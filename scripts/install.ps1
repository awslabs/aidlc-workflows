# AI-DLC Workflow Installer (Windows PowerShell)
# Sets up AI-DLC rules in your target project from this cloned repository.
# Usage: .\scripts\install.ps1 [agent] [target-project-dir]
#   agent: kiro | amazonq | cursor | cline | claude-code | copilot | codex
#   target-project-dir: path to the project you want to set up (defaults to current directory)

param(
    [string]$Agent = "",
    [string]$TargetProject = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$RulesDir  = Join-Path $RepoRoot "aidlc-rules"

function Write-Success($msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Err($msg)     { Write-Host "✗ $msg" -ForegroundColor Red }
function Write-Info($msg)    { Write-Host "ℹ $msg" -ForegroundColor Cyan }

if (-not (Test-Path $RulesDir)) {
    Write-Err "Cannot find aidlc-rules\ at: $RulesDir"
    Write-Err "Run this script from within the cloned aidlc-workflows repository."
    exit 1
}

$RulesSrc   = Join-Path $RulesDir "aws-aidlc-rules"
$DetailsSrc = Join-Path $RulesDir "aws-aidlc-rule-details"

# ── Agent selection ────────────────────────────────────────────────────────────

if (-not $Agent) {
    Write-Host "AI-DLC Workflow Installer"
    Write-Host "========================="
    Write-Host ""
    Write-Host "Select your coding agent:"
    Write-Host "  1) Kiro"
    Write-Host "  2) Amazon Q Developer"
    Write-Host "  3) Cursor IDE"
    Write-Host "  4) Cline"
    Write-Host "  5) Claude Code"
    Write-Host "  6) GitHub Copilot"
    Write-Host "  7) OpenAI Codex"
    Write-Host ""
    $choice = Read-Host "Enter choice [1-7]"
    $Agent = switch ($choice) {
        "1" { "kiro" }
        "2" { "amazonq" }
        "3" { "cursor" }
        "4" { "cline" }
        "5" { "claude-code" }
        "6" { "copilot" }
        "7" { "codex" }
        default { Write-Err "Invalid choice: $choice"; exit 1 }
    }
}

# ── Target project directory ───────────────────────────────────────────────────

if (-not $TargetProject) {
    $default = (Get-Location).Path
    $input = Read-Host "Target project directory [$default]"
    $TargetProject = if ($input -eq "") { $default } else { $input }
}

if (-not (Test-Path $TargetProject)) {
    Write-Err "Directory not found: $TargetProject"
    exit 1
}
$TargetProject = (Resolve-Path $TargetProject).Path

Write-Info "Installing AI-DLC rules for agent '$Agent' into: $TargetProject"
Write-Host ""

# ── Copy rules ─────────────────────────────────────────────────────────────────

switch ($Agent) {
    "kiro" {
        New-Item -ItemType Directory -Force -Path "$TargetProject\.kiro\steering" | Out-Null
        Copy-Item -Recurse -Force $RulesSrc "$TargetProject\.kiro\steering\"
        Copy-Item -Recurse -Force $DetailsSrc "$TargetProject\.kiro\"
        Write-Success "Kiro steering files installed"
    }
    "amazonq" {
        New-Item -ItemType Directory -Force -Path "$TargetProject\.amazonq\rules" | Out-Null
        Copy-Item -Recurse -Force $RulesSrc "$TargetProject\.amazonq\rules\"
        Copy-Item -Recurse -Force $DetailsSrc "$TargetProject\.amazonq\"
        Write-Success "Amazon Q Developer rules installed"
    }
    "cursor" {
        New-Item -ItemType Directory -Force -Path "$TargetProject\.cursor\rules" | Out-Null
        $frontmatter = "---`ndescription: `"AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development`"`nalwaysApply: true`n---`n`n"
        $frontmatter | Out-File -FilePath "$TargetProject\.cursor\rules\ai-dlc-workflow.mdc" -Encoding utf8 -NoNewline
        Get-Content "$RulesSrc\core-workflow.md" | Add-Content "$TargetProject\.cursor\rules\ai-dlc-workflow.mdc"
        New-Item -ItemType Directory -Force -Path "$TargetProject\.aidlc-rule-details" | Out-Null
        Copy-Item -Recurse -Force "$DetailsSrc\*" "$TargetProject\.aidlc-rule-details\"
        Write-Success "Cursor IDE rules installed"
    }
    "cline" {
        New-Item -ItemType Directory -Force -Path "$TargetProject\.clinerules" | Out-Null
        Copy-Item -Force "$RulesSrc\core-workflow.md" "$TargetProject\.clinerules\"
        New-Item -ItemType Directory -Force -Path "$TargetProject\.aidlc-rule-details" | Out-Null
        Copy-Item -Recurse -Force "$DetailsSrc\*" "$TargetProject\.aidlc-rule-details\"
        Write-Success "Cline rules installed"
    }
    "claude-code" {
        Copy-Item -Force "$RulesSrc\core-workflow.md" "$TargetProject\CLAUDE.md"
        New-Item -ItemType Directory -Force -Path "$TargetProject\.aidlc-rule-details" | Out-Null
        Copy-Item -Recurse -Force "$DetailsSrc\*" "$TargetProject\.aidlc-rule-details\"
        Write-Success "Claude Code rules installed"
    }
    "copilot" {
        New-Item -ItemType Directory -Force -Path "$TargetProject\.github" | Out-Null
        Copy-Item -Force "$RulesSrc\core-workflow.md" "$TargetProject\.github\copilot-instructions.md"
        New-Item -ItemType Directory -Force -Path "$TargetProject\.aidlc-rule-details" | Out-Null
        Copy-Item -Recurse -Force "$DetailsSrc\*" "$TargetProject\.aidlc-rule-details\"
        Write-Success "GitHub Copilot rules installed"
    }
    "codex" {
        Copy-Item -Force "$RulesSrc\core-workflow.md" "$TargetProject\AGENTS.md"
        New-Item -ItemType Directory -Force -Path "$TargetProject\.aidlc-rule-details" | Out-Null
        Copy-Item -Recurse -Force "$DetailsSrc\*" "$TargetProject\.aidlc-rule-details\"
        Write-Success "OpenAI Codex rules installed"
    }
    default {
        Write-Err "Unknown agent: $Agent"
        Write-Host "Valid agents: kiro | amazonq | cursor | cline | claude-code | copilot | codex"
        exit 1
    }
}

Write-Host ""
Write-Success "Done. Open your project in your coding agent and start with: 'Using AI-DLC, ...'"
