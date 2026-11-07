// The collection (D60): every card I own, grouped per printing, finish, language and condition.
// Today it is built from my purchases (recorded here and from CardTrader); a ManaBox import joins
// it later through the same shape. Prices over time come from the `history` document, which
// covers owned printings as well as wished ones.
import { can } from "./access";
import type { AppData } from "./data";
import { cmTrend, withShipping } from "./format";
import { shownPrice, type PriceFrom } from "./markets";
import { pendingPurchases } from "./edits";
import type { Edit, HistoryDoc, OwnedRef, Purchase, PurchasesDoc, Wish } from "./types";

export interface Owned {
  key: string; name: string; scryfall_id: string | null; set: string | null; number: string | null; set_name: string | null;
  rarity: string | null; tags: string[]; mana_cost: string | null; type_line: string | null; colors: string[];
  thumb: string | null; image: string | null; foil: boolean; language: string | null; condition: string;
  qty: number; paid: number; first: string; last: string; markets: string[]; lists: string[];
  /** Cardmarket's trend for this finish today, per copy */
  now: number | null; pending: boolean;
  /** Copies that left the collection (D79), grouped by why and when; null for cards I still own. */
  gone: Purchase["gone"]; gone_date: string | null; sold: number | null;
  /** How many of `qty` are recorded (not still on their way in), so they can be taken out */
  settled: number;
}

export const valueOf = (o: Owned) => (o.now != null ? o.now * o.qty : null);
/** Worth now minus what I paid; unknown for someone who may not see money (D78). */
export const gainOf = (o: Owned) => (o.now != null && can("money") ? o.now * o.qty - o.paid : null);

/** The copies a group stands for, as a "removed" edit names them. */
export const refOf = (o: Pick<Owned, "scryfall_id" | "name" | "foil" | "language" | "condition">): OwnedRef =>
  ({ scryfall_id: o.scryfall_id ?? "", name: o.name, foil: o.foil ? "yes" : "no", language: o.language ?? "", condition: o.condition });

const isRef = (p: Purchase, r: OwnedRef) => (r.scryfall_id ? p.scryfall_id === r.scryfall_id : !p.scryfall_id && p.name === r.name)
  && p.foil === (r.foil === "yes") && (p.language ?? "") === r.language && p.condition === r.condition;

/** Purchases with the waiting "removed" edits laid over them, as the GitHub job will apply them
 *  (mycards._remove_owned): sold, traded and lost copies go oldest first and show as gone; a mistake
 *  drops the newest. Copies still on their way in are never touched. */
export function withRemovals(purchases: Purchase[], ops: Edit[]): Purchase[] {
  let out = [...purchases];
  for (const op of ops) {
    if (op.op !== "removed" || !op.owned || !op.remove) continue;
    const r = op.owned, { reason, qty, date, sold_eur } = op.remove;
    const mine = out.filter((p) => !p.gone && !p.pending && isRef(p, r)).sort((a, b) => a.date.localeCompare(b.date));
    if (mine.length < qty) continue;  // the job will refuse it too
    if (reason === "mistake") {
      const drop = new Set(mine.slice(-qty));
      out = out.filter((p) => !drop.has(p));
      continue;
    }
    const take = new Set(mine.slice(0, qty));
    out = out.map((p) => (take.has(p) ? { ...p, gone: reason, gone_date: date, sold: reason === "sold" && sold_eur ? Number(sold_eur) : null, pending: true } : p));
  }
  return out;
}

/** Every purchase as the site should show it now: recorded ones, purchases and removals still waiting. */
export const myPurchases = (ops: Edit[], doc: PurchasesDoc | null | undefined): Purchase[] =>
  withRemovals([...pendingPurchases(ops), ...(doc?.purchases ?? [])], ops);

/** What left the collection (D79, D81): copies sold, the selling price and what those copies cost
 *  (only copies with a price count, `unpriced` says how many sold without one), traded or gifted, lost. */
