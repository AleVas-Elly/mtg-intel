// mtg-intel website Worker (spec D49). Serves the app, signs me in with a passkey, serves my data
// from KV to the signed-in browser, and takes new data from the GitHub jobs (ingest token).

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { b64url, fromB64url, randomToken, sameSecret, sha256Hex, sign, verify } from "./crypto";

interface Env {
  DATA: KVNamespace;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  INGEST_TOKEN: string;
  TRIGGER?: Fetcher; // the timer Worker (service binding): starts the GitHub workflow that applies edits
}

interface Place { city?: string; country?: string }

interface Passkey {
  id: string;
  publicKey: string; // base64url
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  device: string;
  created: string;
  browser?: string; // "Safari on macOS", at creation (passkeys made before 2026-11-06 lack it)
  place?: Place; // where it was created, from Cloudflare's guess for the IP
  aaguid?: string; // which passkey app holds it
}

/** Last time a device used the site: one KV key per passkey, written at most every few hours. */
interface Seen { at: string; browser: string; place: Place }

const SESSION_DAYS = 180;
const CHALLENGE_MINUTES = 5;
const INVITE_MINUTES = 15;
const DATA_KEY = /^(wants|history|live|ct-recent|ct-history|purchases|prices-\d{1,2})$/;
// Want-list edits made on the site (D50): one KV key per waiting edit, so writes from different
// places never overwrite each other; the GitHub job reads them all and reports which are done.
const EDIT_PREFIX = "edit:";
const EDITS_FAILED = "edits:failed";
const MAX_EDITS = 200;
const PASSKEYS = "auth:passkeys";
const SEEN_PREFIX = "auth:seen:";
const SEEN_HOURS = 6;
// A brand-new session is trusted for a moment even if this location's copy of the passkey list
// doesn't show its passkey yet; after that, a removed passkey's sessions stop working.
const FRESH_SESSION_MS = 2 * 60e3;
// Passkey apps by AAGUID (the ones I'm likely to use; others show no app name).
const PASSKEY_APPS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
};

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function passkeys(env: Env): Promise<Passkey[]> {
  return (await env.DATA.get<Passkey[]>(PASSKEYS, "json")) || [];
}

/** The passkey this browser signed in with, or null. A session ends when its passkey is removed. */
async function sessionCred(request: Request, env: Env): Promise<string | null> {
  const token = await verify<{ cred: string; exp: number }>(env.SESSION_SECRET, readCookie(request, "sid"));
  if (!token) return null;
  if (token.exp - SESSION_DAYS * 864e5 > Date.now() - FRESH_SESSION_MS) return token.cred;
  return (await passkeys(env)).some((p) => p.id === token.cred) ? token.cred : null;
}

async function signedIn(request: Request, env: Env): Promise<boolean> {
  return (await sessionCred(request, env)) !== null;
}

async function session(env: Env, credential: string): Promise<string> {
  const token = await sign(env.SESSION_SECRET, { cred: credential, exp: Date.now() + SESSION_DAYS * 864e5 });
  return cookie("sid", token, SESSION_DAYS * 86400);
}

function place(request: Request): Place {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  return { city: cf?.city || undefined, country: cf?.country || undefined };
}

function browserName(request: Request): string {
  const ua = request.headers.get("User-Agent") || "";
  const os = /iPhone/.test(ua) ? "iOS" : /iPad/.test(ua) ? "iPadOS" : /Android/.test(ua) ? "Android"
    : /Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux" : "";
  const app = /Edg[A]?\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";
  return [app, os].filter(Boolean).join(" on ") || "Unknown browser";
}

async function markSeen(request: Request, env: Env, cred: string): Promise<string> {
  const seen: Seen = { at: new Date().toISOString(), browser: browserName(request), place: place(request) };
  await env.DATA.put(SEEN_PREFIX + cred, JSON.stringify(seen));
  return cookie("seen", "1", SEEN_HOURS * 3600);
}

async function devices(env: Env, current: string | null) {
  const list = await passkeys(env);
  const seen = await Promise.all(list.map((p) => env.DATA.get<Seen>(SEEN_PREFIX + p.id, "json")));
  return list.map((p, i) => ({
    id: p.id, device: p.device, created: p.created, browser: p.browser ?? null, place: p.place ?? null,
    app: (p.aaguid && PASSKEY_APPS[p.aaguid]) || null, seen: seen[i], current: p.id === current,
  }));
}

