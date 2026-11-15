// PROTOTYPE, throwaway (mtg-intel-docs issue 6): paste a list of card names into the Want-list or the
// Collection, check the lines that weren't clear, then pick each card's exact version and settings.
// Round 2: the user picked the table (A); variants B (one by one) and C (wall of cards) are in this
// branch's history (3984d90). Each card starts from defaults; the rarer settings fold under "More options",
// per card and for every card at once. Cards and pictures are real (Scryfall); nothing is saved: the last screen
// shows what would be sent. Local copy only. Never merge to main.
import { useEffect, useMemo, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { peek } from "../api";
import type { WantsDoc } from "../types";
import { CardImage } from "../ui/CardImage";
import { IconClose, IconMinus, IconPlus } from "../ui/icons";
import { preview, printings, type ScryCard } from "../scry";
import { langName, versionText } from "../format";
import "./paste.css";

type Target = "wants" | "collection";
type Card = ScryCard & { promo?: boolean; layout?: string; booster?: boolean; prices?: { eur?: string | null; eur_foil?: string | null } };
interface Line { raw: string; qty: number; name: string; set?: string; number?: string; foil?: boolean }
interface Item {
  id: number; line: Line; status: "ok" | "guess" | "unknown" | "dropped"; card: Card | null; options: string[];
  prints: Card[] | null; chosen: boolean; qty: number; lang: string; cond: string; finish: string; price: string;
  // more options: want-list (target, deal level, lists, Zero only) and collection (date)
  target: string; deal: string; lists: string[]; zero: boolean; date: string;
}

// The member's usual language and condition (D94's welcome), here fixed.
const USUAL = { lang: "en", cond: "NM" };
const LANGS = ["en", "it", "de", "fr", "es", "ja", "pt", "ko", "ru", "zhs"];
const CONDS = ["NM", "SP", "MP", "PL", "PO"];
const MAIN_SETS = new Set(["core", "expansion", "masters", "draft_innovation"]);
const SIDE_SETS = new Set(["commander", "starter"]);
const EXAMPLE = `4 Lightning Bolt
1x Sol Ring (CMR) 472
1 Ancient Tomb (UMA) 236
Counterspell
2 Llanowar Elves
Lightning Bolf
The One Ring *F*
Ragavan
Sheoldred, the Apocalypse

Sideboard
1 Swords to Plowshares
Fable of the Mirror-Breaker
Snapcaster`;

// ---- reading the paste -------------------------------------------------------------------------
const SKIP = /^(sideboard|deck|main ?deck|mainboard|commander|companion|maybeboard|tokens?)\s*:?\s*(\(\d+\))?$/i;
function parse(text: string): Line[] {
  return text.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("//") && !s.startsWith("#") && !SKIP.test(s)).map((raw) => {
    let s = raw, qty = 1, foil = false, set: string | undefined, number: string | undefined;
    const q = s.match(/^(\d+)\s*x?\s+/i);
    if (q) { qty = Number(q[1]); s = s.slice(q[0].length); }
    if (/\*f\*|\(foil\)|\s+foil$/i.test(s)) { foil = true; s = s.replace(/\*f\*|\(foil\)|\s+foil$/gi, "").trim(); }
    const sn = s.match(/\s*[([]([a-z0-9]{2,6})[)\]]\s*([0-9a-z★-]+)?\s*$/i);
    if (sn) { set = sn[1].toLowerCase(); number = sn[2]; s = s.slice(0, sn.index).trim(); }
    return { raw, qty, name: s, set, number, foil };
  });
}

let last = 0;
async function paced(url: string, init?: RequestInit): Promise<Response> {
  const wait = last + 110 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  return fetch(url, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json" } });
}

async function match(lines: Line[]): Promise<Item[]> {
  const ids = lines.map((l) => (l.set && l.number ? { set: l.set, collector_number: l.number } : l.set ? { name: l.name, set: l.set } : { name: l.name }));
  const found: (Card | null)[] = [];
  for (let i = 0; i < ids.length; i += 75) {
    const chunk = ids.slice(i, i + 75);
    const r = await paced("https://api.scryfall.com/cards/collection", { method: "POST", body: JSON.stringify({ identifiers: chunk }) });
    const body = (await r.json()) as { data: Card[]; not_found: object[] };
    const missing = new Set(body.not_found.map((x) => JSON.stringify(x)));
    let k = 0;
    for (const id of chunk) found.push(missing.has(JSON.stringify(id)) ? null : body.data[k++]);
    // a name can be a token's too ("Ragavan", "Jace"): a token is never what a pasted line means
    found.forEach((c, j) => { if (c && notCard(c)) found[j] = null; });
  }
  const out: Item[] = [];
  for (const [i, line] of lines.entries()) {
    let card = found[i], status: Item["status"] = card ? "ok" : "unknown", options: string[] = [];
    if (card && line.number && !card.name.toLowerCase().startsWith(line.name.toLowerCase())) status = "guess";  // set + number is another card
    if (!card) {
      const r = await paced(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(line.name)}`);
      const fuzzy = r.ok ? ((await r.json()) as Card) : null;
      if (fuzzy && !notCard(fuzzy)) { card = fuzzy; status = "guess"; }
      else {
        const a = await paced(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(line.name)}`);
        options = a.ok ? ((await a.json()) as { data: string[] }).data.slice(0, 6) : [];
      }
    }
    out.push(fresh(i, line, card, status, options));
  }
  return out;
}

