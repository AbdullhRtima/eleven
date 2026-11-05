// Text rules for phone input (protocol sections 2 and 8.4, security H2). MIT.
// Everything here is pure: strings in, strings out.

export const LIMITS = { answer: 4000, problem: 4000, lines: 200, title: 120, device: 32, rawCap: 64000 };

const CTRL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\uFEFF]/g;          // C0/C1 except \n, line/para separators, BOM
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;                          // bidi controls (the spec list plus ALM, LRM, RLM)

// Invisible to the user, readable by a model (security M2, N3): one class rule instead of a hand list. Every format (Cf) and
// Default_Ignorable_Code_Point character goes: tags, zero-width and joiners, word joiner and invisible operators, BOM,
// variation selectors, soft hyphen, CGJ, the musical and Egyptian format controls, and so on. The Hangul and halfwidth fillers
// are listed too, in case a Unicode version stops counting them as ignorable.
// Private use (\p{Co}, all planes) and the braille blank U+2800 go too: they draw as a box or a blank, so a run of them carries
// bits nobody can read (4d follow-up).
// The one exception: a grapheme that is exactly one RGI emoji (family, rainbow flag, keycap, skin tone, Scotland flag) is kept
// as it is. RGI is a fixed list, so there is no free choice of hidden bits left in it. Everything else in the text is stripped,
// even a ZWJ between two emoji that do not form an RGI sequence.
// Needs Node 20+ (the /v flag and \p{RGI_Emoji}); package.json engines already says >=20. The RGI list is the one in the
// runtime's ICU: an emoji newer than that loses its joiners (fails safe).
// Cost: one pass for the test, and the segmenter only when something is there to strip, so it is linear.
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\u2800\u115F\u1160\u3164\uFFA0]/gu;
const HAS_HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\u2800\u115F\u1160\u3164\uFFA0]/u;
const RGI = /^\p{RGI_Emoji}$/v;
const SEG = new Intl.Segmenter("en", { granularity: "grapheme" });
export function stripHidden(s, { keepEmoji = true } = {}) {
  let t = s;
  if (HAS_HIDDEN.test(t)) {
    if (!keepEmoji) t = t.replace(HIDDEN, "");
    else {
      let out = "";
      for (const { segment: g } of SEG.segment(t)) out += HAS_HIDDEN.test(g) && !RGI.test(g) ? g.replace(HIDDEN, "") : g;
      t = out;
    }
  }
  return t.replace(BIDI, "");
}

export const cpLen = (s) => [...s].length;

// Section 2: NFC, CRLF to LF, strip controls and bidi. A tab becomes a space (the spec strips it; a space keeps words apart).
export function cleanText(s) {
  let t = String(s).toWellFormed().normalize("NFC").replace(/\r\n/g, "\n").replace(/\t/g, " ");
  t = stripHidden(t.replace(CTRL, ""));
  return t.normalize("NFC");
}