function deviceName(request: Request): string {
  const ua = request.headers.get("User-Agent") || "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "Device";
}

async function invite(env: Env, origin: string): Promise<{ url: string; expires: string }> {
  const exp = Date.now() + INVITE_MINUTES * 60e3;
  const token = await sign(env.SESSION_SECRET, { kind: "invite", id: randomToken(12), exp });
  return { url: `${origin}/setup#${token}`, expires: new Date(exp).toISOString() };
}

async function auth(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const rpID = url.hostname;
  const origin = url.origin;
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};

  if (path === "status") {
    const cred = await sessionCred(request, env);
    // Note when each device was last here, at most every few hours (KV writes are limited).
    const headers: HeadersInit = cred && !readCookie(request, "seen") ? { "Set-Cookie": await markSeen(request, env, cred) } : {};
    return json({ signedIn: cred !== null, passkeys: (await passkeys(env)).length }, 200, headers);
  }

  if (path === "register/options") {
    const ticket = await verify<{ kind: string; id: string; exp: number }>(env.SESSION_SECRET, body.invite);
    if (!ticket || ticket.kind !== "invite" || (await env.DATA.get(`auth:used:${ticket.id}`))) {
      return json({ error: "This setup link has expired or was already used. Make a new one." }, 403);
    }
    const existing = await passkeys(env);
    const options = await generateRegistrationOptions({
      rpName: "mtg-intel",
      rpID,
      userName: "me",
      userDisplayName: "mtg-intel",
      userID: new TextEncoder().encode("mtg-intel-owner") as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challenge = await sign(env.SESSION_SECRET, {
      kind: "reg", c: options.challenge, invite: ticket.id, exp: Date.now() + CHALLENGE_MINUTES * 60e3,
    });
    return json(options, 200, { "Set-Cookie": cookie("chal", challenge, CHALLENGE_MINUTES * 60) });
  }

  if (path === "register/verify") {
    const chal = await verify<{ kind: string; c: string; invite: string; exp: number }>(
      env.SESSION_SECRET, readCookie(request, "chal"));
    if (!chal || chal.kind !== "reg" || (await env.DATA.get(`auth:used:${chal.invite}`))) {
      return json({ error: "Setup took too long. Open the link again." }, 403);
    }
    const result = await verifyRegistrationResponse({
      response: body.response, expectedChallenge: chal.c, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
    }).catch((e: Error) => ({ verified: false as const, error: e.message }));
    if (!result.verified || !("registrationInfo" in result) || !result.registrationInfo) {
      return json({ error: "The passkey could not be checked. Try again." }, 400);
    }
    const { credential, aaguid } = result.registrationInfo;
    const list = (await passkeys(env)).filter((p) => p.id !== credential.id);
    list.push({
      id: credential.id, publicKey: b64url(credential.publicKey), counter: credential.counter,
      transports: credential.transports, device: deviceName(request), created: new Date().toISOString(),
      browser: browserName(request), place: place(request), aaguid,
    });
    await env.DATA.put(PASSKEYS, JSON.stringify(list));
    await env.DATA.put(`auth:used:${chal.invite}`, "1", { expirationTtl: INVITE_MINUTES * 60 * 2 });
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", await session(env, credential.id));
    headers.append("Set-Cookie", cookie("chal", "", 0));
    headers.append("Set-Cookie", await markSeen(request, env, credential.id));
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (path === "login/options") {
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    const challenge = await sign(env.SESSION_SECRET, {
      kind: "auth", c: options.challenge, exp: Date.now() + CHALLENGE_MINUTES * 60e3,
    });
    return json(options, 200, { "Set-Cookie": cookie("chal", challenge, CHALLENGE_MINUTES * 60) });
  }

  if (path === "login/verify") {
    const chal = await verify<{ kind: string; c: string; exp: number }>(env.SESSION_SECRET, readCookie(request, "chal"));
    if (!chal || chal.kind !== "auth") return json({ error: "Sign-in took too long. Try again." }, 403);
    const list = await passkeys(env);
    const found = list.find((p) => p.id === body.response?.id);
    if (!found) return json({ error: "This passkey isn't registered for mtg-intel.", unknown: true }, 403);
    const result = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: chal.c, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: found.id, publicKey: fromB64url(found.publicKey), counter: found.counter, transports: found.transports },
      requireUserVerification: false,
    }).catch(() => ({ verified: false as const }));
    if (!result.verified) return json({ error: "The passkey could not be checked. Try again." }, 403);
    const next = "authenticationInfo" in result ? result.authenticationInfo.newCounter : found.counter;
    if (next !== found.counter) {  // synced passkeys stay at 0: no write needed
      found.counter = next;
      await env.DATA.put(PASSKEYS, JSON.stringify(list));
    }
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", await session(env, found.id));
    headers.append("Set-Cookie", cookie("chal", "", 0));
    headers.append("Set-Cookie", await markSeen(request, env, found.id));
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  const me = await sessionCred(request, env);
  if (!me) return json({ error: "Sign in first." }, 401);

  if (path === "invite" && request.method === "POST") return json(await invite(env, origin));

  if (path === "devices") return json(await devices(env, me));

  const removing = /^devices\/([A-Za-z0-9_-]{8,512})$/.exec(path);
  if (removing && request.method === "DELETE") {
    // Remove a device's passkey: it can't sign in again, and its sessions stop working.
    const list = await passkeys(env);
    if (!list.some((p) => p.id === removing[1])) return json({ error: "That device was already removed." }, 404);
    if (list.length <= 1) return json({ error: "This is the only device with a passkey. Add another one first." }, 409);
    await env.DATA.put(PASSKEYS, JSON.stringify(list.filter((p) => p.id !== removing[1])));
    await env.DATA.delete(SEEN_PREFIX + removing[1]);
    const self = removing[1] === me;
    return json({ devices: self ? [] : await devices(env, me), signedOut: self }, 200,
      self ? { "Set-Cookie": cookie("sid", "", 0) } : {});
  }

  if (path === "logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookie("sid", "", 0) });
  }
  return json({ error: "Not found" }, 404);
}

