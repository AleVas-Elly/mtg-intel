from datetime import UTC, datetime, timedelta

import httpx

from mtg_intel import deals
from mtg_intel.archive.cardtrader import Session
from mtg_intel.deals import Listing

NOW = datetime(2026, 10, 21, 8, 7, tzinfo=UTC)


def wish(**overrides):
    return {"line": 2, "name": "Loki, God of Mischief", "set_code": "msh", "collector_number": "343",
            "special_tags": ["borderless"], "finishes": ["nonfoil", "foil"], "scryfall_id": "sf-loki",
            "blueprint_id": 10, "language": "en", "foil": "any", "min_condition": "NM", "via_zero": "yes",
            "max_price_eur": None, "deal_pct": None, "list": "Marvel", "one_of": None, "cardmarket_id": 890665,
            "trend": 4.67, "trend_foil": 4.83, "low": 3.0, "low_foil": 3.5, "avg7": 4.59, "avg7_foil": 5.25,
            **overrides}


def item(id=1, cents=288, condition="Near Mint", language="en", foil=False, zero=True, **extra):
    return {"id": id, "price_cents": cents, "price_currency": "EUR", "quantity": 1, "graded": False,
            "on_vacation": False, "properties_hash": {"condition": condition, "mtg_language": language,
            "mtg_foil": foil, "signed": False, "altered": False},
            "user": {"can_sell_via_hub": zero, "country_code": "IT"}, **extra}


def listing(**kw):
    return Listing.from_api(item(**kw))


def test_listings_a_wish_can_never_want_are_dropped():
    assert listing() is not None
    assert Listing.from_api(item(graded=True)) is None
    assert Listing.from_api(item(on_vacation=True)) is None
    assert Listing.from_api({**item(), "price_currency": "USD"}) is None
    signed = item()
    signed["properties_hash"]["signed"] = True
    assert Listing.from_api(signed) is None


def test_fits_language_foil_condition_and_zero():
    assert deals.fits(listing(), wish())
    assert not deals.fits(listing(language="it"), wish())
    assert deals.fits(listing(language="jp"), wish(language="ja"))
    assert deals.fits(listing(language="it"), wish(language="any"))
    assert not deals.fits(listing(foil=True), wish(foil="no"))
    assert not deals.fits(listing(foil=False), wish(foil="yes"))
    assert not deals.fits(listing(condition="Slightly Played"), wish())
    assert deals.fits(listing(condition="Slightly Played"), wish(min_condition="SP"))
    assert deals.fits(listing(condition="Mint"), wish())
    assert not deals.fits(listing(zero=False), wish())
    assert deals.fits(listing(zero=False), wish(via_zero="no"))


def test_deal_is_measured_against_the_higher_of_cardmarket_and_cardtrader():
    # Cardmarket trend 4.67, no CardTrader history: 2.88 is 38% under -> a deal (cards under €20 need 30%).
    deal = deals.best_deal(wish(), [listing(id=1, cents=288), listing(id=2, cents=320)])
    assert (deal.listing.id, round(deal.below_pct), deal.tier[1], deal.reference) == (1, 38, "✅ Good deal", 4.67)
    # The next cheapest copy (3.20) is not used while Cardmarket has a trend ...
    assert deal.cardtrader_kind == "next cheapest copy" and deal.cardtrader == 3.20
    # ... but is without one.
    deal = deals.best_deal(wish(trend=None, trend_foil=None), [listing(id=1, cents=288), listing(id=2, cents=450)])
    assert (round(deal.below_pct), deal.reference) == (36, 4.50)
    # A usual CardTrader price above the trend wins: 2.88 against 4.80 is 40% under.
    deal = deals.best_deal(wish(), [listing(id=1, cents=288)], usual=4.80)
    assert (round(deal.below_pct), deal.cardtrader_kind, deal.tier[1]) == (40, "usual price", "🔥 Great deal")
    # 3.40 is 29% under the higher price (4.80): no deal...
    assert deals.best_deal(wish(trend=3.0), [listing(cents=340)], usual=4.80) is None
    # ...but 3.30 is 31% under the usual CardTrader price, though over the Cardmarket trend.
    assert round(deals.best_deal(wish(trend=3.0), [listing(cents=330)], usual=4.80).below_pct) == 31


