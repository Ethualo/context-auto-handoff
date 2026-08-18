#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { readStdinJson, resolveProjectRoot, readHandoff } from './lib/frontmatter.js';

const input = readStdinJson();
const projectRoot = resolveProjectRoot(input);
const handoff = readHandoff(projectRoot);

if (!handoff || handoff.keywords.length === 0) process.exit(0);

// The whole handoff is injected on a match, so re-injecting it on every later prompt
// in the same session would re-spend those tokens for context that is already loaded.
const markerPath = path.join(projectRoot, '.handoff', '.injected');
const sessionKey = String(input.session_id || '');

function alreadyInjected() {
  if (!sessionKey) return false;
  try {
    return fs.readFileSync(markerPath, 'utf-8').trim() === `${sessionKey} ${handoff.fields.date}`;
  } catch {
    return false;
  }
}

if (alreadyInjected()) process.exit(0);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary match, not a substring one: a keyword like "ui" or "api" would otherwise
// fire on "build" or "rapid" and dump the entire handoff into an unrelated prompt.
function matchesKeyword(prompt, keyword) {
  const pattern = `(^|[^\\p{L}\\p{N}])${escapeRegExp(keyword)}([^\\p{L}\\p{N}]|$)`;
  return new RegExp(pattern, 'u').test(prompt);
}

const prompt = String(input.prompt || '').toLowerCase();
const matched = handoff.keywords.some((keyword) => matchesKeyword(prompt, keyword));

if (!matched) process.exit(0);

if (sessionKey) {
  try {
    fs.writeFileSync(markerPath, `${sessionKey} ${handoff.fields.date}\n`, 'utf-8');
  } catch {
    // A read-only project dir just means the handoff may be injected again later.
  }
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: handoff.raw
  }
}));
