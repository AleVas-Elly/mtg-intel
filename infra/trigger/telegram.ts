// The Telegram bot's buttons (spec D53). A deal alert carries "🛒 Bought it": a tap records the
// purchase of that exact copy, like Bought it on the site (D51), through the same edit queue (D50).
// The edit is held for HOLD_MINUTES so the "↩️ Undo" button that replaces it can take it back; the
// GitHub job that applies it then removes the Undo button.
//
// Telegram calls the website (`/api/telegram`, public), which hands the request to this Worker
// through its service binding: the bot token lives only here.

const encoder = new TextEncoder();

function randomToken(bytes: number): string {
  const raw = String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameSecret(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export interface TelegramEnv {
  DATA: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  CARDTRADER_TOKEN?: string; // Skip, Check now and the fast lane (D58)
}

const HOLD_MINUTES = 5;
const EDIT_PREFIX = "edit:"; // the site's edit queue (index.ts)
const GUARD = "tg:bought:"; // one purchase per alert message, even with two quick taps
const MARK = "🛒 Bought";
// The lines the bot puts on top of an alert; any of them is replaced by the next (or removed).
const MARKS = [MARK, "✅ In your CardTrader cart", "❌ Already sold"];
const TIMEZONE = "Europe/Amsterdam";

type Button = { text: string; callback_data?: string; url?: string };
interface Entity { type: string; offset: number; length: number; [k: string]: unknown }
interface Message {
  message_id: number; chat: { id: number }; text?: string; entities?: Entity[]; link_preview_options?: unknown;
  caption?: string; caption_entities?: Entity[]; photo?: { file_id: string }[]; // a deal sent as its image (D53)
  reply_markup?: { inline_keyboard: Button[][] };
}
interface CallbackQuery { id: string; data?: string; message?: Message }
interface Wish {
  key: string; name: string; set: string | null; number: string | null; scryfall_id: string | null; thumb: string | null;
  rarity: string | null; tags: string[]; set_name: string | null; lists: string[]; quantity: number; language: string;
  foil: string; finishes: string[]; cm: { trend?: number; trend_foil?: number };
}

const eur = (n: number) => `€${n.toFixed(2)}`;

/** The wish key from the button: Scryfall IDs travel without dashes to fit Telegram's 64 bytes. */
export function keyOf(card: string, language: string, foil: string): string {
  const id = /^[0-9a-f]{32}$/.test(card)
    ? `${card.slice(0, 8)}-${card.slice(8, 12)}-${card.slice(12, 16)}-${card.slice(16, 20)}-${card.slice(20)}`
    : card;
  return `${id}|${language}|${foil}`;
}

/** Cardmarket's trend for the finish bought (the site's cmTrend): the saving is measured against it. */
export function trendFor(w: Wish, foil: boolean): number | null {
  const foilOnly = w.finishes.length > 0 && !w.finishes.includes("nonfoil");
  return (foilOnly || foil ? w.cm.trend_foil : w.cm.trend) || null;
}

/** The alert's text with a line on top (entities move with it), or without it again. `strike`
 *  crosses out the alert's own first line (a copy that was already gone). */
export function withMark(m: Message, line: string | null, strike = false): { text: string; entities: Entity[] } {
  const photo = m.text === undefined;
  let text = (photo ? m.caption : m.text) || "";
  let entities = (photo ? m.caption_entities : m.entities) || [];
  if (MARKS.some((mark) => text.startsWith(mark))) {
    const cut = text.indexOf("\n\n") + 2;
    text = text.slice(cut);
    entities = entities.filter((e) => e.offset >= cut && e.type !== "strikethrough").map((e) => ({ ...e, offset: e.offset - cut }));
  }
  if (strike) {
    const end = text.indexOf("\n");
    entities = [...entities, { type: "strikethrough", offset: 0, length: end < 0 ? text.length : end }];
  }
  if (line) {
    const shift = line.length + 2;
    const bold = line.startsWith(MARK) ? MARK.length : line.length;
    entities = [{ type: "bold", offset: 0, length: bold }, ...entities.map((e) => ({ ...e, offset: e.offset + shift }))];
    text = `${line}\n\n${text}`;
  }
  return { text, entities };
}

interface Done { bought?: string; sold?: string; ended?: string; orig?: string }
const doneKey = (m: Message) => `tgimg:${m.chat.id}:${m.message_id}`;

/** The picture to show for a deal image alert once it is done (D53): its darkened "✓ BOUGHT" or
 *  grey "SOLD" version, stored by the deal check, or the original again (`orig`, remembered the
 *  first time it is swapped). Null for a text alert or one without done versions. */
async function picture(env: TelegramEnv, m: Message, kind: "bought" | "sold" | "orig"): Promise<string | null> {
  if (m.text !== undefined || !m.photo?.length) return null;
  const done = await env.DATA.get<Done>(doneKey(m), "json");
  if (!done) return null;
  if (kind !== "orig" && !done.orig) {
    done.orig = m.photo[m.photo.length - 1].file_id;
    await env.DATA.put(doneKey(m), JSON.stringify(done), { expirationTtl: 60 * 86400 });
  }
  return done[kind] ?? null;
}

/** Edit the alert: its text, or its caption when it is a photo, swapping the picture for `media`. */
function editAlert(env: TelegramEnv, m: Message, line: string | null, keyboard: Button[][],
  opts: { media?: string | null; strike?: boolean } = {}) {
  const { text, entities } = withMark(m, line, opts.strike);
  const target = { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: keyboard } };
  if (m.text === undefined && opts.media) {
    return call(env, "editMessageMedia", { ...target, media: { type: "photo", media: opts.media, caption: text, caption_entities: entities } });
  }
  if (m.text === undefined) return call(env, "editMessageCaption", { ...target, caption: text, caption_entities: entities });
  return call(env, "editMessageText", {
    ...target, text, entities, link_preview_options: m.link_preview_options ?? { is_disabled: true },
  });
}

const linkRows = (m?: Message) => (m?.reply_markup?.inline_keyboard || []).filter((row) => row.every((b) => b.url));

async function call(env: TelegramEnv, method: string, body: unknown): Promise<any> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch {
    return null;
  }
}

