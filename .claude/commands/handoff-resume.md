# /handoff-resume — Restore previous session

Reads `.handoff/handoff.md`, falling back to `.handoff/handoff.json`, then to the newest archive under `.handoff/handoffs/{YYYY-MM-DD}/`.

## Steps

1. Read `.handoff/handoff.md` — cheaper to read than the JSON for the same content, and its headings carry role cues
2. If it is missing or unreadable, read `.handoff/handoff.json` instead and use its fields
3. If neither latest file exists, find the newest `handoff-*` under `.handoff/handoffs/**/` — archives live in a dated subdirectory (`.handoff/handoffs/2026-08-18/handoff-....md` / `.json`), so search recursively, not just the top level. Filenames embed an ISO timestamp, so the last one in sort order is the newest. The `.md` and `.json` sharing a basename are one handoff: prefer the `.md`, fall back to its `.json`.
4. If nothing found: tell user "No handoff file. Run /handoff-save first."
5. If found:
   - Parse: Task Description, Current Status, Key Decisions, Failed Approaches, Blockers, Next Steps
   - Never paste the raw JSON record into the conversation
   - Brief user in their language
   - Never retry Failed Approaches
   - Start from first Next Step immediately
