// Regression tests for the findings of security review 05 (M-A, M-B, L-1 ... L-9) and for the kill switch, device_revoked and
// `unpair --all` (task 5b). Each test fails on the code as it was before task 5b. Synthetic ledgers only.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { startFakeRelay } from "./fake-relay.mjs";
import { claimLink, Phone } from "./phone-sim.mjs";
import { pair, vaultFile } from "../src/pair.js";
import { startDaemon, acquireLock } from "../src/start.js";
import { main } from "../src/cli.js";
import { verifyChain } from "../src/manifest.js";
import { findEleven } from "../src/find.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + fn); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (x) => b64u(crypto.createHash("sha256").update(x).digest());
const qHash = (q) => sha(q.normalize("NFC").trim().replace(/\s+/g, " "));
const tty = (isTTY = true) => { const s = new PassThrough(); s.isTTY = isTTY; return s; };
const sink = (isTTY = true) => { let text = ""; const w = new Writable({ write(c, _e, cb) { text += c; cb(); } }); w.text = () => text; w.isTTY = isTTY; return w; };
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
const LINK = /https:\/\/m\.eleven\.rtima\.org\/pair#\S+/;

const Q1 = "Which export format first? Markdown or PDF?", Q2 = "Second question here?";
const BRIEF = `# Brief: Export notes\n\nStatus: draft\n\n## Problem\nUsers want to export.\n\n## Open questions\n- ${Q1}\n- ${Q2}\n`;

