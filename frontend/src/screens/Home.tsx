// Home (D57): the first screen after sign-in. Today's best deal as a big drop in its own colour,
// the other deals beside it, the countdown to the next check, the counts, and what went today.
import { can, currentMe } from "../access";
import type { AppData } from "../data";
import { dealGap, dealRatio, wishCount } from "../data";
import { fieldStyle } from "../drop";
import { collectorLine, eur } from "../format";
import { link, openCard } from "../router";
import type { Deal, Wish } from "../types";
import { Art, DropCard, GoneItem, Pulse, Roll, TierPill, usualOf } from "../ui/Drop";
import { IconChart, IconOut, IconSettings, IconWarn } from "../ui/icons";
import { ManaCost, SetSymbol } from "../ui/symbols";

const today = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

function HeroDeal({ d, w, data }: { d: Deal; w: Wish; data: AppData }) {
  const field = fieldStyle(w.mana_cost);
  const usual = usualOf(d, data);
  const save = usual ? usual - d.listing.price : null;
  return (
    <section class="hero" data-key={w.key} style={field} aria-label="Best deal right now">
      <div class="body">
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "flex-start" }}>
          <TierPill d={d} />
          <h2><a href={`?card=${encodeURIComponent(w.key)}`} onClick={(e) => { e.preventDefault(); openCard(w.key); }}>{w.name}</a></h2>
          <div class="ver d-ink"><ManaCost cost={w.mana_cost} front /><SetSymbol set={w.set} rarity={w.rarity} /><span>{collectorLine(w)} · {w.condition}</span></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div class="price">
            <Roll value={d.listing.price} class="big" />
            <span class="was d-ink">CardTrader{d.listing.zero ? " via Zero" : ""}<br />{usual ? <>usual {eur(usual)}{save && save > 0 ? ` · save ${eur(save)}` : ""}</> : null}</span>
          </div>
          <div class="acts">
            {w.links.cardtrader && <a class="btn primary" href={w.links.cardtrader} target="_blank" rel="noopener">Open on CardTrader<IconOut /></a>}
            {w.links.cardmarket && <a class="btn" href={w.links.cardmarket} target="_blank" rel="noopener">Cardmarket</a>}
          </div>
        </div>
      </div>
      <div class="art" onClick={() => openCard(w.key)} role="presentation"><Art w={w} eager /></div>
    </section>
  );
}

/** No deal today: the wish closest to one leads instead, quieter. */
function HeroClosest({ w, data }: { w: Wish; data: AppData }) {
  const field = fieldStyle(w.mana_cost);
  const l = data.liveOf(w.key);
  const r = dealRatio(w, l);
  return (
    <section class="hero quiet" data-key={w.key} style={field} aria-label="Closest to a deal">
      <div class="body">
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "flex-start" }}>
          <span class="tier target">No deals right now · closest</span>
          <h2>{w.name}</h2>
          <div class="ver d-ink"><ManaCost cost={w.mana_cost} front /><SetSymbol set={w.set} rarity={w.rarity} /><span>{collectorLine(w)}</span></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div class="price">
            {l && <Roll value={l.price} class="big" />}
            <span class="was d-ink">{r != null && (r < 1 ? `${Math.round((1 - r) * 100)}% under` : `${Math.round((r - 1) * 100)}% over`)} its usual price{l?.needs != null ? <><br />a deal from {l.needs}% under</> : null}</span>
          </div>
          <div class="acts">
            <a class="btn primary" href={`?card=${encodeURIComponent(w.key)}`} onClick={(e) => { e.preventDefault(); openCard(w.key); }}>Details</a>
            <a class="btn" href="/deals" onClick={link("/deals")}>Deals</a>
          </div>
        </div>
      </div>
      <div class="art" onClick={() => openCard(w.key)} role="presentation"><Art w={w} eager /></div>
    </section>
  );
}

