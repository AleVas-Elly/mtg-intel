// mtg-intel website Worker (spec D49). Serves the app, signs me in with a passkey, serves my data
// from KV to the signed-in browser, and takes new data from the GitHub jobs (ingest token).
// Small state that changes often (passkeys, the edit queue, document versions) lives in D1 (D67):
// KV's free plan allows 1,000 writes and lists a day and ran out of reads on 2026-11-06.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { b64url, fromB64url, randomToken, sameSecret, sha256Hex, sign, verify } from "./crypto";
import {
  type Account, can, docPerm, ended, isOwner, meOf, OWNER, type Perm, PERMS, PRESETS, presetOf, tidy,
  withoutDetails, withoutMoney,
} from "./people";

interface Env {
  DATA: KVNamespace;
  DB: D1Database;
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
  account?: string; // whose it is (D76); the passkeys made before are mine, "owner"
}

/** Last time a device used the site: one row per passkey, written at most every few hours. */
interface Seen { at: string; browser: string; place: Place }

const SESSION_DAYS = 180;
const CHALLENGE_MINUTES = 5;
const INVITE_MINUTES = 15; // a setup link for one of my own devices, shown as a QR code
const PERSON_INVITE_HOURS = 24; // a link sent to someone else, who may open it later (D76)
const ACTIVITY_DAYS = 90;
const DATA_KEY = /^(wants|history|live|ct-recent|ct-history|purchases|targets|prices-\d{1,2})$/;
// Want-list edits made on the site (D50): one row per waiting edit, so writes from different
// places never overwrite each other; the GitHub job reads them all and reports which are done.
const MAX_EDITS = 200;
const SEEN_HOURS = 6;
// Where these lived in KV before D67: read once to move them over, never written again.
const KV_PASSKEYS = "auth:passkeys";
const KV_EDIT_PREFIX = "edit:";
const KV_EDITS_FAILED = "edits:failed";
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

async function getMeta(env: Env, key: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

const setMeta = (env: Env, key: string, value: string) =>
  env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, value);

const savePasskey = (env: Env, p: Passkey, verb = "INSERT OR REPLACE") =>
  env.DB.prepare(`${verb} INTO passkeys (id, created, doc, account) VALUES (?, ?, ?, ?)`)
    .bind(p.id, p.created, JSON.stringify(p), p.account ?? OWNER);

const saveAccount = (env: Env, a: Account) =>
  env.DB.prepare("INSERT OR REPLACE INTO accounts (id, created, doc) VALUES (?, ?, ?)").bind(a.id, a.created, JSON.stringify(a));

async function account(env: Env, id: string): Promise<Account | null> {
  const row = await env.DB.prepare("SELECT doc FROM accounts WHERE id = ?").bind(id).first<{ doc: string }>();
  return row ? (JSON.parse(row.doc) as Account) : null;
}

async function accounts(env: Env): Promise<Account[]> {
  return (await env.DB.prepare("SELECT doc FROM accounts ORDER BY created").all<{ doc: string }>()).results
    .map((r) => JSON.parse(r.doc) as Account);
}

/** One line in the activity log (D76). */
const logged = (env: Env, who: string, what: string) =>
  env.DB.prepare("INSERT INTO activity (account, at, what) VALUES (?, ?, ?)").bind(who, new Date().toISOString(), what.slice(0, 300));

