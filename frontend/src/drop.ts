// The Drop (D57): each card brings a flat colour field taken from its own art. The colour is
// sampled once per picture in the browser (Scryfall's image CDN allows it) and remembered.
import { useEffect, useState } from "preact/hooks";

const KEY = "art-colours-v1";
const colours: Record<string, string> = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
})();
let saveTimer: number | undefined;
const remember = (src: string, colour: string) => {
  colours[src] = colour;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const keys = Object.keys(colours);
      // keep the newest few hundred
      for (const k of keys.slice(0, Math.max(0, keys.length - 600))) delete colours[k];
      localStorage.setItem(KEY, JSON.stringify(colours));
    } catch { /* fine */ }
  }, 400);
};

/** The art crop of a Scryfall card picture (any size), or null for pictures from elsewhere. */
export function artUrl(src: string | null | undefined): string | null {
  if (!src || !src.includes("cards.scryfall.io")) return null;
  return src.replace(/\/(small|normal|large|png|border_crop)\//, "/art_crop/").replace(/\.png(\?|$)/, ".jpg$1");
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** The deep field colour for a picture: its strongest hue family, darkened so white type reads on it. */
function fieldOf(img: HTMLImageElement): string {
  const w = 32, h = 24;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const buckets = Array.from({ length: 12 }, () => ({ score: 0, h: 0, s: 0, n: 0 }));
  let greyL = 0, greyN = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [hue, sat, lig] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    if (sat < 0.12 || lig < 0.08 || lig > 0.93) { greyL += lig; greyN++; continue; }
    const b = buckets[Math.floor(hue / 30) % 12];
    const weight = sat * (lig > 0.15 && lig < 0.75 ? 1 : 0.4);
    b.score += weight; b.h += hue * weight; b.s += sat * weight; b.n += weight;
  }
  const best = buckets.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score < (w * h) * 0.04) return `hsl(${Math.round(best.n ? best.h / best.n : 220)} 8% 18%)`;
  const hue = Math.round(best.h / best.n);
  const sat = Math.min(0.78, Math.max(0.28, (best.s / best.n) * 1.15 + 0.08));
  return `hsl(${hue} ${Math.round(sat * 100)}% 21%)`;
}

const waiting = new Map<string, Promise<string | null>>();
function sample(src: string): Promise<string | null> {
  if (colours[src]) return Promise.resolve(colours[src]);
  let p = waiting.get(src);
  if (!p) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    p = img.decode().then(() => {
      const c = fieldOf(img);
      remember(src, c);
      return c;
    }, () => null).finally(() => waiting.delete(src));
    waiting.set(src, p);
  }
  return p;
}

/** The colour field for a card picture; null until it is known (the drop shows its neutral field). */
export function useArtColour(image: string | null | undefined): string | null {
  const src = artUrl(image);
  const [colour, setColour] = useState<string | null>(() => (src ? colours[src] ?? null : null));
  useEffect(() => {
    if (!src) return setColour(null);
    if (colours[src]) return setColour(colours[src]);
    let live = true;
    sample(src).then((c) => { if (live) setColour(c); });
    return () => { live = false; };
  }, [src]);
  return colour;
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
