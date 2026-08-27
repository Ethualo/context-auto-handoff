---
description: Save current session context to handoff file. Use when user runs /handoff-save or asks to save session state before ending.
---

Save session context to `.handoff/handoff.json` + `.handoff/handoff.md` and a timestamped archive pair to `.handoff/handoffs/`. Both formats are produced locally from one record inside `generate_handoff_manifest` — never draft the JSON separately, never call the tool twice, and never ask a model to convert one format into the other. If `implicitRules` or `keyDecisions` are provided, `generate_handoff_manifest` also upserts a `## Session Learnings (auto-updated by handoff)` section into whichever of `CLAUDE.md` / `AGENTS.md` already exist in the project root (both, if both exist; creates `CLAUDE.md` if neither does), replacing the prior auto-managed block (marked by `<!-- handoff:learnings:begin/end -->`) rather than appending — so the memory doc always reflects the latest distilled context instead of growing unbounded.

## Content Generation Rules (STRICT)

Write all field values using telegraphese — drop articles, pronouns, polite words. Maximize density.

- **NO code snippets** in any field. Reference file paths + line-level delta notes only.
- **WHY over WHAT**: Every decision/status must state the reason, not just the action.
- **failedApproaches**: Format each entry as `"Approach: X → Result: Y → Lesson: Z"`. This prevents the next session from repeating mistakes.
- **taskDescription**: Include both Goal and Core Intent (why this matters to the project).
- **implicitRules**: Capture tech stack, naming conventions, env vars — anything not derivable from reading the code.
- **userContribution / userDecisions**: Attribution, not summary. Record only what the human did or decided, and only where you can point at it in the conversation — an assumed contribution is worse than an absent one, because a downstream reader treats these as evidence. Omit either field entirely when the session has nothing to attribute. Never restate your own work here; `keyDecisions` already covers decisions regardless of who made them.

## Steps

1. Determine the project root as an absolute path (the directory that should contain `.handoff`). Needed by both branches below.

2. Choose a branch. **Direct generation is the default** — a subagent starts cold and cannot see this conversation, so the main session has to write the context out for it anyway, which is most of the drafting cost. Delegate only when at least one of these holds:
   - A **cheaper model tier** is actually reachable through the delegation tool (e.g. `model: "haiku"`), so the 3-6k token draft runs on a smaller model than this session.
   - This session's **context is nearly exhausted** and keeping the draft out of it matters more than the forwarding cost.

   Generate directly — do not delegate — when any of these holds:
   - The harness forbids calling the delegation tool unless the user asked for it.
   - The delegation tool exposes no model choice, or its only tier is the model this session already runs on — same model, no quality or cost gain, just a round trip and lost context.
   - The delegation tool or `generate_handoff_manifest` is unavailable to subagents.

3. **Direct branch:** draft the fields below per the Content Generation Rules and call `generate_handoff_manifest` yourself. `workingDirectory` may be omitted here (the session cwd is already the project root), but passing the absolute path from step 1 is never wrong.

   **Delegate branch:** hand the entire save to a subagent (`subagent_type: "general-purpose"`, `run_in_background: false`) via whatever delegation tool this platform exposes (`Agent`/`Task`/equivalent), with the cheapest model tier it offers. If the tier name/id is unknown for this platform, omit it and let the tool default rather than guess an id and risk an invalid-model error; if the call errors on `model`, retry once without it. Do NOT ask it to return the drafted content to the main session; round-tripping a 3-6k token draft through the (usually pricier) main-session model wastes those tokens twice. Instruct the agent to do everything itself:
   - Read the conversation context it's given and draft the fields below per the Content Generation Rules above.
   - Call `generate_handoff_manifest` itself with the drafted fields, ALWAYS including `workingDirectory` set to the absolute project root path from step 1. The subagent runs with a different cwd (its own scratchpad), so omitting `workingDirectory` writes the handoff to the wrong location — pass it explicitly every time, never rely on the tool's default.
   - Report back only a short confirmation: the saved paths reported by the tool (latest + archive, each a `.json`/`.md` pair) and any warning lines — not the field content.

   If the delegate branch fails for any reason, fall back to the direct branch rather than retrying delegation.

   Tool call fields:
     - `summary`, `nextSteps` — required
     - `taskDescription`, `currentStatus`, `keyDecisions`, `failedApproaches`, `modifiedFiles`, `implicitRules` — recommended
     - `blockers`, `userContribution`, `userDecisions` — optional

   Fields to draft:
   - taskDescription: final goal + core intent (why)
   - summary: terse session recap (telegraphese)
   - currentStatus: done vs remaining
   - keyDecisions: architecture choices + why (prevents post-compaction amnesia)
   - failedApproaches: already-failed attempts in `Approach→Result→Lesson` format
   - blockers: unresolved errors
   - modifiedFiles: changed files with delta notes (no code, path + what changed)
   - implicitRules: stack, conventions, env vars
   - userContribution: what the HUMAN did themselves — specified, corrected, reviewed, rejected, tested, hand-wrote
   - userDecisions: calls the HUMAN made, as `{decision, reason, alternativesRejected}` — not ones you proposed and they merely let through

4. Confirm to user (from the agent's short report, or from the tool result in the direct branch):
   - Latest: `.handoff/handoff.md` (+ `.handoff/handoff.json`)
   - Archive: `.handoff/handoffs/{YYYY-MM-DD}/handoff-{timestamp}.md` (+ `.json`)
   - Memory doc(s): updated path(s), if the tool reported any
   - Any `Warning:` line the tool returned — in particular one saying the two formats fell out of sync
   - Next session: run `/handoff-resume` or SessionStart hook auto-restores
