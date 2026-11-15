// The Alerts page (spec D88): everything the bot tells me, in three sections. A notification is
// a short ping; the full alert lives here (picture, both markets, live status, buttons).

import type { ComponentChildren, VNode } from "preact";
import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { send } from "../api";
import { ago, eur } from "../format";
import { go } from "../router";
import { toast } from "../toast";
import { IconOut } from "../ui/icons";

export type Section = "deals" | "digest" | "system";
interface Button { text: string; url?: string; action?: string; done?: boolean }
export interface Alert {
  id: string; section: Section; at: string; updated: string; read: boolean;
  title: string; body?: string; html?: string; picture?: string | null; buttons?: Button[][]; done?: boolean;
  card?: string; price?: number; // deals: the wish key and price (for Snooze)
}
interface Snooze { card: string; name: string; until: string | null; below: number | null }
interface AlertsDoc { alerts: Alert[]; unread: number; snoozes?: Snooze[]; message?: string }

const SECTIONS: { id: Section; label: string; empty: string }[] = [
  { id: "deals", label: "Deals", empty: "No deal alerts in the last 30 days." },
  { id: "digest", label: "Digest", empty: "The daily digest and weekly notes land here." },
  { id: "system", label: "System", empty: "Nothing wrong with the bot. Problems land here." },
];

/** The unread count, shared by the menu and the app icon. */
let unreadNow = 0;
const listeners = new Set<(n: number) => void>();
function setUnread(n: number) {
  unreadNow = n;
  listeners.forEach((f) => f(n));
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  (n ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
}
let loading: Promise<void> | null = null; // the menu and Home both ask: one request
const loadUnread = () => loading ??= send<AlertsDoc>("GET", "/api/alerts").then((d) => setUnread(d.unread)).catch(() => {}).finally(() => { loading = null; });
export function useUnread(): number {
  const [n, setN] = useState(unreadNow);
  useEffect(() => {
    listeners.add(setN);
    const load = () => { if (document.visibilityState === "visible") loadUnread(); };
    load();
    document.addEventListener("visibilitychange", load);
    return () => { listeners.delete(setN); document.removeEventListener("visibilitychange", load); };
  }, []);
  return n;
}

// --- The bot's text: Telegram's small HTML, drawn with an allow-list (never innerHTML) ---------

const KEEP: Record<string, string> = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", INS: "u", S: "s", STRIKE: "s", DEL: "s", CODE: "code", PRE: "code" };

function nodes(list: NodeListOf<ChildNode>): ComponentChildren[] {
  return [...list].map((n, i): ComponentChildren => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent;
    if (n.nodeType !== Node.ELEMENT_NODE) return null;
    const el = n as Element;
    const kids = nodes(el.childNodes);
    if (KEEP[el.tagName]) return h(KEEP[el.tagName], { key: i }, kids);
    if (el.tagName === "BR") return h("br", { key: i });
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      const ok = /^https:\/\//.test(href) || href.startsWith("/");
      return ok ? h("a", { key: i, href, target: href.startsWith("/") ? undefined : "_blank", rel: "noopener" }, kids) : kids;
    }
    if (el.tagName === "BLOCKQUOTE") {
      return el.hasAttribute("expandable")
        ? h("details", { key: i, class: "al-more" }, [h("summary", { key: "s" }, "Price trends"), h("div", { key: "d" }, kids)])
        : h("blockquote", { key: i }, kids);
    }
    return kids; // anything else: its text only
  });
}

export function RichText({ html }: { html: string }): VNode {
  const doc = useMemo(() => new DOMParser().parseFromString(`<body>${html}</body>`, "text/html"), [html]);
  return <div class="al-text">{nodes(doc.body.childNodes)}</div>;
}

// --- The page ----------------------------------------------------------------------------------

