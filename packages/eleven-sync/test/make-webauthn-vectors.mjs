// Makes webauthn-vectors.json: one synthetic passkey assertion for protocol 8.2 (a fresh P-256 key, made-up ids, nothing real).
// Run: node packages/eleven-sync/test/make-webauthn-vectors.mjs   (the signature is random, so a rerun changes the file; the test only needs it to verify)
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { webauthnSig, actionToSign, canon } from "./phone-sim.mjs";

const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const vault = "vlt_AAAAAAAAAAAAAAAAAAAAAA", deviceId = "dev_BBBBBBBBBBBBBBBBBBBBBB";
const action = { t: "action", seq: 3, ts: 1793779260000, actionId: "9d3e2c1b-7a6f-4e5d-8c4b-3a2f1e0d9c8b", createdAt: 1793779260000, kind: "answer", item: "010-export", target: "brief", pre: { qHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, payload: { answer: "Markdown first." } };
const jcs = canon(action), signedInput = `eleven/v1/action|${vault}|${deviceId}|${jcs}`, toSign = actionToSign(vault, deviceId, action);
const sig = webauthnSig(key.privateKey, toSign, { counter: 0 });
const out = {
  note: "Synthetic. toSign = b64u(SHA-256(signedInput)); the WebAuthn challenge is the RAW 32-byte digest, so clientDataJSON.challenge === toSign. signature is ASN.1 DER over authenticatorData || SHA-256(clientDataJSON). pub = b64u SPKI DER of the registered passkey key.",
  vault, deviceId, credId: "c1", pub: key.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  action, jcs, signedInput, toSign, sig,
  decoded: { authenticatorDataHex: Buffer.from(sig.authenticatorData, "base64url").toString("hex"), clientDataJSON: Buffer.from(sig.clientDataJSON, "base64url").toString("utf8") },
};
fs.writeFileSync(fileURLToPath(new URL("./webauthn-vectors.json", import.meta.url)), JSON.stringify(out, null, 2) + "\n");
console.log("wrote webauthn-vectors.json");
