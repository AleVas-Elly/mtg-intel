// PROTOTYPE, throwaway (mtg-intel-docs issue 6): paste a list of card names into the Want-list or the
// Collection, check the lines that weren't clear, then pick each card's exact version and settings.
// Round 2: the user picked the table (A); variants B (one by one) and C (wall of cards) are in this
// branch's history (3984d90). Each card starts from defaults; the rarer settings fold under "More options",
// per card and for every card at once. Cards and pictures are real (Scryfall); nothing is saved: the last screen
// shows what would be sent. Local copy only. Never merge to main.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { peek } from "../api";
import type { WantsDoc } from "../types";
import { CardImage } from "../ui/CardImage";
import { IconClose } from "../ui/icons";
import { preview, printings, type ScryCard } from "../scry";
import { condName, langName, versionText } from "../format";
import "./paste.css";

type Target = "wants" | "collection";
type Card = ScryCard & { promo?: boolean; layout?: string; booster?: boolean; prices?: { eur?: string | null; eur_foil?: string | null } };
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

const closePop = (e: Event) => { ((e.currentTarget as Element).closest("details") as HTMLDetailsElement).open = false; };
// a tap outside an open list closes it
document.addEventListener("pointerdown", (e) => {
  const inside = (e.target as Element).closest?.(".pl-pop");
  document.querySelectorAll<HTMLDetailsElement>(".pl-pop[open]").forEach((d) => d !== inside && (d.open = false));
});