def test_tiers_from_30_and_from_20_for_cards_usually_over_20_euros_and_my_own_floor():
    def tier(cents, trend=10.0, **kw):
        deal = deals.best_deal(wish(trend=trend, **kw), [listing(cents=cents)])
        return deal.tier[1] if deal else None
    assert [tier(c) for c in (750, 700, 610, 600, 510, 500)] == [
        None, "✅ Good deal", "✅ Good deal", "🔥 Great deal", "🔥 Great deal", "🚨 Steal"]
    assert [tier(c, trend=30.0) for c in (2500, 2400, 2100, 1800)] == [
        None, "✅ Good deal", "🔥 Great deal", "🚨 Steal"]
    assert tier(1600, trend=20.0) is None  # €20 exactly is not over €20: needs 30%
    assert tier(790, deal_pct=20.0) == "✅ Good deal"  # my own floor
    assert tier(2300, trend=30.0, deal_pct=25.0) is None
    target = deals.best_deal(wish(max_price_eur=4.0), [listing(cents=400)])
    assert (target.tier, target.reasons) == (None, ["at or under my €4.00 target"])


def test_foil_only_card_is_compared_with_the_foil_trend():
    w = wish(finishes=["foil"], trend=0.44, trend_foil=20.20)
    assert deals.cardmarket_reference(listing(foil=False), w) == 20.20
    assert deals.best_deal(w, [listing(cents=1800, foil=False)]) is None  # not a 96% deal
    assert deals.cardmarket_reference(listing(), wish(trend_foil=0.0)) == 4.67
    assert deals.best_deal(wish(trend=None, trend_foil=None), [listing()]) is None  # no reference, no target


def summary_row(at, cents, **kw):
    row = {"checked_at": at, "blueprint_id": 10, "language": "en", "condition": "Near Mint", "foil": False,
           "zero": True, "min_price": cents / 100, "listings": 3}
    return {**row, **kw}


def test_usual_price_is_the_weekly_median_of_the_cheapest_fitting_listing():
    history = [summary_row(NOW - timedelta(days=d, hours=1), 400 + 10 * d) for d in range(1, 6)]
    history += [summary_row(NOW - timedelta(days=1), 100, language="it"),  # doesn't fit the wish
                summary_row(NOW - timedelta(days=1), 100, zero=False),
                summary_row(NOW - timedelta(days=20), 100)]  # too old
    assert deals.usual_zero_price(wish(), history, NOW) == 4.30  # median of 4.10 … 4.50
    assert deals.usual_zero_price(wish(), history[:2], NOW) is None  # under 3 days of history


def fake_session(listings_by_blueprint, failing=()):
    def handler(request: httpx.Request) -> httpx.Response:
        bp = int(request.url.params["blueprint_id"])
        if bp in failing:
            return httpx.Response(404)
        return httpx.Response(200, json={str(bp): listings_by_blueprint.get(bp, [])})
    return Session(httpx.Client(transport=httpx.MockTransport(handler)), "t", None, sleep=lambda s: None, interval=0)


def test_check_alerts_once_then_on_a_lower_price_and_forgets_gone_deals():
    watch = [wish(), wish(line=3, name="Quiet Card", scryfall_id="sf-q", blueprint_id=11)]
    alerted: dict = {}

    first = deals.check(fake_session({10: [item(cents=288)], 11: [item(cents=999)]}), watch, alerted, NOW)
    assert first.deals[0].tier[1] == "✅ Good deal"
    assert [d.wish["name"] for d in first.new] == ["Loki, God of Mischief"]
    assert {r["blueprint_id"] for r in first.summary} == {10, 11}

    again = deals.check(fake_session({10: [item(cents=288)]}), watch, alerted, NOW + timedelta(minutes=30))
    assert (len(again.deals), again.new) == (1, [])

    cheaper = deals.check(fake_session({10: [item(id=5, cents=250)]}), watch, alerted, NOW + timedelta(hours=1))
    assert [d.listing.id for d in cheaper.new] == [5]

    week = deals.check(fake_session({10: [item(id=5, cents=250)]}), watch, alerted, NOW + timedelta(days=8))
    assert len(week.new) == 1  # repeated after a week

    gone = deals.check(fake_session({10: [item(cents=460)]}), watch, alerted, NOW + timedelta(days=9))
    assert gone.deals == [] and alerted == {}
    back = deals.check(fake_session({10: [item(cents=300)]}), watch, alerted, NOW + timedelta(days=10))
    assert len(back.new) == 1


