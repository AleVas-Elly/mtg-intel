// Want-list filters (spec D55): groups of options in the sidebar. Options in one group are
// alternatives (Rare or Mythic); groups narrow each other (Rare and Blue).
import type { AppData } from "./data";
import { dealGap } from "./data";
import { cmTrend, langName, tagName } from "./format";
import type { HistoryDoc, Wish } from "./types";

export type Icon = { mana: string } | { set: string; rarity?: string | null } | { rarity: string };
// Generic over what is filtered: wishes on the Want-list, owned cards in the Collection (D60).
export interface Option<T = Wish> { id: string; label: string; icon?: Icon; test: (x: T) => boolean }
export interface Group<T = Wish> { id: string; label: string; open: boolean; options: Option<T>[]; show?: number }

export interface FilterState { sel: Record<string, string[]>; min: string; max: string }
export const EMPTY: FilterState = { sel: {}, min: "", max: "" };

const DAY = 86_400_000;

/** Cardmarket trend per day for the wish's finish: MTGJSON's past, then our own days. */
function trendPoints(w: Wish, history: HistoryDoc | null | undefined): [number, number][] {
  if (!history?.base || !w.scryfall_id) return [];
  const card = history.cards[w.scryfall_id];
  if (!card) return [];
  const finish = w.foil === "yes" || (w.finishes.length > 0 && !w.finishes.includes("nonfoil")) ? "foil" : "normal";
  const points = new Map<number, number>();
  for (const source of ["mtgjson", "cardmarket"]) {
    const s = card[source]?.[finish] ?? [];
    for (let i = 0; i < s.length; i += 2) points.set(s[i], s[i + 1]);
  }
  return [...points].sort((a, b) => a[0] - b[0]);
}

/** Cardmarket trend change over 30 days (0.1 = 10% up). */
export function change30(w: Wish, history: HistoryDoc | null | undefined): number | null {
  const pts = trendPoints(w, history);
  if (pts.length < 2) return null;
  const [last, now] = pts[pts.length - 1];
  const then = [...pts].reverse().find(([d]) => d <= last - 30);
  return then && then[1] ? (now - then[1]) / then[1] : null;
}

/** Today's Cardmarket trend is the lowest of the last 90 days (needs at least 60 days of history). */
export function atLow90(w: Wish, history: HistoryDoc | null | undefined): boolean {
  const pts = trendPoints(w, history);
  if (pts.length < 2) return false;
  const [last, now] = pts[pts.length - 1];
  const window = pts.filter(([d]) => d >= last - 90);
  if (window[0][0] > last - 60) return false;
  return now <= Math.min(...window.map(([, v]) => v));
}

/** Colours in the printed cost, both faces, hybrid and Phyrexian symbols counting each colour. */
export function costColours(cost: string | null): string[] {
  const out = new Set<string>();
  for (const m of (cost ?? "").matchAll(/\{([^}]+)\}/g)) for (const c of "WUBRG") if (m[1].includes(c)) out.add(c);
  return [...out];
}

const PRICE = [
  { id: "p0", label: "Under €1", lo: 0, hi: 1 },
  { id: "p1", label: "€1 to €5", lo: 1, hi: 5 },
  { id: "p5", label: "€5 to €20", lo: 5, hi: 20 },
  { id: "p20", label: "€20 to €50", lo: 20, hi: 50 },
  { id: "p50", label: "Over €50", lo: 50, hi: Infinity },
];
const RARITY = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
const COLOURS: [string, string][] = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"]];
const TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Planeswalker", "Battle", "Legendary"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Cardmarket price used by the price filter and the price sort: the wish's finish. */
export const priceOf = (data: AppData, w: Wish) => cmTrend(w, data.liveOf(w.key)?.foil);

