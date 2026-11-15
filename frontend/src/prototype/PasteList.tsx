// PROTOTYPE, throwaway (mtg-intel-docs issue 6): Want-list › Add cards and Collection › Add cards, a page of the
// app. Search, paste a list, import a file or pick a precon deck; every card lands in one list (lines that need a
// look on top), each with its version and settings, edited inline or in the app's side pane; one Add at the end.
// Earlier rounds (a full-screen flow, variants B one-by-one and C wall of cards) are in this branch's history. Cards and pictures are real (Scryfall); nothing is saved: the last screen
// shows what would be sent. Local copy only. Never merge to main.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { peek } from "../api";
import type { WantsDoc } from "../types";
import { CardImage } from "../ui/CardImage";
import { IconBack, IconChart, IconClose, IconMinus, IconPlus, IconSearch } from "../ui/icons";
import { BigCard } from "../ui/CardImage";
import { ManaCost, SetSymbol } from "../ui/symbols";
import { fieldStyle } from "../drop";
import { link } from "../router";
import { Confirm } from "../ui/Confirm";
import { preview, printings, type ScryCard } from "../scry";
import { condName, langName, versionText } from "../format";
import "./paste.css";

type Target = "wants" | "collection";
type Card = ScryCard & { oracle_id?: string; promo?: boolean; layout?: string; booster?: boolean; prices?: { eur?: string | null; eur_foil?: string | null } };
interface Line { raw: string; qty: number; name: string; set?: string; number?: string; foil?: boolean; id?: string; cond?: string; lang?: string }
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
  const ids = lines.map((l) => (l.id ? { id: l.id } : l.set && l.number ? { set: l.set, collector_number: l.number } : l.set ? { name: l.name, set: l.set } : { name: l.name }));
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
    if (card && line.number && !line.id && !card.name.toLowerCase().startsWith(line.name.toLowerCase())) status = "guess";  // set + number is another card
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
  return { id, line, status, card, options, prints: null, chosen: !!(line.number || line.id), qty: line.qty,
    lang: line.lang && LANGS.includes(line.lang) ? line.lang : USUAL.lang, cond: line.cond ?? USUAL.cond, finish: "", price: "",
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
const langText = (v: string) => (!v ? "Language: mixed" : v === "any" ? "Any language" : v.split(",").map(langName).join(" or "));
function LangPick({ value, onChange, ghost }: { value: string; onChange: (v: string) => void; ghost?: boolean }) {
  const on = value && value !== "any" ? value.split(",") : [];
  const flip = (l: string) => { const next = on.includes(l) ? on.filter((x) => x !== l) : [...on, l]; onChange(next.length ? LANGS.filter((x) => next.includes(x)).join(",") : "any"); };
  return (
    <Pop label="Language" text={langText(value)} ghost={ghost} on={value !== USUAL.lang}>
      <Opt on={value === "en,it"} onPick={() => onChange("en,it")} close>English or Italian</Opt>
      <Opt on={value === "any"} onPick={() => onChange("any")} close>Any language</Opt>
      <hr />
      {LANGS.map((l) => <Opt on={on.includes(l)} onPick={() => flip(l)} multi>{langName(l)}</Opt>)}
    </Pop>
  );
}
/** Collection language: a copy is in exactly one. */
function LangOne({ value, onChange, ghost }: { value: string; onChange: (v: string) => void; ghost?: boolean }) {
  return (
    <Pop label="Language" text={value ? langName(value) : "Language: mixed"} ghost={ghost} on={value !== USUAL.lang}>
      {LANGS.map((l) => <Opt on={value === l} onPick={() => onChange(l)} close>{langName(l)}</Opt>)}
    </Pop>
  );
}
function CondPop({ value, onChange, target, ghost }: { value: string; onChange: (v: string) => void; target: Target; ghost?: boolean }) {
  const wants = target === "wants";
  return (
    <Pop label={wants ? "Worst condition" : "Condition"} text={value ? (wants ? `${value} or better` : value) : "Condition: mixed"} ghost={ghost} on={value !== USUAL.cond}>
      {CONDS.map((c) => <Opt on={value === c} onPick={() => onChange(c)} close note={condName(c)}>{wants ? `${c} or better` : c}</Opt>)}
    </Pop>
  );
}
function FinishPop({ value, onChange, fins, target, ghost }: { value: string; onChange: (v: string) => void; fins: string[]; target: Target; ghost?: boolean }) {
  return (
    <Pop label="Finish" text={value ? finishName(value) : "Finish: mixed"} ghost={ghost} on={value !== (target === "wants" ? "any" : "nonfoil")}>
      {fins.map((f) => <Opt on={value === f} onPick={() => onChange(f)} close>{finishName(f)}</Opt>)}
    </Pop>
  );
}
/** How many copies: a quick grid, or any other number. */
function QtyPop({ value, onChange, ghost }: { value: number; onChange: (n: number) => void; ghost?: boolean }) {
  return (
    <Pop label="Copies" text={`${value}×`} ghost={ghost} on={value > 1} narrow>
      <div class="pl-qty-grid">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
          <button type="button" class="pl-qty" aria-pressed={n === value} onClick={(e) => { onChange(n); closePop(e); }}>{n}</button>
        ))}
      </div>
      <label class="pl-pop-field"><span>Other</span>
        <input inputMode="numeric" value={value} onInput={(e) => { const n = Number((e.target as HTMLInputElement).value); if (n >= 1) onChange(Math.floor(n)); }} />
      </label>
    </Pop>
  );
}
/** The want-list's lists: tick any, or create one. For several cards a list some of them are on shows as partly on;
 *  ticking it puts all of them on it, unticking takes all of them off. */