async function world(fakeOpts = {}) {
  const fake = await startFakeRelay({ longPollMs: 300, ...fakeOpts });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sec5b-")));
  const project = path.join(root, "proj"), stateDir = path.join(root, "state"), eleven = path.join(project, "eleven");
  const put = (rel, text) => { const f = path.join(eleven, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put("project.md", "# Project: Acme\n");
  put("work/010-export/brief.md", BRIEF);
  const token = fake.addAccount("acc_alice", "alice@example.com");
  const w = { fake, root, project, stateDir, eleven, put, token, phones: [], daemons: [] };
  w.read = (rel) => fs.readFileSync(path.join(eleven, rel), "utf8");
  w.record = () => JSON.parse(fs.readFileSync(vaultFile(stateDir, findEleven(project)), "utf8"));
  // pair() with a TTY stdin/stdout. link() presses Enter once the "Press Enter" line is on screen (type-ahead is discarded, M-A).
  w.run = (over = {}) => {
    const stdin = tty(), out = sink(), err = sink(), ac = new AbortController();
    const done = pair({ dir: project, stateDir, relay: fake.url, stdin, out, err, signal: ac.signal, WebSocket: globalThis.WebSocket, quietMs: 0, ...over });
    const link = async () => { await until(() => /Press Enter/.test(out.text())); stdin.write("\n"); return (await until(() => LINK.exec(out.text())))[0]; };
    return { stdin, out, err, ac, done, link };
  };
  w.pairPhone = async ({ deviceName = "Pixel 8", readOnly = false } = {}) => {
    const p = w.run({ readOnly });
    const claimed = await claimLink({ relayUrl: fake.url, link: await p.link(), token, deviceName });
    await until(() => /\[y\/N\]/.test(p.out.text()));
    p.stdin.write("y\n");
    assert.equal(await p.done, 0, p.err.text() + p.out.text());
    const fin = await claimed.finish();
    assert.equal(fin.ok, true);
    const phone = new Phone({ relayUrl: fake.url, claimed, fin });
    await phone.connect();
    w.phones.push(phone);
    return phone;
  };
  w.start = async (over = {}) => {
    const err = sink();
    const d = await startDaemon({ dir: project, stateDir, cwd: root, err, debounceMs: 30, poll: true, pollMs: 40, pushDebounceMs: 60, recheckMs: 0, backoff: { baseMs: 20, maxMs: 100 }, pingMs: 0, ...over });
    d.err = err; w.daemons.push(d);
    return d;
  };
  w.queue = (type) => fake.queue(w.record().vault, w.record().deviceId).filter((m) => !type || m.type === type);
  w.answer = (phone, q, text) => phone.action({ kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(q) }, payload: { answer: text } });
  w.result = (phone, id) => phone.waitFor((m) => m.inner.t === "action_result" && m.inner.actionId === id).then((m) => m.inner);
  w.close = async () => { for (const p of w.phones) p.close(); for (const d of w.daemons) { try { await d.stop(); } catch { /* stopped */ } } await fake.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return w;
}
const withWorld = (fn, opts) => async () => { const w = await world(opts); try { await fn(w); } finally { await w.close(); } };

// =============================================================================================================================
// M-A: type-ahead must never answer a question
// =============================================================================================================================
test("M-A: a 'y' typed (or pasted) before the [y/N] prompt exists is discarded; only a line typed after the prompt counts", withWorld(async (w) => {
  const p = w.run();
  const link = await p.link();
  p.stdin.write("y\n"); p.stdin.write("yes\n");                         // typed while the QR is on screen
  const evil = w.fake.addAccount("acc_mallory", "mallory@example.com");
  w.fake.setClaimFrame((f) => ({ ...f, relayEmailMasked: "m•••@example.com" }));
  await claimLink({ relayUrl: w.fake.url, link, token: evil, accountId: "acc_mallory", deviceName: "iPhone", emailMasked: "m•••@example.com" });
  p.stdin.write("y\n");                                                  // and one more in the gap between the claim and the question
  await until(() => /\[y\/N\]/.test(p.out.text()));
  assert.equal(await Promise.race([p.done, sleep(500).then(() => "still waiting")]), "still waiting", "the stale 'y' did not answer the question");
  assert.equal(w.record().devices.length, 0);
  p.stdin.write("n\n");
  assert.equal(await p.done, 1);
  assert.equal(w.record().devices.length, 0);
  assert.match(p.out.text(), /Nothing was paired/);
}));

test("M-A: half a line typed before the prompt is dropped too ('ye' + 's' is not 'yes')", withWorld(async (w) => {
  const p = w.run();
  const link = await p.link();
  p.stdin.write("ye");                                                   // no newline: sits in the line buffer
  await claimLink({ relayUrl: w.fake.url, link, token: w.token });
  await until(() => /\[y\/N\]/.test(p.out.text()));
  p.stdin.write("s\n");                                                  // typed after the prompt: only "s"
  assert.equal(await p.done, 1);
  assert.equal(w.record().devices.length, 0);
}));

test("M-A: an Enter pressed before 'Press Enter to show it' is on screen does not show the code", withWorld(async (w) => {
  const p = w.run();
  p.stdin.write("\n");                                                   // type-ahead, before anything was printed
  await until(() => /Press Enter/.test(p.out.text()));
  await sleep(250);
  assert.doesNotMatch(p.out.text(), LINK, "the code stays hidden until a NEW Enter");
  p.stdin.write("\n");
  await until(() => LINK.test(p.out.text()));
  p.ac.abort(); await p.done;
}));

// =============================================================================================================================
// L-2, L-3, L-4, L-5 at the pairing prompt
// =============================================================================================================================
test("L-2: the prompt shows the relay's masked email; a sealed email that differs is refused with no prompt", withWorld(async (w) => {
  const p = w.run();
  await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token, emailMasked: "m•••@evil.test" });
  await until(() => /Nothing was paired/.test(p.out.text()));
  assert.equal(await p.done, 1);
  assert.doesNotMatch(p.out.text(), /\[y\/N\]/);
  assert.match(p.out.text(), /email/i);
  assert.equal(w.record().devices.length, 0);
  // when they agree, the account line is the relay's value
  const ok = w.run();
  await claimLink({ relayUrl: w.fake.url, link: await ok.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(ok.out.text()));
  assert.match(ok.out.text(), /Account: a•••@example\.com\n/);
  assert.doesNotMatch(ok.out.text(), /the relay says/);
  ok.stdin.write("n\n"); await ok.done;
}));

test("L-3: a device id that is the machine's own, or one already paired, or a claim frame without phoneAuthPub, is refused before the prompt", withWorld(async (w) => {
  await w.pairPhone({ deviceName: "First" });
  const rec = w.record();
  const cases = [
    ["machine's own id", (f) => ({ ...f, deviceId: rec.deviceId })],
    ["a paired phone's id", (f) => ({ ...f, deviceId: rec.devices[0].deviceId })],
    ["no phoneAuthPub", (f) => { const { phoneAuthPub, ...r } = f; return r; }],
  ];
  for (const [name, fn] of cases) {
    w.fake.setClaimFrame(fn);
    const p = w.run();
    await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token, deviceName: "Second" });
    await until(() => /Nothing was paired/.test(p.out.text()));
    assert.equal(await p.done, 1, name);
    assert.doesNotMatch(p.out.text(), /\[y\/N\]/, name);
    assert.deepEqual(w.record().devices.map((d) => d.name), ["First"], `${name}: the existing phone is untouched`);
  }
}));

