---
description: Search past session handoffs by topic or keyword. Use when user asks "did we handle X before", runs /handoff-search <query>, or wants to find a prior session about a topic.
---

Searches `.handoff/handoffs/` archive. No database, no embeddings — grep over a compact index file, then read only the matched archive(s).

## Steps

1. Read `.handoff/handoffs/index.md` if it exists. Each line: `{isoDate} | {keywords} | {headline} | {relativePath}`. One line per handoff — a handoff is a `.json`/`.md` pair sharing a basename, and the index already collapses the pair into a single row, so never count or show it twice.
   - If missing: no indexed archives yet. Fall back to grepping `"keywords"` across `.handoff/handoffs/**/*.json` and `keywords:` / `date:` frontmatter lines across `.handoff/handoffs/**/*.md` directly, deduplicating by basename, then skip to step 4.
2. Match the user's query against index lines, case-insensitive, over the keywords and headline columns only (not the whole file). Rank:
   - Exact keyword match first
   - Headline substring match second
3. If nothing matches, tell user no matching handoff found — do not guess.
4. Show top 3-5 candidates as `date — headline (path)`, most recent first.
5. If user wants detail on one: read only that handoff, and prefer its `.md` half — it costs fewer tokens to read than the JSON for the same content, since it omits empty sections. Summarize its Objective/Status/Next Steps sections. If the Markdown is missing (a JSON-only archive), swap the extension in `{relativePath}` for `.json` and summarize `taskDescription` / `currentStatus` / `nextSteps` instead. A broken or missing half is not a reason to abandon the search — fall back and keep going. Do not load other candidates, and do not paste the raw JSON into the conversation.
6. Never read every file in `.handoff/handoffs/` to answer a search — the index exists specifically to avoid that.
