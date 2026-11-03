// ui/test: drives ui/index.html in headless Chrome on the synthetic ledger in fixtures.mjs and asserts what the page computes.
// Usage: node ui/test/run.mjs            (CHROME=/path/to/chrome, UI=/path/to/index.html, SHOTS=/dir for screenshots)
//        node ui/test/run.mjs --mutants  (runs the suite on each mutant in mutants.mjs; every one must fail)
// Exit code: 0 when every check passes, 1 otherwise. Needs network for the two cdnjs scripts and Google Fonts.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { launch, sleep } from "./cdp.mjs";
import { ledger } from "./fixtures.mjs";
import { MUTANTS, applyMutant } from "./mutants.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const UI = path.resolve(process.env.UI || path.join(HERE, "..", "index.html"));
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const ui = fs.readFileSync(UI, "utf8");

// ------------------------------------------------------------ --mutants: the suite must fail on every deliberately broken copy
if (process.argv.includes("--mutants")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eleven-ui-mutants-"));
  let survived = 0;
  for (const m of MUTANTS) {
    const f = path.join(dir, m.id + ".html");
    fs.writeFileSync(f, applyMutant(ui, m));
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [url.fileURLToPath(import.meta.url)], { env: { ...process.env, UI: f, SHOTS: "" }, encoding: "utf8", maxBuffer: 1 << 28 });
    const fails = (r.stdout || "").split("\n").filter((l) => l.startsWith("FAIL"));
    const killed = r.status === 1 && fails.some((l) => !l.includes("harness error"));
    if (!killed) survived++;
    console.log(`${killed ? "KILLED  " : "SURVIVED"} ${m.id}: ${m.what}  (${fails.length} checks failed, exit ${r.status}, ${Math.round((Date.now() - t0) / 1000)} s)`);
    for (const l of fails.slice(0, 6)) console.log("          " + l.replace(/\s+/g, " ").trim());
    if (fails.length > 6) console.log(`          … ${fails.length - 6} more`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${MUTANTS.length - survived} of ${MUTANTS.length} mutants killed${survived ? `, ${survived} SURVIVED (the suite is blind to them)` : ""}  (ui: ${path.relative(process.cwd(), UI) || UI})`);
  process.exit(survived ? 1 : 0);
}

// A logging "remote" server on another origin: nothing the UI or a ledger file does may reach it (security M1, M2).
const hits = [];
const remote = http.createServer((q, r) => { hits.push(q.method + " " + q.url); r.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }); r.end("ok"); });
remote.on("upgrade", (q, sock) => { hits.push("WS " + q.url); sock.destroy(); });
await new Promise((r) => remote.listen(0, "127.0.0.1", r));
const REMOTE = `http://127.0.0.1:${remote.address().port}`;

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "eleven-ui-test-"));
// The page: the UI with an error trap and the fixture injected first in <head>. window.__x(c) records code that ran,
// __msgs every postMessage, __csp every CSP violation in the app's own document.
const TRAP = `<script>window.__xss=null;window.__x=(c)=>{window.__xss=(window.__xss||"")+c};window.__msgs=[];window.__csp=[];
addEventListener("message",(e)=>{window.__msgs.push(e.data);if(e.data&&e.data.evil)window.__evil=e.data.evil});
document.addEventListener("securitypolicyviolation",(e)=>window.__csp.push(e.violatedDirective+" "+e.blockedURI));</script>`;
const fixture = `<script>window.__ELEVEN_TEST_NAME__="sample";window.__ELEVEN_TEST_FILES__=${JSON.stringify(ledger).replace(/</g, "\\u003c").replaceAll("__REMOTE__", REMOTE)};</script>`;
const PAGE = path.join(OUT, "page.html");
fs.writeFileSync(PAGE, ui.replace("<head>", `<head>\n${TRAP}\n${fixture}`));
const at = (hash) => url.pathToFileURL(PAGE).href + "#" + hash;
// M3: the real connect flow with a fake folder picker. __touched lists every folder listed and file read.
const FAKE_PICKER = `<script>window.__touched=[];window.__pick="project";
const __file=(p,text)=>({kind:"file",name:p.split("/").pop(),async getFile(){__touched.push(p);return{lastModified:1,text:async()=>text}}});
const __dir=(p,kids)=>({kind:"directory",name:p.split("/").pop(),
  async*entries(){__touched.push(p+"/");for(const[k,v]of Object.entries(kids))yield[k,typeof v==="string"?__file(p+"/"+k,v):__dir(p+"/"+k,v)]},
  async getDirectoryHandle(n){const v=kids[n];if(!v||typeof v==="string")throw new DOMException("not found","NotFoundError");return __dir(p+"/"+n,v)},
  async queryPermission(){return"granted"},async requestPermission(){return"granted"}});
const __ELEVEN={"project.md":"# Project: Picked","work":{"001-picked":{"brief.md":"# Brief: Picked item\\n\\nStatus: approved\\n",
  "tasks.md":"| # | Task | Role | Status |\\n|---|---|---|---|\\n| 1 | Check the picker | qa | NEXT |\\n"}}};
const __TREES={project:["acme",{"src":{"secret.md":"SECRET"},"notes.md":"PROJECT-NOTES","eleven":__ELEVEN}],eleven:["eleven",__ELEVEN],none:["other",{"src":{"a.md":"x"}}]};
window.showDirectoryPicker=async()=>__dir(...__TREES[window.__pick]);</script>`;
const PICK = path.join(OUT, "pick.html");
fs.writeFileSync(PICK, ui.replace("<head>", `<head>\n${TRAP}\n${FAKE_PICKER}`));

