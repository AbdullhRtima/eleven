# Briefs, research, and reporting to the CEO

## A brief asks only real decisions
- **Before drafting, learn what the named tool can do** by reading its code. Design inside it, and keep to the limits
  the CEO stated (for example "no server code", or "no emails").
- **Build the brief around the stakeholder's questions.** List the questions they asked, and add the ones their role
  will ask next. For each one, say where its answer will be: the screen, the report, the setting. Mark it **today**
  (works now), **tracking** (needs a code change), or **setup** (configuration, no code).
- **Open questions are decisions only the CEO can make:** privacy, scope, a value the code can't choose. Two or three
  is normal.
  - Don't ask about access, ownership or delivery the CEO hasn't raised.
  - Don't add systems they didn't ask for.
  - Everything else becomes a **stated default, with its reason**.
- **When the CEO rejects a draft,** take the correction as a standing rule for later briefs too, not only this one.

## Two agents for hard calls
For a design where being wrong is costly, such as anything that counts, tracks or decides privacy:
1. **Agent A drafts:** the questions, the design, the claims, each grounded in code (`file:line`).
2. **Agent B challenges A in the code:** a verdict on each claim (confirmed, wrong or unproven), what's missing, what's
   over-built, the smallest first stage, and a numbered "must change" list.
3. **Agent A answers each point:** accepted, accepted with a change, or disputed with evidence. Then it writes the
   final version.

Use the strongest model for both. Their disagreement is what reaches a solid result: the challenger usually finds the
count that would come out wrong.

## Report facts; label inferences
- **A fact you checked** carries its evidence: the commit, the count, the command.
- **An inference** says what it rests on. "These branches aren't merged into `dev`" is a fact. "These are the open
  merge requests" is an inference until you've seen the review list. When you can't see the list, say so, and work
  from what the CEO shows you.
- **Stand-up notes come from history,** not memory. Use the merges since yesterday (`git log --merges --first-parent
  --since=…`), the open work, and what the CEO says they did. Write them for the team, with no ledger jargon.
- **Name the audience** in one line when you hand over something meant for others ("Written for: the team at
  stand-up"), so the CEO can correct it.
