"""Deal alerts (phase 3, D34, D40).

`watch_table` (built with the tables) holds each want-list wish with its Cardmarket reference
prices. `check` asks CardTrader for the live listings of every wished card, keeps the ones that
fit the wish (language, foil, condition, Zero), and compares the cheapest with its usual price:
the higher of the Cardmarket trend for its finish and the usual CardTrader price for the same wish
(D52, was the lower in D47). At least 30% under is a deal, 20% for cards usually over €20, in
three tiers; at or under my target price is one too. A daily digest says the checks are alive.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from statistics import median
from typing import Any
from urllib.parse import quote

import duckdb
import pyarrow as pa

from mtg_intel.archive.cardtrader import Session
from mtg_intel.archive.notify import Rich

# Deal tiers (D47, D52), strongest first: % under the usual price for a card over PRICEY_EUR,
# name, what the message says. The first number also names the tier on the website.
TIERS = [
    (40.0, "🚨 Steal", "Rarely this cheap. Worth buying now."),
    (30.0, "🔥 Great deal", "Well under what this usually costs."),
    (20.0, "✅ Good deal", "Cheaper than usual, worth a look."),
]
PRICEY_EUR = 20.0  # a card usually over this is a deal from 20% under (user, 2026-11-04) ...
PRICEY_DEAL_PCT = 20.0
DEAL_PCT = 30.0  # ... any other from 30%; its tiers move up by the same 10 points (30/40/50)
DIGEST_HOUR = 8  # the daily digest goes with the first check from this hour (TIMEZONE)
TIMEZONE = "Europe/Amsterdam"
DIGEST_MIN_EUR = 10.0  # the digest's "closest to a deal" lists cards usually over this
REALERT_DAYS = 7  # the same deal at the same price is repeated after a week
USUAL_DAYS = 7  # the usual CardTrader Zero price: median of the cheapest per check over this window
USUAL_MIN_DAYS = 3  # with less history, the next-cheapest listing stands in
# A Cardmarket trend this many times under CardTrader's own usual price is a data error, not a
# market (e.g. €0.02 for Counterspell SLD #7123 against €12.66): taking the lower of the two would
# block every deal on the card, so the trend is shown but not used.
REFERENCE_RATIO = 2.5
PROBLEM_REALERT = timedelta(hours=6)  # the same check problem is repeated at most this often

# CardTrader condition words, best first, and the want-list grade each one meets.
CONDITIONS = ["Mint", "Near Mint", "Slightly Played", "Moderately Played", "Played", "Heavily Played", "Poor"]
GRADE = {"NM": 1, "SP": 2, "MP": 3, "PL": 5, "PO": 6}  # worst CONDITIONS index each grade accepts
LANGUAGES = {"ja": "jp"}  # want-list (Scryfall) code -> CardTrader code; the rest are equal

# Cardmarket product-page filters (language ids and minimum condition ids are Cardmarket's).
CM_LANGUAGES = {"en": 1, "fr": 2, "de": 3, "es": 4, "it": 5, "zhs": 6, "ja": 7, "pt": 8, "ru": 9, "ko": 10, "zht": 11}
CM_MIN_CONDITION = {"NM": 2, "SP": 3, "MP": 4, "PL": 5, "PO": 7}
CM_SELLER_COUNTRY = 23  # the Netherlands: the only sellers I buy from on Cardmarket (low shipping)


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
            try_cast(w.deal_pct as double) as deal_pct, w.list, w.one_of, try_cast(w.quantity as integer) as quantity, c.cardmarket_id, c.image_url, c.set_name{", " + prices if prices else ""}
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
    seller: str = ""  # the seller's CardTrader username, to find the copy on the page

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
            quantity=item.get("quantity") or 1, seller=user.get("username") or "",
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


def cardmarket_reference(listing: Listing, wish: dict[str, Any]) -> float | None:
    """Cardmarket trend for the listing's finish. A card printed only in foil uses the foil trend
    whatever the listing says: its non-foil trend is noise (e.g. €0.44 against €20 foil)."""
    finishes = wish.get("finishes") or []
    foil = listing.foil or (bool(finishes) and "nonfoil" not in finishes)
    return (wish.get("trend_foil") if foil else wish.get("trend")) or None


def usual_zero_price(wish: dict[str, Any], history: list[dict[str, Any]], now: datetime) -> float | None:
    """Median over the last week of the cheapest listing fitting this wish in each past check
    (from the check summaries), or None with less than `USUAL_MIN_DAYS` days of history."""
    cheapest: dict[datetime, float] = {}
    since = now - timedelta(days=USUAL_DAYS)
    for row in history:
        listing = Listing(0, row["min_price"], row["condition"], row["language"], row["foil"], row["zero"], "", 1)
        if row["checked_at"] >= since and row["checked_at"] < now and fits(listing, wish):
            cheapest[row["checked_at"]] = min(cheapest.get(row["checked_at"], row["min_price"]), row["min_price"])
    if len({t.date() for t in cheapest}) < USUAL_MIN_DAYS:
        return None
    return median(cheapest.values())


@dataclass
class Assessment:
    """How the cheapest fitting copy of a wish compares with its usual price."""

    listing: Listing  # the cheapest fitting copy
    cardmarket: float | None  # Cardmarket trend for the listing's finish
    cardtrader: float | None  # usual (or next-cheapest) CardTrader price for the wish
    cardtrader_kind: str  # "usual price" | "next cheapest copy" | ""
    cardmarket_trusted: bool  # False: the trend looks wrong (REFERENCE_RATIO) and is not used
    reference: float | None  # the usual price the copy is judged against
    below_pct: float | None  # how far under `reference`, in %
    floor: float  # % under needed for a deal
    tier: tuple[float, str, str] | None


@dataclass
class Deal:
    wish: dict[str, Any]
    listing: Listing
    cardmarket: float | None  # Cardmarket trend for the listing's finish
    cardtrader: float | None  # usual (or next-cheapest) CardTrader price for the wish
    cardtrader_kind: str  # "usual price" | "next cheapest copy" | ""
    below_pct: float | None  # how far under the usual price, in %
    tier: tuple[float, str, str] | None
    reasons: list[str]
    cardmarket_trusted: bool = True  # False: the trend looks wrong (REFERENCE_RATIO) and was not used
    reference: float | None = None  # the usual price the copy was judged against
    floor: float = DEAL_PCT

    @property
    def key(self) -> str:
        """Identifies the wish across want-list edits (line numbers shift)."""
        return wish_key(self.wish)


def wish_key(wish: dict[str, Any]) -> str:
    return f"{wish['scryfall_id'] or wish['blueprint_id']}|{wish['language']}|{wish['foil']}"


def assess(wish: dict[str, Any], listings: list[Listing], usual: float | None = None) -> Assessment | None:
    """Judge the cheapest fitting copy against the usual price (D52): the higher of the Cardmarket
    trend and CardTrader's usual price, so a copy cheap on either market counts. CardTrader's next
    cheapest copy (before 3 days of history) is only used without a Cardmarket trend: one pricey
    listing must not make an ordinary copy look like a steal."""
    matching = sorted((x for x in listings if fits(x, wish)), key=lambda x: x.price)
    if not matching:
        return None
    best = matching[0]
    cardmarket = cardmarket_reference(best, wish)
    if usual is not None:
        cardtrader, kind = usual, "usual price"
    elif len(matching) > 1:
        cardtrader, kind = matching[1].price, "next cheapest copy"
    else:
        cardtrader, kind = None, ""
    trusted = not (cardmarket and cardtrader and max(cardmarket, cardtrader) > REFERENCE_RATIO * min(cardmarket, cardtrader))
    references = [cardmarket] if cardmarket and trusted else []
    if cardtrader and (kind == "usual price" or not references):
        references.append(cardtrader)
    reference = max(references) if references else None
    below = round((1 - best.price / reference) * 100, 6) if reference else None  # exact 20% stays 20
    base = PRICEY_DEAL_PCT if reference and reference > PRICEY_EUR else DEAL_PCT
    floor = wish.get("deal_pct") if wish.get("deal_pct") is not None else base
    tier = None
    if below is not None and below >= floor:
        offset = base - TIERS[-1][0]
        tier = next((t for t in TIERS if below >= t[0] + offset), TIERS[-1])
    return Assessment(best, cardmarket, cardtrader, kind, trusted, reference, below, floor, tier)


def deal_of(wish: dict[str, Any], a: Assessment) -> Deal | None:
    reasons = [f"{a.below_pct:.0f}% under its usual €{a.reference:.2f} (a deal from {a.floor:.0f}%)"] if a.tier else []
    if wish.get("max_price_eur") is not None and a.listing.price <= wish["max_price_eur"]:
        reasons.append(f"at or under my €{wish['max_price_eur']:.2f} target")
    if not reasons:
        return None
    return Deal(wish, a.listing, a.cardmarket, a.cardtrader, a.cardtrader_kind, a.below_pct, a.tier, reasons,
                a.cardmarket_trusted, a.reference, a.floor)


def best_deal(wish: dict[str, Any], listings: list[Listing], usual: float | None = None) -> Deal | None:
    a = assess(wish, listings, usual)
    return deal_of(wish, a) if a else None


@dataclass
class CheckResult:
    deals: list[Deal] = field(default_factory=list)  # all current deals
    new: list[Deal] = field(default_factory=list)  # the ones to alert about now
    summary: list[dict[str, Any]] = field(default_factory=list)
    failed_blueprints: list[int] = field(default_factory=list)  # not checked: request failed or out of time
    late_blueprints: list[int] = field(default_factory=list)  # the part of failed_blueprints left for lack of time
    cheapest: dict[str, Listing] = field(default_factory=dict)  # wish key -> cheapest fitting listing
    counts: dict[str, int] = field(default_factory=dict)  # wish key -> fitting listings
    usual: dict[str, tuple[float | None, str]] = field(default_factory=dict)  # wish key -> CardTrader reference
    assessed: dict[str, Assessment] = field(default_factory=dict)  # wish key -> how close to a deal
    seen: set[int] = field(default_factory=set)  # every listing ID this check saw (live alerts, D54)


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


def check(session: Session, watch: list[dict[str, Any]], alerted: dict[str, dict], now: datetime,
          history: dict[int, list[dict[str, Any]]] | None = None,
          out_of_time: Callable[[], bool] = lambda: False) -> CheckResult:
    """Ask CardTrader about every wished card once, find deals, decide which are new.
    `history` holds earlier check summaries per blueprint, for the usual CardTrader price.
    Once `out_of_time()` says so, the cards still to ask count as failed: a slow CardTrader must
    not stretch one check over the next ones (two hung for 25 minutes on 2026-11-03).

    `alerted` (key -> {listing, price, at}) is updated in place: deals that are gone are forgotten,
    so a later deal on the same wish alerts again.
    """
    result = CheckResult()
    by_blueprint: dict[int, list[dict[str, Any]]] = {}
    for wish in watch:
        by_blueprint.setdefault(wish["blueprint_id"], []).append(wish)
    for blueprint_id, wishes in by_blueprint.items():
        if out_of_time():
            result.failed_blueprints.append(blueprint_id)
            result.late_blueprints.append(blueprint_id)
            continue
        body = session.get("/marketplace/products", {"blueprint_id": blueprint_id})
        if not isinstance(body, dict):
            result.failed_blueprints.append(blueprint_id)
            continue
        listings = [x for x in (Listing.from_api(i) for i in body.get(str(blueprint_id)) or []) if x]
        result.seen.update(x.id for x in listings)
        result.summary += summarize(blueprint_id, listings, now)
        for wish in wishes:
            key = wish_key(wish)
            usual = usual_zero_price(wish, (history or {}).get(blueprint_id, []), now)
            a = assess(wish, listings, usual)
            if a is None:
                continue
            result.assessed[key] = a
            result.cheapest[key], result.counts[key] = a.listing, sum(fits(x, wish) for x in listings)
            if a.cardtrader is not None:
                result.usual[key] = (a.cardtrader, a.cardtrader_kind)
            deal = deal_of(wish, a)
            if deal:
                result.deals.append(deal)
    # Alternatives (`one_of`): a deal on one version is no deal when another is cheaper right now.
    groups: dict[str, list[str]] = {}
    for w in watch:
        if w.get("one_of"):
            groups.setdefault(w["one_of"], []).append(wish_key(w))
    result.deals = [
        d for d in result.deals
        if not any((result.cheapest[k].price if k in result.cheapest else float("inf")) < d.listing.price - 0.005
                   for k in groups.get(d.wish.get("one_of") or "", []) if k != d.key)
    ]
    current = {d.key for d in result.deals}
    checked = {wish_key(w) for bp, ws in by_blueprint.items() if bp not in result.failed_blueprints for w in ws}
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
    """Alert title and text: how strong the deal is, the card, the listing, what it was compared
    with, and both marketplaces' links."""
    w, x = deal.wish, deal.listing
    version = ", ".join(w.get("special_tags") or []) or "regular"
    where = f"{(w.get('set_code') or '').upper()} #{w.get('collector_number')}" if w.get("set_code") else "CardTrader"
    finish = "foil" if x.foil else "non-foil"
    label, advice = (deal.tier[1], deal.tier[2]) if deal.tier else ("🎯 Target price", "At or under the price I set.")
    def off(reference: float) -> str:
        pct = (1 - x.price / reference) * 100
        return f"{pct:.0f}% less" if pct >= 0 else f"{-pct:.0f}% more"

    compared = [(f"Cardmarket trend €{deal.cardmarket:.2f} ({off(deal.cardmarket)})" if deal.cardmarket_trusted
                 else f"Cardmarket trend €{deal.cardmarket:.2f} (looks wrong, not used)") if deal.cardmarket else "",
                f"CardTrader Zero {deal.cardtrader_kind} €{deal.cardtrader:.2f} ({off(deal.cardtrader)})"
                if deal.cardtrader else ""]
    lines = [
        advice,
        f"{w['name']} ({where}, {version})",
        f"€{x.price:.2f} on CardTrader{' via Zero' if x.zero else ''}: "
        + f"{x.condition}, {x.language.upper()}, {finish}, seller in {x.country}",
        "Why: " + "; ".join(deal.reasons),
        "Compared with: " + ", ".join(c for c in compared if c) if any(compared) else "",
        cardmarket_context(w, x.foil),
        f"Open on CardTrader: https://www.cardtrader.com/cards/{w['blueprint_id']}",
    ]
    if w.get("cardmarket_id"):
        lines.append("Open on Cardmarket: " + cardmarket_url(w))
    if w.get("list"):
        lines.append(f"List: {w['list']}")
    pct = f" ({deal.below_pct:.0f}% under)" if deal.tier else ""
    return f"{label}: {w['name']} €{x.price:.2f}{pct}", "\n".join(line for line in lines if line)


