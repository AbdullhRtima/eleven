// A simulated phone for the pairing tests (protocol 6.2 steps 2, 3, 7). It is written on purpose with node:crypto and none of the
// code under test, so the two sides agreeing on the check words and the keys means something.
import crypto from "node:crypto";
import { WORDS } from "../../eleven-protocol/src/wordlist.js";

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
const sha256 = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 32));

export function parseLink(link) {
  const m = /^https:\/\/m\.eleven\.rtima\.org\/pair#v1\.(pr_[\w-]{22})\.([\w-]{43})\.([\w-]{43})$/.exec(link);
  if (!m) throw new Error("bad pairing link: " + link);
  return { pairingId: m[1], secret: unb64u(m[2]), fpr: unb64u(m[3]) };
}

function seal(secret, pairingId, purpose, obj) {
  const key = hkdf(secret, pairingId, "eleven/v1/pair");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`eleven/v1/${purpose}|${pairingId}`));
  return b64u(Buffer.concat([iv, c.update(JSON.stringify(obj)), c.final(), c.getAuthTag()]));
}
function open(secret, pairingId, purpose, sealed) {
  const key = hkdf(secret, pairingId, "eleven/v1/pair");
  const raw = unb64u(sealed);
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(`eleven/v1/${purpose}|${pairingId}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
}

export function wordsFor({ pairingId, fpr, kx, auth, act, accountId }) {
  const inner = sha256(kx, auth, act);
  const h = sha256(Buffer.from("eleven/v1/words|"), Buffer.from(pairingId + "|"), fpr, Buffer.from("|"), inner, Buffer.from("|" + accountId));
  let bits = ""; for (const byte of h) bits += byte.toString(2).padStart(8, "0");
  return [0, 1, 2, 3].map((i) => WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
}

// The machine's device id as the relay lists it (signed GET /v1/vault/:vault/devices, by the freshly registered phone).
async function relayMachine(relayUrl, vault, deviceId, au) {
  const ch = await (await fetch(new URL("/v1/challenge", relayUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId }) })).json();
  const pathq = `/v1/vault/${vault}/devices`;
  const msg = Buffer.from(`eleven/v1/auth\nGET\n${pathq}\n${ch.nonce}\n${b64u(crypto.createHash("sha256").update("").digest())}`);
  const sig = b64u(crypto.sign("sha256", msg, { key: au.privateKey, dsaEncoding: "ieee-p1363" }));
  const r = await fetch(new URL(pathq, relayUrl), { headers: { authorization: `Eleven-Sig dev=${deviceId}, nonce=${ch.nonce}, sig=${sig}` } });
  const list = (await r.json()).devices ?? [];
  return list.find((d) => d.role === "machine")?.deviceId ?? null;
}

/**
 * claimLink({ relayUrl, link, token, accountId, ... }) -> a phone that has claimed. `wrongSecret` / `claimOverride` make bad claims.
 * Returns { status, body, deviceId, words, finish() } where finish() long-polls for the answer and derives the keys.
 */
export async function claimLink({ relayUrl, link, token, accountId = "acc_alice", deviceName = "Pixel 8", emailMasked = "a•••@example.com", withAct = true, wrongSecret = false, claimOverride = {}, postAuthPub = null, actAlg = "es256" }) {
  const { pairingId, secret, fpr } = parseLink(link);
  const kx = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const au = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const act = withAct ? crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : null;
  const spki = (k) => k.publicKey.export({ type: "spki", format: "der" });
  const actPub = act ? spki(act) : Buffer.alloc(0);
  const claim = {
    phoneKxPub: b64u(spki(kx)), phoneAuthPub: b64u(spki(au)),
    ...(act ? { phoneActKey: { alg: actAlg, credId: "c1", pub: b64u(actPub) } } : {}),
    deviceName, accountId, emailMasked, mode: "write", ...claimOverride,
  };
  const sealed = seal(wrongSecret ? crypto.randomBytes(32) : secret, pairingId, "claim", claim);
  const post = (path, init) => fetch(new URL(path, relayUrl), { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const res = await post(`/v1/pair/${pairingId}/claim`, { method: "POST", body: JSON.stringify({ phoneAuthPub: postAuthPub ?? claim.phoneAuthPub, sealed }) });
  const body = await res.json().catch(() => ({}));
  const deviceId = body.deviceId;
  const claimed_deviceId = deviceId;
  const words = wordsFor({ pairingId, fpr, kx: spki(kx), auth: spki(au), act: actPub, accountId });
  return {
    status: res.status, body, deviceId, words, pairingId, secret, keys: { kx, au, act },
    // long-poll GET /v1/pair/:id/reply until the sealed accept (or an error) arrives; then step 7
    // `relayMachineId` overrides what the relay reports as the machine's device (a test of the mismatch refusal).
    async finish({ relayMachineId } = {}) {
      for (let i = 0; i < 100; i++) {
        const r = await post(`/v1/pair/${pairingId}/reply`, { method: "GET" });
        const b = await r.json().catch(() => ({}));
        if (r.status === 202) continue;
        if (!r.ok) return { ok: false, status: r.status, error: b.error };
        const a = open(secret, pairingId, "accept", b.sealed);
        const machineKx = unb64u(a.machineKxPub), machineSig = unb64u(a.machineSigPub);
        if (!sha256(machineKx, machineSig).equals(fpr)) return { ok: false, error: "fingerprint_mismatch" };
        // the accept names the machine's own device id; it must be the machine the relay lists for the vault (the relay's list is a hint, the sealed id is the proof)
        if (typeof a.machineDeviceId !== "string") return { ok: false, error: "machine_device_missing" };
        const listed = relayMachineId ?? await relayMachine(relayUrl, a.vault, claimed_deviceId, au);
        if (a.machineDeviceId !== listed) return { ok: false, error: "machine_device_mismatch" };
        const shared = crypto.diffieHellman({ privateKey: kx.privateKey, publicKey: crypto.createPublicKey({ key: machineKx, format: "der", type: "spki" }) });
        const root = hkdf(shared, sha256(Buffer.from(pairingId), secret), "eleven/v1/root");
        const k = (dir) => hkdf(root, Buffer.alloc(0), `eleven/v1/${dir}|${a.vault}|${a.deviceId}|0`);
        return { ok: true, accept: a, m2p: b64u(k("m2p")), p2m: b64u(k("p2m")) };
      }
      return { ok: false, error: "timeout" };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The phone after pairing (protocol 4, 5, 7, 8, 9): device-signed HTTP, the WebSocket, sealed envelopes, signed actions and
// RFC 8291 decryption. node:crypto only, and none of the code under test (not even the JCS or the envelope sealing).
// ---------------------------------------------------------------------------------------------------------------------------
export function canon(v) {                       // RFC 8785 for the plain values these tests use
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
const padTo = (n) => (n < 65536 ? Math.max(1024, Math.ceil(n / 1024) * 1024) : Math.ceil(n / 65536) * 65536);
const H = (x) => b64u(crypto.createHash("sha256").update(x).digest());
export const actionToSign = (vault, deviceId, a) => H("eleven/v1/action|" + vault + "|" + deviceId + "|" + canon(a));   // 8.2: b64u of the digest; the WebAuthn challenge is the RAW digest

/**
 * A passkey assertion as navigator.credentials.get returns it (WebAuthn 7.2), built by hand: authenticatorData = rpIdHash(32) | flags(1) |
 * counter(4, BE); clientDataJSON; signature = DER ECDSA over authenticatorData || SHA-256(clientDataJSON). `o` changes one thing at a time:
 * rpId, flags, counter, type, challenge, origin, crossOrigin, extra (more clientData keys), clientData (the exact text), tweakAd(buf) -> buf
 * (before signing), key (signer), p1363 (wrong signature encoding), tweakSig(buf) -> buf (after signing), fields (replace sig fields as they are sent).
 */
export function webauthnSig(key, toSign, o = {}) {
  const sha = (x) => crypto.createHash("sha256").update(x).digest(), pick = (k, dflt) => (k in o ? o[k] : dflt);   // so null is a value too
  const counter = Buffer.alloc(4); counter.writeUInt32BE(o.counter ?? 0);
  const ad = (o.tweakAd ?? ((x) => x))(Buffer.concat([sha(o.rpId ?? "m.eleven.rtima.org"), Buffer.from([o.flags ?? 0x1d]), counter]));   // 0x1d = UP | UV | BE | BS
  const cd = Buffer.from(o.clientData ?? JSON.stringify({ type: pick("type", "webauthn.get"), challenge: pick("challenge", toSign), origin: pick("origin", "https://m.eleven.rtima.org"), crossOrigin: pick("crossOrigin", false), ...o.extra }));
  const raw = crypto.sign("sha256", Buffer.concat([ad, sha(cd)]), { key: o.key ?? key, dsaEncoding: o.p1363 ? "ieee-p1363" : "der" });
  return { alg: "webauthn-es256", authenticatorData: b64u(ad), clientDataJSON: b64u(cd), signature: b64u((o.tweakSig ?? ((x) => x))(raw)), ...o.fields };
}

export function aesSeal(key, env, inner) {
  const aad = Buffer.from(["eleven/v1", env.v, env.type, env.vault, env.from, env.to, env.id, env.epoch, env.fid ?? ""].join("|"));
  const json = Buffer.from(canon(inner));
  const plain = Buffer.alloc(padTo(4 + json.length)); plain.writeUInt32BE(json.length, 0); json.copy(plain, 4);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce); c.setAAD(aad);
  return { ...env, n: b64u(nonce), ct: b64u(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])) };
}
export function aesOpen(key, env) {
  const aad = Buffer.from(["eleven/v1", env.v, env.type, env.vault, env.from, env.to, env.id, env.epoch, env.fid ?? ""].join("|"));
  const ct = unb64u(env.ct);
  const d = crypto.createDecipheriv("aes-256-gcm", key, unb64u(env.n)); d.setAAD(aad); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(4, 4 + plain.readUInt32BE(0)).toString("utf8"));
}

// RFC 8291 from the phone side: body = salt(16) rs(4) idlen(1) as_public(65) record
export function decryptWebPush(body, { private: uaPriv, publicRaw, auth }) {
  const b = Buffer.from(body);
  const salt = b.subarray(0, 16), idlen = b[20], asPub = b.subarray(21, 21 + idlen), rec = b.subarray(21 + idlen);
  const secret = crypto.diffieHellman({ privateKey: uaPriv, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), asPub]), format: "der", type: "spki" }) });
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), publicRaw, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(rec.subarray(rec.length - 16));
  const plain = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
  const end = plain.lastIndexOf(2);
  return plain.subarray(0, end).toString("utf8");
}

/**
 * A paired phone: new Phone({ relayUrl, claimed (the claimLink result), fin (its finish() result) }).
 * connect() opens the WebSocket; inbox holds every decoded message { type, inner, env }; waitFor(pred) resolves with the first match.
 */
export class Phone {
  constructor({ relayUrl, claimed, fin }) {
    this.relayUrl = relayUrl; this.deviceId = claimed.deviceId; this.vault = fin.accept.vault; this.machineId = null;
    this.au = claimed.keys.au; this.act = claimed.keys.act;
    this.m2p = unb64u(fin.m2p); this.p2m = unb64u(fin.p2m);
    this.inbox = []; this.raw = []; this.waiters = []; this.seq = 0; this.ws = null;
    this.push = null;
    this.words = claimed.words;
  }
  async signed(method, pathq, bodyObj) {
    const ch = await (await fetch(new URL("/v1/challenge", this.relayUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: this.deviceId }) })).json();
    const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
    const msg = Buffer.from(`eleven/v1/auth\n${method}\n${pathq}\n${ch.nonce}\n${H(body)}`);
    const sig = b64u(crypto.sign("sha256", msg, { key: this.au.privateKey, dsaEncoding: "ieee-p1363" }));
    return fetch(new URL(pathq, this.relayUrl), { method, headers: { authorization: `Eleven-Sig dev=${this.deviceId}, nonce=${ch.nonce}, sig=${sig}`, ...(bodyObj === undefined ? {} : { "content-type": "application/json" }) }, body: bodyObj === undefined ? undefined : body });
  }
  async connect() {
    const { ticket } = await (await this.signed("POST", `/v1/vault/${this.vault}/ws-ticket`, {})).json();
    const u = new URL(`/v1/vault/${this.vault}/ws`, this.relayUrl); u.protocol = "ws:"; u.searchParams.set("ticket", ticket);
    this.ws = new WebSocket(u);
    this.ws.onmessage = (ev) => this.#frame(JSON.parse(ev.data));
    await new Promise((ok, no) => { this.ws.onopen = ok; this.ws.onerror = () => no(new Error("phone websocket failed")); });
    return this;
  }
  #frame(f) {
    this.raw.push(f);
    if (f.type === "hint" || !f.ct) { this.#wake(); return; }
    if (this.machineId === null) this.machineId = f.from;
    try { this.inbox.push({ type: f.type, inner: aesOpen(this.m2p, f), env: f }); } catch { this.raw.push({ undecryptable: f.id }); }
    this.#wake();
  }
  #wake() { for (const w of [...this.waiters]) w(); }
  async waitFor(pred, ms = 5000) {
    const t = Date.now();
    for (;;) {
      const m = this.inbox.find(pred); if (m) return m;
      if (Date.now() - t > ms) throw new Error("phone: timed out waiting; got " + JSON.stringify(this.inbox.map((x) => x.inner.t)));
      await new Promise((r) => { const w = () => { clearTimeout(tm); this.waiters = this.waiters.filter((x) => x !== w); r(); }; const tm = setTimeout(w, 25); this.waiters.push(w); });
    }
  }
  of(t) { return this.inbox.filter((m) => m.inner.t === t); }
  /** Send one sealed message to the machine. */
  send(type, inner, { fid } = {}) {
    const env = { v: 1, type, vault: this.vault, from: this.deviceId, to: "machine", id: crypto.randomUUID(), ts: Date.now(), epoch: 0, ...(fid ? { fid } : {}) };
    const sealed = aesSeal(this.p2m, env, { ...inner, seq: inner.seq ?? ++this.seq, ts: inner.ts ?? Date.now() });
    this.ws.send(JSON.stringify(sealed));
    return sealed;
  }
  req(t, body = {}) { return this.send("req", { t, ...body }); }
  /** A signed action (8.1, 8.2). sig: "device" (default) | "none" | "bad" (signed by another key) | "webauthn" (dummy values) | "passkey" (a real
   *  assertion by this phone's key) | (toSign, action) => sig object (may edit the action after signing) | an object. */
  action(fields, { sig = "device", id = crypto.randomUUID(), createdAt = Date.now() } = {}) {
    const a = { t: "action", seq: ++this.seq, ts: Date.now(), actionId: id, createdAt, ...fields };
    const toSign = actionToSign(this.vault, this.deviceId, a);
    const key = sig === "bad" ? crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey : this.act?.privateKey;
    if (sig === "device" || sig === "bad") a.sig = { alg: "device-es256", signature: b64u(crypto.sign("sha256", Buffer.from(toSign), { key, dsaEncoding: "ieee-p1363" })) };
    else if (sig === "webauthn") a.sig = { alg: "webauthn-es256", authenticatorData: "AA", clientDataJSON: "AA", signature: "AA" };
    else if (sig === "passkey") a.sig = webauthnSig(key, toSign);
    else if (typeof sig === "function") a.sig = sig(toSign, a);
    else if (typeof sig === "object") a.sig = sig;
    return { id, env: this.send("action", a) };
  }
  /** push_keys (7.4): a fresh push subscription (key pair + a fake endpoint), registered at the relay with a signed PUT (contract section 9) and
   *  told to the machine in the sealed req. subId = b64u(first 16 bytes of SHA-256(endpoint)). Kept so decryptPush can read what the machine sends. */
  async pushKeys(lockScreen = "titles", { register = true } = {}) {
    const ec = crypto.createECDH("prime256v1"); ec.generateKeys();
    const auth = crypto.randomBytes(16);
    const endpoint = `https://web.push.apple.com/${b64u(crypto.randomBytes(24))}`;
    const subId = b64u(crypto.createHash("sha256").update(endpoint).digest().subarray(0, 16));
    const pkcs8Head = Buffer.from("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420", "hex");
    this.push = { subId, endpoint, publicRaw: ec.getPublicKey(), auth, private: crypto.createPrivateKey({ key: Buffer.concat([pkcs8Head, ec.getPrivateKey().length === 32 ? ec.getPrivateKey() : Buffer.concat([Buffer.alloc(32 - ec.getPrivateKey().length), ec.getPrivateKey()]), Buffer.from("a144034200", "hex"), ec.getPublicKey()]), format: "der", type: "pkcs8" }) };
    if (register) {
      const r = await this.signed("PUT", `/v1/vault/${this.vault}/devices/${this.deviceId}/push`, { subId, endpoint });
      if (r.status !== 200) throw new Error("push registration failed: " + r.status);
    }
    return this.req("push_keys", { subId, p256dh: b64u(ec.getPublicKey()), auth: b64u(auth), lockScreen });
  }
  decryptPush(bodyB64u) { return JSON.parse(decryptWebPush(unb64u(bodyB64u), this.push)); }
  close() { try { this.ws?.close(); } catch { /* closed */ } }
}
