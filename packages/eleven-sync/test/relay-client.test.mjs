import test from "node:test";
import assert from "node:assert/strict";
import { startFakeRelay } from "./fake-relay.mjs";
import { createRelayClient, createVault, RelayError, LIMITS } from "../src/relay-client.js";
import {
  generateSigningKeyPair, generateKeyAgreementKeyPair, exportPublicKey, deriveRoot, deriveMessageKeys, b64uEncode,
} from "../../eleven-protocol/src/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(5); } throw new Error("timeout waiting for condition"); };
const fastBackoff = { baseMs: 5, maxMs: 20 };
const MARKER = "ZXQ-PLAINTEXT-MARKER-4471";

// A machine with a vault on the fake, and a simulated phone registered with its own PAUTH key and derived L6 keys.
async function world(fake, { phone = true, clientOpts = {} } = {}) {
  const msig = await generateSigningKeyPair();
  const { vault, deviceId } = await createVault({ baseUrl: fake.url, machineSigPubSpki: await exportPublicKey(msig.publicKey) });
  const out = { vault, machineId: deviceId, msig };
  out.machine = createRelayClient({ baseUrl: fake.url, vault, deviceKeys: { deviceId, signingKey: msig.privateKey }, backoff: fastBackoff, pingMs: 0, ...clientOpts });
  if (phone) {
    const pauth = await generateSigningKeyPair();
    const phoneId = fake.addPhone(vault, await exportPublicKey(pauth.publicKey));
    const mkx = await generateKeyAgreementKeyPair(), pkx = await generateKeyAgreementKeyPair();
    const pairingId = "pr_" + b64uEncode(crypto.getRandomValues(new Uint8Array(16))).slice(0, 22);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const mRoot = await deriveRoot({ privateKey: mkx.privateKey, peerPublicKey: pkx.publicKey, pairingId, secret });
    const pRoot = await deriveRoot({ privateKey: pkx.privateKey, peerPublicKey: mkx.publicKey, pairingId, secret });
    const mk = await deriveMessageKeys(mRoot, { vault, deviceId: phoneId, role: "machine" });
    const pk = await deriveMessageKeys(pRoot, { vault, deviceId: phoneId, role: "phone" });
    out.phoneId = phoneId; out.pauth = pauth; out.mk = mk; out.pk = pk;
    out.machine.addPeer(phoneId, mk);
    out.phone = createRelayClient({ baseUrl: fake.url, vault, role: "phone", deviceKeys: { deviceId: phoneId, signingKey: pauth.privateKey }, peers: { [deviceId]: pk }, backoff: fastBackoff, pingMs: 0 });
  }
  return out;
}
const withFake = (fn) => async () => { const fake = await startFakeRelay(); try { await fn(fake); } finally { await fake.close(); } };
const collect = (client, name = "message") => { const got = []; client.on(name, (m) => got.push(m)); return got; };
const action = (extra = {}) => ({ t: "action", actionId: crypto.randomUUID(), createdAt: Date.now(), kind: "answer", item: "009-share-a-note", answer: MARKER, ...extra });

// ---- auth (5)
test("auth: a signed request succeeds, with no bearer token on the wire", withFake(async (fake) => {
  const w = await world(fake, { phone: false });
  const seenAuth = [];
  const f = (u, init) => { if (init?.headers?.authorization) seenAuth.push(init.headers.authorization); return fetch(u, init); };
  const c = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: w.machineId, signingKey: w.msig.privateKey }, fetch: f });
  const devices = await c.devices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceId, w.machineId);
  assert.deepEqual(Object.keys(devices[0]).sort(), ["createdAt", "deviceId", "mode", "push", "role"]);
  assert.equal(seenAuth.length, 1);
  assert.match(seenAuth[0], /^Eleven-Sig dev=dev_[\w-]+, nonce=[\w-]+, sig=[\w-]{86}$/);
  assert.ok(!/bearer/i.test(seenAuth[0]));
  assert.equal(fake.stats.challenges, 1);
}));

