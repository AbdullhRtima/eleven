import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { watch, debounce, isIgnored } from "../src/watch.js";
import { acmeLedger, put, sleep } from "./helpers.mjs";

test("debounce fires once, after the last call, with everything collected", async () => {
  const calls = [];
  const d = debounce((x) => calls.push(x), 60);
  d(["a.md"]); await sleep(30); d(["b.md"]); await sleep(30); d(["a.md"]);
  assert.equal(calls.length, 0);
  await sleep(120);
  assert.deepEqual(calls, [["a.md", "b.md"]]);
  d(["c.md"]); d.cancel(); await sleep(100);
  assert.equal(calls.length, 1);
});

test("isIgnored: dotfiles, editor temp files, other extensions", () => {
  for (const p of [".git/x.md", "work/.hidden.md", "work/a.md~", "work/.a.md.swp", "work/a.md.tmp", "work/4913", "work/.#a.md", "work/img.png", "work/a.md.crdownload", ""]) assert.ok(isIgnored(p), p);
  for (const p of ["project.md", "work/009-share-a-note/tasks.md", "work/009-share-a-note/r.html", "work/009-share-a-note/reports"]) assert.ok(!isIgnored(p), p);
});

for (const poll of [false, true]) {
  test(`watcher (${poll ? "polling" : "native"}) reports a real change once and skips temp files`, async () => {
    const { eleven } = acmeLedger();
    const w = watch(eleven, { debounceMs: 80, poll, pollMs: 40 });
    const got = [];
    w.on("change", (p) => got.push(p));
    await sleep(400);   // FSEvents can replay the fixture setup; let it settle, then start counting
    got.length = 0;
    put(eleven, "work/010-export/.tasks.md.swp", "x");
    put(eleven, "work/010-export/tasks.md.tmp", "x");
    put(eleven, "work/010-export/tasks.md", "# one\n");
    put(eleven, "work/010-export/tasks.md", "# two\n");
    await sleep(700);
    w.close();
    const all = got.flat();
    assert.ok(all.includes("work/010-export/tasks.md"), JSON.stringify(got));
    assert.ok(all.every((p) => !isIgnored(p)), JSON.stringify(got));
    assert.equal(got.length, 1, "burst of writes is one event: " + JSON.stringify(got));
    if (poll) assert.equal(w.mode, "poll");
  });
}
