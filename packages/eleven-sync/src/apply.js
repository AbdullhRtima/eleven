// Apply a phone action to the ledger (protocol section 8.5, steps 2 to 12). MIT.
//
// The caller has already decrypted the envelope and verified the signature and the device (steps 1 and 4).
// applyAction(action, opts) -> { status, reason?, actionId, kind, item?, fid?, appliedAt?, replayed? }
//   status: written | stale | conflict | refused (reason) | expired | cancelled
// opts: { elevenDir, stateDir, device: { id, name, mode? }, now?, recheckMs?, sleep?, hooks?, fids? }
// Nothing here reads a path from the phone: files are named by fid (looked up in our own table) or by fixed names in the item.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseTasks, itemModel, openQuestions, cells, strip, statusKind, isUserRole } from "../../ledger-core/index.js";
import { H, jcs } from "./manifest.js";
import { cleanText, prepBlock, prepTitle, escapeTitle, slugify, deviceLabel, localDate } from "./text.js";
import { tokens, checkSplice } from "./structure.js";
import { readPrivate } from "./fsafe.js";
import { loadActionState, saveActionState, appendLog, markKey, EXPIRE_MS, FUTURE_MS, RATE, DAY } from "./astate.js";

export const KINDS = ["answer", "approve", "accept", "new_item", "cancel"];
export const REASONS = ["bad_request", "unknown_item", "unknown_fid", "bad_target", "too_long", "bad_path", "structure_changed", "rate_limited",
  "read_only", "clock", "no_template", "already_applied", "state_unavailable"];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FID = /^[A-Za-z0-9_-]{22}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const ITEM = /^\d{3}-[a-z0-9-]{1,40}$/;
const MAX_BYTES = 1024 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;   // a FIFO or socket in the ledger must not hang open() (N8)
class Refuse extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const refuse = (r) => { throw new Refuse(r); };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- paths -----------------------------------------------------------------------------------------------------------
function safeRel(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || rel.includes("\\")) refuse("bad_path");
  for (const p of rel.split("/")) if (!p || p === "." || p === "..") refuse("bad_path");
  return rel;
}
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; } }
// W1: on Windows (seen with Node 22.14, build 26300) stat and lstat report dev 0 while fstat reports the volume serial number.
// A dev of 0 is "unknown", not a different volume; the file id must still match.
const sameFile = (a, b) => a.ino === b.ino && (a.dev === b.dev || a.dev === 0 || b.dev === 0);

// Step 7: lstat every component below eleven/, no symlinks, realpath inside eleven/work. null when it does not exist.
function resolveInside(base, rel, want) {
  safeRel(rel);
  if (!rel.startsWith("work/")) refuse("bad_path");
  const parts = rel.split("/");
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const st = lstatOrNull(cur);
    if (!st) return null;
    if (st.isSymbolicLink()) refuse("bad_path");
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) refuse("bad_path");
    if (last && !(want === "dir" ? st.isDirectory() : st.isFile())) refuse("bad_path");
  }
  let real;
  try { real = fs.realpathSync(cur); } catch { return null; }
  if (real !== cur || !(real + path.sep).startsWith(base + path.sep + "work" + path.sep)) refuse("bad_path");
  return cur;
}

function readFileChecked(abs) {
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch (e) { if (e.code === "ENOENT") return null; refuse("bad_path"); }
  try {
    const st = fs.fstatSync(fd);
    const l = lstatOrNull(abs);
    if (!st.isFile() || !l || l.isSymbolicLink() || !sameFile(l, st)) refuse("bad_path");
    if (st.size > MAX_BYTES) refuse("bad_target");
    const bytes = fs.readFileSync(fd);
    return { bytes, st };
  } finally { fs.closeSync(fd); }
}
function decode(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return refuse("bad_target"); }
}

