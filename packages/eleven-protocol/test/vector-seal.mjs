// Test-only seal with a FIXED nonce, for the checked-in vectors. Built from the public building blocks only.
// It lives in test/ on purpose: nothing under src/ may take a nonce from its caller (security L5).
import { b64uEncode, buildAad, pad, jcs, newId, PROTOCOL_VERSION } from "../src/index.js";

const enc = new TextEncoder();

// Same shape as seal(): fields { type, vault, from, to, fid?, id?, ts? }, inner { t, seq, ts?, ... }, key (AES-GCM encrypt).
export async function sealWithFixedNonce(fields, inner, key, nonce) {
  const env = {
    v: PROTOCOL_VERSION, type: fields.type, vault: fields.vault, from: fields.from, to: fields.to,
    id: fields.id ?? newId(), ts: fields.ts ?? Date.now(), epoch: 0,
  };
  if (env.type === "file") env.fid = fields.fid;
  const body = { ...inner, ts: inner.ts ?? Date.now() };
  const plain = pad(enc.encode(jcs(body)));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: buildAad(env), tagLength: 128 }, key, plain));
  env.n = b64uEncode(nonce);
  env.ct = b64uEncode(ct);
  return env;
}
