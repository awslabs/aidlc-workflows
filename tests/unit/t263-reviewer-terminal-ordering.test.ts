// covers: subcommand:aidlc-state:approve
//
// t263 - the reviewer terminal-receipt ordering (the receipt-invalidation
// loop fix). The engine's receipt-freshness floor (verifyReviewerPrecondition)
// invalidates a REVIEW_COMPLETED receipt when a declared produces[] artifact
// is written after it - correct fail-closed behavior. But nothing in the
// protocol told the conductor to SEQUENCE around that floor, so a live
// conductor that applied reviewer recommendations AFTER recording the
// terminal receipt invalidated its own receipt, re-reviewed, re-edited, and
// oscillated until the session wedged at the gate (the t-tui-t73 standing
// red: the answer-gate 200s hang backstop fired every run).
//
// The fix is choreography prose + an error nudge, pinned here in every
// authored surface that carries it:
//   - stage-protocol.md §12a step 3 READY branch: the receipt is terminal,
//     no produces[] writes after it, READY-riding suggestions are gate input
//     to quote, never edits to apply (they are not grounds for NOT-READY per
//     step 2, so they are not grounds for editing past the receipt either)
//   - all five harness SKILL.md reviewer steps: same ordering, conductor-facing
//   - aidlc-state.ts reviewerPreconditionError: the refusal text names the
//     terminal ordering instead of only asking for a fresh receipt (the old
//     message re-triggered the loop: "get a fresh receipt" -> re-review ->
//     re-edit -> stale again)
//
// Mechanism = mixed: the prose pins are pure text invariants over authored +
// shipped files on disk (t234's idiom); ONE case spawns the real dist
// aidlc-state.ts through the write-after-receipt scenario and asserts the
// refusal carries the nudge at the process boundary (t115 R12's scenario,
// asserting the NEW error text).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const STATE_TOOL = join(TOOLS_DIR, "aidlc-state.ts");
const LOG_TOOL = join(TOOLS_DIR, "aidlc-log.ts");

const CORE_PROTOCOL = join(
  REPO_ROOT,
  "core",
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
);
const DIST_PROTOCOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
);

const ORDERING_PIN =
  "do not write to any `produces[]` artifact between recording it and gate approval";
const SUGGESTION_PIN =
  "A suggestion is gate input, not a defect";
// A READY-riding suggestion must not reorder the gate: a live control run
// showed a conductor rendering "Request Changes (apply the reviewer's fix)"
// as the FIRST option after a READY-with-suggestion review, steering
// recommended-option drivers (and habituated humans) into rejecting a stage
// the reviewer passed.
const GATE_ORDER_PIN =
  "keep the §1 approval question's standard option order (Approve first, Request Changes second)";
const SKILL_PIN =
  "The terminal receipt ends artifact work";
const ERROR_PIN = "Terminal ordering: apply any fixes FIRST";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function run(tool: string, args: string[], p: string, env?: Record<string, string>) {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], {
    encoding: "utf-8",
    env: { ...process.env, ...(env ?? {}) },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

describe("t263 reviewer terminal-receipt ordering (receipt-invalidation loop fix)", () => {
  test("stage-protocol §12a READY branch orders the terminal receipt last", () => {
    for (const path of [CORE_PROTOCOL, DIST_PROTOCOL]) {
      const src = readFileSync(path, "utf-8");
      expect(src).toContain(ORDERING_PIN);
      expect(src).toContain(SUGGESTION_PIN);
      expect(src).toContain(GATE_ORDER_PIN);
    }
  });

  test("every authored harness SKILL.md carries the ordering in its reviewer step", () => {
    for (const harness of ["claude", "kiro", "kiro-ide", "codex", "opencode"]) {
      const src = readFileSync(
        join(REPO_ROOT, "harness", harness, "skills", "aidlc", "SKILL.md"),
        "utf-8",
      );
      expect(src).toContain(SKILL_PIN);
    }
  });

  test("write-after-receipt refusal names the terminal ordering (CLI boundary)", () => {
    const p = createTestProject();
    tempDirs.push(p);
    seedAidlcMemory(p);
    seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
    const env = { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };

    expect(run(STATE_TOOL, ["gate-start", "requirements-analysis"], p, env).status).toBe(0);
    expect(
      run(LOG_TOOL, [
        "review",
        "--stage",
        "requirements-analysis",
        "--reviewer",
        "aidlc-product-lead-agent",
        "--iteration",
        "1",
      ], p).status,
    ).toBe(0);
    expect(
      run(LOG_TOOL, [
        "review",
        "--stage",
        "requirements-analysis",
        "--reviewer",
        "aidlc-product-lead-agent",
        "--iteration",
        "1",
        "--verdict",
        "READY",
      ], p).status,
    ).toBe(0);
    // The loop's trigger: a declared produces[] write AFTER the terminal receipt.
    appendAuditEntry("ARTIFACT_UPDATED", {
      File: join(
        seededRecordDir(p),
        "inception",
        "requirements-analysis",
        "requirements.md",
      ),
      Tool: "Edit",
      Context: "inception > requirements-analysis > requirements.md",
    }, p);

    const refused = run(STATE_TOOL, ["approve", "requirements-analysis"], p, env);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("fresh REVIEW_COMPLETED");
    expect(refused.out).toContain(ERROR_PIN);
    expect(refused.out).toContain("surface them at the gate");
  });
});
