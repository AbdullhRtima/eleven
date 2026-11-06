import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sealWithFixedNonce } from "./vector-seal.mjs";
import {
  b64uEncode, b64uDecode, jcs, pad, unpad, paddedSize, seal, open, buildAad, ProtocolError,
  generateKeyAgreementKeyPair, generateSigningKeyPair, exportPublicKey, importPublicKey, fingerprint,
  deriveRoot, deriveMessageKeys, H, generateKfid,
} from "../src/index.js";

const subtle = globalThis.crypto.subtle;
const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const enc = new TextEncoder();
const aesKey = (raw, usages = ["encrypt", "decrypt"]) => subtle.importKey("raw", raw, "AES-GCM", false, usages);
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof ProtocolError && (!code || e.code === code), "expected ProtocolError " + (code ?? ""));

const ids = { vault: V.vault, machine: V.machine, phone: V.phone };
const fieldsM2P = (extra = {}) => ({ type: "manifest", vault: ids.vault, from: ids.machine, to: ids.phone, ...extra });
const innerManifest = (extra = {}) => ({ t: "manifest", seq: 5, ts: 1793779200000, files: [], ...extra });
const newKey = () => aesKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));

// ---- b64u
test("b64u: RFC 4648 vectors, no padding, url alphabet", () => {
  const cases = [["", ""], ["f", "Zg"], ["fo", "Zm8"], ["foo", "Zm9v"], ["foob", "Zm9vYg"], ["fooba", "Zm9vYmE"], ["foobar", "Zm9vYmFy"]];
  for (const [t, b] of cases) { assert.equal(b64uEncode(enc.encode(t)), b); assert.deepEqual(b64uDecode(b), enc.encode(t)); }
  assert.equal(b64uEncode(Uint8Array.of(0xfb, 0xff, 0xfe)), "-__-");
  assert.deepEqual(b64uDecode("-__-"), Uint8Array.of(0xfb, 0xff, 0xfe));
});
test("b64u: all lengths 0..70 round trip", () => {
  for (let n = 0; n <= 70; n++) {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(b64uDecode(b64uEncode(b)), b);
    assert.equal(b64uEncode(b), Buffer.from(b).toString("base64url"));
  }
});
test("b64u: strict decoding rejects bad input", () => {
  for (const bad of ["Zg==", "Z", "Zm9vY", "Zm 8", "Zm8\n", "+/+/", "Zm9v=", "Zh", "Zm9", "é", "Zm\u0000"]) assert.throws(() => b64uDecode(bad), undefined, JSON.stringify(bad));
  assert.throws(() => b64uDecode(null));
  assert.throws(() => b64uEncode("abc"));
});