interface Edit { id: string; at: string; op: "add" | "update" | "remove" | "bought"; key?: string; scryfall_id?: string;
  settings?: Record<string, string>; card?: Record<string, unknown>; purchase?: Record<string, string> }

async function waitingEdits(env: Env): Promise<Edit[]> {
  const listed = await env.DATA.list({ prefix: EDIT_PREFIX });
  const edits = await Promise.all(listed.keys.map((k) => env.DATA.get<Edit>(k.name, "json")));
  return edits.filter((e): e is Edit => !!e).sort((a, b) => a.at.localeCompare(b.at));
}

async function editsDoc(env: Env) {
  return { ops: await waitingEdits(env), failed: (await env.DATA.get(EDITS_FAILED, "json")) ?? [] };
}

/** POST /api/edits (one edit), DELETE /api/edits/<id> (undo a waiting edit), DELETE /api/edits/failed. */
async function edits(request: Request, env: Env, rest: string, ctx: ExecutionContext): Promise<Response> {
  if (!(await signedIn(request, env))) return json({ error: "Sign in first." }, 401);
  if (request.method === "DELETE" && rest === "failed") {
    await env.DATA.delete(EDITS_FAILED);
    return json(await editsDoc(env));
  }
  if (request.method === "DELETE" && /^[A-Za-z0-9_-]{8,40}$/.test(rest)) {
    const listed = await env.DATA.list({ prefix: EDIT_PREFIX });
    const found = listed.keys.find((k) => k.name.endsWith(`:${rest}`));
    if (found) await env.DATA.delete(found.name);
    return json(await editsDoc(env));
  }
  if (request.method !== "POST" || rest) return json({ error: "Not found" }, 404);
  const body = (await request.json().catch(() => null)) as Partial<Edit> | null;
  const ok = body && (body.op === "add" ? typeof body.scryfall_id === "string" : (body.op === "update" || body.op === "remove" || body.op === "bought") && typeof body.key === "string");
  if (!ok || JSON.stringify(body).length > 4000) return json({ error: "That change isn't valid." }, 400);
  if ((await env.DATA.list({ prefix: EDIT_PREFIX })).keys.length >= MAX_EDITS) {
    return json({ error: "Too many changes are waiting. Try again in a few minutes." }, 429);
  }
  const at = new Date().toISOString();
  const edit: Edit = { id: randomToken(12), at, op: body.op!, key: body.key, scryfall_id: body.scryfall_id,
    settings: body.settings ?? {}, card: body.card, purchase: body.purchase };
  await env.DATA.put(`${EDIT_PREFIX}${at}:${edit.id}`, JSON.stringify(edit));
  if (env.TRIGGER) ctx.waitUntil(env.TRIGGER.fetch("https://trigger/wantlist", { method: "POST" }).catch(() => undefined));
  return json(await editsDoc(env));
}

