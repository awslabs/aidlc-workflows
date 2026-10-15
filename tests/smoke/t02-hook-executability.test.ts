// covers:
//
// t02 - hook presence.
//
// Mechanism: none. Subject is the shipped hooks directory on disk
// (dist/claude/.claude/hooks/). Each framework hook must be present as a
// regular file - a pure structural check with zero LLM, zero tokens, zero
// process boundary. We assert it in-process with statSync().isFile() against
// AIDLC_SRC from the fixtures harness (== <REPO_ROOT>/dist/claude/.claude).
//
// Why .isFile() and not bare existsSync(): the .sh's assert_file_exists uses
// `[ -f "$path" ]` (tests/lib/tap.sh), a REGULAR-FILE test that a directory
// of the same name would fail. existsSync alone would pass on a dir, so this
// twin is equal-or-stronger by pinning .isFile().
//
// Source under test: the framework hooks shipped under
// dist/claude/.claude/hooks/ (all .ts, run via bun — no executable bit needed,
// per the .sh's own subject line). The expected set matches the hooks the
// project CLAUDE.md and t01-file-structure.sh enumerate.

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const HOOKS_DIR = join(AIDLC_SRC, "hooks");

// The framework hooks. All .ts, run via bun - no executable bit is needed.
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
      // Assert it is a REGULAR FILE - a dir of the same name fails.
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).isFile()).toBe(true);
    });
  }
});
