// Relay client (protocol 5, 12, 13, 14). One interface for the daemon and for `pair`.
//
// Transport: HTTP via global `fetch` + one WebSocket per vault (global `WebSocket` in Node 22+, injectable for Node 20).
// There is NO long-polling fallback: 12 gives the message channel only as the WebSocket (plus `inbox` for catch-up, which
// is receive-only). On Node 20 without an injected WebSocket, connect() fails with RelayError("no_websocket").
//
// Auth: every request is signed with the device key (MSIG); a fresh challenge nonce is fetched per request. No bearer tokens.
// Envelopes are sealed/opened with @eleven/protocol, so the relay client never handles plaintext after sealing.
import { b64uEncode, H, seal, open, ProtocolError } from "../../eleven-protocol/src/index.js";

const enc = new TextEncoder();

// ---- limits (protocol 14)
export const LIMITS = Object.freeze({
  envelopeBytes: 1_153_433,     // 1.1 MiB (14)
  pushBodyBytes: 4096,          // decoded RFC 8291 body
  pushPerHour: 30,
  pushPerDay: 200,
});

const MACHINE_ACCEPTS = new Set(["req", "action"]);
const PHONE_ACCEPTS = new Set(["hello", "manifest", "delta", "file", "tick", "result"]);
const HINTS = new Set(["presence", "device_revoked", "plan_ended", "push_stale", "error", "pong"]);
export const MAX_RETRY_AFTER_S = 3600;           // a relay hint can never mute the client for longer than this (L-7)

