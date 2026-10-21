import { useEffect, useState } from "preact/hooks";
import { peek } from "./api";
import type { WantsDoc } from "./types";
import { preloadImage } from "./ui/CardImage";

export interface Route { path: string; card: string | null }

const read = (): Route => ({ path: location.pathname, card: new URLSearchParams(location.search).get("card") });
const subscribers = new Set<() => void>();
window.addEventListener("popstate", () => subscribers.forEach((f) => f()));

type VT = { startViewTransition?: (cb: () => Promise<void> | void) => { finished: Promise<void>; skipTransition: () => void } };

const MORPH = "card-open";
// Rendering is paused inside a view transition's update, so wait on timers (Preact renders on a
// microtask), never on animation frames.
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const thumbOf = (key: string) =>
  document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"] .thumb`);

/** Change the URL; animated with a view transition where the browser has them. `morph` names the
 *  card whose picture flies between its list row and the big card in the detail view. Exactly one
 *  element carries the morph name in each snapshot, or the browser drops the transition. */
export function go(path: string, card: string | null = null, replace = false, morph?: string) {
  const url = card ? `${path}?card=${encodeURIComponent(card)}` : path;
  const apply = () => {
    history[replace ? "replaceState" : "pushState"](null, "", url);
    subscribers.forEach((f) => f());
  };
  const doc = document as unknown as VT;
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();
  const big = () => document.querySelector<HTMLElement>(".card-big .thumb");
  const name = (el: HTMLElement | null) => { if (el) el.style.viewTransitionName = MORPH; };
  const clear = () => document.querySelectorAll<HTMLElement>(".thumb").forEach((el) => { el.style.viewTransitionName = ""; });
  clear();
  name(card ? (morph ? thumbOf(morph) : null) : big());
  const root = document.documentElement.classList;
  const cardMove = !!card || !!morph;
  root.add("vt");
  if (cardMove) root.add("vt-card");
  let started = false;
  const vt = doc.startViewTransition(async () => {
    started = true;
    clear();
    apply();
    await settle(); await settle();  // the new screen has rendered
    name(card ? big() : morph ? thumbOf(morph) : null);
  });
  // A throttled page (background tab) may not reach the transition's first frame: open directly.
  setTimeout(() => { if (!started) vt.skipTransition(); }, 400);
  vt.finished.finally(() => {
    root.remove("vt", "vt-card");
    clear();
  });
}

/** Open a card's detail; its big picture is fetched first (briefly) so it flies in sharp. */
export const openCard = (key: string) => {
  const image = peek<WantsDoc>("wants")?.wishes.find((w) => w.key === key)?.image;
  preloadImage(image, 200).then(() => go(location.pathname, key, false, key));
};
export const closeCard = () => go(location.pathname, null, false, new URLSearchParams(location.search).get("card") ?? undefined);

export function useRoute(): Route {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const f = () => setRoute(read());
    subscribers.add(f);
    return () => { subscribers.delete(f); };
  }, []);
  return route;
}

/** onClick for in-app links (keeps cmd/ctrl-click opening a new tab). */
export function link(path: string) {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (location.pathname !== path || location.search) go(path);
    window.scrollTo({ top: 0 });
  };
}
