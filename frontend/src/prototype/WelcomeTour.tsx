// PROTOTYPE, throwaway (mtg-intel-docs issue 5): a member's first visit (welcome + setup) and the
// page tour, in three structurally different variants, switchable from the bar at the bottom.
// Local copy only; nothing here is saved anywhere except sessionStorage. Never merge to main.
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { go } from "../router";
import { peek } from "../api";
import type { WantsDoc } from "../types";
import "./welcome.css";

const OWNER = "Ale";
const MEMBER = "Marco";

type Variant = "A" | "B" | "C";
const NAMES: Record<Variant, string> = {
  A: "Step screens + guided spotlight",
  B: "One setup sheet + tips on each page",
  C: "Checklist on Home + try-it tasks",
};
const VARIANTS: Variant[] = ["A", "B", "C"];

// ---- tiny store (sessionStorage so a reload keeps the place) -------------------------------------
interface State {
  variant: Variant;
  phase: "welcome" | "tour" | "done";
  step: number;                       // welcome screen (A) / tour stop (A)
  theme: "auto" | "light" | "dark";
  country: string; language: string; condition: string;
  phone: "safari" | "home" | "desktop"; notif: "off" | "on";
  seenPages: string[];                // B: pages whose tips were dismissed
  tasks: string[];                    // C: tasks done
  checklistOpen: string | null;       // C
}
const FRESH = (variant: Variant): State => ({
  variant, phase: "welcome", step: 0, theme: "auto", country: "", language: "en", condition: "NM",
  phone: "safari", notif: "off", seenPages: [], tasks: [], checklistOpen: null,
});
const KEY = "proto-welcome";
let state: State = (() => {
  const asked = new URLSearchParams(location.search).get("proto") as Variant | null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null") as State | null;
    if (saved && (!asked || asked === saved.variant)) return saved;
  } catch { /* fine */ }
  return FRESH(asked && VARIANTS.includes(asked) ? asked : "A");
})();
const subs = new Set<() => void>();
function set(p: Partial<State>) {
  state = { ...state, ...p };
  try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* fine */ }
  if (p.theme) {
    if (p.theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = p.theme;
  }
  subs.forEach((f) => f());
}
function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return state;
}
function usePath(): string {
  const [p, setP] = useState(location.pathname + location.search);
  useEffect(() => {
    const t = setInterval(() => setP(location.pathname + location.search), 200);  // shortcut: polls the URL, fine for a prototype
    return () => clearInterval(t);
  }, []);
  return p;
}
const restart = (variant = state.variant) => {
  set(FRESH(variant));
  go("/", null, true);
};

// ---- shared pieces -------------------------------------------------------------------------------
const COUNTRIES = [["NL", "Netherlands"], ["IT", "Italy"], ["DE", "Germany"]];
const LANGS = [["en", "English"], ["it", "Italian"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["ja", "Japanese"]];
const CONDS = [["MT", "Mint"], ["NM", "Near mint"], ["EX", "Excellent"], ["GD", "Good"], ["LP", "Light played"]];

/** A real card's art for the welcome's colour field. */
function art(): string | undefined {
  const w = peek<WantsDoc>("wants")?.wishes.find((x) => x.image && x.tags.includes("showcase")) ?? peek<WantsDoc>("wants")?.wishes.find((x) => x.image);
  return w?.image?.replace("/normal/", "/art_crop/");
}

function Seg({ value, options, onPick, label }: { value: string; options: string[][]; onPick: (v: string) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => <button type="button" aria-pressed={value === v} onClick={() => onPick(v)}>{l}</button>)}
    </div>
  );
}

function ThemePick({ s }: { s: State }) {
  return <Seg label="Theme" value={s.theme} onPick={(v) => set({ theme: v as State["theme"] })} options={[["auto", "Match my phone"], ["light", "Light"], ["dark", "Dark"]]} />;
}

function Buying({ s, compact }: { s: State; compact?: boolean }) {
  return (
    <div class={`pw-fields${compact ? " compact" : ""}`}>
      <label><span>Where you buy from</span>
        <select class="select" value={s.country} onChange={(e) => set({ country: (e.target as HTMLSelectElement).value })}>
          <option value="">Choose your country</option>
          {COUNTRIES.map(([v, l]) => <option value={v}>{l}</option>)}
        </select>
        {!compact && <small>Prices include shipping to you, and links show sellers who ship there.</small>}
      </label>
      <label><span>Usual language</span>
        <select class="select" value={s.language} onChange={(e) => set({ language: (e.target as HTMLSelectElement).value })}>
          {LANGS.map(([v, l]) => <option value={v}>{l}</option>)}
        </select>
      </label>
      <label><span>Worst condition you'll take</span>
        <select class="select" value={s.condition} onChange={(e) => set({ condition: (e.target as HTMLSelectElement).value })}>
          {CONDS.map(([v, l]) => <option value={v}>{l}</option>)}
        </select>
        {!compact && <small>New cards start with these. You can change any card on its own.</small>}
      </label>
    </div>
  );
}

