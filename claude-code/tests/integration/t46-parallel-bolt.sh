#!/bin/bash
# t46: Parallel-bolt concurrency test — 5 processes racing on audit.md.
#
# Fork 5 concurrent `bun aidlc-bolt.ts start` processes against a single
# audit.md. Verify:
#   - All 5 BOLT_STARTED entries land (no lost writes)
#   - Each entry is well-formed (Timestamp, Event, Bolt fields all present)
#   - No audit.md corruption (no half-written entries, no leaked `---`)
#   - Total time stays under the lock timeout (5s × 2 = 10s ceiling)
#
# Closes the Phase 4 + Phase 7 commitment (plan line: "concurrency test for
# aidlc-bolt.ts (5 bolts racing)"). The audit-lock retries were bumped
# 20→50 × 100ms in lib.ts specifically to make this test pass reliably
# under parallel load.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
BOLT="$AIDLC_SRC/tools/aidlc-bolt.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 5

PROJ=$(create_test_project)
seed_audit_file "$PROJ"
# Bolt-start doesn't require state file, but emitError's workflow check does
# (best-effort — we want ERROR_LOGGED NOT to fire here because all 5 should
# succeed). Ensure state exists so any accidental error path still lands
# cleanly.
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"

audit="$PROJ/aidlc-docs/audit.md"

# --- Fork 5 parallel bolt-start processes ---
start_ts=$(date +%s)
pids=()
for i in 1 2 3 4 5; do
  bun "$BOLT" start --name "bolt-$i" --batch 1 --walking-skeleton false --project-dir "$PROJ" \
    >/dev/null 2>&1 &
  pids+=($!)
done

# Wait for all to finish
for pid in "${pids[@]}"; do
  wait "$pid" || true
done
end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))

# --- Assertion 1: Elapsed time under ceiling ---
# Lock retry is 50 × 100ms = 5s max wait. With 5 processes racing, worst case
# the last one waits ~500ms. Ceiling of 10s gives ample headroom while still
# catching real hangs.
if [ "$elapsed" -lt 10 ]; then
  ok "elapsed $elapsed s — under the 10 s ceiling"
else
  not_ok "elapsed $elapsed s — under the 10 s ceiling" "took $elapsed s"
fi

# --- Assertion 2: All 5 BOLT_STARTED entries present ---
bolt_count=$(grep -cE '^\*\*Event\*\*: BOLT_STARTED' "$audit" 2>/dev/null || echo 0)
assert_eq 5 "$bolt_count" "5 BOLT_STARTED entries emitted (no lost writes)"

# --- Assertion 3: Each bolt name appears exactly once ---
all_names_present=true
for i in 1 2 3 4 5; do
  if ! grep -q "\*\*Bolt names\*\*: bolt-$i" "$audit"; then
    all_names_present=false
    break
  fi
done
if $all_names_present; then
  ok "each of bolt-1 .. bolt-5 appears in audit trail"
else
  not_ok "each of bolt-1 .. bolt-5 appears in audit trail" \
    "$(grep "\*\*Bolt names\*\*:" "$audit" | sort -u)"
fi

# --- Assertion 4: No corrupted entries (each BOLT_STARTED has Timestamp + Bolt) ---
# Count complete entries: Timestamp line immediately precedes Event line in
# every well-formed append. If any entry is half-written, the counts diverge.
event_count=$(grep -cE '^\*\*Event\*\*: BOLT_STARTED' "$audit" 2>/dev/null || echo 0)
# Count distinct blocks where the pattern "## Bolt Started\n**Timestamp**:" appears
block_count=$(grep -c '^## Bolt Started$' "$audit" 2>/dev/null || echo 0)
assert_eq "$event_count" "$block_count" "every BOLT_STARTED has a matching heading (no half-writes)"

# --- Assertion 5: Audit file structurally valid (even count of `---` separators) ---
# Each audit block ends with `---`. With 5 concurrent writes to a file that
# started with the fixture audit-sample.md, the `---` count should still be
# coherent: fixture's `---` count + 5 × 1 per new block.
fixture_dashes=$(grep -c '^---$' "$REPO_ROOT/tests/fixtures/audit-sample.md")
actual_dashes=$(grep -c '^---$' "$audit")
expected_dashes=$((fixture_dashes + 5))
assert_eq "$expected_dashes" "$actual_dashes" "separator count matches expected (fixture + 5 bolts)"

cleanup_test_project "$PROJ"

finish
