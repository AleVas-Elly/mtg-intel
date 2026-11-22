"""Phone alerts. The app (D88): every alert goes to the site's Alerts page, which rings my devices;
needs SITE_URL and SITE_INGEST_TOKEN. ntfy is the backup when the site can't take an alert; needs
only NTFY_TOPIC (https://ntfy.sh, no account). Telegram (D43) was switched off on 2026-11-22.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import httpx


@dataclass
class Rich:
    """The rich version of an alert for the Alerts page: HTML text, buttons, and a deal's caption
    and picture (D53, D88)."""

    html: str
    buttons: list[list[dict[str, str]]] = field(default_factory=list)
    caption: str | None = None
    stamps: dict[str, str] | None = None  # done versions of the picture (bought, sold): their URLs on the site
    head: str = ""  # the caption's first line (HTML), kept so a live alert can be redrawn (D54)
    details: str = ""  # the caption's quote behind a tap (HTML)
    links: list[dict[str, str]] = field(default_factory=list)  # the marketplace and site buttons
    tip: str = ""  # one line on timing: buy now, could drop (D55)
    picture: str | None = None  # the photo's URL on the site, for the Alerts page (D88)

NTFY_URL = "https://ntfy.sh"


SECTIONS = ("deals", "digest", "system")


def app_buttons(rows: list[list[dict[str, str]]] | None) -> list[list[dict[str, str]]]:
    """Buttons for the Alerts page: links stay links, a callback becomes an action."""
    return [[{"text": b["text"], "url": b["url"]} if b.get("url") else {"text": b["text"], "action": b.get("callback_data", "")}
             for b in row] for row in rows or []]


def to_app(client: httpx.Client, section: str, title: str, body: str = "", *, html: str | None = None,
           id: str | None = None, picture: str | None = None, buttons: list[list[dict[str, str]]] | None = None,
           done: bool | None = None, ping: bool = True, deal: dict | None = None) -> bool:
    """Store an alert on the site's Alerts page (or update the one with this id) and, with `ping`,
    ring my devices (each device's settings decide whether it rings, D88). `deal`: a deal's `rank`
    (3 Steal … 0 target), `card` (wish key) and `price`, for those settings and snoozes. Whether the
    site took it. Never raises."""
    url, token = os.environ.get("SITE_URL"), os.environ.get("SITE_INGEST_TOKEN")
    if not url or not token:
        return False
    assert section in SECTIONS, section
    doc = {"section": section, "title": title[:200], "body": body[:3000], "ping": ping,
           **{k: v for k, v in {"id": id, "html": html, "picture": picture, "buttons": buttons, "done": done}.items()
              if v is not None}, **(deal or {})}
    try:
        response = client.post(f"{url.rstrip('/')}/api/ingest/alert", json=doc, timeout=20,
                               headers={"Authorization": f"Bearer {token}", "User-Agent": "mtg-intel"})
        response.raise_for_status()
        return True
    except httpx.HTTPError:
        return False


def alert(client: httpx.Client, title: str, message: str, rich: Rich | None = None, section: str = "system",
          app_id: str | None = None, ping: bool = True, deal: dict | None = None) -> bool:
    """Send to the app, in its section (the rich version's text, picture and buttons when there is
    one); ntfy gets title and message when the site didn't take it. Never raises."""
    to_page = to_app(client, section, title, _plain(rich.head) if rich and rich.head else message,
                     html=(rich.caption or rich.html) if rich else None, id=app_id,
                     picture=rich.picture if rich else None, buttons=app_buttons(rich.buttons) if rich else None,
                     ping=ping, deal=deal)  # whether it rings: each device's settings (night: only Steals, by default)
    return to_page or send_alert(client, os.environ.get("NTFY_TOPIC"), title, message)


def _plain(html_text: str) -> str:
    import html
    import re

    return html.unescape(re.sub(r"<[^>]+>", "", html_text))


def send_alert(client: httpx.Client, topic: str | None, title: str, message: str) -> bool:
    """Post to ntfy. Never raises: a failed alert must not hide the original problem."""
    if not topic:
        return False
    try:
        response = client.post(
            f"{NTFY_URL}/{topic}",
            content=message.encode(),
            headers={"Title": title, "Priority": "high", "Tags": "warning"},
            timeout=20,
        )
        response.raise_for_status()
        return True
    except httpx.HTTPError:
        return False


def problem_alert(state: dict[str, Any], problems: list[str], now: datetime, name: str = "deal check",
                  realert: timedelta = timedelta(hours=6), key: str | None = None) -> tuple[str, str] | None:
    """The alert to send about a job's problems, if any: the first time, again after `realert` while
    it lasts or as soon as `key` (which problems) changes, and once when it is over. Remembered in
    `state["problem"]`, so an outage is one message, not one per run."""
    last = state.get("problem")
    if problems:
        text = "\n".join(problems)
        if last and now - datetime.fromisoformat(last["at"]) < realert and last.get("key") == key:
            return None
        state["problem"] = {"at": now.isoformat(), "since": (last or {}).get("since", now.isoformat()),
                            "text": text, "key": key}
        return f"mtg-intel {name} needs a look", text
    if last:
        del state["problem"]
        return f"mtg-intel {name} is fine again", f"The problem seen since {last['since']} is gone."
    return None
