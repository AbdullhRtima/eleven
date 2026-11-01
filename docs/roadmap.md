# Roadmap

## What apexyard has that eleven doesn't (yet)

Studied [apexyard.ai](https://apexyard.ai) on 2026-11-01. Ordered by value to eleven.

| # | Gap | What apexyard does | eleven today | Plan |
|---|---|---|---|---|
| 1 | **Enforced guardrails** | 66 hook scripts: blocks pushes to main, blocks agents writing their own approval, scans for secrets, requires a rollback plan for DB changes | Rules are text in AGENTS.md; agents can ignore them | Ship optional git hooks + Claude Code hooks (`hooks/`) for main-push block, secret scan, self-approval block |
| 2 | **Dedicated code reviewer** | "Rex" reviews code, tests, decisions and glossary on every PR | QA tests behaviour and Security reviews risk; nobody reviews code quality | Add a `reviewer` role (makes 12, or fold it into the architect) |
| 3 | **Slash commands** | `/idea`, `/write-spec`, `/decide`, `/start-ticket`, `/approve-merge`, `/inbox`, `/launch-check`, `/handover`… | You type the prompt yourself | Ship `commands/` (Claude Code, opencode) installed on demand: `/eleven-new`, `/eleven-continue`, `/eleven-status` |
| 4 | **GitHub integration** | Tickets are issues, every PR links a ticket, named human approval per merge | Ledger only, local merges | Optional: mirror tasks to issues, one PR per task, approval by PR review |
| 5 | **Launch-readiness check** | `/launch-check`: security, performance, a11y, monitoring, docs | Definition of done covers part of it | Add `templates/launch-check.md` + a step before Ship |
| 6 | **Portfolio inbox** | `/inbox` across all managed projects; project registry | One project at a time | Live UI: open several eleven folders, one "needs you" inbox |
| 7 | **CI golden paths** | 7 ready GitHub Actions pipelines (quality, security, deps, PR title, SEO) | DevOps role describes CI but ships none | `golden-paths/` with GitHub Actions starter workflows |
| 8 | **Onboarding & handover** | `/setup` asks 3 questions; `/handover <repo>` adopts an existing repo | CTO fills project.md | Guided first run in AGENTS.md + handover checklist |
| 9 | **Update notifications** | Session start warns when your fork is behind upstream | `install --update`, manual | `eleven/VERSION` + the UI shows "update available" |
| 10 | **Post-merge QA on staging** | QA verifies on staging after merge | QA verifies before merge | Add an optional staging-verify step to QA |
| 11 | **Stakeholder updates** | `/stakeholder-update weekly` | None | Template + a CTO task that summarises the ledger weekly |
| 12 | **Glossary** | Reviewed glossary terms | None | `eleven/glossary.md`, read by all roles |
| 13 | **Releases & changelog** | 40 releases, versioned changelog | One commit | Tag v0.1.0, add CHANGELOG.md, GitHub releases |
| 14 | **Community & support** | Slack community, paid setup | None | GitHub Discussions, CONTRIBUTING.md |

## What eleven has that apexyard doesn't

- **A loop grounded in research:** manager/worker/ledger from GVS5H, with a round budget, a no-progress stop, and size-capped notes that are rewritten rather than appended.
- **A fresh context per task:** every role runs as a new subagent.
- **Full product team:** designer, frontend, mobile, DevOps and tech-writer roles, not only engineering and review.
- **Live browser UI, free:** apexyard has no dashboard outside its paid "cockpit".
- **Invisible install:** one folder, hidden through `.git/info/exclude`. Nothing to fork, nothing in your repo.
- **Tool-agnostic and tiny:** about 25 Markdown files you can read in 15 minutes.

## Next up
1. Guardrail hooks (gap 1)
2. Reviewer role (gap 2)
3. Slash commands (gap 3)
4. v0.1.0 release + CHANGELOG (gap 13)
