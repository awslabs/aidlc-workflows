<#
.SYNOPSIS
  Idempotent dependency setup for the synced AI-DLC Windows test tree.

.DESCRIPTION
  Verifies the Windows test prerequisites, installs the repository dependencies
  with Bun, and checks the native Bun terminal and renderer dependencies.

.PARAMETER ProjectDir
  The synced project tree. Default C:\aidlc.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tests\harness\windows\setup.ps1 -ProjectDir C:\aidlc
#>
param(
  [string]$ProjectDir = "C:\aidlc",
  [string]$BunExe = "C:\bun\bin\bun.exe",
  [string]$ClaudeBin = "",
  [string]$GitBash = "C:\Program Files\Git\bin\bash.exe"
)
$ErrorActionPreference = "Stop"

if (-not $ClaudeBin) {
  $ClaudeBin = @(
    "C:\Users\Administrator\.local\bin\claude.exe",
    "C:\Windows\System32\config\systemprofile\.local\bin\claude.exe",
    (Join-Path $env:USERPROFILE ".local\bin\claude.exe")
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $ClaudeBin) { $ClaudeBin = "C:\Users\Administrator\.local\bin\claude.exe" }
}

function Require-Path([string]$path, [string]$what) {
  if (-not (Test-Path $path)) { throw "MISSING PREREQUISITE: $what not found at $path" }
}

Write-Output "=== AI-DLC Windows tui harness setup ==="
Write-Output "ProjectDir: $ProjectDir"

Require-Path $BunExe    "bun"
Require-Path $ClaudeBin "claude CLI"
Require-Path $GitBash   "Git Bash"
Write-Output ("bun {0}; claude present; git-bash present" -f (& $BunExe --version))

if (-not (Test-Path "$ProjectDir\package.json")) {
  throw "No package.json in $ProjectDir - run sync.sh from the repo first to copy the tree up."
}

Set-Location $ProjectDir
Write-Output "=== bun install ==="
& $BunExe install
if ($LASTEXITCODE -ne 0) { throw "bun install failed ($LASTEXITCODE)" }

Write-Output "=== verify native Bun terminal dependencies ==="
& $BunExe -e 'require("@xterm/headless"); if (typeof Bun.Terminal !== "function") throw new Error("Bun.Terminal unavailable"); console.log("DEPS-OK: Bun.Terminal + @xterm/headless")'
if ($LASTEXITCODE -ne 0) { throw "native Bun terminal dependency check failed" }

Write-Output "=== setup complete - run a test with run.ps1 ==="
