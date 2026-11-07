// Cards someone suggested for my want-list (spec D78): an inbox I answer with Add or Dismiss.
import { useEffect, useState } from "preact/hooks";
import { refresh, send } from "./api";
import type { Settings, Wish } from "./types";

export interface Suggestion {
  id: string; account: string; name: string; at: string; scryfall_id: string; settings: Settings; card: Partial<Wish>;
}

let list: Suggestion[] | null = null;
const listeners = new Set<() => void>();
const set = (next: Suggestion[]) => { list = next; listeners.forEach((f) => f()); };

async function load() {
  const r = await fetch("/api/suggestions", { credentials: "same-origin" });
  if (r.ok) set(await r.json());
}

/** The waiting suggestions (everyone's for me, their own for someone else), read on open and when the tab comes back. */
export function useSuggestions(enabled: boolean): Suggestion[] {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    load().catch(() => {});
    const onVisible = () => document.visibilityState === "visible" && load().catch(() => {});
    document.addEventListener("visibilitychange", onVisible);
    return () => { listeners.delete(f); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled]);
  return enabled ? list ?? [] : [];
}

export async function suggest(body: { scryfall_id: string; settings: Settings; card: Partial<Wish> }) {
  set(await send<Suggestion[]>("POST", "/api/suggestions", body));
}

/** Add it to the want-list: the Worker queues it like any edit, so the want-list shows it at once. */
export async function addSuggestion(id: string) {
  set(await send<Suggestion[]>("POST", `/api/suggestions/${id}/add`));
  await refresh("edits").catch(() => {});
}

export async function dropSuggestion(id: string) {
  set(await send<Suggestion[]>("DELETE", `/api/suggestions/${id}`));
}
