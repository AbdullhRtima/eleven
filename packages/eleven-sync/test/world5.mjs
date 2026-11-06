// Shared world for the 5d tests: a fake relay, a project, pair() and the daemon wired together.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { startFakeRelay } from "./fake-relay.mjs";
import { claimLink, Phone } from "./phone-sim.mjs";
import { pair, vaultFile } from "../src/pair.js";
import { startDaemon } from "../src/start.js";
import { findEleven } from "../src/find.js";

export const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + fn); await new Promise((r) => setTimeout(r, 10)); } };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const b64u = (b) => Buffer.from(b).toString("base64url");
export const sha = (x) => b64u(crypto.createHash("sha256").update(x).digest());
export const qHash = (q) => sha(q.normalize("NFC").trim().replace(/\s+/g, " "));
export const tty = (isTTY = true) => { const s = new PassThrough(); s.isTTY = isTTY; return s; };
export const sink = (isTTY = true) => { let text = ""; const w = new Writable({ write(c, _e, cb) { text += c; cb(); } }); w.text = () => text; w.isTTY = isTTY; return w; };
export const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
export const LINK = /https:\/\/m\.eleven\.rtima\.org\/pair#\S+/;

export const Q1 = "Which export format first? Markdown or PDF?", Q2 = "Second question here?";
const BRIEF = `# Brief: Export notes\n\nStatus: draft\n\n## Problem\nUsers want to export.\n\n## Open questions\n- ${Q1}\n- ${Q2}\n`;

export async function world(fakeOpts = {}) {
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
export const withWorld = (fn, opts) => async () => { const w = await world(opts); try { await fn(w); } finally { await w.close(); } };

