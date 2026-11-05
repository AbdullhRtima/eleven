import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ManifestTracker, verifyChain, chainHash, makeManifest, makeDelta, jcs, FULL_EVERY } from "../src/manifest.js";
import { scan } from "../src/scan.js";
import { acmeLedger, tmp, put } from "./helpers.mjs";

test("scan: md and html only, no dotfiles, no symlinks, size limit", () => {
  const { eleven } = acmeLedger();
  put(eleven, "work/009-share-a-note/report.html", "<p>x</p>");
  put(eleven, "work/009-share-a-note/image.png", "x");
  put(eleven, "work/009-share-a-note/.secret.md", "x");
  put(eleven, ".hidden/notes.md", "x");
  put(eleven, "agents/backend.md", "kit file, not synced");
  put(eleven, "work/big.md", "a".repeat(1024 * 1024 + 1));
  const outside = tmp(); put(outside, "leak.md", "secret");
  fs.symlinkSync(path.join(outside, "leak.md"), path.join(eleven, "work/link.md"));
  fs.symlinkSync(outside, path.join(eleven, "work/linkdir"));
  const s = scan(eleven);
  const paths = s.files.map((f) => f.path);
  assert.deepEqual(paths, ["decisions/0001-storage.md", "project.md", "work/009-share-a-note/brief.md", "work/009-share-a-note/report.html",
    "work/009-share-a-note/reports/02-backend.md", "work/009-share-a-note/tasks.md", "work/010-export/brief.md"]);
  assert.deepEqual(s.skipped.map((k) => k.reason).sort(), ["symlink", "symlink", "too large"]);
  assert.ok(s.dirs.includes("work/010-export") && !s.dirs.includes("work/linkdir"));
  const brief = s.files.find((f) => f.path === "project.md");
  assert.equal(brief.kind, "md");
  assert.equal(brief.sha256.length, 43);
});

test("fids are 22 chars, stable across restarts, and unknown fids are refused", () => {
  const { eleven } = acmeLedger(), state = tmp();
  const a = new ManifestTracker({ elevenDir: eleven, stateDir: state });
  const m1 = a.manifest();
  assert.ok(m1.files.every((f) => /^[A-Za-z0-9_-]{22}$/.test(f.fid)));
  assert.equal(new Set(m1.files.map((f) => f.fid)).size, m1.files.length);
  const b = new ManifestTracker({ elevenDir: eleven, stateDir: state });   // restart
  const m2 = b.manifest();
  assert.deepEqual(m2.files.map((f) => [f.path, f.fid]), m1.files.map((f) => [f.path, f.fid]));
  assert.equal(b.pathFor(m1.files[0].fid), m1.files[0].path);
  assert.equal(b.pathFor("A".repeat(22)), null);
  const other = new ManifestTracker({ elevenDir: eleven, stateDir: tmp() }).manifest();   // a different vault
  assert.notEqual(other.files[0].fid, m1.files[0].fid);
  assert.equal(fs.statSync(path.join(state, "state.json")).mode & 0o077, 0);
});

test("manifest hash is H(null || JCS(body)) and jcs sorts keys", () => {
  assert.equal(jcs({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  const m = makeManifest([], []);
  assert.equal(m.prevHash, null);
  assert.equal(m.hash, chainHash(null, { files: [], dirs: [], prevHash: null }));
});

test("deltas chain to the previous hash; unchanged ledger sends nothing; mtime-only is ignored", () => {
  const { eleven } = acmeLedger(), state = tmp();
  const t = new ManifestTracker({ elevenDir: eleven, stateDir: state });
  const first = t.next();
  assert.equal(first.type, "manifest");
  assert.equal(t.next(), null);
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(eleven, "project.md"), future, future);
  assert.equal(t.next(), null);

  put(eleven, "work/010-export/tasks.md", "# Tasks\n");
  fs.writeFileSync(path.join(eleven, "project.md"), "# Project: Acme Notes v2\n");
  fs.rmSync(path.join(eleven, "decisions/0001-storage.md"));
  const d1 = t.next();
  assert.equal(d1.type, "delta");
  assert.equal(d1.body.prevHash, first.body.hash);
  assert.deepEqual(d1.body.upsert.map((f) => f.path), ["project.md", "work/010-export/tasks.md"]);
  assert.equal(d1.body.remove.length, 1);

  // restart: the chain continues from the persisted hash
  const t2 = new ManifestTracker({ elevenDir: eleven, stateDir: state });
  put(eleven, "work/010-export/notes.md", "n");
  const d2 = t2.next();
  assert.equal(d2.type, "delta");
  assert.equal(d2.body.prevHash, d1.body.hash);

  const v = verifyChain(first.body, [d1.body, d2.body]);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.hash, d2.body.hash);
  assert.deepEqual([...v.files.values()].map((f) => f.path).sort(), scan(eleven).files.map((f) => f.path).sort());
});

test("a full manifest follows FULL_EVERY deltas and starts a new chain", () => {
  const { eleven } = acmeLedger();
  const t = new ManifestTracker({ elevenDir: eleven });   // in memory: nothing written
  t.next();
  for (let i = 0; i < FULL_EVERY; i++) { put(eleven, "work/010-export/n.md", String(i)); assert.equal(t.next().type, "delta"); }
  const m = t.next();
  assert.equal(m.type, "manifest");
  assert.equal(m.body.prevHash, null);
});

test("verifyChain detects a broken chain", () => {
  const files = [{ fid: "a".repeat(22), path: "project.md", mtime: 1, size: 1, sha256: "x".repeat(43), kind: "md" }];
  const m = makeManifest(files, []);
  const d1 = makeDelta(m.hash, [], []);
  const d2 = makeDelta(d1.hash, [], [files[0].fid]);
  assert.ok(verifyChain(m, [d1, d2]).ok);
  assert.deepEqual(verifyChain(m, [d2]), { ok: false, index: 0, reason: "prevHash does not match the previous hash" });   // gap
  assert.equal(verifyChain(m, [d2, d1]).ok, false);                                                                       // reordered
  const forged = { ...d1, upsert: [{ ...files[0], sha256: "y".repeat(43) }] };                                            // body changed, hash kept
  assert.deepEqual(verifyChain(m, [forged]), { ok: false, index: 0, reason: "delta hash mismatch" });
  const badM = { ...m, dirs: ["work"] };
  assert.equal(verifyChain(badM, [d1]).index, -1);
});