test("L-4: stdin AND stdout must be terminals; with stdout piped nothing is created and no secret is written", withWorld(async (w) => {
  const out = sink(false), err = sink();
  const stdin = tty(); stdin.write("\n");
  assert.equal(await pair({ dir: w.project, stateDir: w.stateDir, relay: w.fake.url, stdin, out, err, WebSocket: globalThis.WebSocket }), 1);
  assert.match(err.text(), /stdout is not a TTY/);
  assert.equal(out.text(), "");
  assert.equal(fs.existsSync(w.stateDir), false);
  assert.equal(w.fake.storedBytes(), "");
}));

test("L-5: the link is shown, then the screen and scrollback are cleared after accept, after refuse and after timeout (and abort)", async () => {
  const clearedAfterLink = (text) => { const i = text.indexOf("pair#"), c = text.lastIndexOf(CLEAR); assert.ok(i >= 0 && c > i, "link shown, then cleared"); assert.doesNotMatch(text.slice(c), /pair#/); return text.slice(c + CLEAR.length); };
  // accepted
  await withWorld(async (w) => {
    const p = w.run();
    await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
    await until(() => /\[y\/N\]/.test(p.out.text())); p.stdin.write("y\n");
    assert.equal(await p.done, 0);
    assert.match(clearedAfterLink(p.out.text()), /^Paired "Pixel 8"/);
  })();
  // refused by the user
  await withWorld(async (w) => {
    const p = w.run();
    await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
    await until(() => /\[y\/N\]/.test(p.out.text())); p.stdin.write("n\n");
    assert.equal(await p.done, 1);
    assert.match(clearedAfterLink(p.out.text()), /Nothing was paired/);
  })();
  // refused by a check (account mismatch)
  await withWorld(async (w) => {
    const p = w.run();
    await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token, accountId: "acc_other" });
    assert.equal(await p.done, 1);
    clearedAfterLink(p.out.text());
  })();
  // nobody came: the code expired
  await withWorld(async (w) => {
    const p = w.run();
    await p.link();
    assert.equal(await p.done, 1);
    assert.match(clearedAfterLink(p.out.text()), /expired/);
  }, { pairTtlMs: 400 })();
  // Ctrl-C while the code is on screen
  await withWorld(async (w) => {
    const p = w.run();
    await p.link(); p.ac.abort();
    assert.equal(await p.done, 130);
    clearedAfterLink(p.out.text());
  })();
});

test("5b: the sealed accept carries the mode (write, or read for --read-only)", withWorld(async (w) => {
  for (const readOnly of [false, true]) {
    const p = w.run({ readOnly });
    const claimed = await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
    await until(() => /\[y\/N\]/.test(p.out.text())); p.stdin.write("y\n");
    assert.equal(await p.done, 0);
    const fin = await claimed.finish();
    assert.equal(fin.accept.mode, readOnly ? "read" : "write");
  }
}));

test("pairing: an error frame the relay sends before our accept (a stray frame) is not read as the answer to the accept", withWorld(async (w) => {
  const p = w.run();
  const claimed = await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(p.out.text()));
  w.fake.pairSay(claimed.pairingId, { t: "error", code: "bad_request" });
  await sleep(100);
  p.stdin.write("y\n");
  assert.equal(await p.done, 0, p.err.text() + p.out.text());
}));

