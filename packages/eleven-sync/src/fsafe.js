// Private-file helpers for the state dir (security L4): 0700 dir, 0600 files, no symlinks, atomic replace. MIT.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
export const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;   // opening a FIFO or socket must never wait for a peer (N8)

export function lstatOrNull(p) { try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; } }

// Create the folder as 0700 and chmod one that already exists.
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

// Throws when `file` is a symlink (or anything but a regular file). A missing file is fine.
export function refuseSymlink(file) {
  const st = lstatOrNull(file);
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error(`refusing to use a symlink or non-file: ${file}`);
}

// Read a private file without following a symlink. -> Buffer, or null when it does not exist.
// N8: lstat first; only a regular file is opened. A FIFO, socket or device throws instead of hanging in open(). The open also
// uses O_NONBLOCK, so a file swapped for a FIFO after the lstat still cannot block, and the fstat check catches it.
export function readPrivate(file) {
  const l = lstatOrNull(file);
  if (!l) return null;
  if (!l.isFile()) throw new Error(`not a regular file: ${file}`);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`not a regular file: ${file}`);
    try { fs.fchmodSync(fd, 0o600); } catch { /* best effort */ }
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function fsyncDir(dir) { try { const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* not supported everywhere */ } }

// temp file (random name, wx, 0600) + fsync + rename + fsync of the folder. Refuses a symlink at `file`.
export function writePrivateAtomic(file, data) {
  ensurePrivateDir(path.dirname(file));
  refuseSymlink(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, data); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  fsyncDir(path.dirname(file));
}