const answer = (env: TelegramEnv, q: CallbackQuery, text: string, alert = false) =>
  call(env, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });

async function bought(env: TelegramEnv, q: CallbackQuery, m: Message): Promise<void> {
  const [, card, language, foil, cents, grade, copyFoil, copyLanguage] = (q.data || "").split("|");
  const key = keyOf(card, language, foil);
  const guard = `${GUARD}${m.chat.id}:${m.message_id}`;
  if (await env.DATA.get(guard)) return void answer(env, q, "Already saved.");
  const wants = await env.DATA.get<{ wishes: Wish[] }>("wants", "json");
  const w = wants?.wishes.find((x) => x.key === key);
  if (!w) return void answer(env, q, "This card isn't on your want-list any more, so there's nothing to take off.", true);
  const paid = Number(cents) / 100;
  const isFoil = copyFoil === "1";
  const trend = trendFor(w, isFoil);
  const at = new Date();
  const holdUntil = new Date(at.getTime() + HOLD_MINUTES * 60e3).toISOString();
  const id = randomToken(12);
  const name = `${EDIT_PREFIX}${at.toISOString()}:${id}`;
  const edit = {
    id, at: at.toISOString(), op: "bought", key, settings: {},
    card: { name: w.name, set: w.set, number: w.number, scryfall_id: w.scryfall_id, thumb: w.thumb, rarity: w.rarity,
      tags: w.tags, set_name: w.set_name, lists: w.lists },
    purchase: {
      price_eur: paid.toFixed(2), market: "cardtrader", condition: grade, foil: isFoil ? "yes" : "no",
      language: w.language === "any" ? copyLanguage : w.language, date: at.toLocaleDateString("sv-SE", { timeZone: TIMEZONE }),
      cardmarket_trend_eur: trend ? trend.toFixed(2) : "", note: "Telegram",
    },
    hold_until: holdUntil,
    tg: { chat: m.chat.id, message: m.message_id, data: q.data, links: linkRows(m).flat() },
  };
  await env.DATA.put(name, JSON.stringify(edit), { metadata: { hold_until: holdUntil } });
  await env.DATA.put(guard, q.data!, { expirationTtl: 2 * 86400 });
  const saved = trend ? trend - paid : null;
  const line = [
    `${MARK} for ${eur(paid)}`,
    saved != null && saved > 0 ? `${eur(saved)} under Cardmarket` : "",
    w.quantity > 1 ? `${w.quantity - 1} more wanted` : "off the want-list",
  ].filter(Boolean).join(" · ");
  await editAlert(env, m, line, [[{ text: "↩️ Undo", callback_data: `u|${name.slice(EDIT_PREFIX.length)}` }], ...linkRows(m)],
    { media: await picture(env, m, "bought") });
  await answer(env, q, `Saved. Undo works for ${HOLD_MINUTES} minutes.`);
}