/** Notifications, with the iPhone home-screen step when it applies. The "pretend" switch is
 *  prototype-only, to see each case. */
function Notif({ s }: { s: State }) {
  return (
    <div class="pw-notif">
      <div class="pw-pretend">Pretend this is: <Seg label="Device" value={s.phone} onPick={(v) => set({ phone: v as State["phone"], notif: "off" })}
        options={[["safari", "iPhone, in Safari"], ["home", "iPhone, from home screen"], ["desktop", "A computer"]]} /></div>
      {s.phone === "safari" ? (
        <ol class="pw-steps">
          <li>Tap <b>Share</b> <span class="pw-ico">⬆︎</span> at the bottom of Safari</li>
          <li>Choose <b>Add to Home Screen</b>, then <b>Add</b></li>
          <li>Open mtg-intel from your home screen: you'll land back here</li>
        </ol>
      ) : s.notif === "on" ? (
        <p class="pw-ok">✓ Notifications are on for this {s.phone === "desktop" ? "computer" : "iPhone"}. A test ping is on its way.</p>
      ) : (
        <button class="btn primary" type="button" onClick={() => set({ notif: "on" })}>Turn on notifications</button>
      )}
      <p class="pw-small">A ping when a card you want is a deal. You choose what rings later in Settings.</p>
    </div>
  );
}

// ---- tour stops (A spotlight, B tips) -----------------------------------------------------------
interface Stop { path: string; card?: boolean; sel: string; title: string; text: string }
const firstWish = () => peek<WantsDoc>("wants")?.wishes.find((w) => w.image)?.key ?? null;
const STOPS: Stop[] = [
  { path: "/", sel: "main .hero", title: "Home", text: "Your best deal right now. The rest of today's deals are below it." },
  { path: "/search", sel: "main input[type=search]", title: "Search", text: "Any printing, by name, set or Scryfall words. Tap + on the version you want to watch it." },
  { path: "/wants", sel: "main .row", title: "Want-list", text: "Every card you're watching. Tap one to change its condition, language or target price." },
  { path: "/wants", card: true, sel: "aside.detail", title: "A card", text: "Its prices on both markets, what it usually costs, and your settings for it. Set a target and you hear when it's reached." },
  { path: "/deals", sel: "main .drop", title: "Deals", text: "A copy well under its usual price. Open it to buy on CardTrader, then tap I bought it." },
  { path: "/alerts", sel: "main .al-seg", title: "Alerts", text: "Every ping is kept here with its picture and buttons, in case you missed one." },
  { path: "/settings", sel: "main .head", title: "Settings", text: "Change your country, language, condition or notifications any time. This tour is here too." },
];
/** B: the tips each page shows on its first visit (several per page). */
const TIPS: Record<string, { sel: string; text: string }[]> = {
  "/": [{ sel: "main .hero", text: "The best deal right now." }, { sel: "nav.rail a[href='/alerts'], nav.tabbar a[href='/deals']", text: "Your Alerts." }],
  "/search": [{ sel: "main input[type=search]", text: "Search any printing." }, { sel: "main .scope", text: "Look in your lists or in every card." }],
  "/wants": [{ sel: "main .row", text: "Tap a card for its prices and settings." }, { sel: "main .filters-btn, main .side", text: "Filter by set, colour, version…" }, { sel: "main .select", text: "Sort by price, deal, name…" }],
  "/deals": [{ sel: "main .drop", text: "A deal: tap to see the copy, buy it, then I bought it." }, { sel: "main .seg", text: "Only the strongest deals." }],
  "/alerts": [{ sel: "main .al-seg", text: "Deals, and the daily digest." }],
};
function goStop(i: number) {
  const st = STOPS[i];
  go(st.path, st.card ? firstWish() : null);
}

