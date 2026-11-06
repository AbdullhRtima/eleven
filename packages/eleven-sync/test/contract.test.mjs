// The fake relay against the relay wire contract (the agreed wire contract) and the client against the strict fake.
// If the fake were lenient, these tests would be meaningless, so each rule of the contract is exercised from the outside.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startFakeRelay } from "./fake-relay.mjs";
import { createRelayClient, createVault, RelayError } from "../src/relay-client.js";
import { generateSigningKeyPair, exportPublicKey, b64uEncode } from "../../eleven-protocol/src/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(5); } throw new Error("timeout waiting for condition"); };
const b64u = (b) => Buffer.from(b).toString("base64url");
const uuid = () => crypto.randomUUID();
const fast = { baseMs: 5, maxMs: 20 };

async function world(fake, { phones = 1 } = {}) {
  const msig = await generateSigningKeyPair();
  const { vault, deviceId } = await createVault({ baseUrl: fake.url, machineSigPubSpki: await exportPublicKey(msig.publicKey) });
  const w = { vault, machineId: deviceId, phones: [], msig };
  w.machine = createRelayClient({ baseUrl: fake.url, vault, deviceKeys: { deviceId, signingKey: msig.privateKey }, backoff: fast, pingMs: 0, maxHttpRetries: 0 });
  for (let i = 0; i < phones; i++) {
    const pauth = await generateSigningKeyPair();
    const id = fake.addPhone(vault, await exportPublicKey(pauth.publicKey));
    const client = createRelayClient({ baseUrl: fake.url, vault, role: "phone", deviceKeys: { deviceId: id, signingKey: pauth.privateKey }, backoff: fast, pingMs: 0, maxHttpRetries: 0 });
    w.phones.push({ id, client });
  }
  w.phoneId = w.phones[0]?.id; w.phone = w.phones[0]?.client;
  return w;
}
// a raw WebSocket as a device: every frame is kept as text
async function raw(fake, w, client) {
  const ticket = await client.wsTicket();
  const ws = new WebSocket(`${fake.url.replace("http", "ws")}/v1/vault/${w.vault}/ws?ticket=${ticket}`);
  const frames = [], closed = { code: null };
  ws.onmessage = (ev) => frames.push(String(ev.data));
  ws.onclose = (ev) => { closed.code = ev.code; };
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("ws failed")); });
  const json = () => frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
  return { ws, frames, closed, json, send: (o) => ws.send(typeof o === "string" ? o : JSON.stringify(o)), errors: () => json().filter((f) => f.type === "error") };
}
const env = (w, over = {}) => ({ v: 1, type: "tick", vault: w.vault, from: w.machineId, to: w.phoneId, id: uuid(), ts: Date.now(), epoch: 0, n: b64u(crypto.randomBytes(12)), ct: b64u(crypto.randomBytes(32)), ...over });
const withFake = (fn, o) => async () => { const fake = await startFakeRelay(o); try { await fn(fake); } finally { await fake.close(); } };

test("vault WS error frames are {type:'error', error, id?, message?}; the third bad frame closes the connection", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine);
  m.send("not json"); m.send("[1]"); 
  await until(() => m.errors().length === 2);
  assert.deepEqual(Object.keys(m.errors()[0]).sort(), ["error", "message", "type"], "no id for a frame without one");
  assert.equal(m.errors()[0].error, "bad_request");
  m.send({ ...env(w), v: 2 });
  await until(() => m.errors().length === 3);
  const e = m.errors()[2];
  assert.equal(e.error, "bad_request"); assert.match(e.id, /^[0-9a-f-]{36}$/, "the offending envelope's id is echoed when it is a UUID");
  m.send("{"); // a fourth would be the third BAD FRAME (non-object/unparseable): two unparseable above + this one
  await until(() => m.closed.code === 1008);
}));

