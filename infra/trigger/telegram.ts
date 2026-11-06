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
}

const HOLD_MINUTES = 5;
const EDIT_PREFIX = "edit:"; // the site's edit queue (index.ts)
const GUARD = "tg:bought:"; // one purchase per alert message, even with two quick taps
const MARK = "🛒 Bought";
const TIMEZONE = "Europe/Amsterdam";

type Button = { text: string; callback_data?: string; url?: string };
interface Entity { type: string; offset: number; length: number; [k: string]: unknown }
interface Message {
  message_id: number; chat: { id: number }; text?: string; entities?: Entity[];
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

/** The alert's text with a line on top (entities move with it), or without it again. */
export function withMark(m: Message, line: string | null): { text: string; entities: Entity[] } {
  let text = m.text || "";
  let entities = m.entities || [];
  if (text.startsWith(MARK)) {
    const cut = text.indexOf("\n\n") + 2;
    text = text.slice(cut);
    entities = entities.filter((e) => e.offset >= cut).map((e) => ({ ...e, offset: e.offset - cut }));
  }
  if (line) {
    const shift = line.length + 2;
    entities = [{ type: "bold", offset: 0, length: MARK.length }, ...entities.map((e) => ({ ...e, offset: e.offset + shift }))];
    text = `${line}\n\n${text}`;
  }
  return { text, entities };
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
  await call(env, "editMessageText", {
    chat_id: m.chat.id, message_id: m.message_id, ...withMark(m, line), link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: "↩️ Undo", callback_data: `u|${name.slice(EDIT_PREFIX.length)}` }], ...linkRows(m)] },
  });
  await answer(env, q, `Saved. Undo works for ${HOLD_MINUTES} minutes.`);
}

async function undo(env: TelegramEnv, q: CallbackQuery, m: Message): Promise<void> {
  const name = EDIT_PREFIX + (q.data || "").slice(2);
  const edit = await env.DATA.get<{ hold_until: string; tg: { data: string } }>(name, "json");
  const restore = async (data: string) => {
    await env.DATA.delete(`${GUARD}${m.chat.id}:${m.message_id}`);
    await call(env, "editMessageText", {
      chat_id: m.chat.id, message_id: m.message_id, ...withMark(m, null), link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "🛒 Bought it", callback_data: data }], ...linkRows(m)] },
    });
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

/** Telegram's webhook (POST /api/telegram on the website, passed on here). Only my chat counts; anything else is acknowledged and dropped. */
export async function telegramUpdate(request: Request, env: TelegramEnv): Promise<Response> {
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
    else await answer(env, q, "This button no longer works.");
  } else if (update?.message && mine(update.message)) {
    await call(env, "sendMessage", {
      chat_id: update.message.chat.id,
      text: "I only understand my buttons for now: tap 🛒 Bought it under a deal to record it.",
    });
  }
  return ok; // Telegram retries anything else
}
