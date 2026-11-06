"""Live deal alerts (D54): purchases recorded by themselves, alerts that stay true."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from test_deals import listing, wish
from test_tables import two_printings

from mtg_intel import deals, lifecycle
from mtg_intel.tables import mycards

NOW = datetime(2026, 11, 6, 13, 0, tzinfo=UTC)  # 14:00 in Amsterdam


def order(oid=1, state="paid", paid="2026-11-06T12:40:00.000Z", items=None):
    return {"id": oid, "code": f"2026110{oid}abc", "state": state, "paid_at": paid, "order_items": items or []}


def item(product=500, scryfall="sf-loki", cents=288, language="en", foil=False, condition="Near Mint", quantity=1):
    return {"product_id": product, "blueprint_id": 10, "scryfall_id": scryfall, "name": "Loki, God of Mischief",
            "quantity": quantity, "buyer_price": {"cents": cents, "currency": "EUR"}, "expansion": "Marvel",
            "properties": {"condition": condition, "mtg_language": language, "mtg_foil": foil, "collector_number": "343"}}


def test_my_purchases_become_want_list_edits_once():
    book = {"since": "2026-11-06T12:00:00+00:00"}
    watch = [wish(quantity=1)]
    orders = [order(1, items=[item(), item(product=501, scryfall="sf-other", cents=120)]),
              order(2, paid="2026-11-01T10:00:00Z", items=[item(product=502)])]  # before the feature started
    edits, bought = lifecycle.purchase_edits(orders, watch, book, NOW)
    assert [(e["op"], e.get("key")) for e in edits] == [("bought", "sf-loki|en|any"), ("collected", None)]
    p = edits[0]["purchase"]
    assert (p["price_eur"], p["condition"], p["foil"], p["language"], p["date"], p["cardmarket_trend_eur"]) == \
        ("2.88", "NM", "no", "en", "2026-11-06", "4.67")
    assert p["note"] == "CT order 20261101abc #500" and edits[0]["card"]["name"] == "Loki, God of Mischief"
    assert edits[1]["card_row"]["scryfall_id"] == "sf-other" and edits[1]["card_row"]["collector_number"] == "343"
    assert bought == {500: 2.88, 501: 1.2}
    # The next check sees the same order: nothing new to record, but it still counts as bought.
    again, bought = lifecycle.purchase_edits(orders, watch, book, NOW + timedelta(minutes=10))
    assert again == [] and bought == {500: 2.88, 501: 1.2}
    # Cancelled: both purchases are taken back, the wish with its row.
    orders[0]["state"] = "canceled"
    undo, bought = lifecycle.purchase_edits(orders, watch, book, NOW + timedelta(hours=1))
    assert [(e["op"], e.get("key"), e["note"]) for e in undo] == [
        ("unbought", "sf-loki|en|any", "CT order 20261101abc #500"), ("unbought", None, "CT order 20261101abc #501")]
    assert undo[0]["wish_row"]["scryfall_id"] == "sf-loki" and bought == {}
    assert lifecycle.purchase_edits(orders, watch, book, NOW + timedelta(hours=2))[0] == []


def test_a_purchase_matches_the_wish_by_language_and_finish_and_its_copies_left():
    book = {"since": "2026-11-06T12:00:00+00:00"}
    watch = [wish(language="ja", foil="yes", quantity=1)]
    orders = [order(items=[item(language="jp", foil=True, quantity=2), item(product=600, language="en")])]
    edits, _ = lifecycle.purchase_edits(orders, watch, book, NOW)
    # Japanese foil: the wish (once), then the second copy and the English one are my collection.
    assert [e["op"] for e in edits] == ["bought", "collected", "collected"]
    assert edits[0]["purchase"]["language"] == "ja" and edits[0]["purchase"]["foil"] == "yes"


def test_what_an_open_alert_has_become():
    def v(alert=None, **kw):
        a = alert if alert is not None else {"price": 9.29, "added": True}
        args = {"bought_price": None, "in_cart": True, "cart_price": 9.29, "in_feed": True, "still_deal": True} | kw
        return lifecycle.verdict(a, now=NOW, **args)

    assert v().state == "open" and v().price is None
    assert v(cart_price=11.5).price == 11.5
    assert v(bought_price=9.29).state == "bought"
    assert v(still_deal=False, cart_price=11.5).line == "⏹ No longer a deal · price now €11.50"
    # Gone from the cart: decided at once (the cart is read before my purchases).
    assert v(in_cart=False, in_feed=False).line == "❌ Missed · someone else bought it first (14:00)"
    assert v(in_cart=False, in_feed=True).state == "removed"
    # An alert the cart couldn't check: the listing feed decides.
    assert v({"price": 9.29, "added": False}, in_cart=False, in_feed=True).state == "open"


def test_still_a_deal_has_slack_and_a_target_wins():
    a = deals.assess(wish(), [listing(cents=300)])  # usual 4.67, a deal from 30%
    assert lifecycle.still_a_deal({}, 3.0, a, wish()) is True  # 36% under
    assert lifecycle.still_a_deal({}, 3.40, a, wish()) is True  # 27%: within the 5 points of slack
    assert lifecycle.still_a_deal({}, 3.70, a, wish()) is False  # 21%
    assert lifecycle.still_a_deal({}, 3.70, a, wish(max_price_eur=4.0)) is True
    assert lifecycle.still_a_deal({}, 3.70, None, wish()) is None


def test_only_good_deals_ring_by_day_and_only_steals_at_night():
    steal = deals.best_deal(wish(), [listing(cents=100)])
    good = deals.best_deal(wish(), [listing(cents=300)])
    great = deals.best_deal(wish(), [listing(cents=260)])
    assert [d.tier[1] for d in (steal, great, good)] == ["🚨 Steal", "🔥 Great deal", "✅ Good deal"]
    night = datetime(2026, 11, 6, 23, 30, tzinfo=UTC)  # 00:30 in Amsterdam
    assert [lifecycle.rings(d, NOW) for d in (steal, great, good)] == [True, True, False]
    assert [lifecycle.rings(d, night) for d in (steal, great, good)] == [True, False, False]


def test_caption_names_the_copy_and_crosses_out_a_finished_deal():
    alert = {"head": "🚨 Steal · <b>Esika</b> · €9.29", "copy": "Near Mint · English · Non-foil · Zero · Magicfree (Italy)",
             "details": "<blockquote expandable>x</blockquote>", "links": [{"text": "CardTrader", "url": "u"}]}
    cart = {"total": {"cents": 3140}, "subcarts": [{"cart_items": [{"product": {"id": 1}, "quantity": 2, "price_cents": 900},
                                                                     {"product": {"id": 2}, "quantity": 1, "price_cents": 1340}]}]}
    line = lifecycle.cart_line(cart, NOW)
    assert line == "🛒 In your cart · cart €31.40 for 3 cards · checked 14:00"
    assert lifecycle.caption(alert, line) == ("🚨 Steal · <b>Esika</b> · €9.29\nNear Mint · English · Non-foil · Zero · "
                                              "Magicfree (Italy)\n<b>🛒 In your cart · cart €31.40 for 3 cards · checked "
                                              "14:00</b>\n\n<blockquote expandable>x</blockquote>")
    assert lifecycle.caption(alert, "❌ Sold out", done=True).startswith("<s>🚨 Steal · <b>Esika</b> · €9.29</s>")
    assert lifecycle.caption(alert, "✅ Bought for €9.29", done=True).startswith("🚨 Steal")
    assert lifecycle.keyboard(alert, done=False) == [[{"text": "🧾 Pay on CardTrader", "url": lifecycle.CART_URL}],
                                                     alert["links"]]
    assert lifecycle.keyboard(alert, done=True) == [alert["links"]]


def test_the_cart_says_added_gone_or_error():
    def account(status, body):
        return lifecycle.Account(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body))),
                                 "t", sleep=lambda s: None)

    cart = {"total": {"cents": 708}, "subcarts": [{"cart_items": [{"product": {"id": 7}, "quantity": 1, "price_cents": 708}]}]}
    assert account(200, cart).add(7, True) == ("added", cart)
    assert account(422, {"error_code": "validation_error"}).add(7, True) == ("gone", None)
    assert account(500, {}).add(7, True) == ("error", None)
    assert lifecycle.cart_items(cart) == {7: (1, 7.08)} and lifecycle.cart_summary(cart) == (7.08, 1)


class FakeTelegram(lifecycle.Telegram):
    def __init__(self):
        self.edits, self.chat_id = [], "42"

    def call(self, method, body):
        self.edits.append((method, body))
        return {}


class FakeAccount:
    def __init__(self):
        self.removed = []

    def remove(self, product_id, quantity=1):
        self.removed.append(product_id)
        return True

    def add(self, product_id, zero):
        return "error", None


def open_alert(mid, key="sf-loki|en|any", product=500, **kw):
    return {"message_id": mid, "key": key, "name": "Loki", "blueprint_id": 10, "product_id": product, "price": 2.88,
            "added": True, "head": "✅ Good deal · <b>Loki</b> · €2.88", "copy": "Near Mint", "details": "", "links": [],
            "stamps": {"bought": "https://s/img/b.jpg", "sold": "https://s/img/s.jpg", "ended": "https://s/img/e.jpg"},
            "photo": True, "line": "", **kw}


def test_refresh_updates_open_alerts_and_ends_the_others_of_a_bought_wish():
    result = deals.check(fake_session_one(), [wish()], {}, NOW)
    alerts = {"1": open_alert(1), "2": open_alert(2, product=501), "3": open_alert(3, product=502)}
    cart = {"total": {"cents": 288}, "subcarts": [{"cart_items": [{"product": {"id": 501}, "quantity": 1, "price_cents": 288},
                                                                    {"product": {"id": 502}, "quantity": 1, "price_cents": 288}]}]}
    tg, account = FakeTelegram(), FakeAccount()
    log = lifecycle.refresh(alerts, result, [wish(quantity=1)], cart, {500: 2.88}, tg, account, NOW)
    assert alerts["1"]["state"] == "bought" and alerts["2"]["state"] == "got_it" and alerts["3"]["state"] == "got_it"
    assert account.removed == [501, 502]  # the bot's copies of a wish I no longer need leave my cart
    media = [b["media"]["media"] for m, b in tg.edits if m == "editMessageMedia"]
    assert media == ["https://s/img/b.jpg", "https://s/img/e.jpg", "https://s/img/e.jpg"]
    assert log[0] == "Loki: ✅ Bought for €2.88 · recorded, off the want-list"


def test_refresh_keeps_an_alert_in_the_cart_up_to_date():
    result = deals.check(fake_session_one(), [wish()], {}, NOW)
    alerts = {"1": open_alert(1, product=1)}  # listing 1 at €2.88 is in this check
    cart = {"total": {"cents": 288}, "subcarts": [{"cart_items": [{"product": {"id": 1}, "quantity": 1, "price_cents": 288}]}]}
    tg = FakeTelegram()
    lifecycle.refresh(alerts, result, [wish()], cart, {}, tg, FakeAccount(), NOW)
    assert alerts["1"]["line"] == "🛒 In your cart · cart €2.88 for 1 card · checked 14:00" and "closed" not in alerts["1"]
    assert tg.edits[0][0] == "editMessageCaption"
    tg.edits.clear()
    lifecycle.refresh(alerts, result, [wish()], cart, {}, tg, FakeAccount(), NOW)
    assert tg.edits == []  # nothing changed, nothing edited


def fake_session_one():
    class S:
        def get(self, path, params):
            return {"10": [{"id": 1, "price_cents": 288, "price_currency": "EUR", "quantity": 1, "graded": False,
                            "on_vacation": False, "properties_hash": {"condition": "Near Mint", "mtg_language": "en",
                                                                      "mtg_foil": False},
                            "user": {"can_sell_via_hub": True, "country_code": "IT", "username": "Magicfree"}}]}
    return S()


def test_order_purchases_are_applied_once_collected_and_taken_back(tmp_path: Path):
    cards = two_printings(tmp_path)
    text = mycards.write_csv([{"name": "Elvish Archdruid", "scryfall_id": "sf-1", "language": "en", "foil": "any",
                               "quantity": "1", "list": "Showcase"}])
    buy = {"price_eur": "3.50", "market": "cardtrader", "condition": "NM", "foil": "no", "date": "2026-11-06",
           "note": "CT order X #1"}
    purchases: list[dict] = []
    ops = [{"id": "a", "op": "bought", "key": "sf-1|en|any", "purchase": buy},
           {"id": "b", "op": "bought", "key": "sf-1|en|any", "purchase": buy},  # the same order item again
           {"id": "c", "op": "collected", "card_row": {"name": "Elvish Archdruid", "scryfall_id": "sf-new"},
            "purchase": buy | {"note": "CT order X #2"}}]
    text2, results = mycards.apply_edits(text, ops, cards, {}, purchases=purchases)
    assert [(r["ok"], r["message"]) for r in results] == [(True, "bought Elvish Archdruid, off the want-list"),
                                                          (True, "this card: already recorded"),
                                                          (True, "collected Elvish Archdruid")]
    assert [p["note"] for p in purchases] == ["CT order X #1", "CT order X #2"]
    assert mycards.read_csv_rows(text2) == []  # off the want-list
    assert purchases[1]["set_code"] and purchases[1]["list"] == ""  # found in the card table; no list: collection
    # Cancelled: the purchase goes and the wish comes back.
    wish_row = {"name": "Elvish Archdruid", "scryfall_id": "sf-1", "language": "en", "foil": "any", "quantity": "1",
                "list": "Showcase"}
    text3, results = mycards.apply_edits(text2, [{"id": "d", "op": "unbought", "key": "sf-1|en|any", "note": "CT order X #1",
                                                  "wish_row": wish_row}], cards, {}, purchases=purchases)
    assert [p["note"] for p in purchases] == ["CT order X #2"]
    assert [(r["scryfall_id"], r["quantity"]) for r in mycards.read_csv_rows(text3)] == [("sf-1", "1")]
    # A purchase already recorded by hand on the site is not recorded twice.
    by_hand = [{"scryfall_id": "sf-1", "price_eur": "3.50", "market": "cardtrader", "date": "2026-11-05", "note": ""}]
    _, results = mycards.apply_edits(text, [ops[0]], cards, {}, purchases=by_hand)
    assert results[0]["message"].endswith("already recorded by hand") and len(by_hand) == 1


def test_a_purchase_seen_late_turns_a_missed_alert_into_bought():
    result = deals.check(fake_session_one(), [wish()], {}, NOW)
    alerts = {"1": open_alert(1, product=77, state="sold_out", closed=NOW.isoformat(), line="❌ Missed")}
    tg = FakeTelegram()
    log = lifecycle.refresh(alerts, result, [wish()], {"subcarts": []}, {77: 2.5}, tg, FakeAccount(), NOW)
    assert alerts["1"]["state"] == "bought" and log == ["Loki: bought after all"]
    assert tg.edits[0][1]["media"]["media"] == "https://s/img/b.jpg"


def test_zero_box_purchases_are_recorded_and_refunds_taken_back():
    book = {"since": "2026-11-06T12:00:00+00:00"}
    box = [{"id": 9, "quantity": {"pending": 1}, "product_id": 500, "blueprint_id": 10, "scryfall_id": "sf-loki",
            "name": "Loki, God of Mischief", "buyer_price": {"cents": 288}, "paid_at": "2026-11-06T16:50:00.000Z",
            "properties": {"condition": "Near Mint", "mtg_language": "en", "mtg_foil": False}},
           {"id": 8, "quantity": {"ok": 1}, "product_id": 400, "scryfall_id": "sf-x", "buyer_price": {"cents": 100},
            "paid_at": "2026-05-01T10:00:00Z", "properties": {}}]  # bought before the feature: left alone
    edits, bought = lifecycle.purchase_edits(lifecycle.box_orders(box), [wish()], book, NOW)
    assert [(e["op"], e["purchase"]["note"]) for e in edits] == [("bought", "Zero box 9 #500")] and bought == {500: 2.88}
    box[0]["quantity"] = {"missing": 1}  # not available after all: refunded
    undo, bought = lifecycle.purchase_edits(lifecycle.box_orders(box), [wish()], book, NOW + timedelta(hours=1))
    assert [(e["op"], e["note"]) for e in undo] == [("unbought", "Zero box 9 #500")] and bought == {}


def test_fast_lane_lists_the_cards_closest_to_a_deal_with_what_the_timer_needs():
    from test_deals import fake_session, item

    watch = [wish(), wish(scryfall_id="sf-b", blueprint_id=11, language="ja", foil="yes", min_condition="SP", via_zero="no")]
    listings = {10: [item(id=1, cents=400), item(id=9, cents=100)], 11: [item(id=2, cents=430, language="jp", foil=True)]}
    result = deals.check(fake_session(listings), watch, {}, NOW, ignore={9})
    fast = lifecycle.fast_lane(result, watch, {"9": NOW.isoformat()})
    assert [f["bp"] for f in fast] == [10, 11]  # 400 vs 4.67 is 14% under (16 points short) vs 11% for 430 vs 4.83
    loki = fast[0]
    assert (loki["lang"], loki["foil"], loki["grade"], loki["zero"], loki["ref"], loki["floor"], loki["best"], loki["gone"]) == \
        ("en", "any", 1, True, 4.67, 30.0, 4.0, [9])
    assert (fast[1]["lang"], fast[1]["foil"], fast[1]["grade"], fast[1]["zero"]) == ("jp", "yes", 2, False)
