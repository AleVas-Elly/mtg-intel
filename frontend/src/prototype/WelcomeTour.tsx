// PROTOTYPE, throwaway (mtg-intel-docs issue 5): a member's first visit (welcome screens) and a short
// tutorial on each page the first time it opens, replayable from Settings. Round 2: the user picked
// per-page tutorials; variants B and C of round 1 are in this branch's history (a5ae4cf).
// Local copy only; nothing here is saved anywhere except sessionStorage. Never merge to main.
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { go } from "../router";
import { peek } from "../api";
import type { WantsDoc } from "../types";
import "./welcome.css";

const OWNER = "Ale";
const MEMBER = "Marco";

// ---- tiny store (sessionStorage so a reload keeps the place) -------------------------------------
interface State {
  phase: "welcome" | "done";
  step: number;
  theme: "auto" | "light" | "dark";
  country: string; language: string; condition: string;
  phone: "safari" | "home" | "desktop"; notif: "off" | "on";
  seen: string[];            // tutorials finished or skipped
  at: number;                // step inside the open tutorial
}
const FRESH = (): State => ({
  phase: "welcome", step: 0, theme: "auto", country: "", language: "en", condition: "NM",
  phone: "safari", notif: "off", seen: [], at: 0,
});
const KEY = "proto-welcome-2";
let state: State = (() => {
  try { const saved = JSON.parse(sessionStorage.getItem(KEY) || "null") as State | null; if (saved) return saved; } catch { /* fine */ }
  return FRESH();
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
const LOCAL_ON = ["localhost", "127.0.0.1"].includes(location.hostname);

// ---- welcome pieces ------------------------------------------------------------------------------
const COUNTRIES = [["NL", "Netherlands"], ["IT", "Italy"], ["DE", "Germany"]];
const LANGS = [["en", "English"], ["it", "Italian"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["ja", "Japanese"]];
const CONDS = [["MT", "Mint"], ["NM", "Near mint"], ["EX", "Excellent"], ["GD", "Good"], ["LP", "Light played"]];

/** A real card's art for the welcome's colour field. */
function art(): string | undefined {
  const ws = peek<WantsDoc>("wants")?.wishes;
  const w = ws?.find((x) => x.image && x.tags.includes("showcase")) ?? ws?.find((x) => x.image);
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
      <label><span>Usual cards language</span>
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

function Welcome({ s }: { s: State }) {
  const screens = [
    { title: `Hi ${MEMBER}.`, sub: `${OWNER} set you up. Your own want-list, your own deals, pinged to your phone when a card you want is cheap.`, body: null, next: "Set it up" },
    { title: "Light or dark?", sub: "", body: <ThemePick s={s} />, next: "Next" },
    { title: "How you buy", sub: "", body: <Buying s={s} />, next: "Next", block: !s.country },
    { title: "Pings for deals", sub: "", body: <Notif s={s} />, next: s.notif === "on" ? "Next" : "Later" },
    { title: "You're set.", sub: "Each page shows you its main buttons the first time you open it.", body: null, next: "Start" },
  ];
  const sc = screens[s.step];
  const a = art();
  const next = () => s.step < screens.length - 1 ? set({ step: s.step + 1 }) : (set({ phase: "done", at: 0 }), go("/"));
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
          <button class="btn primary" type="button" disabled={sc.block} onClick={next}>{sc.next}</button>
        </div>
      </div>
    </div>
  );
}

// ---- the tutorial on each page -------------------------------------------------------------------
interface Step { sel: string; title: string; text: string }
interface Tutorial { id: string; name: string; steps: Step[] }
/** Which tutorial belongs where: a card's pane has its own, shown the first time any card opens. */
const TUTORIALS: Tutorial[] = [
  { id: "/", name: "Home", steps: [
    { sel: "main .hero", title: "Your best deal", text: "The best deal on your want-list right now. Tap it to see the copy and buy it." },
    { sel: "main .bell, nav.rail a[href='/alerts']", title: "Alerts", text: "Every ping your phone gets is kept here, in case you missed one." },
  ] },
  { id: "/search", name: "Search", steps: [
    { sel: "main .scope", title: "Where to look", text: "Your own want-list, or every card there is." },
    { sel: "main input[type=search]", title: "Find a card", text: "Type a name, or Scryfall words like t:dragon. Tap + on the version you want to add it to your want-list." },
  ] },
  { id: "/wants", name: "Want-list", steps: [
    { sel: "main .row", title: "Your cards", text: "Every card you're watching, with its best price now. Tap one to see more or change it." },
    { sel: "main .filters-btn, main .side", title: "Filters", text: "Narrow the list by set, colour, version and more." },
    { sel: "main .select", title: "Sort", text: "Closest to a deal first, or by price or name." },
  ] },
  { id: "card", name: "A card", steps: [
    { sel: "aside.detail .markets", title: "Prices", text: "Today's price on both markets, and what this card usually costs." },
    { sel: "aside.detail .row-title .btn", title: "Your settings", text: "Change language, condition or foil, or set a target price: you get a ping when it's reached." },
    { sel: "aside.detail .btn.soft", title: "Bought it", text: "Got a copy? Tap Bought it: it moves to your collection." },
  ] },
  { id: "/deals", name: "Deals", steps: [
    { sel: "main .drop", title: "A deal", text: "A copy well under its usual price. Tap it to buy on CardTrader, then tap I bought it." },
    { sel: "main .seg", title: "Strength", text: "Show only the strongest deals." },
  ] },
  { id: "/collection", name: "Collection", steps: [
    { sel: "main .head", title: "Your collection", text: "Add cards with Import from ManaBox, or with I own this on any card in Search." },
    { sel: "main .row", title: "A card you own", text: "What it's worth today and what you paid. Tap it to see more." },
    { sel: "main .coll-tabs", title: "Owned and sold", text: "Cards you sold or traded stay here, under Sold." },
  ] },
  { id: "/alerts", name: "Alerts", steps: [
    { sel: "main .al-seg", title: "Your alerts", text: "Deals, and your daily digest. Tap a deal to buy it or to say you bought it." },
  ] },
  { id: "/dashboards", name: "Dashboards", steps: [
    { sel: "main .toolbar .seg", title: "Your numbers", text: "Your want-list or your collection: what it costs, what it's worth, what moved." },
  ] },
  { id: "/settings", name: "Settings", steps: [
    { sel: "main .pw-settings", title: "Tutorials", text: "Want to see a page's tutorial again? It's here." },
  ] },
];
const tutorialFor = (path: string) => TUTORIALS.find((t) => t.id === (new URLSearchParams(location.search).get("card") ? "card" : location.pathname));

/** The element a step points at, once the page has drawn it (re-measured as things move). */
function useTarget(sel: string | null): DOMRect | null {
  const [r, setR] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!sel) return setR(null);
    let alive = true, lastScroll = 0;
    const tick = () => {
      if (!alive) return;
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.getClientRects().length > 0);
      const nr = el?.getBoundingClientRect() ?? null;
      // bring it on screen, leaving room for the callout (retried while the page settles)
      if (el && nr && (nr.top < 0 || nr.top > innerHeight - 260) && performance.now() - lastScroll > 600) {
        lastScroll = performance.now();
        el.scrollIntoView({ block: nr.height > innerHeight / 2 ? "start" : "center" });
      }
      setR((old) => (old && nr && Math.abs(old.top - nr.top) + Math.abs(old.left - nr.left) + Math.abs(old.width - nr.width) + Math.abs(old.height - nr.height) < 1 ? old : nr));
      requestAnimationFrame(tick);
    };
    tick();
    return () => { alive = false; };
  }, [sel]);
  return r;
}