/** A quiet Telegram note to me through the timer Worker, which holds the bot token (D76). */
function notify(env: Env, ctx: ExecutionContext | null, text: string) {
  if (!env.TRIGGER) return;
  const job = env.TRIGGER.fetch("https://trigger/notify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  }).catch(() => undefined);
  if (ctx) ctx.waitUntil(job);
}

const queueEdit = (env: Env, e: Edit & { hold_until?: string }, verb = "INSERT") =>
  env.DB.prepare(`${verb} INTO edits (name, id, at, hold_until, doc) VALUES (?, ?, ?, ?, ?)`)
    .bind(`${e.at}:${e.id}`, e.id, e.at, e.hold_until ?? null, JSON.stringify(e));

/** Once, after the move to D1 (D67): the passkeys, waiting edits and failed edits still in KV come
 *  over. The KV copies stay as they were. Safe to run twice at once (rows are inserted or ignored). */
let movedFromKv = false;
async function moveFromKv(env: Env): Promise<void> {
  if (movedFromKv) return;
  if (await getMeta(env, "kv_moved")) {
    movedFromKv = true;
    return;
  }
  const keys = (await env.DATA.get<Passkey[]>(KV_PASSKEYS, "json")) || [];
  const listed = await env.DATA.list({ prefix: KV_EDIT_PREFIX });
  const edits = await Promise.all(listed.keys.map((k) => env.DATA.get<Edit & { hold_until?: string }>(k.name, "json")));
  const failed = await env.DATA.get(KV_EDITS_FAILED);
  await env.DB.batch([
    ...keys.map((p) => savePasskey(env, p, "INSERT OR IGNORE")),
    ...edits.filter((e): e is Edit => !!e).map((e) => queueEdit(env, e, "INSERT OR IGNORE")),
    ...(failed ? [env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('edits_failed', ?)").bind(failed)] : []),
    setMeta(env, "kv_moved", new Date().toISOString()),
  ]);
  movedFromKv = true;
}

async function passkeys(env: Env): Promise<Passkey[]> {
  const read = async () => (await env.DB.prepare("SELECT doc FROM passkeys ORDER BY created").all<{ doc: string }>())
    .results.map((r) => JSON.parse(r.doc) as Passkey);
  const list = await read();
  if (list.length || movedFromKv) return list;
  await moveFromKv(env);
  return read();
}

interface Who { cred: string; account: Account }

/** The passkey this browser signed in with and its account, ended or not, or null. A session ends
 *  when its passkey is removed. One D1 read per request, as before accounts. */
async function session(request: Request, env: Env): Promise<Who | null> {
  const token = await verify<{ cred: string; acct?: string; exp: number }>(env.SESSION_SECRET, readCookie(request, "sid"));
  if (!token) return null;
  if (token.acct && token.exp - SESSION_DAYS * 864e5 > Date.now() - FRESH_SESSION_MS) {
    const a = await account(env, token.acct);
    return a ? { cred: token.cred, account: a } : null;
  }
  const row = await env.DB.prepare("SELECT a.doc FROM passkeys p JOIN accounts a ON a.id = p.account WHERE p.id = ?")
    .bind(token.cred).first<{ doc: string }>();
  return row ? { cred: token.cred, account: JSON.parse(row.doc) as Account } : null;
}

/** The signed-in person whose access hasn't ended, or null. */
async function who(request: Request, env: Env): Promise<Who | null> {
  const w = await session(request, env);
  return w && !ended(w.account) ? w : null;
}

async function sessionCookie(env: Env, credential: string, acct: string): Promise<string> {
  const token = await sign(env.SESSION_SECRET, { cred: credential, acct, exp: Date.now() + SESSION_DAYS * 864e5 });
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
  await env.DB.prepare("INSERT OR REPLACE INTO seen (cred, doc) VALUES (?, ?)").bind(cred, JSON.stringify(seen)).run();
  return cookie("seen", "1", SEEN_HOURS * 3600);
}

async function devices(env: Env, current: string | null, only?: string) {
  const list = (await passkeys(env)).filter((p) => !only || (p.account ?? OWNER) === only);
  const rows = (await env.DB.prepare("SELECT cred, doc FROM seen").all<{ cred: string; doc: string }>()).results;
  const seen = new Map(rows.map((r) => [r.cred, JSON.parse(r.doc) as Seen]));
  return list.map((p) => ({
    id: p.id, device: p.device, created: p.created, browser: p.browser ?? null, place: p.place ?? null,
    app: (p.aaguid && PASSKEY_APPS[p.aaguid]) || null, seen: seen.get(p.id) ?? null, current: p.id === current,
    account: p.account ?? OWNER,
  }));
}

async function inviteUsed(env: Env, id: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM used_invites WHERE id = ?").bind(id).first());
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

/** A one-time setup link for a new passkey on `acct`. Its name travels in the link (signed, not
 *  secret) so the setup page can greet the person. */
async function invite(env: Env, origin: string, a: Pick<Account, "id" | "name"> = { id: OWNER, name: "You" }): Promise<{ url: string; expires: string }> {
  const exp = Date.now() + (a.id === OWNER ? INVITE_MINUTES * 60e3 : PERSON_INVITE_HOURS * 3600e3);
  const token = await sign(env.SESSION_SECRET, { kind: "invite", id: randomToken(12), acct: a.id, name: a.id === OWNER ? "" : a.name, exp });
  return { url: `${origin}/setup#${token}`, expires: new Date(exp).toISOString() };
}

/** A device or person's place, for the activity log and Telegram. */
const placeText = (p: Place) => [p.city, p.country].filter(Boolean).join(", ");

async function auth(request: Request, env: Env, path: string, url: URL, ctx: ExecutionContext): Promise<Response> {
  const rpID = url.hostname;
  const origin = url.origin;
  const body = request.method === "POST" || request.method === "PUT"
    ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};

  if (path === "status") {
    const w = await session(request, env);
    if (w && ended(w.account)) {
      return json({ signedIn: false, ended: w.account.expires, passkeys: 1 }, 200, { "Set-Cookie": cookie("sid", "", 0) });
    }
    // Note when each device was last here, at most every few hours (fewer writes).
    const headers: HeadersInit = w && !readCookie(request, "seen") ? { "Set-Cookie": await markSeen(request, env, w.cred) } : {};
    return json({ signedIn: w !== null, me: w ? meOf(w.account) : null, passkeys: (await passkeys(env)).length }, 200, headers);
  }

  if (path === "register/options") {
    const ticket = await verify<{ kind: string; id: string; acct?: string; exp: number }>(env.SESSION_SECRET, body.invite);
    if (!ticket || ticket.kind !== "invite" || (await inviteUsed(env, ticket.id))) {
      return json({ error: "This setup link has expired or was already used. Ask for a new one." }, 403);
    }
    const acct = ticket.acct ?? OWNER;
    const a = await account(env, acct);
    if (!a || ended(a)) return json({ error: "This access was removed or has ended." }, 403);
    const existing = (await passkeys(env)).filter((p) => (p.account ?? OWNER) === acct);
    const options = await generateRegistrationOptions({
      rpName: "mtg-intel",
      rpID,
      // each person is their own passkey user, so one device can hold mine and someone else's
      userName: acct === OWNER ? "me" : a.name,
      userDisplayName: acct === OWNER ? "mtg-intel" : `${a.name} · mtg-intel`,
      userID: new TextEncoder().encode(`mtg-intel-${acct}`) as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challenge = await sign(env.SESSION_SECRET, {
      kind: "reg", c: options.challenge, invite: ticket.id, acct, exp: Date.now() + CHALLENGE_MINUTES * 60e3,
    });
    return json(options, 200, { "Set-Cookie": cookie("chal", challenge, CHALLENGE_MINUTES * 60) });
  }

  if (path === "register/verify") {
    const chal = await verify<{ kind: string; c: string; invite: string; acct?: string; exp: number }>(
      env.SESSION_SECRET, readCookie(request, "chal"));
    if (!chal || chal.kind !== "reg" || (await inviteUsed(env, chal.invite))) {
      return json({ error: "Setup took too long. Open the link again." }, 403);
    }
    const acct = chal.acct ?? OWNER;
    const a = await account(env, acct);
    if (!a || ended(a)) return json({ error: "This access was removed or has ended." }, 403);
    const result = await verifyRegistrationResponse({
      response: body.response, expectedChallenge: chal.c, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
    }).catch((e: Error) => ({ verified: false as const, error: e.message }));
    if (!result.verified || !("registrationInfo" in result) || !result.registrationInfo) {
      return json({ error: "The passkey could not be checked. Try again." }, 400);
    }
    const { credential, aaguid } = result.registrationInfo;
    await passkeys(env);  // brings any passkeys still in KV over first
    const first = !isOwner(a) && !(await env.DB.prepare("SELECT 1 FROM passkeys WHERE account = ?").bind(acct).first());
    const where = placeText(place(request));
    const browser = browserName(request);
    await env.DB.batch([
      savePasskey(env, {
        id: credential.id, publicKey: b64url(credential.publicKey), counter: credential.counter,
        transports: credential.transports, device: deviceName(request), created: new Date().toISOString(),
        browser, place: place(request), aaguid, account: acct,
      }),
      env.DB.prepare("INSERT OR REPLACE INTO used_invites (id, until) VALUES (?, ?)").bind(chal.invite, Date.now() + PERSON_INVITE_HOURS * 3600e3 * 2),
      env.DB.prepare("DELETE FROM used_invites WHERE until < ?").bind(Date.now()),
      logged(env, acct, `${first ? "Joined" : "Added a device"}: ${deviceName(request)}, ${browser}${where ? `, ${where}` : ""}`),
    ]);
    if (!isOwner(a)) notify(env, ctx, `👤 ${a.name} ${first ? "joined mtg-intel" : "added a device"}${where ? ` from ${where}` : ""} (${browser}).`);
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", await sessionCookie(env, credential.id, acct));
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
    const a = await account(env, found.account ?? OWNER);
    if (!a) return json({ error: "This passkey isn't registered for mtg-intel.", unknown: true }, 403);
    if (ended(a)) return json({ error: `Your access to mtg-intel ended on ${a.expires!.slice(0, 10)}.` }, 403);
    const result = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: chal.c, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: found.id, publicKey: fromB64url(found.publicKey), counter: found.counter, transports: found.transports },
      requireUserVerification: false,
    }).catch(() => ({ verified: false as const }));
    if (!result.verified) return json({ error: "The passkey could not be checked. Try again." }, 403);
    const next = "authenticationInfo" in result ? result.authenticationInfo.newCounter : found.counter;
    const writes = [
      logged(env, a.id, `Signed in: ${found.device}, ${browserName(request)}${placeText(place(request)) ? `, ${placeText(place(request))}` : ""}`),
      env.DB.prepare("DELETE FROM activity WHERE at < ?").bind(new Date(Date.now() - ACTIVITY_DAYS * 864e5).toISOString()),
    ];
    if (next !== found.counter) {  // synced passkeys stay at 0: no write needed
      found.counter = next;
      writes.push(savePasskey(env, found));
    }
    await env.DB.batch(writes);
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", await sessionCookie(env, found.id, a.id));
    headers.append("Set-Cookie", cookie("chal", "", 0));
    headers.append("Set-Cookie", await markSeen(request, env, found.id));
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (path === "logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookie("sid", "", 0) });
  }

  const w = await who(request, env);
  if (!w) return json({ error: "Sign in first." }, 401);
  const me = w.account;

  // A setup link for one more device of my own (everyone may add their own devices).
  if (path === "invite" && request.method === "POST") return json(await invite(env, origin, me));

  // Devices: everyone sees and may remove their own; I see and may remove everyone's.
  if (path === "devices") return json(await devices(env, w.cred, isOwner(me) ? undefined : me.id));

  const removing = /^devices\/([A-Za-z0-9_-]{8,512})$/.exec(path);
  if (removing && request.method === "DELETE") {
    // Remove a device's passkey: it can't sign in again, and its sessions stop working.
    const list = await passkeys(env);
    const target = list.find((p) => p.id === removing[1]);
    if (!target) return json({ error: "That device was already removed." }, 404);
    const owner = target.account ?? OWNER;
    if (!isOwner(me) && owner !== me.id) return json({ error: "That isn't one of your devices." }, 403);
    if (owner === OWNER && list.filter((p) => (p.account ?? OWNER) === OWNER).length <= 1) {
      return json({ error: "This is your only device with a passkey. Add another one first." }, 409);
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM passkeys WHERE id = ?").bind(removing[1]),
      env.DB.prepare("DELETE FROM seen WHERE cred = ?").bind(removing[1]),
      logged(env, owner, `Device removed: ${target.device}${owner !== me.id ? ` (by ${me.name})` : ""}`),
    ]);
    const self = removing[1] === w.cred;
    return json({ devices: self ? [] : await devices(env, w.cred, isOwner(me) ? undefined : me.id), signedOut: self }, 200,
      self ? { "Set-Cookie": cookie("sid", "", 0) } : {});
  }

  // People (D76): only I manage them.
  if (path === "people" || path.startsWith("people/") || path === "activity") {
    if (!isOwner(me)) return json({ error: "Only the owner manages people." }, 403);
    return people(request, env, path, body, origin);
  }
  return json({ error: "Not found" }, 404);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The end of the day a person's access ends (Amsterdam is close enough to UTC for a whole day). */
const endOf = (day: string | null | undefined): string | null => (day && DAY.test(day) ? `${day}T23:59:59.000Z` : null);

function cleanName(v: unknown): string | null {
  const name = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return name || null;
}

function permsFrom(body: Record<string, any>): { perms: Account["perms"]; preset: string } {
  if (typeof body.preset === "string" && PRESETS[body.preset] && !body.perms) {
    const perms = tidy(Object.fromEntries(PRESETS[body.preset].map((p) => [p, true])));
    return { perms, preset: presetOf(perms) };
  }
  const given = (body.perms ?? {}) as Record<string, unknown>;
  const perms = tidy(Object.fromEntries(PERMS.filter((p) => given[p] === true).map((p) => [p, true])) as Partial<Record<Perm, boolean>>);
  return { perms, preset: presetOf(perms) };
}

const PERM_NAMES: Record<Perm, string> = {
  wants: "want-list", collection: "collection", money: "money", deals: "live deals", details: "deal details",
  suggest: "suggest cards", edit: "edit want-list", bought: "mark bought",
};

/** GET people, POST people (invite someone new), PUT people/<id>, DELETE people/<id>,
 *  POST people/<id>/invite (a link for one more device), GET activity[?person=<id>]. */
async function people(request: Request, env: Env, path: string, body: Record<string, any>, origin: string): Promise<Response> {
  const list = async () => {
    const all = await accounts(env);
    const devs = await devices(env, null);
    return all.map((a) => ({
      ...a, ended: ended(a),
      devices: devs.filter((d) => d.account === a.id).map(({ account: _, ...d }) => d),
    }));
  };

  if (path === "people" && request.method === "GET") return json(await list());

  if (path === "people" && request.method === "POST") {
    const name = cleanName(body.name);
    if (!name) return json({ error: "Give them a name." }, 400);
    const { perms, preset } = permsFrom(body);
    const a: Account = { id: randomToken(9), name, created: new Date().toISOString(), expires: endOf(body.ends), preset, perms };
    await env.DB.batch([saveAccount(env, a), logged(env, a.id, `Invited as ${preset === "custom" ? "custom access" : preset}${a.expires ? `, until ${a.expires.slice(0, 10)}` : ""}`)]);
    return json({ person: a, invite: await invite(env, origin, a), people: await list() });
  }

  if (path === "activity" && request.method === "GET") {
    const person = new URL(request.url).searchParams.get("person");
    const rows = person
      ? await env.DB.prepare("SELECT account, at, what FROM activity WHERE account = ? ORDER BY n DESC LIMIT 100").bind(person).all()
      : await env.DB.prepare("SELECT account, at, what FROM activity WHERE account != 'owner' ORDER BY n DESC LIMIT 100").all();
    return json(rows.results);
  }

  const m = /^people\/([A-Za-z0-9_-]{4,40})(\/invite)?$/.exec(path);
  if (!m) return json({ error: "Not found" }, 404);
  const a = await account(env, m[1]);
  if (!a) return json({ error: "That person was already removed." }, 404);

  if (m[2] && request.method === "POST") {
    if (ended(a)) return json({ error: `${a.name}'s access has ended. Give them a new end date first.` }, 409);
    return json(await invite(env, origin, a));
  }

  if (!m[2] && request.method === "PUT") {
    if (isOwner(a)) return json({ error: "Your own access can't change." }, 409);
    const next: Account = { ...a };
    const changes: string[] = [];
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) return json({ error: "Give them a name." }, 400);
      if (name !== a.name) changes.push(`renamed from ${a.name} to ${name}`);
      next.name = name;
    }
    if (body.perms !== undefined || body.preset !== undefined) {
      const { perms, preset } = permsFrom(body);
      const on = PERMS.filter((p) => perms[p] && !a.perms[p]).map((p) => PERM_NAMES[p]);
      const off = PERMS.filter((p) => !perms[p] && a.perms[p]).map((p) => PERM_NAMES[p]);
      if (on.length) changes.push(`can now: ${on.join(", ")}`);
      if (off.length) changes.push(`can no longer: ${off.join(", ")}`);
      next.perms = perms;
      next.preset = preset;
    }
    if (body.ends !== undefined) {
      next.expires = endOf(body.ends);
      if (next.expires !== a.expires) changes.push(next.expires ? `access until ${next.expires.slice(0, 10)}` : "access with no end date");
    }
    await env.DB.batch([saveAccount(env, next), ...(changes.length ? [logged(env, a.id, `Access changed: ${changes.join("; ")}`)] : [])]);
    return json(await list());
  }

  if (!m[2] && request.method === "DELETE") {
    if (isOwner(a)) return json({ error: "You can't remove yourself." }, 409);
    // Their passkeys go, so every session made with them stops at once; the log stays 90 days.
    const creds = (await env.DB.prepare("SELECT id FROM passkeys WHERE account = ?").bind(a.id).all<{ id: string }>()).results;
    await env.DB.batch([
      ...creds.map((c) => env.DB.prepare("DELETE FROM seen WHERE cred = ?").bind(c.id)),
      env.DB.prepare("DELETE FROM passkeys WHERE account = ?").bind(a.id),
      env.DB.prepare("DELETE FROM suggestions WHERE account = ?").bind(a.id),
      env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(a.id),
      logged(env, a.id, `Removed: ${a.name}`),
    ]);
    return json(await list());
  }
  return json({ error: "Not found" }, 404);
}

interface Edit { id: string; at: string; op: "add" | "update" | "remove" | "bought" | "collected" | "unbought"; key?: string; scryfall_id?: string;
  settings?: Record<string, string>; card?: Record<string, unknown>; purchase?: Record<string, string>;
  by?: string; // the account that made it on the site (D76); none for the GitHub jobs' and Telegram's
}

async function waitingEdits(env: Env): Promise<Edit[]> {
  try {
    await moveFromKv(env);
  } catch {
    // KV unavailable: the queue in D1 still works, and the move is tried again next time
  }
  return (await env.DB.prepare("SELECT doc FROM edits ORDER BY at, name").all<{ doc: string }>())
    .results.map((r) => JSON.parse(r.doc) as Edit);
}

async function failedEdits(env: Env): Promise<unknown[]> {
  const value = await getMeta(env, "edits_failed");
  return value ? (JSON.parse(value) as unknown[]) : [];
}

async function editsDoc(env: Env, viewer?: Account) {
  const doc = { ops: await waitingEdits(env), failed: (await failedEdits(env)) as Edit[] };
  if (!viewer || can(viewer, "money")) return doc;
  // without the money switch, what a waiting purchase cost stays hidden
  const hide = (e: Edit) => (e.purchase ? { ...e, purchase: { ...e.purchase, price_eur: "", cardmarket_trend_eur: "" } } : e);
  return { ops: doc.ops.map(hide), failed: doc.failed.map(hide) };
}

/** What a want-list edit was, in a few words for the activity log. */
function editText(e: Partial<Edit>): string {
  const name = (e.card?.name as string | undefined) ?? e.key?.split("|")[0] ?? "a card";
  const card = typeof e.card?.name === "string" ? e.card.name : name;
  if (e.op === "add") return `Added ${card} to the want-list`;
  if (e.op === "remove") return `Removed ${card} from the want-list`;
  if (e.op === "bought") return `Marked ${card} bought`;
  return `Changed ${card} (${Object.keys(e.settings ?? {}).join(", ") || "settings"})`;
}

/** POST /api/edits (one edit), DELETE /api/edits/<id> (undo a waiting edit), DELETE /api/edits/failed.
 *  Adding, changing and removing wishes needs the edit switch; marking bought the bought switch (D76). */
async function edits(request: Request, env: Env, rest: string, ctx: ExecutionContext): Promise<Response> {
  const w = await who(request, env);
  if (!w) return json({ error: "Sign in first." }, 401);
  const me = w.account;
  const may = can(me, "edit") || can(me, "bought");
  if (request.method === "DELETE" && rest === "failed") {
    if (!may) return json({ error: "You can only look at this want-list." }, 403);
    await env.DB.prepare("DELETE FROM meta WHERE key = 'edits_failed'").run();
    return json(await editsDoc(env, me));
  }
  if (request.method === "DELETE" && /^[A-Za-z0-9_-]{8,40}$/.test(rest)) {
    // Undo: mine, or anyone's for me
    const row = await env.DB.prepare("SELECT doc FROM edits WHERE id = ?").bind(rest).first<{ doc: string }>();
    const edit = row ? (JSON.parse(row.doc) as Edit) : null;
    if (edit && !isOwner(me) && edit.by !== me.id) return json({ error: "Only the person who made a change can undo it." }, 403);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM edits WHERE id = ?").bind(rest),
      ...(edit && !isOwner(me) ? [logged(env, me.id, `Undid: ${editText(edit)}`)] : []),
    ]);
    return json(await editsDoc(env, me));
  }
  if (request.method !== "POST" || rest) return json({ error: "Not found" }, 404);
  const body = (await request.json().catch(() => null)) as Partial<Edit> | null;
  const ok = body && (body.op === "add" ? typeof body.scryfall_id === "string" : (body.op === "update" || body.op === "remove" || body.op === "bought") && typeof body.key === "string");
  if (!ok || JSON.stringify(body).length > 4000) return json({ error: "That change isn't valid." }, 400);
  if (!can(me, body.op === "bought" ? "bought" : "edit")) {
    return json({ error: body.op === "bought" ? "You can't mark cards bought here." : "You can only look at this want-list." }, 403);
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM edits").first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_EDITS) {
    return json({ error: "Too many changes are waiting. Try again in a few minutes." }, 429);
  }
  const at = new Date().toISOString();
  const edit: Edit = { id: randomToken(12), at, op: body.op!, key: body.key, scryfall_id: body.scryfall_id,
    settings: body.settings ?? {}, card: body.card, purchase: body.purchase, by: me.id };
  await env.DB.batch([queueEdit(env, edit), ...(isOwner(me) ? [] : [logged(env, me.id, editText(edit))])]);
  if (env.TRIGGER) ctx.waitUntil(env.TRIGGER.fetch("https://trigger/wantlist", { method: "POST" }).catch(() => undefined));
  return json(await editsDoc(env, me));
}

