import gzip
import json
import lzma
from datetime import UTC, date, datetime
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import zstandard

from mtg_intel.tables import build, mycards, prices, query, reference

NOW = datetime(2026, 10, 19, 4, 0, tzinfo=UTC)


def scryfall_card(**overrides):
    card = {
        "id": "sf-1",
        "oracle_id": "or-1",
        "name": "Elvish Archdruid",
        "set": "fdn",
        "set_name": "Foundations",
        "set_type": "core",
        "collector_number": "219",
        "rarity": "rare",
        "released_at": "2024-11-15",
        "lang": "en",
        "layout": "normal",
        "border_color": "black",
        "frame": "2015",
        "finishes": ["nonfoil", "foil"],
        "cardmarket_id": 795130,
        "tcgplayer_id": 589337,
        "games": ["paper", "arena"],
        "unknown_extra_field": {"nested": True},  # Scryfall adds fields; we must not break
    }
    card.update(overrides)
    return card


def write_scryfall(path: Path, cards: list[dict]) -> Path:
    with gzip.open(path, "wt") as f:
        for card in cards:
            f.write(json.dumps(card) + "\n")
    return path


def write_zst(path: Path, text: str) -> Path:
    path.write_bytes(zstandard.ZstdCompressor().compress(text.encode()))
    return path


def write_identifiers(path: Path, rows: list[dict]) -> Path:
    pq.write_table(pa.Table.from_pylist(rows), path)
    return path


def write_catalog(path: Path, blueprints: list[dict]) -> Path:
    lines = [
        {"path": "/games", "params": {}, "status": 200, "error": None, "body": "[]"},
        {"path": "/blueprints/export", "params": {"expansion_id": 1}, "status": 200, "error": None,
         "body": json.dumps(blueprints)},
    ]
    return write_zst(path, "\n".join(json.dumps(line) for line in lines) + "\n")


def write_price_guide(path: Path, created_at: str, rows: list[dict]) -> Path:
    return write_zst(path, json.dumps({"version": 1, "createdAt": created_at, "priceGuides": rows}))


def write_mtgjson(path: Path, data: dict) -> Path:
    path.write_bytes(lzma.compress(json.dumps({"meta": {}, "data": data}).encode()))
    return path


# --- reference ---------------------------------------------------------------------------------


def test_cards_get_special_version_tags(tmp_path: Path):
    src = write_scryfall(
        tmp_path / "cards.jsonl.gz",
        [
            scryfall_card(),
            scryfall_card(id="sf-2", collector_number="300", border_color="borderless",
                          frame_effects=["showcase", "legendary"], promo_types=["serialized", "boosterfun"]),
            scryfall_card(id="sf-3", collector_number="1", frame="1997", released_at="2023-02-03"),
            scryfall_card(id="sf-4", collector_number="2", frame="1997", released_at="1999-01-01"),
            scryfall_card(id="sf-digital", games=["arena"]),
        ],
    )

    cards = reference.build_cards(src).to_pylist()

    tags = {c["scryfall_id"]: c["special_tags"] for c in cards}
    assert tags == {
        "sf-1": [],
        "sf-2": ["borderless", "showcase", "serialized"],
        "sf-3": ["retroframe"],  # old frame on a modern card
        "sf-4": [],  # an actual 1999 card is not a retro printing
    }


def test_cards_keep_text_cost_type_and_artist_also_for_double_faced_cards(tmp_path: Path):
    src = write_scryfall(tmp_path / "cards.jsonl.gz", [
        scryfall_card(mana_cost="{3}{G}", cmc=4.0, type_line="Creature — Elf Druid",
                      oracle_text="Tap: add G for each Elf.", artist="Karl Kopinski",
                      image_uris={"small": "s.jpg", "normal": "n.jpg"}),
        scryfall_card(id="sf-dfc", name="Tergrid, God of Fright // Tergrid's Lantern", collector_number="112",
                      type_line="Legendary Creature — God // Legendary Artifact", cmc=5.0, artist="Yongjae Choi",
                      card_faces=[
                          {"name": "Tergrid, God of Fright", "mana_cost": "{3}{B}{B}", "oracle_text": "Menace",
                           "image_uris": {"small": "f.jpg", "normal": "front.jpg"}},
                          {"name": "Tergrid's Lantern", "mana_cost": "{3}{B}", "oracle_text": "Tap: lose 3 life."},
                      ]),
    ])

    cards = {c["scryfall_id"]: c for c in reference.build_cards(src).to_pylist()}
    elf, tergrid = cards["sf-1"], cards["sf-dfc"]

    assert (elf["mana_cost"], elf["cmc"], elf["type_line"], elf["artist"], elf["image_url"]) == (
        "{3}{G}", 4.0, "Creature — Elf Druid", "Karl Kopinski", "n.jpg")
    assert elf["oracle_text"] == "Tap: add G for each Elf."
    assert tergrid["mana_cost"] == "{3}{B}{B} // {3}{B}"
    assert tergrid["oracle_text"] == "Menace // Tap: lose 3 life."
    assert tergrid["image_url"] == "front.jpg"