/** One look for every list that opens from a pill: our own panel, not the browser's. `ghost` = quiet, for rows. */
function Pop({ label, text, children, ghost, on, narrow }: { label: string; text: string; children: preact.ComponentChildren; ghost?: boolean; on?: boolean; narrow?: boolean }) {
  return (
    <details class={`pl-pop${narrow ? " narrow" : ""}`} onToggle={(e) => { const me = e.currentTarget as HTMLDetailsElement; if (me.open) { document.querySelectorAll<HTMLDetailsElement>(".pl-pop[open]").forEach((d) => d !== me && (d.open = false)); me.querySelector<HTMLInputElement>(".pl-pop-search")?.focus(); } }}>
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

/** The cards as one list, each row with its main settings inline; opening a row shows its versions and the rest.
 *  Ticked rows get one line of settings on top. */
function PickTable({ items, upd, target, setAll, each, lot, setLot, spread, deck }: PickProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const picked = items.filter((x) => sel.includes(x.id));
  const flip = (id: number) => setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const go = (id: number | null) => {
    setOpen(id);
    if (id !== null) requestAnimationFrame(() => document.getElementById(`pl-row-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const apply = (p: Partial<Item>) => setAll(p, sel);
  const change: Change = (f) => each(f, sel);
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
          <div class="pl-bulk-line">
            {target === "wants" && <ListPop items={picked} change={change} bulk />}
            {target === "wants" ? <LangPick value={sameOf(picked, "lang")} onChange={(lang) => apply({ lang })} /> : <LangOne value={sameOf(picked, "lang")} onChange={(lang) => apply({ lang })} />}
            <CondPop value={sameOf(picked, "cond")} onChange={(cond) => apply({ cond })} target={target} />
            <FinishPop value={sameOf(picked, "finish")} onChange={(finish) => apply({ finish })} fins={target === "wants" ? ["any", "nonfoil", "foil"] : ["nonfoil", "foil"]} target={target} />
            <Pop label="More settings" text="More settings">
              <MoreForm items={picked} apply={apply} change={change} target={target} bulk />
            </Pop>
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
          const extras = extrasLine(it, target);
          return (
            <div class={`pl-row${open === it.id ? " open" : ""}${sel.includes(it.id) ? " picked" : ""}`} id={`pl-row-${it.id}`}>
              <div class="pl-row-line">
                <input type="checkbox" class="pl-check-box" checked={sel.includes(it.id)} onChange={() => flip(it.id)} aria-label={`Select ${it.card?.name}`} />
                <button type="button" class="pl-row-main" aria-expanded={open === it.id} onClick={() => go(open === it.id ? null : it.id)} title="Versions and more settings">
                  <CardImage src={img(it.card, "small")} alt="" foil={it.finish === "foil"} />
                  <span class="pl-row-text">
                    <b class="pl-row-name">{it.card?.name}</b>
                    <span class="pl-row-ver">{it.card?.set.toUpperCase()} {it.card?.collector_number} · {it.card?.set_name}</span>
                    {extras && <span class="pl-row-extra">{extras}</span>}
                  </span>
                </button>
                <RowControls it={it} upd={upd} target={target} share={share} />
                <button type="button" class="pl-chev-btn" aria-expanded={open === it.id} aria-label={`Versions and more settings for ${it.card?.name}`} onClick={() => go(open === it.id ? null : it.id)}>
                  <svg class="pl-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </button>
              </div>
              {open === it.id && (
                <div class="pl-editor">
                  <VersionStrip it={it} upd={upd} target={target} />
                  <MoreForm items={[it]} apply={(p) => upd(it.id, p)} change={(f) => upd(it.id, f(it))} target={target} />
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

// ---- live card search, with pictures ----------------------------------------------------------
/** Type a name, see matching cards with their pictures as you type (Scryfall search, most played first). */
function CardSearch({ onPick, initial, row, autofocus, placeholder }: { onPick: (c: Card) => void; initial?: string; row?: boolean; autofocus?: boolean; placeholder?: string }) {
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
  const pick = (c: Card) => { onPick(c); if (!row) { setQ(""); setRes(null); } };
  return (
    <div class={`pl-cs${row ? " pl-cs-row" : ""}`}>
      <input class="pl-search" type="search" value={q} placeholder={placeholder ?? "Card name"} autofocus={autofocus} aria-label="Card name"
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (!res?.length) return;
          if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); setHi((hi + 1) % res.length); }
          if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); setHi((hi - 1 + res.length) % res.length); }
          if (e.key === "Enter") { e.preventDefault(); pick(res[hi]); }
        }} />
      {res && (
        <div class="pl-cs-res" role="listbox" aria-label="Matching cards">
          {res.length === 0 ? <p class="pl-cs-none">No card by that name.</p> : res.map((c, i) => (
            <button type="button" class="pl-cs-card" role="option" aria-selected={i === hi} onClick={() => pick(c)} onMouseEnter={() => setHi(i)}>
              <CardImage src={img(c, row ? "small" : "small")} alt="" foil={false} eager />
              <span><b>{c.name}</b><small>{c.type_line}</small></span>
            </button>
          ))}
        </div>
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

// ---- the flow -----------------------------------------------------------------------------------
type Way = "one" | "list" | "file" | "deck" | "manabox";
const WAYS: { id: Way; title: string; text: string; only?: Target }[] = [
  { id: "one", title: "One card", text: "Search by name and see the cards as you type." },
  { id: "list", title: "A list", text: "Paste names from a chat, a note or another app." },
  { id: "file", title: "A file", text: "A CSV, or an export from ManaBox, Moxfield and the like." },
  { id: "deck", title: "A precon deck", text: "Every card of a Commander deck, at its exact version.", only: "collection" },
  { id: "manabox", title: "Keep in step with ManaBox", text: "Your whole ManaBox collection; later imports add what's new and take out what's gone.", only: "collection" },
];
const INPUT_LABEL: Record<Way, string> = { one: "Find cards", list: "Paste", file: "File", deck: "Deck", manabox: "ManaBox" };

function Flow({ target, onClose }: { target: Target; onClose: () => void }) {
  const example = new URLSearchParams(location.search).has("example");
  const [way, setWay] = useState<Way | null>(example ? "list" : null);
  const [step, setStep] = useState<"choose" | "input" | "check" | "pick" | "done">(example ? "input" : "choose");
  const [text, setText] = useState(example ? EXAMPLE : "");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [lot, setLot] = useState("");
  const [deck, setDeck] = useState<DeckRef | null>(null);
  const [fileName, setFileName] = useState("");
  const pickDeck = async (d: DeckRef) => {
    setBusy(true); setDeck(d);
    setItems(await deckItems(d).catch(() => []));
    setBusy(false); setStep("pick");
  };
  const upd: Upd = (id, p) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const live = items.filter((x) => x.status !== "dropped" && x.card);
  const unclear = items.filter((x) => x.status === "guess" || x.status === "unknown").sort((a, b) => Number(b.status === "unknown") - Number(a.status === "unknown"));
  const where = target === "wants" ? "want-list" : "collection";
  const checks = way === "list" || way === "file";
  const steps: [string, string][] = [["choose", "How"], ["input", INPUT_LABEL[way ?? "list"]], ...(checks ? [["check", "Check names"] as [string, string]] : []), ["pick", "Versions and settings"], ["done", "Added"]];

  // fetch every card's printings in the background; until then the matched printing shows
  useEffect(() => {
    if (step !== "check" && step !== "pick" && step !== "input") return;
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

  const find = async (lines: Line[]) => {
    setBusy(true);
    const out = await match(lines).catch(() => []);
    setItems(out.map((x) => ({ ...x, finish: x.line.foil && target === "collection" ? "foil" : defaultFinish(target, x, x.card) })));
    setBusy(false);
    setStep("check");
  };
  const readFile = async (f: File) => { setFileName(f.name); await find(csvLines(await f.text())); };
  const addOne = (card: Card) => setItems((xs) => [...xs, (() => { const it = fresh(Date.now(), { raw: card.name, qty: 1, name: card.name }, card, "ok"); return { ...it, finish: defaultFinish(target, it, card) }; })()]);
  const each = (f: (x: Item) => Partial<Item>, only?: number[]) => setItems((xs) => xs.map((x) => (only && !only.includes(x.id) ? x : { ...x, ...f(x) })));
  const setAll = (p: Partial<Item>, only?: number[]) => setItems((xs) => xs.map((x) => {
    if (only && !only.includes(x.id)) return x;
    if (p.finish && p.finish !== "any" && !finishes(x.card).includes(p.finish)) return x;  // a finish the card doesn't have is skipped
    return { ...x, ...p };
  }));
  const choose = (w: Way) => { setWay(w); setItems([]); setDeck(null); setStep("input"); };
  const spread = useMemo(() => spreadLot(live, lot), [live, lot]);
  const total = live.reduce((t, x) => t + x.qty, 0);

  return (
    <div class="pl" role="dialog" aria-modal="true" aria-label={`Add cards to your ${where}`}>
      <header class="pl-head">
        <div>
          <h2>Add cards</h2>
          <ol class="pl-steps">{steps.map(([k, l]) => <li aria-current={step === k ? "step" : undefined}>{l}</li>)}</ol>
        </div>
        <span class="pl-into">to your {where}</span>
        <button class="icon-btn" type="button" onClick={onClose} aria-label="Close"><IconClose /></button>
      </header>

      <div class="pl-body">
        {step === "choose" && (
          <div class="pl-ways">
            {WAYS.filter((w) => !w.only || w.only === target).map((w) => (
              <button type="button" class="pl-way" onClick={() => choose(w.id)}>
                <span><b>{w.title}</b><small>{w.text}</small></span>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
            ))}
          </div>
        )}

        {step === "input" && way === "one" && (
          <div class="pl-paste">
            <CardSearch onPick={addOne} autofocus placeholder="Type a card name, e.g. bolt" />
            {live.length > 0 && (
              <div class="pl-chosen">
                <small>Chosen</small>
                {live.map((x) => (
                  <span class="pl-chosen-card">
                    <CardImage src={img(x.card, "small")} alt="" foil={false} />
                    <b>{x.card?.name}</b>
                    <button type="button" class="icon-btn" aria-label={`Remove ${x.card?.name}`} onClick={() => setItems((xs) => xs.filter((y) => y.id !== x.id))}><IconClose /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "input" && way === "list" && (
          <div class="pl-paste">
            <div class="pl-example" aria-label="How to write the list">
              <div><b>4 Lightning Bolt</b><span>4 copies; you pick the version next</span></div>
              <div><b>Sol Ring (CMR) 472</b><span>that exact version</span></div>
              <div><b>The One Ring *F*</b><span>foil</span></div>
              <div><b>Sideboard</b><span>headings are skipped</span></div>
            </div>
            <textarea rows={12} value={text} placeholder={"4 Lightning Bolt\nSol Ring (CMR) 472\nCounterspell"} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} autofocus />
            <div class="pl-row-btns">
              <button class="btn sm" type="button" onClick={() => setText(EXAMPLE)}>Try an example</button>
              <small>{parse(text).length} lines</small>
            </div>
          </div>
        )}

        {step === "input" && way === "file" && (
          <div class="pl-paste">
            <label class={`pl-drop${busy ? " busy" : ""}`}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) readFile(f); }}>
              <input type="file" accept=".csv,text/csv,.txt" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) readFile(f); }} />
              <b>{busy ? `Reading ${fileName}…` : "Choose a file, or drop it here"}</b>
              <small>CSV with a name column; set, collector number, quantity, foil, condition and language are used when there. ManaBox, Moxfield, Archidekt and Deckbox exports work as they are. Prices in the file are ignored.</small>
            </label>
          </div>
        )}

        {step === "input" && way === "deck" && (busy ? <p class="pl-ok">Getting {deck?.name}…</p> : <DeckPick onPick={pickDeck} />)}

        {step === "input" && way === "manabox" && (
          <div class="pl-paste">
            <p class="pl-ok">This one has its own screen (spec D93): pick your ManaBox export, see "+120 new · 3 no longer in your export · 8 already here", then Import. Not part of this prototype.</p>
          </div>
        )}

        {step === "check" && (
          <div class="pl-check">
            <p class="pl-ok"><b>{items.filter((x) => x.status === "ok").length} found{fileName && way === "file" ? ` in ${fileName}` : ""}.</b> {unclear.length ? `${unclear.length} need a look:` : "Every line was clear."}</p>
            {unclear.map((it) => (
              <div class={`pl-unclear ${it.status}`}>
                <code>{it.line.raw}</code>
                {it.status === "guess" ? (
                  <div class="pl-guess">
                    <CardImage src={img(it.card, "small")} alt="" foil={false} />
                    <span>Did you mean <b>{it.card?.name}</b>?</span>
                    <button class="btn xs primary" type="button" onClick={() => upd(it.id, { status: "ok" })}>Yes</button>
                    <button class="btn xs" type="button" onClick={() => upd(it.id, { status: "unknown", card: null })}>No, another</button>
                    <button class="btn xs danger-soft" type="button" onClick={() => upd(it.id, { status: "dropped" })}>Leave out</button>
                  </div>
                ) : (
                  <div class="pl-guess stack">
                    <div class="pl-guess-head"><span>Not recognised. Which card is it?</span>
                      <button class="btn xs danger-soft" type="button" onClick={() => upd(it.id, { status: "dropped" })}>Leave out</button>
                    </div>
                    <CardSearch row initial={it.line.name} placeholder="Type the name"
                      onPick={(card) => upd(it.id, { card, status: "ok", prints: null, chosen: false, finish: defaultFinish(target, it, card) })} />
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
        {step === "input" && <button class="btn" type="button" onClick={() => setStep("choose")}>Back</button>}
        {step === "input" && way === "list" && <button class="btn primary" type="button" disabled={busy || !parse(text).length} onClick={() => find(parse(text))}>{busy ? "Finding cards…" : "Find cards"}</button>}
        {step === "input" && way === "one" && <button class="btn primary" type="button" disabled={!live.length} onClick={() => setStep("pick")}>{live.length ? `Next: versions for ${live.length} ${live.length === 1 ? "card" : "cards"}` : "Pick a card first"}</button>}
        {step === "check" && <>
          <button class="btn" type="button" onClick={() => setStep("input")}>Back</button>
          <button class="btn primary" type="button" disabled={unclear.length > 0} onClick={() => setStep("pick")}>{unclear.length ? `${unclear.length} left to check` : `Next: versions for ${live.length} cards`}</button>
        </>}
        {step === "pick" && <>
          <button class="btn" type="button" onClick={() => setStep(checks ? "check" : "input")}>Back</button>
          <button class="btn primary" type="button" onClick={() => setStep("done")}>Add {total} {total === 1 ? "card" : "cards"} to {target === "wants" ? "the want-list" : "the collection"}</button>
        </>}
        {step === "done" && <button class="btn primary" type="button" onClick={onClose}>Done</button>}
      </footer>
    </div>
  );
}

/** The "Add cards" button for a page header; opens the flow over the page. */
export function PasteButton({ to }: { to: Target }) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get("paste") === to);
  const key = useMemo(() => Math.random(), [open]);
  return (
    <>
      <button class="btn sm primary" type="button" onClick={() => setOpen(true)}>Add cards</button>
      {open && createPortal(<Flow key={key} target={to} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
