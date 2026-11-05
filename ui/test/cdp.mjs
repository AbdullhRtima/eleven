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
  const sandbox = process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []; // CI only: runner Chrome can't create its sandbox
  const proc = spawn(CHROME, [...sandbox, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
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
  // errors: every uncaught exception and console.error for the whole run (never cleared by go()). contexts: live JS
  // contexts by frame, so a check can evaluate inside an iframe.
  // frameSessions: out-of-process iframes (Chrome isolates sandboxed frames), attached with flatten: sessionId -> targetInfo.
  const errors = [], contexts = new Map(), cur = { at: "" }, frameSessions = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (!d.method) return;
    events.push(d);
    const p = d.params;
    if (d.method === "Target.attachedToTarget") {
      if (p.targetInfo.type === "iframe") { frameSessions.set(p.sessionId, p.targetInfo); send("Runtime.enable", {}, p.sessionId); }
      return;
    }
    if (d.method === "Target.detachedFromTarget") { frameSessions.delete(p.sessionId); return; }
    if (d.sessionId && d.method.startsWith("Runtime.execution")) return;   // contexts below are the page's own
    if (d.method === "Runtime.exceptionThrown") errors.push({ at: cur.at, error: p.exceptionDetails.exception?.description || p.exceptionDetails.text });
    else if (d.method === "Runtime.consoleAPICalled" && p.type === "error") errors.push({ at: cur.at, error: "console.error: " + p.args.map((a) => a.value ?? a.description).join(" ") });
    else if (d.method === "Runtime.executionContextCreated") contexts.set(p.context.id, p.context);
    else if (d.method === "Runtime.executionContextDestroyed") contexts.delete(p.executionContextId);
    else if (d.method === "Runtime.executionContextsCleared") contexts.clear();
  };
  const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable"); await send("Log.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const api = {
    send, events, errors,
    async tabs() { return (await (await fetch(base + "/json/list")).json()).filter((t) => t.type === "page"); },
    async viewport(w, h, mobile = false) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile }); },
    async go(fileUrl, readyExpr = "!!document.getElementById('__eleven_test_out')") {
      events.length = 0;
      cur.at = fileUrl.split("#")[1] || fileUrl.split("/").pop();
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
    // Evaluate in the (last attached) child frame, e.g. the sandboxed .html view: an out-of-process frame through its own
    // session, else a same-process child frame through its context. Null if there is none.
    async evFrame(expr, ms = 4000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const sid = [...frameSessions.keys()].at(-1);
        let r = null;
        if (sid) r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
        else {
          const child = (await send("Page.getFrameTree")).result.frameTree.childFrames?.[0]?.frame;
          const ctx = child && [...contexts.values()].find((c) => c.auxData?.frameId === child.id && c.auxData?.isDefault);
          if (ctx) r = await send("Runtime.evaluate", { expression: expr, contextId: ctx.id, awaitPromise: true, returnByValue: true });
        }
        if (r?.result?.result && !r.result.exceptionDetails) return { value: r.result.result.value };
        await sleep(100);
      }
      return null;
    },
    // URLs of the page's frames (same-process and out-of-process), page first.
    async frames() {
      const out = [];
      const walk = (n) => { out.push(n.frame.url); (n.childFrames || []).forEach(walk); };
      walk((await send("Page.getFrameTree")).result.frameTree);
      for (const sid of frameSessions.keys()) { const t = (await send("Page.getFrameTree", {}, sid)).result?.frameTree; if (t) walk(t); }
      return [...new Set(out)];
    },
    // Close every other tab (e.g. one a link opened) and bring this one back to the front: input to a background tab can stall.
    async closeOtherTabs() {
      const me = (await send("Target.getTargetInfo")).result?.targetInfo?.targetId;
      for (const t of await api.tabs()) if (t.id !== me) await fetch(`${base}/json/close/${t.id}`).catch(() => {});
      await send("Page.bringToFront");
    },
    async wheel(x, y, deltaX, deltaY, modifiers = 0) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, modifiers }); },
    async drag(x1, y1, x2, y2) {
      await api.mouse("mouseMoved", x1, y1, { button: "none" }); await api.mouse("mousePressed", x1, y1);
      for (let i = 1; i <= 5; i++) await api.mouse("mouseMoved", x1 + (x2 - x1) * i / 5, y1 + (y2 - y1) * i / 5, { buttons: 1 });
      await api.mouse("mouseReleased", x2, y2);
    },
    async key(key, code = key) { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: key === "Enter" ? 13 : 0 }); },
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
