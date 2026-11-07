"""Target price suggestions (D55): a target I would realistically hit, from the last 90 days.

For each wish, the best price of each day (the lower of Cardmarket's trend for its finish plus
shipping, D78, and the cheapest CardTrader copy fitting the wish, shipping included via Zero) over the last 90 days; the suggested target is the
price reached on about 15% of those days, rounded down to a clean number. Suggested only where it
helps: a wish with no target, a target never reached in 90 days, or one reached so often that it
rings on ordinary prices. Sent weekly on Telegram (one tap sets it) and shown on the site.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import date
from statistics import median
from typing import Any

from mtg_intel import deals

REACH_PCT = 15.0  # the suggested target is reached on about this share of days
MIN_DAYS = 30  # days of prices needed before suggesting anything
TOO_EASY_PCT = 50.0  # a target reached on more days than this rings on ordinary prices
CLOSE_PCT = 5.0  # a current target this close to the suggestion is left alone
WEEKLY_MAX = 5  # suggestions in the weekly note


@dataclass
class Suggestion:
    key: str
    name: str
    where: str  # "KHM #314"
    target: float
    reached: int  # days at or under the target ...
    days: int  # ... out of these
    usual: float  # the median of the daily best prices
    current: float | None
    reason: str


def nice_floor(price: float) -> float:
    """Round down to a clean price: 10 cents under €5, 25 cents under €20, 50 cents above."""
    step = 0.10 if price < 5 else 0.25 if price < 20 else 0.50
    return round(math.floor(round(price / step, 6)) * step, 2)


def daily_best(cardmarket: list[tuple[str, float]], cardtrader: list[tuple[str, float]]) -> list[tuple[str, float]]:
    best: dict[str, float] = {}
    for d, v in cardmarket + cardtrader:
        if v:
            best[d] = min(best.get(d, v), v)
    return sorted(best.items())


def suggest(wish: dict[str, Any], cardmarket: list[tuple[str, float]],
            cardtrader: list[tuple[str, float]]) -> Suggestion | None:
    series = daily_best(cardmarket, cardtrader)
    if series:
        last = date.fromisoformat(series[-1][0])
        series = [(d, v) for d, v in series if (last - date.fromisoformat(d)).days < deals.TREND_DAYS]
    # A price far under the card's usual level is a data error (Cardmarket's €0.02 trend for
    # Counterspell SLD #7123 against ~€73), as in the deal rule: left out.
    middle = median(v for _, v in series) if series else 0
    series = [(d, v) for d, v in series if v >= middle / deals.REFERENCE_RATIO]
    if len(series) < MIN_DAYS:
        return None
    values = sorted(v for _, v in series)
    target = nice_floor(values[max(0, math.ceil(len(values) * REACH_PCT / 100) - 1)])
    if target <= 0:
        return None
    reached = sum(v <= target for v in values)
    current = wish.get("max_price_eur")
    if current is None:
        reason = "no target yet"
    else:
        hits = sum(v <= current for v in values)
        if abs(current - target) <= target * CLOSE_PCT / 100:
            return None
        if hits == 0:
            reason = f"your €{current:.2f} wasn't reached in {len(values)} days"
        elif hits * 100 / len(values) > TOO_EASY_PCT:
            reason = f"your €{current:.2f} is reached on most days"
        else:
            return None
    where = f"{(wish.get('set_code') or '').upper()} #{wish.get('collector_number')}" if wish.get("set_code") else ""
    return Suggestion(deals.wish_key(wish), deals.front_name(wish["name"]), where, target, reached, len(values),
                      round(median(values), 2), current, reason)


def all_suggestions(watch: list[dict[str, Any]], price_rows: dict[str, list[dict]],
                    check_rows: dict[int, list[dict]]) -> list[Suggestion]:
    """A suggestion per wish that needs one, the most valuable cards first."""
    out = []
    for w in watch:
        foil = w.get("foil") == "yes" or (bool(w.get("finishes")) and "nonfoil" not in w["finishes"])
        cm = deals.with_shipping(deals.trend_points(price_rows.get(w.get("scryfall_id") or "", []), foil))
        ct = deals.cardtrader_points(check_rows.get(w["blueprint_id"], []), w)
        s = suggest(w, cm, ct)
        if s:
            out.append(s)
    return sorted(out, key=lambda s: -s.usual)


def button_data(s: Suggestion) -> str | None:
    """What the "Set" button sends back (the timer Worker reads it): `t|<card>|<language>|<foil>|<cents>`."""
    card, language, foil = s.key.split("|")
    data = "|".join(["t", card.replace("-", ""), language, foil, str(round(s.target * 100))])
    return data if len(data.encode()) <= deals.CALLBACK_LIMIT else None


def weekly_note(suggestions: list[Suggestion], site_url: str | None) -> tuple[str, list[list[dict[str, str]]]] | None:
    """The Sunday note: up to five suggestions, each with a one-tap button that sets it."""
    picked = [s for s in suggestions if button_data(s)][:WEEKLY_MAX]
    if not picked:
        return None

    def h(t: str) -> str:
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    lines = ["🎯 <b>Target suggestions this week</b>", "Prices you'd realistically hit, from the last 90 days.", ""]
    for s in picked:
        lines.append(f"<b>{h(s.name)}</b>" + (f" · {h(s.where)}" if s.where else ""))
        lines.append(f"€{s.target:.2f} · reached on {s.reached} of {s.days} days · usually €{s.usual:.2f}")
        lines.append(h(s.reason.capitalize()))
        lines.append("")
    if site_url:
        lines.append(f"All suggestions: {site_url.rstrip('/')}/wants")
    buttons = [[{"text": f"Set €{s.target:.2f} · {s.name[:24]}", "callback_data": button_data(s)}] for s in picked]
    return "\n".join(lines).strip(), buttons


def site_doc(suggestions: list[Suggestion], now: str) -> dict[str, Any]:
    """For the site: the suggestion per wish key."""
    return {"built_at": now, "targets": {s.key: asdict(s) for s in suggestions}}