function ListPop({ items, change, bulk, ghost }: { items: Item[]; change: Change; bulk?: boolean; ghost?: boolean }) {
  const [name, setName] = useState("");
  const known = [...new Set([...(peek<WantsDoc>("wants")?.wishes ?? []).flatMap((w) => w.lists), ...items.flatMap((x) => x.lists)])].sort();
  const all = (l: string) => items.every((x) => x.lists.includes(l));
  const toggle = (l: string) => { const off = all(l); change((x) => ({ lists: off ? x.lists.filter((y) => y !== l) : x.lists.includes(l) ? x.lists : [...x.lists, l] })); };
  const create = () => { const v = name.trim(); if (!v) return; change((x) => ({ lists: x.lists.includes(v) ? x.lists : [...x.lists, v] })); setName(""); };
  const mine = items.length === 1 ? items[0].lists : known.filter(all);
  return (
    <Pop label="Lists" text={bulk ? "Add to list" : mine.length ? mine.join(", ") : "No list"} on={!bulk && mine.length > 0} ghost={ghost}>
      {known.map((l) => {
        const n = items.filter((x) => x.lists.includes(l)).length;
        return <Opt on={n === items.length} partial={n > 0 && n < items.length} onPick={() => toggle(l)} multi note={n > 0 && n < items.length ? `${n} of ${items.length}` : undefined}>{l}</Opt>;
      })}
      {known.length > 0 && <hr />}
      <form class="pl-pop-create" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <input placeholder="New list" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="New list name" />
        <button type="submit" class="btn sm primary" disabled={!name.trim()}>Create</button>
      </form>
    </Pop>
  );
}

/** Open the list upwards when there isn't room for it below (the floating Add bar and the phone's tab bar count as taken). */
function flipIfNeeded(d: HTMLDetailsElement) {
  d.classList.remove("up");
  const list = d.querySelector<HTMLElement>(".pl-pop-list");
  if (!list) return;
  const box = d.getBoundingClientRect();
  const below = innerHeight - box.bottom - (innerWidth < 900 ? 170 : 96);
  if (list.offsetHeight > below && box.top - 80 > below) d.classList.add("up");
}
const closePop = (e: Event) => { ((e.currentTarget as Element).closest("details") as HTMLDetailsElement).open = false; };
// a tap outside an open list closes it
document.addEventListener("pointerdown", (e) => {
  const inside = (e.target as Element).closest?.(".pl-pop");
  document.querySelectorAll<HTMLDetailsElement>(".pl-pop[open]").forEach((d) => d !== inside && (d.open = false));
});

/** One look for every list that opens from a pill: our own panel, not the browser's. `ghost` = quiet, for rows. */
function Pop({ label, text, children, ghost, on, narrow }: { label: string; text: string; children: preact.ComponentChildren; ghost?: boolean; on?: boolean; narrow?: boolean }) {
  return (
    <details class={`pl-pop${narrow ? " narrow" : ""}`} onToggle={(e) => { const me = e.currentTarget as HTMLDetailsElement; if (me.open) { document.querySelectorAll<HTMLDetailsElement>(".pl-pop[open]").forEach((d) => d !== me && (d.open = false)); me.querySelector<HTMLInputElement>(".pl-pop-search")?.focus(); flipIfNeeded(me); } }}>
      <summary class={ghost ? `pl-ghost${on ? " on" : ""}` : `select${on ? " on" : ""}`} aria-label={`${label}: ${text}`}><span>{text}</span></summary>
      <div class="pl-pop-list" role="listbox" aria-label={label}>{children}</div>
    </details>
  );
}
function Opt({ on, partial, onPick, close, multi, children, note }: { on: boolean; partial?: boolean; onPick: () => void; close?: boolean; multi?: boolean; children: preact.ComponentChildren; note?: string }) {
  return (
    <button type="button" class={`pl-opt${multi ? " multi" : ""}${partial ? " partial" : ""}`} role="option" aria-selected={on}
      onClick={(e) => { onPick(); if (close) closePop(e); }}>
      <span class="pl-opt-mark" aria-hidden="true">
        {on && <svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>}
        {partial && <svg viewBox="0 0 16 16"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>}
      </span>
      <span>{children}</span>{note && <small>{note}</small>}
    </button>
  );
}

/** The sets a card was printed in, newest first, with a search. */
function SetPop({ sets, value, onPick, total }: { sets: { code: string; name: string; date: string; count: number }[]; value: string; onPick: (v: string) => void; total: number }) {
  const [q, setQ] = useState("");
  const t = q.trim().toLowerCase();
  const shown = sets.filter((s) => !t || s.name.toLowerCase().includes(t) || s.code.includes(t) || s.date.startsWith(t));
  return (
    <Pop label="Set" text={value === "all" ? "Every set" : sets.find((s) => s.code === value)?.name ?? value}>
      <input class="pl-pop-search" type="search" placeholder="Search sets or a year" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search sets" />
      {!t && <Opt on={value === "all"} onPick={() => onPick("all")} close note={String(total)}>Every set</Opt>}
      {!t && <hr />}
      {shown.map((s) => <Opt on={value === s.code} onPick={() => { onPick(s.code); setQ(""); }} close note={`${s.date.slice(0, 4)} · ${s.count}`}>{s.name}</Opt>)}
      {t && !shown.length && <p class="pl-cs-none">No set matches.</p>}
    </Pop>
  );
}

