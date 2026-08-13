# context-auto-handoff -- one-line setup for Windows (PowerShell)
# Usage: irm https://raw.githubusercontent.com/Ethualo/context-auto-handoff/main/scripts/setup.ps1 | iex
# Codex support: run the downloaded file with -Codex, e.g. .\setup.ps1 -Codex

param(
  [switch]$Codex
)

$ErrorActionPreference = "Stop"

$PluginName = "context-handoff"
$HooksTarget = "$env:USERPROFILE\.claude\hooks.json"

Write-Host "[Handoff Setup] Installing $PluginName..."

# 1. npm global install (builds TypeScript)
npm install -g context-auto-handoff

$NpmRoot = (npm root -g).Trim()
$PkgRoot = Join-Path $NpmRoot "context-auto-handoff"

# 2. Register hooks.json (warn if already exists)
$HooksSrc = Join-Path $PkgRoot "hooks\hooks.json"

if (Test-Path $HooksTarget) {
  Write-Host "[Handoff Setup] WARNING: $HooksTarget already exists."
  Write-Host "  Manually merge contents from: $HooksSrc"
} else {
  $HooksDir = Split-Path $HooksTarget
  if (-not (Test-Path $HooksDir)) { New-Item -ItemType Directory -Force $HooksDir | Out-Null }
  Copy-Item $HooksSrc $HooksTarget
  Write-Host "[Handoff Setup] hooks.json registered: $HooksTarget"
}

if ($Codex) {
  Write-Host ""
  Write-Host "[Handoff Setup] Configuring Codex..."

  # 3. Register MCP server in ~/.codex/config.toml (warn if entry already exists)
  $CodexConfig = "$env:USERPROFILE\.codex\config.toml"
  $ServerBin = Join-Path $PkgRoot "build\index.js"
  $CodexConfigDir = Split-Path $CodexConfig
  if (-not (Test-Path $CodexConfigDir)) { New-Item -ItemType Directory -Force $CodexConfigDir | Out-Null }
  if (-not (Test-Path $CodexConfig)) { New-Item -ItemType File -Path $CodexConfig | Out-Null }

  $existingConfig = Get-Content $CodexConfig -Raw -ErrorAction SilentlyContinue
  if ($existingConfig -and $existingConfig.Contains("mcp_servers.context-handoff")) {
    Write-Host "[Handoff Setup] WARNING: [mcp_servers.context-handoff] already present in $CodexConfig — skipping."
  } else {
    $TomlBlock = @"

[mcp_servers.context-handoff]
command = "node"
args = ["$($ServerBin.Replace('\','\\'))"]
"@
    Add-Content -Path $CodexConfig -Value $TomlBlock
    Write-Host "[Handoff Setup] MCP server registered: $CodexConfig"
  }

  # 4. Copy .codex hooks + agents + AGENTS.md into the current project (warn if already present)
  if (Test-Path ".\.codex") {
    Write-Host "[Handoff Setup] WARNING: .\.codex already exists — not overwritten. Reference: $PkgRoot\templates\.codex"
  } else {
    Copy-Item (Join-Path $PkgRoot "templates\.codex") ".\.codex" -Recurse
    Write-Host "[Handoff Setup] Codex hooks + handoff-drafter subagent copied: .\.codex"
  }

  if (Test-Path ".\AGENTS.md") {
    Write-Host "[Handoff Setup] WARNING: .\AGENTS.md already exists — not overwritten. Reference: $PkgRoot\templates\AGENTS.md"
  } else {
    Copy-Item (Join-Path $PkgRoot "templates\AGENTS.md") ".\AGENTS.md"
    Write-Host "[Handoff Setup] AGENTS.md copied: .\AGENTS.md"
  }
}

Write-Host ""
Write-Host "[Handoff Setup] Done!"
Write-Host ""
Write-Host "  Usage:"
Write-Host "    /handoff-save    -- save current session"
Write-Host "    /handoff-resume  -- restore previous session"
Write-Host ""
Write-Host "  SessionStart hook auto-restores previous context on session open."
