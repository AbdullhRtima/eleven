// Run ONCE to (re)create test/pair-vectors.json (pairing: link, check words, sealed claim and accept). Synthetic bytes only: the
// public keys are patterned bytes, not real keys (only hashed or carried as text). Regenerating changes the file: do it on purpose.
//   node packages/eleven-protocol/test/make-pair-vectors.mjs [--force]
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { b64uEncode, buildLink, checkWords, sealClaim, sealAccept, buildAccept } from "../src/index.js";

const out = fileURLToPath(new URL("./pair-vectors.json", import.meta.url));
if (existsSync(out) && !process.argv.includes("--force")) { console.error("pair-vectors.json exists; pass --force to overwrite"); process.exit(1); }
const fill = (n, f) => Uint8Array.from({ length: n }, (_, i) => (f + i * 7) & 255);
const hex = (u) => Buffer.from(u).toString("hex");
const secret = fill(32, 1), fpr = fill(32, 50);
const pairingId = "pr_AbCdEfGhIjKlMnOpQrStUv";
const kx = fill(91, 3), au = fill(91, 9), act = fill(91, 17);
const ivClaim = fill(12, 100), ivAccept = fill(12, 120);
const accountId = "acc_alice";
const claim = { phoneKxPub: b64uEncode(kx), phoneAuthPub: b64uEncode(au), phoneActKey: { alg: "es256", credId: "c1", pub: b64uEncode(act) }, deviceName: "Pixel 8", accountId, emailMasked: "a•••@example.com", mode: "write" };
const accept = buildAccept({ machineKxPub: b64uEncode(fill(91, 21)), machineSigPub: b64uEncode(fill(91, 30)), vault: "vlt_" + "A".repeat(22), deviceId: "dev_" + "B".repeat(22), machineLabel: "mac-mini", mode: "write", machineDeviceId: "dev_" + "M".repeat(22) });

const v = {
  note: "Synthetic. Seals use a fixed 12-byte IV so the output is reproducible; real seals use a random IV. Kpair = HKDF-SHA-256(secret, salt = UTF-8 pairingId, info = 'eleven/v1/pair') -> AES-256-GCM, AAD = 'eleven/v1/<claim|accept>|' + pairingId. sealed = b64u(iv || ciphertext || tag). Plaintext = JSON.stringify(object) in the key order shown (NOT JCS).",
  pairingId, secretHex: hex(secret), fprHex: hex(fpr), accountId,
  link: { pwa: "https://m.eleven.rtima.org", text: buildLink("https://m.eleven.rtima.org", { pairingId, secret, fpr }) },
  words: {
    phoneKxPubHex: hex(kx), phoneAuthPubHex: hex(au), phoneActPubHex: hex(act),
    withAct: await checkWords({ pairingId, fpr, phoneKxPub: kx, phoneAuthPub: au, phoneActPub: act, accountId }),
    readOnly: await checkWords({ pairingId, fpr, phoneKxPub: kx, phoneAuthPub: au, accountId }),
  },
  claim: { ivHex: hex(ivClaim), object: claim, plaintext: JSON.stringify(claim), sealed: await sealClaim(secret, pairingId, claim, ivClaim) },
  accept: { ivHex: hex(ivAccept), object: accept, plaintext: JSON.stringify(accept), sealed: await sealAccept(secret, pairingId, accept, ivAccept) },
};
writeFileSync(out, JSON.stringify(v, null, 2) + "\n");
console.log("wrote", out);
