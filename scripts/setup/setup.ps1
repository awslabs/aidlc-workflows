# =============================================================================
# AI-DLC Setup Script (Windows PowerShell)
# =============================================================================
# Automates the platform-specific setup of AI-DLC rules for supported coding
# agents. Downloads the latest release from GitHub or uses a local path if
# GitHub is unreachable.
# =============================================================================
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1
# =============================================================================

param(
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

# --- Constants ---------------------------------------------------------------
$REPO = "awslabs/aidlc-workflows"
$GITHUB_API = "https://api.github.com/repos/$REPO/releases/latest"

# --- Helper Functions --------------------------------------------------------
function Write-Info    { param([string]$msg) Write-Host "  [i] $msg" -ForegroundColor Cyan }
function Write-Success { param([string]$msg) Write-Host "  [+] $msg" -ForegroundColor Green }
function Write-Warn    { param([string]$msg) Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err     { param([string]$msg) Write-Host "  [x] $msg" -ForegroundColor Red }
function Write-Header  { param([string]$msg) Write-Host "`n  === $msg ===" -ForegroundColor Magenta }

# --- Detect Project Root -----------------------------------------------------
function Get-ProjectRoot {
    Write-Info "Project root: $ProjectRoot"
    return $ProjectRoot
}

# --- Download or Locate Rules ------------------------------------------------
function Get-AidlcRules {
    Write-Header "Step 1: Obtaining AI-DLC Rules"

    Write-Info "Attempting to download latest release from GitHub..."

    $downloadUrl = $null
    $version = $null

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $response = Invoke-RestMethod -Uri $GITHUB_API -TimeoutSec 15 -ErrorAction Stop

        $version = $response.tag_name
        $asset = $response.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1

        if ($asset) {
            $downloadUrl = $asset.browser_download_url
        }
    }
    catch {
        Write-Warn "Could not reach GitHub: $($_.Exception.Message)"
    }

    if ($downloadUrl -and $version) {
        Write-Host ""
        Write-Info "Found latest release: $version"
        $choice = Read-Host "  Download from GitHub? [Y/n]"
        if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "Y" }

        if ($choice -match "^[Yy]") {
            $tmpDir = Join-Path $env:TEMP "aidlc-setup-$(Get-Random)"
            New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
            $zipFile = Join-Path $tmpDir "aidlc-rules.zip"

            try {
                Write-Info "Downloading..."
                Invoke-WebRequest -Uri $downloadUrl -OutFile $zipFile -UseBasicParsing

                Write-Info "Extracting..."
                Expand-Archive -Path $zipFile -DestinationPath $tmpDir -Force

                # Find the aidlc-rules directory
                $rulesDir = Get-ChildItem -Path $tmpDir -Recurse -Directory -Filter "aidlc-rules" | Select-Object -First 1

                if (-not $rulesDir) {
                    # Try finding aws-aidlc-rules and go up one level
                    $awsRulesDir = Get-ChildItem -Path $tmpDir -Recurse -Directory -Filter "aws-aidlc-rules" | Select-Object -First 1
                    if ($awsRulesDir) {
                        $rulesDir = $awsRulesDir.Parent
                    }
                }

                if ($rulesDir -and (Test-Path (Join-Path $rulesDir.FullName "aws-aidlc-rules"))) {
                    Write-Success "Downloaded and extracted successfully."
                    return @{ Path = $rulesDir.FullName; TmpDir = $tmpDir }
                }
                else {
                    Write-Err "Could not find aidlc-rules in the downloaded archive."
                    Write-Warn "Falling back to local path..."
                }
            }
            catch {
                Write-Err "Download failed: $($_.Exception.Message)"
                Write-Warn "Falling back to local path..."
            }
        }
    }
    else {
        Write-Warn "Could not find a downloadable release."
        Write-Host ""
    }

    return Get-LocalPath
}

