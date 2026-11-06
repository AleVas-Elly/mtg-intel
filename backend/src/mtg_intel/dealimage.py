"""One designed image per deal alert (D53): the card, and next to it what makes it a deal.

Drawn in the deal check with Pillow, in the site's typeface (Figtree, `assets/`, SIL Open Font
License) and the site's dark colours. Telegram shows a photo at the width of the chat bubble, so
its type is large (the smallest line is about 2.5% of the width), and it is wider than tall.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from mtg_intel import deals

FONT = Path(__file__).parent / "assets" / "figtree.woff2"
W = 1080  # px; height follows the content, about 0.7 of the width
PAD = 48
CARD_H = 660  # px; the card is about 470 wide
S = 2  # drawn at twice the size, then scaled down for smooth edges

INK, MUTED, LINE, BG = "#f5f5f7", "#a1a1aa", "#3a3a3c", "#1c1c1e"
GOOD, BAD = "#2fcf96", "#ff8a80"
# The site's dark tier colours (frontend styles.css), by the tier's base %: background, text.
TIER_COLOURS = {20.0: ("#2a2150", "#c3b4ff"), 30.0: ("#5b3fd6", "#ffffff"), 40.0: ("#a58cff", "#170a3d")}
TARGET_COLOURS = ("#3a3a3c", INK)


@dataclass
class Panel:
    """What the image says, worked out from a deal (kept apart from drawing, so it can be tested)."""

    pill: str
    tier_pct: float | None
    name: str
    price: str
    saving: str
    markets: list[tuple[str, str, str]]  # market, its prices, how far under its usual
    footer: str


def panel(deal: deals.Deal) -> Panel:
    w, x = deal.wish, deal.listing
    if deal.tier:
        pill = f"{deal.tier[1].split(' ', 1)[1]} · {deal.below_pct:.0f}% under".upper()
        saving = f"€{deal.reference - x.price:.2f} less than usual" if deal.reference else ""
    else:
        pill = "TARGET PRICE"
        saving = f"at or under your €{w['max_price_eur']:.2f} target" if w.get("max_price_eur") is not None else ""
    markets = []
    if deal.cardtrader:
        usual = "usually" if deal.cardtrader_kind == "usual price" else "next copy"
        markets.append(("CardTrader", f"{usual} €{deal.cardtrader:.2f}", deals._less(x.price, deal.cardtrader)))
    if deal.cardmarket:
        foil = x.foil or (bool(w.get("finishes")) and "nonfoil" not in w["finishes"])
        low = w.get("low_foil" if foil else "low")
        if not deal.cardmarket_trusted:
            markets.append(("Cardmarket", f"trend €{deal.cardmarket:.2f} looks wrong", ""))
        elif low:
            markets.append(("Cardmarket", f"from €{low:.2f} · trend €{deal.cardmarket:.2f}", deals._less(low, deal.cardmarket)))
        else:
            markets.append(("Cardmarket", f"trend €{deal.cardmarket:.2f}", deals._less(x.price, deal.cardmarket)))
    footer = " · ".join(p for p in [f"Seller in {deals.COUNTRIES.get(x.country, x.country)}" if x.country else "",
                                    f"{w['list']} list" if w.get("list") else ""] if p)
    return Panel(pill, deal.tier[0] if deal.tier else None, deals.front_name(w["name"]), f"€{x.price:.2f}", saving,
                 markets, footer)


def _font(size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONT), size * S)
    f.set_variation_by_axes([weight])
    return f


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int, lines: int,
          sep: str = " ") -> list[str]:
    """Lines no wider than `width`, broken between words (or between " · " items with `sep`)."""
    out, line = [], ""
    for word in text.split(sep):
        trial = f"{line}{sep}{word}" if line else word
        if line and draw.textlength(trial, font=font) > width * S:
            out.append(line)
            line = word
        else:
            line = trial
    out.append(line)
    if len(out) > lines:
        out = out[:lines]
        while out[-1] and draw.textlength(out[-1] + "…", font=font) > width * S:
            out[-1] = out[-1][:-1]
        out[-1] = out[-1].rstrip(" ·,") + "…"
    return out


def render(p: Panel, card: Image.Image) -> bytes:
    """The image as PNG bytes: the card on the left, everything else in one column beside it.
    Wider than tall, so Telegram shows it at the bubble's full width (a taller one gets bars at
    the sides; user, 2026-11-06)."""
    img = Image.new("RGB", (W * S, 2000 * S), BG)
    draw = ImageDraw.Draw(img)
    ch = CARD_H * S
    cw = round(ch * card.width / card.height)

    # The column beside the card: strength, name, price and saving, then each market against its own
    # usual price. Drawn first, so the image can grow when a long name needs more lines.
    x = (PAD + 44) * S + cw
    width = W - (x // S) - PAD
    right = x + width * S
    y = PAD * S
    bg, ink = TIER_COLOURS.get(p.tier_pct, TARGET_COLOURS) if p.tier_pct else TARGET_COLOURS
    pill = _font(28, 750)
    pw = draw.textlength(p.pill, font=pill) + 40 * S
    draw.rounded_rectangle((x, y, x + pw, y + 54 * S), radius=27 * S, fill=bg)
    draw.text((x + 20 * S, y + 27 * S), p.pill, font=pill, fill=ink, anchor="lm")
    y += 80 * S
    name = _font(50, 750)
    for line in _wrap(draw, p.name, name, width, 3):
        draw.text((x, y), line, font=name, fill=INK)
        y += 60 * S
    y += 18 * S
    size = 120
    while size > 64 and draw.textlength(p.price, font=_font(size, 800)) > width * S:
        size -= 6
    draw.text((x, y), p.price, font=_font(size, 800), fill=INK)
    y += round(size * 1.1) * S
    side = _font(34, 650)
    for line in _wrap(draw, p.saving, side, width, 2):
        draw.text((x, y), line, font=side, fill=GOOD)
        y += 44 * S
    label, prices = _font(32, 750), _font(29, 450)
    for market, text, under in p.markets:
        y += 16 * S
        draw.line((x, y, right, y), fill=LINE, width=2 * S)
        y += 18 * S
        draw.text((x, y), market, font=label, fill=INK)
        if under:
            draw.text((right, y), under, font=label, fill=GOOD if under.startswith("−") else BAD, anchor="ra")
        y += 42 * S
        for line in _wrap(draw, text, prices, width, 2, sep=" · "):
            draw.text((x, y), line, font=prices, fill=MUTED)
            y += 38 * S
    if p.footer:
        y += 18 * S
        for line in _wrap(draw, p.footer, _font(26, 450), width, 2, sep=" · "):
            draw.text((x, y), line, font=_font(26, 450), fill=MUTED)
            y += 34 * S
    height = max(y + PAD * S, ch + 2 * PAD * S)

    # The card, centred top to bottom, with Magic's rounded corners and a soft shadow.
    art = card.convert("RGB").resize((cw, ch), Image.LANCZOS)
    radius = round(cw * 0.047)
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=radius, fill=255)
    x0, y0 = PAD * S, (height - ch) // 2
    shadow = Image.new("L", img.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + 14 * S, x0 + cw, y0 + ch + 14 * S), radius=radius, fill=160)
    img.paste(Image.new("RGB", img.size, "#000000"), (0, 0), shadow.filter(ImageFilter.GaussianBlur(20 * S)))
    img.paste(art, (x0, y0), mask)

    out = io.BytesIO()
    img.crop((0, 0, W * S, height)).resize((W, height // S), Image.LANCZOS).save(out, "PNG", optimize=True)
    return out.getvalue()


def stamp(png: bytes, kind: str, note: str = "") -> bytes:
    """The alert's image once it is done (user, 2026-11-06): darkened, with a large ✓ BOUGHT stamp,
    or grey and darkened with a SOLD stamp when the copy turned out to be gone. JPEG, for Telegram."""
    base = Image.open(io.BytesIO(png)).convert("RGB")
    if kind == "sold":
        base = base.convert("L").convert("RGB")
    w, h = base.size
    img = Image.blend(base, Image.new("RGB", base.size, "#000000"), 0.62 if kind == "sold" else 0.55).resize((w * S, h * S))
    r = 120 * S
    cx, cy = w * S // 2, h * S // 2 - 70 * S
    glow = Image.new("L", img.size, 0)  # a soft dark patch behind the stamp, so its words stay readable
    ImageDraw.Draw(glow).ellipse((cx - 420 * S, cy - 230 * S, cx + 420 * S, cy + 360 * S), fill=170)
    img.paste(Image.new("RGB", img.size, "#000000"), (0, 0), glow.filter(ImageFilter.GaussianBlur(70 * S)))
    draw = ImageDraw.Draw(img)
    colour = GOOD if kind == "bought" else "#d4d4d8"
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=colour)
    ink, width = "#0b2e22" if kind == "bought" else "#27272a", 26 * S
    if kind == "bought":  # a tick
        draw.line([(cx - 58 * S, cy + 4 * S), (cx - 14 * S, cy + 50 * S), (cx + 64 * S, cy - 44 * S)], fill=ink, width=width, joint="curve")
    else:  # a cross
        for a, b in (((-50, -50), (50, 50)), ((-50, 50), (50, -50))):
            draw.line([(cx + a[0] * S, cy + a[1] * S), (cx + b[0] * S, cy + b[1] * S)], fill=ink, width=width)
    title = _font(76, 800)
    draw.text((cx, cy + r + 34 * S), "BOUGHT" if kind == "bought" else "SOLD", font=title, fill="#ffffff", anchor="mt")
    if note:
        draw.text((cx, cy + r + 128 * S), note, font=_font(38, 550), fill="#e4e4e7", anchor="mt")
    out = io.BytesIO()
    img.resize((w, h), Image.LANCZOS).save(out, "JPEG", quality=86, optimize=True)
    return out.getvalue()


def stamps(png: bytes, price: str) -> dict[str, bytes]:
    """Both done versions of a deal's image, for the bot to swap in (bought, or gone before buying)."""
    return {"bought": stamp(png, "bought", price), "sold": stamp(png, "sold", "Gone before you could buy it")}


def card_picture(client: httpx.Client, image_url: str | None) -> Image.Image | None:
    """Scryfall's picture of the card (their CDN, which allows this), or None."""
    if not image_url or not image_url.startswith("https://cards.scryfall.io/"):
        return None
    try:
        response = client.get(image_url.replace("/normal/", "/large/"), timeout=20,
                              headers={"User-Agent": "mtg-intel", "Accept": "image/*"})
        response.raise_for_status()
        return Image.open(io.BytesIO(response.content))
    except (httpx.HTTPError, OSError):
        return None


def deal_image(client: httpx.Client, deal: deals.Deal) -> bytes | None:
    """The deal's image, or None (no picture, or drawing failed): the alert then goes as text."""
    card = card_picture(client, deal.wish.get("image_url"))
    if card is None:
        return None
    try:
        return render(panel(deal), card)
    except (OSError, ValueError):
        return None
