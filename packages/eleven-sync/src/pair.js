// `eleven-sync pair` (protocol 6, security H5). The terminal side of pairing one phone with one vault.
//
// The 256-bit secret exists in three places only: this process's memory, the QR/link fragment shown on screen, and the phone.
// It is never sent to the relay (everything the relay gets is sealed under a key derived from it), never written to a file, and
// wiped (zeroed) once the claim is answered. Nothing is paired until someone types y at this terminal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  b64uEncode, b64uDecode, sha256, generateKeyAgreementKeyPair, generateSigningKeyPair, generateKfid,
  exportPublicKey, importPublicKey, fingerprint, deriveRoot, deriveMessageKeys,
} from "../../eleven-protocol/src/index.js";
import { findEleven } from "./find.js";
import { ensurePrivateDir, readPrivate, writePrivateAtomic } from "./fsafe.js";
import { createRelayClient, createVault, RelayError } from "./relay-client.js";
import { encodeQr, qrToText } from "./qr.js";
import { WORDS } from "./wordlist.js";

export const DEFAULT_RELAY = "https://relay.eleven.rtima.org";
export const DEFAULT_PWA = "https://m.eleven.rtima.org";
export const PAIRING_MS = 5 * 60_000;
const DEVICE_NAME = /^[A-Za-z0-9 ._'-]{1,32}$/;
const DEVICE_ID = /^dev_[A-Za-z0-9_-]{22}$/;
const PAIRING_ID = /^pr_[A-Za-z0-9_-]{22}$/;
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

// ---- Kpair and the sealed claim / accept (6.2 steps 3 and 6). Sealed = b64u(iv(12) || ciphertext || tag).
export async function pairKey(secret, pairingId, usage) {
  const ikm = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(pairingId), info: enc.encode("eleven/v1/pair") }, ikm, { name: "AES-GCM", length: 256 }, false, [usage]);
}
export async function sealPairing(secret, pairingId, purpose, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`eleven/v1/${purpose}|${pairingId}`) }, await pairKey(secret, pairingId, "encrypt"), enc.encode(JSON.stringify(obj))));
  return b64uEncode(concat(iv, ct));
}
export async function openSealed(secret, pairingId, purpose, sealed) {
  const raw = b64uDecode(sealed);
  if (raw.length < 12 + 16) throw new Error("sealed too short");
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: enc.encode(`eleven/v1/${purpose}|${pairingId}`) }, await pairKey(secret, pairingId, "decrypt"), raw.subarray(12));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
}

// ---- check words (6.3): 4 x 11 bits of H("eleven/v1/words" | pairingId | fpr | H(phoneKxPub || phoneAuthPub || PACT pub) | accountId)
// "|" is the byte 0x7c between the fields; fpr and the inner hash are the raw 32 bytes; the three public keys are SPKI DER
// (PACT pub = the bytes of the claim's `phoneActKey.pub`, or nothing for a read-only phone).
export async function checkWords({ pairingId, fpr, phoneKxPub, phoneAuthPub, phoneActPub = new Uint8Array(0), accountId }) {
  const bar = enc.encode("|");
  const inner = await sha256(concat(phoneKxPub, phoneAuthPub, phoneActPub));
  const h = await sha256(concat(enc.encode("eleven/v1/words"), bar, enc.encode(pairingId), bar, fpr, bar, inner, bar, enc.encode(accountId)));
  const words = [];
  for (let i = 0; i < 4; i++) {
    let idx = 0;
    for (let b = 0; b < 11; b++) { const bit = i * 11 + b; idx = (idx << 1) | ((h[bit >> 3] >> (7 - (bit & 7))) & 1); }
    words.push(WORDS[idx]);
  }
  return words;
}

