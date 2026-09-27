<#
.SYNOPSIS
  Run the full AI-DLC test suite on Windows through the native Bun runner.

.DESCRIPTION
  This is the MR10 Windows invariance entrypoint. It sets the Windows-specific
  environment the TUI backend requires, then invokes `bun tests/run-tests.ts
  --all --debug -P <N>`. Native Bun is the default TUI backend;
  AIDLC_TUI_BACKEND=node-pty selects the legacy Node driver.
  AIDLC_TUI_LIVE=1 opts into the token-spending TUI journeys. Check per-file
  skips as well as the final result to establish coverage.

.PARAMETER ProjectDir
  Synced repo directory. Default C:\aidlc.

.PARAMETER Parallel
  Runner parallelism passed to -P. Default 8.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\aidlc\tests\harness\windows\run-all.ps1 -ProjectDir C:\aidlc -Parallel 8
#>
param(
  [string]$ProjectDir = "C:\aidlc",
  [int]$Parallel = 8
)
$ErrorActionPreference = "Continue"

$GitBash = "C:\Program Files\Git\bin\bash.exe"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$BunExe = "C:\bun\bin\bun.exe"

# The claude native installer drops claude.exe under the INSTALLING user's
# ~\.local\bin. Under EC2Launch v2 UserData that user is Administrator; on a
# box bootstrapped as SYSTEM it is the systemprofile. Probe the known homes.
$ClaudeDirCandidates = @(
  "C:\Users\Administrator\.local\bin",
  "C:\Windows\System32\config\systemprofile\.local\bin",
  (Join-Path $env:USERPROFILE ".local\bin")
)
$ClaudeDir = $ClaudeDirCandidates | Where-Object { Test-Path (Join-Path $_ "claude.exe") } | Select-Object -First 1

function Require-Path([string]$Path, [string]$What) {
  if (-not (Test-Path $Path)) { throw "MISSING PREREQUISITE: $What not found at $Path" }
}

Require-Path $ProjectDir "project directory"
Require-Path $GitBash "Git Bash"
Require-Path $NodeExe "node"
Require-Path $BunExe "bun"
if (-not $ClaudeDir) { throw "MISSING PREREQUISITE: claude CLI not found in any of: $($ClaudeDirCandidates -join '; ')" }

$env:Path = "$ClaudeDir;C:\bun\bin;C:\Program Files\nodejs;C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;" + $env:Path
$env:AIDLC_NODE_BIN = $NodeExe
$env:AIDLC_BUN_BIN = $BunExe
$env:AIDLC_TUI_LIVE = "1"
$env:CLAUDE_CODE_USE_BEDROCK = "1"
if (-not $env:AWS_REGION) { $env:AWS_REGION = "us-east-1" }
Remove-Item Env:\NODE_PATH -ErrorAction SilentlyContinue

Set-Location $ProjectDir
Write-Output "=== AI-DLC Windows --all ==="
Write-Output "ProjectDir: $ProjectDir"
Write-Output "AIDLC_NODE_BIN: $env:AIDLC_NODE_BIN"
Write-Output "AIDLC_TUI_LIVE: $env:AIDLC_TUI_LIVE"
Write-Output "Parallel: $Parallel"
Write-Output "=== preflight ==="
& $BunExe --version
& $NodeExe --version
& claude --version 2>&1 | Select-Object -First 1
& $BunExe -e 'import { selectedTuiBackend, tuiUnavailableReason } from "./tests/harness/tui-runtime.ts"; const reason = tuiUnavailableReason(); if (reason) throw new Error(reason); console.log("TUI-OK: " + selectedTuiBackend());' 2>&1 | ForEach-Object { $_.ToString() }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output "=== bun tests/run-tests.ts --all --debug -P $Parallel ==="
$RunOut = Join-Path $ProjectDir "tests\logs\windows-run-all-wrapper.out.log"
$RunErr = Join-Path $ProjectDir "tests\logs\windows-run-all-wrapper.err.log"
New-Item -ItemType Directory -Force -Path (Split-Path $RunOut -Parent) | Out-Null
$Runner = Start-Process `
  -FilePath $BunExe `
  -ArgumentList @("tests/run-tests.ts", "--all", "--debug", "-P", "$Parallel") `
  -WorkingDirectory $ProjectDir `
  -NoNewWindow `
  -PassThru `
  -Wait `
  -RedirectStandardOutput $RunOut `
  -RedirectStandardError $RunErr
if (Test-Path $RunOut) { Get-Content $RunOut | ForEach-Object { $_.ToString() } }
if (Test-Path $RunErr) { Get-Content $RunErr | ForEach-Object { $_.ToString() } }
exit $Runner.ExitCode