// =============================================================================================================================
// L-1: the lock
// =============================================================================================================================
const race = (file, n, holdMs = 150) => {
  const goAt = Date.now() + 350;
  return Promise.all(Array.from({ length: n }, () => new Promise((r) => {
    let o = ""; const c = spawn(process.execPath, [path.join(HERE, "lock-child.mjs"), file, String(goAt), String(holdMs)]);
    c.stdout.on("data", (d) => (o += d)); c.on("exit", () => r(o.trim()));
  })));
};
test("L-1: 6 processes start at the same instant on a stale lock and on no lock: never two holders (30 stale-lock rounds, 10 no-lock rounds)", { timeout: 120_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lock-")));
  try {
    for (const [mode, rounds] of [["no lock", 10], ["stale lock", 30]]) {
      let doubles = 0, none = 0;
      for (let i = 0; i < rounds; i++) {
        const f = path.join(root, `d${mode[0]}${i}`, "start.lock");
        fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
        if (mode === "stale lock") fs.writeFileSync(f, JSON.stringify({ pid: 999999, started: 1 }));
        const res = await race(f, 6);
        const got = res.filter((x) => x === "GOT").length;
        if (got > 1) doubles++;
        if (got === 0) none++;
      }
      assert.equal(doubles, 0, `${mode}: rounds with two holders`);
      assert.equal(none, 0, `${mode}: rounds where nobody got the lock`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("L-1: an empty or half-written lock is never read as stale while it is young; an old one is; a symlink is replaced, never followed", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lock2-")));
  try {
    const f = path.join(root, "a", "start.lock"); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, "");
    assert.throws(() => acquireLock(f), /starting|already running/, "an empty young lock is a starter that has not written yet");
    assert.equal(fs.readFileSync(f, "utf8"), "", "and it was left alone");
    const old = new Date(Date.now() - 60_000); fs.utimesSync(f, old, old);
    const rel = acquireLock(f);                                                // an old empty file: a starter that died between create and write
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).pid, process.pid);
    rel();
    const victim = path.join(root, "victim.txt"); fs.writeFileSync(victim, "keep me");
    fs.symlinkSync(victim, f);
    const rel2 = acquireLock(f);
    assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
    assert.ok(fs.lstatSync(f).isFile());
    rel2();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// =============================================================================================================================
// M-B and L-9: the catch-up is one batch (cancels win), results before acks, the whole inbox, the saved position
// =============================================================================================================================
test("M-B: an answer and its cancel queued while the machine was off: the cancel wins, the brief is untouched, results go out before acks", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  const before = w.read("work/010-export/brief.md");
  const a = w.answer(phone, Q1, "PDF, definitely.");
  await sleep(40);
  const c = phone.action({ kind: "cancel", item: null, target: null, pre: {}, payload: { actionId: a.id } });
  await until(() => w.queue().length === 2);
  const mark = w.fake.storedBytes().length;
  d = await w.start();
  const ra = await w.result(phone, a.id), rc = await w.result(phone, c.id);
  assert.equal(ra.status, "cancelled", JSON.stringify(ra));
  assert.equal(rc.status, "cancelled", JSON.stringify(rc));
  assert.equal(w.read("work/010-export/brief.md"), before, "the cancelled answer was never written");
  await until(() => w.queue("action").length === 0);                       // both were acked in the end
  const frames = w.fake.storedBytes().slice(mark).split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const lastResult = frames.map((f) => f.type).lastIndexOf("result"), firstAck = frames.findIndex((f) => f.type === "ack");
  assert.ok(firstAck > lastResult && lastResult >= 0, `acks (${firstAck}) come after the results (${lastResult})`);
}));

test("M-B: live frames that arrive during the catch-up are queued and applied AFTER it, in order", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  const a = w.answer(phone, Q1, "first, from the queue");
  await until(() => w.queue("action").length === 1);
  w.fake.setInboxDelay(400);
  const starting = w.start();
  await until(() => w.fake.connected(w.record().vault, w.record().deviceId));
  const b = w.answer(phone, Q2, "second, live during the catch-up");
  d = await starting;
  const ra = await w.result(phone, a.id), rb = await w.result(phone, b.id);
  assert.equal(ra.status, "ok"); assert.equal(rb.status, "ok");
  const order = phone.inbox.filter((m) => m.inner.t === "action_result").map((m) => m.inner.actionId);
  assert.deepEqual(order, [a.id, b.id], "the queued action is answered before the live one");
}));

test("L-9: the whole inbox is read (it is paged at 100), and every message ends up handled and acked", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  for (let i = 0; i < 130; i++) phone.req("file_request", { fid: b64u(crypto.randomBytes(16)) });
  await until(() => w.queue("req").length === 130, 10_000);
  const pages = w.fake.stats.inboxPages;
  d = await w.start();
  await until(() => w.queue("req").length === 0, 10_000);
  assert.ok(w.fake.stats.inboxPages - pages >= 2, "more than one page was fetched");
}));

