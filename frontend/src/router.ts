import { useEffect, useState } from "preact/hooks";

export interface Route { path: string; card: string | null }

const read = (): Route => ({ path: location.pathname, card: new URLSearchParams(location.search).get("card") });
const subscribers = new Set<() => void>();
window.addEventListener("popstate", () => subscribers.forEach((f) => f()));

type VT = { startViewTransition?: (cb: () => Promise<void> | void) => unknown };

/** Change the URL; animated with a view transition where the browser has them. */
export function go(path: string, card: string | null = null, replace = false) {
  const url = card ? `${path}?card=${encodeURIComponent(card)}` : path;
  const apply = () => {
    history[replace ? "replaceState" : "pushState"](null, "", url);
    subscribers.forEach((f) => f());
  };
  const doc = document as unknown as VT;
  if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    doc.startViewTransition(() => new Promise<void>((done) => { apply(); setTimeout(done, 20); }));
  } else apply();
}

export const openCard = (key: string) => go(location.pathname, key);
export const closeCard = () => go(location.pathname, null);

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
