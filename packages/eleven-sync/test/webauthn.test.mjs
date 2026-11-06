// Protocol 8.2, `webauthn-es256`: checkActionSignature against hand-built passkey assertions (synthetic keys only; phone-sim.mjs builds the bytes
// with node:crypto and none of the code under test). Every negative changes ONE thing in an otherwise good assertion.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { checkActionSignature } from "../src/start.js";
import { jcs } from "../../eleven-protocol/src/index.js";
import { webauthnSig, actionToSign, canon } from "./phone-sim.mjs";

const b64u = (b) => Buffer.from(b).toString("base64url");
const ec = (curve = "prime256v1") => crypto.generateKeyPairSync("ec", { namedCurve: curve });
const VAULT = "vlt_AAAAAAAAAAAAAAAAAAAAAA", DEV = "dev_BBBBBBBBBBBBBBBBBBBBBB";
const key = ec();
const device = (alg = "webauthn-es256", pub = key.publicKey) => ({ deviceId: DEV, phoneActKey: { alg, credId: "c1", pub: b64u(pub.export({ type: "spki", format: "der" })) } });
const action = { t: "action", seq: 3, ts: 1793779260000, actionId: "9d3e2c1b-7a6f-4e5d-8c4b-3a2f1e0d9c8b", createdAt: 1793779260000, kind: "answer", item: "010-export", target: "brief", pre: { qHash: "q" }, payload: { answer: "Markdown first." } };
const TO_SIGN = actionToSign(VAULT, DEV, action);
const check = (o, { dev = device(), a = action, info } = {}) => checkActionSignature({ ...a, sig: webauthnSig(key.privateKey, TO_SIGN, o) }, dev, VAULT, info);
const flip = (s, i) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);

test("the challenge is the raw SHA-256 digest: clientDataJSON.challenge is its b64u text, the same string device-es256 signs", () => {
  const raw = crypto.createHash("sha256").update(`eleven/v1/action|${VAULT}|${DEV}|${canon(action)}`).digest();
  assert.equal(raw.length, 32);
  assert.equal(TO_SIGN, raw.toString("base64url"));
  assert.equal(TO_SIGN.length, 43);
  const sig = webauthnSig(key.privateKey, TO_SIGN);
  assert.equal(JSON.parse(Buffer.from(sig.clientDataJSON, "base64url")).challenge, raw.toString("base64url"));
});

test("a good assertion is accepted; the counter is reported and need not rise (0, 0, then 7, then 3)", () => {
  for (const counter of [0, 0, 7, 3, 0xffffffff]) { const info = {}; assert.equal(check({ counter }, { info }), null); assert.equal(info.counter, counter); }
});

test("accepted variants: UP+UV only, BE/BS set, no crossOrigin key, extra clientData keys, topOrigin equal to the origin", () => {
  for (const o of [{ flags: 0x05 }, { flags: 0x0d }, { flags: 0x15 }, { flags: 0x1d },
    { clientData: JSON.stringify({ type: "webauthn.get", challenge: TO_SIGN, origin: "https://m.eleven.rtima.org" }) },
    { extra: { androidPackageName: "x", other: [1, 2] } }, { extra: { topOrigin: "https://m.eleven.rtima.org" } }]) assert.equal(check(o), null, JSON.stringify(o));
});

test("clientDataJSON: wrong type, wrong challenge, a challenge for another vault / device / action, wrong origin, crossOrigin, topOrigin", () => {
  assert.equal(check({}), null, "control: the unchanged assertion is accepted");
  const other = (v, d, a) => actionToSign(v, d, a);
  const bad = [
    { type: "webauthn.create" }, { type: "" }, { type: 1 },
    { challenge: flip(TO_SIGN, 5) }, { challenge: TO_SIGN + "A" }, { challenge: TO_SIGN.slice(0, 42) }, { challenge: Buffer.from(TO_SIGN, "base64url").toString("hex") }, { challenge: Buffer.from(TO_SIGN).toString("base64url") },
    { challenge: other("vlt_CCCCCCCCCCCCCCCCCCCCCC", DEV, action) }, { challenge: other(VAULT, "dev_DDDDDDDDDDDDDDDDDDDDDD", action) }, { challenge: other(VAULT, DEV, { ...action, seq: 4 }) },
    { challenge: 5 }, { challenge: null }, { challenge: [TO_SIGN] },
    { origin: "https://evil.example" }, { origin: "https://m.eleven.rtima.org/" }, { origin: "http://m.eleven.rtima.org" }, { origin: "https://M.eleven.rtima.org" }, { origin: "https://m.eleven.rtima.org:443" },
    { origin: "https://m.eleven.rtima.org.evil.example" }, { origin: "https://eleven.rtima.org" }, { origin: "" }, { origin: 1 }, { origin: ["https://m.eleven.rtima.org"] },
    { crossOrigin: true }, { crossOrigin: "false" }, { crossOrigin: 0 }, { crossOrigin: null },
    { crossOrigin: true, extra: { topOrigin: "https://m.eleven.rtima.org" } }, { extra: { topOrigin: "https://evil.example" } }, { extra: { topOrigin: 1 } },
  ];
  for (const o of bad) assert.equal(check(o), "bad_signature", JSON.stringify(o));
  // a missing type, challenge or origin
  for (const k of ["type", "challenge", "origin"]) {
    const cd = { type: "webauthn.get", challenge: TO_SIGN, origin: "https://m.eleven.rtima.org", crossOrigin: false }; delete cd[k];
    assert.equal(check({ clientData: JSON.stringify(cd) }), "bad_signature", k);
  }
});

