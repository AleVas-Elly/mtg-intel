"""Command line: `uv run mtg-intel grab`."""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from mtg_intel.archive import grabber
from mtg_intel.archive.notify import alert
from mtg_intel.archive.sources import SOURCES
from mtg_intel.archive.store import HfStore, LocalStore, Store, hf_retry

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
    tables.add_argument("--site", action="store_true", help="send every website document, changed or not")
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
    commands.add_parser("telegram-webhook", help="send the bot's button taps to the website (SITE_URL)")
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
    want_add.add_argument("--zero", choices=["yes", "no"], default="no", help="CardTrader Zero only")
    want_add.add_argument("--max-price", default="", help="target price in EUR")
    want_add.add_argument("--one-of", default="", help="group name: buying any one of the group fulfils the wish")
    want_add.add_argument("--note", default="")
    want_remove = want_commands.add_parser("remove", help="remove printings by Scryfall ID")
    want_remove.add_argument("ids", nargs="+")
    want_remove.add_argument("--list", help="only from this list")
    commands.add_parser("apply-edits", help="apply the want-list edits waiting on the website, then rebuild the tables")
    deal_check = commands.add_parser("check-deals", help="check CardTrader for want-list deals and alert (phase 3)")
    deal_check.add_argument("--dry-run", action="store_true", help="print deals; send and save nothing")
    suggest = commands.add_parser("suggest-targets", help="target price suggestions from 90 days of prices (D55)")
    suggest.add_argument("--send", action="store_true", help="also send the Telegram note")
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
    if args.command == "telegram-webhook":
        return telegram_webhook()
    if args.command == "suggest-targets":
        with httpx.Client(timeout=60) as client:
            return suggest_targets(client, tables_store(None), None, datetime.now(UTC), args.send)
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
    if args.command == "apply-edits":
        return apply_site_edits()
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
    if not args.dry_run:
        export_site(store, staging / "out", [w.split(" ")[0] for w in report.written], now,
                    force=getattr(args, "site", False))
    if report.problems:
        with httpx.Client() as client:
            alert(client, "mtg-intel tables need a look", "\n".join(report.problems))
        return 1
    return 0


def export_site(store, staged: Path, written: list[str], now: datetime, force: bool = False) -> None:
    """Send the website's documents for the tables this build changed (D49); skipped without SITE_URL."""
    import pyarrow.parquet as pq

    from mtg_intel import site

    def load(path: str):
        local = staged / path
        found = local if local.exists() else store.fetch(path, fresh=False)
        return pq.read_table(found) if found else None

    def purchases() -> str | None:
        from mtg_intel.tables import mycards

        found = store.fetch(PURCHASES)
        return mycards.read_text(found) if found else None

    with httpx.Client() as client:
        target = site.Site.from_env(client)
        if target is None:
            return
        try:
            days = (store.read_state().get("days") or {}).get("cardmarket") or {}
            sent = site.export_tables(target, load, written, now, force=force, latest_day=max(days, default=None),
                                      purchases=purchases)
        except httpx.HTTPError as e:
            print(f"WARNING  site not updated: {e}", file=sys.stderr)
            return
    if sent:
        print(f"   site  sent {', '.join(sent)}")


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
    status = build_tables(argparse.Namespace(local_archive=None, local_out=None, dry_run=False, site=False))
    return status or sync_tables()


