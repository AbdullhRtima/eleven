// The per-project lock of `eleven-sync start` (one daemon per ledger). Kept apart from start.js so a process that only needs the lock
// (the race test, `unpair`) loads almost nothing.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensurePrivateDir, readPrivate, lstatOrNull, O_NOFOLLOW } from "./fsafe.js";

export class StartError extends Error {
  constructor(message, exit = 1) { super(message); this.name = "StartError"; this.exit = exit; }
}

// ---- the lock (one daemon per ledger). A lock whose pid is dead is taken over; a live one refuses.
// L-1: the lock is created with O_EXCL and the pid is written right after, so for a moment the file exists and is EMPTY. An empty or
// unreadable file is never "stale" while it is young (it is a starter in the middle of writing): the caller waits, then refuses.
// An old empty file (a starter that crashed between the two steps) is stale. A stale lock is taken over by a rename: the file is moved
// to a name only we know, checked, and deleted; if it turns out not to be the stale one we judged, it is put back with link().
const LOCK_GRACE_MS = 10_000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** -> { pid } for a readable lock, { pid: 0, young } for an empty or unreadable one. */
function readLock(file) {
  try {
    const lst = lstatOrNull(file);
    if (!lst) return { pid: 0, gone: true };
    if (lst.isSymbolicLink() || !lst.isFile()) return { pid: 0, young: false, text: "<not a regular file>" };   // never followed; replaced by a regular file
    const raw = readPrivate(file);
    if (raw === null) return { pid: 0, gone: true };
    const age = Date.now() - (lstatOrNull(file)?.mtimeMs ?? 0);
    const text = raw.toString("utf8");
    let o = null; try { o = JSON.parse(text); } catch { /* empty or garbage */ }
    if (Number.isSafeInteger(o?.pid) && o.pid > 0) return { pid: o.pid, text };
    return { pid: 0, young: age < LOCK_GRACE_MS, text };
  } catch { return { pid: 0, young: true }; }
}
/** -> a release() function. Throws StartError when a live daemon holds the lock. */
export function acquireLock(file, { pid = process.pid } = {}) {
  ensurePrivateDir(path.dirname(file));
  const guard = `${file}.takeover`;
  const create = () => {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, JSON.stringify({ pid, started: Date.now() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const busy = (n) => new StartError(`another eleven-sync is already running for this project (pid ${n}). Stop it first, or use that one.`);
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let got = false;
  for (let attempt = 0; attempt < 40 && !got; attempt++) {
    try { create(); got = true; break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = readLock(file);
      if (held.gone) continue;                                        // released meanwhile: try to create again
      if (held.pid && alive(held.pid)) throw busy(held.pid);
      if (!held.pid && held.young) {                                 // someone is writing it right now: give them a moment, then refuse
        if (attempt < 20) { sleepMs(10); continue; }
        throw new StartError("another eleven-sync is starting for this project. Try again in a moment.");
      }
      // stale: whoever removes it holds a short-lived guard, so two starters cannot both delete a fresh lock
      let g;
      try { g = fs.openSync(guard, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); }
      catch (e2) {
        if (e2.code !== "EEXIST") throw e2;
        const st = lstatOrNull(guard);
        if (st && Date.now() - st.mtimeMs > LOCK_GRACE_MS) { try { fs.unlinkSync(guard); } catch { /* raced */ } }
        else sleepMs(5);
        continue;
      }
      try {
        const again = readLock(file);
        const stale = again.gone ? false : (again.pid ? !alive(again.pid) : !again.young);
        if (stale && again.text === held.text) {
          const mine = `${file}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
          try { fs.renameSync(file, mine); } catch { /* gone */ }
          const moved = readLock(mine);
          if (moved.text !== held.text) { try { fs.linkSync(mine, file); } catch { /* somebody created a new lock meanwhile */ } }   // not the file we judged: put it back
          try { fs.unlinkSync(mine); } catch { /* gone */ }
        }
      } finally { fs.closeSync(g); try { fs.unlinkSync(guard); } catch { /* gone */ } }
      if (attempt === 39) throw new StartError("could not take over the lock file; remove it by hand if no eleven-sync is running: " + file);
    }
  }
  // every `continue` above (busy guard, vanished lock, young lock) can run the loop out: that is a refusal, never a silent success (L-13)
  if (!got) throw new StartError("could not take the lock (another eleven-sync is starting or a takeover is stuck); try again, or remove the lock file by hand if no eleven-sync is running: " + file);
  let released = false;
  return () => {
    if (released) return; released = true;
    try { if (readLock(file).pid === pid) fs.unlinkSync(file); } catch { /* already gone */ }
  };
}

