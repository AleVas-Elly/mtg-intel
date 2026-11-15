// Web Push from the Worker (spec D88), with WebCrypto only: a VAPID token (RFC 8292) so the push
// service knows it's us, and the message encrypted for the device (RFC 8291, aes128gcm).

import { b64url, fromB64url } from "./crypto";

export interface Subscription { endpoint: string; keys: { p256dh: string; auth: string } }

const te = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, length * 8);
  return new Uint8Array(bits);
}

/** The message encrypted for one device: the body of the push request. */
export async function encrypt(sub: Subscription, payload: string): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // workers-types spell the field `$public`; the runtime (and the spec) want `public`
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(te.encode(payload), new Uint8Array([2])); // 2 = last (and only) record
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

/** `vapid t=…, k=…` for one push service, valid 12 hours. `privateJwk` is the VAPID key as JWK JSON. */
export async function vapid(endpoint: string, publicKey: string, privateJwk: string, subject: string): Promise<string> {
  const head = b64url(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", JSON.parse(privateJwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${publicKey}`;
}

async function topic(tag: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(tag)));
  return b64url(digest).slice(0, 32);
}

export interface Ping { title: string; body: string; url?: string; tag?: string; silent?: boolean; badge?: number }

/** Send one ping. "gone" means the device unsubscribed or the site was removed: forget it. */
export async function push(sub: Subscription, ping: Ping, env: { VAPID_PUBLIC: string; VAPID_PRIVATE: string; SITE_URL: string }): Promise<"ok" | "gone" | string> {
  const response = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapid(sub.endpoint, env.VAPID_PUBLIC, env.VAPID_PRIVATE, env.SITE_URL),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(2 * 86400),
      Urgency: ping.silent ? "low" : "high",
      // one waiting ping per tag: a newer one replaces it before it's delivered (Topic: 32 URL-safe characters)
      ...(ping.tag ? { Topic: await topic(ping.tag) } : {}),
    },
    body: await encrypt(sub, JSON.stringify(ping)),
  });
  if (response.ok) return "ok";
  if (response.status === 404 || response.status === 410) return "gone";
  return `${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`;
}
