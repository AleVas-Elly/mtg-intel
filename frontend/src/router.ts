import { useEffect, useState } from "preact/hooks";

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
 *  card whose picture flies between its list row and the big card in the detail view. */
export function go(path: string, card: string | null = null, replace = false, morph?: string) {
  const url = card ? `${path}?card=${encodeURIComponent(card)}` : path;
  const apply = () => {
    history[replace ? "replaceState" : "pushState"](null, "", url);
    subscribers.forEach((f) => f());
  };
  const doc = document as unknown as VT;
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();
  const opening = !!card && !!morph;
  const source = opening ? thumbOf(morph!) : null;
  if (source) source.style.viewTransitionName = MORPH;
  document.documentElement.classList.add("vt");
  let started = false;
  const vt = doc.startViewTransition(async () => {
    started = true;
    if (source) source.style.viewTransitionName = "";
    apply();
    await settle(); await settle();  // the new screen has rendered
    if (!card && morph) {  // closing: the row's picture receives the big card
      const target = thumbOf(morph);
      if (target) target.style.viewTransitionName = MORPH;
    }
  });
  // A throttled page (background tab) may not reach the transition's first frame: open directly.
  setTimeout(() => { if (!started) vt.skipTransition(); }, 400);
  vt.finished.finally(() => {
    document.documentElement.classList.remove("vt");
    if (morph) { const t = thumbOf(morph); if (t) t.style.viewTransitionName = ""; }
  });
}

export const openCard = (key: string) => go(location.pathname, key, false, key);
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
