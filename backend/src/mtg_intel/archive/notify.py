"""Phone alerts (D43): Telegram when a bot is configured, ntfy otherwise.

Telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; ntfy needs only NTFY_TOPIC
(https://ntfy.sh, no account: the topic name is the address).
"""

from __future__ import annotations

import os

import httpx

NTFY_URL = "https://ntfy.sh"
TELEGRAM_API = "https://api.telegram.org"


def alert(client: httpx.Client, title: str, message: str) -> bool:
    """Send to whichever channel is configured. Never raises."""
    token, chat_id = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat_id:
        return send_telegram(client, token, chat_id, f"{title}\n\n{message}")
    return send_alert(client, os.environ.get("NTFY_TOPIC"), title, message)


def send_telegram(client: httpx.Client, token: str, chat_id: str, text: str) -> bool:
    try:
        response = client.post(
            f"{TELEGRAM_API}/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text[:4096]},
            timeout=20,
        )
        response.raise_for_status()
        return True
    except httpx.HTTPError:
        return False


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