/** The element a stop points at, once the page has drawn it (re-measured as things move). */
function useTarget(sel: string | null): DOMRect | null {
  const [r, setR] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!sel) return setR(null);
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.getClientRects().length > 0);
      const nr = el?.getBoundingClientRect() ?? null;
      setR((old) => (old && nr && Math.abs(old.top - nr.top) + Math.abs(old.left - nr.left) + Math.abs(old.width - nr.width) + Math.abs(old.height - nr.height) < 1 ? old : nr));
      requestAnimationFrame(tick);
    };
    tick();
    return () => { alive = false; };
  }, [sel]);
  return r;
}

// ---- Variant A: step screens, then a guided spotlight across the pages --------------------------
function WelcomeA({ s }: { s: State }) {
  const screens = [
    { title: `Hi ${MEMBER}.`, sub: `${OWNER} set you up. Your own want-list, your own deals, pinged to your phone when a card you want is cheap.`, body: null, next: "Set it up" },
    { title: "Light or dark?", sub: "", body: <ThemePick s={s} />, next: "Next" },
    { title: "How you buy", sub: "", body: <Buying s={s} />, next: "Next", block: !s.country },
    { title: "Pings for deals", sub: "", body: <Notif s={s} />, next: s.notif === "on" ? "Next" : "Later", },
    { title: "You're set.", sub: "One minute to see where the important buttons are?", body: null, next: "Show me around", alt: "Skip, I'll look around" },
  ];
  const sc = screens[s.step];
  const a = art();
  const next = () => s.step < screens.length - 1 ? set({ step: s.step + 1 }) : (set({ phase: "tour", step: 0 }), goStop(0));
  return (
    <div class="pw-a" role="dialog" aria-label="Welcome">
      <div class="pw-a-art" style={a ? { backgroundImage: `url(${a})` } : undefined}><span class="pw-brand">mtg-intel</span></div>
      <div class="pw-a-body" key={s.step}>
        <div class="pw-dots">{screens.map((_, i) => <i class={i === s.step ? "on" : i < s.step ? "done" : ""} />)}</div>
        <h1 class="pw-big">{sc.title}</h1>
        {sc.sub && <p class="pw-sub">{sc.sub}</p>}
        {sc.body}
        <div class="pw-actions">
          {s.step > 0 && s.step < screens.length - 1 && <button class="btn" type="button" onClick={() => set({ step: s.step - 1 })}>Back</button>}
          {sc.alt && <button class="btn" type="button" onClick={() => set({ phase: "done" })}>{sc.alt}</button>}
          <button class="btn primary" type="button" disabled={sc.block} onClick={next}>{sc.next}</button>
        </div>
      </div>
    </div>
  );
}

function Spotlight({ rect, children, pad = 8 }: { rect: DOMRect | null; children: preact.ComponentChildren; pad?: number }) {
  if (!rect) return <div class="pw-scrim" />;
  // the part of the target that is on screen
  const top = Math.max(rect.top, 8), bottom = Math.min(rect.bottom, innerHeight - 8);
  const left = Math.min(Math.max(12, rect.left), innerWidth - 352);
  const H = 210;
  const place = bottom + H < innerHeight ? { top: bottom + pad + 14, left }
    : top - H > 0 ? { bottom: innerHeight - top + pad + 14, left }
    : { bottom: Math.max(24, innerHeight - bottom + pad + 14), left: Math.min(Math.max(12, rect.left + 16), innerWidth - 352) };
  return (
    <>
      <div class="pw-hole" style={{ top: top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: bottom - top + pad * 2 }} />
      <div class="pw-callout" style={place}>{children}</div>
    </>
  );
}

function TourA({ s }: { s: State }) {
  const st = STOPS[s.step];
  const path = usePath();
  const here = location.pathname === st.path && (!st.card || path.includes("card="));
  const rect = useTarget(here ? st.sel : null);
  const to = (i: number) => { set({ step: i }); goStop(i); };
  const end = () => { set({ phase: "done" }); go("/"); };
  return (
    <div class="pw-tour">
      <Spotlight rect={rect}>
        <div class="pw-count">{s.step + 1} of {STOPS.length}</div>
        <h2>{st.title}</h2>
        <p>{st.text}</p>
        <div class="pw-actions">
          <button class="btn sm ghost" type="button" onClick={end}>End tour</button>
          {s.step > 0 && <button class="btn sm" type="button" onClick={() => to(s.step - 1)}>Back</button>}
          {s.step < STOPS.length - 1
            ? <button class="btn sm primary" type="button" onClick={() => to(s.step + 1)}>Next</button>
            : <button class="btn sm primary" type="button" onClick={end}>Done</button>}
        </div>
      </Spotlight>
    </div>
  );
}

