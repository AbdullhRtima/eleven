// Envelope, AAD and AES-256-GCM sealing (protocol 4).
import { b64uEncode, b64uDecode } from "./b64u.js";
import { jcs } from "./jcs.js";
import { pad, unpad } from "./padding.js";

export const PROTOCOL_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CT_BYTES = 16 * 1024 * 1024; // sanity bound before any allocation (see report)
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const subtle = () => globalThis.crypto.subtle;

// Outer types that carry a ciphertext (13.1) and the inner types each may hold (13.2).
export const INNER_TYPES = Object.freeze({
  hello: ["hello"], manifest: ["manifest"], delta: ["delta"], file: ["file"], tick: ["tick"],
  req: ["req", "sync_request", "file_request", "push_keys", "revoke_request", "log_request"],
  action: ["action"],
  result: ["result", "action_result", "file", "revoke_result", "action_log"],
});

export class ProtocolError extends Error {
  constructor(code, message) { super(message ?? code); this.name = "ProtocolError"; this.code = code; }
}
const fail = (code, msg) => { throw new ProtocolError(code, msg); };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isTs = (n) => Number.isSafeInteger(n) && n >= 0;

// AAD = "eleven/v1|" v "|" type "|" vault "|" from "|" to "|" id "|" epoch "|" (fid or "")   (4.2)
// "|" is the separator, so no field may contain it (ids are b64u, UUIDs and fixed words anyway).
export function buildAad(e) {
  const parts = [e.v, e.type, e.vault, e.from, e.to, e.id, e.epoch, e.fid ?? ""];
  if (e.v !== PROTOCOL_VERSION) fail("bad_envelope", "unsupported version");
  if (e.epoch !== 0) fail("bad_epoch", "epoch must be 0 in v1");
  for (const p of parts.slice(1, 6).concat(parts[7])) if (typeof p !== "string" || p.includes("|")) fail("bad_envelope", "bad field");
  if (parts[1] === "" || parts[2] === "" || parts[3] === "" || parts[4] === "" || parts[5] === "") fail("bad_envelope", "empty field");
  return enc.encode("eleven/v1|" + parts.join("|"));
}

function checkKey(key, usage) {
  if (!key || key.type !== "secret" || key.algorithm?.name !== "AES-GCM" || key.algorithm.length !== 256 || !key.usages.includes(usage)) {
    fail("bad_key", "expected an AES-256-GCM key");
  }
}

function checkFid(type, fid) {
  const needs = type === "file"; // `gone` has no ct and is not sealed here
  if (needs && (typeof fid !== "string" || fid === "")) fail("bad_envelope", "fid required for type file");
  if (!needs && fid !== undefined) fail("bad_envelope", "fid only for type file");
}

// Inner header (4.3): { t, seq, ts, ...body }. actions also carry actionId (UUID v4) and createdAt (8.1).
function checkInner(type, inner) {
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) fail("bad_inner", "inner must be an object");
  if (typeof inner.t !== "string" || !INNER_TYPES[type].includes(inner.t)) fail("bad_inner", "inner type mismatch");
  if (!Number.isSafeInteger(inner.seq) || inner.seq < 0) fail("bad_inner", "bad seq");
  if (!isTs(inner.ts)) fail("bad_inner", "bad ts");
  if (type === "action") {
    if (typeof inner.actionId !== "string" || !UUID_V4.test(inner.actionId)) fail("bad_inner", "bad actionId");
    if (!isTs(inner.createdAt)) fail("bad_inner", "bad createdAt");
  }
}

export const newId = () => globalThis.crypto.randomUUID();

// seal(envelopeFields, plaintextObject, key) -> envelope. A fresh random 96-bit nonce every call, generated here:
// no function in src/ takes a nonce from its caller (the checked-in vectors are sealed by test/vector-seal.mjs).
// fields: { type, vault, from, to, fid?, id?, ts? }. id (UUID v4) and ts default to fresh values. v and epoch are set here.
// plaintextObject: { t, seq, ts?, ...body }; ts defaults to now.
export async function seal(fields, inner, key) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const type = fields?.type;
  if (!Object.hasOwn(INNER_TYPES, type)) fail("bad_envelope", "type has no ciphertext");
  checkKey(key, "encrypt");
  checkFid(type, fields.fid);
  const body = { ...inner, ts: inner.ts ?? Date.now() };
  checkInner(type, body);
  const env = {
    v: PROTOCOL_VERSION, type, vault: fields.vault, from: fields.from, to: fields.to,
    id: fields.id ?? newId(), ts: fields.ts ?? Date.now(), epoch: 0,
  };
  if (!isTs(env.ts)) fail("bad_envelope", "bad ts");
  if (type === "file") env.fid = fields.fid;
  const aad = buildAad(env);
  let plain;
  try { plain = pad(enc.encode(jcs(body))); } catch (e) { fail("bad_inner", e.message); }
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plain));
  env.n = b64uEncode(nonce);
  env.ct = b64uEncode(ct);
  return env;
}

// open(envelope, key, expect?) -> inner object. expect = { vault?, from?, to? }: when given, the envelope must carry
// exactly those values, or open fails with the same coarse error as a wrong key (nothing is decrypted first). Every failure throws a ProtocolError with a coarse code and no
// detail an attacker could use as an oracle (4.4); callers drop the message and count it.
// Returns the inner object only; the caller checks seq (rollback) and actionId (dedupe) against its own state.
export async function open(envelope, key, expect) {
  const e = envelope;
  if (e === null || typeof e !== "object") fail("bad_envelope");
  if (e.v !== PROTOCOL_VERSION) fail("bad_envelope", "unsupported version");
  if (e.epoch !== 0) fail("bad_epoch", "unknown epoch");
  if (!Object.hasOwn(INNER_TYPES, e.type)) fail("bad_envelope", "type has no ciphertext");
  checkKey(key, "decrypt");
  if (expect !== undefined) {
    if (expect === null || typeof expect !== "object") fail("bad_key", "expect must be an object");
    for (const f of ["vault", "from", "to"]) if (expect[f] !== undefined && e[f] !== expect[f]) fail("decrypt_failed");
  }
  checkFid(e.type, e.fid);
  if (typeof e.n !== "string" || typeof e.ct !== "string") fail("bad_envelope");
  if (!isTs(e.ts) || typeof e.id !== "string") fail("bad_envelope");
  if (e.ct.length > Math.ceil((MAX_CT_BYTES * 4) / 3)) fail("bad_envelope", "too large");
  let aad, nonce, ct;
  try { aad = buildAad(e); nonce = b64uDecode(e.n); ct = b64uDecode(e.ct); } catch { fail("bad_envelope"); }
  if (nonce.length !== NONCE_BYTES || ct.length < TAG_BYTES) fail("bad_envelope");
  let plain;
  try {
    plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, ct));
  } catch { fail("decrypt_failed"); }
  let inner;
  try { inner = JSON.parse(dec.decode(unpad(plain))); } catch { fail("bad_inner"); }
  checkInner(e.type, inner);
  return inner;
}
