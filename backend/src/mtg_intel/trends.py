"""Weekly price moves (D71): a Monday note on which want-list cards are sliding, have stopped
sliding, or are climbing, from Cardmarket's daily trend.

Each card gets a weekly price: the median of its last 7 days of trend, so one odd day can't move
it. Two comparisons decide the label:
- down at least MOVE_PCT against 4 weeks ago, down at least STILL_PCT against last week and at its
  lowest of the five weeks: falling (wait);
- down at least MOVE_PCT against 4 weeks ago otherwise (flat, up, or bounced off an earlier low):
  stopped falling (a good moment to buy);
- up at least MOVE_PCT against 4 weeks ago: rising (buy soon or let it go).
A slow slide of any shape counts, as long as it adds up to MOVE_PCT in four weeks. Cards whose
weekly price is under MIN_EUR are left out (user, 2026-11-07): their moves are cents.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from statistics import median
from typing import Any
from urllib.parse import quote

from mtg_intel import deals

MIN_EUR = 5.0  # cards usually under this are left out (user, 2026-11-07)
MOVE_PCT = 10.0  # the change over four weeks that counts as a move
STILL_PCT = 2.0  # down at least this much against last week: still falling
WEEK_DAYS = 7
MIN_WEEK_DAYS = 4  # days of prices a week needs to have a weekly price
WEEKS = 4  # how far back the move is measured
MAX_SHOWN = {"falling": 10, "stopped": 10, "rising": 5}  # per section of the note
WEEKDAY, HOUR = 0, 9  # Mondays, with the first check from 9:00 (deals.TIMEZONE)


@dataclass
class Move:
    key: str
    name: str
    where: str  # "KHM #314"
    kind: str  # "falling" | "stopped" | "rising"
    weeks: list[float]  # the weekly price from WEEKS weeks ago to now, oldest first
    change: float  # % against WEEKS weeks ago
    last_week: float  # % against last week


def week_price(points: list[tuple[str, float]], end: date) -> float | None:
    """The median of the prices in the 7 days up to and including `end`, or None with too few days."""
    values = [v for d, v in points if v and 0 <= (end - date.fromisoformat(d)).days < WEEK_DAYS]
    return median(values) if len(values) >= MIN_WEEK_DAYS else None


def move(wish: dict[str, Any], points: list[tuple[str, float]], end: date) -> Move | None:
    """How a card moved over the last four weeks, or None when it didn't move enough to mention."""
    weeks = [week_price(points, end - timedelta(days=WEEK_DAYS * n)) for n in range(WEEKS, -1, -1)]
    now, before, last = weeks[-1], weeks[0], weeks[-2]
    if now is None or before is None or last is None or now < MIN_EUR:
        return None
    change, last_week = (now / before - 1) * 100, (now / last - 1) * 100
    if change <= -MOVE_PCT:
        lowest = all(now <= w for w in weeks if w is not None)  # a bounce off an earlier low has stopped
        kind = "falling" if last_week <= -STILL_PCT and lowest else "stopped"
    elif change >= MOVE_PCT:
        kind = "rising"
    else:
        return None
    where = f"{(wish.get('set_code') or '').upper()} #{wish.get('collector_number')}" if wish.get("set_code") else ""
    return Move(deals.wish_key(wish), deals.front_name(wish["name"]), where, kind,
                [round(w, 2) if w is not None else None for w in weeks], change, last_week)


def weekly_moves(watch: list[dict[str, Any]], price_rows: dict[str, list[dict]]) -> list[Move]:
    """Every want-list card that moved, biggest move first. The weeks end on the latest price day
    in the data (Cardmarket's prices come a day late), the same day for every card."""
    series = {}
    for w in watch:
        foil = w.get("foil") == "yes" or (bool(w.get("finishes")) and "nonfoil" not in w["finishes"])
        series[deals.wish_key(w)] = (w, deals.trend_points(price_rows.get(w.get("scryfall_id") or "", []), foil))
    days = [p[-1][0] for _, p in series.values() if p]
    if not days:
        return []
    end = date.fromisoformat(max(days))
    out = [m for w, p in series.values() if (m := move(w, p, end))]
    return sorted(out, key=lambda m: -abs(m.change))


SECTIONS = [
    ("falling", "📉 <b>Still falling</b> · wait"),
    ("stopped", "🏁 <b>Stopped falling</b> · a good moment to buy"),
    ("rising", "📈 <b>Rising</b> · buy soon or let it go"),
]


def weekly_note(moves: list[Move], site_url: str | None) -> str | None:
    """The Monday note (Telegram HTML): each section with its cards, the weekly prices and the move."""
    if not moves:
        return None

    def h(t: str) -> str:
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def name(m: Move) -> str:
        label = f"<b>{h(m.name)}</b>"
        if site_url:
            label = f'<a href="{h(site_url.rstrip("/"))}/wants?card={quote(m.key, safe="")}">{label}</a>'
        return label + (f" · {h(m.where)}" if m.where else "")

    lines = ["📊 <b>This week's price moves</b>",
             f"Cardmarket trend, each week's typical price, cards over €{MIN_EUR:.0f}.", ""]
    for kind, title in SECTIONS:
        picked = [m for m in moves if m.kind == kind]
        if not picked:
            continue
        more = len(picked) - MAX_SHOWN[kind]
        lines.append(title + (f" · top {MAX_SHOWN[kind]} of {len(picked)}" if more > 0 else ""))
        for m in picked[:MAX_SHOWN[kind]]:
            steps = " → ".join(f"{w:.2f}" for w in m.weeks if w is not None)
            pct = f"{'+' if m.change > 0 else '−'}{abs(m.change):.0f}%"
            lines.append(f"{name(m)}\n€{steps} · {pct} in 4 weeks")
        lines.append("")
    return "\n".join(lines).strip()
