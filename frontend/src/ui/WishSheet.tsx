// The settings of one wish, for a card being added (from Search) or an existing wish (card page).
import { useEffect, useMemo, useState } from "preact/hooks";
import { changed, NEW_WISH, saveEdit, settingsOf } from "../edits";
import type { AppData } from "../data";
import { condName, langName, versionText } from "../format";
import { preview, printings, type ScryCard } from "../scry";
import { toast } from "../toast";
import type { Settings, Wish } from "../types";
import { CardImage } from "./CardImage";
import { IconClose, IconMinus, IconPlus, IconWarn } from "./icons";

const LANGUAGES = ["en", "any", "ja", "it", "fr", "de", "es", "pt", "ko", "ru", "zhs", "zht"];
const CONDITIONS = ["NM", "SP", "MP", "PL", "PO"];

function Seg<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { id: T; label: string; off?: boolean }[]; onChange: (v: T) => void;
}) {
  return (
    <div class="seg full" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={value === o.id} aria-pressed={value === o.id} disabled={o.off}
          onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Every printing of the card being added, to pick the exact one; printings already on the
 *  want-list can't be picked again. */
function Versions({ wish, data, onPick }: { wish: Wish; data?: AppData; onPick: (w: Wish) => void }) {
  const [cards, setCards] = useState<ScryCard[] | null>(null);
  useEffect(() => {
    // the printing I tapped in Search comes first, then the rest newest first
    if (wish.prints) printings(wish.prints).then((all) => setCards([...all.filter((c) => c.id === wish.scryfall_id),
      ...all.filter((c) => c.id !== wish.scryfall_id)])).catch(() => setCards([]));
  }, []);
  const mine = new Set((data?.wants?.wishes ?? []).map((w) => w.scryfall_id));
  if (!wish.prints) return null;
  return (
    <div class="f-row stack"><span>Version{cards && cards.length > 1 ? <small>{cards.length} printings</small> : null}</span>
      <div class="versions" role="radiogroup" aria-label="Version">
        {cards === null
          ? Array.from({ length: 4 }, () => <span class="version"><span class="thumb skeleton" /></span>)
          : cards.map((c) => {
              const v = preview(c);
              const on = mine.has(c.id);
              return (
                <button type="button" class="version" role="radio" aria-checked={wish.scryfall_id === c.id} disabled={on}
                  onClick={() => onPick({ ...v, prints: wish.prints })} title={`${c.set_name} #${c.collector_number}`}>
                  <CardImage src={v.thumb} alt="" foil={false} />
                  <b>{c.set.toUpperCase()} {c.collector_number}</b>
                  <small>{on ? "on the list" : versionText(v)}</small>
                </button>
              );
            })}
      </div>
    </div>
  );
}

/** `wish` is the existing wish, or a card preview to add (then `adding` is true). */
export function WishSheet({ wish: given, adding, lists, data, onClose }: {
  wish: Wish; adding: boolean; lists: string[]; data?: AppData; onClose: () => void;
}) {
  const [wish, setWish] = useState(given);
  const start = useMemo<Settings>(() => (adding ? { ...settingsOf(given), ...NEW_WISH } : settingsOf(given)), [given.key]);
  const [s, setS] = useState<Settings>(start);
  const [newList, setNewList] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Settings) => (v: string) => setS((old) => ({ ...old, [k]: v }));
  const chosen = (s.list ?? "").split("; ").filter(Boolean);
  const allLists = [...new Set([...lists, ...chosen])].sort();
  const toggleList = (name: string) =>
    set("list")((chosen.includes(name) ? chosen.filter((l) => l !== name) : [...chosen, name]).join("; "));
  const finishes = wish.finishes.length ? wish.finishes : ["nonfoil", "foil"];
  const qty = Number(s.quantity) || 1;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);

  const save = async (e: Event) => {
    e.preventDefault();
    const out = { ...s, list: [...chosen, ...(newList.trim() && !chosen.includes(newList.trim()) ? [newList.trim()] : [])].join("; ") };
    const target = out.max_price_eur?.replace(",", ".").trim() ?? "";
    const pct = out.deal_pct?.trim() ?? "";
    if (target && !(Number(target) > 0)) return setError("The target price must be a number, like 4.50.");
    if (pct && !(Number(pct) > 0 && Number(pct) < 100)) return setError("The deal level must be a percentage between 1 and 99.");
    out.max_price_eur = target;
    out.deal_pct = pct;
    setBusy(true);
    setError(null);
    try {
      if (adding) {
        const card: Partial<Wish> = { ...wish, key: undefined, pending: undefined, prints: undefined };
        await saveEdit({ op: "add", scryfall_id: wish.scryfall_id!, settings: out, card });
        toast(`Added ${wish.name}. CardTrader prices follow within about 10 minutes.`);
      } else {
        const diff = changed(wish, out);
        if (!Object.keys(diff).length) return onClose();
        await saveEdit({ op: "update", key: wish.key, settings: diff });
        toast("Saved. The next check uses the new settings.");
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet-wrap" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="sheet" role="dialog" aria-modal="true" aria-label={adding ? "Add to want-list" : "Edit wish"} onSubmit={save}>
        <header class="sheet-head">
          <CardImage src={wish.thumb} alt="" foil={false} />
          <div>
            <h2>{adding ? "Add to want-list" : "Edit wish"}</h2>
            <p>{wish.name}{wish.set ? ` · ${wish.set.toUpperCase()} ${wish.number}` : ""}</p>
          </div>
          <button class="icon-btn" type="button" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>
        <div class="sheet-body">
          <div class="group-title">Which copy counts</div>
          <div class="group form">
            {adding && <Versions wish={wish} data={data} onPick={(w) => {
              setWish(w);
              const has = (f: string) => (w.finishes.length ? w.finishes : ["nonfoil", "foil"]).some((x) => (f === "no" ? x === "nonfoil" : x !== "nonfoil"));
              if (s.foil !== "any" && !has(s.foil ?? "any")) set("foil")("any");
            }} />}
            <label class="f-row"><span>Language</span>
              <select class="select" value={s.language} onChange={(e) => set("language")((e.target as HTMLSelectElement).value)}>
                {LANGUAGES.map((l) => <option value={l}>{langName(l)}</option>)}
              </select>
            </label>
            <div class="f-row stack"><span>Finish</span>
              <Seg label="Finish" value={(s.foil ?? "any") as string} onChange={set("foil")} options={[
                { id: "any", label: "Any" },
                { id: "no", label: "Non-foil", off: !finishes.includes("nonfoil") },
                { id: "yes", label: "Foil", off: !finishes.some((f) => f !== "nonfoil") },
              ]} />
            </div>
            <div class="f-row stack"><span>Worst condition I accept</span>
              <Seg label="Worst condition" value={(s.min_condition ?? "NM") as string} onChange={set("min_condition")}
                options={CONDITIONS.map((c) => ({ id: c, label: c }))} />
              <small>{condName(s.min_condition ?? "NM")} or better</small>
            </div>
            <label class="f-row"><span>CardTrader Zero only</span>
              <input type="checkbox" class="switch" checked={s.via_zero === "yes"}
                onChange={(e) => set("via_zero")((e.target as HTMLInputElement).checked ? "yes" : "no")} />
            </label>
          </div>

          <div class="group-title">When to tell me</div>
          <div class="group form">
            <label class="f-row"><span>Target price<small>Alert at or under this</small></span>
              <span class="money"><span>€</span><input inputMode="decimal" placeholder="none" value={s.max_price_eur}
                onInput={(e) => set("max_price_eur")((e.target as HTMLInputElement).value)} /></span>
            </label>
            <label class="f-row"><span>Deal from<small>How far under the market counts as a deal</small></span>
              <span class="money"><input inputMode="numeric" placeholder="20" value={s.deal_pct}
                onInput={(e) => set("deal_pct")((e.target as HTMLInputElement).value)} /><span>%</span></span>
            </label>
          </div>

          <div class="group-title">Lists and notes</div>
          <div class="group form">
            <div class="f-row stack"><span>Lists</span>
              <div class="chips">
                {allLists.map((l) => (
                  <button type="button" class="chip toggle" aria-pressed={chosen.includes(l)} onClick={() => toggleList(l)}>{l}</button>
                ))}
                <input class="chip-input" placeholder="New list" value={newList} onInput={(e) => setNewList((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div class="f-row"><span>Copies</span>
              <span class="stepper">
                <button type="button" class="icon-btn" disabled={qty <= 1} onClick={() => set("quantity")(String(qty - 1))} aria-label="One fewer"><IconMinus /></button>
                <b aria-live="polite">{qty}</b>
                <button type="button" class="icon-btn" onClick={() => set("quantity")(String(qty + 1))} aria-label="One more"><IconPlus /></button>
              </span>
            </div>
            <label class="f-row stack"><span>Note</span>
              <textarea rows={2} value={s.note} placeholder="Anything to remember" onInput={(e) => set("note")((e.target as HTMLTextAreaElement).value.replace(/\n/g, " "))} />
            </label>
          </div>
          {error && <div class="notice"><IconWarn />{error}</div>}
        </div>
        <footer class="sheet-foot">
          <button class="btn" type="button" onClick={onClose}>Cancel</button>
          <button class="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : adding ? "Add to want-list" : "Save changes"}</button>
        </footer>
      </form>
    </div>
  );
}
