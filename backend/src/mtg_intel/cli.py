"""Command line: `uv run mtg-intel grab`."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import UTC, datetime
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
    commands.add_parser("sync-tables", help="download the tables to data/tables for querying")
    commands.add_parser("telegram-setup", help="find my chat with the bot and send a test message")
    query = commands.add_parser("query", help="run SQL against the tables (after sync-tables)")
    query.add_argument("sql")
    price = commands.add_parser("price", help="Cardmarket price history of a card (after sync-tables)")
    price.add_argument("name")
    price.add_argument("--set", dest="set_code")
    price.add_argument("--last", type=int, default=10, help="days to show per printing")
    args = parser.parse_args(argv)

    load_env_file(REPO_ROOT / ".env")
    if args.command == "build-tables":
        return build_tables(args)
    if args.command == "my-cards":
        return push_my_cards(args)
    if args.command == "sync-tables":
        return sync_tables()
    if args.command == "telegram-setup":
        return telegram_setup()
    if args.command in ("query", "price"):
        return run_query(args)
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
