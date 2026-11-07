// "Check CardTrader" on the pane of a card that isn't on the want-list (D83): CardTrader's live
// copies, fetched only when I ask (one request through the site, kept 5 minutes), instead of
// tracking every collection card in the deal check.
import { useState } from "preact/hooks";
import { can } from "../access";
import { send } from "../api";
import { ago, countryName, eur, langName } from "../format";
import { IconOut } from "./icons";

interface Copy { price: number; condition: string; language: string; foil: boolean; zero: boolean; country: string; quantity: number }
interface Answer { checked_at: string; copies: Copy[] }

const GRADE: Record<string, string> = {
  Mint: "NM", "Near Mint": "NM", "Slightly Played": "SP", "Moderately Played": "MP", Played: "PL", "Heavily Played": "PL", Poor: "PO",
};
const LANG: Record<string, string> = { jp: "ja", kr: "ko", "zh-CN": "zhs", "zh-TW": "zht" };  // CardTrader -> Scryfall codes

/** The CardTrader half of the pane's Prices: a button, then the cheapest Near Mint copy of the
 *  finish this printing comes in, and what else there is. */
export function CtCheck({ blueprint, foilOnly }: { blueprint: number | null; foilOnly: boolean }) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = blueprint ? `https://www.cardtrader.com/cards/${blueprint}` : null;

  if (!blueprint || !can("deals")) {
    return (
      <div class="market">
        <span class="label">CardTrader</span>
        <span class="big">–</span>
        <span class="note">{blueprint ? "Checked every 10 minutes once it's on the want-list" : "Not on CardTrader"}</span>
      </div>
    );
  }

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await send<Answer>("GET", `/api/ct/${blueprint}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "CardTrader didn't answer. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const mine = (answer?.copies ?? []).filter((c) => c.foil === foilOnly);
  const nm = mine.filter((c) => GRADE[c.condition] === "NM");
  const best = nm[0] ?? mine[0];
  const anyCheaper = mine[0] && best && mine[0].price < best.price - 0.005 ? mine[0] : null;
  const other = (answer?.copies ?? []).find((c) => c.foil !== foilOnly);
  const lang = (c: Copy) => langName(LANG[c.language] ?? c.language);

  return (
    <div class="market">
      <span class="label">CardTrader{best?.zero ? " · Zero" : ""}</span>
      <span class="big">{best ? eur(best.price) : "–"}</span>
      {!answer && <span class="note">Live copies, checked when you ask</span>}
      {answer && !best && <span class="note">No {foilOnly ? "foil " : ""}copy for sale right now</span>}
      {best && <span class="note">{GRADE[best.condition] ?? best.condition} · {lang(best)}{best.foil ? " · foil" : ""}{best.country ? ` · ${countryName(best.country)}` : ""}</span>}
      {answer && <span class="note">{mine.length} {mine.length === 1 ? "copy" : "copies"}{anyCheaper ? ` · played from ${eur(anyCheaper.price)}` : ""}{other ? ` · ${foilOnly ? "non-foil" : "foil"} from ${eur(other.price)}` : ""}</span>}
      {answer && <span class="note">Checked {ago(answer.checked_at)}</span>}
      {error && <span class="note warn-text">{error}</span>}
      <span class="ct-actions">
        <button class="btn" type="button" onClick={check} disabled={busy}>{busy ? "Checking…" : answer ? "Check again" : "Check CardTrader"}</button>
        {answer && link && <a class="btn" href={link} target="_blank" rel="noopener" aria-label="Open on CardTrader">Open<IconOut /></a>}
      </span>
    </div>
  );
}