function Get-LocalPath {
    Write-Host ""
    Write-Info "Please provide the path to the extracted 'aidlc-rules' folder."
    Write-Info "This folder should contain 'aws-aidlc-rules\' and 'aws-aidlc-rule-details\'."
    Write-Host ""

    # Try common locations
    $commonPaths = @(
        "$env:USERPROFILE\Downloads\aidlc-rules",
        "$env:USERPROFILE\Desktop\aidlc-rules",
        ".\aidlc-rules"
    )

    $foundPath = $null
    foreach ($p in $commonPaths) {
        if ((Test-Path (Join-Path $p "aws-aidlc-rules")) -and (Test-Path (Join-Path $p "aws-aidlc-rule-details"))) {
            $foundPath = (Resolve-Path $p).Path
            break
        }
    }

    if ($foundPath) {
        Write-Info "Auto-detected: $foundPath"
        $choice = Read-Host "  Use this path? [Y/n]"
        if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "Y" }
        if ($choice -match "^[Yy]") {
            return @{ Path = $foundPath; TmpDir = $null }
        }
    }

    while ($true) {
        $userPath = Read-Host "  Path to aidlc-rules folder"
        $userPath = $userPath.Trim('"').Trim("'")

        if ((Test-Path (Join-Path $userPath "aws-aidlc-rules")) -and (Test-Path (Join-Path $userPath "aws-aidlc-rule-details"))) {
            Write-Success "Valid path confirmed."
            return @{ Path = $userPath; TmpDir = $null }
        }
        else {
            Write-Err "Invalid path. Expected to find 'aws-aidlc-rules\' and 'aws-aidlc-rule-details\' inside."
            $retry = Read-Host "  Try again? [Y/n]"
            if ([string]::IsNullOrWhiteSpace($retry)) { $retry = "Y" }
            if ($retry -notmatch "^[Yy]") {
                Write-Err "Cannot proceed without valid aidlc-rules path."
                exit 1
            }
        }
    }
}

# --- Select Agent ------------------------------------------------------------
function Select-Agent {
    Write-Header "Step 2: Select Your Coding Agent"

    Write-Host ""
    Write-Host "  1) Kiro"
    Write-Host "  2) Amazon Q Developer"
    Write-Host "  3) Cursor IDE"
    Write-Host "  4) Cline"
    Write-Host "  5) Claude Code"
    Write-Host "  6) GitHub Copilot"
    Write-Host "  7) OpenAI Codex"
    Write-Host "  8) All agents"
    Write-Host ""
    $agentChoice = Read-Host "  Select agent [1-8]"

    switch ($agentChoice) {
        "1" { return @("kiro") }
        "2" { return @("amazonq") }
        "3" { return @("cursor") }
        "4" { return @("cline") }
        "5" { return @("claude") }
        "6" { return @("copilot") }
        "7" { return @("codex") }
        "8" { return @("kiro", "amazonq", "cursor", "cline", "claude", "copilot", "codex") }
        default {
            Write-Err "Invalid selection. Please choose 1-8."
            return Select-Agent
        }
    }
}

# --- Setup Functions ---------------------------------------------------------
function Setup-Kiro {
    param([string]$RulesPath, [string]$Root)
    Write-Info "Setting up for Kiro..."
    New-Item -ItemType Directory -Force -Path (Join-Path $Root ".kiro\steering") | Out-Null
    Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rules") (Join-Path $Root ".kiro\steering\")
    Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details") (Join-Path $Root ".kiro\")
    Write-Success "Kiro setup complete."
    Write-Host "    -> .kiro\steering\aws-aidlc-rules\"
    Write-Host "    -> .kiro\aws-aidlc-rule-details\"
}

function Setup-AmazonQ {
    param([string]$RulesPath, [string]$Root)
    Write-Info "Setting up for Amazon Q Developer..."
    New-Item -ItemType Directory -Force -Path (Join-Path $Root ".amazonq\rules") | Out-Null
    Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rules") (Join-Path $Root ".amazonq\rules\")
    Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details") (Join-Path $Root ".amazonq\")
    Write-Success "Amazon Q Developer setup complete."
    Write-Host "    -> .amazonq\rules\aws-aidlc-rules\"
    Write-Host "    -> .amazonq\aws-aidlc-rule-details\"
}

