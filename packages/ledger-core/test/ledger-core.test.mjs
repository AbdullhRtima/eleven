// Synthetic "Acme Notes" ledger. No real data.
import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../index.js";

const TASKS = `# Tasks: 001 search

Round: 3 / 10

| # | Task | Role | Done condition | Status |
|---|---|---|---|---|
| 1 | Write the search brief | product | brief approved | done |
| 2 | Index notes in \`work/001-search/reports/02-backend.md\` | backend | tests pass | ✅ |
| 3 | **Build** the search box, see decision 0002 | frontend | UI matches | NEXT |
| 4 | Verify | qa | PASS | todo |
`;
const files = (o) => new Map(Object.entries(o).map(([k, v]) => [k, { text: v }]));

test("parseTasks reads the table", () => {
  const rows = core.parseTasks(TASKS);
  assert.equal(rows.length, 4);
  assert.deepEqual([rows[2].n, rows[2].role, rows[2].status], ["3", "frontend", "NEXT"]);
  assert.equal(core.parseTasks("no table here"), null);
  assert.equal(core.parseTasks(null), null);
});

test("statusKind covers the done variants", () => {
  for (const s of ["done", "Done", "passed", "shipped", "merged", "✓", "✅", "**done**"]) assert.equal(core.statusKind(s), "done", s);
  assert.equal(core.statusKind("NEXT"), "next");
  assert.equal(core.statusKind("blocked on Bob"), "blocked");
  assert.equal(core.statusKind("failed"), "failed");
  assert.equal(core.statusKind("todo"), "todo");
});

test("isUserRole: user, ceo and you mean waiting on you", () => {
  for (const r of ["user", "User", "CEO", "you", "**user**"]) assert.ok(core.isUserRole(r), r);
  for (const r of ["frontend", "username", "cto"]) assert.ok(!core.isUserRole(r), r);
});

test("itemModel: Round line and NEXT row", () => {
  const it = core.itemModel("001-search", files({ "work/001-search/tasks.md": TASKS, "work/001-search/brief.md": "# Brief: Acme search\n\nStatus: approved\n" }));
  assert.deepEqual(it.round, { n: 3, max: 10 });
  assert.equal(it.title, "Acme search");
  assert.equal(it.state, "working");
  assert.equal(it.chip, "Working · frontend");
  assert.equal(it.nextRole, "frontend");
  assert.deepEqual(it.warn, []);
});

test("itemModel: a user NEXT row waits on you", () => {
  const t = "Round: 1 / 10\n\n| # | Task | Role | Status |\n|---|---|---|---|\n| 1 | user: approve the plan | user | NEXT |\n";
  const it = core.itemModel("002-sync", files({ "work/002-sync/tasks.md": t }));
  assert.equal(it.state, "waiting");
  assert.equal(it.sentence, "Approve the plan");
});

test("itemModel: done, idle, two NEXT rows, round limit", () => {
  const head = "| # | Task | Role | Status |\n|---|---|---|---|\n";
  const m = (t) => core.itemModel("003-x", files({ "work/003-x/tasks.md": t }));
  assert.equal(m(head + "| 1 | a | qa | done |\n").state, "done");
  assert.equal(m(head + "| 1 | a | qa | todo |\n").state, "idle");
  assert.equal(m(head + "| 1 | a | qa | NEXT |\n| 2 | b | qa | NEXT |\n").warn.length, 1);
  assert.match(m("Round: 10 / 10\n\n" + head + "| 1 | a | qa | NEXT |\n").warn[0], /Round limit reached \(10 of 10\)/);
});

test("itemModel: brief status decides before any tasks exist", () => {
  const f = (b) => core.itemModel("004-x", files({ "work/004-x/brief.md": b }));
  assert.equal(f("# Brief: A\n\nStatus: draft\n").state, "waiting");
  assert.equal(f("# Brief: A\n\nStatus: approved by user\n").state, "working");
  assert.equal(core.itemModel("005-x", files({})).state, "new");
});