test("clientDataJSON that is not an object, not JSON or not UTF-8 is refused (signed correctly, so only the parse can fail)", () => {
  assert.equal(check({}), null, "control: the unchanged assertion is accepted");
  for (const text of ["", "null", "[]", "5", '"x"', "{", "{'type':1}", "\ufeff" + JSON.stringify({ type: "webauthn.get", challenge: TO_SIGN, origin: "https://m.eleven.rtima.org" })]) assert.equal(check({ clientData: text }), "bad_signature", text);
  const bytes = Buffer.concat([Buffer.from('{"type":"webauthn.get","challenge":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
  assert.equal(check({ clientData: bytes }), "bad_signature");
  const good = JSON.stringify({ type: "webauthn.get", challenge: TO_SIGN, origin: "https://m.eleven.rtima.org", crossOrigin: false });   // everything right, one stray invalid byte in an unused key
  assert.equal(check({ clientData: Buffer.concat([Buffer.from(good.slice(0, -1) + ',"x":"'), Buffer.from([0xff]), Buffer.from('"}')]) }), "bad_signature");
});

test("authenticatorData: wrong rpIdHash, UP or UV missing, AT or ED set, truncated, longer than 37 bytes", () => {
  assert.equal(check({}), null, "control: the unchanged assertion is accepted");
  const cases = [
    { rpId: "eleven.rtima.org" }, { rpId: "evil.example" }, { rpId: "m.eleven.rtima.org." },
    { flags: 0x04 }, { flags: 0x01 }, { flags: 0x00 }, { flags: 0x0c }, { flags: 0x18 },
    { flags: 0x45 }, { flags: 0x85 }, { flags: 0xc5 }, { flags: 0x5d }, { flags: 0x9d },
    { tweakAd: (b) => b.subarray(0, 36) }, { tweakAd: (b) => b.subarray(0, 32) }, { tweakAd: (b) => b.subarray(0, 1) }, { tweakAd: () => Buffer.alloc(0) },
    { tweakAd: (b) => Buffer.concat([b, Buffer.from([0])]) }, { tweakAd: (b) => Buffer.concat([b, Buffer.alloc(100)]) },
  ];
  for (const o of cases) assert.equal(check(o), "bad_signature", JSON.stringify(o, (_k, v) => (typeof v === "function" ? v.toString() : v)));
});

test("signature: another key, P1363 instead of DER, DER with trailing bytes, truncated, empty, all-zero, signed over the wrong message", () => {
  const stranger = ec();
  assert.equal(check({ key: stranger.privateKey }), "bad_signature");
  assert.equal(check({ p1363: true }), "bad_signature");
  assert.equal(check({ tweakSig: (r) => Buffer.concat([r, Buffer.from([0])]) }), "bad_signature");
  assert.equal(check({ tweakSig: (r) => r.subarray(0, r.length - 1) }), "bad_signature");
  assert.equal(check({ tweakSig: () => Buffer.alloc(0) }), "bad_signature");
  assert.equal(check({ tweakSig: () => Buffer.alloc(64) }), "bad_signature");
  assert.equal(check({ tweakSig: () => Buffer.alloc(72, 0x30) }), "bad_signature");
  assert.equal(check({ tweakSig: (r) => r }), null, "control: the helper itself changes nothing");
  // device-es256 style: ECDSA over the b64u text of toSign (what the old path signs), wrapped as a webauthn signature
  const wrong = crypto.sign("sha256", Buffer.from(TO_SIGN), { key: key.privateKey, dsaEncoding: "der" });
  assert.equal(check({ tweakSig: () => wrong }), "bad_signature");
});

test("b64u must be strict: padding, + and /, whitespace, bad length, non-canonical bits, wrong types, missing fields", () => {
  const good = webauthnSig(key.privateKey, TO_SIGN);
  assert.equal(checkActionSignature({ ...action, sig: good }, device(), VAULT), null, "control: the unchanged assertion is accepted");
  const run = (f, v) => checkActionSignature({ ...action, sig: { ...good, [f]: v } }, device(), VAULT);
  for (const f of ["authenticatorData", "clientDataJSON", "signature"]) {
    const s = good[f];
    for (const v of [s + "=", s + "==", s.replace(/[-_A-Za-z0-9]/, "+"), s.replace(/[-_A-Za-z0-9]/, "/"), " " + s, s + "\n", s.slice(0, 2) + " " + s.slice(2), s + "A", s.slice(0, -1) + (s.at(-1) === "A" ? "B" : "A"), "", 5, null, true, [s], { 0: s }, undefined])
      assert.equal(run(f, v), "bad_signature", `${f}: ${JSON.stringify(v)}`);
  }
  assert.equal(run("authenticatorData", "AA"), "bad_signature");                    // the old dummy values
  assert.equal(checkActionSignature({ ...action, sig: { alg: "webauthn-es256", authenticatorData: "AA", clientDataJSON: "AA", signature: "AA" } }, device(), VAULT), "bad_signature");
  const { signature: _s, ...noSig } = good;
  assert.equal(checkActionSignature({ ...action, sig: noSig }, device(), VAULT), "bad_signature");
  assert.equal(checkActionSignature({ ...action, sig: { alg: "webauthn-es256" } }, device(), VAULT), "bad_signature");
});

test("sizes are bounded: clientDataJSON <= 4096 bytes, authenticatorData 37 bytes, signature <= 72 bytes", () => {
  const withLen = (n) => {                                                          // a signed clientDataJSON of exactly n bytes
    const base = JSON.stringify({ type: "webauthn.get", challenge: TO_SIGN, origin: "https://m.eleven.rtima.org", crossOrigin: false, pad: "" });
    return base.slice(0, -2) + "x".repeat(n - base.length) + '"}';
  };
  assert.equal(Buffer.byteLength(withLen(4096)), 4096);
  assert.equal(check({ clientData: withLen(4096) }), null);
  assert.equal(check({ clientData: withLen(4097) }), "bad_signature");
  assert.equal(check({ clientData: withLen(1_000_000) }), "bad_signature");
  assert.equal(check({ fields: { signature: "A".repeat(97) } }), "bad_signature");
  assert.equal(check({ fields: { signature: "A".repeat(1_000_000) } }), "bad_signature");
  assert.equal(check({ fields: { authenticatorData: "A".repeat(65) } }), "bad_signature");
  assert.equal(check({ fields: { authenticatorData: "A".repeat(1_000_000) } }), "bad_signature");
});

test("the action edited after signing is refused (payload, kind, item, target, pre, seq, a different vault or device)", () => {
  const sig = webauthnSig(key.privateKey, TO_SIGN);
  const edited = [{ payload: { answer: "Other." } }, { kind: "approve" }, { item: "011-x" }, { target: "x" }, { pre: { qHash: "z" } }, { seq: 4 }, { extra: 1 }];
  for (const e of edited) assert.equal(checkActionSignature({ ...action, ...e, sig }, device(), VAULT), "bad_signature", JSON.stringify(e));
  assert.equal(checkActionSignature({ ...action, sig }, device(), "vlt_CCCCCCCCCCCCCCCCCCCCCC"), "bad_signature");
  assert.equal(checkActionSignature({ ...action, sig }, { ...device(), deviceId: "dev_DDDDDDDDDDDDDDDDDDDDDD" }, VAULT), "bad_signature");
  assert.equal(checkActionSignature({ ...action, sig }, device(), VAULT), null, "control: unedited");
});

test("registered alg is never weakened or swapped: device-es256 from a passkey device = weak_signature; passkey from a device-es256 device = bad_signature", () => {
  const dev = device("device-es256"), none = { deviceId: DEV, phoneActKey: null };
  const passkey = webauthnSig(key.privateKey, TO_SIGN);
  assert.equal(checkActionSignature({ ...action, sig: passkey }, device(), VAULT), null, "control: the same assertion is good for a passkey device");
  assert.equal(checkActionSignature({ ...action, sig: passkey }, dev, VAULT), "bad_signature");
  assert.equal(checkActionSignature({ ...action, sig: passkey }, device("es256"), VAULT), "bad_signature");
  assert.equal(checkActionSignature({ ...action, sig: passkey }, none, VAULT), "bad_signature");
  const deviceSig = { alg: "device-es256", signature: b64u(crypto.sign("sha256", Buffer.from(TO_SIGN), { key: key.privateKey, dsaEncoding: "ieee-p1363" })) };
  assert.equal(checkActionSignature({ ...action, sig: deviceSig }, device(), VAULT), "weak_signature");
  assert.equal(checkActionSignature({ ...action, sig: deviceSig }, dev, VAULT), null, "control: the device-es256 path still works");
  assert.equal(checkActionSignature({ ...action, sig: { ...passkey, alg: "webauthn-es512" } }, device(), VAULT), "bad_signature");
});

test("the registered key must be a P-256 public key: secp256k1 (its signatures fit the size cap), P-384, garbage, nothing", () => {
  assert.equal(check({}), null, "control: the unchanged assertion is accepted");
  const k1 = ec("secp256k1"), p384 = ec("secp384r1");
  assert.equal(check({ key: k1.privateKey }, { dev: device("webauthn-es256", k1.publicKey) }), "bad_signature");
  assert.equal(check({ key: p384.privateKey }, { dev: device("webauthn-es256", p384.publicKey) }), "bad_signature");
  assert.equal(check({}, { dev: { deviceId: DEV, phoneActKey: { alg: "webauthn-es256", credId: "c1", pub: "AAAA" } } }), "bad_signature");
  assert.equal(check({}, { dev: { deviceId: DEV, phoneActKey: { alg: "webauthn-es256", credId: "c1" } } }), "bad_signature");
  assert.equal(check({}, { dev: { deviceId: DEV, phoneActKey: { alg: "webauthn-es256", credId: "c1", pub: 5 } } }), "bad_signature");
});

test("malformed sig and action shapes never throw", () => {
  assert.equal(check({}), null, "control: the unchanged assertion is accepted");
  const g = webauthnSig(key.privateKey, TO_SIGN);
  const sigs = [null, undefined, 5, "x", [], [g], { alg: "webauthn-es256", authenticatorData: {}, clientDataJSON: [], signature: () => 1 }, { alg: "webauthn-es256", authenticatorData: { toString() { throw new Error("x"); } } },
    { ...g, authenticatorData: { length: 50 } }, { alg: 5 }];
  for (const sig of sigs) assert.doesNotThrow(() => assert.equal(checkActionSignature({ ...action, sig }, device(), VAULT), "bad_signature"));
  const cyc = { ...action, sig: g }; cyc.self = cyc;
  assert.doesNotThrow(() => assert.equal(checkActionSignature(cyc, device(), VAULT), "bad_signature"));
  assert.doesNotThrow(() => assert.equal(checkActionSignature({ ...action, big: 10n, sig: g }, device(), VAULT), "bad_signature"));
  const throwing = {};
  Object.defineProperty(throwing, "sig", { get() { throw 0; }, enumerable: true });
  for (const bad of [null, undefined, 5, throwing]) assert.doesNotThrow(() => assert.equal(checkActionSignature(bad, device(), VAULT), "bad_signature"), String(bad));
});

test("fuzz: every single-character change in any field of a good assertion is refused, and nothing throws", () => {
  const g = webauthnSig(key.privateKey, TO_SIGN);
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let n = 0;
  for (const f of ["authenticatorData", "clientDataJSON", "signature"]) {
    for (let i = 0; i < 120; i++) {
      const pos = rnd(g[f].length); let c; do c = alpha[rnd(64)]; while (c === g[f][pos]);
      const mutated = g[f].slice(0, pos) + c + g[f].slice(pos + 1);
      assert.equal(checkActionSignature({ ...action, sig: { ...g, [f]: mutated } }, device(), VAULT), "bad_signature", `${f}[${pos}]=${c}`); n++;
    }
  }
  assert.equal(n, 360);
  assert.equal(checkActionSignature({ ...action, sig: g }, device(), VAULT), null);
});

test("the fixed vector (what the PWA matches byte for byte) verifies, and its digest and challenge recompute", () => {
  const v = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./webauthn-vectors.json", import.meta.url)), "utf8"));
  const dev = { deviceId: v.deviceId, phoneActKey: { alg: "webauthn-es256", credId: v.credId, pub: v.pub } };
  assert.equal(canon(v.action), v.jcs);
  assert.equal(jcs(v.action), v.jcs);
  assert.equal(actionToSign(v.vault, v.deviceId, v.action), v.toSign);
  assert.equal(b64u(crypto.createHash("sha256").update(v.signedInput).digest()), v.toSign);
  assert.equal(JSON.parse(Buffer.from(v.sig.clientDataJSON, "base64url")).challenge, v.toSign);
  assert.equal(checkActionSignature({ ...v.action, sig: v.sig }, dev, v.vault), null);
  assert.equal(checkActionSignature({ ...v.action, payload: { answer: "changed" }, sig: v.sig }, dev, v.vault), "bad_signature");
});
