---
description: Save current session context to handoff file. Use when user runs /handoff-save or asks to save session state before ending.
---

Save session context to `.claude/handoff.md` and timestamped archive to `.claude/handoffs/`. If `implicitRules` or `keyDecisions` are provided, `generate_handoff_manifest` also upserts a `## Session Learnings (auto-updated by handoff)` section into the project's `CLAUDE.md` (creating it if missing), replacing the prior auto-managed block (marked by `<!-- handoff:learnings:begin/end -->`) rather than appending — so CLAUDE.md always reflects the latest distilled context instead of growing unbounded.

## Content Generation Rules (STRICT)

Write all field values using telegraphese — drop articles, pronouns, polite words. Maximize density.

- **NO code snippets** in any field. Reference file paths + line-level delta notes only.
- **WHY over WHAT**: Every decision/status must state the reason, not just the action.
- **failedApproaches**: Format each entry as `"Approach: X → Result: Y → Lesson: Z"`. This prevents the next session from repeating mistakes.
- **taskDescription**: Include both Goal and Core Intent (why this matters to the project).
- **implicitRules**: Capture tech stack, naming conventions, env vars — anything not derivable from reading the code.

## Steps

1. Determine the project root as an absolute path (the directory containing `.claude`) BEFORE spawning the agent. Delegate entire save to subagent (`subagent_type: "general-purpose"`, `run_in_background: false`) via whatever delegation tool this platform exposes (`Agent`/`Task`/equivalent). This is a cheap drafting task — route it to the smallest/cheapest model tier the platform's delegation tool exposes (e.g. `model: "haiku"` on Claude Code), not the main session's model. If the delegation tool has no `model` param, or the tier name/id is unknown for this platform, omit it and let the tool default rather than guess an id and risk an invalid-model error; if the call errors on `model`, retry once without it. Do NOT ask it to return the drafted content to the main session; the draft can be 3k-6k tokens and round-tripping it through the (usually pricier) main-session model wastes those tokens twice. Instead, instruct the agent to do everything itself:
   - Read the conversation context it's given and draft the fields below per the Content Generation Rules above.
   - Call `generate_handoff_manifest` itself with the drafted fields, ALWAYS including `workingDirectory` set to the absolute project root path determined above. The subagent runs with a different cwd (its own scratchpad), so omitting `workingDirectory` writes the handoff to the wrong location — pass it explicitly every time, never rely on the tool's default.
     - `summary`, `nextSteps` — required
     - `taskDescription`, `currentStatus`, `keyDecisions`, `failedApproaches`, `modifiedFiles`, `implicitRules` — recommended
     - `blockers` — optional
   - Report back only a short confirmation: saved paths (`.claude/handoff.md` and the archive path) — not the field content.

   Fields to draft:
   - taskDescription: final goal + core intent (why)
   - summary: terse session recap (telegraphese)
   - currentStatus: done vs remaining
   - keyDecisions: architecture choices + why (prevents post-compaction amnesia)
   - failedApproaches: already-failed attempts in `Approach→Result→Lesson` format
   - blockers: unresolved errors
   - modifiedFiles: changed files with delta notes (no code, path + what changed)
   - implicitRules: stack, conventions, env vars

   If Agent/subagents or the `generate_handoff_manifest` tool are unavailable to the subagent, fall back to drafting and calling the tool directly in the current session.

2. Confirm to user using the agent's short report:
   - Latest: `.claude/handoff.md`
   - Archive: `.claude/handoffs/handoff-{timestamp}.md`
   - CLAUDE.md: updated path, if the tool reported one
   - Next session: run `/handoff-resume` or SessionStart hook auto-restores
