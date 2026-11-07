import { useEffect, useMemo, useState } from "preact/hooks";
import { useDoc } from "../api";
import type { AppData } from "../data";
import { dealGap, wishCount } from "../data";
import { dismissFailed } from "../edits";
import { can, useMe } from "../access";
import { addSuggestion, dropSuggestion, useSuggestions } from "../suggestions";
import { CardImage } from "../ui/CardImage";
import { toast } from "../toast";
import { ago, day, langName } from "../format";
import { LOCAL } from "../env";
import { IconArrowDown, IconArrowUp, IconFilter, IconSearch, IconWarn } from "../ui/icons";
import { CardList, RowSkeleton } from "../ui/Row";
import { FilterPanel, FilterSheet } from "../ui/Filters";
import { EMPTY, activeCount, applyFilters, buildGroups, change30, optionCounts, priceOf, type FilterState } from "../filters";
import type { HistoryDoc, Wish } from "../types";

export { change30 };

// Each sort has the order it starts in; the arrow beside the menu reverses it (D67). "Date added" is the
// wish's place in the want-list file, where new wishes are appended, so newest first is the larger line.
type Dir = "asc" | "desc";
const SORTS: { id: string; label: string; dir: Dir }[] = [
  { id: "price", label: "Price", dir: "desc" },
  { id: "added", label: "Date added", dir: "desc" },
  { id: "drop", label: "Biggest 30-day drop", dir: "asc" },
  { id: "rise", label: "Biggest 30-day rise", dir: "desc" },
  { id: "deal", label: "Closest to a deal", dir: "asc" },
  { id: "name", label: "Name", dir: "asc" },
  { id: "set", label: "Set", dir: "asc" },
];
const startDir = (sort: string): Dir => SORTS.find((s) => s.id === sort)?.dir ?? "asc";

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
  const [dir, setDir] = useState<Dir>(() => {
    const d = sessionStorage.getItem("wants-dir");
    return d === "asc" || d === "desc" ? d : startDir(sessionStorage.getItem("wants-sort") || "deal");
  });
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
    const num: Record<string, (w: Wish) => number | null> = {
      deal: (w) => dealGap(w, data.liveOf(w.key)),
      price: (w) => priceOf(data, w),
      added: (w) => w.line,
      drop: (w) => change30(w, history.doc),
      rise: (w) => change30(w, history.doc),
    };
    const text: Record<string, (a: Wish, b: Wish) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      set: (a, b) => (a.set ?? "").localeCompare(b.set ?? "") || (parseInt(a.number ?? "0") - parseInt(b.number ?? "0")),
    };
    const sign = dir === "asc" ? 1 : -1;
    const key = num[sort];
    // cards with nothing to sort by (no price, no live copy, no history) stay last in either direction
    return rows.sort(key ? (a, b) => {
      const x = key(a), y = key(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      return sign * (x - y);
    } : (a, b) => sign * (text[sort] ?? text.name)(a, b));
  }, [searched, groups, filters, sort, dir, data, history.doc]);

  const keepSort = (s: string, d: Dir) => { try { sessionStorage.setItem("wants-sort", s); sessionStorage.setItem("wants-dir", d); } catch { /* fine */ } };
  const pickSort = (s: string) => { const d = startDir(s); setSort(s); setDir(d); keepSort(s, d); };
  const flipSort = () => { const d: Dir = dir === "asc" ? "desc" : "asc"; setDir(d); keepSort(sort, d); };
  const showChange = sort === "drop" || sort === "rise";
  const on = activeCount(filters);
  const total = wishCount(wishes), n = wishCount(shown);
  const clear = () => setFilters(EMPTY);

  return (
    <div class="page wide">
      <header class="head sec-band">
        <div>
          <h1 class="title">Want-list</h1>
          <p class="sub">
            {data.wants ? <>{total} wishes{data.wants.price_date && <>, Cardmarket prices of {day(data.wants.price_date)}</>}</> : "Loading…"}
          </p>
        </div>
      </header>
      <EditsStatus data={data} />
      <Inbox />
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
              <button type="button" class="icon-btn sort-dir" onClick={flipSort}
                aria-label={dir === "asc" ? "Ascending: tap for descending" : "Descending: tap for ascending"}
                title={dir === "asc" ? "Ascending" : "Descending"}>
                {/* the arrow points the way the list runs from its top: a big-first or newest-first list points up (D67) */}
                {dir === "asc" ? <IconArrowDown /> : <IconArrowUp />}
              </button>
            </div>
            {data.wants && (on > 0 || q.trim()) && (
              <div class="list-head shown-line">
                <span class="num">{n} of {total} wishes{on > 0 && ` · ${on} ${on === 1 ? "filter" : "filters"} on`}</span>
                {on > 0 && <button type="button" class="link" onClick={clear}>Clear all</button>}
              </div>
            )}
            {!data.wants ? <RowSkeleton /> : shown.length ? (
              <CardList data={data} current={card} swap={JSON.stringify([filters, sort, dir])} items={shown.map((w) => {
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
          {(can("edit") || can("bought")) && <button class="btn sm" type="button" onClick={() => dismissFailed()}>Dismiss</button>}
        </div>
      )}
    </>
  );
}


/** Cards suggested for the want-list (D76): for me to add or dismiss, or someone's own, waiting. */
function Inbox() {
  const me = useMe();
  const list = useSuggestions(me.owner || can("suggest"));
  const [busy, setBusy] = useState<string | null>(null);
  if (!list.length) return null;
  const act = async (id: string, run: (id: string) => Promise<void>, done: string) => {
    setBusy(id);
    try { await run(id); toast(done); } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <section class="inbox" aria-label="Suggestions">
      <div class="group-title">{me.owner ? `Suggested for you · ${list.length}` : "Your suggestions, waiting for a yes"}</div>
      <div class="group">
        {list.map((s) => {
          const c = s.card;
          const how = [c.set ? `${c.set.toUpperCase()} ${c.number ?? ""}`.trim() : null,
            s.settings.language && s.settings.language !== "en" ? langName(s.settings.language) : null,
            s.settings.foil === "yes" ? "foil" : s.settings.foil === "no" ? "non-foil" : null].filter(Boolean).join(" · ");
          return (
            <div class="inbox-row">
              <CardImage src={c.thumb ?? null} alt="" foil={s.settings.foil === "yes"} />
              <div class="r-main">
                <div class="r-name"><span>{c.name ?? "A card"}</span></div>
                <div class="r-line"><span>{how}</span></div>
                <div class="r-wish">{me.owner ? `${s.name}, ${ago(s.at)}` : `sent ${ago(s.at)}`}{s.settings.note ? ` · “${s.settings.note}”` : ""}</div>
              </div>
              <div class="inbox-acts">
                {me.owner && <button class="btn sm primary" type="button" disabled={busy === s.id}
                  onClick={() => act(s.id, addSuggestion, `Added ${c.name ?? "it"} to the want-list.`)}>Add</button>}
                <button class="btn sm" type="button" disabled={busy === s.id}
                  onClick={() => act(s.id, dropSuggestion, me.owner ? "Dismissed." : "Taken back.")}>{me.owner ? "Dismiss" : "Take back"}</button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
