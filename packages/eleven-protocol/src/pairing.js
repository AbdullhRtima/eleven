// Pairing helpers shared by the machine (eleven-sync pair) and the phone (protocol 6). WebCrypto only: no Node-only imports, so this
// runs in a browser too.
//   - Kpair and the sealed claim / accept (6.2 steps 3 and 6). Sealed = b64u(iv(12) || ciphertext || tag).
//   - the check words (6.3), from the BIP-39 list in wordlist.js
//   - the pairing link and its fragment (6.2 step 2)
import { b64uEncode, b64uDecode } from "./b64u.js";
import { sha256 } from "./keys.js";
import { WORDS } from "./wordlist.js";

export const PAIRING_ID = /^pr_[A-Za-z0-9_-]{22}$/;
export const DEVICE_ID = /^dev_[A-Za-z0-9_-]{22}$/;
export const DEVICE_NAME = /^[A-Za-z0-9 ._'-]{1,32}$/;
const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

export async function pairKey(secret, pairingId, usage) {
  const ikm = await subtle().importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(pairingId), info: enc.encode("eleven/v1/pair") }, ikm, { name: "AES-GCM", length: 256 }, false, [usage]);
}
// `iv` exists for test vectors only (12 bytes); production code leaves it out and gets a random one.
export async function sealPairing(secret, pairingId, purpose, obj, iv = globalThis.crypto.getRandomValues(new Uint8Array(12))) {
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`eleven/v1/${purpose}|${pairingId}`) }, await pairKey(secret, pairingId, "encrypt"), enc.encode(JSON.stringify(obj))));
  return b64uEncode(concat(iv, ct));
}
export async function openSealed(secret, pairingId, purpose, sealed) {
  const raw = b64uDecode(sealed);
  if (raw.length < 12 + 16) throw new Error("sealed too short");
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: enc.encode(`eleven/v1/${purpose}|${pairingId}`) }, await pairKey(secret, pairingId, "decrypt"), raw.subarray(12));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
}

/** The claim the phone seals (6.2 step 3): the object is sealed as given (JSON.stringify, keys in the order the caller wrote them). */
export const sealClaim = (secret, pairingId, claim, iv) => sealPairing(secret, pairingId, "claim", claim, iv);
export const openClaim = (secret, pairingId, sealed) => openSealed(secret, pairingId, "claim", sealed);

const ACCEPT_FIELDS = ["machineKxPub", "machineSigPub", "vault", "deviceId", "machineLabel", "mode", "machineDeviceId"];
/** The accept the machine seals (6.2 step 6). Fixed key order, plain JSON.stringify (not JCS):
 *  { machineKxPub, machineSigPub, vault, deviceId, machineLabel, mode, machineDeviceId }. Throws when a field is missing. */
export function buildAccept(f) {
  const o = {};
  for (const k of ACCEPT_FIELDS) { if (typeof f?.[k] !== "string" || f[k] === "") throw new TypeError(`accept: ${k} is required`); o[k] = f[k]; }
  if (!DEVICE_ID.test(o.machineDeviceId)) throw new TypeError("accept: machineDeviceId is not a device id");
  return o;
}
export const sealAccept = (secret, pairingId, fields, iv) => sealPairing(secret, pairingId, "accept", buildAccept(fields), iv);
/** Opens an accept. `machineDeviceId` comes back as written; the caller compares it with the device the relay reports. */
export const openAccept = (secret, pairingId, sealed) => openSealed(secret, pairingId, "accept", sealed);

// ---- the link: `<pwa>/pair#v1.<pairingId>.<b64u secret (32)>.<b64u fpr (32)>`
export const buildFragment = ({ pairingId, secret, fpr }) => `v1.${pairingId}.${b64uEncode(secret)}.${b64uEncode(fpr)}`;
export const buildLink = (pwa, parts) => `${pwa}/pair#${buildFragment(parts)}`;
/** Parses the text after "#" (a leading "#" is tolerated) -> { pairingId, secret, fpr }; throws on anything else. */
export function parseFragment(fragment) {
  const m = /^#?v1\.(pr_[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(fragment);
  if (!m) throw new Error("bad pairing link");
  return { pairingId: m[1], secret: b64uDecode(m[2]), fpr: b64uDecode(m[3]) };
}
export function parseLink(link) {
  const i = String(link).indexOf("#");
  if (i < 0) throw new Error("bad pairing link");
  return parseFragment(link.slice(i + 1));
}

// ---- check words (6.3): 4 x 11 bits of H("eleven/v1/words" | pairingId | fpr | H(phoneKxPub || phoneAuthPub || PACT pub) | accountId)
// "|" is the byte 0x7c between the fields; fpr and the inner hash are the raw 32 bytes; the three public keys are SPKI DER
// (PACT pub = the bytes of the claim's `phoneActKey.pub`, or nothing for a read-only phone).
export async function checkWords({ pairingId, fpr, phoneKxPub, phoneAuthPub, phoneActPub = new Uint8Array(0), accountId }) {
  const bar = enc.encode("|");
  const inner = await sha256(concat(phoneKxPub, phoneAuthPub, phoneActPub));
  const h = await sha256(concat(enc.encode("eleven/v1/words"), bar, enc.encode(pairingId), bar, fpr, bar, inner, bar, enc.encode(accountId)));
  const words = [];
  for (let i = 0; i < 4; i++) {
    let idx = 0;
    for (let b = 0; b < 11; b++) { const bit = i * 11 + b; idx = (idx << 1) | ((h[bit >> 3] >> (7 - (bit & 7))) & 1); }
    words.push(WORDS[idx]);
  }
  return words;
}
