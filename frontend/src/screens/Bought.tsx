// Cards I bought, newest first, with what each saved against Cardmarket's trend that day.
// Its own page since 2026-11-06 (was a segment of the Want-list).
import { useState } from "preact/hooks";
import { useDoc } from "../api";
import type { AppData } from "../data";
import { pendingPurchases } from "../edits";
import { day, eur, tagName } from "../format";
import { CardImage } from "../ui/CardImage";
import { IconSearch } from "../ui/icons";
import { RowSkeleton } from "../ui/Row";
import { SetSymbol } from "../ui/symbols";
import type { PurchasesDoc } from "../types";

const MARKET: Record<string, string> = { cardtrader: "CardTrader", cardmarket: "Cardmarket", other: "Elsewhere" };

export function Bought({ data }: { data: AppData }) {
  const doc = useDoc<PurchasesDoc>("purchases").doc;
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("all");
  const all = [...pendingPurchases(data.edits.ops), ...(doc?.purchases ?? [])];
  const needle = q.trim().toLowerCase();
  const rows = all.filter((p) => (market === "all" || p.market === market) &&
    (!needle || p.name.toLowerCase().includes(needle) || (p.set ?? "").toLowerCase() === needle));
  const compared = rows.filter((p) => p.saved != null);
  const saved = compared.reduce((t, p) => t + p.saved!, 0);
  const paid = rows.reduce((t, p) => t + p.price, 0);
  const markets = ["all", ...new Set(all.map((p) => p.market))];

  return (
    <div class="page">
      <header class="head"><div><h1 class="title">Bought</h1><p class="sub">What I paid, and what it saved against Cardmarket</p></div></header>
      {all.length > 0 && (
        <div class="toolbar">
          {markets.length > 2 && (
            <div class="seg" role="group" aria-label="Market">
              {markets.map((m) => <button type="button" aria-pressed={market === m} onClick={() => setMarket(m)}>{m === "all" ? "All" : MARKET[m] ?? m}</button>)}
            </div>
          )}
          <label class="field"><IconSearch /><span class="sr">Filter</span>
            <input type="search" placeholder="Search cards" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </label>
        </div>
      )}
      {doc === undefined && !all.length ? <RowSkeleton n={3} /> : !all.length ? (
        <div class="empty"><h2>Nothing bought yet</h2><p>On a card's page, tap <b>Bought it</b> to record what you paid. It shows here with what you saved against Cardmarket.</p></div>
      ) : (
        <>
          <div class="savings">
            <div><span class="label">Saved against Cardmarket</span><b class={saved >= 0 ? "good" : "bad"}>{eur(Math.abs(saved))}{saved < 0 ? " more" : ""}</b></div>
            <div><span class="label">Paid</span><b>{eur(paid)}</b></div>
            <div><span class="label">Cards</span><b>{rows.length}</b></div>
          </div>
          {rows.length ? (
            <div class="list">
              {rows.map((p) => (
                <div class="row static">
                  <CardImage src={p.thumb} alt="" foil={p.foil} />
                  <div class="r-main">
                    <div class="r-name"><span>{p.name}</span></div>
                    <div class="r-line"><SetSymbol set={p.set} rarity={p.rarity} /><span>{p.tags.length ? p.tags.map(tagName).join(", ") : "regular"}{p.set ? `, ${p.set.toUpperCase()} ${p.number}` : ""}</span></div>
                    <div class="r-wish">{p.pending && <span class="pending">Saving</span>}{day(p.date)}, {MARKET[p.market] ?? p.market}, {p.condition}{p.foil ? ", foil" : ""}</div>
                  </div>
                  <div class="r-price">
                    <span class="p-paid">{eur(p.price)}</span>
                    {p.saved != null && <span class={`chg ${p.saved > 0 ? "down" : p.saved < 0 ? "up" : "flat"}`}>{p.saved >= 0 ? `saved ${eur(p.saved)}` : `${eur(-p.saved)} over`}</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : <div class="empty"><h2>Nothing matches</h2><p>Try another name or market.</p></div>}
          <p class="hint">Saved is the difference with Cardmarket's trend for that finish on the day you bought, before shipping.</p>
        </>
      )}
    </div>
  );
}
