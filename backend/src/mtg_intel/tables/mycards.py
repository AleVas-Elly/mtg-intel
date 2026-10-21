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
import pyarrow.compute as pc

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
    "deal_pct",  # optional: % under Cardmarket trend that counts as a deal (default 25, D40)
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


def add_wishes(text: str, wishes: list[dict[str, str]]) -> tuple[str, list[dict[str, str]], list[dict[str, str]]]:
    """Append wishes to the want-list CSV. A wish already there (same printing, language and foil) is
    skipped. Returns the new CSV text, the added and the skipped wishes."""
    rows = read_csv_rows(text) if text.strip() else []
    have = {(r.get("scryfall_id"), r.get("language"), r.get("foil")) for r in rows}
    added, skipped = [], []
    for wish in wishes:
        row = {c: wish.get(c, "") for c in WANTLIST_COLUMNS}
        key = (row["scryfall_id"], row["language"], row["foil"])
        (skipped if key in have else added).append(row)
        have.add(key)
    return write_csv(rows + added), added, skipped


def remove_wishes(text: str, scryfall_ids: set[str], list_name: str | None = None) -> tuple[str, list[dict[str, str]]]:
    """Drop the wishes for these printings (only from `list_name` when given; a row in several lists
    then just leaves that list). Returns the new CSV text and the rows that changed."""
    kept, changed = [], []
    for row in read_csv_rows(text):
        if row.get("scryfall_id") not in scryfall_ids:
            kept.append(row)
            continue
        lists = [name for name in (row.get("list") or "").split("; ") if name]
        if list_name and len(lists) > 1 and list_name in lists:
            row["list"] = "; ".join(name for name in lists if name != list_name)
            kept.append(row)
        elif list_name and list_name not in lists:
            kept.append(row)
            continue
        changed.append(row)
    return write_csv(kept), changed


def write_csv(rows: list[dict[str, str]]) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=WANTLIST_COLUMNS, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    writer.writerows({c: row.get(c, "") for c in WANTLIST_COLUMNS} for row in rows)
    return out.getvalue()


# --- edits made on the website (3c, D50) ------------------------------------------------------

EDITABLE = ["language", "foil", "min_condition", "via_zero", "max_price_eur", "deal_pct", "quantity", "list", "note"]
# Cards I bought, recorded on the site ("Bought it", 3c): what I paid against Cardmarket's trend
# that day is the saving (spec principle 5). Phase 4 builds the collection from it.
PURCHASE_COLUMNS = ["date", "name", "set_code", "collector_number", "scryfall_id", "cardtrader_blueprint_id", "language",
                    "foil", "condition", "price_eur", "market", "cardmarket_trend_eur", "list", "note"]
MARKETS = ("cardtrader", "cardmarket", "other")

ADD_DEFAULTS = {"language": "en", "foil": "any", "min_condition": "NM", "via_zero": "no", "quantity": "1"}  # user, 2026-10-22


def _setting_problem(column: str, value: str) -> str | None:
    """Why a value can't go into the CSV, or None when it can."""
    if "\n" in value or "\r" in value:
        return f"{column} can't hold a line break"
    if column == "language" and not (value == "any" or value.isalpha() and 2 <= len(value) <= 3):
        return f"unknown language {value!r}"
    if column == "foil" and value not in ("yes", "no", "any"):
        return f"foil must be yes, no or any, not {value!r}"
    if column == "min_condition" and value not in CONDITIONS:
        return f"condition must be one of {', '.join(CONDITIONS)}"
    if column == "via_zero" and value not in ("yes", "no"):
        return "Zero only must be yes or no"
    if column in ("max_price_eur", "deal_pct") and value:
        try:
            number = float(value)
        except ValueError:
            return f"{column} must be a number"
        if number <= 0 or column == "deal_pct" and number >= 100:
            return f"{column} is out of range"
    if column == "quantity" and not (value.isdigit() and int(value) >= 1):
        return "quantity must be a whole number from 1"
    return None


def _clean(settings: dict[str, object]) -> tuple[dict[str, str], str | None]:
    out: dict[str, str] = {}
    for column, value in settings.items():
        if column not in EDITABLE:
            return out, f"{column} can't be edited"
        text = "" if value is None else str(value).strip()
        if column in ("language", "foil", "via_zero"):
            text = text.lower()
        if column == "min_condition":
            text = text.upper()
        problem = _setting_problem(column, text)
        if problem:
            return out, problem
        out[column] = text
    return out, None


def wish_key_of(row: dict[str, object]) -> str:
    """The key the site uses for a wish (deals.wish_key over a want-list table row)."""
    sid = row.get("scryfall_id") or None
    blueprint = row.get("cardtrader_blueprint_id") or None
    return f"{sid or (int(blueprint) if blueprint else None)}|{row['language']}|{row['foil']}"


