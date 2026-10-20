"""Move my CardTrader wishlists into our want-list CSV (D44). A one-off move: the app owns the
want-list from then on.

A CardTrader wishlist item names a card in one of three ways:
- expansion code + collector number: one exact printing;
- expansion code + card name (no number): any version of that card in that expansion;
- card name alone: any printing.
Codes and numbers are CardTrader's (collector variants sit in their own expansions, e.g. `cecl`),
so items are resolved through the blueprints of each expansion, which carry the Scryfall ID.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from mtg_intel.archive.cardtrader import Session
from mtg_intel.archive.sources import InvalidDownload

CONDITIONS = {
    "Mint": "NM",
    "Near Mint": "NM",
    "Slightly Played": "SP",
    "Moderately Played": "MP",
    "Played": "PL",
    "Poor": "PO",
}
LANGUAGES = {"jp": "ja"}  # CardTrader code -> Scryfall code; the rest are equal


@dataclass
class Wishlist:
    id: int
    name: str
    items: list[dict[str, Any]]


def slug(name: str) -> str:
    """CardTrader's `meta_name` form of a card name: "Ashling's Command" -> "ashling-s-command"."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")


def list_wishlists(session: Session) -> list[dict[str, Any]]:
    """Wishlist headers (id, name, game_id, …), without items."""
    lists = session.get("/wishlists")
    if not isinstance(lists, list):
        raise InvalidDownload(f"could not read CardTrader wishlists (HTTP {session.last_status})")
    return lists


def fetch_wishlists(session: Session, ids: list[int]) -> list[Wishlist]:
    wishlists = []
    for wishlist_id in ids:
        body = session.get(f"/wishlists/{wishlist_id}")
        if not isinstance(body, dict):
            raise InvalidDownload(f"could not read CardTrader wishlist {wishlist_id} (HTTP {session.last_status})")
        wishlists.append(Wishlist(body["id"], body.get("name", ""), body.get("items") or []))
    return wishlists


def fetch_blueprints(session: Session, wishlists: list[Wishlist]) -> tuple[dict[str, int], dict[int, list[dict]]]:
    """Magic expansion code -> id for every code the items use, and those expansions' blueprints."""
    expansions = session.get("/expansions")
    if not isinstance(expansions, list):
        raise InvalidDownload("could not read CardTrader expansions")
    codes = {e["code"]: e["id"] for e in expansions if e.get("game_id") == 1}  # codes repeat across games
    used = {item.get("expansion_code") for w in wishlists for item in w.items} & codes.keys()
    blueprints = {}
    for code in sorted(used):
        body = session.get("/blueprints/export", {"expansion_id": codes[code]})
        blueprints[codes[code]] = body if isinstance(body, list) else []
    return codes, blueprints


def wantlist_rows(
    wishlists: list[Wishlist],
    expansion_ids: dict[str, int],
    blueprints: dict[int, list[dict]],
    card_names: dict[str, str],
) -> list[dict[str, str]]:
    """Want-list CSV rows (mycards.WANTLIST_COLUMNS). `card_names` maps slug -> Scryfall card name.

    "Any version in this expansion" becomes one row per matching blueprint. The same wish in
    several lists becomes one row that names every list.
    """
    rows: dict[tuple, dict[str, str]] = {}
    for wishlist in wishlists:
        for item in wishlist.items:
            code = item.get("expansion_code") or ""
            number = item.get("collector_number") or ""
            meta_name = item.get("meta_name") or ""
            expansion_blueprints = blueprints.get(expansion_ids.get(code, -1), [])
            if code and number:
                found = [b for b in expansion_blueprints if _number(b) == number]
            elif code:
                found = [b for b in expansion_blueprints if slug(b.get("name", "")) == meta_name]
            else:
                found = []
            wishes = (
                [{"name": b.get("name", ""), "scryfall_id": b.get("scryfall_id") or "",
                  "cardtrader_blueprint_id": str(b["id"])} for b in found]
                if found
                # Any printing, or an item we could not resolve: kept by name, the table build flags it.
                else [{"name": card_names.get(meta_name, meta_name), "scryfall_id": "", "cardtrader_blueprint_id": ""}]
            )
            unresolved = bool(code) and not found
            for wish in wishes:
                row = {
                    **wish,
                    "set_code": "",
                    "collector_number": "",
                    "language": LANGUAGES.get(item.get("language") or "", item.get("language") or "any"),
                    "foil": {"true": "yes", "false": "no"}.get(str(item.get("foil")).lower(), "any"),
                    "min_condition": CONDITIONS.get(item.get("condition") or "", "PO"),
                    "via_zero": "yes",
                    "max_price_eur": "",
                    "quantity": str(item.get("quantity") or 1),
                    "list": wishlist.name,
                    "note": f"CardTrader {code} {number}".strip() + " not found" if unresolved else "",
                }
                key = tuple(row[k] for k in ("name", "scryfall_id", "cardtrader_blueprint_id", "language",
                                             "foil", "min_condition", "note"))
                if key in rows:
                    lists = rows[key]["list"].split("; ")
                    if wishlist.name not in lists:
                        rows[key]["list"] = "; ".join(lists + [wishlist.name])
                    rows[key]["quantity"] = str(max(int(rows[key]["quantity"]), int(row["quantity"])))
                else:
                    rows[key] = row
    return list(rows.values())


def _number(blueprint: dict) -> str:
    return str((blueprint.get("fixed_properties") or {}).get("collector_number") or "")
