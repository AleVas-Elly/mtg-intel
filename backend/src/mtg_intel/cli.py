"""Command line: `uv run mtg-intel grab`."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from mtg_intel.archive import grabber
from mtg_intel.archive.notify import alert
from mtg_intel.archive.sources import SOURCES
from mtg_intel.archive.store import HfStore, LocalStore, Store

REPO_ROOT = Path(__file__).resolve().parents[3]


def load_env_file(path: Path) -> None:
    """Read KEY=value lines into the environment without overriding what is already set."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if value.strip():
            os.environ.setdefault(key.strip(), value.strip())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mtg-intel")
    commands = parser.add_subparsers(dest="command", required=True)
    grab = commands.add_parser("grab", help="download sources and publish what changed")
    grab.add_argument("--local", type=Path, help="publish to this folder instead of Hugging Face")
    grab.add_argument("--dry-run", action="store_true", help="download and compare, publish nothing")
    grab.add_argument("--only", nargs="+", help="source names to grab (default: all)")
    tables = commands.add_parser("build-tables", help="build the phase 2 tables from the archive")
    tables.add_argument("--local-archive", type=Path, help="read raw files from this folder")
    tables.add_argument("--local-out", type=Path, help="write tables to this folder instead of Hugging Face")
    tables.add_argument("--dry-run", action="store_true", help="build, publish nothing")
    mine = commands.add_parser("my-cards", help="upload my collection / want-list CSV for the next table build")
    mine.add_argument("--collection", type=Path, help="ManaBox CSV export")
    mine.add_argument("--wantlist", type=Path, help="want-list CSV (see backend/templates/wantlist.csv)")
    mine.add_argument("--local-out", type=Path, help="tables folder instead of Hugging Face")
    wishlists = commands.add_parser(
        "import-wishlists", help="turn CardTrader wishlists into a want-list CSV (no list given: show the lists)"
    )
    wishlists.add_argument("ids", nargs="*", type=int, help="wishlist IDs to import")
    wishlists.add_argument("--out", type=Path, default=REPO_ROOT / "data" / "my" / "wantlist.csv")
    commands.add_parser("sync-tables", help="download the tables to data/tables for querying")
    commands.add_parser("telegram-setup", help="find my chat with the bot and send a test message")
    test_alert = commands.add_parser("alert", help="send an alert through the configured channel")
    test_alert.add_argument("title")
    test_alert.add_argument("message")
    query = commands.add_parser("query", help="run SQL against the tables (after sync-tables)")
    query.add_argument("sql")
    price = commands.add_parser("price", help="Cardmarket price history of a card (after sync-tables)")
    price.add_argument("name")
    price.add_argument("--set", dest="set_code")
    price.add_argument("--last", type=int, default=10, help="days to show per printing")
    find = commands.add_parser("search", help="Scryfall search over my cards or all cards (after sync-tables)")
    find.add_argument("query", help="Scryfall search syntax, e.g. 'art:cat t:creature'")
    find.add_argument("--in", dest="scope", choices=["mine", "wantlist", "collection", "all"], default="mine")
    find.add_argument("--prints", action="store_true", help="every printing, not one per card (scope all)")
    find.add_argument("--limit", type=int, default=60, help="rows to show")
    find.add_argument("--json", action="store_true", help="print JSON rows")
    want = commands.add_parser("want", help="add or remove want-list cards, then rebuild the tables")
    want_commands = want.add_subparsers(dest="want_command", required=True)
    want_add = want_commands.add_parser("add", help="add printings by Scryfall ID")
    want_add.add_argument("ids", nargs="+")
    want_add.add_argument("--list", default="", help="list name, e.g. Showcase")
    want_add.add_argument("--lang", default="en", help="en, ja, it, … or any")
    want_add.add_argument("--foil", choices=["yes", "no", "any"], default="any")
    want_add.add_argument("--cond", choices=["NM", "SP", "MP", "PL", "PO"], default="NM", help="worst condition I accept")
    want_add.add_argument("--zero", choices=["yes", "no"], default="yes", help="CardTrader Zero only")
    want_add.add_argument("--max-price", default="", help="target price in EUR")
    want_add.add_argument("--one-of", default="", help="group name: buying any one of the group fulfils the wish")
    want_add.add_argument("--note", default="")
    want_remove = want_commands.add_parser("remove", help="remove printings by Scryfall ID")
    want_remove.add_argument("ids", nargs="+")
    want_remove.add_argument("--list", help="only from this list")
    deal_check = commands.add_parser("check-deals", help="check CardTrader for want-list deals and alert (phase 3)")
    deal_check.add_argument("--dry-run", action="store_true", help="print deals; send and save nothing")
    args = parser.parse_args(argv)

    load_env_file(REPO_ROOT / ".env")
    if args.command == "build-tables":
        return build_tables(args)
    if args.command == "my-cards":
        return push_my_cards(args)
    if args.command == "import-wishlists":
        return import_wishlists(args)
    if args.command == "sync-tables":
        return sync_tables()
    if args.command == "telegram-setup":
        return telegram_setup()
    if args.command == "alert":
        with httpx.Client() as client:
            sent = alert(client, args.title, args.message)
        print("sent" if sent else "not sent: no alert channel configured or it failed")
        return 0 if sent else 1
    if args.command in ("query", "price"):
        return run_query(args)
    if args.command == "search":
        return run_search(args)
    if args.command == "want":
        return edit_wantlist(args)
    if args.command == "check-deals":
        return check_deals(args)
    store: Store
    if args.local:
        store = LocalStore(args.local)
    else:
        token, dataset = os.environ.get("HF_TOKEN"), os.environ.get("HF_DATASET")
        if not token or not dataset:
            print("HF_TOKEN and HF_DATASET must be set (in .env or the environment)", file=sys.stderr)
            return 2
        store = HfStore(dataset, token)

    sources = [s for s in SOURCES if not args.only or s.name in args.only]
    staging = Path(os.environ.get("MTG_INTEL_STAGING", REPO_ROOT / "data" / "staging"))
    now = datetime.now(UTC).replace(second=0, microsecond=0)

    context = {
        key: os.environ[env]
        for key, env in [("commit", "GITHUB_SHA"), ("trigger", "GITHUB_EVENT_NAME"), ("run_id", "GITHUB_RUN_ID")]
        if os.environ.get(env)
    }
    run_url = (
        f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
        if os.environ.get("GITHUB_REPOSITORY") and os.environ.get("GITHUB_RUN_ID")
        else ""
    )

    with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(60, read=300)) as client:
        try:
            report = grabber.run(
                sources, store, client, staging, now, publish=not args.dry_run, context=context
            )
        except Exception as e:
            alert(client, "mtg-intel grab crashed", f"{type(e).__name__}: {e}\n{run_url}".strip())
            raise

        for r in report.results:
            print(f"{r.status:>9}  {r.source}  {r.detail}".rstrip())

        if report.problems:
            lines = [f"{r.source}: {r.status}, {r.detail}" for r in report.problems]
            alert(client, "mtg-intel grab needs a look", "\n".join(lines + [run_url]).strip())
            return 1
    return 0


