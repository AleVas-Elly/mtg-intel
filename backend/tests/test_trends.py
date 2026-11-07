from datetime import date, timedelta

from test_deals import wish

from mtg_intel import trends

END = date(2026, 11, 6)


def weekly(*prices, end=END):
    """Daily points whose weeks (oldest first, the last ending on `end`) hold these prices."""
    out = []
    for n, p in enumerate(reversed(prices)):
        for d in range(7):
            out.append(((end - timedelta(days=7 * n + d)).isoformat(), p))
    return sorted(out)


def test_week_price_is_the_median_and_needs_four_days():
    pts = [((END - timedelta(days=d)).isoformat(), v) for d, v in enumerate([10, 11, 50, 12])]
    assert trends.week_price(pts, END) == 11.5  # the €50 day doesn't drag it up
    assert trends.week_price(pts[:3], END) is None


def test_slow_slide_still_falling():
    m = trends.move(wish(), weekly(20, 19, 18, 17, 16), END)
    assert (m.kind, round(m.change), m.weeks) == ("falling", -20, [20, 19, 18, 17, 16])
    assert m.where == "MSH #343"


def test_slide_that_flattened_has_stopped_falling():
    assert trends.move(wish(), weekly(20, 18, 17, 16, 16), END).kind == "stopped"
    assert trends.move(wish(), weekly(20, 17, 16, 15, 15.5), END).kind == "stopped"  # a small bounce too
    assert trends.move(wish(), weekly(20, 17, 15, 17, 16.5), END).kind == "stopped"  # down this week, off a lower low


def test_rising_and_small_moves():
    assert trends.move(wish(), weekly(10, 10.5, 11, 11.5, 12), END).kind == "rising"
    assert trends.move(wish(), weekly(10, 10, 9.6, 9.4, 9.2), END) is None  # −8%: not a move


def test_cheap_cards_and_short_history_are_left_out():
    assert trends.move(wish(), weekly(6, 5.5, 5, 4.6, 4.2), END) is None  # under €5
    assert trends.move(wish(), weekly(20, 18, 16), END) is None  # three weeks of prices


def test_weekly_moves_reads_the_finish_and_sorts_by_size():
    rows = {"a": [{"price_date": d, "finish": "normal", "trend": v, "source": "cardmarket"} for d, v in weekly(20, 19, 18, 17, 16)],
            "b": [{"price_date": d, "finish": "normal", "trend": v, "source": "cardmarket"} for d, v in weekly(20, 15, 13, 12, 11)]}
    watch = [wish(scryfall_id="a", foil="no"), wish(scryfall_id="b", foil="no", collector_number="1")]
    moves = trends.weekly_moves(watch, rows)
    assert [m.where for m in moves] == ["MSH #1", "MSH #343"]
    assert trends.weekly_moves([wish(scryfall_id="a", foil="yes")], rows) == []  # no foil prices


def test_note_has_sections_links_and_caps():
    falling = [trends.move(wish(collector_number=str(i)), weekly(20, 19, 18, 17, 16), END) for i in range(12)]
    rising = trends.move(wish(name="A & B"), weekly(10, 10.5, 11, 11.5, 12), END)
    note = trends.weekly_note(falling + [rising], "https://site.example/")
    assert "📉 <b>Still falling</b> · wait · top 10 of 12" in note
    assert "€20.00 → 19.00 → 18.00 → 17.00 → 16.00 · −20% in 4 weeks" in note
    assert '<a href="https://site.example/wants?card=sf-loki%7Cen%7Cany"><b>A &amp; B</b></a>' in note
    assert "+20% in 4 weeks" in note and "Stopped falling" not in note
    assert note.count("MSH #") == 11
    assert trends.weekly_note([], None) is None
