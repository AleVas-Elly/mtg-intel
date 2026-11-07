// Collection (D60): every card I own, with the Want-list's filters, sorts and the card pane.
// Replaces the Bought page; what I paid and saved now lives on the Want-list dashboard.
import { can } from "../access";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useDoc } from "../api";
import { gainOf, moves, ownedCards, series, valueOf, type Owned } from "../collection";
import type { AppData } from "../data";
import { pendingPurchases } from "../edits";
import { EMPTY, activeCount, applyFilters, costColours, optionCounts, type FilterState, type Group, type Option } from "../filters";
import { day, eur, langName, langShort, tagName } from "../format";
import { link, openCard } from "../router";
import { CardImage, preloadImage } from "../ui/CardImage";
import { FilterPanel, FilterSheet } from "../ui/Filters";
import { IconFilter, IconSearch } from "../ui/icons";
import { RowSkeleton } from "../ui/Row";
import { ManaCost, SetSymbol } from "../ui/symbols";
import type { HistoryDoc, PurchasesDoc } from "../types";
import "./dashboards.css";

const MARKET: Record<string, string> = { cardtrader: "CardTrader", cardmarket: "Cardmarket", other: "Elsewhere" };
const SORTS = [
  { id: "value", label: "Most valuable" },
  { id: "gain", label: "Biggest gain" },
  { id: "loss", label: "Biggest loss" },
  { id: "rise", label: "Rising this month" },
  { id: "new", label: "Newest" },
  { id: "name", label: "Name" },
  { id: "set", label: "Set" },
];
const PRICE = [
  { id: "p0", label: "Under €1", lo: 0, hi: 1 }, { id: "p1", label: "€1 to €5", lo: 1, hi: 5 },
  { id: "p5", label: "€5 to €20", lo: 5, hi: 20 }, { id: "p20", label: "€20 to €50", lo: 20, hi: 50 },
  { id: "p50", label: "Over €50", lo: 50, hi: Infinity },
];
const RARITY = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
const COLOURS: [string, string][] = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"]];
const TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Planeswalker", "Battle", "Legendary"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const qtyOf = (xs: Owned[]) => xs.reduce((t, o) => t + o.qty, 0);