def build_tables(args: argparse.Namespace) -> int:
    from mtg_intel.tables import build

    token = os.environ.get("HF_TOKEN", "")
    raw: build.RawArchive
    if args.local_archive:
        raw = build.LocalRaw(args.local_archive)
    else:
        raw = build.HfRaw(os.environ["HF_DATASET"], token, REPO_ROOT / "data" / "archive")
    store: build.TableStore = (
        build.LocalTables(args.local_out) if args.local_out else build.HfTables(build.tables_dataset_from_env(), token)
    )
    staging = Path(os.environ.get("MTG_INTEL_TABLES_STAGING", REPO_ROOT / "data" / "tables-staging"))
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    report = build.build(raw, store, staging, now, publish=not args.dry_run)

    for line in report.written:
        print(f"  wrote  {line}")
    for line in report.notes:
        print(f"   note  {line}")
    for line in report.problems:
        print(f"PROBLEM  {line}")
    if report.problems:
        with httpx.Client() as client:
            alert(client, "mtg-intel tables need a look", "\n".join(report.problems))
        return 1
    return 0


def tables_store(local_out: Path | None):
    from mtg_intel.tables import build

    if local_out:
        return build.LocalTables(local_out)
    return build.HfTables(build.tables_dataset_from_env(), os.environ["HF_TOKEN"])


