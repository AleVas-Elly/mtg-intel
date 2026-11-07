import type { ComponentChildren } from "preact";
import type { AppData } from "../data";
import { collectorLine, eur, showsFoil, wishLine } from "../format";
import { marketView, pctClass, pctText } from "../markets";
import { openCard } from "../router";
import type { Wish } from "../types";
import { CardImage, preloadImage } from "./CardImage";
import { ManaCost, SetSymbol } from "./symbols";
import { useLook } from "../lab";

export const CM_ICON = "https://static.cardmarket.com/img/favicon.ico";
/** CardTrader's own mark, the pair of triangles from the SVG on its site (cardtrader.com/assets/logo/favicon_dark.svg),
 *  on a dark tile so its white triangle shows in both themes. Its favicon.ico is a blurry 16 px bitmap; Cardmarket's icon stays. */
const CtMark = () => (
  <svg class="mk-ct" viewBox="0 0 16 16" width="14" height="14" role="img" aria-label="CardTrader">
    <rect width="16" height="16" rx="3.5" fill="#14181d" />
    <g transform="translate(3.2 2.5) scale(.2439)">
      <path d="m12 17.7-1.1 2-1.1 2c-.1.2-.4.4-.6.3h-1.8c-2.2 0-4.4 0-6.6 0-.4.1-.7-.2-.8-.6 0-.2 0-.4.1-.5 1.2-2.1 2.4-4.3 3.6-6.4s2.3-4 3.5-6l3.3-5.9 1.2-2.2s.1-.1.1-.1c.2-.3.3-.3.4 0l.8 1.4 3 5.3 3 5.3 2.9 5.2c.7 1.2 1.4 2.5 2.1 3.7.2.3.1.7-.2.9-.1.1-.3.1-.4.1-2.8 0-5.5 0-8.3 0-.4 0-.8-.2-.9-.5-.7-1.2-1.4-2.5-2.1-3.7z" fill="#2aa8f8" />
      <path d="m27.4 27.4c.2-.4.4-.7.6-1 .6-1 1.1-2 1.7-3 .1-.3.4-.4.7-.4h8.3c.7 0 1 .5.6 1.1-1.1 1.9-2.1 3.8-3.2 5.7-1.3 2.2-2.5 4.4-3.8 6.7l-3.1 5.5-1.6 2.9c-.1.1-.1.1-.2.2-.1-.1-.1-.1-.2-.2l-3.2-5.8c-1.1-2-2.3-4-3.4-6.1s-2.3-4.1-3.4-6.1c-.5-1-1.1-2-1.6-2.9-.2-.3-.2-.7.1-.9.1-.1.3-.1.5-.1h8.3c.3 0 .6.2.8.5.7 1.2 1.4 2.5 2.1 3.7z" fill="#fff" />
    </g>
  </svg>
);

/** Both markets for a wish: CardTrader's cheapest fitting copy (shipping included via Zero) and
 *  Cardmarket's lowest listing plus shipping, each with how far under the usual price it is; the
 *  market that saves more is set bigger. */
export function Markets({ w, data, ctPrice }: { w: Wish; data: AppData; ctPrice?: number | null }) {
  const live = data.liveOf(w.key);
  const { ct, cm, low, ship, usual, sCt, sCm, lead } = marketView(w, data, live?.foil, ctPrice);
  if (w.pending === "add") return <div class="r-price"><span class="p-none">prices soon</span></div>;
  return (
    <div class="r-price mk-prices">
      {ct != null ? (
        <span class={`mk${lead === "ct" ? " lead" : ""}`} title={`CardTrader: cheapest copy that fits the wish${live?.zero ? ", via Zero (shipping included)" : ""}`}>
          <CtMark /><b>{eur(ct)}</b>{sCt != null && <i class={pctClass(sCt)}>{pctText(sCt)}</i>}
        </span>
      ) : <span class="p-none">{w.blueprint_id ? "no CardTrader copy" : "not on CardTrader"}</span>}
      {cm != null ? (
        <span class={`mk${lead === "cm" ? " lead" : ""}`} title={`Cardmarket: lowest listing ${eur(low)} (any seller and condition) + ${eur(ship)} shipping`}>
          <img src={CM_ICON} alt="Cardmarket" width="14" height="14" /><b>{eur(cm)}</b>{sCm != null && <i class={pctClass(sCm)}>{pctText(sCm)}</i>}
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
