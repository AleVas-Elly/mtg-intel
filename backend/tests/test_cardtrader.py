import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from mtg_intel.archive import cardtrader, grabber
from mtg_intel.archive.cardtrader import Session, collect_catalog, collect_marketplace
from mtg_intel.archive.sources import SOURCES, InvalidDownload
from mtg_intel.archive.store import LocalStore

NOW = datetime(2026, 10, 18, 2, 17, tzinfo=UTC)
GAMES = [{"id": 1, "name": "Magic", "display_name": "Magic: the Gathering"}, {"id": 5, "name": "Pokemon"}]
EXPANSIONS = [
    {"id": 10, "game_id": 1, "code": "dsk", "name": "Duskmourn"},
    {"id": 11, "game_id": 5, "code": "sv1", "name": "Scarlet & Violet"},
    {"id": 12, "game_id": 1, "code": "fdn", "name": "Foundations"},
]


class FakeCardTrader:
    def __init__(self, failing: set[str] | None = None, statuses: list[int] | None = None) -> None:
        self.requests: list[httpx.Request] = []
        self.failing = failing or set()  # "path?query" keys that always return 500
        self.statuses = list(statuses or [])  # statuses to return first, in order

    def client(self) -> httpx.Client:
        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            if self.statuses:
                return httpx.Response(self.statuses.pop(0))
            path = request.url.path.removeprefix("/api/v2")
            key = f"{path}?{request.url.query.decode()}"
            if key in self.failing:
                return httpx.Response(500)
            if path == "/games":
                return httpx.Response(200, json=GAMES)
            if path == "/expansions":
                return httpx.Response(200, json=EXPANSIONS)
            if path == "/marketplace/products":
                params = dict(request.url.params)
                body = {"101": [{"id": 1, "price": {"cents": 250, "currency": "EUR"}, "query": params}]}
                return httpx.Response(200, json=body)
            if path == "/blueprints/export":
                return httpx.Response(200, json=[{"id": 101, "scryfall_id": "abc", "card_market_ids": [5]}])
            return httpx.Response(404)

        return httpx.Client(transport=httpx.MockTransport(handler))


def no_wait(**overrides):
    return {"sleep": lambda s: None, "clock": lambda: 0.0, **overrides}


def lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_marketplace_fetches_three_passes_for_magic_expansions_only(tmp_path: Path):
    api = FakeCardTrader()
    out = tmp_path / "marketplace.jsonl"

    meta = collect_marketplace(api.client(), out, token="secret", **no_wait())

    product_calls = [dict(r.url.params) for r in api.requests if r.url.path.endswith("/marketplace/products")]
    assert product_calls == [
        {"expansion_id": "10"},
        {"expansion_id": "10", "language": "en"},
        {"expansion_id": "10", "foil": "true"},
        {"expansion_id": "12"},
        {"expansion_id": "12", "language": "en"},
        {"expansion_id": "12", "foil": "true"},
    ]
    assert meta == {"expansions": "2", "requests": "8", "failed_requests": "0"}
    assert all(r.headers["Authorization"] == "Bearer secret" for r in api.requests)


def test_each_request_is_stored_verbatim(tmp_path: Path):
    api = FakeCardTrader()
    out = tmp_path / "marketplace.jsonl"

    collect_marketplace(api.client(), out, token="secret", **no_wait())

    stored = lines(out)
    assert [s["path"] for s in stored[:2]] == ["/games", "/expansions"]
    assert json.loads(stored[0]["body"]) == GAMES  # raw body text, parseable as sent
    product = stored[2]
    assert product["params"] == {"expansion_id": 10}
    assert product["status"] == 200 and product["error"] is None
    assert "secret" not in out.read_text()  # the token never lands in the file


def test_requests_are_paced(tmp_path: Path):
    api = FakeCardTrader()
    waits: list[float] = []
    times = [0.0]

    def fake_clock():
        return times[0]

    def fake_sleep(seconds):
        waits.append(seconds)
        times[0] += seconds

    collect_marketplace(api.client(), tmp_path / "m.jsonl", token="t", sleep=fake_sleep, clock=fake_clock)

    # 8 requests at a fixed clock: every request after the first waits the full interval.
    assert waits == [cardtrader.REQUEST_INTERVAL_SECONDS] * 7


def test_rate_limited_request_is_retried(tmp_path: Path):
    api = FakeCardTrader(statuses=[429])  # first call (/games) is rate limited once
    out = tmp_path / "m.jsonl"

    meta = collect_marketplace(api.client(), out, token="t", **no_wait())

    assert meta["failed_requests"] == "0"
    assert [r.url.path for r in api.requests[:2]] == ["/api/v2/games", "/api/v2/games"]


