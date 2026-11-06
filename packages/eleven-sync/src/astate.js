// Action memory kept in the state dir: applied actionIds (10 days), cancel marks, rate counters, and the action log. MIT.
// The caller passes stateDir. Nothing here reads or writes ~/.config.
// seen and cancelled are keyed by (deviceId, actionId): one device can never touch another device's marks (L3).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensurePrivateDir, readPrivate, writePrivateAtomic, lstatOrNull, O_NOFOLLOW, O_NONBLOCK } from "./fsafe.js";
import { stripHidden } from "./text.js";

export const DAY = 86400000;
export const SEEN_MS = 10 * DAY;         // 8.5 step 2
export const EXPIRE_MS = 7 * DAY;        // 8.5 step 3
export const FUTURE_MS = 5 * 60 * 1000;  // 8.5 step 3
export const RATE = { actionsPerHour: 20, newItemsPerDay: 3, earlyPerHour: 100 };   // 8.5 step 5; early = refusals before step 5 and cancels
export const MAX_ENTRIES = 10000;        // seen and cancelled are each capped; the oldest go first
export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_FILES = 3;              // actions.log, actions.log.1, actions.log.2

export const markKey = (deviceId, actionId) => `${deviceId}|${actionId}`;

// N7: every map is keyed by something the phone influences, so none of them has a prototype ("__proto__" is then just a key).
const dict = (o = {}) => Object.assign(Object.create(null), o);
const empty = () => ({ v: 1, seen: dict(), cancelled: dict(), rate: dict() });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function valid(s) {
  if (!isObj(s) || s.v !== 1 || !isObj(s.seen) || !isObj(s.cancelled) || !isObj(s.rate)) return false;
  for (const m of [s.seen, s.cancelled]) for (const e of Object.values(m)) if (!isObj(e) || !Number.isFinite(e.at)) return false;
  for (const r of Object.values(s.rate)) if (!isObj(r)) return false;
  return true;
}

function prune(map, now) {
  for (const [k, e] of Object.entries(map)) if (now - e.at > SEEN_MS) delete map[k];
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => map[a].at - map[b].at);
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
  }
}

// -> { file, s } or { file, s: null, unavailable: true }.
// A missing file is a fresh start. An unreadable, corrupt or symlinked file is NOT: the caller refuses every action
// (state_unavailable) and the bad file stays where it is; a copy is kept beside it for the user.
export function loadActionState(stateDir, now) {
  const file = path.join(stateDir, "actions-state.json");
  let s = null, raw;
  try {
    raw = readPrivate(file);
    if (raw === null) s = empty();
    else { s = JSON.parse(raw.toString("utf8")); if (!valid(s)) s = null; }
  } catch { s = null; }
  if (!s) {
    try {
      if (raw) {
        const keep = path.join(stateDir, `actions-state.corrupt-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12)}.json`);
        if (!lstatOrNull(keep)) fs.copyFileSync(file, keep, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(keep, 0o600);
      }
    } catch { /* the original is still there */ }
    return { file, s: null, unavailable: true };
  }
  s.seen = dict(s.seen); s.cancelled = dict(s.cancelled); s.rate = dict(s.rate);
  prune(s.seen, now); prune(s.cancelled, now);
  for (const [d, r] of Object.entries(s.rate)) {
    const a = Array.isArray(r.a) ? r.a : [], n = Array.isArray(r.n) ? r.n : [], e = Array.isArray(r.e) ? r.e : [];
    r.a = a.filter((t) => now - t < 3600000); r.n = n.filter((t) => now - t < DAY); r.e = e.filter((t) => now - t < 3600000);
    if (!r.a.length && !r.n.length && !r.e.length) delete s.rate[d];
  }
  return { file, s };
}

export function saveActionState(file, s) {
  writePrivateAtomic(file, JSON.stringify(s));
}

// Nothing that could move a terminal cursor or hide text: every control character (C0, DEL, C1, ESC), line separators,
// bidi controls and invisible characters become a space; each field is cut at 64 characters.
const clean = (x) => [...stripHidden(String(x ?? ""), { keepEmoji: false }).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")].slice(0, 64).join("");

function rotate(file) {
  for (let i = LOG_FILES - 1; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    try { fs.renameSync(from, `${file}.${i}`); } catch { /* nothing to rotate yet */ }
  }
}

// 8.5 step 12: time, device name, kind, item, actionId, H(action), result. No answer text.
export function appendLog(stateDir, { now, device, kind, item, actionId, hash, result }) {
  ensurePrivateDir(stateDir);
  const file = path.join(stateDir, "actions.log");
  const line = [new Date(now).toISOString(), device, kind, item ?? "-", actionId, hash, result].map(clean).join("\t") + "\n";
  // E5: a FIFO, socket or device at actions.log must never make us wait. lstat first; the open is O_NONBLOCK and fstat-checked
  // too, in case the file is swapped after the lstat. Anything but a regular file: skip the log line with a warning.
  const skip = (why) => process.stderr.write(`eleven-sync: not writing actions.log (${why}); the action is not affected\n`);
  const st = lstatOrNull(file);
  if (st && !st.isFile()) return skip("not a regular file");
  if (st && st.size + line.length > LOG_MAX_BYTES) rotate(file);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600); }
  catch (e) { return skip(e.code ?? "open failed"); }
  try {
    if (!fs.fstatSync(fd).isFile()) return skip("not a regular file");
    fs.fchmodSync(fd, 0o600); fs.writeSync(fd, line);
  } finally { fs.closeSync(fd); }
}

export function readLog(stateDir, last = 20) {
  try { return fs.readFileSync(path.join(stateDir, "actions.log"), "utf8").split("\n").filter(Boolean).slice(-last); } catch { return []; }
}
