// PROTOTYPE, throwaway (mtg-intel-docs issue 6): paste a list of card names into the Want-list or the
// Collection, check the lines that weren't clear, then pick each card's exact version and settings.
// Step 1 (paste) and 2 (check) are shared; step 3 (pick) has three variants, switched with ?variant=A|B|C
// or the bar at the bottom. Cards and pictures are real (Scryfall); nothing is saved: the last screen
// shows what would be sent. Local copy only. Never merge to main.
import { useEffect, useMemo, useState } from "preact/hooks";
import { CardImage } from "../ui/CardImage";
import { IconClose, IconMinus, IconPlus } from "../ui/icons";
import { preview, printings, type ScryCard } from "../scry";
import { condName, langName, versionText } from "../format";
import "./paste.css";

type Target = "wants" | "collection";
type Card = ScryCard & { promo?: boolean; prices?: { eur?: string | null; eur_foil?: string | null } };
interface Line { raw: string; qty: number; name: string; set?: string; number?: string; foil?: boolean }
interface Item {
  id: number; line: Line; status: "ok" | "guess" | "unknown" | "dropped"; card: Card | null; options: string[];
  prints: Card[] | null; chosen: boolean; qty: number; lang: string; cond: string; finish: string; price: string;
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
  }
  const out: Item[] = [];
  for (const [i, line] of lines.entries()) {
    let card = found[i], status: Item["status"] = card ? "ok" : "unknown", options: string[] = [];
    if (card && line.number && !card.name.toLowerCase().startsWith(line.name.toLowerCase())) status = "guess";  // set + number is another card
    if (!card) {
      const r = await paced(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(line.name)}`);
      if (r.ok) { card = (await r.json()) as Card; status = "guess"; }
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
  return { id, line, status, card, options, prints: null, chosen: !!line.number, qty: line.qty, lang: USUAL.lang, cond: USUAL.cond, finish: "", price: "" };
}

const plain = (c: Card) => !c.promo && !preview(c).tags.length && c.set !== "plst";
const isRegular = (c: Card) => plain(c) && (MAIN_SETS.has(c.set_type ?? "") || SIDE_SETS.has(c.set_type ?? ""));
/** Newest plain printing from a main set, else from a Commander or starter set, else the newest. */
const newestRegular = (ps: Card[]) => ps.find((c) => plain(c) && MAIN_SETS.has(c.set_type ?? "")) ?? ps.find(isRegular) ?? ps[0];
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
          <select class="select sm" value={set} onChange={(e) => setSet((e.target as HTMLSelectElement).value)} aria-label="Set">
            <option value="all">Every set</option>
            {sets.map(([code, name]) => <option value={code}>{name}</option>)}
          </select>
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

/** Language, condition, finish, copies and (collection) price paid for one card. `row` = compact selects. */
function Fields({ it, upd, target, row }: { it: Item; upd: Upd; target: Target; row?: boolean }) {
  const fins = [...(target === "wants" ? ["any"] : []), ...finishes(it.card)];
  const condLabel = target === "wants" ? "Worst condition" : "Condition";
  if (row) return (
    <>
      <Stepper value={it.qty} onChange={(qty) => upd(it.id, { qty })} />
      <select class="select sm" value={it.lang} onChange={(e) => upd(it.id, { lang: (e.target as HTMLSelectElement).value })} aria-label="Language">
        {LANGS.map((l) => <option value={l}>{langName(l)}</option>)}
      </select>
      <select class="select sm" value={it.cond} onChange={(e) => upd(it.id, { cond: (e.target as HTMLSelectElement).value })} aria-label={condLabel}>
        {CONDS.map((c) => <option value={c}>{target === "wants" ? `${c} or better` : c}</option>)}
      </select>
      <select class="select sm" value={it.finish} onChange={(e) => upd(it.id, { finish: (e.target as HTMLSelectElement).value })} aria-label="Finish">
        {fins.map((f) => <option value={f}>{finishName(f)}</option>)}
      </select>
      {target === "collection" && <span class="money"><span>€</span><input inputMode="decimal" placeholder="paid" value={it.price}
        onInput={(e) => upd(it.id, { price: (e.target as HTMLInputElement).value })} aria-label="Price paid each" /></span>}
    </>
  );
  return (
    <div class="group form">
      <div class="f-row"><span>Copies</span><Stepper value={it.qty} onChange={(qty) => upd(it.id, { qty })} /></div>
      <label class="f-row"><span>Language</span>
        <select class="select" value={it.lang} onChange={(e) => upd(it.id, { lang: (e.target as HTMLSelectElement).value })}>
          {LANGS.map((l) => <option value={l}>{langName(l)}</option>)}
        </select>
      </label>
      <div class="f-row stack"><span>{condLabel}</span>
        <div class="seg full">{CONDS.map((c) => <button type="button" aria-pressed={it.cond === c} onClick={() => upd(it.id, { cond: c })}>{c}</button>)}</div>
        <small>{condName(it.cond)}{target === "wants" ? " or better" : ""}</small>
      </div>
      <div class="f-row stack"><span>Finish</span>
        <div class="seg full">{fins.map((f) => <button type="button" aria-pressed={it.finish === f} onClick={() => upd(it.id, { finish: f })}>{finishName(f)}</button>)}</div>
      </div>
      {target === "collection" && (
        <label class="f-row"><span>Price paid<small>Each, optional. Change it any time later.</small></span>
          <span class="money"><span>€</span><input inputMode="decimal" placeholder="none" value={it.price} onInput={(e) => upd(it.id, { price: (e.target as HTMLInputElement).value })} /></span>
        </label>
      )}
    </div>
  );
}

function Summary({ it, target }: { it: Item; target: Target }) {
  return <>{it.qty}× · {it.lang.toUpperCase()} · {it.cond}{target === "wants" ? "+" : ""} · {finishName(it.finish)}{it.price ? ` · €${it.price}` : ""}</>;
}

// ---- the three ways to pick ---------------------------------------------------------------------
/** A: every card a row, settings inline, "set all" bar on top; the picture opens its versions. */
function PickTable({ items, upd, target, setAll }: PickProps) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div class="pl-table">
      <BulkBar target={target} setAll={setAll} items={items} />
      {items.map((it) => (
        <div class={`pl-row${open === it.id ? " open" : ""}`}>
          <button type="button" class="pl-thumb" onClick={() => setOpen(open === it.id ? null : it.id)} aria-expanded={open === it.id} aria-label={`Versions of ${it.card?.name}`}>
            <CardImage src={img(it.card, "small")} alt="" foil={it.finish === "foil"} />
          </button>
          <div class="pl-name">
            <b>{it.card?.name}</b>
            <button type="button" class="pl-link" onClick={() => setOpen(open === it.id ? null : it.id)}>
              {it.card?.set_name} · {it.card?.collector_number} {it.chosen ? "" : <em>· newest regular, change</em>}
            </button>
          </div>
          <div class="pl-fields"><Fields it={it} upd={upd} target={target} row /></div>
          {open === it.id && <div class="pl-under"><VersionStrip it={it} upd={upd} target={target} /></div>}
        </div>
      ))}
    </div>
  );
}

/** B: one card at a time, big picture, versions and settings; the next card starts with the same settings. */
function PickOne({ items, upd, target }: PickProps) {
  const [at, setAt] = useState(0);
  const it = items[Math.min(at, items.length - 1)];
  const next = () => {
    const n = items[at + 1];
    // the next card starts with the settings just used, unless it was changed already
    if (n && !n.chosen) upd(n.id, { lang: it.lang, cond: it.cond, ...(target === "wants" || finishes(n.card).includes(it.finish) ? { finish: it.finish } : {}) });
    setAt(at + 1);
  };
  if (at >= items.length) return (
    <div class="pl-recap">
      <h3>All {items.length} cards</h3>
      {items.map((x, i) => (
        <button type="button" class="pl-recap-row" onClick={() => setAt(i)}>
          <CardImage src={img(x.card, "small")} alt="" foil={x.finish === "foil"} />
          <span><b>{x.card?.name}</b><small>{x.card?.set.toUpperCase()} {x.card?.collector_number} · <Summary it={x} target={target} /></small></span>
        </button>
      ))}
    </div>
  );
  return (
    <div class="pl-one">
      <div class="pl-big"><CardImage src={img(it.card, "normal")} alt={it.card?.name ?? ""} foil={it.finish === "foil"} eager /></div>
      <div class="pl-side">
        <div class="pl-count">{at + 1} of {items.length} · from “{it.line.raw}”</div>
        <h3>{it.card?.name}</h3>
        <p class="pl-sub">{it.card?.set_name} · {it.card?.collector_number}{!it.chosen && " · newest regular, picked for you"}</p>
        <div class="group-title">Version</div>
        <VersionStrip it={it} upd={upd} target={target} />
        <div class="group-title">Settings</div>
        <Fields it={it} upd={upd} target={target} />
        <div class="pl-one-nav">
          <button class="btn" type="button" disabled={at === 0} onClick={() => setAt(at - 1)}>Back</button>
          <button class="btn" type="button" onClick={() => setAt(items.length)}>Same for the rest</button>
          <button class="btn primary" type="button" onClick={next}>{at === items.length - 1 ? "Review all" : "Next card"}</button>
        </div>
      </div>
    </div>
  );
}

/** C: a wall of the cards as picked; tap one (or tick several) to change them in the side panel. */
function PickWall({ items, upd, target, setAll }: PickProps) {
  const [sel, setSel] = useState<number[]>([]);
  const picked = items.filter((x) => sel.includes(x.id));
  const one = picked.length === 1 ? picked[0] : null;
  const toggle = (id: number, multi: boolean) => setSel(multi ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : sel[0] === id && sel.length === 1 ? [] : [id]);
  return (
    <div class={`pl-wallwrap${picked.length ? " editing" : ""}`}>
      <div>
        <p class="pl-hint">Each card is set to its newest regular version, {langName(USUAL.lang)}, {USUAL.cond}. Tap a card to change it; tick several to change them together.</p>
        <div class="pl-wall">
          {items.map((it) => (
            <div class={`pl-tile${sel.includes(it.id) ? " on" : ""}`}>
              <button type="button" class="pl-tile-card" onClick={() => toggle(it.id, false)}>
                <CardImage src={img(it.card, "normal")} alt={it.card?.name ?? ""} foil={it.finish === "foil"} />
                <span class="pl-badge">{it.qty}×</span>
              </button>
              <label class="pl-tick"><input type="checkbox" checked={sel.includes(it.id)} onChange={() => toggle(it.id, true)} aria-label={`Select ${it.card?.name}`} /></label>
              <small><b>{it.card?.set.toUpperCase()} {it.card?.collector_number}</b> · {it.lang.toUpperCase()} · {it.cond} · {finishName(it.finish)}{it.price ? ` · €${it.price}` : ""}</small>
            </div>
          ))}
        </div>
      </div>
      {picked.length > 0 && (
        <aside class="pl-panel">
          <header><b>{one ? one.card?.name : `${picked.length} cards`}</b><button class="icon-btn" type="button" onClick={() => setSel([])} aria-label="Close"><IconClose /></button></header>
          {one ? <><VersionStrip it={one} upd={upd} target={target} /><Fields it={one} upd={upd} target={target} /></>
            : <BulkBar target={target} items={picked} setAll={(p) => setAll(p, sel)} stacked />}
        </aside>
      )}
    </div>
  );
}

/** Set language, condition, finish (and price) on many cards at once. */
function BulkBar({ target, setAll, items, stacked }: { target: Target; setAll: (p: Partial<Item>) => void; items: Item[]; stacked?: boolean }) {
  const same = (k: "lang" | "cond" | "finish") => (items.every((x) => x[k] === items[0]?.[k]) ? items[0]?.[k] : "");
  return (
    <div class={`pl-bulk${stacked ? " stacked" : ""}`}>
      <span>{stacked ? "Set for all of them" : "Every card"}</span>
      <select class="select sm" value={same("lang")} onChange={(e) => setAll({ lang: (e.target as HTMLSelectElement).value })} aria-label="Language for every card">
        <option value="" disabled>Language…</option>{LANGS.map((l) => <option value={l}>{langName(l)}</option>)}
      </select>
      <select class="select sm" value={same("cond")} onChange={(e) => setAll({ cond: (e.target as HTMLSelectElement).value })} aria-label="Condition for every card">
        <option value="" disabled>Condition…</option>{CONDS.map((c) => <option value={c}>{target === "wants" ? `${c} or better` : c}</option>)}
      </select>
      <select class="select sm" value={same("finish")} onChange={(e) => setAll({ finish: (e.target as HTMLSelectElement).value })} aria-label="Finish for every card">
        <option value="" disabled>Finish…</option>
        {(target === "wants" ? ["any", "nonfoil", "foil"] : ["nonfoil", "foil"]).map((f) => <option value={f}>{finishName(f)}</option>)}
      </select>
    </div>
  );
}

interface PickProps { items: Item[]; upd: Upd; target: Target; setAll: (p: Partial<Item>, only?: number[]) => void }
const VARIANTS: [string, string, (p: PickProps) => preact.JSX.Element][] = [["A", "Table", PickTable], ["B", "One by one", PickOne], ["C", "Wall of cards", PickWall]];

// ---- the flow -----------------------------------------------------------------------------------
function Flow({ target, onClose }: { target: Target; onClose: () => void }) {
  const [step, setStep] = useState<"paste" | "check" | "pick" | "done">("paste");
  const [text, setText] = useState(() => (new URLSearchParams(location.search).has("example") ? EXAMPLE : ""));
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const variant = useVariant();
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
  const setAll = (p: Partial<Item>, only?: number[]) => setItems((xs) => xs.map((x) => {
    if (only && !only.includes(x.id)) return x;
    if (p.finish && p.finish !== "any" && !finishes(x.card).includes(p.finish)) return x;  // a finish the card doesn't have is skipped
    return { ...x, ...p };
  }));
  const Pick = (VARIANTS.find((v) => v[0] === variant) ?? VARIANTS[0])[2];
  const total = live.reduce((t, x) => t + x.qty, 0);

  return (
    <div class="pl" role="dialog" aria-modal="true" aria-label={`Paste a list into your ${where}`}>
      <header class="pl-head">
        <div>
          <h2>Paste a list</h2>
          <ol class="pl-steps">
            {[["paste", "Paste"], ["check", "Check names"], ["pick", "Versions and settings"], ["done", "Added"]].map(([k, l]) => <li aria-current={step === k ? "step" : undefined}>{l}</li>)}
          </ol>
        </div>
        <span class="pl-into">into your {where}</span>
        <button class="icon-btn" type="button" onClick={onClose} aria-label="Close"><IconClose /></button>
      </header>

      <div class="pl-body">
        {step === "paste" && (
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
                    <button class="btn sm" type="button" onClick={() => upd(it.id, { status: "unknown", card: null })}>No, another</button>
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

        {step === "pick" && <Pick items={live} upd={upd} target={target} setAll={setAll} />}

        {step === "done" && (
          <div class="pl-done">
            <h3>{total} cards added to your {where}</h3>
            <p>Prototype: nothing was saved. This is what would be sent, one edit per line:</p>
            <pre>{live.map((x) => target === "wants"
              ? `add   ${x.card?.set.toUpperCase()} ${x.card?.collector_number}  ${x.card?.name}  copies ${x.qty} · ${x.lang} · ${x.cond} or better · foil ${x.finish}`
              : `owned ${x.card?.set.toUpperCase()} ${x.card?.collector_number}  ${x.card?.name}  ×${x.qty} · ${x.lang} · ${x.cond} · ${x.finish}${x.price ? ` · paid €${x.price} each` : " · no price"}`).join("\n")}</pre>
          </div>
        )}
      </div>

      <footer class="pl-foot">
        {step === "paste" && <button class="btn primary" type="button" disabled={busy || !parse(text).length} onClick={find}>{busy ? "Finding cards…" : "Find cards"}</button>}
        {step === "check" && <>
          <button class="btn" type="button" onClick={() => setStep("paste")}>Back to the list</button>
          <button class="btn primary" type="button" disabled={unclear.length > 0} onClick={() => setStep("pick")}>{unclear.length ? `${unclear.length} left to check` : `Next: versions for ${live.length} cards`}</button>
        </>}
        {step === "pick" && <>
          <button class="btn" type="button" onClick={() => setStep("check")}>Back</button>
          <button class="btn primary" type="button" onClick={() => setStep("done")}>Add {total} {total === 1 ? "card" : "cards"} to {target === "wants" ? "the want-list" : "the collection"}</button>
        </>}
        {step === "done" && <button class="btn primary" type="button" onClick={onClose}>Done</button>}
      </footer>
      {step === "pick" && <Switcher />}
    </div>
  );
}

// ---- variant switcher (prototype only) ---------------------------------------------------------
function useVariant(): string {
  const [v, setV] = useState(() => new URLSearchParams(location.search).get("variant") ?? "A");
  useEffect(() => { const f = () => setV(new URLSearchParams(location.search).get("variant") ?? "A"); addEventListener("pl-variant", f); return () => removeEventListener("pl-variant", f); }, []);
  return v;
}
function goVariant(step: number) {
  const keys = VARIANTS.map((x) => x[0]);
  const cur = keys.indexOf(new URLSearchParams(location.search).get("variant") ?? "A");
  const u = new URL(location.href);
  u.searchParams.set("variant", keys[(cur + step + keys.length) % keys.length]);
  history.replaceState(history.state, "", u);
  dispatchEvent(new Event("pl-variant"));
}
function Switcher() {
  const v = useVariant();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") goVariant(-1); else if (e.key === "ArrowRight") goVariant(1);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  const name = VARIANTS.find((x) => x[0] === v)?.[1];
  return (
    <div class="proto-switch" role="group" aria-label="Prototype variant">
      <button type="button" onClick={() => goVariant(-1)} aria-label="Previous variant">←</button>
      <span>{v} · {name}</span>
      <button type="button" onClick={() => goVariant(1)} aria-label="Next variant">→</button>
    </div>
  );
}

/** The "Paste a list" button for a page header; opens the flow over the page. */
export function PasteButton({ to }: { to: Target }) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get("paste") === to);
  const key = useMemo(() => Math.random(), [open]);
  return (
    <>
      <button class="btn sm" type="button" onClick={() => setOpen(true)}>Paste a list</button>
      {open && <Flow key={key} target={to} onClose={() => setOpen(false)} />}
    </>
  );
}
