#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';

const server = new McpServer({
  name: 'context-handoff-manager',
  version: '1.4.0'
});

const ARCHIVE_KEEP = 50;
const INDEX_FILE = 'index.md';

// Bump only when the JSON shape changes in a way a reader must branch on. Readers of an
// older version must stay able to read a newer file, so new fields are additive-optional.
const SCHEMA_VERSION = 1;

// keyDecisions records what was decided; this records who decided it. An external
// reader (DevProof) cannot attribute a decision to the human from keyDecisions alone,
// so the human's own calls are kept in a separate, structured field rather than mixed in.
type UserDecision = {
  decision: string;
  reason: string | null;
  alternativesRejected: string | null;
};

// The single source of truth for a save. Both output formats are derived from one of
// these — Markdown is rendered from it, JSON is a straight serialization of it — so the
// two can never drift, and neither costs an extra model call to produce.
type HandoffRecord = {
  schemaVersion: number;
  generatedAt: string;
  project: string;
  session: string;
  headline: string;
  summary: string | null;
  taskDescription: string | null;
  currentStatus: string | null;
  keyDecisions: string[];
  userContribution: string | null;
  userDecisions: UserDecision[];
  failedApproaches: string[];
  blockers: string | null;
  modifiedFiles: string[];
  implicitRules: string[];
  nextSteps: string[];
  keywords: string[];
};

// One MCP server process = one Claude Code session (stdio transport is 1:1 per session).
// Reusing this id lets repeated saves within the same session update the same archive
// file instead of piling up near-duplicate entries every time PreCompact/Stop fires.
const sessionId = randomUUID().slice(0, 8);
// Keyed by project root: a single server process can be asked to save into more than
// one root, and reusing another root's archive path would scatter files across projects.
// Stored without an extension — one archive is the .json/.md pair sharing this basename.
let lastArchive: { root: string; base: string } | null = null;


