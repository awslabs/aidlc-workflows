#!/bin/bash
# t86: Validates sensor manifest schema for the 4 framework sensors + negative-case fixtures (28 tests)
#
# Asserts the schema MR 7b freezes for the v0.5.0 pull-authoring sensor
# namespace (post applies_to removal):
#   - .claude/sensors/ directory exists with exactly 4 framework manifests
#   - Each manifest carries the required frontmatter fields
#   - id matches filename stem (filename↔id contract)
#   - kind == deterministic (only valid v0.5.0 enum value)
#   - command points at the per-sensor script (canonical execution shape)
#   - applies_to is absent (pull authoring puts scope on the stage side)
#   - default_severity and description present
#
# Negative-case fixtures under tests/fixtures/v05-mr3-sensors-dir/ —
# preserved as-is to exercise schema rejection for files written under
# the old shape; the validators reject them (kind != deterministic,
# missing required fields).
#
# Walk-scope: production manifests via $AIDLC_SRC/sensors/ (existence + per-file
# shape); fixture manifests passed as explicit file paths so they're never
# counted toward the "4 manifests" assertion.
#
# Pure bash — no bun or claude required (L1).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SENSORS_DIR="$AIDLC_SRC/sensors"
FIXTURES_DIR="$SCRIPT_DIR/../fixtures/v05-mr3-sensors-dir"

# The 4 framework manifests, paired with their expected frontmatter id.
# id MUST equal filename stem minus the aidlc- prefix and the .md suffix.
SENSOR_NAMES="required-sections upstream-coverage linter type-check"

plan 28

# ============================================================
# Part 1: Directory + file-existence (5 tests)
# ============================================================

assert_dir_exists "$SENSORS_DIR" ".claude/sensors/ directory exists"

for name in $SENSOR_NAMES; do
  assert_file_exists "$SENSORS_DIR/aidlc-$name.md" "manifest aidlc-$name.md exists"
done

# ============================================================
# Part 2: Per-manifest frontmatter shape (4 manifests × 5 checks = 20 tests)
# ============================================================

# extract_field FILE FIELDNAME -> prints the right-hand side (after `: `) for
# the first frontmatter line whose key matches FIELDNAME, OR empty.
extract_field() {
  local file="$1"
  local field="$2"
  # Restrict to the frontmatter block (between first two `---` lines).
  awk -v fld="$field" '
    /^---$/ { fm = !fm; next }
    fm && $1 == fld":" { sub("^[^:]+: *", ""); print; exit }
  ' "$file"
}

# has_frontmatter_field FILE FIELDNAME -> 0 if a top-level frontmatter line
# `<field>:` exists, 1 otherwise. Recognises both `field: value` (scalar) and
# `field:` (block start) forms.
has_frontmatter_field() {
  local file="$1"
  local field="$2"
  awk -v fld="$field" '
    /^---$/ { fm = !fm; next }
    fm && $0 ~ "^"fld":" { found = 1; exit }
    END { exit !found }
  ' "$file"
}

# manifest_has_applies_to FILE -> 0 if applies_to is present (legacy push
# shape), 1 otherwise. Pull-authoring schema disallows this field; the
# resolver gets no information from it.
manifest_has_applies_to() {
  local file="$1"
  has_frontmatter_field "$file" "applies_to"
}

for name in $SENSOR_NAMES; do
  file="$SENSORS_DIR/aidlc-$name.md"

  # Check 1: id field present and equals the expected slug
  id_value=$(extract_field "$file" "id")
  assert_eq "$id_value" "$name" "aidlc-$name.md: id matches filename stem"

  # Check 2: kind == deterministic
  kind_value=$(extract_field "$file" "kind")
  assert_eq "$kind_value" "deterministic" "aidlc-$name.md: kind is deterministic"

  # Check 3: command points at the per-sensor script (canonical execution shape).
  # Pull authoring at the execution level: each manifest declares HOW the
  # sensor runs via `command:` pointing at its own per-sensor script. The
  # dispatcher reads this and resolves the script sibling-style at fire time.
  command_value=$(extract_field "$file" "command")
  expected_command="bun .claude/tools/aidlc-sensor-$name.ts"
  assert_eq "$command_value" "$expected_command" "aidlc-$name.md: command points at per-sensor script"

  # Check 4: applies_to is ABSENT (pull authoring removed the field;
  # scope now lives on the stage side via stage.sensors[]).
  if ! manifest_has_applies_to "$file"; then
    ok "aidlc-$name.md: applies_to absent (pull authoring)"
  else
    not_ok "aidlc-$name.md: applies_to absent (pull authoring)" "applies_to still present"
  fi

  # Check 5: default_severity and description present
  if has_frontmatter_field "$file" "default_severity" && has_frontmatter_field "$file" "description"; then
    ok "aidlc-$name.md: default_severity and description present"
  else
    not_ok "aidlc-$name.md: default_severity and description present" "one or both missing"
  fi
done

# ============================================================
# Part 3: Negative-case fixtures rejected by schema (3 tests)
# ============================================================

# Negative case A: kind: arbitrary-bogus -> kind != deterministic so
# the schema's kind check should fail (i.e., extract_field returns
# something other than "deterministic").
neg_a="$FIXTURES_DIR/malformed-unknown-kind.md"
neg_a_kind=$(extract_field "$neg_a" "kind")
if [ "$neg_a_kind" != "deterministic" ]; then
  ok "negative: malformed-unknown-kind.md kind != deterministic (rejected by schema)"
else
  not_ok "negative: malformed-unknown-kind.md kind != deterministic (rejected by schema)" "got 'deterministic' which would PASS"
fi

# Negative case B: applies_to: {} fixture predates pull authoring. Pull
# authoring rejects ANY applies_to entry; the legacy fixture is
# rejected for that reason regardless of whether it carried a base
# shape.
neg_b="$FIXTURES_DIR/malformed-empty-applies-to.md"
if manifest_has_applies_to "$neg_b"; then
  ok "negative: malformed-empty-applies-to.md still carries applies_to (rejected — field gone in pull authoring)"
else
  not_ok "negative: malformed-empty-applies-to.md still carries applies_to (rejected — field gone in pull authoring)" "fixture missing applies_to entirely"
fi

# Negative case C: id field absent -> extract_field returns empty.
neg_c="$FIXTURES_DIR/malformed-missing-id.md"
neg_c_id=$(extract_field "$neg_c" "id")
if [ -z "$neg_c_id" ]; then
  ok "negative: malformed-missing-id.md id absent (rejected by schema)"
else
  not_ok "negative: malformed-missing-id.md id absent (rejected by schema)" "id unexpectedly found: '$neg_c_id'"
fi

finish
