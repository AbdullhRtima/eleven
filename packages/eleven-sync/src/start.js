// `eleven-sync start`: the sync daemon (protocol 7 sync, 8 actions, 9 push). MIT.
//
// One daemon per ledger (a lock file). It connects to the relay as the machine, sends a full manifest to every paired phone on start,
// then deltas from the watcher, serves file requests, applies signed actions from phones and pushes a declarative notification when
// an item needs the user. Every message to a phone is sealed with that phone's own send key (L6). Nothing secret is logged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { b64uEncode, b64uDecode, jcs } from "../../eleven-protocol/src/index.js";
import { itemModel } from "../../ledger-core/index.js";
import { findEleven } from "./find.js";
import { acquireLock, StartError } from "./lock.js";
export { acquireLock, StartError };
import { scan } from "./scan.js";
import { ManifestTracker } from "./manifest.js";
import { watch } from "./watch.js";
import { applyAction, applyBatch, toWire } from "./apply.js";
import { loadMachineRecord, saveMachineRecord } from "./pair.js";
import { createRelayClient, RelayError, clean } from "./relay-client.js";
import { ensurePrivateDir, readPrivate, writePrivateAtomic, lstatOrNull, O_NOFOLLOW, O_NONBLOCK } from "./fsafe.js";
import { buildPushJson, encryptWebPush, parsePushKeys, cleanLine } from "./webpush.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version;
const CORE_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ledger-core/package.json"), "utf8")).version; } catch { return "0"; } })();
const subtle = globalThis.crypto.subtle;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const MAX_SYNC_BYTES = 768 * 1024;          // 7.9: larger files are listed in the manifest but never sent
const FID = /^[A-Za-z0-9_-]{22}$/;
const ITEM_PATH = /^work\/(\d{3}-[a-z0-9-]{1,40})\//;
const SEQ_GAP = 1000;                              // after a crash the counter must still be higher than anything the phone saw


// ---- where things live: one folder per project inside the state dir (a shared folder would mix the fid tables of two projects)
export function daemonPaths(stateDir, elevenDir) {
  const tag = crypto.createHash("sha256").update(path.resolve(elevenDir)).digest("hex").slice(0, 16);
  const dir = path.join(stateDir, `proj-${tag}`);
  return { dir, lock: path.join(dir, "start.lock"), daemon: path.join(dir, "daemon.json") };
}

// ---- reading a synced file: no symlink anywhere on the way, a regular file, inside eleven/, small enough, valid UTF-8
function readSynced(base, rel) {
  try {
    let cur = base;
    for (const part of rel.split("/")) { cur = path.join(cur, part); if (lstatOrNull(cur)?.isSymbolicLink()) return null; }
    const st = lstatOrNull(cur);
    if (!st || !st.isFile() || st.size > MAX_SYNC_BYTES) return null;
    const real = fs.realpathSync(cur);
    const r = path.relative(base, real);
    if (r === "" || r.startsWith("..") || path.isAbsolute(r)) return null;
    const fd = fs.openSync(cur, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    let buf;
    try { if (!fs.fstatSync(fd).isFile()) return null; buf = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    if (buf.length > MAX_SYNC_BYTES) return null;
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), sha256: b64uEncode(crypto.createHash("sha256").update(buf).digest()) };
  } catch { return null; }
}