test("auth: wrong key, unknown device, replayed nonce and a bad vault are refused", withFake(async (fake) => {
  const w = await world(fake, { phone: false });
  const other = await generateSigningKeyPair();
  const forged = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: w.machineId, signingKey: other.privateKey } });
  await assert.rejects(forged.devices(), (e) => e instanceof RelayError && e.code === "auth_failed" && e.status === 401);
  const stranger = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: "dev_unknownunknownunknown", signingKey: other.privateKey } });
  await assert.rejects(stranger.devices(), (e) => e.code === "device_unknown" && e.status === 401);

  // replay: capture one valid Authorization header and send it twice
  let captured;
  const spy = (u, init) => { if (init?.headers?.authorization) captured = { u, init }; return fetch(u, init); };
  const c = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: w.machineId, signingKey: w.msig.privateKey }, fetch: spy });
  await c.devices();
  const again = await fetch(captured.u, captured.init);
  assert.equal(again.status, 401);
  assert.equal((await again.json()).error, "auth_failed");

  // a signature for one path does not work for another
  const sig = captured.init.headers.authorization;
  const res = await fetch(new URL(`/v1/vault/${w.vault}/inbox?after=0`, fake.url), { headers: { authorization: sig } });
  assert.equal(res.status, 401);
  assert.ok(fake.stats.authFailures >= 4);
}));

test("auth: a vault id that is not the device's vault is forbidden", withFake(async (fake) => {
  const a = await world(fake, { phone: false }), b = await world(fake, { phone: false });
  const cross = createRelayClient({ baseUrl: fake.url, vault: b.vault, deviceKeys: { deviceId: a.machineId, signingKey: a.msig.privateKey } });
  await assert.rejects(cross.devices(), (e) => e.code === "forbidden" && e.status === 403);
}));

test("limits: the fake refuses an oversized body (413) and createVault rejects a bad key", withFake(async (fake) => {
  const res = await fetch(new URL("/v1/challenge", fake.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: "dev_" + "a".repeat(2_000_000) }) });
  assert.equal(res.status, 413);
  await assert.rejects(createVault({ baseUrl: fake.url, machineSigPubSpki: new Uint8Array(10) }), (e) => e.code === "bad_request");
}));

// ---- tickets (5.4)
test("ws-ticket: single use. The second connection with the same ticket is refused", withFake(async (fake) => {
  const w = await world(fake, { phone: false });
  const ticket = await w.machine.wsTicket();
  const open = (t) => new Promise((resolve) => {
    const s = new WebSocket(`${fake.url.replace("http", "ws")}/v1/vault/${w.vault}/ws?ticket=${t}`);
    s.onopen = () => resolve({ ok: true, s });
    s.onerror = () => resolve({ ok: false });
  });
  const first = await open(ticket);
  assert.ok(first.ok);
  const second = await open(ticket);
  assert.equal(second.ok, false);
  assert.ok(fake.stats.ticketReuse >= 1);   // Node 24's WebSocket retries a refused handshake once; what matters is that it never opens
  assert.equal((await open("not-a-ticket")).ok, false);
  first.s.close();
  // the client asks for a new ticket on every connection
  assert.notEqual(await w.machine.wsTicket(), ticket);
}));

