"""Data for the website (phase 3b, D49).

The browser can't read the private Hugging Face datasets, so the jobs that build the tables and
check deals also write small JSON documents and send them to the site's Worker, which keeps them in
Cloudflare KV:

- `wants`: every wish with its exact version, settings, latest Cardmarket prices, CardTrader's own
  label for the version, links and the data checks that flagged it (built with the tables)
- `history`: Cardmarket and MTGJSON price history of my printings (built with the tables)
- `prices-<n>`: latest Cardmarket trend of every printing, in shards, for card search over all cards
- `live`: the latest deal check: cheapest fitting CardTrader listing per wish and the current deals
- `ct-recent` / `ct-history`: CardTrader's cheapest fitting price per check (recent checks one by
  one, older days as hourly lows from the packed daily files)
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable, Iterable
from datetime import datetime, timedelta
from typing import Any

import duckdb
import httpx
import pyarrow as pa

from mtg_intel import deals

PRICE_SHARDS = 32
RECENT_HOURS = 48  # ct-recent keeps every check this far back; ct-history covers the days before
HISTORY_DAYS = 30  # days of CardTrader history in ct-history
GONE_HOURS = 24  # a deal that disappeared stays listed (struck through) this long
LIVE_FLAG_RATIO = 2.5  # CardTrader and Cardmarket this far apart is worth a look (frontend check)
RETRY_WAITS = (2, 8)  # seconds before the second and third try of an upload


class Site:
    """The site Worker's ingest endpoint: `POST /api/ingest/<key>` stores a document, `GET` reads it."""

    def __init__(self, client: httpx.Client, url: str, token: str, sleep: Callable[[float], None] = time.sleep) -> None:
        self.client, self.url, self.token, self.sleep = client, url.rstrip("/"), token, sleep

    @classmethod
    def from_env(cls, client: httpx.Client) -> Site | None:
        url, token = os.environ.get("SITE_URL"), os.environ.get("SITE_INGEST_TOKEN")
        return cls(client, url, token) if url and token else None

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "User-Agent": "mtg-intel"}

    def _send(self, method: str, key: str, **kwargs: Any) -> httpx.Response:
        """One request, retried on network errors and server errors (RETRY_WAITS)."""
        for attempt in range(len(RETRY_WAITS) + 1):
            try:
                response = self.client.request(method, f"{self.url}/api/ingest/{key}", timeout=60, **kwargs)
                if response.status_code < 500:
                    return response
            except httpx.TransportError:
                if attempt == len(RETRY_WAITS):
                    raise
            if attempt < len(RETRY_WAITS):
                self.sleep(RETRY_WAITS[attempt])
        return response

    def put(self, key: str, doc: Any) -> None:
        body = json.dumps(doc, separators=(",", ":"), default=str)
        self._send("POST", key, content=body.encode(),
                   headers=self._headers() | {"Content-Type": "application/json"}).raise_for_status()

    def get(self, key: str) -> Any | None:
        response = self._send("GET", key, headers=self._headers())
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()


# --- documents built with the tables ----------------------------------------------------------

LANGUAGE_NAMES = {"en": "English", "ja": "Japanese", "any": "Any language", "it": "Italian", "fr": "French",
                  "de": "German", "es": "Spanish", "pt": "Portuguese", "ko": "Korean", "ru": "Russian",
                  "zhs": "Chinese", "zht": "Chinese (trad.)"}

# Words in CardTrader's version label and the special tag each one means in our card table.
CT_LABEL_TAGS = {"borderless": "borderless", "showcase": "showcase", "extended": "extendedart",
                 "etched": "etched", "retro": "retroframe", "full art": "fullart", "serialized": "serialized",
                 "textured": "textured", "galaxy": "galaxyfoil", "surge": "surgefoil", "halo": "halofoil"}


def scryfall_small(image_url: str | None) -> str | None:
    """Scryfall's 146×204 picture for list rows (the table stores the 488×680 one)."""
    return image_url.replace("/normal/", "/small/") if image_url else None


