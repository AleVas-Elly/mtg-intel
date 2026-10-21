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
}

interface Passkey {
  id: string;
  publicKey: string; // base64url
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  device: string;
  created: string;
}

const SESSION_DAYS = 180;
const CHALLENGE_MINUTES = 5;
const INVITE_MINUTES = 15;
const DATA_KEY = /^(wants|history|live|ct-recent|ct-history|prices-\d{1,2})$/;
const PASSKEYS = "auth:passkeys";

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

async function signedIn(request: Request, env: Env): Promise<boolean> {
  return (await verify(env.SESSION_SECRET, readCookie(request, "sid"))) !== null;
}

async function session(env: Env, credential: string): Promise<string> {
  const token = await sign(env.SESSION_SECRET, { cred: credential, exp: Date.now() + SESSION_DAYS * 864e5 });
  return cookie("sid", token, SESSION_DAYS * 86400);
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
    return json({ signedIn: await signedIn(request, env), passkeys: (await passkeys(env)).length });
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
    const { credential } = result.registrationInfo;
    const list = (await passkeys(env)).filter((p) => p.id !== credential.id);
    list.push({
      id: credential.id, publicKey: b64url(credential.publicKey), counter: credential.counter,
      transports: credential.transports, device: deviceName(request), created: new Date().toISOString(),
    });
    await env.DATA.put(PASSKEYS, JSON.stringify(list));
    await env.DATA.put(`auth:used:${chal.invite}`, "1", { expirationTtl: INVITE_MINUTES * 60 * 2 });
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", await session(env, credential.id));
    headers.append("Set-Cookie", cookie("chal", "", 0));
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
    if (!found) return json({ error: "This passkey isn't registered for mtg-intel." }, 403);
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
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (!(await signedIn(request, env))) return json({ error: "Sign in first." }, 401);

  if (path === "invite" && request.method === "POST") return json(await invite(env, origin));

  if (path === "devices") {
    return json((await passkeys(env)).map(({ id, device, created }) => ({ id: id.slice(0, 8), device, created })));
  }

  if (path === "logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookie("sid", "", 0) });
  }
  return json({ error: "Not found" }, 404);
}

async function data(request: Request, env: Env, key: string): Promise<Response> {
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
      if (path.startsWith("/sym/")) return await symbol(request, path.slice(5), ctx);
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Something went wrong on the server.", detail: String(e) }, 500);
    }
    const response = await env.ASSETS.fetch(request);
    if (/^\/assets\//.test(path) && response.ok) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
