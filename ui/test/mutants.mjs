// QA's deliberate breakages (report 08-qa.md, N1; m6 from 003 reports/03-qa.md, B1). `node ui/test/run.mjs --mutants` applies each one to a copy of the UI
// and runs the whole suite on it: every mutant must make at least one check FAIL. A suite that still passes is blind.
// Standalone: `node ui/test/mutants.mjs <out-dir> [ui.html]` writes the mutated copies, one file per mutant.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

export const MUTANTS = [
  { id: "m1-waiting-looks-todo", what: "a waiting task is drawn like a to-do task",
    find: `.k-waiting .gdot { color: var(--warn); } .k-waiting > .gbox { fill: var(--warn-soft); stroke: var(--warn); stroke-width: 1.8px; }`,
    replace: `.k-waiting .gdot { color: var(--muted); }` },
  { id: "m2-graph-clicks-dead", what: "clicking a graph node does nothing",
    find: `function activate(target) {`, replace: `function activate(target) { return;` },
  { id: "m3-collapse-dead", what: "the collapse chevron does nothing",
    find: `function toggleItem(id) {`, replace: `function toggleItem(id) { return;` },
  { id: "m4-fit-dead", what: "Fit does nothing",
    find: `$("#gFit").onclick = fitGraph;`, replace: `$("#gFit").onclick = () => {};` },
  { id: "m5-late-exception", what: "every click throws later, from a timer",
    find: `"use strict";\n`, replace: `"use strict";\ndocument.addEventListener("click", () => setTimeout(() => { throw new Error("QA8-LATE-EXCEPTION"); }));\n` },
  { id: "m6-status-glyphs-gone", what: "status glyphs are removed, so status is shown by colour alone again (003 QA B1)",
    find: `const GLYPH = {`, replace: `const GLYPH = {}, GLYPH_GONE = {` },
  { id: "m7-history-keeps-item-open", what: "an item counts as done only when every row is done, so old failed or cancelled rows keep it open (010)",
    find: `["done", "cancelled"].includes(statusKind(rows[rows.length - 1].status))`, replace: `rows.every((r) => statusKind(r.status) === "done")` },
];

// Throws if the code a mutant targets is gone, so a refactor can't silently turn a mutant into a no-op.
export function applyMutant(src, m) {
  const n = src.split(m.find).length - 1;
  if (n !== 1) throw new Error(`mutant ${m.id}: expected its target exactly once in the UI, found ${n}`);
  return src.replace(m.find, () => m.replace);
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const [outDir, uiPath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "index.html")] = process.argv.slice(2);
  if (!outDir) { console.error("usage: node ui/test/mutants.mjs <out-dir> [ui.html]"); process.exit(2); }
  const src = fs.readFileSync(uiPath, "utf8");
  fs.mkdirSync(outDir, { recursive: true });
  for (const m of MUTANTS) { const f = path.join(outDir, m.id + ".html"); fs.writeFileSync(f, applyMutant(src, m)); console.log(f); }
}