def test_a_failed_card_keeps_its_alert_memory():
    alerted = {"sf-loki|en|any": {"listing": 1, "price": 2.88, "at": NOW.isoformat()}}
    result = deals.check(fake_session({}, failing={10}), [wish()], alerted, NOW)
    assert result.failed_blueprints == [10] and "sf-loki|en|any" in alerted


def test_message_says_how_strong_the_deal_is_and_what_it_was_compared_with():
    deal = deals.best_deal(wish(language="en", foil="no"), [listing(id=1, cents=288), listing(id=2, cents=450)])
    title, text = deals.message(deal)
    assert title == "✅ Good deal: Loki, God of Mischief €2.88 (38% under)"
    assert text.splitlines()[0] == "Cheaper than usual, worth a look."
    assert "Why: 38% under its usual €4.67 (a deal from 30%)" in text
    assert "Loki, God of Mischief (MSH #343, borderless)" in text
    assert "€2.88 on CardTrader via Zero: Near Mint, EN, non-foil, seller in IT" in text
    assert "Compared with: Cardmarket trend €4.67 (38% less), CardTrader Zero next cheapest copy €4.50 (36% less)" in text
    assert "Cardmarket: lowest €3.00, 7-day average €4.59" in text
    assert "https://www.cardtrader.com/cards/10" in text
    assert "https://www.cardmarket.com/en/Magic/Products?idProduct=890665&sellerCountry=23&language=1&minCondition=2&isFoil=N" in text


def test_telegram_message_shows_both_markets_against_their_usual_and_details_behind_a_tap():
    deal = deals.best_deal(wish(scryfall_id="0c3f2c9e-1d3b-4a4e-9a8c-6f1b2d3e4f50", language="en", foil="no"),
                           [listing(id=1, cents=288), listing(id=2, cents=450)])
    rich = deals.telegram(deal, "https://site.example/", "https://site.example/p/x")
    html, buttons, preview = rich.html, rich.buttons, rich.preview
    top, more = html.split("<blockquote expandable>")
    assert top.strip().splitlines() == ["✅ Good deal · 38% under", "<b>Loki, God of Mischief</b>",
                                "<b>CardTrader</b>  €2.88 · next copy €4.50 (−36%)",
                                "<b>Cardmarket</b>  from €3.00 · trend €4.67 (−36%)"]
    assert preview == "https://site.example/p/x"
    assert "Judged against the higher usual price, €4.67; a deal from 30% under." in more
    assert "Seller in Italy" in more and "List: Marvel" in more and "7-day average" not in more
    assert buttons[0] == [{"text": "🛒 Bought it", "callback_data": "b|0c3f2c9e1d3b4a4e9a8c6f1b2d3e4f50|en|no|288|NM|0|en"}]
    assert [b["text"] for b in buttons[1]] == ["CardTrader", "Cardmarket", "Site"]
    assert buttons[1][2]["url"] == "https://site.example/wants?card=0c3f2c9e-1d3b-4a4e-9a8c-6f1b2d3e4f50%7Cen%7Cno"
    assert deals.version_line(deal) == ("MSH #343 · Borderless", "NM · EN · Non-foil · Zero")
    # Without a picture the printing and copy go in the text; a usual CardTrader price says "usually".
    html = deals.telegram(deals.best_deal(wish(), [listing(cents=288)], usual=4.10)).html
    assert "MSH #343 · Borderless · NM · EN · Non-foil · Zero" in html and "usually €4.10 (−30%)" in html