// ---- Variant B: one setup sheet, then numbered tips on each page's first visit ------------------
function WelcomeB({ s }: { s: State }) {
  const a = art();
  return (
    <div class="pw-b-wrap">
      <div class="pw-b" role="dialog" aria-label="Welcome">
        <div class="pw-b-art" style={a ? { backgroundImage: `url(${a})` } : undefined}>
          <h1 class="pw-big">Hi {MEMBER}.</h1>
          <p>{OWNER} set you up. Check these four things and you're in.</p>
        </div>
        <div class="pw-b-body">
          <div class="pw-row"><span>Theme</span><ThemePick s={s} /></div>
          <Buying s={s} compact />
          <div class="pw-row col"><span>Pings for deals</span><Notif s={s} /></div>
          <button class="btn primary wide" type="button" disabled={!s.country} onClick={() => set({ phase: "tour" })}>{s.country ? "Let's go" : "Choose your country first"}</button>
          <p class="pw-small">Each page shows a few tips the first time you open it.</p>
        </div>
      </div>
    </div>
  );
}

function Tip({ sel, n, open, onOpen, text }: { sel: string; n: number; open: boolean; onOpen: () => void; text: string }) {
  const r = useTarget(sel);
  if (!r) return null;
  return (
    <>
      <button class={`pw-dot${open ? " open" : ""}`} type="button" style={{ top: r.top - 10, left: Math.min(r.right - 14, innerWidth - 30) }} onClick={onOpen} aria-label={`Tip ${n}`}>{n}</button>
      {open && <div class="pw-tip" style={{ top: r.top + 20, left: Math.max(12, Math.min(r.right - 260, innerWidth - 272)) }}>{text}</div>}
    </>
  );
}

function TourB({ s }: { s: State }) {
  usePath();
  const page = location.pathname;
  const [open, setOpen] = useState(0);
  useEffect(() => setOpen(0), [page]);
  const tips = TIPS[page];
  if (!tips || s.seenPages.includes(page) || new URLSearchParams(location.search).get("card")) return null;
  return (
    <div class="pw-tips">
      {tips.map((t, i) => <Tip sel={t.sel} n={i + 1} text={t.text} open={open === i} onOpen={() => setOpen(i)} />)}
      <div class="pw-tipbar">
        <span>{tips.length} tip{tips.length > 1 ? "s" : ""} on this page</span>
        {open < tips.length - 1 && <button class="btn sm" type="button" onClick={() => setOpen(open + 1)}>Next tip</button>}
        <button class="btn sm primary" type="button" onClick={() => set({ seenPages: [...s.seenPages, page] })}>Got it</button>
      </div>
    </div>
  );
}

// ---- Variant C: a checklist on Home, the tour is tasks you actually do -------------------------
const TASKS = [
  { id: "add", title: "Add a card you want", hint: "Search, then tap + on the version you want.", path: "/search", sel: "main input[type=search]" },
  { id: "card", title: "Open a card on your want-list", hint: "Tap any card: prices, settings, target.", path: "/wants", sel: "main .row" },
  { id: "deals", title: "Look at today's deals", hint: "Copies well under their usual price.", path: "/deals", sel: "main .drop" },
  { id: "alerts", title: "Find your Alerts", hint: "Every ping is kept here.", path: "/alerts", sel: "main .al-seg" },
];

/** Rendered at the top of Home (variant C only). */
export function ProtoHomeSlot() {
  const s = useStore();
  if (!LOCAL_ON || s.variant !== "C" || s.phase === "done") return null;
  const setupDone = [s.theme !== "auto" || s.checklistOpen === "theme-ok", !!s.country, s.notif === "on"];
  const items = [
    { id: "theme", title: "Light or dark", done: setupDone[0], body: <><ThemePick s={s} /><button class="btn sm" type="button" onClick={() => set({ checklistOpen: "theme-ok" })}>Keep this</button></> },
    { id: "buy", title: "How you buy", done: setupDone[1], body: <Buying s={s} /> },
    { id: "notif", title: "Pings for deals", done: setupDone[2], body: <Notif s={s} /> },
    { id: "tour", title: "Try the main things", done: s.tasks.length === TASKS.length, body: (
      <div class="pw-tasks">{TASKS.map((t) => (
        <button type="button" class={s.tasks.includes(t.id) ? "done" : ""} onClick={() => { set({ phase: "tour", checklistOpen: t.id }); go(t.path); }}>
          <i>{s.tasks.includes(t.id) ? "✓" : ""}</i><span><b>{t.title}</b><small>{t.hint}</small></span>
        </button>))}
      </div>) },
  ];
  const done = items.filter((i) => i.done).length;
  const a = art();
  return (
    <section class="pw-c" style={a ? { "--art": `url(${a})` } : undefined}>
      <div class="pw-c-head">
        <div><h2 class="pw-big sm">Welcome, {MEMBER}</h2><p>{OWNER} set you up. Four things and you're in.</p></div>
        <div class="pw-ring" style={{ "--p": done / items.length }}><span>{done}/{items.length}</span></div>
      </div>
      {items.map((it) => {
        const open = s.checklistOpen === it.id || (it.id === "theme" && s.checklistOpen === null);
        return (
          <div class={`pw-c-item${it.done ? " done" : ""}${open ? " open" : ""}`}>
            <button type="button" class="pw-c-row" onClick={() => set({ checklistOpen: open ? "" : it.id })}><i>{it.done ? "✓" : ""}</i>{it.title}</button>
            {open && <div class="pw-c-body">{it.body}</div>}
          </div>
        );
      })}
      <button class="pw-c-later" type="button" onClick={() => set({ phase: "done" })}>Hide, I'll do it later (Settings has it)</button>
    </section>
  );
}

