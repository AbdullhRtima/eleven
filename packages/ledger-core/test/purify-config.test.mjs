import test from "node:test";
import assert from "node:assert/strict";
import { configurePurify } from "../purify-config.js";

const fake = () => { const hooks = {}; return { hooks, addHook: (n, f) => { hooks[n] = f; } }; };
const el = (nodeName, attrs = {}) => {
  const a = new Map(Object.entries(attrs)); let removed = false;
  return { nodeName, get removed() { return removed; }, remove() { removed = true; }, getAttribute: (k) => a.get(k) ?? null, hasAttribute: (k) => a.has(k),
    setAttribute: (k, v) => a.set(k, v), removeAttribute: (k) => a.delete(k), get attributes() { return [...a.keys()].map((name) => ({ name })); }, a };
};

test("configurePurify returns the config and registers both hooks", () => {
  const d = fake(); const cfg = configurePurify(d);
  assert.equal(cfg.ALLOW_DATA_ATTR, false);
  for (const t of ["svg", "style", "iframe", "form"]) assert.ok(cfg.FORBID_TAGS.includes(t), t);
  for (const t of ["style", "class", "id", "srcset"]) assert.ok(cfg.FORBID_ATTR.includes(t), t);
  assert.deepEqual(Object.keys(d.hooks).sort(), ["afterSanitizeAttributes", "uponSanitizeElement"]);
});
test("hooks: only a disabled task-list checkbox survives; remote images are parked in data-remote", () => {
  const d = fake(); configurePurify(d);
  const text = el("INPUT", { type: "text" }); d.hooks.uponSanitizeElement(text, { tagName: "input" }); assert.equal(text.removed, true);
  const box = el("INPUT", { type: "checkbox", checked: "", onclick: "x" }); d.hooks.uponSanitizeElement(box, { tagName: "input" }); assert.equal(box.removed, false);
  d.hooks.afterSanitizeAttributes(box); assert.deepEqual([...box.a], [["type", "checkbox"], ["disabled", ""], ["checked", ""]]);
  const img = el("IMG", { src: "//x.test/a.png" }); d.hooks.afterSanitizeAttributes(img); assert.equal(img.a.get("data-remote"), "https://x.test/a.png"); assert.equal(img.a.has("src"), false);
  const data = el("IMG", { src: "data:image/png;base64,AA" }); d.hooks.afterSanitizeAttributes(data); assert.equal(data.a.get("src"), "data:image/png;base64,AA");
});