def test_preview_link_is_signed_and_only_for_scryfall_pictures():
    import base64
    import hashlib
    import hmac
    import json

    from mtg_intel import site

    url = site.preview_url("https://s.example", "tok", "k|en|any", "https://cards.scryfall.io/normal/front/a/b.jpg?1",
                           "MSH #343", "NM · EN", NOW, "Marvel Super Heroes")
    body, mac = url.removeprefix("https://s.example/p/").split(".")
    assert base64.urlsafe_b64decode(mac + "==") == hmac.new(b"tok", body.encode(), hashlib.sha256).digest()
    payload = json.loads(base64.urlsafe_b64decode(body + "=="))
    assert (payload["kind"], payload["i"], payload["t"], payload["d"], payload["s"]) == (
        "preview", "normal/front/a/b.jpg?1", "MSH #343", "NM · EN", "Marvel Super Heroes")
    assert deals.front_name("Esika, God of the Tree // The Prismatic Bridge") == "Esika, God of the Tree"
    assert site.preview_url("https://s.example", "tok", "k", "https://evil.example/x.jpg", "t", "d", NOW) is None


def test_bought_button_data_fits_telegram_and_names_the_copy():
    # Japanese wish of any finish, a foil Slightly Played copy: CardTrader's "jp" is the want-list's "ja".
    deal = deals.best_deal(wish(scryfall_id="0c3f2c9e-1d3b-4a4e-9a8c-6f1b2d3e4f50", language="ja", min_condition="SP",
                                max_price_eur=200.0),
                           [listing(cents=12345, language="jp", foil=True, condition="Slightly Played")])
    data = deals.bought_data(deal)
    assert data == "b|0c3f2c9e1d3b4a4e9a8c6f1b2d3e4f50|ja|any|12345|SP|1|ja" and len(data.encode()) <= 64
    assert deals.bought_data(deals.best_deal(wish(scryfall_id=None), [listing(cents=100)])).startswith("b|10|")
    # Names in HTML are escaped.
    assert "<b>R&amp;D's &lt;Secret&gt;</b>" in deals.telegram(deals.best_deal(wish(name="R&D's <Secret>"), [listing(cents=100)])).html


def test_cardmarket_target_alerts_once_and_again_when_lower():
    alerted: dict = {}
    watch = [wish(max_price_eur=5.0), wish(scryfall_id="sf-x", max_price_eur=1.0)]
    assert [t for t, _ in deals.cardmarket_targets(watch, alerted, NOW)] == ["Target: Loki, God of Mischief €4.67 on Cardmarket"]
    assert deals.cardmarket_targets(watch, alerted, NOW) == []
    assert len(deals.cardmarket_targets([wish(max_price_eur=5.0, trend=4.10)], alerted, NOW)) == 1


def test_a_deal_on_one_alternative_is_dropped_when_another_is_cheaper():
    watch = [wish(one_of="pact", trend=None, trend_foil=None, blueprint_id=10),  # etched: no Cardmarket price
             wish(one_of="pact", scryfall_id="sf-regular", blueprint_id=11, trend=60.0)]
    listings = {10: [item(id=1, cents=4562), item(id=2, cents=6014)], 11: [item(id=3, cents=3830), item(id=4, cents=3866)]}
    # Both are deals (60.14 next copy with no trend; €60 trend): only the cheaper one is kept.
    assert [d.listing.id for d in deals.check(fake_session(listings), watch, {}, NOW).deals] == [3]
    listings[11] = [item(id=3, cents=5500), item(id=4, cents=5600)]
    assert [d.listing.id for d in deals.check(fake_session(listings), watch, {}, NOW).deals] == [1]



def test_a_cardmarket_trend_far_under_cardtrader_is_shown_but_not_used():
    # Counterspell SLD #7123 had a €0.02 trend against a €12.66 usual CardTrader price: with the
    # lower of the two, no listing could ever be a deal.
    deal = deals.best_deal(wish(trend=0.02), [listing(cents=850)], usual=12.66)
    assert (round(deal.below_pct), deal.cardmarket_trusted) == (33, False)
    assert "looks wrong, not used" in deals.message(deal)[1]
    # The dangerous way round with the higher of both: a wrong high trend would make a steal of nothing.
    assert deals.best_deal(wish(trend=40.0), [listing(cents=900)], usual=12.66) is None
    # A real gap (under 2.5x) is used.
    assert round(deals.best_deal(wish(trend=20.0), [listing(cents=900)], usual=12.66).below_pct) == 55


