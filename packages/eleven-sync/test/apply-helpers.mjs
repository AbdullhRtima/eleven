// Fixtures for apply and fuzz tests: a synthetic "Acme Notes" ledger, a fid table, and action builders. No real data.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tmp, put, TASKS_USER } from "./helpers.mjs";
import { ManifestTracker, H } from "../src/manifest.js";
import { applyAction } from "../src/apply.js";

export const NOW = new Date(2026, 10, 5, 12, 0, 0).getTime();   // local noon: the date is 2026-11-05 in every time zone
export const DATE = "2026-11-05";
export const uuid = () => crypto.randomUUID();

export const BRIEF_TEMPLATE = `# Brief: <title>

Status: draft | approved by user on <date>

## Problem
<Who is hurting, and how? In the user's words where possible.>

## Users
<Who uses this, and in what situation?>

## Goal
<One sentence: what is true when this ships?>

## Acceptance criteria
- [ ] Given <context>, when <action>, then <observable result>

## Open questions
- <Only the user can answer these. The loop pauses until they're answered.>

## Future
<Good ideas parked for later>
`;

export const BRIEF_DRAFT = `# Brief: Export notes

Status: draft

## Problem
Users want to export their notes.

## Open questions
- Which export format first? Markdown or PDF?
- Should exports include attachments?
  Think about the size limit too.

## Future
- Sync to other apps
`;

export const REPORT = `# Report: task 2, backend

## Result
done

## Open questions for the user
- Which link format do we ship?
- Should links expire?

## Proposed next
- QA
`;

export function ledger() {
  const project = tmp();
  const eleven = path.join(project, "eleven");
  put(eleven, "project.md", "# Project: Acme Notes\n");
  put(eleven, "templates/brief.md", BRIEF_TEMPLATE);
  put(eleven, "work/009-share-a-note/brief.md", "# Brief: Share a note\n\nStatus: approved by user on 2026-11-01\n\n## Open questions\n- Which link format?\n");
  put(eleven, "work/009-share-a-note/tasks.md", TASKS_USER);
  put(eleven, "work/009-share-a-note/reports/01-product.md", "# Report: task 1, product\n\n## Result\ndone\n");
  put(eleven, "work/009-share-a-note/reports/02-backend.md", REPORT);
  put(eleven, "work/010-export/brief.md", BRIEF_DRAFT);
  put(eleven, "decisions/0001-storage.md", "# Decision 0001: storage\n");
  const state = tmp();
  const tracker = new ManifestTracker({ elevenDir: eleven, stateDir: state });
  tracker.manifest();
  const L = { project, eleven, state, tracker };
  return L;
}

export const refresh = (L) => { L.tracker.manifest(); };
export const fid = (L, rel) => L.tracker.fidFor(rel);
export const rd = (L, rel) => fs.readFileSync(path.join(L.eleven, rel), "utf8");
export const wr = (L, rel, text) => { fs.writeFileSync(path.join(L.eleven, rel), text); };
export const hashOf = (L, rel) => H(fs.readFileSync(path.join(L.eleven, rel)));
export const qHash = (q) => H(q.normalize("NFC").trim().replace(/\s+/g, " "));

export const device = (over = {}) => ({ id: "dev_phone1", name: "Pixel 8", mode: "write", ...over });

// the whole tree: path -> text
export function snapshot(root) {
  const out = {};
  (function walk(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n), st = fs.lstatSync(p);
      if (st.isDirectory()) { out[path.relative(root, p) + "/"] = ""; walk(p); }
      else if (st.isSymbolicLink()) out[path.relative(root, p)] = "-> " + fs.readlinkSync(p);
      else out[path.relative(root, p)] = fs.readFileSync(p, "utf8");
    }
  })(root);
  return out;
}

export function opts(L, over = {}) {
  return { elevenDir: L.eleven, stateDir: L.state, device: device(), now: () => NOW, recheckMs: 0, sleep: async () => {}, ...over };
}
export const run = (L, action, over) => applyAction(action, opts(L, over));

// action builders
export const base = (kind, over = {}) => ({ t: "action", seq: 1, ts: NOW, actionId: uuid(), createdAt: NOW, kind, item: null, target: null, pre: {}, payload: {}, ...over });

export const answerBrief = (L, over = {}, question = "Which export format first? Markdown or PDF?", answer = "Markdown.") =>
  base("answer", { item: "010-export", target: "brief", pre: { qHash: qHash(question) }, payload: { answer }, ...over });
export const answerReport = (L, over = {}, question = "Which link format do we ship?", answer = "Short links.") =>
  base("answer", { item: "009-share-a-note", target: { report: fid(L, "work/009-share-a-note/reports/02-backend.md") }, pre: { qHash: qHash(question) }, payload: { answer }, ...over });
export const approve = (L, over = {}) =>
  base("approve", { item: "010-export", target: { brief: fid(L, "work/010-export/brief.md") }, pre: { briefHash: hashOf(L, "work/010-export/brief.md") }, ...over });
export const accept = (L, over = {}) => {
  const rows = rd(L, "work/009-share-a-note/tasks.md").split("\n");
  const raw = rows.find((l) => l.startsWith("| 2 |"));
  const rp = "work/009-share-a-note/reports/02-backend.md";
  return base("accept", { item: "009-share-a-note", target: { n: 2 },
    pre: { rowHash: H(raw), tasksHash: hashOf(L, "work/009-share-a-note/tasks.md"), reportFid: fid(L, rp), reportHash: hashOf(L, rp) }, ...over });
};
export const newItem = (title, problem = "Users cannot find things.", over = {}) => base("new_item", { payload: { title, problem }, ...over });
export const cancel = (target, over = {}) => base("cancel", { payload: { actionId: target }, ...over });

// ---- invariants used by the hostile and fuzz tests -------------------------------------------------------------------
import { tokens } from "../src/structure.js";
import { openQuestions } from "../../ledger-core/index.js";
export const linesOf = (t) => t.split(/\r?\n/);

// `after` must equal `before` with the old bullet (old lines [a, b)) replaced by one bullet plus indented plain-text lines. Returns the new span.
export function bulletOnlyChanged(before, after, a, b, dev = "Pixel 8") {
  const o = linesOf(before), n = linesOf(after);
  const tail = o.length - b;
  if (n.slice(0, a).join("\n") !== o.slice(0, a).join("\n")) throw new Error("text before the bullet changed");
  if (n.slice(n.length - tail).join("\n") !== o.slice(b).join("\n")) throw new Error("text after the bullet changed");
  const mid = n.slice(a, n.length - tail);
  if (!mid.length || !mid[0].startsWith("- ~~") || !mid[0].includes(`**Answer (phone "${dev}", ${DATE}):** `)) throw new Error("bad bullet: " + mid[0]);
  for (const l of mid.slice(1)) if (!l.startsWith("  ")) throw new Error("continuation not indented: " + JSON.stringify(l));
  const tn = tokens(n), to = tokens(o);
  const want = [...to.slice(0, a), "bullet", ...mid.slice(1).map(() => "text"), ...to.slice(b)];
  if (want.join() !== tn.join()) throw new Error("structure changed: " + tn.join() + " vs " + want.join());
  if (openQuestions(before).count !== openQuestions(after).count) throw new Error("question count changed");
  return mid;
}