const splitParts = (text) => text.split(/(?<=\n)/);
const lineOf = (p) => p.replace(/\r?\n$/, "");
const eolOf = (p) => (p === undefined ? "" : /\r\n$/.test(p) ? "\r\n" : /\n$/.test(p) ? "\n" : "");
function spliceParts(parts, a, b, newLines) {
  const eol = eolOf(parts[a]) || parts.map(eolOf).find(Boolean) || "\n";
  const noEol = b === parts.length && eolOf(parts[b - 1]) === "";
  const mid = newLines.map((l, i) => l + (noEol && i === newLines.length - 1 ? "" : eol));
  return [...parts.slice(0, a), ...mid, ...parts.slice(b)];
}
const hasBlock = (lines, block) => {
  outer: for (let i = 0; i + block.length <= lines.length; i++) {
    for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) continue outer;
    return true;
  }
  return false;
};

// ---- reading what the user saw ----------------------------------------------------------------------------------------
const normQ = (s) => s.normalize("NFC").trim().replace(/\s+/g, " ");

// The unstruck bullet under the Open questions heading whose qHash matches (2, 8.3). -> { start, end, question } | null
function findQuestion(lines, headRe, qHash) {
  let fence = false, i = 0;
  for (; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    if (!fence && headRe.test(lines[i])) break;
  }
  if (i >= lines.length) return null;
  let comment = false;
  fence = false;
  const end = (() => { for (let k = i + 1; k < lines.length; k++) { if (/^\s*(```|~~~)/.test(lines[k])) fence = !fence; if (!fence && /^#{1,2}\s/.test(lines[k])) return k; } return lines.length; })();
  fence = false;
  const bad = new Set();   // lines in or touching an HTML comment or a fence: never a question
  for (let k = i + 1; k < end; k++) {
    const l = lines[k];
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; bad.add(k); continue; }
    if (fence) { bad.add(k); continue; }
    if (comment || /<!--|-->/.test(l)) bad.add(k);
    if (/<!--/.test(l) && !/-->/.test(l.slice(l.indexOf("<!--")))) comment = true;
    else if (/-->/.test(l)) comment = false;
  }
  for (let k = i + 1; k < end; k++) {
    const m = lines[k].match(/^[-*+]\s+(.*)$/);
    if (!m || bad.has(k)) continue;
    let j = k + 1;
    const parts = [m[1].trim()];
    while (j < end && !bad.has(j) && ["text", "indent"].includes(tokens([lines[j]])[0]) && !/^[-*+]\s|^\d+[.)]\s/.test(lines[j])) { parts.push(lines[j].trim()); j++; }
    const q = parts.join(" ");
    if (/^~~/.test(q) || /^<[^>]*>$/.test(q) || !q) continue;
    if (H(normQ(q)) === qHash) return { start: k, end: j, question: q };
  }
  return null;
}

function newestReport(base, item) {
  const dirRel = `work/${item}/reports`;
  const dir = resolveInside(base, dirRel, "dir");
  if (!dir) return null;
  const best = [];
  for (const n of fs.readdirSync(dir)) {
    const m = n.match(/^(\d+)([a-z]?)-.*\.(md|html)$/);
    if (!m) continue;
    const st = lstatOrNull(path.join(dir, n));
    if (!st || st.isSymbolicLink() || !st.isFile()) continue;
    best.push({ n, num: +m[1], letter: m[2] });
  }
  best.sort((a, b) => a.num - b.num || (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0) || (a.n < b.n ? -1 : 1));
  const top = best.at(-1);
  return top ? `${dirRel}/${top.n}` : null;
}

// ---- the edits ---------------------------------------------------------------------------------------------------------
// A plan is { result } (stale) or { abs, rel, st, oldBytes, newText, block, noReapply? }.
function stale() { return { result: { status: "stale" } }; }

function load(c, rel) {
  const abs = resolveInside(c.base, rel, "file");
  if (!abs) return null;
  const f = readFileChecked(abs);
  if (!f) return null;
  const text = decode(f.bytes);
  const parts = splitParts(text);
  return { abs, rel, st: f.st, bytes: f.bytes, text, parts, lines: parts.map(lineOf) };
}

function finishPlan(f, a, b, newLines, want, extra) {
  const parts = spliceParts(f.parts, a, b, newLines);
  const newText = parts.join("");
  const nl = splitParts(newText).map(lineOf);
  const why = checkSplice(f.lines, nl, a, b, want);
  if (why) refuse("structure_changed");
  const check = extra?.(f.text, newText);
  if (check) refuse("structure_changed");
  return { abs: f.abs, rel: f.rel, st: f.st, oldBytes: f.bytes, newText, block: newLines };
}

const stableModel = (m, drop) => JSON.stringify({ ...m, ...Object.fromEntries(drop.map((k) => [k, undefined])) });

function planAnswer(c, s) {
  const f = load(c, s.rel);
  if (!f) return stale();
  const q = findQuestion(f.lines, s.headRe, s.qHash);
  if (!q) return stale();
  const first = `- ~~${q.question}~~ **Answer (phone "${c.dev}", ${c.date}):** ${s.lines[0]}`;
  const out = [first, ...s.lines.slice(1).map((l) => "  " + l)];
  return finishPlan(f, q.start, q.end, out, ["bullet", ...s.lines.slice(1).map(() => "text")], (o, n) => {
    if (openQuestions(o).count !== openQuestions(n).count) return "question count";
    if (s.rel.endsWith("/brief.md")) {
      const id = s.item, mo = itemModel(id, new Map([[`work/${id}/brief.md`, { text: o }]])), mn = itemModel(id, new Map([[`work/${id}/brief.md`, { text: n }]]));
      if (stableModel(mo, ["questionsMd"]) !== stableModel(mn, ["questionsMd"])) return "model";
    }
    return null;
  });
}

function planApprove(c, s) {
  const f = load(c, s.rel);
  if (!f) return stale();
  if (H(f.bytes) !== s.briefHash) return stale();
  const i = f.lines.findIndex((l) => /^Status:\s*(.+)$/.test(l));     // the same line itemModel reads
  if (i < 0 || !/^Status:\s*draft\b/i.test(f.lines[i])) return stale();
  const line = `Status: approved by user on ${c.date} (from phone "${c.dev}")`;
  return finishPlan(f, i, i + 1, [line], ["status"], (o, n) => {
    const id = s.item, mo = itemModel(id, new Map([[`work/${id}/brief.md`, { text: o }]])), mn = itemModel(id, new Map([[`work/${id}/brief.md`, { text: n }]]));
    const keep = ["state", "chip", "sentence", "gate", "md"];
    if (stableModel(mo, keep) !== stableModel(mn, keep)) return "model";
    return /^approved\b/i.test(strip(n.split(/\r?\n/)[i].replace(/^Status:\s*/, ""))) ? null : "status";
  });
}

function findTable(lines) {   // the same table parseTasks reads
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const head = cells(lines[i]).map((h) => strip(h).toLowerCase());
    if (!head.includes("task") || !head.includes("status") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    return { head, first: i + 2 };
  }
  return null;
}

function planAccept(c, s) {
  const f = load(c, s.tasksRel);
  if (!f) return stale();
  if (H(f.bytes) !== s.tasksHash) return stale();
  const rows = parseTasks(f.text);
  const tb = findTable(f.lines);
  if (!rows || !tb) return stale();
  const idx = [];
  for (let k = 0; k < rows.length; k++) if (strip(rows[k].n) === String(s.n)) idx.push(k);
  if (idx.length !== 1) return stale();
  const row = rows[idx[0]];
  if (!isUserRole(row.role) || statusKind(row.status) !== "next" || H(row.raw) !== s.rowHash) return stale();
  // newest report: what the phone showed must still be the newest, byte for byte
  const newest = newestReport(c.base, s.item);
  if (newest === null) { if (s.reportFid !== null || s.reportHash !== null) return stale(); }
  else {
    if (s.reportFid === null || s.reportHash === null) return stale();
    if (c.pathFor(s.reportFid) !== newest) return stale();
    const r = load(c, newest);
    if (!r || H(r.bytes) !== s.reportHash) return stale();
  }
  // the line of that row, found by position
  let at = -1, count = -1;
  for (let k = tb.first; k < f.lines.length && f.lines[k].trim().startsWith("|"); k++) {
    const cc = cells(f.lines[k]);
    const get = (n) => { const ci = tb.head.indexOf(n); return ci >= 0 ? cc[ci] ?? "" : ""; };
    if (!strip(get("task"))) continue;
    if (++count === idx[0]) at = k;
  }
  if (at < 0 || f.lines[at] !== row.raw) return stale();
  const col = tb.head.indexOf("status");
  const pieces = row.raw.split(/(?<!\\)\|/);
  const pi = row.raw.trim().startsWith("|") ? col + 1 : col;
  if (pi >= pieces.length) return stale();
  const cell = `done (accepted on phone "${c.dev}", ${c.date})`;
  pieces[pi] = ` ${cell} `;
  const newRaw = pieces.join("|");
  const want = (() => { const cc = cells(newRaw); return cc[col] === cell; })();
  if (!want) refuse("structure_changed");
  return finishPlan(f, at, at + 1, [newRaw], ["table"], (o, n) => {
    const ro = parseTasks(o), rn = parseTasks(n);
    if (!rn || ro.length !== rn.length) return "rows";
    for (let k = 0; k < ro.length; k++) {
      if (k === idx[0]) { if (rn[k].n !== ro[k].n || rn[k].task !== ro[k].task || rn[k].role !== ro[k].role || rn[k].status !== cell || statusKind(rn[k].status) !== "done") return "row"; }
      else if (JSON.stringify(ro[k]) !== JSON.stringify(rn[k])) return "other row";
    }
    return null;
  });
}

// ---- writing -----------------------------------------------------------------------------------------------------------
function writeTemp(abs, data, mode) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", mode);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return tmp;
}
function fsyncDir(dir) { try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* not supported everywhere */ } }

// Step 10. Returns "ok", or "moved" when the file changed since we read it.
function commit(c, p) {
  const tmp = writeTemp(p.abs, p.newText, p.st.mode & 0o777);
  try {
    c.hooks.afterTemp?.(p.abs);
    const now = lstatOrNull(p.abs);
    if (!now || now.isSymbolicLink() || now.mtimeMs !== p.st.mtimeMs || now.size !== p.st.size || now.ino !== p.st.ino) { fs.unlinkSync(tmp); return "moved"; }
    const cur = fs.readFileSync(p.abs);
    if (!cur.equals(p.oldBytes)) { fs.unlinkSync(tmp); return "moved"; }
    fs.renameSync(tmp, p.abs);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  fsyncDir(path.dirname(p.abs));
  const real = fs.realpathSync(p.abs);
  if (real !== p.abs || !(real + path.sep).startsWith(c.base + path.sep + "work" + path.sep)) refuse("bad_path");
  return "ok";
}

// Steps 8 to 10 with the restart rule (at most 3 tries). -> plan (written) or { result }
function applyOnce(c, planFn) {
  for (let t = 0; t < 3; t++) {
    const p = planFn();
    if (p.result) return p;
    if (commit(c, p) === "ok") return p;
    c.hooks.moved?.(t);
  }
  return { result: { status: "conflict", reason: "file_busy" } };
}

// Steps 8 to 11 for answer, approve and accept.
async function runEdit(c, planFn) {
  let p = applyOnce(c, planFn);
  if (p.result) return p.result;
  let again = false;
  for (;;) {
    await c.sleep(c.recheckMs);
    const f = load(c, p.rel);
    if (f && hasBlock(f.lines, p.block)) return { status: "written", appliedAt: c.now(), file: p.rel, ...(again ? { reapplied: true } : {}) };
    if (again) return { status: "conflict", reason: "overwritten_twice" };
    const q = applyOnce(c, planFn);        // the precondition must still hold, else conflict
    if (q.result) return { status: "conflict", reason: q.result.status === "stale" ? "overwritten" : q.result.reason ?? "overwritten" };
    again = true; p = q;
  }
}

// ---- new_item ----------------------------------------------------------------------------------------------------------
function readTemplate(base) {
  let cur = base;
  for (const n of ["templates", "brief.md"]) {
    cur = path.join(cur, n);
    const st = lstatOrNull(cur);
    if (!st || st.isSymbolicLink()) refuse("no_template");
  }
  const f = readFileChecked(cur);
  if (!f) refuse("no_template");
  return decode(f.bytes);
}

async function runNewItem(c, s) {
  const wst = lstatOrNull(path.join(c.base, "work"));
  if (!wst || wst.isSymbolicLink() || !wst.isDirectory()) refuse("bad_path");
  const workDir = path.join(c.base, "work");
  const tpl = readTemplate(c.base);
  const tparts = splitParts(tpl), tl = tparts.map(lineOf);
  const iT = tl.findIndex((l) => /^# Brief:/.test(l)), iS = tl.findIndex((l) => /^Status:/.test(l)), iP = tl.findIndex((l) => /^##\s+Problem\s*$/.test(l));
  if (iT < 0 || iS < 0 || iP < 0 || !(iT < iS && iS < iP)) refuse("no_template");
  let nextH = tl.findIndex((l, i) => i > iP && /^#{1,6}\s/.test(l));
  if (nextH < 0) nextH = tl.length;
  let endBody = nextH;
  while (endBody > iP + 1 && tl[endBody - 1].trim() === "") endBody--;
  const marker = `_(from phone "${c.dev}", ${c.date})_`;
  const prob = s.problem.length ? [...s.problem, "", marker] : [marker];
  const eol = tparts.map(eolOf).find(Boolean) || "\n";
  const newLines = [...tl.slice(0, iT), `# Brief: ${escapeTitle(s.title)}`, ...tl.slice(iT + 1, iS), "Status: draft", ...tl.slice(iS + 1, iP + 1), ...prob, ...tl.slice(endBody)];
  const newText = newLines.join(eol) + (eolOf(tparts.at(-1)) ? eol : "");
  // structure: tokens equal the template's, with the three edited places replaced by what we meant
  const tt = tokens(tl);
  const want = [...tt.slice(0, iT), "heading", ...tt.slice(iT + 1, iS), "status", ...tt.slice(iS + 1, iP + 1),
    ...s.problem.map((l) => (l ? "text" : "blank")), ...(s.problem.length ? ["blank"] : []), "text", ...tt.slice(endBody)];
  const got = tokens(splitParts(newText).map(lineOf));
  if (want.length !== got.length || want.some((t, i) => t !== got[i])) refuse("structure_changed");
  if (!/<!--/.test(tpl) && /<!--/.test(newText)) refuse("structure_changed");
  const mt = itemModel("000-t", new Map([["work/000-t/brief.md", { text: tpl }]])), mn = itemModel("000-t", new Map([["work/000-t/brief.md", { text: newText }]]));
  if (mn.title !== escapeTitle(s.title) || mn.state !== "waiting" || !mn.gate || mn.questionsCount !== mt.questionsCount || mn.round !== null) refuse("structure_changed");

  // 8.3 precondition: no folder with the same slug yet (a duplicate or re-delivered new_item is stale, not a second item)
  const slug = slugify(s.title);
  for (const n of fs.readdirSync(workDir)) { const m = n.match(/^\d{3,}-(.*)$/); if (m && m[1] === slug) return { status: "stale" }; }
  // number: highest existing + 1, taken now. mkdir claims it; a clash takes the next number.
  let dirName = null, dirAbs = null;
  for (let tries = 0; tries < 5 && !dirName; tries++) {
    let top = 0;
    for (const n of fs.readdirSync(workDir)) { const m = n.match(/^(\d{3,})-/); if (m) top = Math.max(top, +m[1]); }
    if (top + 1 > 999) refuse("bad_request");
    const name = `${String(top + 1).padStart(3, "0")}-${slug}`;
    if (!ITEM.test(name)) refuse("bad_request");
    try { fs.mkdirSync(path.join(workDir, name)); dirName = name; dirAbs = path.join(workDir, name); } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  if (!dirName) return { status: "conflict", reason: "number_taken" };
  const abs = path.join(dirAbs, "brief.md");
  try {
    const real = fs.realpathSync(dirAbs);
    if (real !== dirAbs) refuse("bad_path");
    const tmp = writeTemp(abs, newText, 0o644);
    fs.renameSync(tmp, abs);
    fsyncDir(dirAbs);
  } catch (e) { try { fs.rmSync(dirAbs, { recursive: true, force: true }); } catch { /* best effort */ } throw e; }
  const rel = `work/${dirName}/brief.md`;
  await c.sleep(c.recheckMs);
  const f = load(c, rel);
  if (!f || !hasBlock(f.lines, [`# Brief: ${escapeTitle(s.title)}`])) return { status: "conflict", reason: "overwritten" };
  return { status: "written", appliedAt: c.now(), item: dirName, file: rel };
}

// ---- the entry point ---------------------------------------------------------------------------------------------------
const chains = new Map();
function serial(key, fn) {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, run.catch(() => {}));
  return run;
}

// The action_result status the phone sees (8.6): written -> ok, refused -> rejected.
export const toWire = (r) => (r.status === "written" ? { status: "ok" } : r.status === "refused" ? { status: "rejected", reason: r.reason } : { status: r.status, ...(r.reason ? { reason: r.reason } : {}) });

// N7: a device id is a short token. Anything else is refused before the state is even opened. "__proto__", "constructor" and
// "prototype" fit the pattern, so every per-device map is also a null-prototype object (astate.js).
export const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function applyAction(action, opts) {
  if (!opts?.elevenDir || !opts?.stateDir || !isObj(opts.device) || typeof opts.device.id !== "string") throw new TypeError("applyAction needs elevenDir, stateDir and device { id, name }");
  if (!DEVICE_ID.test(opts.device.id)) return Promise.resolve({ status: "refused", reason: "bad_device", actionId: null });
  return serial(path.resolve(opts.stateDir), () => run(action, opts));
}

// 8.7: all cancels first, then the rest ordered by (device, inner seq). items: [{ action, device }]
export async function applyBatch(items, opts) {
  const kind = (i) => (isObj(i.action) && i.action.kind === "cancel" ? 0 : 1);
  const seq = (i) => (isObj(i.action) && Number.isSafeInteger(i.action.seq) ? i.action.seq : 0);
  const order = [...items].sort((a, b) => kind(a) - kind(b) || (kind(a) === 0 ? 0 : (a.device.id < b.device.id ? -1 : a.device.id > b.device.id ? 1 : 0) || seq(a) - seq(b)));
  const out = [];
  for (const i of order) {
    if (typeof opts.before === "function") await opts.before(i);                // the daemon applies cancels that arrived live meanwhile (L-11)
    let r;
    try { r = await applyAction(i.action, { ...opts, device: i.device }); }
    catch { r = { status: "refused", reason: "bad_request", actionId: null }; }   // one bad action must not stop the rest of the batch
    out.push(r);
    if (typeof opts.onResult === "function") await opts.onResult(i, r);          // the daemon sends each result here, before it acks
  }
  return out;
}

const RESULT_KEYS = ["status", "reason", "item", "file", "fid", "appliedAt", "reapplied", "cancelledActionId"];
const keep = (r) => Object.fromEntries(RESULT_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));

async function run(action, opts) {
  const now = opts.now ?? Date.now;
  const t = now();
  const device = opts.device;
  const dev = deviceLabel(device.name);
  const base = fs.realpathSync(opts.elevenDir);
  const { file: sfile, s: S, unavailable } = loadActionState(opts.stateDir, t);
  const id = isObj(action) && typeof action.actionId === "string" && UUID4.test(action.actionId) ? action.actionId : null;
  // only validated values are ever logged or stored (M3)
  const kind = isObj(action) && KINDS.includes(action.kind) ? action.kind : "?";
  const item = isObj(action) && typeof action.item === "string" && ITEM.test(action.item) ? action.item : null;
  if (unavailable) {   // M1: no memory means no dedupe, so nothing is applied until the user looks at the file
    try { appendLog(opts.stateDir, { now: t, device: dev, kind, item, actionId: id ?? "-", hash: "-", result: "refused:state_unavailable" }); } catch { /* the refusal still stands */ }
    return { status: "refused", reason: "state_unavailable", actionId: id, kind, message: "actions-state.json is unreadable; nothing is applied. On the machine run: eleven-sync reset-state" };
  }
  if (!id) return { status: "refused", reason: "bad_request", actionId: null };
  const key = markKey(device.id, id);

  // step 2: dedupe, per (device, actionId)
  const prev = Object.hasOwn(S.seen, key) ? S.seen[key] : null;
  if (prev) {
    if (prev.pending) return { status: "conflict", reason: "interrupted", actionId: id, kind, replayed: true };   // we started it and never finished: do not do it again
    return { ...prev.result, actionId: id, kind, replayed: true };
  }

  let hash = "unhashable";
  try { hash = H(jcs(action)); } catch { /* keep the marker */ }
  const finish = (result) => {
    const r = { ...result, actionId: id, kind, ...(item ? { item: result.item ?? item } : result.item ? { item: result.item } : {}) };
    S.seen[key] = { at: t, dev: device.id, result: keep(r) };
    saveActionState(sfile, S);
    appendLog(opts.stateDir, { now: t, device: dev, kind, item: r.item ?? item, actionId: id, hash, result: r.status + (r.reason ? ":" + r.reason : "") });
    return r;
  };
  const rej = (reason) => finish({ status: "refused", reason });
  // early refusals and cancels have their own small budget; past it the action is dropped and nothing is saved
  const rr = Object.hasOwn(S.rate, device.id) ? S.rate[device.id] : (S.rate[device.id] = { a: [], n: [], e: [] });
  rr.e ||= [];
  const early = () => { if (rr.e.length >= RATE.earlyPerHour) return true; rr.e.push(t); return false; };
  const dropped = () => ({ status: "refused", reason: "rate_limited", actionId: id, kind });
  const earlyDo = (fn) => (early() ? dropped() : fn());
  // write-ahead: saved before anything is written, so a re-delivery after a crash never applies twice
  const begin = () => { S.seen[key] = { at: t, dev: device.id, pending: true }; saveActionState(sfile, S); };

  // a cancel that arrived before its action (same device only)
  if (Object.hasOwn(S.cancelled, key)) return earlyDo(() => finish({ status: "cancelled" }));

  // step 3
  if (!Number.isSafeInteger(action.createdAt)) return earlyDo(() => rej("bad_request"));
  if (t - action.createdAt > EXPIRE_MS) return earlyDo(() => finish({ status: "expired" }));
  if (action.createdAt - t > FUTURE_MS) return earlyDo(() => rej("clock"));
  // step 4 (the signature was verified by the caller). Only mode "write" may write; anything else is read-only (L7)
  if (device.mode !== "write") return earlyDo(() => rej("read_only"));
  if (kind === "?") return earlyDo(() => rej("bad_request"));
  // step 5
  if (kind === "cancel") {   // the user must always be able to stop something: cancel is not on the 20/hour budget
    if (early()) return dropped();
  } else {
    if (rr.a.length >= RATE.actionsPerHour || (kind === "new_item" && rr.n.length >= RATE.newItemsPerDay)) {
      // N4: a rate-limit refusal is NOT remembered (a flood could evict other devices' dedupe records). It costs one slot of the
      // early budget, which is saved so it counts across restarts; past that budget the action is dropped like any other.
      if (early()) return dropped();
      saveActionState(sfile, S);
      try { appendLog(opts.stateDir, { now: t, device: dev, kind, item, actionId: id, hash, result: "refused:rate_limited" }); } catch { /* the refusal still stands */ }
      return dropped();
    }
    rr.a.push(t);
    if (kind === "new_item") rr.n.push(t);
    saveActionState(sfile, S);
  }

  const fids = opts.fids ?? (() => { try { return JSON.parse(readPrivate(path.join(opts.stateDir, "state.json"))?.toString("utf8") ?? "{}").fids ?? {}; } catch { return {}; } })();   // E5: the same safe reader as everywhere else
  const c = {
    base, dev, date: localDate(t), now, fids, hooks: opts.hooks ?? {},
    recheckMs: opts.recheckMs ?? 5000, sleep: opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))),
    pathFor: (fid) => (typeof fid === "string" && Object.hasOwn(fids, fid) ? fids[fid] : null),
  };
  try {
    // step 6
    const pre = isObj(action.pre) ? action.pre : {}, payload = isObj(action.payload) ? action.payload : {};
    if (action.pre !== undefined && action.pre !== null && !isObj(action.pre)) refuse("bad_request");
    if (action.payload !== undefined && action.payload !== null && !isObj(action.payload)) refuse("bad_request");
    const needItem = () => {
      if (typeof action.item !== "string" || !ITEM.test(action.item)) refuse("bad_request");
      if (!resolveInside(base, `work/${action.item}`, "dir")) refuse("unknown_item");
    };
    const fidPath = (fid) => {
      if (typeof fid !== "string" || !FID.test(fid)) refuse("bad_request");
      const p = c.pathFor(fid);
      if (p === null) refuse("unknown_fid");
      return p;
    };
    const inTable = (rel) => { if (!Object.values(fids).includes(rel)) refuse("bad_target"); return rel; };

    if (kind === "cancel") {
      if (action.item != null || action.target != null) refuse("bad_request");
      if (typeof payload.actionId !== "string" || !UUID4.test(payload.actionId)) refuse("bad_request");
      const tkey = markKey(device.id, payload.actionId);   // a device can only cancel its own actions
      const tgt = Object.hasOwn(S.seen, tkey) ? S.seen[tkey] : null;
      if (tgt) {
        if (tgt.result?.status === "cancelled") return finish({ status: "cancelled", cancelledActionId: payload.actionId });
        refuse("already_applied");
      }
      if (!Object.hasOwn(S.cancelled, tkey)) S.cancelled[tkey] = { device: device.id, at: t };
      return finish({ status: "cancelled", cancelledActionId: payload.actionId });
    }

    if (kind === "new_item") {
      if (action.item != null || action.target != null) refuse("bad_request");
      const ti = prepTitle(payload.title); if (ti.error) refuse(ti.error);
      const pr = prepBlock(payload.problem ?? "", { max: 4000, keepBlank: true }); if (pr.error) refuse(pr.error);
      begin();
      return finish(await runNewItem(c, { title: ti.title, problem: pr.lines }));
    }

    needItem();
    const item2 = action.item;
    if (kind === "answer") {
      const qHash = pre.qHash;
      if (typeof qHash !== "string" || !HASH.test(qHash)) refuse("bad_request");
      const tg = action.target;
      let rel, headRe, fid = null;
      if (tg === "brief") { rel = inTable(`work/${item2}/brief.md`); headRe = /^##\s+Open questions\s*$/i; }
      else if (isObj(tg) && Object.keys(tg).length === 1 && "report" in tg) {
        fid = tg.report; rel = fidPath(fid);
        if (!new RegExp(`^work/${item2}/reports/\\d{2}[a-z]?-[a-z-]+\\.md$`).test(rel)) refuse("bad_target");
        headRe = /^##\s+Open questions for the user\s*$/i;
      } else refuse("bad_target");
      const a = prepBlock(payload.answer, { max: 4000, keepBlank: false }); if (a.error) refuse(a.error);
      begin();
      const res = await runEdit(c, () => planAnswer(c, { rel, headRe, qHash, lines: a.lines, item: item2 }));
      return finish(fid ? { ...res, fid } : res);
    }
    if (kind === "approve") {
      const tg = action.target;
      if (!isObj(tg) || Object.keys(tg).length !== 1 || !("brief" in tg)) refuse("bad_target");
      if (typeof pre.briefHash !== "string" || !HASH.test(pre.briefHash)) refuse("bad_request");
      const rel = fidPath(tg.brief);
      if (rel !== `work/${item2}/brief.md`) refuse("bad_target");
      begin();
      const res = await runEdit(c, () => planApprove(c, { rel, briefHash: pre.briefHash, item: item2 }));
      return finish({ ...res, fid: tg.brief });
    }
    // accept
    const tg = action.target;
    if (!isObj(tg) || Object.keys(tg).length !== 1 || !Number.isSafeInteger(tg.n) || tg.n < 1 || tg.n > 9999) refuse("bad_target");
    for (const k of ["rowHash", "tasksHash"]) if (typeof pre[k] !== "string" || !HASH.test(pre[k])) refuse("bad_request");
    if ((pre.reportFid === null) !== (pre.reportHash === null)) refuse("bad_request");
    if (pre.reportFid !== null) { if (typeof pre.reportHash !== "string" || !HASH.test(pre.reportHash)) refuse("bad_request"); fidPath(pre.reportFid); }
    const tasksRel = inTable(`work/${item2}/tasks.md`);
    begin();
    const res = await runEdit(c, () => planAccept(c, { tasksRel, item: item2, n: tg.n, rowHash: pre.rowHash, tasksHash: pre.tasksHash, reportFid: pre.reportFid, reportHash: pre.reportHash }));
    return finish(res);
  } catch (e) {
    if (e instanceof Refuse) return rej(e.reason);
    throw e;
  }
}

export { cleanText };
