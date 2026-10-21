// The two documents every screen needs, joined: my wishes and the latest CardTrader check.
import { useMemo } from "preact/hooks";
import { useDoc } from "./api";
import type { Deal, LiveDoc, LiveWish, WantsDoc, Wish } from "./types";
import { cmTrend, liveFlags } from "./format";

export interface AppData {
  wants: WantsDoc | null | undefined;
  live: LiveDoc | null | undefined;
  byKey: Map<string, Wish>;
  liveOf: (key: string) => LiveWish | undefined;
  dealOf: (key: string) => Deal | undefined;
  flagsOf: (w: Wish) => { code: string; text: string }[];
  error: string | null;
}

export function useAppData(): AppData {
  const wants = useDoc<WantsDoc>("wants");
  const live = useDoc<LiveDoc>("live", 60_000);
  return useMemo(() => {
    const byKey = new Map((wants.doc?.wishes ?? []).map((w) => [w.key, w]));
    const deals = new Map((live.doc?.deals ?? []).map((d) => [d.key, d]));
    const liveOf = (key: string) => live.doc?.wishes[key];
    return {
      wants: wants.doc, live: live.doc, byKey, liveOf,
      dealOf: (key: string) => deals.get(key),
      flagsOf: (w: Wish) => [...w.flags, ...liveFlags(w, liveOf(w.key))],
      error: wants.error || live.error,
    };
  }, [wants.doc, live.doc, wants.error, live.error]);
}

/** How close the cheapest CardTrader copy is to a deal: price over the lower reference. */
export function dealRatio(w: Wish, l: LiveWish | undefined): number | null {
  if (!l) return null;
  const refs = [cmTrend(w, l.foil), l.usual].filter((v): v is number => !!v);
  return refs.length ? l.price / Math.min(...refs) : null;
}

/** Alternatives (`one_of`) count as one wish. */
export const wishCount = (ws: Wish[]) => new Set(ws.map((w) => w.one_of || w.key)).size;
