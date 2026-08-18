---
description: Restore previous session context from handoff file. Use when user runs /handoff-resume or asks to continue from last session.
---

Reads `.handoff/handoff.md`. Falls back to the newest archive under `.handoff/handoffs/{YYYY-MM-DD}/`.

## Steps

1. Read `.handoff/handoff.md`
2. If missing, find the newest `handoff-*.md` under `.handoff/handoffs/**/` — archives live in a dated subdirectory (`.handoff/handoffs/2026-08-18/handoff-....md`), so search recursively, not just the top level. Filenames embed an ISO timestamp, so the last one in sort order is the newest.
3. If neither found: tell user "No handoff file. Run /handoff-save first."
4. If found:
   - Parse: Task Description, Current Status, Key Decisions, Failed Approaches, Blockers, Next Steps
   - Brief user in their language
   - Never retry Failed Approaches
   - Start from first Next Step immediately
