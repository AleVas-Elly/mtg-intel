// The fast lane (D58): every minute, the ~15 cards closest to a deal, judged the way the deal check
// judges them, from the list each full check leaves in the site's `live` document. A copy that has
// become a deal (or hit the target), cheaper than the last full check saw and not seen here in the
// last hour, makes the timer start a full check at once, which puts it in my cart and alerts.
// Needs CARDTRADER_TOKEN; without it, it does nothing.

import { cardtrader, type TelegramEnv } from "./telegram.ts";

interface Fast {
  bp: number; key: string; lang: string; foil: string; grade: number; zero: boolean;
  ref: number; floor: number; max: number | null; best: number; gone: number[];
}

// CardTrader's condition words, best first (deals.CONDITIONS); a wish accepts up to its `grade`.
const CONDITIONS = ["Mint", "Near Mint", "Slightly Played", "Moderately Played", "Played", "Heavily Played", "Poor"];
const SEEN_SECONDS = 3600;

/** The cheapest copy of a card that fits the wish, from a marketplace answer. */
export function cheapest(f: Fast, products: any[]): { id: number; price: number } | null {
  let best: { id: number; price: number } | null = null;
  for (const p of products || []) {
    const props = p.properties_hash || {};
    const condition = CONDITIONS.indexOf(props.condition);
    if (p.graded || p.on_vacation || props.signed || props.altered || p.price_currency !== "EUR") continue;
    if (f.lang !== "any" && props.mtg_language !== f.lang) continue;
    if ((f.foil === "yes" && !props.mtg_foil) || (f.foil === "no" && props.mtg_foil)) continue;
    if (condition < 0 || condition > f.grade) continue;
    if (f.zero && !p.user?.can_sell_via_hub) continue;
    if (f.gone.includes(p.id)) continue;
    const price = p.price_cents / 100;
    if (!best || price < best.price) best = { id: p.id, price };
  }
  return best;
}

export function isDeal(f: Fast, price: number): boolean {
  if (f.max != null && price <= f.max) return true;
  return (1 - price / f.ref) * 100 >= f.floor;
}

/** The fast-lane cards that turned into a deal since the last full check. */
export async function fastLane(env: TelegramEnv): Promise<number[]> {
  if (!env.CARDTRADER_TOKEN) return [];
  // The list from the last `live` upload, copied to D1 by the site (D67): one row read a minute
  // instead of a KV read of the whole document.
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'fast'").first<{ value: string }>();
  const fast: Fast[] = row ? JSON.parse(row.value) : [];
  const found: number[] = [];
  for (const f of fast) {
    const query = `blueprint_id=${f.bp}` + (f.lang !== "any" ? `&language=${f.lang}` : "");
    const answer = await cardtrader(env, "GET", `/marketplace/products?${query}`);
    const copy = cheapest(f, answer?.[String(f.bp)] || []);
    if (!copy || copy.price >= f.best - 0.005 || !isDeal(f, copy.price)) continue;
    if (await env.DATA.get(`fast:${copy.id}`)) continue; // already handed to a check
    await env.DATA.put(`fast:${copy.id}`, "1", { expirationTtl: SEEN_SECONDS });
    found.push(copy.id);
  }
  return found;
}
