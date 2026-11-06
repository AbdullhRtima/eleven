// `eleven-sync start` end to end: the real daemon against the fake relay and a simulated phone (protocol 7, 8, 9, 10).
// The phone (phone-sim.mjs) uses node:crypto only, so the daemon and the phone agree on keys, envelopes, signatures and push
// encryption independently of each other.
//
// The message-socket frames and the inbox follow the agreed relay wire contract (see contract.test.mjs); the fake enforces it.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { startFakeRelay } from "./fake-relay.mjs";
import { claimLink, Phone, canon, webauthnSig, actionToSign } from "./phone-sim.mjs";
import { pair, vaultFile } from "../src/pair.js";
import { startDaemon, StartError, acquireLock, daemonPaths, checkActionSignature, MAX_SYNC_BYTES } from "../src/start.js";
import { encryptWebPush, parsePushKeys, buildPushJson } from "../src/webpush.js";
import { findEleven } from "../src/find.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/eleven-sync.js");
const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + fn); await new Promise((r) => setTimeout(r, 15)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (x) => b64u(crypto.createHash("sha256").update(x).digest());
const qHash = (q) => sha(q.normalize("NFC").trim().replace(/\s+/g, " "));

function tty() { const s = new PassThrough(); s.isTTY = true; return s; }
function sink() { let text = ""; const w = new Writable({ write(c, _e, cb) { text += c; cb(); } }); w.text = () => text; w.isTTY = true; return w; }

const BRIEF_010 = "# Brief: Export notes\n\nStatus: draft\n\n## Problem\nUsers want to export their notes.\n\n## Open questions\n- Which export format first? Markdown or PDF?\n\n## Future\n- Sync\n";
const QUESTION = "Which export format first? Markdown or PDF?";
const TASKS_009 = "# Tasks: 009 share-a-note\n\nRound: 2 / 10\n\n| # | Task | Role | Done condition | Status |\n|---|---|---|---|---|\n| 1 | Write the brief | product | approved | done |\n| 2 | Build the share link | backend | tests pass | NEXT |\n";

async function world() {
  const fake = await startFakeRelay({ longPollMs: 300 });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "start-")));
  const project = path.join(root, "proj"), stateDir = path.join(root, "state"), eleven = path.join(project, "eleven");
  const put = (rel, text) => { const f = path.join(eleven, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put("project.md", "# Project: Acme Notes\n");
  put("work/010-export/brief.md", BRIEF_010);
  put("work/009-share-a-note/brief.md", "# Brief: Share a note\n\nStatus: approved by user on 2026-11-01\n");
  put("work/009-share-a-note/tasks.md", TASKS_009);
  put("work/009-share-a-note/reports/01-product.md", "# Report: task 1, product\n\n## Result\ndone\n");
  put("decisions/0001-storage.md", "# Decision 0001: storage\n");
  fs.writeFileSync(path.join(eleven, "work/009-share-a-note/page.html"), "<h1>Report page</h1>");
  const token = fake.addAccount("acc_alice", "alice@example.com");
  const w = { fake, root, project, stateDir, eleven, put, token, phones: [], daemons: [], errs: [] };
  w.read = (rel) => fs.readFileSync(path.join(eleven, rel), "utf8");
  w.pairPhone = async ({ readOnly = false, deviceName = "Pixel 8", actAlg } = {}) => {
    const stdin = tty(), out = sink(), err = sink();
    const done = pair({ dir: project, stateDir, relay: fake.url, stdin, out, err, readOnly, WebSocket: globalThis.WebSocket, quietMs: 0 });
    await until(() => /Press Enter/.test(out.text()));
    stdin.write("\n");
    const link = (await until(() => /https:\/\/m\.eleven\.rtima\.org\/pair#\S+/.exec(out.text())))[0];
    const claimed = await claimLink({ relayUrl: fake.url, link, token, deviceName, ...(actAlg ? { actAlg } : {}) });
    await until(() => /\[y\/N\]/.test(out.text()));
    stdin.write("y\n");
    assert.equal(await done, 0, err.text() + out.text());
    const fin = await claimed.finish();
    assert.equal(fin.ok, true);
    const phone = new Phone({ relayUrl: fake.url, claimed, fin });
    await phone.connect();
    w.phones.push(phone);
    return phone;
  };
  w.record = () => JSON.parse(fs.readFileSync(vaultFile(stateDir, findEleven(project)), "utf8"));
  w.start = async (over = {}) => {
    const err = sink();
    const d = await startDaemon({ dir: project, stateDir, cwd: root, err, debounceMs: 30, poll: true, pollMs: 40, pushDebounceMs: 60, recheckMs: 0, backoff: { baseMs: 20, maxMs: 100 }, pingMs: 0, ...over });
    d.err = err; w.daemons.push(d); w.errs.push(err);
    return d;
  };
  w.close = async () => {
    for (const p of w.phones) p.close();
    for (const d of w.daemons) await d.stop();
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return w;
}
const withWorld = (fn) => async () => { const w = await world(); try { await fn(w); } finally { await w.close(); } };
const fidOf = (phone, p) => phone.of("manifest").at(-1).inner.files.find((f) => f.path === p)?.fid;
const result = (phone, id) => phone.waitFor((m) => m.inner.t === "action_result" && m.inner.actionId === id).then((m) => m.inner);
const queueOf = (w, type) => w.fake.queue(w.record().vault, w.record().deviceId).filter((m) => m.type === type);

// ---------------------------------------------------------------------------------------------------------------------------
test("end to end: pair, start, manifest, the phone answers a question, the brief is written, 'ok' comes back, the action is acked", withWorld(async (w) => {
  const phone = await w.pairPhone();
  const d = await w.start();
  const hello = (await phone.waitFor((m) => m.inner.t === "hello")).inner;
  assert.equal(hello.proto, 1); assert.equal(hello.accountId, "acc_alice");
  const man = (await phone.waitFor((m) => m.inner.t === "manifest")).inner;
  assert.equal(man.prevHash, null);
  const paths = man.files.map((f) => f.path);
  assert.ok(paths.includes("work/010-export/brief.md") && paths.includes("project.md") && paths.includes("work/009-share-a-note/page.html"));
  // the chain hash recomputed with the phone's own JCS
  const { hash, t: _t, seq: _s, ts: _ts, ...body } = man;
  assert.equal(hash, sha(canon(body)));
  // .md files arrive as `file` messages that match the manifest hashes; .html is never pushed
  const brief = man.files.find((f) => f.path === "work/010-export/brief.md");
  const fm = (await phone.waitFor((m) => m.inner.t === "file" && m.inner.fid === brief.fid)).inner;
  assert.equal(fm.sha256, brief.sha256); assert.equal(fm.text, BRIEF_010);
  assert.equal(phone.of("file").some((m) => m.inner.fid === man.files.find((f) => f.kind === "html").fid), false);

  const { id } = phone.action({ kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(QUESTION) }, payload: { answer: "Markdown first." } });
  const r = await result(phone, id);
  assert.equal(r.status, "ok");
  const text = w.read("work/010-export/brief.md");
  assert.match(text, /~~Which export format first\? Markdown or PDF\?~~ \*\*Answer \(phone "Pixel 8", \d{4}-\d{2}-\d{2}\):\*\* Markdown first\./);
  // then the delta carries the new hash, and the new file text
  const delta = (await phone.waitFor((m) => m.inner.t === "delta" && m.inner.upsert.some((u) => u.fid === brief.fid))).inner;
  assert.equal(delta.prevHash, man.hash);
  assert.equal(delta.hash, sha(man.hash + canon({ prevHash: delta.prevHash, upsert: delta.upsert, remove: delta.remove })));
  const nf = (await phone.waitFor((m) => m.inner.t === "file" && m.inner.fid === brief.fid && m.inner.text === text)).inner;
  assert.equal(nf.sha256, sha(text));
  // acked: the relay no longer holds the action
  await until(() => queueOf(w, "action").length === 0);
  // nothing secret or private reached stderr
  const log = d.err.text();
  assert.match(log, /connected as the machine/);
  for (const secret of [phone.m2p.toString("base64url"), phone.p2m.toString("base64url"), "Markdown first", w.record().msig.priv, w.record().devices[0].keys.send]) assert.ok(!log.includes(secret));
  assert.ok(!w.fake.storedBytes().includes("Markdown first") && !w.fake.storedBytes().includes("Export notes"), "the relay never saw plaintext");
}));

test("a local edit becomes a delta (chained) with the new file; a removed file becomes remove + gone", withWorld(async (w) => {
  const phone = await w.pairPhone();
  await w.start();
  const man = (await phone.waitFor((m) => m.inner.t === "manifest")).inner;
  w.put("work/011-new/brief.md", "# Brief: New thing\n\nStatus: draft\n");
  const dm = await phone.waitFor((m) => m.inner.t === "delta" && m.inner.upsert.some((u) => u.path === "work/011-new/brief.md"));
  assert.equal(dm.inner.prevHash, man.hash);
  const fid = dm.inner.upsert.find((u) => u.path === "work/011-new/brief.md").fid;
  assert.equal((await phone.waitFor((m) => m.inner.t === "file" && m.inner.fid === fid)).inner.text, "# Brief: New thing\n\nStatus: draft\n");
  fs.unlinkSync(path.join(w.eleven, "work/011-new/brief.md"));
  const rm = await phone.waitFor((m) => m.inner.t === "delta" && m.inner.remove.includes(fid));
  assert.equal(rm.inner.prevHash, dm.inner.hash);
  await until(() => phone.raw.length > 0 && w.fake.storedBytes().includes('"type":"gone"'));
}));

test("sync_request: a phone that is current gets a tick, a stale one a fresh manifest; file_request serves md, html (ephemeral) and refuses big files and unknown fids", withWorld(async (w) => {
  w.put("work/012-big/notes.md", "x".repeat(MAX_SYNC_BYTES + 10));
  w.put("work/012-big/small.md", "small\n");
  const phone = await w.pairPhone();
  await w.start();
  const man = (await phone.waitFor((m) => m.inner.t === "manifest")).inner;
  phone.req("sync_request", { haveSeq: 0, haveHash: man.hash });
  await phone.waitFor((m) => m.inner.t === "tick");
  phone.req("sync_request", { haveSeq: 0, haveHash: "stale" });
  await until(() => phone.of("manifest").length === 2);
  const big = man.files.find((f) => f.path === "work/012-big/notes.md"), small = man.files.find((f) => f.path === "work/012-big/small.md");
  assert.ok(big, "a big file is listed in the manifest");
  assert.equal(phone.of("file").some((m) => m.inner.fid === big.fid), false, "but never sent on its own");
  phone.req("file_request", { fid: big.fid });
  phone.req("file_request", { fid: "A".repeat(22) });
  phone.req("file_request", { fid: small.fid });
  await phone.waitFor((m) => m.inner.t === "file" && m.inner.fid === small.fid && m.inner.text === "small\n");
  const html = man.files.find((f) => f.kind === "html");
  phone.req("file_request", { fid: html.fid });
  const hm = await phone.waitFor((m) => m.type === "result" && m.inner.t === "file" && m.inner.fid === html.fid);
  assert.equal(hm.inner.ephemeral, true); assert.equal(hm.inner.text, "<h1>Report page</h1>");
  assert.equal(phone.of("file").filter((m) => m.inner.fid === big.fid).length, 0);
}));

test("a read-only phone cannot write: rejected read_only, the file is untouched", withWorld(async (w) => {
  const ro = await w.pairPhone({ readOnly: true, deviceName: "Reader" });
  await w.start();
  await ro.waitFor((m) => m.inner.t === "manifest");
  const before = w.read("work/010-export/brief.md");
  const { id } = ro.action({ kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(QUESTION) }, payload: { answer: "Sneaky" } });
  const r = await result(ro, id);
  assert.deepEqual([r.status, r.reason], ["rejected", "read_only"]);
  assert.equal(w.read("work/010-export/brief.md"), before);
  await until(() => queueOf(w, "action").length === 0);
}));

test("signatures: a bad, missing, wrong-algorithm or passkey signature is rejected and nothing is written; an unsigned action from a replaced key too", withWorld(async (w) => {
  const phone = await w.pairPhone();
  const pk = await w.pairPhone({ deviceName: "Passkey phone", actAlg: "webauthn-es256" });
  await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest"); await pk.waitFor((m) => m.inner.t === "manifest");
  const before = w.read("work/010-export/brief.md");
  const act = { kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(QUESTION) }, payload: { answer: "Nope" } };
  const cases = [[phone, "bad", "bad_signature"], [phone, "none", "bad_signature"], [phone, "webauthn", "bad_signature"], [phone, { alg: "device-es256", signature: "AAAA" }, "bad_signature"],
    [phone, "passkey", "bad_signature"], [pk, "device", "weak_signature"], [pk, "webauthn", "bad_signature"]];   // a device-es256 phone cannot "upgrade" by sending a passkey assertion (8.2: re-pair)
  for (const [p, sig, reason] of cases) {
    const { id } = p.action(act, { sig });
    const r = await result(p, id);
    assert.deepEqual([r.status, r.reason], ["rejected", reason], JSON.stringify(sig));
  }
  assert.equal(w.read("work/010-export/brief.md"), before);
  // a tampered action (signed, then changed) fails too
  const a = { t: "action", seq: 1, ts: Date.now(), actionId: crypto.randomUUID(), createdAt: Date.now(), ...act };
  assert.equal(checkActionSignature({ ...a, sig: { alg: "device-es256", signature: b64u(Buffer.alloc(64)) } }, { deviceId: "dev_x", phoneActKey: null }, "vlt_x"), "bad_signature");
  // and a good one still works
  const ok = phone.action(act);
  assert.equal((await result(phone, ok.id)).status, "ok");
}));

test("passkey (webauthn-es256): a real assertion is applied and its counter logged; edited, wrong-origin, wrong-vault and P1363 ones are rejected and write nothing", withWorld(async (w) => {
  const pk = await w.pairPhone({ deviceName: "Passkey phone", actAlg: "webauthn-es256" });
  const d = await w.start();
  await pk.waitFor((m) => m.inner.t === "manifest");
  const before = w.read("work/010-export/brief.md");
  const act = { kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(QUESTION) }, payload: { answer: "Passkey answer." } };
  const wa = (o) => (toSign) => webauthnSig(pk.act.privateKey, toSign, o);
  const bad = [wa({ origin: "https://evil.example" }), wa({ crossOrigin: true }), wa({ p1363: true }), wa({ flags: 0x01 }), wa({ rpId: "evil.example" }),
    (toSign, a) => { const s = webauthnSig(pk.act.privateKey, toSign); a.payload = { answer: "Edited after signing." }; return s; },
    (_t, a) => webauthnSig(pk.act.privateKey, actionToSign("vlt_CCCCCCCCCCCCCCCCCCCCCC", pk.deviceId, a))];
  for (const sig of bad) {
    const { id } = pk.action(act, { sig });
    const r = await result(pk, id);
    assert.deepEqual([r.status, r.reason], ["rejected", "bad_signature"], String(sig));
  }
  assert.equal(w.read("work/010-export/brief.md"), before);
  const { id } = pk.action(act, { sig: (toSign) => webauthnSig(pk.act.privateKey, toSign, { counter: 7 }) });
  assert.equal((await result(pk, id)).status, "ok");
  assert.match(w.read("work/010-export/brief.md"), /\*\*Answer \(phone "Passkey phone", \d{4}-\d{2}-\d{2}\):\*\* Passkey answer\./);
  assert.match(d.err.text(), /action from "Passkey phone": passkey counter 7/);
  await until(() => queueOf(w, "action").length === 0);
}));