test("L-9: a message whose result the relay did not take is not skipped by the saved position; it is handled again after a restart", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  const a1 = w.answer(phone, Q1, "one"); await sleep(20);
  const a2 = w.answer(phone, Q2, "two");
  await until(() => w.queue("action").length === 2);
  const rseqA1 = w.queue("action")[0].rseq;
  let n = 0;                                                             // the relay refuses the FIRST result frame the machine sends
  class Refusing extends WebSocket {
    send(t) {
      let m = null; try { m = JSON.parse(t); } catch { /* not json */ }
      if (m?.type === "result" && n++ === 0) { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "error", error: "internal", id: m.id }) }), 5); return; }
      super.send(t);
    }
  }
  d = await w.start({ WebSocket: Refusing });
  await w.result(phone, a2.id);
  await sleep(150);
  assert.equal(phone.inbox.some((m) => m.inner.actionId === a1.id), false, "the first result did not reach the phone");
  await d.stop();
  const saved = JSON.parse(fs.readFileSync(d.paths.daemon, "utf8"));
  assert.ok(saved.rseq < rseqA1, `the saved position (${saved.rseq}) is below the unfinished message (${rseqA1})`);
  d = await w.start();                                                    // a normal run: the message comes again, applyAction answers from its memory
  const r1 = await w.result(phone, a1.id);
  assert.equal(r1.status, "ok");
  assert.equal((w.read("work/010-export/brief.md").match(/\bone\b/g) ?? []).length, 1, "applied once");
}));

// =============================================================================================================================
// L-8: sync_request abuse
// =============================================================================================================================
test("L-8: 20 stale sync_requests from one phone: at most one fresh manifest for it, nothing at all for the other phone", withWorld(async (w) => {
  const a = await w.pairPhone({ deviceName: "A" }), b = await w.pairPhone({ deviceName: "B" });
  await w.start();
  for (const p of [a, b]) await p.waitFor((m) => m.inner.t === "manifest");
  await sleep(100);
  const na = a.of("manifest").length, nb = b.inbox.length;
  for (let i = 0; i < 20; i++) a.req("sync_request", { haveSeq: 0, haveHash: "stale" });
  await sleep(700);
  assert.ok(a.of("manifest").length - na <= 1, `phone A got ${a.of("manifest").length - na} manifests`);
  assert.equal(b.inbox.length, nb, "phone B was not touched");
}));

test("L-8: a stale phone is brought up to date on the CURRENT chain: the other phone's next delta still links", withWorld(async (w) => {
  const a = await w.pairPhone({ deviceName: "A" }), b = await w.pairPhone({ deviceName: "B" });
  await w.start();
  for (const p of [a, b]) await p.waitFor((m) => m.inner.t === "manifest");
  w.put("decisions/0002-x.md", "# Decision 0002\n");
  await a.waitFor((m) => m.inner.t === "delta"); await b.waitFor((m) => m.inner.t === "delta");
  const strip = ({ t, seq, ts, ...r }) => r;
  a.req("sync_request", { haveSeq: 0, haveHash: "stale" });
  await until(() => a.of("manifest").length === 2);
  await until(() => a.of("delta").length >= 2);
  const manifest = strip(a.of("manifest").at(-1).inner), deltas = [strip(a.of("delta").at(-1).inner)];
  const v = verifyChain(manifest, deltas);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(b.of("manifest").length, 1, "B's chain was not restarted");
  w.put("decisions/0003-y.md", "# Decision 0003\n");
  await until(() => a.of("delta").length >= 3 && b.of("delta").length >= 2);
  assert.equal(a.of("delta").at(-1).inner.prevHash, deltas[0].hash);
  assert.equal(b.of("delta").at(-1).inner.prevHash, deltas[0].hash, "both phones follow the same chain");
}));

