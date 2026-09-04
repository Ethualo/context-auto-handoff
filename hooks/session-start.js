#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readStdinJson, resolveProjectRoot, readHandoff } from './lib/frontmatter.js';

const input = readStdinJson();
const projectRoot = resolveProjectRoot(input);
const handoff = readHandoff(projectRoot);
const messages = [];

if (handoff) {
  const ageLabel = handoff.ageDays < 1
    ? `${Math.max(1, Math.round(handoff.ageDays * 24))}h`
    : `${Math.round(handoff.ageDays)}d`;
  const topics = handoff.keywords.length > 0
    ? handoff.keywords.join(', ')
    : '(no keywords tagged)';
  messages.push(`Prior handoff exists (${ageLabel} old, project: ${handoff.fields.project || 'unknown'}). Topics: ${topics}. If continuing that work, mention it or run /handoff-resume.`);
}

// PreCompact/Stop are "prompt"-type hooks — Claude Code only. Codex parses but skips
// them (command/mcp_tool only), so templates/.codex/hooks.json ships a command-type
// equivalent. Runtime detection is delegated to whichever model reads this message:
// a Claude Code session recognizes it isn't Codex and ignores the instruction.
if (!fs.existsSync(path.join(projectRoot, '.codex', 'hooks.json'))) {
  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const codexTemplateSrc = path.join(pluginRoot, 'templates', '.codex');
  messages.push(`If you are running as Codex (not Claude Code) and this project has no .codex/hooks.json: copy ${codexTemplateSrc} to ${path.join(projectRoot, '.codex')} to enable the PreCompact/Stop handoff hooks (Codex skips this plugin's prompt-type hooks otherwise). Confirm with the user before writing. If you are Claude Code, ignore this.`);
}

if (messages.length > 0) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: messages.join('\n\n')
    }
  }));
}