function fresh(id: number, line: Line, card: Card | null, status: Item["status"], options: string[] = []): Item {
  return { id, line, status, card, options, prints: null, chosen: !!line.number, qty: line.qty, lang: USUAL.lang, cond: USUAL.cond, finish: "", price: "",
    target: "", deal: "", lists: [], zero: false, date: "" };
}

const notCard = (c: Card) => /token|emblem|art_series/.test(c.layout ?? "") || ["token", "memorabilia"].includes(c.set_type ?? "");
const NOT_REGULAR_SETS = new Set(["plst", "mb1", "mb2", "fmb1"]);  // The List and Mystery Boosters: reprints with odd frames or stamps
const plain = (c: Card) => !c.promo && !preview(c).tags.length && c.set !== "plst";
const isRegular = (c: Card) => plain(c) && (MAIN_SETS.has(c.set_type ?? "") || SIDE_SETS.has(c.set_type ?? ""));
/** Newest plain printing from a main set, else from a Commander or starter set, else the newest. */
const newestRegular = (ps: Card[]) => ps.find((c) => plain(c) && c.booster && !NOT_REGULAR_SETS.has(c.set) && MAIN_SETS.has(c.set_type ?? ""))
  ?? ps.find((c) => isRegular(c) && !NOT_REGULAR_SETS.has(c.set)) ?? ps[0];
const img = (c: Card | null, size: "small" | "normal") => (c ? c.image_uris?.[size] ?? c.card_faces?.[0]?.image_uris?.[size] ?? null : null);
const finishes = (c: Card | null) => (c?.finishes.length ? c.finishes : ["nonfoil", "foil"]);
function defaultFinish(target: Target, it: Item, c: Card | null): string {
  const f = finishes(c);
  if (target === "wants") return it.line.foil ? "foil" : "any";
  if (it.line.foil && f.includes("foil")) return "foil";
  return f.includes("nonfoil") ? "nonfoil" : f[0];
}
const finishName = (f: string) => ({ any: "Any finish", nonfoil: "Non-foil", foil: "Foil", etched: "Etched" })[f] ?? f;
const priceOf = (c: Card, foil: boolean) => (foil ? c.prices?.eur_foil : c.prices?.eur) ?? c.prices?.eur ?? c.prices?.eur_foil;

// ---- shared pieces ------------------------------------------------------------------------------
type Upd = (id: number, p: Partial<Item>) => void;

/** Want-list language: one, several ("en,it" = English or Italian), or any. A copy in any of them counts. */
const langText = (v: string) => (!v ? "Mixed" : v === "any" ? "Any language" : v.split(",").map(langName).join(" or "));
function LangPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const on = value && value !== "any" ? value.split(",") : [];
  const flip = (l: string) => { const next = on.includes(l) ? on.filter((x) => x !== l) : [...on, l]; onChange(next.length ? LANGS.filter((x) => next.includes(x)).join(",") : "any"); };
  return (
    <Pop label="Languages" text={langText(value)}>
      <Opt on={value === "en,it"} onPick={() => onChange("en,it")} close>English or Italian</Opt>
      <Opt on={value === "any"} onPick={() => onChange("any")} close>Any language</Opt>
      <hr />
      {LANGS.map((l) => <Opt on={on.includes(l)} onPick={() => flip(l)} multi>{langName(l)}</Opt>)}
    </Pop>
  );
}

// a tap outside an open list closes it
document.addEventListener("pointerdown", (e) => {
  const inside = (e.target as Element).closest?.(".pl-pop");
  document.querySelectorAll<HTMLDetailsElement>(".pl-pop[open]").forEach((d) => d !== inside && (d.open = false));
});

