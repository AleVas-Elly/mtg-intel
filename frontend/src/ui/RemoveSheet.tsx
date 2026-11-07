// Taking cards out of the collection (D79): sold, traded or gifted, lost, or recorded by mistake.
// Kept simple on purpose (user, 2026-11-07: "I am not planning to sell many cards"): a reason, an
// optional selling price, how many, and Undo for a few seconds. The purchase record stays (what I
// paid), only a mistake deletes it.
import { useEffect, useState } from "preact/hooks";
import { can } from "../access";
import { useDoc } from "../api";
import { myPurchases, ownedCards, refOf, type Owned } from "../collection";
import type { AppData } from "../data";
import { saveEdit, undoEdit } from "../edits";
import { day, eur, langName } from "../format";
import { toast } from "../toast";
import type { GoneReason, PurchasesDoc } from "../types";
import { CardImage } from "./CardImage";
import { Confirm } from "./Confirm";
import { IconClose, IconWarn } from "./icons";

const today = () => new Date().toLocaleDateString("sv-SE");  // YYYY-MM-DD in my time zone
const REASONS: [GoneReason, string][] = [["sold", "Sold"], ["traded", "Traded or gifted"], ["lost", "Lost"], ["mistake", "Added by mistake"]];
export const GONE_TEXT: Record<string, string> = { sold: "Sold", traded: "Traded or gifted", lost: "Lost" };

/** "NM · foil · Japanese", the way a group of copies differs from the others of the same card. */
export const copyText = (o: Owned) => [o.condition, o.foil ? "foil" : "non-foil", o.language ? langName(o.language) : null].filter(Boolean).join(" · ");

/** "Sold 7 Nov for €6.50" */
export const goneText = (o: Owned) =>
  `${GONE_TEXT[o.gone ?? ""] ?? "Gone"}${o.gone_date ? ` ${day(o.gone_date)}` : ""}${o.sold != null && can("money") ? ` for ${eur(o.sold)}` : ""}`;