CONDITION_GRADE = {"Mint": "NM", "Near Mint": "NM", "Slightly Played": "SP", "Moderately Played": "MP",
                   "Played": "PL", "Heavily Played": "PL", "Poor": "PO"}  # CardTrader words -> want-list grades
CALLBACK_LIMIT = 64  # bytes Telegram allows in a button's callback data


def bought_data(deal: Deal) -> str | None:
    """What the "Bought it" button sends back (the site Worker reads it): the wish key and the
    copy bought, packed under Telegram's 64 bytes. `b|<scryfall id without dashes, or blueprint>|
    <wish language>|<wish foil>|<price in cents>|<grade>|<copy foil 1/0>|<copy language>`."""
    x = deal.listing
    card, language, foil = deal.key.split("|")
    card = card.replace("-", "")
    copy_language = {v: k for k, v in LANGUAGES.items()}.get(x.language, x.language)
    data = "|".join(["b", card, language, foil, str(round(x.price * 100)),
                     CONDITION_GRADE.get(x.condition, "NM"), "1" if x.foil else "0", copy_language])
    return data if len(data.encode()) <= CALLBACK_LIMIT and "|" not in card else None


def _h(text: object) -> str:
    """Escape text for Telegram's HTML."""
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def version_line(deal: Deal) -> tuple[str, str]:
    """Which printing and which copy: ("KHM #314 · Showcase", "NM · EN · Non-foil · Zero")."""
    w, x = deal.wish, deal.listing
    printing = [f"{(w.get('set_code') or '').upper()} #{w.get('collector_number')}" if w.get("set_code") else "",
                ", ".join(t.capitalize() for t in w.get("special_tags") or [])]
    copy = [CONDITION_GRADE.get(x.condition, x.condition), x.language.upper(), "Foil" if x.foil else "Non-foil",
            "Zero" if x.zero else ""]
    return " · ".join(p for p in printing if p), " · ".join(c for c in copy if c)