// L-7: text that came from the relay is cleaned before it is logged or put in an error: control, ESC and bidi characters out, capped.
export const clean = (s, max = 120) => (typeof s === "string" ? s : "").replace(/[\p{C}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, max);
// A relay error code is a short lowercase word. Anything else is "unknown".
export const safeCode = (c) => (typeof c === "string" && /^[a-z_]{1,32}$/.test(c) ? c : "unknown");
// a clamped integer without `| 0` (which wraps at 2^31)
const clampInt = (x, lo, hi) => { const n = Math.trunc(Number(x)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
const capRetry = (n) => (Number.isFinite(n) && n > 0 ? Math.min(n, MAX_RETRY_AFTER_S) : undefined);

export class RelayError extends Error {
  constructor(code, message, { status, retryAfter } = {}) {
    super(message ?? code);
    this.name = "RelayError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}
// Errors that retrying cannot fix: the loop stops and emits "fatal". The relay chooses the code, so only the two that say "this
// machine is gone / not on the plan" (and the missing-WebSocket case) stop the daemon; every other code backs off and retries (L-7).
const FATAL = new Set(["device_unknown", "plan_inactive", "no_websocket"]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with full jitter, at least 1 ms. attempt starts at 0.
export function backoffDelay(attempt, { baseMs = 500, maxMs = 30_000, random = Math.random } = {}) {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.max(1, Math.floor(random() * cap));
}

async function readJson(res) {
  const text = await res.text();
  if (text === "") return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function toError(res, body) {
  const code = typeof body?.error === "string" ? safeCode(body.error) : `http_${clampInt(res.status, 0, 999)}`;
  const ra = Number.isFinite(body?.retryAfter) ? body.retryAfter : Number(res.headers?.get?.("retry-after"));
  return new RelayError(code, `relay ${clampInt(res.status, 0, 999)} ${code}`, { status: res.status, retryAfter: capRetry(ra) });
}

// POST /v1/vaults { machineSigPub } -> { vault, deviceId }. No auth (5, 6.1), so it is a plain function.
export async function createVault({ baseUrl, machineSigPubSpki, fetch: f = globalThis.fetch }) {
  const res = await f(new URL("/v1/vaults", baseUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineSigPub: b64uEncode(machineSigPubSpki) }),
  });
  const body = await readJson(res);
  if (!res.ok) throw toError(res, body);
  return body;
}

/**
 * createRelayClient({
 *   baseUrl, vault,
 *   deviceKeys: { deviceId, signingKey },   // signingKey: ECDSA P-256 private CryptoKey (MSIG)
 *   role: "machine" | "phone",              // default "machine" (the phone role exists so tests can simulate a phone)
 *   peers: { [remoteDeviceId]: { send, recv } },  // from deriveMessageKeys(..., { role }); more via addPeer()
 *   fetch, WebSocket,                       // injectable; default to the globals
 *   seqStart = 0,                           // the daemon persists seq and passes the last used value
 *   backoff: { baseMs, maxMs, random }, sleep, now, pingMs = 30000, maxHttpRetries = 3,
 * })
 */
export function createRelayClient(opts) {
  const {
    baseUrl, vault, deviceKeys, role = "machine",
    fetch: fetchImpl = globalThis.fetch, WebSocket: WS = globalThis.WebSocket,
    backoff = {}, sleep = defaultSleep, now = Date.now, pingMs = 30_000, maxHttpRetries = 3,
  } = opts;
  if (!baseUrl || !deviceKeys?.deviceId || !deviceKeys?.signingKey) throw new TypeError("createRelayClient: baseUrl and deviceKeys are required");
  if (role !== "machine" && role !== "phone") throw new TypeError("createRelayClient: bad role");
  const deviceId = deviceKeys.deviceId;
  const peers = new Map(Object.entries(opts.peers ?? {}));
  const accepts = role === "machine" ? MACHINE_ACCEPTS : PHONE_ACCEPTS;
  let seq = opts.seqStart ?? 0;
  const listeners = new Map();
  const seen = new Map();                  // envelope id -> true (bounded): catch-up and live delivery can overlap
  let lastRseq = opts.rseqStart ?? 0;
  const afterRseq = typeof opts.afterRseq === "function" ? opts.afterRseq : () => lastRseq;   // where the catch-up starts (the daemon: the lowest unhandled message)
  let ws = null, closed = true, loop = null, pausedUntil = 0, pingTimer = null, wake = null;
  let catching = false, liveBuf = [], frameChain = Promise.resolve();
  let readOnly = false, roEpisode = 0, roLast = 0, roTimer = null;
  const pendingAcks = [];
  const pushTimes = [];
  const stats = { dropped: 0, reconnects: 0, rateLimited: 0 };

  const on = (name, fn) => { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)).add(fn); return () => listeners.get(name)?.delete(fn); };
  const emit = (name, arg) => { for (const fn of [...(listeners.get(name) ?? [])]) { try { fn(arg); } catch { /* a listener must not break the client */ } } };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // `id` and `rseq` of a dropped envelope let the daemon ack it: the relay keeps an unacked item for 7 days and counts it against the caps
  const drop = (reason, from, msg) => { stats.dropped++; emit("drop", { reason, from, ...(typeof msg?.id === "string" && UUID.test(msg.id) ? { id: msg.id } : {}), ...(Number.isSafeInteger(msg?.rseq) ? { rseq: msg.rseq } : {}) }); };
  const url = (p) => new URL(p, baseUrl);
  const waitPause = async () => { const w = pausedUntil - now(); if (w > 0) await sleep(w); };

  // ---- signed HTTP (protocol 5)
  async function challenge() {
    const res = await fetchImpl(url("/v1/challenge"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId }) });
    const body = await readJson(res);
    if (!res.ok) throw toError(res, body);
    if (typeof body.nonce !== "string") throw new RelayError("bad_response", "challenge without nonce");
    return body.nonce;
  }

  async function signedOnce(method, pathAndQuery, bodyText) {
    const nonce = await challenge();
    const msg = enc.encode(`eleven/v1/auth\n${method}\n${pathAndQuery}\n${nonce}\n${await H(enc.encode(bodyText ?? ""))}`);
    // WebCrypto ECDSA output is IEEE P1363 (r||s, 64 bytes). See "Proposed spec changes" in the report.
    const sig = b64uEncode(new Uint8Array(await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, deviceKeys.signingKey, msg)));
    const headers = { authorization: `Eleven-Sig dev=${deviceId}, nonce=${nonce}, sig=${sig}` };
    if (bodyText !== undefined) headers["content-type"] = "application/json";
    return fetchImpl(url(pathAndQuery), { method, headers, body: bodyText });
  }

  async function rateWait(err, attempt) {
    stats.rateLimited++;
    const ms = Math.max((err.retryAfter ?? 0) * 1000, backoffDelay(attempt, backoff));
    emit("rate_limited", { retryAfter: err.retryAfter, waitMs: ms });
    await sleep(ms);
  }

  // 429 / 503 read_only -> wait max(retryAfter, backoff) and retry; 401 auth_failed -> one retry with a fresh nonce.
  async function request(method, pathAndQuery, body) {
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    if (bodyText !== undefined && enc.encode(bodyText).length > LIMITS.envelopeBytes) throw new RelayError("too_large", "request body over the 1.1 MB limit");
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      await waitPause();
      let res;
      try { res = await signedOnce(method, pathAndQuery, bodyText); }
      catch (e) {
        if (e instanceof RelayError) {
          if (e.code === "rate_limited" && attempt < maxHttpRetries) { await rateWait(e, attempt); continue; }
          throw e;
        }
        throw new RelayError("network", String(e?.message ?? e));
      }
      const data = await readJson(res);
      if (res.ok) return data;
      const err = toError(res, data);
      if (err.code === "auth_failed" && !authRetried) { authRetried = true; continue; }
      if ((err.code === "rate_limited" || err.code === "read_only") && attempt < maxHttpRetries) { await rateWait(err, attempt); continue; }
      throw err;
    }
  }

  // ---- endpoints (12)
  const v = () => `/v1/vault/${encodeURIComponent(vault)}`;
  const api = {
    wsTicket: async () => {
      const t = (await request("POST", `${v()}/ws-ticket`)).ticket;          // signed, empty body
      if (typeof t !== "string" || t === "") throw new RelayError("bad_response", "ws-ticket without a ticket");
      return t;
    },
    /** One page of GET .../inbox?after=&limit= -> { messages, next? } (`next` only when more exist). */
    inboxPage: async (after = 0, limit = 100) => {
      const r = await request("GET", `${v()}/inbox?after=${clampInt(after, 0, Number.MAX_SAFE_INTEGER)}&limit=${clampInt(limit, 1, 500)}`);
      return { messages: Array.isArray(r.messages) ? r.messages : [], ...(Number.isSafeInteger(r.next) ? { next: r.next } : {}) };
    },
    /** The WHOLE inbox after `after`: follows `next` until it is absent (L-9). A relay that does not move forward is an error. */
    inbox: async (after = lastRseq) => {
      const out = [];
      let cur = clampInt(after, 0, Number.MAX_SAFE_INTEGER);
      for (let page = 0; page < 1000; page++) {
        const r = await api.inboxPage(cur, 100);
        out.push(...r.messages);
        if (r.next === undefined) return out;
        if (r.next <= cur || !r.messages.length) throw new RelayError("bad_response", "the inbox did not move forward");
        cur = r.next;
        if (out.length > 50_000) throw new RelayError("bad_response", "the inbox is unreasonably large");
      }
      throw new RelayError("bad_response", "the inbox has too many pages");
    },
    devices: async () => (await request("GET", `${v()}/devices`)).devices ?? [],
    revokeDevice: (dev) => request("DELETE", `${v()}/devices/${encodeURIComponent(dev)}`),
    /** DELETE /v1/vault/:vault, signed by the machine (`eleven-sync unpair --all`). */
    deleteVault: () => request("DELETE", v()),
    // POST /v1/pair, signed, empty body (6.2 step 1) -> { pairingId, expires, wsTicket }. The ticket opens the machine pairing socket.
    startPairing: () => request("POST", "/v1/pair"),
  };

  // ---- WebSocket plumbing
  function wsUrl(path, ticket) {
    const u = url(path);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("ticket", ticket);
    return u.toString();
  }

  function openSocket(path, ticket, onFrame) {
    if (typeof WS !== "function") throw new RelayError("no_websocket", "no WebSocket: Node 22+ has one, or inject { WebSocket }");
    return new Promise((resolve, reject) => {
      const s = new WS(wsUrl(path, ticket));
      let opened = false;
      s.onopen = () => { opened = true; resolve(s); };
      s.onmessage = (ev) => {
        try {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data);
        if (data.length > LIMITS.envelopeBytes * 2) return drop("frame_too_large");
        let msg; try { msg = JSON.parse(data); } catch { return drop("bad_json"); }
        if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return drop("bad_frame");
        onFrame(msg, s);
        } catch { drop("handler_error"); }     // no hostile frame can throw out of the socket's event handler (L-14)
      };
      s.onerror = () => { if (!opened) reject(new RelayError("network", "websocket handshake failed")); };
      s.onclose = (ev) => { if (!opened) reject(new RelayError("network", "websocket closed before open")); else s.__onclose?.(ev); };
    });
  }

  const sendFrame = (obj) => {
    const text = JSON.stringify(obj);
    if (enc.encode(text).length > LIMITS.envelopeBytes) throw new RelayError("too_large", "message over the 1.1 MB envelope limit");
    if (!ws || ws.readyState !== 1) throw new RelayError("not_connected", "websocket is not open");
    ws.send(text);
  };

  // ---- kill switch (contract section 11): HTTP 503 read_only or a read_only error frame. Sending stops (the local state is kept), the
  // condition is reported once, and the connection is retried later with a growing delay; the catch-up then replays what was not handled.
  const roDelay = (n) => backoffDelay(n, { baseMs: 5_000, maxMs: 300_000, ...backoff });
  function noteReadOnly() {
    const t = now();
    if (t - roLast > 600_000) roEpisode = 0;
    roLast = t;
    const attempt = roEpisode++;
    readOnly = true;
    emit("read_only", { first: attempt === 0, attempt });
    if (roTimer || closed) return;
    roTimer = setTimeout(() => {
      roTimer = null; readOnly = false;                 // optimistic: the next send tells; a reconnect re-reads the inbox
      const s = ws;
      if (s && !closed) { try { s.close(); } catch { /* closed */ } }
    }, roDelay(attempt));
    roTimer.unref?.();
  }

  // hints are handled at once and are never proof (1); what reaches listeners is cleaned and bounded (L-7)
  function handleHint(msg) {
    if (msg.type === "pong") return;
    if (msg.type === "error") {
      const code = safeCode(msg.error), id = typeof msg.id === "string" && msg.id.length <= 64 ? msg.id : undefined;
      if (code === "rate_limited") {
        stats.rateLimited++;
        const secs = capRetry(Number(msg.retryAfter)) ?? 1;
        pausedUntil = now() + secs * 1000;
        emit("rate_limited", { retryAfter: secs, waitMs: secs * 1000 });
      } else if (code === "read_only") noteReadOnly();
      if (id) emit("send_failed", { id, error: code });
      return emit("hint", { type: "error", error: code, ...(id ? { id } : {}) });
    }
    if (msg.type === "device_revoked") return emit("hint", { type: "device_revoked", deviceId: clean(msg.deviceId, 64) });
    if (msg.type === "push_stale") return emit("hint", { type: "push_stale", subId: clean(msg.subId, 64) });
    return emit("hint", { type: msg.type });
  }

  // validate, open and track one envelope -> an event, or null when it is dropped. `catchup`: the message came from the inbox, so a
  // copy we already saw (and did not finish) is wanted again, and nothing is remembered as "seen".
  async function decode(msg, { catchup = false } = {}) {
    if (typeof msg.type !== "string" || !accepts.has(msg.type)) return drop("type_not_accepted", msg.from, msg), null;
    if (msg.vault !== vault) return drop("wrong_vault", msg.from, msg), null;
    const peer = peers.get(msg.from);
    if (!peer) return drop("unknown_peer", msg.from, msg), null;
    if (typeof msg.id !== "string") return drop("bad_envelope", msg.from, msg), null;
    if (!catchup && seen.has(msg.id)) return null;
    let inner;
    try { inner = await open(msg, peer.recv, { vault, from: msg.from, to: role === "machine" ? "machine" : deviceId }); }
    catch (e) {
      emit("decrypt_failed", { from: msg.from, code: e instanceof ProtocolError ? e.code : "error" });   // 4.4: counted, never answered
      return drop("decrypt_failed", msg.from, msg), null;
    }
    if (!catchup) { seen.set(msg.id, true); if (seen.size > 5000) seen.delete(seen.keys().next().value); }
    if (Number.isSafeInteger(msg.rseq) && msg.rseq > lastRseq) lastRseq = msg.rseq;
    return { envelope: msg, inner, from: msg.from, id: msg.id, type: msg.type, rseq: msg.rseq };
  }

  // frames are processed one at a time in arrival order (decrypting a big frame must not let a small later one overtake it)
  function onSocketFrame(msg) {
    if (HINTS.has(msg.type)) return handleHint(msg);
    if (catching) { liveBuf.push(msg); return; }          // queued until the catch-up batch is done, so nothing is applied out of order
    frameChain = frameChain.then(async () => { const ev = await decode(msg); if (ev) emit("message", ev); }).catch(() => drop("handler_error"));
  }

  async function connectOnce() {
    const ticket = await api.wsTicket();                                  // a new single-use ticket per connection
    catching = true; liveBuf = [];
    const s = await openSocket(`${v()}/ws`, ticket, onSocketFrame);
    ws = s;
    s.__onclose = () => { if (ws === s) ws = null; clearInterval(pingTimer); emit("close"); wake?.(); };
    clearInterval(pingTimer);
    if (pingMs > 0) { pingTimer = setInterval(() => { try { sendFrame({ type: "ping" }); } catch { /* reconnect handles it */ } }, pingMs); pingTimer.unref?.(); }
    try {
      while (pendingAcks.length) sendFrame({ type: "ack", ids: pendingAcks.splice(0, 100) });
      // catch up on what arrived while we were away: the WHOLE inbox (M-B, L-9), decoded, then handed over as ONE batch
      const batch = [];
      for (const m of await api.inbox(afterRseq())) { if (m !== null && typeof m === "object") { const ev = await decode(m, { catchup: true }); if (ev) batch.push(ev); } }
      // live frames that arrived meanwhile join the batch (L-11), so a cancel that came live still sorts before its action
      const have = new Set(batch.map((e) => e.id));
      while (liveBuf.length) {
        const live = liveBuf; liveBuf = [];
        for (const m of live) if (!(typeof m.id === "string" && have.has(m.id))) { const ev = await decode(m); if (ev) { have.add(ev.id); batch.push(ev); } }
      }
      catching = false;
      if (listeners.get("batch")?.size) emit("batch", batch);
      else for (const ev of batch) emit("message", ev);
    } catch (e) { catching = false; liveBuf = []; if (ws === s) ws = null; try { s.close(); } catch { /* closed */ } throw e; }
    emit("open");
    return s;
  }

  async function run() {
    let attempt = 0;
    while (!closed) {
      try {
        await waitPause();
        const s = await connectOnce();
        attempt = 0;
        if (ws === s) await new Promise((r) => { wake = r; });            // until the socket closes
        wake = null;
        if (closed) break;
        stats.reconnects++;
        await sleep(backoffDelay(0, backoff));
      } catch (e) {
        if (closed) break;
        const err = e instanceof RelayError ? e : new RelayError("network", clean(e?.message ?? e));
        if (err.code === "read_only") { noteReadOnly(); await sleep(roDelay(Math.max(0, roEpisode - 1))); continue; }
        emit("error", err);
        if (FATAL.has(err.code)) { closed = true; emit("fatal", err); break; }
        if (err.code === "rate_limited") { await rateWait(err, attempt++); continue; }
        await sleep(backoffDelay(attempt++, backoff));
      }
    }
  }

  // ---- public API
  const client = {
    deviceId, vault, stats,
    on,
    get lastSeq() { return seq; },
    get lastRseq() { return lastRseq; },
    get connected() { return !!ws && ws.readyState === 1; },
    get readOnly() { return readOnly; },
    addPeer(id, keys) { peers.set(id, keys); },
    removePeer(id) { peers.delete(id); },
    ...api,
    /** A signed request to any path of the relay: request(method, pathAndQuery, bodyObject?) -> parsed JSON, or throws RelayError. */
    request,

    /** Start the connect/reconnect loop. Resolves when the first connection is open, rejects on a fatal error. */
    connect() {
      if (!closed) return loop.first;
      closed = false;
      const first = new Promise((resolve, reject) => {
        const off = () => { offOpen(); offFatal(); };
        const offOpen = on("open", () => { off(); resolve(); });
        const offFatal = on("fatal", (e) => { off(); reject(e); });
      });
      first.catch(() => {});
      loop = { first, done: run() };
      return first;
    },
    async close() {
      closed = true; clearInterval(pingTimer); clearTimeout(roTimer); roTimer = null;
      const s = ws; ws = null;
      try { s?.close(); } catch { /* already closed */ }
      wake?.();
      await loop?.done;
    },

    /**
     * Seal and send one message. `to` is the remote deviceId (its keys must be registered with addPeer).
     * type: outer type; inner: { t, ...body } (seq defaults to the next counter value). Returns the envelope id.
     */
    async send(type, to, inner, { fid } = {}) {
      const peer = peers.get(to);
      if (!peer) throw new RelayError("unknown_peer", "no keys for that device");
      if (readOnly) throw new RelayError("read_only", "the relay is read-only; nothing is sent");
      await waitPause();
      if (inner.seq !== undefined && inner.seq > seq) seq = inner.seq;
      const body = { ...inner, seq: inner.seq ?? ++seq };
      const env = await seal({ type, vault, from: deviceId, to: role === "machine" ? to : "machine", ...(fid !== undefined ? { fid } : {}) }, body, peer.send);
      sendFrame(env);                                // throws too_large / not_connected before anything leaves the machine
      return env.id;
    },
    /** `gone { fid }` has no ciphertext (13.1) but a nonce, and a real phone as `to` (the relay deletes the file for every device). */
    async sendGone(fid, to) {
      if (typeof fid !== "string" || fid === "") throw new TypeError("sendGone: fid");
      if (typeof to !== "string" || to === "") throw new TypeError("sendGone: to must be a phone device id");
      if (readOnly) throw new RelayError("read_only", "the relay is read-only; nothing is sent");
      await waitPause();
      sendFrame({ v: 1, type: "gone", vault, from: deviceId, to, id: globalThis.crypto.randomUUID(), ts: now(), epoch: 0, fid, n: b64uEncode(globalThis.crypto.getRandomValues(new Uint8Array(12))) });
    },
    /** `push`: { to, subId, bodyBytes (RFC 8291), topic }. Limits (14): body <= 4096 bytes, 30 per hour, 200 per day. */
    async sendPush({ to, subId, bodyBytes, topic }) {
      if (!(bodyBytes instanceof Uint8Array)) throw new TypeError("sendPush: bodyBytes");
      if (bodyBytes.length > LIMITS.pushBodyBytes) throw new RelayError("too_large", "push body over 4096 bytes");
      const t = now();
      while (pushTimes.length && t - pushTimes[0] > 86_400_000) pushTimes.shift();
      if (pushTimes.length >= LIMITS.pushPerDay) throw new RelayError("rate_limited", "push: 200 per day", { retryAfter: Math.ceil((pushTimes[0] + 86_400_000 - t) / 1000) });
      if (pushTimes.filter((x) => t - x <= 3_600_000).length >= LIMITS.pushPerHour) throw new RelayError("rate_limited", "push: 30 per hour");
      if (readOnly) throw new RelayError("read_only", "the relay is read-only; nothing is sent");
      await waitPause();
      sendFrame({ v: 1, type: "push", vault, from: deviceId, to, id: globalThis.crypto.randomUUID(), ts: t, epoch: 0, subId, topic, urgency: "high", ttl: 86400, body: b64uEncode(bodyBytes) });
      pushTimes.push(t);
    },
    /** `ack { ids }`. Queued if the socket is down and sent on the next open. */
    ack(ids) {
      const list = [...ids].filter((x) => typeof x === "string");
      if (!list.length) return;
      if (!client.connected || readOnly) { pendingAcks.push(...list); return; }
      for (let i = 0; i < list.length; i += 100) sendFrame({ type: "ack", ids: list.slice(i, i + 100) });
    },

    /**
     * Pairing channel (6.2 steps 1 and 5): WS /v1/pair/:id/machine?ticket=<wsTicket>. The ticket is opaque.
     * The relay sends one claim frame { t: "claim", sealed, relayAccountId, relayEmailMasked, deviceId, phoneAuthPub } and the machine
     * answers with ONE frame: { t: "accept", sealed, mode } or { t: "refuse" }.
     * Result frames: { t: "accepted" } | { t: "refused" } | { t: "error", code }; the relay then closes the socket.
     */
    async openPairing(pairingId, wsTicket) {
      if (typeof wsTicket !== "string" || wsTicket === "") throw new TypeError("openPairing: wsTicket");
      const claimFns = new Set(), resultFns = new Set(), closeFns = new Set();
      const s = await openSocket(`/v1/pair/${encodeURIComponent(pairingId)}/machine`, wsTicket, (m) => {
        if (m.t === "accepted" || m.t === "refused" || m.t === "error") { for (const fn of resultFns) fn(m); return; }
        if (m.t === "claim" && typeof m.sealed === "string") for (const fn of claimFns) fn(m);
      });
      s.__onclose = () => { for (const fn of closeFns) fn(); };
      const send = (o) => s.send(JSON.stringify(o));
      return {
        onClaim(fn) { claimFns.add(fn); },
        onResult(fn) { resultFns.add(fn); },
        onClose(fn) { closeFns.add(fn); },
        accept(sealed, mode) {
          if (mode !== "write" && mode !== "read") throw new TypeError('accept: mode is "write" or "read"');
          send({ t: "accept", sealed, mode });
        },
        refuse() { send({ t: "refuse" }); },
        close() { try { s.close(); } catch { /* closed */ } },
      };
    },
  };
  return client;
}