function Spotlight({ rect, children, pad = 8 }: { rect: DOMRect | null; children: preact.ComponentChildren; pad?: number }) {
  if (!rect) return null;
  const top = Math.max(rect.top, 8), bottom = Math.min(rect.bottom, innerHeight - 8);
  const maxLeft = Math.max(12, innerWidth - Math.min(340, innerWidth - 24) - 12);
  const left = Math.min(Math.max(12, rect.left), maxLeft);
  const H = 210;
  const place = bottom + H < innerHeight ? { top: bottom + pad + 14, left }
    : top - H > 0 ? { bottom: innerHeight - top + pad + 14, left }
    : { bottom: Math.max(24, innerHeight - bottom + pad + 14), left: Math.min(Math.max(12, rect.left + 16), maxLeft) };
  return (
    <>
      <div class="pw-hole" style={{ top: top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: bottom - top + pad * 2 }} />
      <div class="pw-callout" style={place}>{children}</div>
    </>
  );
}

function PageTutorial({ s }: { s: State }) {
  const path = usePath();
  const t = tutorialFor(path);
  const open = !!t && !s.seen.includes(t.id);
  const step = open ? t!.steps[Math.min(s.at, t!.steps.length - 1)] : null;
  const rect = useTarget(step?.sel ?? null);
  useEffect(() => { if (open) set({ at: 0 }); }, [t?.id]);
  if (!open || !step) return null;
  const done = () => set({ seen: [...s.seen, t!.id], at: 0 });
  const last = s.at >= t!.steps.length - 1;
  return (
    <div class="pw-tour">
      <Spotlight rect={rect}>
        {t!.steps.length > 1 && <div class="pw-count">{t!.name} · {s.at + 1} of {t!.steps.length}</div>}
        <h2>{step.title}</h2>
        <p>{step.text}</p>
        <div class="pw-actions">
          {!last && <button class="btn sm ghost" type="button" onClick={done}>Skip</button>}
          {s.at > 0 && <button class="btn sm" type="button" onClick={() => set({ at: s.at - 1 })}>Back</button>}
          <button class="btn sm primary" type="button" onClick={() => last ? done() : set({ at: s.at + 1 })}>{last ? "Got it" : "Next"}</button>
        </div>
      </Spotlight>
    </div>
  );
}