def push_my_cards(args: argparse.Namespace) -> int:
    from mtg_intel.tables.build import MY_INPUTS

    files = [(MY_INPUTS[name], path) for name, path in [("collection", args.collection), ("wantlist", args.wantlist)] if path]
    if not files:
        print("nothing to upload: pass --collection and/or --wantlist", file=sys.stderr)
        return 2
    tables_store(args.local_out).put(files, "my cards: " + ", ".join(p for p, _ in files))
    print("uploaded " + ", ".join(f"{local} -> {p}" for p, local in files) + "; tables update on the next build")
    return 0


TABLES_DIR = REPO_ROOT / "data" / "tables"


def import_wishlists(args: argparse.Namespace) -> int:
    """List my CardTrader wishlists, or write the chosen ones as a want-list CSV to upload with my-cards."""
    import csv

    import duckdb

    from mtg_intel.archive.cardtrader import Session
    from mtg_intel.tables import mycards, wishlists

    token = os.environ.get("CARDTRADER_TOKEN")
    if not token:
        print("CARDTRADER_TOKEN is not set (add it to .env)", file=sys.stderr)
        return 2
    with httpx.Client(timeout=60) as client:
        session = Session(client, token, out=None)
        headers = [w for w in wishlists.list_wishlists(session) if w.get("game_id") == 1]
        if not args.ids:
            for w in headers:
                print(f"{w['id']:>9}  {w['name']}  (updated {w['updated_at'][:10]})")
            print("pass the IDs to import, e.g. import-wishlists 2398152 3262115")
            return 0
        unknown = set(args.ids) - {w["id"] for w in headers}
        if unknown:
            print(f"not my Magic wishlists: {sorted(unknown)}", file=sys.stderr)
            return 2
        chosen = wishlists.fetch_wishlists(session, args.ids)
        codes, blueprints = wishlists.fetch_blueprints(session, chosen)

    cards = TABLES_DIR / "reference" / "cards.parquet"
    if not cards.exists():
        print("no card reference: run sync-tables first", file=sys.stderr)
        return 2
    printings = duckdb.sql(f"select scryfall_id, name, set_code, collector_number from '{cards}'").fetchall()
    card_names = {wishlists.slug(name): name for _, name, _, _ in printings}
    by_id = {sid: (set_code, number) for sid, _, set_code, number in printings}
    rows = wishlists.wantlist_rows(chosen, codes, blueprints, card_names, by_id)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=mycards.WANTLIST_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    items = sum(len(w.items) for w in chosen)
    unresolved = sum(1 for r in rows if r["note"].endswith("not found"))
    print(f"{items} items from {len(chosen)} lists -> {len(rows)} want-list rows in {args.out}"
          + (f" ({unresolved} not found on CardTrader, kept by name)" if unresolved else ""))
    return 0


def sync_tables() -> int:
    from huggingface_hub import snapshot_download

    from mtg_intel.tables.build import tables_dataset_from_env

    snapshot_download(
        tables_dataset_from_env(), repo_type="dataset", token=os.environ["HF_TOKEN"], local_dir=TABLES_DIR,
        allow_patterns=["reference/*", "prices/**", "my/*.parquet"],
    )
    print(f"tables in {TABLES_DIR}")
    return 0