function groupsFor(owned: Owned[], history: HistoryDoc | null | undefined): Group<Owned>[] {
  const count = <T,>(key: (o: Owned) => T[]) => {
    const m = new Map<T, number>();
    for (const o of owned) for (const k of key(o)) m.set(k, (m.get(k) ?? 0) + o.qty);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  const present = (opts: Option<Owned>[]) => opts.filter((o) => owned.some(o.test));
  const sets = new Map(owned.filter((o) => o.set).map((o) => [o.set!, o]));
  const move = (o: Owned) => moves(series(o.scryfall_id, o.foil, history));
  return [
    { id: "source", label: "Where it came from", open: true, options: count((o) => o.markets).map((m) => ({ id: m, label: m === "other" ? "Bought elsewhere" : `Bought on ${MARKET[m] ?? m}`, test: (o) => o.markets.includes(m) })) },
    { id: "price", label: "Worth (a copy)", open: true, options: PRICE.map((p) => ({ id: p.id, label: p.label, test: (o) => o.now != null && o.now >= p.lo && o.now < p.hi })) },
    {
      id: "move", label: "Price movement", open: true, options: [
        ...(can("money") ? [
          { id: "gain", label: "Worth more than I paid", test: (o: Owned) => (gainOf(o) ?? 0) > 0.005 },
          { id: "loss", label: "Worth less than I paid", test: (o: Owned) => (gainOf(o) ?? 0) < -0.005 },
        ] : []),
        { id: "up", label: "Up 10% or more in 30 days", test: (o) => (move(o).change30 ?? 0) >= 0.1 },
        { id: "down", label: "Down 10% or more in 30 days", test: (o) => (move(o).change30 ?? 0) <= -0.1 },
      ],
    },
    { id: "version", label: "Version", open: false, options: count((o) => (o.tags.length ? o.tags : ["regular"])).map((t) => ({ id: t, label: cap(tagName(t)), test: (o) => (t === "regular" ? !o.tags.length : o.tags.includes(t)) })) },
    { id: "rarity", label: "Rarity", open: false, options: present(RARITY.map((r) => ({ id: r, label: cap(r), icon: { rarity: r }, test: (o: Owned) => o.rarity === r }))) },
    {
      id: "colour", label: "Colour", open: false, options: present([
        ...COLOURS.map(([c, label]) => ({ id: c, label, icon: { mana: c }, test: (o: Owned) => costColours(o.mana_cost).includes(c) })),
        { id: "C", label: "Colourless", icon: { mana: "C" }, test: (o) => costColours(o.mana_cost).length === 0 },
        { id: "M", label: "Multicolour", test: (o) => costColours(o.mana_cost).length > 1 },
      ]),
    },
    { id: "type", label: "Card type", open: false, options: present(TYPES.map((t) => ({ id: t, label: t, test: (o: Owned) => (o.type_line ?? "").includes(t) }))) },
    {
      id: "set", label: "Expansion", open: false, show: 8,
      options: count((o) => (o.set ? [o.set] : [])).map((s) => ({ id: s, label: sets.get(s)?.set_name ?? s.toUpperCase(), icon: { set: s, rarity: "common" }, test: (o) => o.set === s })),
    },
    { id: "list", label: "Was on list", open: false, options: count((o) => o.lists).map((l) => ({ id: l, label: l, test: (o) => o.lists.includes(l) })) },
    { id: "lang", label: "Language", open: false, options: count((o) => (o.language ? [o.language] : [])).map((l) => ({ id: l, label: langName(l), test: (o) => o.language === l })) },
    { id: "finish", label: "Finish", open: false, options: present([{ id: "f", label: "Foil", test: (o) => o.foil }, { id: "n", label: "Non-foil", test: (o) => !o.foil }]) },
  ];
}

const FILTER_KEY = "collection-filters";
function readFilters(): FilterState {
  try {
    const s = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
    if (s && typeof s.sel === "object") return { sel: s.sel, min: s.min ?? "", max: s.max ?? "" };
  } catch { /* fine */ }
  return EMPTY;
}

/** The card pane for an owned card: its wish when it is still wanted, else Scryfall's card. */
export function openOwned(data: AppData, o: Owned) {
  const wish = o.scryfall_id ? data.wants?.wishes.find((w) => w.scryfall_id === o.scryfall_id) : undefined;
  if (wish) return openCard(wish.key);
  if (o.scryfall_id) openCard(`sf:${o.scryfall_id}`);
}

function OwnedRow({ o, data, n, current, extra }: { o: Owned; data: AppData; n: number; current?: boolean; extra?: preact.ComponentChildren }) {
  const value = valueOf(o), gain = gainOf(o);
  return (
    <a class="row" data-key={o.scryfall_id ? `sf:${o.scryfall_id}` : o.key} href={o.scryfall_id ? `?card=sf:${o.scryfall_id}` : undefined}
      aria-current={current ? "true" : undefined} style={{ "--n": n }}
      onClick={(e) => { e.preventDefault(); openOwned(data, o); }} onPointerEnter={() => preloadImage(o.image, 0)}>
      <CardImage src={o.thumb} alt="" foil={o.foil} />
      <div class="r-main">
        <div class="r-name"><span>{o.name}</span><ManaCost cost={o.mana_cost} front /></div>
        <div class="r-line"><SetSymbol set={o.set} rarity={o.rarity} /><span>{o.tags.length ? o.tags.map(tagName).join(", ") : "regular"}{o.set ? `, ${o.set.toUpperCase()} ${o.number ?? ""}` : ""}{o.language ? ` • ${langShort(o.language)}` : ""}</span></div>
        {extra ?? <div class="r-wish">{o.pending && <span class="pending">Saving</span>}{o.qty > 1 ? `${o.qty} copies, ` : ""}{o.condition}{o.foil ? ", foil" : ""}, {o.qty > 1 ? "last " : ""}bought {day(o.last)} on {o.markets.map((m) => MARKET[m] ?? m).join(" and ")}</div>}
      </div>
      <div class="r-price">
        {value != null ? <span class="p-worth">{eur(value)}</span> : <span class="p-none">no price yet</span>}
        {gain != null ? <span class={`chg ${gain > 0.005 ? "down" : gain < -0.005 ? "up" : "flat"}`}>{gain >= 0 ? "+" : "−"}{eur(Math.abs(gain))}<span class="wide-only"> since bought</span></span>
          : can("money") ? <span class="p-none">paid {eur(o.paid)}</span> : null}
      </div>
    </a>
  );
}

export function Collection({ data, card }: { data: AppData; card: string | null }) {
  const doc = useDoc<PurchasesDoc>("purchases").doc;
  const history = useDoc<HistoryDoc>("history").doc;
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<string>(() => sessionStorage.getItem("collection-sort") || "value");
  const [filters, setFilters] = useState<FilterState>(readFilters);
  const [sheet, setSheet] = useState(false);
  useEffect(() => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* fine */ } }, [filters]);

  const owned = useMemo(() => ownedCards([...pendingPurchases(data.edits.ops), ...(doc?.purchases ?? [])]), [doc, data.edits.ops]);
  const groups = useMemo(() => groupsFor(owned, history), [owned, history]);
  const needle = q.trim().toLowerCase();
  const searched = useMemo(() => needle ? owned.filter((o) => o.name.toLowerCase().includes(needle) || (o.set ?? "") === needle ||
    (o.set_name ?? "").toLowerCase().includes(needle) || o.tags.some((t) => t.includes(needle))) : owned, [owned, needle]);
  const price = (o: Owned) => o.now;
  const counts = useMemo(() => optionCounts(searched, groups, filters, price, qtyOf), [searched, groups, filters]);
  const shown = useMemo(() => {
    const rows = applyFilters(searched, groups, filters, price);
    const c30 = (o: Owned) => moves(series(o.scryfall_id, o.foil, history)).change30;
    const by: Record<string, (a: Owned, b: Owned) => number> = {
      value: (a, b) => (valueOf(b) ?? -1) - (valueOf(a) ?? -1),
      gain: (a, b) => (gainOf(b) ?? -1e9) - (gainOf(a) ?? -1e9),
      loss: (a, b) => (gainOf(a) ?? 1e9) - (gainOf(b) ?? 1e9),
      rise: (a, b) => (c30(b) ?? -9) - (c30(a) ?? -9),
      new: (a, b) => b.last.localeCompare(a.last),
      name: (a, b) => a.name.localeCompare(b.name),
      set: (a, b) => (a.set ?? "").localeCompare(b.set ?? "") || (parseInt(a.number ?? "0") - parseInt(b.number ?? "0")),
    };
    return rows.sort(by[sort] ?? by.value);
  }, [searched, groups, filters, sort, history]);

  const pickSort = (s: string) => { setSort(s); try { sessionStorage.setItem("collection-sort", s); } catch { /* fine */ } };
  const on = activeCount(filters);
  const total = qtyOf(owned), n = qtyOf(shown);
  const worth = shown.reduce((t, o) => t + (valueOf(o) ?? 0), 0);
  const gain = shown.reduce((t, o) => t + (gainOf(o) ?? 0), 0);
  const clear = () => setFilters(EMPTY);
  const current = card?.startsWith("sf:") ? card.slice(3) : data.byKey.get(card ?? "")?.scryfall_id;

  return (
    <div class="page wide">
      <header class="head sec-band">
        <div>
          <h1 class="title">Collection</h1>
          <p class="sub">{doc === undefined ? "Loading…" : total ? <>{total} {total === 1 ? "card" : "cards"}, worth {eur(owned.reduce((t, o) => t + (valueOf(o) ?? 0), 0))} at Cardmarket's trend</> : "Your cards, with what they're worth"}</p>
        </div>
        <a class="btn sm" href="/dashboards" onClick={link("/dashboards")}>Dashboard</a>
      </header>
      {doc === undefined && !owned.length ? <RowSkeleton /> : !owned.length ? (
        <div class="empty">
          <h2>Your collection starts here</h2>
          <p>Every card you buy shows up here: from Bought it on a card, and from your CardTrader orders. Send Claude your ManaBox export to bring in everything you already own.</p>
        </div>
      ) : (
        <div class="with-side">
          <div class="side-grid">
            <aside class="side" aria-label="Filters">
              <div class="side-head"><span>Filters</span>{on > 0 && <button type="button" class="link" onClick={clear}>Clear all</button>}</div>
              <FilterPanel groups={groups} state={filters} onChange={setFilters} counts={counts} />
            </aside>
            <div class="side-main">
              <div class="toolbar">
                <label class="field"><IconSearch /><span class="sr">Filter</span>
                  <input type="search" placeholder="Search your cards" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
                </label>
                <button type="button" class="btn sm filters-btn" aria-label={`Filters${on ? `, ${on} on` : ""}`} onClick={() => setSheet(true)}>
                  <IconFilter />Filters{on > 0 && <span class="f-on">{on}</span>}
                </button>
                <select class="select" aria-label="Sort" value={sort} onChange={(e) => pickSort((e.target as HTMLSelectElement).value)}>
                  {SORTS.filter((s) => can("money") || (s.id !== "gain" && s.id !== "loss")).map((s) => <option value={s.id}>{s.label}</option>)}
                </select>
              </div>
              {(on > 0 || needle) && (
                <div class="list-head shown-line">
                  <span class="num">{n} of {total} cards · worth {eur(worth)}{gain ? ` · ${gain >= 0 ? "+" : "−"}${eur(Math.abs(gain))} since bought` : ""}</span>
                  {on > 0 && <button type="button" class="link" onClick={clear}>Clear all</button>}
                </div>
              )}
              {shown.length ? (
                <div class="list" key={JSON.stringify([filters, sort])}>
                  {shown.map((o, i) => <OwnedRow o={o} data={data} n={i} current={!!current && current === o.scryfall_id} />)}
                </div>
              ) : <div class="empty"><h2>No cards match</h2><p>Loosen a filter, or <button type="button" class="link" onClick={clear}>clear them all</button>.</p></div>}
              <p class="hint">Worth is Cardmarket's trend for each card's finish{doc?.price_date ? ` on ${day(doc.price_date)}` : ""}, times the copies you own.{can("money") ? " Since bought compares it with what you paid." : ""}</p>
            </div>
          </div>
        </div>
      )}
      {sheet && <FilterSheet groups={groups} state={filters} onChange={setFilters} counts={counts} shown={n} onClose={() => setSheet(false)} />}
    </div>
  );
}

export { OwnedRow };
