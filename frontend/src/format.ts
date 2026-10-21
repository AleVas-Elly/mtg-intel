import type { Deal, LiveWish, Wish } from "./types";

const euro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });
export const eur = (v: number | null | undefined) => (v == null ? "–" : euro.format(v));

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const LANG_SHORT: Record<string, string> = { ja: "JP", jp: "JP", any: "Any language", zhs: "ZH", zht: "ZH" };
export const langShort = (code: string) => LANG_SHORT[code] ?? code.toUpperCase();

const LANG_NAME: Record<string, string> = {
  en: "English", ja: "Japanese", jp: "Japanese", any: "Any language", it: "Italian", fr: "French", de: "German",
  es: "Spanish", pt: "Portuguese", ko: "Korean", ru: "Russian", zhs: "Chinese", zht: "Chinese",
};
export const langName = (code: string) => LANG_NAME[code] ?? code.toUpperCase();

const COND: Record<string, string> = { NM: "Near Mint", SP: "Slightly Played", MP: "Moderately Played", PL: "Played", PO: "Poor" };
export const condName = (c: string) => COND[c] ?? c;

const TAGS: Record<string, string> = {
  extendedart: "extended art", fullart: "full art", retroframe: "retro frame", galaxyfoil: "galaxy foil",
  surgefoil: "surge foil", halofoil: "halo foil", confettifoil: "confetti foil", raisedfoil: "raised foil",
  doublerainbow: "double rainbow", neonink: "neon ink", oilslick: "oil slick", stepandcompleat: "step-and-compleat",
  rainbowfoil: "rainbow foil", fracturefoil: "fracture foil", manafoil: "mana foil", ripplefoil: "ripple foil",
};
export const tagName = (t: string) => TAGS[t] ?? t;
export const versionText = (w: Wish) => (w.tags.length ? w.tags.map(tagName).join(", ") : "regular");

/** The card's own collector line: SET · number · language · version. */
export function collectorLine(w: Wish): string {
  if (!w.set) return w.ct ? `CardTrader only, ${w.ct.expansion ?? ""} #${w.ct.number ?? ""}` : "No exact version";
  // as printed on the card: set and language joined by a bullet
  return `${versionText(w)}, ${w.set.toUpperCase()} ${w.number} • ${langShort(w.language)}`;
}

export function wishLine(w: Wish): string {
  const foil = w.foil === "yes" ? "Foil" : w.foil === "no" ? "Non-foil" : "Foil or not";
  return [`${w.condition} or better`, foil.toLowerCase(), w.zero ? "via Zero" : "any seller"].join(", ");
}

export const foilOnly = (w: Wish) => w.finishes.length > 0 && !w.finishes.includes("nonfoil");
export const showsFoil = (w: Wish) => w.foil === "yes" || foilOnly(w);

/** The Cardmarket trend for the finish the wish is about (a foil-only card always uses foil). */
export function cmTrend(w: Wish, foil?: boolean): number | null {
  const f = foilOnly(w) || (w.foil === "yes") || (foil ?? showsFoil(w));
  const v = f ? w.cm.trend_foil : w.cm.trend;
  if (v) return v;
  if (w.foil === "any" && !foilOnly(w)) return w.cm.trend || w.cm.trend_foil || null;
  return null;
}

export const TIERS: Record<number, { label: string; cls: string }> = {
  40: { label: "Steal", cls: "t3" },
  30: { label: "Great deal", cls: "t2" },
  20: { label: "Good deal", cls: "t1" },
};
export const tierOf = (d: Deal) => (d.tier ? TIERS[d.tier] : null);

/** Live data checks that need the CardTrader side. */
export function liveFlags(w: Wish, live: LiveWish | undefined): { code: string; text: string }[] {
  const out = [];
  const cm = cmTrend(w, live?.foil);
  if (live && cm && (live.price / cm > 2.5 || live.price / cm < 0.4)) {
    out.push({ code: "markets_apart", text: `CardTrader's cheapest (${eur(live.price)}) and Cardmarket's trend (${eur(cm)}) are far apart.` });
  }
  return out;
}

export const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};