def run_query(args: argparse.Namespace) -> int:
    from mtg_intel.tables import query

    con = query.connect(TABLES_DIR)
    if args.command == "query":
        con.sql(args.sql).show(max_width=200)
        return 0
    rows = query.price_history(con, args.name, args.set_code).fetchall()
    if not rows:
        print("no prices found (did you run sync-tables? is the name exact?)")
        return 1
    by_printing: dict[tuple, list] = {}
    for r in rows:
        by_printing.setdefault((r[2], r[3], tuple(r[4] or [])), []).append(r)
    for (set_code, number, tags), series in by_printing.items():
        label = f"{series[0][1]} ({set_code} #{number})" + (f" [{', '.join(tags)}]" if tags else "")
        print(label)
        print("  date        trend    avg    low | foil trend    avg    low")
        for r in series[-args.last:]:
            cells = [f"{v:>6.2f}" if v is not None else "     -" for v in r[5:]]
            print(f"  {r[0]}  {cells[0]} {cells[1]} {cells[2]} |      {cells[3]} {cells[4]} {cells[5]}")
    return 0


def run_search(args: argparse.Namespace) -> int:
    import json

    from mtg_intel import search
    from mtg_intel.tables import query

    con = query.connect(TABLES_DIR)
    if "cards" not in query.views(con):
        print("no tables yet: run sync-tables first", file=sys.stderr)
        return 2
    with httpx.Client(timeout=60) as client:
        try:
            ids, found = search.search(search.Scryfall(client), con, args.query, args.scope,
                                       "prints" if args.prints else None)
        except search.SearchError as e:
            print(f"Scryfall: {e}", file=sys.stderr)
            return 2
    rows = search.describe(con, ids).to_pylist()
    shown = rows[: args.limit]
    if args.json:
        print(json.dumps({"query": args.query, "scope": args.scope, "total": len(rows), "truncated": found.truncated,
                          "warnings": found.warnings, "cards": shown}, default=str, ensure_ascii=False))
        return 0
    for w in found.warnings:
        print(f"Scryfall warning: {w}")
    for r in shown:
        price = " / ".join(f"{label} {v:.2f}" for label, v in [("€", r["trend"]), ("foil €", r["trend_foil"])] if v)
        mine = "; ".join(x for x in [f"wanted: {r['wanted_in']}" if r["wanted_in"] else "",
                                     f"owned: {r['owned']}" if r["owned"] else ""] if x)
        tags = f" [{', '.join(r['special_tags'])}]" if r["special_tags"] else ""
        print(f"{r['name']} ({r['set_code'].upper()} #{r['collector_number']}){tags}  {price or 'no price'}"
              + (f"  | {mine}" if mine else "") + f"  | {r['scryfall_id']}")
    more = f", showing {len(shown)}" if len(rows) > len(shown) else ""
    print(f"{len(rows)} cards{more}" + (" (stopped early: too many results, narrow the search)" if found.truncated else ""))
    return 0


