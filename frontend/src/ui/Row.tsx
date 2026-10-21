import type { ComponentChildren } from "preact";
import type { AppData } from "../data";
import { cmTrend, collectorLine, eur, showsFoil, wishLine } from "../format";
import { openCard } from "../router";
import type { Wish } from "../types";
import { CardImage } from "./CardImage";
import { ManaCost, SetSymbol } from "./symbols";
import { useLook } from "../lab";

/** One card: picture, name and cost, the collector line, the wish, and both markets' prices. */
export function WishRow({ w, data, current, extra, ctPrice, gone }: {
  w: Wish; data: AppData; current?: boolean; extra?: ComponentChildren; ctPrice?: number | null; gone?: boolean;
}) {
  const live = data.liveOf(w.key);
  const ct = ctPrice !== undefined ? ctPrice : live?.price;
  const cm = cmTrend(w, live?.foil);
  const flagged = data.flagsOf(w).length > 0;
  return (
    <a
      class={`row${gone ? " gone" : ""}`}
      data-key={w.key}
      href={`?card=${encodeURIComponent(w.key)}`}
      aria-current={current ? "true" : undefined}
      onClick={(e) => { e.preventDefault(); openCard(w.key); }}
    >
      <CardImage src={w.thumb} alt="" foil={showsFoil(w)} />
      <div class="r-main">
        <div class="r-name"><span>{w.name}</span><ManaCost cost={w.mana_cost} front />{flagged && <span class="flag-dot" title="Needs a look" />}</div>
        <div class="r-line"><SetSymbol set={w.set} rarity={w.rarity} /><span>{collectorLine(w)}</span></div>
        {extra ?? <div class="r-wish">{wishLine(w)}{w.one_of ? ", either version" : ""}</div>}
      </div>
      <div class="r-price">
        {ct != null ? <span class="p-ct">{eur(ct)}</span> : <span class="p-none">{w.blueprint_id ? "no copy" : "not on CardTrader"}</span>}
        {cm != null ? <span class="p-cm">{eur(cm)}</span> : <span class="p-none">no CM price</span>}
      </div>
    </a>
  );
}

export function RowSkeleton({ n = 6 }: { n?: number }) {
  return (
    <div class="list" aria-busy="true">
      {Array.from({ length: n }, () => (
        <div class="row">
          <div class="thumb skeleton" style={{ width: "48px" }} />
          <div class="r-main"><div class="skeleton" style={{ height: "14px", width: "60%" }} /><div class="skeleton" style={{ height: "11px", width: "80%" }} /></div>
          <div class="skeleton" style={{ height: "14px", width: "52px" }} />
        </div>
      ))}
    </div>
  );
}

export interface Item { w: Wish; extra?: ComponentChildren; ctPrice?: number | null; gone?: boolean }

/** A big card picture with its name, version and both prices (the Gallery layout). */
function GalleryCard({ w, data, extra, ctPrice, gone }: Item & { data: AppData }) {
  const live = data.liveOf(w.key);
  const ct = ctPrice !== undefined ? ctPrice : live?.price;
  const cm = cmTrend(w, live?.foil);
  return (
    <a class={`g-card${gone ? " gone" : ""}`} data-key={w.key} href={`?card=${encodeURIComponent(w.key)}`}
      onClick={(e) => { e.preventDefault(); openCard(w.key); }}>
      <CardImage src={w.image} alt={w.name} foil={showsFoil(w)} placeholder={w.thumb} />
      <div class="g-name"><span>{w.name}</span>{data.flagsOf(w).length > 0 && <span class="flag-dot" title="Needs a look" />}</div>
      <div class="g-line"><SetSymbol set={w.set} rarity={w.rarity} /><span>{collectorLine(w)}</span></div>
      {extra}
      <div class="g-prices">
        {ct != null ? <span class="p-ct">{eur(ct)}</span> : <span class="p-none">{w.blueprint_id ? "no copy" : "not on CardTrader"}</span>}
        {cm != null ? <span class="p-cm">{eur(cm)}</span> : <span class="p-none">no CM price</span>}
      </div>
    </a>
  );
}

/** The cards of a screen, as rows or, in the Gallery layout, as big pictures. */
export function CardList({ items, data, current }: { items: Item[]; data: AppData; current?: string | null }) {
  const look = useLook();
  if (look.density === "gallery") {
    return <div class="gallery">{items.map((it) => <GalleryCard {...it} data={data} />)}</div>;
  }
  return <div class="list">{items.map((it) => <WishRow {...it} data={data} current={current === it.w.key} />)}</div>;
}
