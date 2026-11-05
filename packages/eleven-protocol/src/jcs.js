// RFC 8785 JSON Canonicalization Scheme for the JSON values this protocol uses.
// Numbers use ECMAScript Number-to-string (what RFC 8785 requires); strings use JSON.stringify,
// which emits the escapes RFC 8785 specifies. Keys sort by UTF-16 code units (default JS sort).
// Rejected: NaN/Infinity, undefined, functions, symbols, bigint, lone surrogates, non-plain objects.
export function jcs(v) {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("jcs: non-finite number");
      return Object.is(v, -0) ? "0" : JSON.stringify(v);
    case "string":
      if (!isWellFormed(v)) throw new Error("jcs: lone surrogate");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (!(i in v)) throw new Error("jcs: sparse array");
        return "[" + v.map(jcs).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error("jcs: not a plain object");
      const keys = Object.keys(v).sort();
      return "{" + keys.map((k) => jcs(k) + ":" + jcs(v[k])).join(",") + "}";
    }
    default: throw new Error("jcs: unsupported type " + typeof v);
  }
}

function isWellFormed(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
