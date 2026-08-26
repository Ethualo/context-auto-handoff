---
description: Restore previous session context from handoff file. Use when user runs /handoff-resume or asks to continue from last session.
---

Every handoff is saved twice from one record: `.handoff/handoff.md` (the human/resume briefing) and `.handoff/handoff.json` (structured, for external tools like DevProof). **Resume reads the Markdown.** Reading it into context costs fewer tokens for the same content — the Markdown omits empty sections entirely, while the JSON keeps every `null` and `[]` key, and its section headings carry role cues (e.g. "DO NOT RETRY") the JSON key names do not. The JSON is the fallback, not the default: nothing here parses fields programmatically, so its structure buys nothing.

## Read priority

1. `.handoff/handoff.md`
2. `.handoff/handoff.json`
3. newest `.md` archive under `.handoff/handoffs/{YYYY-MM-DD}/`
4. newest `.json` archive under the same
5. legacy `.claude/handoff.md`

## Steps

1. Read `.handoff/handoff.md` and parse its sections — Objective, Status, Blockers, Next Steps, Failed Approaches, Key Decisions.
2. If it is missing or unreadable, fall back to the JSON half of the same basename (`.handoff/handoff.json`) and use its fields — `taskDescription`, `currentStatus`, `keyDecisions`, `failedApproaches`, `blockers`, `nextSteps`. A missing Markdown file is not a reason to stop; its JSON twin holds the same content.
3. If neither latest file exists, find the newest archive under `.handoff/handoffs/**/` — archives live in a dated subdirectory (`.handoff/handoffs/2026-08-18/handoff-....md` / `.json`), so search recursively, not just the top level. Filenames embed an ISO timestamp, so the last one in sort order is the newest. The `.md` and `.json` sharing a basename are ONE handoff, not two candidates: prefer the `.md`, fall back to its `.json`.
4. If nothing is found: tell user "No handoff file. Run /handoff-save first."
5. If found:
   - Brief the user in their language with the same compact briefing as before — Objective, Status, Blockers, Next Steps. If you had to fall back to the JSON, brief from its fields; never paste the raw JSON record into the conversation, since repeating it spends the context the handoff was meant to save.
   - If the filename timestamp and the record's `generatedAt` disagree, mention it once as a warning and keep reading.
   - Never retry anything listed in `failedApproaches`.
   - Start from the first entry of `nextSteps` immediately.
