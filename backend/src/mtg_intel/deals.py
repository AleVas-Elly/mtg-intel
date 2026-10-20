"""Deal alerts (phase 3, D34, D40).

`watch_table` (built with the tables) holds each want-list wish with its Cardmarket reference
prices. `check` asks CardTrader for the live listings of every wished card, keeps the ones that
fit the wish (language, foil, condition, Zero), and calls the cheapest a deal when it is at least
`deal_pct` under the Cardmarket trend for that finish, or at or under my target price.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import duckdb
import pyarrow as pa

from mtg_intel.archive.cardtrader import Session

DEFAULT_DEAL_PCT = 25.0  # D40: one global X, overridable per card
REALERT_DAYS = 7  # the same deal at the same price is repeated after a week

# CardTrader condition words, best first, and the want-list grade each one meets.
CONDITIONS = ["Mint", "Near Mint", "Slightly Played", "Moderately Played", "Played", "Heavily Played", "Poor"]
GRADE = {"NM": 1, "SP": 2, "MP": 3, "PL": 5, "PO": 6}  # worst CONDITIONS index each grade accepts
LANGUAGES = {"ja": "jp"}  # want-list (Scryfall) code -> CardTrader code; the rest are equal

# Cardmarket product-page filters (language ids and minimum condition ids are Cardmarket's).
CM_LANGUAGES = {"en": 1, "fr": 2, "de": 3, "es": 4, "it": 5, "zhs": 6, "ja": 7, "pt": 8, "ru": 9, "ko": 10, "zht": 11}
CM_MIN_CONDITION = {"NM": 2, "SP": 3, "MP": 4, "PL": 5, "PO": 7}


def watch_table(wantlist: pa.Table, cards: pa.Table, cardmarket: pa.Table | None) -> pa.Table:
    """One row per wish that CardTrader can be asked about, with the latest Cardmarket prices."""
    con = duckdb.connect()
    for column in ("max_price_eur", "deal_pct", "one_of"):  # want-lists built before these columns existed
        if column not in wantlist.column_names:
            wantlist = wantlist.append_column(column, pa.nulls(wantlist.num_rows, pa.string()))
    con.register("w", wantlist)
    con.register("c", cards)
    if cardmarket is None:
        cardmarket = pa.table({"id_product": pa.array([], pa.int64())})
    con.register("p", cardmarket)
    price_columns = [c for c in ("price_date", "trend", "trend_foil", "low", "low_foil", "avg7", "avg7_foil")
                     if c in cardmarket.column_names]
    prices = ", ".join(f"p.{c}" for c in price_columns)
    return con.execute(
        f"""
        select w.line, coalesce(c.name, w.name) as name, c.set_code, c.collector_number, c.special_tags,
            c.finishes, w.scryfall_id, try_cast(w.cardtrader_blueprint_id as bigint) as blueprint_id,
            w.language, w.foil, w.min_condition, w.via_zero, try_cast(w.max_price_eur as double) as max_price_eur,
            try_cast(w.deal_pct as double) as deal_pct, w.list, w.one_of, c.cardmarket_id{", " + prices if prices else ""}
        from w
        left join c using (scryfall_id)
        left join p on p.id_product = c.cardmarket_id
        where try_cast(w.cardtrader_blueprint_id as bigint) is not null
        order by w.line
        """
    ).to_arrow_table()


@dataclass
class Listing:
    id: int
    price: float  # EUR
    condition: str
    language: str
    foil: bool
    zero: bool
    country: str
    quantity: int

    @classmethod
    def from_api(cls, item: dict[str, Any]) -> Listing | None:
        """A buyable listing, or None for anything a wish can never want (graded, signed, altered,
        on vacation, not in EUR)."""
        props = item.get("properties_hash") or {}
        if (item.get("graded") or item.get("on_vacation") or props.get("signed") or props.get("altered")
                or item.get("price_currency") != "EUR"):
            return None
        user = item.get("user") or {}
        return cls(
            id=item["id"], price=item["price_cents"] / 100, condition=props.get("condition") or "",
            language=props.get("mtg_language") or "", foil=bool(props.get("mtg_foil")),
            zero=bool(user.get("can_sell_via_hub")), country=user.get("country_code") or "",
            quantity=item.get("quantity") or 1,
        )


def fits(listing: Listing, wish: dict[str, Any]) -> bool:
    language = wish["language"] or "any"
    if language != "any" and listing.language != LANGUAGES.get(language, language):
        return False
    if wish["foil"] == "yes" and not listing.foil or wish["foil"] == "no" and listing.foil:
        return False
    if listing.condition not in CONDITIONS or CONDITIONS.index(listing.condition) > GRADE.get(wish["min_condition"], 1):
        return False
    return not (wish["via_zero"] == "yes" and not listing.zero)


def reference(listing: Listing, wish: dict[str, Any]) -> float | None:
    """Cardmarket trend for the listing's finish. A card printed only in foil uses the foil trend
    whatever the listing says: its non-foil trend is noise (e.g. €0.44 against €20 foil)."""
    finishes = wish.get("finishes") or []
    foil = listing.foil or (bool(finishes) and "nonfoil" not in finishes)
    return wish.get("trend_foil") if foil else wish.get("trend")


@dataclass
class Deal:
    wish: dict[str, Any]
    listing: Listing
    reference: float | None
    below_pct: float | None  # how far under the reference, in %
    reasons: list[str]

    @property
    def key(self) -> str:
        """Identifies the wish across want-list edits (line numbers shift)."""
        return f"{self.wish['scryfall_id'] or self.wish['blueprint_id']}|{self.wish['language']}|{self.wish['foil']}"


def best_deal(wish: dict[str, Any], listings: list[Listing]) -> Deal | None:
    matching = sorted((x for x in listings if fits(x, wish)), key=lambda x: x.price)
    if not matching:
        return None
    best = matching[0]
    ref = reference(best, wish)
    pct = wish.get("deal_pct") if wish.get("deal_pct") is not None else DEFAULT_DEAL_PCT
    below = (1 - best.price / ref) * 100 if ref else None
    reasons = []
    if below is not None and below >= pct:
        reasons.append(f"{below:.0f}% under Cardmarket trend")
    if wish.get("max_price_eur") is not None and best.price <= wish["max_price_eur"]:
        reasons.append(f"at or under my €{wish['max_price_eur']:.2f} target")
    return Deal(wish, best, ref, below, reasons) if reasons else None


@dataclass
class CheckResult:
    deals: list[Deal] = field(default_factory=list)  # all current deals
    new: list[Deal] = field(default_factory=list)  # the ones to alert about now
    summary: list[dict[str, Any]] = field(default_factory=list)
    failed_blueprints: list[int] = field(default_factory=list)


def summarize(blueprint_id: int, listings: list[Listing], checked_at: datetime) -> list[dict[str, Any]]:
    """Compact record of one check (open question in spec §7, settled here): per language,
    condition, foil and Zero, the cheapest price and how many listings."""
    groups: dict[tuple, list[Listing]] = {}
    for x in listings:
        groups.setdefault((x.language, x.condition, x.foil, x.zero), []).append(x)
    return [
        {"checked_at": checked_at, "blueprint_id": blueprint_id, "language": lang, "condition": cond, "foil": foil,
         "zero": zero, "min_price": min(x.price for x in xs), "listings": len(xs)}
        for (lang, cond, foil, zero), xs in sorted(groups.items())
    ]


def check(session: Session, watch: list[dict[str, Any]], alerted: dict[str, dict], now: datetime) -> CheckResult:
    """Ask CardTrader about every wished card once, find deals, decide which are new.

    `alerted` (key -> {listing, price, at}) is updated in place: deals that are gone are forgotten,
    so a later deal on the same wish alerts again.
    """
    result = CheckResult()
    by_blueprint: dict[int, list[dict[str, Any]]] = {}
    for wish in watch:
        by_blueprint.setdefault(wish["blueprint_id"], []).append(wish)
    for blueprint_id, wishes in by_blueprint.items():
        body = session.get("/marketplace/products", {"blueprint_id": blueprint_id})
        if not isinstance(body, dict):
            result.failed_blueprints.append(blueprint_id)
            continue
        listings = [x for x in (Listing.from_api(i) for i in body.get(str(blueprint_id)) or []) if x]
        result.summary += summarize(blueprint_id, listings, now)
        for wish in wishes:
            deal = best_deal(wish, listings)
            if deal:
                result.deals.append(deal)
    current = {d.key for d in result.deals}
    checked = {f"{w['scryfall_id'] or w['blueprint_id']}|{w['language']}|{w['foil']}"
               for bp, ws in by_blueprint.items() if bp not in result.failed_blueprints for w in ws}
    for key in list(alerted):
        if key in checked and key not in current:
            del alerted[key]
    for deal in result.deals:
        last = alerted.get(deal.key)
        stale = last and (now - datetime.fromisoformat(last["at"])).days >= REALERT_DAYS
        if not last or deal.listing.price < last["price"] - 0.005 or stale:
            result.new.append(deal)
            alerted[deal.key] = {"listing": deal.listing.id, "price": deal.listing.price, "at": now.isoformat()}
    return result


def cardmarket_context(wish: dict[str, Any], foil: bool) -> str:
    """Cardmarket's cheapest listing and 7-day average for the same finish, to judge the trend."""
    suffix = "_foil" if foil else ""
    parts = [f"{label} €{wish[key + suffix]:.2f}" for key, label in (("low", "lowest"), ("avg7", "7-day average"))
             if wish.get(key + suffix)]
    return "Cardmarket: " + ", ".join(parts) if parts else "Cardmarket: no other prices"


