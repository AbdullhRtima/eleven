// Regression tests for the carried LOWs of security review 04e (E1, E2, E3, E5) and 04c (N7). Synthetic ledgers only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as h from "./apply-helpers.mjs";
import { cleanText, escapeLt, prepBlock, prepTitle } from "../src/text.js";
import { appendLog } from "../src/astate.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const { ledger, run } = h;
const mkfifo = (p) => assert.equal(spawnSync("mkfifo", [p]).status, 0);

// ---- E1
test("E1: in a URL word every '&' is '&amp;', so no entity-shaped text (with '_' or without) is left", () => {
  for (const w of ["http://e.example/?a&shy_x;b", "http://e.example/&nbsp_;", "http://e.example&lt_", "www.e.example/&not_", "https://e.example/&#x41_;", "http://e.example?&ZeroWidthSpace;x", "HTTP://E.X/&amp;"]) {
    const out = escapeLt(w);
    assert.ok(!/&(?!amp;)/.test(out), `a bare & is left in ${out}`);
    assert.equal(out, w.replace(/&/g, "&amp;"));
  }
  // the entity decodes back to exactly what was typed
  assert.equal(escapeLt("see http://e.example/?a=1&b=2 now"), "see http://e.example/?a=1&amp;b=2 now");
  // "<" and "[" in a URL word keep their rules
  assert.equal(escapeLt("http://e.example<x&y"), "http://e.example&lt;x&amp;y");
  assert.equal(escapeLt("http://e.example/[a]"), "http://e.example/\\[a\\]");
  // outside a URL word nothing changed
  assert.equal(escapeLt("a & b &shy_x;"), "a \\& b \\&shy_x;");
  const p = prepBlock("go http://e.example/&shy_x; ok", { max: 4000, keepBlank: false });
  assert.deepEqual(p.lines, ["go http://e.example/&amp;shy_x; ok"]);
});

// ---- E2
test("E2: U+FFFC is stripped (text, titles, device names)", () => {
  assert.equal(cleanText("Mark￼￼￼down"), "Markdown");
  assert.equal(prepTitle("A￼B").title, "AB");
  assert.equal(prepBlock("x￼y", { max: 100, keepBlank: false }).lines[0], "xy");
});

// ---- E3
test("E3: an emoji with a VS16 form is always written with U+FE0F; RGI sequences stay intact", () => {
  for (const x of ["☝", "⛹", "✌", "✍", "\u{1F321}", "\u{1F324}", "©", "❤"]) {
    assert.equal(cleanText(`a${x}b`), `a${x}️b`, "bare " + x.codePointAt(0).toString(16));
    assert.equal(cleanText(`a${x}️b`), `a${x}️b`, "with VS16 " + x.codePointAt(0).toString(16));
    assert.equal(cleanText(`a${x}︎​b`), `a${x}️b`, "VS15 and ZWSP " + x.codePointAt(0).toString(16));
    assert.equal(cleanText(`a${x}️️️b`), `a${x}️b`, "VS16 run");
  }
  // both spellings give one string, so presence of the selector cannot carry a bit
  assert.equal(cleanText("☝"), cleanText("☝️"));
  // things that are not emoji with a VS16 form are untouched; the selector is still stripped from them
  assert.equal(cleanText("1 a # * é 中"), "1 a # * é 中");
  assert.equal(cleanText("1️"), "1");
  assert.equal(cleanText("\u{1F600}"), "\u{1F600}");
  assert.equal(cleanText("\u{1F600}️"), "\u{1F600}");
  // RGI sequences are kept as they are
  for (const s of ["\u{1F468}‍\u{1F469}‍\u{1F467}", "\u{1F3F3}️‍\u{1F308}", "1️⃣", "☝\u{1F3FD}", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}", "\u{1F1E9}\u{1F1EA}"]) {
    assert.equal(cleanText(s), s, JSON.stringify(s));
  }
});

// ---- E5
test("E5: a FIFO at actions.log never hangs; the log line is skipped with a warning", () => {
  const L = ledger(); mkfifo(path.join(L.state, "actions.log"));
  const code = `import { appendLog } from ${JSON.stringify(pathToFileURL(path.join(SRC, "astate.js")).href)};
    appendLog(${JSON.stringify(L.state)}, { now: 1, device: "d", kind: "answer", item: "x", actionId: "a", hash: "h", result: "written" }); console.log("returned");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
  assert.equal(r.error, undefined, "hung: " + r.error);
  assert.equal(r.stdout.trim(), "returned");
  assert.match(r.stderr, /not writing actions\.log/);
});

test("E5: a whole applyAction with a FIFO at actions.log still finishes", () => {
  const L = ledger(); mkfifo(path.join(L.state, "actions.log"));
  const act = h.answerBrief(L);
  const code = `import { applyAction } from ${JSON.stringify(pathToFileURL(path.join(SRC, "apply.js")).href)};
    const r = await applyAction(${JSON.stringify(act)}, { elevenDir: ${JSON.stringify(L.eleven)}, stateDir: ${JSON.stringify(L.state)}, device: { id: "dev_phone1", name: "Pixel 8", mode: "write" }, now: () => ${h.NOW}, recheckMs: 0, sleep: async () => {}, fids: ${JSON.stringify(Object.fromEntries([["f1", "work/010-export/brief.md"]]))} }); console.log(r.status);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 8000 });
  assert.equal(r.error, undefined, "hung: " + r.error);
  assert.equal(r.stdout.trim(), "written");
});

