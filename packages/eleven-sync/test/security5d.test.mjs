// Regression tests for the findings of security re-check 05c (L-11 ... L-15 and the info notes). Synthetic ledgers only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claimLink } from "./phone-sim.mjs";
import { acquireLock } from "../src/lock.js";
import { main } from "../src/cli.js";
import { createRelayClient, clean } from "../src/relay-client.js";
import { vaultFile } from "../src/pair.js";
import { findEleven } from "../src/find.js";
import { until, sleep, qHash, Q1, Q2, withWorld, tty, sink } from "./world5.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("L-13: acquireLock throws when it cannot take the lock; it never returns without holding it", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lock13-")));
  try {
    const f = path.join(root, "p", "start.lock"); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify({ pid: 999999, started: 1 }));      // a daemon that died
    fs.writeFileSync(f + ".takeover", "");                               // a starter killed while it held the guard (young)
    assert.throws(() => acquireLock(f, { pid: 111111 }), /could not take the lock/);
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).pid, 999999, "and it did not pretend: the lock file is not ours");
    const old = new Date(Date.now() - 11_000); fs.utimesSync(f + ".takeover", old, old);
    const rel = acquireLock(f, { pid: process.pid });                    // once the guard is old, a normal takeover works
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).pid, process.pid);
    rel();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("L-14: clean() takes strings only; hostile hint frames with {toString:1} in every field never crash the daemon", withWorld(async (w) => {
  assert.equal(clean({ toString: 1 }), ""); assert.equal(clean(null), ""); assert.equal(clean(42), ""); assert.equal(clean("a\u001b[2Jb"), "a[2Jb");
  const phone = await w.pairPhone();
  const bad = { toString: 1 };
  let sock = null;
  class WS extends WebSocket { constructor(u) { super(u); if (String(u).includes("/ws?")) sock = this; } }
  const uncaught = []; const onU = (e) => uncaught.push(e.message); process.on("uncaughtException", onU);
  try {
    const d = await w.start({ WebSocket: WS });
    await phone.waitFor((m) => m.inner.t === "manifest");
    const hostile = [{ type: "device_revoked", deviceId: bad }, { type: "push_stale", subId: bad }, { type: "presence", machine: bad, lastSeen: bad }, { type: "plan_ended", x: bad },
      { type: "error", error: bad, id: bad, message: bad }, { type: "error", error: "rate_limited", retryAfter: bad }, { type: "pong", x: bad }, { type: "nonsense", x: bad }, { type: bad }];
    for (const f of hostile) sock.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(f) }));
    await sleep(300);
    assert.deepEqual(uncaught, [], "no uncaught exception");
    phone.req("sync_request", { haveSeq: 0, haveHash: d.tracker.hash });
    await phone.waitFor((m) => m.inner.t === "tick");                    // the daemon still works
    assert.ok(d.client.connected);
  } finally { process.off("uncaughtException", onU); }
}));

test("L-12: kill -9 between 'position saved' and 'ack sent': the next start reads the inbox again and the item is acked", { timeout: 60_000 }, withWorld(async (w) => {
  const phone = await w.pairPhone();
  const child = spawn(process.execPath, [path.join(HERE, "daemon-child.mjs"), w.project, w.stateDir, w.root, "5000"], { stdio: ["ignore", "pipe", "pipe"] });
  let up = ""; child.stdout.on("data", (d) => (up += d)); child.stderr.on("data", () => {});
  await until(() => up.includes("UP"), 10_000);
  await phone.waitFor((m) => m.inner.t === "manifest");
  const a = w.answer(phone, Q1, "PDF K");
  await w.result(phone, a.id);
  const rseq = w.queue("action")[0].rseq;
  const dj = () => { try { const p = path.join(w.stateDir, fs.readdirSync(w.stateDir).find((x) => x.startsWith("proj-")), "daemon.json"); return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  await until(() => (dj()?.rseq ?? 0) >= rseq, 5000);                    // the position is saved ...
  child.kill("SIGKILL"); await new Promise((r) => child.on("exit", r));  // ... the ack (5 s grace) never left
  assert.equal(w.queue("action").length, 1, "the relay still holds the item");
  await w.start();
  await until(() => w.queue("action").length === 0, 6000);               // read again, deduped (applied once), acked
  assert.equal((w.read("work/010-export/brief.md").match(/PDF K/g) ?? []).length, 1);
}));

test("L-11: a cancel that arrives live while a batch is being applied wins over the batch's next action", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  const a1 = w.answer(phone, Q1, "first"); await sleep(20);
  const a2 = w.answer(phone, Q2, "second");
  await until(() => w.queue("action").length === 2);
  d = w.start({ recheckMs: 500 });                                       // each action takes ~500 ms to finish
  await until(() => w.fake.connected(w.record().vault, w.record().deviceId));
  await sleep(150);
  const c = phone.action({ kind: "cancel", item: null, target: null, pre: {}, payload: { actionId: a2.id } });
  await d;
  assert.equal((await w.result(phone, a1.id)).status, "ok");
  assert.equal((await w.result(phone, a2.id)).status, "cancelled");
  assert.ok(["ok", "cancelled"].includes((await w.result(phone, c.id)).status));
  assert.ok(!w.read("work/010-export/brief.md").includes("second"), "the cancelled answer was never written");
  assert.ok(w.read("work/010-export/brief.md").includes("first"));
}));