def apply_site_edits() -> int:
    """Want-list edits made on the website (D50): apply them to the CSV, upload it, rebuild the tables
    (which sends the new `wants` document), then tell the site which edits are done."""
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    from mtg_intel import site
    from mtg_intel.site import Site
    from mtg_intel.tables import build, mycards

    with httpx.Client() as client:
        site_store = Site.from_env(client)
        if not site_store:
            print("SITE_URL and SITE_INGEST_TOKEN must be set", file=sys.stderr)
            return 2
        ops = (site_store.get("edits") or {}).get("ops") or []
        # A purchase from the Telegram button waits a few minutes, so its Undo still works.
        ops, held = mycards.ready_edits(ops, datetime.now(UTC))
        if held:
            print(f"{len(held)} edits held for undo")
        if not ops:
            print("no edits waiting")
            return 0
        store = tables_store(None)
        current = store.fetch(build.MY_INPUTS["wantlist"])
        text = mycards.read_text(current) if current else ""
        cards = pq.read_table(store.fetch("reference/cards.parquet", fresh=False))
        ids = pq.read_table(store.fetch("reference/card_ids.parquet", fresh=False))
        ids = ids.filter(pc.equal(ids["source"], "cardtrader")).to_pylist()
        blueprint_of: dict[str, int] = {}
        for row in ids:
            if str(row["external_id"]).isdigit():
                blueprint = int(row["external_id"])
                blueprint_of[row["scryfall_id"]] = min(blueprint_of.get(row["scryfall_id"], blueprint), blueprint)
        before = text
        old = store.fetch(PURCHASES)
        old_purchases = mycards.read_text(old) if old else ""
        rows = mycards.read_csv_rows(old_purchases) if old_purchases.strip() else []
        text, results = mycards.apply_edits(text, ops, cards, blueprint_of, purchases=rows)
        for r in results:
            print(f"{'     ok' if r['ok'] else ' FAILED'}  {r['message']}")
        purchases = mycards.append_purchases("", rows)
        changed_purchases = purchases != (mycards.append_purchases(old_purchases, []) if old_purchases.strip() else
                                          mycards.append_purchases("", []))
        status = 0
        if text != before or changed_purchases:
            out = REPO_ROOT / "data" / "my" / "wantlist.csv"
            out.parent.mkdir(parents=True, exist_ok=True)
            files = []
            if text != before:
                out.write_text(text)
                files.append((build.MY_INPUTS["wantlist"], out))
            if changed_purchases:
                out_purchases = out.parent / "purchases.csv"
                out_purchases.write_text(purchases)
                files.append((PURCHASES, out_purchases))
            store.put(files, f"want-list: {sum(r['ok'] for r in results)} edits from the site")
            if changed_purchases:
                # With the latest Cardmarket day, so a new purchase shows what it is worth now too.
                latest = max((store.read_state().get("days") or {}).get("cardmarket") or {}, default=None)
                day_path = store.fetch(f"prices/cardmarket/{latest[:4]}/{latest}.parquet", fresh=False) if latest else None
                site_store.put("purchases", site.purchases_doc(purchases, cards, datetime.now(UTC).replace(microsecond=0),
                                                               pq.read_table(day_path) if day_path else None, latest))
            if text != before:
                status = build_tables(argparse.Namespace(local_archive=None, local_out=None, dry_run=False, site=False))
        site_store.put("edits-applied", {"results": results})
        telegram_edits_done(client, ops, results)
        return status


def telegram_edits_done(client: httpx.Client, ops: list[dict], results: list[dict]) -> None:
    """Purchases made with the Telegram button: once saved, the alert loses its Undo button; one
    that could not be saved gets a reply saying why."""
    from mtg_intel.archive.notify import telegram_call

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    by_id = {r["id"]: r for r in results}
    for op in ops:
        tg, result = op.get("tg"), by_id.get(op.get("id"))
        if not token or not isinstance(tg, dict) or not result:
            continue
        markup = {"inline_keyboard": [tg["links"]] if tg.get("links") else []}
        telegram_call(client, token, "editMessageReplyMarkup",
                      {"chat_id": tg["chat"], "message_id": tg["message"], "reply_markup": markup})
        if not result["ok"]:
            telegram_call(client, token, "sendMessage", {
                "chat_id": tg["chat"], "reply_parameters": {"message_id": tg["message"]},
                "text": f"⚠️ This purchase was not saved: {result['message']}. Record it on the site instead."})


