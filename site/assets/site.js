/* eleven landing page: shared by / (EN) and /ar/ (AR). Language-specific copy lives in each HTML (window.ELEVEN_T for JS strings). */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = document.documentElement;
/* Reduced motion is live: turning it on mid-visit moves every module to its static state; turning it off restarts the loops. */
const mqRM = matchMedia("(prefers-reduced-motion: reduce)");
let RM = mqRM.matches || root.dataset.motion === "reduce";
const onMotion = [];
mqRM.addEventListener("change", () => { const v = mqRM.matches || root.dataset.motion === "reduce"; if (v !== RM) { RM = v; onMotion.forEach((f) => f()); } });
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/* ======================================================== copy: each page sets window.ELEVEN_T (its JS-only strings) inline */
const STR = window.ELEVEN_T || {};
const lang = root.lang === "ar" ? "ar" : "en";
const T = (k) => STR[k] ?? k;
const RN = (r) => STR["role." + r] ?? r;   // role name in diagrams: translated on /ar/ (except the hero ring), the key on /

/* ======================================================== language link (design.md §2): a plain link; JS saves eleven-lang and keeps the #hash */
const ll = $("#langLink");
if (ll) ll.addEventListener("click", (e) => {
  const to = ll.getAttribute("hreflang") === "ar" ? "ar" : "en";
  let href = ll.getAttribute("href"), saved = true;
  try { localStorage.setItem("eleven-lang", to); } catch (err) { saved = false; }
  if (!saved && to === "en") href = "/?lang=en";   // storage blocked: the escape param stops the redirect instead
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // new tab/window: default link
  e.preventDefault(); location.href = href + location.hash;
});

