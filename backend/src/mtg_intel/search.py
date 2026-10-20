"""Card search (D45): a Scryfall search query, answered by Scryfall's API and joined with my tables.

Scryfall does the matching (oracle text, types, costs, artists, and the community art and function
tags that exist only in its search API); our tables add prices, my lists and my collection. Claude
turns plain-language questions into the query (`.claude/skills/cards`).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import duckdb
import httpx
import pyarrow as pa

from mtg_intel.archive.sources import USER_AGENT

API = "https://api.scryfall.com/cards/search"
REQUEST_INTERVAL_SECONDS = 0.1  # Scryfall asks for 50-100 ms between requests
RETRY_WAITS = (2, 10)
MAX_PAGES = 20  # 175 cards a page
QUERY_BUDGET = 800  # characters of printing filter per scoped search; my cards are split over several
MAX_NESTED = 20  # Scryfall refuses searches with more parenthesised groups

SCOPES = ("mine", "wantlist", "collection", "all")


class SearchError(Exception):
    """Scryfall rejected the query (its message says why) or could not be reached."""


@dataclass
class Found:
    ids: list[str] = field(default_factory=list)  # Scryfall order
    total: int = 0
    truncated: bool = False
    warnings: list[str] = field(default_factory=list)


class Scryfall:
    def __init__(
        self,
        client: httpx.Client,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client, self.sleep, self.clock = client, sleep, clock
        self.last_request: float | None = None

    def search(self, query: str, unique: str = "prints", max_pages: int = MAX_PAGES) -> Found:
        found = Found()
        url: str | None = API
        params: dict[str, Any] | None = {
            "q": query, "unique": unique, "include_variations": "true", "order": "released", "dir": "desc",
        }
        pages = 0
        while url:
            if pages == max_pages:
                found.truncated = True
                break
            body = self._get(url, params)
            if body is None:  # no cards
                break
            pages += 1
            found.total = body.get("total_cards", found.total)
            warnings = body.get("warnings") or []
            # Scryfall drops what it can't parse and searches the rest, which can mean "every card".
            invalid = [w for w in warnings if w.startswith("Invalid expression")]
            if invalid:
                raise SearchError(" ".join(invalid))
            found.warnings += [w for w in warnings if w not in found.warnings]
            found.ids += [card["id"] for card in body.get("data") or []]
            url, params = body.get("next_page") if body.get("has_more") else None, None  # next_page carries the query
        return found

    def _get(self, url: str, params: dict[str, Any] | None) -> dict | None:
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        for attempt in range(len(RETRY_WAITS) + 1):
            self._pace()
            try:
                response = self.client.get(url, params=params, headers=headers)
            except httpx.TransportError as e:
                error = f"{type(e).__name__}: {e}"
            else:
                if response.status_code == 404:
                    return None
                if response.status_code == 400:
                    raise SearchError(response.json().get("details", "Scryfall did not understand the query"))
                if response.status_code < 400:
                    return response.json()
                error = f"HTTP {response.status_code}"
            if attempt < len(RETRY_WAITS):
                self.sleep(RETRY_WAITS[attempt])
        raise SearchError(f"Scryfall search failed: {error}")

    def _pace(self) -> None:
        now = self.clock()
        if self.last_request is not None:
            wait = REQUEST_INTERVAL_SECONDS - (now - self.last_request)
            if wait > 0:
                self.sleep(wait)
        self.last_request = self.clock()


def my_scryfall_ids(con: duckdb.DuckDBPyConnection, scope: str) -> set[str] | None:
    """The printings in scope, or None for all cards."""
    if scope == "all":
        return None
    tables = {"mine": ["wantlist", "collection"], "wantlist": ["wantlist"], "collection": ["collection"]}[scope]
    present = {r[0] for r in con.execute("select view_name from duckdb_views() where not internal").fetchall()}
    ids: set[str] = set()
    for table in tables:
        if table in present:
            ids |= {r[0] for r in con.execute(f"select scryfall_id from {table} where matched").fetchall()}
    return ids


def search(scryfall: Scryfall, con: duckdb.DuckDBPyConnection, query: str, scope: str = "mine",
           unique: str | None = None) -> tuple[list[str], Found]:
    """Scryfall IDs matching `query` within `scope`, in Scryfall's order (newest first)."""
    mine = my_scryfall_ids(con, scope)
    if mine is None:
        found = scryfall.search(query, unique or "cards")
        return found.ids, found
    if not mine:
        return [], Found()
    printings = con.execute(
        "select set_code, collector_number from cards where scryfall_id in (select unnest(?)) order by all",
        [sorted(mine)],
    ).fetchall()
    found = Found()
    groups_left = MAX_NESTED - 2 - query.count("(")  # our wrapping parentheses take two
    for printing_filter in printing_filters(printings, max_sets=max(1, groups_left // 2)):
        part = scryfall.search(f"({query}) ({printing_filter})", "prints")
        found.ids += part.ids
        found.truncated |= part.truncated
        found.warnings += [w for w in part.warnings if w not in found.warnings]
    ids = [i for i in dict.fromkeys(found.ids) if i in mine]
    found.total = len(ids)
    return ids, found


def printing_filters(printings: list[tuple[str, str]], budget: int = QUERY_BUDGET, max_sets: int = 8) -> list[str]:
    """Scryfall filters naming exactly these printings, e.g. `(s:msh (cn:"401" or cn:"400"))`, each
    within the character budget and `max_sets` set groups (two nested groups each), so a scoped
    search only ever returns my cards."""
    by_set: dict[str, list[str]] = {}
    for set_code, number in printings:
        by_set.setdefault(set_code, []).append(number)
    terms = []
    for set_code, numbers in by_set.items():
        chunk: list[str] = []
        for number in numbers:
            chunk.append(f'cn:"{number}"')
            if len(" or ".join(chunk)) > budget // 2:
                terms.append(f"(s:{set_code} ({' or '.join(chunk)}))")
                chunk = []
        if chunk:
            terms.append(f"(s:{set_code} ({' or '.join(chunk)}))")
    filters, current = [], []
    for term in terms:
        if current and (len(current) == max_sets or len(" or ".join(current + [term])) > budget):
            filters.append(" or ".join(current))
            current = []
        current.append(term)
    if current:
        filters.append(" or ".join(current))
    return filters


def describe(con: duckdb.DuckDBPyConnection, ids: list[str]) -> pa.Table:
    """One row per printing: card facts, latest Cardmarket trend and where it sits in my cards."""
    con.register("hits", pa.table({"scryfall_id": ids, "rank": list(range(len(ids)))}))
    present = {r[0] for r in con.execute("select view_name from duckdb_views() where not internal").fetchall()}
    wants = (
        "(select scryfall_id, string_agg(distinct list, '; ') as lists from wantlist where matched group by all)"
        if "wantlist" in present else "(select null::varchar as scryfall_id, null::varchar as lists)"
    )
    owned = (
        "(select scryfall_id, sum(try_cast(quantity as integer)) as owned from collection where matched group by all)"
        if "collection" in present else "(select null::varchar as scryfall_id, null::integer as owned)"
    )
    prices = (
        """(select scryfall_id, arg_max(trend, price_date) as trend, arg_max(trend_foil, price_date) as trend_foil,
               max(price_date) as price_date from card_cardmarket_prices group by all)"""
        if "card_cardmarket_prices" in present
        else "(select null::varchar as scryfall_id, null::double as trend, null::double as trend_foil, null::date as price_date)"
    )
    return con.execute(
        f"""
        select c.scryfall_id, c.name, c.set_code, c.collector_number, c.special_tags, c.mana_cost, c.type_line,
            c.artist, p.trend, p.trend_foil, p.price_date, w.lists as wanted_in, o.owned
        from hits h
        join cards c using (scryfall_id)
        left join {prices} p using (scryfall_id)
        left join {wants} w using (scryfall_id)
        left join {owned} o using (scryfall_id)
        order by h.rank
        """
    ).to_arrow_table()