// ---- the round trip (13, 4, L6)
test("round trip: machine -> relay -> phone -> relay -> machine, sealed with the L6 keys; the relay sees no plaintext", withFake(async (fake) => {
  const w = await world(fake);
  const onPhone = collect(w.phone), onMachine = collect(w.machine);
  await Promise.all([w.machine.connect(), w.phone.connect()]);

  const manifest = { t: "manifest", files: [{ fid: "k3J9xQ0aZ1bY2cX3dW4eV5", path: `work/${MARKER}/brief.md`, size: 12 }], dirs: [], prevHash: null, hash: "h" };
  const mid = await w.machine.send("manifest", w.phoneId, manifest);
  await until(() => onPhone.length === 1);
  assert.equal(onPhone[0].id, mid);
  assert.equal(onPhone[0].type, "manifest");
  assert.equal(onPhone[0].inner.files[0].path, `work/${MARKER}/brief.md`);
  assert.equal(onPhone[0].inner.seq, 1);

  await w.machine.send("file", w.phoneId, { t: "file", fid: "k3J9xQ0aZ1bY2cX3dW4eV5", sha256: "x", text: `# Brief ${MARKER}` }, { fid: "k3J9xQ0aZ1bY2cX3dW4eV5" });
  await until(() => onPhone.length === 2);
  assert.equal(onPhone[1].inner.text, `# Brief ${MARKER}`);
  assert.equal(onPhone[1].inner.seq, 2);

  const a = action();
  const aid = await w.phone.send("action", w.machineId, a);
  await until(() => onMachine.length === 1);
  assert.equal(onMachine[0].id, aid);
  assert.equal(onMachine[0].from, w.phoneId);
  assert.equal(onMachine[0].inner.actionId, a.actionId);
  assert.equal(onMachine[0].inner.answer, MARKER);

  // the machine acks the action; the relay drops it; then it seals a result back
  w.machine.ack([aid]);
  await until(() => fake.queue(w.vault, w.machineId).length === 0);
  await w.machine.send("result", w.phoneId, { t: "action_result", actionId: a.actionId, status: "ok" });
  await until(() => onPhone.length === 3);
  assert.equal(onPhone[2].inner.status, "ok");

  // the relay stored and saw only ciphertext
  const stored = fake.storedBytes();
  assert.ok(stored.length > 1000);
  assert.ok(!stored.includes(MARKER), "plaintext marker leaked to the relay");
  assert.ok(!stored.includes("brief.md"));
  assert.ok(!stored.includes("answer"));
  for (const rec of fake.queue(w.vault, w.phoneId)) { assert.ok(typeof rec.ct === "string" && typeof rec.n === "string"); assert.equal(rec.epoch, 0); }
  await Promise.all([w.machine.close(), w.phone.close()]);
}));

test("L6: a client cannot send with its receive key (decrypt-only), in either role", withFake(async (fake) => {
  const w = await world(fake);
  await Promise.all([w.machine.connect(), w.phone.connect()]);
  w.machine.addPeer("dev_swapped", { send: w.mk.recv, recv: w.mk.send });
  await assert.rejects(w.machine.send("hello", "dev_swapped", { t: "hello" }), (e) => e.code === "bad_key");
  w.phone.addPeer("dev_swapped", { send: w.pk.recv, recv: w.pk.send });
  await assert.rejects(w.phone.send("action", "dev_swapped", action()), (e) => e.code === "bad_key");
  await Promise.all([w.machine.close(), w.phone.close()]);
}));

test("types the machine does not accept (e.g. a manifest sent to it) are dropped and counted", withFake(async (fake) => {
  const w = await world(fake);
  const got = collect(w.machine), drops = collect(w.machine, "drop");
  await Promise.all([w.machine.connect(), w.phone.connect()]);
  // the fake only lets a phone send req/action, so inject a wrong-type frame straight to the machine's socket
  fake.hint(w.vault, w.machineId, { v: 1, type: "manifest", vault: w.vault, from: w.phoneId, to: "machine", id: crypto.randomUUID(), ts: 1, epoch: 0, n: "AAAA", ct: "AAAA" });
  await until(() => drops.length === 1);
  assert.equal(drops[0].reason, "type_not_accepted");
  assert.equal(got.length, 0);
  await Promise.all([w.machine.close(), w.phone.close()]);
}));

