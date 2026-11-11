# HTML reports in the ledger

The live view shows a ledger `.html` file in a sandboxed frame (`sandbox="allow-scripts"`, loaded from a blob URL, with
a content policy that blocks all network). The page's scripts run, but some ordinary web habits fail without telling
you.

## What breaks, and what to do instead
- **Hash navigation is blocked.** Setting `location.hash` from a click doesn't navigate, so tabs that switch only
  through `hashchange` look dead. Call the show function directly on click, then try to set the hash inside
  `try/catch`, for pages that are also opened elsewhere. Do the same for `<a href="#…">` links: catch the click and
  call the show function.
- **No network:** no web fonts, CDN scripts, remote images or `fetch`. Use a system font stack, inline SVG or CSS for
  drawings, and `data:` URIs for anything else.
- **A page that navigates itself** is caught and replaced with a warning. Never set `location.href`.

## Pages the CEO forwards
- **Mockups use generic sample names** ("Engineer A", "Project Alpha"). Don't put real colleagues' names next to
  invented numbers, such as costs or review comments: a forwarded page reads those as facts.
- **Keep sample numbers consistent:** totals add up, percentages match, and an average can't exceed its own cap.
- **Before handing over a page an agent wrote,** read it, or at least its script and every place a name or a number
  appears. Then check that the tabs, the panels and each `aria-controls` match, and run `node --check` on the inline
  script.
- **When the plan behind a page changes,** update the page too: a renamed group, a new task, a count. Republish to
  the same address, so links people already have stay valid.