// ---- JCS
test("jcs: keys sort by UTF-16 code units, recursively", () => {
  assert.equal(jcs({ b: 1, a: { d: 1, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":1},"b":1}');
  // RFC 8785 3.2.3: € (euro) < 😀 (emoji, high surrogate d83d) < דּ in UTF-16 order
  assert.equal(jcs({ "דּ": 3, "😀": 2, "€": 1 }), '{"€":1,"😀":2,"דּ":3}');
  assert.equal(jcs({ "é": 1, e: 2, "ê": 3 }), '{"e":2,"é":1,"ê":3}');
});
test("jcs: strings, numbers and literals", () => {
  assert.equal(jcs("a\"b\\c\n\u0001\u007f "), '"a\\"b\\\\c\\n\\u0001\u007f "');
  assert.equal(jcs("café 🚀"), '"café 🚀"');
  assert.equal(jcs([1, 1.5, -0, 1e21, 1e-7, 4.5e-10, 0.000001, 123456789012345680000, true, false, null]), "[1,1.5,0,1e+21,1e-7,4.5e-10,0.000001,123456789012345680000,true,false,null]");
  assert.equal(jcs({}), "{}");
  assert.equal(jcs([]), "[]");
});
test("jcs: rejects values with no canonical form", () => {
  for (const bad of [NaN, Infinity, undefined, () => 1, Symbol("x"), 1n, "\ud800", { a: undefined }, new Date(), new Map()]) assert.throws(() => jcs(bad));
});

// ---- padding
test("padding: sizes round up to 1 KiB below 64 KiB and to 64 KiB above", () => {
  const K = 1024, M = 64 * K;
  const cases = [[0, K], [1, K], [K, K], [K + 1, 2 * K], [2 * K, 2 * K], [M - 1, M], [M, M], [M + 1, 2 * M], [2 * M, 2 * M], [2 * M + 1, 3 * M]];
  for (const [n, want] of cases) assert.equal(paddedSize(n), want, "n=" + n);
  assert.equal(pad(new Uint8Array(0)).length, K);
  assert.equal(pad(new Uint8Array(K - 4)).length, K);
  assert.equal(pad(new Uint8Array(K - 3)).length, 2 * K);
  assert.equal(pad(new Uint8Array(M - 4)).length, M);
  assert.equal(pad(new Uint8Array(M - 3)).length, 2 * M);
});
test("padding: length prefix is big-endian, padding is zero, unpad ignores the rest", () => {
  const j = enc.encode("{\"a\":1}");
  const p = pad(j);
  assert.deepEqual([...p.subarray(0, 4)], [0, 0, 0, 7]);
  assert.ok(p.subarray(4 + 7).every((b) => b === 0));
  assert.deepEqual(unpad(p), j);
  p[p.length - 1] = 9; // junk in the padding is ignored
  assert.deepEqual(unpad(p), j);
  assert.throws(() => unpad(Uint8Array.of(0, 0, 0)));
  assert.throws(() => unpad(Uint8Array.of(0, 0, 1, 0, 1, 2)));
  assert.throws(() => unpad(Uint8Array.of(255, 255, 255, 255, 0)));
});
test("padding: sealed ciphertext length leaks only the bucket", async () => {
  const key = await newKey();
  const len = async (n) => b64uDecode((await seal(fieldsM2P(), innerManifest({ x: "a".repeat(n) }), key)).ct).length;
  assert.equal(await len(10), 1024 + 16);
  assert.equal(await len(500), 1024 + 16);
  assert.equal(await len(2000), 3072 + 16);
  assert.equal(await len(70000), 2 * 65536 + 16);
});

// ---- round trip
test("seal/open round trip, envelope shape", async () => {
  const key = await newKey();
  const env = await seal(fieldsM2P(), innerManifest({ text: "héllo 🚀" }), key);
  assert.deepEqual(Object.keys(env).sort(), ["ct", "epoch", "from", "id", "n", "to", "ts", "type", "v", "vault"]);
  assert.equal(env.v, 1); assert.equal(env.epoch, 0);
  assert.match(env.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(b64uDecode(env.n).length, 12);
  const inner = await open(JSON.parse(JSON.stringify(env)), key);
  assert.deepEqual(inner, innerManifest({ text: "héllo 🚀", ts: inner.ts }));
});
test("round trip: file with fid, req with inner type, result with inner type, action with actionId", async () => {
  const key = await newKey();
  const f = await seal({ ...fieldsM2P(), type: "file", fid: "k3J9xQ0aZ1bY2cX3dW4eV5" }, { t: "file", seq: 1, text: "x" }, key);
  assert.equal(f.fid, "k3J9xQ0aZ1bY2cX3dW4eV5");
  assert.equal((await open(f, key)).text, "x");
  const r = await seal({ ...fieldsM2P(), type: "req", from: ids.phone, to: "machine" }, { t: "sync_request", seq: 1 }, key);
  assert.equal((await open(r, key)).t, "sync_request");
  const res = await seal({ ...fieldsM2P(), type: "result" }, { t: "action_result", seq: 9 }, key);
  assert.equal((await open(res, key)).t, "action_result");
  const a = await seal({ ...fieldsM2P(), type: "action", from: ids.phone, to: "machine" },
    { t: "action", seq: 2, actionId: "9d3e2c1b-7a6f-4e5d-8c4b-3a2f1e0d9c8b", createdAt: 1793779260000, kind: "answer" }, key);
  const ai = await open(a, key);
  assert.equal(ai.actionId, "9d3e2c1b-7a6f-4e5d-8c4b-3a2f1e0d9c8b");
  assert.equal(ai.createdAt, 1793779260000);
});
test("a large message (200 KiB) round trips", async () => {
  const key = await newKey();
  const big = "x".repeat(200 * 1024);
  assert.equal((await open(await seal(fieldsM2P(), innerManifest({ big }), key), key)).big, big);
});
test("seal refuses bad input", async () => {
  const key = await newKey();
  await rejects(seal({ ...fieldsM2P(), type: "gone" }, innerManifest(), key), "bad_envelope");
  await rejects(seal({ ...fieldsM2P(), type: "file" }, { t: "file", seq: 1 }, key), "bad_envelope"); // fid missing
  await rejects(seal({ ...fieldsM2P(), fid: "abc" }, innerManifest(), key), "bad_envelope"); // fid on a non-file
  await rejects(seal(fieldsM2P(), { ...innerManifest(), t: "delta" }, key), "bad_inner"); // t vs type
  await rejects(seal(fieldsM2P(), { ...innerManifest(), seq: -1 }, key), "bad_inner");
  await rejects(seal(fieldsM2P(), { ...innerManifest(), seq: 1.5 }, key), "bad_inner");
  await rejects(seal(fieldsM2P(), { t: "manifest" }, key), "bad_inner");
  await rejects(seal({ ...fieldsM2P(), type: "action" }, { t: "action", seq: 1 }, key), "bad_inner"); // no actionId
  await rejects(seal({ ...fieldsM2P(), type: "action" }, { t: "action", seq: 1, actionId: "nope", createdAt: 1 }, key), "bad_inner");
  await rejects(seal({ ...fieldsM2P(), vault: "a|b" }, innerManifest(), key), "bad_envelope"); // separator injection
  await rejects(seal(fieldsM2P(), innerManifest(), await subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"])), "bad_key"); // AES-128
  await rejects(seal(fieldsM2P(), innerManifest(), await aesKey(new Uint8Array(32), ["decrypt"])), "bad_key");
});

// ---- tampering: each must fail to open
test("tamper: every AAD field, nonce, ciphertext, epoch and the wrong key fail to open", async () => {
  const key = await newKey();
  const good = await seal({ ...fieldsM2P(), type: "file", fid: "k3J9xQ0aZ1bY2cX3dW4eV5" }, { t: "file", seq: 1, text: "hi" }, key);
  assert.equal((await open(good, key)).text, "hi");
  const changed = {
    v: 2, type: "result", vault: "vlt_other", from: "dev_other", to: "dev_other", id: "00000000-0000-4000-8000-000000000000",
    epoch: 1, fid: "k3J9xQ0aZ1bY2cX3dW4eV6",
  };
  for (const [f, val] of Object.entries(changed)) await rejects(open({ ...good, [f]: val }, key), undefined);
  const { fid, ...noFid } = good;
  await rejects(open(noFid, key)); // dropping the fid
  for (const [f, val] of [["epoch", "0"], ["epoch", null], ["epoch", 0.5], ["epoch", -1], ["epoch", undefined]]) await rejects(open({ ...good, [f]: val }, key));
  // nonce: flip one bit in every byte position
  const n = b64uDecode(good.n);
  for (let i = 0; i < n.length; i++) { const m = n.slice(); m[i] ^= 1; await rejects(open({ ...good, n: b64uEncode(m) }, key), "decrypt_failed"); }
  await rejects(open({ ...good, n: b64uEncode(n.subarray(0, 11)) }, key), "bad_envelope");
  // ciphertext: flip a bit at the start, middle and in the tag
  const ct = b64uDecode(good.ct);
  for (const i of [0, 100, ct.length - 17, ct.length - 1]) { const m = ct.slice(); m[i] ^= 0x80; await rejects(open({ ...good, ct: b64uEncode(m) }, key), "decrypt_failed"); }
  await rejects(open({ ...good, ct: b64uEncode(ct.subarray(0, ct.length - 1)) }, key));
  await rejects(open({ ...good, ct: b64uEncode(ct.subarray(0, 8)) }, key), "bad_envelope");
  await rejects(open({ ...good, ct: good.ct + "A" }, key));
  // wrong key, and the other direction's key
  await rejects(open(good, await newKey()), "decrypt_failed");
  assert.equal((await open(good, key)).t, "file");
});
test("tamper: epoch is checked before anything else, and a non-zero epoch never decrypts", async () => {
  const key = await newKey();
  const good = await seal(fieldsM2P(), innerManifest(), key);
  await rejects(open({ ...good, epoch: 1 }, key), "bad_epoch");
  await rejects(open({ ...good, epoch: "0" }, key), "bad_epoch");
  assert.throws(() => buildAad({ ...good, epoch: 1 }), (e) => e.code === "bad_epoch");
});
test("tamper: a ciphertext sealed for one envelope cannot be moved to another", async () => {
  const key = await newKey();
  const a = await seal(fieldsM2P({ id: "5b0c6f8e-1f2a-4c3d-9e4f-0a1b2c3d4e5f" }), innerManifest(), key);
  const b = await seal(fieldsM2P({ id: "6b0c6f8e-1f2a-4c3d-9e4f-0a1b2c3d4e5f" }), innerManifest(), key);
  await rejects(open({ ...a, ct: b.ct, n: b.n }, key), "decrypt_failed");
  assert.equal((await open({ ...a }, key)).t, "manifest");
});
test("tamper: inner type must match the outer type even with a valid tag", async () => {
  // build a validly-encrypted message whose inner t does not belong to the outer type
  const key = await newKey();
  const env = await seal(fieldsM2P(), innerManifest(), key);
  const aad = buildAad(env);
  const bad = pad(enc.encode(jcs({ t: "delta", seq: 1, ts: 1 })));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: b64uDecode(env.n), additionalData: aad, tagLength: 128 }, key, bad));
  await rejects(open({ ...env, ct: b64uEncode(ct) }, key), "bad_inner");
  const noSeq = pad(enc.encode(jcs({ t: "manifest", ts: 1 })));
  const ct2 = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: b64uDecode(env.n), additionalData: aad, tagLength: 128 }, key, noSeq));
  await rejects(open({ ...env, ct: b64uEncode(ct2) }, key), "bad_inner");
});
test("open refuses malformed envelopes without throwing anything but ProtocolError", async () => {
  const key = await newKey();
  const good = await seal(fieldsM2P(), innerManifest(), key);
  for (const bad of [null, undefined, 5, "x", [], {}, { ...good, type: "gone" }, { ...good, type: "nope" }, { ...good, n: 5 }, { ...good, ct: "!!" }, { ...good, vault: "a|b" }, { ...good, id: 7 }, { ...good, ts: "1" }, { ...good, fid: "x" }])
    await rejects(open(bad, key));
  await rejects(open(good, null), "bad_key");
  await rejects(open(good, await aesKey(new Uint8Array(32), ["encrypt"])), "bad_key");
});

// ---- nonce uniqueness
test("nonces: 10,000 seals under one key give 10,000 distinct 12-byte nonces", async () => {
  const key = await newKey();
  const seen = new Set();
  for (let i = 0; i < 10000; i++) {
    const e = await seal(fieldsM2P(), innerManifest({ seq: i }), key);
    assert.equal(b64uDecode(e.n).length, 12);
    seen.add(e.n);
  }
  assert.equal(seen.size, 10000);
});

// ---- keys and derivation
test("keys: SPKI export/import, fingerprint, Kfid", async () => {
  const x = await generateKeyAgreementKeyPair();
  const s = await generateSigningKeyPair();
  assert.equal(x.privateKey.extractable, false);
  const xs = await exportPublicKey(x.publicKey), ss = await exportPublicKey(s.publicKey);
  assert.equal(xs.length, 91);
  assert.equal((await importPublicKey(xs, "ecdh")).algorithm.name, "ECDH");
  assert.equal((await importPublicKey(ss, "ecdsa")).algorithm.name, "ECDSA");
  await assert.rejects(importPublicKey(xs.subarray(0, 90), "ecdh"));
  await assert.rejects(importPublicKey(xs, "rsa"));
  await assert.rejects(exportPublicKey(x.privateKey));
  const f = await fingerprint(xs, ss);
  assert.equal(f.bytes.length, 32);
  assert.equal(f.b64u, await H(new Uint8Array([...xs, ...ss])));
  assert.notEqual((await fingerprint(ss, xs)).b64u, f.b64u); // order matters
  assert.equal(generateKfid().length, 32);
  assert.notEqual(b64uEncode(generateKfid()), b64uEncode(generateKfid()));
});
test("keys: both sides derive the same message keys; direction, vault, device and secret change them", async () => {
  const m = await generateKeyAgreementKeyPair(), p = await generateKeyAgreementKeyPair();
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const rm = await deriveRoot({ privateKey: m.privateKey, peerPublicKey: p.publicKey, pairingId: "pr_xxxxxxxx", secret });
  const rp = await deriveRoot({ privateKey: p.privateKey, peerPublicKey: m.publicKey, pairingId: "pr_xxxxxxxx", secret });
  const km = await deriveMessageKeys(rm, { vault: ids.vault, deviceId: ids.phone, role: "machine" });
  const kp = await deriveMessageKeys(rp, { vault: ids.vault, deviceId: ids.phone, role: "phone" });
  assert.equal(km.send.extractable, false);
  const env = await seal(fieldsM2P(), innerManifest(), km.send);   // machine -> phone: K_m2p
  assert.equal((await open(env, kp.recv)).t, "manifest");
  await rejects(open(env, km.recv), "decrypt_failed"); // each direction has its own key
  await rejects(open(env, kp.recv, { vault: "other" }), "decrypt_failed");
  const other = async (opts, dev = ids.phone, vault = ids.vault) => (await deriveMessageKeys(await deriveRoot({ privateKey: p.privateKey, peerPublicKey: m.publicKey, pairingId: "pr_xxxxxxxx", secret, ...opts }), { vault, deviceId: dev, role: "phone" })).recv;
  await rejects(open(env, await other({ secret: Uint8Array.from({ length: 32 }, (_, i) => i + 2) })), "decrypt_failed");
  await rejects(open(env, await other({ pairingId: "pr_yyyyyyyy" })), "decrypt_failed");
  await rejects(open(env, await other({}, "dev_other")), "decrypt_failed");
  await rejects(open(env, await other({}, ids.phone, "vlt_other")), "decrypt_failed");
  await assert.rejects(deriveMessageKeys(rm, { vault: ids.vault, deviceId: ids.phone, role: "machine", epoch: 1 }));
  await assert.rejects(deriveRoot({ privateKey: m.privateKey, peerPublicKey: p.publicKey, pairingId: "pr_xxxxxxxx", secret: new Uint8Array(0) }));
});

// ---- checked-in vectors (the PWA must reproduce these)
test("vectors: independent derivation matches the checked-in values", async () => {
  const mkx = await subtle.importKey("jwk", V.mkx.private, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
  const pkx = await subtle.importKey("jwk", V.pkx.private, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
  const mkxPub = await importPublicKey(b64uDecode(V.mkx.spkiB64u), "ecdh");
  const pkxPub = await importPublicKey(b64uDecode(V.pkx.spkiB64u), "ecdh");
  // 1. ECDH, both directions
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pkxPub }, mkx, 256));
  assert.equal(Buffer.from(shared).toString("hex"), V.sharedHex);
  assert.equal(Buffer.from(await subtle.deriveBits({ name: "ECDH", public: mkxPub }, pkx, 256)).toString("hex"), V.sharedHex);
  // 2. root and message keys by hand from the spec text, using only deriveBits
  const hkdf = async (ikm, salt, info) => new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), 256));
  const secret = hexToBytes(V.secretHex);
  const salt = new Uint8Array(await subtle.digest("SHA-256", new Uint8Array([...enc.encode(V.pairingId), ...secret])));
  const root = await hkdf(shared, salt, "eleven/v1/root");
  const hex = (u) => Buffer.from(u).toString("hex");
  assert.equal(hex(await hkdf(root, new Uint8Array(0), `eleven/v1/m2p|${V.vault}|${V.phone}|0`)), V.kM2pHex);
  assert.equal(hex(await hkdf(root, new Uint8Array(0), `eleven/v1/p2m|${V.vault}|${V.phone}|0`)), V.kP2mHex);
  // 3. deriveRoot itself, on the vector inputs (32-byte secret), reproduces the vector keys
  const libRoot = await deriveRoot({ privateKey: mkx, peerPublicKey: pkxPub, pairingId: V.pairingId, secret });
  const lib = await deriveMessageKeys(libRoot, { vault: V.vault, deviceId: V.phone, role: "machine", extractable: true });
  const libPhone = await deriveMessageKeys(libRoot, { vault: V.vault, deviceId: V.phone, role: "phone", extractable: true });
  const raw = async (k) => hex(new Uint8Array(await subtle.exportKey("raw", k)));
  assert.equal(await raw(lib.send), V.kM2pHex);       // the same bytes as the checked-in vectors, whatever the role
  assert.equal(await raw(lib.recv), V.kP2mHex);
  assert.equal(await raw(libPhone.send), V.kP2mHex);
  assert.equal(await raw(libPhone.recv), V.kM2pHex);
  assert.equal(secret.length, 32);
  // 4. fingerprint
  assert.equal((await fingerprint(b64uDecode(V.mkx.spkiB64u), b64uDecode(V.msigSpkiB64u))).b64u, V.fingerprintB64u);
});
test("vectors: every checked-in envelope opens to its inner message, and the AAD is the spec string", async () => {
  const keys = { m2p: await aesKey(hexToBytes(V.kM2pHex)), p2m: await aesKey(hexToBytes(V.kP2mHex)) };
  for (const m of V.messages) {
    const e = m.envelope;
    assert.deepEqual(await open(e, keys[m.key]), m.inner, m.name);
    assert.equal(new TextDecoder().decode(buildAad(e)), `eleven/v1|1|${e.type}|${e.vault}|${e.from}|${e.to}|${e.id}|0|${e.fid ?? ""}`);
    await rejects(open(e, keys[m.key === "m2p" ? "p2m" : "m2p"]), "decrypt_failed");
  }
  // padding visible in the vectors: 1 KiB bucket + 16-byte tag
  assert.equal(b64uDecode(V.messages[0].envelope.ct).length, 1024 + 16);
});

