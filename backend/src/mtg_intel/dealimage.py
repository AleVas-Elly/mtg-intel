"""One designed image per deal alert (D53): the card, and next to it what makes it a deal.

Drawn in the deal check with Pillow, in the site's typeface (Figtree, `assets/`, SIL Open Font
License) and the site's dark colours. Telegram shows a photo at the width of the chat bubble, so
the image is tall (4:5) and its type is large: the smallest line is about 3% of the width.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from mtg_intel import deals

FONT = Path(__file__).parent / "assets" / "figtree.woff2"
W = 1080  # px; height follows the content
PAD = 56
S = 2  # drawn at twice the size, then scaled down for smooth edges

INK, MUTED, LINE, BG = "#f5f5f7", "#a1a1aa", "#3a3a3c", "#1c1c1e"
GOOD, BAD = "#2fcf96", "#ff8a80"
# The site's dark tier colours (frontend styles.css), by the tier's base %: background, text.
TIER_COLOURS = {20.0: ("#2a2150", "#c3b4ff"), 30.0: ("#5b3fd6", "#ffffff"), 40.0: ("#a58cff", "#170a3d")}
TARGET_COLOURS = ("#3a3a3c", INK)
CONDITION_NAMES = {"NM": "Near Mint", "SP": "Slightly Played", "MP": "Moderately Played", "PL": "Played", "PO": "Poor"}
LANGUAGE_NAMES = {"en": "English", "ja": "Japanese", "jp": "Japanese", "it": "Italian", "fr": "French", "de": "German",
                  "es": "Spanish", "pt": "Portuguese", "ko": "Korean", "ru": "Russian", "zhs": "Chinese",
                  "zh-cn": "Chinese", "zht": "Chinese (trad.)", "zh-tw": "Chinese (trad.)"}
COUNTRIES = {"IT": "Italy", "DE": "Germany", "FR": "France", "ES": "Spain", "NL": "the Netherlands", "BE": "Belgium",
             "AT": "Austria", "PT": "Portugal", "PL": "Poland", "IE": "Ireland", "LU": "Luxembourg", "DK": "Denmark",
             "SE": "Sweden", "FI": "Finland", "CZ": "Czechia", "SK": "Slovakia", "SI": "Slovenia", "HR": "Croatia",
             "GR": "Greece", "HU": "Hungary", "RO": "Romania", "BG": "Bulgaria", "MT": "Malta", "CY": "Cyprus",
             "EE": "Estonia", "LV": "Latvia", "LT": "Lithuania", "GB": "the UK", "CH": "Switzerland", "US": "the US",
             "JP": "Japan"}


@dataclass
class Panel:
    """What the image says, worked out from a deal (kept apart from drawing, so it can be tested)."""

    pill: str
    tier_pct: float | None
    name: str
    printing: str
    copy: str
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
    printing = " · ".join(p for p in [w.get("set_name") or "", deals.version_line(deal)[0]] if p)
    grade = deals.CONDITION_GRADE.get(x.condition, "")
    copy = " · ".join(p for p in [CONDITION_NAMES.get(grade, x.condition), LANGUAGE_NAMES.get(x.language, x.language.upper()),
                                  "Foil" if x.foil else "Non-foil", "Zero" if x.zero else ""] if p)
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
    footer = " · ".join(p for p in [f"Seller in {COUNTRIES.get(x.country, x.country)}" if x.country else "",
                                    f"{w['list']} list" if w.get("list") else ""] if p)
    return Panel(pill, deal.tier[0] if deal.tier else None, deals.front_name(w["name"]), printing, copy,
                 f"€{x.price:.2f}", saving, markets, footer)


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
    """The image as PNG bytes."""
    img = Image.new("RGB", (W * S, 2000 * S), BG)
    draw = ImageDraw.Draw(img)

    # The card on the left, with Magic's rounded corners and a soft shadow.
    cw = 430 * S
    ch = round(cw * card.height / card.width)
    art = card.convert("RGB").resize((cw, ch), Image.LANCZOS)
    radius = round(cw * 0.047)
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw - 1, ch - 1), radius=radius, fill=255)
    x0 = y0 = PAD * S
    shadow = Image.new("L", img.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + 14 * S, x0 + cw, y0 + ch + 14 * S), radius=radius, fill=160)
    img.paste(Image.new("RGB", img.size, "#000000"), (0, 0), shadow.filter(ImageFilter.GaussianBlur(20 * S)))
    img.paste(art, (x0, y0), mask)

    # Beside it: the strength, the card and the copy.
    x = x0 + cw + 44 * S
    width = W - (x // S) - PAD
    y = y0 + 6 * S
    bg, ink = TIER_COLOURS.get(p.tier_pct, TARGET_COLOURS) if p.tier_pct else TARGET_COLOURS
    pill = _font(30, 750)
    pw = draw.textlength(p.pill, font=pill) + 44 * S
    draw.rounded_rectangle((x, y, x + pw, y + 58 * S), radius=29 * S, fill=bg)
    draw.text((x + 22 * S, y + 29 * S), p.pill, font=pill, fill=ink, anchor="lm")
    y += 92 * S
    name = _font(56, 750)
    for line in _wrap(draw, p.name, name, width, 4):
        draw.text((x, y), line, font=name, fill=INK)
        y += 66 * S
    y += 18 * S
    small = _font(34, 450)
    for text in (p.printing, p.copy):
        for line in _wrap(draw, text, small, width, 3, sep=" · "):
            draw.text((x, y), line, font=small, fill=MUTED)
            y += 44 * S
        y += 12 * S

    # Under it, full width: the price, then each market against its own usual price.
    x = x0
    full = (W - 2 * PAD) * S
    y = max(y, y0 + ch) + 52 * S
    big = _font(150, 800)
    draw.text((x, y), p.price, font=big, fill=INK, anchor="lt")
    px = x + draw.textlength(p.price, font=big) + 32 * S
    side = _font(38, 650)
    if px + draw.textlength(p.saving, font=side) <= x + full:
        draw.text((px, y + 52 * S), p.saving, font=side, fill=GOOD, anchor="ls")
        draw.text((px, y + 104 * S), "on CardTrader", font=_font(34, 450), fill=MUTED, anchor="ls")
        y += 170 * S
    else:  # a long price or saving: the saving goes under the price
        y += 170 * S
        draw.text((x, y), p.saving, font=side, fill=GOOD)
        draw.text((x, y + 52 * S), "on CardTrader", font=_font(34, 450), fill=MUTED)
        y += 116 * S
    label, text, pct = _font(36, 750), _font(36, 450), _font(36, 750)
    for market, prices, under in p.markets:
        y += 8 * S
        draw.line((x, y, x + full, y), fill=LINE, width=2 * S)
        y += 30 * S
        draw.text((x, y), market, font=label, fill=INK)
        draw.text((x + 250 * S, y), prices, font=text, fill=MUTED)
        if under:
            draw.text((x + full, y), under, font=pct, fill=GOOD if under.startswith("−") else BAD, anchor="ra")
        y += 62 * S
    if p.footer:
        y += 28 * S
        draw.text((x, y), p.footer, font=_font(30, 450), fill=MUTED)
        y += 40 * S
    y += PAD * S

    out = io.BytesIO()
    img.crop((0, 0, W * S, y)).resize((W, y // S), Image.LANCZOS).save(out, "PNG", optimize=True)
    return out.getvalue()


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