test("an action replayed after a restart is not applied twice; seq keeps rising; the position is persisted 0600", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  const { id } = phone.action({ kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(QUESTION) }, payload: { answer: "Once." } });
  assert.equal((await result(phone, id)).status, "ok");
  await until(() => queueOf(w, "action").length === 0);
  const afterFirst = w.read("work/010-export/brief.md");
  const seq1 = Math.max(...phone.inbox.map((m) => m.inner.seq));
  await d.stop();
  assert.ok(!fs.existsSync(d.paths.lock), "the lock is gone after a clean stop");
  const st = JSON.parse(fs.readFileSync(d.paths.daemon, "utf8"));
  assert.ok(st.rseq > 0 && st.lastSeq >= seq1, JSON.stringify(st));
  assert.equal(fs.statSync(d.paths.daemon).mode & 0o777, 0o600);
  d = await w.start();                                                          // a new process would start the same way
  await until(() => phone.of("manifest").length === 2);
  // the phone (or the relay) delivers the very same action again, in a new envelope
  phone.action({ kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(QUESTION) }, payload: { answer: "Once." } }, { id });
  await until(() => phone.of("action_result").filter((m) => m.inner.actionId === id).length >= 2);
  const r2 = phone.of("action_result").filter((m) => m.inner.actionId === id)[1].inner;
  assert.equal(r2.status, "ok");
  assert.equal(w.read("work/010-export/brief.md"), afterFirst, "applied once");
  assert.equal((afterFirst.match(/Answer \(phone/g) ?? []).length, 1);
  assert.ok(Math.min(...phone.of("manifest").slice(1).map((m) => m.inner.seq)) > seq1, "seq is still strictly increasing after the restart");
  assert.match(d.err.text(), /\(replay\)/);
}));

