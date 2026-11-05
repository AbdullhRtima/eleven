// Walk eleven/ and list the files that sync (protocol section 7.1). MIT.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LIMITS = { maxBytes: 1024 * 1024, maxFiles: 5000 };
const ROOTS = ["project.md", "work", "decisions"];
const kindOf = (name) => (/\.md$/i.test(name) ? "md" : /\.html$/i.test(name) ? "html" : null);

// -> { files: [{ path, mtime, size, sha256, kind }], dirs: [path], skipped: [{ path, reason }], texts?: Map }
export function scan(elevenDir, { includeText = false } = {}) {
  const root = fs.realpathSync(elevenDir);
  const files = [], dirs = [], skipped = [], texts = new Map();
  const inside = (p) => { const r = path.relative(root, p); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r); };

  function visit(rel, isTop) {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    const name = path.basename(rel);
    if (name.startsWith(".")) return;
    if (st.isSymbolicLink()) { skipped.push({ path: rel, reason: "symlink" }); return; }
    if (st.isDirectory()) {
      let real; try { real = fs.realpathSync(abs); } catch { return; }
      if (!inside(real)) { skipped.push({ path: rel, reason: "outside" }); return; }
      dirs.push(rel);
      for (const n of fs.readdirSync(abs).sort()) visit(`${rel}/${n}`, false);
      return;
    }
    if (!st.isFile()) return;
    const kind = kindOf(name);
    if (!kind || (isTop && rel !== "project.md")) return;
    if (st.size > LIMITS.maxBytes) { skipped.push({ path: rel, reason: "too large" }); return; }
    if (files.length >= LIMITS.maxFiles) { skipped.push({ path: rel, reason: "file limit" }); return; }
    let real; try { real = fs.realpathSync(abs); } catch { return; }
    if (!inside(real)) { skipped.push({ path: rel, reason: "outside" }); return; }
    const buf = fs.readFileSync(abs);
    if (buf.length > LIMITS.maxBytes) { skipped.push({ path: rel, reason: "too large" }); return; }
    files.push({ path: rel, mtime: Math.floor(st.mtimeMs), size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("base64url"), kind });
    if (includeText && kind === "md") texts.set(rel, { text: buf.toString("utf8") });
  }

  for (const r of ROOTS) visit(r, true);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  dirs.sort();
  return includeText ? { files, dirs, skipped, texts } : { files, dirs, skipped };
}
