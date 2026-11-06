"""Live deal alerts (D54): from a deal found to a card bought, with the alert always telling the truth.

A new deal's copy goes into my CardTrader cart first: the cart is CardTrader's only uncached view,
so a copy that is already gone never alerts. Every check then reads my cart and my CardTrader
purchases once and brings every open alert up to date: still in the cart, bought (recorded by
itself: off the want-list, onto the Bought list), sold out, taken out of the cart, no longer a
deal, or replaced by a cheaper copy. Paying stays mine (CardTrader's purchase call pays the whole
cart, including things I put there myself).

The decisions are pure functions (tested on their own); `Account` and `Telegram` do the talking.
"""

from __future__ import annotations

import itertools
import secrets
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from mtg_intel import deals
from mtg_intel.archive.notify import TELEGRAM_API

API = "https://api.cardtrader.com/api/v2"
CART_URL = "https://www.cardtrader.com/cart/edit"  # opens in my own language (/en-EU/…, /it-IT/…)
TIMEZONE = ZoneInfo("Europe/Amsterdam")
ORDER_DAYS = 30  # purchases are read this far back (to see cancellations too)
KEEP_DONE_DAYS = 3  # a finished alert is forgotten after this
SLACK_PCT = 5.0  # an open alert ends only when its copy is this many points short of a deal
NIGHT = (23, 8)  # 23:00-08:00: only Steals ring
# A copy gone from the cart counts as gone at once: the cart is read before my purchases, so a copy I
# just paid for shows as bought, and a purchase seen later still turns a "sold out" alert into BOUGHT.
MISSING_CHECKS = 1
LIVE_ORDER_STATES = {"paid", "hub_pending", "sent", "arrived", "done", "request_for_cancel", "lost"}
RETRY_WAITS = (2, 8)


# --- CardTrader: my cart and my purchases ------------------------------------------------------

class Account:
    """My CardTrader cart and purchases (the full API with my own token)."""

    def __init__(self, client: httpx.Client, token: str, sleep=None) -> None:
        import time

        self.client, self.headers, self.sleep = client, {"Authorization": f"Bearer {token}"}, sleep or time.sleep

    def _call(self, method: str, path: str, **kwargs: Any) -> httpx.Response | None:
        for attempt in range(len(RETRY_WAITS) + 1):
            try:
                response = self.client.request(method, f"{API}{path}", headers=self.headers, timeout=30, **kwargs)
                if response.status_code < 500 and response.status_code != 429:
                    return response
            except httpx.TransportError:
                pass
            if attempt < len(RETRY_WAITS):
                self.sleep(RETRY_WAITS[attempt])
        return None

    def cart(self) -> dict | None:
        r = self._call("GET", "/cart")
        return r.json() if r is not None and r.status_code == 200 else None

    def add(self, product_id: int, zero: bool) -> tuple[str, dict | None]:
        """("added", cart) | ("gone", None): CardTrader says the copy no longer exists | ("error", None)."""
        r = self._call("POST", "/cart/add", json={"product_id": product_id, "quantity": 1, "via_cardtrader_zero": zero})
        if r is None:
            return "error", None
        if r.status_code == 200:
            cart = r.json()
            return ("added", cart) if product_id in cart_items(cart) else ("gone", cart)
        if r.status_code in (404, 422):
            return "gone", None
        return "error", None

    def remove(self, product_id: int, quantity: int = 1) -> bool:
        r = self._call("POST", "/cart/remove", json={"product_id": product_id, "quantity": quantity})
        return r is not None and r.status_code == 200

    def zero_box(self) -> list[dict] | None:
        """My CardTrader Zero box: every copy bought via Zero and not shipped yet, live (a Zero
        purchase only becomes an order when the week's box is merged and shipped). Only what a
        purchase needs is kept: sellers' contact details are dropped at once."""
        r = self._call("GET", "/ct0_box_items")
        if r is None or r.status_code != 200:
            return None
        body = r.json()
        items = body if isinstance(body, list) else body.get("array") or []
        keep = ("id", "quantity", "product_id", "blueprint_id", "name", "expansion", "properties", "buyer_price",
                "scryfall_id", "paid_at", "cancelled_at")
        return [{k: i.get(k) for k in keep} for i in items]

    def purchases(self, since: date) -> list[dict] | None:
        """My CardTrader orders as a buyer since `since`, newest first (up to 500)."""
        out: list[dict] = []
        for page in range(1, 6):
            r = self._call("GET", "/orders", params={"order_as": "buyer", "from": since.isoformat(), "sort": "date.desc",
                                                     "limit": 100, "page": page})
            if r is None or r.status_code != 200:
                return None if page == 1 else out
            batch = r.json()
            batch = batch if isinstance(batch, list) else batch.get("array") or []
            out += batch
            if len(batch) < 100:
                break
        return out