test("the lock: a live daemon refuses a second start; a stale lock (dead pid) is taken over; the lock is 0600 and removed on stop", withWorld(async (w) => {
  await w.pairPhone();
  const d = await w.start();
  const mode = fs.statSync(d.paths.lock).mode & 0o777;
  assert.equal(mode, 0o600);
  await assert.rejects(() => w.start(), (e) => e instanceof StartError && /already running.*pid \d+/.test(e.message));
  assert.ok(fs.existsSync(d.paths.lock), "the refused start left the live lock alone");
  await d.stop();
  assert.ok(!fs.existsSync(d.paths.lock));
  // a dead pid
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.writeFileSync(d.paths.lock, JSON.stringify({ pid: Number(dead), started: 1 }));
  const d2 = await w.start();
  assert.equal(JSON.parse(fs.readFileSync(d2.paths.lock, "utf8")).pid, process.pid);
  // acquireLock directly: garbage in a YOUNG file is a starter still writing (never stale, L-1); an OLD one is stale; release only removes our own lock
  const f = path.join(w.root, "x.lock");
  fs.writeFileSync(f, "not json");
  assert.throws(() => acquireLock(f), /starting/);
  const old = new Date(Date.now() - 60_000); fs.utimesSync(f, old, old);
  const rel = acquireLock(f);
  assert.throws(() => acquireLock(f), /already running/);
  fs.writeFileSync(f, JSON.stringify({ pid: 1, started: 1 }));
  rel();
  assert.ok(fs.existsSync(f), "someone else's lock is not removed");
}));

