# Working with AI better than most engineers

Most engineers use AI as one long chat: "build X", then "fix it", then "fix it again".
The context fills with noise, the model forgets its own decisions, and quality decays.
The edge comes from **organising** the AI, not from prompting it harder.

## What the research says

*GVS5H: Zero-Shot Self-Orchestration with Ledger-Based Control for Improved LLM Coding Performance*
(Gao et al., [arXiv:2608.26480](https://arxiv.org/abs/2608.26480)):

- A **manager** call plans; **fresh worker** calls each do **one** task; they share state only through a few **files on disk** (the "ledger").
- A **verifier** runs tests, and a failing test overrides "done".
- **Guards:** a round budget, a no-progress stop, summaries for workers that run out of context, and **size caps on plan (4k chars) and notes (8k chars), which are rewritten rather than appended.**
- Results on 100 hard LiveCodeBench problems: up to **+25.6 points** (Qwen3.8-27B: 66.8 → 92.4). An orchestrated cheap model scored **93.0 vs 90.4** for a frontier model at about **9% of the cost**.
- The authors credit **decomposition** and **persistent context**, and observe that writing reasoning to disk before coding helps.
- Caveats: about 3× the tokens of a single call. Not every model gained, and some got worse, because deliberation can settle on a worse plan. Strong models gain least.

`eleven` is that loop, extended with the roles a real product team needs.

## Ten habits

1. **Brief before code.** Make the acceptance criteria testable. Most AI failures are spec failures.
2. **One task per fresh context.** Long chats rot. Start new sessions and let the files carry the memory.
3. **Make it think on disk.** Approaches and pitfalls go into `notes.md` before code. Read them; it's the cheapest review you'll ever do.
4. **Keep the ledger small and true.** Rewrite, don't append. Stale notes are poison.
5. **Verify, don't trust.** Tests that fail without the change. A real build. Real output pasted. "Should work" isn't evidence.
6. **Separate maker and checker.** The agent that wrote the code doesn't approve it. QA and Security do.
7. **Small diffs, shipped often.** You can review 50 lines. You can't review 2,000.
8. **Write decisions down.** One page in `eleven/decisions/` saves a week of re-arguing later.
9. **Stop loops early.** If the same task comes up twice, the plan is wrong, not the worker. Change the task.
10. **You stay the CEO.** Approve the brief, accept the result, and read every diff that touches money, auth or data.

## Measure yourself
Track per item: rounds used, QA failures caught before you saw them, bugs after
shipping, and time from brief to shipped. Improve the role files when a pattern
repeats. Treat them as your team's training material.