async function data(request: Request, env: Env, key: string): Promise<Response> {
  if (key === "edits") {
    if (!(await signedIn(request, env))) return json({ error: "Sign in first." }, 401);
    return json(await editsDoc(env));
  }
  if (!DATA_KEY.test(key)) return json({ error: "Not found" }, 404);
  if (!(await signedIn(request, env))) return json({ error: "Sign in first." }, 401);
  const { value, metadata } = await env.DATA.getWithMetadata<{ etag: string; at: string }>(key, "stream");
  if (value === null) return json({ error: "Not there yet" }, 404);
  const etag = `"${metadata?.etag || "0"}"`;
  const headers = {
    "Content-Type": "application/json", "Cache-Control": "private, no-cache", ETag: etag,
    "X-Updated": metadata?.at || "",
  };
  if (request.headers.get("If-None-Match") === etag) {
    await value.cancel();
    return new Response(null, { status: 304, headers });
  }
  return new Response(value, { headers });
}

async function ingest(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const header = request.headers.get("Authorization") || "";
  if (!env.INGEST_TOKEN || !sameSecret(header, `Bearer ${env.INGEST_TOKEN}`)) return json({ error: "Forbidden" }, 403);
  if (path === "invite" && request.method === "POST") return json(await invite(env, url.origin));
  if (path === "edits" && request.method === "GET") return json(await editsDoc(env));
  if (path === "edits-applied" && request.method === "POST") {
    // The GitHub job's report: done edits leave the queue, failed ones are kept to show on the site.
    const { results } = (await request.json()) as { results: { id: string; ok: boolean; message: string }[] };
    const waiting = await env.DATA.list({ prefix: EDIT_PREFIX });
    const byId = new Map(waiting.keys.map((k) => [k.name.split(":").pop()!, k.name]));
    const failed: unknown[] = (await env.DATA.get(EDITS_FAILED, "json")) ?? [];
    for (const r of results) {
      const name = byId.get(r.id);
      if (!r.ok && name) failed.push({ ...(await env.DATA.get<Edit>(name, "json")), message: r.message });
      if (name) await env.DATA.delete(name);
    }
    if (results.some((r) => !r.ok)) await env.DATA.put(EDITS_FAILED, JSON.stringify(failed.slice(-20)));
    return json({ ok: true });
  }
  // Done versions of a deal alert's picture (D53): stored for 60 days, served publicly by an
  // unguessable name so Telegram can fetch them; and which ones belong to which alert message.
  const img = /^img\/([A-Za-z0-9_-]{16,64})$/.exec(path);
  if (img && request.method === "POST") {
    const body = await request.arrayBuffer();
    if (body.byteLength > 2_000_000) return json({ error: "Too large" }, 413);
    await env.DATA.put(`img:${img[1]}`, body, { expirationTtl: 60 * 86400 });
    return json({ ok: true, bytes: body.byteLength });
  }
  const link = /^tgimg\/(-?\d{1,20})\/(\d{1,12})$/.exec(path);
  if (link && request.method === "POST") {
    const map = (await request.json().catch(() => null)) as Record<string, string> | null;
    if (!map || Object.values(map).some((u) => typeof u !== "string" || !u.startsWith(url.origin + "/img/"))) {
      return json({ error: "Not valid" }, 400);
    }
    await env.DATA.put(`tgimg:${link[1]}:${link[2]}`, JSON.stringify(map), { expirationTtl: 60 * 86400 });
    return json({ ok: true });
  }
  if (!DATA_KEY.test(path)) return json({ error: "Unknown key" }, 404);
  if (request.method === "GET") {
    const value = await env.DATA.get(path, "stream");
    return value ? new Response(value, { headers: { "Content-Type": "application/json" } }) : json({ error: "Not there yet" }, 404);
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const text = await request.text();
  try {
    JSON.parse(text);
  } catch {
    return json({ error: "Not JSON" }, 400);
  }
  await env.DATA.put(path, text, { metadata: { etag: (await sha256Hex(text)).slice(0, 16), at: new Date().toISOString() } });
  return json({ ok: true, bytes: text.length });
}

/** Telegram's webhook for the bot's buttons (D53): passed to the timer Worker, which holds the bot
 *  token, checks Telegram's secret header and records the purchase. */
async function telegram(request: Request, env: Env): Promise<Response> {
  if (!env.TRIGGER || request.method !== "POST") return json({ error: "Not found" }, 404);
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  return env.TRIGGER.fetch("https://trigger/telegram", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: await request.text(),
  });
}

