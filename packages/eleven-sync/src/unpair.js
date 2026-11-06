// `eleven-sync unpair --all`: delete this project's vault at the relay (signed DELETE /v1/vault/:vault, machine only), and only after
// the relay says yes, remove the local keys and state. Destructive on both sides, so it asks for a typed confirmation at a terminal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { b64uDecode } from "../../eleven-protocol/src/index.js";
import { findEleven } from "./find.js";
import { loadMachineRecord, vaultFile } from "./pair.js";
import { createRelayClient, RelayError, clean } from "./relay-client.js";
import { acquireLock, StartError } from "./lock.js";
import { daemonPaths } from "./start.js";

// one line from stdin; anything that arrives within `quietMs` of the question is discarded (L-15), as are earlier lines
const ask = (stdin, out, q, quietMs) => new Promise((ok) => {
  out.write(q);
  const t0 = Date.now();
  const rl = readline.createInterface({ input: stdin, terminal: false });
  let done = false;
  rl.on("line", (l) => { if (done || Date.now() - t0 < quietMs) return; done = true; rl.close(); ok(l.trim()); });
  rl.once("close", () => { if (!done) ok(""); });
});

/** -> exit code: 0 unpaired (or the relay no longer knows the vault) · 1 nothing changed */
export async function unpairAll({ dir = ".", stateDir = path.join(os.homedir(), ".config", "eleven-sync"), cwd = process.cwd(), quietMs = 300, stdin = process.stdin, out = process.stdout, err = process.stderr, fetch = globalThis.fetch } = {}) {
  if (!stdin?.isTTY) { err.write("eleven-sync unpair --all asks for a typed confirmation and needs a terminal (stdin is not a TTY). Nothing changed.\n"); return 1; }
  const elevenDir = findEleven(path.resolve(cwd, dir));
  if (!elevenDir) { err.write(`no eleven/ folder found from ${path.resolve(cwd, dir)} upward\n`); return 1; }
  let record;
  try { record = loadMachineRecord(stateDir, elevenDir); } catch (e) { err.write(`could not read the machine keys: ${clean(e.message)}\n`); return 1; }
  if (!record?.vault) { err.write("this project has no vault. Nothing to unpair.\n"); return 1; }
  const paths = daemonPaths(stateDir, elevenDir);
  let release;
  try { release = acquireLock(paths.lock); }                               // a running daemon must be stopped first
  catch (e) { if (e instanceof StartError) { err.write(e.message + "\n"); return 1; } throw e; }
  try {
    out.write(`This deletes the vault ${record.vault.slice(0, 8)}... at ${record.relay} with everything queued in it, unpairs ${record.devices.filter((d) => !d.revoked).length} phone(s), and removes the keys and state kept here for this project.\n`);
    if ((await ask(stdin, out, 'Type "unpair" to continue: ', quietMs)) !== "unpair") { out.write("\nCancelled. Nothing changed.\n"); return 1; }
    let gone = false;
    try {
      const signingKey = await globalThis.crypto.subtle.importKey("pkcs8", b64uDecode(record.msig.priv), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const client = createRelayClient({ baseUrl: record.relay, vault: record.vault, deviceKeys: { deviceId: record.deviceId, signingKey }, fetch, maxHttpRetries: 1, backoff: { baseMs: 200, maxMs: 2000 } });
      await client.deleteVault();
      gone = true;
    } catch (e) {
      if (e instanceof RelayError && e.code === "device_unknown") { out.write("The relay does not know this vault any more (already deleted). Removing the local state.\n"); gone = true; }
      else {
        const why = e instanceof RelayError && e.code === "read_only" ? "the relay is in read-only mode (maintenance); try again later" : clean(e?.code ?? e?.message);
        err.write(`The relay did not delete the vault (${why}). Nothing was removed here.\n`);
        return 1;
      }
    }
    if (gone) {
      release(); release = null;
      fs.rmSync(paths.dir, { recursive: true, force: true });
      fs.rmSync(vaultFile(stateDir, elevenDir), { force: true });
      out.write("Unpaired. The vault is deleted and the local keys and state are removed.\n");
    }
    return 0;
  } finally { release?.(); }
}
