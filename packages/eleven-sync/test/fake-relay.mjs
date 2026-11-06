// A TEST double of the eleven relay (protocol 5, 12, 13, 14), aligned with the relay wire contract (slices A-H). In memory, node:http
// only, 127.0.0.1 on a random port.
// It validates the way the real relay should: bad signatures, replayed nonces, reused tickets, oversized bodies and unknown
// devices are refused. It never decrypts anything (it has no keys). Not for production.
import http from "node:http";
import crypto from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
const MAX_BODY = 1_153_433;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const rid = (prefix, n = 16) => prefix + b64u(crypto.randomBytes(n)).slice(0, 22);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---- minimal RFC 6455 server side: text frames, fragmentation, ping/pong, close
function frame(opcode, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let h;
  if (p.length < 126) h = Buffer.from([0x80 | opcode, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}

class Conn {
  constructor(socket, onText, onClose) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.parts = []; this.dead = false;
    socket.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(onText); });
    socket.on("close", () => { this.dead = true; onClose(); });
    socket.on("error", () => socket.destroy());
  }
  parse(onText) {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (!masked) return this.close(1002);                    // clients MUST mask
      if (len > MAX_BODY * 2) return this.close(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) return this.close(1000);
      if (op === 9) { this.socket.write(frame(10, data)); continue; }
      if (op === 10) continue;
      if (op === 2) { onText(null); continue; }               // a binary frame: handlers decide (the vault socket answers bad_request)
      if (op === 1 || op === 0) {
        this.parts.push(data);
        if (fin) { const t = Buffer.concat(this.parts).toString("utf8"); this.parts = []; onText(t); }
      }
    }
  }
  send(text) { if (!this.dead) this.socket.write(frame(1, text)); }
  close(code = 1000) {
    if (this.dead) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    try { this.socket.end(frame(8, p)); } catch { /* gone */ }
    setTimeout(() => this.socket.destroy(), 50).unref();
  }
  drop() { this.socket.destroy(); }                          // abrupt, no close frame
}
// ---- shapes from the contract (sections 6, 9, 10)
const ENV_KEYS = new Set(["v", "type", "vault", "from", "to", "id", "ts", "epoch", "fid", "n", "ct"]);
const PUSH_KEYS = new Set(["v", "type", "vault", "from", "to", "id", "ts", "epoch", "subId", "body", "topic", "urgency", "ttl"]);
const MACHINE_TYPES = new Set(["hello", "manifest", "delta", "file", "gone", "tick", "result"]);
const PHONE_TYPES = new Set(["req", "action"]);
const FID = /^[A-Za-z0-9_-]{22}$/, B64U = /^[A-Za-z0-9_-]+$/, DEV = /^dev_[A-Za-z0-9_-]{22}$/;
const PUSH_HOST = /^(?:[a-z0-9-]+\.)+push\.apple\.com$|^fcm\.googleapis\.com$|^updates\.push\.services\.mozilla\.com$|^(?:[a-z0-9-]+\.)+notify\.windows\.com$/i;
const MESSAGES = { bad_request: "bad request", forbidden: "not allowed", not_found: "not found", too_large: "too large", rate_limited: "rate limited", read_only: "the relay is read-only", device_unknown: "device unknown", plan_inactive: "plan inactive", internal: "internal error" };

