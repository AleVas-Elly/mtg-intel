"""Move my CardTrader wishlists into our want-list CSV (D44). A one-off move: the app owns the
want-list from then on.

A CardTrader wishlist item names a card in one of three ways:
- expansion code + collector number: one exact printing;
- expansion code + card name (no number): any version of that card in that expansion;
- card name alone: any printing.
Codes and numbers are CardTrader's (collector variants sit in their own expansions, e.g. `cecl`),
so items are resolved through the blueprints of each expansion, which carry the Scryfall ID.

Every wish names its version (D44). An item with several possible versions becomes a `one_of`
group (any one of them fulfils the wish) with a note to narrow it down; an item with no
expansion stays a name-only row that the table build flags.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
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
    printings: dict[str, tuple[str, str]] | None = None,
) -> list[dict[str, str]]:
    """Want-list CSV rows (mycards.WANTLIST_COLUMNS). `card_names` maps slug -> Scryfall card name;
    `printings` maps Scryfall ID -> (set code, collector number), to fill blueprints that lack a
    Scryfall ID from their expansion's other blueprints.

    The same wish in several lists becomes one row that names every list.
    """
    scryfall_ids = _fill_scryfall_ids(blueprints, printings or {})
    rows: dict[tuple, dict[str, str]] = {}
    for wishlist in wishlists:
        for item in wishlist.items:
            code = item.get("expansion_code") or ""
            number = item.get("collector_number") or ""
            meta_name = item.get("meta_name") or ""
            foil = {"true": "yes", "false": "no"}.get(str(item.get("foil")).lower(), "any")
            expansion_blueprints = blueprints.get(expansion_ids.get(code, -1), [])
            if code and number:
                found = [b for b in expansion_blueprints if _number(b) == number]
            elif code:
                found = [b for b in expansion_blueprints if slug(b.get("name", "")) == meta_name]
                if foil == "no":
                    found = [b for b in found if not _foil_only(b)]
            else:
                found = []

            one_of, note = "", ""
            if len(found) > 1:
                one_of = f"{found[0].get('name', '')} ({code})"
                note = "version not chosen on CardTrader: keep the ones you want"
            elif code and not found:
                note = f"CardTrader {code} {number}".strip() + " not found"
            elif not code:
                note = "no version on CardTrader: pick one"
            wishes = (
                [{"name": b.get("name", ""), "scryfall_id": scryfall_ids.get(b["id"], ""),
                  "cardtrader_blueprint_id": str(b["id"])} for b in found]
                if found
                else [{"name": card_names.get(meta_name, meta_name), "scryfall_id": "", "cardtrader_blueprint_id": ""}]
            )
            for wish in wishes:
                row = {
                    **wish,
                    "set_code": "",
                    "collector_number": "",
                    "language": LANGUAGES.get(item.get("language") or "", item.get("language") or "any"),
                    "foil": foil,
                    "min_condition": CONDITIONS.get(item.get("condition") or "", "PO"),
                    "via_zero": "yes",
                    "max_price_eur": "",
                    "quantity": str(item.get("quantity") or 1),
                    "list": wishlist.name,
                    "one_of": one_of,
                    "note": note,
                }
                key = tuple(row[k] for k in ("name", "scryfall_id", "cardtrader_blueprint_id", "language",
                                             "foil", "min_condition", "one_of", "note"))
                if key in rows:
                    lists = rows[key]["list"].split("; ")
                    if wishlist.name not in lists:
                        rows[key]["list"] = "; ".join(lists + [wishlist.name])
                    rows[key]["quantity"] = str(max(int(rows[key]["quantity"]), int(row["quantity"])))
                else:
                    rows[key] = row
    return list(rows.values())


def _fill_scryfall_ids(blueprints: dict[int, list[dict]], printings: dict[str, tuple[str, str]]) -> dict[int, str]:
    """Blueprint ID -> Scryfall ID. A blueprint without one gets the printing with its collector number
    in the Scryfall set most of its expansion maps to (CardTrader's `099` is Scryfall's `99`)."""
    by_number = {(set_code, number.lstrip("0")): sid for sid, (set_code, number) in printings.items()}
    found = {}
    for expansion in blueprints.values():
        sets = Counter(printings[b["scryfall_id"]][0] for b in expansion if b.get("scryfall_id") in printings)
        main_set = sets.most_common(1)[0][0] if sets else None
        for b in expansion:
            sid = b.get("scryfall_id") or by_number.get((main_set, _number(b).lstrip("0")), "")
            if sid:
                found[b["id"]] = sid
    return found


def _foil_only(blueprint: dict) -> bool:
    """CardTrader keeps foil-only treatments (etched, serialized, fracture foil …) as their own versions."""
    version = str(blueprint.get("version") or "").lower()
    return "foil" in version or "serialized" in version


def _number(blueprint: dict) -> str:
    return str((blueprint.get("fixed_properties") or {}).get("collector_number") or "")