const results = [];
function check(id, name, ok, detail = "") {
  results.push({ id, name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(3)} ${name}${ok ? "" : `\n        got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const b = await launch();
await b.viewport(1280, 900);
const xssHits = [], cspHits = [];
// Before leaving a page, keep what its traps saw (ledger code that ran, CSP violations the app itself caused).
const collect = async () => {
  const r = await b.ev(`[window.__xss||null,window.__csp||[]]`).catch(() => null);
  if (r?.[0]) xssHits.push(r[0]);
  for (const v of r?.[1] || []) if (!v.includes(REMOTE)) cspHits.push(v);   // the logging server is only ever hit on purpose
};
// Ready when the UI wrote its test output, or gave up ("Paused"), so a broken build fails checks instead of stopping the run.
const READY = "!!document.getElementById('__eleven_test_out')||!!document.querySelector('#pill.paused')";
const tryGo = async (hash, ready = READY) => { await collect(); return b.go(at(hash), ready); };
const go = async (hash, ready) => { const t = await tryGo(hash, ready); if (t < 0) throw new Error("page did not load: " + hash); };
const out = () => b.ev(`JSON.parse(document.getElementById('__eleven_test_out')?.textContent||'{"items":[],"workGraph":{"items":[],"decisionsLeft":[]}}')`);
const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await b.shot(path.join(SHOTS, name + ".png")); } };
// Real mouse click on the element an expression returns (near its left edge, like a user clicking a link).
const clickEl = async (expr) => {
  const r = await b.ev(`(()=>{const e=(${expr});if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return [r.x+Math.min(r.width/2,20),r.y+r.height/2]})()`);
  if (r) await b.clickAt(r[0], r[1]);
  return !!r;
};
// Real mouse click at a fraction of the element's width, scrolling only if it isn't visible (keeps the graph's pan intact).
const clickAtEl = async (expr, fx = 0.5) => {
  const r = await b.ev(`(()=>{const e=(${expr});if(!e)return null;e.scrollIntoView({block:"nearest",inline:"nearest"});const r=e.getBoundingClientRect();return [r.x+r.width*${fx},r.y+r.height/2]})()`);
  if (r) await b.clickAt(r[0], r[1]);
  return !!r;
};
const node = (key, part = ".gbox") => `document.querySelector('#gNodes [data-key="${key}"] > ${part}')`;
const view = () => b.ev(`[S.view.kind==="file"?S.view.path:"home",S.graphOpen]`);
// Computed colour of a CSS token in the current theme, for comparing against what an element actually paints.
const TOK = `((v)=>{const e=document.createElement("span");e.style.color="var("+v+")";document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c})`;
const link = (text) => `[...document.querySelectorAll('#view a')].find((a)=>a.textContent.trim()===${JSON.stringify(text)})`;
const setFile = (p, js) => b.ev(`(()=>{const f=window.__ELEVEN_TEST_FILES__[${JSON.stringify(p)}];${js};f.mtime=Date.now()})()`);
// Elements past the right edge, ignoring boxes that scroll on their own.
const OVERFLOW = `(()=>{const W=document.documentElement.clientWidth;const over=[...document.querySelectorAll("body *")].filter((el)=>{
  if(el.closest(".tablewrap, pre, .q-body, .gwrap, .menu, iframe, [hidden]")||(el.closest("#side")&&!document.body.classList.contains("drawer")))return false;
  const r=el.getBoundingClientRect();return r.width&&r.right>W+0.5}).slice(0,5).map((el)=>el.tagName+"."+el.className);
  return {W,docSW:document.documentElement.scrollWidth,bodySW:document.body.scrollWidth,over}})()`;

try {
  // ------------------------------------------------------------ home
  await go("theme=light");
  await shot("home");
  const o = await out();
  const st = Object.fromEntries(o.items.map((i) => [i.id, [i.state, i.chip, i.sentence]]));
  const want = {
    "001-done": ["done", "Done", "All tasks done."],
    "002-working": ["working", "Working · frontend", "Build `design/mock.html` from decision 0001"],
    "003-waiting": ["waiting", "Waiting on you", "Answer the brief's open questions"],
    "004-prose-q": ["waiting", "Waiting on you", "Pick the first market"],
    "005-none-q": ["waiting", "Waiting on you", "Approve the plan"],
    "006-gate": ["waiting", "Waiting on you", "Read the brief and approve it."],
    "007-planning": ["working", "Working · CTO", "Writing the plan."],
    "008-idle": ["idle", "Waiting for the CTO", "No task is marked NEXT."],
    "009-two-next": ["working", "Working · architect", "Explore"],
    "010-arabic": ["working", "Working · writer", "Write `my notes.md` and ملف.md"],
    "011-attack": ["waiting", "Waiting on you", `<img src=x onerror="window.__x('S')"> and [js](javascript:window.__x('SL'))`],
    "012-svg": ["working", "Working · frontend", ledger["work/012-svg/tasks.md"].text.split("\n")[2].split(" | ")[1]],
  };
  for (const [id, w] of Object.entries(want)) check("C1", `status of ${id}: ${w[0]} · ${w[1]}`, eq(st[id], w), st[id]);
  check("C1", "two NEXT rows warn", (o.items.find((i) => i.id === "009-two-next")?.warn || []).some((w) => /2 tasks are marked NEXT/.test(w)));
  check("C1", "only the 12 items are listed", eq(o.items.map((i) => i.id), Object.keys(want)), o.items.map((i) => i.id));

  const files = await b.ev(`[...S.files.keys()]`);
  const hidden = ["AGENTS.md", "README.md", "agents/cto.md", "templates/brief.md", "docs/guide.md", "ui/index.html", ".hidden/x.md", "work/001-done/.secret.md"];
  check("C3", "kit files and dotfiles are not in the tree", !hidden.some((p) => files.includes(p)), hidden.filter((p) => files.includes(p)));
  check("C3", "sub-folders, decisions/archive and .html are in the tree",
    ["work/002-working/design/deep/inner.md", "decisions/archive/0002-old.md", "work/002-working/design/mock.html", "work/010-arabic/my notes.md", "work/010-arabic/ملف.md"].every((p) => files.includes(p)));

  const q = (id) => o.items.find((i) => i.id === id);
  const card = (id, expr) => b.ev(`(()=>{const c=document.querySelector('.card[data-item="${id}"]');return ${expr}})()`);
  check("C2", "003: 15 numbered questions, collapsed, one <li> each, no report questions",
    q("003-waiting").questions === 15 && eq(await card("003-waiting", `[!!c.querySelector('details.q'),c.querySelector('details.q').open,c.querySelectorAll('.q-body > ol > li').length,/REPORT-QUESTION/.test(c.textContent)]`), [true, false, 15, false]),
    [q("003-waiting").questions, await card("003-waiting", `[!!c.querySelector('details.q'),c.querySelector('details.q')?.open,c.querySelectorAll('.q-body > ol > li').length,/REPORT-QUESTION/.test(c.textContent)]`)]);
  check("C2", "005: '- None.' shows no questions box", (await card("005-none-q", `!!c.querySelector('details.q')`)) === false);
  const b5 = await card("004-prose-q", `[!!c.querySelector('details.q'),c.querySelector('details.q summary')?.textContent.trim(),/PROSE-Q-MARKER/.test(c.querySelector('.q-body')?.textContent||'')]`);
  check("B5", "004: prose-only questions still show, rendered, without a count", eq(b5, [true, "Open questions", true]), b5);
  const b7 = await card("001-done", `(()=>{const r=c.querySelector('.round');const m=document.createElement('span');m.style.color='var(--muted)';document.body.append(m);const mc=getComputedStyle(m).color;m.remove();return [r?.textContent,r?.classList.contains('near'),getComputedStyle(r).color===mc]})()`);
  check("B7", "done card: 'Round 10 of 10' is not red", eq(b7, ["Round 10 of 10", false, true]), b7);
  const b7w = await card("009-two-next", `!!c.querySelector('.round')`);
  check("B7", "(control) the round still shows on other cards", b7w === true);
  const b6t = await b.ev(`(()=>{const n=document.querySelector('#tree [data-dir="work/010-arabic"] .name');return [n?.getAttribute('dir'),n?.matches(':dir(rtl)')]})()`);
  check("B6", "tree: Arabic item label is dir=auto and renders RTL", eq(b6t, ["auto", true]), b6t);
  const b6c = await card("010-arabic", `[c.querySelector('.c-title').getAttribute('dir'),c.querySelector('.sent').getAttribute('dir')]`);
  check("B6", "cards: title and sentence are dir=auto", eq(b6c, ["auto", "auto"]), b6c);

  // B8: SRI on the cdnjs scripts, hashes match the real files, and the page still loaded them.
  const scripts = await b.ev(`[...document.querySelectorAll('script[src]')].map((s)=>({src:s.src,integrity:s.integrity,co:s.getAttribute('crossorigin')}))`);
  const cdn = scripts.filter((s) => s.src.startsWith("https://cdnjs.cloudflare.com/"));
  let sriOk = cdn.length === 2, sriWhy = [];
  for (const s of cdn) {
    const body = Buffer.from(await (await fetch(s.src)).arrayBuffer());
    const h = "sha512-" + crypto.createHash("sha512").update(body).digest("base64");
    if (s.integrity !== h || s.co !== "anonymous") { sriOk = false; sriWhy.push({ src: s.src, has: s.integrity, want: h, crossorigin: s.co }); }
  }
  check("B8", "cdnjs scripts carry the right sha512 integrity + crossorigin=anonymous", sriOk, sriWhy.length ? sriWhy : cdn);
  check("B8", "marked and DOMPurify still load with SRI", eq(await b.ev(`[typeof marked?.parse, typeof DOMPurify?.sanitize]`), ["function", "function"]));
  check("C8", "only cdnjs scripts, pinned versions", cdn.length === scripts.length && cdn.every((s) => /\/\d+\.\d+\.\d+\//.test(s.src)), scripts);

  // ------------------------------------------------------------ M4: inline SVG in a task cell can't blank or cover Home
  const m4h = await b.ev(`(()=>{const h=document.getElementById('homeH').getBoundingClientRect();const top=document.elementFromPoint(h.x+h.width/2,h.y+h.height/2);
    const c=document.querySelector('.card[data-item="012-svg"]');return {cards:document.querySelectorAll('.card').length,pill:document.querySelector('#pill .txt').textContent,
    lost:!!document.querySelector('.lostbar'),svgs:document.querySelectorAll('#cards :is(.sent,.q-body) :is(svg,math,rect)').length,
    headOnTop:top?.id==='homeH',sent:c?.querySelector('.sent').textContent.trim()}})()`);
  check("M4", "an <svg><a> + overlay <rect> in a NEXT task: Home keeps all 12 cards, 'Live', no 'Lost access', nothing painted over it",
    m4h.cards === 12 && m4h.pill === "Live" && !m4h.lost && m4h.svgs === 0 && m4h.headOnTop && /^Fix\s+x?\s*the\s+thing$/.test(m4h.sent), m4h);

  // ------------------------------------------------------------ M1: page CSP (option B: mockups keep their JS)
  const metaM = ui.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  const firstLoad = Math.min(...["<script", "<link"].map((t) => ui.indexOf(t)).filter((i) => i >= 0));
  const csp = metaM ? Object.fromEntries(metaM[1].split(";").map((d) => d.trim().split(/\s+/)).filter((a) => a[0]).map(([k, ...v]) => [k, v.sort()])) : null;
  const wantCsp = { "default-src": ["'none'"], "script-src": ["'unsafe-inline'", ...cdn.map((s) => s.src)].sort(), "style-src": ["'unsafe-inline'", "https://fonts.googleapis.com"].sort(),
    "font-src": ["https://fonts.gstatic.com"], "img-src": ["data:", "https:"], "frame-src": ["blob:"], "connect-src": ["'none'"], "base-uri": ["'none'"], "form-action": ["'none'"], "object-src": ["'none'"] };
  check("M1", "CSP meta comes before every script/link and is exactly option B (inline + the 2 pinned cdnjs files; no network; frames only blob:)",
    metaM && ui.indexOf(metaM[0]) < firstLoad && eq(csp, wantCsp), csp);
  hits.length = 0;
  const m1 = await b.ev(`(async()=>{const r={};try{await fetch(${JSON.stringify(REMOTE + "/deliberate-fetch")});r.fetch="sent"}catch(e){r.fetch="blocked"}
    const s=document.createElement("script");s.src=${JSON.stringify(REMOTE + "/deliberate-script.js")};r.script=await new Promise((res)=>{s.onload=()=>res("ran");s.onerror=()=>res("blocked");document.head.append(s)});
    const i=new Image();i.src=${JSON.stringify(REMOTE.replace("http:", "https:") + "/deliberate-img")};
    await Promise.all(["600 16px Geist","400 16px 'Geist Mono'","400 40px 'Instrument Serif'","italic 400 25px 'Instrument Serif'"].map((f)=>document.fonts.load(f)));
    r.fonts=["Geist","Geist Mono","Instrument Serif"].map((n)=>[...document.fonts].some((f)=>f.family.replace(/"/g,"")===n&&f.status==="loaded"));
    r.libs=[typeof marked?.parse,typeof DOMPurify?.sanitize];return r})()`);
  await sleep(300);
  check("M1", "the CSP blocks fetch and injected remote scripts from the app; cdnjs libraries and Google Fonts (Geist, Geist Mono, Instrument Serif) still load",
    eq(m1, { fetch: "blocked", script: "blocked", fonts: [true, true, true], libs: ["function", "function"] }) && !hits.some((h) => h.includes("/deliberate-fetch") || h.includes("/deliberate-script")), { m1, hits });

  // ------------------------------------------------------------ N1c: waiting / working / done / idle look different on every card (light + dark)
  const STATE_LOOK = { waiting: ["--warn", "--warn"], working: ["--accent", "--accent-ink"], done: ["--ok", "--ok-ink"], idle: ["--muted", "--muted"], new: ["--muted", "--muted"] };
  for (const theme of ["light", "dark"]) {
    if (theme !== "light") await go("theme=" + theme);
    const looks = await b.ev(`(()=>{const tok=${TOK};const T=Object.fromEntries(["--warn","--accent","--accent-ink","--ok","--ok-ink","--muted","--warn-soft","--panel"].map((v)=>[v,tok(v)]));
      return {T,cards:[...document.querySelectorAll('.card')].map((c)=>{const chip=c.querySelector('.chip'),cs=getComputedStyle(c),sd=document.querySelector('#tree [data-dir="work/'+c.dataset.item+'"] .sdot');
        return {id:c.dataset.item,card:c.className,chip:chip.className,label:chip.textContent.trim(),dot:getComputedStyle(chip.querySelector('.dot')).backgroundColor,ink:getComputedStyle(chip).color,
          bl:cs.borderLeftColor+" "+cs.borderLeftWidth,bg:cs.backgroundColor,tree:sd&&[sd.className,getComputedStyle(sd).backgroundColor]}})}})()`);
    const bad = [];
    for (const c of looks.cards) {
      const [state, label] = want[c.id] || [];
      const [dotV, inkV] = STATE_LOOK[state] || [];
      const T = looks.T;
      const ok = state && c.card === `card s-${state}` && c.chip === `chip s-${state}` && c.label === label && c.dot === T[dotV] && c.ink === T[inkV] &&
        eq(c.tree, [`sdot s-${state}`, T[dotV]]) && (state === "waiting" ? c.bg === T["--warn-soft"] && c.bl === `${T["--warn"]} 3px` : c.bg === T["--panel"]);
      if (!ok) bad.push({ want: [state, label, T[dotV], T[inkV]], got: c });
    }
    check("N1", `${theme}: every card and tree dot shows its state by class, label and colour (waiting amber, working vermilion, done green, idle grey)`,
      looks.cards.length === 12 && bad.length === 0 && new Set(["--warn", "--accent", "--ok", "--muted"].map((v) => looks.T[v])).size === 4, bad.length ? bad : looks.cards.length);
  }

  // ------------------------------------------------------------ B3: live update keeps the questions box scroll
  await go("theme=light");
  await b.click('.card[data-item="003-waiting"] details.q summary');
  await sleep(200);
  await b.ev(`document.querySelector('.card[data-item="003-waiting"] .q-body').scrollTop=120`);
  const before = await b.ev(`document.querySelector('.card[data-item="003-waiting"] .q-body').scrollTop`);
  await setFile("work/003-waiting/brief.md", `f.text=f.text.replace("number 15,","number 15 LIVE-Q-MARKER,")`);
  const ms = await b.waitFor(`document.querySelector('.card[data-item="003-waiting"] .q-body')?.textContent.includes('LIVE-Q-MARKER')`, 8000);
  const after = await b.ev(`[document.querySelector('.card[data-item="003-waiting"] details.q').open,document.querySelector('.card[data-item="003-waiting"] .q-body').scrollTop]`);
  check("B3", `questions box keeps scroll 120 across a live update (${ms} ms)`, before === 120 && ms >= 0 && eq(after, [true, 120]), { before, ms, after });

  // ------------------------------------------------------------ B3: live update keeps a text selection in the reader
  await go("theme=light&file=" + encodeURIComponent("work/002-working/notes.md"));
  await b.ev(`(()=>{const p=[...document.querySelectorAll('.doc p')].find((p)=>p.textContent.includes('SELECT-ME'));const r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r)})()`);
  await b.ev(`document.getElementById('pane').scrollTop=0`);
  await setFile("work/002-working/notes.md", `f.text+="\\n\\nLIVE-END-MARKER\\n"`);
  const ms2 = await b.waitFor(`document.querySelector('.doc')?.textContent.includes('LIVE-END-MARKER')`, 8000);
  const sel = await b.ev(`getSelection().toString()`);
  check("B3", `reader keeps the text selection when the open file changes (${ms2} ms)`, ms2 >= 0 && sel.includes("SELECT-ME"), { ms2, sel });

  // ------------------------------------------------------------ B1: hostile Markdown
  await go("theme=light&file=" + encodeURIComponent("work/011-attack/notes.md"));
  await b.waitFor(`document.body.textContent.includes('AFTER-ATTACK-MARKER')`);
  await sleep(1200);
  await shot("attack-notes");
  const b1 = await b.ev(`(()=>{const v=document.getElementById('view');const m=[...v.querySelectorAll('div')].find((d)=>d.textContent.trim()==='CLASS-ID-STYLE-MARKER');return {
    forbidden:[...v.querySelectorAll('.doc :is(style,link,form,input:not([type=checkbox][disabled]),textarea,select,button:not(.imgoff),iframe,object,embed,video,audio,source,image,svg,math)')].map((e)=>e.tagName),
    topBg:getComputedStyle(document.querySelector('.top')).backgroundColor,
    markerAttrs:m?[...m.attributes].map((a)=>a.name):'missing',
    bgAttr:[...v.querySelectorAll('[background],[poster],[srcset],[style]')].length,
    pixelBtn:!!v.querySelector('button.imgoff[data-src="https://example.com/eleven-test-pixel.png"]'),
    imgs:[...v.querySelectorAll('img')].map((i)=>i.getAttribute('src')),
    handlers:[...v.querySelectorAll('*')].filter((e)=>[...e.attributes].some((a)=>/^on/i.test(a.name))).length,
    jsHrefs:[...v.querySelectorAll('a')].filter((a)=>/javascript:/i.test(a.getAttribute('href')||'')).length,
    paneOk:document.getElementById('pane').id==='pane'&&document.querySelectorAll('#pane').length===1}})()`);
  check("B1", "no style/form/input/button/iframe/object/embed/media left in the doc", b1.forbidden.length === 0, b1.forbidden);
  check("B1", "a <style> in a ledger file can't restyle the UI", b1.topBg !== "rgb(255, 0, 0)", b1.topBg);
  check("B1", "class/id/style/data-* from a ledger file are stripped", eq(b1.markerAttrs, []) && b1.bgAttr === 0 && b1.paneOk, b1);
  check("B1", "remote image becomes a click-to-load button; no <img> with a src", b1.pixelBtn && b1.imgs.length === 0, b1);
  const remote = b.requests().filter((u) => u.includes("eleven-test-"));
  check("B1", "no request to any remote resource named in the file", remote.length === 0, remote);
  check("C7", "no on* handlers or javascript: links survive", b1.handlers === 0 && b1.jsHrefs === 0, b1);

  // ------------------------------------------------------------ B2: links never navigate the app
  const LINKS = "theme=light&file=" + encodeURIComponent("work/011-attack/links.md");
  await go(LINKS);
  const startUrl = await b.ev(`location.href`);
  for (const [text, msg] of [["missing", "missing.md isn't in this folder."], ["mail", "This link can't be opened here."], ["file", "This link can't be opened here."]]) {
    await b.ev(`document.getElementById('toast')&&(document.getElementById('toast').hidden=true)`);
    const clicked = await clickEl(link(text));
    await sleep(700);
    const r = await b.ev(`({url:location.href,toast:document.getElementById('toast')&&!document.getElementById('toast').hidden?document.getElementById('toast').textContent:null})`).catch((e) => ({ url: "error: " + e.message }));
    check("B2", `click on '${text}' link: app stays, notice shown`, clicked && r.url === startUrl && r.toast === msg, { clicked, ...r });
    if (r.url !== startUrl) await go(LINKS);
  }
  const ext = await b.ev(`(()=>{const a=${link("external")};return a&&{href:a.getAttribute('href'),target:a.target,rel:a.rel}})()`);
  await clickEl(link("external"));
  let newTab = false;
  for (let i = 0; i < 30 && !newTab; i++) { newTab = (await b.tabs()).some((t) => t.url.includes("eleven-test-external")); if (!newTab) await sleep(100); }
  const urlAfterExt = await b.ev(`location.href`);
  check("B2", "external https link opens a new tab (noopener), app stays",
    ext && ext.target === "_blank" && /noopener/.test(ext.rel) && newTab && urlAfterExt === startUrl, { ext, newTab, urlAfterExt });
  await b.closeOtherTabs();
  await clickEl(link("ledger"));
  await sleep(400);
  const led = await b.ev(`[S.view.path,location.href.split('#')[0]===${JSON.stringify(startUrl.split("#")[0])}]`).catch((e) => String(e));
  check("B2", "link to a ledger file opens it in the reader", eq(led, ["work/002-working/notes.md", true]), led);

  // ------------------------------------------------------------ C5: .html files in a sandbox
  await go("theme=light&file=" + encodeURIComponent("work/002-working/design/mock.html"));
  const fr = await b.ev(`(()=>{const f=document.querySelector('#framebox iframe');return f&&[f.getAttribute('sandbox'),f.src.slice(0,5)]})()`);
  check("C5", ".html opens in <iframe sandbox=\"allow-scripts\"> from a blob", eq(fr, ["allow-scripts", "blob:"]), fr);
  await go("theme=light&file=" + encodeURIComponent("work/011-attack/evil.html"));
  await b.waitFor(`!!window.__evil`, 4000);
  const evil = await b.ev(`[window.__evil,window.__xss]`);
  check("C5", "hostile .html runs but can't reach the UI", evil[0]?.ran === true && evil[0]?.parentDoc === "blocked" && evil[0]?.ls === "blocked" && evil[1] === null, evil);

  // ------------------------------------------------------------ M1 option B: a ledger .html mockup keeps its JavaScript
  await go("theme=light&file=" + encodeURIComponent("work/002-working/design/mock.html"));
  const ifr = await b.ev(`(()=>{const f=document.querySelector('#framebox iframe');const r=f.getBoundingClientRect();return {csp:f.getAttribute('csp'),sandbox:f.getAttribute('sandbox'),x:r.x+1,y:r.y+1}})()`);
  const btn = (await b.evFrame(`(()=>{const r=document.getElementById('b').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`))?.value;
  if (btn) await b.clickAt(ifr.x + btn[0], ifr.y + btn[1]);
  const clicked = await b.waitFor(`window.__msgs.some((m)=>m&&m.mock==="clicked")`, 3000);
  const inFrame = (await b.evFrame(`[document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,document.compatMode,document.getElementById('b')?.textContent]`))?.value;
  const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
  check("M1", "a ledger .html mockup keeps its JavaScript (CEO option B): a real click inside the frame runs its handler", clicked >= 0 && inFrame?.[2] === "pressed", { btn, clicked, inFrame });
  check("M2", "iframe csp attribute = the no-network policy, and the same policy is written at the top of the blob (standards mode kept)",
    ifr.csp === FRAME_CSP && ifr.sandbox === "allow-scripts" && eq(inFrame?.slice(0, 2), [FRAME_CSP, "CSS1Compat"]), { ifr, inFrame });

  // ------------------------------------------------------------ M2: a hostile ledger .html gets no network
  hits.length = 0;
  await go("theme=light&file=" + encodeURIComponent("work/011-attack/net.html"));
  const ran = await b.waitFor(`window.__msgs.some((m)=>m&&m.net==="ran")`, 5000);
  const left = await b.waitFor(`!!document.getElementById('frameLeft')`, 4000);   // it tries to navigate itself away after 300 ms
  await sleep(1200);   // give every other attempt time to land
  const frames = await b.frames();
  check("M2", "hostile .html: its script runs, but no request reaches the network (fetch, POST, beacon, WebSocket, XHR, img, CSS, font, script, sub-frame, self-navigation)",
    ran >= 0 && hits.length === 0, { ran, hits });
  check("M2", "its self-navigation is stopped and explained ('This file tried to open a web page.'); no remote frame ever loads",
    left >= 0 && !frames.some((u) => u.startsWith(REMOTE)), { left, frames });
  await shot("net-html");

  // ------------------------------------------------------------ B6: RTL + paths with spaces / non-ASCII
  await go("theme=light&file=" + encodeURIComponent("work/010-arabic/notes.md"));
  await shot("arabic-notes");
  const b6 = await b.ev(`(()=>{const ps=[...document.querySelectorAll('.doc p')];const ar=ps.find((p)=>/[\\u0600-\\u06FF]{4}/.test(p.textContent)&&!/English/.test(p.textContent)),en=ps.find((p)=>/English/.test(p.textContent));
    const refs=(p)=>[...document.querySelectorAll('.doc a.ref')].filter((a)=>a.dataset.path===p).length;
    return {ar:[ar?.getAttribute('dir'),ar?.matches(':dir(rtl)')],en:en?.matches(':dir(ltr)'),h1:document.querySelector('.doc h1')?.matches(':dir(rtl)'),spaces:refs('work/010-arabic/my notes.md'),arabic:refs('work/010-arabic/ملف.md')}})()`);
  check("B6", "Arabic paragraph and heading render RTL (dir=auto), English stays LTR", eq(b6.ar, ["auto", true]) && b6.en && b6.h1, b6);
  check("B6", "'my notes.md' (link + code span) and 'ملف.md' (code + prose) become reader links", b6.spaces >= 2 && b6.arabic >= 2, b6);

  // ------------------------------------------------------------ C4: work graph
  await go("theme=light&graph");
  await shot("graph");
  const g = (await out()).workGraph;
  const gi = (id) => g.items.find((i) => i.id === id);
  const g002 = ["#1 architect [done] -> 01 · architect, notes-a", "#2 frontend [working] -> mock.html, 0001 · sample", "#3 qa [todo] -> -"];
  check("C4", "graph: 002 tasks, colours and outputs", eq(gi("002-working")?.tasks, g002), gi("002-working")?.tasks);
  check("C4", "graph: 003 user NEXT is 'waiting', report 01 belongs to task 1",
    eq(gi("003-waiting")?.tasks, ["#1 product [done] -> 01 · product", "#2 user [waiting] -> -"]), gi("003-waiting")?.tasks);
  check("C4", "graph: brief/tasks/notes and unclaimed files are item files", eq(gi("002-working")?.itemFiles, ["brief", "tasks", "notes", "inner"]), gi("002-working")?.itemFiles);
  check("C4", "graph: decision nobody names is listed", eq(g.decisionsLeft, ["decisions/archive/0002-old.md"]), g.decisionsLeft);
  check("B6", "graph: 'my notes.md' and 'ملف.md' named in a row are task outputs", eq(gi("010-arabic")?.tasks, ["#1 writer [working] -> ملف, my notes"]), gi("010-arabic")?.tasks);
  const drawn = await b.ev(`[document.querySelectorAll('#gNodes .k-task').length,!!document.querySelector('#gNodes [data-key="t:002-working:2"].k-working'),!!document.querySelector('#gNodes [data-key="t:003-waiting:2"].k-waiting')]`);
  check("C4", "graph: task nodes drawn with status classes", drawn[0] > 0 && drawn[1] && drawn[2], drawn);

  // ------------------------------------------------------------ N1c: every graph node shows its status by class, label and colour (light + dark)
  const KIND_LOOK = { waiting: ["--warn", "--warn", "--warn-soft"], working: ["--accent", "--accent", "--accent-soft"], todo: ["--muted", "--border", "--panel"],
    done: ["--ok", null, "--panel"], progress: [null, "--accent", "--panel"], blocked: ["--danger", "--danger", "--panel"] };
  const ITEM_LOOK = { waiting: ["--warn", "Waiting on you"], working: ["--accent-ink", "Working"], done: ["--ok-ink", "Done"], idle: ["--muted", "Waiting for the CTO"], new: ["--muted", "Not started"] };
  const ITEM_BAR = { waiting: "--warn", working: "--accent", done: "--ok", idle: "--muted", new: "--muted" };
  for (const theme of ["light", "dark"]) {
    if (theme !== "light") await go("theme=dark&graph");
    const gl = await b.ev(`(()=>{const tok=${TOK};const T=Object.fromEntries(["--warn","--warn-soft","--accent","--accent-soft","--accent-ink","--muted","--border","--panel","--ok","--ok-ink","--danger"].map((v)=>[v,tok(v)]));
      const kinds=Object.fromEntries(workModel().items.flatMap((x)=>x.tasks.map((t)=>[t.key,t.kind])));
      return {T,kinds,tasks:[...document.querySelectorAll('#gNodes .k-task')].map((g)=>({key:g.dataset.key,cls:g.getAttribute('class'),dot:getComputedStyle(g.querySelector('.gdot')).fill,
          stroke:getComputedStyle(g.querySelector('.gbox')).stroke,fill:getComputedStyle(g.querySelector('.gbox')).fill})),
        items:[...document.querySelectorAll('#gNodes .k-item')].map((g)=>({key:g.dataset.key,cls:g.getAttribute('class'),label:g.querySelector('.gt.st')?.textContent,
          bar:getComputedStyle(g.querySelector('.gsbar')).fill,ink:getComputedStyle(g.querySelector('.gt.st')).fill}))}})()`);
    const bad = [];
    const T = gl.T;
    for (const t of gl.tasks) {
      const k = gl.kinds[t.key], [d, st, fi] = KIND_LOOK[k] || [];
      if (!k || t.cls !== `gnode k-task k-${k}` || (d && t.dot !== T[d]) || (st && t.stroke !== T[st]) || (fi && t.fill !== T[fi])) bad.push({ want: [k, T[d], T[st], T[fi]], got: t });
    }
    for (const n of gl.items) {
      const st = want[n.key.slice(2)]?.[0], [inkV, label] = ITEM_LOOK[st] || [];
      if (!st || n.cls !== `gnode k-item s-${st}` || !n.label?.startsWith(label) || n.bar !== T[ITEM_BAR[st]] || n.ink !== T[inkV]) bad.push({ want: [st, label, T[ITEM_BAR[st]]], got: n });
    }
    const fixed = { "t:002-working:1": "done", "t:002-working:2": "working", "t:002-working:3": "todo", "t:003-waiting:2": "waiting", "t:004-prose-q:1": "waiting", "t:009-two-next:1": "working" };
    const wrongKind = Object.entries(fixed).filter(([key, k]) => !gl.tasks.some((t) => t.key === key && t.cls.endsWith(" k-" + k)));
    const dots = ["waiting", "working", "todo"].map((k) => gl.tasks.find((t) => t.cls.endsWith(" k-" + k))?.dot);
    check("N1", `${theme}: every task and item node in the graph shows its status by class, label and colour; waiting, working and to-do differ`,
      gl.tasks.length >= 10 && gl.items.length === 12 && bad.length === 0 && wrongKind.length === 0 && new Set(dots).size === 3 && !dots.includes(undefined), { bad, wrongKind, dots, n: [gl.tasks.length, gl.items.length] });
  }

  // ------------------------------------------------------------ N1b: real graph interactions (1280 px: left-to-right, pan/zoom, Fit, collapse, clicks)
  await go("theme=light&graph");
  const tf = () => b.ev(`document.getElementById('gvp').getAttribute('transform')`);
  const box = await b.ev(`(()=>{const r=document.getElementById('gsvg').getBoundingClientRect();return [G.mode,r.x+r.width/2,r.y+r.height/2]})()`);
  const t0 = await tf();
  await b.wheel(box[1], box[2], 0, 120);
  await b.wheel(box[1], box[2], 0, -250, 2);   // ctrl+wheel = zoom
  await b.drag(box[1] - 200, box[2] + 150, box[1] - 120, box[2] + 100);
  await sleep(150);
  const t1 = await tf();
  await b.click("#gFit");
  await sleep(250);
  const t2 = await tf();
  check("N1", "graph: wheel, ctrl+wheel and drag move the view; Fit puts it back exactly", box[0] === "ltr" && t0 && t1 !== t0 && t2 === t0, { mode: box[0], t0, t1, t2 });

  const taskCount = () => b.ev(`document.querySelectorAll('#gNodes .k-task').length`);
  const n0 = await taskCount();
  await clickAtEl(`document.querySelector('#gNodes [data-toggle="002-working"] .gchevbg')`);
  await sleep(300);
  const col = await b.ev(`[document.querySelectorAll('#gNodes .k-task').length,document.querySelector('#gNodes [data-toggle="002-working"]')?.getAttribute('aria-expanded'),document.querySelector('#gNodes [data-key="i:002-working"] .gt.st')?.textContent,!!document.querySelector('#gNodes [data-key^="t:002-working:"]')]`);
  await clickAtEl(`document.querySelector('#gNodes [data-toggle="002-working"] .gchevbg')`);
  await sleep(300);
  const exp = await b.ev(`[document.querySelectorAll('#gNodes .k-task').length,document.querySelector('#gNodes [data-toggle="002-working"]')?.getAttribute('aria-expanded')]`);
  const doneLabel = await b.ev(`document.querySelector('#gNodes [data-key="i:001-done"] .gt.st')?.textContent`);
  check("N1", "graph: the chevron collapses an item (3 tasks hidden, aria-expanded=false, '· 3 tasks') and expands it again; done items start collapsed",
    eq(col, [n0 - 3, "false", "Working · 3 tasks", false]) && eq(exp, [n0, "true"]) && doneLabel === "Done · 6 tasks", { n0, col, exp, doneLabel });

  const clicks = [];
  for (const [key, fx, wantPath] of [["t:002-working:1", 0.5, "work/002-working/reports/01-architect.md"], ["t:002-working:3", 0.5, "work/002-working/tasks.md"],
    ["i:002-working", 0.75, "work/002-working/brief.md"], ["p", 0.6, "project.md"], ["f:decisions/0001-sample.md", 0.5, "decisions/0001-sample.md"],
    ["f:work/002-working/design/deep/inner.md", 0.5, "work/002-working/design/deep/inner.md"]]) {
    const ok = await clickAtEl(node(key), fx);
    await sleep(350);
    const [p, open] = await view();
    const ringed = await b.ev(`!!document.querySelector('#gNodes [data-key="${key}"].sel')`);
    clicks.push({ key, ok, p, open, ringed, pass: ok && p === wantPath && open && ringed });
  }
  check("N1", "graph: clicking a task opens its report (or tasks.md), an item its brief, the project project.md, a file itself; graph stays open and rings it",
    clicks.every((c) => c.pass), clicks.filter((c) => !c.pass));
  await b.ev(`document.querySelector('#gNodes [data-key="t:003-waiting:1"]').focus()`);
  await b.key("Enter");
  await sleep(300);
  check("N1", "graph: Enter on a focused task opens its report", (await view())[0] === "work/003-waiting/reports/01-product.md", await view());

  await b.viewport(1920, 1000);
  await go("theme=light&graph&file=" + encodeURIComponent("work/002-working/brief.md"));
  const split = await b.ev(`(()=>{const w=document.querySelector('.gwrap').getBoundingClientRect();const off=[...document.querySelectorAll('#gNodes [data-key]')].filter((g)=>{const r=g.getBoundingClientRect();
    return r.left<w.left-1||r.right>w.right+1||r.top<w.top-1||r.bottom>w.bottom+1}).map((g)=>g.dataset.key);return [document.getElementById('main').classList.contains('split'),G.mode,document.querySelectorAll('#gNodes [data-key]').length,off]})()`);
  await shot("graph-split-1920");
  check("N1", "1920 px split: reader + left-to-right graph, every node inside the graph box", split[0] && split[1] === "ltr" && split[2] > 20 && split[3].length === 0, split);
  await b.viewport(1280, 900);

  // ------------------------------------------------------------ M4: no inline SVG/MathML in docs
  await go("theme=light&file=" + encodeURIComponent("work/011-attack/svg.md"));
  const m4d = await b.ev(`(()=>{const c=document.querySelector('.crumbs').getBoundingClientRect();const top=document.elementFromPoint(c.x+10,c.y+c.height/2);const d=document.querySelector('.doc');
    return {doc:!!d,svg:d?d.querySelectorAll('svg,math,rect,text,mi').length:-1,marker:d?.textContent.includes('AFTER-SVG-MARKER'),crumbsOnTop:!!top?.closest('.crumbs'),
      err:!!document.querySelector('#view .state'),sw:[document.getElementById('pane').scrollWidth,document.getElementById('pane').clientWidth]}})()`);
  check("M4", "svg/math are removed from docs: nothing covers the breadcrumb, nothing is wider than the reader, the rest of the doc renders",
    m4d.doc && m4d.svg === 0 && m4d.marker && m4d.crumbsOnTop && !m4d.err && m4d.sw[0] <= m4d.sw[1], m4d);
  await go("theme=light&file=" + encodeURIComponent("work/011-attack/math.md"));
  const n4 = await b.ev(`(()=>{const d=document.querySelector('.doc');return [!!d&&d.textContent.includes('BEFORE-MATH'),!!d&&d.textContent.includes('AFTER-MATH-MARKER'),d?d.querySelectorAll('math,style,img').length:-1]})()`);
  check("M4", "an unclosed <style> inside <math> stays inert: no math/style/img left, text before it kept (what follows is still lost: QA N4, open)", eq(n4.filter((_, i) => i !== 1), [true, 0]), n4);

  // A render error is shown where it happened (the card), never as "Lost access" / "Paused" (M4 part 3).
  await go("theme=light");
  await b.ev(`(()=>{const o=enhanceHtml;window.enhanceHtml=(h,f)=>{if(/BOOM-MARKER/.test(h))throw new Error("test: render error");return o(h,f)}})()`);
  await setFile("work/002-working/tasks.md", `f.text=f.text.replace("Build \`design/mock.html\`","Build BOOM-MARKER \`design/mock.html\`")`);
  const boom = await b.waitFor(`document.querySelector('.card[data-item="002-working"]')?.textContent.includes('BOOM-MARKER')`, 8000);
  await sleep(2300);   // one more poll: the error must not flip the status either
  const m4e = await b.ev(`(()=>{const c=document.querySelector('.card[data-item="002-working"]');return {chip:c?.querySelector('.chip').textContent.trim(),warn:c?.querySelector('.warnline')?.textContent,
    sent:c?.querySelector('.sent').textContent,pill:document.querySelector('#pill .txt').textContent,lost:!!document.querySelector('.lostbar'),cards:document.querySelectorAll('.card').length}})()`);
  check("M4", "a render error in one card: that card shows its status + a plain-text warning; the pill stays 'Live', no 'Lost access'",
    boom >= 0 && m4e.chip === "Working · frontend" && /Couldn't show this item's Markdown/.test(m4e.warn || "") && m4e.sent.includes("BOOM-MARKER") && m4e.pill === "Live" && !m4e.lost && m4e.cards === 12, m4e);

  // ------------------------------------------------------------ L3: heading ids can't clash with the UI's ids; anchors still work
  const IDS = "theme=light&file=" + encodeURIComponent("work/011-attack/ids.md");
  await go(IDS);
  const l3 = await b.ev(`["toast","gsvg","gvp","legend","pane","view","tree"].map((i)=>{const e=document.getElementById(i);return e?e.tagName+(e.closest('.doc')?"@doc":""):null}).concat([[...document.querySelectorAll('.doc :is(h1,h2)')].every((h)=>h.id.startsWith('h-'))])`);
  check("L3", "headings named toast/gsvg/gvp/legend/pane/view/tree don't take over the UI's ids (doc ids are h-…)", eq(l3, ["DIV", "svg", "g", "DIV", "DIV", "DIV", "DIV", true]), l3);
  await clickEl(link("missing"));
  await sleep(300);
  const l3t = await b.ev(`(()=>{const t=document.querySelector('.toast');return [t?.id,t&&!t.hidden,t?.textContent]})()`);
  check("L3", "the toast still works on that page", eq(l3t, ["toast", true, "missing.md isn't in this folder."]), l3t);
  const farTop = `(()=>{const h=document.getElementById('h-far-heading');return h?Math.round(h.getBoundingClientRect().top-document.getElementById('pane').getBoundingClientRect().top):null})()`;
  const before3 = await b.ev(farTop);
  await clickEl(link("jump"));
  await sleep(300);
  const after3 = await b.ev(farTop);
  await clickEl(link("bad anchor"));
  await sleep(200);
  check("L3", "an in-doc #anchor link still scrolls to its (prefixed) heading; a malformed #anchor does nothing", before3 > 900 && after3 >= 0 && after3 < 60 && (await view())[0] === "work/011-attack/ids.md", { before3, after3 });
  await go(IDS + "&at=far-heading");
  await sleep(200);
  const deep = await b.ev(farTop);
  await clickEl(link("cross"));
  await sleep(300);
  check("L3", "#at=<heading> deep links still land on the heading; file.md#anchor links still open the file", deep >= 0 && deep < 60 && (await view())[0] === "work/011-attack/links.md", { deep, view: await view() });

  // ------------------------------------------------------------ N2: task-list checkboxes
  await go("theme=light&file=" + encodeURIComponent("work/011-attack/checks.md"));
  await shot("checks");
  const n2 = await b.ev(`(()=>{const d=document.querySelector('.doc');const box=(i)=>[i.type,i.checked,i.disabled,[...i.attributes].map((a)=>a.name).sort().join(","),i.offsetWidth>0&&getComputedStyle(i).visibility==="visible"];
    return {list:[...d.querySelectorAll('li > input')].map(box),li:[...d.querySelectorAll('li')].map((l)=>[l.textContent.trim(),getComputedStyle(l).listStyleType]),
      others:[...d.querySelectorAll('input')].filter((i)=>!i.closest('li')).map(box),text:d.innerHTML.includes('TEXT-INPUT')}})()`);
  await clickAtEl(`document.querySelector('.doc li > input')`);
  await sleep(150);
  const stillChecked = await b.ev(`[...document.querySelectorAll('.doc li > input')].map((i)=>i.checked)`);
  check("N2", "'- [x]' and '- [ ]' render as disabled checkboxes, checked vs unchecked, no bullet; a click can't change them",
    eq(n2.list, [["checkbox", true, true, "checked,disabled,type", true], ["checkbox", false, true, "disabled,type", true]]) && eq(n2.li, [["CHECKED-ITEM", "none"], ["OPEN-ITEM", "none"]]) && eq(stillChecked, [true, false]), { n2, stillChecked });
  check("N2", "any other <input> is dropped; a raw checkbox keeps only type/disabled (no handlers, name, form or style)",
    !n2.text && eq(n2.others, [["checkbox", false, true, "disabled,type", true]]), n2);

  // ------------------------------------------------------------ M3: persist only the eleven/ folder handle
  const pickGo = async () => { await collect(); const t = await b.go(url.pathToFileURL(PICK).href + "#theme=light", "!!document.getElementById('cOpen')"); if (t < 0) throw new Error("connect screen did not load"); };
  const SPY = `window.saveHandle=(r)=>{window.__saved=r&&r.h?{h:r.h.name,name:r.name}:{bare:r&&r.name}}`;
  await pickGo();
  const copy = await b.ev(`[document.getElementById('cOpen').textContent.trim(),document.querySelector('.connect p').textContent.trim()]`);
  check("M3", "connect screen copy: 'Open the eleven folder'", eq(copy, ["Open the eleven folder", "Open the eleven folder in your project. Only that folder is read."]), copy);
  await b.ev(SPY);
  await b.click("#cOpen");
  await b.waitFor(`!!window.__saved`, 5000);
  const m3a = await b.ev(`({saved:window.__saved||null,folder:document.getElementById('folderBtn').textContent,cards:document.querySelectorAll('.card').length,
    outside:__touched.filter((p)=>!p.startsWith("acme/eleven/"))})`);
  check("M3", "picking the project folder: reads and saves only its eleven/ sub-folder (the project's other files are never listed or read)",
    eq(m3a, { saved: { h: "eleven", name: "acme" }, folder: "acme", cards: 1, outside: [] }), m3a);
  await pickGo();
  await b.ev(SPY + `;window.__pick="eleven"`);
  await b.click("#cOpen");
  await b.waitFor(`!!window.__saved`, 5000);
  check("M3", "picking the eleven folder itself: that folder is saved", eq(await b.ev(`window.__saved`), { h: "eleven", name: "eleven" }), await b.ev(`window.__saved`));
  await pickGo();
  await b.ev(SPY + `;window.__pick="none"`);
  await b.click("#cOpen");
  await b.waitFor(`!!document.getElementById('nlOpen')`, 5000);
  await sleep(300);
  const m3c = await b.ev(`[window.__saved||null,document.querySelector('.connect h1')?.textContent,document.getElementById('nlOpen')?.textContent]`);
  check("M3", "picking a folder with no ledger: nothing is saved; 'No eleven folder here.'", eq(m3c, [null, "No eleven folder here.", "Open the eleven folder"]), m3c);
  const wf = fs.readFileSync(path.join(HERE, "..", "..", ".github", "workflows", "pages.yml"), "utf8");
  const uses = [...wf.matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)].map((m) => m[1].trim());
  check("M3", "Pages workflow: every action is pinned to a full commit SHA, with its tag in a comment", uses.length >= 4 && uses.every((u) => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/.test(u)), uses);

  // ------------------------------------------------------------ 390 px
  await b.viewport(390, 844, true);
  for (const [name, hash] of [["home", "theme=light"], ["questions open", "theme=dark&q=003-waiting"], ["attack notes", "theme=light&file=" + encodeURIComponent("work/011-attack/notes.md")],
    ["svg notes", "theme=light&file=" + encodeURIComponent("work/011-attack/svg.md")], ["checkboxes", "theme=light&file=" + encodeURIComponent("work/011-attack/checks.md")],
    ["arabic notes", "theme=light&file=" + encodeURIComponent("work/010-arabic/notes.md")], ["graph", "theme=light&graph"]]) {
    await go(hash);
    const ov = await b.ev(OVERFLOW);
    await shot("phone-" + name.replace(/\s+/g, "-"));
    check("C7", `390 px, ${name}: no horizontal overflow`, ov.W === 390 && ov.docSW <= 390 && ov.bodySW <= 390 && ov.over.length === 0, ov);
  }
  // still on the phone graph: tap a task
  const td = await b.ev(`G.mode`);
  await clickAtEl(node("t:002-working:1"));
  await sleep(400);
  const tapped = await view();
  check("N1", "390 px graph (top-down): tapping a task opens its report and closes the graph", td === "td" && eq(tapped, ["work/002-working/reports/01-architect.md", false]) && (await b.ev(`document.getElementById('graphPane').hidden`)), { td, tapped });
  await b.viewport(1280, 900);

  // ------------------------------------------------------------ T1: theme button, same key, values and labels as the site (003)
  await go("theme=light");
  await b.ev(`localStorage.removeItem("eleven-theme")`);
  await go("t1");
  const thm = async () => b.ev(`[document.documentElement.dataset.theme||null,localStorage.getItem("eleven-theme"),document.getElementById("themeBtn").getAttribute("aria-label"),
    getComputedStyle(document.body).backgroundColor===${TOK}("--bg")&&!!document.querySelector("#themeBtn svg")]`);
  const cyc = [await thm()];
  for (let i = 0; i < 3; i++) { await b.click("#themeBtn"); await sleep(100); cyc.push(await thm()); }
  await b.click("#themeBtn"); await go("t1-reload"); cyc.push(await thm());
  const t1paint = await b.ev(`(()=>{const h=document.head.innerHTML;const i=h.search(/<script>[^<]*eleven-theme/);return i>h.indexOf("Content-Security-Policy")&&i<h.indexOf("<style>")})()`);
  await b.ev(`localStorage.removeItem("eleven-theme")`);
  const AUTO = "Theme: auto (follows your system). Switch to light", LIGHT = "Theme: light. Switch to dark", DARK = "Theme: dark. Switch to auto";
  check("T1", "theme button cycles Auto → Light → Dark → Auto on eleven-theme (absent = auto) with the site's labels; a reload keeps it; the no-flash script sits after the CSP",
    eq(cyc, [[null, null, AUTO, true], ["light", "light", LIGHT, true], ["dark", "dark", DARK, true], [null, null, AUTO, true], ["light", "light", LIGHT, true]]) && t1paint, { cyc, t1paint });

  // ------------------------------------------------------------ L6: a malformed #file= hash
  const l6 = await tryGo("theme=light&file=%E0%A4%A&at=%E0");
  const l6v = l6 >= 0 ? await b.ev(`[S.view.kind,document.querySelectorAll('.card').length,document.getElementById('homeH').textContent]`) : null;
  check("L6", "#file=%E0%A4%A (malformed) is ignored: Home shows, no exception", l6 >= 0 && eq(l6v, ["home", 12, "5 items wait on you"]), { l6, l6v });

  // ------------------------------------------------------------ across every page
  await collect();
  check("C7", "no script from the ledger ran on any page", xssHits.length === 0, xssHits);
  check("M1", "the app itself never trips its CSP (no violation on any page)", cspHits.length === 0, [...new Set(cspHits)]);
  check("C8", "no uncaught exception or console.error anywhere in the run (all pages, clicks, live updates, frames)", b.errors.length === 0, b.errors);
} catch (e) {
  check("!!", "harness error", false, e.stack || String(e));
} finally {
  await b.close();
  remote.close();
  fs.rmSync(OUT, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed  (ui: ${path.relative(process.cwd(), UI) || UI})`);
process.exit(failed.length ? 1 : 0);