/** Every printing, with filters by set and treatment; the newest regular one is marked. */
function VersionStrip({ it, upd, target }: { it: Item; upd: Upd; target: Target }) {
  const [treat, setTreat] = useState("all");
  const [set, setSet] = useState("all");
  const all = it.prints ?? (it.card ? [it.card] : []);
  const tagsOf = (c: Card) => (isRegular(c) ? ["regular"] : preview(c).tags.length ? preview(c).tags : ["promo"]);
  const treatments = [...new Set(all.flatMap(tagsOf))].sort((a, b) => Number(b === "regular") - Number(a === "regular"));
  const bySet = new Map<string, { code: string; name: string; date: string; count: number }>();
  for (const c of all) {
    const s = bySet.get(c.set) ?? { code: c.set, name: c.set_name, date: "", count: 0 };
    s.count++; if ((c.released_at ?? "") > s.date) s.date = c.released_at ?? "";
    bySet.set(c.set, s);
  }
  const sets = [...bySet.values()].sort((a, b) => b.date.localeCompare(a.date));
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
          <SetPop sets={sets} value={set} onPick={setSet} total={all.length} />
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

type Change = (f: (x: Item) => Partial<Item>) => void;
const sameOf = (items: Item[], k: "lang" | "cond" | "finish" | "deal" | "target" | "date") => (items.every((x) => x[k] === items[0]?.[k]) ? items[0]?.[k] ?? "" : "");

/** The rarer settings: want-list target, deal level, Zero only (and lists, for one card); collection date. */
function MoreForm({ items, apply, change, target, bulk }: { items: Item[]; apply: (p: Partial<Item>) => void; change: Change; target: Target; bulk?: boolean }) {
  return (
    <div class="pl-more-form">
      {target === "wants" ? <>
        <div class="pl-f"><span>Target price</span>
          <span class="money"><span>€</span><input inputMode="decimal" placeholder="none" value={sameOf(items, "target")} onInput={(e) => apply({ target: (e.target as HTMLInputElement).value })} /></span>
        </div>
        <div class="pl-f"><span>Deal from</span>
          <span class="money"><input inputMode="numeric" placeholder="20" value={sameOf(items, "deal")} onInput={(e) => apply({ deal: (e.target as HTMLInputElement).value })} /><span>% under</span></span>
        </div>
        <label class="pl-f pl-switch"><span>CardTrader Zero only</span>
          <input type="checkbox" class="switch" checked={items.every((x) => x.zero)} onChange={(e) => apply({ zero: (e.target as HTMLInputElement).checked })} />
        </label>
      </> : (
        <div class="pl-f"><span>Date bought</span>
          <span class="money text-in"><input type="date" value={sameOf(items, "date")} onInput={(e) => apply({ date: (e.target as HTMLInputElement).value })} /></span>
        </div>
      )}
    </div>
  );
}

/** Copies, language, condition and finish (and price paid, collection) as quiet dropdowns on the row. */
function RowControls({ it, upd, target, share }: { it: Item; upd: Upd; target: Target; share?: number }) {
  const set = (p: Partial<Item>) => upd(it.id, p);
  return (
    <div class={`pl-row-ctrls${target === "collection" ? " money" : ""}`}>
      <QtyPop value={it.qty} onChange={(qty) => set({ qty })} ghost />
      {target === "wants" ? <LangPick value={it.lang} onChange={(lang) => set({ lang })} ghost /> : <LangOne value={it.lang} onChange={(lang) => set({ lang })} ghost />}
      <CondPop value={it.cond} onChange={(cond) => set({ cond })} target={target} ghost />
      <FinishPop value={it.finish} onChange={(finish) => set({ finish })} fins={[...(target === "wants" ? ["any"] : []), ...finishes(it.card)]} target={target} ghost />
      {target === "wants" && <ListPop items={[it]} change={(f) => upd(it.id, f(it))} ghost />}
      {target === "collection" && (
        <span class={`pl-ghost-money${it.price ? " on" : ""}`}><span>€</span>
          <input inputMode="decimal" placeholder={share ? share.toFixed(2) : "paid"} value={it.price} onInput={(e) => set({ price: (e.target as HTMLInputElement).value })} aria-label="Price paid each" />
        </span>
      )}
    </div>
  );
}

/** What a card has beyond its row's controls, as a short line. */
function extrasLine(it: Item, target: Target): string {
  return (target === "wants" ? [it.target && `target €${it.target}`, it.deal && `deal from ${it.deal}%`, it.zero && "Zero only"] : [it.date]).filter(Boolean).join(" · ");
}

/** The version line as the app writes it: treatment, set and number. */
const versionLine = (c: Card | null) => (c ? `${versionText(preview(c)) || "Regular"}, ${c.set.toUpperCase()} ${c.collector_number}` : "");

/** The cards to add, as the app's list: rows like the Want-list's, their main settings as quiet dropdowns on the right.
 *  Tapping a card opens it in the side pane. Ticked rows get one line of settings on top. */
function AddList({ ask, items, upd, target, setAll, each, lot, setLot, spread, deck, open, setOpen }: PickProps & { open: number | null; setOpen: (id: number | null) => void }) {
  const [sel, setSel] = useState<number[]>([]);
  const picked = items.filter((x) => sel.includes(x.id));
  const flip = (id: number) => setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const apply = (p: Partial<Item>) => setAll(p, sel);
  const change: Change = (f) => each(f, sel);
  const wants = target === "wants";
  return (
    <>
      {target === "collection" && !deck && (
        <label class="pl-lotline">Paid one price for all of these?
          <span class="money"><span>€</span><input inputMode="decimal" placeholder="optional" value={lot} onInput={(e) => setLot((e.target as HTMLInputElement).value)} /></span>
          <small>Shared out by Cardmarket price; a price typed on a card wins.</small>
        </label>
      )}
      {/* one grid for the head and every row: each settings column is as wide as its widest entry, all gaps equal */}
      <div class={`list add-list${wants ? "" : " money"}`}>
        <div class={`add-gridhead${picked.length ? " active" : ""}`}>
          <input type="checkbox" class="pl-check-box" checked={picked.length === items.length} ref={(el) => { if (el) el.indeterminate = picked.length > 0 && picked.length < items.length; }}
            onChange={() => setSel(picked.length === items.length ? [] : items.map((x) => x.id))} aria-label="Select every card" />
          <span class="add-gh-who">
            <b>{picked.length ? `${picked.length} selected` : "Select all"}</b>
            {picked.length > 0 && <>
              <Pop label="More settings" text="More settings" ghost><MoreForm items={picked} apply={apply} change={change} target={target} bulk /></Pop>
              <span class="add-gh-acts">
                <button type="button" class="pl-text-btn" onClick={() => setSel([])}>Clear</button>
                <button type="button" class="btn sm danger-soft" onClick={() => ask({
                  title: `Remove ${picked.length === 1 ? picked[0].card?.name : `${picked.length} cards`}?`,
                  text: `${picked.length === 1 ? "It won't" : "They won't"} be added to your ${target === "wants" ? "want-list" : "collection"}. You can find ${picked.length === 1 ? "it" : "them"} again from Find cards.`,
                  action: "Remove", run: () => { setAll({ status: "dropped" }, sel); setSel([]); setOpen(null); },
                })}>Remove</button>
              </span>
            </>}
          </span>
          {picked.length ? <>
            <span class="add-gh-set">Set for the ticked cards</span>
            <span class="add-gh-label">Copies</span>
            {wants ? <LangPick value={sameOf(picked, "lang")} onChange={(lang) => apply({ lang })} /> : <LangOne value={sameOf(picked, "lang")} onChange={(lang) => apply({ lang })} />}
            <CondPop value={sameOf(picked, "cond")} onChange={(cond) => apply({ cond })} target={target} />
            <FinishPop value={sameOf(picked, "finish")} onChange={(finish) => apply({ finish })} fins={wants ? ["any", "nonfoil", "foil"] : ["nonfoil", "foil"]} target={target} />
            {wants ? <ListPop items={picked} change={change} bulk /> : <span class="add-gh-label">Paid each</span>}
          </> : <>
            <span class="add-gh-label">Copies</span>
            <span class="add-gh-label">Language</span>
            <span class="add-gh-label">{wants ? "Worst condition" : "Condition"}</span>
            <span class="add-gh-label">Finish</span>
            <span class="add-gh-label">{wants ? "Lists" : "Paid each"}</span>
          </>}
        </div>
        {items.map((it) => {
          const extras = extrasLine(it, target);
          return (
            <div class={`row add-row${sel.includes(it.id) ? " picked" : ""}`} aria-current={open === it.id ? "true" : undefined}>
              <input type="checkbox" class="pl-check-box" checked={sel.includes(it.id)} onChange={() => flip(it.id)} aria-label={`Select ${it.card?.name}`} />
              <button type="button" class="add-row-main" onClick={() => setOpen(open === it.id ? null : it.id)} aria-label={`${it.card?.name}: versions and settings`}>
                <CardImage src={img(it.card, "small")} alt="" foil={it.finish === "foil"} />
                <span class="r-main">
                  <span class="r-name"><span>{it.card?.name}</span><ManaCost cost={it.card?.mana_cost ?? it.card?.card_faces?.[0]?.mana_cost} front /></span>
                  <span class="r-line"><SetSymbol set={it.card?.set ?? null} rarity={it.card?.rarity} /><span>{versionLine(it.card)}{!it.chosen && it.prints ? " · newest regular" : ""}</span></span>
                  {extras && <span class="r-wish">{extras}</span>}
                </span>
              </button>
              <RowControls it={it} upd={upd} target={target} share={spread.get(it.id)} />
            </div>
          );
        })}
      </div>
    </>
  );
}

/** A card being added, in the app's side pane: its colour field and big picture, its versions, then its settings. */
function AddPane({ it, upd, target, share, onClose, onNext, place }: { it: Item; upd: Upd; target: Target; share?: number; onClose: () => void; onNext?: () => void; place: string }) {
  const c = it.card!;
  const set = (p: Partial<Item>) => upd(it.id, p);
  const wants = target === "wants";
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  const fins = [...(wants ? ["any"] : []), ...finishes(c)];
  return (
    <>
      <div class="detail-backdrop" onClick={onClose} />
      <aside class="detail add-pane" aria-label={c.name} style={fieldStyle(c.mana_cost ?? c.card_faces?.[0]?.mana_cost)}>
        <div class="d-top">
          <button class="icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
          <span class="d-top-title">{place}</span>
          <span style={{ width: "36px" }} />
        </div>
        <div class="d-stage">
          <BigCard src={img(c, "normal")} alt={c.name} foil={it.finish === "foil"} placeholder={img(c, "small")} />
          <h2 class="d-name">{c.name}<ManaCost cost={c.mana_cost ?? c.card_faces?.[0]?.mana_cost} large /></h2>
          <div class="d-version">
            <SetSymbol set={c.set} rarity={c.rarity} />
            <span>{c.set_name} · #{c.collector_number}</span>
            <span class="chip">{versionText(preview(c)) || "Regular"}</span>
          </div>
        </div>

        <div class="group-title">Version</div>
        <div class="group form add-versions"><VersionStrip it={it} upd={upd} target={target} /></div>

        <div class="group-title">{wants ? "Which copy counts" : "Your copy"}</div>
        <div class="group form">
          <div class="f-row"><span>Copies</span>
            <span class="stepper">
              <button type="button" class="icon-btn" disabled={it.qty <= 1} onClick={() => set({ qty: it.qty - 1 })} aria-label="One fewer"><IconMinus /></button>
              <b aria-live="polite">{it.qty}</b>
              <button type="button" class="icon-btn" onClick={() => set({ qty: it.qty + 1 })} aria-label="One more"><IconPlus /></button>
            </span>
          </div>
          <div class="f-row"><span>Language</span>
            {wants ? <LangPick value={it.lang} onChange={(lang) => set({ lang })} /> : <LangOne value={it.lang} onChange={(lang) => set({ lang })} />}
          </div>
          <div class="f-row stack"><span>{wants ? "Worst condition I accept" : "Condition"}</span>
            <div class="seg full" role="radiogroup" aria-label="Condition">
              {CONDS.map((x) => <button type="button" role="radio" aria-checked={it.cond === x} aria-pressed={it.cond === x} onClick={() => set({ cond: x })}>{x}</button>)}
            </div>
            <small>{condName(it.cond)}{wants ? " or better" : ""}</small>
          </div>
          <div class="f-row stack"><span>Finish</span>
            <div class="seg full" role="radiogroup" aria-label="Finish">
              {fins.map((f) => <button type="button" role="radio" aria-checked={it.finish === f} aria-pressed={it.finish === f} onClick={() => set({ finish: f })}>{f === "any" ? "Any" : finishName(f)}</button>)}
            </div>
          </div>
          {wants && <div class="f-row"><span>Lists</span><ListPop items={[it]} change={(f) => upd(it.id, f(it))} /></div>}
          {!wants && <>
            <label class="f-row"><span>Price paid<small>Each, optional; change it any time</small></span>
              <span class="money"><span>€</span><input inputMode="decimal" placeholder={share ? share.toFixed(2) : "none"} value={it.price} onInput={(e) => set({ price: (e.target as HTMLInputElement).value })} /></span>
            </label>
            <label class="f-row"><span>Date bought<small>Optional</small></span>
              <span class="money text-in"><input type="date" value={it.date} onInput={(e) => set({ date: (e.target as HTMLInputElement).value })} /></span>
            </label>
          </>}
        </div>

        {wants && <>
          <div class="group-title">When to tell me</div>
          <div class="group form">
            <label class="f-row"><span>Target price<small>Alert at or under this</small></span>
              <span class="money"><span>€</span><input inputMode="decimal" placeholder="none" value={it.target} onInput={(e) => set({ target: (e.target as HTMLInputElement).value })} /></span>
            </label>
            <label class="f-row"><span>Deal from<small>How far under the market counts as a deal</small></span>
              <span class="money"><input inputMode="numeric" placeholder="20" value={it.deal} onInput={(e) => set({ deal: (e.target as HTMLInputElement).value })} /><span>%</span></span>
            </label>
            <label class="f-row"><span>CardTrader Zero only</span>
              <input type="checkbox" class="switch" checked={it.zero} onChange={(e) => set({ zero: (e.target as HTMLInputElement).checked })} />
            </label>
          </div>
        </>}
        <div class="add-pane-foot">
          <button class="btn" type="button" onClick={onClose}>Done</button>
          {onNext && <button class="btn primary" type="button" onClick={onNext}>Next card</button>}
        </div>
      </aside>
    </>
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

type Ask = (q: { title: string; text: string; action: string; run: () => void }) => void;
interface PickProps { ask: Ask; items: Item[]; upd: Upd; target: Target; setAll: (p: Partial<Item>, only?: number[]) => void; each: (f: (x: Item) => Partial<Item>, only?: number[]) => void; deck: boolean; lot: string; setLot: (v: string) => void; spread: Map<number, number> }

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

// ---- live card search, with pictures ----------------------------------------------------------
/** Type a name, see matching cards with their pictures as you type (Scryfall search, most played first).
 *  `row`: picture tiles in a row (a line that needs a look); otherwise the app's list with an add button per card. */
function CardSearch({ onPick, onLess, initial, row, autofocus, placeholder, added }: { onPick: (c: Card) => void; onLess?: (c: Card) => void; initial?: string; row?: boolean; autofocus?: boolean; placeholder?: string; added?: (c: Card) => number }) {
  const [q, setQ] = useState(initial ?? "");
  const [res, setRes] = useState<Card[] | null>(null);
  const [hi, setHi] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(null); return; }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await paced(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(`${term} game:paper`)}&unique=cards&order=edhrec`).catch(() => null);
      const body = r?.ok ? ((await r.json()) as { data: Card[] }) : { data: [] };
      if (n === seq.current) { setRes(body.data.filter((c) => !notCard(c)).slice(0, row ? 6 : 8)); setHi(0); }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);
  const keys = (e: KeyboardEvent) => {
    if (!res?.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); setHi((hi + 1) % res.length); }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); setHi((hi - 1 + res.length) % res.length); }
    if (e.key === "Enter") { e.preventDefault(); onPick(res[hi]); }
  };
  return (
    <div class={`pl-cs${row ? " pl-cs-row" : ""}`}>
      <label class="field"><IconSearch /><span class="sr">Card name</span>
        <input type="search" value={q} placeholder={placeholder ?? "Card name"} autofocus={autofocus} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={keys} />
      </label>
      {res && row && (
        <div class="pl-cs-res" role="listbox" aria-label="Matching cards">
          {res.length === 0 ? <p class="pl-cs-none">No card by that name.</p> : res.map((c, i) => (
            <button type="button" class="pl-cs-card" role="option" aria-selected={i === hi} onClick={() => onPick(c)} onMouseEnter={() => setHi(i)}>
              <CardImage src={img(c, "small")} alt="" foil={false} eager /><b>{c.name}</b>
            </button>
          ))}
        </div>
      )}
      {res && !row && (
        res.length === 0 ? <p class="pl-cs-none">No card by that name.</p> : (
          <div class="list" role="listbox" aria-label="Matching cards">
            {res.map((c, i) => {
              const n = added?.(c) ?? 0;
              return (
                <div class="row" role="option" aria-selected={i === hi} aria-current={i === hi ? "true" : undefined} onMouseEnter={() => setHi(i)} onClick={() => onPick(c)}>
                  <CardImage src={img(c, "small")} alt="" foil={false} eager />
                  <div class="r-main">
                    <div class="r-name"><span>{c.name}</span><ManaCost cost={c.mana_cost ?? c.card_faces?.[0]?.mana_cost} front /></div>
                    <div class="r-line"><span>{c.type_line}</span></div>
                  </div>
                  {n && onLess ? (
                    <span class="pl-step" onClick={(e) => e.stopPropagation()}>
                      <button type="button" class="icon-btn" aria-label={`One fewer ${c.name}`} onClick={() => onLess(c)}><IconMinus /></button>
                      <b aria-live="polite">{n}</b>
                      <button type="button" class="icon-btn" aria-label={`One more ${c.name}`} onClick={() => onPick(c)}><IconPlus /></button>
                    </span>
                  ) : (
                    <button type="button" class="icon-btn pl-add" aria-label={`Add ${c.name}`} onClick={(e) => { e.stopPropagation(); onPick(c); }}><IconPlus /></button>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

// ---- a file: CSV, ManaBox, Moxfield and the like ------------------------------------------------
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
const COND_WORDS: Record<string, string> = { mint: "NM", near_mint: "NM", nm: "NM", excellent: "SP", lightly_played: "SP", sp: "SP", good: "MP", moderately_played: "MP", mp: "MP", played: "PL", heavily_played: "PL", pl: "PL", poor: "PO", damaged: "PO", po: "PO" };
/** Rows of a CSV as pasted lines; columns found by their header (ManaBox: Name, Set code, Collector number, Foil,
 *  Quantity, Scryfall ID, Condition, Language). The file's prices are ignored (D93). */
function csvLines(text: string): Line[] {
  const [head = [], ...rows] = csvRows(text);
  const h = head.map((x) => x.trim().toLowerCase());
  const col = (re: RegExp) => h.findIndex((x) => re.test(x));
  const c = { name: col(/^(card )?name$/), qty: col(/^(quantity|qty|count|amount)$/), set: col(/^(set|set code|edition|edition code)$/), num: col(/collector|^(number|cn)$/),
    foil: col(/^(foil|finish|printing)$/), id: col(/scryfall/), cond: col(/condition/), lang: col(/^lang(uage)?$/) };
  return rows.map((r) => {
    const v = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const set = v(c.set), num = v(c.num);
    return { raw: [v(c.qty), v(c.name), set && `(${set.toUpperCase()}) ${num}`].filter(Boolean).join(" "), qty: Number(v(c.qty)) || 1, name: v(c.name),
      set: set.toLowerCase() || undefined, number: num || undefined, foil: /foil|etched/i.test(v(c.foil)), id: v(c.id) || undefined,
      cond: COND_WORDS[v(c.cond).toLowerCase().replace(/[ -]/g, "_")], lang: v(c.lang).toLowerCase() || undefined };
  }).filter((l) => l.name || l.id);
}

// ---- the page -----------------------------------------------------------------------------------
type Way = "search" | "list" | "file" | "deck" | "manabox";
const WAYS: { id: Way; label: string; only?: Target }[] = [
  { id: "search", label: "Search" }, { id: "list", label: "Paste a list" }, { id: "file", label: "File" },
  { id: "deck", label: "Precon deck", only: "collection" }, { id: "manabox", label: "ManaBox", only: "collection" },
];
let nextId = 1;

/** Want-list › Add cards (or Collection › Add cards): a page of the app. Pick a way to add, cards land in the list
 *  below, any way can add more; lines that need a look sit on top; one Add at the bottom. */
export function AddPage({ target }: { target: Target }) {
  const example = new URLSearchParams(location.search).has("example");
  const [way, setWay] = useState<Way>(example ? "list" : "search");
  const [text, setText] = useState(example ? EXAMPLE : "");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [lot, setLot] = useState("");
  const [deck, setDeck] = useState<DeckRef | null>(null);
  const [fileName, setFileName] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [stage, setStage] = useState<"find" | "tune" | "done">("find");
  const [question, setQuestion] = useState<Parameters<Ask>[0] | null>(null);
  const ask: Ask = (q) => setQuestion(q);
  const done = stage === "done";
  const back = target === "wants" ? "/wants" : "/collection";
  const where = target === "wants" ? "want-list" : "collection";
  const upd: Upd = (id, p) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const live = items.filter((x) => x.status === "ok" && x.card);
  const unclear = items.filter((x) => x.status === "guess" || x.status === "unknown").sort((a, b) => Number(b.status === "unknown") - Number(a.status === "unknown"));
  const add = (xs: Item[]) => setItems((cur) => [...cur, ...xs.map((x) => ({ ...x, id: nextId++ }))]);

  // fetch every card's printings in the background; until then the matched printing shows
  useEffect(() => {
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
  }, [items.map((x) => `${x.id}:${x.card?.name}:${!!x.prints}`).join()]);

  // the side pane is the app's: a third column on a wide screen
  useEffect(() => { document.querySelector(".shell")?.classList.toggle("has-detail", open !== null); }, [open]);
  useEffect(() => () => document.querySelector(".shell")?.classList.remove("has-detail"), []);

  const find = async (lines: Line[]) => {
    setBusy(true);
    const out = await match(lines).catch(() => []);
    add(out.map((x) => ({ ...x, finish: x.line.foil && target === "collection" ? "foil" : defaultFinish(target, x, x.card) })));
    setBusy(false);
    setText("");
  };
  const readFile = async (f: File) => { setFileName(f.name); await find(csvLines(await f.text())); };
  const addCard = (card: Card) => {
    const same = items.find((x) => x.status === "ok" && x.line.raw === card.name && !x.chosen);
    if (same) return upd(same.id, { qty: same.qty + 1 });
    const it = fresh(0, { raw: card.name, qty: 1, name: card.name }, card, "ok");
    add([{ ...it, finish: defaultFinish(target, it, card) }]);
  };
  const sameCard = (x: Item, c: Card) => x.status === "ok" && (x.card?.oracle_id === c.oracle_id || x.card?.name === c.name);
  /** One copy fewer of a card from the search: the last one added goes first; at none it leaves the list. */
  const less = (c: Card) => {
    const it = [...items].reverse().find((x) => sameCard(x, c));
    if (!it) return;
    if (it.qty > 1) return upd(it.id, { qty: it.qty - 1 });
    ask({ title: `Remove ${c.name}?`, text: "It won't be added. You can add it again from the search.", action: "Remove", run: () => setItems((xs) => xs.filter((x) => x.id !== it.id)) });
  };
  const go = (s: typeof stage) => { setOpen(null); setStage(s); scrollTo(0, 0); };
  const pickDeck = async (d: DeckRef) => {
    setBusy(true); setDeck(d);
    add(await deckItems(d).catch(() => []));
    setBusy(false);
  };
  const each = (f: (x: Item) => Partial<Item>, only?: number[]) => setItems((xs) => xs.map((x) => (only && !only.includes(x.id) ? x : { ...x, ...f(x) })));
  const setAll = (p: Partial<Item>, only?: number[]) => setItems((xs) => xs.map((x) => {
    if (only && !only.includes(x.id)) return x;
    if (p.finish && p.finish !== "any" && !finishes(x.card).includes(p.finish)) return x;  // a finish the card doesn't have is skipped
    return { ...x, ...p };
  }));
  const spread = useMemo(() => spreadLot(live, lot), [live, lot]);
  const total = live.reduce((t, x) => t + x.qty, 0);
  const openIt = live.find((x) => x.id === open);
  const openAt = openIt ? live.indexOf(openIt) : -1;
  const shell = document.querySelector(".shell");

  if (done) return (
    <div class="page wide add-page">
      <header class="head sec-band"><div><h1 class="title">Added</h1><p class="sub">{total} cards on their way to your {where}</p></div></header>
      <p class="hint">Prototype: nothing was saved. This is what would be sent, one edit per card:</p>
      <pre class="add-sent">{live.map((x) => target === "wants"
        ? `add   ${x.card?.set.toUpperCase()} ${x.card?.collector_number}  ${x.card?.name}  copies ${x.qty} · ${langText(x.lang)} · ${x.cond} or better · foil ${x.finish}${x.target ? ` · target €${x.target}` : ""} · deal from ${x.deal || 20}%${x.lists.length ? ` · lists ${x.lists.join("; ")}` : ""}${x.zero ? " · Zero only" : ""}`
        : `owned ${x.card?.set.toUpperCase()} ${x.card?.collector_number}  ${x.card?.name}  ×${x.qty} · ${x.lang} · ${x.cond} · ${x.finish}${x.price ? ` · paid €${x.price} each` : spread.has(x.id) ? ` · paid €${spread.get(x.id)!.toFixed(2)} each (share of the lot)` : " · no price"}${x.date ? ` · ${x.date}` : ""}`).join("\n")}</pre>
      <a class="btn primary" href={back} onClick={link(back)}>Back to the {where}</a>
    </div>
  );

  return (
    <div class="page wide add-page">
      <header class="head sec-band">
        <div>
          {stage === "tune"
            ? <button type="button" class="add-crumb" onClick={() => go("find")}><IconBack />Find more cards</button>
            : <a class="add-crumb" href={back} onClick={link(back)}><IconBack />{target === "wants" ? "Want-list" : "Collection"}</a>}
          <h1 class="title">{stage === "tune" ? "Fine-tune" : "Add cards"}</h1>
          <ol class="add-steps" aria-label="Steps">
            <li aria-current={stage === "find" ? "step" : undefined}>Find cards</li>
            <li aria-current={stage === "tune" ? "step" : undefined}>Versions and settings</li>
            <li>Add</li>
          </ol>
        </div>
      </header>

      {stage === "find" && <>
      <div class="seg add-ways" role="tablist" aria-label="How to add">
        {WAYS.filter((w) => !w.only || w.only === target).map((w) => (
          <button type="button" role="tab" aria-selected={way === w.id} aria-pressed={way === w.id} onClick={() => setWay(w.id)}>{w.label}</button>
        ))}
      </div>

      <section class="add-input">
        {way === "search" && <CardSearch onPick={addCard} autofocus placeholder="Type a card name, e.g. bolt" onLess={less} added={(c) => live.filter((x) => sameCard(x, c)).reduce((t, x) => t + x.qty, 0)} />}
        {way === "list" && (
          <div class="add-paste">
            <textarea rows={6} value={text} placeholder={"4 Lightning Bolt\nSol Ring (CMR) 472\nThe One Ring *F*"} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
            <div class="add-paste-side">
              <div class="pl-example" aria-label="How to write the list">
                <div><b>4 Lightning Bolt</b><span>4 copies</span></div>
                <div><b>Sol Ring (CMR) 472</b><span>that exact version</span></div>
                <div><b>The One Ring *F*</b><span>foil</span></div>
                <div><b>Sideboard</b><span>skipped</span></div>
              </div>
              <div class="add-paste-acts">
                <button class="pl-text-btn" type="button" onClick={() => setText(EXAMPLE)}>Try an example</button>
                <button class="btn primary" type="button" disabled={busy || !parse(text).length} onClick={() => find(parse(text))}>{busy ? "Finding…" : `Find ${parse(text).length || ""} cards`}</button>
              </div>
            </div>
          </div>
        )}
        {way === "file" && (
          <label class={`pl-drop${busy ? " busy" : ""}`}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) readFile(f); }}>
            <input type="file" accept=".csv,text/csv,.txt" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) readFile(f); }} />
            <b>{busy ? `Reading ${fileName}…` : fileName ? `${fileName} added. Another file?` : "Choose a file, or drop it here"}</b>
            <small>A CSV with a name column; set, number, quantity, foil, condition and language are used when there. ManaBox, Moxfield, Archidekt and Deckbox exports work as they are. Prices in the file are ignored.</small>
          </label>
        )}
        {way === "deck" && (busy ? <p class="hint">Getting {deck?.name}…</p> : <DeckPick onPick={pickDeck} />)}
        {way === "manabox" && <p class="hint add-note">Keeping the collection in step with ManaBox has its own preview (spec D93): pick your export, see "+120 new · 3 no longer in your export · 8 already here", then Import. Not part of this prototype.</p>}
      </section>

      {unclear.length > 0 && <>
        <div class="list-head add-head bad"><span class="add-dot" />Needs a look<span>{unclear.length} {unclear.length === 1 ? "line" : "lines"}</span></div>
        <div class="list add-unclear">
          {unclear.map((it) => (
            <div class={`add-check ${it.status}`}>
              {it.status === "guess" ? (
                <div class="add-check-line">
                  <CardImage src={img(it.card, "small")} alt="" foil={false} />
                  <div class="r-main">
                    <div class="r-name"><span>Did you mean {it.card?.name}?</span></div>
                    <div class="r-line"><span>You wrote “{it.line.raw}”</span></div>
                  </div>
                  <span class="add-check-acts">
                    <button class="btn xs primary" type="button" onClick={() => upd(it.id, { status: "ok" })}>Yes</button>
                    <button class="btn xs" type="button" onClick={() => upd(it.id, { status: "unknown", card: null })}>No</button>
                    <button class="btn xs danger-soft" type="button" onClick={() => ask({ title: `Leave out “${it.line.raw}”?`, text: "That line won't be added.", action: "Leave out", run: () => upd(it.id, { status: "dropped" }) })}>Leave out</button>
                  </span>
                </div>
              ) : (
                <>
                  <div class="add-check-line">
                    <span class="add-check-q" aria-hidden="true">?</span>
                    <div class="r-main">
                      <div class="r-name"><span>“{it.line.raw}”</span></div>
                      <div class="r-line"><span>Not recognised. Which card is it?</span></div>
                    </div>
                    <span class="add-check-acts"><button class="btn xs danger-soft" type="button" onClick={() => ask({ title: `Leave out “${it.line.raw}”?`, text: "That line won't be added.", action: "Leave out", run: () => upd(it.id, { status: "dropped" }) })}>Leave out</button></span>
                  </div>
                  <CardSearch row initial={it.line.name} placeholder="Type the name"
                    onPick={(card) => upd(it.id, { card, status: "ok", prints: null, chosen: false, finish: defaultFinish(target, it, card) })} />
                </>
              )}
            </div>
          ))}
        </div>
      </>}

      {live.length > 0 && <>
        <div class="list-head add-head good"><span class="add-dot" />Found<span>{total} {total === 1 ? "card" : "cards"}</span></div>
        <div class="add-found">
          {live.map((x) => (
            <span class="add-found-card" title={`${x.card?.name}, ${versionLine(x.card)}`}>
              <CardImage src={img(x.card, "small")} alt={x.card?.name ?? ""} foil={false} />
              {x.qty > 1 && <b>{x.qty}</b>}
              <button type="button" aria-label={`Remove ${x.card?.name}`} onClick={() => ask({ title: `Remove ${x.card?.name}?`, text: `${x.qty > 1 ? `All ${x.qty} copies` : "It"} won't be added. You can find it again.`, action: "Remove", run: () => setItems((xs) => xs.filter((y) => y.id !== x.id)) })}><IconClose /></button>
            </span>
          ))}
        </div>
      </>}
      {!items.length && <div class="empty add-empty"><p>Search, paste or import. Then fine-tune each card's version and settings before adding.</p></div>}
      </>}

      {stage === "tune" && deck && live.length > 0 && (
        <div class="pl-deckhead">
          <div><b>{deck.name}</b><small>exact versions from the deck list</small></div>
          <label>Paid for the deck <span class="money"><span>€</span><input inputMode="decimal" placeholder="optional" value={lot} onInput={(e) => setLot((e.target as HTMLInputElement).value)} /></span></label>
        </div>
      )}

      {stage === "tune" && <>
        <p class="add-lead">Each card starts on its newest regular version and your usual settings. Change any of them here, tick several to change them together, or open a card for all its versions.</p>
        <AddList ask={ask} items={live} upd={upd} target={target} setAll={setAll} each={each} deck={!!deck} lot={lot} setLot={setLot} spread={spread} open={open} setOpen={setOpen} />
      </>}

      {items.length > 0 && (stage === "find" ? (
        <div class="add-bar">
          <span>{unclear.length ? `${unclear.length} to check first` : `${total} ${total === 1 ? "card" : "cards"} found`}</span>
          <button class="btn primary" type="button" disabled={!live.length || unclear.length > 0} onClick={() => go("tune")}>Next: versions and settings</button>
        </div>
      ) : (
        <div class="add-bar">
          <span>{total} {total === 1 ? "card" : "cards"}</span>
          <button class="btn primary" type="button" disabled={!live.length} onClick={() => go("done")}>Add to the {where}</button>
        </div>
      ))}

      {question && <Confirm title={question.title} text={question.text} action={question.action}
        onCancel={() => setQuestion(null)} onConfirm={() => { question.run(); setQuestion(null); }} />}
      {openIt && shell && createPortal(
        <AddPane key={openIt.id} it={openIt} upd={upd} target={target} share={spread.get(openIt.id)} place={`${openAt + 1} of ${live.length}`}
          onClose={() => setOpen(null)} onNext={openAt < live.length - 1 ? () => setOpen(live[openAt + 1].id) : undefined} />, shell)}
    </div>
  );
}