test("ts is required; unknown envelope keys (a client-sent rseq) are rejected; vault/from must match; epoch 0", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine);
  const bad = async (over, omit) => { const e = env(w, over); if (omit) delete e[omit]; const n = m.errors().length; m.send(e); await until(() => m.errors().length === n + 1); return m.errors().at(-1); };
  assert.equal((await bad({}, "ts")).error, "bad_request");
  assert.equal((await bad({ rseq: 5 })).error, "bad_request");
  assert.equal((await bad({ extra: 1 })).error, "bad_request");
  assert.equal((await bad({ ts: -1 })).error, "bad_request");
  assert.equal((await bad({ ts: 1.5 })).error, "bad_request");
  assert.equal((await bad({ epoch: 1 })).error, "bad_request");
  assert.equal((await bad({ from: w.phoneId })).error, "forbidden");
  assert.equal((await bad({ vault: "vlt_" + "A".repeat(22) })).error, "forbidden");
  assert.equal((await bad({ type: "req" })).error, "forbidden", "a machine cannot send a phone type");
  assert.equal((await bad({ type: "bogus" })).error, "bad_request");
  assert.equal((await bad({}, "ct")).error, "bad_request", "ct is required except on gone");
  assert.equal((await bad({ n: "AAAA" })).error, "bad_request", "n is exactly 12 bytes");
  assert.equal((await bad({ fid: "k3J9xQ0aZ1bY2cX3dW4eV5" })).error, "bad_request", "fid only on file and gone");
}));

test("gone and tick need a real phone as `to`; gone has a nonce and no ciphertext; a revoked phone is refused", withFake(async (fake) => {
  const w = await world(fake, { phones: 2 });
  const m = await raw(fake, w, w.machine);
  const fid = "k3J9xQ0aZ1bY2cX3dW4eV5";
  const err = async (o) => { const n = m.errors().length; m.send(o); await sleep(60); return m.errors().length > n ? m.errors().at(-1).error : null; };
  assert.equal(await err(env(w, { type: "tick", to: "relay" })), "bad_request");
  assert.equal(await err(env(w, { type: "tick", to: "machine" })), "bad_request");
  assert.equal(await err(env(w, { type: "tick", to: "dev_" + "Q".repeat(22) })), "forbidden", "not a phone of this vault");
  assert.equal(await err(env(w, { type: "tick", to: w.machineId })), "forbidden");
  const gone = (over = {}) => { const e = env(w, { type: "gone", fid, ...over }); delete e.ct; return e; };
  assert.equal(await err(gone({ to: "relay" })), "bad_request");
  assert.equal(await err({ ...gone(), ct: b64u(crypto.randomBytes(32)) }), "bad_request", "gone must not carry ct");
  assert.equal(await err(gone()), null, "a valid gone is accepted (nothing comes back)");
  // gone deletes the stored file for EVERY device
  for (const p of w.phones) fake.queue(w.vault, p.id);   // (queues start empty)
  m.send(env(w, { type: "file", fid, to: w.phones[0].id })); m.send(env(w, { type: "file", fid, to: w.phones[1].id }));
  await until(() => fake.queue(w.vault, w.phones[0].id).length === 1 && fake.queue(w.vault, w.phones[1].id).length === 1);
  m.send(gone({ to: w.phones[0].id }));
  await until(() => fake.queue(w.vault, w.phones[0].id).length === 0 && fake.queue(w.vault, w.phones[1].id).length === 0);
  await w.machine.revokeDevice(w.phones[1].id);
  assert.equal(await err(env(w, { type: "tick", to: w.phones[1].id })), "forbidden", "no messages to a revoked phone");
}));

test("duplicates (from, id) are dropped silently; a tick is live only and carries no rseq; hello keeps the latest", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine), p = await raw(fake, w, w.phone);
  const e = env(w, { type: "hello" });
  m.send(e); m.send(e);
  await sleep(100);
  assert.equal(m.errors().length, 0, "no error for a duplicate");
  assert.equal(fake.stats.duplicates, 1);
  assert.equal(p.json().filter((f) => f.type === "hello").length, 1, "delivered once");
  m.send(env(w, { type: "hello" }));
  await until(() => p.json().filter((f) => f.type === "hello").length === 2);
  assert.equal(fake.queue(w.vault, w.phoneId).filter((x) => x.type === "hello").length, 1, "only the latest hello is stored");
  m.send(env(w, { type: "tick" }));
  const tick = await until(() => p.json().find((f) => f.type === "tick"));
  assert.equal("rseq" in tick, false);
  assert.equal(fake.queue(w.vault, w.phoneId).some((x) => x.type === "tick"), false);
  assert.ok(p.json().find((f) => f.type === "hello" && Number.isInteger(f.rseq)), "stored messages carry rseq");
}));

