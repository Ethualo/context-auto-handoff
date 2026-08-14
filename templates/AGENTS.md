# Context Handoff — Session Instructions

Copy this file to your project root as `AGENTS.md` when using the `context-handoff` MCP server with Codex.

## Session Start

If `.handoff/handoff.md` exists in the project root, read it immediately before doing anything else. Restore all context: task description, current status, key decisions, failed approaches, blockers, and next steps. Begin from the first uncompleted next step.

If the file does not exist, proceed normally.

## Session End / Before Context Grows Large

Before ending the session or when the conversation is getting long, delegate to the `handoff-drafter` subagent (`.codex/agents/handoff-drafter.toml`) rather than drafting the fields or calling the tool yourself — it can run on a lighter model and keeps the drafted content out of this thread. Pass it the project's absolute root path so it can set `workingDirectory` correctly (it runs with its own cwd).

If the `handoff-drafter` subagent is unavailable, fall back to calling `generate_handoff_manifest` directly with these fields:

| Field | Required | Format |
|-------|----------|--------|
| `summary` | ✅ | Terse session recap. Telegraphese — no articles, no filler. |
| `nextSteps` | ✅ | Ordered array of next tasks |
| `taskDescription` | recommended | Goal + why it matters to the project |
| `currentStatus` | recommended | What is done vs what remains — state WHY, not just what |
| `keyDecisions` | recommended | `"Decision: X — Reason: Y"` |
| `failedApproaches` | recommended | `"Approach: X → Result: Y → Lesson: Z"` |
| `modifiedFiles` | recommended | `"path/to/file: what changed"` — NO code snippets |
| `implicitRules` | recommended | Tech stack, naming conventions, env vars |
| `blockers` | optional | Unresolved errors or open questions |
| `workingDirectory` | recommended | Absolute path to this project's root. Pass it explicitly — do not rely on the tool's cwd fallback. |

Output is saved to `.handoff/handoff.md` (latest) and `.handoff/handoffs/handoff-{timestamp}.md` (archive). If `implicitRules` or `keyDecisions` are given, the tool also upserts a `## Session Learnings` section into this file (`AGENTS.md`) — and into `CLAUDE.md` too, if that also exists in the project — so the distilled context loads automatically at the start of every session, not just via a handoff read.

## Rules

- **WHY over WHAT**: Every decision and status must state the reason, not just the action.
- **No code snippets** in any field — reference file paths and delta notes only.
- **failedApproaches is mandatory** when any approach was tried and failed — prevents the next session from repeating mistakes.
