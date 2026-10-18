"""Phase 0 sources (spec §5). Only sanctioned, openly downloadable files."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path

import httpx

USER_AGENT = "mtg-intel/0.1 (personal price archiver)"

XZ_MAGIC = b"\xfd7zXZ\x00"
GZIP_MAGIC = b"\x1f\x8b"


class InvalidDownload(Exception):
    pass


@dataclass(frozen=True)
class Source:
    name: str
    url: str = ""
    resolve: Callable[[httpx.Client], str] | None = None  # for URLs that change, e.g. Scryfall bulk
    compress: bool = False  # zstd-compress before storing (D25)
    min_bytes: int = 1
    # Raises InvalidDownload; may return metadata found in the file (e.g. its own timestamp).
    validate: Callable[[Path], dict[str, str] | None] | None = None
    every: timedelta | None = None  # minimum time between saves; None = check every run
    once: bool = False  # save a single time, never again (one-off backfill)
    max_age: timedelta | None = None  # alert when the last saved version is older than this
    headers: dict[str, str] = field(default_factory=dict)
    # A collector makes its own requests and writes one file (D31). It returns metadata.
    collect: Callable[[httpx.Client, Path], dict[str, str]] | None = None
    filename: str | None = None  # stored file name; default: last part of the URL
    requires_env: tuple[str, ...] = ()  # source is "disabled" while any of these is unset
    retries: bool = True  # retry the whole source; collectors retry per request instead


def json_with_key(key: str) -> Callable[[Path], dict[str, str] | None]:
    def check(path: Path) -> dict[str, str] | None:
        try:
            with path.open("rb") as f:
                data = json.load(f)
        except ValueError as e:
            raise InvalidDownload(f"not valid JSON: {e}") from e
        if not isinstance(data, dict) or not data.get(key):
            raise InvalidDownload(f"JSON has no non-empty '{key}'")
        created_at = data.get("createdAt")  # Cardmarket's own "as of" time
        return {"created_at": str(created_at)} if created_at else None

    return check


def starts_with(magic: bytes, kind: str) -> Callable[[Path], None]:
    def check(path: Path) -> None:
        with path.open("rb") as f:
            if f.read(len(magic)) != magic:
                raise InvalidDownload(f"not a {kind} file")

    return check


SCRYFALL_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}


def scryfall_default_cards(client: httpx.Client) -> str:
    response = client.get("https://api.scryfall.com/bulk-data/default-cards", headers=SCRYFALL_HEADERS)
    response.raise_for_status()
    data = response.json()
    url = data.get("jsonl_download_uri") or data.get("download_uri")
    if not url:
        raise InvalidDownload("Scryfall bulk-data response has no download URI")
    return url


CARDMARKET = "https://downloads.s3.cardmarket.com/productCatalog"
MTGJSON = "https://mtgjson.com/api/v5"

CARDTRADER = "https://api.cardtrader.com/api/v2"


def cardtrader_marketplace(client: httpx.Client, dest: Path) -> dict[str, str]:
    from mtg_intel.archive.cardtrader import collect_marketplace

    return collect_marketplace(client, dest, token=os.environ["CARDTRADER_TOKEN"])


def cardtrader_catalog(client: httpx.Client, dest: Path) -> dict[str, str]:
    from mtg_intel.archive.cardtrader import collect_catalog

    return collect_catalog(client, dest, token=os.environ["CARDTRADER_TOKEN"])


# A daily file that has not changed for this long means the source (or we) stopped updating.
DAILY = timedelta(hours=30)

SOURCES: list[Source] = [
    Source(
        name="cardmarket_price_guide",
        url=f"{CARDMARKET}/priceGuide/price_guide_1.json",
        compress=True,
        min_bytes=5_000_000,
        validate=json_with_key("priceGuides"),
        max_age=DAILY,
    ),
    Source(
        name="cardmarket_products_singles",
        url=f"{CARDMARKET}/productList/products_singles_1.json",
        compress=True,
        min_bytes=5_000_000,
        validate=json_with_key("products"),
        max_age=DAILY,
    ),
    Source(
        name="cardmarket_products_nonsingles",
        url=f"{CARDMARKET}/productList/products_nonsingles_1.json",
        compress=True,
        min_bytes=100_000,
        validate=json_with_key("products"),
        max_age=DAILY,
    ),
    Source(
        name="mtgjson_allprices_today",
        url=f"{MTGJSON}/AllPricesToday.json.xz",
        min_bytes=1_000_000,
        validate=starts_with(XZ_MAGIC, "xz"),
        max_age=DAILY,
    ),
    Source(
        name="mtgjson_allprices",
        url=f"{MTGJSON}/AllPrices.json.xz",
        min_bytes=10_000_000,
        validate=starts_with(XZ_MAGIC, "xz"),
        once=True,
    ),
    Source(
        name="mtgjson_card_identifiers",
        url=f"{MTGJSON}/parquet/cardIdentifiers.parquet",
        min_bytes=1_000_000,
        validate=starts_with(b"PAR1", "Parquet"),
        # Weekly (D38): links MTGJSON uuid to Scryfall and Cardmarket IDs.
        every=timedelta(days=7) - timedelta(hours=6),
        max_age=timedelta(days=8),
    ),
    Source(
        name="scryfall_default_cards",
        resolve=scryfall_default_cards,
        min_bytes=20_000_000,
        validate=starts_with(GZIP_MAGIC, "gzip"),
        # Weekly (D5). Runs drift by a few hours, so allow some slack.
        every=timedelta(days=7) - timedelta(hours=6),
        max_age=timedelta(days=8),
        headers={"User-Agent": USER_AGENT},
    ),
    Source(
        name="cardtrader_marketplace",
        url=f"{CARDTRADER}/marketplace/products",
        collect=cardtrader_marketplace,
        filename="marketplace.jsonl",
        compress=True,
        min_bytes=1_000,
        # CARDTRADER_APPROVED is set only once CardTrader OKs market API use (spec D30).
        requires_env=("CARDTRADER_TOKEN", "CARDTRADER_APPROVED"),
        retries=False,
        # Once a day: the 02:17 UTC run (runs are 6 h apart).
        every=timedelta(hours=20),
        max_age=DAILY,
    ),
    Source(
        name="cardtrader_catalog",
        url=f"{CARDTRADER}/blueprints/export",
        collect=cardtrader_catalog,
        filename="blueprints.jsonl",
        compress=True,
        min_bytes=1_000,
        # Card list only, no prices: the inventory side of the API, no approval needed (spec D33).
        requires_env=("CARDTRADER_TOKEN",),
        retries=False,
        every=timedelta(days=7) - timedelta(hours=6),
        max_age=timedelta(days=8),
    ),
]
