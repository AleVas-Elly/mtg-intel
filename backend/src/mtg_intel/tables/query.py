"""DuckDB over the phase 2 tables: one connection with a view per table."""

from __future__ import annotations

from pathlib import Path

import duckdb

VIEWS = {
    "cards": "reference/cards.parquet",
    "card_ids": "reference/card_ids.parquet",
    "cardmarket_products": "reference/cardmarket_products.parquet",
    "cardmarket_prices": "prices/cardmarket/*/*.parquet",
    "mtgjson_prices": "prices/mtgjson/*/*.parquet",
    "collection": "my/collection.parquet",
    "wantlist": "my/wantlist.parquet",
}


def connect(tables_dir: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for name, pattern in VIEWS.items():
        if any(tables_dir.glob(pattern)):
            con.execute(f"create view {name} as select * from read_parquet('{tables_dir / pattern}')")
    if {"cards", "card_ids", "cardmarket_prices"} <= set(views(con)):
        # The everyday question: a printing's Cardmarket prices over time.
        con.execute(
            """
            create view card_cardmarket_prices as
            select c.scryfall_id, c.name, c.set_code, c.collector_number, c.special_tags, p.*
            from cards c
            join card_ids i on i.scryfall_id = c.scryfall_id and i.source = 'cardmarket'
            join cardmarket_prices p on p.id_product = cast(i.external_id as bigint)
            """
        )
    if {"cards", "card_ids", "mtgjson_prices"} <= set(views(con)):
        # MTGJSON history, incl. the 90-day backfill before our own Cardmarket archive started.
        con.execute(
            """
            create view card_mtgjson_prices as
            select c.scryfall_id, c.name, c.set_code, c.collector_number, c.special_tags, p.*
            from cards c
            join card_ids i on i.scryfall_id = c.scryfall_id and i.source = 'mtgjson'
            join mtgjson_prices p on p.uuid = i.external_id
            """
        )
    return con


def views(con: duckdb.DuckDBPyConnection) -> list[str]:
    return [r[0] for r in con.execute("select view_name from duckdb_views() where not internal").fetchall()]


def price_history(con: duckdb.DuckDBPyConnection, name: str, set_code: str | None = None):
    """Cardmarket trend/avg/low (+ foil) per day for every printing matching `name` (and set)."""
    sql = """
        select price_date, name, set_code, collector_number, special_tags,
               trend, avg, low, trend_foil, avg_foil, low_foil
        from card_cardmarket_prices
        where lower(name) = lower(?) {}
        order by set_code, collector_number, price_date
    """.format("and lower(set_code) = lower(?)" if set_code else "")
    params = [name, set_code] if set_code else [name]
    return con.execute(sql, params)