test("ack is {type:'ack', ids:[1..100 uuids]} with no other keys; it deletes only queued items addressed to the acking device", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine), p = await raw(fake, w, w.phone);
  const bad = async (o) => { const n = p.errors().length; p.send(o); await sleep(50); return p.errors().length > n ? p.errors().at(-1).error : null; };
  assert.equal(await bad({ type: "ack", ids: [] }), "bad_request");
  assert.equal(await bad({ type: "ack", ids: ["x"] }), "bad_request");
  assert.equal(await bad({ type: "ack", ids: [uuid()], extra: 1 }), "bad_request");
  assert.equal(await bad({ type: "ack", ids: Array.from({ length: 101 }, uuid) }), "bad_request");
  const r = env(w, { type: "result" }), t = env(w, { type: "hello" });
  m.send(r); m.send(t);
  await until(() => fake.queue(w.vault, w.phoneId).length === 2);
  assert.equal(await bad({ type: "ack", ids: [r.id, t.id, uuid()] }), null, "silent, even for unknown ids");
  await sleep(50);
  assert.deepEqual(fake.queue(w.vault, w.phoneId).map((x) => x.type), ["hello"], "a result is deleted, a state message is not");
}));

test("ping: the exact string {\"type\":\"ping\"} is answered {\"type\":\"pong\"}; the client sends exactly that string", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine);
  m.send('{"type":"ping"}');
  await until(() => m.frames.includes('{"type":"pong"}'));
  assert.equal(fake.stats.pings, 1);
  const c = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: w.machineId, signingKey: w.msig.privateKey }, pingMs: 20, backoff: fast });
  await c.connect();
  await until(() => fake.stats.pings >= 3);
  assert.equal(fake.stats.pingsOther, 0, "the client's ping has no other spacing");
  await c.close();
}));

test("inbox: ?after=&limit= -> {messages, next?}; default 100, max 500, limit=0 and junk are 400; next only when more exist", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine);
  for (let i = 0; i < 7; i++) m.send(env(w, { type: "result" }));
  await until(() => fake.queue(w.vault, w.phoneId).length === 7);
  const page = (q) => w.phone.request("GET", `/v1/vault/${w.vault}/inbox${q}`);
  const a = await page("?after=0&limit=3");
  assert.equal(a.messages.length, 3); assert.equal(a.next, a.messages[2].rseq);
  const b = await page(`?after=${a.next}&limit=3`);
  assert.equal(b.messages.length, 3);
  const c = await page(`?after=${b.next}&limit=3`);
  assert.equal(c.messages.length, 1); assert.equal("next" in c, false, "no next on the last page");
  assert.equal((await page("")).messages.length, 7);
  for (const q of ["?limit=0", "?limit=-1", "?limit=abc", "?after=-1", "?after=x"]) await assert.rejects(page(q), (e) => e.code === "bad_request", q);
  assert.equal((await page("?limit=100000")).messages.length, 7, "clamped to 500");
  // the client follows `next` to the end
  assert.equal((await w.phone.inbox(0)).length, 7);
}));

