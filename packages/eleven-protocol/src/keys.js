// Key types and derivation (protocol 3). WebCrypto only: ECDH P-256, ECDSA P-256, HKDF-SHA-256, AES-256-GCM.
import { b64uEncode } from "./b64u.js";

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const concat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) { out.set(x, o); o += x.length; }
  return out;
};

const PAIRING_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const sha256 = async (bytes) => new Uint8Array(await subtle().digest("SHA-256", bytes));
// H(x) as the spec writes it: SHA-256 as b64u (43 chars)
export const H = async (bytes) => b64uEncode(await sha256(bytes));

// MKX / PKX: ECDH P-256. MSIG / PAUTH / PACT fallback: ECDSA P-256.
export function generateKeyAgreementKeyPair({ extractable = false } = {}) {
  return subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, extractable, ["deriveBits", "deriveKey"]);
}
export function generateSigningKeyPair({ extractable = false } = {}) {
  return subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, extractable, ["sign", "verify"]);
}
// Kfid: 32 random bytes
export const generateKfid = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

// Public keys travel as SPKI DER bytes. importPublicKey makes WebCrypto validate the point is on P-256.
export async function exportPublicKey(publicKey) {
  if (publicKey.type !== "public") throw new TypeError("exportPublicKey: not a public key");
  return new Uint8Array(await subtle().exportKey("spki", publicKey));
}
export async function importPublicKey(spki, kind) {
  if (kind === "ecdh") return subtle().importKey("spki", spki, { name: "ECDH", namedCurve: "P-256" }, true, []);
  if (kind === "ecdsa") return subtle().importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  throw new TypeError("importPublicKey: kind must be 'ecdh' or 'ecdsa'");
}

// fpr = H(SPKI(MKX) || SPKI(MSIG)), the full 32 bytes (returned as raw bytes and as b64u).
export async function fingerprint(mkxSpki, msigSpki) {
  const bytes = await sha256(concat(mkxSpki, msigSpki));
  return { bytes, b64u: b64uEncode(bytes) };
}

// root = HKDF(ikm = ECDH(own private, peer public), salt = H(pairingId || secret), info = "eleven/v1/root").
// pairingId is UTF-8, secret is raw bytes, the salt is the raw 32-byte hash. `root` is returned as a
// non-extractable HKDF CryptoKey; the ECDH output never leaves WebCrypto.
export async function deriveRoot({ privateKey, peerPublicKey, pairingId, secret }) {
  if (typeof pairingId !== "string" || !PAIRING_ID.test(pairingId)) throw new TypeError("deriveRoot: bad pairingId");
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new TypeError("deriveRoot: the secret must be exactly 32 bytes");
  const ikm = await subtle().deriveKey({ name: "ECDH", public: peerPublicKey }, privateKey, { name: "HKDF" }, false, ["deriveBits"]);
  const salt = await sha256(concat(enc.encode(pairingId), secret));
  const rootBits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("eleven/v1/root") }, ikm, 256);
  return subtle().importKey("raw", rootBits, "HKDF", false, ["deriveKey", "deriveBits"]);
}

// K_m2p and K_p2m: AES-256-GCM, info = "eleven/v1/<dir>|vault|deviceId|epoch", empty salt.
// L6: each key is bound to its direction by its WebCrypto usages. The machine gets { send: K_m2p (encrypt only), recv: K_p2m
// (decrypt only) } and the phone the reverse, so a side cannot encrypt with the key it receives with, and a stolen key object
// of one direction cannot forge the other. `role` is "machine" or "phone" and is required. The key bytes are the same as before
// (the vectors do not change); only the usages do.
// v1: epoch is always 0. `extractable` exists for test vectors only; production code leaves it false.
export async function deriveMessageKeys(root, { vault, deviceId, role, epoch = 0, extractable = false }) {
  if (epoch !== 0) throw new RangeError("deriveMessageKeys: v1 supports epoch 0 only");
  if (role !== "machine" && role !== "phone") throw new TypeError('deriveMessageKeys: role must be "machine" or "phone"');
  for (const s of [vault, deviceId]) if (typeof s !== "string" || s === "" || s.includes("|")) throw new TypeError("deriveMessageKeys: bad vault or deviceId");
  const one = (dir, usages) => subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(`eleven/v1/${dir}|${vault}|${deviceId}|${epoch}`) },
    root, { name: "AES-GCM", length: 256 }, extractable, usages);
  const machine = role === "machine";
  const [send, recv] = await Promise.all([one(machine ? "m2p" : "p2m", ["encrypt"]), one(machine ? "p2m" : "m2p", ["decrypt"])]);
  return { send, recv };
}
