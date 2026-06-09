#!/bin/bash
# t68: Validates AIDLC_VERSION in aidlc-version.ts agrees with the latest CHANGELOG.md heading,
# the matching link reference is present, no duplicate version headings exist (post-rebase
# guard), the wired CLI prints what version.ts declares (catches handler-rename or
# import drift), and the README.md version badge matches version.ts (catches a stale
# public-facing badge — the v0.5.0 release missed this). (6 tests)
# Pure bash, plus one bun invocation for the CLI wiring assertion (L1)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

VERSION_TS="$AIDLC_SRC/tools/aidlc-version.ts"
CHANGELOG="$REPO_ROOT/CHANGELOG.md"
UTILITY_TS="$AIDLC_SRC/tools/aidlc-utility.ts"
README="$REPO_ROOT/README.md"

plan 6

# --- Extract AIDLC_VERSION literal from version.ts ---
# Matches: export const AIDLC_VERSION = "0.3.1";
# `head -1` defends against merge-conflict markers leaving two assignments.
TS_VERSION=$(grep -oE 'AIDLC_VERSION = "[0-9]+\.[0-9]+\.[0-9]+"' "$VERSION_TS" \
  | head -1 \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

# Test 1: extracted exactly one non-empty version
DUP_TS=$(grep -cE 'AIDLC_VERSION = "[0-9]+\.[0-9]+\.[0-9]+"' "$VERSION_TS" || echo 0)
if [ -n "$TS_VERSION" ] && [ "$DUP_TS" = "1" ]; then
  ok "extracted AIDLC_VERSION=$TS_VERSION from version.ts (single assignment)"
else
  not_ok "extracted AIDLC_VERSION from version.ts (single assignment)" \
    "value='$TS_VERSION' assignment_count=$DUP_TS"
fi

# --- Extract latest ## [N.N.N] heading from CHANGELOG.md ---
# CHANGELOG is reverse-chronological; the FIRST ## heading is the latest release.
CL_VERSION=$(grep -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$CHANGELOG" \
  | head -1 \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

# Test 2: AIDLC_VERSION matches the latest CHANGELOG heading
assert_eq "$TS_VERSION" "$CL_VERSION" "AIDLC_VERSION matches latest CHANGELOG heading"

# Test 3: matching [N.N.N]: link reference exists at the bottom of CHANGELOG
if grep -qE "^\[${TS_VERSION}\]:" "$CHANGELOG"; then
  ok "[$TS_VERSION]: link reference present in CHANGELOG.md"
else
  not_ok "[$TS_VERSION]: link reference present in CHANGELOG.md" \
    "no line matching ^\\[$TS_VERSION\\]: in $CHANGELOG"
fi

# Test 4: heading-count == link-reference-count (catches duplicate headings post-rebase
# OR an orphaned heading without a matching link reference). A botched rebase that leaves
# two `## [0.3.1]` blocks fails here even when test 2 passes.
HEADING_COUNT=$(grep -cE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$CHANGELOG" || echo 0)
LINKREF_COUNT=$(grep -cE '^\[[0-9]+\.[0-9]+\.[0-9]+\]:' "$CHANGELOG" || echo 0)
if [ "$HEADING_COUNT" = "$LINKREF_COUNT" ] && [ "$HEADING_COUNT" -gt 0 ]; then
  ok "## [N.N.N] heading count ($HEADING_COUNT) == [N.N.N]: link-ref count ($LINKREF_COUNT)"
else
  not_ok "## [N.N.N] heading count == [N.N.N]: link-ref count" \
    "headings=$HEADING_COUNT linkrefs=$LINKREF_COUNT"
fi

# Test 5: CLI wiring — `bun aidlc-utility.ts version` prints `aidlc <CL_VERSION>`.
# Catches a renamed constant, a broken import, a switch-case typo, or a missing
# version.ts. The static import in aidlc-utility.ts means a missing file throws on
# any subcommand, but invoking `version` specifically asserts the handler is wired.
CLI_OUT=$(bun "$UTILITY_TS" version 2>&1 || echo "EXIT_NONZERO")
EXPECTED="aidlc $CL_VERSION"
if [ "$CLI_OUT" = "$EXPECTED" ]; then
  ok "bun aidlc-utility.ts version prints '$EXPECTED'"
else
  not_ok "bun aidlc-utility.ts version prints '$EXPECTED'" \
    "got: $CLI_OUT"
fi

# Test 6: README.md version badge matches version.ts. The shields.io badge
# (![version](https://img.shields.io/badge/version-<V>-blue)) is the public,
# human-facing version on the repo front page; a release that bumps version.ts
# but forgets the badge ships a wrong number to every reader. The v0.5.0
# release missed exactly this. Extract <V> from between `version-` and `-blue`.
README_VERSION=$(grep -oE 'badge/version-[0-9]+\.[0-9]+\.[0-9]+-blue' "$README" \
  | head -1 \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
assert_eq "$README_VERSION" "$TS_VERSION" "README.md version badge matches aidlc-version.ts ($TS_VERSION)"

finish