export function soldSummary(purchases: Purchase[]) {
  const gone = purchases.filter((p) => p.gone);
  const sold = gone.filter((p) => p.gone === "sold"), priced = sold.filter((p) => p.sold != null);
  return {
    copies: gone.length, sold: sold.length, unpriced: sold.length - priced.length,
    soldFor: priced.reduce((t, p) => t + (p.sold ?? 0), 0), paidFor: priced.reduce((t, p) => t + (p.price ?? 0), 0),
    traded: gone.filter((p) => p.gone === "traded").length, lost: gone.filter((p) => p.gone === "lost").length,
  };
}

/** Cards I own now, or (gone = true) the copies that left, grouped per printing, finish, language and
 *  condition (and, when gone, per reason and day). */
export function ownedCards(purchases: Purchase[], gone = false): Owned[] {
  const at = new Map<string, Owned>();
  for (const p of purchases) {
    if (!!p.gone !== gone) continue;
    const key = [p.scryfall_id ?? p.name, p.foil ? "f" : "n", p.language ?? "", p.condition, ...(gone ? [p.gone, p.gone_date] : [])].join("|");
    const o = at.get(key);
    if (o) {
      o.qty += 1; o.paid += p.price;
      if (!p.pending) o.settled += 1;
      if (p.sold != null) o.sold = (o.sold ?? 0) + p.sold;
      if (p.date < o.first) o.first = p.date;
      if (p.date > o.last) o.last = p.date;
      if (!o.markets.includes(p.market)) o.markets.push(p.market);
      for (const l of p.lists) if (!o.lists.includes(l)) o.lists.push(l);
      o.now = o.now ?? p.now ?? null;
      o.pending ||= !!p.pending;
      continue;
    }
    at.set(key, {
      key, name: p.name, scryfall_id: p.scryfall_id, set: p.set, number: p.number, set_name: p.set_name, rarity: p.rarity,
      tags: p.tags, mana_cost: p.mana_cost ?? null, type_line: p.type_line ?? null, colors: p.colors ?? [],
      thumb: p.thumb, image: p.image ?? (p.thumb ? p.thumb.replace("/small/", "/normal/") : null), foil: p.foil,
      language: p.language, condition: p.condition, qty: 1, paid: p.price, first: p.date, last: p.date,
      markets: [p.market], lists: [...p.lists], now: p.now ?? null, pending: !!p.pending,
      gone: p.gone ?? null, gone_date: p.gone_date ?? null, sold: p.sold ?? null, settled: p.pending ? 0 : 1,
    });
  }
  return [...at.values()];
}

// ---------- prices over time ----------

const DAY = 86_400_000;

/** Cardmarket's trend per day (day offset from the document's base) for a printing and finish. */
export function series(id: string | null, foil: boolean, history: HistoryDoc | null | undefined): [number, number][] {
  if (!history?.base || !id) return [];
  const card = history.cards[id];
  if (!card) return [];
  const finish = foil ? "foil" : "normal";
  const points = new Map<number, number>();
  for (const source of ["mtgjson", "cardmarket"]) {  // our own daily guide wins on the same day
    const s = card[source]?.[finish] ?? (foil ? card[source]?.etched : undefined) ?? [];
    for (let i = 0; i < s.length; i += 2) points.set(s[i], s[i + 1]);
  }
  return [...points].sort((a, b) => a[0] - b[0]);
}

export interface Moves { change30: number | null; high90: number | null; low90: number | null; days: number }

export function moves(pts: [number, number][]): Moves {
  if (pts.length < 2) return { change30: null, high90: null, low90: null, days: pts.length };
  const [last, now] = pts[pts.length - 1];
  const then = [...pts].reverse().find(([d]) => d <= last - 30);
  const window = pts.filter(([d]) => d >= last - 90).map(([, v]) => v);
  return {
    change30: then && then[1] ? (now - then[1]) / then[1] : null,
    high90: Math.max(...window), low90: Math.min(...window), days: last - pts[0][0],
  };
}

