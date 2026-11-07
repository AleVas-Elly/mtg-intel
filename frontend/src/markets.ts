// One place for the two market prices a card shows, so the list rows and the side pane can't drift apart (D70).
//   CardTrader: the cheapest copy that fits the wish (Zero, so shipping is in it).
//   Cardmarket: the lowest listing for the finish (any seller and condition, from the daily price list) plus
//   the shipping estimated for a card of that price. The trend and 7-day figures are context, not the price.
//   usual: what both are judged against, decided by the deal check (D78): the lower of Cardmarket's trend plus
//   shipping and CardTrader's usual price. Before a check has judged the card, Cardmarket's side alone.
import type { AppData } from "./data";
import { cmLow, cmShipping, cmTrend, withShipping } from "./format";
import type { LiveWish, Wish } from "./types";

/** The usual price a wish is judged against: the deal check's own (live `ref`, D78), else Cardmarket's trend plus
 *  shipping. The one place the site reads it, so rows, pane, lists and sorts can't disagree with the alerts. */
export function usualPrice(w: Wish, live: LiveWish | undefined, foil?: boolean): number | null {
  if (live?.ref) return live.ref;
  const trend = cmTrend(w, foil ?? live?.foil);
  return trend ? withShipping(trend) : null;
}

export const under = (usual: number | null, p: number | null) => (usual && p != null ? (usual - p) / usual : null);
export const pctText = (s: number) => (s >= 0.005 ? `−${Math.round(s * 100)}%` : s <= -0.005 ? `+${Math.round(-s * 100)}%` : "0%");
/** The colour class of a percentage: a saving, over the usual price, or level with it. */
export const pctClass = (s: number) => (s >= 0.005 ? "good" : s <= -0.005 ? "up" : "over");

export interface MarketView {
  ct: number | null; cm: number | null; low: number | null; ship: number | null; trend: number | null;
  usual: number | null; ctUsual: number | null; sCt: number | null; sCm: number | null; lead: "ct" | "cm";
}

/** `foil` picks the finish (the list uses the live copy's, the pane its Foil switch); `ctPrice` overrides the live CardTrader price. */
export function marketView(w: Wish, data: AppData, foil?: boolean, ctPrice?: number | null): MarketView {
  const live = data.liveOf(w.key);
  const ct = ctPrice !== undefined ? ctPrice : live?.price ?? null;
  const trend = cmTrend(w, foil);
  const low = cmLow(w, foil);
  const ship = low != null ? cmShipping(low) : null;
  const cm = low != null ? Math.round((low + ship!) * 100) / 100 : null;
  const usual = usualPrice(w, live, foil);
  const sCt = under(usual, ct), sCm = under(usual, cm);
  const lead = ct == null ? "cm" : cm == null ? "ct" : (sCt ?? -9) >= (sCm ?? -9) ? "ct" : "cm";
  return { ct, cm, low, ship, trend, usual, ctUsual: live?.usual ?? null, sCt, sCm, lead };
}

/** Which of a row's prices to count: the cheaper of the two, or one market only (the Dashboards' switch, D77). */
export type PriceFrom = "best" | "ct" | "cm";

/** A price the row shows: CardTrader's copy, Cardmarket's lowest listing plus shipping, or the cheaper of the two
 *  (D72), which is what the Price sort and the price filter use, so their order matches what is on screen. */
export function shownPrice(w: Wish, data: AppData, from: PriceFrom = "best"): number | null {
  const { ct, cm } = marketView(w, data, data.liveOf(w.key)?.foil);
  if (from !== "best") return from === "ct" ? ct : cm;
  const prices = [ct, cm].filter((v): v is number => v != null);
  return prices.length ? Math.min(...prices) : null;
}
