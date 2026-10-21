// "Bought it" (3c): record what I paid, where and in what condition. One copy comes off the wish;
// the saving is measured against Cardmarket's trend today (spec principle 5).
import { useEffect, useState } from "preact/hooks";
import { saveEdit } from "../edits";
import { cmTrend, condName, eur, foilOnly } from "../format";
import { toast } from "../toast";
import type { LiveWish, PurchaseInput, Wish } from "../types";
import { CardImage } from "./CardImage";
import { IconClose, IconWarn } from "./icons";

const CONDITIONS = ["NM", "SP", "MP", "PL", "PO"];
// CardTrader's condition words -> the want-list grades
const GRADE: Record<string, string> = {
  Mint: "NM", "Near Mint": "NM", "Slightly Played": "SP", "Moderately Played": "MP", Played: "PL", "Heavily Played": "PL", Poor: "PO",
};
const today = () => new Date().toLocaleDateString("sv-SE");  // YYYY-MM-DD in my time zone

export function BoughtSheet({ wish: w, live, onClose, onDone }: { wish: Wish; live?: LiveWish; onClose: () => void; onDone: () => void }) {
  const canFoil = w.finishes.length === 0 || w.finishes.some((f) => f !== "nonfoil");
  const canPlain = w.finishes.length === 0 || w.finishes.includes("nonfoil");
  const [market, setMarket] = useState<PurchaseInput["market"]>(live ? "cardtrader" : "cardmarket");
  const [foil, setFoil] = useState(foilOnly(w) || w.foil === "yes" || (w.foil === "any" && !!live?.foil));
  const trend = cmTrend(w, foil);
  const suggested = (m: string) => (m === "cardtrader" ? live?.price : m === "cardmarket" ? trend : null);
  const [price, setPrice] = useState(() => suggested(live ? "cardtrader" : "cardmarket")?.toFixed(2) ?? "");
  const [touched, setTouched] = useState(false);
  const [condition, setCondition] = useState(live ? GRADE[live.condition] ?? "NM" : "NM");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paid = Number(price.replace(",", "."));
  const saved = trend && paid > 0 ? trend - paid : null;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);

  const pickMarket = (m: PurchaseInput["market"]) => {
    setMarket(m);
    const s = suggested(m);
    if (!touched && s) setPrice(s.toFixed(2));  // follow the market until I type my own price
  };

  const save = async (e: Event) => {
    e.preventDefault();
    if (!(paid > 0)) return setError("Type the price you paid, like 4.50.");
    setBusy(true);
    setError(null);
    try {
      const purchase: PurchaseInput = {
        price_eur: paid.toFixed(2), market, condition, foil: foil ? "yes" : "no",
        language: live?.language && w.language === "any" ? live.language : w.language, date,
        cardmarket_trend_eur: trend ? trend.toFixed(2) : "",
      };
      const card = { name: w.name, set: w.set, number: w.number, scryfall_id: w.scryfall_id, thumb: w.thumb, rarity: w.rarity,
        tags: w.tags, set_name: w.set_name, lists: w.lists };
      await saveEdit({ op: "bought", key: w.key, purchase, card });
      const off = w.quantity > 1 ? `${w.quantity - 1} more wanted` : "it's off the want-list";
      toast(saved != null && saved > 0 ? `Saved ${eur(saved)} against Cardmarket, and ${off}.` : `Recorded, and ${off}.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet-wrap" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="sheet" role="dialog" aria-modal="true" aria-label="Bought it" onSubmit={save}>
        <header class="sheet-head">
          <CardImage src={w.thumb} alt="" foil={false} />
          <div><h2>Bought it</h2><p>{w.name}{w.set ? ` · ${w.set.toUpperCase()} ${w.number}` : ""}</p></div>
          <button class="icon-btn" type="button" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>
        <div class="sheet-body">
          <div class="group form">
            <div class="f-row stack"><span>Where</span>
              <div class="seg full" role="radiogroup" aria-label="Where">
                {([["cardtrader", "CardTrader"], ["cardmarket", "Cardmarket"], ["other", "Elsewhere"]] as const).map(([id, label]) => (
                  <button type="button" role="radio" aria-checked={market === id} aria-pressed={market === id} onClick={() => pickMarket(id)}>{label}</button>
                ))}
              </div>
            </div>
            <label class="f-row"><span>Price paid<small>The card only, without shipping</small></span>
              <span class="money"><span>€</span><input inputMode="decimal" value={price} autoFocus
                onInput={(e) => { setTouched(true); setPrice((e.target as HTMLInputElement).value); }} /></span>
            </label>
            <div class="f-row stack"><span>Condition</span>
              <div class="seg full" role="radiogroup" aria-label="Condition">
                {CONDITIONS.map((c) => <button type="button" role="radio" aria-checked={condition === c} aria-pressed={condition === c} onClick={() => setCondition(c)}>{c}</button>)}
              </div>
              <small>{condName(condition)}</small>
            </div>
            {canFoil && canPlain && (
              <div class="f-row stack"><span>Finish</span>
                <div class="seg full" role="radiogroup" aria-label="Finish">
                  <button type="button" role="radio" aria-checked={!foil} aria-pressed={!foil} onClick={() => setFoil(false)}>Non-foil</button>
                  <button type="button" role="radio" aria-checked={foil} aria-pressed={foil} onClick={() => setFoil(true)}>Foil</button>
                </div>
              </div>
            )}
            <label class="f-row"><span>Date</span>
              <input class="date" type="date" value={date} max={today()} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
            </label>
          </div>
          <div class={`saving-line${saved != null && saved > 0 ? " good" : ""}`}>
            {trend == null ? "No Cardmarket price to compare with."
              : saved == null ? `Cardmarket trend ${eur(trend)}.`
              : saved > 0 ? <>You save <b>{eur(saved)}</b> ({Math.round((saved / trend) * 100)}%) against Cardmarket's trend of {eur(trend)}.</>
              : saved < 0 ? <>{eur(-saved)} more than Cardmarket's trend of {eur(trend)}.</>
              : <>The same as Cardmarket's trend.</>}
          </div>
          <p class="hint">{w.quantity > 1 ? `One copy comes off the wish (${w.quantity - 1} more wanted).` : "The card leaves the want-list."} It goes on your Bought list.</p>
          {error && <div class="notice"><IconWarn />{error}</div>}
        </div>
        <footer class="sheet-foot">
          <button class="btn" type="button" onClick={onClose}>Cancel</button>
          <button class="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save purchase"}</button>
        </footer>
      </form>
    </div>
  );
}
