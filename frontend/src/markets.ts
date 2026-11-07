// One place for the two market prices a card shows, so the list rows and the side pane can't drift apart (D70).
//   CardTrader: the cheapest copy that fits the wish (Zero, so shipping is in it).
//   Cardmarket: the lowest listing for the finish (any seller and condition, from the daily price list) plus
//   the shipping estimated for a card of that price. The trend and 7-day figures are context, not the price.
//   usual: what both are judged against, the higher of Cardmarket's trend and CardTrader's usual price (D52).
import type { AppData } from "./data";
import { cmLow, cmShipping, cmTrend } from "./format";
import type { Wish } from "./types";

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
  const refs = [trend, live?.usual].filter((v): v is number => !!v);
  const usual = live?.ref ?? (refs.length ? Math.max(...refs) : null);
  const sCt = under(usual, ct), sCm = under(usual, cm);
  const lead = ct == null ? "cm" : cm == null ? "ct" : (sCt ?? -9) >= (sCm ?? -9) ? "ct" : "cm";
  return { ct, cm, low, ship, trend, usual, ctUsual: live?.usual ?? null, sCt, sCm, lead };
}

/** The cheaper of the two prices a row shows (D72): what the Price sort and the price filter use, so their
 *  order matches what is on screen. */
export function shownPrice(w: Wish, data: AppData): number | null {
  const { ct, cm } = marketView(w, data, data.liveOf(w.key)?.foil);
  const prices = [ct, cm].filter((v): v is number => v != null);
  return prices.length ? Math.min(...prices) : null;
}
