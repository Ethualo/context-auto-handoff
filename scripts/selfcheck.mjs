#!/usr/bin/env node
// Drives the built server over stdio the way Claude Code does, so the check covers the
// bundle that actually ships — not a re-import of the source with its deps resolvable.
// The bundle is copied out of the repo into a temp dir with no node_modules anywhere up
// the tree, which is what a plugin cache install looks like: an unbundled import would
// surface here as ERR_MODULE_NOT_FOUND instead of silently resolving against the repo.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-selfcheck-'));

const serverPath = path.join(workspace, 'cache', 'index.js');
fs.mkdirSync(path.dirname(serverPath), { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'build', 'index.js'), serverPath);

const SCHEMA_VERSION = 1;

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function callTool(id, args) {
  return rpc(id, 'tools/call', { name: 'generate_handoff_manifest', arguments: args });
}

// One server process per run keeps the session-scoped archive reuse observable.
function runSession(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      assert.ok(!stderr.includes('ERR_MODULE_NOT_FOUND'), `bundle has an unresolved runtime import:\n${stderr}`);
      const responses = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      resolve(responses);
    });

    child.stdin.write([
      rpc(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'selfcheck', version: '1' }
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ...requests
    ].join('\n') + '\n');
    child.stdin.end();
  });
}

const text = (response) => response.result.content[0].text;
const handoffsDir = (root) => path.join(root, '.handoff', 'handoffs');

const walk = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  : []);

const archiveFiles = (root) => walk(handoffsDir(root)).filter((f) => path.basename(f) !== 'index.md');
const archiveBases = (root) => [...new Set(archiveFiles(root).map((f) => f.slice(0, -path.extname(f).length)))];
const indexRows = (root) => {
  const file = path.join(handoffsDir(root), 'index.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
};

// Mirrors the documented read priority the resume/search skills follow: Markdown first —
// it is the cheaper read into a model's context for the same content — with the JSON half
// of the same pair as the fallback when the Markdown is missing.
function readHandoffPair(base) {
  const mdPath = `${base}.md`;
  if (fs.existsSync(mdPath)) return { format: 'markdown', raw: fs.readFileSync(mdPath, 'utf-8') };

  const jsonPath = `${base}.json`;
  if (fs.existsSync(jsonPath)) {
    try {
      return { format: 'json', record: JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) };
    } catch {
      return null;
    }
  }
  return null;
}

function seedArchivePair(root, day, stamp, { json = true, markdown = true, malformedJson = false } = {}) {
  const dir = path.join(handoffsDir(root), day);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `handoff-${stamp.replace(/[:.]/g, '-')}`);
  if (json) {
    fs.writeFileSync(`${base}.json`, malformedJson ? '{ this is not json' : JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: stamp,
      project: 'seeded',
      session: 'seed',
      headline: `seeded ${stamp}`,
      summary: null,
      taskDescription: null,
      currentStatus: null,
      keyDecisions: [],
      failedApproaches: [],
      blockers: null,
      modifiedFiles: [],
      implicitRules: [],
      nextSteps: ['seeded step'],
      keywords: ['seeded']
    }, null, 2) + '\n', 'utf-8');
  }
  if (markdown) {
    fs.writeFileSync(
      `${base}.md`,
      `---\ndate: ${stamp}\nkeywords: seeded\nheadline: seeded markdown ${stamp}\n---\n\n* **Goal:** seeded\n`,
      'utf-8'
    );
  }
  return base;
}

const FULL_ARGS = {
  summary: 'session recap',
  nextSteps: ['first step', 'second step'],
  taskDescription: 'dual format handoff',
  currentStatus: 'json half added, docs pending',
  keyDecisions: ['Decision: one record — Reason: no drift'],
  failedApproaches: ['Approach: X → Result: Y → Lesson: Z'],
  blockers: 'none open',
  modifiedFiles: ['src/index.ts: record + renderer'],
  implicitRules: ['TypeScript, esbuild bundle'],
  keywords: ['alpha, beta']
};

