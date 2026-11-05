// An item is done when no row is NEXT and its last row is done (or cancelled). Synthetic data.
import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../index.js";

const head = "| # | Task | Role | Status |\n|---|---|---|---|\n";
const model = (rows) => core.itemModel("001-x", new Map([["work/001-x/tasks.md", { text: head + rows.map((r) => `| ${r.join(" | ")} |`).join("\n") + "\n" }]]));

test("statusKind: cancelled is its own closed kind, not todo", () => {
  for (const s of ["cancelled", "Cancelled: replaced by 2a", "canceled", "**cancelled**"]) assert.equal(core.statusKind(s), "cancelled", s);
  assert.equal(core.statusKind("todo"), "todo");
});

test("itemModel: closed with failed and cancelled history is done", () => {
  const it = model([["1", "a", "qa", "done"], ["2", "b", "qa", "failed: 7/8 pass; fix → task 3"], ["3", "c", "dev", "done"],
    ["4", "d", "dev", "cancelled: superseded"], ["5", "e", "user", "done (accepted)"]]);
  assert.equal(it.state, "done");
  assert.equal(it.chip, "Done");
});

test("itemModel: a trailing failed or todo row, with no NEXT, still needs the CTO", () => {
  assert.equal(model([["1", "a", "dev", "done"], ["2", "b", "qa", "failed: 3/8"]]).state, "idle");
  assert.equal(model([["1", "a", "dev", "done"], ["2", "b", "qa", "todo"]]).state, "idle");
  assert.equal(model([["1", "a", "dev", "failed"], ["2", "b", "qa", "done"], ["3", "c", "qa", "failed"]]).chip, "Waiting for the CTO");
});

test("itemModel: a NEXT row wins over a done last row", () => {
  assert.equal(model([["1", "a", "dev", "NEXT"], ["2", "b", "qa", "done"]]).state, "working");
});

test("itemModel: cancelled as the last row is closed", () => {
  assert.equal(model([["1", "a", "dev", "done"], ["2", "b", "qa", "cancelled"]]).state, "done");
});