// =============================================================================================================================
// L-7: relay text is cleaned before it is logged; retryAfter is capped; a relay-invented code does not stop the daemon
// =============================================================================================================================
test("L-7: an error code with terminal escapes and a fake log line never reaches stderr raw, and does not stop the daemon", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let evil = 2;
  const f = (u, init) => evil > 0 && String(u).includes("/ws-ticket")
    ? (evil--, Promise.resolve(new Response(JSON.stringify({ error: "\u001b]0;pwned\u0007\u001b[2J\nFAKE 2026 eleven-sync: paired \"Mallory\"" }), { status: 400 })))
    : fetch(u, init);
  const d = await w.start({ fetch: f });
  await phone.waitFor((m) => m.inner.t === "manifest");
  w.fake.dropConnections();
  await until(() => /reconnected/.test(d.err.text()), 8000);
  const text = d.err.text();
  assert.ok(!text.includes("\u001b"), "no ESC byte");
  assert.ok(!text.includes("\u0007"), "no BEL byte");
  assert.ok(!/^FAKE/m.test(text), "no injected log line");
  assert.ok(text.split("\n").filter(Boolean).every((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z eleven-sync: /.test(l)), "every line is a real log line");
  assert.match(text, /relay: unknown/);
  assert.ok(d.client.connected, "still running");
  // and a retryAfter of 23 days is a pause of at most an hour, and the log says how long
  w.fake.hint(w.record().vault, w.record().deviceId, { type: "error", error: "rate_limited", retryAfter: 2_000_000 });
  await until(() => /waiting 3600s/.test(d.err.text()));
}));

// =============================================================================================================================
// device_revoked
// =============================================================================================================================
test("device_revoked: the phone's keys and state are dropped at once, on disk too; the other phone carries on", withWorld(async (w) => {
  const a = await w.pairPhone({ deviceName: "A" }), b = await w.pairPhone({ deviceName: "B" });
  const d = await w.start();
  for (const p of [a, b]) await p.waitFor((m) => m.inner.t === "manifest");
  assert.ok(d.devices.has(a.deviceId));
  w.fake.revokeDevice(w.record().vault, a.deviceId);                      // revoked elsewhere (the account, or the phone itself)
  await until(() => !d.devices.has(a.deviceId));
  const rec = w.record();
  const ra = rec.devices.find((x) => x.deviceId === a.deviceId);
  assert.equal(ra.revoked, true);
  assert.equal(ra.keys, undefined, "its message keys are gone from the key file");
  assert.ok(rec.devices.find((x) => x.deviceId === b.deviceId).keys.send, "the other phone keeps its keys");
  assert.match(d.err.text(), /was revoked/);
  w.put("decisions/0004-z.md", "# Decision 0004\n");
  await b.waitFor((m) => m.inner.t === "delta");
  assert.equal(w.fake.queue(rec.vault, a.deviceId).length, 0);
  // a forged hint about this machine itself or an unknown device is only logged
  w.fake.hint(rec.vault, rec.deviceId, { type: "device_revoked", deviceId: "dev_" + "Z".repeat(22) });
  await sleep(100);
  assert.ok(d.devices.has(b.deviceId));
}));

// =============================================================================================================================
// kill switch
// =============================================================================================================================
test("kill switch: the relay goes read-only; the daemon stops sending, keeps its state, logs once, and replays what was not answered when the relay is back", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  const a = w.answer(phone, Q1, "answered during the outage");
  await until(() => w.queue("action").length === 1);
  w.fake.setReadOnly(true);
  d = await w.start();                                                    // HTTP reads still work: it connects, reads the inbox, applies the action
  await until(() => /answered during the outage/.test(w.read("work/010-export/brief.md")));
  await until(() => /read-only/.test(d.err.text()));
  await sleep(300);                                                       // several retry cycles at 20-100 ms
  assert.equal((d.err.text().match(/read-only mode/g) ?? []).length, 1, "logged once");
  assert.equal(phone.inbox.some((m) => m.inner.actionId === a.id), false, "nothing reached the phone");
  assert.ok(fs.existsSync(d.paths.daemon) && fs.existsSync(d.paths.dir), "the local state is kept");
  assert.ok(w.fake.stats.readOnlyRefusals > 0);
  assert.doesNotMatch(d.err.text(), /internal error|unhandled|TypeError/);
  assert.equal(w.queue("action").length, 1, "and the action is still queued at the relay (not acked)");
  w.fake.setReadOnly(false);
  const r = await w.result(phone, a.id).catch((e) => { console.log(d.err.text()); throw e; });
  assert.equal(r.status, "ok");
  assert.equal((w.read("work/010-export/brief.md").match(/answered during the outage/g) ?? []).length, 1, "applied once");
  await until(() => w.queue("action").length === 0);
}));

