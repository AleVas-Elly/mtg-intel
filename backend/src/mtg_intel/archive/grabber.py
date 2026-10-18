"""One grabber run: download every due source into staging, keep what changed, publish once."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx
import zstandard

from mtg_intel.archive.manifest import Entry, Manifest
from mtg_intel.archive.sources import USER_AGENT, InvalidDownload, Source
from mtg_intel.archive.store import Store

CHUNK = 1 << 20
BACKOFF_SECONDS = (5, 20)  # waits between the 3 attempts
PROBLEMS = ("failed", "stale")


@dataclass
class Result:
    source: str
    status: str  # saved | unchanged | not_due | disabled | stale | failed
    detail: str = ""
    url: str | None = None
    sha256: str | None = None
    size: int | None = None
    last_modified: str | None = None  # HTTP Last-Modified
    etag: str | None = None
    created_at: str | None = None  # the file's own timestamp, when it has one
    last_saved_at: str | None = None  # when the version now in the archive was saved
    attempts: int = 0
    seconds: float = 0.0
    extra: dict[str, str] = field(default_factory=dict)  # collector metadata, e.g. request counts


@dataclass
class Report:
    started_at: str
    finished_at: str = ""
    context: dict[str, str] = field(default_factory=dict)  # e.g. git commit, trigger
    results: list[Result] = field(default_factory=list)

    @property
    def problems(self) -> list[Result]:
        return [r for r in self.results if r.status in PROBLEMS]

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2) + "\n"


def run(
    sources: list[Source],
    store: Store,
    client: httpx.Client,
    staging: Path,
    now: datetime,
    publish: bool = True,
    context: dict[str, str] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> Report:
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "download").mkdir(parents=True)
    (staging / "archive").mkdir(parents=True)

    manifest = store.read_manifest()
    report = Report(started_at=now.isoformat(), context=context or {})
    files: list[tuple[str, Path]] = []

    for source in sources:
        started = time.monotonic()
        result, saved = grab(source, manifest, client, staging, now, sleep)
        result.seconds = round(time.monotonic() - started, 1)
        check_staleness(source, result, manifest, now)
        report.results.append(result)
        if saved:
            files.append(saved)

    report.finished_at = datetime.now(UTC).replace(microsecond=0).isoformat()

    # Every run is recorded, even when nothing changed, so a gap in the archive can be told
    # apart from a source that did not update.
    log_path = f"runs/{now:%Y}/{now:%m}/{now:%Y-%m-%dT%H%MZ}.json"
    log_file = staging / "archive" / log_path
    log_file.parent.mkdir(parents=True, exist_ok=True)
    log_file.write_text(report.to_json())
    files.append((log_path, log_file))

    if publish:
        store.publish(files, manifest, commit_message(report, now))
    return report


def commit_message(report: Report, now: datetime) -> str:
    by_status: dict[str, list[str]] = {}
    for r in report.results:
        by_status.setdefault(r.status, []).append(r.source)
    parts = [f"{status}: {', '.join(names)}" for status, names in by_status.items()]
    return f"grab {now:%Y-%m-%d %H:%MZ} | " + " | ".join(parts)


def grab(
    source: Source,
    manifest: Manifest,
    client: httpx.Client,
    staging: Path,
    now: datetime,
    sleep: Callable[[float], None],
) -> tuple[Result, tuple[str, Path] | None]:
    previous = manifest.entries.get(source.name)
    result = Result(source.name, "not_due", last_saved_at=previous.saved_at if previous else None)
    missing = [name for name in source.requires_env if not env_is_on(name)]
    if missing:
        result.status, result.detail = "disabled", f"set {', '.join(missing)} to enable"
        return result, None
    if not is_due(source, previous, now):
        return result, None

    downloaded = staging / "download" / source.name
    max_attempts = len(BACKOFF_SECONDS) + 1 if source.retries else 1
    for attempt in range(1, max_attempts + 1):
        result.attempts = attempt
        try:
            fetch(source, client, downloaded, result)
            break
        except Exception as e:  # noqa: BLE001 - one broken source must never stop the others
            result.status, result.detail = "failed", f"{type(e).__name__}: {e}"
            if attempt == max_attempts or not retryable(e):
                return result, None
            sleep(BACKOFF_SECONDS[attempt - 1])
    result.detail = ""

    if previous and previous.sha256 == result.sha256:
        downloaded.unlink()
        result.status = "unchanged"
        return result, None

    filename = source.filename or Path(urlparse(result.url or "").path).name
    stored_name = f"{filename}.zst" if source.compress else filename
    path_in_archive = f"raw/{source.name}/{now:%Y-%m-%d}/{now:%H%M}Z_{stored_name}"
    stored = staging / "archive" / path_in_archive
    stored.parent.mkdir(parents=True, exist_ok=True)
    if source.compress:
        compress(downloaded, stored)
        downloaded.unlink()
    else:
        downloaded.rename(stored)

    manifest.entries[source.name] = Entry(
        sha256=result.sha256 or "",
        size=result.size or 0,
        path=path_in_archive,
        saved_at=now.isoformat(),
        url=result.url or "",
    )
    counts = ", ".join(f"{k} {v}" for k, v in result.extra.items())
    result.status, result.last_saved_at = "saved", now.isoformat()
    result.detail = f"{path_in_archive} ({counts})" if counts else path_in_archive
    return result, (path_in_archive, stored)


def fetch(source: Source, client: httpx.Client, dest: Path, result: Result) -> None:
    """Download (or collect) and validate one source into `dest`, filling in `result`."""
    if source.collect:
        result.url = source.url
        result.extra = source.collect(client, dest)
        result.sha256, result.size = file_sha256(dest), dest.stat().st_size
        check_file(source, dest, result)
        return

    result.url = source.resolve(client) if source.resolve else source.url
    # Ask for the file as-is (no transfer compression), so the bytes we hash are the file itself.
    headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity", **source.headers}
    digest, size = hashlib.sha256(), 0
    with client.stream("GET", result.url, headers=headers) as response:
        response.raise_for_status()
        result.last_modified = response.headers.get("last-modified")
        result.etag = response.headers.get("etag")
        with dest.open("wb") as f:
            for chunk in response.iter_bytes(CHUNK):
                digest.update(chunk)
                size += len(chunk)
                f.write(chunk)
    result.sha256, result.size = digest.hexdigest(), size
    check_file(source, dest, result)


def check_file(source: Source, dest: Path, result: Result) -> None:
    size = result.size or 0
    if size < source.min_bytes:
        raise InvalidDownload(f"{size} bytes, expected at least {source.min_bytes}")
    if source.validate:
        metadata = source.validate(dest) or {}
        result.created_at = metadata.get("created_at")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def retryable(error: Exception) -> bool:
    if isinstance(error, httpx.HTTPStatusError):
        code = error.response.status_code
        return code >= 500 or code == 429
    # Network errors, and files that came back truncated or as an error page.
    return isinstance(error, (httpx.TransportError, InvalidDownload))


def env_is_on(name: str) -> bool:
    """Set and not an explicit "off" value: CARDTRADER_APPROVED=no must not switch anything on."""
    return os.environ.get(name, "").strip().lower() not in ("", "0", "no", "false", "off")


def is_due(source: Source, previous: Entry | None, now: datetime) -> bool:
    if previous is None:
        return True
    if source.once:
        return False
    if source.every is not None:
        return now - previous.saved_at_dt >= source.every
    return True


def check_staleness(source: Source, result: Result, manifest: Manifest, now: datetime) -> None:
    """Flag a source whose newest saved version is too old, even if this run itself succeeded."""
    entry = manifest.entries.get(source.name)
    if source.max_age is None or entry is None or result.status == "failed":
        return
    age = now - entry.saved_at_dt
    if age > source.max_age:
        hours = int(age.total_seconds() // 3600)
        result.status = "stale"
        result.detail = f"no new version for {hours} h (limit {int(source.max_age.total_seconds() // 3600)} h)"


def compress(src: Path, dest: Path) -> None:
    compressor = zstandard.ZstdCompressor(level=10, threads=-1)
    with src.open("rb") as fin, dest.open("wb") as fout:
        compressor.copy_stream(fin, fout, size=src.stat().st_size)
