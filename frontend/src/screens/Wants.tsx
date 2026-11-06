import { useEffect, useMemo, useState } from "preact/hooks";
import { useDoc } from "../api";
import type { AppData } from "../data";
import { dealGap, wishCount } from "../data";
import { day } from "../format";
import { dismissFailed } from "../edits";
import { LOCAL } from "../env";
import { IconFilter, IconSearch, IconWarn } from "../ui/icons";
import { CardList, RowSkeleton } from "../ui/Row";
import { FilterPanel, FilterSheet } from "../ui/Filters";
import { EMPTY, activeCount, applyFilters, buildGroups, change30, optionCounts, priceOf, type FilterState } from "../filters";
import type { HistoryDoc, Wish } from "../types";

export { change30 };

const SORTS = [
  { id: "deal", label: "Closest to a deal" },
  { id: "price", label: "Highest price" },
  { id: "drop", label: "Biggest 30-day drop" },
  { id: "rise", label: "Biggest 30-day rise" },
  { id: "name", label: "Name" },
  { id: "set", label: "Set" },
];

const FILTER_KEY = "wants-filters";
function readFilters(): FilterState {
  try {
    const s = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
    if (s && typeof s.sel === "object") return { sel: s.sel, min: s.min ?? "", max: s.max ?? "" };
  } catch { /* fine */ }
  return EMPTY;
}