export function RemoveSheet({ o, onClose }: { o: Owned; onClose: () => void }) {
  const [reason, setReason] = useState<GoneReason>("sold");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(() => (o.now != null && can("money") ? o.now.toFixed(2) : ""));
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);

  const sold = Number(price.replace(",", "."));
  const save = async (e: Event) => {
    e.preventDefault();
    if (reason === "sold" && price.trim() && !(sold >= 0)) return setError("Type the price a copy sold for, like 6.50, or leave it empty.");
    setBusy(true);
    setError(null);
    try {
      const remove = { reason, qty, date, sold_eur: reason === "sold" && price.trim() ? sold.toFixed(2) : "" };
      const doc = await saveEdit({ op: "removed", owned: refOf(o), remove });
      const op = [...doc.ops].reverse().find((x) => x.op === "removed" && x.owned?.scryfall_id === refOf(o).scryfall_id);
      const what = qty === 1 ? o.name : `${qty} copies of ${o.name}`;
      toast(reason === "mistake" ? `Deleted ${what} from the collection.` : `${what}: ${GONE_TEXT[reason].toLowerCase()}, out of the collection.`,
        op && { label: "Undo", run: () => { undoEdit(op.id).catch(() => toast("Too late to undo: it's already saved.")); } });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet-wrap" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="sheet" role="dialog" aria-modal="true" aria-label="Remove from collection" onSubmit={save}>
        <header class="sheet-head">
          <CardImage src={o.thumb} alt="" foil={o.foil} />
          <div><h2>Remove from collection</h2><p>{o.name}{o.set ? ` · ${o.set.toUpperCase()} ${o.number ?? ""}` : ""} · {copyText(o)}</p></div>
          <button class="icon-btn" type="button" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>
        <div class="sheet-body">
          <div class="group form">
            <div class="f-row stack"><span>Why</span>
              <div class="seg full two" role="radiogroup" aria-label="Why">
                {REASONS.map(([id, label]) => (
                  <button type="button" role="radio" aria-checked={reason === id} aria-pressed={reason === id} onClick={() => setReason(id)}>{label}</button>
                ))}
              </div>
            </div>
            {reason === "sold" && can("money") && (
              <label class="f-row"><span>Sold for<small>{o.settled > 1 ? "A copy, if you want to keep it" : "If you want to keep it"}</small></span>
                <span class="money"><span>€</span><input inputMode="decimal" value={price} placeholder="optional"
                  onInput={(e) => setPrice((e.target as HTMLInputElement).value)} /></span>
              </label>
            )}
            {o.settled > 1 && (
              <div class="f-row"><span>How many<small>Of the {o.settled} you have</small></span>
                <span class="stepper">
                  <button type="button" class="icon-btn" aria-label="One fewer" disabled={qty <= 1} onClick={() => setQty(qty - 1)}>−</button>
                  <b aria-live="polite">{qty}</b>
                  <button type="button" class="icon-btn" aria-label="One more" disabled={qty >= o.settled} onClick={() => setQty(qty + 1)}>+</button>
                </span>
              </div>
            )}
            {reason !== "mistake" && (
              <label class="f-row"><span>Date</span>
                <input class="date" type="date" value={date} max={today()} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
              </label>
            )}
          </div>
          <p class="hint">{reason === "mistake"
            ? `The purchase record is deleted, as if it was never added.`
            : `${qty === 1 ? "It leaves" : "They leave"} the collection and its value. What you paid stays on record; the Collection's Sold tab lists ${qty === 1 ? "it" : "them"}.`}</p>
          {error && <div class="notice"><IconWarn />{error}</div>}
        </div>
        <footer class="sheet-foot">
          <button class="btn" type="button" onClick={onClose}>Cancel</button>
          <button class={`btn ${reason === "mistake" ? "danger" : "primary"}`} type="submit" disabled={busy}>
            {busy ? "Saving…" : reason === "mistake" ? "Delete record" : "Remove"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/** Delete the records of copies that already left (D84), with Undo for a few seconds. */
async function deleteRecord(o: Owned) {
  try {
    const owned = { ...refOf(o), gone: o.gone ?? "", gone_date: o.gone_date ?? "" };
    const doc = await saveEdit({ op: "removed", owned, remove: { reason: "mistake", qty: o.settled, date: today(), sold_eur: "" } });
    const op = [...doc.ops].reverse().find((x) => x.op === "removed" && x.owned?.gone === owned.gone && x.owned?.scryfall_id === owned.scryfall_id);
    toast(`Deleted the record of ${o.name}.`, op && { label: "Undo", run: () => { undoEdit(op.id).catch(() => toast("Too late to undo: it's already deleted.")); } });
  } catch (err) {
    toast(err instanceof Error ? err.message : "Couldn't delete it. Try again.");
  }
}

/** "In your collection" on a card's pane: the copies I own of this printing, each with Remove, and
 *  the ones that left. Nothing when I own none and none left. */
export function OwnedHere({ data, id }: { data: AppData; id: string | null }) {
  const allowed = can("collection");
  const doc = useDoc<PurchasesDoc>(allowed && id ? "purchases" : null).doc;
  const [removing, setRemoving] = useState<Owned | null>(null);
  const [deleting, setDeleting] = useState<Owned | null>(null);
  if (!allowed || !id || !doc) return null;
  const all = myPurchases(data.edits.ops, doc).filter((p) => p.scryfall_id === id);
  const owned = ownedCards(all), gone = ownedCards(all, true).sort((a, b) => (b.gone_date ?? "").localeCompare(a.gone_date ?? ""));
  if (!owned.length && !gone.length) return null;
  return (
    <>
      <div class="group-title">In your collection</div>
      <div class="group">
        {owned.map((o) => (
          <div class="kv owned-line">
            <dt><b>{o.qty} ×</b> {copyText(o)}<small>{o.pending ? "Saving" : `${o.qty > 1 ? "Last bought" : "Bought"} ${day(o.last)}${can("money") ? ` for ${eur(o.paid / o.qty)}${o.qty > 1 ? " each on average" : ""}` : ""}`}</small></dt>
            <dd>{can("bought") && <button class="btn sm" type="button" onClick={() => setRemoving(o)} disabled={!o.settled}
              title={!o.settled ? "Wait until it's saved" : undefined}>Remove</button>}</dd>
          </div>
        ))}
        {gone.map((o) => (
          <div class="kv owned-line left">
            <dt><b>{o.qty} ×</b> {copyText(o)}<small>{o.pending ? "Saving" : goneText(o)}</small></dt>
            <dd>{can("bought") && o.settled
              ? <button class="btn sm" type="button" onClick={() => setDeleting(o)} aria-label={`Delete the record of ${o.name}`}>Delete</button>
              : GONE_TEXT[o.gone ?? ""]}</dd>
          </div>
        ))}
      </div>
      {removing && <RemoveSheet o={removing} onClose={() => setRemoving(null)} />}
      {deleting && (
        <Confirm title={`Delete the record of ${deleting.name}?`}
          text={`${deleting.settled === 1 ? "This copy" : `These ${deleting.settled} copies`} and what you paid${deleting.sold != null ? " and sold for" : ""} are deleted, as if never recorded. Use it for test cards or mistakes.`}
          action="Delete" onCancel={() => setDeleting(null)} onConfirm={() => { const o = deleting; setDeleting(null); deleteRecord(o); }} />
      )}
    </>
  );
}
