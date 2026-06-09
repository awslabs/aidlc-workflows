#!/bin/bash
# t04: Guard two shell anti-patterns that have bitten the harness before.
#
# Pattern A — trailing `[ ... ] && action` as the LAST line of a function body
# with no `|| fallback`. Under `set -e`, a falsy `[` exit propagates through
# the function return and kills the caller mid-script. See #34 (tap.sh
# `not_ok` helper killed multi-case tests mid-plan). Guard scope: function
# bodies only — the AND-OR pattern is safe elsewhere.
#
# Pattern B — `$VAR` adjacent to a non-ASCII character without `${...}`
# braces. Under `set -u`, bash reads the UTF-8 continuation bytes as part of
# the identifier and exits with "unbound variable". See #41 (t21b `→`
# arrow crashed the script before assertions could fire).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

TESTS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

plan 2

# Pattern A — scan function bodies for a trailing `[ ... ] && action` whose
# next non-blank, non-comment line is the function-closing `}`. Relies on
# tests/ following the convention of putting `}` on its own line at column
# zero — which holds throughout the suite.
pattern_a_hits=""
while IFS= read -r -d '' file; do
  hits=$(awk '
    function is_candidate(s) {
      return match(s, /^[[:space:]]*\[[^]]*\][[:space:]]*&&[[:space:]]*[^|&]+$/) \
          && index(s, "||") == 0 \
          && s !~ /^[[:space:]]*#/
    }
    # Enter function body on `name() {` line. Record any candidate line seen.
    # On closing `}` at column 0, emit if the candidate was the most recent
    # non-blank/non-comment line.
    /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(\)[[:space:]]*\{?[[:space:]]*$/ {
      in_fn = 1; last_cand = 0; last_code = 0; next
    }
    in_fn && /^\}[[:space:]]*$/ {
      if (last_cand > 0 && last_cand == last_code) {
        print FILENAME ":" last_cand ": trailing [..] && in function body"
      }
      in_fn = 0; next
    }
    in_fn {
      if ($0 ~ /^[[:space:]]*$/) next
      if ($0 ~ /^[[:space:]]*#/) next
      last_code = NR
      if (is_candidate($0)) last_cand = NR
    }
  ' "$file")
  if [ -n "$hits" ]; then
    pattern_a_hits="${pattern_a_hits}${hits}
"
  fi
done < <(find "$TESTS_ROOT" -name "*.sh" -type f -print0)

if [ -z "$pattern_a_hits" ]; then
  ok "no trailing '[ ... ] && action' as last line of a function body (#34 guard)"
else
  not_ok "no trailing '[ ... ] && action' as last line of a function body (#34 guard)" \
    "$(printf '%s' "$pattern_a_hits" | head -5)"
fi

# Pattern B — `$VAR` immediately followed by a non-printable-ASCII byte
# (no braces). Uses awk for portability: BSD grep on macOS lacks `-P` (PCRE).
# `[^ -~\t]` means "any byte outside printable ASCII + tab" — catches the
# UTF-8 leading bytes of `→`, `—`, emoji, etc.
pattern_b_hits=$(find "$TESTS_ROOT" -name "*.sh" -type f -print0 \
  | LC_ALL=C xargs -0 awk '
    /\$[A-Za-z_][A-Za-z0-9_]*[^ -~\t]/ {
      if ($0 ~ /^[[:space:]]*#/) next
      print FILENAME ":" FNR ": " $0
    }
  ' 2>/dev/null || true)

if [ -z "$pattern_b_hits" ]; then
  ok "no unbraced \$VAR adjacent to non-ASCII characters (#41 guard)"
else
  not_ok "no unbraced \$VAR adjacent to non-ASCII characters (#41 guard)" \
    "$(printf '%s' "$pattern_b_hits" | head -5)"
fi

finish