// The line starts like Markdown or ledger structure. Used on the line itself and on its NFKC-folded copy (N5).
const startsRisky = (l, folded) =>
  /^status:/i.test(l) || /^(\d+)([.)])(?=\s|$)/.test(l) || /^[#|`~*_\-+=<>\[:]/.test(l) || /^!\[/.test(l) || (folded && /^NEXT(?![A-Za-z0-9])/.test(l));

// One line, trimmed. Escape a risky start with a backslash (8.4, H2 fix 4). Called after trimming, on every line.
// N5: a fullwidth or compatibility lookalike ("Ｓtatus：", "＃＃", "｜", "－－－", "ＮＥＸＴ") is no Markdown, but an agent reading
// the file may fold it. So a COPY is NFKC-folded only to find a risky start; when it has one, the original's first character is
// escaped. The text itself is never folded or changed otherwise. Confusables without a fold (Cyrillic "Ѕtatus:") stay possible:
// the only Status line that counts is the one ledger-core reads.
export function escapeLine(l) {
  if (/^status:/i.test(l)) return l.replace(/^(status):/i, "$1\\:");
  const d = l.match(/^(\d+)([.)])(?=\s|$)/);
  if (d) return `${d[1]}\\${d[2]}${l.slice(d[0].length)}`;
  if (/^[#|`~*_\-+=<>\[:]/.test(l) || /^!\[/.test(l)) return "\\" + l;
  const f = l.normalize("NFKC");
  if (f !== l && startsRisky(f, true)) return "\\" + l;
  return l;
}

// "<", "[", "]" and "&" are escaped everywhere (M2, N1, N2): no inline HTML (<span hidden>, <details>, <?, <![CDATA[), no Markdown
// link or image (its title or URL would hide text) and no entity (&#xE0041;, &ZeroWidthSpace;) can hide text. Backslashes just
// before one of them are doubled: otherwise a typed "\<" would become "\\<" and the "<" would be live again. The lookbehind
// makes a match start only at the start of a backslash run, so the scan is linear (a plain /(\\*)</ is quadratic).
// A bare URL ("http://x", "www.x") is turned into a link by /app (marked's GFM autolink), and inside it backslash escapes are
// NOT processed: "\&ZeroWidthSpace;" would still decode to a hidden character in the link text. So the ";" that ends an
// entity-like "&name;" or "&#123;" is escaped too ("\&name\;"): no entity can form there, and the text stays visible.
const ESC_CORE = (t) => t.replace(/(?<!\\)(\\*)([<\[\]&])/g, "$1$1\\$2").replace(/\\&([#A-Za-z0-9]+);/g, "\\&$1\\;");
// The same rule bites on "<": marked's autolink takes everything up to the next "<" or space, so in "http://x\\<!-- c -->" the
// backslash is swallowed by the URL and the "<" after it is live (a comment or tag can then hide text). In a word that contains a
// URL start, "<" is written as the entity "&lt;" instead: it shows as "<" in the link text and in plain text alike, and in the file
// it is plain, visible text. The other pieces of such a word get the normal escapes.
const URLISH = /(?:https?:\/\/|ftp:\/\/|www\.)/i;
export const escapeLt = (t) => t.replace(/\S+/g, (w) => (w.includes("<") && URLISH.test(w) ? w.split("<").map(ESC_CORE).join("&lt;") : ESC_CORE(w)));
export const escapeTitle = (t) => escapeLt(t.replace(/[|#]/g, "\\$&"));

// answer and problem. -> { lines } or { error: "too_long" | "bad_request" }
export function prepBlock(raw, { max, keepBlank }) {
  if (typeof raw !== "string") return { error: "bad_request" };
  if (raw.length > LIMITS.rawCap) return { error: "too_long" };
  const t = cleanText(raw);
  if (cpLen(t) > max) return { error: "too_long" };
  let lines = t.split("\n");
  if (lines.length > LIMITS.lines) return { error: "too_long" };
  lines = lines.map((l) => l.trim());
  if (keepBlank) {
    const out = [];
    for (const l of lines) if (l || (out.length && out[out.length - 1] !== "")) out.push(l);
    while (out.length && out[out.length - 1] === "") out.pop();
    lines = out;
  } else lines = lines.filter(Boolean);
  if (!lines.length && !keepBlank) return { error: "bad_request" };
  return { lines: lines.map((l) => (l ? escapeLine(escapeLt(l)) : l)) };
}

// -> { title } or { error }
export function prepTitle(raw) {
  if (typeof raw !== "string") return { error: "bad_request" };
  if (raw.length > LIMITS.rawCap) return { error: "too_long" };
  const t = cleanText(raw);
  if (t.includes("\n")) return { error: "bad_request" };
  const c = t.replace(/\s+/g, " ").trim();
  if (!c) return { error: "bad_request" };
  if (cpLen(c) > LIMITS.title) return { error: "too_long" };
  return { title: c };
}

// Lowercase ASCII, [a-z0-9-], runs of - collapsed, <= 40, "item" if empty (8.3). Unicode lookalikes do not survive.
export function slugify(title) {
  let s = String(title).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  s = s.slice(0, 40).replace(/-+$/g, "");
  return s || "item";
}

// The device name goes into a ledger line: keep letters, digits, space . ' - only; at most 32 characters.
export function deviceLabel(name) {
  const t = cleanText(typeof name === "string" ? name : "").replace(/[^\p{L}\p{N} .'\-]/gu, "").replace(/\s+/g, " ").trim();
  return [...t].slice(0, LIMITS.device).join("").trim() || "phone";
}

export function localDate(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