test("push frame: exact shape, subId must match the stored endpoint (else push_stale), 30/hour per vault (rate_limited with the id), duplicates silent", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine), p = await raw(fake, w, w.phone);
  const endpoint = "https://web.push.apple.com/abc123";
  const subId = b64u(crypto.createHash("sha256").update(endpoint).digest().subarray(0, 16));
  assert.equal(subId.length, 22);
  await w.phone.request("PUT", `/v1/vault/${w.vault}/devices/${w.phoneId}/push`, { subId, endpoint });
  const push = (over = {}) => ({ v: 1, type: "push", vault: w.vault, from: w.machineId, to: w.phoneId, id: uuid(), ts: Date.now(), epoch: 0, subId, body: b64u(crypto.randomBytes(100)), topic: "topic1", urgency: "high", ttl: 86400, ...over });
  const expectErr = async (o, code) => { const n = m.errors().length; m.send(o); await until(() => m.errors().length === n + 1); const e = m.errors().at(-1); assert.equal(e.error, code); if (o.id) assert.equal(e.id, o.id); };
  m.send(push()); await until(() => fake.pushes.length === 1);
  assert.equal(fake.pushes[0].endpoint, endpoint);
  await expectErr({ ...push(), n: b64u(crypto.randomBytes(12)) }, "bad_request");           // n/ct/fid are not allowed on a push
  await expectErr({ ...push(), ct: b64u(crypto.randomBytes(32)) }, "bad_request");
  await expectErr(push({ urgency: "urgent" }), "bad_request");
  await expectErr(push({ ttl: 86401 }), "bad_request");
  await expectErr(push({ topic: "bad topic!" }), "bad_request");
  await expectErr(push({ topic: "x".repeat(33) }), "bad_request");
  await expectErr(push({ body: b64u(Buffer.alloc(4097)) }), "bad_request");
  await expectErr(push({ to: "dev_" + "Q".repeat(22) }), "forbidden");
  const dup = push(); m.send(dup); m.send(dup); await sleep(60);
  assert.equal(fake.pushes.length, 2, "a duplicate id is dropped silently");
  const stale = push({ subId: b64u(crypto.randomBytes(16)) }); m.send(stale);
  const hint = await until(() => m.json().find((f) => f.type === "push_stale"));
  assert.equal(hint.subId, stale.subId); assert.equal(fake.pushes.length, 2);
  for (let i = 0; i < 28; i++) m.send(push());
  await until(() => fake.pushes.length === 30);
  await expectErr(push(), "rate_limited");
  assert.equal(fake.pushes.length, 30);
  // a phone may not push
  const n = p.errors().length; p.send({ ...push(), from: w.phoneId, to: "machine" }); await until(() => p.errors().length === n + 1);
  assert.equal(p.errors().at(-1).error, "forbidden");
  // a push service answering 410 deletes the endpoint and tells the machine
  fake.setPushService(410);
}));

test("push endpoint registration: phone only, https + known host, no port or fragment, subId = b64u(sha256(endpoint)[0..16])", withFake(async (fake) => {
  const w = await world(fake);
  const put = (c, id, body) => c.request("PUT", `/v1/vault/${w.vault}/devices/${id}/push`, body);
  const ep = "https://fcm.googleapis.com/fcm/send/xyz";
  const sub = (e) => b64u(crypto.createHash("sha256").update(e).digest().subarray(0, 16));
  assert.deepEqual(await put(w.phone, w.phoneId, { subId: sub(ep), endpoint: ep }), { ok: true });
  for (const [name, body] of [["wrong subId", { subId: sub("x"), endpoint: ep }], ["extra key", { subId: sub(ep), endpoint: ep, x: 1 }], ["http", { subId: sub("http://fcm.googleapis.com/x"), endpoint: "http://fcm.googleapis.com/x" }],
    ["host", { subId: sub("https://evil.example/x"), endpoint: "https://evil.example/x" }], ["port", { subId: sub("https://fcm.googleapis.com:443/x"), endpoint: "https://fcm.googleapis.com:443/x" }],
    ["fragment", { subId: sub(ep + "#a"), endpoint: ep + "#a" }]]) await assert.rejects(put(w.phone, w.phoneId, body), (e) => e.code === "bad_request", name);
  await assert.rejects(put(w.machine, w.phoneId, { subId: sub(ep), endpoint: ep }), (e) => e.code === "forbidden", "the machine may not register a phone's endpoint");
  assert.equal(fake.pushEndpoint(w.vault, w.phoneId).endpoint, ep);
  assert.deepEqual(await w.phone.request("DELETE", `/v1/vault/${w.vault}/devices/${w.phoneId}/push`), { ok: true });
  assert.equal(fake.pushEndpoint(w.vault, w.phoneId), null);
}));

test("devices and revoke: list shape; machine or the phone itself may revoke; the machine cannot be revoked; a repeat revoke is 204; device_revoked frames", withFake(async (fake) => {
  const w = await world(fake, { phones: 2 });
  const [a, b] = w.phones;
  const list = await w.machine.devices();
  assert.deepEqual(list.map((d) => d.role).sort(), ["machine", "phone", "phone"]);
  assert.ok(list.every((d) => typeof d.deviceId === "string" && typeof d.createdAt === "number" && typeof d.push === "boolean" && ["write", "read"].includes(d.mode)));
  const m = await raw(fake, w, w.machine), pa = await raw(fake, w, a.client);
  await assert.rejects(a.client.revokeDevice(b.id), (e) => e.code === "forbidden", "a phone cannot revoke another phone");
  await assert.rejects(w.machine.revokeDevice(w.machineId), (e) => e.code === "forbidden", "the machine is deleted with the vault, not revoked");
  await a.client.revokeDevice(a.id);                                           // the phone revokes itself
  const note = (f) => f.type === "device_revoked" && f.deviceId === a.id;
  await until(() => m.json().some(note) && pa.json().some(note));
  await until(() => pa.closed.code === 1008);
  await w.machine.revokeDevice(a.id);                                          // a repeat by the machine: 204, and the cleanup runs again (safe to retry after a 500)
  assert.equal(fake.stats.revokeRepeats, 1);
  await assert.rejects(w.machine.revokeDevice("dev_" + "Q".repeat(22)), (e) => e.code === "not_found", "an unknown device is 404");
  await assert.rejects(a.client.devices(), (e) => e.code === "device_unknown");
  assert.equal((await w.machine.devices()).length, 2, "revoked devices are not listed");
}));