test("a message that fails to decrypt is dropped and counted (4.4), and later messages still flow", withFake(async (fake) => {
  const w = await world(fake);
  const onMachine = collect(w.machine), failed = collect(w.machine, "decrypt_failed");
  // swap the phone's send key for an unrelated one: the machine cannot open its messages
  const wrong = await deriveMessageKeys(await deriveRoot({
    privateKey: (await generateKeyAgreementKeyPair()).privateKey, peerPublicKey: (await generateKeyAgreementKeyPair()).publicKey,
    pairingId: "pr_wrongwrongwrongwrong", secret: crypto.getRandomValues(new Uint8Array(32)),
  }), { vault: w.vault, deviceId: w.phoneId, role: "phone" });
  const evil = createRelayClient({ baseUrl: fake.url, vault: w.vault, role: "phone", deviceKeys: { deviceId: w.phoneId, signingKey: w.pauth.privateKey }, peers: { [w.machineId]: wrong }, backoff: fastBackoff, pingMs: 0 });
  await Promise.all([w.machine.connect(), evil.connect()]);
  await evil.send("action", w.machineId, action());
  await until(() => failed.length === 1);
  assert.equal(onMachine.length, 0);
  assert.equal(w.machine.stats.dropped, 1);
  await Promise.all([w.machine.close(), evil.close()]);
}));

test("catch-up: messages queued while the machine was away arrive through the inbox on connect, once", withFake(async (fake) => {
  const w = await world(fake);
  await w.phone.connect();
  const a1 = action(), a2 = action();
  await w.phone.send("action", w.machineId, a1);
  await w.phone.send("action", w.machineId, a2);
  await until(() => fake.queue(w.vault, w.machineId).length === 2);
  const got = collect(w.machine);
  await w.machine.connect();
  await sleep(50);
  assert.deepEqual(got.map((m) => m.inner.actionId), [a1.actionId, a2.actionId]);
  assert.equal(w.machine.lastRseq, 2);
  await Promise.all([w.machine.close(), w.phone.close()]);
}));

// ---- reconnect
test("reconnect: after the relay drops the connection the client reconnects with a new ticket and traffic resumes", withFake(async (fake) => {
  const w = await world(fake);
  const onMachine = collect(w.machine);
  let opens = 0; w.machine.on("open", () => opens++);
  await Promise.all([w.machine.connect(), w.phone.connect()]);
  await w.phone.send("action", w.machineId, action());
  await until(() => onMachine.length === 1);

  fake.dropConnections();
  await until(() => opens === 2 && w.machine.connected && w.phone.connected);
  assert.equal(w.machine.stats.reconnects, 1);

  const a = action();
  await w.phone.send("action", w.machineId, a);
  await until(() => onMachine.length === 2);
  assert.equal(onMachine[1].inner.actionId, a.actionId);
  await Promise.all([w.machine.close(), w.phone.close()]);
}));

test("reconnect: backs off with growing delays while the relay is unreachable, then recovers", async () => {
  const fake = await startFakeRelay();
  const w = await world(fake);
  const sleeps = [];
  const m = createRelayClient({
    baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: w.machineId, signingKey: w.msig.privateKey }, pingMs: 0,
    backoff: { baseMs: 100, maxMs: 800, random: () => 0.999 }, sleep: async (ms) => { sleeps.push(ms); await sleep(1); },
  });
  fake.rateLimit({ count: 3, where: "upgrade", retryAfter: 1 });      // three handshakes fail
  await m.connect();
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps[0] < sleeps[1] && sleeps[1] < sleeps[2], `delays should grow: ${sleeps}`);
  assert.ok(sleeps.every((x) => x <= 800));
  await m.close();
  await fake.close();
});

test("a fatal error (device_unknown) stops the loop instead of retrying forever", withFake(async (fake) => {
  const w = await world(fake, { phone: false });
  const other = await generateSigningKeyPair();
  const m = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: "dev_nobodynobodynobodyxx", signingKey: other.privateKey }, backoff: fastBackoff, pingMs: 0 });
  await assert.rejects(m.connect(), (e) => e.code === "device_unknown");
  const before = fake.stats.challenges;
  await sleep(60);
  assert.equal(fake.stats.challenges, before);
}));

