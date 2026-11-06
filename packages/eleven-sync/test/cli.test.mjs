import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acmeLedger, put, tmp, TASKS_USER } from "./helpers.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/eleven-sync.js");
const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });

test("--help and --version", () => {
  const h = run(["--help"]);
  assert.equal(h.status, 0);
  for (const w of ["status", "pair", "start", "devices"]) assert.match(h.stdout, new RegExp(w));
  assert.match(run(["--version"]).stdout, /^0\.0\.1\n$/);
});

test("devices is a stub", () => {
  for (const c of ["devices"]) assert.match(run([c]).stdout, /not built yet/);
});

test("status prints items, kinds and the manifest summary", () => {
  const { project, eleven } = acmeLedger();
  put(eleven, "work/011-theme/brief.md", "# Brief: Dark theme\n\nStatus: approved\n");
  put(eleven, "work/011-theme/tasks.md", TASKS_USER);
  const r = run(["status"], path.join(eleven, "work/009-share-a-note"));   // from deep inside: walks up
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /009-share-a-note {2}Share a note\n {4}working \(backend\) {2}round 2\/10/);
  assert.match(r.stdout, /010-export {2}Export notes\n {4}waiting on you/);
  assert.match(r.stdout, /011-theme {2}Dark theme\n {4}waiting on you \(user\)/);
  assert.match(r.stdout, /files: 8 \(8 md, 0 html\)/);
  assert.equal(run(["status", project]).stdout, r.stdout);                 // from the project root
  const h = run(["status", project, "--state-dir", tmp()]);
  assert.match(h.stdout, /hash: [A-Za-z0-9_-]{43}/);
});

test("status with no eleven/ fails clearly", () => {
  const r = run(["status", tmp()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no eleven\/ folder/);
  assert.equal(run(["bogus"]).status, 2);
});

// ---- reset-state (follow-up after CTO review of 4b)
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.js";
import { applyAction } from "../src/apply.js";
import { ledger, NOW, newItem, device } from "./apply-helpers.mjs";

const sink = () => { let t = ""; return { write: (x) => { t += x; }, get text() { return t; } }; };
const input = (text, tty = true) => { const s = new PassThrough(); s.isTTY = tty; if (text !== null) s.end(text); return s; };
const runReset = async (args, text, tty = true) => { const out = sink(), err = sink(); const code = await main(args, { out, err, stdin: input(text, tty) }); return { code, out: out.text, err: err.text }; };

test("reset-state: refuses when stdin is not a TTY and changes nothing", async () => {
  const L = ledger(), file = path.join(L.state, "actions-state.json");
  fs.writeFileSync(file, "{bad");
  const r = await runReset(["reset-state", L.state], "reset\n", false);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a TTY/);
  assert.equal(fs.readFileSync(file, "utf8"), "{bad");
  assert.deepEqual(fs.readdirSync(L.state).filter((n) => n.includes(".bad-")), []);
});

test("reset-state: shows the plan, needs the word reset, moves the bad file aside (never deletes it) and starts clean", async () => {
  const L = ledger(), file = path.join(L.state, "actions-state.json");
  fs.writeFileSync(file, '{"v":1,"seen":{');
  const o = { elevenDir: L.eleven, stateDir: L.state, device: device(), now: () => NOW, recheckMs: 0, sleep: async () => {} };
  assert.equal((await applyAction(newItem("Dark mode"), o)).reason, "state_unavailable");
  assert.match((await applyAction(newItem("Dark mode"), o)).message, /eleven-sync reset-state/);
  for (const text of ["", "no\n", "RESET\n", "yes\n", "reset please\n"]) {   // anything but "reset" cancels
    const r = await runReset(["reset-state", L.state], text);
    assert.equal(r.code, 1, text);
    assert.match(r.out, /actions-state\.bad-/);       // the plan was shown
    assert.equal(fs.readFileSync(file, "utf8"), '{"v":1,"seen":{', text);
  }
  const r = await runReset(["reset-state", L.state], "reset\n");
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(file));
  const kept = fs.readdirSync(L.state).filter((n) => /^actions-state\.bad-\d{4}-\d\d-\d\dT[\d-]+Z?\.json$/.test(n));
  assert.equal(kept.length, 1, fs.readdirSync(L.state).join());
  assert.equal(fs.readFileSync(path.join(L.state, kept[0]), "utf8"), '{"v":1,"seen":{');
  assert.equal((await applyAction(newItem("Dark mode"), o)).status, "written");   // clean start
  // a second reset never overwrites the first backup
  fs.writeFileSync(file, "{bad2");
  assert.equal((await runReset(["--state-dir", L.state, "reset-state"], "reset\n")).code, 0);
  const all = fs.readdirSync(L.state).filter((n) => n.includes(".bad-"));
  assert.equal(all.length, 2);
  assert.ok(all.some((n) => fs.readFileSync(path.join(L.state, n), "utf8") === '{"v":1,"seen":{'));
});

test("reset-state: nothing to reset when the file is missing; status warns about an unreadable one", async () => {
  const L = ledger();
  const r = await runReset(["reset-state", L.state], "reset\n");
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to reset/);
  fs.writeFileSync(path.join(L.state, "actions-state.json"), "garbage");
  const out = sink();
  await main(["status", L.project, "--state-dir", L.state], { out, err: sink() });
  assert.match(out.text, /warning: actions-state\.json is unreadable.*eleven-sync reset-state/);
});

test("reset-state: help lists it, and the real binary refuses without a TTY", () => {
  assert.match(run(["--help"]).stdout, /reset-state/);
  const d = tmp(); fs.writeFileSync(path.join(d, "actions-state.json"), "{bad");
  const r = spawnSync(process.execPath, [BIN, "reset-state", d], { encoding: "utf8", input: "reset\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a TTY/);
  assert.equal(fs.readFileSync(path.join(d, "actions-state.json"), "utf8"), "{bad");
});
