// Find the eleven/ folder: from a start dir, walk up. MIT.
import fs from "node:fs";
import path from "node:path";

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
// An eleven folder has work/ or project.md. A bare folder named "eleven" is not enough.
const looksLikeEleven = (d) => isDir(d) && (isDir(path.join(d, "work")) || isFile(path.join(d, "project.md")));

export function findEleven(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (path.basename(dir) === "eleven" && looksLikeEleven(dir)) return dir;
    const child = path.join(dir, "eleven");
    if (looksLikeEleven(child)) return child;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
