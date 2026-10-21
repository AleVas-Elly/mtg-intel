// Design lab (3b): the look is a few named choices, set as attributes on <html> so the CSS can
// switch whole token sets. Kept in this browser only; the chosen set becomes the default later.
import { useEffect, useState } from "preact/hooks";

export interface Look { palette: string; type: string; motion: string; density: string; tiers: string }

export const DEFAULT: Look = { palette: "island", type: "system", motion: "lively", density: "comfortable", tiers: "gold" };

export const OPTIONS: { [K in keyof Look]: { id: string; label: string; mana?: string; hint: string }[] } = {
  palette: [
    { id: "silver", label: "Silver", mana: "C", hint: "Neutral grey, nothing tinted" },
    { id: "plains", label: "Plains", mana: "W", hint: "Warm white, sunlit" },
    { id: "island", label: "Island", mana: "U", hint: "Cool blue-grey, calm" },
    { id: "swamp", label: "Swamp", mana: "B", hint: "Dusky violet-grey" },
    { id: "mountain", label: "Mountain", mana: "R", hint: "Warm stone" },
    { id: "forest", label: "Forest", mana: "G", hint: "Soft sage" },
  ],
  type: [
    { id: "system", label: "System", hint: "Apple's own typeface on your devices" },
    { id: "figtree", label: "Figtree", hint: "Friendly and round" },
    { id: "serif", label: "Card serif", hint: "Titles and card names in a serif like the one printed on cards" },
  ],
  motion: [
    { id: "calm", label: "Calm", hint: "Things just appear: no flying card, foil stays still" },
    { id: "smooth", label: "Smooth", hint: "A tapped card flies into its page, lists fade in, foil shimmers slowly" },
    { id: "lively", label: "Lively", hint: "The card flies with a bounce, lists cascade in, cards tilt when touched, Steal badges shine" },
  ],
  density: [
    { id: "compact", label: "Compact", hint: "Small pictures, more cards per screen" },
    { id: "comfortable", label: "Comfortable", hint: "Balanced rows" },
    { id: "gallery", label: "Gallery", hint: "Big card pictures in a grid" },
  ],
  tiers: [
    { id: "green", label: "Green", hint: "The colour of saving money, like price drops and \u201ccheaper here\u201d" },
    { id: "gold", label: "Gold", hint: "Treasure gold; close to the rare set symbol" },
    { id: "rose", label: "Rose", hint: "Sale-tag pink-red" },
    { id: "violet", label: "Violet", hint: "Deal tiers in three violets" },
    { id: "ink", label: "Ink", hint: "Deal tiers in black and grey, no colour" },
  ],
};

const KEY = "look";
const subscribers = new Set<() => void>();

export function readLook(): Look {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEFAULT;
  }
}

const fonts: Record<string, () => Promise<unknown>> = {
  figtree: () => import("@fontsource-variable/figtree"),
  serif: () => import("@fontsource-variable/source-serif-4/opsz.css"),
};

export function applyLook(look: Look) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(look)) root.dataset[k] = v;
  fonts[look.type]?.().catch(() => {});  // a new version went live meanwhile: the system font stays
}

export function setLook(change: Partial<Look>) {
  const next = { ...readLook(), ...change };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* fine */ }
  const doc = document as unknown as { startViewTransition?: (f: () => void) => void };
  const run = () => { applyLook(next); subscribers.forEach((f) => f()); };
  doc.startViewTransition && next.motion !== "calm" ? doc.startViewTransition(run) : run();
}

export function useLook(): Look {
  const [look, set] = useState(readLook);
  useEffect(() => {
    const f = () => set(readLook());
    subscribers.add(f);
    return () => { subscribers.delete(f); };
  }, []);
  return look;
}

export function describe(look: Look): string {
  const name = (k: keyof Look) => OPTIONS[k].find((o) => o.id === look[k])?.label ?? look[k];
  return `My mtg-intel look: palette ${name("palette")}, type ${name("type")}, motion ${name("motion")}, density ${name("density")}, deal tiers ${name("tiers")}.`;
}