server.tool(
  'generate_handoff_manifest',
  'Save this session\'s working context to .handoff/handoff.json + .handoff/handoff.md plus a timestamped archive pair, so the next session can resume without re-deriving decisions, blockers, and next steps.',
  {
    summary: z.string().optional().describe('Detailed session recap in English — omit if other fields cover it'),
    nextSteps: z.array(z.string()).min(1).describe('Tasks to continue immediately in the next session. Write in English.'),
    taskDescription: z.string().optional().describe('High-level goal + core intent (why this matters). Use telegraphese — drop articles/pronouns. Write in English.'),
    currentStatus: z.string().optional().describe('What is done vs what remains. State why, not just what. Write in English.'),
    keyDecisions: z.array(z.string()).optional().describe('Architecture choices and why — prevents post-compaction amnesia. Format: "Decision: X — Reason: Y". Write in English.'),
    userContribution: z.string().optional().describe('What the HUMAN did in this session, in their own right: what they specified, corrected, reviewed, rejected, tested, or built by hand. Attribution field — never credit your own work here, and omit it entirely rather than guessing. Write in English.'),
    userDecisions: z.array(z.object({
      decision: z.string().describe('The direction the human chose.'),
      reason: z.string().optional().describe('Why they chose it, in their own reasoning.'),
      alternativesRejected: z.string().optional().describe('The options they turned down.')
    })).optional().describe('Calls the HUMAN made, not ones you proposed and they merely accepted without comment. Subset of keyDecisions with attribution attached. Omit any entry you cannot point to in the conversation. Write in English.'),
    failedApproaches: z.array(z.string()).optional().describe('Already-failed attempts. Format each: "Approach: X → Result: Y → Lesson: Z". Prevents repeating mistakes. Write in English.'),
    blockers: z.string().optional().describe('Unresolved errors or blockers. Write in English.'),
    modifiedFiles: z.array(z.string()).optional().describe('Changed files with delta notes. Format: "path/to/file: what changed" — NO code snippets, path+delta only.'),
    implicitRules: z.array(z.string()).optional().describe('Tech stack, naming conventions, env vars, implicit project rules — anything not derivable from reading code. Write in English.'),
    keywords: z.array(z.string()).max(8).optional().describe('Short topic/feature tags (e.g. file names, feature names) used to match a future session prompt for auto-resume. Write in English, lowercase, 1-3 words each.'),
    workingDirectory: z.string().optional().describe('Absolute path to the project root where the handoff should be written. Required on Windows where process.cwd() may return System32.')
  },
  async (input) => {
    try {
      const { projectRoot, warnings } = resolveProjectRoot(input.workingDirectory);
      const handoffDir = path.join(projectRoot, '.handoff');
      const handoffsDir = path.join(handoffDir, 'handoffs');

      fs.mkdirSync(handoffsDir, { recursive: true });
      warnings.push(...absorbLegacyHandoffs(projectRoot, handoffsDir));

      const now = new Date();
      const record = buildRecord(input, path.basename(projectRoot), sessionId, now);

      // Both payloads are produced before anything on disk is touched, so a serialization
      // or rendering failure leaves the previous latest handoff intact.
      const json = serializeRecord(record);
      const markdown = renderMarkdown(record);

      const mainBase = path.join(handoffDir, 'handoff');
      warnings.push(...writePair(mainBase, json, markdown));

      // Reuse this session's own archive pair across repeat saves (PreCompact/Stop can
      // both fire in one long session) instead of piling up near-duplicate archives.
      const archiveBase = lastArchive && lastArchive.root === projectRoot && pairExists(lastArchive.base)
        ? lastArchive.base
        : newArchiveBase(handoffsDir, now);
      fs.mkdirSync(path.dirname(archiveBase), { recursive: true });
      warnings.push(...writePair(archiveBase, json, markdown));
      lastArchive = { root: projectRoot, base: archiveBase };

      pruneArchives(handoffsDir, ARCHIVE_KEEP);
      // Rebuilt from the surviving files, so pruned archives can never leave dangling index rows.
      rebuildIndex(handoffsDir);

      // A memory-doc failure must not report the already-written handoff as a failed save.
      let memoryDocLines = '';
      try {
        memoryDocLines = upsertMemoryDocSection(projectRoot, record.implicitRules, record.keyDecisions)
          .map(p => `\n${path.basename(p)} updated: ${p}`)
          .join('');
      } catch (error: any) {
        warnings.push(`Handoff saved, but the memory doc could not be updated: ${error.message}`);
      }

      const warningLines = warnings.map(w => `\nWarning: ${w}`).join('');

      return {
        content: [{
          type: 'text',
          text: `Handoff saved.\nLatest: ${mainBase}.md (+ ${mainBase}.json)\nArchive: ${archiveBase}.md (+ ${archiveBase}.json)${memoryDocLines}${warningLines}`
        }]
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Save error: ${error.message}` }]
      };
    }
  }
);

type ToolInput = {
  summary?: string;
  nextSteps: string[];
  taskDescription?: string;
  currentStatus?: string;
  keyDecisions?: string[];
  userContribution?: string;
  userDecisions?: { decision: string; reason?: string; alternativesRejected?: string }[];
  failedApproaches?: string[];
  blockers?: string;
  modifiedFiles?: string[];
  implicitRules?: string[];
  keywords?: string[];
  workingDirectory?: string;
};

// Optional fields are normalized to null / [] rather than dropped: an external reader
// should never have to distinguish "absent" from "empty", and a missing key is the most
// common cause of a downstream crash.
function buildRecord(input: ToolInput, project: string, session: string, now: Date): HandoffRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    project,
    session,
    headline: oneLine(input.taskDescription || input.summary || input.nextSteps[0] || '(no summary)'),
    summary: orNull(input.summary),
    taskDescription: orNull(input.taskDescription),
    currentStatus: orNull(input.currentStatus),
    keyDecisions: orList(input.keyDecisions),
    userContribution: orNull(input.userContribution),
    userDecisions: orDecisionList(input.userDecisions),
    failedApproaches: orList(input.failedApproaches),
    blockers: orNull(input.blockers),
    modifiedFiles: orList(input.modifiedFiles),
    implicitRules: orList(input.implicitRules),
    nextSteps: input.nextSteps,
    keywords: sanitizeKeywords(input.keywords)
    // workingDirectory is deliberately absent: it is an absolute path on the author's
    // machine, and the JSON is the format meant to be read by other tools.
  };
}

function orNull(value?: string): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function orList(value?: string[]): string[] {
  return (value ?? []).filter(item => typeof item === 'string' && item.trim() !== '');
}

// An entry with no decision is not an attribution, so it is dropped rather than stored
// as an empty shell that a reader would have to defend against.
function orDecisionList(value?: ToolInput['userDecisions']): UserDecision[] {
  return (value ?? [])
    .filter(item => item && typeof item.decision === 'string' && item.decision.trim() !== '')
    .map(item => ({
      decision: item.decision.trim(),
      reason: orNull(item.reason),
      alternativesRejected: orNull(item.alternativesRejected)
    }));
}

function serializeRecord(record: HandoffRecord): string {
  return JSON.stringify(record, null, 2) + '\n';
}

function pairExists(base: string): boolean {
  return fs.existsSync(`${base}.json`) || fs.existsSync(`${base}.md`);
}

// Written to temp files and verified before either final path is replaced, so a failed
// render, a full disk, or a malformed serialization can never leave a half-written
// handoff where a readable one used to be. Returns warnings; throws only if the JSON
// (the machine-readable half) could not be committed at all.
function writePair(base: string, json: string, markdown: string): string[] {
  const jsonPath = `${base}.json`;
  const mdPath = `${base}.md`;
  const jsonTmp = `${jsonPath}.tmp`;
  const mdTmp = `${mdPath}.tmp`;
  const warnings: string[] = [];

  try {
    fs.writeFileSync(jsonTmp, json, 'utf-8');
    fs.writeFileSync(mdTmp, markdown, 'utf-8');

    // Read back and re-parse rather than trusting the string we just built: this is what
    // catches a truncated write, and it is the exact operation every JSON consumer runs.
    const parsed = JSON.parse(fs.readFileSync(jsonTmp, 'utf-8'));
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.nextSteps) || parsed.nextSteps.length === 0) {
      throw new Error('serialized handoff failed its own validation');
    }
    if (fs.readFileSync(mdTmp, 'utf-8').trim() === '') {
      throw new Error('rendered markdown was empty');
    }

    // rename over an existing file replaces it on Windows too (MOVEFILE_REPLACE_EXISTING).
    fs.renameSync(jsonTmp, jsonPath);
    try {
      fs.renameSync(mdTmp, mdPath);
    } catch (error: any) {
      warnings.push(`${path.basename(jsonPath)} was updated but ${path.basename(mdPath)} could not be replaced (${error.message}) — the two formats are out of sync for this handoff.`);
    }
  } finally {
    for (const tmp of [jsonTmp, mdTmp]) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  return warnings;
}

// A wrong root is the worst failure mode here: mkdir -p happily invents a whole tree,
// the save reports success, and the session hooks — which read CLAUDE_PROJECT_DIR —
// never see the file again. So validate loudly instead of writing somewhere plausible.
function resolveProjectRoot(workingDirectory?: string): { projectRoot: string; warnings: string[] } {
  const envRoot = process.env['CLAUDE_PROJECT_DIR'];
  const projectRoot = workingDirectory || envRoot || process.cwd();
  const warnings: string[] = [];

  if (!path.isAbsolute(projectRoot)) {
    throw new Error(`workingDirectory must be an absolute path (got "${projectRoot}"). A relative path resolves against this server's own cwd, not the project.`);
  }
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}. Pass workingDirectory as the project's absolute root path.`);
  }
  if (workingDirectory && envRoot && path.resolve(workingDirectory) !== path.resolve(envRoot)) {
    warnings.push(`workingDirectory (${workingDirectory}) differs from CLAUDE_PROJECT_DIR (${envRoot}). The session hooks read CLAUDE_PROJECT_DIR, so this handoff will not be restored automatically.`);
  }

  return { projectRoot, warnings };
}

