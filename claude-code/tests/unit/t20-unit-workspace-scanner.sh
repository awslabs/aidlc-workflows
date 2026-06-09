#!/bin/bash
# t20: Unit tests for deterministic workspace scanner inside aidlc-utility init
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-utility.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 21

# --- Test 1-2: empty directory → Greenfield, Unknown languages/frameworks ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-scanner-XXXXXX")
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
STATE="$PROJ/aidlc-docs/aidlc-state.md"
assert_grep "$STATE" '\*\*Project Type\*\*: Greenfield' "empty dir classified Greenfield"
assert_grep "$STATE" '\*\*Languages\*\*: Unknown' "empty dir: Languages=Unknown"
cleanup_test_project "$PROJ"
unset PROJ STATE

# --- Test 3-6: realistic React+TS app → Brownfield, TS+React+npm ---
# This setup triggers multiple brownfield signals (deps, source file, source
# dir, lockfile) — complementary isolated tests follow to pin each branch.
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-scanner-XXXXXX")
cat > "$PROJ/package.json" <<'PKG'
{
  "name": "todo-app",
  "dependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
PKG
touch "$PROJ/package-lock.json"
mkdir -p "$PROJ/src"
echo 'export const App = () => <div>hi</div>;' > "$PROJ/src/App.tsx"
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
STATE="$PROJ/aidlc-docs/aidlc-state.md"
assert_grep "$STATE" '\*\*Project Type\*\*: Brownfield' "node app classified Brownfield"
assert_grep "$STATE" '^- \*\*Languages\*\*:.*TypeScript' "node app: Languages field lists TypeScript"
assert_grep "$STATE" '^- \*\*Frameworks\*\*:.*React' "node app: Frameworks field lists React"
assert_grep "$STATE" '^- \*\*Build System\*\*: npm (package.json)' "node app: Build System is npm (package.json)"
cleanup_test_project "$PROJ"
unset PROJ STATE

# --- Test 7-8: bare `dependencies` only (no src/, no lockfile) pins hasNonDevDeps ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-scanner-XXXXXX")
cat > "$PROJ/package.json" <<'PKG'
{
  "name": "deps-only",
  "dependencies": { "react": "^18.0.0" }
}
PKG
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
STATE="$PROJ/aidlc-docs/aidlc-state.md"
assert_grep "$STATE" '\*\*Project Type\*\*: Brownfield' "deps-only package.json → Brownfield (pins hasNonDevDeps)"
assert_grep "$STATE" '\*\*Languages\*\*: Unknown' "deps-only: no source files → Languages Unknown"
cleanup_test_project "$PROJ"
unset PROJ STATE

# --- Test 9-10: bare src/App.tsx (no package.json) pins hasSourceFiles ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-scanner-XXXXXX")
mkdir -p "$PROJ/src"
echo 'export const App = () => <div>hi</div>;' > "$PROJ/src/App.tsx"
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
STATE="$PROJ/aidlc-docs/aidlc-state.md"
assert_grep "$STATE" '\*\*Project Type\*\*: Brownfield' "bare src/App.tsx → Brownfield (pins hasSourceFiles)"
assert_grep "$STATE" '^- \*\*Languages\*\*:.*TypeScript' "bare src/App.tsx: Languages=TypeScript"
cleanup_test_project "$PROJ"
unset PROJ STATE

# --- Test 11-13: package.json with only devDependencies → Greenfield (scaffolding) ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-scanner-XXXXXX")
cat > "$PROJ/package.json" <<'PKG'
{
  "name": "scaffold",
  "devDependencies": {
    "prettier": "^3.0.0"
  }
}
PKG
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
STATE="$PROJ/aidlc-docs/aidlc-state.md"
assert_grep "$STATE" '\*\*Project Type\*\*: Greenfield' "devDeps-only package.json is Greenfield"
assert_grep "$STATE" '\*\*Languages\*\*: Unknown' "devDeps-only: no source languages"
assert_grep "$STATE" '^- \*\*Build System\*\*: npm (package.json)' "devDeps-only: Build System is npm (package.json)"
cleanup_test_project "$PROJ"
unset PROJ STATE

# --- Test 14-16: pyproject.toml with poetry → Brownfield Python ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-scanner-XXXXXX")
cat > "$PROJ/pyproject.toml" <<'TOML'
[tool.poetry]
name = "hello"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
TOML
mkdir -p "$PROJ/src"
echo 'print("hi")' > "$PROJ/src/app.py"
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
STATE="$PROJ/aidlc-docs/aidlc-state.md"
assert_grep "$STATE" '\*\*Project Type\*\*: Brownfield' "python project Brownfield"
assert_grep "$STATE" '^- \*\*Languages\*\*:.*Python' "python: Languages field lists Python"
assert_grep "$STATE" '^- \*\*Build System\*\*: poetry (pyproject.toml)' "python: Build System is poetry (pyproject.toml)"
cleanup_test_project "$PROJ"
unset PROJ STATE

# --- Test 17-21: --force semantics, orphan warning, noise-file filter ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-scanner-XXXXXX")
# First init
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"
WORKFLOWS_BEFORE=$(grep -c "^\*\*Event\*\*: WORKFLOW_STARTED" "$AUDIT" || true)

# No-force retry errors
RC_RETRY=0
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1 || RC_RETRY=$?
assert_gt "$RC_RETRY" 0 "no-force retry exits non-zero"

# --force succeeds
bun "$TOOL" init --scope poc --project-dir "$PROJ" --force >/dev/null 2>&1
assert_file_exists "$STATE" "--force reinit: state still exists"

# Audit kept + gained a WORKFLOW_STARTED on re-init (SESSION_* is hook-owned now)
WORKFLOWS_AFTER=$(grep -c "^\*\*Event\*\*: WORKFLOW_STARTED" "$AUDIT" || true)
assert_gt "$WORKFLOWS_AFTER" "$WORKFLOWS_BEFORE" "--force adds fresh WORKFLOW_STARTED ($WORKFLOWS_BEFORE → $WORKFLOWS_AFTER)"

# Orphan warning: seed a non-init artifact, run --force, expect warning on stderr
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
echo "# intent" > "$PROJ/aidlc-docs/ideation/intent-capture/intent.md"
STDERR=$(bun "$TOOL" init --scope poc --project-dir "$PROJ" --force 2>&1 >/dev/null)
assert_contains "$STDERR" "non-init artifacts" "--force warns when orphan artifacts present"

# .DS_Store must NOT appear in the orphan warning (macOS Finder noise)
touch "$PROJ/aidlc-docs/ideation/intent-capture/.DS_Store"
STDERR=$(bun "$TOOL" init --scope poc --project-dir "$PROJ" --force 2>&1 >/dev/null)
if echo "$STDERR" | grep -q "\.DS_Store"; then
  not_ok "orphan warning filters .DS_Store" "found .DS_Store in stderr"
else
  ok "orphan warning filters .DS_Store"
fi

cleanup_test_project "$PROJ"
unset PROJ STATE AUDIT SESSIONS_BEFORE SESSIONS_AFTER RC_RETRY STDERR

finish