// ---- 8.2, passkey: `challenge` is toSign (the phone passes the raw digest to credentials.get; the browser writes it b64u into clientDataJSON).
// The signature is ASN.1 DER over authenticatorData || SHA-256(clientDataJSON). No attestation: the key is whatever pairing registered.
const WA_RP = "m.eleven.rtima.org", WA_ORIGIN = `https://${WA_RP}`;
const WA_RPID_HASH = crypto.createHash("sha256").update(WA_RP).digest();
const WA_MAX = { authenticatorData: 64, clientDataJSON: 5462, signature: 96 };   // b64u chars; they cap the decoded size: authenticatorData 37 bytes (+slack), clientDataJSON 4096 bytes, DER <= 72 bytes
function checkWebauthn(sig, challenge, pub, info) {
  const f = {};
  for (const [k, max] of Object.entries(WA_MAX)) {
    if (typeof sig[k] !== "string" || sig[k].length > max) return "bad_signature";
    f[k] = Buffer.from(b64uDecode(sig[k]));                                         // strict: no padding, no other alphabet, canonical
  }
  const ad = f.authenticatorData, cd = f.clientDataJSON;
  if (ad.length !== 37) return "bad_signature";                                     // exactly rpIdHash, flags, counter: AT and ED (more bytes) are refused below
  if (!ad.subarray(0, 32).equals(WA_RPID_HASH)) return "bad_signature";
  if ((ad[32] & 0x05) !== 0x05 || (ad[32] & 0xc0)) return "bad_signature";         // UP and UV set; no attested credential data (AT) or extensions (ED) on a get
  const c = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(cd));
  if (!isObj(c) || c.type !== "webauthn.get" || c.challenge !== challenge || c.origin !== WA_ORIGIN) return "bad_signature";
  if (c.crossOrigin !== undefined && c.crossOrigin !== false) return "bad_signature";
  if (c.topOrigin !== undefined && c.topOrigin !== WA_ORIGIN) return "bad_signature";
  if (pub.asymmetricKeyType !== "ec" || pub.asymmetricKeyDetails?.namedCurve !== "prime256v1") return "bad_signature";
  const msg = Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]);
  if (!crypto.verify("sha256", msg, { key: pub, dsaEncoding: "der" }, f.signature)) return "bad_signature";
  info.counter = ad.readUInt32BE(33);                                               // recorded by the caller, never required to rise (synced passkeys report 0)
  return null;
}

// ---- 8.2: the per-action signature. -> null when good, else the rejection reason. `info` (optional) gets `counter` for a good passkey assertion.
export function checkActionSignature(action, device, vault, info = {}) {
  try {
    if (!isObj(action)) return "bad_signature";                                                // null, or a throwing sig getter, must not escape
    const sig = action.sig;
    if (!isObj(sig) || typeof sig.alg !== "string") return "bad_signature";
    const registered = device.phoneActKey?.alg === "webauthn-es256" ? "webauthn-es256" : "device-es256";
    if (registered === "webauthn-es256" && sig.alg === "device-es256") return "weak_signature";   // never weaker than what was registered
    if (sig.alg !== registered) return "bad_signature";                                          // nor swapped: a software key's webauthn-shaped flags would be self-asserted (8.2: upgrade = re-pair)
    const { sig: _drop, ...rest } = action;
    const toSign = b64uEncode(crypto.createHash("sha256").update(`eleven/v1/action|${vault}|${device.deviceId}|${jcs(rest)}`).digest());
    const pub = crypto.createPublicKey({ key: Buffer.from(device.phoneActKey?.pub ?? "", "base64url"), format: "der", type: "spki" });
    if (registered === "webauthn-es256") return checkWebauthn(sig, toSign, pub, info);
    const raw = Buffer.from(typeof sig.signature === "string" ? sig.signature : "", "base64url");
    if (raw.length !== 64) return "bad_signature";
    return crypto.verify("sha256", Buffer.from(toSign), { key: pub, dsaEncoding: "ieee-p1363" }, raw) ? null : "bad_signature";
  } catch { return "bad_signature"; }
}