def live_deal_alerts(client: httpx.Client, token: str, state: dict, result, watch: list[dict], now: datetime,
                     rich, site_store) -> list[bool]:
    """Live deal alerts (D54): my CardTrader purchases recorded, open alerts brought up to date, and
    each new deal's copy put in my cart before it alerts (a copy CardTrader says is gone never does).
    One per alerted deal: whether it went out."""
    import copy

    from mtg_intel import deals, lifecycle
    from mtg_intel.archive.notify import alert

    tg_token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not tg_token or not chat:  # no bot: the old plain alerts
        return [alert(client, *deals.message(d)) for d in result.new[:MAX_DEAL_MESSAGES]]
    account = lifecycle.Account(client, token)
    telegram = lifecycle.Telegram(client, tg_token, chat)
    alerts: dict[str, dict] = state.setdefault("alerts", {})
    alerted: dict[str, dict] = state.setdefault("alerted", {})

    # 1. My cart, then my purchases (in this order: a copy I pay for in between shows as bought, never
    # as sold to someone else). Purchases become want-list edits; the site starts the wantlist run.
    cart = account.cart()
    book = state.setdefault("purchases", {})
    before = copy.deepcopy(book)
    since = datetime.fromisoformat(book.get("since", now.isoformat())).date() - timedelta(days=1)
    orders = account.purchases(max(since, (now - timedelta(days=lifecycle.ORDER_DAYS)).date()))
    box = account.zero_box()
    if orders is not None and box is not None:
        # Zero purchases come from the live box; a Zero order is only the week's box, merged later.
        orders = [o for o in orders if not o.get("via_cardtrader_zero")] + lifecycle.box_orders(box)
    else:
        orders = None
    bought: dict[int, float] = {}
    if orders is not None:
        edits, bought = lifecycle.purchase_edits(orders, watch, book, now)
        if edits:
            try:
                if not site_store:
                    raise httpx.HTTPError("the site is not set up")
                site_store.put("edits-add", {"ops": edits})
                print(f"purchases recorded: {len(edits)} edits")
            except httpx.HTTPError as e:  # try again next time: nothing is marked as recorded
                print(f"WARNING  purchases not recorded: {e}", file=sys.stderr)
                state["purchases"] = before
                bought = {}
    else:
        print("WARNING  CardTrader purchases not read", file=sys.stderr)

    # 2. Open alerts: still in the cart, bought, sold out, taken out, no longer a deal.
    if cart is not None:
        for line in lifecycle.refresh(alerts, result, watch, cart, bought, telegram, account, now):
            print(f"ALERT  {line}")

    # 3. New deals: into the cart first, then the alert.
    sent: list[bool] = []
    for d in result.new[:MAX_DEAL_MESSAGES]:
        open_alert = next((a for a in alerts.values() if not a.get("closed") and a["key"] == d.key), None)
        if open_alert and (open_alert["product_id"] == d.listing.id or d.listing.price >= open_alert["price"] - 0.005):
            continue  # already alerted and still live
        items = lifecycle.cart_items(cart)
        if d.listing.id in items:
            status = "there"
        else:
            status, after = account.add(d.listing.id, d.listing.zero)
            cart = after or cart
        if status == "gone":
            print(f"NOT ALERTED  {d.wish['name']} €{d.listing.price:.2f}: CardTrader says this copy is gone")
            state.setdefault("gone", {})[str(d.listing.id)] = now.isoformat()
            alerted.pop(d.key, None)  # the next real copy of this wish alerts as new
            continue
        if open_alert:
            lifecycle.finish(open_alert, lifecycle.Verdict("replaced", "⬇️ A cheaper copy was found · see the newer alert"),
                             telegram, account, now)
        out = rich(d)
        record = {"key": d.key, "name": d.wish["name"], "blueprint_id": d.wish["blueprint_id"], "product_id": d.listing.id,
                  "price": d.listing.price, "zero": d.listing.zero, "added": status == "added", "there": status == "there",
                  "head": out.head, "copy": deals.copy_line(d.listing), "tip": getattr(out, "tip", ""),
                  "details": out.details, "links": out.links,
                  "stamps": out.stamps or {}, "photo": bool(out.photo), "created": now.isoformat()}
        line = (lifecycle.cart_line(cart, now) if status in ("added", "there")
                else "⚠️ Not checked live: CardTrader's cart didn't answer")
        out.caption = lifecycle.caption(record, line)
        out.html = out.caption
        out.buttons = lifecycle.keyboard(record, done=False)
        out.silent = not lifecycle.rings(d, now)
        ok = alert(client, *deals.message(d), telegram=out)
        sent.append(ok)
        if ok and out.message_id:
            alerts[str(out.message_id)] = record | {"message_id": out.message_id, "line": line}
            if out.stamps and site_store:  # for Skip in the timer Worker: the picture to swap in
                try:
                    site_store.put(f"tgimg/{chat}/{out.message_id}", out.stamps)
                except httpx.HTTPError as e:
                    print(f"WARNING  done pictures not linked: {e}", file=sys.stderr)
        elif status == "added":  # not alerted: don't leave it in my cart
            account.remove(d.listing.id)
    lifecycle.prune(alerts, now)
    return sent


