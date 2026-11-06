// Web Push for the machine (protocol 9): the Declarative Web Push JSON the machine writes, and RFC 8291 (aes128gcm) encryption
// with node:crypto only. The relay forwards the bytes and cannot read or change them. MIT.
import crypto from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
export const PWA_ORIGIN = "https://m.eleven.rtima.org";
export const PUSH_MAX_PLAINTEXT = 3000;           // 9 step 4
const RS = 4096;                                   // record size in the header; one record is all we ever need
const ITEM = /^\d{3}-[a-z0-9-]{1,40}$/;

/** Check the keys a phone sent in push_keys. -> { p256dh: Buffer(65), auth: Buffer(16) } or null. */
export function parsePushKeys(p256dh, auth) {
  try {
    if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 100 || auth.length > 40) return null;
    const pub = unb64u(p256dh), au = unb64u(auth);
    if (pub.length !== 65 || pub[0] !== 4 || au.length !== 16) return null;
    const e = crypto.createECDH("prime256v1"); e.generateKeys();
    e.computeSecret(pub);                                        // throws unless the point is on the curve
    return { p256dh: pub, auth: au };
  } catch { return null; }
}

/**
 * RFC 8291 aes128gcm. keys = { p256dh (65 bytes), auth (16 bytes) } -> the request body (Uint8Array):
 * salt(16) || rs(4, BE) || idlen(1) || as_public(65) || AES-128-GCM(plaintext || 0x02).
 * `fixed` ({ asPrivate, salt }) is for the RFC test vector only.
 */
export function encryptWebPush(keys, plaintext, fixed) {
  const pt = Buffer.from(plaintext);
  if (pt.length > RS - 17 - 1) throw new RangeError("push payload does not fit one record");
  const as = crypto.createECDH("prime256v1");
  if (fixed?.asPrivate) as.setPrivateKey(fixed.asPrivate); else as.generateKeys();
  const asPub = as.getPublicKey();
  const secret = as.computeSecret(keys.p256dh);
  const salt = fixed?.salt ?? crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), keys.p256dh, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, keys.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([pt, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(RS, 16); head[20] = asPub.length;
  return new Uint8Array(Buffer.concat([head, asPub, body]));
}

// What goes on a lock screen is text from the ledger: no control, bidi or invisible characters, one line, cut short.
export function cleanLine(s, max) {
  const t = String(s ?? "").normalize("NFC").replace(/[\p{C}\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2060\ufeff]/gu, " ").replace(/\s+/g, " ").trim();
  return [...t].slice(0, max).join("");
}

/**
 * The Declarative Web Push JSON (9 step 4). `generic` (the phone chose generic, or there is no title) gives the fixed text and the app root.
 * -> the JSON text. `navigate` is exactly the PWA root, optionally followed by #/i/<item>.
 */
export function buildPushJson({ vault, item, title, body, reason, seq, badge, generic }) {
  const itemOk = typeof item === "string" && ITEM.test(item);
  const plain = generic || !itemOk || !cleanLine(title, 80);
  const n = {
    title: plain ? "eleven" : cleanLine(title, 80),
    body: plain ? "Something needs you" : cleanLine(body, 100) || "Needs you",
    navigate: plain || !itemOk ? `${PWA_ORIGIN}/` : `${PWA_ORIGIN}/#/i/${item}`,
    data: { v: 1, vault, ...(itemOk && !plain ? { item } : {}), reason, seq },   // generic: not even the item id travels
  };
  const json = JSON.stringify({ web_push: 8030, notification: n, ...(badge !== undefined ? { app_badge: String(badge) } : {}) });
  if (Buffer.byteLength(json) > PUSH_MAX_PLAINTEXT) throw new RangeError("push payload over 3000 bytes");
  return json;
}