test("start refuses with a clear message when there is nothing to sync with", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "start-none-")));
  try {
    fs.mkdirSync(path.join(root, "eleven/work"), { recursive: true });
    const err = sink();
    await assert.rejects(() => startDaemon({ dir: root, stateDir: path.join(root, "s"), cwd: root, err }), (e) => e instanceof StartError && /eleven-sync pair/.test(e.message));
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "start-bare-")));
    await assert.rejects(() => startDaemon({ dir: bare, stateDir: path.join(root, "s"), cwd: root, err }), (e) => e instanceof StartError && /no eleven\/ folder/.test(e.message));
    fs.rmSync(bare, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("push: an item that becomes waiting, and a failed report, reach the phone as an RFC 8291 payload the phone can decrypt; privacy 'generic' hides the title", withWorld(async (w) => {
  const titles = await w.pairPhone({ deviceName: "Titles phone" });
  const generic = await w.pairPhone({ deviceName: "Private phone" });
  const quiet = await w.pairPhone({ deviceName: "No push phone" });
  await w.start();
  for (const p of [titles, generic, quiet]) await p.waitFor((m) => m.inner.t === "manifest");
  await titles.pushKeys("titles"); await generic.pushKeys("generic");
  await sleep(200);
  assert.equal(w.fake.pushes.length, 0, "an item that was already waiting at start does not push");
  w.put("work/011-shiny/brief.md", "# Brief: Shiny idea\n\nStatus: draft\n\n## Open questions\n- Which color?\n- Which size?\n");
  await until(() => w.fake.pushes.length >= 2).catch((e) => { console.log(w.errs[0].text()); throw e; });
  await sleep(250);
  assert.equal(w.fake.pushes.length, 2, "one push per phone that registered keys, none for the phone that did not");
  const byTo = Object.fromEntries(w.fake.pushes.map((p) => [p.to, p]));
  assert.ok(!byTo[quiet.deviceId]);
  const t = titles.decryptPush(byTo[titles.deviceId].body);
  assert.equal(t.web_push, 8030);
  assert.equal(t.notification.title, "011 Shiny idea");
  assert.equal(t.notification.body, "2 open questions");
  assert.equal(t.notification.navigate, "https://m.eleven.rtima.org/#/i/011-shiny");
  assert.equal(t.notification.data.reason, "waiting"); assert.equal(t.notification.data.item, "011-shiny"); assert.equal(t.notification.data.vault, w.record().vault);
  assert.equal(typeof t.app_badge, "string");
  const g = generic.decryptPush(byTo[generic.deviceId].body);
  assert.deepEqual([g.notification.title, g.notification.body, g.notification.navigate], ["eleven", "Something needs you", "https://m.eleven.rtima.org/"]);
  assert.ok(!JSON.stringify(g).includes("Shiny") && !JSON.stringify(g).includes("011"));
  assert.equal(byTo[titles.deviceId].subId, titles.push.subId);
  assert.match(byTo[titles.deviceId].topic, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(byTo[titles.deviceId].topic, byTo[generic.deviceId].topic, "one topic per (vault, item)");
  assert.throws(() => generic.decryptPush(byTo[titles.deviceId].body), "a payload is encrypted to one phone only");
  assert.ok(!w.fake.storedBytes().includes("Shiny"), "the relay saw no title");
  // the same state again does not push again; an unrelated edit does not either
  w.put("work/011-shiny/notes.md", "# notes\n");
  await sleep(300);
  assert.equal(w.fake.pushes.length, 2);
  // a failed report pushes (reason failed)
  w.put("work/009-share-a-note/reports/02-backend.md", "# Report: task 2, backend\n\n## Result\nfailed: tests red\n");
  await until(() => w.fake.pushes.length >= 4);
  const f = titles.decryptPush(w.fake.pushes.filter((p) => p.to === titles.deviceId).at(-1).body);
  assert.equal(f.notification.data.reason, "failed"); assert.equal(f.notification.body, "A task failed");
  assert.ok(Buffer.from(w.fake.pushes[0].body, "base64url").length <= 4096);
  // the choice survives a restart
  await w.daemons[0].stop();
  assert.equal(JSON.parse(fs.readFileSync(w.daemons[0].paths.daemon, "utf8")).push[generic.deviceId].lockScreen, "generic");
}));

test("an answer applied from the phone can open a push; the lock-screen text never carries ledger control characters", () => {
  const j = JSON.parse(buildPushJson({ vault: "vlt_x", item: "009-share-a-note", title: "009 Share‮ a\nnote\u0000", body: "1\topen question", reason: "waiting", seq: 5, badge: 2, generic: false }));
  assert.equal(j.notification.title, "009 Share a note"); assert.equal(j.notification.body, "1 open question"); assert.equal(j.app_badge, "2");
  const bad = JSON.parse(buildPushJson({ vault: "vlt_x", item: "../../etc", title: "evil", body: "x", reason: "waiting", seq: 1, generic: false }));
  assert.equal(bad.notification.navigate, "https://m.eleven.rtima.org/"); assert.equal(bad.notification.title, "eleven");
  assert.throws(() => buildPushJson({ vault: "v", item: "009-x", title: "t", body: "b", reason: "waiting", seq: 1, generic: false, badge: "x".repeat(4000) }), /3000/);
});

test("RFC 8291 appendix A test vector, and malformed push keys are refused", () => {
  const u = (s) => Buffer.from(s, "base64url");
  const body = encryptWebPush({ p256dh: u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), auth: u("BTBZMqHH6r4Tts7J_aSIgg") },
    "When I grow up, I want to be a watermelon", { asPrivate: u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: u("DGv6ra1nlYgDCS1FRnbzlw") });
  assert.equal(b64u(body), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  assert.equal(parsePushKeys("AAAA", "AAAA"), null);
  assert.equal(parsePushKeys(b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])), b64u(Buffer.alloc(16))), null, "a point that is not on the curve");
  assert.equal(parsePushKeys(42, 42), null);
});