interface Suggestion { id: string; account: string; name: string; at: string; scryfall_id: string; settings: Record<string, string>; card: Record<string, unknown> }

/** Cards someone suggested for my want-list (D76). GET: mine to answer (everyone's) or their own;
 *  POST: suggest (the suggest switch); DELETE <id>: dismiss (me) or take back (theirs);
 *  POST <id>/add: I add it, queued like any want-list edit. */
async function suggestions(request: Request, env: Env, rest: string, ctx: ExecutionContext): Promise<Response> {
  const w = await who(request, env);
  if (!w) return json({ error: "Sign in first." }, 401);
  const me = w.account;
  const listed = async () => {
    const rows = isOwner(me)
      ? await env.DB.prepare("SELECT doc FROM suggestions ORDER BY at DESC").all<{ doc: string }>()
      : await env.DB.prepare("SELECT doc FROM suggestions WHERE account = ? ORDER BY at DESC").bind(me.id).all<{ doc: string }>();
    return rows.results.map((r) => JSON.parse(r.doc) as Suggestion);
  };
  if (!rest && request.method === "GET") return json(await listed());
  if (!rest && request.method === "POST") {
    if (!can(me, "suggest") || isOwner(me)) return json({ error: "You can't suggest cards here." }, 403);
    const body = (await request.json().catch(() => null)) as Partial<Suggestion> | null;
    if (!body || typeof body.scryfall_id !== "string" || JSON.stringify(body).length > 4000) return json({ error: "That suggestion isn't valid." }, 400);
    const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE account = ?").bind(me.id).first<{ n: number }>();
    if ((waiting?.n ?? 0) >= 50) return json({ error: "50 suggestions are already waiting. Wait for some answers first." }, 429);
    const s: Suggestion = { id: randomToken(9), account: me.id, name: me.name, at: new Date().toISOString(),
      scryfall_id: body.scryfall_id, settings: body.settings ?? {}, card: body.card ?? {} };
    const card = typeof s.card.name === "string" ? s.card.name : "a card";
    const note = s.settings.note ? ` "${s.settings.note}"` : "";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO suggestions (id, account, at, doc) VALUES (?, ?, ?, ?)").bind(s.id, s.account, s.at, JSON.stringify(s)),
      logged(env, me.id, `Suggested ${card}`),
    ]);
    notify(env, ctx, `💡 ${me.name} suggested ${card}${s.card.set ? ` (${String(s.card.set).toUpperCase()} ${s.card.number ?? ""})`.replace(" )", ")") : ""}${note}. Add or dismiss it on the want-list.`);
    return json(await listed());
  }
  const m = /^([A-Za-z0-9_-]{8,20})(\/add)?$/.exec(rest);
  if (!m) return json({ error: "Not found" }, 404);
  const row = await env.DB.prepare("SELECT doc FROM suggestions WHERE id = ?").bind(m[1]).first<{ doc: string }>();
  if (!row) return json(await listed());
  const s = JSON.parse(row.doc) as Suggestion;
  const card = typeof s.card.name === "string" ? s.card.name : "a card";
  if (m[2] && request.method === "POST") {
    if (!isOwner(me)) return json({ error: "Only the owner adds suggestions." }, 403);
    const edit: Edit = { id: randomToken(12), at: new Date().toISOString(), op: "add", scryfall_id: s.scryfall_id,
      settings: s.settings, card: s.card, by: me.id };
    await env.DB.batch([
      queueEdit(env, edit),
      env.DB.prepare("DELETE FROM suggestions WHERE id = ?").bind(s.id),
      logged(env, s.account, `Suggestion added: ${card}`),
    ]);
    if (env.TRIGGER) ctx.waitUntil(env.TRIGGER.fetch("https://trigger/wantlist", { method: "POST" }).catch(() => undefined));
    return json(await listed());
  }
  if (!m[2] && request.method === "DELETE") {
    if (!isOwner(me) && s.account !== me.id) return json({ error: "That isn't your suggestion." }, 403);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM suggestions WHERE id = ?").bind(s.id),
      logged(env, s.account, isOwner(me) ? `Suggestion dismissed: ${card}` : `Took back the suggestion: ${card}`),
    ]);
    return json(await listed());
  }
  return json({ error: "Not found" }, 404);
}

