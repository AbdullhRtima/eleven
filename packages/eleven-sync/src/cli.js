// eleven-sync CLI. MIT.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { itemModel } from "../../ledger-core/index.js";
import { findEleven } from "./find.js";
import { scan } from "./scan.js";
import { ManifestTracker } from "./manifest.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version;
const HELP = `eleven-sync ${VERSION}: machine-side sync for the eleven ledger

Usage:
  eleven-sync status [dir] [--state-dir <dir>]   show the items and the manifest summary
  eleven-sync pair                               not built yet
  eleven-sync start                              not built yet
  eleven-sync devices                            not built yet
  eleven-sync --help | --version
`;
const LABEL = { waiting: "waiting on you", working: "working", done: "done", idle: "waiting for the CTO", new: "not started" };

export function statusText(elevenDir, { stateDir = null } = {}) {
  const s = scan(elevenDir, { includeText: true });
  const ids = new Set();
  for (const f of s.files) { const m = f.path.match(/^work\/([^/]+)\//); if (m) ids.add(m[1]); }
  const items = [...ids].sort().map((id) => itemModel(id, s.texts));
  const out = [`eleven: ${elevenDir}`, "", `Items (${items.length}):`];
  for (const it of items) {
    const round = it.round ? `  round ${it.round.n}/${it.round.max}` : "";
    out.push(`  ${it.id}  ${it.title}`, `    ${LABEL[it.state] ?? it.state}${it.nextRole ? ` (${it.nextRole})` : ""}${round}`);
    for (const w of it.warn) out.push(`    warning: ${w}`);
  }
  const bytes = s.files.reduce((n, f) => n + f.size, 0);
  const md = s.files.filter((f) => f.kind === "md").length;
  out.push("", "Manifest:", `  files: ${s.files.length} (${md} md, ${s.files.length - md} html), ${bytes} bytes, ${s.dirs.length} dirs`);
  if (s.skipped.length) out.push(`  skipped: ${s.skipped.length} (${[...new Set(s.skipped.map((k) => k.reason))].join(", ")})`);
  if (stateDir) {
    const t = new ManifestTracker({ elevenDir, stateDir });
    out.push(`  hash: ${t.manifest().hash}`);
  } else out.push("  hash: not computed (pass --state-dir to keep a fid table and print it)");
  return out.join("\n") + "\n";
}

export async function main(argv, { out = process.stdout, err = process.stderr, cwd = process.cwd() } = {}) {
  const args = [...argv];
  let stateDir = null;
  const si = args.indexOf("--state-dir");
  if (si >= 0) { stateDir = args[si + 1] ?? null; args.splice(si, 2); if (!stateDir) { err.write("--state-dir needs a folder\n"); return 2; } }
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { out.write(HELP); return 0; }
  if (cmd === "--version" || cmd === "-v") { out.write(VERSION + "\n"); return 0; }
  if (["pair", "start", "devices"].includes(cmd)) { out.write(`eleven-sync ${cmd}: not built yet\n`); return 0; }
  if (cmd === "status") {
    const start = path.resolve(cwd, rest[0] ?? ".");
    const dir = findEleven(start);
    if (!dir) { err.write(`no eleven/ folder found from ${start} upward\n`); return 1; }
    out.write(statusText(dir, { stateDir }));
    return 0;
  }
  err.write(`unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}
