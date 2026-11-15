// Self-check for push.ts (spec D88): decrypt our own message the way a phone would (RFC 8291),
// and verify the VAPID signature. Run: npm run check:push
import { b64url, fromB64url } from "./crypto";
import { encrypt, vapid } from "./push";

const te = new TextEncoder();
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
  new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]), n * 8));
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
const auth = crypto.getRandomValues(new Uint8Array(16));
const message = JSON.stringify({ title: "Deal · Sheoldred", body: "24% under usual · €18.40 ✓" });
const body = await encrypt({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: b64url(uaPublic), auth: b64url(auth) } }, message);

const salt = body.slice(0, 16), rs = new DataView(body.buffer).getUint32(16), idlen = body[20];
const asPublic = body.slice(21, 21 + idlen);
const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, ua.privateKey, 256));
const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), body.slice(21 + idlen)));
console.assert(rs === 4096 && idlen === 65, "header");
console.assert(plain[plain.length - 1] === 2, "padding delimiter");
const got = new TextDecoder().decode(plain.slice(0, -1));
if (got !== message) throw new Error(`decrypted ${got}`);

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const pub = b64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
const header = await vapid("https://web.push.apple.com/3/device/abc", pub, JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)), "https://example.test");
const [, jwt] = /^vapid t=([^,]+), k=/.exec(header)!;
const [h, b, s] = jwt.split(".");
const claims = JSON.parse(new TextDecoder().decode(fromB64url(b)));
if (claims.aud !== "https://web.push.apple.com") throw new Error("aud");
if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, fromB64url(s), te.encode(`${h}.${b}`)))) throw new Error("signature");
console.log("push self-check ok");