def test_card_ids_link_all_marketplaces(tmp_path: Path):
    cards = reference.build_cards(write_scryfall(tmp_path / "c.jsonl.gz", [scryfall_card()]))
    ids = write_identifiers(tmp_path / "ids.parquet", [
        {"uuid": "uuid-1", "scryfallId": "sf-1", "mcmId": "795130"},
        {"uuid": "uuid-other", "scryfallId": "sf-not-paper", "mcmId": None},
    ])
    catalog = write_catalog(tmp_path / "bp.jsonl.zst", [
        {"id": 307063, "scryfall_id": "sf-1", "card_market_ids": [795130]},
        {"id": 999, "scryfall_id": None, "card_market_ids": []},  # sealed product: no card
    ])

    links = reference.build_card_ids(cards, ids, catalog).to_pylist()

    assert sorted((r["source"], r["external_id"]) for r in links) == [
        ("cardmarket", "795130"),  # same ID from Scryfall, MTGJSON and CardTrader: kept once
        ("cardtrader", "307063"),
        ("mtgjson", "uuid-1"),
        ("tcgplayer", "589337"),
    ]


# --- prices ------------------------------------------------------------------------------------


def test_cardmarket_prices_use_cardmarkets_own_day(tmp_path: Path):
    guide = write_price_guide(tmp_path / "g.json.zst", "2026-10-18T01:30:00+0200", [
        {"idProduct": 795130, "idCategory": 1, "avg": 0.7, "low": 0.15, "trend": 0.65,
         "avg1": 0.6, "avg7": 0.66, "avg30": 0.7, "trend-foil": 0.98, "low-foil": 0.3},
    ])

    day, table = prices.cardmarket_prices(guide)

    row = table.to_pylist()[0]
    assert day == date(2026, 10, 18)  # 23:30 UTC the day before, but Cardmarket's 18 October
    assert row["created_at"] == datetime(2026, 10, 17, 23, 30, tzinfo=UTC)
    assert (row["trend"], row["trend_foil"], row["avg_foil"]) == (0.65, 0.98, None)


def test_mtgjson_prices_are_split_by_day_and_skip_known_days(tmp_path: Path):
    src = write_mtgjson(tmp_path / "AllPrices.json.xz", {
        "uuid-1": {
            "paper": {"cardmarket": {"retail": {"foil": {"2026-10-16": 1.0, "2026-10-17": 1.1}},
                                     "buylist": {}, "currency": "EUR"}},
            "mtgo": {"cardhoarder": {"retail": {"normal": {"2026-10-17": 0.02}}, "currency": "USD"}},
        },
    })
    written: dict[date, list] = {}

    days = prices.mtgjson_prices(src, tmp_path / "work", lambda d, t: written.update({d: t.to_pylist()}),
                                 skip_days={date(2026, 10, 16)})

    assert days == [date(2026, 10, 17)]
    assert written[date(2026, 10, 17)] == [{
        "price_date": date(2026, 10, 17), "uuid": "uuid-1", "provider": "cardmarket",
        "price_type": "retail", "finish": "foil", "currency": "EUR", "price": 1.1,
    }]  # MTGO prices are left out


# --- checks ------------------------------------------------------------------------------------


def test_check_days_reports_gaps_stale_and_shrinking():
    counts = {"2026-10-14": 1000, "2026-10-15": 1000, "2026-10-17": 500}
    problems = build.check_days("Cardmarket", counts, NOW)
    assert problems == [
        "Cardmarket: missing price days 2026-10-16",
        "Cardmarket: latest price day is 2026-10-17",
        "Cardmarket: 2026-10-17 has 500 rows, 1,000 the day before",
    ]
    assert build.check_days("Cardmarket", {"2026-10-18": 10, "2026-10-19": 10}, NOW) == []


# --- my cards ----------------------------------------------------------------------------------


def two_printings(tmp_path: Path) -> pa.Table:
    return reference.build_cards(write_scryfall(tmp_path / "c.jsonl.gz", [
        scryfall_card(),
        scryfall_card(id="sf-new", set="j25", collector_number="5", released_at="2025-01-01"),
    ]))