test("DELETE /v1/vault/:vault: machine only; every socket gets device_revoked with its own id and is closed; afterwards the vault is gone", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine), p = await raw(fake, w, w.phone);
  await assert.rejects(w.phone.deleteVault(), (e) => e.code === "forbidden");
  assert.ok(fake.hasVault(w.vault));
  assert.deepEqual(await w.machine.deleteVault(), { ok: true });
  assert.equal(fake.hasVault(w.vault), false);
  await until(() => m.json().some((f) => f.type === "device_revoked" && f.deviceId === w.machineId) && p.json().some((f) => f.type === "device_revoked" && f.deviceId === w.phoneId));
  await until(() => m.closed.code === 1008 && p.closed.code === 1008);
  await assert.rejects(w.machine.devices(), (e) => e.code === "device_unknown");
}));

test("kill switch: non-GET requests are 503 read_only (challenge, ws-ticket exempt); reads work; WS envelopes, acks and pushes get a read_only error frame with the id; ping works", withFake(async (fake) => {
  const w = await world(fake);
  const m = await raw(fake, w, w.machine);
  fake.setReadOnly(true);
  await assert.rejects(w.machine.deleteVault(), (e) => e.code === "read_only" && e.status === 503);
  await assert.rejects(w.phone.request("PUT", `/v1/vault/${w.vault}/devices/${w.phoneId}/push`, { subId: "x", endpoint: "y" }), (e) => e.code === "read_only");
  assert.ok(await w.machine.wsTicket(), "ws-ticket is exempt");
  assert.deepEqual(await w.machine.devices().then((d) => d.length), 2, "GET works");
  assert.deepEqual((await w.machine.inboxPage(0)).messages, []);
  const e = env(w, { type: "hello" });
  m.send(e); m.send({ type: "ack", ids: [uuid()] }); m.send('{"type":"ping"}');
  await until(() => m.errors().length === 2 && m.frames.includes('{"type":"pong"}'));
  assert.deepEqual(m.errors().map((x) => x.error), ["read_only", "read_only"]);
  assert.equal(m.errors()[0].id, e.id); assert.equal("id" in m.errors()[1], false);
  assert.equal(fake.queue(w.vault, w.phoneId).length, 0, "nothing stored");
  fake.setReadOnly(false);
  m.send(e); await until(() => fake.queue(w.vault, w.phoneId).length === 1);
}));

test("pairing socket: accept before a claim is {t:'error',code:'bad_request'} (retry allowed); read-only gives {t:'error',code:'read_only'}", withFake(async (fake) => {
  const w = await world(fake, { phones: 0 });
  const { pairingId, wsTicket } = await w.machine.startPairing();
  const ch = await w.machine.openPairing(pairingId, wsTicket);
  const got = [];
  ch.onResult((m) => got.push(m));
  ch.accept("A".repeat(60), "write");
  await until(() => got.length === 1);
  assert.deepEqual(got[0], { t: "error", code: "bad_request" });
  fake.setReadOnly(true);
  ch.accept("A".repeat(60), "write");
  await until(() => got.length === 2);
  assert.deepEqual(got[1], { t: "error", code: "read_only" });
  ch.close();
}));

