#!/usr/bin/env bash
# context-auto-handoff -- one-line setup for Linux/macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Ethualo/context-auto-handoff/main/scripts/setup.sh | bash
# Codex support:  ... | bash -s -- --codex

set -e

PLUGIN_NAME="context-handoff"
HOOKS_TARGET="$HOME/.claude/hooks.json"
WITH_CODEX=false

for arg in "$@"; do
  case "$arg" in
    --codex) WITH_CODEX=true ;;
  esac
done

echo "[Handoff Setup] Installing $PLUGIN_NAME..."

# 1. npm global install (builds TypeScript)
npm install -g context-auto-handoff

PKG_ROOT="$(npm root -g)/context-auto-handoff"

# 2. Register hooks.json (warn if already exists)
HOOKS_SRC="$PKG_ROOT/hooks/hooks.json"

if [ -f "$HOOKS_TARGET" ]; then
  echo "[Handoff Setup] WARNING: $HOOKS_TARGET already exists."
  echo "  Manually merge contents from: $HOOKS_SRC"
else
  mkdir -p "$(dirname "$HOOKS_TARGET")"
  cp "$HOOKS_SRC" "$HOOKS_TARGET"
  echo "[Handoff Setup] hooks.json registered: $HOOKS_TARGET"
fi

if [ "$WITH_CODEX" = true ]; then
  echo ""
  echo "[Handoff Setup] Configuring Codex..."

  # 3. Register MCP server in ~/.codex/config.toml (warn if entry already exists)
  CODEX_CONFIG="$HOME/.codex/config.toml"
  SERVER_BIN="$PKG_ROOT/build/index.js"
  mkdir -p "$(dirname "$CODEX_CONFIG")"
  touch "$CODEX_CONFIG"

  if grep -q "mcp_servers.context-handoff" "$CODEX_CONFIG" 2>/dev/null; then
    echo "[Handoff Setup] WARNING: [mcp_servers.context-handoff] already present in $CODEX_CONFIG — skipping."
  else
    {
      echo ""
      echo "[mcp_servers.context-handoff]"
      echo "command = \"node\""
      echo "args = [\"$SERVER_BIN\"]"
    } >> "$CODEX_CONFIG"
    echo "[Handoff Setup] MCP server registered: $CODEX_CONFIG"
  fi

  # 4. Copy .codex hooks + agents + AGENTS.md into the current project (warn if already present)
  if [ -d "./.codex" ]; then
    echo "[Handoff Setup] WARNING: ./.codex already exists — not overwritten. Reference: $PKG_ROOT/templates/.codex"
  else
    cp -r "$PKG_ROOT/templates/.codex" ./.codex
    echo "[Handoff Setup] Codex hooks + handoff-drafter subagent copied: ./.codex"
  fi

  if [ -f "./AGENTS.md" ]; then
    echo "[Handoff Setup] WARNING: ./AGENTS.md already exists — not overwritten. Reference: $PKG_ROOT/templates/AGENTS.md"
  else
    cp "$PKG_ROOT/templates/AGENTS.md" ./AGENTS.md
    echo "[Handoff Setup] AGENTS.md copied: ./AGENTS.md"
  fi
fi

echo ""
echo "[Handoff Setup] Done!"
echo ""
echo "  Usage:"
echo "    /handoff-save    -- save current session"
echo "    /handoff-resume  -- restore previous session"
echo ""
echo "  SessionStart hook auto-restores previous context on session open."
