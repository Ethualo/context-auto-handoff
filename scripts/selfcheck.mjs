#!/usr/bin/env node
// Drives the built server over stdio the way Claude Code does, so the check covers the
// bundle that actually ships — not a re-import of the source with its deps resolvable.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'index.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-selfcheck-'));

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function callTool(id, args) {
  return rpc(id, 'tools/call', { name: 'generate_handoff_manifest', arguments: args });
}

// One server process per run keeps the session-scoped archive reuse observable.
function runSession(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', () => {
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
const archives = (root) => {
  const dir = path.join(root, '.handoff', 'handoffs');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  return walk(dir).filter((f) => path.basename(f) !== 'index.md');
};

async function main() {
  const root = path.join(workspace, 'project');
  fs.mkdirSync(root);

  // A legacy file written by an outdated build must be absorbed, not orphaned.
  const legacyDir = path.join(root, '.claude');
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, 'handoff.md'), '---\ndate: 2020-01-01T00:00:00.000Z\n---\n\n* **Goal:** legacy entry\n');

  const [, first, second] = await runSession([
    callTool(2, { nextSteps: ['first step'], taskDescription: 'first goal', keywords: ['alpha, beta'], workingDirectory: root }),
    callTool(3, { nextSteps: ['second step'], taskDescription: 'second goal', keywords: ['alpha, beta'], workingDirectory: root })
  ]);

  assert.equal(first.result.isError, undefined, `save failed: ${JSON.stringify(first)}`);
  const mainPath = path.join(root, '.handoff', 'handoff.md');
  assert.ok(fs.existsSync(mainPath), 'handoff.md not written under .handoff/');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'handoff.md')), 'legacy .claude/handoff.md left behind');
  assert.match(text(first), /Absorbed 1 handoff file/, 'legacy absorption not reported');

  // Repeat saves in one session update the same archive instead of piling up.
  const archivePaths = new Set([text(first), text(second)].map((t) => t.match(/Archive: (.+)/)[1]));
  assert.equal(archivePaths.size, 1, 'second save created a new archive for the same session');

  const files = archives(root);
  assert.equal(files.length, 2, `expected legacy + session archive, got ${files.length}`);
  for (const file of files) {
    assert.match(path.dirname(file), /\d{4}-\d{2}-\d{2}$/, `archive not in a dated directory: ${file}`);
  }

  // The index is rebuilt from disk, so it must describe exactly the surviving archives.
  const indexLines = fs.readFileSync(path.join(root, '.handoff', 'handoffs', 'index.md'), 'utf-8').split('\n').filter(Boolean);
  assert.equal(indexLines.length, files.length, 'index row count does not match archive count');
  for (const line of indexLines) {
    const relativePath = line.split(' | ')[3];
    assert.ok(fs.existsSync(path.join(root, '.handoff', 'handoffs', relativePath)), `index points at a missing file: ${relativePath}`);
  }
  assert.ok(indexLines.some((l) => l.includes('legacy entry')), 'headline not derived for the absorbed legacy archive');

  // A comma inside a keyword must not silently split into two keywords.
  const keywordLine = fs.readFileSync(mainPath, 'utf-8').match(/^keywords: (.*)$/m)[1];
  assert.equal(keywordLine, 'alpha beta', `keyword not sanitized: ${keywordLine}`);

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
  const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'user-prompt-submit.js');
  const root = path.join(workspace, 'hook-project');
  fs.mkdirSync(path.join(root, '.handoff'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.handoff', 'handoff.md'),
    `---\ndate: ${new Date().toISOString()}\nkeywords: ui, api\n---\n\nbody\n`
  );

  const ask = (prompt, sessionId) => runHook(hookPath, { cwd: root, prompt, session_id: sessionId });

  // 'ui' and 'api' sit inside 'build', 'guide', and 'rapid' — a substring match would fire here.
  assert.equal(await ask('build a guide for rapid delivery', 's1'), '', 'keyword matched inside an unrelated word');

  const hit = await ask('fix the ui spacing', 's1');
  assert.ok(hit.includes('additionalContext'), 'real keyword occurrence did not inject the handoff');

  // Same session, still matching: the context is already loaded, so do not pay for it twice.
  assert.equal(await ask('more ui work', 's1'), '', 'handoff re-injected within the same session');
  assert.ok((await ask('more ui work', 's2')).includes('additionalContext'), 'new session did not get the handoff');
}

main()
  .catch((error) => { console.error('selfcheck FAILED:', error.message); process.exitCode = 1; })
  .finally(() => fs.rmSync(workspace, { recursive: true, force: true }));