def front_name(name: str) -> str:
    """A double-faced card by its front face: "Esika, God of the Tree", not "… // The Prismatic Bridge"."""
    return name.split(" // ")[0]


def _less(price: float, usual: float) -> str:
    pct = (1 - price / usual) * 100
    return f"−{pct:.0f}%" if pct >= 0.5 else f"+{-pct:.0f}%" if pct <= -0.5 else "same"


SPARK = "▁▂▃▄▅▆▇█"
TREND_DAYS = 90
FLAT_PCT = 5.0  # a month's change smaller than this is "steady"


def trend_points(rows: list[dict[str, Any]], foil: bool) -> list[tuple[str, float]]:
    """One printing's Cardmarket trend per day for one finish, oldest first, from `my/price_history`
    rows: the archived Cardmarket price guide where we have it, MTGJSON's Cardmarket prices before."""
    finish = "foil" if foil else "normal"
    by_day: dict[str, tuple[int, float]] = {}
    for r in rows:
        if r["finish"] != finish or not r.get("trend"):
            continue
        day = str(r["price_date"])[:10]
        rank = 0 if r["source"] == "cardmarket" else 1
        if day not in by_day or rank < by_day[day][0]:
            by_day[day] = (rank, r["trend"])
    return [(d, v) for d, (_, v) in sorted(by_day.items())]