// ---- security 04b (L5, L6, jcs)
test("L5: the test-only fixed-nonce seal reproduces every vector; src/ has no nonce-taking seal", async () => {
  const keys = { m2p: await aesKey(hexToBytes(V.kM2pHex)), p2m: await aesKey(hexToBytes(V.kP2mHex)) };
  for (const m of V.messages) {
    const e = m.envelope;
    const fields = { type: e.type, vault: e.vault, from: e.from, to: e.to, id: e.id, ts: e.ts, ...(e.fid !== undefined ? { fid: e.fid } : {}) };
    assert.deepEqual(await sealWithFixedNonce(fields, m.inner, keys[m.key], b64uDecode(e.n)), e, m.name);
  }
  const srcDir = new URL("../src/", import.meta.url);
  for (const f of readdirSync(srcDir)) {
    const text = readFileSync(new URL(f, srcDir), "utf8");
    assert.ok(!/sealWithNonce|ForVectors|function[^(]*\([^)]*nonce|nonce\s*\)\s*=>/i.test(text.replace(/\/\/.*$/gm, "")), `${f} must not take a nonce from its caller`);
  }
});
test("L6: deriveRoot needs a 32-byte secret and a pairingId of [A-Za-z0-9_-]{8,64}", async () => {
  const m = await generateKeyAgreementKeyPair(), p = await generateKeyAgreementKeyPair();
  const ok = { privateKey: m.privateKey, peerPublicKey: p.publicKey, pairingId: "pr_dGVzdFBhaXJpbmcwMDAwMQ", secret: new Uint8Array(32) };
  await deriveRoot(ok);
  for (const secret of [new Uint8Array(1), new Uint8Array(16), new Uint8Array(31), new Uint8Array(33), new Uint8Array(0), "x".repeat(32), Array(32).fill(0)]) await assert.rejects(deriveRoot({ ...ok, secret }), TypeError);
  for (const pairingId of ["a|b_cdefgh", "short", "x".repeat(65), "pr_ü_ü_ü_ü_", "pr x xxxxx", "", 5, undefined]) await assert.rejects(deriveRoot({ ...ok, pairingId }), TypeError);
  await deriveRoot({ ...ok, pairingId: "x".repeat(64) });
  await deriveRoot({ ...ok, pairingId: "x".repeat(8) });
});
test("L6: open() with expected { vault, from, to } rejects mismatches with the same coarse error as a wrong key", async () => {
  const key = await newKey();
  const env = await seal(fieldsM2P(), innerManifest(), key);
  assert.equal((await open(env, key, { vault: ids.vault, from: ids.machine, to: ids.phone })).t, "manifest");
  assert.equal((await open(env, key, {})).t, "manifest");
  const wrongKey = await rejects(open(env, await newKey()), "decrypt_failed").then(() => "decrypt_failed");
  for (const expect of [{ vault: "vlt_other" }, { from: "dev_other" }, { to: "dev_other" }, { vault: ids.vault, from: ids.machine, to: "dev_x" }]) {
    await assert.rejects(open(env, key, expect), (e) => e instanceof ProtocolError && e.code === wrongKey && e.message === wrongKey);
  }
});
test("jcs: sparse arrays are refused", () => {
  assert.throws(() => jcs([1, , 3]), /sparse/);
  assert.equal(jcs([1, null, 3]), "[1,null,3]");
});

