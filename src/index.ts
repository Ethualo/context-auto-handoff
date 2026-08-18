#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';

const server = new McpServer({
  name: 'context-handoff-manager',
  version: '1.3.0'
});

const ARCHIVE_KEEP = 50;
const INDEX_FILE = 'index.md';

// One MCP server process = one Claude Code session (stdio transport is 1:1 per session).
// Reusing this id lets repeated saves within the same session update the same archive
// file instead of piling up near-duplicate entries every time PreCompact/Stop fires.
const sessionId = randomUUID().slice(0, 8);
// Keyed by project root: a single server process can be asked to save into more than
// one root, and reusing another root's archive path would scatter files across projects.
let lastArchive: { root: string; file: string } | null = null;


server.tool(
  'generate_handoff_manifest',
  'Save this session\'s working context to .handoff/handoff.md plus a timestamped archive, so the next session can resume without re-deriving decisions, blockers, and next steps.',
  {
    summary: z.string().optional().describe('Detailed session recap in English — omit if other fields cover it'),
    nextSteps: z.array(z.string()).min(1).describe('Tasks to continue immediately in the next session. Write in English.'),
    taskDescription: z.string().optional().describe('High-level goal + core intent (why this matters). Use telegraphese — drop articles/pronouns. Write in English.'),
    currentStatus: z.string().optional().describe('What is done vs what remains. State why, not just what. Write in English.'),
    keyDecisions: z.array(z.string()).optional().describe('Architecture choices and why — prevents post-compaction amnesia. Format: "Decision: X — Reason: Y". Write in English.'),
    failedApproaches: z.array(z.string()).optional().describe('Already-failed attempts. Format each: "Approach: X → Result: Y → Lesson: Z". Prevents repeating mistakes. Write in English.'),
    blockers: z.string().optional().describe('Unresolved errors or blockers. Write in English.'),
    modifiedFiles: z.array(z.string()).optional().describe('Changed files with delta notes. Format: "path/to/file: what changed" — NO code snippets, path+delta only.'),
    implicitRules: z.array(z.string()).optional().describe('Tech stack, naming conventions, env vars, implicit project rules — anything not derivable from reading code. Write in English.'),
    keywords: z.array(z.string()).max(8).optional().describe('Short topic/feature tags (e.g. file names, feature names) used to match a future session prompt for auto-resume. Write in English, lowercase, 1-3 words each.'),
    workingDirectory: z.string().optional().describe('Absolute path to the project root where handoff.md should be written. Required on Windows where process.cwd() may return System32.')
  },
  async ({ summary, nextSteps, taskDescription, currentStatus, keyDecisions, failedApproaches, blockers, modifiedFiles, implicitRules, keywords, workingDirectory }) => {
    try {
      const { projectRoot, warnings } = resolveProjectRoot(workingDirectory);
      const handoffDir = path.join(projectRoot, '.handoff');
      const handoffsDir = path.join(handoffDir, 'handoffs');

      fs.mkdirSync(handoffsDir, { recursive: true });
      warnings.push(...absorbLegacyHandoffs(projectRoot, handoffsDir));

      const now = new Date();
      const cleanKeywords = sanitizeKeywords(keywords);
      const headline = oneLine(taskDescription || summary || nextSteps[0] || '(no summary)');

      const content = buildMarkdown({
        summary, nextSteps, taskDescription, currentStatus, keyDecisions, failedApproaches,
        blockers, modifiedFiles, implicitRules,
        keywords: cleanKeywords,
        headline,
        displayTime: now.toLocaleString(),
        project: path.basename(projectRoot),
        isoDate: now.toISOString(),
        sessionId
      });

      const mainPath = path.join(handoffDir, 'handoff.md');
      fs.writeFileSync(mainPath, content, 'utf-8');

      // Reuse this session's own archive file across repeat saves (PreCompact/Stop can
      // both fire in one long session) instead of piling up near-duplicate archives.
      const archivePath = lastArchive && lastArchive.root === projectRoot && fs.existsSync(lastArchive.file)
        ? lastArchive.file
        : newArchivePath(handoffsDir, now);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, content, 'utf-8');
      lastArchive = { root: projectRoot, file: archivePath };

      pruneArchives(handoffsDir, ARCHIVE_KEEP);
      // Rebuilt from the surviving files, so pruned archives can never leave dangling index rows.
      rebuildIndex(handoffsDir);

      // A memory-doc failure must not report the already-written handoff as a failed save.
      let memoryDocLines = '';
      try {
        memoryDocLines = upsertMemoryDocSection(projectRoot, implicitRules ?? [], keyDecisions ?? [])
          .map(p => `\n${path.basename(p)} updated: ${p}`)
          .join('');
      } catch (error: any) {
        warnings.push(`Handoff saved, but the memory doc could not be updated: ${error.message}`);
      }

      const warningLines = warnings.map(w => `\nWarning: ${w}`).join('');

      return {
        content: [{
          type: 'text',
          text: `Handoff saved.\nLatest: ${mainPath}\nArchive: ${archivePath}${memoryDocLines}${warningLines}`
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

function newArchivePath(handoffsDir: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(handoffsDir, now.toISOString().slice(0, 10), `handoff-${timestamp}.md`);
}

function listArchives(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listArchives(full);
    return entry.name.endsWith('.md') && entry.name !== INDEX_FILE ? [full] : [];
  });
}

function pruneArchives(handoffsDir: string, keep: number): void {
  const files = listArchives(handoffsDir);
  // Archive names embed an ISO timestamp, so a name sort is a chronological sort.
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const excess = files.length - keep;
  if (excess > 0) files.slice(0, excess).forEach(f => fs.unlinkSync(f));

  for (const entry of fs.readdirSync(handoffsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(handoffsDir, entry.name);
    if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
  }
}

// Regenerated from the archive files themselves rather than appended to, so the index
// can never drift out of sync with what is actually on disk (pruned, migrated, or
// hand-deleted files all correct themselves on the next save).
function rebuildIndex(handoffsDir: string): void {
  const rows = listArchives(handoffsDir).map(file => {
    const raw = fs.readFileSync(file, 'utf-8');
    const fields = readFrontmatter(raw);
    const date = fields['date'] || new Date(fs.statSync(file).mtimeMs).toISOString();
    const keywords = fields['keywords'] || '(none)';
    const headline = fields['headline'] || deriveHeadline(raw);
    const relativePath = path.relative(handoffsDir, file).replace(/\\/g, '/');
    return `${date} | ${keywords} | ${headline} | ${relativePath}`;
  });

  rows.sort();
  fs.writeFileSync(path.join(handoffsDir, INDEX_FILE), rows.length ? rows.join('\n') + '\n' : '', 'utf-8');
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

function buildMarkdown(params: {
  summary?: string;
  nextSteps: string[];
  taskDescription?: string;
  currentStatus?: string;
  keyDecisions?: string[];
  failedApproaches?: string[];
  blockers?: string;
  modifiedFiles?: string[];
  implicitRules?: string[];
  keywords: string[];
  headline: string;
  displayTime: string;
  project: string;
  isoDate: string;
  sessionId: string;
}): string {
  const { summary, nextSteps, taskDescription, currentStatus, keyDecisions, failedApproaches, blockers, modifiedFiles, implicitRules, keywords, headline, displayTime, project, isoDate, sessionId } = params;

  const frontmatter = [
    `---`,
    `date: ${isoDate}`,
    `project: ${project}`,
    `session: ${sessionId}`,
    `next_steps_count: ${nextSteps.length}`,
    `has_blockers: ${Boolean(blockers)}`,
    `keywords: ${keywords.join(', ')}`,
    `headline: ${headline}`,
    `---`,
    ``
  ].join('\n');

  const sections: string[] = [
    frontmatter,
    `# Session Handoff Snapshot`,
    `> **Generated:** ${displayTime}`,
    ``
  ];

  if (taskDescription) {
    sections.push(`## 🎯 High-Level Objective\n* **Goal:** ${taskDescription}\n`);
  }

  const stateLines: string[] = [];
  if (currentStatus) stateLines.push(`* **Status:** ${currentStatus}`);
  if (blockers) stateLines.push(`* **Blocker:** ${blockers}`);
  stateLines.push(`* **Next Action:** ${nextSteps[0]}`);
  sections.push(`## 📌 Current State & Next Steps\n${stateLines.join('\n')}\n`);
  if (nextSteps.length > 1) {
    sections.push(`### Remaining Queue\n${nextSteps.slice(1).map(s => `- [ ] ${s}`).join('\n')}\n`);
  }

  if (modifiedFiles && modifiedFiles.length > 0) {
    sections.push(`## 🛠️ Modified Files Delta\n${modifiedFiles.map(f => `* ${f}`).join('\n')}\n`);
  }

  if (failedApproaches && failedApproaches.length > 0) {
    sections.push(`## 🚫 Failed Approaches (DO NOT RETRY)\n${failedApproaches.map(f => `* ${f}`).join('\n')}\n`);
  }

  if (implicitRules && implicitRules.length > 0) {
    sections.push(`## 🔑 Crucial Context & Implicit Rules\n${implicitRules.map(r => `* ${r}`).join('\n')}\n`);
  }

  if (keyDecisions && keyDecisions.length > 0) {
    sections.push(`## Key Decisions\n${keyDecisions.map(d => `- ${d}`).join('\n')}\n`);
  }

  if (summary) {
    sections.push(`## Summary\n${summary}\n`);
  }

  sections.push(`---\n*A short hint surfaces on session start; full context loads only if your next prompt matches a keyword above, or via manual \`/handoff-resume\`.*`);

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