function Setup-Cursor {
    param([string]$RulesPath, [string]$Root)
    Write-Host ""
    Write-Info "Cursor IDE has two setup options:"
    Write-Host "    1) Project Rules (.cursor\rules\) - Recommended"
    Write-Host "    2) AGENTS.md (simple alternative)"
    $cursorOption = Read-Host "  Select option [1/2]"
    if ([string]::IsNullOrWhiteSpace($cursorOption)) { $cursorOption = "1" }

    if ($cursorOption -eq "2") {
        Write-Info "Setting up Cursor with AGENTS.md..."
        Copy-Item -Force (Join-Path $RulesPath "aws-aidlc-rules\core-workflow.md") (Join-Path $Root "AGENTS.md")
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".aidlc-rule-details") | Out-Null
        Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details\*") (Join-Path $Root ".aidlc-rule-details\")
        Write-Success "Cursor setup complete (AGENTS.md)."
        Write-Host "    -> AGENTS.md"
        Write-Host "    -> .aidlc-rule-details\"
    }
    else {
        Write-Info "Setting up Cursor with Project Rules..."
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".cursor\rules") | Out-Null

        $frontmatter = @"
---
description: "AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development"
alwaysApply: true
---

"@
        $coreContent = Get-Content -Path (Join-Path $RulesPath "aws-aidlc-rules\core-workflow.md") -Raw
        $mdcContent = $frontmatter + $coreContent
        Set-Content -Path (Join-Path $Root ".cursor\rules\ai-dlc-workflow.mdc") -Value $mdcContent -Encoding UTF8

        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".aidlc-rule-details") | Out-Null
        Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details\*") (Join-Path $Root ".aidlc-rule-details\")
        Write-Success "Cursor setup complete (Project Rules)."
        Write-Host "    -> .cursor\rules\ai-dlc-workflow.mdc"
        Write-Host "    -> .aidlc-rule-details\"
    }
}

function Setup-Cline {
    param([string]$RulesPath, [string]$Root)
    Write-Host ""
    Write-Info "Cline has two setup options:"
    Write-Host "    1) .clinerules directory - Recommended"
    Write-Host "    2) AGENTS.md (simple alternative)"
    $clineOption = Read-Host "  Select option [1/2]"
    if ([string]::IsNullOrWhiteSpace($clineOption)) { $clineOption = "1" }

    if ($clineOption -eq "2") {
        Write-Info "Setting up Cline with AGENTS.md..."
        Copy-Item -Force (Join-Path $RulesPath "aws-aidlc-rules\core-workflow.md") (Join-Path $Root "AGENTS.md")
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".aidlc-rule-details") | Out-Null
        Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details\*") (Join-Path $Root ".aidlc-rule-details\")
        Write-Success "Cline setup complete (AGENTS.md)."
        Write-Host "    -> AGENTS.md"
        Write-Host "    -> .aidlc-rule-details\"
    }
    else {
        Write-Info "Setting up Cline with .clinerules..."
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".clinerules") | Out-Null
        Copy-Item -Force (Join-Path $RulesPath "aws-aidlc-rules\core-workflow.md") (Join-Path $Root ".clinerules\")
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".aidlc-rule-details") | Out-Null
        Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details\*") (Join-Path $Root ".aidlc-rule-details\")
        Write-Success "Cline setup complete (.clinerules)."
        Write-Host "    -> .clinerules\core-workflow.md"
        Write-Host "    -> .aidlc-rule-details\"
    }
}

function Setup-Claude {
    param([string]$RulesPath, [string]$Root)
    Write-Host ""
    Write-Info "Claude Code has two setup options:"
    Write-Host "    1) Project root CLAUDE.md - Recommended"
    Write-Host "    2) .claude\CLAUDE.md directory"
    $claudeOption = Read-Host "  Select option [1/2]"
    if ([string]::IsNullOrWhiteSpace($claudeOption)) { $claudeOption = "1" }

    if ($claudeOption -eq "2") {
        Write-Info "Setting up Claude Code with .claude\CLAUDE.md..."
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".claude") | Out-Null
        Copy-Item -Force (Join-Path $RulesPath "aws-aidlc-rules\core-workflow.md") (Join-Path $Root ".claude\CLAUDE.md")
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".aidlc-rule-details") | Out-Null
        Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details\*") (Join-Path $Root ".aidlc-rule-details\")
        Write-Success "Claude Code setup complete (.claude\CLAUDE.md)."
        Write-Host "    -> .claude\CLAUDE.md"
        Write-Host "    -> .aidlc-rule-details\"
    }
    else {
        Write-Info "Setting up Claude Code with CLAUDE.md..."
        Copy-Item -Force (Join-Path $RulesPath "aws-aidlc-rules\core-workflow.md") (Join-Path $Root "CLAUDE.md")
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".aidlc-rule-details") | Out-Null
        Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details\*") (Join-Path $Root ".aidlc-rule-details\")
        Write-Success "Claude Code setup complete (CLAUDE.md)."
        Write-Host "    -> CLAUDE.md"
        Write-Host "    -> .aidlc-rule-details\"
    }
}