def _purchase(wish_row: dict[str, str], purchase: dict[str, object]) -> tuple[dict[str, str], str | None]:
    """A purchase row for a wish, or why the purchase can't be recorded."""
    p = {k: ("" if v is None else str(v).strip()) for k, v in purchase.items()}
    try:
        price = float(p.get("price_eur", "").replace(",", "."))
    except ValueError:
        return {}, "the price paid must be a number"
    if price <= 0:
        return {}, "the price paid must be above zero"
    if p.get("market") not in MARKETS:
        return {}, "where it was bought must be CardTrader, Cardmarket or other"
    if p.get("condition", "").upper() not in CONDITIONS:
        return {}, f"condition must be one of {', '.join(CONDITIONS)}"
    if p.get("foil") not in ("yes", "no"):
        return {}, "foil must be yes or no"
    date = p.get("date", "")
    if not (len(date) == 10 and date[4] == date[7] == "-" and date.replace("-", "").isdigit()):
        return {}, "the date must look like 2026-10-22"
    trend = p.get("cardmarket_trend_eur", "")
    try:
        trend = f"{float(trend):.2f}" if trend else ""
    except ValueError:
        trend = ""
    language = (p.get("language") or wish_row.get("language") or "").lower()
    return {
        "date": date, "name": wish_row.get("name", ""), "set_code": wish_row.get("set_code", ""),
        "collector_number": wish_row.get("collector_number", ""), "scryfall_id": wish_row.get("scryfall_id", ""),
        "cardtrader_blueprint_id": wish_row.get("cardtrader_blueprint_id", ""),
        "language": "" if language == "any" else language, "foil": p["foil"], "condition": p["condition"].upper(),
        "price_eur": f"{price:.2f}", "market": p["market"], "cardmarket_trend_eur": trend,
        "list": wish_row.get("list", ""), "note": p.get("note", "").replace("\n", " "),
    }, None


def apply_edits(text: str, ops: list[dict], cards: pa.Table, blueprint_of: dict[str, int],
                bought: list[dict[str, str]] | None = None) -> tuple[str, list[dict]]:
    """Apply the site's waiting edits, oldest first, to the want-list CSV text. Each op is
    {"id", "op": "add" | "update" | "remove" | "bought", ...}: add carries "scryfall_id" and
    "settings", update "key" and "settings", remove "key", bought "key" and "purchase" (one copy
    off the wish, which goes at zero; the purchase row is appended to `bought`). Returns the new
    text and one result per op ({"id", "ok", "message"}); a failed op changes nothing."""
    rows = read_csv_rows(text) if text.strip() else []
    results = []
    for op in ops:
        table = wantlist_table(write_csv(rows), cards).to_pylist() if rows else []
        keys = {wish_key_of(r): r["line"] - 2 for r in table}  # site key -> index into rows
        kind = op.get("op")
        settings, problem = _clean(op.get("settings") or {})
        if problem:
            results.append({"id": op.get("id"), "ok": False, "message": problem})
            continue
        if kind == "add":
            sid = str(op.get("scryfall_id") or "")
            card = cards.filter(pc.equal(cards["scryfall_id"], sid)).slice(0, 1).to_pylist() if sid else []
            if not card:
                results.append({"id": op.get("id"), "ok": False, "message": "card not found in the card table"})
                continue
            row = {c: "" for c in WANTLIST_COLUMNS} | ADD_DEFAULTS | settings
            row |= {"name": card[0]["name"], "set_code": card[0]["set_code"], "collector_number": card[0]["collector_number"],
                    "scryfall_id": sid, "cardtrader_blueprint_id": str(blueprint_of.get(sid) or "")}
            key = wish_key_of(row)
            if key in keys:
                results.append({"id": op.get("id"), "ok": False, "message": "already on the want-list"})
                continue
            rows.append(row)
            results.append({"id": op.get("id"), "ok": True, "message": f"added {row['name']}", "key": key})
        elif kind == "bought":
            index = keys.get(str(op.get("key")))
            if index is None:
                results.append({"id": op.get("id"), "ok": False, "message": "this wish is no longer on the want-list"})
                continue
            row = {**rows[index], "scryfall_id": table[index]["scryfall_id"] or ""}
            purchase, problem = _purchase(row, op.get("purchase") or {})
            if problem:
                results.append({"id": op.get("id"), "ok": False, "message": problem})
                continue
            if bought is not None:
                bought.append(purchase)
            left = max(int(rows[index].get("quantity") or 1) - 1, 0)
            if left:
                rows[index] = rows[index] | {"quantity": str(left)}
            else:
                del rows[index]
            results.append({"id": op.get("id"), "ok": True, "message": f"bought {row.get('name')}"
                            + (f", {left} more wanted" if left else ", off the want-list")})
        elif kind in ("update", "remove"):
            index = keys.get(str(op.get("key")))
            if index is None:
                results.append({"id": op.get("id"), "ok": False, "message": "this wish is no longer on the want-list"})
                continue
            if kind == "remove":
                results.append({"id": op.get("id"), "ok": True, "message": f"removed {rows[index].get('name')}"})
                del rows[index]
                continue
            row = rows[index] | settings
            normalized = {**table[index], **{c: row.get(c, "") for c in ("language", "foil")}}
            normalized["language"] = (normalized["language"] or "any").lower()
            normalized["foil"] = (normalized["foil"] or "any").lower()
            key = wish_key_of(normalized)
            if key != op.get("key") and key in keys:
                results.append({"id": op.get("id"), "ok": False, "message": "the want-list already has that version"})
                continue
            rows[index] = row
            results.append({"id": op.get("id"), "ok": True, "message": f"changed {row.get('name')}", "key": key})
        else:
            results.append({"id": op.get("id"), "ok": False, "message": f"unknown edit {kind!r}"})
    return write_csv(rows), results


def append_purchases(text: str, rows: list[dict[str, str]]) -> str:
    """The purchases CSV with these rows added at the end."""
    old = read_csv_rows(text) if text.strip() else []
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=PURCHASE_COLUMNS, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    writer.writerows({c: r.get(c, "") for c in PURCHASE_COLUMNS} for r in old + rows)
    return out.getvalue()
