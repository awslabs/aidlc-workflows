// covers:
//
// t02 — hook presence. Migrated from tests/smoke/t02-hook-executability.sh
// (TAP plan 10, 10 assert_file_exists rows). The .sh had no `# covers:` header
// (it is a structural presence guard over the shipped dist tree, not a unit
// contract), so this twin's covers id list is empty too — matching the smoke
// guard house style in tests/smoke/t-scope-mapping-guard.test.ts.
//
// Mechanism: none. Subject is the shipped hooks directory on disk
// (dist/claude/.claude/hooks/). The .sh asserted each of the 10 framework hooks
// is present as a regular file — a pure structural check with zero LLM, zero
// tokens, zero process boundary. We assert it in-process with statSync().isFile()
// against the same dist tree the .sh resolved (AIDLC_SRC from the fixtures
// harness == <REPO_ROOT>/dist/claude/.claude, the .sh's
// "$SCRIPT_DIR/../../dist/claude/.claude").
//
// Why .isFile() and not bare existsSync(): the .sh's assert_file_exists uses
// `[ -f "$path" ]` (tests/lib/tap.sh:32), a REGULAR-FILE test that a directory
// of the same name would fail. existsSync alone would pass on a dir, so this
// twin is equal-or-stronger by pinning .isFile().
//
// Source under test: the framework hooks shipped under
// dist/claude/.claude/hooks/ (all .ts, run via bun — no executable bit needed,
// per the .sh's own subject line). The expected set matches the hooks the
// project CLAUDE.md and t01-file-structure.sh:20-29 enumerate.
//
// Old TAP -> new test parity (1:1, one test() per .sh assert_file_exists row):
//   .sh:11 aidlc-write-audit-log.ts present    -> "hook present: aidlc-write-audit-log.ts"
//   .sh:12 aidlc-run-sensors.ts present     -> "hook present: aidlc-run-sensors.ts"
//   .sh:13 aidlc-sync-workflow-state.ts present -> "hook present: aidlc-sync-workflow-state.ts"
//   .sh:14 aidlc-rebuild-stage-graph.ts present -> "hook present: aidlc-rebuild-stage-graph.ts"
//   .sh:15 aidlc-validate-state.ts present  -> "hook present: aidlc-validate-state.ts"
//   .sh:16 aidlc-log-subagent.ts present    -> "hook present: aidlc-log-subagent.ts"
//   .sh:17 aidlc-session-start.ts present   -> "hook present: aidlc-session-start.ts"
//   .sh:18 aidlc-session-end.ts present     -> "hook present: aidlc-session-end.ts"
//   .sh:19 aidlc-statusline.ts present      -> "hook present: aidlc-statusline.ts"
//   .sh:20 aidlc-continue-workflow.ts present (Stop hook)-> "hook present: aidlc-continue-workflow.ts"

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const HOOKS_DIR = join(AIDLC_SRC, "hooks");

// The framework hooks, in the .sh's row order (t02:11-20) plus the
// mint-presence hook added after the migration. All .ts, run via bun — the .sh
// title notes no executable bit is needed.
const HOOKS = [
  "aidlc-write-audit-log.ts",
  "aidlc-run-sensors.ts",
  "aidlc-sync-workflow-state.ts",
  "aidlc-rebuild-stage-graph.ts",
  "aidlc-validate-state.ts",
  "aidlc-log-subagent.ts",
  "aidlc-session-start.ts",
  "aidlc-session-end.ts",
  "aidlc-statusline.ts",
  "aidlc-continue-workflow.ts",
  // Records a HUMAN_TURN on UserPromptSubmit.
  "aidlc-record-human-turn.ts",
  // Attaches exact active-stage rules at the subagent dispatch boundary.
  "aidlc-deliver-stage-rules.ts",
  // Blocks direct lifecycle mutations that bypass orchestrate report.
  "aidlc-state-transition-guard.ts",
  // Enforces the per-unit reviewer read-scope bound on PreToolUse.
  "aidlc-reviewer-scope.ts",
  // Enforces the §12a terminal-receipt write-freeze on PreToolUse.
  "aidlc-review-freeze.ts",
  // Folds transcript token usage into the durable ledger on PreToolUse + PostToolUse.
  "aidlc-fold-usage.ts",
  // Enforces code-generation's plan-before-generation ordering on PreToolUse.
  "aidlc-plan-approval-guard.ts",
] as const;

describe("t02 hook presence — shipped dist/claude/.claude/hooks (migrated from t02-hook-executability.sh, plan 10)", () => {
  for (const hook of HOOKS) {
    test(`hook present: ${hook}`, () => {
      const p = join(HOOKS_DIR, hook);
      // Stronger than the .sh's existence intent: assert it is a REGULAR FILE,
      // mirroring `[ -f "$path" ]` (tap.sh:32) — a dir of the same name fails.
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).isFile()).toBe(true);
    });
  }
});
