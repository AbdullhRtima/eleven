# Git and shipping without surprises

## One worktree per item
- Do each item's code in its own worktree (`git worktree add ../<repo>-wt/<item> -b <branch> origin/<base>`), so the
  main checkout and other items stay untouched.
- On Windows, `git worktree remove` can fail on deep `node_modules` paths. Delete the folder through the `\\?\` path
  prefix, then run `git worktree prune`. If a terminal is still inside the folder, the empty folder stays until the
  user moves out.
- Delete the local branch after the merge (`git branch -d`). `-d` refuses unmerged work, which is the point.

## Someone else's pushed branch
- **Merge the base into it; don't rebase.** A rebase rewrites their commits and forces a force-push. A merge lets you
  push on top.
- When their review asks for changes and the CEO decides "we fix it ourselves", work on a local branch from their
  head. Merge the base in, fix, and push as a normal fast-forward to their branch, so their review updates in place.

## See conflicts before they happen
- **A trial merge needs no checkout.** `git merge-tree --write-tree <a> <b>` prints the conflicted files, or a tree id
  when it's clean.
- **When two open branches touch the same files,** trial-merge them in both orders on top of the base. Tell the CEO
  which to merge first, and that you'll resolve the second after. Usually the conflicts are both sides adding their
  own lines in the same place: keep both.
- After a merge, re-run the full gate before you push.

## Pushing
- **Push only with the CEO's OK, given at the machine.** Before the push, confirm three things:
  - the remote tip is still an ancestor of what you push, so it's a fast-forward;
  - the base is merged in;
  - no tracked secret file changed.
- If a force-push is ever truly needed, don't run it. Give the CEO the full `--force-with-lease=<branch>:<full-sha>`
  line to run.
- **New branches:** a hosting service's "create pull request" link often defaults to the main branch. Tell the CEO
  which base to pick.
- **Write the merge request's title and description,** plus who it's for, ready to paste. Save a copy in the item
  folder.

## Secrets and settings files
- **Never print or read the values in `.env*` files.** To check them, print key names only
  (`sed -E 's/=.*/=<hidden>/'`), or compare two lines for equality without printing either.
- **Check whether those files are tracked** (`git ls-files '.env*'`). If they are, a value the CEO changes must be
  committed. Commit it, checking only the diff summary.
- **A setting the app needs** (a flag, an id) is documented where the repo documents settings. The agent never writes
  the value.