def cart_items(cart: dict | None) -> dict[int, tuple[int, float]]:
    """Product ID -> (quantity, price) of what is in the cart."""
    return {int(i["product"]["id"]): (i["quantity"], i["price_cents"] / 100)
            for sub in (cart or {}).get("subcarts") or [] for i in sub.get("cart_items") or []}


def cart_summary(cart: dict | None) -> tuple[float, int]:
    """The cart's total (EUR) and how many cards are in it."""
    total = ((cart or {}).get("total") or {}).get("cents") or 0
    return total / 100, sum(q for q, _ in cart_items(cart).values())


# --- purchases -> want-list edits (D50/D51) -----------------------------------------------------

def _local_day(stamp: str | None, now: datetime) -> str:
    when = datetime.fromisoformat(stamp) if stamp else now
    return when.astimezone(TIMEZONE).date().isoformat()


def _matches(wish: dict[str, Any], item: dict[str, Any]) -> bool:
    props = item.get("properties") or {}
    same_card = (wish.get("scryfall_id") and wish["scryfall_id"] == item.get("scryfall_id")) or \
        (not wish.get("scryfall_id") and wish.get("blueprint_id") == item.get("blueprint_id"))
    if not same_card:
        return False
    language = wish.get("language") or "any"
    if language != "any" and props.get("mtg_language") != deals.LANGUAGES.get(language, language):
        return False
    foil = bool(props.get("mtg_foil"))
    return not (wish.get("foil") == "yes" and not foil or wish.get("foil") == "no" and foil)


def _marker(order: dict[str, Any], item: dict[str, Any]) -> str:
    code = order.get("code") or order["id"]
    return f"{code if str(code).startswith('Zero box') else 'CT order ' + str(code)} #{item.get('product_id')}"


def _purchase(order: dict, item: dict, wish: dict | None, now: datetime) -> dict[str, str]:
    props = item.get("properties") or {}
    foil = bool(props.get("mtg_foil"))
    trend = (wish or {}).get("trend_foil" if foil else "trend") if wish else None
    language = {v: k for k, v in deals.LANGUAGES.items()}.get(props.get("mtg_language") or "", props.get("mtg_language") or "")
    return {
        "price_eur": f"{((item.get('buyer_price') or {}).get('cents') or 0) / 100:.2f}", "market": "cardtrader",
        "condition": deals.CONDITION_GRADE.get(props.get("condition") or "", "NM"), "foil": "yes" if foil else "no",
        "language": language, "date": _local_day(order.get("paid_at"), now),
        "cardmarket_trend_eur": f"{trend:.2f}" if trend else "", "note": _marker(order, item),
    }