TARGETS_WEEKDAY, TARGETS_HOUR = 6, 10  # the target note: Sundays, with the first check from 10:00 (Amsterdam)


def suggest_targets(client: httpx.Client, store, watch: list[dict] | None, now: datetime, send: bool) -> int:
    """Target suggestions for every wish (D55): sent to the site, and as the weekly Telegram note."""
    import pyarrow.parquet as pq

    from mtg_intel import targets
    from mtg_intel.archive.notify import telegram_call
    from mtg_intel.site import Site

    if watch is None:
        watch = pq.read_table(store.fetch("my/watch.parquet")).to_pylist()
    ids = sorted({w["scryfall_id"] for w in watch if w.get("scryfall_id")})
    path = store.fetch("my/price_history.parquet", fresh=False)
    price_rows: dict[str, list[dict]] = {}
    for r in pq.read_table(path, filters=[("scryfall_id", "in", ids)]).to_pylist() if path and ids else []:
        price_rows.setdefault(r["scryfall_id"], []).append(r)
    check_rows: dict[int, list[dict]] = {}
    found = False
    for days_back in range(1, 91):
        daily = store.fetch(daily_checks_path((now - timedelta(days=days_back)).date()), fresh=False)
        if daily is None:
            if found:
                break
            continue
        found = True
        for r in pq.read_table(daily).to_pylist():
            check_rows.setdefault(r["blueprint_id"], []).append(r)
    found_targets = targets.all_suggestions(watch, price_rows, check_rows)
    print(f"target suggestions: {len(found_targets)}")
    for t in found_targets[:10]:
        print(f"  {t.name} {t.where}: €{t.target:.2f} ({t.reached}/{t.days} days, usually €{t.usual:.2f}) · {t.reason}")
    site_store = Site.from_env(client)
    if site_store:
        site_store.put("targets", targets.site_doc(found_targets, now.isoformat()))
    note = targets.weekly_note(found_targets, os.environ.get("SITE_URL"))
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if send and note and token and chat:
        sent = telegram_call(client, token, "sendMessage", {
            "chat_id": chat, "text": note[0], "parse_mode": "HTML", "disable_notification": True,
            "link_preview_options": {"is_disabled": True}, "reply_markup": {"inline_keyboard": note[1]}})
        print(f"target note sent: {sent is not None}")
    return 0


