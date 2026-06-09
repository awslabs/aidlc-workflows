#!/bin/bash
# t125: scope files — validScopes() + scope metadata derive from
# .claude/scopes/*.md presence (MR 12).
#
# A scope is now authored as one .claude/scopes/aidlc-<name>.md file
# (frontmatter name/depth/keywords/description, prose body). Dropping a file
# makes the scope valid with no code change; removing one drops it. The
# depth/keywords/description come from the .md frontmatter; the EXECUTE/SKIP
# grid comes from the compiled scope-grid.json.
#
# Assertions (10):
#   1. 9 shipped scope files exist under .claude/scopes/
#   2. each shipped scope file's frontmatter `name` == its slug (filename stem)
#   3. validScopes() == the 9 .md-derived scope names, alphabetical
#   4. loadScopeMetadata() reads depth/keywords/description from frontmatter
#   5. workshop's testStrategy override is read from its .md
#   6. derived loadScopeMapping() depth/keywords/description match the .md
#   7. dropping a new aidlc-<x>.md makes <x> a valid scope (no code change)
#   8. removing all but one .md leaves exactly that scope valid
#   9. detect-scope --from-text resolves a dropped scope's keyword from its .md
#  10. scope-grid.json + .claude/scopes/ name sets agree (every scope authored)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

LIB="$AIDLC_SRC/tools/aidlc-lib.ts"
SCOPES_DIR="$AIDLC_SRC/scopes"
GRID_JSON="$AIDLC_SRC/tools/data/scope-grid.json"

plan 10

# 1. 9 shipped scope files
COUNT=$(ls "$SCOPES_DIR"/aidlc-*.md 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$COUNT" "9" "9 shipped .claude/scopes/aidlc-*.md files exist"

# 2. each file's frontmatter name == filename stem (minus aidlc- prefix)
BAD=""
for f in "$SCOPES_DIR"/aidlc-*.md; do
  stem=$(basename "$f" .md)
  expected="${stem#aidlc-}"
  name=$(bun -e "
    import { scalarField } from '$LIB';
    const raw = require('fs').readFileSync('$f','utf-8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
    console.log(scalarField(fm,'name'));
  " 2>&1 | tail -1)
  [ "$name" = "$expected" ] || BAD="$BAD $expected(!=$name)"
done
if [ -z "$BAD" ]; then
  ok "every shipped scope file's frontmatter name == filename stem"
else
  not_ok "every shipped scope file's frontmatter name == filename stem" "$BAD"
fi

# 3. validScopes() == 9 .md-derived names, alphabetical
EXPECTED="bugfix,enterprise,feature,infra,mvp,poc,refactor,security-patch,workshop"
ACTUAL=$(bun -e "import { validScopes } from '$LIB'; console.log([...validScopes()].join(','));" 2>&1 | tail -1)
assert_eq "$ACTUAL" "$EXPECTED" "validScopes() == 9 scope names from .claude/scopes/*.md, alphabetical"

# 4. loadScopeMetadata reads frontmatter
OUT=$(bun -e "
  import { loadScopeMetadata } from '$LIB';
  const m = loadScopeMetadata();
  console.log(m.bugfix.depth + '|' + m.bugfix.keywords.join(',') + '|' + m.bugfix.description);
" 2>&1 | tail -1)
assert_eq "$OUT" "Minimal|fix,bug,broken|Fix a specific bug" "loadScopeMetadata reads bugfix depth/keywords/description from .md"

# 5. workshop testStrategy override read from .md
OUT=$(bun -e "import { loadScopeMetadata } from '$LIB'; console.log(loadScopeMetadata().workshop.testStrategy);" 2>&1 | tail -1)
assert_eq "$OUT" "Minimal" "workshop testStrategy override read from its .md frontmatter"

# 6. loadScopeMapping derived fields match the .md
OUT=$(bun -e "
  import { loadScopeMapping } from '$LIB';
  const m = loadScopeMapping();
  console.log(m.poc.depth + '|' + (m.poc.keywords || []).join(',') + '|' + m.poc.description);
" 2>&1 | tail -1)
assert_eq "$OUT" "Minimal|proof of concept,prototype,poc,spike|Prove feasibility fast" "loadScopeMapping poc fields derive from .md frontmatter"

# --- Tests 7-9: dropped-file dynamics in an integration sandbox ---
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
PROJ_LIB="$PROJ/.claude/tools/aidlc-lib.ts"
PROJ_UTIL="$PROJ/.claude/tools/aidlc-utility.ts"
PROJ_SCOPES="$PROJ/.claude/scopes"

# 7. dropping a new scope file makes it valid with no code change
cat > "$PROJ_SCOPES/aidlc-dropscope.md" <<'EOF'
---
name: dropscope
depth: Minimal
keywords:
  - dropscopetrigger
description: Dropped scope for t125
---

# dropscope

Proves a dropped .md file becomes a valid scope.
EOF
ACTUAL=$(bun -e "import { validScopes } from '$PROJ_LIB'; console.log([...validScopes()].includes('dropscope') ? 'yes' : 'no');" 2>&1 | tail -1)
assert_eq "$ACTUAL" "yes" "dropping aidlc-dropscope.md makes 'dropscope' a valid scope (no code change)"

# 9. detect-scope --from-text resolves the dropped scope's keyword
bun "$PROJ_UTIL" detect-scope --from-text --input "dropscopetrigger" --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "Detected scope.*: dropscope" "$PROJ/aidlc-docs/audit.md"; then
  ok "detect-scope --from-text resolves dropscope keyword from its .md"
else
  not_ok "detect-scope --from-text resolves dropscope keyword from its .md" \
    "audit: $(tail -15 "$PROJ/aidlc-docs/audit.md")"
fi

# 8. removing all but one .md leaves exactly that scope valid (isolated dir seam)
ISO=$(mktemp -d -t aidlc-t125-iso.XXXXXX)
cp "$PROJ_SCOPES/aidlc-dropscope.md" "$ISO/"
ACTUAL=$(AIDLC_SCOPES_DIR="$ISO" bun -e "
  import { validScopes, _resetScopeMappingForTests } from '$PROJ_LIB';
  _resetScopeMappingForTests();
  console.log([...validScopes()].join(','));
" 2>&1 | tail -1)
assert_eq "$ACTUAL" "dropscope" "isolated .claude/scopes/ with one file yields exactly that scope"
rm -rf "$ISO"
cleanup_test_project "$PROJ"

# 10. scope-grid names ⊆ .claude/scopes/ names (every grid column is authored)
OUT=$(bun -e "
  const grid = Object.keys(JSON.parse(require('fs').readFileSync('$GRID_JSON','utf-8'))).sort();
  const fs = require('fs');
  const files = fs.readdirSync('$SCOPES_DIR').filter(f => f.endsWith('.md')).map(f => f.replace(/^aidlc-/,'').replace(/\.md\$/,'')).sort();
  const orphanCols = grid.filter(c => !files.includes(c));
  console.log(orphanCols.length === 0 ? 'ALL_AUTHORED' : orphanCols.join(','));
" 2>&1 | tail -1)
assert_eq "$OUT" "ALL_AUTHORED" "every scope-grid column has a matching .claude/scopes/*.md file"

finish
