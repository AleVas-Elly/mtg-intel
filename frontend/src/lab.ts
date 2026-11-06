// Look: the few choices left to make (D57 fixes colour and type), set as attributes on <html> so the CSS can
// switch them. Earlier: the design lab (3b),, set as attributes on <html> so the CSS can
// switch whole token sets. Kept in this browser only; the chosen set becomes the default later.
import { useEffect, useState } from "preact/hooks";

export interface Look { motion: string; density: string }

export const DEFAULT: Look = { motion: "lively", density: "comfortable" };

export const OPTIONS: { [K in keyof Look]: { id: string; label: string; hint: string }[] } = {
  motion: [
    { id: "calm", label: "Calm", hint: "Things just appear: no rolling prices, no flying card, foil stays still" },
    { id: "smooth", label: "Smooth", hint: "Pages glide, a tapped card flies into its pane, prices roll, foil shimmers slowly" },
    { id: "lively", label: "Lively", hint: "All of Smooth, plus lists cascade in, cards tilt when touched and Steal badges shine" },
  ],
  density: [
    { id: "compact", label: "Compact", hint: "Small pictures, more cards per screen" },
    { id: "comfortable", label: "Comfortable", hint: "Balanced rows" },
    { id: "gallery", label: "Gallery", hint: "Big card pictures in a grid" },
  ],
};

// Versioned: a new default look replaces what the lab saved in each browser before it.
const KEY = "look-v3";
const subscribers = new Set<() => void>();

export function readLook(): Look {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEFAULT;
  }
}

export function applyLook(look: Look) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(look)) root.dataset[k] = v;
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
  return `My mtg-intel look: motion ${name("motion")}, layout ${name("density")}.`;
}
