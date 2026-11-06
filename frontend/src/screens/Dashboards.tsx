// Dashboards (D60): two of them. Want-list: what finishing it costs, whether it's getting cheaper,
// what to buy now, and the buying record (from the old Bought page). Collection: what it's worth,
// how it moved, what to consider selling. Both: set completion.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useDoc } from "../api";
import { bestNow, completionBySet, gainOf, moves, ownedCards, series, toBuy, totalOverTime, valueOf, type Owned } from "../collection";
import type { AppData } from "../data";
import { dealGap, wishCount } from "../data";
import { pendingPurchases } from "../edits";
import { atLow90 } from "../filters";
import { day, eur, showsFoil } from "../format";
import { go, link, openCard } from "../router";
import { CardImage } from "../ui/CardImage";
import { SetSymbol } from "../ui/symbols";
import type { HistoryDoc, PurchasesDoc, Wish } from "../types";
import { openOwned } from "./Collection";
import { Breakdown, Months, pct, signed, tone, totals } from "./Bought";
import "./bought.css";
import "./dashboards.css";

type Tab = "wants" | "collection";

// ---------- shared pieces ----------

/** Open the Want-list or the Collection with one filter set, e.g. a set or a list (D62). */
function openFiltered(path: "/wants" | "/collection", group: string, id: string) {
  try { localStorage.setItem(path === "/wants" ? "wants-filters" : "collection-filters", JSON.stringify({ sel: { [group]: [id] }, min: "", max: "" })); } catch { /* fine */ }
  go(path);
  window.scrollTo({ top: 0 });
}

const fmtDay = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** A value over time: one line with a flat tint under it. Point at it (or use the arrow keys) to
 *  read any day's value and its change since the start of the range. */
