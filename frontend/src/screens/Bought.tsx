// Cards I bought, as a small dashboard: what I paid, what it saved against Cardmarket's trend that
// day, what the cards are worth now, month by month, where the money went, then every purchase.
// Its own page since 2026-11-06 (was a segment of the Want-list).
import { useMemo, useState } from "preact/hooks";
import { useDoc } from "../api";
import type { AppData } from "../data";
import { pendingPurchases } from "../edits";
import { day, eur, tagName } from "../format";
import { CardImage } from "../ui/CardImage";
import { IconSearch } from "../ui/icons";
import { RowSkeleton } from "../ui/Row";
import { SetSymbol } from "../ui/symbols";
import type { Purchase, PurchasesDoc } from "../types";
import "./bought.css";

const MARKET: Record<string, string> = { cardtrader: "CardTrader", cardmarket: "Cardmarket", other: "Elsewhere" };

const sum = (rows: Purchase[], f: (p: Purchase) => number) => rows.reduce((t, p) => t + f(p), 0);
const pct = (v: number) => `${Math.round(Math.abs(v) * 100)}%`;
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${eur(Math.abs(v))}`;
const tone = (v: number) => (v > 0.005 ? "good" : v < -0.005 ? "bad" : "flat");

/** Paid, saved against the trend that day, and what the same cards are worth now. */
function totals(rows: Purchase[]) {
  const compared = rows.filter((p) => p.cardmarket != null);
  const valued = rows.filter((p) => p.now != null);
  const trend = sum(compared, (p) => p.cardmarket!);
  const saved = sum(compared, (p) => p.cardmarket! - p.price);
  const worth = sum(valued, (p) => p.now!);
  const worthPaid = sum(valued, (p) => p.price);
  return {
    paid: sum(rows, (p) => p.price), saved, under: trend > 0 ? saved / trend : null, compared: compared.length,
    worth, gain: worth - worthPaid, valued: valued.length,
  };
}

// ---------- month by month ----------

interface Month { key: string; label: string; year: number; paid: number; market: number; saved: number; cards: number }

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** The last 6 to 12 months up to this one (as far back as the first purchase, at least 6). */
function months(rows: Purchase[], today = new Date()): Month[] {
  const first = rows.reduce((m, p) => (p.date < m ? p.date : m), monthKey(today));
  const [fy, fm] = first.slice(0, 7).split("-").map(Number);
  const span = (today.getFullYear() - fy) * 12 + today.getMonth() + 1 - fm + 1;
  const n = Math.min(12, Math.max(6, span));
  const out: Month[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    out.push({ key: monthKey(d), label: d.toLocaleDateString("en-GB", { month: "short" }), year: d.getFullYear(), paid: 0, market: 0, saved: 0, cards: 0 });
  }
  const at = new Map(out.map((m) => [m.key, m]));
  for (const p of rows) {
    const m = at.get(p.date.slice(0, 7));
    if (!m) continue;
    m.paid += p.price; m.cards += 1;
    m.market += p.cardmarket ?? p.price;
    m.saved += p.cardmarket != null ? p.cardmarket - p.price : 0;
  }
  return out;
}

function niceMax(v: number): number {
  if (v <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= v) ?? 10 * mag);
}

function Months({ rows }: { rows: Purchase[] }) {
  const data = useMemo(() => months(rows), [rows]);
  const [active, setActive] = useState<number | null>(null);
  const top = niceMax(Math.max(...data.map((m) => Math.max(m.paid, m.market))));
  const ticks = [top / 2, top];
  const now = data[data.length - 1], last = data[data.length - 2];
  const shown = active != null ? data[active] : null;
  // the tip sits beside the month, on the side with room, so it never hides the bars it describes
  const left = active != null && active < data.length / 2;

  return (
    <section class="bt-card">
      <div class="bt-card-head">
        <h2>Month by month</h2>
        <span>{now.cards ? `${eur(now.paid)} this month` : "Nothing this month"}{last ? `, ${last.cards ? eur(last.paid) : "nothing"} in ${last.label}` : ""}</span>
      </div>
      <div class="bt-legend" aria-hidden="true">
        <span><i class="k-paid" />Paid</span>
        <span><i class="k-cm" />At Cardmarket's trend</span>
      </div>
      <div class="bt-plot" onMouseLeave={() => setActive(null)}>
        <div class="bt-ticks" aria-hidden="true">
          {ticks.map((t) => <div class="bt-tick" style={{ bottom: `${(t / top) * 100}%` }}><span>{eur(t).replace(/[.,]00(?=\D*$)/, "")}</span></div>)}
        </div>
        <div class="bt-cols" style={{ "--cols": data.length }}>
          {data.map((m, i) => (
            <button type="button" class="bt-col" style={{ "--i": i }} aria-pressed={active === i}
              aria-label={`${m.label} ${m.year}: paid ${eur(m.paid)} for ${m.cards} ${m.cards === 1 ? "card" : "cards"}, ${eur(m.market)} at Cardmarket's trend`}
              onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
              onClick={() => setActive(active === i ? null : i)}>
              <span class="bt-bars">
                <span class="bt-bar cm" style={{ height: `${(m.market / top) * 100}%` }} />
                <span class="bt-bar paid" style={{ height: `${(m.paid / top) * 100}%` }} />
              </span>
              <span class="bt-x">{m.label}{m.key.endsWith("-01") || i === 0 ? <small> {String(m.year).slice(2)}</small> : null}</span>
            </button>
          ))}
          {shown && (
            <div class={`bt-tip ${left ? "right" : "left"}`} role="status"
              style={{ left: `${((left ? active! + 1 : active!) / data.length) * 100}%` }}>
              <b>{shown.label} {shown.year}</b>
              {shown.cards ? (
                <>
                  <span><i class="k-paid" />Paid <em>{eur(shown.paid)}</em></span>
                  <span><i class="k-cm" />Cardmarket <em>{eur(shown.market)}</em></span>
                  <span class={`bt-tip-saved ${tone(shown.saved)}`}>{shown.saved >= 0 ? "Saved" : "Over"} <em>{eur(Math.abs(shown.saved))}</em></span>
                  <small>{shown.cards} {shown.cards === 1 ? "card" : "cards"}</small>
                </>
              ) : <small>Nothing bought</small>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- where the money went ----------

type By = "market" | "set" | "version" | "list";
const BY: { id: By; label: string }[] = [
  { id: "market", label: "Market" }, { id: "set", label: "Set" }, { id: "version", label: "Version" }, { id: "list", label: "List" },
];
const SHOWN_GROUPS = 6;

function labelsOf(p: Purchase, by: By): string[] {
  if (by === "market") return [MARKET[p.market] ?? p.market];
  if (by === "set") return [p.set_name ?? (p.set ? p.set.toUpperCase() : "Unknown set")];
  if (by === "version") {
    const v = p.tags.length ? p.tags.map(tagName).join(", ") : "regular";
    return [(v[0].toUpperCase() + v.slice(1)) + (p.foil ? ", foil" : "")];
  }
  return p.lists.length ? p.lists : ["On no list"];
}

interface Group { label: string; paid: number; cards: number; saved: number; trend: number }

function groups(rows: Purchase[], by: By): Group[] {
  const at = new Map<string, Group>();
  for (const p of rows) {
    for (const label of labelsOf(p, by)) {
      const g = at.get(label) ?? { label, paid: 0, cards: 0, saved: 0, trend: 0 };
      g.paid += p.price; g.cards += 1;
      if (p.cardmarket != null) { g.saved += p.cardmarket - p.price; g.trend += p.cardmarket; }
      at.set(label, g);
    }
  }
  const all = [...at.values()].sort((a, b) => b.paid - a.paid || a.label.localeCompare(b.label));
  if (all.length <= SHOWN_GROUPS) return all;
  const rest = all.slice(SHOWN_GROUPS - 1);
  return [...all.slice(0, SHOWN_GROUPS - 1), rest.reduce((o, g) => ({
    ...o, paid: o.paid + g.paid, cards: o.cards + g.cards, saved: o.saved + g.saved, trend: o.trend + g.trend,
  }), { label: `${rest.length} more`, paid: 0, cards: 0, saved: 0, trend: 0 })];
}

function Breakdown({ rows }: { rows: Purchase[] }) {
  const [by, setBy] = useState<By>("market");
  const list = useMemo(() => groups(rows, by), [rows, by]);
  const max = Math.max(...list.map((g) => g.paid), 0.01);
  return (
    <section class="bt-card">
      <div class="bt-card-head">
        <h2>Where the money went</h2>
        <div class="seg" role="group" aria-label="Group by">
          {BY.map((b) => <button type="button" aria-pressed={by === b.id} onClick={() => setBy(b.id)}>{b.label}</button>)}
        </div>
      </div>
      <ul class="bt-groups" key={by}>
        {list.map((g, i) => (
          <li style={{ "--i": i }}>
            <div class="bt-g-line">
              <span class="bt-g-name">{g.label}</span>
              <b>{eur(g.paid)}</b>
            </div>
            <div class="bt-g-bar"><span style={{ width: `${(g.paid / max) * 100}%` }} /></div>
            <div class="bt-g-sub">
              <span>{g.cards} {g.cards === 1 ? "card" : "cards"}</span>
              {g.trend > 0 && <span class={tone(g.saved)}>{pct(g.saved / g.trend)} {g.saved >= 0 ? "under" : "over"} Cardmarket</span>}
            </div>
          </li>
        ))}
      </ul>
      {by === "list" && rows.some((p) => p.lists.length > 1) && <p class="hint">A card on two lists counts in both.</p>}
    </section>
  );
}

// ---------- every purchase ----------

type Sort = "new" | "deal" | "gain" | "price";
const SORTS: { id: Sort; label: string }[] = [
  { id: "new", label: "Newest" }, { id: "deal", label: "Best deal" }, { id: "gain", label: "Gained" }, { id: "price", label: "Price" },
];
const dealOf = (p: Purchase) => (p.cardmarket ? (p.cardmarket - p.price) / p.cardmarket : -Infinity);
const gainOf = (p: Purchase) => (p.now != null ? p.now - p.price : -Infinity);
const SORT_BY: Record<Sort, ((a: Purchase, b: Purchase) => number) | null> = {
  new: null,
  deal: (a, b) => dealOf(b) - dealOf(a),
  gain: (a, b) => gainOf(b) - gainOf(a),
  price: (a, b) => b.price - a.price,
};

function Row({ p, n }: { p: Purchase; n: number }) {
  const gain = p.now != null ? p.now - p.price : null;
  return (
    <div class="row static" style={{ "--n": n }}>
      <CardImage src={p.thumb} alt="" foil={p.foil} />
      <div class="r-main">
        <div class="r-name"><span>{p.name}</span></div>
        <div class="r-line"><SetSymbol set={p.set} rarity={p.rarity} /><span>{p.tags.length ? p.tags.map(tagName).join(", ") : "regular"}{p.set ? `, ${p.set.toUpperCase()} ${p.number}` : ""}</span></div>
        <div class="r-wish">{p.pending && <span class="pending">Saving</span>}{day(p.date)}, {MARKET[p.market] ?? p.market}, {p.condition}{p.foil ? ", foil" : ""}</div>
      </div>
      <div class="r-price">
        <span class="p-paid">{eur(p.price)}</span>
        {p.saved != null && <span class={`chg ${p.saved > 0 ? "down" : p.saved < 0 ? "up" : "flat"}`}>{p.saved >= 0 ? `saved ${eur(p.saved)}` : `${eur(-p.saved)} over`}</span>}
        {gain != null && <span class="bt-now">now {eur(p.now)} <i class={tone(gain)} aria-label={gain > 0.005 ? "up" : gain < -0.005 ? "down" : "same"}>{gain > 0.005 ? "▲" : gain < -0.005 ? "▼" : "="}</i></span>}
      </div>
    </div>
  );
}

// ---------- the page ----------

export function Bought({ data }: { data: AppData }) {
  const doc = useDoc<PurchasesDoc>("purchases").doc;
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("all");
  const [sort, setSort] = useState<Sort>("new");
  const all = useMemo(() => [...pendingPurchases(data.edits.ops), ...(doc?.purchases ?? [])], [data.edits.ops, doc]);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => all.filter((p) => (market === "all" || p.market === market) &&
    (!needle || p.name.toLowerCase().includes(needle) || (p.set ?? "").toLowerCase() === needle ||
      (p.set_name ?? "").toLowerCase().includes(needle) || p.lists.some((l) => l.toLowerCase().includes(needle)))), [all, market, needle]);
  const sorted = useMemo(() => (SORT_BY[sort] ? [...rows].sort(SORT_BY[sort]!) : rows), [rows, sort]);
  const t = totals(rows);
  const markets = ["all", ...new Set(all.map((p) => p.market))];
  const thisMonth = monthKey(new Date());
  const monthCards = rows.filter((p) => p.date.startsWith(thisMonth)).length;

  return (
    <div class="page">
      <header class="head"><div><h1 class="title">Bought</h1><p class="sub">What I paid, what it saved against Cardmarket, what it's worth now</p></div></header>
      {all.length > 0 && (
        <div class="toolbar">
          {markets.length > 2 && (
            <div class="seg" role="group" aria-label="Market">
              {markets.map((m) => <button type="button" aria-pressed={market === m} onClick={() => setMarket(m)}>{m === "all" ? "All" : MARKET[m] ?? m}</button>)}
            </div>
          )}
          <label class="field"><IconSearch /><span class="sr">Filter</span>
            <input type="search" placeholder="Search cards, sets or lists" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </label>
        </div>
      )}
      {doc === undefined && !all.length ? <RowSkeleton n={3} /> : !all.length ? (
        <div class="empty"><h2>Nothing bought yet</h2><p>On a card's page, tap <b>Bought it</b> to record what you paid. It shows here with what you saved against Cardmarket.</p></div>
      ) : !rows.length ? (
        <div class="empty"><h2>Nothing matches</h2><p>Try another name, set, list or market.</p></div>
      ) : (
        <>
          <div class="bt-stats">
            <div class="bt-stat lead">
              <span class="label">Saved against Cardmarket</span>
              <b class={`fig ${t.saved >= 0 ? "good" : "bad"}`}>{eur(Math.abs(t.saved))}{t.saved < 0 ? " more" : ""}</b>
              <small>{t.under != null ? `${pct(t.under)} ${t.under >= 0 ? "under" : "over"} the trend` : "No Cardmarket price to compare"}</small>
            </div>
            <div class="bt-stat">
              <span class="label">Paid</span>
              <b class="fig">{eur(t.paid)}</b>
              <small>{eur(t.paid / rows.length)} a card</small>
            </div>
            <div class="bt-stat">
              <span class="label">Worth now</span>
              <b class="fig">{t.valued ? eur(t.worth) : "–"}</b>
              <small>{t.valued
                ? <><span class={tone(t.gain)}>{signed(t.gain)}</span> since bought{t.valued < rows.length ? `, ${t.valued} of ${rows.length}` : ""}</>
                : "With the next price update"}</small>
            </div>
            <div class="bt-stat">
              <span class="label">Cards</span>
              <b class="fig">{rows.length}</b>
              <small>{monthCards ? `${monthCards} this month` : "None this month"}</small>
            </div>
          </div>

          <div class="bt-grid">
            <Months rows={rows} />
            <Breakdown rows={rows} />
          </div>

          <div class="bt-list-head">
            <h2>Cards <span>{rows.length}</span></h2>
            <div class="seg" role="group" aria-label="Sort">
              {SORTS.map((s) => <button type="button" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>)}
            </div>
          </div>
          <div class="list" key={sort}>
            {sorted.map((p, i) => <Row p={p} n={i} />)}
          </div>
          <p class="hint">
            Saved is the difference with Cardmarket's trend for that finish on the day you bought, before shipping.
            {doc?.price_date ? ` Worth now is Cardmarket's trend on ${day(doc.price_date)}.` : ""}
          </p>
        </>
      )}
    </div>
  );
}