/** The page header's actions on the Want-list and the Collection: Add cards, in the page's own colour, and
 *  Dashboards as an icon. */
export function PasteButton({ to }: { to: Target }) {
  const path = to === "wants" ? "/wants/add" : "/collection/add";
  return (
    <span class="head-acts">
      <a class="btn sm sec-soft" href={path} onClick={link(path)}><IconPlus />Add cards</a>
      <a class="icon-btn head-icon" href="/dashboards" onClick={link("/dashboards")} aria-label="Dashboards" title="Dashboards"><IconChart /></a>
    </span>
  );
}


/** PREVIEW only (local copy): flips every lime button in the app between solid and soft, to compare. */
export function ButtonStylePreview() {
  const [soft, setSoft] = useState(() => { try { return localStorage.getItem("btn-preview") !== "solid"; } catch { return true; } });
  useEffect(() => {
    if (soft) document.documentElement.dataset.btn = "soft"; else delete document.documentElement.dataset.btn;
    try { localStorage.setItem("btn-preview", soft ? "soft" : "solid"); } catch { /* fine */ }
  }, [soft]);
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return null;
  return (
    <div class="btn-preview" role="group" aria-label="Button style preview">
      <span>Buttons</span>
      <button type="button" aria-pressed={!soft} onClick={() => setSoft(false)}>Solid</button>
      <button type="button" aria-pressed={soft} onClick={() => setSoft(true)}>Soft</button>
    </div>
  );
}
