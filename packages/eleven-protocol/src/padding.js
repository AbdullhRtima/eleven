// Plaintext = uint32 length (big-endian) || UTF-8 canonical JSON || zero padding (4.3).
// The whole plaintext is rounded up to the next 1 KiB below 64 KiB, and to the next 64 KiB from 64 KiB up.
const KIB = 1024;
const STEP_SMALL = KIB;
const STEP_LARGE = 64 * KIB;
export const MAX_JSON_BYTES = 8 * 1024 * 1024; // sanity bound, not in the spec (see report)

export function paddedSize(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("padding: bad size");
  const step = n < STEP_LARGE ? STEP_SMALL : STEP_LARGE;
  return Math.max(step, Math.ceil(n / step) * step);
}

export function pad(jsonBytes) {
  if (!(jsonBytes instanceof Uint8Array)) throw new TypeError("pad: expected Uint8Array");
  if (jsonBytes.length > MAX_JSON_BYTES) throw new RangeError("pad: message too large");
  const out = new Uint8Array(paddedSize(4 + jsonBytes.length)); // zero-filled
  new DataView(out.buffer).setUint32(0, jsonBytes.length, false);
  out.set(jsonBytes, 4);
  return out;
}

export function unpad(plain) {
  if (!(plain instanceof Uint8Array) || plain.length < 4) throw new Error("padding: too short");
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (len > plain.length - 4) throw new Error("padding: bad length");
  return plain.subarray(4, 4 + len); // the rest is ignored (4.3)
}