/** Every group, its options built from the wishes on the list. */
export function buildGroups(wishes: Wish[], data: AppData, history: HistoryDoc | null | undefined, today = Date.now()): Group<Wish>[] {
  const count = <T,>(key: (w: Wish) => T[]) => {
    const m = new Map<T, number>();
    for (const w of wishes) for (const k of key(w)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  const live = (w: Wish) => data.liveOf(w.key);
  const sets = new Map(wishes.filter((w) => w.set).map((w) => [w.set!, w]));
  const versions = count((w) => (w.tags.length ? w.tags : ["regular"]));
  const languages = count((w) => [w.language]);

  // fixed choices nobody on the list has (no commons, no battles) stay out of the way
  const present = (opts: Option<Wish>[]) => opts.filter((o) => wishes.some(o.test));

  return [
    { id: "list", label: "List", open: true, options: count((w) => w.lists).map((l) => ({ id: l, label: l, test: (w) => w.lists.includes(l) })) },
    {
      id: "deal", label: "Deal status", open: true, options: [
        { id: "now", label: "Deal right now", test: (w) => !!data.dealOf(w.key) },
        { id: "close", label: "Close to a deal", test: (w) => { const g = dealGap(w, live(w)); return !data.dealOf(w.key) && g != null && g > 0 && g <= 10; } },
        { id: "target", label: "Under my target price", test: (w) => { const l = live(w); return w.max_price != null && !!l && l.price <= w.max_price; } },
        { id: "ct", label: "Cheaper on CardTrader", test: (w) => { const l = live(w), cm = cmTrend(w, l?.foil); return !!l && cm != null && l.price < cm; } },
        { id: "none", label: "No copy on CardTrader", test: (w) => !!data.live && !live(w) },
      ],
    },
    { id: "price", label: "Price", open: true, options: PRICE.map((p) => ({ id: p.id, label: p.label, test: (w) => { const v = priceOf(data, w); return v != null && v >= p.lo && v < p.hi; } })) },
    { id: "version", label: "Version", open: true, options: versions.map((t) => ({ id: t, label: cap(tagName(t)), test: (w) => (t === "regular" ? !w.tags.length : w.tags.includes(t)) })) },
    { id: "rarity", label: "Rarity", open: false, options: present(RARITY.map((r) => ({ id: r, label: cap(r), icon: { rarity: r }, test: (w: Wish) => w.rarity === r }))) },
    {
      id: "colour", label: "Colour", open: false, options: present([
        ...COLOURS.map(([c, label]) => ({ id: c, label, icon: { mana: c }, test: (w: Wish) => costColours(w.mana_cost).includes(c) })),
        { id: "C", label: "Colourless", icon: { mana: "C" }, test: (w) => costColours(w.mana_cost).length === 0 },
        { id: "M", label: "Multicolour", test: (w) => costColours(w.mana_cost).length > 1 },
      ]),
    },
    { id: "type", label: "Card type", open: false, options: present(TYPES.map((t) => ({ id: t, label: t, test: (w: Wish) => (w.type_line ?? "").includes(t) }))) },
    {
      id: "set", label: "Expansion", open: false, show: 8,
      options: count((w) => (w.set ? [w.set] : [])).map((s) => ({
        id: s, label: sets.get(s)?.set_name ?? s.toUpperCase(), icon: { set: s, rarity: "common" }, test: (w) => w.set === s,
      })),
    },
    {
      id: "timing", label: "Price movement", open: false, options: [
        { id: "low90", label: "Lowest in 90 days", test: (w) => atLow90(w, history) },
        { id: "down", label: "Down 5% or more in 30 days", test: (w) => (change30(w, history) ?? 0) <= -0.05 },
        { id: "up", label: "Up 5% or more in 30 days", test: (w) => (change30(w, history) ?? 0) >= 0.05 },
        { id: "new", label: "Released in the last 3 months", test: (w) => !!w.released && Date.parse(w.released) >= today - 92 * DAY },
      ],
    },
    { id: "lang", label: "Language", open: false, options: languages.map((l) => ({ id: l, label: langName(l), test: (w) => w.language === l })) },
    {
      id: "finish", label: "Finish", open: false, options: present([
        { id: "yes", label: "Foil", test: (w) => w.foil === "yes" },
        { id: "no", label: "Non-foil", test: (w) => w.foil === "no" },
        { id: "any", label: "Foil or not", test: (w) => w.foil === "any" },
      ]),
    },
  ];
}

const num = (s: string) => { const v = parseFloat(s.replace(",", ".")); return Number.isFinite(v) ? v : null; };
export const customPrice = (s: FilterState) => ({ min: num(s.min), max: num(s.max) });
const hasCustom = (s: FilterState) => { const c = customPrice(s); return c.min != null || c.max != null; };

/** Does the item pass this group's picks? A group with nothing picked lets everything through. */
function passes<T>(x: T, g: Group<T>, s: FilterState, price: (x: T) => number | null): boolean {
  const picked = s.sel[g.id] ?? [];
  const custom = g.id === "price" && hasCustom(s);
  if (!picked.length && !custom) return true;
  if (g.options.some((o) => picked.includes(o.id) && o.test(x))) return true;
  if (!custom) return false;
  const v = price(x), c = customPrice(s);
  return v != null && (c.min == null || v >= c.min) && (c.max == null || v <= c.max);
}

export function applyFilters<T>(items: T[], groups: Group<T>[], s: FilterState, price: (x: T) => number | null): T[] {
  return items.filter((x) => groups.every((g) => passes(x, g, s, price)));
}

/** Items each option would show, given every other group's picks (`count` decides what counts once). */
export function optionCounts<T>(items: T[], groups: Group<T>[], s: FilterState, price: (x: T) => number | null,
  count: (xs: T[]) => number = (xs) => xs.length): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) {
    const rest = items.filter((x) => groups.every((h) => h === g || passes(x, h, s, price)));
    for (const o of g.options) out.set(`${g.id}:${o.id}`, count(rest.filter(o.test)));
  }
  return out;
}

export const activeCount = (s: FilterState) => Object.values(s.sel).reduce((t, v) => t + v.length, 0) + (hasCustom(s) ? 1 : 0);