def test_wantlist_matches_by_number_and_id_and_needs_a_version(tmp_path: Path):
    cards = two_printings(tmp_path)
    text = (
        "name,set_code,collector_number,scryfall_id,language,foil,min_condition,via_zero,max_price_eur,note\n"
        "Elvish Archdruid,FDN,219,,en,yes,nm,yes,0.50,\n"
        "elvish archdruid,,,,,,,,,\n"
        ",,,sf-1,,,,,,\n"
        "Not A Real Card,,,,,,,,,\n"
    )

    rows = mycards.wantlist_table(text, cards).to_pylist()

    assert [(r["line"], r["scryfall_id"], r["matched"]) for r in rows] == [
        (2, "sf-1", True),
        (3, None, False),  # name only: no version, flagged
        (4, "sf-1", True),
        (5, None, False),
    ]
    assert (rows[0]["min_condition"], rows[1]["foil"], rows[1]["via_zero"], rows[1]["language"]) == ("NM", "any", "yes", "any")


def test_site_edits_add_change_and_remove_wishes(tmp_path: Path):
    cards = two_printings(tmp_path)
    text = mycards.write_csv([{"name": "Elvish Archdruid", "scryfall_id": "sf-1", "language": "en", "foil": "any",
                               "min_condition": "NM", "via_zero": "yes", "quantity": "1", "list": "Showcase"}])
    ops = [
        {"id": "a", "op": "add", "scryfall_id": "sf-new", "settings": {"max_price_eur": "4.5", "list": "Showcase"}},
        {"id": "b", "op": "add", "scryfall_id": "sf-new", "settings": {}},  # same version again
        {"id": "c", "op": "update", "key": "sf-1|en|any", "settings": {"foil": "Yes", "deal_pct": "30", "note": "for the deck"}},
        {"id": "d", "op": "update", "key": "sf-1|en|any", "settings": {}},  # its key changed with "c"
        {"id": "e", "op": "update", "key": "sf-1|en|yes", "settings": {"min_condition": "XX"}},
        {"id": "f", "op": "remove", "key": "sf-new|en|any"},
        {"id": "g", "op": "add", "scryfall_id": "sf-new", "settings": {"language": "ja"}},
    ]

    text, results = mycards.apply_edits(text, ops, cards, {"sf-new": 777})

    assert [(r["id"], r["ok"]) for r in results] == [
        ("a", True), ("b", False), ("c", True), ("d", False), ("e", False), ("f", True), ("g", True)]
    assert results[1]["message"] == "already on the want-list"
    rows = mycards.read_csv_rows(text)
    assert [(r["scryfall_id"], r["language"], r["foil"], r["deal_pct"], r["note"]) for r in rows] == [
        ("sf-1", "en", "yes", "30", "for the deck"),
        ("sf-new", "ja", "any", "", ""),
    ]
    assert (rows[1]["set_code"], rows[1]["collector_number"], rows[1]["cardtrader_blueprint_id"]) == ("j25", "5", "777")
    assert (rows[1]["min_condition"], rows[1]["via_zero"]) == ("NM", "no")  # the defaults


def test_collection_reads_manabox_headers(tmp_path: Path):
    cards = two_printings(tmp_path)
    text = (
        "Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,"
        "Purchase price,Misprint,Altered,Condition,Language,Purchase price currency\n"
        "Elvish Archdruid,fdn,Foundations,219,foil,rare,2,123,sf-1,0.55,false,false,near_mint,en,EUR\n"
    )

    [row] = mycards.collection_table(text, cards).to_pylist()

    assert (row["scryfall_id"], row["matched"], row["quantity"], row["foil"], row["purchase_price"]) == (
        "sf-1", True, "2", "foil", "0.55")


# --- the build, end to end ---------------------------------------------------------------------


def make_archive(root: Path) -> Path:
    def at(path: str) -> Path:
        p = root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    write_scryfall(at("raw/scryfall_default_cards/2026-10-17/0200Z_default-cards.jsonl.gz"), [scryfall_card()])
    write_identifiers(at("raw/mtgjson_card_identifiers/2026-10-18/1029Z_cardIdentifiers.parquet"),
                      [{"uuid": "uuid-1", "scryfallId": "sf-1", "mcmId": "795130"}])
    for day in ("17", "18"):
        write_price_guide(at(f"raw/cardmarket_price_guide/2026-10-{day}/0217Z_price_guide_1.json.zst"),
                          f"2026-10-{day}T02:44:00+0200", [{"idProduct": 795130, "trend": 0.6}])
    write_mtgjson(at("raw/mtgjson_allprices/2026-10-17/1424Z_AllPrices.json.xz"), {
        "uuid-1": {"paper": {"cardmarket": {"retail": {"normal": {"2026-10-15": 0.5, "2026-10-16": 0.55,
                                                                  "2026-10-17": 0.6}}, "currency": "EUR"}}}})
    write_mtgjson(at("raw/mtgjson_allprices_today/2026-10-18/0817Z_AllPricesToday.json.xz"), {
        "uuid-1": {"paper": {"cardmarket": {"retail": {"normal": {"2026-10-18": 0.61}}, "currency": "EUR"}}}})
    return root