export function Home({ data, card }: { data: AppData; card: string | null }) {
  const deals = (data.live?.deals ?? []).filter((d) => data.byKey.has(d.key)).sort((a, b) => (b.below_pct ?? 0) - (a.below_pct ?? 0));
  const gone = (data.live?.gone ?? []).filter((d) => data.byKey.has(d.key));
  const wishes = data.wants?.wishes ?? [];
  const flagged = wishes.filter((w) => data.flagsOf(w).length).length;
  const me = currentMe();
  const seesDeals = can("deals");
  const loading = (seesDeals && data.live === undefined) || (can("wants") && data.wants === undefined);
  const best = deals[0];
  const closest = !best && data.live
    ? wishes.map((w) => ({ w, gap: dealGap(w, data.liveOf(w.key)) })).filter((x): x is { w: Wish; gap: number } => x.gap != null).sort((a, b) => a.gap - b.gap)[0]?.w
    : undefined;
  const rest = deals.slice(1, 5);
  return (
    <div class="home-wrap">
      <div class="home">
        <header class="home-head">
          <h1 class="title">{today()}</h1>
          {seesDeals && <Pulse data={data} />}
          <span class="phone-only head-btns">
            <a class="icon-btn" href="/dashboards" onClick={link("/dashboards")} aria-label="Dashboards"><IconChart /></a>
            <a class="icon-btn" href="/settings" onClick={link("/settings")} aria-label="Settings"><IconSettings /></a>
          </span>
        </header>
        {data.error && <div class="notice"><IconWarn />{data.error} Showing the last copy.</div>}
        {loading ? (
          <div class="home-grid"><div class="hero skeleton" style={{ minHeight: "420px" }} /><div class="counts"><div class="stat skeleton" /><div class="stat skeleton" /><div class="stat skeleton" /></div></div>
        ) : (
          <>
            <div class="home-grid">
              {!seesDeals ? <Welcome name={me.name} />
                : best ? <HeroDeal d={best} w={data.byKey.get(best.key)!} data={data} />
                : closest ? <HeroClosest w={closest} data={data} />
                : <section class="hero" style={{ minHeight: "260px" }}><div class="body"><h2>No deals yet</h2><p class="hero-note d-ink">The first CardTrader check fills this in.</p></div></section>}
              <div class="counts">
                {seesDeals && <a class="stat" href="/deals" onClick={link("/deals")} style={{ "--n": 1 }}><span>Deals right now</span><b class="fig">{deals.length}</b></a>}
                {can("wants") && <a class="stat" href="/wants" onClick={link("/wants")} style={{ "--n": 2 }}><span>{me.owner ? "Wishes on your lists" : "Wishes on the lists"}</span><b class="fig">{wishCount(wishes)}</b></a>}
                {can("wants") && <a class={`stat${flagged ? " warn" : ""}`} href="/check" onClick={link("/check")} style={{ "--n": 3 }}><span>Cards to check</span><b class="fig">{flagged}</b></a>}
              </div>
            </div>
            {rest.length > 0 && (
              <>
                <div class="section-head"><h2>More deals</h2>{deals.length > 5 ? <a class="link" href="/deals" onClick={link("/deals")}>All {deals.length} deals</a> : <span>sorted by how far under</span>}</div>
                <div class="drop-row">
                  {rest.map((d, n) => <DropCard key={d.key} d={d} w={data.byKey.get(d.key)!} data={data} kind="small" n={n} current={card === d.key} />)}
                </div>
              </>
            )}
            {gone.length > 0 && (
              <>
                <div class="section-head"><h2>Gone today</h2><span>sold or no longer cheap</span></div>
                <div class="gone-row">
                  {gone.slice(0, 6).map((d, n) => <GoneItem key={d.key + d.gone_at} d={d} w={data.byKey.get(d.key)!} n={n} />)}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}


/** Home for someone who doesn't see live deals (D78): what they can open here. */
function Welcome({ name }: { name: string }) {
  const places = [
    can("wants") && ["/wants", "the want-list"],
    can("collection") && ["/collection", "the collection"],
    ["/search", "every card, with prices"],
  ].filter(Boolean) as [string, string][];
  return (
    <section class="hero" style={{ minHeight: "260px" }}>
      <div class="body">
        <h2>Hi {name}</h2>
        <p class="hero-note" style={{ color: "var(--ink-2)", fontSize: "16px", lineHeight: 1.5 }}>You can look at{" "}
          {places.map(([to, label], i) => <>{i ? (i === places.length - 1 ? " and " : ", ") : ""}<a class="link" href={to} onClick={link(to)}>{label}</a></>)}.
          {can("suggest") ? " Found something good? Open a card in Search and suggest it." : ""}</p>
      </div>
    </section>
  );
}
