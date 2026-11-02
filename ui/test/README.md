# ui/test

Browser checks for `ui/index.html`. They run in headless Chrome against a made-up ledger.

```sh
node ui/test/run.mjs
```

The command prints one `PASS`/`FAIL` line per check and exits with code 1 if any check fails.

- **Needs:** Node 22 or newer, Google Chrome, and a network connection (the page loads marked and DOMPurify from cdnjs). There are no npm packages.
- **Chrome:** the default path is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. On another system, set `CHROME=/path/to/chrome`.
- **Another build:** `UI=/path/to/index.html node ui/test/run.mjs` tests a different copy. Use it to confirm that a check fails without your fix.
- **Screenshots:** `SHOTS=/some/dir node ui/test/run.mjs` saves the pages it visits, including the 390 px views.
- **Mutants:** `node ui/test/run.mjs --mutants` runs the whole suite on each deliberately broken copy in `mutants.mjs` (QA's five from report 08)
  and exits with 1 if any of them still passes. Run it after changing a check. `node ui/test/mutants.mjs <dir>` writes the copies to look at.

## How it works
- `fixtures.mjs` holds a **synthetic** ledger. It has every status case, the different shapes of open questions, sub-folders, an `.html` file, Arabic text,
  a file name with spaces, and the XSS and attack files from QA (report 04).
  Never copy a real project's ledger in here.
- `run.mjs` writes a temporary page: the UI plus `window.__ELEVEN_TEST_FILES__`, which replaces the folder picker. The UI re-reads that object on
  every poll, so a check can change the "disk" while the page is open. The UI then writes what it computed to `#__eleven_test_out`.
- `cdp.mjs` is a small Chrome DevTools Protocol driver. It sends real mouse, wheel and key events, sets the viewport for 390 px, records network
  requests, and keeps every exception and `console.error` of the whole run (pages, clicks, live updates and the sandboxed frames, which Chrome runs
  out of process). The final C8 check fails on any of them.
- `run.mjs` also starts a logging server on 127.0.0.1. A ledger `.html` file and the CSP checks aim at it, and no request may arrive. For the connect
  flow (M3), it loads the UI with a fake folder picker.

Check ids: `C1`–`C8` match the brief's acceptance criteria. `B1`–`B8` match the bugs in QA report 04. `M1`–`M4`, `L3` and `L6` match security
report 08b, and `N1`/`N2` match QA report 08.
