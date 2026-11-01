// Minimal Chrome DevTools Protocol driver: headless Chrome, real input events, no npm dependencies (Node 22+).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1280, height = 900 } = {}) {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}. Set CHROME=/path/to/chrome.`);
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "eleven-ui-test-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--allow-file-access-from-files", "--remote-debugging-port=0", `--user-data-dir=${ud}`, `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = fs.readFileSync(path.join(ud, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { await sleep(100); }
  }
  if (!port) { proc.kill(); throw new Error("Chrome did not start (no DevToolsActivePort)"); }
  const base = `http://127.0.0.1:${port}`;
  let list = [];
  for (let i = 0; i < 50; i++) { try { list = await (await fetch(base + "/json/list")).json(); if (list.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map(), events = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method) events.push(d);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable"); await send("Log.enable");

  const api = {
    send, events,
    async tabs() { return (await (await fetch(base + "/json/list")).json()).filter((t) => t.type === "page"); },
    async viewport(w, h, mobile = false) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile }); },
    async go(fileUrl, readyExpr = "!!document.getElementById('__eleven_test_out')") {
      events.length = 0;
      await send("Page.navigate", { url: "about:blank" }); await sleep(100);
      await send("Page.navigate", { url: fileUrl });
      const t = await api.waitFor(readyExpr, 10000);
      await sleep(400);   // let rAF work (Show more, graph fit) settle
      return t;
    },
    async ev(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error("page: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
      return r.result?.result?.value;
    },
    // Resolves with ms waited, or -1 on timeout.
    waitFor(cond, ms = 8000) {
      return api.ev(`new Promise(res=>{const t0=performance.now();const tick=()=>{let ok=false;try{ok=!!(${cond})}catch{}if(ok)res(Math.round(performance.now()-t0));else if(performance.now()-t0>${ms})res(-1);else setTimeout(tick,25)};tick()})`);
    },
    async mouse(type, x, y, extra = {}) { await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra }); },
    async clickAt(x, y) { await api.mouse("mouseMoved", x, y, { button: "none" }); await api.mouse("mousePressed", x, y); await api.mouse("mouseReleased", x, y); },
    // Real mouse click in the middle of the first element matching the selector (scrolled into view first).
    async click(sel) {
      const r = await api.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:"center"});const b=e.getBoundingClientRect();return [b.x+Math.min(b.width/2,20),b.y+b.height/2]})()`);
      if (!r) return false;
      await api.clickAt(r[0], r[1]); return true;
    },
    requests() { return events.filter((e) => e.method === "Network.requestWillBeSent").map((e) => e.params.request.url); },
    exceptions() { return events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text); },
    async shot(file) { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(file, Buffer.from(r.result.data, "base64")); },
    async close() { try { ws.close(); } catch {} proc.kill(); await sleep(300); fs.rmSync(ud, { recursive: true, force: true }); },
  };
  return api;
}
