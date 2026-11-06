// A small dependency-free QR Code encoder for the pairing code: byte mode, error correction M, versions 1..10, automatic mask.
// The algorithm is the one in ISO/IEC 18004; it was checked module-for-module against a reference encoder (test/qr-vectors.json).
// -> { version, mask, size, modules: boolean[][] }  (modules[y][x] === true is a dark module)

const SIZE_MAX_VERSION = 10;
const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   // index = version
const BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_BITS_M = 0;                                               // the 2-bit code for level M
const PENALTY = { n1: 3, n2: 3, n3: 40, n4: 10 };

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const a = Math.floor(ver / 7) + 2; r -= (25 * a - 10) * a - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];

// ---- Reed-Solomon over GF(256), polynomial 0x11D
function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; }
function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let p = size - 7; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
}

const bch = (value, poly, degree) => { let r = value; for (let i = 0; i < degree; i++) r = (r << 1) ^ ((r >>> (degree - 1)) * poly); return r; };

export function encodeQr(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input);
  // smallest version that fits: 4 (mode) + 8 or 16 (count) + 8 per byte
  let version = 0;
  for (let v = 1; v <= SIZE_MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (bytes.length < (1 << countBits) && 4 + countBits + bytes.length * 8 <= dataCodewords(v) * 8) { version = v; break; }
  }
  if (!version) throw new RangeError(`qr: ${bytes.length} bytes do not fit in version ${SIZE_MAX_VERSION}-M`);

  // ---- data bits
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCodewords(version) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // ---- blocks, ECC, interleave
  const nb = BLOCKS_M[version], eccLen = ECC_PER_BLOCK_M[version], raw = Math.floor(rawModules(version) / 8);
  const shortLen = Math.floor(raw / nb), nShort = nb - (raw % nb), div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(b[i]); });

  // ---- matrix
  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = alignPositions(version);
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask) => {
    const d = (FORMAT_BITS_M << 3) | mask;
    const f = ((d << 10) | bch(d, 0x537, 10)) ^ 0x5412;
    const b = (i) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
    set(8, size - 8, true);
  };
  drawFormat(0);                                   // reserve the format areas first
  if (version >= 7) {
    const v = (version << 12) | bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) !== 0, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }
  // zigzag placement of the codewords
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (!fn[y][x] && bi < all.length * 8) { mod[y][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
    }
  }
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const inv = [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
        ((x * y) % 2) + ((x * y) % 3) === 0, (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][mask];
      if (!fn[y][x] && inv) mod[y][x] = !mod[y][x];
    }
  };
  let best = -1, bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty(mod, size);
    if (p < bestPenalty) { best = m; bestPenalty = p; }
    applyMask(m);                                  // undo
  }
  applyMask(best); drawFormat(best);
  return { version, mask: best, size, modules: mod };
}

function penalty(mod, size) {
  let result = 0;
  const addHistory = (len, h) => { if (h[0] === 0) len += size; h.pop(); h.unshift(len); };
  const countPatterns = (h) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const terminate = (color, len, h) => { if (color) { addHistory(len, h); len = 0; } len += size; addHistory(len, h); return countPatterns(h); };
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      let color = false, run = 0; const h = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const dark = horizontal ? mod[a][b] : mod[b][a];
        if (dark === color) { run++; if (run === 5) result += PENALTY.n1; else if (run > 5) result++; }
        else { addHistory(run, h); if (!color) result += countPatterns(h) * PENALTY.n3; color = dark; run = 1; }
      }
      result += terminate(color, run, h) * PENALTY.n3;
    }
  }
  let darkCount = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (mod[y][x]) darkCount++;
    if (x < size - 1 && y < size - 1 && mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) result += PENALTY.n2;
  }
  const total = size * size;
  result += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * PENALTY.n4;
  return result;
}

// Two rows of modules per text line, black on white (explicit colours, so it scans on dark and light terminals). Quiet zone: 4 modules.
export function qrToText(qr, { quiet = 4 } = {}) {
  const n = qr.size + quiet * 2;
  const dark = (x, y) => x >= quiet && y >= quiet && x < n - quiet && y < n - quiet && qr.modules[y - quiet][x - quiet];
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let s = "";
    for (let x = 0; x < n; x++) {
      const t = dark(x, y), b = dark(x, y + 1);
      s += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    }
    lines.push(`\x1b[30;47m${s}\x1b[0m`);
  }
  return lines.join("\n") + "\n";
}
