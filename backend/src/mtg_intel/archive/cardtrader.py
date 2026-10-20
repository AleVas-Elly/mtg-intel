"""CardTrader collectors (D30). Many API requests, one verbatim JSONL file.

Each line is one request: what was asked, when, the HTTP status and the raw response body as
text, so the snapshot stays lossless. Requests are paced and retried one by one; a failed
request is recorded and the collection goes on.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

import httpx

from mtg_intel.archive.sources import USER_AGENT, InvalidDownload

API = "https://api.cardtrader.com/api/v2"
REQUEST_INTERVAL_SECONDS = 1.0  # the docs say both 1/s and 10/s for the marketplace; take the safe one
RETRY_WAITS = (5, 15)  # per request
MAX_FAILED_SHARE = 0.2

# Marketplace passes per expansion: everything, English only, foil only. The cheapest 25 per card
# are often played or foreign copies, so the filtered passes keep English and foil prices visible.
MARKETPLACE_PASSES: list[dict[str, str]] = [{}, {"language": "en"}, {"foil": "true"}]


class Session:
    """Paced, retrying GETs that write one JSONL line each (or nothing, with `out=None`)."""

    def __init__(
        self,
        client: httpx.Client,
        token: str,
        out: IO[str] | None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        interval: float | None = None,
    ) -> None:
        self.client, self.out, self.sleep, self.clock = client, out, sleep, clock
        self.interval = REQUEST_INTERVAL_SECONDS if interval is None else interval
        self.headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
        self.last_request: float | None = None
        self.requests = 0
        self.failed = 0
        self.last_status: int | None = None

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any | None:
        """Return the parsed JSON body, or None if the request failed after retries."""
        params = params or {}
        status: int | None = None
        body: str | None = None
        error: str | None = None
        for attempt in range(len(RETRY_WAITS) + 1):
            self._pace()
            try:
                response = self.client.get(f"{API}{path}", params=params, headers=self.headers)
                status, body, error = response.status_code, response.text, None
                if status == 429 or status >= 500:
                    error = f"HTTP {status}"
                else:
                    break
            except httpx.TransportError as e:
                status, body, error = None, None, f"{type(e).__name__}: {e}"
            if attempt < len(RETRY_WAITS):
                self.sleep(RETRY_WAITS[attempt])

        ok = error is None and status is not None and status < 400
        self.last_status = status
        self.requests += 1
        self.failed += 0 if ok else 1
        line = {
            "path": path,
            "params": params,
            "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "status": status,
            "error": error if not ok else None,
            "body": body,
        }
        if self.out is not None:
            self.out.write(json.dumps(line, ensure_ascii=False) + "\n")
        if not ok:
            return None
        try:
            return json.loads(body or "")
        except ValueError:
            return None

    def _pace(self) -> None:
        now = self.clock()
        if self.last_request is not None:
            wait = self.interval - (now - self.last_request)
            if wait > 0:
                self.sleep(wait)
        self.last_request = self.clock()

    def summary(self) -> dict[str, str]:
        if self.requests and self.failed / self.requests > MAX_FAILED_SHARE:
            raise InvalidDownload(f"{self.failed} of {self.requests} requests failed")
        return {"requests": str(self.requests), "failed_requests": str(self.failed)}


def magic_expansion_ids(session: Session) -> list[int]:
    games = session.get("/games")
    expansions = session.get("/expansions")
    if isinstance(games, dict):  # tolerate a wrapped list
        games = games.get("array") or games.get("games")
    if not isinstance(games, list) or not isinstance(expansions, list):
        raise InvalidDownload("could not read CardTrader games or expansions")
    magic = [g["id"] for g in games if str(g.get("name", "")).lower() in ("magic", "magic: the gathering")]
    if not magic:
        raise InvalidDownload("Magic not found in CardTrader games")
    return sorted(e["id"] for e in expansions if e.get("game_id") in magic)


def collect_marketplace(client: httpx.Client, dest: Path, token: str, **session_options: Any) -> dict[str, str]:
    with dest.open("w") as out:
        session = Session(client, token, out, **session_options)
        expansion_ids = magic_expansion_ids(session)
        for expansion_id in expansion_ids:
            for extra in MARKETPLACE_PASSES:
                session.get("/marketplace/products", {"expansion_id": expansion_id, **extra})
    return {"expansions": str(len(expansion_ids)), **session.summary()}


def collect_catalog(client: httpx.Client, dest: Path, token: str, **session_options: Any) -> dict[str, str]:
    with dest.open("w") as out:
        session = Session(client, token, out, **session_options)
        expansion_ids = magic_expansion_ids(session)
        for expansion_id in expansion_ids:
            session.get("/blueprints/export", {"expansion_id": expansion_id})
    return {"expansions": str(len(expansion_ids)), **session.summary()}
