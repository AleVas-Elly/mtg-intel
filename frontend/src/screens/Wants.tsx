import { useMemo, useState } from "preact/hooks";
import { useDoc } from "../api";
import type { AppData } from "../data";
import { dealRatio, wishCount } from "../data";
import { cmTrend, day, foilOnly, showsFoil } from "../format";
import { IconSearch } from "../ui/icons";
import { CardList, RowSkeleton } from "../ui/Row";
import type { HistoryDoc, Wish } from "../types";

const SORTS = [
  { id: "deal", label: "Closest to a deal" },
  { id: "price", label: "Highest price" },
  { id: "drop", label: "Biggest 30-day drop" },
  { id: "rise", label: "Biggest 30-day rise" },
  { id: "name", label: "Name" },
  { id: "set", label: "Set" },
];

/** Cardmarket trend change over 30 days, from the price history (MTGJSON then our own days). */
export function change30(w: Wish, history: HistoryDoc | null | undefined): number | null {
  if (!history?.base || !w.scryfall_id) return null;
  const card = history.cards[w.scryfall_id];
  if (!card) return null;
  const finish = showsFoil(w) || (foilOnly(w)) ? "foil" : "normal";
  const points = new Map<number, number>();
  for (const source of ["mtgjson", "cardmarket"]) {
    const s = card[source]?.[finish] ?? [];
    for (let i = 0; i < s.length; i += 2) points.set(s[i], s[i + 1]);
  }
  if (points.size < 2) return null;
  const days = [...points.keys()].sort((a, b) => a - b);
  const last = days[days.length - 1];
  const then = [...days].reverse().find((d) => d <= last - 30);
  if (then == null) return null;
  const a = points.get(then)!, b = points.get(last)!;
  return a ? (b - a) / a : null;
}

export function Wants({ data, card }: { data: AppData; card: string | null }) {
  const [list, setList] = useState<string>(() => sessionStorage.getItem("wants-list") || "All");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<string>(() => sessionStorage.getItem("wants-sort") || "deal");
  const history = useDoc<HistoryDoc>(sort === "drop" || sort === "rise" ? "history" : null);
  const wishes = data.wants?.wishes ?? [];
  const lists = useMemo(() => ["All", ...new Set(wishes.flatMap((w) => w.lists))], [wishes]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = wishes.filter((w) =>
      (list === "All" || w.lists.includes(list)) &&
      (!needle || w.name.toLowerCase().includes(needle) || (w.set ?? "").toLowerCase() === needle ||
        (w.set_name ?? "").toLowerCase().includes(needle) || w.tags.some((t) => t.includes(needle))));
    const price = (w: Wish) => cmTrend(w, data.liveOf(w.key)?.foil) ?? -1;
    const by: Record<string, (a: Wish, b: Wish) => number> = {
      deal: (a, b) => (dealRatio(a, data.liveOf(a.key)) ?? 9) - (dealRatio(b, data.liveOf(b.key)) ?? 9),
      price: (a, b) => price(b) - price(a),
      drop: (a, b) => (change30(a, history.doc) ?? 9) - (change30(b, history.doc) ?? 9),
      rise: (a, b) => (change30(b, history.doc) ?? -9) - (change30(a, history.doc) ?? -9),
      name: (a, b) => a.name.localeCompare(b.name),
      set: (a, b) => (a.set ?? "").localeCompare(b.set ?? "") || (parseInt(a.number ?? "0") - parseInt(b.number ?? "0")),
    };
    return rows.sort(by[sort] ?? by.deal);
  }, [wishes, list, q, sort, data.live, history.doc]);

  const pick = (l: string) => { setList(l); try { sessionStorage.setItem("wants-list", l); } catch { /* fine */ } };
  const pickSort = (s: string) => { setSort(s); try { sessionStorage.setItem("wants-sort", s); } catch { /* fine */ } };
  const showChange = sort === "drop" || sort === "rise";

  return (
    <div class="page">
      <header class="head">
        <div>
          <h1 class="title">Want-list</h1>
          <p class="sub">
            {data.wants ? <>{wishCount(wishes)} wishes{data.wants.price_date && <>, Cardmarket prices of {day(data.wants.price_date)}</>}</> : "Loading…"}
          </p>
        </div>
      </header>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="List">
          {lists.map((l) => (
            <button type="button" aria-pressed={list === l} onClick={() => pick(l)}>
              {l}<small>{wishCount(l === "All" ? wishes : wishes.filter((w) => w.lists.includes(l)))}</small>
            </button>
          ))}
        </div>
        <label class="field"><IconSearch /><span class="sr">Filter</span>
          <input type="search" placeholder="Search cards" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
        <select class="select" aria-label="Sort" value={sort} onChange={(e) => pickSort((e.target as HTMLSelectElement).value)}>
          {SORTS.map((s) => <option value={s.id}>{s.label}</option>)}
        </select>
      </div>
      {!data.wants ? <RowSkeleton /> : shown.length ? (
        <CardList data={data} current={card} items={shown.map((w) => {
          const c = showChange ? change30(w, history.doc) : null;
          return {
            w, extra: showChange && c != null ? (
              <div class={`r-wish chg ${c <= -0.02 ? "down" : c >= 0.02 ? "up" : "flat"}`}>{c > 0 ? "+" : ""}{Math.round(c * 100)}% on Cardmarket in 30 days</div>
            ) : undefined,
          };
        })} />
      ) : (
        <div class="empty"><h2>Nothing matches “{q}”</h2><p>Try a card name, a set code like <b>msh</b>, or a version like <b>borderless</b>.</p></div>
      )}
      <p class="hint">Green dot: CardTrader's cheapest copy that fits the wish, right now. Blue square: Cardmarket's trend for that finish (all sellers, all conditions, once a day).</p>
    </div>
  );
}