function Setup-Copilot {
    param([string]$RulesPath, [string]$Root)
    Write-Info "Setting up for GitHub Copilot..."
    New-Item -ItemType Directory -Force -Path (Join-Path $Root ".github") | Out-Null
    Copy-Item -Force (Join-Path $RulesPath "aws-aidlc-rules\core-workflow.md") (Join-Path $Root ".github\copilot-instructions.md")
    New-Item -ItemType Directory -Force -Path (Join-Path $Root ".aidlc-rule-details") | Out-Null
    Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details\*") (Join-Path $Root ".aidlc-rule-details\")
    Write-Success "GitHub Copilot setup complete."
    Write-Host "    -> .github\copilot-instructions.md"
    Write-Host "    -> .aidlc-rule-details\"
}

function Setup-Codex {
    param([string]$RulesPath, [string]$Root)
    Write-Info "Setting up for OpenAI Codex..."
    Copy-Item -Force (Join-Path $RulesPath "aws-aidlc-rules\core-workflow.md") (Join-Path $Root "AGENTS.md")
    New-Item -ItemType Directory -Force -Path (Join-Path $Root ".aidlc-rule-details") | Out-Null
    Copy-Item -Recurse -Force (Join-Path $RulesPath "aws-aidlc-rule-details\*") (Join-Path $Root ".aidlc-rule-details\")
    Write-Success "OpenAI Codex setup complete."
    Write-Host "    -> AGENTS.md"
    Write-Host "    -> .aidlc-rule-details\"
}

# --- Main --------------------------------------------------------------------
function Main {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║          AI-DLC Setup - Automated Installer             ║" -ForegroundColor Cyan
    Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Info "This script sets up AI-DLC rules for your coding agent."
    Write-Info "Run this from your project root directory."
    Write-Host ""

    $root = Get-ProjectRoot
    $result = Get-AidlcRules
    $rulesPath = $result.Path
    $agents = Select-Agent

    Write-Header "Step 3: Installing Rules"

    foreach ($agent in $agents) {
        Write-Host ""
        switch ($agent) {
            "kiro"    { Setup-Kiro -RulesPath $rulesPath -Root $root }
            "amazonq" { Setup-AmazonQ -RulesPath $rulesPath -Root $root }
            "cursor"  { Setup-Cursor -RulesPath $rulesPath -Root $root }
            "cline"   { Setup-Cline -RulesPath $rulesPath -Root $root }
            "claude"  { Setup-Claude -RulesPath $rulesPath -Root $root }
            "copilot" { Setup-Copilot -RulesPath $rulesPath -Root $root }
            "codex"   { Setup-Codex -RulesPath $rulesPath -Root $root }
        }
    }

    # Cleanup temp directory if used
    if ($result.TmpDir -and (Test-Path $result.TmpDir)) {
        Remove-Item -Recurse -Force $result.TmpDir
    }

    Write-Header "Setup Complete"
    Write-Host ""
    Write-Success "AI-DLC rules have been installed successfully."
    Write-Host ""
    Write-Info "Next steps:"
    Write-Host "    1. Open your project in your coding agent"
    Write-Host "    2. Start a chat with: `"Using AI-DLC, ...`""
    Write-Host "    3. The workflow will guide you from there"
    Write-Host ""
    Write-Info "For verification steps, see: https://github.com/$REPO#platform-specific-setup"
    Write-Host ""
}

Main