/** A total over the last `span` days: each item's quantity times its price that day (the last
 *  known price carried forward). Only items with a price at the window's start count, so the line
 *  never jumps when a card's history begins; `of` says how many that is. */
export function totalOverTime<T>(items: T[], pointsOf: (x: T) => [number, number][], qty: (x: T) => number,
  history: HistoryDoc | null | undefined, span = 90): { line: { t: number; v: number }[]; of: number } {
  if (!history?.base) return { line: [], of: 0 };
  const all = items.map((x) => ({ x, pts: pointsOf(x) })).filter((s) => s.pts.length);
  const last = Math.max(0, ...all.map((s) => s.pts[s.pts.length - 1][0]));
  const start = last - span;
  const counted = all.filter((s) => s.pts[0][0] <= start + 3);
  const base = Date.parse(history.base + "T12:00:00Z");
  const line: { t: number; v: number }[] = [];
  const idx = counted.map(() => 0);
  for (let d = start; d <= last; d++) {
    let v = 0;
    counted.forEach((s, i) => {
      while (idx[i] + 1 < s.pts.length && s.pts[idx[i] + 1][0] <= d) idx[i]++;
      v += s.pts[idx[i]][1] * qty(s.x);
    });
    line.push({ t: base + d * DAY, v });
  }
  return { line, of: counted.length };
}

// ---------- the want-list side ----------

/** The best price a wish could be bought for now: the cheaper of the two prices its row shows (D75), CardTrader's
 *  cheapest fitting copy or Cardmarket's lowest listing plus shipping. */
export const bestNow = (data: AppData, w: Wish, from: PriceFrom = "best"): number | null => shownPrice(w, data, from);

/** Cardmarket's trend plus shipping: what buying at the trend would cost (D78). */
const trendShipped = (w: Wish, data: AppData) => { const t = cmTrend(w, data.liveOf(w.key)?.foil); return t ? withShipping(t) : null; };

/** Wishes as things to buy: alternatives (`one_of`) count once, at their cheapest version. */
export function toBuy(data: AppData, from: PriceFrom = "best"): { w: Wish; best: number | null; trend: number | null; qty: number }[] {
  const groups = new Map<string, Wish[]>();
  for (const w of data.wants?.wishes ?? []) groups.set(w.one_of || w.key, [...(groups.get(w.one_of || w.key) ?? []), w]);
  return [...groups.values()].map((ws) => {
    const priced = ws.map((w) => ({ w, best: bestNow(data, w, from), trend: trendShipped(w, data) }))
      .sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity));
    return { ...priced[0], qty: Math.max(1, priced[0].w.quantity || 1) };
  });
}

// ---------- set completion ----------

export interface Completion { id: string; label: string; set: string | null; owned: number; wanted: number; left: number; priced: number }

/** Per set: the printings I own against the ones still on the want-list, and what the rest costs now. */
export function completionBySet(data: AppData, owned: Owned[], from: PriceFrom = "best"): Completion[] {
  const at = new Map<string, Completion>();
  const get = (set: string | null, name: string | null) => {
    const id = set ?? "?";
    let c = at.get(id);
    if (!c) at.set(id, c = { id, label: name ?? (set ? set.toUpperCase() : "Unknown set"), set, owned: 0, wanted: 0, left: 0, priced: 0 });
    return c;
  };
  const mine = new Set<string>();
  for (const o of owned) {
    const k = o.scryfall_id ?? o.key;
    if (mine.has(k)) continue;
    mine.add(k);
    get(o.set, o.set_name).owned += 1;
  }
  for (const { w, best } of toBuy(data, from)) {
    if (w.scryfall_id && mine.has(w.scryfall_id)) continue;
    const c = get(w.set, w.set_name);
    c.wanted += 1;
    if (best != null) { c.left += best; c.priced += 1; }
  }
  return [...at.values()].filter((c) => c.id !== "?").sort((a, b) => (b.owned + b.wanted) - (a.owned + a.wanted) || a.label.localeCompare(b.label));
}
