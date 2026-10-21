import { useEffect, useMemo, useState } from "preact/hooks";
import { useDoc } from "../api";
import type { AppData } from "../data";
import { ago, cmTrend, condName, countryName, day, eur, foilOnly, langName, showsFoil, TIERS, versionText } from "../format";
import { closeCard } from "../router";
import { BigCard } from "../ui/CardImage";
import { PriceChart, type Point } from "../ui/Chart";
import { IconBack, IconClose, IconCopy, IconOut, IconWarn } from "../ui/icons";
import { ManaCost, SetSymbol } from "../ui/symbols";
import type { CtHistoryDoc, HistoryDoc, RecentDoc, Wish } from "../types";

function series(w: Wish, history: HistoryDoc | null | undefined, foil: boolean): Point[] {
  if (!history?.base || !w.scryfall_id) return [];
  const card = history.cards[w.scryfall_id];
  if (!card) return [];
  const base = new Date(history.base + "T12:00:00Z").getTime();
  const finish = foil ? "foil" : "normal";
  const byDay = new Map<number, Point>();
  for (const source of ["mtgjson", "cardmarket"]) {  // our own daily guide wins on the same day
    const s = card[source]?.[finish] ?? (finish === "foil" ? card[source]?.etched : undefined) ?? [];
    for (let i = 0; i < s.length; i += 2) byDay.set(s[i], { t: base + s[i] * 864e5, v: s[i + 1], source });
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

function ctSeries(key: string, older: CtHistoryDoc | null | undefined, recent: RecentDoc | null | undefined): Point[] {
  const points: Point[] = (older?.[key] ?? []).map(([t, v]) => ({ t: new Date(t).getTime(), v }));
  const first = recent?.t.length ? new Date(recent.t[0]).getTime() : Infinity;
  const out = points.filter((p) => p.t < first);
  (recent?.p[key] ?? []).forEach((v, i) => v != null && out.push({ t: new Date(recent!.t[i]).getTime(), v }));
  return out.sort((a, b) => a.t - b.t);
}

function summary(w: Wish, flags: { text: string }[]): string {
  return [
    `${w.name} — ${w.set?.toUpperCase() ?? "?"} #${w.number ?? "?"} (${versionText(w)})`,
    `Scryfall ${w.scryfall_id ?? "none"} · CardTrader ${w.blueprint_id ?? "none"} · Cardmarket ${w.cardmarket_id ?? "none"}`,
    w.ct ? `CardTrader calls it: ${w.ct.name}${w.ct.version ? ` (${w.ct.version})` : ""}, ${w.ct.expansion} #${w.ct.number}` : "",
    ...flags.map((f) => `• ${f.text}`),
  ].filter(Boolean).join("\n");
}

export function Detail({ data, wishKey }: { data: AppData; wishKey: string }) {
  const w = data.byKey.get(wishKey);
  const history = useDoc<HistoryDoc>("history");
  const older = useDoc<CtHistoryDoc>("ct-history");
  const recent = useDoc<RecentDoc>("ct-recent", 120_000);
  const live = data.liveOf(wishKey);
  const deal = data.dealOf(wishKey);
  const bothFinishes = !!w && w.foil === "any" && !foilOnly(w) && w.finishes.some((f) => f !== "nonfoil");
  const [foil, setFoil] = useState(false);
  useEffect(() => { if (w) setFoil(live?.foil ?? showsFoil(w)); }, [wishKey, w?.key]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeCard();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  const cm = useMemo(() => (w ? series(w, history.doc, foil) : []), [w, history.doc, foil]);
  const ct = useMemo(() => ctSeries(wishKey, older.doc, recent.doc), [wishKey, older.doc, recent.doc]);

  if (!w) {
    return (
      <>
        <div class="detail-backdrop" onClick={closeCard} />
        <aside class="detail" aria-label="Card"><div class="d-top"><button class="icon-btn" onClick={closeCard} aria-label="Close"><IconClose /></button></div>
          <div class="empty"><h2>Card not found</h2><p>It may have been removed from the want-list.</p></div></aside>
      </>
    );
  }
  const flags = data.flagsOf(w);
  const trend = cmTrend(w, foil);
  const fin = foil ? "_foil" : "";
  const low = w.cm[`low${fin}` as "low"];
  const avg7 = w.cm[`avg7${fin}` as "avg7"];
  const cheaper = live && trend ? (live.price < trend ? "ct" : "cm") : null;
  const tier = deal?.tier ? TIERS[deal.tier] : null;

  return (
    <>
      <div class="detail-backdrop" onClick={closeCard} />
      <aside class="detail" aria-label={w.name}>
        <div class="d-top">
          <button class="icon-btn" onClick={closeCard} aria-label="Back"><IconBack /></button>
          {w.links.scryfall && <a class="icon-btn" href={w.links.scryfall} target="_blank" rel="noopener" aria-label="Open on Scryfall"><IconOut /></a>}
        </div>
        <BigCard src={w.image} alt={w.name} foil={foil} placeholder={w.thumb} />
        <h2 class="d-name">{w.name}<ManaCost cost={w.mana_cost} large /></h2>
        {w.type_line && <p class="d-type">{w.type_line}</p>}
        <div class="d-version">
          <SetSymbol set={w.set} rarity={w.rarity} />
          <span>{w.set_name ?? "CardTrader only"}{w.number ? ` · #${w.number}` : ""}</span>
          <span class="chip">{versionText(w)}</span>
          {foil && <span class="chip">foil</span>}
          {w.rarity && <span class="chip">{w.rarity}</span>}
        </div>
        {w.ct && (
          <p class="hint" style={{ textAlign: "center" }}>
            CardTrader calls it {w.ct.name}{w.ct.version ? ` · ${w.ct.version}` : ""} · {w.ct.expansion} #{w.ct.number}
          </p>
        )}

        {deal && (
          <div class="group" style={{ padding: "14px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <span class={`tier ${tier?.cls ?? "target"}`}>{tier?.label ?? "Target price"}{deal.below_pct != null && <small>{Math.round(deal.below_pct)}% under</small>}</span>
            <span style={{ fontSize: "13.5px", color: "var(--ink-2)" }}>
              Lower market price {eur(Math.min(...[deal.cardmarket, deal.cardtrader].filter((v): v is number => !!v)))} · first seen {ago(deal.since)}
            </span>
          </div>
        )}

        <div class="group-title">Prices{bothFinishes && " · "}{bothFinishes && (
          <span class="seg" role="group" aria-label="Finish" style={{ verticalAlign: "middle" }}>
            <button type="button" aria-pressed={!foil} onClick={() => setFoil(false)}>Non-foil</button>
            <button type="button" aria-pressed={foil} onClick={() => setFoil(true)}>Foil</button>
          </span>
        )}</div>
        <div class="group markets">
          <div class="market">
            <span class="label">CardTrader{w.zero ? " · Zero" : ""}</span>
            <span class="big">{live ? eur(live.price) : "–"}</span>
            {cheaper === "ct" && <span class="cheaper">Cheaper here</span>}
            <span class="note">{live
              ? `${condName(live.condition)} · ${langName(live.language)}${live.foil ? " · foil" : ""} · ${countryName(live.country)}`
              : w.blueprint_id ? "No copy fits the wish right now" : "Not on CardTrader"}</span>
            {live && <span class="note">{live.count} fitting {live.count === 1 ? "copy" : "copies"}{live.usual ? ` · ${live.usual_kind === "usual price" ? "usual" : "next"} ${eur(live.usual)}` : ""}</span>}
            {w.links.cardtrader && <a class="btn" href={w.links.cardtrader} target="_blank" rel="noopener">Open<IconOut /></a>}
          </div>
          <div class="market cm">
            <span class="label">Cardmarket</span>
            <span class="big">{eur(trend)}</span>
            {cheaper === "cm" && <span class="cheaper">Cheaper here</span>}
            <span class="note">Trend{foil ? " foil" : ""}{low ? ` · low ${eur(low)}` : ""}{avg7 ? ` · 7-day ${eur(avg7)}` : ""}</span>
            <span class="note">All sellers{w.cm.date ? `, ${day(w.cm.date)}` : ""}</span>
            {w.links.cardmarket && <a class="btn" href={w.links.cardmarket} target="_blank" rel="noopener">Dutch NM<IconOut /></a>}
          </div>
        </div>

        <div class="group-title">History</div>
        <div class="group"><PriceChart ct={ct} cm={cm} finishLabel={foil ? "foil" : "non-foil"} /></div>

        <div class="group-title">My wish</div>
        <dl class="group">
          <div class="kv"><dt>List</dt><dd>{w.lists.join(", ") || "–"}</dd></div>
          <div class="kv"><dt>Language</dt><dd>{langName(w.language)}</dd></div>
          <div class="kv"><dt>Condition</dt><dd>{condName(w.condition)} or better</dd></div>
          <div class="kv"><dt>Finish</dt><dd>{w.foil === "yes" ? "Foil" : w.foil === "no" ? "Non-foil" : "Foil or not"}</dd></div>
          <div class="kv"><dt>CardTrader</dt><dd>{w.zero ? "Via Zero only" : "Any seller"}</dd></div>
          {w.max_price != null && <div class="kv"><dt>Target price</dt><dd>{eur(w.max_price)}</dd></div>}
          {w.deal_pct != null && <div class="kv"><dt>Deal from</dt><dd>{w.deal_pct}% under</dd></div>}
          {w.one_of && <div class="kv"><dt>Alternatives</dt><dd>Buying one version of “{w.one_of}” fulfils it</dd></div>}
          {w.quantity > 1 && <div class="kv"><dt>Copies</dt><dd>{w.quantity}</dd></div>}
          {w.note && <div class="kv"><dt>Note</dt><dd>{w.note}</dd></div>}
        </dl>

        {flags.length > 0 && (
          <>
            <div class="group-title">Needs a look</div>
            <div class="group">
              {flags.map((f) => <div class="flag"><IconWarn /><span>{f.text}</span></div>)}
            </div>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "center", marginTop: "18px" }}>
          <button class="btn" type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(summary(w, flags)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* no clipboard */ }
          }}><IconCopy />{copied ? "Copied" : "Copy details for Claude"}</button>
        </div>
      </aside>
    </>
  );
}