function TourC({ s }: { s: State }) {
  const path = usePath();
  const task = TASKS.find((t) => t.id === s.checklistOpen);
  const [show, setShow] = useState(false);
  const rect = useTarget(task && show && location.pathname === task.path ? task.sel : null);
  // a task counts as done when the person actually does it
  useEffect(() => {
    if (!task || s.tasks.includes(task.id)) return;
    const done = task.id === "card" ? path.includes("card=") : task.id === "add" ? path.includes("card=sf") : location.pathname === task.path;
    if (done) set({ tasks: [...s.tasks, task.id] });
  }, [path, task?.id]);
  useEffect(() => setShow(false), [task?.id]);
  if (!task || location.pathname === "/") return null;
  const ok = s.tasks.includes(task.id);
  const nextTask = TASKS.find((t) => !s.tasks.includes(t.id) && t.id !== task.id);
  return (
    <>
      {rect && <div class="pw-pulse" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: Math.min(rect.height, 200) + 12 }} />}
      <div class={`pw-coach${ok ? " ok" : ""}`}>
        <i>{ok ? "✓" : "→"}</i>
        <span><b>{ok ? "Done!" : task.title}</b><small>{ok ? (nextTask ? `Next: ${nextTask.title.toLowerCase()}` : "That's everything.") : task.hint}</small></span>
        {!ok && <button class="btn sm" type="button" onClick={() => setShow(!show)}>{show ? "Hide" : "Show me"}</button>}
        {ok && nextTask && <button class="btn sm primary" type="button" onClick={() => { set({ checklistOpen: nextTask.id }); go(nextTask.path); }}>Next</button>}
        <button class="btn sm ghost" type="button" onClick={() => { set({ checklistOpen: "tour" }); go("/"); }}>Back to list</button>
      </div>
    </>
  );
}

// ---- the overlay + switcher ---------------------------------------------------------------------
const LOCAL_ON = ["localhost", "127.0.0.1"].includes(location.hostname);

export function WelcomeTourPrototype() {
  const s = useStore();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      const i = VARIANTS.indexOf(state.variant);
      if (e.key === "ArrowRight") restart(VARIANTS[(i + 1) % 3]);
      if (e.key === "ArrowLeft") restart(VARIANTS[(i + 2) % 3]);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  if (!LOCAL_ON) return null;
  const i = VARIANTS.indexOf(s.variant);
  return (
    <>
      {s.variant === "A" && s.phase === "welcome" && <WelcomeA s={s} />}
      {s.variant === "A" && s.phase === "tour" && <TourA s={s} />}
      {s.variant === "B" && s.phase === "welcome" && <WelcomeB s={s} />}
      {s.variant === "B" && s.phase === "tour" && <TourB s={s} />}
      {s.variant === "C" && s.phase !== "done" && <TourC s={s} />}
      <div class="pw-switch" role="toolbar" aria-label="Prototype variants">
        <button type="button" onClick={() => restart(VARIANTS[(i + 2) % 3])} aria-label="Previous variant">‹</button>
        <span><b>{s.variant}</b> {NAMES[s.variant]}</span>
        <button type="button" onClick={() => restart(VARIANTS[(i + 1) % 3])} aria-label="Next variant">›</button>
        <button type="button" class="pw-restart" onClick={() => restart()}>Restart</button>
      </div>
    </>
  );
}
