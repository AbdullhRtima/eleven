import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findEleven } from "../src/find.js";
import { acmeLedger, tmp, put } from "./helpers.mjs";

test("finds eleven/ from the project root, a deep folder, and inside eleven/", () => {
  const { project, eleven } = acmeLedger();
  const real = fs.realpathSync(eleven);
  assert.equal(fs.realpathSync(findEleven(project)), real);
  assert.equal(fs.realpathSync(findEleven(path.join(eleven, "work/009-share-a-note/reports"))), real);
  assert.equal(fs.realpathSync(findEleven(eleven)), real);
});

test("returns null when there is none, and ignores a bare folder named eleven", () => {
  const empty = tmp();
  fs.mkdirSync(path.join(empty, "eleven"));
  assert.equal(findEleven(empty), null);
  put(empty, "eleven/project.md", "x");
  assert.ok(findEleven(empty));
});
