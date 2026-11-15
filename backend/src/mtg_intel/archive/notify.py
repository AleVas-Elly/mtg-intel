"""Phone alerts. The app (D88): every alert goes to the site's Alerts page, which rings my devices;
needs SITE_URL and SITE_INGEST_TOKEN. Telegram (D43) runs alongside until it is switched off; needs
TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. ntfy is the backup for system alerts when the site can't
take them (or no other channel is set up); needs only NTFY_TOPIC (https://ntfy.sh, no account).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import httpx


@dataclass
class Rich:
    """A richer Telegram version of an alert: HTML text, buttons, and either a link to preview small
    above the text or a photo with a short caption (a deal's image, D53)."""

    html: str
    buttons: list[list[dict[str, str]]] = field(default_factory=list)
    preview: str | None = None
    photo: bytes | None = None
    caption: str | None = None
    stamps: dict[str, str] | None = None  # done versions of the photo (bought, sold): their URLs on the site
    message_id: int | None = None  # set once sent
    head: str = ""  # the caption's first line (HTML), kept so a live alert can be redrawn (D54)
    details: str = ""  # the caption's quote behind a tap (HTML)
    links: list[dict[str, str]] = field(default_factory=list)  # the marketplace and site buttons
    silent: bool = False  # arrives without ringing
    tip: str = ""  # one line on timing: buy now, could drop (D55)
    picture: str | None = None  # the photo's URL on the site, for the Alerts page (D88)

NTFY_URL = "https://ntfy.sh"
TELEGRAM_API = "https://api.telegram.org"


SECTIONS = ("deals", "digest", "system")


def app_buttons(rows: list[list[dict[str, str]]] | None) -> list[list[dict[str, str]]]:
    """Telegram's buttons for the Alerts page: links stay links, a callback becomes an action."""
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


def alert(client: httpx.Client, title: str, message: str, telegram: Rich | None = None, section: str = "system",
          app_id: str | None = None, ping: bool = True, deal: dict | None = None) -> bool:
    """Send to every configured channel. Never raises. The app gets the alert in its section (the
    rich version's text, picture and buttons when there is one). Telegram gets the photo, else the
    HTML text, the plain text if it refuses both. ntfy gets title and message when nothing else
    took the alert, or the site didn't take a system alert (the backup when the site is down)."""
    rich = telegram
    to_page = to_app(client, section, title, _plain(rich.head) if rich and rich.head else message,
                     html=(rich.caption or rich.html) if rich else None, id=app_id,
                     picture=rich.picture if rich else None, buttons=app_buttons(rich.buttons) if rich else None,
                     ping=ping, deal=deal)  # whether it rings: each device's settings (night: only Steals, by default)
    sent = _telegram(client, title, message, rich)
    if (section == "system" and not to_page) or not (to_page or sent):
        sent = send_alert(client, os.environ.get("NTFY_TOPIC"), title, message) or sent
    return to_page or sent


def _plain(html_text: str) -> str:
    import html
    import re

    return html.unescape(re.sub(r"<[^>]+>", "", html_text))


def _telegram(client: httpx.Client, title: str, message: str, telegram: Rich | None) -> bool:
    token, chat_id = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat_id:
        if telegram and telegram.photo:
            sent = send_photo(client, token, chat_id, telegram.photo, telegram.caption or telegram.html, telegram.buttons,
                              silent=telegram.silent)
            if sent is not None:
                telegram.message_id = sent.get("message_id")
                return True
        if telegram:
            options = ({"url": telegram.preview, "prefer_small_media": True, "show_above_text": True} if telegram.preview
                       else {"is_disabled": True})
            body = {"chat_id": chat_id, "text": telegram.html[:4096], "parse_mode": "HTML", "link_preview_options": options,
                    "disable_notification": telegram.silent}
            if telegram.buttons:
                body["reply_markup"] = {"inline_keyboard": telegram.buttons}
            sent = telegram_call(client, token, "sendMessage", body)
            if sent is not None:
                telegram.message_id = sent.get("message_id")
                return True
        return send_telegram(client, token, chat_id, f"{title}\n\n{message}")
    return False


def send_telegram(client: httpx.Client, token: str, chat_id: str, text: str, html: bool = False,
                  buttons: list[list[dict[str, str]]] | None = None, preview: str | None = None) -> bool:
    """`preview`: a link shown as a small preview above the text (a deal's card picture)."""
    options = ({"url": preview, "prefer_small_media": True, "show_above_text": True} if preview
               else {"is_disabled": True})
    body: dict = {"chat_id": chat_id, "text": text[:4096], "link_preview_options": options}
    if html:
        body["parse_mode"] = "HTML"
    if buttons:
        body["reply_markup"] = {"inline_keyboard": buttons}
    return telegram_call(client, token, "sendMessage", body) is not None


def send_photo(client: httpx.Client, token: str, chat_id: str, png: bytes, caption: str,
               buttons: list[list[dict[str, str]]] | None = None, silent: bool = False) -> dict | None:
    """A photo with an HTML caption (at most 1024 characters) and buttons: the sent message, or
    None. Never raises."""
    data = {"chat_id": chat_id, "caption": caption[:1024], "parse_mode": "HTML"}
    if silent:
        data["disable_notification"] = "true"
    if buttons:
        data["reply_markup"] = json.dumps({"inline_keyboard": buttons})
    try:
        response = client.post(f"{TELEGRAM_API}/bot{token}/sendPhoto", data=data,
                               files={"photo": ("deal.png", png, "image/png")}, timeout=60)
        response.raise_for_status()
        return response.json().get("result") or {}
    except (httpx.HTTPError, ValueError):
        return None


def telegram_call(client: httpx.Client, token: str, method: str, body: dict) -> dict | None:
    """One Bot API call; its result, or None when it failed. Never raises."""
    try:
        response = client.post(f"{TELEGRAM_API}/bot{token}/{method}", json=body, timeout=20)
        response.raise_for_status()
        return response.json().get("result") or {}
    except (httpx.HTTPError, ValueError):
        return None


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
