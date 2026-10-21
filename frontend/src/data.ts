// The two documents every screen needs, joined: my wishes and the latest CardTrader check.
import { useMemo } from "preact/hooks";
import { useDoc } from "./api";
import type { Deal, EditsDoc, LiveDoc, LiveWish, WantsDoc, Wish } from "./types";
import { cmTrend, liveFlags } from "./format";
import { overlay, useEdits } from "./edits";

export interface AppData {
  wants: WantsDoc | null | undefined;
  live: LiveDoc | null | undefined;
  byKey: Map<string, Wish>;
  liveOf: (key: string) => LiveWish | undefined;
  dealOf: (key: string) => Deal | undefined;
  flagsOf: (w: Wish) => { code: string; text: string }[];
  error: string | null;
  edits: EditsDoc;
}

export function useAppData(): AppData {
  const wants = useDoc<WantsDoc>("wants");
  const live = useDoc<LiveDoc>("live", 60_000);
  const edits = useEdits();
  return useMemo(() => {
    // Waiting edits from the site are shown as if done (D50).
    const doc = wants.doc && { ...wants.doc, wishes: overlay(wants.doc.wishes, edits.ops) };
    const byKey = new Map((doc?.wishes ?? []).map((w) => [w.key, w]));
    const deals = new Map((live.doc?.deals ?? []).map((d) => [d.key, d]));
    const liveOf = (key: string) => live.doc?.wishes[key];
    return {
      wants: doc, live: live.doc, byKey, liveOf, edits,
      dealOf: (key: string) => deals.get(key),
      flagsOf: (w: Wish) => [...w.flags, ...liveFlags(w, liveOf(w.key))],
      error: wants.error || live.error,
    };
  }, [wants.doc, live.doc, wants.error, live.error, edits]);
}

/** How close the cheapest CardTrader copy is to a deal: price over the lower reference. */
export function dealRatio(w: Wish, l: LiveWish | undefined): number | null {
  if (!l) return null;
  const refs = [cmTrend(w, l.foil), l.usual].filter((v): v is number => !!v);
  return refs.length ? l.price / Math.min(...refs) : null;
}

/** Alternatives (`one_of`) count as one wish. */
export const wishCount = (ws: Wish[]) => new Set(ws.map((w) => w.one_of || w.key)).size;

/** Every list name on the want-list. */
export const allLists = (data: AppData) => [...new Set((data.wants?.wishes ?? []).flatMap((w) => w.lists))].sort();