/** A document for the signed-in browser. Its version is kept in D1 (D67), so the usual answer to
 *  a refresh, "not changed", costs no KV read; only a changed document is read from KV. */
async function data(request: Request, env: Env, key: string): Promise<Response> {
  const w = await who(request, env);
  if (key === "edits") {
    if (!w) return json({ error: "Sign in first." }, 401);
    return json(await editsDoc(env, w.account));
  }
  if (!DATA_KEY.test(key)) return json({ error: "Not found" }, 404);
  if (!w) return json({ error: "Sign in first." }, 401);
  const need = docPerm(key);
  // Not shared with this person: answered like a document that isn't there, so the app shows nothing (D76).
  if (need && !can(w.account, need)) return json({ error: "Not shared with you" }, 404);
  const filter = key === "purchases" && !can(w.account, "money") ? "m"
    : key === "live" && !can(w.account, "details") ? "d" : "";
  const known = await env.DB.prepare("SELECT etag, at FROM docs WHERE key = ?").bind(key).first<{ etag: string; at: string }>();
  const headersFor = (etag: string, at: string) => ({
    "Content-Type": "application/json", "Cache-Control": "private, no-cache", ETag: `"${etag}"`, "X-Updated": at,
  });
  // A filtered copy has its own version, so a browser never mixes the two.
  if (known && request.headers.get("If-None-Match") === `"${known.etag}${filter}"`) {
    return new Response(null, { status: 304, headers: headersFor(known.etag + filter, known.at) });
  }
  const { value, metadata } = await env.DATA.getWithMetadata<{ etag: string; at: string }>(key, "stream");
  if (value === null) return json({ error: "Not there yet" }, 404);
  const etag = metadata?.etag || "0";
  if (!known && metadata?.etag) {
    // A document uploaded before D67: remember its version from now on.
    await env.DB.prepare("INSERT OR IGNORE INTO docs (key, etag, at) VALUES (?, ?, ?)").bind(key, metadata.etag, metadata.at || "").run();
  }
  if (request.headers.get("If-None-Match") === `"${etag}${filter}"`) {
    await value.cancel();
    return new Response(null, { status: 304, headers: headersFor(etag + filter, metadata?.at || "") });
  }
  if (!filter) return new Response(value, { headers: headersFor(etag, metadata?.at || "") });
  const doc = JSON.parse(await new Response(value).text());
  return new Response(JSON.stringify(filter === "m" ? withoutMoney(doc) : withoutDetails(doc)), { headers: headersFor(etag + filter, metadata?.at || "") });
}

