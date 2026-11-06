import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  b64uEncode, checkWords, buildLink, parseLink, parseFragment, sealPairing, sealClaim, openClaim, sealAccept, openAccept, buildAccept, WORDS,
} from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("./pair-vectors.json", import.meta.url), "utf8"));
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const secret = unhex(V.secretHex), fpr = unhex(V.fprHex);

test("word list: 2048 BIP-39 words, known hash", async () => {
  assert.equal(WORDS.length, 2048);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(WORDS.join("\n") + "\n")));
  assert.equal(Buffer.from(h).toString("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
});
test("vectors: check words", async () => {
  const base = { pairingId: V.pairingId, fpr, phoneKxPub: unhex(V.words.phoneKxPubHex), phoneAuthPub: unhex(V.words.phoneAuthPubHex), accountId: V.accountId };
  assert.deepEqual(await checkWords({ ...base, phoneActPub: unhex(V.words.phoneActPubHex) }), V.words.withAct);
  assert.deepEqual(await checkWords(base), V.words.readOnly);
});
test("vectors: link and fragment", () => {
  assert.equal(buildLink(V.link.pwa, { pairingId: V.pairingId, secret, fpr }), V.link.text);
  const p = parseLink(V.link.text);
  assert.deepEqual([p.pairingId, b64uEncode(p.secret), b64uEncode(p.fpr)], [V.pairingId, b64uEncode(secret), b64uEncode(fpr)]);
  assert.deepEqual(parseFragment("#" + V.link.text.split("#")[1]).secret, secret);
  for (const bad of ["", "v2." + V.link.text.split("#")[1].slice(3), V.link.text.slice(0, -1), V.link.text + "=", V.link.text.replace("pr_", "xx_")]) assert.throws(() => parseLink(bad));
});
test("vectors: sealed claim and accept are byte-identical and open", async () => {
  assert.equal(await sealClaim(secret, V.pairingId, V.claim.object, unhex(V.claim.ivHex)), V.claim.sealed);
  assert.equal(await sealAccept(secret, V.pairingId, V.accept.object, unhex(V.accept.ivHex)), V.accept.sealed);
  assert.equal(JSON.stringify(await openClaim(secret, V.pairingId, V.claim.sealed)), V.claim.plaintext);
  assert.equal(JSON.stringify(await openAccept(secret, V.pairingId, V.accept.sealed)), V.accept.plaintext);
});
test("the accept carries machineDeviceId last, and a missing or malformed one is refused at build", () => {
  assert.deepEqual(Object.keys(V.accept.object), ["machineKxPub", "machineSigPub", "vault", "deviceId", "machineLabel", "mode", "machineDeviceId"]);
  const { machineDeviceId, ...rest } = V.accept.object;
  assert.throws(() => buildAccept(rest), /machineDeviceId/);
  assert.throws(() => buildAccept({ ...rest, machineDeviceId: "dev_short" }), /device id/);
});
test("purpose and pairingId are bound in the AAD; a wrong secret fails", async () => {
  await assert.rejects(openAccept(secret, V.pairingId, V.claim.sealed));
  await assert.rejects(openClaim(secret, "pr_" + "Z".repeat(22), V.claim.sealed));
  await assert.rejects(openClaim(new Uint8Array(32), V.pairingId, V.claim.sealed));
  assert.notEqual(await sealPairing(secret, V.pairingId, "claim", {}), await sealPairing(secret, V.pairingId, "claim", {}), "a random IV by default");
});
test("pairing.js and wordlist.js import nothing from node:", () => {
  for (const f of ["pairing.js", "wordlist.js"]) assert.doesNotMatch(readFileSync(new URL("../src/" + f, import.meta.url), "utf8"), /from "node:|import\("node:/);
});