/** One look for every list that opens from a pill (set, language): our own panel, not the browser's. */
function Pop({ label, text, children }: { label: string; text: string; children: preact.ComponentChildren }) {
  return (
    <details class="pl-pop" onToggle={(e) => { const me = e.currentTarget as HTMLDetailsElement; if (me.open) document.querySelectorAll<HTMLDetailsElement>(".pl-pop[open]").forEach((d) => d !== me && (d.open = false)); }}>
      <summary class="select" aria-label={label}><span>{text}</span></summary>
      <div class="pl-pop-list" role="listbox" aria-label={label} aria-multiselectable="true">{children}</div>
    </details>
  );
}
function Opt({ on, onPick, close, multi, children, note }: { on: boolean; onPick: () => void; close?: boolean; multi?: boolean; children: preact.ComponentChildren; note?: string }) {
  return (
    <button type="button" class={`pl-opt${multi ? " multi" : ""}`} role="option" aria-selected={on}
      onClick={(e) => { onPick(); if (close) (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>
      <span class="pl-opt-mark" aria-hidden="true">{on && <svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>}</span>
      <span>{children}</span>{note && <small>{note}</small>}
    </button>
  );
}

/** Every printing, with filters by set and treatment; the newest regular one is marked. */
function VersionStrip({ it, upd, target }: { it: Item; upd: Upd; target: Target }) {
  const [treat, setTreat] = useState("all");
  const [set, setSet] = useState("all");
  const all = it.prints ?? (it.card ? [it.card] : []);
  const tagsOf = (c: Card) => (isRegular(c) ? ["regular"] : preview(c).tags.length ? preview(c).tags : ["promo"]);
  const treatments = [...new Set(all.flatMap(tagsOf))].sort((a, b) => Number(b === "regular") - Number(a === "regular"));
  const sets = [...new Map(all.map((c) => [c.set, c.set_name])).entries()];
  // the picked version first, then the rest newest first
  const shown = [...all.filter((c) => c.id === it.card?.id), ...all.filter((c) => c.id !== it.card?.id)].filter((c) => (treat === "all" || tagsOf(c).includes(treat)) && (set === "all" || c.set === set));
  const newest = it.prints ? newestRegular(it.prints) : null;
  return (
    <div class="pl-versions">
      <div class="pl-vfilters">
        <div class="seg" role="group" aria-label="Treatment">
          {["all", ...treatments].map((t) => <button type="button" aria-pressed={treat === t} onClick={() => setTreat(t)}>{t === "all" ? `All ${all.length}` : t}</button>)}
        </div>
        {sets.length > 1 && (
          <Pop label="Set" text={set === "all" ? "Every set" : sets.find(([c]) => c === set)?.[1] ?? set}>
            <Opt on={set === "all"} onPick={() => setSet("all")} close note={String(all.length)}>Every set</Opt>
            <hr />
            {sets.map(([code, name]) => <Opt on={set === code} onPick={() => setSet(code)} close note={String(all.filter((c) => c.set === code).length)}>{name}</Opt>)}
          </Pop>
        )}
      </div>
      <div class="versions" role="radiogroup" aria-label="Version">
        {shown.map((c) => {
          const p = priceOf(c, it.finish === "foil" || it.finish === "etched");
          return (
            <button type="button" class="version" role="radio" aria-checked={it.card?.id === c.id}
              onClick={() => upd(it.id, { card: c, chosen: true, finish: finishes(c).includes(it.finish) || it.finish === "any" ? it.finish : defaultFinish(target, it, c) })}>
              <CardImage src={img(c, "small")} alt="" foil={false} eager />
              <b>{c.set.toUpperCase()} {c.collector_number}</b>
              <small>{c === newest ? "Newest regular" : versionText(preview(c)) || c.set_name}{p ? ` · €${p}` : ""}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span class="stepper">
      <button type="button" class="icon-btn" disabled={value <= 1} onClick={() => onChange(value - 1)} aria-label="One fewer"><IconMinus /></button>
      <b>{value}</b>
      <button type="button" class="icon-btn" onClick={() => onChange(value + 1)} aria-label="One more"><IconPlus /></button>
    </span>
  );
}

/** A segmented control; with mixed values (several cards) no option is pressed. */
function Seg({ label, value, options, onPick }: { label: string; value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => <button type="button" aria-pressed={value === v} onClick={() => onPick(v)}>{l}</button>)}
    </div>
  );
}

const sameOf = (items: Item[], k: "lang" | "cond" | "finish" | "deal" | "target" | "date") => (items.every((x) => x[k] === items[0]?.[k]) ? items[0]?.[k] ?? "" : "");
const same2 = (items: Item[], k: "lists") => (items.every((x) => x[k].join() === items[0]?.[k].join()) ? items[0]?.[k] ?? [] : []);

/** The settings of one card, or of several at once (`bulk`): seen options, not dropdowns, then More settings folded. */
function SettingsForm({ items, apply, change, target, bulk, share }: {
  items: Item[]; apply: (p: Partial<Item>) => void; change: (f: (x: Item) => Partial<Item>) => void; target: Target; bulk?: boolean; share?: number;
}) {
  const it = items[0];
  const wants = target === "wants";
  const fins = bulk ? (wants ? ["any", "nonfoil", "foil"] : ["nonfoil", "foil"]) : [...(wants ? ["any"] : []), ...finishes(it.card)];
  const extraCount = wants ? [sameOf(items, "target"), sameOf(items, "deal"), !bulk && same2(items, "lists").length, items.every((x) => x.zero)].filter(Boolean).length : [sameOf(items, "date")].filter(Boolean).length;
  return (
    <div class="pl-form">
      <div class="pl-form-grid">
        {wants && bulk && <div class="pl-f wide"><span>Add to list</span><ListPick items={items} change={change} /></div>}
        {!bulk && <div class="pl-f"><span>Copies</span><Stepper value={it.qty} onChange={(qty) => apply({ qty })} /></div>}
        <div class="pl-f"><span>Language</span>
          {wants ? <LangPick value={sameOf(items, "lang")} onChange={(lang) => apply({ lang })} /> : (
            <Pop label="Language" text={sameOf(items, "lang") ? langName(sameOf(items, "lang")) : "Mixed"}>
              {LANGS.map((l) => <Opt on={sameOf(items, "lang") === l} onPick={() => apply({ lang: l })} close>{langName(l)}</Opt>)}
            </Pop>
          )}
        </div>
        <div class="pl-f"><span>{wants ? "Worst condition" : "Condition"}</span>
          <Seg label="Condition" value={sameOf(items, "cond")} onPick={(cond) => apply({ cond })} options={CONDS.map((c) => [c, c])} />
        </div>
        <div class="pl-f"><span>Finish</span>
          <Seg label="Finish" value={sameOf(items, "finish")} onPick={(finish) => apply({ finish })} options={fins.map((f) => [f, f === "any" ? "Any" : finishName(f)])} />
        </div>
        {!wants && !bulk && (
          <div class="pl-f"><span>Price paid, each</span>
            <span class="money"><span>€</span><input inputMode="decimal" placeholder={share ? share.toFixed(2) : "optional"} value={it.price} onInput={(e) => apply({ price: (e.target as HTMLInputElement).value })} /></span>
          </div>
        )}
      </div>
      <details class="pl-more" open={extraCount > 0}>
        <summary>More settings{extraCount > 0 && <small>{extraCount} set</small>}</summary>
        <div class="pl-form-grid">
          {wants ? <>
            <div class="pl-f"><span>Target price</span>
              <span class="money"><span>€</span><input inputMode="decimal" placeholder="none" value={sameOf(items, "target")} onInput={(e) => apply({ target: (e.target as HTMLInputElement).value })} /></span>
            </div>
            <div class="pl-f"><span>Deal from</span>
              <span class="money"><input inputMode="numeric" placeholder="20" value={sameOf(items, "deal")} onInput={(e) => apply({ deal: (e.target as HTMLInputElement).value })} /><span>% under</span></span>
            </div>
            <label class="pl-f pl-switch"><span>CardTrader Zero only</span>
              <input type="checkbox" class="switch" checked={items.every((x) => x.zero)} onChange={(e) => apply({ zero: (e.target as HTMLInputElement).checked })} />
            </label>
            {!bulk && <div class="pl-f wide"><span>Lists</span><ListPick items={items} change={change} /></div>}
          </> : (
            <div class="pl-f"><span>Date bought</span>
              <span class="money text-in"><input type="date" value={sameOf(items, "date")} onInput={(e) => apply({ date: (e.target as HTMLInputElement).value })} /></span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

/** A row's settings as one line; values that differ from the defaults stand out. */
function settingsLine(it: Item, target: Target): { text: string; on: boolean }[] {
  const wants = target === "wants";
  const parts = [
    { text: wants ? langText(it.lang) : langName(it.lang), on: it.lang !== USUAL.lang },
    { text: wants ? `${it.cond} or better` : it.cond, on: it.cond !== USUAL.cond },
    { text: finishName(it.finish), on: it.finish !== (wants ? "any" : "nonfoil") },
  ];
  const extra = wants ? [it.target && `target €${it.target}`, it.deal && `deal from ${it.deal}%`, ...it.lists, it.zero && "Zero only"] : [it.date];
  return [...parts, ...extra.filter(Boolean).map((t) => ({ text: t as string, on: true }))];
}

/** The cards as one list. A row reads; tapping it opens its versions and settings. Ticked rows change together. */
function PickTable({ items, upd, target, setAll, each, lot, setLot, spread, deck }: PickProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const picked = items.filter((x) => sel.includes(x.id));
  const flip = (id: number) => setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const go = (id: number | null) => {
    setOpen(id);
    if (id !== null) requestAnimationFrame(() => document.getElementById(`pl-row-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  return (
    <div class="pl-table">
      <div class={`pl-top${picked.length ? " active" : ""}`}>
        <div class="pl-toolbar">
          <label class="pl-all">
            <input type="checkbox" class="pl-check-box" checked={picked.length === items.length} ref={(el) => { if (el) el.indeterminate = picked.length > 0 && picked.length < items.length; }}
              onChange={() => setSel(picked.length === items.length ? [] : items.map((x) => x.id))} aria-label="Select every card" />
            <span>{picked.length ? `${picked.length} of ${items.length} selected` : "Select all"}</span>
          </label>
          {picked.length ? (
            <span class="pl-toolbar-acts">
              <button type="button" class="pl-text-btn" onClick={() => setSel([])}>Clear</button>
              <button type="button" class="btn sm" onClick={() => { setAll({ status: "dropped" }, sel); setSel([]); setOpen(null); }}>Leave out</button>
            </span>
          ) : <span class="pl-hint">Tick cards to set them together</span>}
        </div>
        {picked.length > 0 && (
          <div class="pl-bulk-panel">
            <SettingsForm items={picked} apply={(p) => setAll(p, sel)} change={(f) => each(f, sel)} target={target} bulk />
          </div>
        )}
      </div>
      {target === "collection" && !deck && !picked.length && (
        <label class="pl-lotline">Paid one price for all of these?
          <span class="money"><span>€</span><input inputMode="decimal" placeholder="optional" value={lot} onInput={(e) => setLot((e.target as HTMLInputElement).value)} /></span>
          <small>Shared out by Cardmarket price; a price typed on a card wins.</small>
        </label>
      )}
      <div class="pl-list">
        {items.map((it, i) => {
          const share = spread.get(it.id);
          return (
            <div class={`pl-row${open === it.id ? " open" : ""}${sel.includes(it.id) ? " picked" : ""}`} id={`pl-row-${it.id}`}>
              <div class="pl-row-line">
                <input type="checkbox" class="pl-check-box" checked={sel.includes(it.id)} onChange={() => flip(it.id)} aria-label={`Select ${it.card?.name}`} />
                <button type="button" class="pl-row-main" aria-expanded={open === it.id} onClick={() => go(open === it.id ? null : it.id)}>
                  <CardImage src={img(it.card, "small")} alt="" foil={it.finish === "foil"} />
                  <span class="pl-row-text">
                    <b class="pl-row-name">{it.card?.name}</b>
                    <span class="pl-row-ver">{it.card?.set.toUpperCase()} {it.card?.collector_number} · {it.card?.set_name}</span>
                    <span class="pl-row-set">{settingsLine(it, target).map((p) => <span class={p.on ? "on" : ""}>{p.text}</span>)}</span>
                  </span>
                  <span class="pl-row-fig">
                    <b class={it.qty > 1 ? "" : "one"}>{it.qty}×</b>
                    {target === "collection" && <small>{it.price ? `€${it.price}` : share ? `≈ €${share.toFixed(2)}` : "no price"}</small>}
                  </span>
                  <svg class="pl-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </button>
              </div>
              {open === it.id && (
                <div class="pl-editor">
                  <VersionStrip it={it} upd={upd} target={target} />
                  <SettingsForm items={[it]} apply={(p) => upd(it.id, p)} change={(f) => upd(it.id, f(it))} target={target} share={share} />
                  <div class="pl-editor-foot">
                    <button class="btn sm" type="button" onClick={() => go(null)}>Done</button>
                    {i < items.length - 1 && <button class="btn sm primary" type="button" onClick={() => go(items[i + 1].id)}>Next card</button>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The lists on the want-list, as chips, plus a new one. For several cards a tap puts all of them on the list,
 *  or takes all of them off when every one is already on it; a list some of them are on shows as partly on. */
function ListPick({ items, change }: { items: Item[]; change: (f: (x: Item) => Partial<Item>) => void }) {
  const known = [...new Set([...(peek<WantsDoc>("wants")?.wishes ?? []).flatMap((w) => w.lists), ...items.flatMap((x) => x.lists)])].sort();
  const toggle = (l: string) => {
    const all = items.every((x) => x.lists.includes(l));
    change((x) => ({ lists: all ? x.lists.filter((y) => y !== l) : x.lists.includes(l) ? x.lists : [...x.lists, l] }));
  };
  return (
    <span class="chips">
      {known.map((l) => {
        const n = items.filter((x) => x.lists.includes(l)).length;
        return <button type="button" class="chip toggle" aria-pressed={n === items.length ? "true" : n ? "mixed" : "false"} onClick={() => toggle(l)}>{l}{n > 0 && n < items.length && <small>{n}</small>}</button>;
      })}
      <input class="chip-input" placeholder="New list" onKeyDown={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (e.key === "Enter" && v) { e.preventDefault(); change((x) => ({ lists: x.lists.includes(v) ? x.lists : [...x.lists, v] })); (e.target as HTMLInputElement).value = ""; } }} />
    </span>
  );
}

/** The lot's price shared across cards without their own price, by Cardmarket price (each copy). */
function spreadLot(items: Item[], lot: string): Map<number, number> {
  const out = new Map<number, number>();
  const total = Number(lot.replace(",", "."));
  if (!(total > 0)) return out;
  const own = items.reduce((t, x) => t + (Number(x.price.replace(",", ".")) || 0) * x.qty, 0);
  const open = items.filter((x) => !x.price);
  const market = (x: Item) => Number(x.card ? priceOf(x.card, x.finish === "foil" || x.finish === "etched") : 0) || 0;
  const known = open.filter((x) => market(x) > 0);
  const avg = known.length ? known.reduce((t, x) => t + market(x), 0) / known.length : 1;
  const weight = (x: Item) => market(x) || avg;  // no Cardmarket price: counts as an average card
  const sum = open.reduce((t, x) => t + weight(x) * x.qty, 0);
  const left = Math.max(0, total - own);
  for (const x of open) out.set(x.id, sum ? (left * weight(x)) / sum : 0);
  return out;
}

interface PickProps { items: Item[]; upd: Upd; target: Target; setAll: (p: Partial<Item>, only?: number[]) => void; each: (f: (x: Item) => Partial<Item>, only?: number[]) => void; deck: boolean; lot: string; setLot: (v: string) => void; spread: Map<number, number> }

// ---- a precon deck (collection only): MTGJSON's deck lists name every card's exact printing ----
interface DeckRef { name: string; fileName: string; releaseDate: string; type: string; code: string }
let deckList: Promise<DeckRef[]> | null = null;
const decks = () => (deckList ??= fetch("https://mtgjson.com/api/v5/DeckList.json").then((r) => r.json())
  .then((b: { data: DeckRef[] }) => b.data.filter((d) => /commander/i.test(d.type)).sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))));
interface DeckCard { name: string; setCode: string; number: string; count: number; isFoil?: boolean; identifiers: { scryfallId?: string } }

async function deckItems(d: DeckRef): Promise<Item[]> {
  const body = (await (await fetch(`https://mtgjson.com/api/v5/decks/${d.fileName}.json`)).json()) as { data: Record<string, DeckCard[]> };
  const cards = [...body.data.commander ?? [], ...body.data.mainBoard ?? [], ...body.data.sideBoard ?? []].filter((c) => c.identifiers.scryfallId);
  const found = new Map<string, Card>();
  for (let i = 0; i < cards.length; i += 75) {
    const r = await paced("https://api.scryfall.com/cards/collection", { method: "POST", body: JSON.stringify({ identifiers: cards.slice(i, i + 75).map((c) => ({ id: c.identifiers.scryfallId })) }) });
    for (const c of ((await r.json()) as { data: Card[] }).data) found.set(c.id, c);
  }
  return cards.map((c, i) => {
    const card = found.get(c.identifiers.scryfallId!) ?? null;
    const line: Line = { raw: `${c.count} ${c.name} (${c.setCode}) ${c.number}`, qty: c.count, name: c.name, set: c.setCode.toLowerCase(), number: c.number, foil: !!c.isFoil };
    const it = fresh(i, line, card, card ? "ok" : "dropped");
    return { ...it, finish: c.isFoil ? "foil" : defaultFinish("collection", it, card) };
  });
}

function DeckPick({ onPick }: { onPick: (d: DeckRef) => void }) {
  const [all, setAll] = useState<DeckRef[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { decks().then(setAll); }, []);
  const shown = (all ?? []).filter((d) => `${d.name} ${d.code}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <div class="pl-paste">
      <p>Every card of the deck comes in at its exact version, foils included. You can still change anything before adding.</p>
      <input class="pl-search" type="search" placeholder="Deck name or set, e.g. Klingon, Eldrazi, PIP" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} autofocus />
      <div class="pl-decks">
        {all === null ? <p>Loading the decks…</p> : shown.map((d) => (
          <button type="button" class="pl-deck" onClick={() => onPick(d)}>
            <b>{d.name}</b><small>{d.code} · {d.releaseDate.slice(0, 4)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- the flow -----------------------------------------------------------------------------------
function Flow({ target, onClose }: { target: Target; onClose: () => void }) {
  const [step, setStep] = useState<"paste" | "check" | "pick" | "done">("paste");
  const [text, setText] = useState(() => (new URLSearchParams(location.search).has("example") ? EXAMPLE : ""));
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [lot, setLot] = useState("");
  const [mode, setMode] = useState<"list" | "deck">("list");
  const [deck, setDeck] = useState<DeckRef | null>(null);
  const pickDeck = async (d: DeckRef) => {
    setBusy(true); setDeck(d);
    setItems(await deckItems(d).catch(() => []));
    setBusy(false); setStep("pick");
  };
  const upd: Upd = (id, p) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const live = items.filter((x) => x.status !== "dropped" && x.card);
  const unclear = items.filter((x) => x.status === "guess" || x.status === "unknown");
  const where = target === "wants" ? "want-list" : "collection";

  // fetch every card's printings in the background; until then the matched printing shows
  useEffect(() => {
    if (step !== "check" && step !== "pick") return;
    const todo = items.filter((x) => x.card && !x.prints && x.status !== "dropped");
    if (!todo.length) return;
    let stop = false;
    (async () => {
      for (const it of todo) {
        if (stop) return;
        const uri = it.card!.prints_search_uri;
        const ps = (uri ? await printings(uri).catch(() => []) : []) as Card[];
        await new Promise((r) => setTimeout(r, 100));
        setItems((xs) => xs.map((x) => {
          if (x.id !== it.id) return x;
          const card = x.chosen ? x.card : newestRegular(ps) ?? x.card;
          return { ...x, prints: ps, card, finish: x.finish || defaultFinish(target, x, card) };
        }));
      }
    })();
    return () => { stop = true; };
  }, [step, items.map((x) => `${x.id}:${x.card?.name}:${!!x.prints}`).join()]);

  const find = async () => {
    setBusy(true);
    const out = await match(parse(text)).catch(() => []);
    setItems(out.map((x) => ({ ...x, finish: defaultFinish(target, x, x.card) })));
    setBusy(false);
    setStep("check");
  };
  const rename = async (it: Item, name: string) => {
    const r = await paced(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
    if (r.ok) { const card = (await r.json()) as Card; upd(it.id, { card, status: "ok", prints: null, finish: defaultFinish(target, it, card) }); }
  };
  const each = (f: (x: Item) => Partial<Item>, only?: number[]) => setItems((xs) => xs.map((x) => (only && !only.includes(x.id) ? x : { ...x, ...f(x) })));
  const another = async (it: Item) => {
    const a = await paced(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(it.line.name)}`);
    upd(it.id, { status: "unknown", card: null, options: a.ok ? ((await a.json()) as { data: string[] }).data.filter((n) => n !== it.card?.name).slice(0, 6) : [] });
  };
  const setAll = (p: Partial<Item>, only?: number[]) => setItems((xs) => xs.map((x) => {
    if (only && !only.includes(x.id)) return x;
    if (p.finish && p.finish !== "any" && !finishes(x.card).includes(p.finish)) return x;  // a finish the card doesn't have is skipped
    return { ...x, ...p };
  }));
  const spread = useMemo(() => spreadLot(live, lot), [live, lot]);
  const total = live.reduce((t, x) => t + x.qty, 0);

  return (
    <div class="pl" role="dialog" aria-modal="true" aria-label={`Paste a list into your ${where}`}>
      <header class="pl-head">
        <div>
          <h2>{target === "collection" ? "Add cards" : "Paste a list"}</h2>
          <ol class="pl-steps">
            {[["paste", "Paste"], ["check", "Check names"], ["pick", "Versions and settings"], ["done", "Added"]].map(([k, l]) => <li aria-current={step === k ? "step" : undefined}>{l}</li>)}
          </ol>
        </div>
        <span class="pl-into">into your {where}</span>
        <button class="icon-btn" type="button" onClick={onClose} aria-label="Close"><IconClose /></button>
      </header>

      <div class="pl-body">
        {step === "paste" && target === "collection" && (
          <div class="seg pl-mode" role="group" aria-label="What to add">
            <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>A list of cards</button>
            <button type="button" aria-pressed={mode === "deck"} onClick={() => setMode("deck")}>A precon deck</button>
          </div>
        )}
        {step === "paste" && mode === "deck" && (busy ? <p class="pl-ok">Getting {deck?.name}…</p> : <DeckPick onPick={pickDeck} />)}
        {step === "paste" && mode === "list" && (
          <div class="pl-paste">
            <p>One card per line, as written in a chat or exported from another app. Numbers in front are copies; a set and number in brackets pick that exact version.</p>
            <textarea rows={14} value={text} placeholder={"4 Lightning Bolt\n1x Sol Ring (CMR) 472\nCounterspell"} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} autofocus />
            <div class="pl-row-btns">
              <button class="btn sm" type="button" onClick={() => setText(EXAMPLE)}>Try an example</button>
              <small>{parse(text).length} lines</small>
            </div>
          </div>
        )}

        {step === "check" && (
          <div class="pl-check">
            <p class="pl-ok"><b>{items.filter((x) => x.status === "ok").length} found.</b> {unclear.length ? `${unclear.length} need a look:` : "Every line was clear."}</p>
            {unclear.map((it) => (
              <div class={`pl-unclear ${it.status}`}>
                <code>{it.line.raw}</code>
                {it.status === "guess" ? (
                  <div class="pl-guess">
                    <CardImage src={img(it.card, "small")} alt="" foil={false} />
                    <span>Did you mean <b>{it.card?.name}</b>?</span>
                    <button class="btn sm primary" type="button" onClick={() => upd(it.id, { status: "ok" })}>Yes</button>
                    <button class="btn sm" type="button" onClick={() => another(it)}>No, another</button>
                    <button class="btn sm" type="button" onClick={() => upd(it.id, { status: "dropped" })}>Leave out</button>
                  </div>
                ) : (
                  <div class="pl-guess">
                    <span>Not recognised.</span>
                    {it.options.map((o) => <button class="chip toggle" type="button" onClick={() => rename(it, o)}>{o}</button>)}
                    <input class="chip-input" placeholder="Type the name" onKeyDown={(e) => e.key === "Enter" && rename(it, (e.target as HTMLInputElement).value)} />
                    <button class="btn sm" type="button" onClick={() => upd(it.id, { status: "dropped" })}>Leave out</button>
                  </div>
                )}
              </div>
            ))}
            {items.some((x) => x.status === "dropped") && <p class="pl-left">Left out: {items.filter((x) => x.status === "dropped").map((x) => x.line.raw).join(", ")}</p>}
            <div class="pl-found">
              {items.filter((x) => x.status === "ok").map((x) => <span title={x.line.raw}><CardImage src={img(x.card, "small")} alt={x.card?.name ?? ""} foil={false} /></span>)}
            </div>
          </div>
        )}

        {step === "pick" && deck && (
          <div class="pl-deckhead">
            <div><b>{deck.name}</b><small>{total} cards · exact versions from the deck list</small></div>
            <label>What did you pay for the deck? <span class="money"><span>€</span><input inputMode="decimal" placeholder="optional" value={lot} onInput={(e) => setLot((e.target as HTMLInputElement).value)} /></span></label>
            <small>{lot ? "Shared out across the cards by Cardmarket price; each card shows its share." : "Leave it empty to price cards later."}</small>
          </div>
        )}
        {step === "pick" && <PickTable items={live} upd={upd} target={target} setAll={setAll} each={each} deck={!!deck} lot={lot} setLot={setLot} spread={spread} />}

        {step === "done" && (
          <div class="pl-done">
            <h3>{total} cards added to your {where}</h3>
            <p>Prototype: nothing was saved. This is what would be sent, one edit per line:</p>
            <pre>{live.map((x) => target === "wants"
              ? `add   ${x.card?.set.toUpperCase()} ${x.card?.collector_number}  ${x.card?.name}  copies ${x.qty} · ${langText(x.lang)} · ${x.cond} or better · foil ${x.finish}${x.target ? ` · target €${x.target}` : ""} · deal from ${x.deal || 20}%${x.lists.length ? ` · lists ${x.lists.join("; ")}` : ""}${x.zero ? " · Zero only" : ""}`
              : `owned ${x.card?.set.toUpperCase()} ${x.card?.collector_number}  ${x.card?.name}  ×${x.qty} · ${x.lang} · ${x.cond} · ${x.finish}${x.price ? ` · paid €${x.price} each` : spread.has(x.id) ? ` · paid €${spread.get(x.id)!.toFixed(2)} each (share of the lot)` : " · no price"}${x.date ? ` · ${x.date}` : ""}`).join("\n")}</pre>
          </div>
        )}
      </div>

      <footer class="pl-foot">
        {step === "paste" && mode === "list" && <button class="btn primary" type="button" disabled={busy || !parse(text).length} onClick={find}>{busy ? "Finding cards…" : "Find cards"}</button>}
        {step === "check" && <>
          <button class="btn" type="button" onClick={() => setStep("paste")}>Back to the list</button>
          <button class="btn primary" type="button" disabled={unclear.length > 0} onClick={() => setStep("pick")}>{unclear.length ? `${unclear.length} left to check` : `Next: versions for ${live.length} cards`}</button>
        </>}
        {step === "pick" && <>
          <button class="btn" type="button" onClick={() => setStep(deck ? "paste" : "check")}>Back</button>
          <button class="btn primary" type="button" onClick={() => setStep("done")}>Add {total} {total === 1 ? "card" : "cards"} to {target === "wants" ? "the want-list" : "the collection"}</button>
        </>}
        {step === "done" && <button class="btn primary" type="button" onClick={onClose}>Done</button>}
      </footer>
    </div>
  );
}

/** The "Paste a list" button for a page header; opens the flow over the page. */
export function PasteButton({ to }: { to: Target }) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get("paste") === to);
  const key = useMemo(() => Math.random(), [open]);
  return (
    <>
      <button class="btn sm" type="button" onClick={() => setOpen(true)}>{to === "collection" ? "Add a list or deck" : "Paste a list"}</button>
      {open && createPortal(<Flow key={key} target={to} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