PURCHASES = "my/inputs/purchases.csv"  # cards bought, recorded on the site (3c); phase 4's collection starts here
MAX_DEAL_MESSAGES = 10  # one message per deal up to this many, then one summary
SKIP_AFTER = timedelta(minutes=4)  # a scheduled (fallback) run this soon after a check is redundant
SLOW_CHECK = timedelta(minutes=4)  # checks start every 5 minutes (D48, D55)
CARDTRADER_BUDGET = timedelta(minutes=3, seconds=30)  # past this, a check stops asking and saves what it has
# CardTrader allows 10 marketplace requests a second (API reference, checked 2026-11-06): half of
# that keeps a full check of ~210 cards near 45 seconds instead of 3.5 minutes.
CHECK_INTERVAL = 0.2
GONE_KEEP = timedelta(days=14)  # a copy the cart said is gone is ignored this long
CARDTRADER_TIMEOUT = 20  # seconds per CardTrader request (each is retried twice)


def check_deals(args: argparse.Namespace) -> int:
    """One deal check (phase 3): every wished card on CardTrader, alerts for new deals, and the
    check summary and alert memory saved to the tables dataset."""
    import json

    import pyarrow as pa
    import pyarrow.parquet as pq

    from mtg_intel import dealimage, deals, site
    from mtg_intel.archive.cardtrader import Session
    from mtg_intel.archive.sources import InvalidDownload
    from mtg_intel.site import Site

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
    # The first check of a day also rebuilds the site's CardTrader history from a month of daily files.
    to_site = not args.dry_run and bool(os.environ.get("SITE_URL"))
    packing = store.fetch(daily_checks_path((now - timedelta(days=1)).date())) is None
    if to_site and not packing:  # the site has no CardTrader history yet (first run, or lost)
        with httpx.Client() as client:
            target = Site.from_env(client)
            try:
                packing = target is not None and target.get("ct-history") is None
            except httpx.HTTPError:
                pass
    site_history: dict[int, list[dict]] = {}
    for days_back in range(1, (site.HISTORY_DAYS if packing and to_site else deals.USUAL_DAYS) + 1):
        day = (now - timedelta(days=days_back)).date()
        daily = store.fetch(daily_checks_path(day))
        if daily is None and days_back == 1:
            daily = pack_day(store, day, work)
            if daily:
                files.append((daily_checks_path(day), daily))
        for row in pq.read_table(daily).to_pylist() if daily else []:
            site_history.setdefault(row["blueprint_id"], []).append(row)
            if days_back <= deals.USUAL_DAYS:
                history.setdefault(row["blueprint_id"], []).append(row)

    with httpx.Client(timeout=CARDTRADER_TIMEOUT) as client:
        site_store = Site.from_env(client) if to_site else None
        session = Session(client, token, out=None, interval=CHECK_INTERVAL)
        started = time.monotonic()
        gone = state.setdefault("gone", {})  # copies CardTrader's cart said are gone (D54)
        for pid in [p for p, at in gone.items() if now - datetime.fromisoformat(at) > GONE_KEEP]:
            del gone[pid]
        result = deals.check(session, watch, alerted, now, history,
                             out_of_time=lambda: time.monotonic() - started > CARDTRADER_BUDGET.total_seconds(),
                             ignore={int(p) for p in gone})
        targets = deals.cardmarket_targets(watch, alerted, now)
        site_url, site_token = os.environ.get("SITE_URL"), os.environ.get("SITE_INGEST_TOKEN")

        def preview(d: deals.Deal) -> str | None:
            if not site_url or not site_token:
                return None
            printing, copy = deals.version_line(d)
            return site.preview_url(site_url, site_token, d.key, d.wish.get("image_url"), printing or d.wish["name"],
                                    copy, now, d.wish.get("set_name") or "mtg-intel")

        history_rows: dict[str, list[dict]] = {}
        if result.new:  # the price trend shown in each alert's details
            try:
                path = store.fetch("my/price_history.parquet", fresh=False)
                ids = sorted({d.wish["scryfall_id"] for d in result.new if d.wish.get("scryfall_id")})
                if path and ids:
                    for r in pq.read_table(path, filters=[("scryfall_id", "in", ids)]).to_pylist():
                        history_rows.setdefault(r["scryfall_id"], []).append(r)
            except Exception as e:  # noqa: BLE001 - the alert goes without a trend rather than not at all
                print(f"WARNING  price history not read: {e}", file=sys.stderr)

        # CardTrader's own trend: the cheapest fitting copy per day from the packed daily check files
        # (kept since 2026-10-20), up to 90 days back, plus this check.
        ct_rows: dict[int, list[dict]] = {}
        if result.new:
            wanted = {d.wish["blueprint_id"] for d in result.new}
            found = False
            for days_back in range(1, deals.TREND_DAYS + 1):
                daily = store.fetch(daily_checks_path((now - timedelta(days=days_back)).date()), fresh=False)
                if daily is None:
                    if found:
                        break  # the files are contiguous: an earlier gap is where they start
                    continue
                found = True
                for row in pq.read_table(daily, filters=[("blueprint_id", "in", sorted(wanted))]).to_pylist():
                    ct_rows.setdefault(row["blueprint_id"], []).append(row)
            for row in result.summary:
                if row["blueprint_id"] in wanted:
                    ct_rows.setdefault(row["blueprint_id"], []).append(row)

        def rich(d: deals.Deal):
            # The deal's image (D53) is drawn only for alerts that go out on their own.
            image = None if args.dry_run else dealimage.deal_image(client, d)
            done = None
            if image and site_store:  # its done versions, swapped in when I buy it or it is gone
                try:
                    done = {kind: site_store.put_image(secrets.token_urlsafe(16), jpeg)
                            for kind, jpeg in dealimage.stamps(image, f"€{d.listing.price:.2f}").items()}
                except httpx.HTTPError as e:
                    print(f"WARNING  done images not stored: {e}", file=sys.stderr)
            foil = d.listing.foil or (bool(d.wish.get("finishes")) and "nonfoil" not in d.wish["finishes"])
            cm = deals.trend_points(history_rows.get(d.wish.get("scryfall_id") or "", []), foil)
            ct = deals.cardtrader_points(ct_rows.get(d.wish["blueprint_id"], []), d.wish)
            trends = [deals.price_trend(cm, d.cardmarket, "📈 Cardmarket trend"),
                      deals.price_trend(ct, None, "📉 CardTrader, cheapest copy", min_days=5)]
            out = deals.telegram(d, site_url, preview(d), image, trends)
            out.stamps = done
            out.tip = deals.buy_tip(d.listing.price, cm, ct)
            return out

        messages = [(title, text, None) for title, text in targets]  # Cardmarket target prices: plain alerts
        problems = []
        try:
            session.summary()
        except InvalidDownload as e:
            problems.append(f"CardTrader: {e} (HTTP {session.last_status})")
        if result.late_blueprints:
            problems.append(f"CardTrader is slow: {len(result.late_blueprints)} cards not checked within "
                            f"{CARDTRADER_BUDGET.seconds // 60} minutes")
        for problem in problems:
            print(f"PROBLEM  {problem}", file=sys.stderr)
        problem = deals.problem_alert(state, problems, now)
        if problem and not args.dry_run:
            alert(client, *problem)
        for d in result.deals:
            title, _ = deals.message(d)
            print(f"{'NEW ' if d in result.new else '    '}{title}  ({'; '.join(d.reasons)})")
        print(f"{len({w['blueprint_id'] for w in watch})} cards checked, {len(result.summary)} listing groups, "
              f"{len(result.deals)} deals, {len(result.new) + len(messages)} to alert, {len(result.failed_blueprints)} failed")
        if args.dry_run:
            return 0
        sent = live_deal_alerts(client, token, state, result, watch, now, rich, site_store)
        sent += [alert(client, title, text) for title, text, _ in messages]
        if sent:
            print(f"alerts sent: {sum(sent)} of {len(sent)}")
        deals.record_check(state, now, len(result.failed_blueprints), sum(sent))
        note = deals.digest(state, result, watch, now, os.environ.get("SITE_URL"))
        if note:
            print(f"daily digest sent: {alert(client, *note)}")
        local = now.astimezone(ZoneInfo("Europe/Amsterdam"))
        if local.weekday() == TARGETS_WEEKDAY and local.hour >= TARGETS_HOUR and state.get("targets_on") != local.date().isoformat():
            state["targets_on"] = local.date().isoformat()
            try:
                suggest_targets(client, store, watch, now, send=True)
            except Exception as e:  # noqa: BLE001 - never stops the check
                print(f"WARNING  target suggestions failed: {e}", file=sys.stderr)
        if site_store:
            try:  # the website's copy (D49); a failure here never stops the alerts or the saved check
                from mtg_intel import lifecycle

                live = site.live_doc(result, watch, now, site_store.get("live"))
                live["fast"] = lifecycle.fast_lane(result, watch, state.get("gone", {}))  # the timer's minute checks
                site_store.put("live", live)
                if now.minute % 10 < 5:  # every other check: the 48-hour chart keeps 10-minute steps,
                    # and the site's free 1,000 writes a day stay well away
                    site_store.put("ct-recent", site.ct_recent_doc(site_store.get("ct-recent"), result, now))
                if packing:
                    site_store.put("ct-history", site.ct_history_doc(watch, site_history))
                print("site updated")
            except httpx.HTTPError as e:
                print(f"WARNING  site not updated: {e}", file=sys.stderr)

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
    folder = hf_retry(lambda: snapshot_download(
        store.repo_id, repo_type="dataset", token=store.token, local_dir=work / "pack",
        allow_patterns=[f"checks/{day:%Y/%m/%d}/*.parquet", f"checks/{day:%Y/%m}/{day.isoformat()}.parquet"],
    ))
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
        reply = client.get(f"{TELEGRAM_API}/bot{token}/getUpdates").json()
        if reply.get("error_code") == 409:
            print("the bot sends its updates to the website (telegram-webhook): TELEGRAM_CHAT_ID is already set up")
            return 1
        updates = reply.get("result", [])
        chats = [u["message"]["chat"]["id"] for u in updates if "message" in u]
        if not chats:
            print("no messages yet: send any message to your bot in Telegram, then run this again")
            return 1
        chat_id = str(chats[-1])
        sent = send_telegram(client, token, chat_id, "mtg-intel: alerts will arrive here.")
    print(f"chat id: {chat_id} | test message sent: {sent}")
    return 0 if sent else 1


def telegram_webhook() -> int:
    """Point the bot's updates (button taps) at the website Worker, which checks Telegram's secret
    header: the SHA-256 of "mtg-intel-webhook:" + the bot token, so no extra secret is needed."""
    import hashlib

    from mtg_intel.archive.notify import telegram_call

    token, site_url = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("SITE_URL")
    if not token or not site_url:
        print("TELEGRAM_BOT_TOKEN and SITE_URL must be set", file=sys.stderr)
        return 2
    secret = hashlib.sha256(f"mtg-intel-webhook:{token}".encode()).hexdigest()
    with httpx.Client() as client:
        done = telegram_call(client, token, "setWebhook", {
            "url": f"{site_url.rstrip('/')}/api/telegram", "secret_token": secret,
            "allowed_updates": ["callback_query", "message"], "drop_pending_updates": True})
        info = telegram_call(client, token, "getWebhookInfo", {}) or {}
    print(f"webhook set: {done is not None} | url: {info.get('url')} | last error: {info.get('last_error_message')}")
    return 0 if done is not None else 1


if __name__ == "__main__":
    sys.exit(main())