def test_a_slow_check_stops_asking_and_keeps_alert_memory():
    watch = [wish(), wish(line=3, name="Late", scryfall_id="sf-late", blueprint_id=11)]
    alerted = {"sf-late|en|any": {"listing": 1, "price": 1.0, "at": NOW.isoformat()}}
    asked = []
    result = deals.check(fake_session({10: [item(cents=288)]}), watch, alerted, NOW,
                         out_of_time=lambda: (asked.append(1) or len(asked)) > 1)
    assert (result.failed_blueprints, result.late_blueprints) == ([11], [11])
    assert {r["blueprint_id"] for r in result.summary} == {10}
    assert "sf-late|en|any" in alerted


def test_a_lasting_problem_alerts_once_every_six_hours_then_says_it_is_over():
    state: dict = {}
    assert deals.problem_alert(state, [], NOW) is None
    assert deals.problem_alert(state, ["CardTrader: 215 of 215 requests failed"], NOW)[0] == "mtg-intel deal check needs a look"
    assert deals.problem_alert(state, ["CardTrader: 215 of 215 requests failed"], NOW + timedelta(minutes=10)) is None
    assert deals.problem_alert(state, ["x"], NOW + timedelta(hours=6)) is not None
    title, text = deals.problem_alert(state, [], NOW + timedelta(hours=7))
    assert title == "mtg-intel deal check is fine again" and NOW.isoformat() in text
    assert state == {} and deals.problem_alert(state, [], NOW + timedelta(hours=8)) is None


def test_daily_digest_once_a_day_from_8_with_the_closest_cards_over_10_euros():
    watch = [wish(), wish(scryfall_id="sf-a", name="Pricey", blueprint_id=11, trend=30.0),
             wish(scryfall_id="sf-b", name="Mid", blueprint_id=12, trend=12.0),
             wish(scryfall_id="sf-c", name="Deal", blueprint_id=13, trend=50.0)]
    session = fake_session({10: [item(cents=400)], 11: [item(cents=2700)], 12: [item(cents=1000)], 13: [item(cents=3000)]})
    morning = datetime(2026, 11, 5, 7, 7, tzinfo=UTC)  # 08:07 in Amsterdam
    result = deals.check(session, watch, {}, morning)
    state: dict = {}
    deals.record_check(state, morning - timedelta(hours=30), 0, 9)  # older than a day: dropped
    deals.record_check(state, morning - timedelta(hours=23, minutes=30), 3, 1)
    deals.record_check(state, morning, 0, 0)
    assert deals.digest(state, result, watch, morning - timedelta(hours=1), None) is None  # 07:07: too early
    title, text = deals.digest(state, result, watch, morning, "https://site.example")
    assert title == "☀️ mtg-intel: 1 deals live"
    assert "Last 24 h: 2 checks (one every 10 minutes is 144 a day), 1 alerts sent, 1 checks with cards not reached." in text
    assert "• Deal €30.00, 40% under" in text
    closest = text.split("Closest to a deal (usually over €10):\n")[1].splitlines()
    # Pricey: 10% under €30, needs 20 (10 to go); Mid: 17% under €12, needs 30 (13 to go); Loki is under €10.
    assert [line.split(" (")[0] for line in closest[:2]] == ["• Pricey", "• Mid"]
    assert "€27.00, 10% under its usual €30.00, a deal from 20%" in closest[0]
    assert text.endswith("https://site.example/")
    assert deals.digest(state, result, watch, morning + timedelta(hours=3), None) is None  # once a day
    assert deals.digest(state, result, watch, morning + timedelta(days=1), None) is not None


def test_deal_image_says_what_makes_it_a_deal_and_draws():
    import io

    from PIL import Image

    from mtg_intel import dealimage

    deal = deals.best_deal(wish(set_name="Marvel Super Heroes", foil="no"), [listing(cents=288), listing(id=2, cents=450)],
                           usual=4.10)
    p = dealimage.panel(deal)
    assert (p.pill, p.name, p.price, p.saving) == ("GOOD DEAL · 38% UNDER", "Loki, God of Mischief", "€2.88", "€1.79 less than usual")
    assert p.markets == [("CardTrader", "usually €4.10", "−30%"), ("Cardmarket", "from €3.00 · trend €4.67", "−36%")]
    assert p.footer == "Seller in Italy · Marvel list"
    png = dealimage.render(p, Image.new("RGB", (488, 680), "#335533"))
    image = Image.open(io.BytesIO(png))
    assert image.width == 1080 and 650 < image.height < 900  # wider than tall: no side bars
    # The photo goes with a one-line caption (lock screen) and the details behind a tap.
    rich = deals.telegram(deal, photo=png)
    assert rich.photo == png and rich.caption.startswith("✅ Good deal · <b>Loki, God of Mischief</b> · €2.88\n\n<blockquote expandable>")