test("clean shutdown from a real process: SIGTERM and SIGINT close the socket, flush state and remove the lock (exit 0)", withWorld(async (w) => {
  const phone = await w.pairPhone();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    const child = spawn(process.execPath, [BIN, "start", w.project, "--state-dir", w.stateDir], { stdio: ["ignore", "pipe", "pipe"] });
    let errText = ""; child.stderr.on("data", (c) => { errText += c; });
    const exited = new Promise((r) => child.on("exit", (code, s) => r({ code, s })));
    const n = phone.of("manifest").length;
    await until(() => phone.of("manifest").length > n, 15000);
    const paths = daemonPaths(w.stateDir, w.eleven);
    assert.ok(fs.existsSync(paths.lock));
    assert.ok(w.fake.connected(w.record().vault, w.record().deviceId));
    child.kill(sig);
    const r = await exited;
    assert.deepEqual([r.code, r.s], [0, null], errText);
    assert.ok(!fs.existsSync(paths.lock), "lock removed");
    assert.ok(fs.existsSync(paths.daemon) && (fs.statSync(paths.daemon).mode & 0o777) === 0o600, "state flushed");
    await until(() => !w.fake.connected(w.record().vault, w.record().deviceId));
    assert.match(errText, /stopped/);
  }
}));

test("the relay drops every socket: the daemon reconnects by itself and keeps syncing", withWorld(async (w) => {
  const phone = await w.pairPhone();
  const d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  w.fake.dropConnections();
  await until(() => /reconnected/.test(d.err.text()));
  await phone.connect();
  w.put("work/013-after/brief.md", "# Brief: After the drop\n\nStatus: draft\n");
  await phone.waitFor((m) => m.inner.t === "delta" && m.inner.upsert.some((u) => u.path === "work/013-after/brief.md"));
}));