// ---- ledger state -> push triggers (9 step 3): an item becomes waiting, its newest report says failed, or the round limit is hit
function itemStates(elevenDir) {
  const s = scan(elevenDir, { includeText: true });
  const ids = new Set();
  for (const f of s.files) { const m = ITEM_PATH.exec(f.path); if (m) ids.add(m[1]); }
  const out = new Map();
  for (const id of [...ids].sort()) {
    const it = itemModel(id, s.texts);
    const reasons = new Map();
    if (it.state === "waiting") reasons.set("waiting", it.questionsCount ? `${it.questionsCount} open question${it.questionsCount === 1 ? "" : "s"}` : "Waiting on you");
    const reports = [...s.texts.keys()].filter((p) => new RegExp(`^work/${id}/reports/\\d{2}[a-z]?-[a-z-]+\\.md$`).test(p)).sort();
    const last = reports.length ? s.texts.get(reports[reports.length - 1]).text : "";
    if (/^##\s+Result\s*\r?\n(?:\s*\r?\n)*\s*\W*failed\b/im.test(last)) reasons.set("failed", "A task failed");
    if (it.round && it.round.n >= it.round.max && it.state !== "done") reasons.set("round_limit", "Round limit reached");
    out.set(id, { title: `${it.num} ${it.title}`, state: it.state, reasons });
  }
  return out;
}

const defaultStateDir = () => path.join(os.homedir(), ".config", "eleven-sync");

/**
 * startDaemon({ dir, stateDir, cwd, err, out, fetch, WebSocket, debounceMs, pollMs, poll, pushDebounceMs, recheckMs, backoff, pingMs })
 *   -> { stop(), done (resolves { fatal? } when the daemon ends by itself), client, lock, paths }
 * Throws StartError (a clear message and an exit code) before anything is started.
 */
export async function startDaemon(opts = {}) {
  const {
    dir = ".", cwd = process.cwd(), err = process.stderr, fetch: fetchImpl = globalThis.fetch, WebSocket: WS = globalThis.WebSocket,
    debounceMs = 500, pollMs = 1000, poll = false, pushDebounceMs = 3000, recheckMs, backoff, pingMs, syncMinMs = 10_000, ackDelayMs = 250,
  } = opts;
  const stateDir = path.resolve(cwd, opts.stateDir ?? defaultStateDir());
  const log = (m) => err.write(`${new Date().toISOString()} eleven-sync: ${clean(m, 300)}\n`);   // one line, no control characters, whatever the text (L-7)

  const elevenDir = findEleven(path.resolve(cwd, dir));
  if (!elevenDir) throw new StartError(`no eleven/ folder found from ${path.resolve(cwd, dir)} upward`);
  const base = fs.realpathSync(elevenDir);
  const paths = daemonPaths(stateDir, elevenDir);
  ensurePrivateDir(stateDir);

  let record;
  try { record = loadMachineRecord(stateDir, elevenDir); } catch (e) { throw new StartError(`could not read the machine keys: ${e.message}`); }
  if (!record?.vault || !record.deviceId) throw new StartError("this project has no vault yet. Run: eleven-sync pair");
  if (!record.devices.length) throw new StartError("no phone is paired with this project. Run: eleven-sync pair");

  const release = acquireLock(paths.lock);          // one daemon per ledger
  let client = null, watcher = null, stopping = false;
  const timers = new Set();
  try {
    // ---- keys. Send and receive keys are separate objects with one usage each (L6).
    const aes = (b64, usage) => subtle.importKey("raw", b64uDecode(b64), { name: "AES-GCM" }, false, [usage]);
    const signingKey = await subtle.importKey("pkcs8", b64uDecode(record.msig.priv), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const devices = new Map();
    const peers = {};
    for (const d of record.devices) {
      if (d.revoked || !d.keys?.send || !d.keys?.recv) continue;
      devices.set(d.deviceId, { ...d, push: null });
      peers[d.deviceId] = { send: await aes(d.keys.send, "encrypt"), recv: await aes(d.keys.recv, "decrypt") };
    }
    if (!devices.size) throw new StartError("every paired phone is revoked. Run: eleven-sync pair");

    // ---- persisted state: seq, the relay position, push registrations and topics (0600, atomic)
    ensurePrivateDir(paths.dir);
    let saved = null;
    try { const raw = readPrivate(paths.daemon); if (raw) { const o = JSON.parse(raw.toString("utf8")); if (o?.v === 1) saved = o; } }
    catch { log("daemon.json is unreadable; starting with a fresh position (actions already applied are still remembered)"); }
    const state = {
      v: 1, lastSeq: saved?.lastSeq ?? 0, rseq: saved?.rseq ?? 0,
      push: isObj(saved?.push) ? saved.push : {}, topics: isObj(saved?.topics) ? saved.topics : {},
    };
    for (const [id, p] of Object.entries(state.push)) if (devices.has(id) && isObj(p) && parsePushKeys(p.p256dh, p.auth)) devices.get(id).push = p;
    // L-9: the saved inbox position is the highest message below the lowest one not finished yet, never "the highest one acked"
    const unhandled = new Set();                       // rseq of messages handed to us and not finished (or whose result the relay refused)
    const position = () => (unhandled.size ? Math.min(...unhandled) - 1 : Math.max(state.rseq, client?.lastRseq ?? 0));
    const save = () => {
      state.lastSeq = Math.max(state.lastSeq, client?.lastSeq ?? 0);
      state.rseq = Math.max(0, position());
      state.push = Object.fromEntries([...devices].filter(([, d]) => d.push).map(([id, d]) => [id, d.push]));
      writePrivateAtomic(paths.daemon, JSON.stringify(state));
    };
    let saveTimer = null;
    const dirty = () => { if (saveTimer || stopping) return; saveTimer = setTimeout(() => { saveTimer = null; try { save(); } catch (e) { log(`could not save state: ${e.message}`); } }, 100); timers.add(saveTimer); saveTimer.unref?.(); };

    client = createRelayClient({
      baseUrl: record.relay, vault: record.vault, deviceKeys: { deviceId: record.deviceId, signingKey }, peers,
      seqStart: Math.max(state.lastSeq + SEQ_GAP, Math.floor(Date.now() / 1000)), rseqStart: state.rseq, afterRseq: () => 0,   // the machine's inbox holds only its own unacked items: read it all at every connect (L-12), replays are deduped
      fetch: fetchImpl, WebSocket: WS, ...(backoff ? { backoff } : {}), ...(pingMs !== undefined ? { pingMs } : {}),
    });

    const tracker = new ManifestTracker({ elevenDir, stateDir: paths.dir });
    const active = () => [...devices.values()];
    let needFull = false;

    // ---- queues: messages are handled one at a time, in order; syncs too
    const serial = () => { let p = Promise.resolve(); const q = (fn) => (p = p.then(fn).catch((e) => log(`internal error: ${e?.code ?? e?.message ?? e}`))); q.idle = () => p; return q; };
    const inQ = serial(), syncQ = serial();

    // ---- sending
    const sentFor = new Map();                        // envelope id of an answer -> the inbound message it answers (to replay it if the relay refuses)
    async function sendTo(d, type, inner, o, ev) {
      try {
        const id = await client.send(type, d.deviceId, inner, o);
        if (ev) { sentFor.set(id, { rseq: ev.rseq, id: ev.id }); if (sentFor.size > 2000) sentFor.delete(sentFor.keys().next().value); }
        dirty(); return true;
      } catch (e) {
        if (e instanceof RelayError && (e.code === "not_connected" || e.code === "read_only")) needFull = true;
        if (!(e instanceof RelayError && e.code === "read_only")) log(`could not send ${inner.t} to "${d.name}": ${clean(e.code ?? e.message)}`);   // read_only is logged once, by the client event
        return false;
      }
    }
    const broadcast = (type, inner) => Promise.all(active().map((d) => sendTo(d, type, inner)));
    const fileMessage = (entry) => {
      const f = readSynced(base, entry.path);
      return f ? { t: "file", fid: entry.fid, sha256: f.sha256, text: f.text } : null;
    };
    async function sendFiles(targets, entries) {   // .md only, newest items first (7.3); never .html
      const rank = (p) => { const m = ITEM_PATH.exec(p); return m ? "1" + m[1] : p === "project.md" ? "0" : "0" + p; };
      const list = entries.filter((e) => e.kind === "md" && e.size <= MAX_SYNC_BYTES).sort((a, b) => (rank(a.path) < rank(b.path) ? 1 : -1));
      for (const e of list) {
        const m = fileMessage(e);
        if (m) for (const d of targets) await sendTo(d, "file", m, { fid: e.fid });
      }
    }
    async function fullSync(filesTo = active()) {
      const m = tracker.manifest();
      await broadcast("manifest", { t: "manifest", ...m });
      await sendFiles(filesTo, m.files);
      needFull = false;
    }
    const hello = () => ({
      t: "hello", machineLabel: cleanLine(os.hostname(), 32) || "machine", projectName: cleanLine(path.basename(path.dirname(base)), 64) || "project",
      proto: 1, coreVersion: CORE_VERSION, syncVersion: VERSION, accountId: record.account ?? null,
    });

    // ---- deltas: change -> hash-chained delta + the changed .md files + `gone` for removed ones
    const kick = () => syncQ(async () => {
      if (stopping) return;
      const n = tracker.next();
      if (n) {
        if (n.type === "manifest") { await broadcast("manifest", { t: "manifest", ...n.body }); await sendFiles(active(), n.body.files); }
        else {
          await broadcast("delta", { t: "delta", ...n.body });
          await sendFiles(active(), n.body.upsert);
          const to = active()[0]?.deviceId;               // `gone` needs a real phone as `to`; the relay deletes the file for every device
          if (to) for (const fid of n.body.remove) { try { await client.sendGone(fid, to); } catch (e) { if (e.code !== "read_only") log(`could not send gone: ${clean(e.code ?? e.message)}`); needFull = true; } }
        }
      }
      await evaluate(false);
    });

    // ---- push (9)
    let prevReasons = new Map();
    let pending = new Map();                           // "item|reason" -> { item, reason }
    let pushTimer = null;
    async function evaluate(baseline) {
      const now = itemStates(elevenDir);
      const next = new Map();
      for (const [id, s] of now) for (const r of s.reasons.keys()) next.set(`${id}|${r}`, id);
      if (!baseline) for (const [k, id] of next) if (!prevReasons.has(k)) pending.set(k, { item: id, reason: k.split("|")[1] });
      prevReasons = next;
      if (pending.size && !pushTimer && !stopping) {
        pushTimer = setTimeout(() => { pushTimer = null; syncQ(flushPush); }, pushDebounceMs);
        timers.add(pushTimer); pushTimer.unref?.();
      }
    }
    const topicFor = (item) => {
      const month = new Date().toISOString().slice(0, 7);
      const t = state.topics[item];
      if (t && t.m === month) return t.t;
      state.topics[item] = { t: b64uEncode(crypto.randomBytes(16)).slice(0, 22), m: month };
      dirty();
      return state.topics[item].t;
    };
    async function flushPush() {
      if (stopping) return;
      const now = itemStates(elevenDir);
      const todo = [...pending.values()].filter((p) => now.get(p.item)?.reasons.has(p.reason));    // still true after the debounce
      pending = new Map();
      if (!todo.length) return;
      const badge = [...now.values()].filter((s) => s.reasons.has("waiting")).length;
      for (const p of todo) {
        const s = now.get(p.item);
        for (const d of active()) {
          if (!d.push) continue;
          try {
            const keys = parsePushKeys(d.push.p256dh, d.push.auth);
            if (!keys) continue;
            const json = buildPushJson({ vault: record.vault, item: p.item, title: s.title, body: s.reasons.get(p.reason), reason: p.reason, seq: client.lastSeq, badge, generic: d.push.lockScreen !== "titles" });
            await client.sendPush({ to: d.deviceId, subId: d.push.subId, bodyBytes: encryptWebPush(keys, json), topic: topicFor(p.item) });
          } catch (e) { log(`push to "${d.name}" not sent: ${e.code ?? e.message}`); }
        }
      }
    }

    // ---- phone -> machine
    const sendResult = (d, inner, ev) => sendTo(d, "result", inner, undefined, ev);
    const syncTimes = new Map();                        // deviceId -> [ms] of the stale sync_requests we answered (L-8)
    const syncAllowed = (d) => {
      const t = Date.now(), list = (syncTimes.get(d.deviceId) ?? []).filter((x) => t - x < 3_600_000);
      syncTimes.set(d.deviceId, list);
      if (list.length && t - list.at(-1) < syncMinMs) return false;          // merge a burst into one answer
      if (list.length >= 30) return false;                                   // and cap one phone at 30 an hour
      list.push(t); return true;
    };
    // bring ONE phone up to date: the current chain (the manifest it started with and the deltas since) + the files. Nobody else is touched.
    async function resyncOne(d) {
      const chain = tracker.chainFor();
      if (!chain) return fullSync([d]);               // an old state file without a chain record: a new chain for everybody, once
      await sendTo(d, "manifest", { t: "manifest", ...chain.manifest });
      for (const dl of chain.deltas) await sendTo(d, "delta", { t: "delta", ...dl });
      await sendFiles([d], tracker.state.current.files);
    }
    async function onReq(d, a, ev) {
      switch (a.t) {
        case "sync_request": {
          if (typeof a.haveHash === "string" && tracker.hash && a.haveHash === tracker.hash) return sendTo(d, "tick", { t: "tick" }, undefined, ev);
          if (!syncAllowed(d)) { log(`sync_request from "${d.name}" ignored (too often)`); return true; }
          await syncQ(() => resyncOne(d));
          return true;
        }
        case "file_request": {
          const p = typeof a.fid === "string" && FID.test(a.fid) ? tracker.pathFor(a.fid) : null;
          const entry = p && tracker.state.current?.files.find((f) => f.fid === a.fid);
          if (!entry) { log(`file_request from "${d.name}" for an unknown fid ignored`); return true; }
          if (entry.size > MAX_SYNC_BYTES) { log(`file_request from "${d.name}": file over 768 KiB is not sent`); return true; }
          const m = fileMessage(entry);
          if (!m) return true;
          if (entry.kind === "md") return sendTo(d, "file", m, { fid: entry.fid }, ev);
          return sendResult(d, { ...m, ephemeral: true }, ev);       // .html: a result, shown once on the phone (7.4)
        }
        case "push_keys": {
          const k = parsePushKeys(a.p256dh, a.auth);
          if (!k || typeof a.subId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(a.subId)) { log(`push_keys from "${d.name}" ignored (malformed)`); return true; }
          d.push = { subId: a.subId, p256dh: a.p256dh, auth: a.auth, lockScreen: a.lockScreen === "titles" ? "titles" : "generic" };   // anything but "titles" is the private choice
          dirty();
          return true;
        }
        case "revoke_request":
          log(`revoke_request from "${d.name}" refused: revoking is done at this machine (TODO)`);
          return sendResult(d, { t: "revoke_result", deviceId: typeof a.deviceId === "string" ? a.deviceId.slice(0, 64) : "", ok: false }, ev);
        case "log_request":
          log(`log_request from "${d.name}" ignored (TODO)`);
          return true;
        default:
          log(`unknown request type from "${d.name}" ignored`);
          return true;
      }
    }

    // an action: the signature (8.2), then applyAction/applyBatch, then the sealed action_result. -> true when the result left
    const applyOpts = () => ({ elevenDir, stateDir: paths.dir, fids: tracker.state.fids, ...(recheckMs !== undefined ? { recheckMs } : {}) });
    const asDevice = (d) => ({ id: d.deviceId, name: d.name, mode: d.mode });
    function signatureProblem(d, a) {                                              // 8.5 step 4: mode first (applyAction refuses read_only), then the signature
      if (d.mode !== "write") return null;
      const info = {}, why = checkActionSignature(a, d, record.vault, info);
      if (why) log(`action from "${d.name}" rejected: ${why}`);
      else if (info.counter !== undefined) log(`action from "${d.name}": passkey counter ${info.counter}`);   // 8.2: recorded here only, not required to rise
      return why;
    }
    async function answerAction(d, a, r, ev) {
      const w = toWire(r);
      const ok = await sendResult(d, { t: "action_result", actionId: typeof a.actionId === "string" ? a.actionId : null, ...w, ...(r.appliedAt ? { appliedAt: r.appliedAt } : {}), ...(r.fid ? { fid: r.fid } : {}) }, ev);
      log(`action ${r.kind ?? "?"} from "${d.name}": ${r.status}${r.reason ? ":" + r.reason : ""}${r.replayed ? " (replay)" : ""}`);
      if (r.status === "written") kick();                                          // the change goes out at once, and may open or close a push
      return ok;
    }

    // ---- inbound messages. M-B: the catch-up after every (re)connect is ONE batch: cancels first (8.7), then by (device, seq); the
    // results go out BEFORE the acks. Live frames that arrive meanwhile are queued by the client and come after the batch.
    const okIds = new Set();                                                       // finished in this process: a replay is only acked again
    const attempts = new Map();
    const MAX_ATTEMPTS = 3;
    function done(ev) { if (Number.isSafeInteger(ev.rseq)) unhandled.delete(ev.rseq); }
    function finish(ev, ok) {
      if (ok === false) {
        if (client.readOnly || !client.connected) return;                          // the relay is read-only or the socket is down: not the message's fault, no count
        const n = (attempts.get(ev.id) ?? 0) + 1; attempts.set(ev.id, n);
        if (n < MAX_ATTEMPTS) return;                                              // stays unhandled: the next catch-up brings it again
        log(`giving up on a message from ${clean(ev.from, 8)}... after ${n} tries`);
        done(ev); okIds.add(ev.id); queueAck(ev.id, ev.rseq); dirty(); return;               // dropped on purpose: acked too, or it comes back with every catch-up
      }
      okIds.add(ev.id); if (okIds.size > 5000) okIds.delete(okIds.values().next().value);
      done(ev);
      queueAck(ev.id, ev.rseq);
      dirty();
    }
    // Acks go out after the results, and a moment later still: a result the relay refuses is answered by an error frame within
    // milliseconds, and a message that was acked at the relay can never be fetched again to answer it (L-9).
    const ackQueue = new Map(); let ackTimer = null;                              // id -> { at: when its result was sent, rseq }: the grace is per id
    const flushAcks = (all = false) => {
      if (ackTimer) { clearTimeout(ackTimer); timers.delete(ackTimer); ackTimer = null; }
      const t = Date.now(), ids = [];
      for (const [id, { at }] of ackQueue) if (all || t - at >= ackDelayMs) { ackQueue.delete(id); if (okIds.has(id)) ids.push(id); }
      if (ids.length) { client.ack(ids); for (const id of ids) attempts.delete(id); }
      if (ackQueue.size && !stopping) { const wait = Math.max(5, ackDelayMs - (t - Math.min(...[...ackQueue.values()].map((x) => x.at)))); ackTimer = setTimeout(flushAcks, wait); timers.add(ackTimer); ackTimer.unref?.(); }
    };
    const queueAck = (id, rseq) => { if (!ackQueue.has(id)) ackQueue.set(id, { at: Date.now(), rseq }); if (!ackTimer && !stopping) { ackTimer = setTimeout(flushAcks, ackDelayMs); timers.add(ackTimer); ackTimer.unref?.(); } };
    let batchRunning = false;
    async function handleBatch(evs) {
      if (stopping) return;
      batchRunning = true;
      try { await handleBatchInner(evs); } finally { batchRunning = false; liveCancels.length = 0; }
    }
    async function handleBatchInner(evs) {                                                         // left unacked: it comes again on the next start
      const items = [], reqs = [];
      for (const ev of evs) {
        if (okIds.has(ev.id)) { done(ev); queueAck(ev.id, ev.rseq); continue; }
        const d = devices.get(ev.from);
        if (!d) { done(ev); okIds.add(ev.id); queueAck(ev.id, ev.rseq); continue; }           // unknown or revoked: dropped (4.4) and acked (contract 13)
        (ev.type === "action" ? items : reqs).push({ ev, d });
      }
      const toApply = [];
      for (const it of items) {
        const why = signatureProblem(it.d, it.ev.inner);
        if (why) finish(it.ev, await answerAction(it.d, it.ev.inner, { status: "refused", reason: why, kind: it.ev.inner?.kind }, it.ev));
        else toApply.push({ action: it.ev.inner, device: asDevice(it.d), ev: it.ev, d: it.d });
      }
      if (toApply.length) {
        try {
          await applyBatch(toApply, { ...applyOpts(), before: () => drainLiveCancels(), onResult: async (it, r) => finish(it.ev, await answerAction(it.d, it.action, r, it.ev)) });
        } catch (e) { log(`actions failed: ${clean(e?.message)}`); }
      }
      for (const { ev, d } of reqs) finish(ev, await onReq(d, ev.inner, ev));
    }
    const track = (ev) => { if (Number.isSafeInteger(ev.rseq)) unhandled.add(ev.rseq); };
    client.on("batch", (evs) => { evs.forEach(track); inQ(() => handleBatch(evs)); });
    // L-11: a cancel that arrives live while a batch is being applied is applied before the batch's next action
    const liveCancels = [];
    client.on("message", (ev) => {
      track(ev);
      if (batchRunning && ev.type === "action" && isObj(ev.inner) && ev.inner.kind === "cancel") liveCancels.push(ev);
      inQ(() => handleBatch([ev]));
    });
    async function drainLiveCancels() {
      while (liveCancels.length) {
        const ev = liveCancels.shift(), d = devices.get(ev.from);
        if (!d || okIds.has(ev.id) || signatureProblem(d, ev.inner)) continue;      // anything odd takes the normal path
        const r = await applyAction(ev.inner, { ...applyOpts(), device: asDevice(d) });
        finish(ev, await answerAction(d, ev.inner, r, ev));
      }
    }
    // the relay refused an envelope (kill switch, rate limit): if it was an answer, the message is not finished; if it was state, send it all again later
    client.on("send_failed", ({ id, error }) => {
      const m = sentFor.get(id);
      if (!m) { needFull = true; return; }
      okIds.delete(m.id);
      if (error !== "read_only") {                                                  // too_large / bad_request will not get better: a few tries, then drop it and ack
        const n = (attempts.get(m.id) ?? 0) + 1; attempts.set(m.id, n);
        if (n >= MAX_ATTEMPTS) { log(`the relay refused our answer (${clean(error, 32)}) ${n} times; giving up on that message`); okIds.add(m.id); queueAck(m.id, m.rseq); dirty(); return; }
      }
      if (Number.isSafeInteger(m.rseq)) unhandled.add(m.rseq);
      dirty();
    });
    // an envelope the client could not use (undecryptable, unknown sender ...) is dropped on purpose; ack it as well
    client.on("drop", (e) => { if (e.id && ["decrypt_failed", "unknown_peer", "type_not_accepted", "wrong_vault", "bad_envelope"].includes(e.reason)) { okIds.add(e.id); queueAck(e.id, e.rseq); } });
    // An outcome only counts as durable once its result has survived the ack grace on a live socket. If the socket drops first, a refusal
    // frame may have been lost with it: take those messages back (not finished, not acked) and let the next catch-up replay them.
    client.on("close", () => {
      for (const [id, { rseq }] of ackQueue) { okIds.delete(id); if (Number.isSafeInteger(rseq)) unhandled.add(rseq); }
      ackQueue.clear();
    });
    client.on("read_only", ({ first }) => { if (first) log("the relay is in read-only mode: nothing is sent, nothing is lost; will retry"); });
    client.on("decrypt_failed", ({ from }) => log(`a message from ${clean(from, 8)}... could not be decrypted and was dropped`));
    // device_revoked (13.1 hint, contract section 9): drop that phone's keys and state NOW. A hint is never proof, but dropping is the safe direction.
    client.on("hint", (h) => {
      if (h.type === "device_revoked") {
        if (h.deviceId === record.deviceId) { log("relay hint: this machine's vault was deleted"); return; }
        const d = devices.get(h.deviceId);
        if (!d) { log("relay hint: device_revoked for a device we do not know"); return; }
        devices.delete(h.deviceId); client.removePeer(h.deviceId);
        for (const e of record.devices) if (e.deviceId === h.deviceId) { e.revoked = true; e.revokedAt = Date.now(); delete e.keys; }
        try { saveMachineRecord(stateDir, elevenDir, record); } catch (e) { log(`could not save the revoked device: ${clean(e.message)}`); }
        dirty();
        log(`"${d.name}" was revoked (reported by the relay); its keys were removed`);
      } else if (h.type === "push_stale" || h.type === "plan_ended") log(`relay hint: ${h.type}`);
    });
    client.on("error", (e) => log(`relay: ${clean(e.code ?? e.message)}`));
    client.on("rate_limited", (r) => log(`relay rate limit: waiting ${Math.round((r.waitMs ?? 0) / 1000)}s`));
    let first = true;
    client.on("open", () => { if (first) { first = false; return; } log("reconnected"); if (needFull) syncQ(() => fullSync()); });
    const fatal = new Promise((resolve) => client.on("fatal", (e) => { log(`stopped: ${clean(e.code)} (${clean(e.message)})`); resolve({ fatal: e }); }));

    // ---- go
    await client.connect();
    log(`connected as the machine of ${record.vault.slice(0, 8)}... with ${devices.size} phone(s)`);
    await syncQ(async () => {
      await broadcast("hello", hello());
      await fullSync();
      await evaluate(true);
    });
    save();
    watcher = watch(elevenDir, { debounceMs, poll, pollMs });
    watcher.on("change", () => kick());
    watcher.on("error", (e) => log(`watcher: ${e.message} (falling back to polling)`));

    let stopP = null;
    const stop = () => stopP ??= (async () => {
      stopping = true;
      watcher?.close();
      for (const t of timers) clearTimeout(t);
      await Promise.race([Promise.all([inQ.idle(), syncQ.idle()]), new Promise((r) => { const t = setTimeout(r, 4000); t.unref?.(); })]);
      try { flushAcks(true); } catch { /* closing */ }
      try { await client.close(); } catch { /* closing */ }
      try { save(); } catch (e) { log(`could not save state: ${e.message}`); }
      release();
      log("stopped");
    })();
    fatal.then(() => stop());                          // the relay says this machine is gone or the plan ended: shut down cleanly
    return { stop, done: fatal, client, paths, tracker, devices };
  } catch (e) {
    try { await client?.close(); } catch { /* closing */ }
    watcher?.close();
    for (const t of timers) clearTimeout(t);
    release();
    throw e;
  }
}
