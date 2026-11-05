// The structural check (protocol 8.5 step 9, security H2 fix 4). MIT.
// A line classifier plus a splice check: the new file must equal the old file with one span of lines replaced,
// and the replaced lines must have exactly the structure we meant (for example "one bullet, then plain text").
// The ledger core's own models (openQuestions, parseTasks, itemModel) are compared by apply.js on top of this.

const FENCE = /^\s*(```|~~~)/;
// Tested on the trimmed line: no two adjacent \s* around an optional "|", so no backtracking blow-up (security L1).
const DELIM = /^\|?\s*:?-+:?(?:\s*\|\s*:?-+:?)*\s*\|?$/;

export function classify(l) {
  if (/<!--|-->/.test(l)) return "comment";
  if (/^\s*$/.test(l)) return "blank";
  if (/^\s*#/.test(l)) return "heading";
  if (/^\s*(?:[-*_])(?:\s*[-*_]){2,}\s*$/.test(l) || /^\s*(=+|-+)\s*$/.test(l)) return "rule";
  if (/^\s*\|/.test(l) || (l.includes("|") && DELIM.test(l.trim()))) return "table";
  if (/^\s*>/.test(l)) return "quote";
  if (/^\s*</.test(l)) return "html";
  if (/^\s*status:/i.test(l)) return "status";
  if (/^\s*([-*+]|\d+[.)])(\s|$)/.test(l)) return "bullet";
  if (/^\s*\[[^\]]*\]:/.test(l)) return "refdef";
  if (/^ {4,}/.test(l)) return "indent";
  return "text";
}

// One token per line. Fence lines toggle code; lines inside a fence are "code" whatever they say.
export function tokens(lines) {
  let fence = false;
  return lines.map((l) => {
    if (FENCE.test(l)) { fence = !fence; return "fence"; }
    return fence ? "code" : classify(l);
  });
}

export const countOf = (text, re) => (text.match(re) || []).length;

// old lines [a, b) were replaced by count new lines whose tokens must be `want`.
// Returns null when fine, or a short reason.
export function checkSplice(oldLines, newLines, a, b, want) {
  if (newLines.length !== oldLines.length - (b - a) + want.length) return "line count";
  for (let i = 0; i < a; i++) if (oldLines[i] !== newLines[i]) return "text before the change moved";
  const tail = oldLines.length - b;
  for (let i = 0; i < tail; i++) if (oldLines[b + i] !== newLines[a + want.length + i]) return "text after the change moved";
  const to = tokens(oldLines), tn = tokens(newLines);
  const exp = [...to.slice(0, a), ...want, ...to.slice(b)];
  if (exp.length !== tn.length) return "token count";
  for (let i = 0; i < exp.length; i++) if (exp[i] !== tn[i]) return `line ${i + 1} is ${tn[i]}, expected ${exp[i]}`;
  const ct = (ls) => countOf(ls.join("\n"), /<!--/g);
  if (ct(oldLines.slice(a, b)) + ct(oldLines.slice(0, a)) + ct(oldLines.slice(b)) !== ct(newLines)) return "comment added";
  return null;
}
