<#
.SYNOPSIS
  One-time (idempotent) setup of a Windows box to run the AI-DLC `tui` test tier
  exactly the way the project's own install instructions prescribe  -  like-for-like
  with a real user's environment.

.DESCRIPTION
  The `tui` tier drives the real `claude` TUI through node-pty + @xterm/headless on
  Windows (docs/reference/09-testing.md "The tui Mechanism"). Those two modules are
  declared as `devDependencies` in the repo's root package.json and  -  per
  09-testing.md:100-101  -  MUST be installed with **npm** (a bun-installed node-pty is
  not resolvable by node, which is the runtime the Windows driver uses because
  node-pty's input wedges under bun, microsoft/node-pty#748).

  So setup is just: run `npm install` in the synced project tree. node then resolves
  `node-pty` / `@xterm/headless` by walking up from tests/harness/tui-drive.ts to the
  project's own node_modules  -  NO NODE_PATH games (the failure mode that cost a prior
  session was pointing NODE_PATH at a tree that had only one of the two modules).

  Prerequisites that must already be on the box (the framework's documented
  prerequisites, docs/guide/01-getting-started.md): claude.exe, bun, node. This script
  verifies them and fails loud if any is missing  -  it does not install them.

.PARAMETER ProjectDir
  The synced project tree (where sync.sh deposited the git-archive). Default C:\aidlc.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tests\harness\windows\setup.ps1
#>
param(
  [string]$ProjectDir = "C:\aidlc"
)
$ErrorActionPreference = "Stop"

# --- Canonical tool locations on this box (docs: project_v0harness_windows_ec2_box).
# node is frequently installed yet OFF PATH on Windows; resolve the concrete binary.
$NodeExe = "C:\Program Files\nodejs\node.exe"
$NpmCmd  = "C:\Program Files\nodejs\npm.cmd"
$BunExe  = "C:\bun\bin\bun.exe"
$ClaudeBin = "C:\Windows\System32\config\systemprofile\.local\bin\claude.exe"

function Require-Path([string]$path, [string]$what) {
  if (-not (Test-Path $path)) { throw "MISSING PREREQUISITE: $what not found at $path" }
}

Write-Output "=== AI-DLC Windows tui harness setup ==="
Write-Output "ProjectDir: $ProjectDir"

# --- 1. Verify the documented prerequisites are present (install them out-of-band).
Require-Path $NodeExe   "node"
Require-Path $NpmCmd    "npm (ships with node)"
Require-Path $BunExe    "bun"
Require-Path $ClaudeBin "claude CLI"
Write-Output ("node {0}; npm {1}; bun {2}; claude present" -f `
  (& $NodeExe --version), (& $NpmCmd --version), (& $BunExe --version))

if (-not (Test-Path "$ProjectDir\package.json")) {
  throw "No package.json in $ProjectDir  -  run sync.sh from the repo first to copy the tree up."
}

# --- 2. Install the test devDependencies with npm (node-pty + @xterm/headless),
#        into the project's OWN node_modules  -  the documented, NODE_PATH-free setup.
Set-Location $ProjectDir

# Clear any partial node_modules from a prior failed install (avoids EPERM rmdir
# churn and a half-built node-pty). Best-effort; npm will recreate it.
if (Test-Path "$ProjectDir\node_modules") {
  Write-Output "=== clearing prior node_modules ==="
  Remove-Item -Recurse -Force "$ProjectDir\node_modules" -ErrorAction SilentlyContinue
}

# node-pty has a NATIVE build step (node scripts/prebuild.js || node-gyp rebuild)
# that npm runs as a child `cmd /c node ...`. node is installed on this box but OFF
# PATH (the documented quirk), so that child build fails "'node' is not recognized".
# A normal Windows user has node on PATH (the installer adds it), so the faithful
# setup is to put node's own directory on PATH for the install. This mirrors how the
# driver reads AIDLC_NODE_BIN for the off-PATH node at run time.
$NodeDir = Split-Path $NodeExe -Parent
$env:Path = "$NodeDir;" + $env:Path
Write-Output "=== npm install (node-pty + @xterm/headless from package.json devDependencies) ==="
Write-Output "node dir on PATH for native build: $NodeDir"
& $NpmCmd install
if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }

# --- 3. Verify node can resolve BOTH modules from the project node_modules with NO
#        NODE_PATH set  -  the exact resolution the daemon relies on. A miss here is the
#        real failure surface, caught now rather than as a mid-run empty capture.
Write-Output "=== verify node resolves both modules from project node_modules (no NODE_PATH) ==="
$env:NODE_PATH = $null
& $NodeExe -e "require('node-pty'); require('@xterm/headless'); console.log('DEPS-OK: node-pty + @xterm/headless resolvable')"
if ($LASTEXITCODE -ne 0) { throw "dependency resolution check failed  -  node could not require both modules" }

Write-Output "=== setup complete  -  run a test with run.ps1 ==="