test("errors from the relay: unknown/escaped codes become 'unknown'; retryAfter is capped at an hour", withFake(async (fake) => {
  const w = await world(fake);
  const f = (u, init) => String(u).includes("/devices") ? Promise.resolve(new Response(JSON.stringify({ error: "\u001b[2JBAD CODE\nx", retryAfter: 9e9 }), { status: 429 })) : fetch(u, init);
  const c = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: w.machineId, signingKey: (await generateSigningKeyPair()).privateKey }, fetch: f, maxHttpRetries: 0 });
  await assert.rejects(c.devices(), (e) => e instanceof RelayError && e.code === "unknown" && !/[\u001b\n]/.test(e.message));
  const g = (u, init) => String(u).includes("/devices") ? Promise.resolve(new Response(JSON.stringify({ error: "rate_limited", retryAfter: 9e9 }), { status: 429 })) : fetch(u, init);
  const c2 = createRelayClient({ baseUrl: fake.url, vault: w.vault, deviceKeys: { deviceId: w.machineId, signingKey: w.machine && (await generateSigningKeyPair()).privateKey }, fetch: g, maxHttpRetries: 0 });
  await assert.rejects(c2.devices(), (e) => e.code === "rate_limited" && e.retryAfter === 3600);
}));

test("per-phone caps in a vault: 40 queued actions (rate_limited with the id) and the stored-bytes cap (too_large with the id)", withFake(async (fake) => {
  const w = await world(fake);
  const p = await raw(fake, w, w.phone);
  const act = (over = {}) => env(w, { type: "action", from: w.phoneId, to: "machine", ...over });
  for (let i = 0; i < 40; i++) p.send(act());
  await until(() => fake.queue(w.vault, w.machineId).length === 40);
  const over = act(); p.send(over);
  const e = await until(() => p.errors().find((x) => x.id === over.id));
  assert.equal(e.error, "rate_limited");
  const m = await raw(fake, w, w.machine);                                       // the machine acks one, the phone may send again
  m.send({ type: "ack", ids: [fake.queue(w.vault, w.machineId)[0].id] });
  await until(() => fake.queue(w.vault, w.machineId).length === 39);
  p.send(act()); await until(() => fake.queue(w.vault, w.machineId).length === 40);
}));

test("per-phone stored-bytes cap gives too_large with the id", withFake(async (fake) => {
  const w = await world(fake);
  const p = await raw(fake, w, w.phone);
  const req = (kb) => env(w, { type: "req", from: w.phoneId, to: "machine", ct: b64u(crypto.randomBytes(kb * 1024)) });
  p.send(req(300)); p.send(req(300));
  await until(() => fake.queue(w.vault, w.machineId).length === 2);
  const big = req(300); p.send(big);
  const e = await until(() => p.errors().find((x) => x.id === big.id));
  assert.equal(e.error, "too_large");
}, { phoneStoredCap: 1000 * 1024 }));

test("plan gate: off the allowlist every signed call is 402 plan_inactive, except the machine's DELETE /v1/vault/:vault", withFake(async (fake) => {
  const w = await world(fake);
  fake.setPlanActive(w.vault, false);
  await assert.rejects(w.machine.devices(), (e) => e.code === "plan_inactive" && e.status === 402);
  await assert.rejects(w.machine.wsTicket(), (e) => e.code === "plan_inactive");
  assert.deepEqual(await w.machine.deleteVault(), { ok: true });
  assert.equal(fake.hasVault(w.vault), false);
}));

test("pairing socket: a non-object frame (null, an array) gets {t:'error',code:'bad_request'} and the socket stays open; a frame from a phone being revoked gets device_unknown and the socket closes", withFake(async (fake) => {
  const w = await world(fake);
  const { pairingId, wsTicket } = await w.machine.startPairing();
  const ws = new WebSocket(`${fake.url.replace("http", "ws")}/v1/pair/${pairingId}/machine?ticket=${wsTicket}`);
  const got = []; let code = null;
  ws.onmessage = (e) => got.push(JSON.parse(e.data)); ws.onclose = (e) => { code = e.code; };
  await new Promise((ok) => { ws.onopen = ok; });
  ws.send("null"); ws.send("[1]");
  await until(() => got.length === 2);
  assert.deepEqual(got, [{ t: "error", code: "bad_request" }, { t: "error", code: "bad_request" }]);
  assert.equal(code, null, "still open");
  ws.close();
  // the phone is revoked while its socket is open: its next frame is device_unknown and the socket closes (1008)
  const p = await raw(fake, w, w.phone);
  fake.revokeDevice(w.vault, w.phoneId);
  await until(() => p.closed.code === 1008);
}));
