// `eleven-sync pair` against the fake relay and a simulated phone (protocol 6, security H5).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { startFakeRelay } from "./fake-relay.mjs";
import { claimLink, parseLink } from "./phone-sim.mjs";
import { pair, vaultFile } from "../src/pair.js";
import { findEleven } from "../src/find.js";

const until = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + fn); await new Promise((r) => setTimeout(r, 10)); } };

function tty(isTTY = true) { const s = new PassThrough(); s.isTTY = isTTY; return s; }
function sink(isTTY = true) { let text = ""; const w = new Writable({ write(c, _e, cb) { text += c; cb(); } }); w.text = () => text; w.isTTY = isTTY; return w; }

async function world(fakeOpts = {}) {
  const fake = await startFakeRelay(fakeOpts);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pair-"));
  const project = path.join(root, "proj"), stateDir = path.join(root, "state");
  fs.mkdirSync(path.join(project, "eleven", "work"), { recursive: true });
  const token = fake.addAccount("acc_alice", "alice@example.com");
  const run = (over = {}) => {
    const stdin = tty(), out = sink(), err = sink(), ac = new AbortController();
    const done = pair({ dir: project, stateDir, relay: fake.url, stdin, out, err, signal: ac.signal, WebSocket: globalThis.WebSocket, quietMs: 0, ...over });
    return { stdin, out, err, ac, done, link: async () => { await until(() => /Press Enter/.test(out.text())); stdin.write("\n"); return (await until(() => /https:\/\/m\.eleven\.rtima\.org\/pair#\S+/.exec(out.text())))[0]; } };
  };
  return { fake, root, project, stateDir, token, run, close: async () => { await fake.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const withWorld = (fn, opts) => async () => { const w = await world(opts); try { await fn(w); } finally { await w.close(); } };
const record = (w) => JSON.parse(fs.readFileSync(vaultFile(w.stateDir, findEleven(w.project)), "utf8"));
const wordsShown = (out) => /Check words: (\w+ \w+ \w+ \w+)/.exec(out)?.[1].split(" ");

test("happy path: both sides show the same 4 words and derive the same keys, then 'Paired'", withWorld(async (w) => {
  const p = w.run();
  const link = await p.link();
  assert.match(p.out.text(), /Press Enter to show it/);
  assert.match(p.out.text(), /\x1b\[30;47m/, "a QR code is drawn");
  const phone = await claimLink({ relayUrl: w.fake.url, link, token: w.token });
  assert.equal(phone.status, 202);
  assert.match(phone.deviceId, /^dev_[\w-]{22}$/);
  await until(() => /\[y\/N\]/.test(p.out.text()));
  const shown = wordsShown(p.out.text());
  assert.deepEqual(shown, phone.words, "same check words on both sides");
  const text = p.out.text();
  assert.match(text, /Pixel 8/); assert.match(text, /a•••@example\.com/); assert.match(text, /read and write/);
  p.stdin.write("y\n");
  assert.equal(await p.done, 0);
  assert.match(p.out.text(), /Paired "Pixel 8"/);
  const fin = await phone.finish();
  assert.equal(fin.ok, true);
  assert.equal(fin.accept.deviceId, phone.deviceId);
  const rec = record(w);
  assert.equal(rec.devices.length, 1);
  const d = rec.devices[0];
  assert.deepEqual([d.deviceId, d.name, d.mode, d.accountId], [phone.deviceId, "Pixel 8", "write", "acc_alice"]);
  assert.equal(d.keys.send, fin.m2p, "K_m2p is the same on both sides");
  assert.equal(d.keys.recv, fin.p2m, "K_p2m is the same on both sides");
  assert.notEqual(d.keys.send, d.keys.recv);
  assert.equal(rec.account, "acc_alice");
  assert.equal(w.fake.pairingState(phone.pairingId), "accepted");
}));

for (const [name, answer] of [["N", "n\n"], ["Enter", "\n"], ["anything else", "maybe\n"]]) {
  test(`the user answers ${name}: nothing is paired, the relay is told, exit 1`, withWorld(async (w) => {
    const p = w.run();
    const phone = await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
    await until(() => /\[y\/N\]/.test(p.out.text()));
    p.stdin.write(answer);
    assert.equal(await p.done, 1);
    assert.match(p.out.text(), /Nothing was paired/);
    assert.doesNotMatch(p.out.text(), /Paired "/);
    assert.equal(record(w).devices.length, 0);
    assert.equal(record(w).account, null);
    await until(() => w.fake.pairingState(phone.pairingId) === "refused");
    const fin = await phone.finish();
    assert.deepEqual([fin.ok, fin.error], [false, "refused"]);
  }));
}

test("'yes' and 'Y' are accepted too", withWorld(async (w) => {
  const p = w.run();
  await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(p.out.text()));
  p.stdin.write("YES\n");
  assert.equal(await p.done, 0);
}));

test("an expired code: no claim in time -> expired, exit 1; a late claim gets pairing_expired", withWorld(async (w) => {
  const p = w.run();
  const link = await p.link();
  assert.equal(await p.done, 1);
  assert.match(p.out.text(), /expired/i);
  const late = await claimLink({ relayUrl: w.fake.url, link, token: w.token });
  assert.equal(late.status, 410);
  assert.equal(late.body.error, "pairing_expired");
  assert.equal(record(w).devices.length, 0);
}, { pairTtlMs: 400 }));

test("a claim answered after the code expired counts as No", withWorld(async (w) => {
  const p = w.run();
  await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(p.out.text()));
  assert.equal(await p.done, 1, "no answer before the 5 minutes end");
  assert.match(p.out.text(), /Timed out/);
  assert.equal(record(w).devices.length, 0);
}, { pairTtlMs: 600 }));

test("a code used twice: the second claim is refused (409) and a stray second claim frame is ignored", withWorld(async (w) => {
  const p = w.run();
  const link = await p.link();
  const first = await claimLink({ relayUrl: w.fake.url, link, token: w.token, deviceName: "First" });
  const other = w.fake.addAccount("acc_mallory", "mallory@example.com");
  const second = await claimLink({ relayUrl: w.fake.url, link, token: other, accountId: "acc_mallory", deviceName: "Second" });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "pairing_used");
  await until(() => /\[y\/N\]/.test(p.out.text()));
  w.fake.claim(first.pairingId, { sealed: "A".repeat(60), relayAccountId: "acc_mallory", relayEmailMasked: "m•••@example.com", deviceId: "dev_" + "x".repeat(22) });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((p.out.text().match(/\[y\/N\]/g) ?? []).length, 1, "only one prompt");
  p.stdin.write("y\n");
  assert.equal(await p.done, 0);
  assert.deepEqual(record(w).devices.map((d) => d.name), ["First"]);
}));

test("no TTY: refuses at once, nothing is created, nothing is sent", withWorld(async (w) => {
  const p = w.run({ stdin: tty(false) });
  assert.equal(await p.done, 1);
  assert.match(p.err.text(), /interactive terminal/);
  assert.equal(p.out.text(), "");
  assert.equal(fs.existsSync(w.stateDir), false);
  assert.equal(w.fake.storedBytes(), "");
}));

test("--read-only: the accept says mode read and the device is recorded read", withWorld(async (w) => {
  const p = w.run({ readOnly: true });
  const phone = await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token, withAct: false });
  await until(() => /\[y\/N\]/.test(p.out.text()));
  assert.match(p.out.text(), /read only/);
  p.stdin.write("y\n");
  assert.equal(await p.done, 0);
  assert.equal(record(w).devices[0].mode, "read");
  assert.equal(w.fake.pairingReplies(phone.pairingId).find((m) => m.t === "accept").mode, "read");
  assert.equal((await phone.finish()).ok, true);
}));

test("the secret never reaches the relay (nor any file); the link is the only place it is shown", withWorld(async (w) => {
  const p = w.run();
  const link = await p.link();
  const { secret } = parseLink(link);
  const phone = await claimLink({ relayUrl: w.fake.url, link, token: w.token });
  await until(() => /\[y\/N\]/.test(p.out.text()));
  p.stdin.write("y\n");
  assert.equal(await p.done, 0);
  await phone.finish();
  const forms = [secret.toString("base64url"), secret.toString("hex"), secret.toString("base64"), link, link.split("#")[1], secret.toString("base64url").slice(0, 20)];
  const sent = w.fake.storedBytes();
  assert.ok(sent.length > 500, "the fake did record the traffic");
  assert.match(sent, /POST \/v1\/pair\b/);
  assert.match(sent, /"t":"accept"/);
  for (const f of forms) assert.ok(!sent.includes(f), "relay saw " + f.slice(0, 8));
  assert.ok(!sent.includes("#v1."), "no fragment in any URL or header");
  for (const f of fs.readdirSync(w.stateDir)) {
    const content = fs.readFileSync(path.join(w.stateDir, f), "latin1");
    for (const x of forms.slice(0, 3)) assert.ok(!content.includes(x), "state file holds the secret");
  }
  assert.ok(!p.err.text().includes(secret.toString("base64url")));
  assert.equal(link.split("#").length, 2);
}));

test("files: state dir 0700, key file 0600, no temp files left; a second pairing reuses the keys and the vault", withWorld(async (w) => {
  const run1 = w.run(); const l1 = await run1.link();
  await claimLink({ relayUrl: w.fake.url, link: l1, token: w.token });
  await until(() => /\[y\/N\]/.test(run1.out.text())); run1.stdin.write("y\n");
  assert.equal(await run1.done, 0);
  const files = fs.readdirSync(w.stateDir);
  assert.equal(files.length, 1, files.join());
  assert.equal(fs.statSync(w.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(w.stateDir, files[0])).mode & 0o777, 0o600);
  const r1 = record(w);
  assert.match(r1.vault, /^vlt_[\w-]{22}$/); assert.match(r1.deviceId, /^dev_[\w-]{22}$/);
  const run2 = w.run(); const l2 = await run2.link();
  assert.equal(parseLink(l2).fpr.toString("base64url"), parseLink(l1).fpr.toString("base64url"), "same machine keys, same fingerprint");
  await claimLink({ relayUrl: w.fake.url, link: l2, token: w.token, deviceName: "iPad" });
  await until(() => /\[y\/N\]/.test(run2.out.text())); run2.stdin.write("y\n");
  assert.equal(await run2.done, 0);
  const r2 = record(w);
  assert.equal(r2.vault, r1.vault);
  assert.deepEqual(r2.devices.map((d) => d.name), ["Pixel 8", "iPad"]);
  assert.equal(fs.statSync(path.join(w.stateDir, files[0])).mode & 0o777, 0o600);
}));

test("a wrong 0644 key file is tightened to 0600 on the next run", withWorld(async (w) => {
  const a = w.run(); await a.link(); a.ac.abort(); await a.done;
  const f = vaultFile(w.stateDir, findEleven(w.project));
  fs.chmodSync(f, 0o644);
  const b = w.run(); await b.link(); b.ac.abort(); await b.done;
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
}));

test("Ctrl-C while waiting: clean exit 130, the channel closes, the code is dead", withWorld(async (w) => {
  const p = w.run();
  const link = await p.link();
  await until(() => /Waiting for the phone/.test(p.out.text()));
  p.ac.abort();
  assert.equal(await p.done, 130);
  assert.match(p.out.text(), /Cancelled/);
  assert.equal(record(w).devices.length, 0);
  const late = await claimLink({ relayUrl: w.fake.url, link, token: w.token });
  assert.equal(late.status, 202, "the relay still takes a claim, but nobody answers");
  await new Promise((r) => setTimeout(r, 100));
  assert.notEqual(w.fake.pairingState(late.pairingId), "accepted");
  assert.equal(record(w).devices.length, 0);
}));

test("Ctrl-C at the Enter prompt and at the [y/N] prompt", withWorld(async (w) => {
  const a = w.run(); await until(() => /Press Enter/.test(a.out.text())); a.ac.abort();
  assert.equal(await a.done, 130);
  assert.doesNotMatch(a.out.text(), /pair#/);
  const b = w.run();
  await claimLink({ relayUrl: w.fake.url, link: await b.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(b.out.text())); b.ac.abort();
  assert.equal(await b.done, 130);
  assert.equal(record(w).devices.length, 0);
}));

test("stdin closes (EOF) at the prompt: treated as No", withWorld(async (w) => {
  const p = w.run();
  await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(p.out.text()));
  p.stdin.end();
  assert.equal(await p.done, 1);
  assert.equal(record(w).devices.length, 0);
}));

test("a claim made with the wrong secret is refused without a prompt", withWorld(async (w) => {
  const p = w.run();
  const phone = await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token, wrongSecret: true });
  assert.equal(await p.done, 1);
  assert.doesNotMatch(p.out.text(), /\[y\/N\]/);
  assert.match(p.out.text(), /could not be opened/);
  assert.equal((await phone.finish()).error, "refused");
}));

test("a claim whose account differs from the relay's, or with a bad device name, is refused", withWorld(async (w) => {
  for (const [over, re] of [[{ accountId: "acc_other" }, /does not match/], [{ deviceName: 'Pixel "8"|x' }, /name that is not allowed/], [{ claimOverride: { phoneKxPub: "AAAA" } }, /malformed key/]]) {
    const p = w.run();
    await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token, ...over });
    assert.equal(await p.done, 1);
    assert.match(p.out.text(), re);
    assert.doesNotMatch(p.out.text(), /\[y\/N\]/);
  }
  assert.equal(record(w).devices.length, 0);
}));

test("a vault bound to one account refuses a phone of another account at the machine", withWorld(async (w) => {
  const a = w.run();
  await claimLink({ relayUrl: w.fake.url, link: await a.link(), token: w.token });
  await until(() => /\[y\/N\]/.test(a.out.text())); a.stdin.write("y\n");
  assert.equal(await a.done, 0);
  const b = w.run();
  const bob = w.fake.addAccount("acc_bob", "bob@example.com");
  await claimLink({ relayUrl: w.fake.url, link: await b.link(), token: bob, accountId: "acc_bob" });
  assert.equal(await b.done, 1);
  assert.match(b.out.text(), /another account/);
}));

test("unsafe relay URL (plain http, not loopback) is refused; no eleven folder is reported", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pair-x-"));
  try {
    const mk = () => ({ stdin: tty(), out: sink(), err: sink() });
    const a = mk();
    assert.equal(await pair({ dir: root, stateDir: path.join(root, "s"), relay: "http://relay.example.com", ...a }), 2);
    assert.match(a.err.text(), /https/);
    const b = mk();
    assert.equal(await pair({ dir: root, stateDir: path.join(root, "s"), relay: "https://relay.example.com", ...b }), 1);
    assert.match(b.err.text(), /no eleven\/ folder/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the relay link is https://m.eleven.rtima.org/pair#v1.<pairingId>.<secret>.<fpr>, 256-bit secret, fresh each time", withWorld(async (w) => {
  const a = w.run(), b = w.run();
  const la = parseLink(await a.link()), lb = parseLink(await b.link());
  assert.equal(la.secret.length, 32);
  assert.notDeepEqual(la.secret, lb.secret);
  assert.notEqual(la.pairingId, lb.pairingId);
  a.ac.abort(); b.ac.abort(); await Promise.all([a.done, b.done]);
}));

test("the claim frame carries phoneAuthPub; one that differs from the sealed copy is refused without a prompt", withWorld(async (w) => {
  const other = (await import("node:crypto")).generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const p = w.run();
  const phone = await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token, postAuthPub: other });
  assert.equal(await p.done, 1);
  assert.match(p.out.text(), /auth key mismatch/);
  assert.doesNotMatch(p.out.text(), /\[y\/N\]/);
  assert.equal(record(w).devices.length, 0);
  assert.equal((await phone.finish()).error, "refused");
}));

test("every accept frame carries mode (write, or read with --read-only)", withWorld(async (w) => {
  for (const readOnly of [false, true]) {
    const p = w.run({ readOnly });
    const phone = await claimLink({ relayUrl: w.fake.url, link: await p.link(), token: w.token });
    await until(() => /\[y\/N\]/.test(p.out.text()));
    p.stdin.write("y\n");
    assert.equal(await p.done, 0);
    const accepts = w.fake.pairingReplies(phone.pairingId).filter((m) => m.t === "accept");
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0].mode, readOnly ? "read" : "write");
    assert.equal(w.fake.pairingState(phone.pairingId), "accepted");
  }
}));