function Line({ line, label }: { line: { t: number; v: number }[]; label: string }) {
  const [at, setAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  if (line.length < 2) return <div class="chart-empty">Not enough price history yet.</div>;
  const W = 640, H = 170, P = 6;
  const vs = line.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || hi || 1;
  const x = (i: number) => P + (i / (line.length - 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - lo) / span) * (H - 2 * P);
  const d = line.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = line[line.length - 1];
  const pick = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    setAt(Math.max(0, Math.min(line.length - 1, Math.round(((clientX - r.left) / r.width) * (line.length - 1)))));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setAt((a) => Math.max(0, Math.min(line.length - 1, (a ?? line.length - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
  };
  const p = at != null ? line[at] : null;
  const change = p && line[0].v ? (p.v - line[0].v) / line[0].v : null;
  return (
    <figure class="db-line" aria-label={label}>
      <div class="db-plot" ref={box} tabIndex={0} role="img" aria-label={`${label}: from ${eur(line[0].v)} to ${eur(last.v)}. Arrow keys read each day.`}
        onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={() => setAt(null)} onKeyDown={key} onBlur={() => setAt(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <path class="db-area" d={`${d}L${x(line.length - 1)},${H}L${x(0)},${H}Z`} />
          <path class="db-path" d={d} vector-effect="non-scaling-stroke" />
          {at != null && <line class="db-cross" x1={x(at)} x2={x(at)} y1={0} y2={H} vector-effect="non-scaling-stroke" />}
        </svg>
        <span class="db-mark" style={{ left: `${(x(at ?? line.length - 1) / W) * 100}%`, top: `${(y((p ?? last).v) / H) * 100}%` }} />
        {p && (
          <div class={`db-tip ${at! > line.length / 2 ? "left" : "right"}`} style={{ left: `${(x(at!) / W) * 100}%` }} role="status">
            <b class="fig">{eur(p.v)}</b>
            <span>{fmtDay(p.t)}</span>
            {change != null && at! > 0 && <span class={change >= 0 ? "good" : "bad"}>{change >= 0 ? "+" : "−"}{pct(change)} since {fmtDay(line[0].t)}</span>}
          </div>
        )}
      </div>
      <figcaption><span>{fmtDay(line[0].t)} · {eur(line[0].v)}</span><span>high {eur(hi)} · low {eur(lo)}</span><span>{fmtDay(last.t)} · {eur(last.v)}</span></figcaption>
    </figure>
  );
}

/** A value line with its own range switch (30 or 90 days) and the change over the range. */
function ValueCard({ title, make, label, hint, upIsGood }: {
  title: string; make: (span: number) => { line: { t: number; v: number }[]; of: number }; label: string;
  hint: (of: number) => ComponentChildren; upIsGood: boolean;
}) {
  const [span, setSpan] = useState(90);
  const { line, of } = useMemo(() => make(span), [make, span]);
  const c = line.length > 1 && line[0].v ? (line[line.length - 1].v - line[0].v) / line[0].v : null;
  return (
    <Card title={title} wide aside={
      <span class="db-range">
        {c != null && <span class={(c >= 0) === upIsGood ? "good" : "bad"}>{c >= 0 ? "up" : "down"} {pct(c)}</span>}
        <span class="seg" role="group" aria-label="Range">
          {[30, 90].map((d) => <button type="button" aria-pressed={span === d} onClick={() => setSpan(d)}>{d} days</button>)}
        </span>
      </span>
    }>
      <Line key={span} line={line} label={label} />
      <p class="hint">{hint(of)}</p>
    </Card>
  );
}

function Card({ title, aside, children, wide }: { title: string; aside?: ComponentChildren; children: ComponentChildren; wide?: boolean }) {
  return (
    <section class={`bt-card db-card${wide ? " wide" : ""}`}>
      <div class="bt-card-head"><h2>{title}</h2>{aside && <span>{aside}</span>}</div>
      {children}
    </section>
  );
}

function Stat({ label, value, note, lead, cls, to }: { label: string; value: string; note?: ComponentChildren; lead?: boolean; cls?: string; to?: () => void }) {
  const inner = <><span class="label">{label}</span><b class={`fig ${cls ?? ""}`}>{value}</b>{note && <small>{note}</small>}</>;
  return to
    ? <button type="button" class={`bt-stat go${lead ? " lead" : ""}`} onClick={to}>{inner}<span class="db-go" aria-hidden="true">→</span></button>
    : <div class={`bt-stat${lead ? " lead" : ""}`}>{inner}</div>;
}

/** A short list of cards, each with one figure and one line of why. */
function CardRows({ rows, empty }: { rows: { key: string; thumb: string | null; foil: boolean; name: string; set: string | null; rarity: string | null; line: ComponentChildren; figure: string; sub?: ComponentChildren; open: () => void }[]; empty: string }) {
  if (!rows.length) return <p class="db-empty">{empty}</p>;
  return (
    <ul class="db-rows">
      {rows.map((r, i) => (
        <li style={{ "--i": i }}>
          <button type="button" class="db-row" onClick={r.open}>
            <CardImage src={r.thumb} alt="" foil={r.foil} />
            <span class="db-row-main"><b>{r.name}</b><span><SetSymbol set={r.set} rarity={r.rarity} />{r.line}</span></span>
            <span class="db-row-fig"><b class="fig">{r.figure}</b>{r.sub && <small>{r.sub}</small>}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Completion({ data, owned, target }: { data: AppData; owned: Owned[]; target: "/wants" | "/collection" }) {
  const [all, setAll] = useState(false);
  const sets = useMemo(() => completionBySet(data, owned), [data, owned]);
  const shown = all ? sets : sets.slice(0, 8);
  if (!sets.length) return null;
  return (
    <Card title="Set completion" aside={target === "/wants" ? "tap a set to see what's left to buy" : "tap a set to see what you own"} wide>
      <ul class="db-sets">
        {shown.map((c, i) => {
          const share = c.owned / Math.max(1, c.owned + c.wanted);
          return (
            <li style={{ "--i": i }}>
              <button type="button" class="db-set" onClick={() => c.set && openFiltered(target, "set", c.set)}
                aria-label={`${c.label}: ${c.owned} of ${c.owned + c.wanted} owned. Show ${target === "/wants" ? "the wishes" : "my cards"} from this set`}>
              <div class="db-set-line">
                <span class="db-set-name"><SetSymbol set={c.set} rarity="common" />{c.label}</span>
                <b class="num">{c.owned} of {c.owned + c.wanted}</b>
              </div>
              <div class="db-bar" role="img" aria-label={`${Math.round(share * 100)}% owned`}><span style={{ width: `${share * 100}%` }} /></div>
              <div class="db-set-sub">
                <span>{c.wanted ? `${c.wanted} to go` : "Complete"}</span>
                {c.wanted > 0 && <span>{c.priced ? `${eur(c.left)} at today's best prices${c.priced < c.wanted ? ` (${c.priced} priced)` : ""}` : "no prices yet"}</span>}
              </div>
              </button>
            </li>
          );
        })}
      </ul>
      {sets.length > 8 && <button type="button" class="f-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${sets.length} sets`}</button>}
    </Card>
  );
}

// ---------- the want-list dashboard ----------

function WantsBoard({ data, owned, history, purchases }: { data: AppData; owned: Owned[]; history: HistoryDoc | null | undefined; purchases: PurchasesDoc | null | undefined }) {
  const items = useMemo(() => toBuy(data), [data]);
  const best = items.reduce((t, x) => t + (x.best ?? 0) * x.qty, 0);
  const trend = items.reduce((t, x) => t + (x.trend ?? x.best ?? 0) * x.qty, 0);
  const priced = items.filter((x) => x.best != null).length;
  const wishes = data.wants?.wishes ?? [];
  const lows = useMemo(() => wishes.filter((w) => atLow90(w, history)), [wishes, history]);
  const close = useMemo(() => wishes.map((w) => ({ w, gap: dealGap(w, data.liveOf(w.key)) }))
    .filter((x): x is { w: Wish; gap: number } => x.gap != null && !data.dealOf(x.w.key)).sort((a, b) => a.gap - b.gap), [wishes, data]);
  const overList = useMemo(() => (span: number) => totalOverTime(items, (x) => series(x.w.scryfall_id, showsFoil(x.w), history), (x) => x.qty, history, span), [items, history]);
  const rows = [...pendingPurchases(data.edits.ops), ...(purchases?.purchases ?? [])];
  const bought = totals(rows);
  const byList = useMemo(() => {
    const at = new Map<string, { list: string; best: number; n: number }>();
    for (const x of items) for (const l of x.w.lists.length ? x.w.lists : ["On no list"]) {
      const g = at.get(l) ?? { list: l, best: 0, n: 0 };
      g.best += (x.best ?? 0) * x.qty; g.n += 1; at.set(l, g);
    }
    return [...at.values()].sort((a, b) => b.best - a.best);
  }, [items]);
  const top = Math.max(0.01, ...byList.map((g) => g.best));
  const wishRow = (w: Wish, figure: string, line: ComponentChildren, sub?: ComponentChildren) => ({
    key: w.key, thumb: w.thumb, foil: showsFoil(w), name: w.name, set: w.set, rarity: w.rarity, line, figure, sub, open: () => openCard(w.key),
  });

  return (
    <>
      <div class="bt-stats">
        <Stat lead label="To finish the want-list" value={eur(best)} note={`at today's best prices, ${priced} of ${items.length} priced`} />
        <Stat label="At Cardmarket's trend" value={eur(trend)} note={trend > best ? <><span class="good">{eur(trend - best)}</span> more than the best prices</> : "the same as the best prices"} />
        <Stat label="At their lowest in 90 days" value={String(lows.length)} note={lows.length ? "a good time to buy those" : "none right now"} to={() => openFiltered("/wants", "timing", "low90")} />
        <Stat label="Close to a deal" value={String(close.filter((x) => x.gap <= 10).length)} note="under 10 points from a deal" to={() => openFiltered("/wants", "deal", "close")} />
      </div>
      <div class="db-grid">
        <ValueCard title="What the list costs over time" make={overList} label="Want-list at Cardmarket's trend" upIsGood={false}
          hint={(of) => <>Cardmarket's trend of every wish, its copies added up{of < items.length ? `; ${of} of ${items.length} wishes have prices for the whole range` : ""}. A falling line means waiting pays.</>} />
        <Card title="Closest to a deal" aside={<a class="link" href="/wants" onClick={link("/wants")}>Want-list</a>}>
          <CardRows empty="No CardTrader copies checked yet." rows={close.slice(0, 6).map(({ w, gap }) => {
            const l = data.liveOf(w.key);
            return wishRow(w, l ? eur(l.price) : "–", gap <= 0.5 ? "right at the deal line" : `${Math.round(gap)} points from a deal`, l?.below != null ? `${Math.round(l.below)}% under its usual` : undefined);
          })} />
        </Card>
        <Card title="At their lowest in 90 days" aside={lows.length ? `${lows.length} wishes` : undefined}>
          <CardRows empty="None of your wishes is at its 90-day low right now." rows={lows.slice(0, 6).map((w) => {
            const b = bestNow(data, w);
            return wishRow(w, b != null ? eur(b) : "–", "Cardmarket's lowest in 90 days");
          })} />
        </Card>
        <Card title="What each list costs" aside="at today's best prices">
          <ul class="bt-groups">
            {byList.map((g, i) => (
              <li style={{ "--i": i }}>
                <button type="button" class="db-set" onClick={() => g.list !== "On no list" && openFiltered("/wants", "list", g.list)}>
                  <div class="bt-g-line"><span class="bt-g-name">{g.list}</span><b>{eur(g.best)}</b></div>
                  <div class="bt-g-bar"><span style={{ width: `${(g.best / top) * 100}%` }} /></div>
                  <div class="bt-g-sub"><span>{g.n} {g.n === 1 ? "wish" : "wishes"}</span><span>{pct(g.best / Math.max(0.01, best))} of the total</span></div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Biggest costs left" aside="the wishes that weigh most">
          <CardRows empty="No prices yet." rows={[...items].filter((x) => x.best != null).sort((a, b) => b.best! * b.qty - a.best! * a.qty).slice(0, 6)
            .map((x) => wishRow(x.w, eur(x.best! * x.qty), x.qty > 1 ? `${x.qty} copies` : x.w.lists.join(", ") || "on no list",
              best > 0 ? `${pct((x.best! * x.qty) / best)} of the total` : undefined))} />
        </Card>
        <Completion data={data} owned={owned} target="/wants" />
      </div>
      <h2 class="db-section">Buying record</h2>
      {rows.length ? (
        <>
          <div class="bt-stats">
            <Stat lead label="Saved against Cardmarket" value={eur(Math.abs(bought.saved))} cls={bought.saved >= 0 ? "good" : "bad"}
              note={bought.under != null ? `${pct(bought.under)} ${bought.under >= 0 ? "under" : "over"} the trend` : "No Cardmarket price to compare"} />
            <Stat label="Paid" value={eur(bought.paid)} note={`${rows.length} ${rows.length === 1 ? "card" : "cards"}, ${eur(bought.paid / rows.length)} a card`} />
            <Stat label="Worth now" value={bought.valued ? eur(bought.worth) : "–"} note={bought.valued ? <><span class={tone(bought.gain)}>{signed(bought.gain)}</span> since bought</> : "with the next price update"} />
            <Stat label="Wishes left" value={String(wishCount(wishes))} note="on the want-list" />
          </div>
          <div class="bt-grid"><Months rows={rows} /><Breakdown rows={rows} /></div>
        </>
      ) : <p class="db-empty">Nothing bought yet. Purchases recorded here or on CardTrader show what you saved.</p>}
    </>
  );
}

// ---------- the collection dashboard ----------

function CollectionBoard({ data, owned, history, purchases }: { data: AppData; owned: Owned[]; history: HistoryDoc | null | undefined; purchases: PurchasesDoc | null | undefined }) {
  const worth = owned.reduce((t, o) => t + (valueOf(o) ?? 0), 0);
  const valued = owned.filter((o) => o.now != null);
  const paid = valued.reduce((t, o) => t + o.paid, 0);
  const gain = worth - paid;
  const copies = owned.reduce((t, o) => t + o.qty, 0);
  const sets = new Set(owned.map((o) => o.set).filter(Boolean)).size;
  const withMoves = useMemo(() => {
    const seen = new Set<string>();
    return owned.filter((o) => { const k = `${o.scryfall_id ?? o.key}|${o.foil}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((o) => ({ o, m: moves(series(o.scryfall_id, o.foil, history)) }));
  }, [owned, history]);
  const overOwned = useMemo(() => (span: number) => totalOverTime(owned, (o) => series(o.scryfall_id, o.foil, history), (o) => o.qty, history, span), [owned, history]);
  const [dir, setDir] = useState<"all" | "up" | "down">("all");
  const sell = withMoves.filter(({ o, m }) => o.now != null && ((m.change30 ?? 0) >= 0.15 || (m.days >= 30 && m.high90 != null && o.now >= m.high90 * 0.95 && (gainOf(o) ?? 0) > 0)))
    .sort((a, b) => (b.m.change30 ?? 0) - (a.m.change30 ?? 0));
  const movers = withMoves.filter(({ m }) => m.change30 != null && Math.abs(m.change30) >= 0.05).sort((a, b) => Math.abs(b.m.change30!) - Math.abs(a.m.change30!));
  const valuable = [...owned].sort((a, b) => (valueOf(b) ?? 0) - (valueOf(a) ?? 0)).filter((o) => o.now != null);
  const ownedRow = (o: Owned, figure: string, line: ComponentChildren, sub?: ComponentChildren) => ({
    key: o.key, thumb: o.thumb, foil: o.foil, name: o.name, set: o.set, rarity: o.rarity, line, figure, sub, open: () => openOwned(data, o),
  });
  if (!owned.length) {
    return <div class="empty"><h2>No collection yet</h2><p>Cards you buy show up here, with what they're worth. Send Claude your ManaBox export to bring in everything you already own.</p></div>;
  }
  return (
    <>
      <div class="bt-stats">
        <Stat lead to={() => { try { sessionStorage.setItem("collection-sort", "value"); } catch { /* fine */ } go("/collection"); }} label="Worth now" value={eur(worth)} note={`Cardmarket's trend${purchases?.price_date ? ` on ${day(purchases.price_date)}` : ""}${valued.length < owned.length ? `, ${valued.length} of ${owned.length} priced` : ""}`} />
        <Stat to={() => openFiltered("/collection", "move", gain >= 0 ? "gain" : "loss")} label="Since bought" value={signed(gain)} cls={tone(gain)} note={paid > 0 ? `${pct(gain / paid)} ${gain >= 0 ? "up" : "down"} on ${eur(paid)} paid` : "nothing priced yet"} />
        <Stat label="Cards" value={String(copies)} note={`${owned.length} different printings`} />
        <Stat label="Sets" value={String(sets)} note="with at least one card" />
      </div>
      <div class="db-grid">
        <ValueCard title="Value over time" make={overOwned} label="Collection at Cardmarket's trend" upIsGood
          hint={(of) => <>What today's cards were worth on each day, at Cardmarket's trend{of < owned.length ? `; ${of} of ${owned.length} printings have prices for the whole range` : ""}.</>} />
        <Card title="Sell watch" aside="spiked, or near their 90-day high">
          <CardRows empty="Nothing has spiked. Cards up 15% in a month, or near their 90-day high and worth more than you paid, show here." rows={sell.slice(0, 6).map(({ o, m }) => ownedRow(o, eur(o.now!),
            (m.change30 ?? 0) >= 0.15 ? `+${pct(m.change30!)} in 30 days` : `near its 90-day high of ${eur(m.high90!)}`,
            <>paid {eur(o.paid / o.qty)}</>))} />
        </Card>
        <Card title="Top movers" aside={
          <span class="seg" role="group" aria-label="Direction">
            {(["all", "up", "down"] as const).map((d) => <button type="button" aria-pressed={dir === d} onClick={() => setDir(d)}>{d === "all" ? "All" : d === "up" ? "Up" : "Down"}</button>)}
          </span>}>
          <CardRows empty={dir === "all" ? "No card moved 5% or more this month." : `No card went ${dir} 5% or more this month.`} rows={movers.filter(({ m }) => dir === "all" || (dir === "up" ? m.change30! > 0 : m.change30! < 0)).slice(0, 6).map(({ o, m }) => ownedRow(o, `${m.change30! >= 0 ? "+" : "−"}${pct(m.change30!)}`,
            `${eur(o.now ?? 0)} a copy`, <span class={m.change30! >= 0 ? "good" : "bad"}>{m.change30! >= 0 ? "up" : "down"}</span>))} />
        </Card>
        <Card title="Most valuable">
          <CardRows empty="No prices yet." rows={valuable.slice(0, 6).map((o) => ownedRow(o, eur(valueOf(o)!), o.qty > 1 ? `${o.qty} copies` : `${o.condition}${o.foil ? ", foil" : ""}`,
            gainOf(o) != null ? <span class={tone(gainOf(o)!)}>{signed(gainOf(o)!)}</span> : undefined))} />
        </Card>
        <Card title="Recently added" aside={<a class="link" href="/collection" onClick={link("/collection")}>Collection</a>}>
          <CardRows empty="Nothing yet." rows={[...owned].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 6).map((o) => ownedRow(o, eur(o.paid / o.qty),
            `${day(o.last)}, ${o.markets.includes("cardtrader") ? "CardTrader" : o.markets.includes("cardmarket") ? "Cardmarket" : "elsewhere"}`,
            o.now != null ? <>now {eur(o.now)}</> : undefined))} />
        </Card>
        <Completion data={data} owned={owned} target="/collection" />
      </div>
    </>
  );
}

export function Dashboards({ data }: { data: AppData }) {
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("dash-tab") as Tab) || "wants");
  const purchases = useDoc<PurchasesDoc>("purchases").doc;
  const history = useDoc<HistoryDoc>("history").doc;
  const owned = useMemo(() => ownedCards([...pendingPurchases(data.edits.ops), ...(purchases?.purchases ?? [])]), [purchases, data.edits.ops]);
  const pick = (t: Tab) => { setTab(t); try { sessionStorage.setItem("dash-tab", t); } catch { /* fine */ } };
  useEffect(() => { document.documentElement.dataset.section = tab === "wants" ? "wants" : "collection"; }, [tab]);
  return (
    <div class="page dash">
      <header class="head sec-band">
        <div><h1 class="title">{tab === "wants" ? "Want-list dashboard" : "Collection dashboard"}</h1><p class="sub">{tab === "wants" ? "What's left to buy, what it costs, and when to buy it" : "What you own, what it's worth, and what's moving"}</p></div>
      </header>
      <div class="toolbar">
        <div class="seg" role="tablist" aria-label="Dashboard">
          <button type="button" role="tab" class="tab-wants" aria-pressed={tab === "wants"} aria-selected={tab === "wants"} onClick={() => pick("wants")}>Want-list</button>
          <button type="button" role="tab" class="tab-coll" aria-pressed={tab === "collection"} aria-selected={tab === "collection"} onClick={() => pick("collection")}>Collection</button>
        </div>
      </div>
      {data.wants === undefined ? <div class="bt-stats"><div class="bt-stat skeleton" style={{ height: "110px" }} /><div class="bt-stat skeleton" /><div class="bt-stat skeleton" /><div class="bt-stat skeleton" /></div>
        : tab === "wants"
          ? <WantsBoard key="w" data={data} owned={owned} history={history} purchases={purchases} />
          : <CollectionBoard key="c" data={data} owned={owned} history={history} purchases={purchases} />}
    </div>
  );
}
