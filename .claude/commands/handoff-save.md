# /handoff-save — Save session handoff

Saves context to `.handoff/handoff.json` + `.handoff/handoff.md` and a timestamped archive pair to `.handoff/handoffs/`. Both formats come from one record inside the tool — no second draft, no extra call.

## Steps

1. Gather from current session:
   - taskDescription: final goal
   - summary: full session recap
   - currentStatus: done vs remaining
   - keyDecisions: architecture choices + why (prevents post-compaction amnesia)
   - failedApproaches: already-failed attempts (prevents repeat mistakes)
   - blockers: unresolved errors
   - userContribution: what the HUMAN did themselves (attribution — omit rather than guess)
   - userDecisions: calls the HUMAN made, as `{decision, reason, alternativesRejected}`

2. Call `generate_handoff_manifest`:
   - `summary`, `nextSteps` — required
   - `taskDescription`, `currentStatus`, `keyDecisions`, `failedApproaches` — recommended
   - `blockers`, `userContribution`, `userDecisions` — optional

3. Confirm to user:
   - Latest: `.handoff/handoff.md` (+ `.handoff/handoff.json`)
   - Archive: `.handoff/handoffs/{YYYY-MM-DD}/handoff-{timestamp}.md` (+ `.json`)
   - Any `Warning:` line the tool returned
   - Next session: run `/handoff-resume` or SessionStart hook auto-restores