test("revocation hint from the relay is surfaced as a hint, not acted on", withFake(async (fake) => {
  const w = await world(fake);
  const hints = collect(w.phone, "hint");
  await w.phone.connect();
  fake.hint(w.vault, w.phoneId, { type: "device_revoked", deviceId: w.phoneId });
  await until(() => hints.some((h) => h.type === "device_revoked"));
  assert.equal(hints.find((h) => h.type === "device_revoked").deviceId, w.phoneId);
  assert.ok(w.phone.connected);
  await w.phone.close();
}));

// ---- rate_limited (12, 14)
test("rate_limited over HTTP: waits at least retryAfter, then retries and succeeds", withFake(async (fake) => {
  const sleeps = [];
  const w = await world(fake, { phone: false, clientOpts: { sleep: async (ms) => { sleeps.push(ms); } } });
  fake.rateLimit({ count: 2, retryAfter: 3, where: "http", match: /\/devices$/ });
  const events = collect(w.machine, "rate_limited");
  const devices = await w.machine.devices();
  assert.equal(devices.length, 1);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms >= 3000), `slept ${sleeps}`);
  assert.equal(events.length, 2);
}));

test("rate_limited gives up after maxHttpRetries and reports the code", withFake(async (fake) => {
  const w = await world(fake, { phone: false, clientOpts: { sleep: async () => {}, maxHttpRetries: 2 } });
  fake.rateLimit({ count: 99, retryAfter: 1, where: "http", match: /\/devices$/ });
  await assert.rejects(w.machine.devices(), (e) => e.code === "rate_limited" && e.status === 429 && e.retryAfter === 1);
}));

test("rate_limited over the WebSocket: the client pauses sending for retryAfter", withFake(async (fake) => {
  const sleeps = [];
  const w = await world(fake, { clientOpts: { sleep: async (ms) => { sleeps.push(ms); } } });
  const rl = collect(w.machine, "rate_limited");
  await Promise.all([w.machine.connect(), w.phone.connect()]);
  fake.rateLimit({ count: 1, retryAfter: 4, where: "ws" });
  await w.machine.send("tick", w.phoneId, { t: "tick" });
  await until(() => rl.length === 1);
  assert.equal(rl[0].retryAfter, 1, "the contract's error frame has no retryAfter: one second");
  await w.machine.send("tick", w.phoneId, { t: "tick" });       // waits first
  assert.ok(sleeps.some((ms) => ms > 500 && ms <= 1000), `slept ${sleeps}`);
  // L-7: a relay hint cannot mute the client for more than an hour
  fake.hint(w.vault, w.machineId, { type: "error", error: "rate_limited", retryAfter: 2_000_000 });
  await until(() => rl.length === 2);
  assert.equal(rl[1].retryAfter, 3600);
  assert.ok(rl[1].waitMs <= 3_600_000);
  await Promise.all([w.machine.close(), w.phone.close()]);
}));

// ---- client-side limits (14)
test("limits: an oversize message is refused client-side, before it reaches the relay", withFake(async (fake) => {
  const w = await world(fake);
  await Promise.all([w.machine.connect(), w.phone.connect()]);
  const onPhone = collect(w.phone);
  const frames = fake.storedBytes().length;
  await assert.rejects(
    w.machine.send("file", w.phoneId, { t: "file", fid: "k3J9xQ0aZ1bY2cX3dW4eV5", sha256: "x", text: "x".repeat(1_200_000) }, { fid: "k3J9xQ0aZ1bY2cX3dW4eV5" }),
    (e) => e instanceof RelayError && e.code === "too_large");
  await sleep(40);
  assert.equal(fake.storedBytes().length, frames, "nothing may have reached the relay");
  assert.equal(onPhone.length, 0);
  // just under the limit still goes through
  await w.machine.send("file", w.phoneId, { t: "file", fid: "k3J9xQ0aZ1bY2cX3dW4eV5", sha256: "x", text: "x".repeat(700_000) }, { fid: "k3J9xQ0aZ1bY2cX3dW4eV5" });
  await until(() => onPhone.length === 1);
  await Promise.all([w.machine.close(), w.phone.close()]);
}));