def edit_wantlist(args: argparse.Namespace) -> int:
    from mtg_intel.tables import build, mycards, query

    store = tables_store(None)
    current = store.fetch(build.MY_INPUTS["wantlist"])
    text = mycards.read_text(current) if current else ""
    if args.want_command == "add":
        con = query.connect(TABLES_DIR)
        found = con.execute(
            """select c.scryfall_id, c.name, min(try_cast(i.external_id as bigint)) as blueprint
               from cards c left join card_ids i on i.scryfall_id = c.scryfall_id and i.source = 'cardtrader'
               where c.scryfall_id in (select unnest(?)) group by all""",
            [args.ids],
        ).fetchall()
        unknown = set(args.ids) - {r[0] for r in found}
        if unknown:
            print(f"not in the card table: {sorted(unknown)}", file=sys.stderr)
            return 2
        wishes = [
            {"name": name, "scryfall_id": sid, "language": args.lang, "foil": args.foil, "min_condition": args.cond,
             "via_zero": args.zero, "max_price_eur": args.max_price, "quantity": "1", "list": args.list,
             "cardtrader_blueprint_id": str(blueprint or ""), "one_of": args.one_of, "note": args.note}
            for sid, name, blueprint in found
        ]
        text, added, skipped = mycards.add_wishes(text, wishes)
        message = f"want-list: add {len(added)}"
        for r in added:
            print(f"   added  {r['name']}  ({r['scryfall_id']})")
        for r in skipped:
            print(f" already  {r['name']}  ({r['scryfall_id']})")
        if not added:
            return 0
    else:
        text, changed = mycards.remove_wishes(text, set(args.ids), args.list)
        message = f"want-list: remove {len(changed)}"
        for r in changed:
            print(f" removed  {r['name']}  ({r['scryfall_id']})" + (f" from {args.list}" if args.list else ""))
        if not changed:
            print("nothing to remove")
            return 0
    out = REPO_ROOT / "data" / "my" / "wantlist.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    store.put([(build.MY_INPUTS["wantlist"], out)], message)
    # Rebuild now so the want-list table (and anything reading it) is current right away.
    status = build_tables(argparse.Namespace(local_archive=None, local_out=None, dry_run=False))
    return status or sync_tables()


MAX_DEAL_MESSAGES = 10  # one message per deal up to this many, then one summary
SKIP_AFTER = timedelta(minutes=8)  # a scheduled (fallback) run this soon after a check is redundant
SLOW_CHECK = timedelta(minutes=8)  # checks start every 10 minutes (D48)


def check_deals(args: argparse.Namespace) -> int:
    """One deal check (phase 3): every wished card on CardTrader, alerts for new deals, and the
    check summary and alert memory saved to the tables dataset."""
    import json

    import pyarrow as pa
    import pyarrow.parquet as pq

    from mtg_intel import deals
    from mtg_intel.archive.cardtrader import Session
    from mtg_intel.archive.sources import InvalidDownload

    token = os.environ.get("CARDTRADER_TOKEN")
    if not token:
        print("CARDTRADER_TOKEN is not set", file=sys.stderr)
        return 2
    store = tables_store(None)
    watch_file = store.fetch("my/watch.parquet")
    if not watch_file:
        print("no watch table yet: upload a want-list and run build-tables", file=sys.stderr)
        return 2
    watch = pq.read_table(watch_file).to_pylist()
    state_file = store.fetch(DEALS_STATE)
    state = json.loads(state_file.read_text()) if state_file else {}
    alerted = state.setdefault("alerted", {})
    now = datetime.now(UTC).replace(microsecond=0)
    last = state.get("last_check")
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule" and last and now - datetime.fromisoformat(last) < SKIP_AFTER:
        # GitHub's own (late) schedule is only the fallback for the on-time timer (D48).
        print(f"skipped: the timer already checked at {last}")
        return 0
    # Earlier checks, for the usual CardTrader price of each wish (D47): the daily files of the
    # last week. Yesterday's is packed from its per-check files by the first check of the day.
    work = REPO_ROOT / "data" / "deals-staging"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    files: list[tuple[str, Path]] = []
    history: dict[int, list[dict]] = {}
    for days_back in range(1, deals.USUAL_DAYS + 1):
        day = (now - timedelta(days=days_back)).date()
        daily = store.fetch(daily_checks_path(day))
        if daily is None and days_back == 1:
            daily = pack_day(store, day, work)
            if daily:
                files.append((daily_checks_path(day), daily))
        for row in pq.read_table(daily).to_pylist() if daily else []:
            history.setdefault(row["blueprint_id"], []).append(row)

    with httpx.Client(timeout=60) as client:
        session = Session(client, token, out=None)
        result = deals.check(session, watch, alerted, now, history)
        targets = deals.cardmarket_targets(watch, alerted, now)
        messages = [deals.message(d) for d in result.new] + targets
        try:
            session.summary()
        except InvalidDownload as e:
            if not args.dry_run:
                alert(client, "mtg-intel deal check needs a look", f"CardTrader: {e}")
            print(f"PROBLEM  CardTrader: {e}", file=sys.stderr)
        for d in result.deals:
            title, _ = deals.message(d)
            print(f"{'NEW ' if d in result.new else '    '}{title}  ({'; '.join(d.reasons)})")
        print(f"{len({w['blueprint_id'] for w in watch})} cards checked, {len(result.summary)} listing groups, "
              f"{len(result.deals)} deals, {len(messages)} to alert, {len(result.failed_blueprints)} failed")
        if args.dry_run:
            return 0
        sent = [alert(client, title, text) for title, text in messages[:MAX_DEAL_MESSAGES]]
        if len(messages) > MAX_DEAL_MESSAGES:
            rest = [title for title, _ in messages[MAX_DEAL_MESSAGES:]]
            sent.append(alert(client, f"{len(rest)} more deals", "\n".join(rest)))
        if sent:
            print(f"alerts sent: {sum(sent)} of {len(sent)}")

    took = datetime.now(UTC) - now
    if took > SLOW_CHECK:
        print(f"WARNING  the check took {took.seconds // 60} min: the want-list is outgrowing the 10-minute rhythm")
    state["last_check"] = now.isoformat()
    (work / "state.json").write_text(json.dumps(state, indent=1))
    files.append((DEALS_STATE, work / "state.json"))
    if result.summary:
        # One small file per check: nothing is rewritten, so the dataset's history stays small.
        pq.write_table(pa.Table.from_pylist(result.summary), work / "check.parquet", compression="zstd")
        files.append((f"checks/{now:%Y/%m/%d}/{now:%H%M%S}Z.parquet", work / "check.parquet"))
    store.put(files, f"deal check {now:%Y-%m-%d %H:%MZ}: {len(result.deals)} deals, {len(result.new)} new")
    return 0