def message(deal: Deal) -> tuple[str, str]:
    """Alert title and text: the card, the listing, why it's a deal, and both marketplaces' links."""
    w, x = deal.wish, deal.listing
    version = ", ".join(w.get("special_tags") or []) or "regular"
    where = f"{(w.get('set_code') or '').upper()} #{w.get('collector_number')}" if w.get("set_code") else "CardTrader"
    finish = "foil" if x.foil else "non-foil"
    lines = [
        f"{w['name']} ({where}, {version})",
        f"€{x.price:.2f} on CardTrader{' via Zero' if x.zero else ''}: "
        + f"{x.condition}, {x.language.upper()}, {finish}, seller in {x.country}",
        "Why: " + "; ".join(deal.reasons) + (f" (trend €{deal.reference:.2f})" if deal.reference else ""),
        cardmarket_context(w, x.foil),
        f"CardTrader: https://www.cardtrader.com/cards/{w['blueprint_id']}",
    ]
    if w.get("cardmarket_id"):
        params = [f"idProduct={w['cardmarket_id']}"]
        if w["language"] in CM_LANGUAGES:
            params.append(f"language={CM_LANGUAGES[w['language']]}")
        params.append(f"minCondition={CM_MIN_CONDITION.get(w['min_condition'], 2)}")
        if w["foil"] in ("yes", "no"):
            params.append(f"isFoil={'Y' if w['foil'] == 'yes' else 'N'}")
        lines.append("Cardmarket: https://www.cardmarket.com/en/Magic/Products?" + "&".join(params))
    if w.get("list"):
        lines.append(f"List: {w['list']}")
    return f"Deal: {w['name']} €{x.price:.2f}", "\n".join(lines)