def _wish_row(wish: dict[str, Any]) -> dict[str, str]:
    """The want-list CSV row to bring back when an order is cancelled."""
    value = lambda v: "" if v is None else (f"{v:g}" if isinstance(v, float) else str(v))
    return {"name": wish.get("name") or "", "set_code": wish.get("set_code") or "",
            "collector_number": wish.get("collector_number") or "", "scryfall_id": wish.get("scryfall_id") or "",
            "cardtrader_blueprint_id": value(wish.get("blueprint_id")), "language": wish.get("language") or "",
            "foil": wish.get("foil") or "", "min_condition": wish.get("min_condition") or "",
            "via_zero": wish.get("via_zero") or "", "max_price_eur": value(wish.get("max_price_eur")),
            "deal_pct": value(wish.get("deal_pct")), "quantity": "1", "list": wish.get("list") or "",
            "one_of": wish.get("one_of") or ""}


def _card(wish: dict[str, Any]) -> dict[str, Any]:
    """What the site shows for a waiting purchase (as Bought it on the site sends)."""
    image = wish.get("image_url")
    return {"name": wish.get("name"), "set": wish.get("set_code"), "number": wish.get("collector_number"),
            "scryfall_id": wish.get("scryfall_id"), "thumb": image.replace("/normal/", "/small/") if image else None,
            "tags": wish.get("special_tags") or [], "set_name": wish.get("set_name"),
            "lists": [x for x in (wish.get("list") or "").split("; ") if x]}


def box_orders(box: list[dict]) -> list[dict]:
    """My Zero box items as one-item orders: bought copies (`ok` or `pending`), or cancelled when
    CardTrader refunded them (`missing`)."""
    out = []
    for b in box:
        q = b.get("quantity") or {}
        bought = int(q.get("ok") or 0) + int(q.get("pending") or 0)
        state = "paid" if bought else "canceled" if q.get("missing") or b.get("cancelled_at") else None
        if state:
            out.append({"id": f"box{b['id']}", "code": f"Zero box {b['id']}", "state": state, "paid_at": b.get("paid_at"),
                        "order_items": [b | {"quantity": bought or int(q.get("missing") or 1)}]})
    return out


def purchase_edits(orders: list[dict], watch: list[dict[str, Any]], book: dict[str, Any],
                   now: datetime) -> tuple[list[dict], dict[int, float]]:
    """Want-list edits for my CardTrader purchases (D54), and product ID -> price paid for every
    copy bought. `book` (in the deal state) remembers which orders were recorded since when, so
    each is recorded once and a cancelled one is taken back: a copy matching a wish is a `bought`
    edit (off the want-list), any other copy a `collected` one (my collection); a cancelled order
    gives `unbought` edits. Orders paid before the feature started are left alone."""
    since = datetime.fromisoformat(book.setdefault("since", now.isoformat()))
    recorded: dict[str, dict] = book.setdefault("recorded", {})
    wanted = {deals.wish_key(w): dict(w) for w in watch}
    left = {k: int(w.get("quantity") or 1) for k, w in wanted.items()}
    edits: list[dict] = []
    bought: dict[int, float] = {}
    stamp = now.isoformat()

    def edit(kind: str, **fields: Any) -> dict:
        return {"id": secrets.token_urlsafe(9), "at": stamp, "op": kind, "settings": {}, **fields}

    for order in orders:
        paid = order.get("paid_at")
        if not paid or datetime.fromisoformat(paid) < since:
            continue
        oid, state = str(order["id"]), order.get("state")
        if oid in recorded:
            if state == "canceled" and not recorded[oid].get("cancelled"):
                for item in recorded[oid]["items"]:
                    edits.append(edit("unbought", key=item.get("key"), note=item["marker"], wish_row=item.get("wish_row")))
                recorded[oid]["cancelled"] = stamp
            elif state in LIVE_ORDER_STATES:
                for item in recorded[oid]["items"]:
                    bought[int(item["product_id"])] = item["price"]
            continue
        if state not in LIVE_ORDER_STATES:
            continue
        items = []
        for item in order.get("order_items") or []:
            for _ in range(int(item.get("quantity") or 1)):
                key = next((k for k, w in wanted.items() if left[k] > 0 and _matches(w, item)), None)
                wish = wanted.get(key) if key else None
                purchase = _purchase(order, item, wish, now)
                if wish:
                    left[key] -= 1
                    edits.append(edit("bought", key=key, purchase=purchase, card=_card(wish)))
                else:
                    edits.append(edit("collected", purchase=purchase, card_row={
                        "name": item.get("name") or "", "set_code": "", "collector_number":
                        str((item.get("properties") or {}).get("collector_number") or "").lstrip("0"),
                        "scryfall_id": item.get("scryfall_id") or "", "cardtrader_blueprint_id": str(item.get("blueprint_id") or ""),
                        "expansion": item.get("expansion") or ""}))
                items.append({"product_id": item.get("product_id"), "price": float(purchase["price_eur"]),
                              "marker": purchase["note"], "key": key, "wish_row": _wish_row(wish) if wish else None})
                bought[int(item.get("product_id") or 0)] = float(purchase["price_eur"])
        recorded[oid] = {"code": order.get("code"), "paid_at": paid, "items": items}
    cutoff = now - timedelta(days=ORDER_DAYS + 15)
    for oid in [o for o, r in recorded.items() if datetime.fromisoformat(r["paid_at"]) < cutoff]:
        del recorded[oid]
    return edits, bought


