# The ledger is the CEO's screen

The live view (`eleven/ui/index.html`) and the phone build their picture of each item from two files: `brief.md` and
`tasks.md`. If those are stale or written in words the view doesn't read, the CEO sees the wrong state. That's worse
than seeing nothing.

## Status words
- The view sorts each row by the start of its Status cell. Read `statusKind()` in your copy of `ui/index.html` for the
  exact list your version understands. A typical set is:
  - `NEXT` → working (or waiting, when the row's role is the CEO);
  - `done`, `passed`, `shipped`, `merged` → done;
  - `blocked`, `failed`, `cancelled`;
  - anything else → to do.
- Words like "running", "on hold" or "in progress" may read as **to do**. Put the active task's status as
  `NEXT: in progress (…)`, so the detail in brackets doesn't hide the state.
- **Exactly one NEXT.** Two NEXT rows give the view a warning, and the second is ignored.
- Put the detail after the status word: `done (merged as #70, dev 76caaec; worktree removed)`. The phone shows that
  text, so make it the facts the CEO needs.

## Only the first table counts
The view parses only the **first** table in `tasks.md`. A second table, such as a follow-up round written lower down,
is invisible. Add follow-up work as new rows in the first table (`9a`, `10`, `11`) and keep the prose sections below
it.

## When an item is "waiting" and "done"
- **Waiting:** a NEXT row whose role is the CEO, the user or "you". Only then does the view show the brief's
  `## Open questions` on the item.
- **Done:** the **last** row of the first table is done or cancelled. A superseded row left as "to do" keeps the item
  open forever, so mark it `cancelled (superseded: …)`.
- `brief.md`'s `Status:` line matters only while `tasks.md` has no rows. Before then, "approved…" reads as working and
  anything else as "read the brief and approve it".

## Update as you go
- Edit the row the moment a task starts, finishes or changes owner. The CEO checks from a phone between meetings.
- When a subagent hands back, record its result in the row (key numbers, commit, verdict) before you reply.
- Keep `notes.md` short. The ledger is for state; reports are for evidence.