// Storage moved from .claude/ to the neutral .handoff/ dir. This runs on every save
// rather than only when .handoff/ is absent, because an outdated plugin build (or a
// stale globally installed copy of the server) can keep writing to .claude/ long after
// the migration "already happened" — those files would otherwise be orphaned forever.
function absorbLegacyHandoffs(projectRoot: string, handoffsDir: string): string[] {
  const legacyDir = path.join(projectRoot, '.claude');
  const legacyMain = path.join(legacyDir, 'handoff.md');
  const legacyArchives = path.join(legacyDir, 'handoffs');

  let moved = 0;
  if (fs.existsSync(legacyArchives)) {
    moved += moveTree(legacyArchives, handoffsDir);
  }
  if (fs.existsSync(legacyMain)) {
    // handoff.md is rewritten on every save, so the legacy copy is kept as an archive
    // entry — clobbering the current one would lose whichever is newer.
    const stamp = new Date(fs.statSync(legacyMain).mtimeMs).toISOString();
    const target = path.join(handoffsDir, stamp.slice(0, 10), `handoff-${stamp.replace(/[:.]/g, '-')}.md`);
    if (fs.existsSync(target)) {
      fs.unlinkSync(legacyMain);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacyMain, target);
      moved++;
    }
  }

  return moved > 0
    ? [`Absorbed ${moved} handoff file(s) left in legacy .claude/ storage — an outdated build of this server may still be running.`]
    : [];
}

