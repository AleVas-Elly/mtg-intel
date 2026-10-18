import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import ClassVar

import httpx
import zstandard

from mtg_intel.archive import grabber
from mtg_intel.archive.sources import XZ_MAGIC, Source, json_with_key, starts_with
from mtg_intel.archive.store import LocalStore

NOW = datetime(2026, 10, 17, 2, 0, tzinfo=UTC)


class FakeServer:
    """Serves whatever bytes `files` holds for each URL; 404 otherwise."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.requests: list[str] = []

    def client(self) -> httpx.Client:
        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(str(request.url))
            body = self.files.get(str(request.url))
            return httpx.Response(200, content=body) if body is not None else httpx.Response(404)

        return httpx.Client(transport=httpx.MockTransport(handler))


def price_guide(day: int) -> bytes:
    return json.dumps({"version": 1, "priceGuides": [{"idProduct": 1, "trend": day}]}).encode()


GUIDE = Source(
    name="guide",
    url="https://example.test/price_guide_1.json",
    compress=True,
    validate=json_with_key("priceGuides"),
)
XZ = Source(name="xz", url="https://example.test/AllPricesToday.json.xz", validate=starts_with(XZ_MAGIC, "xz"))


def grab(server, store, tmp_path, sources, now=NOW):
    return grabber.run(sources, store, server.client(), tmp_path / "staging", now, sleep=lambda s: None)


def statuses(report):
    return {r.source: r.status for r in report.results}


def test_first_run_saves_compressed_file_and_manifest(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = price_guide(1)

    assert statuses(grab(server, store, tmp_path, [GUIDE])) == {"guide": "saved"}

    entry = store.read_manifest().entries["guide"]
    assert entry.path == "raw/guide/2026-10-17/0200Z_price_guide_1.json.zst"
    stored = (tmp_path / "archive" / entry.path).read_bytes()
    assert zstandard.ZstdDecompressor().decompress(stored) == price_guide(1)  # lossless
    assert entry.size == len(price_guide(1))


def test_unchanged_content_is_not_saved_again(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = price_guide(1)
    grab(server, store, tmp_path, [GUIDE])

    later = NOW + timedelta(hours=6)
    assert statuses(grab(server, store, tmp_path, [GUIDE], later)) == {"guide": "unchanged"}
    assert not (tmp_path / "archive" / "raw/guide/2026-10-17/0800Z_price_guide_1.json.zst").exists()


def test_changed_content_is_saved_as_new_file(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = price_guide(1)
    grab(server, store, tmp_path, [GUIDE])

    server.files[GUIDE.url] = price_guide(2)
    next_day = NOW + timedelta(days=1)
    assert statuses(grab(server, store, tmp_path, [GUIDE], next_day)) == {"guide": "saved"}

    assert (tmp_path / "archive/raw/guide/2026-10-17/0200Z_price_guide_1.json.zst").exists()
    assert store.read_manifest().entries["guide"].path == "raw/guide/2026-10-18/0200Z_price_guide_1.json.zst"


def test_compressed_downloads_are_stored_byte_for_byte(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    body = XZ_MAGIC + b"rest of an xz file"
    server.files[XZ.url] = body

    grab(server, store, tmp_path, [XZ])

    entry = store.read_manifest().entries["xz"]
    assert entry.path.endswith("0200Z_AllPricesToday.json.xz")
    assert (tmp_path / "archive" / entry.path).read_bytes() == body


def test_one_failing_source_does_not_block_the_others(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = price_guide(1)  # XZ url is missing: 404

    assert statuses(grab(server, store, tmp_path, [XZ, GUIDE])) == {"xz": "failed", "guide": "saved"}
    assert set(store.read_manifest().entries) == {"guide"}


def test_invalid_download_is_rejected_and_not_saved(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = b"<html>maintenance</html>"
    server.files[XZ.url] = b"not xz at all"

    report = grab(server, store, tmp_path, [GUIDE, XZ])

    assert statuses(report) == {"guide": "failed", "xz": "failed"}
    assert store.read_manifest().entries == {}


def test_too_small_download_is_rejected(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    source = Source(name="small", url="https://example.test/f.json", min_bytes=1000)
    server.files[source.url] = b"{}"

    assert statuses(grab(server, store, tmp_path, [source])) == {"small": "failed"}


def test_once_source_is_never_downloaded_again(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    backfill = Source(name="backfill", url="https://example.test/AllPrices.json.xz", once=True)
    server.files[backfill.url] = b"v1"
    grab(server, store, tmp_path, [backfill])

    server.files[backfill.url] = b"v2"
    server.requests.clear()
    assert statuses(grab(server, store, tmp_path, [backfill], NOW + timedelta(days=1))) == {
        "backfill": "not_due"
    }
    assert server.requests == []


def test_weekly_source_waits_until_due(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    weekly = Source(name="weekly", url="https://example.test/cards.jsonl.gz", every=timedelta(days=6, hours=18))
    server.files[weekly.url] = b"week 1"
    grab(server, store, tmp_path, [weekly])

    server.files[weekly.url] = b"week 2"
    assert statuses(grab(server, store, tmp_path, [weekly], NOW + timedelta(days=3))) == {"weekly": "not_due"}
    assert statuses(grab(server, store, tmp_path, [weekly], NOW + timedelta(days=7))) == {"weekly": "saved"}


def test_resolved_url_is_downloaded_and_named_after_its_file(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    server.files["https://data.example.test/default-cards-20261017.jsonl.gz"] = b"cards"
    source = Source(
        name="cards", resolve=lambda client: "https://data.example.test/default-cards-20261017.jsonl.gz"
    )

    grab(server, store, tmp_path, [source])

    entry = store.read_manifest().entries["cards"]
    assert entry.path == "raw/cards/2026-10-17/0200Z_default-cards-20261017.jsonl.gz"
    assert entry.url == "https://data.example.test/default-cards-20261017.jsonl.gz"


def test_unchanged_run_publishes_only_its_run_log(tmp_path: Path):
    server = FakeServer()
    server.files[GUIDE.url] = price_guide(1)

    class RecordingStore(LocalStore):
        published: ClassVar[list[list[str]]] = []

        def publish(self, files, manifest, message):
            RecordingStore.published.append([p for p, _ in files])
            super().publish(files, manifest, message)

    store = RecordingStore(tmp_path / "archive")
    grab(server, store, tmp_path, [GUIDE])
    grab(server, store, tmp_path, [GUIDE], NOW + timedelta(hours=6))

    assert RecordingStore.published[1] == ["runs/2026/10/2026-10-17T0800Z.json"]


def test_dry_run_publishes_nothing(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = price_guide(1)

    report = grabber.run([GUIDE], store, server.client(), tmp_path / "staging", NOW, publish=False)

    assert statuses(report) == {"guide": "saved"}
    assert not (tmp_path / "archive").exists()


class FlakyServer(FakeServer):
    """Answers with `fail_with` for the first `failures` requests, then normally."""

    def __init__(self, failures: int, fail_with: int) -> None:
        super().__init__()
        self.failures, self.fail_with = failures, fail_with

    def client(self) -> httpx.Client:
        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(str(request.url))
            if len(self.requests) <= self.failures:
                return httpx.Response(self.fail_with)
            body = self.files.get(str(request.url))
            headers = {"Last-Modified": "Sat, 17 Oct 2026 00:44:39 GMT", "ETag": '"abc"'}
            return httpx.Response(200, content=body, headers=headers) if body else httpx.Response(404)

        return httpx.Client(transport=httpx.MockTransport(handler))


def test_server_errors_are_retried(tmp_path: Path):
    server, store = FlakyServer(failures=2, fail_with=503), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = price_guide(1)
    waits: list[float] = []

    report = grabber.run([GUIDE], store, server.client(), tmp_path / "staging", NOW, sleep=waits.append)

    result = report.results[0]
    assert (result.status, result.attempts) == ("saved", 3)
    assert waits == list(grabber.BACKOFF_SECONDS)


def test_client_errors_are_not_retried(tmp_path: Path):
    server, store = FlakyServer(failures=5, fail_with=403), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = price_guide(1)

    report = grab(server, store, tmp_path, [GUIDE])

    assert (report.results[0].status, report.results[0].attempts) == ("failed", 1)
    assert "403" in report.results[0].detail


def test_gives_up_after_three_attempts(tmp_path: Path):
    server, store = FlakyServer(failures=10, fail_with=500), LocalStore(tmp_path / "archive")
    server.files[GUIDE.url] = price_guide(1)

    report = grab(server, store, tmp_path, [GUIDE])

    assert (report.results[0].status, report.results[0].attempts) == ("failed", 3)
    assert report.problems == report.results


def test_run_log_records_source_metadata(tmp_path: Path):
    server, store = FlakyServer(failures=0, fail_with=500), LocalStore(tmp_path / "archive")
    body = json.dumps({"createdAt": "2026-10-17T02:44:27+0200", "priceGuides": [{"idProduct": 1}]}).encode()
    server.files[GUIDE.url] = body

    grabber.run([GUIDE], store, server.client(), tmp_path / "staging", NOW, context={"commit": "abc123"})

    log = json.loads((tmp_path / "archive/runs/2026/10/2026-10-17T0200Z.json").read_text())
    assert log["context"] == {"commit": "abc123"}
    [result] = log["results"]
    assert result["status"] == "saved"
    assert result["created_at"] == "2026-10-17T02:44:27+0200"
    assert result["last_modified"] == "Sat, 17 Oct 2026 00:44:39 GMT"
    assert result["etag"] == '"abc"'
    assert result["size"] == len(body)


def test_source_unchanged_for_too_long_is_stale(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    daily = Source(name="daily", url="https://example.test/daily.json", max_age=timedelta(hours=30))
    server.files[daily.url] = b"same every day"
    grab(server, store, tmp_path, [daily])

    assert statuses(grab(server, store, tmp_path, [daily], NOW + timedelta(hours=24))) == {"daily": "unchanged"}
    report = grab(server, store, tmp_path, [daily], NOW + timedelta(hours=31))
    assert statuses(report) == {"daily": "stale"}
    assert "31 h" in report.results[0].detail


def test_a_failing_source_is_reported_as_failed_not_stale(tmp_path: Path):
    server, store = FakeServer(), LocalStore(tmp_path / "archive")
    weekly = Source(
        name="weekly",
        url="https://example.test/w.jsonl.gz",
        every=timedelta(days=7),
        max_age=timedelta(days=8),
    )
    server.files[weekly.url] = b"week 1"
    grab(server, store, tmp_path, [weekly])

    del server.files[weekly.url]  # source disappears: every later attempt fails
    grab(server, store, tmp_path, [weekly], NOW + timedelta(days=7))
    assert statuses(grab(server, store, tmp_path, [weekly], NOW + timedelta(days=9))) == {"weekly": "failed"}


def test_alert_is_posted_to_ntfy_topic():
    from mtg_intel.archive.notify import send_alert

    posted: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(request)
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert send_alert(client, "my-topic", "title", "body") is True
    assert str(posted[0].url) == "https://ntfy.sh/my-topic"
    assert posted[0].headers["Title"] == "title"
    assert posted[0].content == b"body"
    assert send_alert(client, None, "title", "body") is False
    assert len(posted) == 1


def test_alert_failure_never_raises():
    from mtg_intel.archive.notify import send_alert

    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(500)))
    assert send_alert(client, "my-topic", "title", "body") is False


def test_telegram_is_used_when_configured(monkeypatch):
    from mtg_intel.archive.notify import alert

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    monkeypatch.setenv("NTFY_TOPIC", "my-topic")
    posted: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(request)
        return httpx.Response(200, json={"ok": True})

    assert alert(httpx.Client(transport=httpx.MockTransport(handler)), "title", "body") is True
    [request] = posted
    assert str(request.url) == "https://api.telegram.org/bot123:abc/sendMessage"
    assert json.loads(request.content) == {"chat_id": "42", "text": "title\n\nbody"}


def test_ntfy_is_the_fallback_without_telegram(monkeypatch):
    from mtg_intel.archive.notify import alert

    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.setenv("NTFY_TOPIC", "my-topic")
    posted: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(request)
        return httpx.Response(200)

    alert(httpx.Client(transport=httpx.MockTransport(handler)), "title", "body")
    assert str(posted[0].url) == "https://ntfy.sh/my-topic"