def test_photo_alert_falls_back_to_text_then_plain(monkeypatch):
    from mtg_intel.archive.notify import Rich, alert

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    methods = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.url.path.rsplit("/", 1)[1])
        return httpx.Response(400 if methods[-1] == "sendPhoto" else 200, json={"ok": True, "result": {}})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert alert(client, "t", "m", Rich("<b>x</b>", [], photo=b"png", caption="c"))
    assert methods == ["sendPhoto", "sendMessage"]


def test_price_trend_tells_where_the_card_has_been():
    from datetime import date, timedelta

    start = date(2026, 8, 8)
    rows = [{"price_date": start + timedelta(days=i), "source": "mtgjson", "finish": "normal", "trend": 20.0 - i * 0.06}
            for i in range(90)]
    rows.append({"price_date": start + timedelta(days=89), "source": "cardmarket", "finish": "normal", "trend": 14.98})
    rows.append({"price_date": start, "source": "mtgjson", "finish": "foil", "trend": 99.0})
    points = deals.trend_points(rows, foil=False)
    assert len(points) == 90 and points[-1] == ("2026-11-05", 14.98) and 99.0 not in [v for _, v in points]
    section = deals.price_trend(points, None, "📈 Cardmarket trend")
    assert section[0] == "📈 Cardmarket trend · 90 days"
    assert section[1].startswith("█") and section[1].endswith("▁") and len(section[1]) == 13
    assert section[2:] == ["Down 9% in a month (was €16.46)", "Down 24% in 3 months (was €19.76)",
                           "Lowest €14.72 · 4 Nov", "Highest €20.00 · 8 Aug"]
    assert deals.price_trend(points[-10:], None, "x") == []  # under two weeks says nothing


def test_cardtrader_trend_uses_the_cheapest_fitting_copy_each_day_since_checks_began():
    from datetime import datetime

    def row(day, price, language="en", zero=True):
        return {"checked_at": datetime(2026, 10, day, 8, tzinfo=UTC), "blueprint_id": 10, "language": language,
                "condition": "Near Mint", "foil": False, "zero": zero, "min_price": price, "listings": 1}

    rows = [row(20, 6.0), row(20, 5.0, zero=False), row(20, 1.0, language="it")]
    rows += [row(d, 6.0 + (d - 20) * 0.1) for d in range(21, 31)] + [row(30, 4.16)]
    points = deals.cardtrader_points(rows, wish())
    assert points[0] == ("2026-10-20", 6.0) and points[-1] == ("2026-10-30", 4.16) and len(points) == 11
    section = deals.price_trend(points, None, "📉 CardTrader, cheapest copy", min_days=5)
    assert section[0] == "📉 CardTrader, cheapest copy · since 20 Oct"
    assert section[-2:] == ["Lowest €4.16 · 30 Oct", "Highest €6.90 · 29 Oct"]


def test_details_are_spaced_sections_with_the_seller():
    deal = deals.best_deal(wish(), [Listing.from_api(item(cents=288, user={"can_sell_via_hub": True, "country_code": "PT",
                                                                           "username": "Mardu_TCG"}))])
    rich = deals.telegram(deal, history=[["📈 Cardmarket trend · 90 days", "▁▂▃", "Lowest €3.00 · 1 Oct"], []])
    head, details = rich.caption.split("\n\n", 1)
    assert head == "✅ Good deal · <b>Loki, God of Mischief</b> · €2.88"
    assert details == ("<blockquote expandable><b>📈 Cardmarket trend · 90 days</b>\n▁▂▃\nLowest €3.00 · 1 Oct\n\n"
                       "<b>ℹ️ Why it's a deal</b>\nJudged against the higher usual price, €4.67; a deal from 30% under.\n"
                       "Cardmarket's prices come from its daily list: any seller, condition and language.\n"
                       "Seller: Mardu_TCG (Portugal)\nList: Marvel</blockquote>")