function moveTree(from: string, to: string): number {
  let moved = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      moved += moveTree(src, dst);
    } else if (fs.existsSync(dst)) {
      fs.unlinkSync(src);
    } else {
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(src, dst);
      moved++;
    }
  }
  fs.rmSync(from, { recursive: true, force: true });
  return moved;
}

function newArchiveBase(handoffsDir: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(handoffsDir, now.toISOString().slice(0, 10), `handoff-${timestamp}`);
}

// One handoff is one basename, not one file: the .json/.md pair must count, prune, and
// index as a single entry, and a legacy archive that only has one of the two still counts.
function listArchiveBases(dir: string): string[] {
  const bases = new Set<string>();
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if ((entry.name.endsWith('.md') || entry.name.endsWith('.json')) && entry.name !== INDEX_FILE) {
        bases.add(full.slice(0, full.length - path.extname(full).length));
      }
    }
  };
  walk(dir);
  return [...bases];
}

function pruneArchives(handoffsDir: string, keep: number): void {
  const bases = listArchiveBases(handoffsDir);
  // Archive names embed an ISO timestamp, so a name sort is a chronological sort.
  bases.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const excess = bases.length - keep;
  if (excess > 0) {
    for (const base of bases.slice(0, excess)) {
      for (const file of [`${base}.json`, `${base}.md`]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }
  }

  for (const entry of fs.readdirSync(handoffsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(handoffsDir, entry.name);
    if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
  }
}

// Regenerated from the archive files themselves rather than appended to, so the index
// can never drift out of sync with what is actually on disk (pruned, migrated, or
// hand-deleted files all correct themselves on the next save). One row per basename —
// the JSON and Markdown halves of one handoff must never appear as two search hits.
function rebuildIndex(handoffsDir: string): void {
  const rows = listArchiveBases(handoffsDir).map(base => {
    const meta = readArchiveMeta(base);
    // The Markdown half is what a resume actually reads, so it is the path published to
    // readers; a JSON-only archive publishes its .json instead.
    const target = fs.existsSync(`${base}.md`) ? `${base}.md` : `${base}.json`;
    const relativePath = path.relative(handoffsDir, target).replace(/\\/g, '/');
    return `${meta.date} | ${meta.keywords} | ${meta.headline} | ${relativePath}`;
  });

  rows.sort();
  fs.writeFileSync(path.join(handoffsDir, INDEX_FILE), rows.length ? rows.join('\n') + '\n' : '', 'utf-8');
}

// JSON first here, unlike the resume/search read path, which prefers the Markdown: this
// reader is code, so parsing a real record beats scraping frontmatter, and no tokens are
// at stake. Markdown frontmatter is the fallback — a malformed JSON half must not cost the
// whole archive its index row, and archives written before the JSON half existed have none.
function readArchiveMeta(base: string): { date: string; keywords: string; headline: string } {
  const jsonPath = `${base}.json`;
  if (fs.existsSync(jsonPath)) {
    try {
      const record = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if (record && typeof record.generatedAt === 'string') {
        return {
          date: record.generatedAt,
          keywords: Array.isArray(record.keywords) && record.keywords.length > 0 ? record.keywords.join(', ') : '(none)',
          headline: oneLine(String(record.headline || '(no summary)'))
        };
      }
    } catch {
      // Fall through to the Markdown half of the same pair.
    }
  }

  const mdPath = `${base}.md`;
  if (fs.existsSync(mdPath)) {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const fields = readFrontmatter(raw);
    return {
      date: fields['date'] || new Date(fs.statSync(mdPath).mtimeMs).toISOString(),
      keywords: fields['keywords'] || '(none)',
      headline: fields['headline'] || deriveHeadline(raw)
    };
  }

  return {
    date: new Date(fs.statSync(jsonPath).mtimeMs).toISOString(),
    keywords: '(none)',
    headline: '(unreadable handoff)'
  };
}

function readFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

// Fallback for archives written before `headline` was part of the frontmatter.
function deriveHeadline(raw: string): string {
  const goal = raw.match(/\*\*Goal:\*\*\s*(.+)/);
  if (goal) return oneLine(goal[1]);
  const firstBullet = raw.match(/^[-*]\s+(.+)$/m);
  return firstBullet ? oneLine(firstBullet[1]) : '(no summary)';
}

function oneLine(text: string): string {
  return text.replace(/\|/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// The frontmatter is a flat `key: value` list split on commas by the hooks, so a comma
// or newline inside a keyword would silently invent or truncate keywords.
function sanitizeKeywords(keywords?: string[]): string[] {
  return (keywords ?? [])
    .map(k => k.replace(/[,\r\n]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Pure function of the record — no model call, no second draft, no reading the JSON back.
// Section titles and icons live here and only here: they are presentation, and putting
// them in the record would make the JSON a rendering artifact instead of data.
function renderMarkdown(record: HandoffRecord): string {
  const frontmatter = [
    `---`,
    `date: ${record.generatedAt}`,
    `project: ${record.project}`,
    `session: ${record.session}`,
    `schema_version: ${record.schemaVersion}`,
    `next_steps_count: ${record.nextSteps.length}`,
    `has_blockers: ${Boolean(record.blockers)}`,
    `keywords: ${record.keywords.join(', ')}`,
    `headline: ${record.headline}`,
    `---`,
    ``
  ].join('\n');

  const sections: string[] = [
    frontmatter,
    `# Session Handoff Snapshot`,
    `> **Generated:** ${new Date(record.generatedAt).toLocaleString()}`,
    ``
  ];

  if (record.taskDescription) {
    sections.push(`## 🎯 High-Level Objective\n* **Goal:** ${record.taskDescription}\n`);
  }

  const stateLines: string[] = [];
  if (record.currentStatus) stateLines.push(`* **Status:** ${record.currentStatus}`);
  if (record.blockers) stateLines.push(`* **Blocker:** ${record.blockers}`);
  stateLines.push(`* **Next Action:** ${record.nextSteps[0]}`);
  sections.push(`## 📌 Current State & Next Steps\n${stateLines.join('\n')}\n`);
  if (record.nextSteps.length > 1) {
    sections.push(`### Remaining Queue\n${record.nextSteps.slice(1).map(s => `- [ ] ${s}`).join('\n')}\n`);
  }

  if (record.modifiedFiles.length > 0) {
    sections.push(`## 🛠️ Modified Files Delta\n${record.modifiedFiles.map(f => `* ${f}`).join('\n')}\n`);
  }

  if (record.failedApproaches.length > 0) {
    sections.push(`## 🚫 Failed Approaches (DO NOT RETRY)\n${record.failedApproaches.map(f => `* ${f}`).join('\n')}\n`);
  }

  if (record.implicitRules.length > 0) {
    sections.push(`## 🔑 Crucial Context & Implicit Rules\n${record.implicitRules.map(r => `* ${r}`).join('\n')}\n`);
  }

  if (record.keyDecisions.length > 0) {
    sections.push(`## Key Decisions\n${record.keyDecisions.map(d => `- ${d}`).join('\n')}\n`);
  }

  if (record.userContribution) {
    sections.push(`## 🙋 User Contribution (human-authored)\n${record.userContribution}\n`);
  }

  if (record.userDecisions.length > 0) {
    const lines = record.userDecisions.map(d => {
      const detail = [
        d.reason ? `  - Reason: ${d.reason}` : '',
        d.alternativesRejected ? `  - Rejected: ${d.alternativesRejected}` : ''
      ].filter(Boolean).join('\n');
      return detail ? `- **${d.decision}**\n${detail}` : `- **${d.decision}**`;
    });
    sections.push(`## 🙋 User Decisions (made by the human)\n${lines.join('\n')}\n`);
  }

  if (record.summary) {
    sections.push(`## Summary\n${record.summary}\n`);
  }

  sections.push(`---\n*A short hint surfaces on session start; full context loads only if your next prompt matches a keyword above, or via manual \`/handoff-resume\`. The same record is available as a sibling \`.json\` file for external tools.*`);

  return sections.join('\n');
}

const MEMORY_DOC_BEGIN = '<!-- handoff:learnings:begin -->';
const MEMORY_DOC_END = '<!-- handoff:learnings:end -->';

// The "always loaded" project memory file differs by tool: Claude Code reads
// CLAUDE.md, Codex reads AGENTS.md. Update whichever already exist so the
// section lands wherever the calling tool actually looks; if neither exists
// yet, default to CLAUDE.md.
const MEMORY_DOC_CANDIDATES = ['CLAUDE.md', 'AGENTS.md'];

// Replaces (not appends) the auto-managed section on every save, so the memory
// doc reflects the latest distilled context instead of growing unbounded across sessions.
function upsertMemoryDocSection(projectRoot: string, implicitRules: string[], keyDecisions: string[]): string[] {
  if (implicitRules.length === 0 && keyDecisions.length === 0) return [];

  const parts: string[] = [`${MEMORY_DOC_BEGIN}`, `## Session Learnings (auto-updated by handoff)`, ``];
  if (implicitRules.length > 0) {
    parts.push(`### Implicit Rules`, ...implicitRules.map(r => `- ${r}`), ``);
  }
  if (keyDecisions.length > 0) {
    parts.push(`### Key Decisions`, ...keyDecisions.map(d => `- ${d}`), ``);
  }
  parts.push(MEMORY_DOC_END);
  const section = parts.join('\n');
  const blockRegex = new RegExp(`${MEMORY_DOC_BEGIN}[\\s\\S]*?${MEMORY_DOC_END}`);

  const targetNames = MEMORY_DOC_CANDIDATES.filter(name => fs.existsSync(path.join(projectRoot, name)));
  if (targetNames.length === 0) targetNames.push('CLAUDE.md');

  return targetNames.map(name => {
    const docPath = path.join(projectRoot, name);
    const existing = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf-8') : `# ${name}\n`;

    const updated = blockRegex.test(existing)
      ? existing.replace(blockRegex, section)
      : `${existing.trimEnd()}\n\n${section}\n`;

    fs.writeFileSync(docPath, updated, 'utf-8');
    return docPath;
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Context Handoff MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
