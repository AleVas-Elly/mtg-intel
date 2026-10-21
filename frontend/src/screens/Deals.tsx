import { useEffect, useState } from "preact/hooks";
import type { AppData } from "../data";
import { dealRatio } from "../data";
import { ago, time, TIERS } from "../format";
import { link } from "../router";
import { IconSettings, IconWarn } from "../ui/icons";
import { CardList, RowSkeleton, type Item } from "../ui/Row";
import type { Deal } from "../types";

const STALE_MIN = 25;

function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, []);
  return now;
}

function TierChip({ d }: { d: Deal }) {
  const tier = d.tier ? TIERS[d.tier] : null;
  if (!tier) return <span class="tier target">Target price</span>;
  return <span class={`tier ${tier.cls}`}>{tier.label}<small>{Math.round(d.below_pct ?? 0)}% under</small></span>;
}

export function Status({ data }: { data: AppData }) {
  const now = useNow();
  const at = data.live?.checked_at;
  if (!at) return <p class="sub">Waiting for the first CardTrader check…</p>;
  const minutes = (now - new Date(at).getTime()) / 60e3;
  const stale = minutes > STALE_MIN;
  const next = Math.max(0, Math.ceil(10 - (minutes % 10)));
  return (
    <p class="sub">
      <span key={at} class={`dot ${stale ? "stale" : "live"}`} />
      <span>Checked {ago(at, now)}{!stale && `, next in ${next} min`}{data.live!.failed > 0 && `. ${data.live!.failed} cards failed`}</span>
    </p>
  );
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "40", label: "Steal" },
  { id: "30", label: "Great" },
  { id: "20", label: "Good" },
  { id: "target", label: "Target" },
];

export function Deals({ data, card }: { data: AppData; card: string | null }) {
  const [filter, setFilter] = useState("all");
  const deals = (data.live?.deals ?? []).filter((d) => data.byKey.has(d.key)).sort((a, b) => (b.below_pct ?? 0) - (a.below_pct ?? 0));
  const match = (d: Deal) => filter === "all" || (filter === "target" ? !d.tier : String(d.tier) === filter);
  const shown = deals.filter(match);
  const gone = data.live?.gone ?? [];
  const loading = data.live === undefined || data.wants === undefined;
  const closest = data.wants && data.live && !deals.length
    ? data.wants.wishes
        .map((w) => ({ w, r: dealRatio(w, data.liveOf(w.key)) }))
        .filter((x): x is { w: typeof x.w; r: number } => x.r != null)
        .sort((a, b) => a.r - b.r)
        .slice(0, 6)
    : [];
  return (
    <div class="page">
      <header class="head">
        <div>
          <h1 class="title">Deals</h1>
          <Status data={data} />
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <a class="icon-btn" href="/settings" onClick={link("/settings")} aria-label="Settings"><IconSettings /></a>
        </div>
      </header>
      {data.error && <div class="notice"><IconWarn />{data.error} Showing the last copy.</div>}
      {loading ? <RowSkeleton n={4} /> : (
        <>
          {deals.length > 0 && (
            <div class="toolbar">
              <div class="seg" role="group" aria-label="Deal strength">
                {FILTERS.map((f) => {
                  const n = deals.filter((d) => f.id === "all" || (f.id === "target" ? !d.tier : String(d.tier) === f.id)).length;
                  return (f.id === "all" || n > 0) && (
                    <button type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<small>{n}</small></button>
                  );
                })}
              </div>
            </div>
          )}
          {shown.length > 0 ? (
            <CardList data={data} current={card} items={shown.flatMap((d): Item[] => {
              const w = data.byKey.get(d.key);
              return w ? [{ w, ctPrice: d.listing.price, extra: <TierChip d={d} /> }] : [];
            })} />
          ) : (
            <div class="empty">
              <h2>No deals right now</h2>
              <p>Every 10 minutes CardTrader is checked for a Zero copy at least 20% under the lower of Cardmarket's trend and CardTrader's usual price. A Telegram message arrives when one shows up.</p>
            </div>
          )}
          {closest.length > 0 && (
            <>
              <div class="list-head">Closest to a deal<span>cheapest copy vs the lower market price</span></div>
              <CardList data={data} current={card} items={closest.map(({ w, r }) => ({
                w, extra: <div class="r-wish">{r < 1 ? `${Math.round((1 - r) * 100)}% under` : `${Math.round((r - 1) * 100)}% over`} the lower market price</div>,
              }))} />
            </>
          )}
          {gone.length > 0 && (
            <>
              <div class="list-head">Gone today<span>sold or no longer cheap</span></div>
              <CardList data={data} items={gone.flatMap((d): Item[] => {
                const w = data.byKey.get(d.key);
                return w ? [{ w, gone: true, ctPrice: d.listing.price, extra: <div class="r-wish">Gone at {time(d.gone_at!)}</div> }] : [];
              })} />
            </>
          )}
        </>
      )}
    </div>
  );
}