COUNTRIES = {"IT": "Italy", "DE": "Germany", "FR": "France", "ES": "Spain", "NL": "the Netherlands", "BE": "Belgium",
             "AT": "Austria", "PT": "Portugal", "PL": "Poland", "IE": "Ireland", "LU": "Luxembourg", "DK": "Denmark",
             "SE": "Sweden", "FI": "Finland", "CZ": "Czechia", "SK": "Slovakia", "SI": "Slovenia", "HR": "Croatia",
             "GR": "Greece", "HU": "Hungary", "RO": "Romania", "BG": "Bulgaria", "MT": "Malta", "CY": "Cyprus",
             "EE": "Estonia", "LV": "Latvia", "LT": "Lithuania", "GB": "the UK", "CH": "Switzerland", "US": "the US",
             "CA": "Canada", "JP": "Japan"}


def cardtrader_points(rows: list[dict[str, Any]], wish: dict[str, Any]) -> list[tuple[str, float]]:
    """The cheapest CardTrader copy fitting a wish on each day, oldest first, from the daily check
    summaries (`checks/daily`, one row per check, language, condition, foil and Zero)."""
    cheapest: dict[str, float] = {}
    for r in rows:
        x = Listing(0, r["min_price"], r["condition"], r["language"], r["foil"], r["zero"], "", 1)
        if fits(x, wish):
            day = str(r["checked_at"])[:10]
            cheapest[day] = min(cheapest.get(day, x.price), x.price)
    return sorted(cheapest.items())


