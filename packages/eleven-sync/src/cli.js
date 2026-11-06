// eleven-sync CLI. MIT.
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { itemModel } from "../../ledger-core/index.js";
import { findEleven } from "./find.js";
import { scan } from "./scan.js";
import { ManifestTracker } from "./manifest.js";
import { loadActionState } from "./astate.js";
import { lstatOrNull } from "./fsafe.js";
import { pair, DEFAULT_RELAY } from "./pair.js";
import { startDaemon, StartError } from "./start.js";
import { RelayError } from "./relay-client.js";
import { unpairAll } from "./unpair.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version;
const HELP = `eleven-sync ${VERSION}: machine-side sync for the eleven ledger

Usage:
  eleven-sync status [dir] [--state-dir <dir>]   show the items and the manifest summary
  eleven-sync reset-state [dir]                  move a bad actions-state.json aside and start clean (asks you to type "reset")
                                                 dir = the state folder (default ~/.config/eleven-sync)
  eleven-sync pair [dir] [--read-only] [--relay <url>] [--state-dir <dir>]
                                                 pair a phone: shows a QR code, asks you to confirm [y/N]
  eleven-sync start [dir] [--state-dir <dir>]    run the sync daemon for a paired project (Ctrl-C to stop)
  eleven-sync unpair --all [dir] [--state-dir <dir>]
                                                 delete this project's vault at the relay, then remove the local keys and state
                                                 (asks you to type "unpair"; stop the daemon first)
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
    if (loadActionState(stateDir, Date.now()).unavailable) out.push("  warning: actions-state.json is unreadable, so every phone action is refused (state_unavailable). Run: eleven-sync reset-state " + stateDir);
  } else out.push("  hash: not computed (pass --state-dir to keep a fid table and print it)");
  return out.join("\n") + "\n";
}

const ask = (stdin, out, q) => new Promise((ok) => {
  out.write(q);
  const rl = readline.createInterface({ input: stdin, terminal: false });
  let done = false;
  rl.once("line", (l) => { done = true; rl.close(); ok(l.trim()); });
  rl.once("close", () => { if (!done) ok(""); });
});

// Move `file` to `dest` without ever overwriting what is at `dest` (N6). link + unlink for a regular file (link fails with
// EEXIST when anything, a folder included, is there); copy with COPYFILE_EXCL when the filesystem has no hard links; a symlink is
// re-created as a symlink (never followed). Throws EEXIST when the name is taken.
function moveNoOverwrite(file, dest, st) {
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(file), dest);
  else if (st.isFile()) {
    try { fs.linkSync(file, dest); } catch (e) { if (e.code === "EEXIST" || e.code === "ENOENT") throw e; fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL); }
  } else throw Object.assign(new Error("not a regular file or symlink"), { code: "ENOTFILE" });
  fs.unlinkSync(file);
}

// Move a bad actions-state.json aside (never delete it) so the next action starts with clean memory. -> exit code
export async function resetState(stateDir, { out, err, stdin, now = () => new Date() }) {
  if (!stdin?.isTTY) { err.write("reset-state asks for a typed confirmation and needs a terminal (stdin is not a TTY). Nothing changed.\n"); return 1; }
  const file = path.join(stateDir, "actions-state.json");
  const st = lstatOrNull(file);
  if (!st) { out.write(`nothing to reset: ${file} does not exist (a missing file already means a clean start)\n`); return 0; }
  if (!st.isFile() && !st.isSymbolicLink()) { err.write(`${file} is not a file or a symlink. Move it by hand. Nothing changed.\n`); return 1; }
  const name = (i) => `actions-state.bad-${now().toISOString().replace(/[:.]/g, "-")}${i > 1 ? `-${i}` : ""}.json`;
  out.write(`This will move\n  ${file}  (${st.size} bytes)\nto\n  ${path.join(stateDir, name(1))}  (a number is added if that name is taken)\nand start with clean action memory. The file is not deleted.\n` +
    "Dedupe memory is lost: an action already applied could be applied again if the relay re-delivers it (a new_item with a title that already exists is still refused).\n" +
    "Cancel marks are lost too: an action you cancelled that is still queued at the relay would be applied when it arrives.\n");
  const a = await ask(stdin, out, 'Type "reset" to continue: ');
  if (a !== "reset") { out.write("\nCancelled. Nothing changed.\n"); return 1; }
  // the name is chosen now, after the confirmation, and taken atomically: a file or folder that appeared meanwhile is skipped
  for (let i = 1; i < 1000; i++) {
    const dest = path.join(stateDir, name(i));
    try { moveNoOverwrite(file, dest, st); } catch (e) {
      if (e.code === "EEXIST") continue;
      err.write(`Could not move ${file}: ${e.message}. Nothing changed.\n`); return 1;
    }
    out.write(`\nMoved to ${dest}. The next action starts clean.\n`);
    return 0;
  }
  err.write("Could not find a free backup name. Nothing changed.\n");
  return 1;
}

export async function main(argv, { out = process.stdout, err = process.stderr, cwd = process.cwd(), stdin = process.stdin, quietMs } = {}) {
  const args = [...argv];
  let stateDir = null;
  const si = args.indexOf("--state-dir");
  if (si >= 0) { stateDir = args[si + 1] ?? null; args.splice(si, 2); if (!stateDir) { err.write("--state-dir needs a folder\n"); return 2; } }
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { out.write(HELP); return 0; }
  if (cmd === "--version" || cmd === "-v") { out.write(VERSION + "\n"); return 0; }
  if (cmd === "pair") {
    const ro = rest.indexOf("--read-only"); if (ro >= 0) rest.splice(ro, 1);
    let relay = process.env.ELEVEN_RELAY_URL || DEFAULT_RELAY;
    const ri = rest.indexOf("--relay");
    if (ri >= 0) { relay = rest[ri + 1]; rest.splice(ri, 2); if (!relay) { err.write("--relay needs a URL\n"); return 2; } }
    const bad = rest.find((a) => a.startsWith("-"));
    if (bad || rest.length > 1) { err.write(`pair: unexpected argument ${bad ?? rest[1]}\n`); return 2; }
    const ac = new AbortController();
    const onInt = () => ac.abort();
    process.once("SIGINT", onInt);
    try { return await pair({ dir: rest[0] ?? ".", readOnly: ro >= 0, stateDir: stateDir ? path.resolve(cwd, stateDir) : undefined, relay, stdin, out, err, cwd, signal: ac.signal }); }
    finally { process.off("SIGINT", onInt); }
  }
  if (cmd === "start") {
    const bad = rest.find((a) => a.startsWith("-"));
    if (bad || rest.length > 1) { err.write(`start: unexpected argument ${bad ?? rest[1]}\n`); return 2; }
    // the handlers go in first, so a signal during start-up still ends in a clean stop
    let signalled = false, wake;
    const sig = new Promise((r) => { wake = r; });
    const onSig = () => { signalled = true; wake(); };
    process.once("SIGINT", onSig); process.once("SIGTERM", onSig);
    try {
      let h;
      try { h = await startDaemon({ dir: rest[0] ?? ".", stateDir: stateDir ?? undefined, cwd, err }); }
      catch (e) {
        if (e instanceof StartError) { err.write(e.message + "\n"); return e.exit; }
        // One clear line instead of a stack trace when the relay refuses us (e.g. the machine was unpaired or revoked).
        if (e instanceof RelayError) { err.write(`eleven-sync: the relay refused this machine (${String(e.code).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}). If it was unpaired or revoked, run "eleven-sync pair" again.\n`); return 1; }
        throw e;
      }
      const r = await Promise.race([h.done, sig]);
      await h.stop();
      return signalled || !r?.fatal ? 0 : 1;
    } finally { process.off("SIGINT", onSig); process.off("SIGTERM", onSig); }
  }
  if (cmd === "unpair") {
    const all = rest.indexOf("--all"); if (all >= 0) rest.splice(all, 1);
    const bad = rest.find((a) => a.startsWith("-"));
    if (all < 0 || bad || rest.length > 1) { err.write(all < 0 ? "unpair: only --all is built (it deletes the whole vault). Usage: eleven-sync unpair --all [dir]\n" : `unpair: unexpected argument ${bad ?? rest[1]}\n`); return 2; }
    return unpairAll({ dir: rest[0] ?? ".", stateDir: stateDir ? path.resolve(cwd, stateDir) : undefined, cwd, stdin, out, err, ...(quietMs !== undefined ? { quietMs } : {}) });
  }
  if (["devices"].includes(cmd)) { out.write(`eleven-sync ${cmd}: not built yet\n`); return 0; }
  if (cmd === "reset-state") {
    const dir = path.resolve(cwd, stateDir ?? rest[0] ?? path.join(os.homedir(), ".config", "eleven-sync"));
    return resetState(dir, { out, err, stdin });
  }
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
