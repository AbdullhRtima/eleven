import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { encodeQr, qrToText } from "../src/qr.js";
import { WORDS } from "../../eleven-protocol/src/wordlist.js";

// Reference matrices from an independent encoder (Nayuki's qrcodegen, via qrcode.react 3.1.0): byte mode, ECC M, no ECC boost.
const vectors = JSON.parse(fs.readFileSync(new URL("./qr-vectors.json", import.meta.url), "utf8"));

for (const v of vectors) {
  test(`QR: version ${v.version} (${v.text.length} bytes) matches the reference module for module`, () => {
    const q = encodeQr(v.text);
    assert.equal(q.version, v.version);
    assert.equal(q.mask, v.mask);
    assert.deepEqual(q.modules.map((r) => r.map((x) => (x ? "1" : "0")).join("")), v.rows);
  });
}

test("QR: the finder patterns, timing pattern and dark module are where the standard puts them", () => {
  const { modules: m, size } = encodeQr("hello");
  assert.equal(size, 21);
  const ring = (x0, y0) => { for (let i = 0; i < 7; i++) assert.ok(m[y0][x0 + i] && m[y0 + 6][x0 + i] && m[y0 + i][x0] && m[y0 + i][x0 + 6]); assert.ok(m[y0 + 3][x0 + 3]); assert.ok(!m[y0 + 1][x0 + 1]); };
  ring(0, 0); ring(14, 0); ring(0, 14);
  for (let i = 8; i < 13; i++) assert.equal(m[6][i], i % 2 === 0);
  assert.ok(m[13][8], "dark module");
});

test("QR: sizes grow with the data, the limit is version 10 (213 bytes), and the 16-bit count is used from version 10", () => {
  assert.equal(encodeQr("a".repeat(14)).version, 1);
  assert.equal(encodeQr("a".repeat(15)).version, 2);
  assert.equal(encodeQr("a".repeat(213)).version, 10);
  assert.throws(() => encodeQr("a".repeat(214)), RangeError);
});

test("QR: a real pairing link fits (about 150 bytes -> version 8)", () => {
  const link = "https://m.eleven.rtima.org/pair#v1." + "p".repeat(25) + "." + "s".repeat(43) + "." + "f".repeat(43);
  assert.equal(encodeQr(link).version, 8);
});

test("QR text: two module rows per line, 4-module quiet zone, explicit black on white", () => {
  const q = encodeQr("hello");
  const lines = qrToText(q).trimEnd().split("\n");
  assert.equal(lines.length, Math.ceil((21 + 8) / 2));
  assert.ok(lines.every((l) => l.startsWith("\x1b[30;47m") && l.endsWith("\x1b[0m")));
  assert.equal(lines[0].replace(/\x1b\[[0-9;]*m/g, "").length, 29);
});

test("the check-word list is the BIP-39 English list (2048 words, known SHA-256)", () => {
  assert.equal(WORDS.length, 2048);
  assert.equal(crypto.createHash("sha256").update(WORDS.join("\n") + "\n").digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
});