def price_trend(points: list[tuple[str, float]], now: float | None, title: str, min_days: int = 14) -> list[str]:
    """Where a price has been over the last 90 days (user, 2026-11-06), from (date, price) points,
    oldest first: a title (with "since <date>" while there is less history), a sparkline, the
    change over a month and over three months, and the lowest and highest with their dates.
    Empty with under `min_days` of history."""
    from datetime import date

    points = [(d, v) for d, v in points if v]
    if not points:
        return []
    last = date.fromisoformat(points[-1][0])
    points = [(d, v) for d, v in points if (last - date.fromisoformat(d)).days <= TREND_DAYS]
    first = date.fromisoformat(points[0][0])
    if (last - first).days < min_days:
        return []
    now = now or points[-1][1]
    span = (last - first).days + 1
    steps = min(13, span)
    buckets: list[list[float]] = [[] for _ in range(steps)]
    for d, v in points:
        buckets[min(steps - 1, (date.fromisoformat(d) - first).days * steps // span)].append(v)
    means = [sum(b) / len(b) for b in buckets if b]
    lo, hi = min(means), max(means)
    spark = "".join(SPARK[0 if hi == lo else round((m - lo) / (hi - lo) * (len(SPARK) - 1))] for m in means)

    def ago(days: int) -> float | None:
        before = [v for d, v in points if (last - date.fromisoformat(d)).days >= days]
        return before[-1] if before else None

    def change(old: float, when: str) -> str:
        pct = (now / old - 1) * 100
        move = "Steady" if abs(pct) < FLAT_PCT else f"{'Up' if pct > 0 else 'Down'} {abs(pct):.0f}%"
        return f"{move} {when} (was €{old:.2f})"

    day = lambda d: date.fromisoformat(d).strftime("%-d %b")
    low = min(points, key=lambda p: p[1])
    high = max(points, key=lambda p: p[1])
    month, quarter = ago(30), ago(85)
    window = "90 days" if (last - first).days >= 85 else f"since {day(points[0][0])}"
    return [f"{title} · {window}", spark,
            *([change(month, "in a month")] if month else []),
            *([change(quarter, "in 3 months")] if quarter else []),
            f"Lowest €{low[1]:.2f} · {day(low[0])}",
            f"Highest €{high[1]:.2f} · {day(high[0])}"]


def telegram(deal: Deal, site_url: str | None = None, preview: str | None = None,
             photo: bytes | None = None, history: list[list[str]] | None = None) -> Rich:
    """The deal as a Telegram message (user, 2026-11-06): the strength, the card, then each market
    against its own usual price (CardTrader: this copy against its usual; Cardmarket: its lowest
    against its trend); the rest in a quote that opens on a tap; buttons for "Bought it" and the
    marketplaces. `preview` is the site's preview page for this card: Telegram shows the card's
    picture small, beside its printing and the copy's condition, language and finish. With `photo`
    (the deal's image, dealimage.py) the alert is that image, captioned with one line for the lock
    screen and the same details behind a tap; the text version stays as the fallback."""
    w, x = deal.wish, deal.listing
    head = f"{deal.tier[1]} · {deal.below_pct:.0f}% under" if deal.tier else "🎯 Target price"
    if deal.cardtrader:
        usual = "usually" if deal.cardtrader_kind == "usual price" else "next copy"
        ct = f"€{x.price:.2f} · {usual} €{deal.cardtrader:.2f} ({_less(x.price, deal.cardtrader)})"
    else:
        ct = f"€{x.price:.2f}"
    lines = [_h(head), f"<b>{_h(front_name(w['name']))}</b>", f"<b>CardTrader</b>  {_h(ct)}"]
    foil = x.foil or (bool(w.get("finishes")) and "nonfoil" not in w["finishes"])
    low = w.get("low_foil" if foil else "low")
    if deal.cardmarket:
        trend = f"trend €{deal.cardmarket:.2f}" + ("" if deal.cardmarket_trusted else " (looks wrong, not used)")
        cm = f"from €{low:.2f} · {trend} ({_less(low, deal.cardmarket)})" if low and deal.cardmarket_trusted else trend
        lines.append(f"<b>Cardmarket</b>  {_h(cm)}")
    printing, copy = version_line(deal)
    if not preview:
        lines.append(_h(" · ".join(p for p in (printing, copy) if p)))

    # The details, behind a tap: the price trends, each a section with a bold title, a blank line
    # between them (user, 2026-11-06; "why it's a deal", the seller and the list were dropped).
    sections = [s for s in (history or []) if s]
    details = ("<blockquote expandable>" + "\n\n".join(
        "\n".join([f"<b>{_h(section[0])}</b>", *(_h(line) for line in section[1:])]) for section in sections
    ) + "</blockquote>") if sections else ""
    if details:
        lines += ["", details]
    buttons: list[list[dict[str, str]]] = []
    data = bought_data(deal)
    if data:
        buttons.append([{"text": "🛒 Bought it", "callback_data": data}])
    links = [{"text": "CardTrader", "url": f"https://www.cardtrader.com/cards/{w['blueprint_id']}"}]
    if w.get("cardmarket_id"):
        links.append({"text": "Cardmarket", "url": cardmarket_url(w)})
    if site_url:
        links.append({"text": "Site", "url": f"{site_url.rstrip('/')}/wants?card={quote(deal.key, safe='')}"})
    buttons.append(links)
    label = f"{deal.tier[1]} · " if deal.tier else "🎯 Target · "
    head = f"{_h(label)}<b>{_h(front_name(w['name']))}</b> · €{x.price:.2f}"
    caption = head + (f"\n\n{details}" if details else "")
    return Rich("\n".join(lines), buttons, preview, photo, caption, head=head, details=details, links=links)


LANGUAGE_NAMES = {"en": "English", "jp": "Japanese", "ja": "Japanese", "it": "Italian", "fr": "French", "de": "German",
                  "es": "Spanish", "pt": "Portuguese", "ko": "Korean", "ru": "Russian", "zh-CN": "Chinese",
                  "zh-TW": "Chinese (trad.)"}
CONDITION_NAMES = {"NM": "Near Mint", "SP": "Slightly Played", "MP": "Moderately Played", "PL": "Played", "PO": "Poor"}


def copy_line(listing: Listing) -> str:
    """Exactly which copy (user, 2026-11-06: "I need to know exactly what I'm buying"):
    "Near Mint · English · Non-foil · Zero · Magicfree (Italy)"."""
    x = listing
    seller = (f"{x.seller} ({COUNTRIES.get(x.country, x.country)})" if x.country else x.seller) if x.seller else \
        (f"seller in {COUNTRIES.get(x.country, x.country)}" if x.country else "")
    return " · ".join(p for p in [CONDITION_NAMES.get(CONDITION_GRADE.get(x.condition, ""), x.condition),
                                  LANGUAGE_NAMES.get(x.language, x.language.upper()), "Foil" if x.foil else "Non-foil",
                                  "Zero" if x.zero else "", seller] if p)


def cardmarket_url(w: dict[str, Any]) -> str:
    """Cardmarket product page filtered to Dutch sellers and the wish's language, condition and foil."""
    params = [f"idProduct={w['cardmarket_id']}", f"sellerCountry={CM_SELLER_COUNTRY}"]
    if w["language"] in CM_LANGUAGES:
        params.append(f"language={CM_LANGUAGES[w['language']]}")
    params.append(f"minCondition={CM_MIN_CONDITION.get(w['min_condition'], 2)}")
    if w["foil"] in ("yes", "no"):
        params.append(f"isFoil={'Y' if w['foil'] == 'yes' else 'N'}")
    return "https://www.cardmarket.com/en/Magic/Products?" + "&".join(params)


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


def problem_alert(state: dict[str, Any], problems: list[str], now: datetime) -> tuple[str, str] | None:
    """The alert to send about this check's problems, if any: the first time, again after
    `PROBLEM_REALERT` while it lasts, and once when it is over. Remembered in `state["problem"]`,
    so an outage (CardTrader down, an expired token) is one message, not one every 10 minutes."""
    last = state.get("problem")
    if problems:
        text = "\n".join(problems)
        if last and now - datetime.fromisoformat(last["at"]) < PROBLEM_REALERT:
            return None
        state["problem"] = {"at": now.isoformat(), "since": (last or {}).get("since", now.isoformat()), "text": text}
        return "mtg-intel deal check needs a look", text
    if last:
        del state["problem"]
        return "mtg-intel deal check is fine again", f"The problem seen since {last['since']} is gone."
    return None


def record_check(state: dict[str, Any], now: datetime, failed: int, alerts: int) -> None:
    """Keep a day of check results in the state, for the digest."""
    since = now - timedelta(hours=24)
    recent = [r for r in state.get("recent", []) if datetime.fromisoformat(r["at"]) > since]
    state["recent"] = recent + [{"at": now.isoformat(), "failed": failed, "alerts": alerts}]


def digest(state: dict[str, Any], result: CheckResult, watch: list[dict[str, Any]], now: datetime,
           site_url: str | None = None) -> tuple[str, str] | None:
    """The daily note (user, 2026-11-04), sent with the first check from DIGEST_HOUR: that checks
    run, what they found, and the three cards over DIGEST_MIN_EUR closest to a deal, so a quiet bot
    is never mistaken for a broken one."""
    from zoneinfo import ZoneInfo

    local = now.astimezone(ZoneInfo(TIMEZONE))
    if local.hour < DIGEST_HOUR or state.get("digest_on") == local.date().isoformat():
        return None
    state["digest_on"] = local.date().isoformat()
    recent = state.get("recent", [])
    first = datetime.fromisoformat(recent[0]["at"]) if recent else now
    span = "Last 24 h" if now - first > timedelta(hours=23) else f"Since {first.astimezone(ZoneInfo(TIMEZONE)):%H:%M}"
    lines = [(f"{span}: {len(recent)} checks (one every 10 minutes is 144 a day), "
              f"{sum(r['alerts'] for r in recent)} alerts sent, "
              f"{sum(1 for r in recent if r['failed'])} checks with cards not reached.")]
    if state.get("problem"):
        lines.append(f"⚠️ Problem since {state['problem']['since'][:16]}Z: {state['problem']['text']}")
    names = {wish_key(w): w for w in watch}
    if result.deals:
        lines.append("")
        lines.append(f"Deals right now ({len(result.deals)}):")
        lines += [f"• {d.wish['name']} €{d.listing.price:.2f}" + (f", {d.below_pct:.0f}% under" if d.tier else ", target")
                  for d in sorted(result.deals, key=lambda d: -(d.below_pct or 0))[:5]]
    dealt = {d.key for d in result.deals}
    close = sorted(
        ((k, a) for k, a in result.assessed.items()
         if k not in dealt and k in names and a.reference and a.reference > DIGEST_MIN_EUR and a.below_pct is not None),
        key=lambda ka: ka[1].floor - ka[1].below_pct)[:3]
    if close:
        lines.append("")
        lines.append(f"Closest to a deal (usually over €{DIGEST_MIN_EUR:.0f}):")
        for k, a in close:
            w = names[k]
            where = f" ({(w.get('set_code') or '').upper()} #{w.get('collector_number')})" if w.get("set_code") else ""
            gap = f"{a.below_pct:.0f}% under" if a.below_pct >= 0 else f"{-a.below_pct:.0f}% over"
            lines.append(f"• {w['name']}{where}: €{a.listing.price:.2f}, {gap} its usual €{a.reference:.2f}, "
                         f"a deal from {a.floor:.0f}%")
    if site_url:
        lines += ["", site_url.rstrip("/") + "/"]
    title = "☀️ mtg-intel: " + (f"{len(result.deals)} deals live" if result.deals else "all quiet, checks running")
    return title, "\n".join(lines)
