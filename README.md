# eleven

> M-theory needs **eleven dimensions** to unify five string theories into one.
> `eleven` unifies eleven roles into one AI team.

A folder of Markdown files you drop into any project. It turns a coding agent
(Claude Code, opencode, Codex, Cursor…) into a full software team: product,
design, architecture, backend, frontend, mobile, QA, DevOps, security, docs,
and a CTO who runs the loop.

It lives in one folder, `eleven/`, at the project root, and it is invisible to git.

Website: **[eleven.rtima.org](https://eleven.rtima.org)**

## Install into a project

**macOS / Linux**
```bash
git clone https://github.com/AbdullhRtima/eleven.git ~/eleven
~/eleven/install.sh ~/code/my-project
```

**Windows (PowerShell)**
```powershell
git clone https://github.com/AbdullhRtima/eleven.git $HOME\eleven
~\eleven\install.ps1 C:\code\my-project
```
If scripts are blocked, run `powershell -ExecutionPolicy Bypass -File $HOME\eleven\install.ps1 C:\code\my-project` instead.

The installer copies the kit to `my-project/eleven/` and adds `/eleven/` to
`.git/info/exclude`. That file is your local ignore list, so the project's
`.gitignore` is untouched and nothing shows up in `git status`.

To pull in kit improvements later, run `git pull` in the kit, then
`install.sh --update ~/code/my-project` (or `install.ps1 -Update …`).
Your `project.md`, `work/` and `decisions/` are never touched.

## Watch it work

Open **[eleven.rtima.org/app](https://eleven.rtima.org/app/)**, or `eleven/ui/index.html`
locally, in Chrome or Edge, then choose your project's `eleven` folder. You see each
item's loop step, round budget, tasks, reports and a live activity feed, and
anything that needs your answer is pulled to the top. The page reads the folder in
your browser; nothing is uploaded. Firefox and Safari open a snapshot instead.

## Use it

In your project, tell the agent:

> Read eleven/AGENTS.md and act as the CTO. Fill eleven/project.md from the codebase.

Then, for each piece of work:

> Read eleven/AGENTS.md and act as the CTO. New item 001: *&lt;your idea&gt;*. Start at step 0.

Or, to pick up where you left off:

> Read eleven/AGENTS.md and act as the CTO. Continue item 001.

You approve the brief, answer open questions, and accept the result.

## Inside `eleven/`

```
AGENTS.md         the operating manual every agent reads first
project.md        facts about this project (filled on first run)
agents/*.md       the 11 roles
templates/        brief, plan, tasks, notes, report, decision, project
work/<NNN>-slug/  one folder per item: the shared "ledger"
decisions/        decision records that outlive an item
docs/             the habits and research behind it, the CTO role, the roadmap
ui/index.html     the live browser UI
install.sh        install/update (macOS, Linux)
install.ps1       install/update (Windows)
```

The kit repo also holds `site/` (the landing page, deployed to GitHub Pages).
See [docs/roadmap.md](docs/roadmap.md) for what's next.

## Why this works

It applies the manager/worker/ledger loop from *GVS5H* ([arXiv:2608.26480](https://arxiv.org/abs/2608.26480)):
fresh single-task workers, shared files with size caps, a verifier that can veto
"done", and guards against runaway loops. That loop lifted a cheap model above a
frontier one on hard coding problems. See [docs/working-with-ai.md](docs/working-with-ai.md).

![What a CTO does](docs/cto.svg)