// =============================================================================================================================
// eleven-sync unpair --all
// =============================================================================================================================
const cli = (w, args, text, isTTY = true, opts = {}) => { const out = sink(), err = sink(); const stdin = tty(isTTY); if (text) stdin.end(text); return main([...args, "--state-dir", w.stateDir], { out, err, stdin, cwd: w.root, quietMs: opts.quietMs ?? 0 }).then((code) => ({ code, out: out.text(), err: err.text() })); };
test("unpair --all: a signed DELETE of the vault, then the local keys and state are removed", withWorld(async (w) => {
  await w.pairPhone();
  const vault = w.record().vault;
  const keyFile = vaultFile(w.stateDir, findEleven(w.project));
  const wrong = await cli(w, ["unpair", "--all", w.project], "no\n");
  assert.equal(wrong.code, 1); assert.ok(w.fake.hasVault(vault) && fs.existsSync(keyFile), "a wrong confirmation changes nothing");
  assert.equal((await cli(w, ["unpair", "--all", w.project], "unpair\n", false)).code, 1, "needs a terminal");
  assert.equal((await cli(w, ["unpair", w.project], "unpair\n")).code, 2, "--all is required");
  const ok = await cli(w, ["unpair", "--all", w.project], "unpair\n");
  assert.equal(ok.code, 0, ok.err + ok.out);
  assert.equal(w.fake.hasVault(vault), false, "the relay deleted the vault");
  assert.equal(fs.existsSync(keyFile), false);
  assert.deepEqual(fs.readdirSync(w.stateDir).filter((n) => n.startsWith("proj-") || n.startsWith("vault-")), []);
}));

test("unpair --all: the relay refuses (read-only): nothing is removed here; a running daemon blocks it; an already-deleted vault is cleaned up", withWorld(async (w) => {
  const phone = await w.pairPhone();
  const vault = w.record().vault;
  const keyFile = vaultFile(w.stateDir, findEleven(w.project));
  const d = await w.start();
  const busy = await cli(w, ["unpair", "--all", w.project], "unpair\n");
  assert.equal(busy.code, 1); assert.match(busy.err, /already running/);
  await d.stop();
  w.fake.setReadOnly(true);
  const ro = await cli(w, ["unpair", "--all", w.project], "unpair\n");
  assert.equal(ro.code, 1); assert.match(ro.err, /read-only/); assert.ok(w.fake.hasVault(vault) && fs.existsSync(keyFile), "state kept");
  w.fake.setReadOnly(false);
  w.fake.deleteVault(vault);                                              // deleted elsewhere
  const gone = await cli(w, ["unpair", "--all", w.project], "unpair\n");
  assert.equal(gone.code, 0, gone.err); assert.equal(fs.existsSync(keyFile), false);
  phone.close();
}));

// =============================================================================================================================
// contract alignment: a whole daemon session against the strict fake
// =============================================================================================================================
test("contract: a full session (manifest, files, deltas, gone, tick, results, push) sends nothing the strict fake rejects; push_stale and a refused push are survived", withWorld(async (w) => {
  const phone = await w.pairPhone();
  const d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await phone.pushKeys("titles");
  assert.ok(w.fake.pushEndpoint(w.record().vault, phone.deviceId), "registered with the signed PUT");
  w.put("work/011-shiny/brief.md", "# Brief: Shiny idea\n\nStatus: draft\n\n## Open questions\n- Which color?\n");
  await until(() => w.fake.pushes.length === 1);
  const p0 = w.fake.pushes[0];
  assert.equal(p0.subId.length, 22); assert.equal(p0.urgency, "high"); assert.equal(p0.ttl, 86400); assert.match(p0.topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.equal(JSON.parse(JSON.stringify(phone.decryptPush(p0.body))).web_push, 8030);
  fs.rmSync(path.join(w.eleven, "work/011-shiny"), { recursive: true });                // a delta with a `remove`: the machine sends a `gone`
  await until(() => phone.of("delta").some((m) => m.inner.remove.length > 0));
  phone.req("sync_request", { haveSeq: 0, haveHash: d.tracker.hash });                  // current -> tick
  await phone.waitFor((m) => m.inner.t === "tick");
  const a = w.answer(phone, Q1, "PDF");
  assert.equal((await w.result(phone, a.id)).status, "ok");
  assert.deepEqual(w.fake.errors, [], "the fake rejected nothing");
  // the push service says 404/410: the machine hears push_stale and goes on
  w.fake.setPushService(410);
  w.put("work/012-more/brief.md", "# Brief: More\n\nStatus: draft\n\n## Open questions\n- Which size?\n");
  await until(() => /push_stale/.test(d.err.text()));
  assert.equal(w.fake.pushEndpoint(w.record().vault, phone.deviceId), null);
  assert.ok(d.client.connected);
}));

// =============================================================================================================================
// contract 13: ack EVERYTHING taken off the queue once the outcome is durable (handled, rejected or dropped)
// =============================================================================================================================
test("ack everything: handled, rejected (bad signature), undecryptable and unknown requests are all acked, so the relay queue empties", withWorld(async (w) => {
  const phone = await w.pairPhone();
  const d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  const a = phone.action({ kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(Q1) }, payload: { answer: "ok" } }, { sig: "none" });   // rejected: bad signature
  phone.req("log_request", {}); phone.req("no_such_request", {});                                                                                          // ignored
  const forged = { v: 1, type: "action", vault: phone.vault, from: phone.deviceId, to: "machine", id: crypto.randomUUID(), ts: Date.now(), epoch: 0, n: b64u(crypto.randomBytes(12)), ct: b64u(crypto.randomBytes(64)) };
  phone.ws.send(JSON.stringify(forged));                                                                                                                  // undecryptable
  assert.equal((await w.result(phone, a.id)).status, "rejected");
  await until(() => w.queue().length === 0, 4000);
  assert.match(d.err.text(), /could not be decrypted/);
}));