// ---- L6: direction-bound message keys
test("L6: machine { send: K_m2p, recv: K_p2m } and phone the reverse; usages enforce the direction", async () => {
  const m = await generateKeyAgreementKeyPair(), p = await generateKeyAgreementKeyPair();
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const rm = await deriveRoot({ privateKey: m.privateKey, peerPublicKey: p.publicKey, pairingId: "pr_xxxxxxxx", secret });
  const rp = await deriveRoot({ privateKey: p.privateKey, peerPublicKey: m.publicKey, pairingId: "pr_xxxxxxxx", secret });
  const km = await deriveMessageKeys(rm, { vault: ids.vault, deviceId: ids.phone, role: "machine" });
  const kp = await deriveMessageKeys(rp, { vault: ids.vault, deviceId: ids.phone, role: "phone" });
  assert.deepEqual(Object.keys(km).sort(), ["recv", "send"]);
  assert.deepEqual(km.send.usages, ["encrypt"]);
  assert.deepEqual(km.recv.usages, ["decrypt"]);
  assert.deepEqual(kp.send.usages, ["encrypt"]);
  assert.deepEqual(kp.recv.usages, ["decrypt"]);
  // machine -> phone and phone -> machine, both ways
  const down = await seal(fieldsM2P(), innerManifest(), km.send);
  assert.equal((await open(down, kp.recv)).t, "manifest");
  const up = await seal({ type: "action", vault: ids.vault, from: ids.phone, to: ids.machine }, { t: "action", seq: 1, actionId: "9d3e2c1b-7a6f-4e5d-8c4b-3a2f1e0d9c8b", createdAt: 1793779260000 }, kp.send);
  assert.equal((await open(up, km.recv)).t, "action");
  // a receive key cannot encrypt, a send key cannot decrypt
  await rejects(seal(fieldsM2P(), innerManifest(), km.recv), "bad_key");
  await rejects(seal(fieldsM2P(), innerManifest(), kp.recv), "bad_key");
  await rejects(open(down, km.send), "bad_key");
  await rejects(open(up, kp.send), "bad_key");
  // WebCrypto itself refuses too, not only our check
  await assert.rejects(subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, km.recv, new Uint8Array(1)));
  await assert.rejects(subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, km.send, new Uint8Array(32)));
  // the role is required
  await assert.rejects(deriveMessageKeys(rm, { vault: ids.vault, deviceId: ids.phone }), TypeError);
  await assert.rejects(deriveMessageKeys(rm, { vault: ids.vault, deviceId: ids.phone, role: "relay" }), TypeError);
});
