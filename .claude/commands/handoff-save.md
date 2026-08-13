# /handoff-save — Save session handoff

Saves context to `.handoff/handoff.md` and timestamped archive to `.handoff/handoffs/`.

## Steps

1. Gather from current session:
   - taskDescription: final goal
   - summary: full session recap
   - currentStatus: done vs remaining
   - keyDecisions: architecture choices + why (prevents post-compaction amnesia)
   - failedApproaches: already-failed attempts (prevents repeat mistakes)
   - blockers: unresolved errors

2. Call `generate_handoff_manifest`:
   - `summary`, `nextSteps` — required
   - `taskDescription`, `currentStatus`, `keyDecisions`, `failedApproaches` — recommended
   - `blockers` — optional

3. Confirm to user:
   - Latest: `.handoff/handoff.md`
   - Archive: `.handoff/handoffs/handoff-{timestamp}.md`
   - Next session: run `/handoff-resume` or SessionStart hook auto-restores
