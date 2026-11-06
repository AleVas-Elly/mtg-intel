"""Phone alerts (D43): Telegram when a bot is configured, ntfy otherwise.

Telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; ntfy needs only NTFY_TOPIC
(https://ntfy.sh, no account: the topic name is the address).
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

NTFY_URL = "https://ntfy.sh"
TELEGRAM_API = "https://api.telegram.org"


def alert(client: httpx.Client, title: str, message: str, telegram: Rich | None = None) -> bool:
    """Send to whichever channel is configured. Never raises. Telegram gets the richer version when
    there is one (the photo, else the HTML text), the plain text if Telegram refuses both; ntfy
    gets title and message."""
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
    return send_alert(client, os.environ.get("NTFY_TOPIC"), title, message)


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
