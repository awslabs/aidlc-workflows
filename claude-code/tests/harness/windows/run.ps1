<#
.SYNOPSIS
  Run one (or all) AI-DLC `tui` tier test(s) on Windows with the documented
  environment  -  the like-for-like-with-a-user run recipe.

.DESCRIPTION
  Sets only the environment the framework + harness actually require on Windows
  (docs/guide/01-getting-started.md prerequisites + docs/reference/09-testing.md tui
  mechanism), then invokes `bun test` on the chosen file. The driver itself spawns
  under node on Windows (node-pty wedges under bun, #748) via the AIDLC_NODE_BIN the
  test reads; bun is only the test runner.

  Deliberately does NOT set NODE_PATH. node-pty + @xterm/headless are resolved from the
  project's own node_modules (populated by setup.ps1 / `npm install`) by walking up
  from tests/harness/tui-drive.ts. NODE_PATH is what bit a prior session; its absence
  here is intentional and load-bearing.

.PARAMETER Test
  A test selector. Either a bare token (e.g. "t27" -> the matching tests/tui file),
  or a full relative path under tests/tui. Default "preflight" (no Bedrock tokens).

.PARAMETER ProjectDir
  The synced project tree. Default C:\aidlc.

.PARAMETER TimeoutS
  AIDLC_TEST_TIMEOUT (seconds)  -  the hang-backstop the tests read, NOT a budget.
  Default 900.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tests\harness\windows\run.ps1 -Test t27
  powershell -ExecutionPolicy Bypass -File tests\harness\windows\run.ps1 -Test preflight
#>
param(
  [string]$Test = "preflight",
  [string]$ProjectDir = "C:\aidlc",
  [int]$TimeoutS = 900
)
$ErrorActionPreference = "Continue"   # let bun own the exit code; don't abort on a test red

$NodeExe = "C:\Program Files\nodejs\node.exe"
$BunExe  = "C:\bun\bin\bun.exe"
$ClaudeDir = "C:\Windows\System32\config\systemprofile\.local\bin"

# --- Resolve the test file from the selector --------------------------------------
Set-Location $ProjectDir
$tuiDir = Join-Path $ProjectDir "tests\tui"
if (Test-Path (Join-Path $ProjectDir $Test)) {
  $testFile = $Test                                   # caller passed a full relative path
} else {
  # bare token: match a file under tests/tui whose name contains the token.
  $match = Get-ChildItem $tuiDir -Filter "*.tui.test.ts" |
           Where-Object { $_.Name -match [regex]::Escape($Test) } |
           Select-Object -First 1
  if (-not $match) { throw "No tui test under tests/tui matching '$Test'" }
  $testFile = "tests/tui/" + $match.Name
}
Write-Output "=== running tui test: $testFile (timeout ${TimeoutS}s) ==="

# --- Environment (documented prerequisites; NODE_PATH intentionally UNSET) ---------
# claude + bun on PATH (statusline hook shells `bun`; claude is the TUI under test).
$env:Path = "$ClaudeDir;C:\bun\bin;" + $env:Path
# node is off PATH on this box -> the driver reads AIDLC_NODE_BIN to spawn under node.
$env:AIDLC_NODE_BIN = $NodeExe
# tui live opt-in + hang-backstop (seconds). The journey terminates on the on-disk
# artifact; this only ever fires as a loud backstop, never as a pass/fail budget.
$env:AIDLC_TUI_LIVE = "1"
$env:AIDLC_TEST_TIMEOUT = "$TimeoutS"
# Bedrock routing (the shipped settings.json defaults; region required).
$env:CLAUDE_CODE_USE_BEDROCK = "1"
$env:AWS_REGION = "us-east-1"
# Belt-and-braces: ensure no stale NODE_PATH leaks in from the parent environment.
Remove-Item Env:\NODE_PATH -ErrorAction SilentlyContinue

# --- Preflight echo so a failed run is self-diagnosing -----------------------------
Write-Output "=== preflight ==="
& claude --version 2>&1 | Select-Object -First 1
& $NodeExe -e "require('node-pty'); require('@xterm/headless'); console.log('DEPS-OK')" 2>&1 | Select-Object -First 1

# --- Run -----------------------------------------------------------------------------
# bun writes its test results to stderr. We redirect 2>&1 to capture them, but render
# each record via ToString() so PowerShell does NOT decorate native stderr lines as
# "bun.exe : ..." NativeCommandError records (cosmetic noise that obscures the real
# pass/fail summary). $LASTEXITCODE is set by bun regardless of the pipeline, so the
# exit code below still reflects the true test result.
Write-Output "=== bun test ==="
& $BunExe test --timeout ($TimeoutS * 1000) $testFile 2>&1 | ForEach-Object { $_.ToString() }
exit $LASTEXITCODE