def cardmarket_link(cardmarket_id: int | None, wish: dict[str, Any]) -> str | None:
    """Cardmarket product page filtered to Dutch sellers and the wish's language, condition and foil (D17)."""
    if not cardmarket_id:
        return None
    params = [f"idProduct={cardmarket_id}", f"sellerCountry={deals.CM_SELLER_COUNTRY}"]
    if wish.get("language") in deals.CM_LANGUAGES:
        params.append(f"language={deals.CM_LANGUAGES[wish['language']]}")
    params.append(f"minCondition={deals.CM_MIN_CONDITION.get(wish.get('min_condition') or 'NM', 2)}")
    if wish.get("foil") in ("yes", "no"):
        params.append(f"isFoil={'Y' if wish['foil'] == 'yes' else 'N'}")
    return "https://www.cardmarket.com/en/Magic/Products?" + "&".join(params)


def number_key(number: str | None) -> str:
    return (number or "").lstrip("0").lower()


def name_key(name: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").split(" // ")[0].lower())


def wish_flags(w: dict[str, Any]) -> list[dict[str, str]]:
    """What looks doubtful about one wish, in plain words (the site's Check tab)."""
    flags = []

    def flag(code: str, text: str) -> None:
        flags.append({"code": code, "text": text})

    if not w.get("scryfall_id"):
        flag("no_version", "Not matched to an exact printing (a name alone is never enough).")
    ct = w.get("ct") or {}
    if w.get("scryfall_id") and not w.get("blueprint_id"):
        flag("no_cardtrader", "No CardTrader card, so it is never checked for deals.")
    if ct and w.get("scryfall_id"):
        if w.get("collector_number") and ct.get("number") and number_key(ct["number"]) != number_key(w["collector_number"]):
            flag("ct_number", f"CardTrader has #{ct['number']}, we have #{w['collector_number']}.")
        if w.get("name") and ct.get("name") and name_key(ct["name"]) != name_key(w["name"]):
            flag("ct_name", f"CardTrader calls it “{ct['name']}”.")
        if ct.get("scryfall_id") and w.get("scryfall_id") and ct["scryfall_id"] != w["scryfall_id"]:
            flag("ct_printing", "CardTrader's card points at a different Scryfall printing.")
        label = (ct.get("version") or "").lower()
        missing = sorted({tag for word, tag in CT_LABEL_TAGS.items() if word in label} - set(w.get("special_tags") or []))
        if missing:
            flag("ct_label", f"CardTrader's label “{ct['version']}” says {', '.join(missing)}; our version doesn't.")
        if w.get("cardmarket_id") and ct.get("card_market_ids") and w["cardmarket_id"] not in ct["card_market_ids"]:
            flag("cm_product", "CardTrader links a different Cardmarket product than Scryfall does.")
    finishes = w.get("finishes") or []
    if w.get("foil") == "yes" and finishes and "foil" not in finishes and "etched" not in finishes:
        flag("foil", "Wish is foil, but this printing has no foil.")
    if w.get("foil") == "no" and finishes and "nonfoil" not in finishes:
        flag("foil", "Wish is non-foil, but this printing is foil only.")
    cm = w.get("cm") or {}
    if w.get("scryfall_id"):
        if not w.get("cardmarket_id"):
            flag("no_cardmarket", "No Cardmarket product linked.")
        else:
            foil_only = bool(finishes) and "nonfoil" not in finishes
            nonfoil_only = bool(finishes) and not ({"foil", "etched"} & set(finishes))
            wanted = (["trend_foil"] if w.get("foil") == "yes" or foil_only
                      else ["trend"] if w.get("foil") == "no" or nonfoil_only else ["trend", "trend_foil"])
            values = [cm.get(k) for k in wanted]
            if all(v is None for v in values):
                flag("no_cm_price", "No Cardmarket price for this finish.")
            for key, value in zip(wanted, values, strict=True):
                if value == 0:
                    finish = "foil" if key.endswith("foil") else "non-foil"
                    flag("cm_zero", f"Cardmarket's {finish} trend is €0.00 (probably no {finish} copies sold).")
    if w.get("jump"):
        flag("cm_jump", f"Cardmarket trend moved {w['jump']:+.0f}% in one day.")
    return flags


def wants_doc(wantlist: pa.Table, cards: pa.Table, blueprints: pa.Table | None, history: pa.Table | None,
              now: datetime) -> dict[str, Any]:
    con = duckdb.connect()
    for column in ("max_price_eur", "deal_pct", "one_of", "note", "quantity"):
        if column not in wantlist.column_names:
            wantlist = wantlist.append_column(column, pa.nulls(wantlist.num_rows, pa.string()))
    con.register("w", wantlist)
    con.register("c", cards)
    if blueprints is None:
        blueprints = pa.table({"blueprint_id": pa.array([], pa.int64())})
    con.register("b", blueprints)
    if history is None or history.num_rows == 0:
        history = pa.table({"scryfall_id": pa.array([], pa.string()), "price_date": pa.array([], pa.date32()),
                            "source": pa.array([], pa.string()), "finish": pa.array([], pa.string()),
                            "trend": pa.array([], pa.float64()), "low": pa.array([], pa.float64()),
                            "avg7": pa.array([], pa.float64())})
    con.register("h", history)
    con.execute(
        """create table latest as
           with cm as (select * from h where source = 'cardmarket'),
           days as (select scryfall_id, max(price_date) as d from cm group by all)
           select cm.scryfall_id, cm.price_date,
               max(trend) filter (finish = 'normal') as trend, max(trend) filter (finish = 'foil') as trend_foil,
               max(low) filter (finish = 'normal') as low, max(low) filter (finish = 'foil') as low_foil,
               max(avg7) filter (finish = 'normal') as avg7, max(avg7) filter (finish = 'foil') as avg7_foil
           from cm join days on days.scryfall_id = cm.scryfall_id and days.d = cm.price_date group by all"""
    )
    # Day-over-day change of the trend, to flag sudden jumps (often a data error, sometimes real).
    con.execute(
        """create table jumps as
           select scryfall_id, finish, trend, lag(trend) over (partition by scryfall_id, finish order by price_date) as before,
               row_number() over (partition by scryfall_id, finish order by price_date desc) as nth
           from h where source = 'cardmarket'"""
    )
    rows = con.execute(
        """select w.line, coalesce(c.name, w.card_name, w.name) as name, c.set_code, c.set_name, c.collector_number,
               c.special_tags, c.finishes, c.rarity, c.image_url, c.mana_cost, c.type_line, c.artist, c.released_at, w.scryfall_id,
               try_cast(w.cardtrader_blueprint_id as bigint) as blueprint_id, c.cardmarket_id,
               w.language, w.foil, w.min_condition, w.via_zero, try_cast(w.max_price_eur as double) as max_price_eur,
               try_cast(w.deal_pct as double) as deal_pct, w.list, nullif(w.one_of, '') as one_of,
               nullif(w.note, '') as note, try_cast(w.quantity as integer) as quantity,
               b.name as ct_name, b.version as ct_version, b.expansion_code as ct_code, b.expansion_name as ct_expansion,
               b.collector_number as ct_number, b.scryfall_id as ct_scryfall_id, b.card_market_ids, b.image_url as ct_image,
               l.price_date, l.trend, l.trend_foil, l.low, l.low_foil, l.avg7, l.avg7_foil,
               (select max(abs(trend / before - 1) * 100 * sign(trend - before)) from jumps j
                where j.scryfall_id = w.scryfall_id and j.nth = 1 and j.before > 0 and abs(trend / before - 1) > 0.6) as jump
           from w
           left join c using (scryfall_id)
           left join b on b.blueprint_id = try_cast(w.cardtrader_blueprint_id as bigint)
           left join latest l using (scryfall_id)
           order by w.line"""
    ).to_arrow_table().to_pylist()
    wishes = []
    for r in rows:
        ct = ({"name": r["ct_name"], "version": r["ct_version"], "code": r["ct_code"], "expansion": r["ct_expansion"],
               "number": r["ct_number"], "scryfall_id": r["ct_scryfall_id"], "card_market_ids": r["card_market_ids"] or []}
              if r["ct_name"] else None)
        cm = {k: r[k] for k in ("trend", "trend_foil", "low", "low_foil", "avg7", "avg7_foil") if r[k] is not None}
        if r["price_date"]:
            cm["date"] = r["price_date"].isoformat()
        w = {"name": r["name"], "scryfall_id": r["scryfall_id"], "blueprint_id": r["blueprint_id"],
             "cardmarket_id": r["cardmarket_id"], "collector_number": r["collector_number"],
             "special_tags": list(r["special_tags"] or []), "finishes": list(r["finishes"] or []),
             "language": r["language"] or "any", "foil": r["foil"] or "any", "min_condition": r["min_condition"] or "NM",
             "ct": ct, "cm": cm, "jump": r["jump"]}
        ct_image = r["ct_image"]
        if ct_image and ct_image.startswith("/"):
            ct_image = "https://www.cardtrader.com" + ct_image
        wishes.append({
            "key": deals.wish_key(w), "line": r["line"], "name": r["name"], "set": r["set_code"],
            "set_name": r["set_name"], "number": r["collector_number"], "tags": w["special_tags"],
            "mana_cost": r["mana_cost"], "type_line": r["type_line"], "artist": r["artist"],
            "released": r["released_at"].isoformat() if r["released_at"] else None,
            "finishes": w["finishes"], "rarity": r["rarity"], "scryfall_id": r["scryfall_id"],
            "blueprint_id": r["blueprint_id"], "cardmarket_id": r["cardmarket_id"],
            "image": r["image_url"] or ct_image, "thumb": scryfall_small(r["image_url"]) or ct_image,
            "lists": [x.strip() for x in (r["list"] or "").split(";") if x.strip()], "one_of": r["one_of"],
            "note": r["note"], "quantity": r["quantity"] or 1,
            "language": w["language"], "foil": w["foil"], "condition": w["min_condition"],
            "zero": (r["via_zero"] or "yes") == "yes", "max_price": r["max_price_eur"], "deal_pct": r["deal_pct"],
            "cm": cm, "ct": {k: v for k, v in (ct or {}).items() if k in ("name", "version", "code", "expansion", "number")}
            or None,
            "links": {
                "cardmarket": cardmarket_link(r["cardmarket_id"], w),
                "cardtrader": f"https://www.cardtrader.com/cards/{r['blueprint_id']}" if r["blueprint_id"] else None,
                "scryfall": f"https://scryfall.com/card/{r['set_code']}/{r['collector_number']}" if r["set_code"] else None,
            },
            "flags": wish_flags(w),
        })
    return {"built_at": now.isoformat(), "price_date": max((w["cm"].get("date") or "" for w in wishes), default=None),
            "languages": LANGUAGE_NAMES, "wishes": wishes}


def history_doc(history: pa.Table | None) -> dict[str, Any]:
    """Per printing and source, flat [day offset, value, …] lists from a shared base day (compact)."""
    rows = history.to_pylist() if history is not None else []
    base = min((r["price_date"] for r in rows), default=None)
    cards: dict[str, dict] = {}
    for r in rows:
        if r["trend"] is None:
            continue
        series = cards.setdefault(r["scryfall_id"], {}).setdefault(r["source"], {}).setdefault(r["finish"], [])
        series += [(r["price_date"] - base).days, round(r["trend"], 2)]
    return {"base": base.isoformat() if base else None, "cards": cards}


def price_shards(cards: pa.Table, cardmarket_day: pa.Table) -> dict[int, dict[str, list]]:
    """Latest Cardmarket trend (non-foil, foil) of every printing, split by the first byte of its ID."""
    con = duckdb.connect()
    con.register("c", cards)
    con.register("p", cardmarket_day)
    rows = con.execute(
        """select c.scryfall_id, p.trend, p.trend_foil from c join p on p.id_product = c.cardmarket_id
           where p.trend is not null or p.trend_foil is not null"""
    ).fetchall()
    shards: dict[int, dict[str, list]] = {n: {} for n in range(PRICE_SHARDS)}
    for sid, trend, trend_foil in rows:
        shards[shard_of(sid)][sid] = [trend, trend_foil]
    return shards


def shard_of(scryfall_id: str) -> int:
    return int(scryfall_id[:2], 16) % PRICE_SHARDS


def export_tables(site: Site, load: Callable[[str], pa.Table | None], changed: Iterable[str], now: datetime,
                  force: bool = False, latest_day: str | None = None) -> list[str]:
    """Send the documents whose tables changed in this build; returns the keys sent."""
    changed = list(changed)
    sent = []
    touches = lambda prefixes: force or any(p.startswith(prefixes) for p in changed)
    if touches(("my/", "reference/cards", "reference/cardtrader_blueprints")):
        wantlist, cards = load("my/wantlist.parquet"), load("reference/cards.parquet")
        if wantlist is not None and cards is not None:
            history = load("my/price_history.parquet")
            site.put("wants", wants_doc(wantlist, cards, load("reference/cardtrader_blueprints.parquet"), history, now))
            site.put("history", history_doc(history))
            sent += ["wants", "history"]
    days = sorted(p for p in changed if p.startswith("prices/cardmarket/"))
    if days or force:
        cards = load("reference/cards.parquet")
        latest = days[-1] if days else (f"prices/cardmarket/{latest_day[:4]}/{latest_day}.parquet" if latest_day else None)
        day = load(latest) if latest else None
        if cards is not None and day is not None:
            for n, shard in price_shards(cards, day).items():
                site.put(f"prices-{n}", shard)
            sent.append(f"prices-0…{PRICE_SHARDS - 1}")
    return sent


# --- documents written by each deal check -------------------------------------------------------


def listing_doc(x: deals.Listing) -> dict[str, Any]:
    return {"id": x.id, "price": x.price, "condition": x.condition, "language": x.language, "foil": x.foil,
            "zero": x.zero, "country": x.country}


def live_doc(result: deals.CheckResult, watch: list[dict[str, Any]], now: datetime,
             previous: dict[str, Any] | None) -> dict[str, Any]:
    """The latest check: per wish the cheapest fitting listing and the usual price; the deals; and
    deals from earlier checks that are gone now (kept a day, so a sold deal is seen as sold)."""
    current = {}
    for d in result.deals:
        current[d.key] = {
            "key": d.key, "listing": listing_doc(d.listing), "cardmarket": d.cardmarket, "cardtrader": d.cardtrader,
            "cardtrader_kind": d.cardtrader_kind, "below_pct": d.below_pct,
            "tier": d.tier[0] if d.tier else None, "target": any("target" in r for r in d.reasons),
            "reasons": d.reasons, "since": now.isoformat(),
        }
    gone = []
    checked = {deals.wish_key(w) for w in watch if w["blueprint_id"] not in result.failed_blueprints}
    for old in (previous or {}).get("deals", []):
        if old["key"] in current:
            current[old["key"]]["since"] = old.get("since") or current[old["key"]]["since"]
        elif old["key"] in checked:
            gone.append(old | {"gone_at": now.isoformat()})
    cutoff = now - timedelta(hours=GONE_HOURS)
    gone += [g for g in (previous or {}).get("gone", [])
             if g["key"] not in current and datetime.fromisoformat(g["gone_at"]) >= cutoff
             and g["key"] not in {x["key"] for x in gone}]
    wishes = {}
    for key, listing in result.cheapest.items():
        usual, kind = result.usual.get(key, (None, ""))
        wishes[key] = listing_doc(listing) | {"count": result.counts.get(key, 0), "usual": usual, "usual_kind": kind}
    return {"checked_at": now.isoformat(), "cards_checked": len({w["blueprint_id"] for w in watch}),
            "failed": len(result.failed_blueprints), "wishes": wishes,
            "empty": sorted(checked - set(wishes)), "deals": list(current.values()), "gone": gone}


def ct_recent_doc(previous: dict[str, Any] | None, result: deals.CheckResult, now: datetime) -> dict[str, Any]:
    """Every check of the last two days: {"t": [times], "p": {wish key: [price or None per time]}}."""
    times = list((previous or {}).get("t", []))
    prices = {k: list(v) for k, v in (previous or {}).get("p", {}).items()}
    times.append(now.isoformat())
    for key in set(prices) | set(result.cheapest):
        series = prices.setdefault(key, [None] * (len(times) - 1))
        series += [None] * (len(times) - 1 - len(series))
        listing = result.cheapest.get(key)
        series.append(listing.price if listing else None)
    cutoff = now - timedelta(hours=RECENT_HOURS)
    keep = [i for i, t in enumerate(times) if datetime.fromisoformat(t) >= cutoff]
    return {"t": [times[i] for i in keep],
            "p": {k: [v[i] for i in keep] for k, v in prices.items() if any(v[i] is not None for i in keep)}}


def ct_history_doc(watch: list[dict[str, Any]], history: dict[int, list[dict[str, Any]]]) -> dict[str, Any]:
    """Hourly lowest fitting CardTrader price per wish from the packed daily check files:
    {wish key: [[hour (ISO, UTC), price], …]}."""
    out: dict[str, list] = {}
    for wish in watch:
        hourly: dict[str, float] = {}
        for row in history.get(wish["blueprint_id"], []):
            listing = deals.Listing(0, row["min_price"], row["condition"], row["language"], row["foil"], row["zero"], "", 1)
            if deals.fits(listing, wish):
                hour = row["checked_at"].replace(minute=0, second=0, microsecond=0).isoformat()
                hourly[hour] = min(hourly.get(hour, row["min_price"]), row["min_price"])
        if hourly:
            out[deals.wish_key(wish)] = [[h, p] for h, p in sorted(hourly.items())]
    return out
