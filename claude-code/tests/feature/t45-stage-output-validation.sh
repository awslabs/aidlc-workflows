#!/bin/bash
# t45: Feature test — deterministic validation that stage file outputs are referenced in Steps
# No LLM required — runs aidlc-validate.ts via bun (~1s)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

BUN=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
[ -x "$BUN" ] || { echo "Bail out! bun not found"; exit 1; }

plan 10

VALIDATE="$AIDLC_SRC/tools/aidlc-validate.ts"

for phase in initialization ideation inception construction operation; do
  OUTPUT=$("$BUN" "$VALIDATE" outputs "$phase" 2>&1)
  RC=$?

  # Test 1: tool succeeds
  if [ "$RC" -eq 0 ]; then
    ok "$phase output validation completed"
  else
    not_ok "$phase output validation completed" "aidlc-validate exited with $RC"
  fi

  # Test 2: all outputs found in steps (use bun for cross-platform JSON parsing)
  PASS=$(echo "$OUTPUT" | "$BUN" -e 'const d=JSON.parse(await Bun.stdin.text()); console.log(d.pass?"true":"false")' 2>/dev/null || echo "error")
  if [ "$PASS" = "true" ]; then
    ok "$phase stages: all declared outputs referenced in steps"
  else
    MISSING=$(echo "$OUTPUT" | "$BUN" -e 'const d=JSON.parse(await Bun.stdin.text()); console.log(d.stages.filter(s=>!s.pass).map(s=>s.slug+": "+s.missing.join(", ")).join("; "))' 2>/dev/null || echo "parse error")
    not_ok "$phase stages: all declared outputs referenced in steps" "$MISSING"
  fi
done

finish
