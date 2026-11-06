import type { ComponentChildren } from "preact";
import type { AppData } from "../data";
import { cmLow, cmShipping, cmTrend, collectorLine, eur, showsFoil, wishLine } from "../format";
import { openCard } from "../router";
import type { Wish } from "../types";
import { CardImage, preloadImage } from "./CardImage";
import { ManaCost, SetSymbol } from "./symbols";
import { useLook } from "../lab";

export const CT_ICON = "https://www.cardtrader.com/favicon.ico";
export const CM_ICON = "https://static.cardmarket.com/img/favicon.ico";
const under = (usual: number | null, p: number | null) => (usual && p != null ? (usual - p) / usual : null);
const pctText = (s: number) => (s >= 0.005 ? `−${Math.round(s * 100)}%` : s <= -0.005 ? `+${Math.round(-s * 100)}%` : "0%");

/** Both markets for a wish: CardTrader's cheapest fitting copy (shipping included via Zero) and
 *  Cardmarket's lowest listing plus shipping, each with how far under the usual price it is; the
 *  market that saves more is set bigger. */
export function Markets({ w, data, ctPrice }: { w: Wish; data: AppData; ctPrice?: number | null }) {
  const live = data.liveOf(w.key);
  const ct = ctPrice !== undefined ? ctPrice : live?.price ?? null;
  const trend = cmTrend(w, live?.foil);
  const low = cmLow(w, live?.foil);
  const ship = low != null ? cmShipping(low) : null;
  const cm = low != null ? Math.round((low + ship!) * 100) / 100 : null;
  const refs = [trend, live?.usual].filter((v): v is number => !!v);
  const usual = live?.ref ?? (refs.length ? Math.max(...refs) : null);
  const sCt = under(usual, ct), sCm = under(usual, cm);
  const lead = ct == null ? "cm" : cm == null ? "ct" : (sCt ?? -9) >= (sCm ?? -9) ? "ct" : "cm";
  if (w.pending === "add") return <div class="r-price"><span class="p-none">prices soon</span></div>;
  return (
    <div class="r-price mk-prices">
      {ct != null ? (
        <span class={`mk${lead === "ct" ? " lead" : ""}`} title={`CardTrader: cheapest copy that fits the wish${live?.zero ? ", via Zero (shipping included)" : ""}`}>
          <img src={CT_ICON} alt="CardTrader" width="14" height="14" /><b>{eur(ct)}</b>{sCt != null && <i class={sCt >= 0.005 ? "good" : "over"}>{pctText(sCt)}</i>}
        </span>
      ) : <span class="p-none">{w.blueprint_id ? "no CardTrader copy" : "not on CardTrader"}</span>}
      {cm != null ? (
        <span class={`mk${lead === "cm" ? " lead" : ""}`} title={`Cardmarket: lowest listing ${eur(low)} (any seller and condition) + ${eur(ship)} shipping`}>
          <img src={CM_ICON} alt="Cardmarket" width="14" height="14" /><b>{eur(cm)}</b>{sCm != null && <i class={sCm >= 0.005 ? "good" : "over"}>{pctText(sCm)}</i>}
        </span>
      ) : <span class="p-none">no Cardmarket price</span>}
      {usual != null && <span class="mk-usual">usual {eur(usual)}</span>}
    </div>
  );
}

/** One card: picture, name and cost, the collector line, the wish, and both markets' prices. */
export function WishRow({ w, data, current, extra, ctPrice, gone, n }: {
  w: Wish; data: AppData; current?: boolean; extra?: ComponentChildren; ctPrice?: number | null; gone?: boolean; n?: number;
}) {
  const flagged = data.flagsOf(w).length > 0;
  return (
    <a
      class={`row${gone ? " gone" : ""}`}
      data-key={w.key}
      href={`?card=${encodeURIComponent(w.key)}`}
      aria-current={current ? "true" : undefined}
      style={n != null ? { "--n": n } : undefined}
      onClick={(e) => { e.preventDefault(); openCard(w.key); }}
      onPointerEnter={() => preloadImage(w.image, 0)} onPointerDown={() => preloadImage(w.image, 0)}
    >
      <CardImage src={w.thumb} alt="" foil={showsFoil(w)} />
      <div class="r-main">
        <div class="r-name"><span>{w.name}</span><ManaCost cost={w.mana_cost} front />{flagged && <span class="flag-dot" title="Needs a look" />}</div>
        <div class="r-line"><SetSymbol set={w.set} rarity={w.rarity} /><span>{collectorLine(w)}</span></div>
        {extra ?? <div class="r-wish">{w.pending && <span class="pending">{w.pending === "add" ? "Adding" : "Saving"}</span>}{wishLine(w)}{w.one_of ? ", either version" : ""}</div>}
      </div>
      <Markets w={w} data={data} ctPrice={ctPrice} />
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
function GalleryCard({ w, data, extra, ctPrice, gone, n }: Item & { data: AppData; n: number }) {
  return (
    <a class={`g-card${gone ? " gone" : ""}`} data-key={w.key} href={`?card=${encodeURIComponent(w.key)}`} style={{ "--n": n }}
      onClick={(e) => { e.preventDefault(); openCard(w.key); }}
      onPointerEnter={() => preloadImage(w.image, 0)} onPointerDown={() => preloadImage(w.image, 0)}>
      <CardImage src={w.image} alt={w.name} foil={showsFoil(w)} placeholder={w.thumb} />
      <div class="g-name"><span>{w.name}</span>{data.flagsOf(w).length > 0 && <span class="flag-dot" title="Needs a look" />}</div>
      <div class="g-line"><SetSymbol set={w.set} rarity={w.rarity} /><span>{collectorLine(w)}</span></div>
      {extra}
      <Markets w={w} data={data} ctPrice={ctPrice} />
    </a>
  );
}

/** The cards of a screen, as rows or, in the Gallery layout, as big pictures. */
/** `swap` changes when the filters or sort do: the list then plays its entrance again, so a
 *  filter click visibly lands (typing in the search box does not, it would flicker). */
export function CardList({ items, data, current, swap }: { items: Item[]; data: AppData; current?: string | null; swap?: string }) {
  const look = useLook();
  if (look.density === "gallery") {
    return <div class="gallery" key={swap}>{items.map((it, n) => <GalleryCard key={it.w.key} {...it} data={data} n={n} />)}</div>;
  }
  return <div class="list" key={swap}>{items.map((it, n) => <WishRow key={it.w.key} {...it} data={data} n={n} current={current === it.w.key} />)}</div>;
}
