// Run ONCE to (re)create test/vectors.json. Synthetic keys only. Regenerating changes the file: do it on purpose.
//   node packages/eleven-protocol/test/make-vectors.mjs
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { b64uEncode, generateKeyAgreementKeyPair, exportPublicKey, fingerprint, deriveMessageKeys, deriveRoot, jcs } from "../src/index.js";
import { _sealWithNonceForVectors } from "../src/envelope.js";

const out = fileURLToPath(new URL("./vectors.json", import.meta.url));
if (existsSync(out) && !process.argv.includes("--force")) { console.error("vectors.json exists; pass --force to overwrite"); process.exit(1); }
const subtle = globalThis.crypto.subtle;
const hex = (u) => Buffer.from(u).toString("hex");
const jwkOf = async (k) => subtle.exportKey("jwk", k);

const mkx = await generateKeyAgreementKeyPair({ extractable: true });
const pkx = await generateKeyAgreementKeyPair({ extractable: true });
const msig = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pairingId = "pr_dGVzdFBhaXJpbmcwMDAwMQ";
const secret = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const vault = "vlt_Q2xhc3NpY0FjbWVOb3Rlcw";
const machine = "dev_bWFjaGluZUFjbWUwMDAx";
const phone = "dev_cGhvbmVQaXhlbDgwMDAx";

const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pkx.publicKey }, mkx.privateKey, 256));
const root = await deriveRoot({ privateKey: mkx.privateKey, peerPublicKey: pkx.publicKey, pairingId, secret });
const keys = await deriveMessageKeys(root, { vault, deviceId: phone, epoch: 0, extractable: true });
const rawKey = async (k) => new Uint8Array(await subtle.exportKey("raw", k));
const mkxSpki = await exportPublicKey(mkx.publicKey);
const msigSpki = new Uint8Array(await subtle.exportKey("spki", msig.publicKey));
const fpr = await fingerprint(mkxSpki, msigSpki);

const nonce = (n) => Uint8Array.from({ length: 12 }, (_, i) => n + i);
const mk = async (name, fields, inner, key, n) => {
  const env = await _sealWithNonceForVectors(fields, inner, key, nonce(n));
  return { name, key: key === keys.m2p ? "m2p" : "p2m", envelope: env, inner: JSON.parse(jcs(inner)) };
};
const base = { vault, id: "5b0c6f8e-1f2a-4c3d-9e4f-0a1b2c3d4e5f", ts: 1793779200000 };
const messages = [
  await mk("manifest", { ...base, type: "manifest", from: machine, to: phone }, { t: "manifest", seq: 1, ts: 1793779200000, files: [] }, keys.m2p, 1),
  await mk("file with unicode", { ...base, type: "file", from: machine, to: phone, fid: "k3J9xQ0aZ1bY2cX3dW4eV5" }, { t: "file", seq: 2, ts: 1793779201000, text: "# Café مرحبا 🚀\n" }, keys.m2p, 20),
  await mk("action", { ...base, id: "7c1d2e3f-4a5b-4c6d-8e7f-0a9b8c7d6e5f", type: "action", from: phone, to: "machine" },
    { t: "action", seq: 37, ts: 1793779260000, actionId: "9d3e2c1b-7a6f-4e5d-8c4b-3a2f1e0d9c8b", createdAt: 1793779260000, kind: "answer", item: "009-share-a-note", payload: { text: "yes" } }, keys.p2m, 40),
];
const vectors = {
  note: "Synthetic keys only. Generated once by make-vectors.mjs. Hex = lowercase hex of raw bytes.",
  vault, machine, phone, pairingId, secretHex: hex(secret),
  mkx: { private: await jwkOf(mkx.privateKey), spkiB64u: b64uEncode(mkxSpki) },
  pkx: { private: await jwkOf(pkx.privateKey), spkiB64u: b64uEncode(await exportPublicKey(pkx.publicKey)) },
  msigSpkiB64u: b64uEncode(msigSpki),
  fingerprintB64u: fpr.b64u,
  sharedHex: hex(shared),
  kM2pHex: hex(await rawKey(keys.m2p)),
  kP2mHex: hex(await rawKey(keys.p2m)),
  messages,
};
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log("wrote", out);
