// Synthetic "Acme Notes" ledgers in a tmp dir. No real data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eleven-sync-")));   // realpath: macOS /var -> /private/var
export const put = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TASKS = `# Tasks: 009 share-a-note

Round: 2 / 10

| # | Task | Role | Done condition | Status |
|---|---|---|---|---|
| 1 | Write the brief | product | approved | done |
| 2 | Build the share link | backend | tests pass | NEXT |
`;
export const TASKS_USER = TASKS.replace("| Build the share link | backend |", "| user: pick the link format | user |");

// project/ is the repo root; project/eleven is the ledger. Returns { project, eleven }.
export function acmeLedger() {
  const project = tmp();
  const eleven = path.join(project, "eleven");
  put(eleven, "project.md", "# Project: Acme Notes\n");
  put(eleven, "work/009-share-a-note/brief.md", "# Brief: Share a note\n\nStatus: approved by user\n");
  put(eleven, "work/009-share-a-note/tasks.md", TASKS);
  put(eleven, "work/009-share-a-note/reports/02-backend.md", "# Report: task 2, backend\n\n## Result\ndone\n");
  put(eleven, "work/010-export/brief.md", "# Brief: Export notes\n\nStatus: draft\n");
  put(eleven, "decisions/0001-storage.md", "# Decision 0001: storage\n");
  return { project, eleven };
}