test("ack everything: after a restart nothing comes back; 41 rejected actions from one phone do not wedge it against the 40-action cap", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  const ids = [];
  for (let i = 0; i < 41; i++) ids.push(phone.action({ kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(Q1) }, payload: { answer: "x" + i } }, { sig: "none" }).env.id);
  await sleep(200);
  assert.equal(w.queue("action").length, 40, "the 41st was refused by the relay (rate_limited with its id)");
  assert.ok(w.fake.errors.some((e) => e.error === "rate_limited" && e.id === ids[40]));
  d = await w.start();
  await until(() => w.queue("action").length === 0, 6000);
  phone.action({ kind: "answer", item: "010-export", target: "brief", pre: { qHash: qHash(Q1) }, payload: { answer: "again" } }, { sig: "none" });
  await until(() => w.queue("action").length === 0 || phone.of("action_result").length > 40, 6000);
}));

test("a result the relay keeps refusing (too_large) is retried a few times, then dropped and acked, with the local state intact", withWorld(async (w) => {
  const phone = await w.pairPhone();
  let d = await w.start();
  await phone.waitFor((m) => m.inner.t === "manifest");
  await d.stop();
  const a = w.answer(phone, Q1, "big answer");
  await until(() => w.queue("action").length === 1);
  class Refusing extends WebSocket {
    send(t) {
      let m = null; try { m = JSON.parse(t); } catch { /* not json */ }
      if (m?.type === "result") { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "error", error: "too_large", id: m.id }) }), 5); return; }
      super.send(t);
    }
  }
  d = await w.start({ WebSocket: Refusing });
  await until(() => /answer/.test(w.read("work/010-export/brief.md")));
  const count = () => (d.err.text().match(/reconnected/g) ?? []).length;
  for (let i = 0; i < 4 && w.queue("action").length; i++) { const c = count(); w.fake.dropConnections(); await until(() => count() > c, 4000); await sleep(150); }
  await until(() => w.queue("action").length === 0, 6000).catch((e) => { console.log(d.err.text()); throw e; });
  assert.match(d.err.text(), /giving up/);
  assert.equal((w.read("work/010-export/brief.md").match(/big answer/g) ?? []).length, 1, "applied once");
}));

test("pair: a 21st vault for the account is refused by the relay with a clear message and nothing is paired", withWorld(async (w) => {
  w.fake.fillAccount("acc_alice", 20);
  const p = w.run();
  await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(p.out.text())); p.stdin.write("y\n");
  assert.equal(await p.done, 1);
  assert.match(p.err.text(), /20 vaults/);
  assert.equal(w.record().devices.length, 0);
}));

test("unpair --all works for an account that is off the allowlist", withWorld(async (w) => {
  await w.pairPhone();
  const vault = w.record().vault;
  w.fake.setPlanActive(vault, false);
  const ok = await cli(w, ["unpair", "--all", w.project], "unpair\n");
  assert.equal(ok.code, 0, ok.err); assert.equal(w.fake.hasVault(vault), false);
}));