/** GET /img/<name>.jpg: a done version of a deal alert's picture, for Telegram (D53). */
async function doneImage(env: Env, file: string): Promise<Response> {
  const m = /^([A-Za-z0-9_-]{16,64})\.jpg$/.exec(file);
  const body = m ? await env.DATA.get(`img:${m[1]}`, "arrayBuffer") : null;
  if (!body) return new Response("Not found", { status: 404 });
  return new Response(body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** GET /p/<signed>: a card's preview page for Telegram (D53). A deal alert links here so Telegram
 *  shows the card's picture small, beside its printing and the copy's condition, language and
 *  finish. Only what a GitHub job signed with the ingest token, only Scryfall pictures. A person
 *  who opens it is sent on to the card by script, never by a meta refresh: Telegram follows those
 *  and would preview the sign-in page instead (2026-11-06). */
async function preview(env: Env, token: string): Promise<Response> {
  const p = await verify<{ kind: string; k: string; i: string; t: string; d: string; s?: string; exp: number }>(env.INGEST_TOKEN, token);
  if (!p || p.kind !== "preview" || !/^[A-Za-z0-9/_.?=-]{1,200}$/.test(p.i) || p.i.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  const card = `/wants?card=${encodeURIComponent(p.k)}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${attr(p.t)}</title>
<meta name="robots" content="noindex">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${attr(p.s || "mtg-intel")}">
<meta property="og:title" content="${attr(p.t)}">
<meta property="og:description" content="${attr(p.d)}">
<meta property="og:image" content="https://cards.scryfall.io/${attr(p.i)}">
<meta property="og:image:width" content="488"><meta property="og:image:height" content="680">
</head><body><a href="${attr(card)}">Open the card</a><script>location.replace(${JSON.stringify(card).replace(/</g, "\\u003c")})</script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}

/** Scryfall's set and mana symbol SVGs, from our own origin so CSS masks can colour them by rarity. */
async function symbol(request: Request, path: string, ctx: ExecutionContext): Promise<Response> {
  if (!/^(sets|card-symbols)\/[A-Za-z0-9_-]{1,40}\.svg$/.test(path)) return new Response("Not found", { status: 404 });
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const headers = { "User-Agent": "mtg-intel", Accept: "*/*" };
  let upstream = await fetch(`https://svgs.scryfall.io/${path}`, { headers });
  if (upstream.status === 404 && path.startsWith("sets/")) {
    // Some sets borrow another set's symbol (Secret Lair, promos): ask Scryfall which one.
    const set = await fetch(`https://api.scryfall.com/sets/${path.slice(5, -4)}`, { headers: { ...headers, Accept: "application/json" } });
    const icon = set.ok ? ((await set.json()) as { icon_svg_uri?: string }).icon_svg_uri : undefined;
    if (icon) upstream = await fetch(icon, { headers });
  }
  if (!upstream.ok) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=3600" } });
  const response = new Response(upstream.body, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=2592000, immutable" },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path.startsWith("/api/auth/")) return await auth(request, env, path.slice(10), url);
      if (path.startsWith("/api/data/")) return await data(request, env, path.slice(10));
      if (path.startsWith("/api/ingest/")) return await ingest(request, env, path.slice(12), url);
      if (path === "/api/edits" || path.startsWith("/api/edits/")) return await edits(request, env, path.slice(11), ctx);
      if (path.startsWith("/sym/")) return await symbol(request, path.slice(5), ctx);
      if (path === "/api/telegram") return await telegram(request, env);
      if (path.startsWith("/p/")) return await preview(env, path.slice(3));
      if (path.startsWith("/img/")) return await doneImage(env, path.slice(5));
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Something went wrong on the server.", detail: String(e) }, 500);
    }
    const response = await env.ASSETS.fetch(request);
    if (/^\/assets\//.test(path)) {
      // A missing build file gets the app page from the single-page fallback; answer "not found"
      // instead, and never let a browser keep that answer (it would show a blank page for a year).
      if (!response.ok || (response.headers.get("Content-Type") || "").startsWith("text/html")) {
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