test("L-11: a cancel that arrives live during the inbox read joins the batch and wins", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  const before = w.read("work/010-export/brief.md");
  const a = w.answer(phone, Q1, "to be cancelled");
  await until(() => w.queue("action").length === 1);
  w.fake.setInboxDelay(500);
  const starting = w.start();
  await until(() => w.fake.connected(w.record().vault, w.record().deviceId));
  const c = phone.action({ kind: "cancel", item: null, target: null, pre: {}, payload: { actionId: a.id } });
  await starting;
  assert.equal((await w.result(phone, a.id)).status, "cancelled");
  await w.result(phone, c.id);
  assert.equal(w.read("work/010-export/brief.md"), before);
}));

test("L-15: input that arrives within 300 ms of the [y/N] prompt is discarded; a later line counts", withWorld(async (w) => {
  const p = w.run({ quietMs: undefined });
  const claimed = await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(p.out.text()));
  p.stdin.write("y\n");                                                  // the instant the prompt is on screen
  assert.equal(await Promise.race([p.done, sleep(200).then(() => "waiting")]), "waiting", "an instant 'y' does not answer");
  await sleep(250);
  p.stdin.write("y\n");                                                  // a person who read the question
  assert.equal(await p.done, 0, p.err.text());
  assert.equal(w.record().devices.length, 1);
  assert.ok(claimed);
}));

test("L-15: the unpair --all confirmation has the same quiet window (a line piped in at once is discarded)", withWorld(async (w) => {
  await w.pairPhone();
  const vault = w.record().vault;
  const out = sink(), err = sink(), stdin = tty(); stdin.end("unpair\n");
  const code = await main(["unpair", "--all", w.project, "--state-dir", w.stateDir], { out, err, stdin, cwd: w.root, quietMs: undefined });
  assert.equal(code, 1); assert.ok(w.fake.hasVault(vault), "nothing was deleted");
  assert.ok(fs.existsSync(vaultFile(w.stateDir, findEleven(w.project))));
}));

test("info: the ack grace is per id, not one timer for the whole queue", withWorld(async (w) => {
  const phone = await w.pairPhone();
  await w.start({ ackDelayMs: 600 });
  await phone.waitFor((m) => m.inner.t === "manifest");
  phone.req("log_request", {});                                          // A: ignored request, acked ~600 ms after its answer
  await until(() => w.queue("req").length === 1);
  await sleep(350);
  phone.req("log_request", {});                                          // B: 350 ms later
  await until(() => w.queue("req").length === 2, 2000);
  await until(() => w.queue("req").length === 1, 2000);                  // A is acked first ...
  assert.equal(w.queue("req").length, 1, "... while B still waits for its own grace");
  await until(() => w.queue("req").length === 0, 2000);
}));

test("info: after/limit are clamped without wrapping at 2^31", withWorld(async (w) => {
  await w.pairPhone();
  const urls = [];
  const f = (u, init) => { urls.push(String(u)); return fetch(u, init); };
  const rec = w.record();
  const { importPrivateSigning } = { importPrivateSigning: async () => globalThis.crypto.subtle.importKey("pkcs8", Buffer.from(rec.msig.priv, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
  const c = createRelayClient({ baseUrl: rec.relay, vault: rec.vault, deviceKeys: { deviceId: rec.deviceId, signingKey: await importPrivateSigning() }, fetch: f });
  await c.inboxPage(2 ** 32 + 5, 2 ** 31);
  const u = urls.find((x) => x.includes("/inbox"));
  assert.match(u, /after=4294967301&limit=500/);
  await c.inboxPage(-7, 0);
  assert.match(urls.filter((x) => x.includes("/inbox")).at(-1), /after=0&limit=1/);
}));

test("flake fix: a result whose socket drops inside the ack grace is not durable: it is replayed after the reconnect, then acked", withWorld(async (w) => {
  const phone = await w.pairPhone();
  const d = await w.start({ ackDelayMs: 3000 });
  await phone.waitFor((m) => m.inner.t === "manifest");
  const a = w.answer(phone, Q1, "grace drop");
  await w.result(phone, a.id);
  w.fake.dropConnections();                                              // inside the 3 s grace: a refusal frame could have been lost with the socket
  await until(() => /\(replay\)/.test(d.err.text()), 6000);              // the action is handled again and its stored result is resent
  assert.equal((w.read("work/010-export/brief.md").match(/grace drop/g) ?? []).length, 1, "applied once");
  await until(() => w.queue("action").length === 0, 8000);               // and acked once the grace passed on the live socket
}));
