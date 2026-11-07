// People and access (spec D76): who may see and do what on the site. Each passkey belongs to an
// account; my own passkeys are the account `owner`, which always has everything and alone manages
// people. Every switch is checked here on the server, not only hidden in the app.

export const PERMS = ["wants", "collection", "money", "deals", "details", "suggest", "edit", "bought"] as const;
export type Perm = (typeof PERMS)[number];
export type Perms = Partial<Record<Perm, boolean>>;

export const PRESETS: Record<string, Perm[]> = {
  viewer: ["wants", "collection"],
  friend: ["wants", "collection", "suggest"],
  helper: ["wants", "collection", "suggest", "edit", "bought"],
  coowner: [...PERMS],
};

export interface Account {
  id: string;
  name: string;
  created: string;
  expires: string | null; // ISO date; after it the account can't sign in and its sessions stop
  preset: string; // "owner", a preset name, or "custom"
  perms: Perms;
}

export const OWNER = "owner";
export const isOwner = (a: Account) => a.id === OWNER;
export const ended = (a: Account, now = Date.now()) => !isOwner(a) && !!a.expires && Date.parse(a.expires) <= now;
export const can = (a: Account, p: Perm) => isOwner(a) || !!a.perms[p];

/** Switches that make no sense alone are turned off: editing or marking bought needs the want-list,
 *  deal details need the deals, money needs something to put it on. */
export function tidy(perms: Perms): Perms {
  const out: Perms = {};
  for (const p of PERMS) if (perms[p]) out[p] = true;
  if (!out.wants) { delete out.edit; delete out.bought; }
  if (!out.deals) delete out.details;
  if (!out.wants && !out.collection) delete out.money;
  return out;
}

/** The preset these switches match, or "custom". */
export function presetOf(perms: Perms): string {
  const on = PERMS.filter((p) => perms[p]).join();
  const found = Object.entries(PRESETS).find(([, list]) => PERMS.filter((p) => list.includes(p)).join() === on);
  return found ? found[0] : "custom";
}

/** What the app needs to know about the signed-in person. */
export const meOf = (a: Account) => ({
  id: a.id, name: a.name, owner: isOwner(a), expires: a.expires,
  perms: Object.fromEntries(PERMS.map((p) => [p, can(a, p)])) as Record<Perm, boolean>,
});

/** Which document needs which switch. Price documents (history, prices-N) are open to everyone. */
export function docPerm(key: string): Perm | null {
  if (key === "wants" || key === "targets") return "wants";
  if (key === "purchases") return "collection";
  if (key === "live" || key === "ct-recent" || key === "ct-history") return "deals";
  return null;
}

/** Money out of the purchases document: what I paid and saved. The value now (Cardmarket's trend,
 *  public) stays. */
export function withoutMoney(doc: { purchases?: Record<string, unknown>[] }) {
  return { ...doc, purchases: (doc.purchases ?? []).map(({ price, saved, cardmarket, ...rest }) => ({ ...rest, price: null, saved: null, cardmarket: null })) };
}

/** Deal details out of the live document: seller country and the reasons. */
export function withoutDetails(doc: { deals?: Record<string, any>[]; gone?: Record<string, any>[]; wishes?: Record<string, any>; fast?: unknown }) {
  const strip = (d: Record<string, any>) => ({ ...d, reasons: [], listing: d.listing ? { ...d.listing, country: "" } : d.listing });
  const wishes = Object.fromEntries(Object.entries(doc.wishes ?? {}).map(([k, w]) => [k, { ...w, country: "" }]));
  const { fast, ...rest } = doc;
  return { ...rest, wishes, deals: (doc.deals ?? []).map(strip), gone: (doc.gone ?? []).map(strip) };
}