/** Settings: see the tutorials again (rendered under the Settings page). */
export function ProtoSettingsSlot() {
  const s = useStore();
  if (!LOCAL_ON) return null;
  return (
    <div class="page pw-settings-wrap">
      <div class="group-title">Page tutorials</div>
      <dl class="group pw-settings">
        {TUTORIALS.filter((t) => t.id !== "/settings").map((t) => (
          <div class="kv"><dt>{t.name}</dt><dd>
            <button class="btn sm" type="button" onClick={() => {
              set({ seen: s.seen.filter((x) => x !== t.id), at: 0 });
              if (t.id === "card") { const k = peek<WantsDoc>("wants")?.wishes.find((w) => w.image)?.key; go("/wants", k ?? null); } else go(t.id);
            }}>Show again</button>
          </dd></div>
        ))}
        <div class="kv"><dt>All pages</dt><dd><button class="btn sm" type="button" onClick={() => set({ seen: ["/settings"], at: 0 })}>Show each again next time</button></dd></div>
      </dl>
    </div>
  );
}

// ---- the overlay + prototype bar -----------------------------------------------------------------
export function WelcomeTourPrototype() {
  const s = useStore();
  if (!LOCAL_ON) return null;
  return (
    <>
      {s.phase === "welcome" ? <Welcome s={s} /> : <PageTutorial s={s} />}
      <div class="pw-switch" role="toolbar" aria-label="Prototype">
        <span>Prototype · {s.phase === "welcome" ? "welcome" : `tutorials seen ${s.seen.length}/${TUTORIALS.length}`}</span>
        <button type="button" class="pw-restart" onClick={() => { set(FRESH()); go("/", null, true); }}>Start as a new member</button>
      </div>
    </>
  );
}