test("limits: push body over 4096 bytes is refused; 30 pushes per hour is the cap", withFake(async (fake) => {
  const w = await world(fake, { clientOpts: { now: () => 1_800_000_000_000 } });
  await w.machine.connect();
  const subId = fake.setPush(w.vault, w.phoneId);
  const push = (n) => w.machine.sendPush({ to: w.phoneId, subId, topic: "t", bodyBytes: new Uint8Array(n) });
  await assert.rejects(push(LIMITS.pushBodyBytes + 1), (e) => e.code === "too_large");
  for (let i = 0; i < 30; i++) await push(100);
  await assert.rejects(push(100), (e) => e.code === "rate_limited");
  await until(() => fake.pushes.length === 30);
  await w.machine.close();
}));

test("gone: sent without ciphertext and deletes the stored file", withFake(async (fake) => {
  const w = await world(fake);
  await Promise.all([w.machine.connect(), w.phone.connect()]);
  const fid = "k3J9xQ0aZ1bY2cX3dW4eV5";
  await w.machine.send("file", w.phoneId, { t: "file", fid, sha256: "x", text: "hi" }, { fid });
  await until(() => fake.queue(w.vault, w.phoneId).some((x) => x.type === "file"));
  await w.machine.sendGone(fid, w.phoneId);
  await until(() => !fake.queue(w.vault, w.phoneId).some((x) => x.type === "file"));
  await Promise.all([w.machine.close(), w.phone.close()]);
}));

test("revokeDevice: signed DELETE; the revoked phone is refused afterwards", withFake(async (fake) => {
  const w = await world(fake);
  await w.machine.revokeDevice(w.phoneId);
  await assert.rejects(w.phone.devices(), (e) => e.code === "device_unknown");
}));

// ---- pairing endpoints (6.2)
test("pairing: signed POST /v1/pair returns the ticket; the machine socket gets the claim and answers with t:accept", withFake(async (fake) => {
  const w = await world(fake, { phone: false });
  const { pairingId, expires, wsTicket } = await w.machine.startPairing();
  assert.match(pairingId, /^pr_[A-Za-z0-9_-]{22}$/);
  assert.ok(expires > Date.now());
  assert.equal(typeof wsTicket, "string");
  assert.equal(w.machine.pairingTicket, undefined, "no separate pairing ws-ticket call");
  const ch = await w.machine.openPairing(pairingId, wsTicket);
  const claims = [], results = []; ch.onClaim((c) => claims.push(c)); ch.onResult((r) => results.push(r));
  fake.claim(pairingId, { sealed: "SEALED", relayAccountId: "acc_1", relayEmailMasked: "a***@example.com" });
  await until(() => claims.length === 1);
  assert.equal(claims[0].relayAccountId, "acc_1");
  assert.throws(() => ch.accept("S", "act"), /write|read/);
  ch.refuse();
  await until(() => fake.pairingReplies(pairingId).length === 1);
  assert.deepEqual(fake.pairingReplies(pairingId)[0], { t: "refuse" });
  ch.close();
}));

test("pairing: a pairing ticket works once", withFake(async (fake) => {
  const w = await world(fake, { phone: false });
  const { pairingId, wsTicket } = await w.machine.startPairing();
  (await w.machine.openPairing(pairingId, wsTicket)).close();
  await assert.rejects(w.machine.openPairing(pairingId, wsTicket));
}));

test("no WebSocket available: connect() fails with a clear fatal error (Node 20 needs an injected WebSocket)", withFake(async (fake) => {
  const w = await world(fake, { phone: false, clientOpts: { WebSocket: null } });
  const c = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: w.machineId, signingKey: w.msig.privateKey }, WebSocket: null, backoff: fastBackoff });
  await assert.rejects(c.connect(), (e) => e.code === "no_websocket");
}));