test("openQuestions", () => {
  const q = core.openQuestions("# Brief\n\n## Open questions\n- Which plan tier?\n- Offline mode?\n\n## Next\nx");
  assert.equal(q.count, 2);
  assert.match(q.md, /Which plan tier/);
  assert.equal(core.openQuestions("## Open questions\n- none\n").count, 0);
  assert.equal(core.openQuestions("## Open questions\n- <question>\n").count, 0);
  assert.equal(core.openQuestions("```\n## Open questions\n- x\n```").count, 0);
  assert.equal(core.openQuestions("## Open questions\n<!-- hint -->\n").md, "");
});

test("reportTask: heading wins, then the file name", () => {
  const ids = new Set(["1", "2", "3b"]);
  assert.equal(core.reportTask("work/x/reports/09-qa.md", "# Report: task 2, qa\n", ids), "2");
  assert.equal(core.reportTask("work/x/reports/03b-designer.md", "no heading", ids), "3b");
  assert.equal(core.reportTask("work/x/reports/07-qa.md", "# Report: task 9\n", ids), null);
});

test("taskKind", () => {
  const k = (status, role = "qa") => core.taskKind({ status, role });
  assert.equal(k("NEXT"), "working");
  assert.equal(k("NEXT", "user"), "waiting");
  assert.equal(k("done"), "done");
  assert.equal(k("blocked"), "blocked");
  assert.equal(k("in progress"), "progress");
  assert.equal(k("todo"), "todo");
});

test("graph links: refsIn, resolveRef, decisions", () => {
  const raw = "See `work/001-search/reports/02-backend.md`, ../decisions/0002-index.md and [plan](plan.md#top). Decision 0002 applies.";
  const refs = core.refsIn(raw);
  assert.ok(refs.includes("work/001-search/reports/02-backend.md"));
  assert.ok(refs.includes("plan.md"));
  const fs = files({ "work/001-search/plan.md": "", "work/001-search/reports/02-backend.md": "", "decisions/0002-index.md": "", "work/001-search/tasks.md": "" });
  const from = "work/001-search/tasks.md";
  assert.equal(core.resolveRef("plan.md", from, fs), "work/001-search/plan.md");
  assert.equal(core.resolveRef("02-backend.md", from, fs), "work/001-search/reports/02-backend.md");
  assert.equal(core.resolveRef("../../decisions/0002-index.md", from, fs), "decisions/0002-index.md");
  assert.equal(core.resolveRef("eleven/decisions/0002-index.md", from, fs), "decisions/0002-index.md");
  assert.equal(core.resolveRef("https://example.com/a.md", from, fs), null);
  assert.equal(core.resolveRef("/etc/a.md", from, fs), null);
  assert.equal(core.resolveRef("missing.md", from, fs), null);
  assert.equal(core.decisionNode("0002", fs), "decisions/0002-index.md");
  assert.equal(core.decisionNode("0009", fs), null);
  assert.equal([...raw.matchAll(core.RE_DEC)][0][1], "0002");
});

test("paths with spaces only count when delimited", () => {
  assert.ok(core.refsIn("open `work/001-search/my notes.md` now").includes("work/001-search/my notes.md"));
  assert.ok(!core.refsIn("open my notes.md now").includes("my notes.md"));
});

test("file helpers", () => {
  assert.equal(core.fileType("project.md"), "project");
  assert.equal(core.fileType("decisions/0002-index.md"), "decision");
  assert.equal(core.fileType("work/001-search/reports/02-backend.md"), "report");
  assert.equal(core.fileType("work/001-search/tasks.md"), "tasks");
  assert.equal(core.fileType("work/001-search/ui.html"), "html");
  assert.equal(core.fileLabel("work/001-search/reports/02-backend.md"), "02 · backend");
  assert.equal(core.itemOf("work/001-search/brief.md"), "001-search");
  assert.equal(core.normPath("a/./b/../c"), "a/c");
  assert.equal(core.normN("# 03"), "3");
});

test("the module has no DOM or browser dependency", async () => {
  assert.equal(typeof document, "undefined");
  assert.ok(Object.keys(core).length > 20);
});