export function Wants({ data, card }: { data: AppData; card: string | null }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<string>(() => sessionStorage.getItem("wants-sort") || "deal");
  const [filters, setFilters] = useState<FilterState>(readFilters);
  const [sheet, setSheet] = useState(false);
  // price history feeds "Lowest in 90 days", the 30-day moves and their sorts
  const history = useDoc<HistoryDoc>("history");
  const wishes = data.wants?.wishes ?? [];
  useEffect(() => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* fine */ } }, [filters]);

  const groups = useMemo(() => buildGroups(wishes, data, history.doc), [wishes, data, history.doc]);
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? wishes.filter((w) => w.name.toLowerCase().includes(needle) || (w.set ?? "").toLowerCase() === needle ||
      (w.set_name ?? "").toLowerCase().includes(needle) || w.tags.some((t) => t.includes(needle))) : wishes;
  }, [wishes, q]);
  const counts = useMemo(() => optionCounts(searched, groups, filters, (w) => priceOf(data, w), wishCount), [searched, groups, filters, data]);

  const shown = useMemo(() => {
    const rows = applyFilters(searched, groups, filters, (w) => priceOf(data, w));
    const price = (w: Wish) => priceOf(data, w) ?? -1;
    const by: Record<string, (a: Wish, b: Wish) => number> = {
      deal: (a, b) => (dealGap(a, data.liveOf(a.key)) ?? 999) - (dealGap(b, data.liveOf(b.key)) ?? 999),
      price: (a, b) => price(b) - price(a),
      drop: (a, b) => (change30(a, history.doc) ?? 9) - (change30(b, history.doc) ?? 9),
      rise: (a, b) => (change30(b, history.doc) ?? -9) - (change30(a, history.doc) ?? -9),
      name: (a, b) => a.name.localeCompare(b.name),
      set: (a, b) => (a.set ?? "").localeCompare(b.set ?? "") || (parseInt(a.number ?? "0") - parseInt(b.number ?? "0")),
    };
    return rows.sort(by[sort] ?? by.deal);
  }, [searched, groups, filters, sort, data, history.doc]);

  const pickSort = (s: string) => { setSort(s); try { sessionStorage.setItem("wants-sort", s); } catch { /* fine */ } };
  const showChange = sort === "drop" || sort === "rise";
  const on = activeCount(filters);
  const total = wishCount(wishes), n = wishCount(shown);
  const clear = () => setFilters(EMPTY);

  return (
    <div class="page wide">
      <header class="head">
        <div>
          <h1 class="title">Want-list</h1>
          <p class="sub">
            {data.wants ? <>{total} wishes{data.wants.price_date && <>, Cardmarket prices of {day(data.wants.price_date)}</>}</> : "Loading…"}
          </p>
        </div>
      </header>
      <EditsStatus data={data} />
      <div class="with-side">
        <div class="side-grid">
          <aside class="side" aria-label="Filters">
            <div class="side-head"><span>Filters</span>{on > 0 && <button type="button" class="link" onClick={clear}>Clear all</button>}</div>
            <FilterPanel groups={groups} state={filters} onChange={setFilters} counts={counts} />
          </aside>
          <div class="side-main">
            <div class="toolbar">
              <label class="field"><IconSearch /><span class="sr">Filter</span>
                <input type="search" placeholder="Search cards" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
              </label>
              <button type="button" class="btn sm filters-btn" aria-label={`Filters${on ? `, ${on} on` : ""}`} onClick={() => setSheet(true)}>
                <IconFilter />Filters{on > 0 && <span class="f-on">{on}</span>}
              </button>
              <select class="select" aria-label="Sort" value={sort} onChange={(e) => pickSort((e.target as HTMLSelectElement).value)}>
                {SORTS.map((s) => <option value={s.id}>{s.label}</option>)}
              </select>
            </div>
            {data.wants && (on > 0 || q.trim()) && (
              <div class="list-head shown-line">
                <span class="num">{n} of {total} wishes{on > 0 && ` · ${on} ${on === 1 ? "filter" : "filters"} on`}</span>
                {on > 0 && <button type="button" class="link" onClick={clear}>Clear all</button>}
              </div>
            )}
            {!data.wants ? <RowSkeleton /> : shown.length ? (
              <CardList data={data} current={card} swap={JSON.stringify([filters, sort])} items={shown.map((w) => {
                const c = showChange ? change30(w, history.doc) : null;
                return {
                  w, extra: showChange && c != null ? (
                    <div class={`r-wish chg ${c <= -0.02 ? "down" : c >= 0.02 ? "up" : "flat"}`}>{c > 0 ? "+" : ""}{Math.round(c * 100)}% on Cardmarket in 30 days</div>
                  ) : undefined,
                };
              })} />
            ) : q.trim() && !on ? (
              <div class="empty"><h2>Nothing matches “{q}”</h2><p>Try a card name, a set code like <b>msh</b>, or a version like <b>borderless</b>.</p></div>
            ) : (
              <div class="empty"><h2>No wishes match</h2><p>Loosen a filter, or <button type="button" class="link" onClick={clear}>clear them all</button>.</p></div>
            )}
            <p class="hint">Green dot: CardTrader's cheapest copy that fits the wish, right now. Blue square: Cardmarket's trend for that finish (all sellers, all conditions, once a day).</p>
          </div>
        </div>
      </div>
      {sheet && <FilterSheet groups={groups} state={filters} onChange={setFilters} counts={counts} shown={n} onClose={() => setSheet(false)} />}
    </div>
  );
}

/** Changes made here that are still on their way into the want-list file, or that failed. */
function EditsStatus({ data }: { data: AppData }) {
  const { ops, failed } = data.edits;
  if (!ops.length && !failed.length) return null;
  return (
    <>
      {ops.length > 0 && (
        <div class="notice saving">{LOCAL
          ? "This is the local test copy: changes stay here and are never saved to your real want-list."
          : `Saving ${ops.length === 1 ? "1 change" : `${ops.length} changes`} to the want-list. It usually takes a minute or two.`}</div>
      )}
      {failed.length > 0 && (
        <div class="notice">
          <IconWarn />
          <span>{failed.length === 1 ? "1 change couldn't be saved" : `${failed.length} changes couldn't be saved`}:{" "}
            {failed.map((f) => `${(f.card?.name as string | undefined) ?? f.key?.split("|")[0] ?? "a card"} (${f.message})`).join("; ")}.</span>
          <button class="btn sm" type="button" onClick={() => dismissFailed()}>Dismiss</button>
        </div>
      )}
    </>
  );
}