async function checkDualFormatSave() {
  const root = path.join(workspace, 'project');
  fs.mkdirSync(root);

  // A legacy file written by an outdated build must be absorbed, not orphaned.
  const legacyDir = path.join(root, '.claude');
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, 'handoff.md'), '---\ndate: 2020-01-01T00:00:00.000Z\n---\n\n* **Goal:** legacy entry\n');

  const [, first, second] = await runSession([
    callTool(2, { ...FULL_ARGS, workingDirectory: root }),
    callTool(3, { ...FULL_ARGS, taskDescription: 'second goal', workingDirectory: root })
  ]);

  assert.equal(first.result.isError, undefined, `save failed: ${JSON.stringify(first)}`);
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'handoff.md')), 'legacy .claude/handoff.md left behind');
  assert.match(text(first), /Absorbed 1 handoff file/, 'legacy absorption not reported');

  const mainJson = path.join(root, '.handoff', 'handoff.json');
  const mainMd = path.join(root, '.handoff', 'handoff.md');
  assert.ok(fs.existsSync(mainJson), '.handoff/handoff.json not written');
  assert.ok(fs.existsSync(mainMd), '.handoff/handoff.md not written');
  assert.equal(fs.readdirSync(path.join(root, '.handoff')).filter((f) => f.endsWith('.tmp')).length, 0, 'temp files left behind');

  // The JSON half must survive a real parse — that is the whole contract for outside readers.
  const record = JSON.parse(fs.readFileSync(mainJson, 'utf-8'));
  assert.equal(record.schemaVersion, SCHEMA_VERSION, 'schemaVersion wrong');
  assert.ok(Number.isInteger(record.schemaVersion), 'schemaVersion is not an integer');
  assert.equal(record.taskDescription, 'second goal', 'latest JSON is not the latest save');
  assert.deepEqual(record.nextSteps, FULL_ARGS.nextSteps, 'nextSteps not preserved');
  assert.ok(record.nextSteps.length >= 1, 'nextSteps contract (>=1) broken');
  assert.equal(record.workingDirectory, undefined, 'absolute workingDirectory leaked into the JSON');
  assert.ok(!fs.readFileSync(mainJson, 'utf-8').includes(root), 'absolute project path leaked into the JSON');

  // Same meaning in both halves, produced by one tool call — no second draft, no model.
  const md = fs.readFileSync(mainMd, 'utf-8');
  assert.ok(md.includes(record.taskDescription), 'taskDescription missing from markdown');
  assert.ok(md.includes(record.currentStatus), 'currentStatus missing from markdown');
  assert.ok(md.includes(record.blockers), 'blockers missing from markdown');
  assert.ok(md.includes(record.summary), 'summary missing from markdown');
  for (const list of ['keyDecisions', 'failedApproaches', 'modifiedFiles', 'implicitRules']) {
    for (const item of record[list]) assert.ok(md.includes(item), `${list} entry missing from markdown: ${item}`);
  }
  for (const step of record.nextSteps) assert.ok(md.includes(step), `next step missing from markdown: ${step}`);
  assert.match(md, /^schema_version: 1$/m, 'markdown frontmatter lost schema_version');
  for (const section of ['High-Level Objective', 'Current State & Next Steps', 'Remaining Queue',
    'Modified Files Delta', 'Failed Approaches', 'Crucial Context & Implicit Rules', 'Key Decisions', 'Summary']) {
    assert.ok(md.includes(section), `resume-critical section missing: ${section}`);
  }

  // A comma inside a keyword must not silently split into two keywords.
  assert.deepEqual(record.keywords, ['alpha beta'], `keyword not sanitized: ${record.keywords}`);
  assert.equal(md.match(/^keywords: (.*)$/m)[1], 'alpha beta', 'markdown keywords not sanitized');

  // Repeat saves in one session update the same archive pair instead of piling up.
  const archivePaths = new Set([text(first), text(second)].map((t) => t.match(/Archive: (.+?) \(/)[1]));
  assert.equal(archivePaths.size, 1, 'second save created a new archive for the same session');

  const bases = archiveBases(root);
  assert.equal(bases.length, 2, `expected legacy + session archive, got ${bases.length}`);
  for (const base of bases) {
    assert.match(path.dirname(base), /\d{4}-\d{2}-\d{2}$/, `archive not in a dated directory: ${base}`);
  }
  const sessionBase = bases.find((b) => fs.existsSync(`${b}.json`));
  assert.ok(sessionBase, 'session archive has no JSON half');
  assert.ok(fs.existsSync(`${sessionBase}.md`), 'session archive has no Markdown half');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${sessionBase}.json`, 'utf-8')),
    record,
    'archive JSON differs from the latest JSON'
  );

  // One handoff = one index row, whichever halves exist on disk.
  const rows = indexRows(root);
  assert.equal(rows.length, bases.length, 'index row count does not match archive count');
  for (const row of rows) {
    const relativePath = row.split(' | ')[3];
    assert.ok(fs.existsSync(path.join(handoffsDir(root), relativePath)), `index points at a missing file: ${relativePath}`);
  }
  assert.ok(rows.some((l) => l.includes('legacy entry')), 'headline not derived for the absorbed legacy archive');

  return root;
}

async function checkOptionalFieldNormalization() {
  const root = path.join(workspace, 'minimal');
  fs.mkdirSync(root);

  const [, response] = await runSession([callTool(2, { nextSteps: ['only step'], workingDirectory: root })]);
  assert.equal(response.result.isError, undefined, `minimal save failed: ${JSON.stringify(response)}`);

  const record = JSON.parse(fs.readFileSync(path.join(root, '.handoff', 'handoff.json'), 'utf-8'));
  for (const key of ['summary', 'taskDescription', 'currentStatus', 'blockers']) {
    assert.ok(key in record, `optional field dropped instead of nulled: ${key}`);
    assert.equal(record[key], null, `optional field not normalized to null: ${key}`);
  }
  for (const key of ['keyDecisions', 'failedApproaches', 'modifiedFiles', 'implicitRules', 'keywords']) {
    assert.deepEqual(record[key], [], `optional list not normalized to []: ${key}`);
  }
  assert.equal(record.headline, 'only step', 'headline not derived from the first next step');
}

// The decisive regression test for pair-aware retention: under file counting, 50 pairs
// (100 files) would blow past the 50-file limit and delete half the history.
async function checkPairAwarePruning() {
  const root = path.join(workspace, 'prune');
  fs.mkdirSync(root);

  for (let i = 0; i < 49; i++) {
    seedArchivePair(root, '2000-01-01', `2000-01-01T00:00:${String(i).padStart(2, '0')}.000Z`);
  }
  await runSession([callTool(2, { nextSteps: ['keep me'], workingDirectory: root })]);

  assert.equal(archiveBases(root).length, 50, 'a handoff pair was counted as two handoffs');
  assert.equal(archiveFiles(root).length, 100, 'files were pruned while the pair count was still under the limit');
  assert.equal(indexRows(root).length, 50, 'index counted JSON and Markdown halves separately');

  for (let i = 0; i < 4; i++) {
    seedArchivePair(root, '1999-01-01', `1999-01-01T00:00:0${i}.000Z`);
  }
  await runSession([callTool(2, { nextSteps: ['keep me too'], workingDirectory: root })]);

  const bases = archiveBases(root);
  assert.equal(bases.length, 50, `pruning did not settle at the 50-handoff limit: ${bases.length}`);
  assert.ok(!fs.existsSync(path.join(handoffsDir(root), '1999-01-01')), 'oldest handoffs survived pruning');
  for (const base of bases) {
    const halves = [`${base}.json`, `${base}.md`].filter((f) => fs.existsSync(f));
    assert.equal(halves.length, 2, `pruning split a pair, leaving only: ${halves}`);
  }

  // No dangling rows: the index is rebuilt from what survived.
  const rows = indexRows(root);
  assert.equal(rows.length, 50, 'index row count drifted from the surviving handoffs');
  for (const row of rows) {
    assert.ok(fs.existsSync(path.join(handoffsDir(root), row.split(' | ')[3])), `dangling index row: ${row}`);
  }
}

// A half-missing or half-corrupt archive must still be findable and readable.
async function checkMixedArchiveReads() {
  const root = path.join(workspace, 'mixed');
  fs.mkdirSync(root);

  const jsonOnly = seedArchivePair(root, '2001-01-01', '2001-01-01T00:00:00.000Z', { markdown: false });
  const mdOnly = seedArchivePair(root, '2001-01-02', '2001-01-02T00:00:00.000Z', { json: false });
  const broken = seedArchivePair(root, '2001-01-03', '2001-01-03T00:00:00.000Z', { malformedJson: true });

  await runSession([callTool(2, { nextSteps: ['index rebuild'], keywords: ['live'], workingDirectory: root })]);

  const rows = indexRows(root);
  assert.equal(rows.length, 4, `expected one row per handoff, got ${rows.length}`);
  const row = (needle) => rows.find((r) => r.includes(needle));

  assert.ok(row('2001-01-01/handoff-2001-01-01T00-00-00-000Z.json'), 'JSON-only archive missing from the index');
  assert.ok(row('handoff-2001-01-02T00-00-00-000Z.md'), 'Markdown-only legacy archive missing from the index');
  // The malformed JSON half must not cost its archive the index row — the pair falls back.
  const brokenRow = row('handoff-2001-01-03T00-00-00-000Z.md');
  assert.ok(brokenRow, 'archive with malformed JSON dropped from the index');
  assert.ok(brokenRow.includes('seeded markdown'), 'malformed JSON did not fall back to the Markdown half');

  // Dated subdirectories are searched recursively, not just the top level.
  for (const r of rows) {
    assert.match(r.split(' | ')[3], /^\d{4}-\d{2}-\d{2}\//, `archive row is not pointing into a dated subdirectory: ${r}`);
  }

  // Read priority: Markdown when present, the JSON half of the same pair otherwise.
  assert.equal(readHandoffPair(mdOnly).format, 'markdown', 'Markdown-only archive not read as Markdown');
  assert.equal(readHandoffPair(jsonOnly).format, 'json', 'JSON-only archive did not fall back to JSON');
  assert.equal(readHandoffPair(broken).format, 'markdown', 'a malformed JSON half derailed a readable Markdown half');

  const latestBase = path.join(root, '.handoff', 'handoff');
  assert.equal(readHandoffPair(latestBase).format, 'markdown', 'latest handoff not read Markdown-first');
  fs.unlinkSync(`${latestBase}.md`);
  const fallback = readHandoffPair(latestBase);
  assert.equal(fallback.format, 'json', 'latest handoff did not fall back to JSON');
  assert.deepEqual(fallback.record.nextSteps, ['index rebuild'], 'JSON fallback lost the next step');

  // Both halves unusable: report nothing rather than throwing mid-resume.
  fs.unlinkSync(`${broken}.md`);
  assert.equal(readHandoffPair(broken), null, 'an unreadable pair threw instead of returning null');
}

// A failed save must not leave the previous latest handoff damaged or half-updated.
async function checkPartialFailureSafety() {
  const root = path.join(workspace, 'partial');
  fs.mkdirSync(root);

  await runSession([callTool(2, { nextSteps: ['good save'], taskDescription: 'intact goal', workingDirectory: root })]);
  const mainMd = path.join(root, '.handoff', 'handoff.md');
  const before = fs.readFileSync(mainMd, 'utf-8');

  // A directory where handoff.json belongs makes the commit of the JSON half fail.
  const mainJson = path.join(root, '.handoff', 'handoff.json');
  fs.unlinkSync(mainJson);
  fs.mkdirSync(mainJson);

  const [, blocked] = await runSession([
    callTool(2, { nextSteps: ['should not land'], taskDescription: 'clobbered goal', workingDirectory: root })
  ]);
  assert.ok(blocked.result.isError, 'a failed JSON commit was reported as a successful save');
  assert.equal(fs.readFileSync(mainMd, 'utf-8'), before, 'a failed save clobbered the previous latest handoff.md');
  assert.ok(!fs.existsSync(`${mainJson}.tmp`), 'temp file left behind after a failed save');
  assert.ok(!fs.existsSync(`${mainMd}.tmp`), 'temp file left behind after a failed save');

  fs.rmSync(mainJson, { recursive: true, force: true });
}

function runHook(hookPath, input) {
  return new Promise((resolve, reject) => {
    // Pinned explicitly: the hook prefers CLAUDE_PROJECT_DIR, so inheriting the real one
    // would point this check at the developer's own repo.
    const env = { ...process.env, CLAUDE_PROJECT_DIR: input.cwd };
    const child = spawn(process.execPath, [hookPath], { stdio: ['pipe', 'pipe', 'inherit'], env });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(stdout.trim()));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

async function checkPromptHook() {
  const hookPath = path.join(repoRoot, 'hooks', 'user-prompt-submit.js');
  const root = path.join(workspace, 'hook-project');
  fs.mkdirSync(path.join(root, '.handoff'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.handoff', 'handoff.md'),
    `---\ndate: ${new Date().toISOString()}\nkeywords: ui, api\n---\n\n# Session Handoff Snapshot\nbody\n`
  );
  fs.writeFileSync(
    path.join(root, '.handoff', 'handoff.json'),
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), nextSteps: ['x'] }, null, 2)
  );

  const ask = (prompt, sessionId) => runHook(hookPath, { cwd: root, prompt, session_id: sessionId });

  // 'ui' and 'api' sit inside 'build', 'guide', and 'rapid' — a substring match would fire here.
  assert.equal(await ask('build a guide for rapid delivery', 's1'), '', 'keyword matched inside an unrelated word');

  const hit = await ask('fix the ui spacing', 's1');
  assert.ok(hit.includes('additionalContext'), 'real keyword occurrence did not inject the handoff');
  // Resume context stays the compact Markdown briefing — the raw JSON record is never
  // dumped into the session, which is the whole point of keeping two formats.
  assert.ok(hit.includes('Session Handoff Snapshot'), 'injected context is not the Markdown briefing');
  assert.ok(!hit.includes('schemaVersion'), 'the raw JSON record was injected into the session context');

  // Same session, still matching: the context is already loaded, so do not pay for it twice.
  assert.equal(await ask('more ui work', 's1'), '', 'handoff re-injected within the same session');
  assert.ok((await ask('more ui work', 's2')).includes('additionalContext'), 'new session did not get the handoff');
}

async function main() {
  const root = await checkDualFormatSave();
  await checkOptionalFieldNormalization();
  await checkPairAwarePruning();
  await checkMixedArchiveReads();
  await checkPartialFailureSafety();

  // Bad roots must fail loudly rather than inventing a tree somewhere plausible.
  const [, relative, missing, empty] = await runSession([
    callTool(2, { nextSteps: ['x'], workingDirectory: 'relative/path' }),
    callTool(3, { nextSteps: ['x'], workingDirectory: path.join(workspace, 'does-not-exist') }),
    callTool(4, { nextSteps: [], workingDirectory: root })
  ]);
  assert.ok(relative.result.isError, 'relative workingDirectory accepted');
  assert.ok(missing.result.isError, 'non-existent workingDirectory accepted');
  assert.ok(!fs.existsSync(path.join(workspace, 'does-not-exist')), 'non-existent root was created anyway');
  assert.ok(empty.error || empty.result.isError, 'empty nextSteps accepted');

  await checkPromptHook();

  console.log('selfcheck OK');
}

main()
  .catch((error) => { console.error('selfcheck FAILED:', error.message); process.exitCode = 1; })
  .finally(() => fs.rmSync(workspace, { recursive: true, force: true }));
