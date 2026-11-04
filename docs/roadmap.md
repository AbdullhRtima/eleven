# Roadmap

## Vision

Your AI, organised into a team. eleven turns any coding agent into a small software company that
plans, builds, checks and ships. You stay the CEO.

What eleven stays, whatever we add:

- **Grounded in research:** a manager, fresh single-task workers and a shared ledger (GVS5H), with a
  round budget, a no-progress stop, and size-capped notes that are rewritten, not appended.
- **A fresh context per task:** every role runs as a new subagent with one job.
- **A full product team:** product, design, architecture, engineering, QA, DevOps, security and docs.
- **Plain and tiny:** about 25 Markdown files you can read in 15 minutes. No server, no account.
- **Invisible:** one folder, hidden through `.git/info/exclude`. Nothing lands in your repo.
- **Any agent:** works with anything that can read files and follow instructions.
- **Free:** MIT, including the live browser UI.

## Planned

Ordered by value.

| # | Feature | eleven today | Plan |
|---|---|---|---|
| 1 | **Enforced guardrails** | Rules are text in AGENTS.md; agents can ignore them | Optional git hooks and agent hooks (`hooks/`): block pushes to main, scan for secrets, stop an agent from approving its own work |
| 2 | **Code reviewer** | QA tests behaviour and Security reviews risk; nobody reviews code quality | Add a `reviewer` role, or fold it into the architect |
| 3 | **Slash commands** | You type the prompt yourself | `commands/`, installed on demand: `/eleven-new`, `/eleven-continue`, `/eleven-status` |
| 4 | **GitHub integration** | Ledger only, local merges | Optional: mirror tasks to issues, one PR per task, approval by PR review |
| 5 | **Launch check** | The definition of done covers part of it | `templates/launch-check.md` (security, performance, a11y, monitoring, docs) as a step before Ship |
| 6 | **Multi-project inbox** | One project at a time | Live UI: open several eleven folders in one "needs you" inbox |
| 7 | **CI starters** | DevOps describes CI but ships none | `golden-paths/` with GitHub Actions starter workflows |
| 8 | **Onboarding and handover** | The CTO fills project.md | A guided first run and a checklist for adopting an existing repo |
| 9 | **Update notice** | `install --update`, by hand | `eleven/VERSION`, and the UI shows "update available" |
| 10 | **Post-merge check** | QA verifies before merge | An optional staging check for QA after merge |
| 11 | **Stakeholder updates** | None | A template and a weekly CTO summary of the ledger |
| 12 | **Glossary** | None | `eleven/glossary.md`, read by every role |
| 13 | **Releases and changelog** | No tagged release | Tag v0.1.0, add CHANGELOG.md and GitHub releases |
| 14 | **Community** | None | GitHub Discussions and CONTRIBUTING.md |

## Next up
1. Guardrail hooks (1)
2. Reviewer role (2)
3. Slash commands (3)
4. v0.1.0 release and CHANGELOG (13)
