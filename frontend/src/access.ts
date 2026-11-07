// Who is signed in and what they may see and do (spec D78). The Worker enforces every switch; the
// app only hides what someone can't use. Kept in localStorage so the right screens paint at once.
import { useEffect, useState } from "preact/hooks";

export type Perm = "wants" | "collection" | "money" | "deals" | "details" | "suggest" | "edit" | "bought";

export interface Me { id: string; name: string; owner: boolean; expires: string | null; perms: Record<Perm, boolean> }

const ALL: Record<Perm, boolean> = { wants: true, collection: true, money: true, deals: true, details: true, suggest: true, edit: true, bought: true };
const OWNER: Me = { id: "owner", name: "You", owner: true, expires: null, perms: ALL };

let me: Me = (() => {
  try {
    const raw = localStorage.getItem("me");
    if (raw) return JSON.parse(raw) as Me;
  } catch { /* fine */ }
  return OWNER;
})();
const listeners = new Set<() => void>();

export function setMe(next: Me | null) {
  me = next ?? OWNER;
  try { next ? localStorage.setItem("me", JSON.stringify(next)) : localStorage.removeItem("me"); } catch { /* fine */ }
  listeners.forEach((f) => f());
}

/** The signed-in person, outside components. */
export const currentMe = () => me;
export const can = (p: Perm) => me.owner || !!me.perms[p];

export function useMe(): Me {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return me;
}

export const PERM_INFO: { id: Perm; label: string; hint: string; needs?: Perm }[] = [
  { id: "wants", label: "Want-list", hint: "What you're looking for, with targets" },
  { id: "collection", label: "Collection", hint: "The cards you own" },
  { id: "money", label: "Money", hint: "What you paid and saved" },
  { id: "deals", label: "Live deals", hint: "Cheap CardTrader copies right now. They could buy one first" },
  { id: "details", label: "Deal details", hint: "Seller country and why it's a deal", needs: "deals" },
  { id: "suggest", label: "Suggest cards", hint: "Their picks wait in your inbox for Add or Dismiss" },
  { id: "edit", label: "Edit want-list", hint: "Add, change and remove wishes and targets", needs: "wants" },
  { id: "bought", label: "Mark bought", hint: "Record purchases and take cards out of the collection", needs: "wants" },
];

export const PRESETS: { id: string; label: string; hint: string; perms: Perm[] }[] = [
  { id: "viewer", label: "Viewer", hint: "Sees the want-list and collection", perms: ["wants", "collection"] },
  { id: "friend", label: "Friend", hint: "Viewer, and can suggest cards", perms: ["wants", "collection", "suggest"] },
  { id: "helper", label: "Helper", hint: "Friend, and can edit the want-list and mark bought", perms: ["wants", "collection", "suggest", "edit", "bought"] },
  { id: "coowner", label: "Co-owner", hint: "Everything except managing people", perms: ["wants", "collection", "money", "deals", "details", "suggest", "edit", "bought"] },
];

// Access can change while the app is open (I edit someone's switches): the sign-in check runs again
// when the tab comes back, every few minutes, and right after the server refuses something.
let recheck: () => void = () => {};
let last = 0;
export function onRecheck(f: () => void) { recheck = f; }
export function recheckAccess() {
  if (Date.now() - last < 3000) return;
  last = Date.now();
  recheck();
}