// ---- machine keys on disk (0700 dir, 0600 file, as fsafe.js). The OS keychain comes later (protocol 3).
const stripCtl = (s, max = 64) => (typeof s === "string" ? s : "").replace(/[\p{C}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, max);
export const vaultFile = (stateDir, elevenDir) => path.join(stateDir, `vault-${crypto.createHash("sha256").update(path.resolve(elevenDir)).digest("hex").slice(0, 16)}.json`);

async function newKeyRecord(kind) {
  const kp = await (kind === "ecdh" ? generateKeyAgreementKeyPair : generateSigningKeyPair)({ extractable: true });
  return { priv: b64uEncode(new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey))), pub: b64uEncode(await exportPublicKey(kp.publicKey)) };
}
function readRecord(file) {
  const raw = readPrivate(file);
  if (raw === null) return null;
  let r; try { r = JSON.parse(raw.toString("utf8")); } catch { throw new Error(`${file} is not valid JSON`); }
  if (!r || r.v !== 1 || typeof r.mkx?.priv !== "string" || typeof r.msig?.priv !== "string" || !Array.isArray(r.devices)) throw new Error(`${file} is not a machine key file`);
  return r;
}
/** The machine record for a project (keys, vault, paired devices), or null when `pair` never ran. */
export const loadMachineRecord = (stateDir, elevenDir) => readRecord(vaultFile(stateDir, elevenDir));
const saveRecord = (file, r) => writePrivateAtomic(file, JSON.stringify(r, null, 2) + "\n");
/** Write the record back (the daemon, after the relay reports a revoked phone). */
export const saveMachineRecord = (stateDir, elevenDir, r) => saveRecord(vaultFile(stateDir, elevenDir), r);

/** Load, or create, the machine keys and the vault for this project. -> { record, file, signingKey, mkxSpki, msigSpki } */
export async function ensureMachine({ stateDir, elevenDir, relay, fetch }) {
  ensurePrivateDir(stateDir);
  const file = vaultFile(stateDir, elevenDir);
  let record = readRecord(file);
  if (record && record.relay !== relay) throw new Error(`this project is registered with ${record.relay}, not ${relay}`);
  if (!record) {
    record = { v: 1, relay, project: path.resolve(elevenDir), mkx: await newKeyRecord("ecdh"), msig: await newKeyRecord("ecdsa"), kfid: b64uEncode(generateKfid()), vault: null, deviceId: null, account: null, devices: [] };
    saveRecord(file, record);
  }
  const registered = async () => {
    const r = await createVault({ baseUrl: relay, machineSigPubSpki: b64uDecode(record.msig.pub), fetch });
    if (!/^vlt_[A-Za-z0-9_-]{22}$/.test(r.vault) || !DEVICE_ID.test(r.deviceId)) throw new RelayError("bad_response", "the relay returned a malformed vault or device id");
    record.vault = r.vault; record.deviceId = r.deviceId; saveRecord(file, record);
  };
  if (!record.vault) await registered();
  const load = async () => ({
    signingKey: await subtle.importKey("pkcs8", b64uDecode(record.msig.priv), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    kxKey: await subtle.importKey("pkcs8", b64uDecode(record.mkx.priv), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits", "deriveKey"]),
  });
  return { record, file, load, reregister: registered, mkxSpki: b64uDecode(record.mkx.pub), msigSpki: b64uDecode(record.msig.pub) };
}

// ---- terminal input: lines from stdin, with a timeout and an abort. Resolves null on EOF, timeout or abort.
function lineReader(stdin, signal) {
  let buf = "", ended = false; const lines = []; let wake = null, quietUntil = 0;
  const onData = (d) => { if (Date.now() < quietUntil) { buf = ""; return; }                       // L-15: nothing typed this soon after a question counts
    buf += String(d); let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); } wake?.(); };
  const onEnd = () => { ended = true; wake?.(); };
  stdin.setEncoding?.("utf8"); stdin.on("data", onData); stdin.on("end", onEnd); stdin.on("close", onEnd);
  return {
    next(ms) {
      return new Promise((resolve) => {
        const done = (v) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); wake = null; resolve(v); };
        const check = () => { if (lines.length) done(lines.shift()); else if (ended || signal?.aborted) done(null); };
        const onAbort = () => done(null);
        const t = setTimeout(() => done(null), Math.max(0, ms));
        wake = check; signal?.addEventListener("abort", onAbort); check();
      });
    },
    // M-A: forget every line and half line typed so far. Called right before a question is printed, so the answer can only be
    // something typed AFTER the person saw the question (a stray key, a paste or type-ahead must never answer it).
    flush(quietMs = 0) { lines.length = 0; buf = ""; quietUntil = quietMs > 0 ? Date.now() + quietMs : 0; },
    stop() { stdin.off("data", onData); stdin.off("end", onEnd); stdin.off("close", onEnd); stdin.pause?.(); },
  };
}

const relayOk = (u) => { try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname)); } catch { return false; } };