def cardmarket_targets(watch: list[dict[str, Any]], alerted: dict[str, dict], now: datetime) -> list[tuple[str, str]]:
    """Wishes with a target price whose Cardmarket trend is at or under it (alerted once, again
    only when the trend drops further). Cardmarket can't be checked live (D17), so this uses the
    daily price guide."""
    messages = []
    for w in watch:
        if w.get("max_price_eur") is None:
            continue
        finishes = w.get("finishes") or []
        foil = w["foil"] == "yes" or (bool(finishes) and "nonfoil" not in finishes)
        trend = w.get("trend_foil") if foil else w.get("trend")
        key = f"cardmarket|{w['scryfall_id']}|{w['language']}|{w['foil']}"
        if trend is None or trend > w["max_price_eur"]:
            alerted.pop(key, None)
            continue
        if key in alerted and trend >= alerted[key]["price"] - 0.005:
            continue
        alerted[key] = {"price": trend, "at": now.isoformat()}
        link = f"https://www.cardmarket.com/en/Magic/Products?idProduct={w['cardmarket_id']}" if w.get("cardmarket_id") else ""
        messages.append((
            f"Target: {w['name']} €{trend:.2f} on Cardmarket",
            f"{w['name']}: Cardmarket trend €{trend:.2f} is at or under my €{w['max_price_eur']:.2f} target.\n{link}".strip(),
        ))
    return messages
