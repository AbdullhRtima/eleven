// base64url without padding (protocol 2). Strict decoding: only the URL alphabet, no "=",
// no whitespace, and no non-canonical trailing bits, so one byte string has exactly one text form.
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64uEncode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("b64u: expected Uint8Array");
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63] + ALPHA[n & 63];
  }
  if (bytes.length - i === 1) {
    const n = bytes[i] << 16;
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63];
  } else if (bytes.length - i === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63];
  }
  return out;
}

const REV = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) REV[ALPHA.charCodeAt(i)] = i;

export function b64uDecode(s) {
  if (typeof s !== "string") throw new TypeError("b64u: expected string");
  const len = s.length;
  if (len % 4 === 1) throw new Error("b64u: bad length");
  const vals = new Array(len);
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? REV[c] : -1;
    if (v < 0) throw new Error("b64u: bad character");
    vals[i] = v;
  }
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < len; i += 4) {
    const n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    out[o++] = n >> 16; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
  }
  const rem = len - i;
  if (rem === 2) {
    if (vals[i + 1] & 15) throw new Error("b64u: non-canonical trailing bits");
    out[o++] = (vals[i] << 2) | (vals[i + 1] >> 4);
  } else if (rem === 3) {
    if (vals[i + 2] & 3) throw new Error("b64u: non-canonical trailing bits");
    out[o++] = (vals[i] << 2) | (vals[i + 1] >> 4);
    out[o++] = ((vals[i + 1] & 15) << 4) | (vals[i + 2] >> 2);
  }
  return out;
}