/* ======================================================== theme: Auto -> Light -> Dark (key eleven-theme, absent = auto) */
const ICON = {
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
};
const tb = $("#themeBtn");
const themeNow = () => root.dataset.theme || "auto";
const onTheme = [];
function paintThemeBtn() {
  const s = themeNow();
  tb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICON[s] + "</svg>";
  tb.setAttribute("aria-label", T("theme." + s)); tb.title = T("theme." + s);
}
/* Browser chrome colour follows the effective theme: each theme-color meta keeps its media query, a forced theme overrides its colour. */
const TC = { light: "#F3EFE6", dark: "#0B0D12" };
function syncThemeColor() {
  const s = themeNow();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = TC[s === "auto" ? (/dark/.test(m.media) ? "dark" : "light") : s]; });
}
syncThemeColor(); onTheme.push(syncThemeColor);
tb.hidden = false;
tb.addEventListener("click", () => {
  const next = { auto: "light", light: "dark", dark: "auto" }[themeNow()];
  if (next === "auto") { delete root.dataset.theme; store.set("eleven-theme", null); } else { root.dataset.theme = next; store.set("eleven-theme", next); }
  paintThemeBtn(); onTheme.forEach((f) => f());
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => onTheme.forEach((f) => f()));

/* ======================================================== visibility: run animations only on screen and in a visible tab */
const vis = new WeakMap();
const io = new IntersectionObserver((es) => es.forEach((e) => { vis.set(e.target, e.isIntersecting); e.target.classList.toggle("run", e.isIntersecting); e.target.dispatchEvent(new Event(e.isIntersecting ? "on" : "off")); }), { rootMargin: "60px" });
$$("[data-live]").forEach((el) => io.observe(el));
const live = (el) => !document.hidden && vis.get(el) !== false;
document.addEventListener("visibilitychange", () => { if (!document.hidden) $$("[data-live]").forEach((el) => vis.get(el) && el.dispatchEvent(new Event("on"))); });
function loopWhileLive(el, frame) { // rAF loop that stops off-screen and resumes on "on"
  let id = 0, last = 0;
  const tick = (now) => { if (RM || !live(el)) { id = 0; return; } const dt = last ? Math.min(64, now - last) : 16; last = now; frame(dt, now); id = requestAnimationFrame(tick); };
  const start = () => { if (!id && !RM) { last = 0; id = requestAnimationFrame(tick); } };
  el.addEventListener("on", start); onMotion.push(start); start();
}
const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();

/* nav border on scroll */
const nav = $("nav.top");
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

/* ======================================================== HERO: eleven strings resonate, then braid into one loop */
(() => {
  const cv = $("#strings"), cx2 = cv.getContext("2d"), hero = $(".hero");
  const N = 11, SEG = 150, ROLES = ["cto", "product", "designer", "architect", "backend", "frontend", "mobile", "qa", "devops", "security", "writer"];
  let W = 0, H = 0, cx = 0, cy = 0, R = 0, A = 0, gap = 0, wide = true, rtl = false, C = {};
  let T0 = performance.now(), tok = 0, prevS = 0;
  const pl = Array.from({ length: N }, (_, i) => ({ t: .25 + i * .11, a: 1, w: 10 + (i % 4) * 1.7, m: 1 + (i % 3) }));
  const lit = new Array(N).fill(-99);
  vis.set(hero, true);
  io.observe(hero); hero.setAttribute("data-live", "");
  function colors() {
    C = { s: css("--string"), sa: parseFloat(css("--string-alpha")) || .6, glow: css("--glow") === "1", a: css("--accent-hi"), ink: css("--ink"), mu: css("--muted"), bg: css("--bg") };
  }
  function size() {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    wide = matchMedia("(min-width: 901px)").matches; rtl = root.dir === "rtl";
    if (wide) { cx = W * .745; cy = H * .5; R = Math.min(H * .29, W * .172, 240); } else { cx = W / 2; cy = H / 2; R = Math.min(W * .25, H * .3); }
    if (rtl) cx = W - cx;
    A = R * .075; gap = (wide ? R * 2.3 : R * 2.2) / (N - 1);
  }
  const hexA = (hex, a) => { const h = hex.replace("#", ""); const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
  const theta = (s, rot) => rtl ? -s * Math.PI * 2 - rot : Math.PI + s * Math.PI * 2 + rot;
  function draw(t, still) {
    const ctx = cx2; ctx.clearRect(0, 0, W, H);
    const rot = still ? 0 : (scrollY * .0011);
    const x0 = rtl ? W + 20 : -20, x1 = rtl ? cx - R : cx + R;
    const fadeEnd = wide ? (rtl ? W * .5 : W * .5) : (rtl ? W * .85 : W * .15);
    const mkGrad = (col, a) => { const g = ctx.createLinearGradient(x0, 0, fadeEnd, 0); g.addColorStop(0, hexA(col, 0)); g.addColorStop(1, hexA(col, a)); return g; };
    const gS = mkGrad(C.s, C.sa), gA = mkGrad(C.a, .95);
    const na = still ? 1 : clamp((t - 3.1) / .9, 0, 1);
    for (let i = 0; i < N; i++) {
      const e = still ? 1 : ease(clamp((t - 1.7 - i * .07) / 1.7, 0, 1));
      const p = pl[i], dtp = t - p.t;
      let amp = 0;
      if (!still && dtp > 0) amp = p.a * Math.exp(-dtp / 1.15) * Math.sin(dtp * p.w) * (R * .13 * (1 - e) + R * .05 * e);
      const y0 = cy + (i - (N - 1) / 2) * gap, ph = i * Math.PI * 2 / N;
      const isLit = !still && t - lit[i] < 1.4;
      ctx.beginPath();
      for (let k = 0; k <= SEG; k++) {
        const s = k / SEG;
        const sx = x0 + (x1 - x0) * s, sy = y0;
        const th = theta(s, rot), rr = R + A * Math.sin(3 * Math.PI * 2 * s + ph);
        const rx = cx + Math.cos(th) * rr, ry = cy + Math.sin(th) * rr;
        const modeS = Math.sin(Math.PI * s * p.m), modeR = Math.sin(Math.PI * 2 * s * (p.m + 1));
        const v = amp * (modeS * (1 - e) + modeR * e);
        const nx = Math.cos(th) * e, ny = (1 - e) + Math.sin(th) * e;
        const x = sx + (rx - sx) * e + nx * v, y = sy + (ry - sy) * e + ny * v;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      if (C.glow) { ctx.lineWidth = 5; ctx.strokeStyle = isLit ? hexA(C.a, .16) : hexA(C.s, .06); ctx.stroke(); }
      ctx.lineWidth = isLit ? 1.7 : 1.15;
      ctx.strokeStyle = isLit ? gA : gS; ctx.stroke();
    }
    if (na <= 0) return;
    ctx.save(); ctx.globalAlpha = na;
    // nodes + labels
    const lf = wide ? 11.5 : 10;
    ctx.font = `400 ${lf}px "Geist Mono", ui-monospace, monospace`; ctx.textBaseline = "middle";
    for (let j = 0; j < N; j++) {
      const th = theta(j / N, rot), on = !still && t - lit[j] < 1.4;
      const x = cx + Math.cos(th) * R, y = cy + Math.sin(th) * R;
      ctx.beginPath(); ctx.arc(x, y, on ? 5 : 3.4, 0, Math.PI * 2);
      ctx.fillStyle = on ? C.a : C.bg; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = on ? C.a : C.ink; ctx.stroke();
      const lr = R + A + (wide ? 22 : 15), c = Math.cos(th);
      ctx.textAlign = c > .3 ? "left" : c < -.3 ? "right" : "center";
      ctx.fillStyle = on ? C.a : C.mu;
      ctx.fillText(ROLES[j], cx + c * lr, cy + Math.sin(th) * lr);
    }
    // centre: 11
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = C.ink;
    ctx.font = `italic 400 ${Math.round(R * .78)}px "Instrument Serif", Georgia, serif`;
    ctx.fillText("11", cx, cy + R * .2);
    ctx.fillStyle = C.mu;
    ctx.font = lang === "ar" ? `500 ${wide ? 13 : 11.5}px "IBM Plex Sans Arabic", sans-serif` : `400 ${wide ? 11.5 : 10}px "Geist Mono", monospace`;
    ctx.fillText(T("ring.sub"), cx, cy + R * .42);
    // token
    const tt = theta(tok, rot), tx = cx + Math.cos(tt) * R, ty = cy + Math.sin(tt) * R;
    ctx.beginPath(); ctx.arc(tx, ty, 13, 0, Math.PI * 2); ctx.fillStyle = hexA(C.a, .16); ctx.fill();
    ctx.beginPath(); ctx.arc(tx, ty, 5.5, 0, Math.PI * 2); ctx.fillStyle = C.a; ctx.fill();
    ctx.restore();
  }
  function frame(dt, now) {
    const t = (now - T0) / 1000;
    if (t > 3.6) {
      tok = ((t - 3.6) / 9) % 1;
      for (let j = 0; j < N; j++) { const sj = j / N; const crossed = prevS <= tok ? (prevS < sj && sj <= tok) : (sj > prevS || sj <= tok); if (crossed) { lit[j] = t; pl[j] = { ...pl[j], t, a: .55 }; } }
      prevS = tok;
    }
    draw(t);
  }
  const redraw = () => { colors(); size(); if (RM) { tok = 0; draw(99, true); } };
  redraw(); new ResizeObserver(redraw).observe(cv);
  document.fonts && document.fonts.ready.then(redraw);
  onTheme.push(redraw);
  onMotion.push(() => { if (RM) redraw(); else T0 = performance.now() - 3600; });   // back on: skip the intro, the ring is already formed
  loopWhileLive(hero, frame);
})();

/* ======================================================== tape: CSS marquee, paused off-screen via .run (and in reduced motion) */

/* ======================================================== terminal that types */
(() => {
  const term = $("#term"), out = $("#termOut");
  const L = {
    unix: [["c", "once"], ["$", "git clone https://github.com/AbdullhRtima/eleven ~/eleven"], ["", ""], ["c", "per"], ["$", "~/eleven/install.sh ~/code/my-app"], ["o", "Hidden from git via /Users/you/code/my-app/.git/info/exclude"], ["k", "Installed eleven in /Users/you/code/my-app/eleven"]],
    win: [["c", "once"], [">", "git clone https://github.com/AbdullhRtima/eleven $HOME\\eleven"], ["", ""], ["c", "per"], [">", "~\\eleven\\install.ps1 C:\\code\\my-app"], ["o", "Hidden from git via C:\\code\\my-app\\.git\\info\\exclude"], ["k", "Installed eleven in C:\\code\\my-app\\eleven"]]
  };
  let os = "unix", run = 0, started = false;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  // narrow screens wrap a command only at spaces and after a / or \: words (and "my-app") stay whole
  const path = (s) => s.split(/(\s+|[\/\\]+)/).map((p, i) => !p ? "" : i % 2 ? (/\s/.test(p) ? p : esc(p) + "<wbr>") : `<span class="w">${esc(p)}</span>`).join("");
  const line = ([k, s], n) => k === "c" ? `<span class="c">${esc(T("term." + s))}</span>` : k === "$" || k === ">" ? `<span class="p">${esc(k)}</span> ${path(s.slice(0, n ?? s.length))}` : k ? `<span class="${k}">${k === "k" ? "✓ " : ""}${path(s)}</span>` : "";
  const full = () => L[os].map((l) => line(l)).join("\n");
  async function type() {
    const my = ++run; const lines = L[os]; let done = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const l of lines) {
      if (my !== run) return;
      if (l[0] === "$" || l[0] === ">") {
        for (let n = 0; n <= l[1].length; n += 2) { if (my !== run) return; out.innerHTML = [...done, line(l, n)].join("\n") + '<span class="caret"></span>'; await wait(22); }
        await wait(260);
      } else await wait(l[0] === "o" || l[0] === "k" ? 380 : 140);
      done.push(line(l)); out.innerHTML = done.join("\n") + '<span class="caret"></span>';
    }
  }
  const show = () => { if (RM) { out.innerHTML = full(); } else type(); };
  term.addEventListener("on", () => { if (!started) { started = true; show(); } });
  out.innerHTML = RM ? full() : '<span class="caret"></span>';
  if (RM) started = true;
  onMotion.push(() => { if (RM) { run++; started = true; out.innerHTML = full(); } });
  const tabs = $$('[role="tab"]', term);
  const pick = (b) => { tabs.forEach((x) => { const on = x === b; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; }); out.setAttribute("aria-labelledby", b.id); os = b.dataset.os; started = true; show(); };
  tabs.forEach((b) => { b.addEventListener("click", () => pick(b)); b.addEventListener("keydown", (e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const o = tabs[(tabs.indexOf(b) + 1) % 2]; o.focus(); pick(o); } }); });
  $("#replay").addEventListener("click", () => { started = true; show(); });
  // copy
  const cb = $("#copyBtn");
  cb.addEventListener("click", async () => {
    const txt = $("#prompt").textContent;
    try { await navigator.clipboard.writeText(txt); } catch (e) { const r = document.createRange(); r.selectNodeContents($("#prompt")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand("copy"); } catch (e2) {} }
    const lab = $("span", cb); lab.textContent = T("copied"); cb.classList.add("done");
    setTimeout(() => { lab.textContent = T("copy"); cb.classList.remove("done"); }, 1800);
  });
})();

/* ======================================================== the loop: a token travels Intake -> ... -> Ship, Round n / 10 */
(() => {
  const fig = $("#loopfig"), rows = $$("#steps li");
  let svg, paths = {}, stEls = {}, tokG, rnd, badge, timeline = [], step = 0, el = 0, round = 1, POSX = {}, tall = false;
  const OWN = { I: "product", P: "cto", E: "architect", S: "cto" };
  // Two layouts: a horizontal track (desktop) and a vertical one (phones), both mirrored for RTL.
  const LAY = {
    wide: { vb: [790, 340], P: { I: [50, 170], P: [160, 170], E: [270, 170], M: [360, 170], X: [470, 60], V: [580, 170], S: [740, 170] }, bot: [470, 280] },
    tall: { vb: [400, 700], P: { I: [170, 30], P: [170, 120], E: [170, 210], M: [170, 290], X: [280, 400], V: [170, 510], S: [170, 650] }, bot: [60, 400] }
  };
  function build() {
    tall = fig.clientWidth < 600;
    const L = tall ? LAY.tall : LAY.wide, VW = L.vb[0], rtl = root.dir === "rtl";
    const X = (x) => rtl ? VW - x : x, sw = rtl ? 0 : 1, an = (a) => rtl ? ({ start: "end", end: "start" }[a] || a) : a;
    POSX = {}; for (const k in L.P) POSX[k] = [X(L.P[k][0]), L.P[k][1]];
    const p = (k) => POSX[k].join(",");
    const tx = (cls, x, y, a, txt, id) => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${an(a)}" style="direction:ltr;unicode-bidi:isolate"${id ? ` id="${id}"` : ""}>${txt}</text>`;
    const E = {
      IP: `M${p("I")} L${p("P")}`, PE: `M${p("P")} L${p("E")}`, EM: `M${p("E")} L${p("M")}`,
      MX: `M${p("M")} A110,110 0 0 ${sw} ${p("X")}`, XV: `M${p("X")} A110,110 0 0 ${sw} ${p("V")}`,
      VM: `M${p("V")} A110,110 0 0 ${sw} ${X(L.bot[0])},${L.bot[1]} A110,110 0 0 ${sw} ${p("M")}`, VS: `M${p("V")} L${p("S")}`
    };
    let h = `<svg viewBox="0 0 ${L.vb[0]} ${L.vb[1]}" role="img" aria-label="${T("loop.aria")}">`;
    for (const k in E) h += `<path class="trk${k === "VM" ? " back" : ""}" id="e-${k}" d="${E[k]}"/>`;
    if (!tall) {
      h += tx("bk", X(470), 314, "middle", T("loop.back"));
      h += tx("rnd-l", X(470), 200, "middle", T("loop.round")) + tx("rnd", X(470), 238, "middle", "1 / 10", "rnd");
    } else h += tx("rnd-l", X(170), 392, "middle", T("loop.round")) + tx("rnd", X(170), 432, "middle", "1 / 10", "rnd");
    for (const k in L.P) {
      const [bx, y] = L.P[k], x = X(bx), gate = k === "I" || k === "S";
      const sub = gate ? ["gl", T(k === "I" ? "gate.approve" : "gate.accept")] : OWN[k] ? ["own", STR["own." + OWN[k]] ?? OWN[k]] : null;
      h += `<g class="st" data-k="${k}">`;
      if (gate) h += `<circle class="gate" cx="${x}" cy="${y}" r="17"/>`;
      h += `<circle class="halo" cx="${x}" cy="${y}" r="15"/><circle class="n" cx="${x}" cy="${y}" r="8"/>`;
      if (!tall) {
        if (k === "M") h += tx("lbl", X(418), y + 8, "middle", T("st.M"));
        else if (k === "V") h += tx("lbl", X(522), y + 8, "middle", T("st.V"));
        else if (k === "X") h += tx("lbl", x, y + 44, "middle", T("st.X"));
        else { h += tx("lbl", x, y + 50, "middle", T("st." + k)); if (sub) h += tx(sub[0], x, y + 75, "middle", sub[1]); }
      } else {
        if (k === "M") h += tx("lbl", x, y + 46, "middle", T("st.M"));
        else if (k === "V") h += tx("lbl", x, y - 26, "middle", T("st.V"));
        else if (k === "X") h += tx("lbl", X(bx + 22), y + 8, "start", T("st.X"));
        else { h += tx("lbl", X(bx + 30), y + 6, "start", T("st." + k)); if (sub) h += tx(sub[0], X(bx + 30), y + 27, "start", sub[1]); }
      }
      h += `</g>`;
    }
    h += tall ? tx("badge", X(200), 548, "middle", "", "badge") : tx("badge", X(604), 146, "middle", "", "badge");
    h += `<g id="tok"><circle class="tokh" r="15"/><circle class="tok" r="7"/></g></svg>`;
    fig.innerHTML = h;
    svg = $("svg", fig); tokG = $("#tok", svg); rnd = $("#rnd", svg); badge = $("#badge", svg);
    paths = {}; for (const k in E) { const pe = $("#e-" + k, svg); paths[k] = { el: pe, len: pe.getTotalLength() }; }
    stEls = {}; $$(".st", svg).forEach((g) => stEls[g.dataset.k] = g);
  }
  // timeline
  const ROUNDS = 3, SPEED = 230, DW = 520;
  function mkTimeline() {
    const t = [];
    const at = (k) => t.push({ at: k, d: DW }), mv = (e) => t.push({ mv: e });
    at("I"); mv("IP"); at("P"); mv("PE"); at("E"); mv("EM");
    for (let r = 1; r <= ROUNDS; r++) { t.push({ round: r }); at("M"); mv("MX"); at("X"); mv("XV"); t.push({ at: "V", d: DW + 300, verdict: r < ROUNDS ? "bad" : "ok" }); mv(r < ROUNDS ? "VM" : "VS"); }
    t.push({ at: "S", d: 2200, end: true });
    return t;
  }
  function setStation(k) {
    for (const s in stEls) stEls[s].classList.toggle("on", s === k);
    if (k) stEls[k].classList.add("done");
    rows.forEach((r) => r.classList.toggle("on", r.dataset.st === k));
  }
  function place(x, y) { tokG.setAttribute("transform", `translate(${x} ${y})`); }
  function placeAt(k) { place(POSX[k][0], POSX[k][1]); }
  function reset() { step = 0; el = 0; round = 1; Object.values(stEls).forEach((g) => g.classList.remove("done", "on")); badge.textContent = ""; rnd.textContent = "1 / 10"; }
  function frame(dt) {
    let s = timeline[step]; if (!s) return;
    el += dt;
    if (s.round) { round = s.round; rnd.textContent = `${round} / 10`; step++; el = 0; return; }
    if (s.at) {
      if (el === dt) { placeAt(s.at); setStation(s.at); if (s.verdict) { badge.textContent = s.verdict === "ok" ? "✓" : "✗"; badge.style.fill = `var(--${s.verdict})`; } }
      if (el >= s.d) { step++; el = 0; if (s.verdict) badge.textContent = ""; if (s.end) { reset(); } }
      return;
    }
    const P = paths[s.mv], d = P.len / SPEED * 1000, f = Math.min(1, el / d), pt = P.el.getPointAtLength(ease(f) * P.len);
    place(pt.x, pt.y);
    if (f >= 1) { step++; el = 0; }
  }
  function staticState() { // reduced motion: everything visited, token parked on Ship, round 3 / 10
    Object.values(stEls).forEach((g) => g.classList.add("done")); setStation("S"); placeAt("S"); rnd.textContent = `${ROUNDS} / 10`;
    rows.forEach((r) => r.classList.remove("on"));
  }
  build(); timeline = mkTimeline(); reset();
  if (RM) staticState(); else placeAt("I");
  onMotion.push(() => { if (RM) staticState(); else { reset(); placeAt("I"); } });
  loopWhileLive(fig, frame);
  const rebuild = () => { build(); reset(); if (RM) staticState(); else placeAt("I"); };
  new ResizeObserver(() => { if ((fig.clientWidth < 600) !== tall) rebuild(); }).observe(fig);
})();

/* ======================================================== the team: the CTO hands out tasks */
(() => {
  const svg = $("#constel"), wrap = svg.parentElement, status = $("#status");
  const RING = ["product", "designer", "architect", "backend", "frontend", "mobile", "qa", "devops", "security", "writer"];
  const C0 = [200, 240], RR = 158, pos = { cto: C0, you: [200, 18] };
  RING.forEach((r, i) => { const a = (-90 + 18 + i * 36) * Math.PI / 180; pos[r] = [C0[0] + Math.cos(a) * RR, C0[1] + Math.sin(a) * RR]; });
  let h = `<circle class="orbit" cx="${C0[0]}" cy="${C0[1]}" r="${RR}"/>`;
  RING.forEach((r) => h += `<line class="ln" x1="${C0[0]}" y1="${C0[1]}" x2="${pos[r][0].toFixed(1)}" y2="${pos[r][1].toFixed(1)}"/>`);
  h += `<line class="ln you" x1="${C0[0]}" y1="${C0[1] - 38}" x2="200" y2="44"/>`;
  // Label position for a font size of f SVG units (11 on desktop; larger on phones so it renders at 11 px or more, see fit()).
  const RAD = { you: 18, cto: 38 }, lab = (r, f) => {
    const rad = RAD[r] || 23, [x, y] = pos[r], k = f / 11; let lx = x, ly = y + rad + 16, anc = "middle";
    if (!RAD[r]) { const a = Math.atan2(y - C0[1], x - C0[0]); const lr = RR + rad + 14; lx = C0[0] + Math.cos(a) * lr; ly = C0[1] + Math.sin(a) * lr + 4 * k; anc = Math.cos(a) > .25 ? "start" : Math.cos(a) < -.25 ? "end" : "middle"; if (Math.abs(Math.cos(a)) <= .25) ly += Math.sin(a) > 0 ? 8 * k : -2 * k; }
    if (r === "you") { lx = x + rad + 10; ly = y + 4 * k; anc = "start"; }
    if (r === "cto") ly = y + rad + 9 + f;
    return [lx, ly, anc];
  };
  const node = (r, rad, ic, cls) => {
    const [x, y] = pos[r], [lx, ly, anc] = lab(r, 11);
    return `<g class="nd ${cls}" data-r="${r}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}"/><use href="#i-${ic}" x="${(x - rad * .55).toFixed(1)}" y="${(y - rad * .55).toFixed(1)}" width="${(rad * 1.1).toFixed(1)}" height="${(rad * 1.1).toFixed(1)}"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anc}" style="direction:ltr">${RN(r)}</text></g>`;
  };
  RING.forEach((r) => h += node(r, 23, r, ""));
  h += node("you", 18, "you", "you");
  h += node("cto", 38, "cto", "lead");
  h += `<circle class="pulse" id="pulse" r="5" cx="${C0[0]}" cy="${C0[1]}" opacity="0"/>`;
  svg.innerHTML = h;
  // Phones: the SVG scales down, so grow the labels (in SVG units) until they render at 11 px or more, and widen the
  // viewBox to fit them. Desktop keeps the original viewBox and 11-unit labels.
  const VB0 = svg.getAttribute("viewBox").split(" ").map(Number), texts = $$(".nd text", svg);
  function fit() {
    const px = svg.getBoundingClientRect().width; if (!px) return;
    let vb = VB0, f = 11;
    for (let n = 0; n < 6; n++) {
      const need = 11 * vb[2] / px, want = need <= 11.01 ? 11 : need * 1.02;
      if (n && Math.abs(want - f) < .05) break;
      f = want;
      texts.forEach((t) => { const [lx, ly] = lab(t.parentNode.dataset.r, f); t.setAttribute("x", lx.toFixed(1)); t.setAttribute("y", ly.toFixed(1)); t.style.fontSize = f === 11 ? "" : f.toFixed(2) + "px"; });
      const bb = svg.getBBox(), x0 = Math.min(VB0[0], bb.x - 6), y0 = Math.min(VB0[1], bb.y - 4);
      vb = [x0, y0, Math.max(VB0[0] + VB0[2], bb.x + bb.width + 6) - x0, Math.max(VB0[1] + VB0[3], bb.y + bb.height + 4) - y0];
    }
    svg.setAttribute("viewBox", vb.map((v) => +v.toFixed(1)).join(" "));
  }
  let fitW = -1;
  fit(); new ResizeObserver(() => { const w = wrap.clientWidth; if (w !== fitW) { fitW = w; fit(); } }).observe(wrap); document.fonts && document.fonts.ready.then(fit);
  const pulse = $("#pulse", svg), nodes = Object.fromEntries($$(".nd", svg).map((g) => [g.dataset.r, g])), rows = Object.fromEntries($$("#roles li").map((l) => [l.dataset.r, l]));
  const SEQ = ["product", "you", "architect", "designer", "backend", "frontend", "mobile", "qa", "security", "devops", "writer", "you"];
  let i = 0, el = 0, n = 1;
  const STAT = lang === "ar"
    ? (r, k) => r === "you" ? (k === SEQ.length - 1 ? `<span>tasks.md</span> <b>${T("st.gate")}</b>` : `<span>brief.md</span> <b>${T("st.wait")}</b>`) : `<span>tasks.md</span> <b><bdi>#${k + 1}</bdi> ${T("st.next")} ← ${RN(r)}</b>`
    : (r, k) => r === "you" ? (k === SEQ.length - 1 ? `<span>tasks.md</span> <b>GATE → you: accept</b>` : `<span>brief.md</span> <b>Status: waiting on you</b>`) : `<span>tasks.md</span> <b>#${k + 1} NEXT → ${r}</b>`;
  function light(r, on) { nodes[r] && nodes[r].classList.toggle("on", on); rows[r] && rows[r].classList.toggle("on", on); }
  function frame(dt) {
    el += dt; const r = SEQ[i], [tx, ty] = pos[r], f = clamp(el / 520, 0, 1), e = ease(f);
    const sx = C0[0], sy = C0[1];
    if (f < 1) { pulse.setAttribute("opacity", 1); pulse.setAttribute("cx", sx + (tx - sx) * e); pulse.setAttribute("cy", sy + (ty - sy) * e); }
    else if (pulse.getAttribute("opacity") !== "0") { pulse.setAttribute("opacity", 0); light(r, true); status.innerHTML = STAT(r, i); }
    if (el > 1700) { light(r, false); i = (i + 1) % SEQ.length; el = 0; }
  }
  const still = () => { Object.keys(nodes).forEach((r) => light(r, false)); pulse.setAttribute("opacity", 0); status.innerHTML = STAT("frontend", 4); nodes.frontend.classList.add("on"); };
  if (RM) still();
  onMotion.push(() => { if (RM) still(); else { light("frontend", false); i = 0; el = 0; } });
  loopWhileLive(wrap, frame);
  // hover a role row -> light its node
  $$("#roles li").forEach((li) => { li.addEventListener("mouseenter", () => nodes[li.dataset.r]?.classList.add("on")); li.addEventListener("mouseleave", () => nodes[li.dataset.r]?.classList.remove("on")); });
})();

/* ======================================================== live UI windows: parallax + tilt */
(() => {
  const desk = $("#desk"), tilt = $(".tilt", desk), wins = $$(".win", desk);
  const k = { 1: -14, 2: 30, 3: 56 };
  let mx = 0, my = 0;
  onMotion.push(() => { if (RM) { wins.forEach((w) => w.style.removeProperty("--py")); tilt.style.removeProperty("--rx"); tilt.style.removeProperty("--ry"); } });
  {
    loopWhileLive(desk, () => {
      if (!matchMedia("(min-width: 901px)").matches) return;
      const r = desk.getBoundingClientRect(), p = (r.top + r.height / 2 - innerHeight / 2) / innerHeight;
      wins.forEach((w) => w.style.setProperty("--py", (p * k[w.dataset.w]).toFixed(1) + "px"));
      tilt.style.setProperty("--rx", (my * -3).toFixed(2) + "deg"); tilt.style.setProperty("--ry", (mx * 4).toFixed(2) + "deg");
    });
    desk.addEventListener("pointermove", (e) => { const r = desk.getBoundingClientRect(); mx = (e.clientX - r.left) / r.width - .5; my = (e.clientY - r.top) / r.height - .5; });
    desk.addEventListener("pointerleave", () => { mx = my = 0; });
  }
  $$(".caps > div").forEach((c) => {
    const w = $(`.win[data-w="${c.dataset.w}"]`, desk);
    c.addEventListener("mouseenter", () => { wins.forEach((x) => x.classList.toggle("front", x === w)); });
  });
})();

/* ======================================================== counters + reveals */
(() => {
  const fmt = (el, v) => (el.dataset.pre || "") + v.toFixed(+el.dataset.dec) + (el.dataset.suf || "");
  const count = (el) => { if (RM) return; const to = +el.dataset.to, t0 = performance.now(), D = 1500;
    const step = (now) => { const f = RM ? 1 : clamp((now - t0) / D, 0, 1); el.textContent = fmt(el, to * (1 - Math.pow(1 - f, 3))); if (f < 1) requestAnimationFrame(step); };
    el.textContent = fmt(el, 0); requestAnimationFrame(step); };
  const rio = new IntersectionObserver((es) => es.forEach((e) => { if (!e.isIntersecting) return; e.target.classList.add("in"); $$(".count", e.target).forEach(count); rio.unobserve(e.target); }), { threshold: .12 });
  $$("[data-reveal]").forEach((el) => RM ? el.classList.add("in") : rio.observe(el));
  onMotion.push(() => { if (RM) $$("[data-reveal]").forEach((el) => { rio.unobserve(el); el.classList.add("in"); }); });
})();

/* ======================================================== final: eleven strings drawn in */
(() => {
  const svg = $("#harp"), sec = $("#final"); let h = "";
  for (let i = 0; i < 11; i++) { const y = 40 + i * 42, bow = (i - 5) * 26; h += `<path d="M0 ${y} Q600 ${250 + bow * .35} 1200 ${y}" pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:${RM ? 0 : 1};transition:stroke-dashoffset 2.2s ${(i * .07).toFixed(2)}s cubic-bezier(.2,.7,.2,1)"/>`; }
  svg.innerHTML = h;
  const drawIn = () => $$("path", svg).forEach((p) => p.style.strokeDashoffset = 0);
  if (!RM) sec.addEventListener("on", drawIn, { once: true });
  onMotion.push(() => { if (RM) drawIn(); });
})();

paintThemeBtn();
})();
