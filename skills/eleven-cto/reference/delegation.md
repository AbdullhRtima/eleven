# Delegating, and checking what comes back

## Brief an agent like a peer who knows nothing
A fresh agent knows only your prompt. A good brief has:
- **the goal and why;**
- **the exact place:** the repo, a worktree path, a branch and its head commit;
- **the facts you already checked,** with `file:line`, so they aren't re-derived wrongly;
- **what not to do:** no push, no secrets, no bare `git stash` in a shared repo, no files outside its task, nothing
  left running;
- **the checks to run,** with their exact commands;
- **where to write the report,** in the kit's report template;
- **what to hand back:** a short summary.

**Pick the model by difficulty.** The cheap model does build, QA and page work. The strongest model does the
thinking where a wrong answer is costly: architecture, privacy, a design that counts things.

**Pass new decisions on at once.** If the CEO answers while an agent runs, message that agent with the decision. Don't
wait for its hand-back and redo the work.

## Check every hand-back
A hand-back is the agent's claim, not a fact. Before you mark the row done:
- **The commits are there,** on the right branch, and touch only what they should (`git show --stat`).
- **The worktree is clean,** and no stash entry was left behind. Agents that stash to "see a test fail first" can
  leave one.
- **Secrets are untouched:** no `.env*` file in the diff. Check key names, never values.
- **Nothing is left running** from the worktree: dev servers, test runners.
- **Read the key code yourself** when it carries the risk: a privacy check, a flag read in one place, a merge
  resolution.
- **Re-check numbers that matter:** a fix that "removes the flake" needs runs before and after.

## What "green" means
- **The project's full gate:** typecheck, format, lint, any analyzers, unit tests and the build. If end-to-end tests
  aren't in CI, run them **twice**.
- **Classify every failure:**
  - re-run it alone;
  - check it against the known flaky tests;
  - if it isn't on that list, compare against the base branch under the same load (`--repeat-each`, or several full
    runs per tree) before calling it a flake.
- **If your change adds work on a hot path,** suspect it when a timing test starts failing, for example a formatter
  built on every render. Fix the cost, then measure again.
- **Sight-check UI work:** screenshots at desktop and phone width, in light and dark, read by an agent or by you.

## Ask the user before you touch their work
- Don't stop a process the user started, such as a dev server from their local test. Ask, or ask them to stop it.
- A folder still held open by a user's terminal can't be deleted. Tell them to `cd` out, and don't force it.
