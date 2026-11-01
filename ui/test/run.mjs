// ui/test: drives ui/index.html in headless Chrome on the synthetic ledger in fixtures.mjs and asserts what the page computes.
// Usage: node ui/test/run.mjs            (CHROME=/path/to/chrome, UI=/path/to/index.html, SHOTS=/dir for screenshots)
// Exit code: 0 when every check passes, 1 otherwise. Needs network for the two cdnjs scripts.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { launch, sleep } from "./cdp.mjs";
import { ledger } from "./fixtures.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const UI = path.resolve(process.env.UI || path.join(HERE, "..", "index.html"));
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "eleven-ui-test-"));
const ui = fs.readFileSync(UI, "utf8");

// The page: the UI with an error trap and the fixture injected first in <head>. window.__x(c) records code that ran.
const TRAP = `<script>window.__xss=null;window.__x=(c)=>{window.__xss=(window.__xss||"")+c};
addEventListener("message",(e)=>{if(e.data&&e.data.evil)window.__evil=e.data.evil});</script>`;
const fixture = `<script>window.__ELEVEN_TEST_NAME__="sample";window.__ELEVEN_TEST_FILES__=${JSON.stringify(ledger).replace(/</g, "\\u003c")};</script>`;
const PAGE = path.join(OUT, "page.html");
fs.writeFileSync(PAGE, ui.replace("<head>", `<head>\n${TRAP}\n${fixture}`));
const at = (hash) => url.pathToFileURL(PAGE).href + "#" + hash;

const results = [];
function check(id, name, ok, detail = "") {
  results.push({ id, name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(3)} ${name}${ok ? "" : `\n        got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const b = await launch();
await b.viewport(1280, 900);
const exceptions = [];
const xssHits = [];
const go = async (hash) => { const x = await b.ev(`window.__xss||null`).catch(() => null); if (x) xssHits.push(x); const t = await b.go(at(hash)); exceptions.push(...b.exceptions()); if (t < 0) throw new Error("page did not load: " + hash); };
const out = () => b.ev(`JSON.parse(document.getElementById('__eleven_test_out').textContent)`);
const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await b.shot(path.join(SHOTS, name + ".png")); } };
// Real mouse click on the element an expression returns.
const clickEl = async (expr) => {
  const r = await b.ev(`(()=>{const e=(${expr});if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return [r.x+Math.min(r.width/2,20),r.y+r.height/2]})()`);
  if (r) await b.clickAt(r[0], r[1]);
  return !!r;
};
const link = (text) => `[...document.querySelectorAll('#view a')].find((a)=>a.textContent.trim()===${JSON.stringify(text)})`;
const setFile = (p, js) => b.ev(`(()=>{const f=window.__ELEVEN_TEST_FILES__[${JSON.stringify(p)}];${js};f.mtime=Date.now()})()`);
// Elements past the right edge, ignoring boxes that scroll on their own.
const OVERFLOW = `(()=>{const W=document.documentElement.clientWidth;const over=[...document.querySelectorAll("body *")].filter((el)=>{
  if(el.closest(".tablewrap, pre, .q-body, svg, .gwrap, .menu, iframe, [hidden]")||(el.closest("#side")&&!document.body.classList.contains("drawer")))return false;
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
  };
  for (const [id, w] of Object.entries(want)) check("C1", `status of ${id}: ${w[0]} · ${w[1]}`, eq(st[id], w), st[id]);
  check("C1", "two NEXT rows warn", (o.items.find((i) => i.id === "009-two-next")?.warn || []).some((w) => /2 tasks are marked NEXT/.test(w)));
  check("C1", "only the 11 items are listed", eq(o.items.map((i) => i.id), Object.keys(want)), o.items.map((i) => i.id));

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
    forbidden:[...v.querySelectorAll('.doc :is(style,link,form,input,textarea,select,button:not(.imgoff),iframe,object,embed,video,audio,source,image)')].map((e)=>e.tagName),
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

  // ------------------------------------------------------------ 390 px
  await b.viewport(390, 844, true);
  for (const [name, hash] of [["home", "theme=light"], ["questions open", "theme=dark&q=003-waiting"], ["attack notes", "theme=light&file=" + encodeURIComponent("work/011-attack/notes.md")],
    ["arabic notes", "theme=light&file=" + encodeURIComponent("work/010-arabic/notes.md")], ["graph", "theme=light&graph"]]) {
    await go(hash);
    const ov = await b.ev(OVERFLOW);
    await shot("phone-" + name.replace(/\s+/g, "-"));
    check("C7", `390 px, ${name}: no horizontal overflow`, ov.W === 390 && ov.docSW <= 390 && ov.bodySW <= 390 && ov.over.length === 0, ov);
  }
  await b.viewport(1280, 900);

  // ------------------------------------------------------------ across every page
  const lastX = await b.ev(`window.__xss`); if (lastX) xssHits.push(lastX);
  check("C7", "no script from the ledger ran on any page", xssHits.length === 0, xssHits);
  check("C8", "no uncaught exceptions in the page", exceptions.length === 0, exceptions);
} catch (e) {
  check("!!", "harness error", false, e.stack || String(e));
} finally {
  await b.close();
  fs.rmSync(OUT, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed  (ui: ${path.relative(process.cwd(), UI) || UI})`);
process.exit(failed.length ? 1 : 0);