async function undo(env: TelegramEnv, q: CallbackQuery, m: Message): Promise<void> {
  const name = EDIT_PREFIX + (q.data || "").slice(2);
  const edit = await env.DATA.get<{ hold_until: string; tg: { data: string } }>(name, "json");
  const restore = async (data: string) => {
    await env.DATA.delete(`${GUARD}${m.chat.id}:${m.message_id}`);
    await editAlert(env, m, null, [[{ text: "🛒 Bought it", callback_data: data }], ...linkRows(m)],
      { media: await picture(env, m, "orig") });
  };
  if (edit && Date.parse(edit.hold_until) > Date.now()) {
    await env.DATA.delete(name);
    await restore(edit.tg.data);
    return void answer(env, q, "Undone: nothing was recorded.");
  }
  const started = Date.parse(name.slice(EDIT_PREFIX.length, EDIT_PREFIX.length + 24));
  const data = await env.DATA.get(`${GUARD}${m.chat.id}:${m.message_id}`);
  if (!edit && Date.now() - started < HOLD_MINUTES * 60e3 && data) {
    // Gone while still held, so never applied: it was undone on the site.
    await restore(data);
    return void answer(env, q, "It was already undone on the site.");
  }
  await call(env, "editMessageReplyMarkup", { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: linkRows(m) } });
  await answer(env, q, "Too late to undo: the purchase is saved. It's on the Bought list on the site.", true);
}

/** A demo of the "Add to cart" button (2026-11-06), before it is built: `d|ok`, `d|sold` and
 *  `d|bought` (then `d|undo`) show what the real buttons would do. Nothing touches CardTrader or the want-list. */
async function demo(env: TelegramEnv, q: CallbackQuery, m: Message): Promise<void> {
  const links = linkRows(m);
  const kind = (q.data || "").slice(2);
  const price = (((m.text ?? m.caption) || "").match(/€\d+\.\d\d/) || ["€?"])[0];
  const start = [[{ text: "🛒 Add to cart", callback_data: "d|ok" }, { text: "✅ Bought it", callback_data: "d|bought" }], ...links];
  if (kind === "undo") {
    await editAlert(env, m, null, start, { media: await picture(env, m, "orig") });
    return void answer(env, q, "Demo: undone.");
  }
  if (kind === "ok") {
    await editAlert(env, m, "✅ In your CardTrader cart · go pay there",
      [[{ text: "🧾 Open cart", url: "https://www.cardtrader.com/cart/edit" }, { text: "✅ Bought it", callback_data: "d|bought" }], ...links]);
    return void answer(env, q, "Demo: added to your CardTrader cart.");
  }
  if (kind === "bought") {
    await editAlert(env, m, `${MARK} for ${price} · off the want-list`, [[{ text: "↩️ Undo", callback_data: "d|undo" }], ...links],
      { media: await picture(env, m, "bought") });
    return void answer(env, q, "Demo: saved. Undo works for 5 minutes.");
  }
  await editAlert(env, m, "❌ Already sold: CardTrader's list was out of date", links,
    { media: await picture(env, m, "sold"), strike: true });
  await answer(env, q, "Demo: this copy is gone, so nothing was added.", true);
}