/**
 * pair({ dir, readOnly, stateDir, relay, pwa, stdin, out, err, signal, fetch, WebSocket }) -> exit code
 *   0 paired · 1 not paired (refused, expired, error) · 2 bad usage · 130 cancelled
 */
export async function pair({
  dir = ".", readOnly = false, stateDir = path.join(os.homedir(), ".config", "eleven-sync"), relay = DEFAULT_RELAY, pwa = DEFAULT_PWA,
  stdin = process.stdin, out = process.stdout, err = process.stderr, signal, quietMs = 300, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, cwd = process.cwd(),
} = {}) {
  if (!stdin?.isTTY || !out?.isTTY) { err.write(`eleven-sync pair needs an interactive terminal (${!stdin?.isTTY ? "stdin" : "stdout"} is not a TTY). The pairing code must only be shown to, and confirmed by, a person at this machine. Nothing was done.\n`); return 1; }
  if (!relayOk(relay)) { err.write(`the relay URL must be https (got ${relay}).\n`); return 2; }
  const elevenDir = findEleven(path.resolve(cwd, dir));
  if (!elevenDir) { err.write(`no eleven/ folder found from ${path.resolve(cwd, dir)} upward\n`); return 1; }
  const mode = readOnly ? "read" : "write";
  const input = lineReader(stdin, signal);
  let secret = null, channel = null;
  const wipe = () => { if (secret) { secret.fill(0); secret = null; } };
  // L-5: the QR and the link stay on screen until the pairing ends; then the screen AND the scrollback are cleared, whatever the outcome
  let shown = false;
  const clearScreen = () => { if (shown) { shown = false; out.write("\x1b[2J\x1b[3J\x1b[H"); } };
  const say = (msg) => { clearScreen(); out.write(msg); };
  try {
    let machine;
    try { machine = await ensureMachine({ stateDir, elevenDir, relay, fetch }); }
    catch (e) { err.write(`could not set up the machine keys or the vault: ${e.message}\n`); return 1; }
    const fpr = (await fingerprint(machine.mkxSpki, machine.msigSpki));
    const keys = await machine.load();

    input.flush();
    out.write("Anyone who sees this code in the next 5 minutes can try to pair. Press Enter to show it.\n");
    if ((await input.next(10 * 60_000)) === null) { out.write(signal?.aborted ? "\nCancelled.\n" : "Cancelled. Nothing was shown.\n"); return signal?.aborted ? 130 : 1; }

    const mkClient = () => createRelayClient({ baseUrl: relay, vault: machine.record.vault, deviceKeys: { deviceId: machine.record.deviceId, signingKey: keys.signingKey }, fetch, WebSocket });
    let started;
    try {
      try { started = await mkClient().startPairing(); }
      catch (e) {
        if (e.code !== "device_unknown" || machine.record.account) throw e;
        await machine.reregister();                       // a pending vault that nobody confirmed is deleted after 1 hour (6.1)
        started = await mkClient().startPairing();
      }
    } catch (e) { err.write(pairingProblem(e) + "\n"); return 1; }
    const { pairingId, wsTicket } = started;
    if (!PAIRING_ID.test(pairingId) || typeof wsTicket !== "string") { err.write("the relay returned a malformed pairing session.\n"); return 1; }
    const expiresAt = Math.min(Number(started.expires) || Infinity, Date.now() + PAIRING_MS);
    const left = () => expiresAt - Date.now();

    secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const link = `${pwa}/pair#v1.${pairingId}.${b64uEncode(secret)}.${fpr.b64u}`;

    // one pending event at a time: the first claim, or the end
    let claimFrame = null;
    const events = []; let notify = null;
    const push = (e) => { events.push(e); notify?.(); };
    try { channel = await mkClient().openPairing(pairingId, wsTicket); }
    catch (e) { err.write(`could not open the pairing channel: ${e.message}\n`); return 1; }
    channel.onClaim((m) => { if (claimFrame) return; claimFrame = m; push({ k: "claim", m }); });   // a later claim is ignored (6.2 step 5)
    channel.onResult((m) => push({ k: "result", m }));
    channel.onClose(() => push({ k: "close" }));
    const nextEvent = (ms) => new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); signal?.removeEventListener("abort", ab); notify = null; resolve(v); };
      const check = () => { if (events.length) done(events.shift()); };
      const ab = () => done({ k: "abort" });
      const t = setTimeout(() => done({ k: "timeout" }), Math.max(0, ms));
      notify = check; signal?.addEventListener("abort", ab); if (signal?.aborted) return ab(); check();
    });

    shown = true;
    out.write(qrToText(encodeQr(link)));
    out.write(`\nOr paste this link into the eleven app on your phone:\n${link}\n\n`);
    out.write("It works once and expires in 5 minutes. Waiting for the phone... (Ctrl-C to cancel)\n");

    let ev;
    do { ev = await nextEvent(left()); } while (ev.k === "result");
    if (ev.k === "abort") { say("\nCancelled. Nothing was paired.\n"); return 130; }
    if (ev.k === "timeout") { say("This code expired. Run eleven-sync pair again.\n"); return 1; }
    if (ev.k === "close") { say(left() <= 0 ? "This code expired. Run eleven-sync pair again.\n" : "The relay closed the pairing channel. Run eleven-sync pair again.\n"); return 1; }

    // ---- a claim
    const refuse = (why) => { try { channel.refuse(); } catch { /* socket gone */ } wipe(); say(`${why} Nothing was paired.\n`); return 1; };
    const frame = ev.m;
    let claim;
    try { claim = await openSealed(secret, pairingId, "claim", frame.sealed); }
    catch { return refuse("The request could not be opened (it was not made from this code, or it was changed on the way)."); }
    let phoneKx, phoneAuth, phoneActPub = new Uint8Array(0);
    try {
      if (!claim || typeof claim !== "object") throw new Error("shape");
      if (typeof claim.deviceName !== "string" || !DEVICE_NAME.test(claim.deviceName)) return refuse("The phone sent a device name that is not allowed.");
      if (typeof claim.accountId !== "string" || claim.accountId === "" || claim.accountId !== frame.relayAccountId) return refuse("The account in the request does not match the account the relay reports.");
      if (machine.record.account && machine.record.account !== claim.accountId) return refuse("This project already belongs to another account.");
      if (typeof frame.deviceId !== "string" || !DEVICE_ID.test(frame.deviceId)) return refuse("The relay did not give a valid device id for the phone.");
      // L-3: the relay chooses the phone's id. It can never be this machine's id or the id of a phone we already know (revoked ones included).
      if (frame.deviceId === machine.record.deviceId || machine.record.devices.some((d) => d.deviceId === frame.deviceId)) return refuse("The relay gave the phone a device id that is already in use.");
      // the relay's copy of the phone's auth key (it registers this one) must be the key inside the sealed claim, and it is always sent (L-3)
      if (typeof frame.phoneAuthPub !== "string" || frame.phoneAuthPub !== claim.phoneAuthPub) return refuse("The phone's auth key does not match the one the relay holds (auth key mismatch).");
      // L-2: the account is the one the relay reports. The phone's own text must say the same, or the claim is refused.
      if (typeof frame.relayEmailMasked !== "string" || stripCtl(frame.relayEmailMasked) === "") return refuse("The relay did not report the account's email.");
      if (claim.emailMasked !== undefined && stripCtl(claim.emailMasked) !== stripCtl(frame.relayEmailMasked)) return refuse("The email in the request does not match the email the relay reports for the account.");
      phoneKx = b64uDecode(claim.phoneKxPub); phoneAuth = b64uDecode(claim.phoneAuthPub);
      await importPublicKey(phoneKx, "ecdh"); await importPublicKey(phoneAuth, "ecdsa");
      if (claim.phoneActKey?.pub !== undefined) phoneActPub = b64uDecode(claim.phoneActKey.pub);
    } catch { return refuse("The request has a malformed key."); }

    const words = await checkWords({ pairingId, fpr: fpr.bytes, phoneKxPub: phoneKx, phoneAuthPub: phoneAuth, phoneActPub, accountId: claim.accountId });
    const email = stripCtl(frame.relayEmailMasked);                                  // the relay's value, the same as the phone's (checked above)
    out.write(`\nA phone wants to pair.\n  Device:  ${claim.deviceName}\n  Account: ${email}\n  Mode:    ${mode === "read" ? "read only" : "read and write"}\n  Check words: ${words.join(" ")}\n`);
    out.write("The phone must show the same four words. If they differ, answer N.\n");
    input.flush(quietMs);                                                           // M-A, L-15: only a line typed after this question AND after a short quiet window counts
    out.write(`Pair "${claim.deviceName}" (account ${email}) as ${mode === "read" ? "read-only" : "read and write"}? [y/N] `);
    const answer = await input.next(left());
    if (answer === null) {
      if (signal?.aborted) { try { channel.refuse(); } catch { /* gone */ } wipe(); say("\nCancelled. Nothing was paired.\n"); return 130; }
      return refuse(left() <= 0 ? "\nTimed out." : "\nNo answer.");
    }
    if (!/^(y|yes)$/i.test(answer.trim())) return refuse("Not paired.");

    // ---- yes: derive the keys, send the sealed accept, wait for the relay to confirm
    const root = await deriveRoot({ privateKey: keys.kxKey, peerPublicKey: await importPublicKey(phoneKx, "ecdh"), pairingId, secret });
    const mk = await deriveMessageKeys(root, { vault: machine.record.vault, deviceId: frame.deviceId, role: "machine", extractable: true });
    const raw = async (k) => b64uEncode(new Uint8Array(await subtle.exportKey("raw", k)));
    const deviceKeys = { send: await raw(mk.send), recv: await raw(mk.recv) };   // protocol 3: the OS keychain later; 0600 file for now
    const label = stripCtl(os.hostname(), 32).replace(/[^A-Za-z0-9 ._'-]/g, "") || "machine";
    const sealed = await sealPairing(secret, pairingId, "accept", {
      machineKxPub: b64uEncode(machine.mkxSpki), machineSigPub: b64uEncode(machine.msigSpki), vault: machine.record.vault, deviceId: frame.deviceId, machineLabel: label, mode,
    });
    wipe();                                                                         // single use: the secret is gone before anything else happens
    for (let i = events.length - 1; i >= 0; i--) if (events[i].k === "result") events.splice(i, 1);   // an error the relay sent BEFORE our accept (e.g. for a stray frame) is not the answer to it
    try { channel.accept(sealed, mode); } catch (e) { clearScreen(); err.write(`could not send the answer: ${stripCtl(e.message, 120)}\n`); return 1; }
    let res;
    do { res = await nextEvent(Math.min(15_000, Math.max(left(), 2000))); } while (res.k === "claim");
    if (res.k === "abort") { say("\nCancelled before the relay confirmed. Run eleven-sync devices to check.\n"); return 130; }
    if (res.k !== "result" || res.m.t !== "accepted") {
      const code = res.k === "result" ? (res.m.code ?? res.m.t) : res.k;
      clearScreen();
      if (code === "forbidden") { err.write("The relay refused to bind this vault: the account already has 20 vaults (or no free phone slot). Remove one with eleven-sync unpair --all, then pair again. Nothing was paired.\n"); return 1; }
      if (code === "read_only") { err.write("The relay is in read-only mode (maintenance). Nothing was paired; try again later.\n"); return 1; }
      err.write(`The relay did not confirm the pairing (${stripCtl(code, 40)}). Nothing was paired.\n`);
      return 1;
    }
    const rec = machine.record;
    rec.account = claim.accountId;
    rec.devices = rec.devices.filter((d) => d.deviceId !== frame.deviceId).concat({
      deviceId: frame.deviceId, name: claim.deviceName, mode, accountId: claim.accountId, emailMasked: email,
      phoneKxPub: claim.phoneKxPub, phoneAuthPub: claim.phoneAuthPub, phoneActKey: claim.phoneActKey ?? null, keys: deviceKeys, pairedAt: Date.now(),
    });
    saveRecord(machine.file, rec);
    say(`Paired "${claim.deviceName}" (${mode === "read" ? "read-only" : "read and write"}).\n`);
    return 0;
  } finally {
    wipe();
    try { channel?.close(); } catch { /* closed */ }
    input.stop();
  }
}

function pairingProblem(e) {
  const code = e?.code;
  if (code === "rate_limited") return "The relay says too many pairings were started today for this project. Try again later.";
  if (code === "plan_inactive") return "The relay says the plan is not active.";
  if (code === "read_only") return "The relay is in read-only mode (maintenance). Try again later.";
  if (code === "pairing_expired") return "This code expired. Run eleven-sync pair again.";
  if (code === "pairing_used") return "This code was already used. Run eleven-sync pair again.";
  if (code === "device_unknown") return "The relay does not know this machine any more. The vault was deleted.";
  return `could not start pairing: ${stripCtl(e?.message ?? e, 120)}`;
}
