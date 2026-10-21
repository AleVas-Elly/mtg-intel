// Want-list edits made on the site (spec D50). Each one is saved on the Worker at once and shown
// straight away; a GitHub job writes it into the want-list file within a few minutes.
import { send, setLocal, useDoc } from "./api";
import type { Edit, EditsDoc, Purchase, Settings, Wish } from "./types";

/** What a new wish starts with (user, 2026-10-22): English, any finish, NM or better, any CardTrader
 *  seller, on the Showcase list. */
export const NEW_WISH: Settings = { language: "en", foil: "any", min_condition: "NM", via_zero: "no", quantity: "1", list: "Showcase" };

export function settingsOf(w: Wish): Settings {
  return {
    language: w.language, foil: w.foil, min_condition: w.condition, via_zero: w.zero ? "yes" : "no",
    max_price_eur: w.max_price != null ? String(w.max_price) : "", deal_pct: w.deal_pct != null ? String(w.deal_pct) : "",
    quantity: String(w.quantity || 1), list: w.lists.join("; "), note: w.note ?? "",
  };
}

const num = (v: string | undefined) => (v ? Number(v) : null);

/** A wish with settings applied, as it will look once the change is written. */
export function withSettings(w: Wish, s: Settings): Wish {
  return {
    ...w,
    ...(s.language !== undefined && { language: s.language }),
    ...(s.foil !== undefined && { foil: s.foil as Wish["foil"] }),
    ...(s.min_condition !== undefined && { condition: s.min_condition }),
    ...(s.via_zero !== undefined && { zero: s.via_zero === "yes" }),
    ...(s.max_price_eur !== undefined && { max_price: num(s.max_price_eur) }),
    ...(s.deal_pct !== undefined && { deal_pct: num(s.deal_pct) }),
    ...(s.quantity !== undefined && { quantity: Number(s.quantity) || 1 }),
    ...(s.list !== undefined && { lists: s.list.split("; ").filter(Boolean) }),
    ...(s.note !== undefined && { note: s.note || null }),
  };
}

/** Only the settings that differ from the wish's current ones. */
export function changed(w: Wish, s: Settings): Settings {
  const now = settingsOf(w);
  return Object.fromEntries(Object.entries(s).filter(([k, v]) => (now[k as keyof Settings] ?? "") !== v)) as Settings;
}

/** The want-list with waiting edits laid over it: added wishes appear, removed ones go. */
export function overlay(wishes: Wish[], ops: Edit[]): Wish[] {
  const out = new Map(wishes.map((w) => [w.key, w]));
  for (const op of ops) {
    if (op.op === "add" && op.card && op.scryfall_id) {
      const s = { ...NEW_WISH, ...op.settings };
      const key = `${op.scryfall_id}|${s.language}|${s.foil}`;
      if (!out.has(key)) out.set(key, withSettings({ ...(op.card as Wish), key, pending: "add" }, s));
    } else if (op.op === "update" && op.key && out.has(op.key)) {
      out.set(op.key, { ...withSettings(out.get(op.key)!, op.settings ?? {}), pending: "update" });
    } else if (op.op === "remove" && op.key) {
      out.delete(op.key);
    } else if (op.op === "bought" && op.key && out.has(op.key)) {
      const w = out.get(op.key)!;  // one copy off; the wish goes at zero
      if (w.quantity > 1) out.set(op.key, { ...w, quantity: w.quantity - 1, pending: "update" });
      else out.delete(op.key);
    }
  }
  return [...out.values()];
}

export function useEdits(): EditsDoc {
  return useDoc<EditsDoc>("edits", 30_000).doc ?? { ops: [], failed: [] };
}

export async function saveEdit(edit: Omit<Edit, "id" | "at">): Promise<EditsDoc> {
  const doc = await send<EditsDoc>("POST", "/api/edits", edit);
  setLocal("edits", doc);
  return doc;
}

export async function undoEdit(id: string): Promise<void> {
  setLocal("edits", await send<EditsDoc>("DELETE", `/api/edits/${id}`));
}

export async function dismissFailed(): Promise<void> {
  setLocal("edits", await send<EditsDoc>("DELETE", "/api/edits/failed"));
}

/** Purchases still on their way into the file, shaped like recorded ones. */
export function pendingPurchases(ops: Edit[]): Purchase[] {
  return ops.filter((o) => o.op === "bought" && o.purchase && o.card).map((o, i) => {
    const p = o.purchase!, c = o.card!;
    const price = Number(p.price_eur), trend = p.cardmarket_trend_eur ? Number(p.cardmarket_trend_eur) : null;
    return {
      n: -1 - i, date: p.date, name: c.name ?? "", set: c.set ?? null, number: c.number ?? null, scryfall_id: c.scryfall_id ?? null,
      language: p.language, foil: p.foil === "yes", condition: p.condition, price, market: p.market, cardmarket: trend,
      saved: trend != null ? Math.round((trend - price) * 100) / 100 : null, thumb: c.thumb ?? null, rarity: c.rarity ?? null,
      tags: c.tags ?? [], set_name: c.set_name ?? null, lists: c.lists ?? [], pending: true,
    };
  }).reverse();
}