// --- Skip and Check now on a live deal alert (D58) -------------------------------------------------

const CT_API = "https://api.cardtrader.com/api/v2";
const NEEDS_TOKEN = "This button needs your CardTrader token in the timer once: run `npx wrangler secret put CARDTRADER_TOKEN` in infra/trigger.";
// Lines the deal check writes under the copy line; the first such line (after the card's own line) is the status.
const STATUS = ["🛒", "⚠️", "⏳", "❌", "✕", "⏹", "✅ Bought", "⬇️", "✓"];

export async function cardtrader(env: TelegramEnv, method: string, path: string, body?: unknown): Promise<any> {
  try {
    const r = await fetch(`${CT_API}${path}`, {
      method, headers: { Authorization: `Bearer ${env.CARDTRADER_TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const cartItems = (cart: any): Map<number, number> =>
  new Map((cart?.subcarts || []).flatMap((s: any) => (s.cart_items || []).map((i: any) => [Number(i.product.id), i.price_cents / 100])));

const clock = () => new Date().toLocaleTimeString("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });

/** The alert's text with its status line replaced (entities follow), its first line crossed out with `strike`. */
export function withStatus(m: Message, line: string, strike = false): { text: string; entities: Entity[] } {
  const photo = m.text === undefined;
  const text = (photo ? m.caption : m.text) || "";
  let entities = (photo ? m.caption_entities : m.entities) || [];
  const lines = text.split("\n");
  const at = lines.findIndex((l, i) => i > 0 && STATUS.some((p) => l.startsWith(p)));
  if (at < 0) return { text, entities };
  const start = lines.slice(0, at).reduce((n, l) => n + l.length + 1, 0);
  const old = lines[at].length;
  const delta = line.length - old;
  entities = entities
    .filter((e) => e.offset + e.length <= start || e.offset >= start + old)
    .map((e) => (e.offset >= start + old ? { ...e, offset: e.offset + delta } : e));
  entities.push({ type: "bold", offset: start, length: line.length });
  if (strike) entities.push({ type: "strikethrough", offset: 0, length: lines[0].length });
  lines[at] = line;
  return { text: lines.join("\n"), entities };
}

function editStatus(env: TelegramEnv, m: Message, line: string, keyboard: Button[][], opts: { media?: string | null; strike?: boolean } = {}) {
  const { text, entities } = withStatus(m, line, opts.strike);
  const target = { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: keyboard } };
  if (m.text === undefined && opts.media) {
    return call(env, "editMessageMedia", { ...target, media: { type: "photo", media: opts.media, caption: text, caption_entities: entities } });
  }
  if (m.text === undefined) return call(env, "editMessageCaption", { ...target, caption: text, caption_entities: entities });
  return call(env, "editMessageText", { ...target, text, entities, link_preview_options: m.link_preview_options ?? { is_disabled: true } });
}

/** ✕ Skip: that copy leaves my cart and the alert ends at once, in the words the next check uses too. */
async function skip(env: TelegramEnv, q: CallbackQuery, m: Message): Promise<void> {
  if (!env.CARDTRADER_TOKEN) return void answer(env, q, NEEDS_TOKEN, true);
  const pid = Number((q.data || "").split("|")[1]);
  if (cartItems(await cardtrader(env, "GET", "/cart")).has(pid)) {
    await cardtrader(env, "POST", "/cart/remove", { product_id: pid, quantity: 1 });
  }
  const done = await env.DATA.get<Done>(doneKey(m), "json");
  const links = linkRows(m).filter((row) => !row.some((b) => b.url?.includes("/cart")));  // no Pay any more
  await editStatus(env, m, "✕ You took it out of your cart", links, { media: done?.ended, strike: true });
  await answer(env, q, "Skipped: it's out of your cart, and this copy won't alert again.");
}

/** 🔄 Check now: a live look at my cart (and my Zero box, if it left the cart). */
async function checkNow(env: TelegramEnv, q: CallbackQuery, m: Message, onDeals?: () => Promise<unknown>): Promise<void> {
  if (!env.CARDTRADER_TOKEN) return void answer(env, q, NEEDS_TOKEN, true);
  const pid = Number((q.data || "").split("|")[1]);
  const items = cartItems(await cardtrader(env, "GET", "/cart"));
  if (items.has(pid)) {
    const price = items.get(pid)!;
    await editStatus(env, m, `🛒 Still in your cart · €${price.toFixed(2)} · checked ${clock()}`, m.reply_markup?.inline_keyboard || []);
    return void answer(env, q, `Still there, €${price.toFixed(2)} ✓`);
  }
  const box = (await cardtrader(env, "GET", "/ct0_box_items")) || [];
  const mine = (Array.isArray(box) ? box : []).some((b: any) => Number(b.product_id) === pid);
  if (onDeals) await onDeals().catch(() => undefined); // a full check now settles the alert
  await answer(env, q, mine ? "You bought it ✓ The alert turns BOUGHT within a couple of minutes."
    : "It's not in your cart any more: sold, or taken out. The alert updates within a couple of minutes.", !mine);
}

/** "Set €13.50" under a weekly target suggestion (D55): the wish's target changes through the edit
 *  queue, like a change made on the site, and the button turns into a tick. */
async function setTarget(env: TelegramEnv, q: CallbackQuery, m: Message, onEdit?: () => Promise<unknown>): Promise<void> {
  const [, card, language, foil, cents] = (q.data || "").split("|");
  const target = (Number(cents) / 100).toFixed(2);
  const at = new Date().toISOString();
  const id = randomToken(12);
  await env.DATA.put(`${EDIT_PREFIX}${at}:${id}`, JSON.stringify({
    id, at, op: "update", key: keyOf(card, language, foil), settings: { max_price_eur: target },
  }));
  if (onEdit) await onEdit().catch(() => undefined);
  const keyboard = (m.reply_markup?.inline_keyboard || []).map((row) => row.map((b) =>
    b.callback_data === q.data ? { text: `✓ ${b.text.replace(/^Set /, "")}`, callback_data: "x|done" } : b));
  await call(env, "editMessageReplyMarkup", { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: keyboard } });
  await answer(env, q, `Target set to €${target}. The want-list updates in a few minutes.`);
}

/** Telegram's webhook (POST /api/telegram on the website, passed on here). Only my chat counts; anything else is acknowledged and dropped. */
export async function telegramUpdate(request: Request, env: TelegramEnv, onEdit?: () => Promise<unknown>,
  onDeals?: () => Promise<unknown>): Promise<Response> {
  const ok = new Response("ok");
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || request.method !== "POST") return new Response("Not found", { status: 404 });
  const secret = await sha256Hex(`mtg-intel-webhook:${env.TELEGRAM_BOT_TOKEN}`);
  if (!sameSecret(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", secret)) return new Response("Forbidden", { status: 403 });
  const update = (await request.json().catch(() => null)) as { callback_query?: CallbackQuery; message?: Message } | null;
  const mine = (m?: Message) => !!m && String(m.chat.id) === String(env.TELEGRAM_CHAT_ID);
  const q = update?.callback_query;
  if (q && mine(q.message)) {
    if (q.data?.startsWith("b|")) await bought(env, q, q.message!);
    else if (q.data?.startsWith("u|")) await undo(env, q, q.message!);
    else if (q.data?.startsWith("d|")) await demo(env, q, q.message!);
    else if (q.data?.startsWith("t|")) await setTarget(env, q, q.message!, onEdit);
    else if (q.data === "x|done") await answer(env, q, "Already set.");
    else if (q.data?.startsWith("s|")) await skip(env, q, q.message!);
    else if (q.data?.startsWith("c|")) await checkNow(env, q, q.message!, onDeals);
    else await answer(env, q, "This button no longer works.");
  } else if (update?.message && mine(update.message)) {
    await call(env, "sendMessage", {
      chat_id: update.message.chat.id,
      text: "I only understand my buttons for now: tap 🛒 Bought it under a deal to record it.",
    });
  }
  return ok; // Telegram retries anything else
}