const SNOOZE_DAYS: [number, string][] = [[1, "1 day"], [3, "3 days"], [7, "1 week"], [30, "1 month"]];
const untilText = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** Snooze a card's deal alerts (D88): quiet for some days, or ring only below a price. They still show here. */
function SnoozePanel({ a, z, onSnooze, onClose }: { a: Alert; z?: Snooze; onSnooze: (body: { days?: number; below?: number } | null) => void; onClose: () => void }) {
  const [below, setBelow] = useState(a.price ? String(Math.max(0.5, Math.floor(a.price * 0.9 * 2) / 2).toFixed(2)) : "");
  const price = Number(below.replace(",", "."));
  return (
    <div class="snooze">
      <p class="snooze-what">This card's deals keep showing here; only the ping stops.</p>
      <div class="ring-opts">
        <span class="snooze-label">Quiet for</span>
        {SNOOZE_DAYS.map(([d, label]) => <button type="button" class="chip toggle" onClick={() => onSnooze({ days: d })}>{label}</button>)}
      </div>
      <form class="ring-opts" onSubmit={(e) => { e.preventDefault(); if (price > 0) onSnooze({ below: price }); }}>
        <span class="snooze-label">Ring only below</span>
        <label class="field snooze-price"><span>€</span><input inputMode="decimal" value={below} aria-label="Price in euro"
          onInput={(e) => setBelow((e.target as HTMLInputElement).value)} /></label>
        <button class="btn sm" type="submit" disabled={!(price > 0)}>Set</button>
      </form>
      <div class="ring-opts">
        {z && <button type="button" class="btn sm" onClick={() => onSnooze(null)}>Stop snoozing</button>}
        <button type="button" class="btn sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function AlertCard({ a, focus, z, onAction, onSnooze }: { a: Alert; focus: boolean; z?: Snooze; onAction: (a: Alert, action: string) => void;
  onSnooze: (a: Alert, body: { days?: number; below?: number } | null) => void }) {
  const [snoozing, setSnoozing] = useState(false);
  return (
    <article id={`al-${a.id}`} class={`al${a.read ? "" : " unread"}${a.done ? " done" : ""}${focus ? " focus" : ""}`}>
      {a.picture && <img class="al-pic" src={a.picture} alt="" loading="lazy" />}
      <div class="al-body">
        <div class="al-meta"><time dateTime={a.at}>{ago(a.at)}</time>{a.updated !== a.at && a.section === "deals" && <span> · updated {ago(a.updated)}</span>}</div>
        {a.html ? <RichText html={a.html} /> : <><h3 class="al-title">{a.title}</h3>{a.body && <p class="al-plain">{a.body}</p>}</>}
        {z && <p class="snoozed">🔕 {z.until ? `Quiet until ${untilText(z.until)}` : ""}{z.until && z.below != null ? " · " : ""}{z.below != null ? `rings only below ${eur(z.below)}` : ""}</p>}
        {(!!a.buttons?.length || a.card) && (
          <div class="al-btns">
            {(a.buttons ?? []).flat().map((b) => b.url
              ? <a class="btn sm" href={b.url} target={b.url.startsWith("/") ? undefined : "_blank"} rel="noopener">{b.text}{!b.url.startsWith("/") && <IconOut />}</a>
              : <button class="btn sm" type="button" disabled={b.done || !b.action} onClick={() => b.action && onAction(a, b.action)}>{b.text}</button>)}
            {a.card && <button class="btn sm" type="button" aria-expanded={snoozing} onClick={() => setSnoozing(!snoozing)}>{z ? "Snoozed" : "Snooze"}</button>}
          </div>
        )}
        {snoozing && a.card && <SnoozePanel a={a} z={z} onClose={() => setSnoozing(false)} onSnooze={(body) => { setSnoozing(false); onSnooze(a, body); }} />}
      </div>
    </article>
  );
}

export function Alerts({ system }: { system: boolean }) {
  const asked = new URLSearchParams(location.search).get("a");
  const [doc, setDoc] = useState<AlertsDoc | null>(null);
  const [section, setSection] = useState<Section>(() => (asked?.split(":")[0] as Section) || "deals");
  const [error, setError] = useState<string | null>(null);
  const shown = SECTIONS.filter((s) => system || s.id !== "system");
  const load = () => send<AlertsDoc>("GET", "/api/alerts").then((d) => { setDoc(d); setUnread(d.unread); setError(null); })
    .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
    const again = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);
  // the alert a notification pointed at: its section, scrolled into view
  useEffect(() => {
    const a = doc?.alerts.find((x) => x.id === asked);
    if (!a) return;
    setSection(a.section);
    requestAnimationFrame(() => document.getElementById(`al-${a.id}`)?.scrollIntoView({ block: "center" }));
  }, [doc, asked]);
  const list = (doc?.alerts ?? []).filter((a) => a.section === section);
  // what's on screen counts as read after a moment
  useEffect(() => {
    const ids = list.filter((a) => !a.read).map((a) => a.id);
    if (!ids.length) return;
    const t = setTimeout(() => send<AlertsDoc>("POST", "/api/alerts/read", { ids }).then((d) => { setDoc(d); setUnread(d.unread); }).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [section, doc]);
  const act = async (a: Alert, action: string) => {
    try {
      const d = await send<AlertsDoc>("POST", `/api/alerts/${encodeURIComponent(a.id)}/action`, { action });
      setDoc(d);
      if (d.message) toast(d.message);
    } catch (e) { toast((e as Error).message); }
  };
  const snooze = async (a: Alert, body: { days?: number; below?: number } | null) => {
    try {
      const d = body ? await send<AlertsDoc>("POST", "/api/alerts/snooze", { card: a.card, name: a.title, ...body })
        : await send<AlertsDoc>("POST", "/api/alerts/snooze/remove", { card: a.card });
      setDoc(d);
      toast(!body ? "Snooze stopped: this card's deals ring again." : body.days ? `Quiet for ${SNOOZE_DAYS.find(([n]) => n === body.days)?.[1]}. Its deals still show here.` : `This card rings only below ${eur(body.below!)}.`);
    } catch (e) { toast((e as Error).message); }
  };
  const count = (s: Section) => doc?.alerts.filter((a) => a.section === s && !a.read).length ?? 0;
  return (
    <div class="page alerts">
      <header class="head"><div><h1 class="title">Alerts</h1></div></header>
      <div class="seg al-seg" role="tablist" aria-label="Sections">
        {shown.map((s) => (
          <button type="button" role="tab" aria-selected={section === s.id} aria-pressed={section === s.id}
            onClick={() => { setSection(s.id); if (asked) go("/alerts", null, true); }}>
            {s.label}{count(s.id) > 0 && <small>{count(s.id)}</small>}
          </button>
        ))}
      </div>
      {error && <p class="err">{error}</p>}
      {doc && !list.length && <p class="hint al-empty">{SECTIONS.find((s) => s.id === section)!.empty}</p>}
      <div class="al-list">
        {list.map((a) => <AlertCard key={a.id} a={a} focus={a.id === asked} z={doc?.snoozes?.find((z) => z.card === a.card)} onAction={act} onSnooze={snooze} />)}
      </div>
    </div>
  );
}
