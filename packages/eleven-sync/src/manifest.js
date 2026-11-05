// Manifest, fid table and hash-chained deltas (protocol sections 2, 7.2, 7.3). MIT.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { scan } from "./scan.js";
import { jcs } from "../../eleven-protocol/src/jcs.js";
import { ensurePrivateDir, readPrivate, writePrivateAtomic } from "./fsafe.js";

export const FULL_EVERY = 100;   // a full manifest after this many deltas (7.3)
export const b64u = (buf) => Buffer.from(buf).toString("base64url");
export const H = (x) => b64u(crypto.createHash("sha256").update(x).digest());

// RFC 8785: the protocol package's JCS is the only one (it refuses lone surrogates, undefined, non-plain objects and sparse arrays).
export { jcs };

// hash = H(prevHash || JCS(body without hash)). prevHash null counts as the empty string.
export function chainHash(prevHash, body) {
  const { hash, ...rest } = body;
  return H((prevHash ?? "") + jcs(rest));
}

export const manifestBody = (files, dirs) => ({ files, dirs, prevHash: null });
export function makeManifest(files, dirs) {
  const body = manifestBody(files, dirs);
  return { ...body, hash: chainHash(null, body) };
}
export function makeDelta(prevHash, upsert, remove) {
  const body = { prevHash, upsert, remove };
  return { ...body, hash: chainHash(prevHash, body) };
}

// Apply a delta to a Map fid -> entry (the phone's view). Returns the new Map.
export function applyDelta(entries, delta) {
  const next = new Map(entries);
  for (const fid of delta.remove) next.delete(fid);
  for (const e of delta.upsert) next.set(e.fid, e);
  return next;
}

// Check a manifest and the deltas that follow it. -> { ok, hash, files } or { ok:false, index, reason }
// index -1 is the manifest itself.
export function verifyChain(manifest, deltas = []) {
  if (!manifest || manifest.prevHash !== null) return { ok: false, index: -1, reason: "manifest prevHash must be null" };
  if (chainHash(null, manifest) !== manifest.hash) return { ok: false, index: -1, reason: "manifest hash mismatch" };
  let hash = manifest.hash;
  let files = new Map(manifest.files.map((e) => [e.fid, e]));
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    if (d.prevHash !== hash) return { ok: false, index: i, reason: "prevHash does not match the previous hash" };
    if (chainHash(d.prevHash, d) !== d.hash) return { ok: false, index: i, reason: "delta hash mismatch" };
    files = applyDelta(files, d);
    hash = d.hash;
  }
  return { ok: true, hash, files };
}

// Local state: the fid key, the fid -> path table, and the last manifest.
// The caller passes stateDir (never ~/.config here). Kfid belongs in the OS keychain later (task 6).
export function loadState(stateDir) {
  const file = path.join(stateDir, "state.json");
  ensurePrivateDir(stateDir);
  let s = null;
  try {
    const raw = readPrivate(file);   // refuses a symlink; chmods an existing file to 0600
    if (raw !== null) s = JSON.parse(raw.toString("utf8"));
  } catch { throw new Error(`state file unreadable: ${file}`); }
  if (!s || s.v !== 1 || typeof s.kfid !== "string") s = { v: 1, kfid: b64u(crypto.randomBytes(32)), epoch: 0, fids: {}, current: null };
  return { file, state: s };
}
function saveState(file, state) { writePrivateAtomic(file, JSON.stringify(state)); }

export class ManifestTracker {
  // stateDir null = in-memory only (nothing written)
  constructor({ elevenDir, stateDir = null }) {
    this.elevenDir = elevenDir;
    if (stateDir) ({ file: this.file, state: this.state } = loadState(stateDir));
    else this.state = { v: 1, kfid: b64u(crypto.randomBytes(32)), epoch: 0, fids: {}, current: null };
  }
  // fid = first 16 bytes of HMAC-SHA-256(Kfid, epoch || "|" || path), b64u (7.2)
  fidFor(p) {
    const mac = crypto.createHmac("sha256", Buffer.from(this.state.kfid, "base64url")).update(`${this.state.epoch}|${p}`).digest();
    return b64u(mac.subarray(0, 16));
  }
  pathFor(fid) { return this.state.fids[fid] ?? null; }   // unknown fid -> null: refuse
  get hash() { return this.state.current?.hash ?? null; }
  get deltaCount() { return this.state.current?.deltaCount ?? 0; }

  scan() {
    const s = scan(this.elevenDir);
    const files = s.files.map((f) => ({ fid: this.fidFor(f.path), path: f.path, mtime: f.mtime, size: f.size, sha256: f.sha256, kind: f.kind }));
    return { files, dirs: s.dirs, skipped: s.skipped };
  }
  #save() { if (this.file) saveState(this.file, this.state); }
  #setCurrent(hash, files, deltaCount) {
    this.state.current = { hash, files, deltaCount };
    this.state.fids = Object.fromEntries(files.map((f) => [f.fid, f.path]));
    this.#save();
  }
  // A full manifest. Starts a new chain.
  manifest() {
    const { files, dirs } = this.scan();
    const m = makeManifest(files, dirs);
    this.#setCurrent(m.hash, files, 0);
    return m;
  }
  // The next message to send: a manifest on start or every FULL_EVERY deltas, a delta on change, null if nothing changed.
  // mtime-only changes are ignored: an entry changes when its path, size or sha256 changes.
  next() {
    const cur = this.state.current;
    if (!cur || cur.deltaCount >= FULL_EVERY) return { type: "manifest", body: this.manifest() };
    const { files } = this.scan();
    const old = new Map(cur.files.map((f) => [f.fid, f]));
    const merged = [], upsert = [];
    for (const f of files) {
      const o = old.get(f.fid);
      if (o && o.sha256 === f.sha256 && o.size === f.size) merged.push(o);
      else { merged.push(f); upsert.push(f); }
    }
    const seen = new Set(files.map((f) => f.fid));
    const remove = [...old.keys()].filter((fid) => !seen.has(fid)).sort();
    if (!upsert.length && !remove.length) return null;
    const d = makeDelta(cur.hash, upsert, remove);
    this.#setCurrent(d.hash, merged, cur.deltaCount + 1);
    return { type: "delta", body: d };
  }
}
