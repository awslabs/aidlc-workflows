#!/bin/bash
# t130 (feature): Scope-runners drive the engine with their baked scope. For
# each first-batch runner (bugfix, feature, mvp, security-patch) this seeds a
# real `--test-run` init under that scope, then runs the SAME first move the
# runner's shell makes — `aidlc-orchestrate next --scope <scope>` — and asserts
# the engine resolves a real `run-stage` directive for that scope's first
# EXECUTE stage AND bakes the shared conductor persona into the first directive
# (decision D-E: the runner does not load the persona by hand; the engine
# delivers it). The full drive-to-done shape is proven exhaustively per scope by
# t118's differential corpus; this test pins that the runner's baked-scope first
# move reaches the engine and carries the persona. Pure bash + bun, NO LLM,
# no model — runs in the --ci gate. (12 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$REPO_ROOT/dist/claude/.claude"
SKILLS_DIR="$SRC/skills"

# Per first-batch scope: the first EXECUTE stage the engine resolves on a fresh
# greenfield --test-run init (measured against the live engine; the brownfield
# conditional stages SKIP on an empty workspace, so security-patch's
# reverse-engineering is greenfield-skipped and the engine lands on the first
# Construction Bolt). scope|expected-first-stage
CASES="bugfix|requirements-analysis feature|intent-capture mvp|intent-capture security-patch|nfr-requirements"

plan 12

# Stage a self-contained project with the full framework .claude/ so the engine
# resolves stage files, the graph, and the conductor persona. Returns proj dir.
make_project() {
  local scope="$1"
  local proj
  proj=$(mktemp -d -t t130-feat-XXXXXX)
  cp -r "$SRC" "$proj/.claude"
  bun "$proj/.claude/tools/aidlc-utility.ts" init --scope "$scope" --test-run \
    --project-dir "$proj" >/dev/null 2>&1
  echo "$proj"
}

for case in $CASES; do
  scope="${case%%|*}"
  want_stage="${case##*|}"
  proj=$(make_project "$scope")

  # The runner's first move: next --scope <scope>. Capture the directive.
  directive=$(bun "$proj/.claude/tools/aidlc-orchestrate.ts" next --scope "$scope" \
    --project-dir "$proj" 2>/dev/null || true)

  # kind == run-stage, stage == expected first EXECUTE stage, persona present.
  read -r kind stage has_persona <<EOF
$(printf '%s' "$directive" | bun -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let d;
    try { d = JSON.parse(raw); } catch { console.log("PARSE_ERROR - 0"); return; }
    const persona = typeof d.conductor_persona === "string" && d.conductor_persona.length > 0 ? "1" : "0";
    console.log([d.kind || "-", d.stage || "-", persona].join(" "));
  });
')
EOF

  assert_eq "$kind" "run-stage" "aidlc-$scope: baked-scope first move → run-stage"
  assert_eq "$stage" "$want_stage" "aidlc-$scope: lands on first EXECUTE stage ($want_stage)"
  assert_eq "$has_persona" "1" "aidlc-$scope: directive carries the conductor persona (engine-delivered)"

  rm -rf "$proj"
done

finish
