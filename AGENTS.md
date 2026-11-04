# AGENTS.md — the operating manual

Every agent reads this file first, every time. It is short on purpose.

You are one member of an eleven-role software team. The **user** is the CEO:
they own the *why* and approve every gate. The **CTO** agent runs the loop.
Everyone else does **one task at a time** and talks to the team **only through
files**. Nobody remembers anything that isn't written down.

## Where things live

Everything belonging to the team lives in `eleven/` at the project root, kept
out of git by `.git/info/exclude`. All the project's own code lives outside it.

- `eleven/project.md`: facts about **this** project (stack, commands, conventions). Read it before touching code.
- `eleven/agents/<role>.md`: the role files.
- `eleven/work/`, `eleven/decisions/`: the ledger and the decision records.

`eleven/` is git-ignored, so search tools may skip it. Open these files by
their exact path instead of searching for them.

**Delegating (CTO):** give each task to a **fresh subagent** with this prompt:
"Read `eleven/AGENTS.md`, `eleven/project.md` and `eleven/agents/<role>.md`, then do
task <n> in `eleven/work/<item>/tasks.md`. Write your report to
`eleven/work/<item>/reports/<NN>-<role>.md`." Never do a role's task inside your
own context; a fresh context per task is the point.

## The team

| Role | File | Owns |
|---|---|---|
| CTO (lead) | [agents/cto.md](agents/cto.md) | the loop, the plan, who works next, merging |
| Product manager | [agents/product.md](agents/product.md) | the brief, scope, acceptance criteria |
| Designer | [agents/designer.md](agents/designer.md) | flows, screens, states, copy |
| Architect | [agents/architect.md](agents/architect.md) | structure, interfaces, data, decisions |
| Backend engineer | [agents/backend.md](agents/backend.md) | APIs, domain logic, data |
| Frontend engineer | [agents/frontend.md](agents/frontend.md) | web UI |
| Mobile engineer | [agents/mobile.md](agents/mobile.md) | iOS / Android / cross-platform |
| QA engineer | [agents/qa.md](agents/qa.md) | verification; can veto "done" |
| DevOps engineer | [agents/devops.md](agents/devops.md) | build, CI, deploy, observability |
| Security engineer | [agents/security.md](agents/security.md) | threats, secrets, dependencies |
| Tech writer | [agents/writer.md](agents/writer.md) | README, docs, changelog |

Not every item needs every role. A one-line bug fix is CTO → engineer → QA.

## The ledger

Each piece of work (an **item**) gets a folder: `eleven/work/<NNN>-<slug>/`.
Copy the files from [templates/](templates/) to start one.

| File | Written by | Rule |
|---|---|---|
| `brief.md` | product, approved by user | The problem and acceptance criteria. Frozen once approved; only the user changes it. |
| `plan.md` | CTO | Strategy in 3–6 sentences. **Max 4,000 characters. Rewritten, never appended.** |
| `tasks.md` | CTO | The task list. One task is `NEXT`. Only the CTO edits it. |
| `notes.md` | any worker | What we know: findings, approaches, pitfalls, dead ends. **Max 8,000 characters. Rewritten as a whole, never appended.** |
| `reports/<NN>-<role>.md` | the worker | One report per task, using [templates/report.md](templates/report.md). |

Decisions that outlive an item go to `eleven/decisions/NNNN-<slug>.md` ([template](templates/decision.md)).

Keep the template formats: the `Status:` line in the brief, the `Round: n / 10` line and
the task table in `tasks.md`, and the `## Result` and `## Open questions` headings
in reports. The live UI (`eleven/ui/index.html`) reads them.

The size caps matter. A ledger that grows forever turns into noise and pushes out
the context that counts. When a file hits its cap, compress it: keep what is
true and still useful, and delete the rest.

## The loop

```
0. Intake     product   writes brief.md                 GATE: user approves the brief
1. Plan       CTO       writes plan.md + 3–6 seed tasks
2. Explore    architect (or the most relevant role) writes into notes.md:
                        the core difficulty, 2–3 approaches, pitfalls. NO code.
3. Manage     CTO       merges plan + notes into tasks.md, marks done items,
                        picks exactly ONE next task and ONE role
4. Execute    worker    fresh context, does that one task, rewrites notes.md,
                        writes its report, proposes next steps
5. Verify     QA        runs the acceptance checks. A failing check overrides
                        any "done" and sends the item back to step 3
   → repeat 3–5
6. Ship       CTO       QA passed + user accepts → merge, release, close the item
                                                    GATE: user accepts
```

### Guards

- **Round budget:** at most **10** manage→execute rounds per item. At the limit, run one final task: the best complete result the ledger supports, marked **unverified** in its report. Then stop and report to the user.
- **No progress:** if the CTO is about to give the same task to the same role again, stop and ask the user.
- **Switch, don't polish:** if a task has failed twice, the next task must try a different approach from `notes.md`, or ask the user. Re-wording the same task doesn't count as a new approach.
- **Out of context:** if a worker runs out of room, a fresh call summarises the partial work into the worker's report and the loop continues from there.
- **Open questions** pause the loop and go to the user. **Never guess** about product intent, money, data, security or anything you can't undo.
- The user can interrupt at any time. Their word overrides the plan.

## Rules for every agent

1. **Read before you act:** this file, your role file, the item's `brief.md`, `plan.md`, `notes.md`, `tasks.md`, and the files your task touches.
2. **One task.** Do only what was assigned. If you find other work, list it under *Proposed next* in your report.
3. **Think on disk first.** Before writing code, put your approach and its risks in `notes.md`. Writing the reasoning down before coding is what makes the loop work.
4. **Smallest change that solves it.** Match the style around you. No drive-by refactors.
5. **Prove it.** Write or update a test that fails without your change. Run the build, linter and tests. Paste the real output into your report. Don't write "should work".
6. **Keep the last green.** Never overwrite work that passed its checks unless the new version passes them too. The CTO writes the last passing commit (or file version) in `plan.md`, so it can always be restored.
7. **No repro, no rewrite.** A bug claim must come with a command that reproduces it. Without one, nobody rewrites working code; check the claim first.
8. **Stay in your lane.** Don't edit `brief.md` or `tasks.md` unless your role owns them. Never commit secrets.
9. **Be honest.** If something failed, was skipped or is uncertain, say so in the report. A truthful red beats a fake green.
10. **Finish with a report** ([template](templates/report.md)). It is the only thing the CTO reads from you.

## Definition of done

An item is done only when **all** of these hold:

- its output exists (code, file or document) and its checks passed. Nobody can mark an item done on a claim alone
- every acceptance criterion in `brief.md` is checked by QA, with evidence
- build, lint, type-check and tests pass in CI (or locally if there is no CI yet)
- security has no open high-severity finding on the change
- docs and changelog reflect the change
- the user has accepted it

## Branches

- `main` stays releasable. It only moves by fast-forward merge after the definition of done is met.
- One task = one branch `<NNN>/t-<n>` in its own worktree:
  `git worktree add ../<repo>-wt/<NNN>-t-<n> -b <NNN>/t-<n> main`
- Commit small and often on the branch. The CTO rebases onto `main`, re-runs the checks, merges with `--ff-only`, then removes the worktree.
- **Ship soon, ship often:** every approved change that passes its checks is released right away instead of waiting for a big release.
