# context-auto-handoff

English | **[한국어](README.ko.md)**

Claude Code plugin that automatically saves session context and generates token-efficient handoff manifests before Claude compacts or stops.

![npm version](https://img.shields.io/npm/v/context-auto-handoff)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

---

## Requirements

- **Node.js 18+** — must be on `PATH` as `node`
- **Claude Code** or **Codex** — plugin and hooks require Claude Code CLI or Codex CLI

---

## Overview

Claude's context window eventually fills and compacts — losing design decisions, active blockers, and next steps mid-session. This plugin hooks into `PreCompact` and `Stop` events to trigger an AI-authored handoff document before that happens, so the next session picks up exactly where this one left off.

Handoff content is written in **telegraphese** (no articles, no filler, no code snippets) and structured to maximize token efficiency while preserving all decision context the next session needs.

Drafting (typically 3-6k tokens per save) is delegated to a Haiku subagent, which also calls `generate_handoff_manifest` itself — the draft never round-trips through the main-session model.

Key context (`implicitRules`, `keyDecisions`) is also kept in sync in `CLAUDE.md` and/or `AGENTS.md` (whichever already exist in the project) on every save, so it's always loaded — not just when you resume a handoff.

---

## Components

### Tools

- **`generate_handoff_manifest`** — Writes the handoff twice, from one record: `.handoff/handoff.json` (structured, for external tools) and `.handoff/handoff.md` (the human/resume briefing). Also archives both to `.handoff/handoffs/{YYYY-MM-DD}/handoff-{timestamp}.json` + `.md` (auto-pruned to the most recent 50 handoffs — a `.json`/`.md` pair counts as one) and upserts a one-line entry in `.handoff/handoffs/index.md` — a compact, grep-friendly index (date, keywords, headline, path) for searching past handoffs without opening every archive file. Repeat saves within the same session (e.g. both `PreCompact` and `Stop` firing in one long session) update that session's own archive file and index line in place instead of piling up near-duplicates — each MCP server process gets one session id, tagged in the `session:` frontmatter field.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `nextSteps` | `string[]` | ✅ | Ordered todo list for the next session |
| `summary` | `string` | ✗ | Terse session recap (telegraphese) — omit if other fields cover it |
| `taskDescription` | `string` | ✗ | High-level goal + core intent (why this matters) |
| `currentStatus` | `string` | ✗ | What is done vs what remains — state why, not just what |
| `keyDecisions` | `string[]` | ✗ | Architecture choices and reasons. Format: `"Decision: X — Reason: Y"` |
| `failedApproaches` | `string[]` | ✗ | Already-failed attempts. Format: `"Approach: X → Result: Y → Lesson: Z"` |
| `modifiedFiles` | `string[]` | ✗ | Changed files with delta notes. Format: `"path/to/file: what changed"` — no code |
| `implicitRules` | `string[]` | ✗ | Tech stack, naming conventions, env vars — anything not derivable from reading code |
| `blockers` | `string` | ✗ | Unresolved errors or open questions |
| `workingDirectory` | `string` | ✗ | Absolute path to the project root to write the handoff to — needed on Windows where `process.cwd()` may resolve to System32. Never stored in the JSON: it is an absolute path on the author's machine |

### Storage layout

```text
.handoff/
├── handoff.json                                  # latest, structured
├── handoff.md                                    # latest, human/resume briefing
└── handoffs/
    ├── index.md                                  # one row per handoff, not per file
    └── YYYY-MM-DD/
        ├── handoff-<timestamp>.json
        └── handoff-<timestamp>.md
```

The `.json` and `.md` sharing a basename are **one handoff**. Retention, pruning, the index, and search all count the pair once. Archives that only have one half — Markdown-only files written by older versions, or a JSON whose Markdown twin was deleted — are read and indexed normally; nothing is deleted or force-converted.

Both files are written to a temp path, verified (the JSON is re-parsed, the Markdown checked non-empty), then renamed into place, so a failed save cannot damage the previous handoff. If one format lands and the other does not, the tool returns a `Warning:` line saying so.

### JSON schema

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-26T09:23:00.000Z",
  "project": "my-project",
  "session": "a1b2c3d4",
  "headline": "dual-format handoff",
  "summary": "session recap or null",
  "taskDescription": "goal and intent or null",
  "currentStatus": "done vs remaining, or null",
  "keyDecisions": [],
  "failedApproaches": [],
  "blockers": null,
  "modifiedFiles": [],
  "implicitRules": [],
  "nextSteps": ["at least one"],
  "keywords": []
}
```

- Optional fields are normalized, never omitted: absent strings become `null`, absent lists become `[]`. A reader never has to tell "missing" from "empty".
- `nextSteps` always holds at least one entry.
- `schemaVersion` is an integer. It is bumped only when a reader must branch on the shape; new fields are added optionally, so a reader written for an older version keeps working.
- The JSON holds data only — no section titles, icons, or rendered Markdown strings — and never the absolute `workingDirectory`.

**Both formats are produced by local code from the same MCP input, in the same call.** The Markdown is rendered from the record by a pure function; no extra model call, prompt, or token is spent to add the JSON.

**Which half to read.** Anything that loads a handoff into a model's context — the hooks, `/handoff-resume`, `/handoff-search` — reads the **Markdown**, falling back to the JSON only if the Markdown half is missing. For the same content the Markdown is the cheaper read: it omits empty sections entirely where the JSON keeps every `null` and `[]` key, and its headings ("DO NOT RETRY") carry role cues that bare key names do not. Nothing on that path parses fields programmatically, so the JSON's structure buys it nothing.

**For external consumers (e.g. DevProof):** read the JSON — that is what it is for. Treat its contents as a narrative draft written by the session, not as verified fact — git commits and test results are outside this tool's responsibility and must be verified independently. The handoff deliberately carries no `commit`, `testResult`, or `evidence` fields.

### Skills

| Command | Behavior |
|---------|----------|
| `/handoff-save` | Delegate to a Haiku subagent that drafts session context and calls `generate_handoff_manifest` itself — keeps the 3-6k token draft off the (usually pricier) main-session model |
| `/handoff-resume` | Read `.handoff/handoff.md` (falling back to `.handoff/handoff.json`) and restore context in a new session |
| `/handoff-search` | Grep `.handoff/handoffs/index.md` for a topic and surface matching past sessions — no database, no embeddings |

### Hooks

Claude Code hooks are built-in. Codex hooks require copying `templates/.codex` to your project root (see [Codex installation](#codex)).

| Event | Behavior |
|-------|----------|
| `PreCompact` | Prompts the model to invoke the `handoff-save` skill (Haiku subagent) before context compression |
| `Stop` | Warns if handoff is stale or missing after each response |
| `SessionStart` | Surfaces a short hint (age, topics) if a handoff exists — full content loads via keyword match or `/handoff-resume` |
| `UserPromptSubmit` | If your prompt matches a keyword from the last handoff, injects the full handoff content as context automatically |

---

## Quick Start

**Linux / macOS**
```bash
curl -fsSL https://raw.githubusercontent.com/Ethualo/context-auto-handoff/main/scripts/setup.sh | bash
# Also set up Codex (hooks + handoff-drafter subagent + AGENTS.md):
curl -fsSL https://raw.githubusercontent.com/Ethualo/context-auto-handoff/main/scripts/setup.sh | bash -s -- --codex
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/Ethualo/context-auto-handoff/main/scripts/setup.ps1 -OutFile setup.ps1
.\setup.ps1          # Claude Code only
.\setup.ps1 -Codex   # also set up Codex (hooks + handoff-drafter subagent + AGENTS.md)
```

**npm (cross-platform)**
```bash
npm install -g context-auto-handoff
context-handoff-setup           # Claude Code only
context-handoff-setup --codex   # also set up Codex
```

---

## Installation

### As a Claude Code plugin

```bash
claude plugin install context-handoff
```

### As an npm package

```bash
npm install -g context-auto-handoff
context-handoff-setup  # hooks.json 자동 배치, --codex 붙이면 Codex도 함께 설정
```

### Manual MCP configuration (Claude Code)

Add to your Claude Code `settings.json`:

```json
{
  "mcpServers": {
    "context-handoff-manager": {
      "command": "node",
      "args": ["/path/to/build/index.js"]
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml` (global MCP config):

```toml
[mcp_servers.context-handoff]
command = "node"
args = ["/path/to/build/index.js"]
```

Then copy the hook templates and instructions to your project root:

```bash
cp -r /path/to/context-auto-handoff/templates/.codex ./.codex
cp /path/to/context-auto-handoff/templates/AGENTS.md ./AGENTS.md
```

This enables the same `SessionStart`, `PreCompact`, and `Stop` hooks as Claude Code, plus a `handoff-drafter` subagent (`.codex/agents/handoff-drafter.toml`) that drafts and saves the handoff so it doesn't run in your main thread.

---

## Usage

### Claude Code

All four hooks fire automatically — `SessionStart` surfaces a short hint if a handoff exists, `UserPromptSubmit` auto-loads full context when your prompt matches a saved keyword, `PreCompact` saves before compression, `Stop` warns if handoff is stale. Generated manifests are saved to `.handoff/handoff.json` and `.handoff/handoff.md`.

**Manual checkpoint:**
```
/handoff-save
```

**Manual resume (if keyword match didn't trigger):**
```
/handoff-resume
```

**Search past sessions:**
```
/handoff-search <topic>
```

### Codex

Same three hooks fire automatically via `.codex/hooks.json`. No slash commands — hooks handle everything.

| Event | Behavior |
|-------|----------|
| `SessionStart` | Reads `.handoff/handoff.md` and injects content as context — the compact briefing, never the raw JSON record |
| `PreCompact` | Prompts Codex to delegate to the `handoff-drafter` subagent before compression |
| `Stop` | Warns if handoff is stale (>5 min) or missing |

### Output format

```markdown
# Session Handoff Snapshot
> **Generated:** 6/22/2026, 3:30:00 PM

## 🎯 High-Level Objective
* **Goal:** Build Next.js 15 app syncing Supabase + Notion stock data in real-time
* **Core Intent:** Minimize client re-fetches via Zustand store — cost control

## 📌 Current State & Next Steps
* **Status:** Task 3 (Zustand store) complete
* **Blocker:** Notion API rate limit (3 req/s) — buffer layer needed
* **Next Action:** Implement Supabase Edge Functions debounce queue

## 🛠️ Modified Files Delta
* src/store/stockStore.ts: Zustand store skeleton + syncStatus state
* src/app/api/notion/sync/route.ts: POST handler written, Supabase not wired yet

## 🚫 Failed Approaches (DO NOT RETRY)
* Approach: Call Notion API directly from Server Actions → Result: Rate limit hit on re-render → Lesson: Queue middleware mandatory
* Approach: useEffect polling → Result: Supabase read usage spike → Lesson: Abandoned

## 🔑 Crucial Context & Implicit Rules
* Stack: Next.js 15 (App Router), Supabase v2, Zustand v5
* Naming: API endpoints always route.ts, PascalCase store names
* Env: NEXT_PUBLIC_SUPABASE_ANON_KEY active

---
*A short hint surfaces on session start; full context loads only if your next prompt matches a keyword above, or via manual `/handoff-resume`.*
```

---

## License

MIT
