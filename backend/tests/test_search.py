from pathlib import Path

import httpx
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from test_tables import scryfall_card, write_scryfall

from mtg_intel import search
from mtg_intel.search import Scryfall, SearchError
from mtg_intel.tables import mycards, query, reference


def fake_scryfall(pages_by_query, seen):
    def handler(request: httpx.Request) -> httpx.Response:
        q = request.url.params.get("q", "")
        seen.append(request.url.params)
        if "page" in request.url.params:
            return httpx.Response(200, json=pages_by_query[q][int(request.url.params["page"]) - 1])
        if q not in pages_by_query:
            return httpx.Response(404, json={"object": "error", "details": "No cards found"})
        return httpx.Response(200, json=pages_by_query[q][0])
    return Scryfall(httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda s: None)


def page(ids, more=None, warnings=None, total=None):
    body = {"object": "list", "total_cards": total or len(ids), "has_more": more is not None,
            "data": [{"id": i} for i in ids]}
    if more:
        body["next_page"] = more
    if warnings:
        body["warnings"] = warnings
    return body


def test_search_follows_pages_and_stops_at_the_cap():
    seen = []
    nxt = "https://api.scryfall.com/cards/search?q=art%3Acat&page=2"
    scryfall = fake_scryfall({"art:cat": [page(["a", "b"], more=nxt, total=3), page(["c"], total=3)]}, seen)

    found = scryfall.search("art:cat")
    assert (found.ids, found.total, found.truncated) == (["a", "b", "c"], 3, False)
    assert seen[0]["unique"] == "prints" and seen[0]["include_variations"] == "true"

    capped = scryfall.search("art:cat", max_pages=1)
    assert (capped.ids, capped.truncated) == (["a", "b"], True)


def test_no_match_is_empty_and_an_ignored_expression_is_an_error():
    scryfall = fake_scryfall({"foo:bar": [page(["x"], warnings=["Invalid expression “foo:bar” was ignored."])]}, [])
    assert scryfall.search("art:nothing").ids == []
    with pytest.raises(SearchError, match="foo:bar"):
        scryfall.search("foo:bar")


def test_printing_filters_respect_budget_and_set_groups():
    printings = [("msh", str(n)) for n in range(1, 4)] + [("mar", "99"), ("sld", "7123")]
    assert search.printing_filters(printings) == [
        '(s:msh (cn:"1" or cn:"2" or cn:"3")) or (s:mar (cn:"99")) or (s:sld (cn:"7123"))'
    ]
    assert search.printing_filters(printings, max_sets=2) == [
        '(s:msh (cn:"1" or cn:"2" or cn:"3")) or (s:mar (cn:"99"))', '(s:sld (cn:"7123"))'
    ]
    long = search.printing_filters([("msh", str(n)) for n in range(200)], budget=200)
    assert len(long) > 1 and all(len(f) <= 200 + 60 for f in long)


def tables(tmp_path: Path) -> Path:
    cards = reference.build_cards(write_scryfall(tmp_path / "c.jsonl.gz", [
        scryfall_card(),
        scryfall_card(id="sf-cat", name="Jetmir, Nexus of Revels", set="snc", collector_number="312"),
        scryfall_card(id="sf-other", name="Not Mine", set="snc", collector_number="1"),
    ]))
    out = tmp_path / "tables"
    (out / "reference").mkdir(parents=True)
    (out / "my").mkdir()
    pq.write_table(cards, out / "reference/cards.parquet")
    pq.write_table(pa.table({"scryfall_id": ["sf-1"], "source": ["cardmarket"], "external_id": ["1"]}),
                   out / "reference/card_ids.parquet")
    text = mycards.write_csv([{"scryfall_id": "sf-cat", "name": "Jetmir", "list": "Showcase"},
                              {"scryfall_id": "sf-1", "name": "Elvish Archdruid", "list": "buy"}])
    pq.write_table(mycards.wantlist_table(text, cards), out / "my/wantlist.parquet")
    return out


def test_scoped_search_names_only_my_printings_and_joins_my_lists(tmp_path: Path):
    con = query.connect(tables(tmp_path))
    seen = []
    q = '(art:cat) ((s:fdn (cn:"219")) or (s:snc (cn:"312")))'
    scryfall = fake_scryfall({q: [page(["sf-cat", "sf-other"])]}, seen)

    ids, _ = search.search(scryfall, con, "art:cat", "wantlist")
    rows = search.describe(con, ids).to_pylist()

    assert [s["q"] for s in seen] == [q]
    assert ids == ["sf-cat"]  # anything else Scryfall returns is not mine
    assert (rows[0]["name"], rows[0]["wanted_in"], rows[0]["trend"]) == ("Jetmir, Nexus of Revels", "Showcase", None)


def test_add_and_remove_wishes():
    text = mycards.write_csv([{"name": "A", "scryfall_id": "sf-a", "language": "en", "foil": "any", "list": "x; y"}])

    text, added, skipped = mycards.add_wishes(text, [
        {"name": "A", "scryfall_id": "sf-a", "language": "en", "foil": "any"},
        {"name": "B", "scryfall_id": "sf-b", "language": "en", "foil": "any", "list": "z"},
    ])
    assert ([r["name"] for r in added], [r["name"] for r in skipped]) == (["B"], ["A"])

    text, changed = mycards.remove_wishes(text, {"sf-a"}, "x")  # leaves list x, stays in y
    assert [r["list"] for r in mycards.read_csv_rows(text)] == ["y", "z"]
    text, changed = mycards.remove_wishes(text, {"sf-a", "sf-b"})
    assert mycards.read_csv_rows(text) == [] and len(changed) == 2
