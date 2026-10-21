from datetime import UTC, date, datetime, timedelta

import pyarrow as pa

from mtg_intel import deals, site
from mtg_intel.deals import CheckResult, Listing

NOW = datetime(2026, 10, 21, 8, 7, tzinfo=UTC)


def wish(**overrides):
    return {"name": "Loki, God of Mischief", "scryfall_id": "sf-loki", "blueprint_id": 10, "cardmarket_id": 890665,
            "collector_number": "343", "special_tags": ["borderless"], "finishes": ["nonfoil", "foil"],
            "language": "en", "foil": "any", "min_condition": "NM", "via_zero": "yes",
            "ct": {"name": "Loki, God of Mischief", "version": "Borderless", "number": "343",
                   "scryfall_id": "sf-loki", "card_market_ids": [890665]},
            "cm": {"trend": 4.67, "trend_foil": 4.83}, "jump": None, **overrides}


def codes(w):
    return [f["code"] for f in site.wish_flags(w)]


def test_a_clean_wish_has_no_flags():
    assert codes(wish()) == []


def test_flags_name_what_looks_wrong():
    assert codes(wish(ct=wish()["ct"] | {"number": "344"})) == ["ct_number"]
    assert codes(wish(ct=wish()["ct"] | {"version": "Showcase Borderless"})) == ["ct_label"]
    assert codes(wish(ct=wish()["ct"] | {"card_market_ids": [1]})) == ["cm_product"]
    assert codes(wish(foil="no", finishes=["foil"], cm={"trend_foil": 20.2})) == ["foil"]
    # a foil-only printing is judged on its foil price; its €0 non-foil trend is noise, not a flag
    assert codes(wish(finishes=["foil"], cm={"trend": 0.0, "trend_foil": 20.2})) == []
    assert codes(wish(cm={"trend": 0.0, "trend_foil": 4.8})) == ["cm_zero"]
    assert codes(wish(cm={})) == ["no_cm_price"]
    assert codes(wish(scryfall_id=None, ct=None)) == ["no_version"]
    # leading zeros and double faces are the same card
    assert codes(wish(collector_number="44", ct=wish()["ct"] | {"number": "044"})) == []
    assert codes(wish(name="Esika // Bridge", ct=wish()["ct"] | {"name": "Esika"})) == []


def test_cardmarket_link_is_filtered_to_dutch_near_mint():
    link = site.cardmarket_link(890665, {"language": "ja", "min_condition": "NM", "foil": "yes"})
    assert link == ("https://www.cardmarket.com/en/Magic/Products?idProduct=890665&sellerCountry=23"
                    "&language=7&minCondition=2&isFoil=Y")


def test_history_doc_is_compact_offsets_from_one_base_day():
    history = pa.table({"scryfall_id": ["a", "a", "a"], "price_date": [date(2026, 7, 19), date(2026, 7, 21), date(2026, 10, 17)],
                        "source": ["mtgjson", "mtgjson", "cardmarket"], "finish": ["normal", "normal", "foil"],
                        "trend": [1.0, 1.256, 2.0], "low": [None, None, 1.5], "avg7": [None, None, None]})
    doc = site.history_doc(history)
    assert doc == {"base": "2026-07-19", "cards": {"a": {"mtgjson": {"normal": [0, 1.0, 2, 1.26]},
                                                        "cardmarket": {"foil": [90, 2.0]}}}}


def listing(price, id=1):
    return Listing(id, price, "Near Mint", "en", False, True, "IT", 1)


def watch_wish(**overrides):
    return {"scryfall_id": "sf-loki", "blueprint_id": 10, "language": "en", "foil": "any", **overrides}


def test_live_doc_keeps_a_sold_deal_for_a_day_and_the_first_seen_time():
    w = watch_wish()
    key = deals.wish_key(w)
    deal = deals.Deal(w, listing(2.88), 4.67, 4.5, "usual price", 36.0, deals.TIERS[1], ["36% under"])
    first = site.live_doc(CheckResult(deals=[deal], cheapest={key: listing(2.88)}, counts={key: 3}), [w], NOW, None)
    assert first["deals"][0]["tier"] == 30.0 and first["wishes"][key]["count"] == 3
    later = NOW + timedelta(minutes=10)
    again = site.live_doc(CheckResult(deals=[deal], cheapest={key: listing(2.88)}), [w], later, first)
    assert again["deals"][0]["since"] == NOW.isoformat()
    sold = site.live_doc(CheckResult(cheapest={key: listing(4.6)}), [w], later, again)
    assert sold["deals"] == [] and sold["gone"][0]["gone_at"] == later.isoformat()
    next_day = site.live_doc(CheckResult(), [w], later + timedelta(hours=25), sold)
    assert next_day["gone"] == [] and next_day["empty"] == [key]


def test_ct_recent_aligns_prices_with_check_times_and_drops_old_checks():
    key = "sf-loki|en|any"
    doc = site.ct_recent_doc(None, CheckResult(cheapest={key: listing(3.0)}), NOW)
    doc = site.ct_recent_doc(doc, CheckResult(cheapest={"other|en|any": listing(1.0)}), NOW + timedelta(minutes=10))
    assert doc["p"][key] == [3.0, None] and doc["p"]["other|en|any"] == [None, 1.0]
    doc = site.ct_recent_doc(doc, CheckResult(), NOW + timedelta(hours=49))
    assert len(doc["t"]) == 1 and doc["p"] == {}


def test_ct_history_is_the_hourly_low_of_fitting_listings():
    rows = [{"checked_at": NOW.replace(minute=m), "blueprint_id": 10, "language": lang, "condition": "Near Mint",
             "foil": False, "zero": True, "min_price": p, "listings": 1}
            for m, lang, p in [(7, "en", 3.0), (17, "en", 2.5), (27, "it", 1.0)]]
    assert site.ct_history_doc([watch_wish(min_condition="NM", via_zero="yes")], {10: rows}) == {
        "sf-loki|en|any": [[NOW.replace(minute=0).isoformat(), 2.5]]}


def test_price_shards_split_by_the_id_prefix():
    cards = pa.table({"scryfall_id": ["00aa", "21bb", "ffcc"], "cardmarket_id": [1, 2, 3]})
    day = pa.table({"id_product": [1, 2], "trend": [0.5, None], "trend_foil": [None, 3.0]})
    shards = site.price_shards(cards, day)
    assert shards[0] == {"00aa": [0.5, None]} and shards[1] == {"21bb": [None, 3.0]}
    assert sum(len(s) for s in shards.values()) == 2
