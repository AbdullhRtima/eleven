# eleven-cto skill

The working habits for running an eleven project as its CTO: a ledger the live view and the phone read correctly,
questions to the CEO while they're away, safe handling of phone answers, delegating and checking agents' work,
shipping through git without force-pushes, briefs that ask only real decisions, and HTML reports that work in the
eleven viewer.

`SKILL.md` is the short version. `reference/` holds the detail.

## Before you install it
- **eleven installed in your project.** See the repo's [Quick start](../../README.md#quick-start). The skill reads
  `eleven/AGENTS.md`, the item ledgers under `eleven/work/`, and the live view in `eleven/ui/`.
- **Optional: answering from your phone.** The skill's notes on phone answers and on watching for submissions apply
  only when you do.

## Install
Choose one of the three ways.

### 1. With the `skills` CLI, recommended
From your project's root:
```bash
npx skills add AbdullhRtima/eleven -s eleven-cto
```
This puts the skill in `.agents/skills/eleven-cto/`, the shared folder that Codex and Cursor read, and links it into
`.claude/skills/` for Claude Code. If your tool wasn't detected, add `-a <tool>`, for example `-a claude-code`.

### 2. By hand, for one project
Copy the folder into the project:
```bash
# Claude Code
mkdir -p .claude/skills && cp -r ~/eleven/skills/eleven-cto .claude/skills/

# Codex, Cursor and other tools that read .agents/skills
mkdir -p .agents/skills && cp -r ~/eleven/skills/eleven-cto .agents/skills/
```
```powershell
# Windows, Claude Code
New-Item -ItemType Directory -Force .claude\skills | Out-Null
Copy-Item -Recurse $HOME\eleven\skills\eleven-cto .claude\skills\
```

### 3. By hand, for every project (Claude Code)
```bash
mkdir -p ~/.claude/skills && cp -r ~/eleven/skills/eleven-cto ~/.claude/skills/
```

These paths assume you cloned the kit to `~/eleven`, as in the Quick start. If you don't want the skill in your
repo's history, add `.claude/skills/` or `.agents/` to `.git/info/exclude`, the same way eleven hides itself.

## Use it
Start your agent in the project and say:
```
Read eleven/AGENTS.md and act as the CTO.
```
The skill loads when the agent acts as eleven's CTO. To load it explicitly, name it: "use the eleven-cto skill".

To work from your phone, set up your phone access first. Tell the agent you're away and that it should
keep watching the ledger. It will then put its questions in each item's `brief.md`, and re-arm its watch as it goes.

## Update
- **With the CLI:** run `npx skills update`.
- **By hand:** `git pull` in your clone of the kit, then copy the folder again.
