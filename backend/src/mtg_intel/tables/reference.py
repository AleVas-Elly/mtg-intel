"""Card reference tables: `cards` (one row per paper printing) and `card_ids` (the bridge)."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pyarrow as pa

from mtg_intel.tables.rawfiles import read_bytes

SCRYFALL_COLUMNS = {
    "id": "VARCHAR",
    "oracle_id": "VARCHAR",
    "name": "VARCHAR",
    "set": "VARCHAR",
    "set_name": "VARCHAR",
    "set_type": "VARCHAR",
    "collector_number": "VARCHAR",
    "rarity": "VARCHAR",
    "released_at": "DATE",
    "lang": "VARCHAR",
    "layout": "VARCHAR",
    "border_color": "VARCHAR",
    "frame": "VARCHAR",
    "frame_effects": "VARCHAR[]",
    "promo_types": "VARCHAR[]",
    "full_art": "BOOLEAN",
    "finishes": "VARCHAR[]",
    "cardmarket_id": "BIGINT",
    "tcgplayer_id": "BIGINT",
    "edhrec_rank": "INTEGER",
    "reserved": "BOOLEAN",
    "reprint": "BOOLEAN",
    "games": "VARCHAR[]",
    # Card search (D45): what the card says and shows. Double-faced cards keep these per face.
    "mana_cost": "VARCHAR",
    "cmc": "DOUBLE",
    "type_line": "VARCHAR",
    "oracle_text": "VARCHAR",
    "flavor_text": "VARCHAR",
    "colors": "VARCHAR[]",
    "color_identity": "VARCHAR[]",
    "keywords": "VARCHAR[]",
    "power": "VARCHAR",
    "toughness": "VARCHAR",
    "loyalty": "VARCHAR",
    "artist": "VARCHAR",
    "image_uris": "STRUCT(small VARCHAR, normal VARCHAR)",
    "card_faces": "STRUCT(name VARCHAR, mana_cost VARCHAR, type_line VARCHAR, oracle_text VARCHAR, "
    "flavor_text VARCHAR, artist VARCHAR, image_uris STRUCT(small VARCHAR, normal VARCHAR))[]",
}
CARDS_TABLE_VERSION = 2  # bump when the columns change, so the next build rewrites the table

# Special-version tags (my collection focus). Frame effects and promo types are Scryfall's own words.
FRAME_TAGS = ["showcase", "extendedart", "etched"]
FOIL_TAGS = [
    "serialized",
    "textured",
    "galaxyfoil",
    "surgefoil",
    "halofoil",
    "confettifoil",
    "ripplefoil",
    "raisedfoil",
    "doublerainbow",
    "neonink",
    "oilslick",
    "gilded",
    "stepandcompleat",
    "rainbowfoil",
    "fracturefoil",
    "manafoil",
]


def faces(field: str) -> str:
    """SQL for a double-faced card's field, joined front // back the way Scryfall prints it."""
    return f"nullif(array_to_string(list_transform(card_faces, f -> f.{field}), ' // '), '')"


def build_cards(scryfall_jsonl_gz: Path) -> pa.Table:
    """One row per paper printing, with `special_tags` such as borderless, showcase, extendedart."""
    con = duckdb.connect()
    frame_tags = ", ".join(f"'{t}'" for t in FRAME_TAGS)
    foil_tags = ", ".join(f"'{t}'" for t in FOIL_TAGS)
    return con.execute(
        f"""
        with raw as (
            select * from read_json(?, format='newline_delimited', columns={SCRYFALL_COLUMNS})
            where list_contains(games, 'paper')
        )
        select
            id as scryfall_id, oracle_id, name, "set" as set_code, set_name, set_type,
            collector_number, rarity, released_at, lang, layout, border_color, frame,
            coalesce(frame_effects, []) as frame_effects, coalesce(promo_types, []) as promo_types,
            coalesce(full_art, false) as full_art, finishes, cardmarket_id, tcgplayer_id,
            edhrec_rank, reserved, reprint,
            coalesce(mana_cost, {faces('mana_cost')}) as mana_cost, cmc,
            type_line, coalesce(oracle_text, {faces('oracle_text')}) as oracle_text,
            coalesce(flavor_text, {faces('flavor_text')}) as flavor_text,
            colors, color_identity, keywords, power, toughness, loyalty,
            coalesce(artist, {faces('artist')}) as artist,
            coalesce(image_uris.normal, card_faces[1].image_uris.normal) as image_url,
            list_filter([
                case when border_color = 'borderless' then 'borderless' end,
                case when coalesce(full_art, false) then 'fullart' end,
                -- an old frame on a modern card is a deliberate retro printing
                case when frame in ('1993', '1997') and released_at >= DATE '2020-01-01' then 'retroframe' end
            ], x -> x is not null)
            || list_filter(coalesce(frame_effects, []), x -> list_contains([{frame_tags}], x))
            || list_filter(coalesce(promo_types, []), x -> list_contains([{foil_tags}], x))
            as special_tags
        from raw
        order by set_code, collector_number
        """,
        [str(scryfall_jsonl_gz)],
    ).to_arrow_table()


def build_card_ids(cards: pa.Table, mtgjson_identifiers: Path, cardtrader_catalog: Path | None) -> pa.Table:
    """Long table (scryfall_id, source, external_id) linking every printing to each marketplace's ID."""
    con = duckdb.connect()
    con.register("cards", cards)
    con.execute(
        "create table ids as select uuid, scryfallId, mcmId from read_parquet(?) where scryfallId is not null",
        [str(mtgjson_identifiers)],
    )
    rows = list(cardtrader_blueprints(cardtrader_catalog)) if cardtrader_catalog else []
    ct = pa.table(
        {
            "scryfall_id": pa.array([r[0] for r in rows], pa.string()),
            "blueprint_id": pa.array([r[1] for r in rows], pa.int64()),
            "card_market_id": pa.array([r[2] for r in rows], pa.int64()),
        }
    )
    con.register("ct", ct)
    return con.execute(
        """
        select distinct * from (
            select scryfall_id, 'cardmarket' as source, cast(cardmarket_id as varchar) as external_id
                from cards where cardmarket_id is not null
            union all
            select scryfallId, 'cardmarket', cast(mcmId as varchar) from ids where mcmId is not null
            union all
            select scryfall_id, 'tcgplayer', cast(tcgplayer_id as varchar) from cards where tcgplayer_id is not null
            union all
            select scryfallId, 'mtgjson', uuid from ids
            union all
            select scryfall_id, 'cardtrader', cast(blueprint_id as varchar) from ct
            union all
            select scryfall_id, 'cardmarket', cast(card_market_id as varchar) from ct where card_market_id is not null
        )
        where scryfall_id in (select scryfall_id from cards)
        order by scryfall_id, source, external_id
        """
    ).to_arrow_table()


def cardtrader_blueprints(catalog_jsonl_zst: Path):
    """Yield (scryfall_id, blueprint_id, card_market_id) from a CardTrader catalog file."""
    for line in read_bytes(catalog_jsonl_zst).decode().splitlines():
        record = json.loads(line)
        if record.get("path") != "/blueprints/export" or not record.get("body") or record.get("error"):
            continue
        try:
            blueprints = json.loads(record["body"])
        except ValueError:
            continue
        for bp in blueprints if isinstance(blueprints, list) else []:
            scryfall_id = bp.get("scryfall_id")
            if not scryfall_id:
                continue
            market_ids = bp.get("card_market_ids") or [None]
            for market_id in market_ids:
                yield scryfall_id, bp["id"], market_id