test("E5: appendLog still writes a regular log, mode 0600, and a symlink at actions.log is not followed", () => {
  const L = ledger();
  appendLog(L.state, { now: 1, device: "d", kind: "answer", item: "x", actionId: "a", hash: "h", result: "written" });
  const f = path.join(L.state, "actions.log");
  assert.match(fs.readFileSync(f, "utf8"), /\tanswer\tx\ta\th\twritten\n$/);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const victim = path.join(L.state, "victim"); fs.writeFileSync(victim, "keep");
  fs.rmSync(f); fs.symlinkSync(victim, f);
  appendLog(L.state, { now: 1, device: "d", kind: "answer", item: "x", actionId: "a", hash: "h", result: "written" });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
});

test("E5: the state.json fallback (no opts.fids) uses the safe reader: a FIFO there does not hang", () => {
  const L = ledger();
  fs.rmSync(path.join(L.state, "state.json"), { force: true }); mkfifo(path.join(L.state, "state.json"));
  const act = h.answerBrief(L);
  const code = `import { applyAction } from ${JSON.stringify(pathToFileURL(path.join(SRC, "apply.js")).href)};
    const r = await applyAction(${JSON.stringify(act)}, { elevenDir: ${JSON.stringify(L.eleven)}, stateDir: ${JSON.stringify(L.state)}, device: { id: "dev_phone1", name: "Pixel 8", mode: "write" }, now: () => ${h.NOW}, recheckMs: 0, sleep: async () => {} }); console.log(r.status + ":" + (r.reason ?? ""));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
  assert.equal(r.error, undefined, "hung: " + r.error);
  assert.match(r.stdout.trim(), /^refused:/);
});

// ---- N7
test("N7: device ids must match ^[A-Za-z0-9_-]{1,64}$; anything else is refused and nothing changes", async () => {
  for (const id of ["", "a b", "dev|x", "dev.x", "dev/../x", "\u0000", "é", "x".repeat(65), "dev\n", "__proto__​"]) {
    const L = ledger(); const before = h.snapshot(L.eleven), stateBefore = fs.readdirSync(L.state).sort();
    const r = await run(L, h.answerBrief(L), { device: h.device({ id }) });
    assert.deepEqual([r.status, r.reason], ["refused", "bad_device"], JSON.stringify(id));
    assert.deepEqual(h.snapshot(L.eleven), before);
    assert.deepEqual(fs.readdirSync(L.state).sort(), stateBefore);
  }
  await assert.rejects(async () => run(ledger(), h.answerBrief(ledger()), { device: h.device({ id: 7 }) }), TypeError);
  const L = ledger();
  const ok = await run(L, h.answerBrief(L), { device: h.device({ id: "x".repeat(64) }) });
  assert.equal(ok.status, "written");
});

test("N7: '__proto__', 'constructor' and 'prototype' are plain keys: no pollution, no crash, state survives a reload", async () => {
  for (const id of ["__proto__", "constructor", "prototype"]) {
    const L = ledger();
    const r = await run(L, h.answerBrief(L), { device: h.device({ id }) });
    assert.equal(r.status, "written", id);
    assert.equal(Object.hasOwn(Object.prototype, "e"), false);
    assert.equal(Object.hasOwn(Object.prototype, "a"), false);
    assert.equal(({}).e, undefined);
    assert.equal(typeof Object.prototype.constructor, "function");
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    const saved = JSON.parse(fs.readFileSync(path.join(L.state, "actions-state.json"), "utf8"));
    assert.ok(Object.hasOwn(saved.rate, id), "rate entry saved under " + id);
    // second action after a reload from disk, with a device of the same name: counted, not crashed
    const r2 = await run(L, h.cancel(h.uuid()), { device: h.device({ id }) });
    assert.equal(r2.status, "cancelled", id);
    const saved2 = JSON.parse(fs.readFileSync(path.join(L.state, "actions-state.json"), "utf8"));
    assert.equal(saved2.rate[id].a.length, 1);
    assert.equal(saved2.rate[id].e.length, 1);
    // another device is not affected
    const r3 = await run(L, h.cancel(h.uuid()), { device: h.device({ id: "dev_other" }) });
    assert.equal(r3.status, "cancelled");
  }
});
