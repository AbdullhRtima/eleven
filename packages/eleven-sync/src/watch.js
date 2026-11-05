// Watch eleven/ and emit debounced change events. fs.watch, with a polling fallback. MIT.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

const TEMP = /(~|\.swp|\.swx|\.swo|\.tmp|\.temp|\.part|\.crdownload|\.bak)$|^(4913|\.#.*|#.*#)$/i;
// Ignore dotfiles and dot folders, editor and download temp files, and files that are not .md/.html.
// Extensionless names pass (they may be folders) unless they match a temp pattern.
export function isIgnored(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return true;
  if (parts.some((p) => p.startsWith("."))) return true;
  const name = parts[parts.length - 1];
  if (TEMP.test(name)) return true;
  const ext = path.extname(name);
  return ext !== "" && !/^\.(md|html)$/i.test(ext);
}

// Collects calls and fires once, `ms` after the last one, with everything collected.
export function debounce(fn, ms) {
  let timer = null, pending = new Set();
  const d = (items = []) => {
    for (const i of [].concat(items)) pending.add(i);
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; const out = [...pending].sort(); pending = new Set(); fn(out); }, ms);
  };
  d.cancel = () => { clearTimeout(timer); timer = null; pending = new Set(); };
  return d;
}

function snapshot(dir) {
  const m = new Map();
  (function walk(rel) {
    let names; try { names = fs.readdirSync(path.join(dir, rel)); } catch { return; }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (n.startsWith(".")) continue;
      let st; try { st = fs.lstatSync(path.join(dir, r)); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(r);
      else if (!isIgnored(r)) m.set(r, `${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  })("");
  return m;
}

// Emits "change" with a sorted list of changed relative paths, "error" on watcher errors.
// opts: { debounceMs = 200, poll = false (force polling), pollMs = 1000 }
export function watch(dir, { debounceMs = 200, poll = false, pollMs = 1000 } = {}) {
  const ee = new EventEmitter();
  const fire = debounce((paths) => ee.emit("change", paths), debounceMs);
  let watcher = null, timer = null, last = null;
  const startPolling = () => {
    last = snapshot(dir);
    timer = setInterval(() => {
      const now = snapshot(dir), changed = [];
      for (const [p, sig] of now) if (last.get(p) !== sig) changed.push(p);
      for (const p of last.keys()) if (!now.has(p)) changed.push(p);
      last = now;
      if (changed.length) fire(changed);
    }, pollMs);
    timer.unref?.();
    ee.mode = "poll";
  };
  if (!poll) {
    try {
      watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
        if (!name) return fire(["."]);
        const rel = String(name).split(path.sep).join("/");
        if (!isIgnored(rel)) fire([rel]);
      });
      watcher.on("error", (e) => { watcher?.close(); watcher = null; startPolling(); ee.emit("error", e); });
      ee.mode = "native";
    } catch { startPolling(); }
  } else startPolling();
  ee.close = () => { fire.cancel(); watcher?.close(); clearInterval(timer); };
  return ee;
}
