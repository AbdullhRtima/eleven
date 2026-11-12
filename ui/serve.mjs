#!/usr/bin/env node
// Live UI without the browser's folder picker. Serves index.html at http://127.0.0.1:<port>/ and lets that page read the
// ledger over HTTP, for browsers where showDirectoryPicker() fails. Read-only, this computer only, no npm dependencies.
//
// Usage (from the project root):  node eleven/ui/serve.mjs [eleven-folder] [--port 7411]
// The folder defaults to the one that holds this ui/ folder. If it has an eleven/ sub-folder, that is used instead.
//
// What the page can read: the same files the folder picker shows (project.md, work/**, decisions/** .md and .html),
// never dotfiles, never anything outside the folder (symlinks are resolved and checked).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const PORT = portAt >= 0 ? Number(args.splice(portAt, 2)[1]) : 7411;
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) { console.error("--port needs a number from 0 to 65535"); process.exit(2); }

let root = path.resolve(args[0] || path.join(HERE, ".."));
if (fs.existsSync(path.join(root, "eleven")) && fs.statSync(path.join(root, "eleven")).isDirectory()) root = path.join(root, "eleven");
if (!fs.existsSync(root)) { console.error(`No such folder: ${root}`); process.exit(2); }
root = fs.realpathSync(root);
const NAME = path.basename(path.dirname(root)) || path.basename(root);   // the project folder, as the picker shows it

const keepFile = (n) => /\.(md|html?)$/i.test(n);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Same walk as fsaSource() in index.html: project.md at the top, everything kept under work/ and decisions/.
function scan() {
  const files = [], dirs = [];
  let ledger = false;
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".")) continue;
      const p = rel + "/" + e.name, a = path.join(abs, e.name);
      let st;
      try { st = fs.statSync(a); } catch { continue; }
      if (st.isDirectory()) { if (!inside(a)) continue; dirs.push(p); walk(a, p); }
      else if (st.isFile() && keepFile(e.name)) files.push({ p, mtime: Math.floor(st.mtimeMs) });
    }
  };
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".")) continue;
    const a = path.join(root, e.name);
    if (e.name === "work" || e.name === "decisions") {
      if (!fs.statSync(a).isDirectory() || !inside(a)) continue;
      ledger = true; dirs.push(e.name); walk(a, e.name);
    } else if (e.name === "project.md") { ledger = true; files.push({ p: e.name, mtime: Math.floor(fs.statSync(a).mtimeMs) }); }
    else if (e.name === "AGENTS.md") ledger = true;
  }
  return { name: NAME, ledger, dirs, files };
}
function inside(abs) {
  try { const r = fs.realpathSync(abs); return r === root || r.startsWith(root + path.sep); } catch { return false; }
}
// A ledger path the page may read, or null.
function allowed(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\\") || rel.includes("\0")) return null;
  const parts = rel.split("/");
  if (parts.some((s) => !s || s === "." || s === ".." || s.startsWith("."))) return null;
  if (!(parts.length === 1 ? rel === "project.md" : (parts[0] === "work" || parts[0] === "decisions") && keepFile(parts.at(-1)))) return null;
  const abs = path.join(root, ...parts);
  return inside(abs) ? abs : null;
}

// The page as published blocks every request (connect-src 'none'). Served from here it may call back to this server only.
function page() {
  const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
  const out = html.replace("connect-src 'none'", "connect-src 'self'")
    .replace(/(<meta http-equiv="Content-Security-Policy"[^>]*>)/, `$1\n<meta name="eleven-local" content="${esc(NAME)}">`);
  if (out === html || !out.includes('name="eleven-local"')) throw new Error("index.html has no Content-Security-Policy meta to adjust");
  return out;
}

const server = http.createServer((req, res) => {
  const send = (code, body, type = "text/plain; charset=utf-8", extra = {}) => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
    res.end(body);
  };
  // Only this computer, only by its own name (stops DNS rebinding), only GET, never from another site.
  const host = String(req.headers.host || "");
  if (host !== `127.0.0.1:${PORT_REAL}` && host !== `localhost:${PORT_REAL}`) return send(403, "Wrong host.\n");
  if (req.method !== "GET") return send(405, "Read-only.\n");
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return send(403, "Not from another site.\n");
  const u = new URL(req.url, `http://${host}`);
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") return send(200, page(), "text/html; charset=utf-8");
    if (u.pathname === "/__eleven/scan") return send(200, JSON.stringify(scan()), "application/json");
    if (u.pathname === "/__eleven/file") {
      const abs = allowed(u.searchParams.get("p"));
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(404, "Not a ledger file.\n");
      // Bytes for the page to read, never a document to open here: an .html mockup must not run on this origin.
      return send(200, fs.readFileSync(abs), "application/octet-stream",
        { "Content-Disposition": "attachment", "Content-Security-Policy": "sandbox; default-src 'none'" });
    }
    return send(404, "Not found.\n");
  } catch (e) {
    console.error(e);
    return send(500, "Couldn't read the folder.\n");
  }
});
let PORT_REAL = PORT;
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is in use. Try: --port ${PORT + 1}` : e.message);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  PORT_REAL = server.address().port;
  console.log(`eleven live UI for ${root}`);
  console.log(`Open http://127.0.0.1:${PORT_REAL}/ in any browser. Ctrl+C stops it.`);
});