def test_build_is_incremental_and_queryable(tmp_path: Path):
    raw = build.LocalRaw(make_archive(tmp_path / "archive"))
    store = build.LocalTables(tmp_path / "tables")

    first = build.build(raw, store, tmp_path / "staging", NOW)

    assert first.problems == []
    assert "prices/cardmarket/2026/2026-10-18.parquet (1 rows)" in first.written
    # backfill fills 15-17; the daily file gives 18
    mtgjson_files = sorted(w.split(" ")[0] for w in first.written if w.startswith("prices/mtgjson"))
    assert mtgjson_files == [f"prices/mtgjson/2026/2026-10-{d}.parquet" for d in ("15", "16", "17", "18")]

    second = build.build(raw, store, tmp_path / "staging", NOW)
    assert second.written == [] and second.notes == ["nothing new to build"]

    con = query.connect(tmp_path / "tables")
    history = query.price_history(con, "elvish archdruid").fetchall()
    assert [(r[0], r[5]) for r in history] == [(date(2026, 10, 17), 0.6), (date(2026, 10, 18), 0.6)]
    mtgjson_days = con.execute("select count(*) from card_mtgjson_prices where scryfall_id = 'sf-1'").fetchone()
    assert mtgjson_days == (4,)


def test_build_picks_up_my_wantlist_and_rebuilds_only_when_it_changes(tmp_path: Path):
    raw = build.LocalRaw(make_archive(tmp_path / "archive"))
    store = build.LocalTables(tmp_path / "tables")
    build.build(raw, store, tmp_path / "staging", NOW)

    want = tmp_path / "want.csv"
    want.write_text("name,set_code,collector_number,cardtrader_blueprint_id\nElvish Archdruid,fdn,219,77\n")
    store.put([(build.MY_INPUTS["wantlist"], want)], "upload")
    report = build.build(raw, store, tmp_path / "staging", NOW)
    assert report.written == ["my/wantlist.parquet (1 rows)", "my/watch.parquet (1 rows)",
                              "my/price_history.parquet (6 rows)"]
    [watch] = pq.read_table(tmp_path / "tables/my/watch.parquet").to_pylist()
    assert (watch["blueprint_id"], watch["cardmarket_id"]) == (77, 795130)
    assert watch["trend"] is not None  # latest Cardmarket price day
    # The site's price history: both Cardmarket days and the four MTGJSON days, for my printing only.
    history = pq.read_table(tmp_path / "tables/my/price_history.parquet").to_pylist()
    assert [(r["source"], str(r["price_date"]), r["trend"]) for r in history] == [
        ("cardmarket", "2026-10-17", 0.6), ("cardmarket", "2026-10-18", 0.6),
        ("mtgjson", "2026-10-15", 0.5), ("mtgjson", "2026-10-16", 0.55),
        ("mtgjson", "2026-10-17", 0.6), ("mtgjson", "2026-10-18", 0.61)]

    assert build.build(raw, store, tmp_path / "staging", NOW).written == []

    want.write_text("name,set_code,collector_number\nElvish Archdruid,fdn,219\nTypo Card,,\n")
    store.put([(build.MY_INPUTS["wantlist"], want)], "upload")
    report = build.build(raw, store, tmp_path / "staging", NOW)
    assert report.written == ["my/wantlist.parquet (2 rows)", "my/watch.parquet (0 rows)",
                              "my/price_history.parquet (0 rows)"]
    assert report.problems == ["wantlist: 1 row(s) not matched to a card"]


def test_new_product_lists_rebuild_only_the_products_table(tmp_path: Path):
    archive = make_archive(tmp_path / "archive")
    products = archive / "raw/cardmarket_products_singles/2026-10-18/0817Z_products_singles_1.json.zst"
    products.parent.mkdir(parents=True)
    write_zst(products, json.dumps({"products": [{"idProduct": 795130, "name": "Elvish Archdruid"}]}))
    raw, store = build.LocalRaw(archive), build.LocalTables(tmp_path / "tables")
    build.build(raw, store, tmp_path / "staging", NOW)

    newer = archive / "raw/cardmarket_products_singles/2026-10-19/0817Z_products_singles_1.json.zst"
    newer.parent.mkdir(parents=True)
    write_zst(newer, json.dumps({"products": [{"idProduct": 795130, "name": "Elvish Archdruid"}, {"idProduct": 1}]}))
    report = build.build(raw, store, tmp_path / "staging", NOW)

    assert report.written == ["reference/cardmarket_products.parquet (2 rows)"]