def test_failed_request_is_recorded_and_collection_goes_on(tmp_path: Path):
    api = FakeCardTrader(failing={"/marketplace/products?expansion_id=10&foil=true"})
    out = tmp_path / "m.jsonl"

    meta = collect_marketplace(api.client(), out, token="t", **no_wait())

    assert meta["failed_requests"] == "1"
    failed = [s for s in lines(out) if s["error"]]
    assert len(failed) == 1 and failed[0]["status"] == 500
    assert failed[0]["params"] == {"expansion_id": 10, "foil": "true"}


def test_too_many_failures_fail_the_source(tmp_path: Path):
    failing = {f"/marketplace/products?expansion_id={e}{q}" for e in (10, 12) for q in ("", "&language=en")}
    api = FakeCardTrader(failing=failing)

    with pytest.raises(InvalidDownload, match="4 of 8 requests failed"):
        collect_marketplace(api.client(), tmp_path / "m.jsonl", token="t", **no_wait())


def test_missing_game_list_fails_the_source(tmp_path: Path):
    api = FakeCardTrader(failing={"/games?"})

    with pytest.raises(InvalidDownload):
        collect_marketplace(api.client(), tmp_path / "m.jsonl", token="t", **no_wait())


def test_catalog_exports_blueprints_per_magic_expansion(tmp_path: Path):
    api = FakeCardTrader()
    out = tmp_path / "blueprints.jsonl"

    meta = collect_catalog(api.client(), out, token="t", **no_wait())

    calls = [dict(r.url.params) for r in api.requests if r.url.path.endswith("/blueprints/export")]
    assert calls == [{"expansion_id": "10"}, {"expansion_id": "12"}]
    assert json.loads(lines(out)[-1]["body"])[0]["scryfall_id"] == "abc"
    assert meta["expansions"] == "2"


def test_marketplace_is_disabled_until_approved_but_catalog_runs(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CARDTRADER_TOKEN", "a token alone is not enough")
    monkeypatch.delenv("CARDTRADER_APPROVED", raising=False)
    monkeypatch.setattr(cardtrader, "REQUEST_INTERVAL_SECONDS", 0.0)
    # The fake API's tiny catalog is below the real minimum size.
    sources = [replace(s, min_bytes=1) for s in SOURCES if s.name.startswith("cardtrader")]
    api = FakeCardTrader()

    report = grabber.run(sources, LocalStore(tmp_path / "archive"), api.client(), tmp_path / "staging", NOW)

    statuses = {r.source: r.status for r in report.results}
    assert statuses["cardtrader_marketplace"] == "disabled"
    assert statuses["cardtrader_catalog"] == "saved"  # card list only: runs with the token alone
    assert not any("/marketplace/" in r.url.path for r in api.requests)


def test_collector_source_is_saved_compressed_with_its_counts(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CARDTRADER_TOKEN", "t")
    monkeypatch.setenv("CARDTRADER_APPROVED", "yes")
    monkeypatch.setattr(cardtrader, "REQUEST_INTERVAL_SECONDS", 0.0)
    [source] = [s for s in SOURCES if s.name == "cardtrader_marketplace"]
    store = LocalStore(tmp_path / "archive")

    report = grabber.run([source], store, FakeCardTrader().client(), tmp_path / "staging", NOW)

    [result] = report.results
    assert result.status == "saved"
    assert result.extra == {"expansions": "2", "requests": "8", "failed_requests": "0"}
    entry = store.read_manifest().entries["cardtrader_marketplace"]
    assert entry.path == "raw/cardtrader_marketplace/2026-10-18/0217Z_marketplace.jsonl.zst"


def test_session_returns_none_for_unreadable_body(tmp_path: Path):
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text="not json")))
    with (tmp_path / "x.jsonl").open("w") as out:
        session = Session(client, "t", out, **no_wait())
        assert session.get("/games") is None


@pytest.mark.parametrize("value", ["no", "No", "false", "0", "off", " "])
def test_approved_switch_set_to_no_keeps_cardtrader_disabled(tmp_path: Path, monkeypatch, value):
    monkeypatch.setenv("CARDTRADER_TOKEN", "t")
    monkeypatch.setenv("CARDTRADER_APPROVED", value)
    monkeypatch.setattr(cardtrader, "REQUEST_INTERVAL_SECONDS", 0.0)
    # The fake API's tiny catalog is below the real minimum size.
    sources = [replace(s, min_bytes=1) for s in SOURCES if s.name.startswith("cardtrader")]
    api = FakeCardTrader()

    report = grabber.run(sources, LocalStore(tmp_path / "archive"), api.client(), tmp_path / "staging", NOW)

    assert {r.source: r.status for r in report.results}["cardtrader_marketplace"] == "disabled"
    assert not any("/marketplace/" in r.url.path for r in api.requests)
