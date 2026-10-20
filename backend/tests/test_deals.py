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


def test_deal_is_measured_against_the_lower_of_cardmarket_and_cardtrader():
    # Cardmarket trend 4.67; next Zero listing 3.20 is lower, so 2.88 is only 10% under: no deal.
    assert deals.best_deal(wish(), [listing(id=1, cents=288), listing(id=2, cents=320)]) is None
    # Next listing 4.50: the lower reference is 4.50, 2.88 is 36% under -> great deal.
    deal = deals.best_deal(wish(), [listing(id=1, cents=288), listing(id=2, cents=450)])
    assert (deal.listing.id, round(deal.below_pct), deal.tier[1], deal.cardtrader_kind) == (1, 36, "🔥 Great deal", "next cheapest copy")
    # With a usual CardTrader price, that wins over the next listing.
    deal = deals.best_deal(wish(), [listing(id=1, cents=288), listing(id=2, cents=320)], usual=4.80)
    assert (round(deal.below_pct), deal.cardtrader_kind) == (38, "usual price")  # 4.67 trend is the lower
    # Only one listing and no history: Cardmarket alone.
    assert round(deals.best_deal(wish(), [listing(cents=288)]).below_pct) == 38


def test_tiers_20_30_40_and_my_own_floor():
    def tier(cents):
        deal = deals.best_deal(wish(trend=10.0), [listing(cents=cents)])
        return deal.tier[1] if deal else None
    assert [tier(c) for c in (850, 800, 710, 700, 600, 590)] == [
        None, "✅ Good deal", "✅ Good deal", "🔥 Great deal", "🚨 Steal", "🚨 Steal"]
    assert deals.best_deal(wish(trend=10.0, deal_pct=30.0), [listing(cents=750)]) is None
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
    assert first.deals[0].tier[1] == "🔥 Great deal"
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
    assert title == "🔥 Great deal: Loki, God of Mischief €2.88 (36% under)"
    assert text.splitlines()[0] == "Well under what this usually costs."
    assert "Loki, God of Mischief (MSH #343, borderless)" in text
    assert "€2.88 on CardTrader via Zero: Near Mint, EN, non-foil, seller in IT" in text
    assert "Compared with: Cardmarket trend €4.67 (38% less), CardTrader Zero next cheapest copy €4.50 (36% less)" in text
    assert "Cardmarket: lowest €3.00, 7-day average €4.59" in text
    assert "https://www.cardtrader.com/cards/10" in text
    assert "https://www.cardmarket.com/en/Magic/Products?idProduct=890665&language=1&minCondition=2&isFoil=N" in text


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
    assert deals.check(fake_session(listings), watch, {}, NOW).deals == []
    listings[11] = [item(id=3, cents=5500), item(id=4, cents=5600)]
    assert [d.listing.id for d in deals.check(fake_session(listings), watch, {}, NOW).deals] == [1]

