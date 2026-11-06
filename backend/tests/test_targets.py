from datetime import date, timedelta

from test_deals import wish

from mtg_intel import targets


def days(values, start=date(2026, 8, 8)):
    return [((start + timedelta(days=i)).isoformat(), v) for i, v in enumerate(values)]


def test_nice_floor_rounds_down_to_clean_prices():
    assert [targets.nice_floor(p) for p in (4.37, 13.62, 13.5, 142.9)] == [4.3, 13.5, 13.5, 142.5]


def test_suggests_the_price_reached_on_about_15_percent_of_days():
    cm = days([20.0 - (i % 20) * 0.5 for i in range(90)])  # 20.00 down to 10.50, again and again
    s = targets.suggest(wish(), cm, [])
    assert (s.target, s.reached, s.days, s.reason) == (12.0, 16, 90, "no target yet")
    assert targets.suggest(wish(), cm[:20], []) is None  # under 30 days says nothing


def test_only_suggests_where_it_helps():
    cm = days([20.0 - (i % 20) * 0.5 for i in range(90)])
    assert targets.suggest(wish(max_price_eur=12.4), cm, []) is None  # close enough to the suggestion
    assert targets.suggest(wish(max_price_eur=14.0), cm, []) is None  # a fine target already
    assert targets.suggest(wish(max_price_eur=5.0), cm, []).reason == "your €5.00 wasn't reached in 90 days"
    assert targets.suggest(wish(max_price_eur=19.0), cm, []).reason == "your €19.00 is reached on most days"


def test_the_lower_market_counts_and_data_errors_do_not():
    cm = days([20.0] * 60)
    ct = days([15.0] * 60)
    assert targets.suggest(wish(), cm, ct).target == 15.0
    broken = days([20.0] * 59 + [0.02])  # a €0.02 trend: a data error
    assert targets.suggest(wish(), broken, []).target == 20.0


def test_weekly_note_has_one_tap_buttons():
    cm = days([20.0 - (i % 20) * 0.5 for i in range(90)])
    s = targets.suggest(wish(scryfall_id="0c3f2c9e-1d3b-4a4e-9a8c-6f1b2d3e4f50"), cm, [])
    text, buttons = targets.weekly_note([s], "https://site.example")
    assert "<b>Loki, God of Mischief</b> · MSH #343" in text and "€12.00 · reached on 16 of 90 days" in text
    assert buttons == [[{"text": "Set €12.00 · Loki, God of Mischief",
                         "callback_data": "t|0c3f2c9e1d3b4a4e9a8c6f1b2d3e4f50|en|any|1200"}]]
