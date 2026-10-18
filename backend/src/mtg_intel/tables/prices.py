"""Price tables: one Parquet file per price date (D37).

`cardmarket_prices`: Cardmarket's own price guide, dated by its `createdAt` (in UTC).
`mtgjson_prices`: MTGJSON daily prices (paper only), long format, incl. the 90-day backfill.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from datetime import UTC, date, datetime
from pathlib import Path

import duckdb
import ijson
import pyarrow as pa

from mtg_intel.tables.rawfiles import open_raw, read_bytes

CARDMARKET_FIELDS = ["avg", "low", "trend", "avg1", "avg7", "avg30"]

CARDMARKET_SCHEMA = pa.schema(
    [
        ("price_date", pa.date32()),
        ("created_at", pa.timestamp("s", tz="UTC")),
        ("id_product", pa.int64()),
        ("id_category", pa.int32()),
        *[(f, pa.float64()) for f in CARDMARKET_FIELDS],
        *[(f"{f}_foil", pa.float64()) for f in CARDMARKET_FIELDS],
    ]
)

MTGJSON_SCHEMA = pa.schema(
    [
        ("price_date", pa.date32()),
        ("uuid", pa.string()),
        ("provider", pa.string()),
        ("price_type", pa.string()),  # retail | buylist
        ("finish", pa.string()),  # normal | foil | etched
        ("currency", pa.string()),
        ("price", pa.float64()),
    ]
)

BATCH_ROWS = 500_000


def cardmarket_prices(price_guide: Path) -> tuple[date, pa.Table]:
    """`price_date` is Cardmarket's own calendar day (as written in `createdAt`); `created_at` is UTC."""
    data = json.loads(read_bytes(price_guide))
    local = datetime.strptime(data["createdAt"], "%Y-%m-%dT%H:%M:%S%z")
    created, day = local.astimezone(UTC), local.date()
    rows = data["priceGuides"]
    columns: dict[str, list] = {
        "price_date": [day] * len(rows),
        "created_at": [created] * len(rows),
        "id_product": [r["idProduct"] for r in rows],
        "id_category": [r.get("idCategory") for r in rows],
    }
    for f in CARDMARKET_FIELDS:
        columns[f] = [r.get(f) for r in rows]
        columns[f"{f}_foil"] = [r.get(f"{f}-foil") for r in rows]
    return day, pa.table(columns, schema=CARDMARKET_SCHEMA)


def cardmarket_products(singles: Path, nonsingles: Path | None) -> pa.Table:
    rows = []
    for path, kind in [(singles, "single"), (nonsingles, "nonsingle")]:
        if path is None:
            continue
        for p in json.loads(read_bytes(path))["products"]:
            rows.append(
                {
                    "id_product": p["idProduct"],
                    "name": p.get("name"),
                    "id_category": p.get("idCategory"),
                    "category_name": p.get("categoryName"),
                    "id_expansion": p.get("idExpansion"),
                    "id_metacard": p.get("idMetacard"),
                    "date_added": p.get("dateAdded"),
                    "kind": kind,
                }
            )
    return pa.Table.from_pylist(rows)


def mtgjson_batches(path: Path) -> Iterator[pa.Table]:
    """Stream (paper) price rows from AllPrices / AllPricesToday without loading the whole file."""
    columns: dict[str, list] = {name: [] for name in MTGJSON_SCHEMA.names}

    def flush() -> pa.Table:
        table = pa.table(columns, schema=MTGJSON_SCHEMA)
        for values in columns.values():
            values.clear()
        return table

    with open_raw(path) as f:
        for uuid, formats in ijson.kvitems(f, "data", use_float=True):
            for provider, prices in (formats.get("paper") or {}).items():
                currency = prices.get("currency")
                for price_type in ("retail", "buylist"):
                    for finish, by_date in (prices.get(price_type) or {}).items():
                        for day, price in by_date.items():
                            columns["price_date"].append(date.fromisoformat(day))
                            columns["uuid"].append(uuid)
                            columns["provider"].append(provider)
                            columns["price_type"].append(price_type)
                            columns["finish"].append(finish)
                            columns["currency"].append(currency)
                            columns["price"].append(price)
            if len(columns["uuid"]) >= BATCH_ROWS:
                yield flush()
    if columns["uuid"]:
        yield flush()


def mtgjson_prices(
    path: Path,
    work_dir: Path,
    write: Callable[[date, pa.Table], None],
    skip_days: set[date] = frozenset(),
) -> list[date]:
    """Write every price date in an MTGJSON prices file through `write`, one day at a time.

    Rows spill to an on-disk DuckDB in `work_dir`, so even the 90-day file (~60M rows) stays
    within a small, fixed amount of memory. Days in `skip_days` are left out.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    db_path = work_dir / "mtgjson.duckdb"
    db_path.unlink(missing_ok=True)
    con = duckdb.connect(str(db_path))
    con.execute("set memory_limit = '1GB'")
    con.execute(
        "create table p (price_date date, uuid varchar, provider varchar, price_type varchar,"
        " finish varchar, currency varchar, price double)"
    )
    for batch in mtgjson_batches(path):
        con.register("batch", batch)
        con.execute("insert into p select * from batch")
        con.unregister("batch")
    days = [row[0] for row in con.execute("select distinct price_date from p order by 1").fetchall()]
    written = []
    for day in days:
        if day in skip_days:
            continue
        table = con.execute(
            "select * from p where price_date = ? order by uuid, provider, price_type, finish", [day]
        ).to_arrow_table().cast(MTGJSON_SCHEMA)
        write(day, table)
        written.append(day)
    con.close()
    db_path.unlink(missing_ok=True)
    return written
