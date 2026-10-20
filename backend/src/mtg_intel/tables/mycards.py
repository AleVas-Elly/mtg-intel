"""My cards (D36, D37): the collection (ManaBox CSV export) and the want-list (our own CSV).

Both are matched to Scryfall printings. Rows that can't be matched stay in the table with
`matched = false`, so nothing I typed silently disappears.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

import duckdb
import pyarrow as pa

CONDITIONS = ["NM", "SP", "MP", "PL", "PO"]  # CardTrader: Near Mint … Poor (Mint counts as NM)

WANTLIST_COLUMNS = [
    "name",
    "set_code",
    "collector_number",
    "scryfall_id",
    "language",  # en, it, fr, … or any
    "foil",  # yes | no | any
    "min_condition",  # NM | SP | MP | PL | PO
    "via_zero",  # yes | no (CardTrader Zero only)
    "max_price_eur",  # optional target price
    "quantity",
    "list",  # my own grouping, e.g. the CardTrader wishlist it came from ("; " between several)
    "cardtrader_blueprint_id",  # exact CardTrader card, when known
    "one_of",  # rows sharing a value are alternatives: buying any one fulfils the wish
    "note",
]

# ManaBox export headers we use, matched case-insensitively. To check against a real export
# (spec, open questions).
MANABOX_COLUMNS = {
    "name": "name",
    "set code": "set_code",
    "collector number": "collector_number",
    "scryfall id": "scryfall_id",
    "quantity": "quantity",
    "foil": "foil",
    "condition": "condition",
    "language": "language",
    "purchase price": "purchase_price",
    "purchase price currency": "purchase_price_currency",
}


def read_csv_rows(text: str) -> list[dict[str, str]]:
    sample = text[:4096]
    dialect = csv.Sniffer().sniff(sample, delimiters=",;\t") if sample.strip() else csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    return [{(k or "").strip().lower(): (v or "").strip() for k, v in row.items()} for row in reader]


def wantlist_table(text: str, cards: pa.Table) -> pa.Table:
    rows = []
    for i, row in enumerate(read_csv_rows(text), start=2):  # line 1 is the header
        rows.append(
            {
                "line": i,
                **{c: row.get(c, "") for c in WANTLIST_COLUMNS},
            }
        )
    for row in rows:
        row["language"] = (row["language"] or "any").lower()
        row["foil"] = (row["foil"] or "any").lower()
        row["min_condition"] = (row["min_condition"] or "NM").upper()
        row["via_zero"] = (row["via_zero"] or "yes").lower()
        row["quantity"] = row["quantity"] or "1"
    # Every wish names its version (D44): a name alone is not matched.
    schema = _schema(["line"] + WANTLIST_COLUMNS, {"line": pa.int32()})
    return match(pa.Table.from_pylist(rows, schema=schema), cards, by_name=False)


def collection_table(text: str, cards: pa.Table) -> pa.Table:
    rows = []
    for i, row in enumerate(read_csv_rows(text), start=2):
        mapped = {ours: row.get(theirs, "") for theirs, ours in MANABOX_COLUMNS.items()}
        rows.append({"line": i, **mapped})
    columns = ["line", *MANABOX_COLUMNS.values()]
    return match(pa.Table.from_pylist(rows, schema=_schema(columns, {"line": pa.int32()})), cards)


def _schema(columns: list[str], types: dict[str, pa.DataType]) -> pa.Schema:
    return pa.schema([(c, types.get(c, pa.string())) for c in columns])


def match(rows: pa.Table, cards: pa.Table, by_name: bool = True) -> pa.Table:
    """Find each row's Scryfall printing: by Scryfall ID, else set + number, else name (newest printing)."""
    con = duckdb.connect()
    con.register("rows", rows)
    con.register("cards", cards)
    return con.execute(
        """
        with by_id as (
            select r.line, c.scryfall_id as hit from rows r join cards c on c.scryfall_id = nullif(r.scryfall_id, '')
        ),
        by_number as (
            select r.line, c.scryfall_id as hit from rows r
            join cards c on lower(c.set_code) = lower(r.set_code) and c.collector_number = r.collector_number
            where nullif(r.scryfall_id, '') is null
        ),
        by_name as (
            select r.line, arg_max(c.scryfall_id, c.released_at) as hit from rows r
            join cards c on lower(c.name) = lower(r.name)
            where nullif(r.scryfall_id, '') is null and nullif(r.collector_number, '') is null and $by_name
            group by r.line
        ),
        hits as (select * from by_id union all select * from by_number union all select * from by_name)
        select r.* exclude (scryfall_id),
            coalesce(h.hit, nullif(r.scryfall_id, '')) as scryfall_id,
            h.hit is not null as matched,
            c.name as card_name, c.set_code as card_set, c.collector_number as card_number,
            c.special_tags
        from rows r
        left join (select line, any_value(hit) as hit from hits group by line) h using (line)
        left join cards c on c.scryfall_id = h.hit
        order by r.line
        """,
        {"by_name": by_name},
    ).to_arrow_table()


def read_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8-sig")