# --- what an open alert has become ---------------------------------------------------------------

@dataclass
class Verdict:
    state: str  # open | bought | sold_out | removed | ended | replaced | got_it
    line: str  # the status line under the card's name
    price: float | None = None  # the copy's price now, when it changed


def verdict(alert: dict[str, Any], *, bought_price: float | None, in_cart: bool, cart_price: float | None,
            in_feed: bool, still_deal: bool | None, now: datetime) -> Verdict:
    """What an open alert's copy is now. The cart is the truth: CardTrader drops a copy from it
    once it is sold; a copy gone from the cart but still listed was taken out by me."""
    at = now.astimezone(TIMEZONE).strftime("%H:%M")
    if bought_price is not None:
        return Verdict("bought", f"✅ Bought for €{bought_price:.2f} · recorded, off the want-list")
    if not in_cart and (alert.get("added") or alert.get("there") or not in_feed):
        alert["missing"] = alert.get("missing", 0) + 1
        if alert["missing"] < MISSING_CHECKS:
            return Verdict("open", alert.get("line") or "")
        if in_feed:
            return Verdict("removed", "✕ You took it out of your cart")
        return Verdict("sold_out", f"❌ Missed · someone else bought it first ({at})")
    alert["missing"] = 0
    price = cart_price if cart_price is not None else alert["price"]
    changed = price if abs(price - alert["price"]) >= 0.005 else None
    if still_deal is False:
        why = f"price now €{price:.2f}" if changed and price > alert["price"] else "the usual price moved"
        return Verdict("ended", f"⏹ No longer a deal · {why}", changed)
    return Verdict("open", "", changed)


def still_a_deal(alert: dict[str, Any], price: float, assessment: deals.Assessment | None,
                 wish: dict[str, Any] | None) -> bool | None:
    """Whether the alert's copy, at its price now, still counts (with SLACK_PCT of slack, so an
    alert doesn't flicker on and off); None when this check has no judgement for the wish."""
    if wish and wish.get("max_price_eur") is not None and price <= wish["max_price_eur"]:
        return True
    if assessment is None or not assessment.reference:
        return None
    below = (1 - price / assessment.reference) * 100
    return below >= assessment.floor - SLACK_PCT


def rings(deal: deals.Deal, now: datetime) -> bool:
    """Steals always ring; Great deals ring by day; Good deals and target prices arrive silently."""
    name = deal.tier[1] if deal.tier else ""
    if "Steal" in name:
        return True
    hour = now.astimezone(TIMEZONE).hour
    night = hour >= NIGHT[0] or hour < NIGHT[1]
    return "Great" in name and not night


# --- the alert message ---------------------------------------------------------------------------

