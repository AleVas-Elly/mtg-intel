"""Phone alerts (D43): Telegram when a bot is configured, ntfy otherwise.

Telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; ntfy needs only NTFY_TOPIC
(https://ntfy.sh, no account: the topic name is the address).
"""

from __future__ import annotations

import os

import httpx

NTFY_URL = "https://ntfy.sh"
TELEGRAM_API = "https://api.telegram.org"


def alert(client: httpx.Client, title: str, message: str,
          telegram: tuple[str, list[list[dict[str, str]]], str | None] | None = None) -> bool:
    """Send to whichever channel is configured. Never raises. `telegram` is a richer version for
    Telegram (HTML text, buttons such as a deal's "Bought it", a link to preview small beside the
    text); ntfy gets title and message."""
    token, chat_id = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat_id:
        if telegram and send_telegram(client, token, chat_id, telegram[0], html=True, buttons=telegram[1],
                                      preview=telegram[2] if len(telegram) > 2 else None):
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