def daily_checks_path(day) -> str:
    return f"checks/daily/{day:%Y}/{day.isoformat()}.parquet"


def pack_day(store, day, work: Path) -> Path | None:
    """All of one day's per-check files (and the older one-file-per-day format) in one file."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    from huggingface_hub import snapshot_download

    if not hasattr(store, "repo_id"):
        return None
    folder = snapshot_download(
        store.repo_id, repo_type="dataset", token=store.token, local_dir=work / "pack",
        allow_patterns=[f"checks/{day:%Y/%m/%d}/*.parquet", f"checks/{day:%Y/%m}/{day.isoformat()}.parquet"],
    )
    parts = sorted(Path(folder).glob("checks/**/*.parquet"))
    if not parts:
        return None
    out = work / f"daily-{day.isoformat()}.parquet"
    tables = [pq.read_table(p) for p in parts]
    pq.write_table(pa.concat_tables(tables, promote_options="default"), out, compression="zstd")
    print(f"packed {len(parts)} check files of {day} into {daily_checks_path(day)}")
    return out


DEALS_STATE = "deals/state.json"


def telegram_setup() -> int:
    """Read the bot's latest message to learn my chat ID, then send a test alert there."""
    from mtg_intel.archive.notify import TELEGRAM_API, send_telegram

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        print("TELEGRAM_BOT_TOKEN is not set (add it to .env)", file=sys.stderr)
        return 2
    with httpx.Client(timeout=20) as client:
        updates = client.get(f"{TELEGRAM_API}/bot{token}/getUpdates").json().get("result", [])
        chats = [u["message"]["chat"]["id"] for u in updates if "message" in u]
        if not chats:
            print("no messages yet: send any message to your bot in Telegram, then run this again")
            return 1
        chat_id = str(chats[-1])
        sent = send_telegram(client, token, chat_id, "mtg-intel: alerts will arrive here.")
    print(f"chat id: {chat_id} | test message sent: {sent}")
    return 0 if sent else 1


if __name__ == "__main__":
    sys.exit(main())
