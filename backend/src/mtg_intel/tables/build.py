"""Build the phase 2 tables from the raw archive, incrementally (D39).

Reads raw files (local folder or the Hugging Face archive), builds only what is new since the
last build (`_build.json` in the tables store), checks for gaps, and publishes once.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from typing import Protocol

import pyarrow as pa
import pyarrow.parquet as pq

from mtg_intel.tables import mycards, prices, reference

STATE_PATH = "_build.json"
SHRINK_LIMIT = 0.9  # a day with fewer than 90% of the previous day's rows is suspicious


# --- where raw files come from -----------------------------------------------------------


class RawArchive(Protocol):
    def list(self, source: str) -> list[str]: ...

    def fetch(self, path: str) -> Path: ...


class LocalRaw:
    def __init__(self, root: Path) -> None:
        self.root = root

    def list(self, source: str) -> list[str]:
        base = self.root / "raw" / source
        if not base.exists():
            return []
        return sorted(str(p.relative_to(self.root)) for p in base.rglob("*") if p.is_file())

    def fetch(self, path: str) -> Path:
        return self.root / path


class HfRaw:
    def __init__(self, repo_id: str, token: str, cache_dir: Path) -> None:
        from huggingface_hub import HfApi

        self.repo_id, self.token, self.cache_dir = repo_id, token, cache_dir
        self.files = HfApi(token=token).list_repo_files(repo_id, repo_type="dataset")

    def list(self, source: str) -> list[str]:
        return sorted(f for f in self.files if f.startswith(f"raw/{source}/"))

    def fetch(self, path: str) -> Path:
        from huggingface_hub import hf_hub_download

        return Path(
            hf_hub_download(self.repo_id, path, repo_type="dataset", token=self.token, local_dir=self.cache_dir)
        )


# --- where tables go ------------------------------------------------------------------------


class TableStore(Protocol):
    def read_state(self) -> dict: ...

    def fetch(self, path: str) -> Path | None:
        """A file already in the store (e.g. my uploaded CSVs), or None."""
        ...

    def put(self, files: list[tuple[str, Path]], message: str) -> None: ...

    def publish(self, files: list[tuple[str, Path]], state: dict, message: str) -> None: ...


class LocalTables:
    def __init__(self, root: Path) -> None:
        self.root = root

    def read_state(self) -> dict:
        path = self.root / STATE_PATH
        return json.loads(path.read_text()) if path.exists() else {}

    def fetch(self, path: str) -> Path | None:
        local = self.root / path
        return local if local.exists() else None

    def put(self, files: list[tuple[str, Path]], message: str) -> None:
        for path_in_store, local in files:
            dest = self.root / path_in_store
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(local, dest)

    def publish(self, files: list[tuple[str, Path]], state: dict, message: str) -> None:
        for path_in_store, local in files:
            dest = self.root / path_in_store
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(local, dest)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / STATE_PATH).write_text(json.dumps(state, indent=2) + "\n")


class HfTables:
    def __init__(self, repo_id: str, token: str) -> None:
        from huggingface_hub import HfApi

        self.repo_id, self.token = repo_id, token
        self.api = HfApi(token=token)

    def read_state(self) -> dict:
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError

        try:
            path = hf_hub_download(
                self.repo_id, STATE_PATH, repo_type="dataset", token=self.token, force_download=True
            )
        except EntryNotFoundError:
            return {}
        return json.loads(Path(path).read_text())

    def fetch(self, path: str) -> Path | None:
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError

        try:
            return Path(
                hf_hub_download(self.repo_id, path, repo_type="dataset", token=self.token, force_download=True)
            )
        except EntryNotFoundError:
            return None

    def put(self, files: list[tuple[str, Path]], message: str) -> None:
        from huggingface_hub import CommitOperationAdd

        operations = [CommitOperationAdd(path_in_repo=p, path_or_fileobj=str(local)) for p, local in files]
        self.api.create_commit(self.repo_id, operations, commit_message=message, repo_type="dataset")

    def publish(self, files: list[tuple[str, Path]], state: dict, message: str) -> None:
        from huggingface_hub import CommitOperationAdd

        operations = [CommitOperationAdd(path_in_repo=p, path_or_fileobj=str(local)) for p, local in files]
        operations.append(
            CommitOperationAdd(path_in_repo=STATE_PATH, path_or_fileobj=(json.dumps(state, indent=2) + "\n").encode())
        )
        self.api.create_commit(self.repo_id, operations, commit_message=message, repo_type="dataset")


# --- the build ---------------------------------------------------------------------------------


@dataclass
class BuildReport:
    written: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def build(raw: RawArchive, store: TableStore, staging: Path, now: datetime, publish: bool = True) -> BuildReport:
    if staging.exists():
        shutil.rmtree(staging)
    out = staging / "out"
    out.mkdir(parents=True)
    state = store.read_state()
    processed: dict[str, list[str]] = state.setdefault("processed", {})
    days: dict[str, dict[str, int]] = state.setdefault("days", {})  # table -> {date: row count}
    report = BuildReport()
    files: list[tuple[str, Path]] = []

    def stage(path_in_store: str, table: pa.Table) -> None:
        local = out / path_in_store
        local.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, local, compression="zstd")
        files.append((path_in_store, local))
        report.written.append(f"{path_in_store} ({table.num_rows:,} rows)")

    # Reference tables, each rebuilt only when its own latest inputs changed (every rewrite is a
    # new file version on Hugging Face, so daily rebuilds of weekly data would waste storage).
    cards: pa.Table | None = None
    latest = {source: (raw.list(source) or [None])[-1] for source in REFERENCE_SOURCES}
    built_from: dict[str, dict] = state.setdefault("reference_inputs", {})
    if built_from and not {"cards", "products"} & built_from.keys():
        built_from.clear()  # state from before the split: rebuild once
    card_inputs = {k: latest[k] for k in CARD_SOURCES} | {"table_version": reference.CARDS_TABLE_VERSION}
    product_inputs = {k: latest[k] for k in PRODUCT_SOURCES}
    if not (latest["scryfall_default_cards"] and latest["mtgjson_card_identifiers"]):
        report.notes.append("reference tables skipped: Scryfall or MTGJSON identifiers not archived yet")
    elif built_from.get("cards") != card_inputs:
        cards = reference.build_cards(raw.fetch(latest["scryfall_default_cards"]))
        catalog = raw.fetch(latest["cardtrader_catalog"]) if latest["cardtrader_catalog"] else None
        card_ids = reference.build_card_ids(cards, raw.fetch(latest["mtgjson_card_identifiers"]), catalog)
        stage("reference/cards.parquet", cards)
        stage("reference/card_ids.parquet", card_ids)
        built_from["cards"] = card_inputs
    if latest["cardmarket_products_singles"] and built_from.get("products") != product_inputs:
        nonsingles = latest["cardmarket_products_nonsingles"]
        stage(
            "reference/cardmarket_products.parquet",
            prices.cardmarket_products(
                raw.fetch(latest["cardmarket_products_singles"]), raw.fetch(nonsingles) if nonsingles else None
            ),
        )
        built_from["products"] = product_inputs

    # Cardmarket prices: one file per new price guide.
    cm_days = days.setdefault("cardmarket", {})
    for path in new_paths(raw, "cardmarket_price_guide", processed):
        day, table = prices.cardmarket_prices(raw.fetch(path))
        stage(f"prices/cardmarket/{day:%Y}/{day.isoformat()}.parquet", table)
        cm_days[day.isoformat()] = table.num_rows
        processed["cardmarket_price_guide"].append(path)

    # MTGJSON prices: daily files first; the 90-day backfill only fills days not covered yet.
    mj_days = days.setdefault("mtgjson", {})

    def write_mtgjson(day: date, table: pa.Table) -> None:
        stage(f"prices/mtgjson/{day:%Y}/{day.isoformat()}.parquet", table)
        mj_days[day.isoformat()] = table.num_rows

    for source, skip_known in [("mtgjson_allprices_today", False), ("mtgjson_allprices", True)]:
        for path in new_paths(raw, source, processed):
            skip = {date.fromisoformat(d) for d in mj_days} if skip_known else set()
            prices.mtgjson_prices(raw.fetch(path), staging / "work", write_mtgjson, skip)
            processed[source].append(path)

    # My cards: rebuilt when my CSVs or the card reference changed.
    my_inputs = {name: store.fetch(path) for name, path in MY_INPUTS.items()}
    fingerprint = {name: file_sha256(p) if p else None for name, p in my_inputs.items()}
    fingerprint["cards"] = state["reference_inputs"].get("cards")
    if any(my_inputs.values()) and state.get("my_inputs") != fingerprint:
        if cards is None:
            existing = store.fetch("reference/cards.parquet")
            cards = pq.read_table(existing) if existing else None
        if cards is None:
            report.notes.append("my cards skipped: no card reference yet")
        else:
            for name, builder in [("wantlist", mycards.wantlist_table), ("collection", mycards.collection_table)]:
                if my_inputs[name]:
                    table = builder(mycards.read_text(my_inputs[name]), cards)
                    stage(f"my/{name}.parquet", table)
                    # Rows with a CardTrader card but no Scryfall printing can still be tracked on CardTrader.
                    matched = table.column("matched").to_pylist()
                    blueprints = (
                        table.column("cardtrader_blueprint_id").to_pylist()
                        if "cardtrader_blueprint_id" in table.column_names
                        else [""] * len(matched)
                    )
                    unmatched = sum(1 for ok, bp in zip(matched, blueprints, strict=True) if not ok and not bp)
                    if unmatched:
                        report.problems.append(f"{name}: {unmatched} row(s) not matched to a card")
            state["my_inputs"] = fingerprint

    report.problems += check_days("Cardmarket", cm_days, now)
    report.problems += check_days("MTGJSON", mj_days, now, ignore_before=first_daily_date(processed))

    state["built_at"] = now.isoformat()
    if publish and files:
        store.publish(files, state, f"build {now:%Y-%m-%d %H:%MZ}: {len(files)} files")
    elif publish:
        report.notes.append("nothing new to build")
    return report


MY_INPUTS = {"wantlist": "my/inputs/wantlist.csv", "collection": "my/inputs/collection.csv"}

CARD_SOURCES = ["scryfall_default_cards", "mtgjson_card_identifiers", "cardtrader_catalog"]
PRODUCT_SOURCES = ["cardmarket_products_singles", "cardmarket_products_nonsingles"]
REFERENCE_SOURCES = [
    "scryfall_default_cards",
    "mtgjson_card_identifiers",
    "cardtrader_catalog",
    "cardmarket_products_singles",
    "cardmarket_products_nonsingles",
]


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def new_paths(raw: RawArchive, source: str, processed: dict[str, list[str]]) -> list[str]:
    done = set(processed.setdefault(source, []))
    return [p for p in raw.list(source) if p not in done]


def first_daily_date(processed: dict[str, list[str]]) -> date | None:
    """Gap checks for MTGJSON start where our own daily saves start (the backfill has its own range)."""
    daily = processed.get("mtgjson_allprices_today") or []
    return min((date.fromisoformat(p.split("/")[2]) for p in daily), default=None)


def check_days(
    name: str, row_counts: dict[str, int], now: datetime, ignore_before: date | None = None
) -> list[str]:
    """Missing days, a stale latest day, and sudden drops in row count."""
    if not row_counts:
        return []
    known = sorted(date.fromisoformat(d) for d in row_counts)
    if ignore_before:
        known = [d for d in known if d >= ignore_before] or known[-1:]
    problems = []
    expected = {known[0] + timedelta(days=i) for i in range((known[-1] - known[0]).days + 1)}
    missing = sorted(expected - set(known))
    if missing:
        problems.append(f"{name}: missing price days {', '.join(d.isoformat() for d in missing)}")
    if (now.date() - known[-1]).days > 1:
        problems.append(f"{name}: latest price day is {known[-1].isoformat()}")
    for previous, current in pairwise(known):
        before, after = row_counts[previous.isoformat()], row_counts[current.isoformat()]
        if after < before * SHRINK_LIMIT:
            problems.append(f"{name}: {current.isoformat()} has {after:,} rows, {before:,} the day before")
    return problems


def tables_dataset_from_env() -> str:
    """HF_TABLES_DATASET, or `<owner of HF_DATASET>/mtg-intel-tables` (D36)."""
    explicit = os.environ.get("HF_TABLES_DATASET")
    if explicit:
        return explicit
    archive = os.environ.get("HF_DATASET", "")
    if "/" not in archive:
        raise SystemExit("HF_DATASET (or HF_TABLES_DATASET) must be set")
    return f"{archive.split('/')[0]}/mtg-intel-tables"