const MAX_VAULTS_PER_ACCOUNT = 20, MAX_ACTIONS_PER_PHONE = 40;
export async function startFakeRelay({ ticketMs = 30_000, nonceMs = 60_000, pairTtlMs = 300_000, longPollMs = 1000, phoneStoredCap = 20 * 1024 * 1024 } = {}) {
  const hmacKey = crypto.randomBytes(32);
  const mac = (...parts) => crypto.createHmac("sha256", hmacKey).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
  const vaults = new Map();        // vault -> { devices: Map(id -> {role, mode, pub, createdAt, push, revoked}), queue: Map(deviceId -> []), rseq, conns: Map(deviceId -> Conn), seenIds: Set, machineSeen }
  const usedNonces = new Set();
  const tickets = new Map();       // ticket -> { kind, vault, dev, pairingId?, exp, used }
  const pairings = new Map();      // pairingId -> { vault, exp, state: open|claimed|accepted|refused|failed, conn, claim, replySealed, waiters, timer }
  const accounts = new Map();     // bearer token -> { id, email }
  const stats = { authFailures: 0, ticketReuse: 0, tooLarge: 0, framesRejected: 0, challenges: 0, duplicates: 0, readOnlyRefusals: 0, inboxPages: 0, pings: 0, pingsOther: 0, revokeRepeats: 0 };
  const log = [];                  // every byte the relay stored or forwarded, as text (to assert it never sees plaintext)
  const pushes = [];
  const errors = [];               // every error frame sent on a vault socket: { dev, error, id }
  const hooks = { claimFrame: null, rateLimit: null, readOnly: false, inboxDelayMs: 0, pushService: 201 };   // rateLimit: { count, retryAfter, where: "http"|"ws"|"upgrade", match? }
  const conns = new Set();

  const json = (res, status, obj) => { const t = JSON.stringify(obj); res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(t); };
  const err = (res, status, error, extra = {}) => json(res, status, { error, ...extra });

  function takeRateLimit(where, path) {
    const r = hooks.rateLimit;
    if (!r || r.where !== where || (r.match && !r.match.test(path)) || r.count <= 0) return null;
    r.count--;
    return r;
  }

  // Over the limit: read and discard the rest of the body first (a fake can afford it), then answer 413 and close. Answering
  // while the client is still uploading makes the client see ECONNRESET instead of the response (a flaky test).
  async function readBody(req, res) {
    const chunks = []; let n = 0, over = false;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) { over = true; chunks.length = 0; } else if (!over) chunks.push(c);
    }
    if (over) { stats.tooLarge++; res.setHeader("connection", "close"); err(res, 413, "too_large"); return null; }
    return Buffer.concat(chunks);
  }

  // 5: Authorization: Eleven-Sig dev=, nonce=, sig= over "eleven/v1/auth\nMETHOD\nPATH_AND_QUERY\nnonce\nH(body or "")"
  function verifySig(req, body) {
    const h = req.headers.authorization ?? "";
    const m = /^Eleven-Sig dev=([\w-]+), nonce=([\w-]+), sig=([\w-]+)$/.exec(h);
    if (!m) return { status: 401, error: "auth_failed" };
    const [, dev, nonce, sig] = m;
    const raw = unb64u(nonce);
    if (raw.length !== 16 + 8 + 32) return { status: 401, error: "auth_failed" };
    const rand = raw.subarray(0, 16), expB = raw.subarray(16, 24), tag = raw.subarray(24);
    const want = mac(dev, rand, expB);
    if (!crypto.timingSafeEqual(tag, want)) return { status: 401, error: "auth_failed" };
    if (Number(expB.readBigUInt64BE()) < Date.now()) return { status: 401, error: "auth_failed" };
    if (usedNonces.has(nonce)) return { status: 401, error: "auth_failed" };
    const found = findDevice(dev);
    if (!found) return { status: 401, error: "device_unknown" };
    if (found.dev.revoked) return { status: 401, error: "device_unknown" };
    const bodyHash = b64u(crypto.createHash("sha256").update(body.length ? body : "").digest());
    const msg = Buffer.from(`eleven/v1/auth\n${req.method}\n${req.url}\n${nonce}\n${bodyHash}`);
    const ok = crypto.verify("sha256", msg, { key: found.dev.pub, dsaEncoding: "ieee-p1363" }, unb64u(sig));
    if (!ok) return { status: 401, error: "auth_failed" };
    usedNonces.add(nonce);       // a nonce works once
    return { dev, vault: found.vault, role: found.dev.role };
  }

  function findDevice(id) {
    for (const [name, v] of vaults) { const d = v.devices.get(id); if (d) return { vault: name, dev: d }; }
    return null;
  }

  function mkTicket(kind, extra) {
    const rand = crypto.randomBytes(16);
    const exp = Buffer.alloc(8); exp.writeBigUInt64BE(BigInt(Date.now() + ticketMs));
    const t = b64u(Buffer.concat([rand, exp, mac("ticket", rand, exp)]));
    tickets.set(t, { kind, exp: Date.now() + ticketMs, used: false, ...extra });
    return t;
  }

  const machineOf = (v) => [...v.devices].find(([, d]) => d.role === "machine")?.[0];
  const livePhone = (v, id) => { const d = v.devices.get(id); return d && d.role === "phone" && !d.revoked; };

  // Storage per recipient (contract section 6): hello/manifest latest, delta <= 100 after the latest manifest, file latest per fid,
  // tick live only, result/req/action queued. Returns the stored record (with rseq), or the envelope itself for a live-only tick.
  function store(v, toDev, env) {
    if (env.type === "tick") return env;                       // live only, delivered without rseq
    v.rseq += 1;
    const rec = { ...env, rseq: v.rseq };
    log.push(JSON.stringify(rec));
    if (!v.queue.has(toDev)) v.queue.set(toDev, []);
    const q = v.queue.get(toDev);
    const drop = (pred) => { for (let i = q.length - 1; i >= 0; i--) if (pred(q[i])) q.splice(i, 1); };
    if (env.type === "hello") drop((x) => x.type === "hello");
    if (env.type === "file") drop((x) => x.type === "file" && x.fid === env.fid);
    if (env.type === "manifest") drop((x) => x.type === "manifest" || x.type === "delta");
    q.push(rec);
    if (env.type === "delta") { const ds = q.filter((x) => x.type === "delta"); if (ds.length > 100) q.splice(q.indexOf(ds[0]), 1); }
    return rec;
  }

  // ---- pairing session helpers (6.2)
  function deliverClaim(pr) {
    if (!pr.conn || !pr.claim || pr.claim.delivered) return;
    pr.claim.delivered = true;
    const c = pr.claim;
    const frame = { t: "claim", sealed: c.sealed, relayAccountId: c.account.id, relayEmailMasked: c.account.masked, deviceId: c.deviceId, phoneAuthPub: c.phoneAuthPub };
    pr.conn.send(JSON.stringify(hooks.claimFrame ? hooks.claimFrame(frame) : frame));
  }
  function replyOf(pr) {
    if (pr.exp < Date.now()) return { status: 410, error: "pairing_expired" };
    if (pr.state === "accepted") return { sealed: pr.replySealed };
    if (pr.state === "refused") return { status: 409, error: "refused" };
    return null;
  }
  function wakePair(pr) { for (const w of pr.waiters.splice(0)) w(); }
  function onPairFrame(pr, conn, text) {
    const say = (o) => conn.send(JSON.stringify(o));
    if (text === null || text.length > 16_384) return conn.close(1009);
    let m; try { m = JSON.parse(text); } catch { return conn.close(1008); }
    if (m === null || typeof m !== "object" || Array.isArray(m)) return say({ t: "error", code: "bad_request" });   // a non-object frame: an error, the socket stays open
    if (pr.exp < Date.now()) { say({ t: "error", code: "pairing_expired" }); return conn.close(1000); }
    if (hooks.readOnly) { stats.readOnlyRefusals++; return say({ t: "error", code: "read_only" }); }   // the vault stays pending; the claim is not burned
    if (pr.state !== "claimed" || m === null || typeof m !== "object") return say({ t: "error", code: "bad_request" });
    if (m.t === "refuse") { pr.state = "refused"; wakePair(pr); say({ t: "refused" }); return conn.close(1000); }
    if (m.t !== "accept" || typeof m.sealed !== "string" || !/^[A-Za-z0-9_-]{1,8192}$/.test(m.sealed) || (m.mode !== "write" && m.mode !== "read")) return say({ t: "error", code: "bad_request" });
    const bound = [...vaults.values()].filter((x) => x.account === pr.claim.account.id).length;
    const v = vaults.get(pr.vault);
    if (v.account !== pr.claim.account.id && bound >= MAX_VAULTS_PER_ACCOUNT) return say({ t: "error", code: "forbidden" });   // a 21st vault for the account (contract 14)
    v.account = pr.claim.account.id;
    pr.state = "accepted"; pr.replySealed = m.sealed;
    v.devices.set(pr.claim.deviceId, { role: "phone", mode: m.mode, createdAt: Date.now(), push: null, pub: crypto.createPublicKey({ key: unb64u(pr.claim.phoneAuthPub), format: "der", type: "spki" }) });
    wakePair(pr);
    say({ t: "accepted" });
    conn.close(1000);
  }

  // ---- WS frames from a vault device (contract section 6). The first failing check is the answer; nothing is stored.
  const pushTimes = new Map();      // vault -> [ms]
  function onVaultFrame(vname, devId, conn, text) {
    const v = vaults.get(vname); if (!v) return;
    const me = v.devices.get(devId);
    let m = null;
    const wellId = () => (typeof m?.id === "string" && UUID_V4.test(m.id) ? m.id : undefined);
    const fail = (error) => { stats.framesRejected++; const id = wellId(); errors.push({ dev: devId, error, id }); conn.send(JSON.stringify({ type: "error", error, ...(id ? { id } : {}), message: MESSAGES[error] ?? "error" })); };
    v.badFrames ??= new Map();
    const badFrame = () => { fail("bad_request"); const n = (v.badFrames.get(conn) ?? 0) + 1; v.badFrames.set(conn, n); if (n >= 3) conn.close(1008); };
    if (text === null) return badFrame();                                          // binary frame
    if (text === '{"type":"ping"}') { stats.pings++; return conn.send('{"type":"pong"}'); }   // answered by the runtime, exact string only
    log.push(text);
    if (Buffer.byteLength(text) > MAX_BODY) return fail("too_large");
    try { m = JSON.parse(text); } catch { return badFrame(); }
    if (m === null || typeof m !== "object" || Array.isArray(m) || typeof m.type !== "string") return badFrame();
    if (m.type === "ping") { stats.pingsOther++; return conn.send('{"type":"pong"}'); }
    const rl = takeRateLimit("ws", "frame");
    if (rl) return fail("rate_limited");
    if (hooks.readOnly) { stats.readOnlyRefusals++; return fail("read_only"); }    // every envelope, push and ack
    if (me.revoked) { fail("device_unknown"); return conn.close(1008); }    // a frame from a phone that is being revoked: device_unknown, then closed
    if (m.type === "ack") {
      if (Object.keys(m).some((k) => k !== "type" && k !== "ids") || !Array.isArray(m.ids) || m.ids.length < 1 || m.ids.length > 100 || !m.ids.every((x) => typeof x === "string" && UUID_V4.test(x))) return fail("bad_request");
      const q = v.queue.get(devId) ?? [];
      v.queue.set(devId, q.filter((x) => !(m.ids.includes(x.id) && ["result", "req", "action"].includes(x.type))));   // only queued items addressed to the acking device
      return;
    }
    // 1. version
    if (m.v !== 1) return fail("bad_request");
    // 2. type and role
    const known = MACHINE_TYPES.has(m.type) || PHONE_TYPES.has(m.type) || m.type === "push";
    if (!known) return fail("bad_request");
    const allowed = me.role === "machine" ? (MACHINE_TYPES.has(m.type) || m.type === "push") : PHONE_TYPES.has(m.type);
    if (!allowed) return fail("forbidden");
    // 3. keys
    const keys = m.type === "push" ? PUSH_KEYS : ENV_KEYS;
    if (Object.keys(m).some((k) => !keys.has(k))) return fail("bad_request");
    // 4. vault and from
    if (typeof m.vault !== "string" || !/^vlt_[\w-]{22}$/.test(m.vault) || typeof m.from !== "string" || !DEV.test(m.from)) return fail("bad_request");
    if (m.vault !== vname || m.from !== devId) return fail("forbidden");
    // 5. id, ts, epoch
    if (typeof m.id !== "string" || !UUID_V4.test(m.id) || !Number.isSafeInteger(m.ts) || m.ts < 0 || m.epoch !== 0) return fail("bad_request");
    // 6. to
    let target;
    if (me.role === "phone") { if (m.to !== "machine") return fail("bad_request"); target = machineOf(v); }
    else {
      if (typeof m.to !== "string" || !DEV.test(m.to)) return fail("bad_request");
      if (!livePhone(v, m.to)) return fail("forbidden");
      target = m.to;
    }
    if (m.type === "push") return onPush(v, vname, devId, conn, m, fail);
    // 7. fid and n
    const needsFid = m.type === "file" || m.type === "gone";
    if (needsFid ? (typeof m.fid !== "string" || !FID.test(m.fid)) : "fid" in m) return fail("bad_request");
    if (typeof m.n !== "string" || !B64U.test(m.n) || Buffer.from(m.n, "base64url").length !== 12) return fail("bad_request");
    // 8. ct
    if (m.type === "gone") { if ("ct" in m) return fail("bad_request"); }
    else if (typeof m.ct !== "string" || !B64U.test(m.ct) || Buffer.from(m.ct, "base64url").length < 16) return fail("bad_request");
    // 9. dedupe on (from, id): silent
    const dk = `${m.from}|${m.id}`;
    if (v.seenIds.has(dk)) { stats.duplicates++; return; }
    if (m.type === "action" && (v.queue.get(target) ?? []).filter((x) => x.type === "action").length >= 100) return fail("rate_limited");
    if (me.role === "phone") {                                                       // per-phone caps in a vault (contract 14): 40 queued actions, 20 MiB stored
      const mine = (v.queue.get(target) ?? []).filter((x) => x.from === devId);
      if (m.type === "action" && mine.filter((x) => x.type === "action").length >= MAX_ACTIONS_PER_PHONE) return fail("rate_limited");
      if (mine.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x)), 0) + Buffer.byteLength(text) > phoneStoredCap) return fail("too_large");
    }
    v.seenIds.add(dk);
    if (m.type === "gone") { for (const q of v.queue.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i].type === "file" && q[i].fid === m.fid) q.splice(i, 1); return; }   // never stored, never delivered
    if (me.role === "machine") v.machineSeen = Date.now();
    const rec = store(v, target, m);
    v.conns.get(target)?.send(JSON.stringify(rec));
  }

  function onPush(v, vname, devId, conn, m, fail) {
    if (typeof m.subId !== "string" || m.subId.length !== 22 || !B64U.test(m.subId) || typeof m.body !== "string" || !B64U.test(m.body) || typeof m.topic !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(m.topic)
      || !["very-low", "low", "normal", "high"].includes(m.urgency) || !Number.isInteger(m.ttl) || m.ttl < 0 || m.ttl > 86_400) return fail("bad_request");
    const bytes = Buffer.from(m.body, "base64url");
    if (bytes.length < 1 || bytes.length > 4096) return fail("bad_request");
    const phone = v.devices.get(m.to);
    if (phone.push?.subId !== m.subId) { conn.send(JSON.stringify({ type: "push_stale", subId: m.subId })); return; }
    const dk = `${m.from}|${m.id}`;
    if (v.seenIds.has(dk)) { stats.duplicates++; return; }
    const now = Date.now(), times = (pushTimes.get(vname) ?? []).filter((t) => now - t < 86_400_000);
    pushTimes.set(vname, times);
    if (times.length >= 200 || times.filter((t) => now - t < 3_600_000).length >= 30) return fail("rate_limited");
    v.seenIds.add(dk); times.push(now);
    if (hooks.pushService === 404 || hooks.pushService === 410) { phone.push = null; conn.send(JSON.stringify({ type: "push_stale", subId: m.subId })); return; }
    pushes.push({ to: m.to, subId: m.subId, topic: m.topic, urgency: m.urgency, ttl: m.ttl, bytes: bytes.length, body: m.body, id: m.id, endpoint: phone.push.endpoint });
  }

  // ---- revocation and deletion (contract section 9)
  function revoke(v, vname, dev) {
    const d = v.devices.get(dev);
    d.revoked = true; d.push = null;
    v.queue.delete(dev);
    for (const q of v.queue.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i].from === dev) q.splice(i, 1);
    const note = JSON.stringify({ type: "device_revoked", deviceId: dev });
    const pc = v.conns.get(dev);
    if (pc) { pc.send(note); pc.close(1008); }
    v.conns.get(machineOf(v))?.send(note);
  }
  function deleteVault(vname) {
    const v = vaults.get(vname);
    for (const [id, c] of v.conns) { c.send(JSON.stringify({ type: "device_revoked", deviceId: id })); c.close(1008); }
    vaults.delete(vname);
  }
  const presenceFor = (v) => JSON.stringify({ type: "presence", machine: v.conns.has(machineOf(v)) || (v.machineSeen && Date.now() - v.machineSeen < 90_000) ? "online" : "offline", lastSeen: v.machineSeen ?? 0 });

  // ---- HTTP
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    try {
      // kill switch (section 11): every non-GET answers 503 before auth or parsing, except challenge, ws-ticket and refresh
      if (hooks.readOnly && req.method !== "GET" && req.method !== "OPTIONS" && !(req.method === "POST" && (p === "/v1/challenge" || p === "/v1/auth/refresh" || /^\/v1\/vault\/[\w-]+\/ws-ticket$/.test(p)))) {
        stats.readOnlyRefusals++; req.resume(); return err(res, 503, "read_only");
      }
      const rl = takeRateLimit("http", p);
      if (rl) { res.setHeader("retry-after", String(rl.retryAfter)); return err(res, 429, "rate_limited", { retryAfter: rl.retryAfter }); }
      const body = await readBody(req, res);
      if (body === null) return;
      log.push(`${req.method} ${req.url}\n${Object.entries(req.headers).map(([k, x]) => `${k}: ${x}`).join("\n")}\n${body.toString("latin1")}`);   // everything the relay is sent
      let obj = {};
      if (body.length) { try { obj = JSON.parse(body.toString("utf8")); } catch { return err(res, 400, "bad_request"); } }

      if (req.method === "POST" && p === "/v1/vaults") {
        let pub; try { pub = crypto.createPublicKey({ key: unb64u(String(obj.machineSigPub ?? "")), format: "der", type: "spki" }); } catch { return err(res, 400, "bad_request"); }
        if (pub.asymmetricKeyType !== "ec" || pub.asymmetricKeyDetails?.namedCurve !== "prime256v1") return err(res, 400, "bad_request");
        const vault = rid("vlt_"), deviceId = rid("dev_");
        vaults.set(vault, { devices: new Map([[deviceId, { role: "machine", mode: "write", createdAt: Date.now(), push: null, pub }]]), queue: new Map(), rseq: 0, conns: new Map(), seenIds: new Set() });
        return json(res, 201, { vault, deviceId });
      }
      if (req.method === "POST" && p === "/v1/challenge") {
        stats.challenges++;
        if (typeof obj.deviceId !== "string" || !/^dev_[\w-]{1,64}$/.test(obj.deviceId)) return err(res, 400, "bad_request");
        const rand = crypto.randomBytes(16), exp = Buffer.alloc(8); exp.writeBigUInt64BE(BigInt(Date.now() + nonceMs));
        return json(res, 200, { nonce: b64u(Buffer.concat([rand, exp, mac(obj.deviceId, rand, exp)])), exp: Date.now() + nonceMs });
      }

      // phone side of pairing: account token (Bearer)
      let pm;
      if ((pm = /^\/v1\/pair\/(pr_[\w-]+)\/(claim|reply)$/.exec(p))) {
        const acct = accounts.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (!acct) return err(res, 401, "auth_failed");
        const pr = pairings.get(pm[1]);
        if (!pr) return err(res, 410, "pairing_expired");
        if (pr.exp < Date.now()) return err(res, 410, "pairing_expired");
        if (pm[2] === "claim" && req.method === "POST") {
          if (typeof obj.phoneAuthPub !== "string" || typeof obj.sealed !== "string" || obj.sealed.length < 38 || obj.sealed.length > 8192 || body.length > 16_384) return err(res, 400, "bad_request");
          try { const k = crypto.createPublicKey({ key: unb64u(obj.phoneAuthPub), format: "der", type: "spki" }); if (k.asymmetricKeyType !== "ec") throw 0; } catch { return err(res, 400, "bad_request"); }
          if (pr.state !== "open") return err(res, 409, "pairing_used");        // the first claim burns the session
          pr.state = "claimed";
          pr.claim = { account: acct, deviceId: rid("dev_"), phoneAuthPub: obj.phoneAuthPub, sealed: obj.sealed };
          deliverClaim(pr);
          return json(res, 202, { deviceId: pr.claim.deviceId });
        }
        if (pm[2] === "reply" && req.method === "GET") {
          if (!pr.claim || pr.claim.account.id !== acct.id) return err(res, 403, "forbidden");
          const r = replyOf(pr);
          if (r) return r.status ? err(res, r.status, r.error) : json(res, 200, r);
          const timer = setTimeout(() => { pr.waiters = pr.waiters.filter((w) => w !== done); json(res, 202, { status: "pending" }); }, longPollMs);
          const done = () => { clearTimeout(timer); const x = replyOf(pr); if (x) (x.status ? err(res, x.status, x.error) : json(res, 200, x)); else json(res, 202, { status: "pending" }); };
          pr.waiters.push(done);
          return;
        }
      }

      // everything below needs a signature
      const auth = verifySig(req, body);
      if (auth.error) { stats.authFailures++; return err(res, auth.status, auth.error); }
      const v = vaults.get(auth.vault);
      // the allowlist: off it every signed call is 402, except the machine's own vault delete (contract 14)
      if (v.inactive && !(req.method === "DELETE" && p === `/v1/vault/${auth.vault}` && auth.role === "machine")) return err(res, 402, "plan_inactive");

      if (req.method === "POST" && p === "/v1/pair") {
        if (auth.role !== "machine") return err(res, 403, "forbidden");
        const pairingId = rid("pr_");
        const expires = Date.now() + pairTtlMs;
        const pr = { vault: auth.vault, machineDev: auth.dev, exp: expires, state: "open", conn: null, claim: null, replySealed: null, waiters: [], replies: [] };
        pr.timer = setTimeout(() => { pr.exp = 0; pr.conn?.close(1000); wakePair(pr); }, pairTtlMs); pr.timer.unref();
        pairings.set(pairingId, pr);
        return json(res, 201, { pairingId, expires, wsTicket: mkTicket("pair", { pairingId, dev: auth.dev }) });
      }
      let m;
      if (!(m = /^\/v1\/vault\/([\w-]+)(\/.*)?$/.exec(p))) return err(res, 404, "not_found");
      if (m[1] !== auth.vault) return err(res, 403, "forbidden");
      const rest = m[2] ?? "";
      if (req.method === "DELETE" && rest === "") {          // eleven-sync unpair --all
        if (auth.role !== "machine") return err(res, 403, "forbidden");
        deleteVault(auth.vault);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && rest === "/ws-ticket") return json(res, 200, { ticket: mkTicket("vault", { vault: auth.vault, dev: auth.dev }), exp: Date.now() + ticketMs });
      if (req.method === "GET" && rest === "/inbox") {
        const after = u.searchParams.has("after") ? Number(u.searchParams.get("after")) : 0;
        const limit = u.searchParams.has("limit") ? Number(u.searchParams.get("limit")) : 100;
        if (!/^\d+$/.test(u.searchParams.get("after") ?? "0") || !Number.isSafeInteger(after)) return err(res, 400, "bad_request");
        if (u.searchParams.has("limit") && (!/^\d+$/.test(u.searchParams.get("limit")) || limit < 1)) return err(res, 400, "bad_request");
        stats.inboxPages++;
        const all = (v.queue.get(auth.dev) ?? []).filter((x) => x.rseq > after).sort((a, b) => a.rseq - b.rseq);   // the snapshot is taken first, then the (test) delay
        if (hooks.inboxDelayMs) await new Promise((r) => setTimeout(r, hooks.inboxDelayMs));
        const page = all.slice(0, Math.min(limit, 500));
        return json(res, 200, { messages: page, ...(all.length > page.length ? { next: page.at(-1).rseq } : {}) });
      }
      if (req.method === "GET" && rest === "/devices") {
        return json(res, 200, { devices: [...v.devices].filter(([, d]) => !d.revoked).map(([deviceId, d]) => ({ deviceId, role: d.role, mode: d.mode, createdAt: d.createdAt, push: !!d.push })) });
      }
      if ((m = /^\/devices\/([\w-]+)\/push$/.exec(rest)) && (req.method === "PUT" || req.method === "DELETE")) {
        if (auth.role !== "phone" || auth.dev !== m[1]) return err(res, 403, "forbidden");
        const d = v.devices.get(m[1]);
        if (req.method === "DELETE") { d.push = null; return json(res, 200, { ok: true }); }
        const ep = obj.endpoint;
        if (Object.keys(obj).some((k) => k !== "subId" && k !== "endpoint") || typeof ep !== "string" || typeof obj.subId !== "string") return err(res, 400, "bad_request");
        let url; try { url = new URL(ep); } catch { return err(res, 400, "bad_request"); }
        if (url.protocol !== "https:" || url.username || url.password || url.port || ep.includes("#") || !/^[\x21-\x7e]+$/.test(ep) || ep.length > 1024 || !PUSH_HOST.test(url.hostname) || /^https:\/\/[^/]*:/.test(ep)) return err(res, 400, "bad_request");
        if (obj.subId !== b64u(crypto.createHash("sha256").update(ep).digest().subarray(0, 16))) return err(res, 400, "bad_request");
        d.push = { endpoint: ep, subId: obj.subId };
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && (m = /^\/devices\/([\w-]+)$/.exec(rest))) {
        const d = v.devices.get(m[1]);
        if (!d) return err(res, 404, "not_found");
        if (auth.role !== "machine" && auth.dev !== m[1]) return err(res, 403, "forbidden");
        if (d.role === "machine") return err(res, 403, "forbidden");
        if (d.revoked) { stats.revokeRepeats++; v.queue.delete(m[1]); res.writeHead(204); return res.end(); }   // a repeat re-runs the cleanup (safe after a 500)
        revoke(v, auth.vault, m[1]);
        return json(res, 200, { ok: true });
      }
      return err(res, 404, "not_found");
    } catch (e) {
      if (!res.headersSent) err(res, 500, "internal");
    }
  });

  // ---- WebSocket upgrade: the ticket is checked before anything is routed, and works once
  server.on("upgrade", (req, socket) => {
    const reject = (status, error) => { socket.write(`HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ error })}`); socket.destroy(); };
    const u = new URL(req.url, "http://x");
    const t = u.searchParams.get("ticket") ?? "";
    const rec = tickets.get(t);
    if (rl429()) return;
    function rl429() { const r = takeRateLimit("upgrade", u.pathname); if (r) { reject(429, "rate_limited"); return true; } return false; }
    if (!rec) return reject(401, "auth_failed");
    if (rec.used) { stats.ticketReuse++; return reject(401, "auth_failed"); }
    rec.used = true;                                            // single use, even if the rest fails
    const raw = unb64u(t);
    if (raw.length !== 56 || !crypto.timingSafeEqual(raw.subarray(24), mac("ticket", raw.subarray(0, 16), raw.subarray(16, 24))) || rec.exp < Date.now()) return reject(401, "auth_failed");
    const key = req.headers["sec-websocket-key"];
    if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") return reject(400, "bad_request");
    let route;
    if (rec.kind === "pair" && !pairings.get(rec.pairingId)) return reject(404, "not_found");
    if (rec.kind === "vault") {
      if (u.pathname !== `/v1/vault/${rec.vault}/ws`) return reject(403, "forbidden");
      const vv = vaults.get(rec.vault), dd = vv?.devices.get(rec.dev);
      if (!dd || dd.revoked) return reject(401, "device_unknown");
      if (vv.inactive) return reject(402, "plan_inactive");
      route = "vault";
    } else { if (u.pathname !== `/v1/pair/${rec.pairingId}/machine`) return reject(403, "forbidden"); route = "pair"; }
    if (route === "pair" && pairings.get(rec.pairingId).conn && !pairings.get(rec.pairingId).conn.dead) return reject(409, "pairing_used");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + GUID).digest("base64")}`, "", ""].join("\r\n"));
    let conn;
    const onClose = () => { conns.delete(conn); if (route === "vault") { const v = vaults.get(rec.vault); if (v && v.conns.get(rec.dev) === conn) v.conns.delete(rec.dev); } };
    if (route === "vault") {
      conn = new Conn(socket, (text) => onVaultFrame(rec.vault, rec.dev, conn, text), onClose);
      const v = vaults.get(rec.vault);
      v.conns.get(rec.dev)?.close(1000);                          // one socket per device: a new connection replaces the old one
      v.conns.set(rec.dev, conn);
      if (v.devices.get(rec.dev).role === "machine") {
        v.machineSeen = Date.now();
        for (const [id, d] of v.devices) if (d.role === "phone") v.conns.get(id)?.send(presenceFor(v));
      } else conn.send(presenceFor(v));
    } else {
      const pr = pairings.get(rec.pairingId);
      conn = new Conn(socket, (text) => { log.push(String(text)); try { pr.replies.push(JSON.parse(text)); } catch { /* not JSON */ } onPairFrame(pr, conn, text); }, () => {
        onClose();
        if (pr.state === "claimed") { pr.state = "refused"; wakePair(pr); }       // the machine went away without answering
      });
      pr.conn = conn;
      if (pr.exp < Date.now()) { conn.close(1000); } else deliverClaim(pr);
    }
    conns.add(conn);
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    stats, pushes, errors,
    // ---- test hooks
    /** Register a phone's PAUTH public key (SPKI DER) in a vault. Real flow = pairing (task 3). Returns its deviceId. */
    addPhone(vault, authPubSpki, deviceId = rid("dev_")) {
      vaults.get(vault).devices.set(deviceId, { role: "phone", mode: "write", createdAt: Date.now(), push: null, pub: crypto.createPublicKey({ key: Buffer.from(authPubSpki), format: "der", type: "spki" }) });
      return deviceId;
    },
    /** Drop every WebSocket abruptly (no close frame), as a network failure would. */
    dropConnections() { for (const c of [...conns]) c.drop(); },
    /** The next `count` requests of kind where ("http" | "ws" frame | "upgrade") get rate_limited with `retryAfter` seconds. */
    rateLimit({ count = 1, retryAfter = 1, where = "http", match } = {}) { hooks.rateLimit = { count, retryAfter, where, match }; },
    /** Rewrite the claim frame the relay sends to the machine (a hostile or buggy relay): fn(frame) -> frame. */
    setClaimFrame(fn) { hooks.claimFrame = fn; },
    /** Say something on the machine's pairing socket (an error frame in the middle of a pairing). */
    pairSay(pairingId, obj) { pairings.get(pairingId).conn.send(JSON.stringify(obj)); },
    /** Take a vault's account off the allowlist (or put it back). */
    setPlanActive(vault, active) { vaults.get(vault).inactive = !active; },
    /** Bind `n` extra vaults to an account (to reach the 20-vault cap). */
    fillAccount(accountId, n) { for (let i = 0; i < n; i++) vaults.set(rid("vlt_"), { devices: new Map(), queue: new Map(), rseq: 0, conns: new Map(), seenIds: new Set(), account: accountId }); },
    /** The kill switch (contract section 11): non-GET requests get 503 read_only, WS envelopes/acks/pushes get a read_only error frame. */
    setReadOnly(on) { hooks.readOnly = !!on; },
    /** The inbox answers after this many ms (so live frames can arrive during a catch-up). */
    setInboxDelay(ms) { hooks.inboxDelayMs = ms; },
    /** What the push service answers (404/410 delete the endpoint and tell the machine push_stale). */
    setPushService(status) { hooks.pushService = status; },
    /** Account-initiated revoke (acct + step-up in the contract). */
    revokeDevice(vault, dev) { revoke(vaults.get(vault), vault, dev); },
    /** Vault deletion (the account route or the machine route). */
    deleteVault,
    hasVault: (vault) => vaults.has(vault),
    /** Register a push endpoint for a phone directly (the real route is the phone's signed PUT). Returns the subId. */
    setPush(vault, dev, endpoint = "https://web.push.apple.com/test-endpoint") {
      const subId = b64u(crypto.createHash("sha256").update(endpoint).digest().subarray(0, 16));
      vaults.get(vault).devices.get(dev).push = { endpoint, subId };
      return subId;
    },
    pushEndpoint: (vault, dev) => vaults.get(vault)?.devices.get(dev)?.push ?? null,
    /** Relay-made frame to a device (a hint, a forged envelope, an error frame). */
    hint(vault, deviceId, obj) { vaults.get(vault).conns.get(deviceId)?.send(typeof obj === "string" ? obj : JSON.stringify(obj)); },
    /** Phone claim frame pushed straight to the machine's pairing socket (bypasses the checks of the claim endpoint). */
    claim(pairingId, obj) { pairings.get(pairingId).conn.send(JSON.stringify({ t: "claim", ...obj })); },
    /** A phone account (Bearer token) for the claim and reply endpoints. */
    addAccount(id, email = "alice@example.com") { const token = "acct_" + b64u(crypto.randomBytes(12)); const [u, d] = email.split("@"); accounts.set(token, { id, email, masked: `${u[0]}•••@${d}` }); return token; },
    pairingReplies: (id) => pairings.get(id)?.replies ?? [],
    pairingState: (id) => pairings.get(id)?.state,
    queue: (vault, deviceId) => [...(vaults.get(vault)?.queue.get(deviceId) ?? [])],
    connected: (vault, deviceId) => !!vaults.get(vault)?.conns.get(deviceId),
    /** Everything the relay ever stored or received on a WebSocket, as one string. */
    storedBytes: () => log.join("\n"),
    async close() {
      for (const c of [...conns]) c.drop();
      await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
    },
  };
}
