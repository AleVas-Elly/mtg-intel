// The Drop (D57, D66): each deal is a flat field in its card's own mana colour: a white card on a
// white field, a blue card on blue, and a multicolour card split into halves (three or more in
// stripes). The fields are darker and less saturated than the mana symbols, so the page stays calm.
import { useEffect, useState } from "preact/hooks";
import { costColours } from "./filters";

// The sampled colours of the old version (art-colours-v1/v2) are no longer used.
try { for (const k of ["art-colours-v1", "art-colours-v2"]) localStorage.removeItem(k); } catch { /* private window */ }

/** The art crop of a Scryfall card picture (any size), or null for pictures from elsewhere. */
export function artUrl(src: string | null | undefined): string | null {
  if (!src || !src.includes("cards.scryfall.io")) return null;
  return src.replace(/\/(small|normal|large|png|border_crop)\//, "/art_crop/").replace(/\.png(\?|$)/, ".jpg$1");
}

/** Each mana colour as a field: its hue, desaturated and darkened. White stays a light stone so it reads as white. */
const FIELD: Record<string, string> = {
  W: "hsl(42 12% 80%)",
  U: "hsl(212 34% 29%)",
  B: "hsl(265 8% 17%)",
  R: "hsl(6 38% 31%)",
  G: "hsl(146 24% 26%)",
  C: "hsl(215 4% 34%)",
};
// A card of several colours: calmer, closer in lightness (white is a mid warm grey, so white type reads on every
// stop), and blended into each other, so the field reads as one object, not as stripes of mana colours.
const MULTI: Record<string, string> = {
  W: "hsl(40 9% 44%)",
  U: "hsl(212 26% 32%)",
  B: "hsl(265 7% 21%)",
  R: "hsl(6 28% 34%)",
  G: "hsl(146 18% 29%)",
};
const LIGHT = new Set(["W"]);  // single-colour fields that take dark type

/** The inline custom properties of a card's field, from its printed mana cost (both faces joined by //). */
export function fieldStyle(cost: string | null | undefined): Record<string, string> {
  const order = "WUBRG";
  const cs = costColours(cost ?? null).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const names = cs.length ? cs : ["C"];
  const n = names.length;
  const cols = names.map((c) => (n > 1 ? MULTI : FIELD)[c]);
  // each colour is centred in its share of the diagonal and fades into the next (the ends stay flat)
  const background = n === 1 ? cols[0] : `linear-gradient(135deg in oklab, ${cols
    .map((c, i) => `${c} ${(10 + (80 * i) / (n - 1)).toFixed(1)}%`).join(", ")})`;
  const dark = n === 1 && LIGHT.has(names[0]);
  const on = dark ? "#121211" : "#ffffff";
  return {
    "--f": cols[0],          // one colour: the field; the first colour of a split card
    "--f-end": cols[n - 1],  // the last colour: what a tall pane shows below the end of the gradient
    "--fbg": background,      // what the field is painted with
    "--on-f": on,             // type on the field
    "--off-f": dark ? "#ffffff" : "#121211",  // a pill or button on the field (the inverse)
  };
}

/** A clock that ticks every `ms`. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export const CHECK_EVERY_MIN = 10;
export const STALE_MIN = 25;

/** Where the CardTrader checks stand: minutes since the last one, time to the next. */
export function checkState(at: string | null | undefined, now: number) {
  if (!at) return null;
  const since = (now - new Date(at).getTime()) / 60e3;
  const stale = since > STALE_MIN;
  const left = Math.max(0, CHECK_EVERY_MIN * 60 - (since * 60) % (CHECK_EVERY_MIN * 60));
  const due = since >= CHECK_EVERY_MIN;  // a check should have landed: it is running or late
  return { since, stale, due, left, fraction: due ? 1 : 1 - left / (CHECK_EVERY_MIN * 60) };
}

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