def _h(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def cart_line(cart: dict | None, now: datetime) -> str:
    total, cards = cart_summary(cart)
    at = now.astimezone(TIMEZONE).strftime("%H:%M")
    return f"🛒 In your cart · cart €{total:.2f} for {cards} card{'s' if cards != 1 else ''} · checked {at}"


def caption(alert: dict[str, Any], line: str, done: bool = False) -> str:
    """The alert's caption: the card and price (crossed out once the deal is over, unless bought),
    the exact copy, the status line, and the price trends behind a tap."""
    head = alert["head"]
    if done and not line.startswith("✅"):
        head = f"<s>{head}</s>"
    parts = [head, _h(alert["copy"]), _h(alert.get("tip") or ""), f"<b>{_h(line)}</b>" if line else ""]
    text = "\n".join(p for p in parts if p)
    return text + (f"\n\n{alert['details']}" if alert.get("details") else "")


def keyboard(alert: dict[str, Any], done: bool) -> list[list[dict[str, str]]]:
    """Open: Pay, then the links; done: the links. (Skip and Check now were tried and dropped, D58.)"""
    rows = [] if done else [[{"text": "🧾 Pay on CardTrader", "url": CART_URL}]]
    return rows + ([alert["links"]] if alert.get("links") else [])


class Telegram:
    """Sends and edits alerts in my chat (HTML captions)."""

    def __init__(self, client: httpx.Client, token: str, chat_id: str) -> None:
        self.client, self.token, self.chat_id = client, token, chat_id

    def call(self, method: str, body: dict) -> dict | None:
        try:
            r = self.client.post(f"{TELEGRAM_API}/bot{self.token}/{method}", json=body, timeout=30)
            data = r.json()
            if data.get("ok") or "message is not modified" in (data.get("description") or ""):
                return data.get("result") or {}
        except (httpx.HTTPError, ValueError):
            pass
        return None

    def update(self, alert: dict[str, Any], text: str, buttons: list, picture: str | None = None) -> bool:
        target = {"chat_id": self.chat_id, "message_id": alert["message_id"], "reply_markup": {"inline_keyboard": buttons}}
        if alert.get("photo") and picture:
            body = target | {"media": {"type": "photo", "media": picture, "caption": text[:1024], "parse_mode": "HTML"}}
            return self.call("editMessageMedia", body) is not None
        if alert.get("photo"):
            return self.call("editMessageCaption", target | {"caption": text[:1024], "parse_mode": "HTML"}) is not None
        return self.call("editMessageText", target | {"text": text[:4096], "parse_mode": "HTML",
                                                       "link_preview_options": {"is_disabled": True}}) is not None


DONE_PICTURE = {"bought": "bought", "sold_out": "sold", "removed": "ended", "ended": "ended", "replaced": "ended",
                "got_it": "ended"}


def finish(alert: dict[str, Any], v: Verdict, telegram: Telegram, account: Account | None, now: datetime) -> None:
    """Close an alert: its done picture and line, and its copy out of my cart if the bot put it there."""
    if account and alert.get("added") and v.state in ("ended", "replaced", "got_it"):
        account.remove(int(alert["product_id"]))
    alert.update(state=v.state, line=v.line, closed=now.isoformat())
    picture = (alert.get("stamps") or {}).get(DONE_PICTURE.get(v.state, "ended"))
    telegram.update(alert, caption(alert, v.line, done=True), keyboard(alert, done=True), picture)


def refresh(alerts: dict[str, dict], result: deals.CheckResult, watch: list[dict[str, Any]], cart: dict | None,
            bought: dict[int, float], telegram: Telegram, account: Account | None, now: datetime) -> list[str]:
    """Bring every open alert up to date (D54); a line per change, for the log."""
    wishes = {deals.wish_key(w): w for w in watch}
    items = cart_items(cart)
    failed = set(result.failed_blueprints)
    log: list[str] = []
    bought_now: list[dict] = []
    for alert in [a for a in alerts.values() if a.get("closed") and a.get("state") != "bought"]:
        if int(alert["product_id"]) in bought:  # it was me after all: my purchase showed up late
            finish(alert, Verdict("bought", f"✅ Bought for €{bought[int(alert['product_id'])]:.2f} · recorded, "
                                            "off the want-list"), telegram, None, now)
            log.append(f"{alert['name']}: bought after all")
    for alert in [a for a in alerts.values() if not a.get("closed")]:
        pid = int(alert["product_id"])
        if pid not in bought and alert["blueprint_id"] in failed:
            continue  # nothing new about this card this time
        if pid not in items and pid not in bought and not (alert.get("added") or alert.get("there")) and account:
            status, after = account.add(pid, alert.get("zero", True))  # not checked live yet: try again
            if status == "added":
                alert["added"], items, cart = True, cart_items(after), after
        wish = wishes.get(alert["key"])
        in_cart = pid in items
        cart_price = items[pid][1] if in_cart else None
        price = cart_price if cart_price is not None else alert["price"]
        if wish is None and pid not in bought:
            v = Verdict("ended", "⏹ No longer on your want-list")
        else:
            v = verdict(alert, bought_price=bought.get(pid), in_cart=in_cart, cart_price=cart_price,
                        in_feed=pid in result.seen, still_deal=still_a_deal(alert, price, result.assessed.get(alert["key"]), wish),
                        now=now)
        if v.state == "open":
            line = v.line or (cart_line(cart, now) + (f" · price now €{v.price:.2f}" if v.price else "") if in_cart
                              else alert.get("line") or "")
            if line != alert.get("line"):
                telegram.update(alert, caption(alert, line), keyboard(alert, done=False))
                alert["line"] = line
            continue
        finish(alert, v, telegram, account, now)
        log.append(f"{alert['name']}: {v.line}")
        if v.state == "bought":
            bought_now.append(alert)
    # A wish with no copies left: its other open alerts end ("you already bought this one").
    for b in bought_now:
        wish = wishes.get(b["key"]) or {}
        left = int(wish.get("quantity") or 1) - sum(1 for x in bought_now if x["key"] == b["key"])
        group = wish.get("one_of")
        members = {k for k, w in wishes.items() if group and w.get("one_of") == group}
        for other in [a for a in alerts.values() if not a.get("closed")]:
            if (other["key"] == b["key"] and left <= 0) or other["key"] in members - {b["key"]}:
                finish(other, Verdict("got_it", "✓ You already bought this card"), telegram, account, now)
                log.append(f"{other['name']}: already bought")
    return log


FAST_CARDS = 30  # cards the timer Worker checks every minute (D58) ...
FAST_EXPLORE = 5  # ... of which these rotate through all the others, so none is missed for ever
DROP_WINDOW = timedelta(hours=1)
MIN_POINTS = 12  # checks of history needed to learn a card's chance; less: PRIOR_CHANCE
PRIOR_CHANCE = 0.02


def price_series(rows: list[dict[str, Any]], wish: dict[str, Any]) -> list[tuple[datetime, float, int]]:
    """Per check: the cheapest copy fitting the wish and how many fitting copies there were."""
    best: dict[datetime, tuple[float, int]] = {}
    for r in rows:
        x = deals.Listing(0, r["min_price"], r["condition"], r["language"], r["foil"], r["zero"], "", 1)
        if deals.fits(x, wish):
            t = r["checked_at"]
            price, count = best.get(t, (x.price, 0))
            best[t] = (min(price, x.price), count + int(r.get("listings") or 1))
    return sorted((t, p, n) for t, (p, n) in best.items())


def drop_chance(series: list[tuple[datetime, float, int]], gap: float) -> float:
    """How often, over the history, the cheapest copy dropped by at least `gap` euros within an hour."""
    if len(series) < MIN_POINTS:
        return PRIOR_CHANCE
    hits = 0
    for i, (t, price, _) in enumerate(series):
        j = i + 1
        while j < len(series) and series[j][0] - t <= DROP_WINDOW:
            if series[j][1] <= price - gap + 0.005:
                hits += 1
                break
            j += 1
    return hits / len(series)


def fresh_rate(series: list[tuple[datetime, float, int]]) -> float:
    """The share of checks where the number of fitting copies went up: new copies being listed."""
    if len(series) < 2:
        return 0.0
    return sum(b[2] > a[2] for a, b in itertools.pairwise(series)) / (len(series) - 1)


def fast_score(a: deals.Assessment, wish: dict[str, Any], series: list[tuple[datetime, float, int]]) -> float:
    """Chance it becomes a deal soon × what that deal is worth × a bonus for fresh copies (D58):
    the gap is how many euros the cheapest copy must fall to be a deal (or hit the target); the
    chance is how often it fell that far within an hour over the last week; the worth is the
    square root of the euros a deal saves, so pricey cards don't take every place."""
    deal_price = a.reference * (1 - a.floor / 100)
    if wish.get("max_price_eur") is not None:
        deal_price = max(deal_price, wish["max_price_eur"])
    gap = a.listing.price - deal_price
    if gap <= 0:
        return 0.0  # a deal already: the full check has it
    worth = (a.reference * a.floor / 100) ** 0.5
    return drop_chance(series, gap) * worth * (1 + 0.5 * min(1.0, 4 * fresh_rate(series)))


def fast_lane(result: deals.CheckResult, watch: list[dict[str, Any]], gone: dict[str, str],
              history: dict[int, list[dict[str, Any]]] | None = None, now: datetime | None = None) -> list[dict[str, Any]]:
    """The cards the timer Worker checks every minute (D58): the 25 most likely to turn into a
    worthwhile deal soon (fast_score, from the last week of checks), plus 5 that rotate through all
    the others with each check. With what the Worker needs to judge a copy on its own: the wish's
    language, finish, worst condition and Zero, the usual price and the % under needed (or the
    target), the cheapest copy this check saw, and the copies the cart said are gone. A copy it
    finds is handed back to a full check, which alerts."""
    current = {d.key for d in result.deals}
    wishes = {deals.wish_key(w): w for w in watch}
    gone_ids = {int(p) for p in gone}
    candidates = [(k, a) for k, a in result.assessed.items()
                  if k in wishes and k not in current and a.reference and a.below_pct is not None]
    scored = sorted(((fast_score(a, wishes[k], price_series((history or {}).get(wishes[k]["blueprint_id"], []), wishes[k])), k, a)
                     for k, a in candidates), key=lambda ska: (-ska[0], ska[1]))
    top = scored[: FAST_CARDS - FAST_EXPLORE]
    rest = sorted(scored[FAST_CARDS - FAST_EXPLORE:], key=lambda ska: ska[1])
    if rest:  # the explorers: a different slice of the rest at each check (every 5 minutes)
        turn = int((now or utcnow()).timestamp() // 300)
        start = (turn * FAST_EXPLORE) % len(rest)
        top += (rest + rest)[start:start + min(FAST_EXPLORE, len(rest))]
    out = []
    for score, key, a in top:
        w = wishes[key]
        language = w.get("language") or "any"
        out.append({"bp": w["blueprint_id"], "key": key,
                    "lang": "any" if language == "any" else deals.LANGUAGES.get(language, language),
                    "foil": w.get("foil") or "any", "grade": deals.GRADE.get(w.get("min_condition") or "NM", 1),
                    "zero": w.get("via_zero") == "yes", "ref": round(a.reference, 2), "floor": a.floor,
                    "max": w.get("max_price_eur"), "best": a.listing.price, "score": round(score, 4),
                    "gone": sorted(p for p in gone_ids if p in result.seen_by.get(w["blueprint_id"], set()))})
    return out


def prune(alerts: dict[str, dict], now: datetime) -> None:
    for mid in [m for m, a in alerts.items()
                if a.get("closed") and now - datetime.fromisoformat(a["closed"]) > timedelta(days=KEEP_DONE_DAYS)]:
        del alerts[mid]


def utcnow() -> datetime:
    return datetime.now(UTC)
