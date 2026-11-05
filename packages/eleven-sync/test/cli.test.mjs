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

test("pair, start, devices are stubs", () => {
  for (const c of ["pair", "start", "devices"]) assert.match(run([c]).stdout, /not built yet/);
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