async function ingest(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const header = request.headers.get("Authorization") || "";
  if (!env.INGEST_TOKEN || !sameSecret(header, `Bearer ${env.INGEST_TOKEN}`)) return json({ error: "Forbidden" }, 403);
  if (path === "invite" && request.method === "POST") return json(await invite(env, url.origin));
  if (path === "edits" && request.method === "GET") return json(await editsDoc(env));
  if (path === "edits-add" && request.method === "POST") {
    // Purchases the deal check found in my CardTrader orders (D54): queued like edits made on the
    // site, and the run that applies them starts at once.
    const { ops } = (await request.json()) as { ops: Edit[] };
    const kinds = ["bought", "collected", "unbought"];
    if (!Array.isArray(ops) || ops.length > 500 || ops.some((o) => !kinds.includes(o.op) || JSON.stringify(o).length > 6000)) {
      return json({ error: "Not valid" }, 400);
    }
    const at = new Date().toISOString();
    const rows = ops.map((o) => ({ ...o, id: /^[A-Za-z0-9_-]{8,40}$/.test(o.id) ? o.id : randomToken(12), at }));
    if (rows.length) await env.DB.batch(rows.map((e) => queueEdit(env, e, "INSERT OR IGNORE")));
    if (env.TRIGGER && ops.length) await env.TRIGGER.fetch("https://trigger/wantlist", { method: "POST" }).catch(() => undefined);
    return json({ ok: true, added: ops.length });
  }
  if (path === "edits-applied" && request.method === "POST") {
    // The GitHub job's report: done edits leave the queue, failed ones are kept to show on the site.
    const { results } = (await request.json()) as { results: { id: string; ok: boolean; message: string }[] };
    const waiting = (await env.DB.prepare("SELECT id, doc FROM edits").all<{ id: string; doc: string }>()).results;
    const byId = new Map(waiting.map((r) => [r.id, r.doc]));
    const failed = await failedEdits(env);
    const done: D1PreparedStatement[] = [];
    for (const r of results) {
      const doc = byId.get(r.id);
      if (doc === undefined) continue;
      if (!r.ok) failed.push({ ...JSON.parse(doc), message: r.message });
      done.push(env.DB.prepare("DELETE FROM edits WHERE id = ?").bind(r.id));
    }
    if (results.some((r) => !r.ok)) done.push(setMeta(env, "edits_failed", JSON.stringify(failed.slice(-20))));
    if (done.length) await env.DB.batch(done);
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
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return json({ error: "Not JSON" }, 400);
  }
  const etag = (await sha256Hex(text)).slice(0, 16);
  const at = new Date().toISOString();
  await env.DATA.put(path, text, { metadata: { etag, at } });
  // Its version in D1 (D67), and for `live` the fast-lane list the timer Worker reads every minute.
  const rows = [env.DB.prepare("INSERT OR REPLACE INTO docs (key, etag, at) VALUES (?, ?, ?)").bind(path, etag, at)];
  if (path === "live") rows.push(setMeta(env, "fast", JSON.stringify((doc as { fast?: unknown[] }).fast ?? [])));
  await env.DB.batch(rows);
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
      if (path.startsWith("/api/auth/")) return await auth(request, env, path.slice(10), url, ctx);
      if (path === "/api/suggestions" || path.startsWith("/api/suggestions/")) return await suggestions(request, env, path.slice(17), ctx);
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
