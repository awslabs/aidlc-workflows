// t266 — engine-enforced review iteration ceiling (aidlc-log review).
//
// Before this feature the §12a iteration cap was prose-only: a conductor that
// lost count (or got wedged in the receipt-invalidation loop) could dispatch
// reviews unbounded — the live failure behind the customer-reported 30-minute
// requirements stages. Now `aidlc-log review` (the REVIEW_REQUESTED half)
// refuses an --iteration beyond the stage's effective budget:
//   advisory  -> 1 (single pass IS the contract)
//   adversarial -> reviewer_max_iterations (default 2)
//   none      -> 0 (scope cap / override silenced the reviewer)
// and the refusal text teaches the terminal path instead of re-triggering a
// loop. Spawns the REAL dist CLI (module-root stage-graph.json carries
// review_class; the seeded state file carries Scope + Review Override).
//
// Boundary cases pinned: at-budget passes, over-budget refuses (rc 1, no
// audit row), REVIEW_COMPLETED (the --verdict half) is never budget-checked
// (a terminal receipt must always be recordable), per-unit requests use the
// DECLARED class (swarm exemption), and no --iteration stays exempt.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestProject,
  seedAuditFile,
  seedStateFile,
  seededStateFile,
} from "../harness/fixtures.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const LOG_TOOL = join(
  import.meta.dir,
  "..",
  "..",
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-log.ts"
);

function runReview(proj: string, args: string[]) {
  const res = spawnSync(
    process.execPath,
    [LOG_TOOL, "review", ...args],
    {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    }
  );
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// state-mid-inception.md: Scope bugfix (review_cap advisory), Current Stage
// requirements-analysis (declared advisory anyway). For adversarial cases we
// flip the scope field to `feature` (uncapped).
function seedProject(scope: "bugfix" | "feature"): string {
  const proj = createTestProject();
  seedStateFile(proj, "state-mid-inception.md");
  seedAuditFile(proj);
  if (scope === "feature") {
    const sf = seededStateFile(proj);
    writeFileSync(
      sf,
      readFileSync(sf, "utf8").replace(
        "- **Scope**: bugfix",
        "- **Scope**: feature"
      )
    );
  }
  return proj;
}

describe("t266 review iteration ceiling", () => {
  test("advisory stage: iteration 1 passes, iteration 2 refused with terminal guidance", () => {
    const proj = seedProject("feature"); // requirements-analysis declares advisory
    const ok = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("REVIEW_REQUESTED");

    const over = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "2",
    ]);
    expect(over.status).not.toBe(0);
    expect(over.stderr).toContain("exceeds");
    expect(over.stderr).toContain("advisory");
    // The refusal must teach the terminal path, not re-trigger a review loop.
    expect(over.stderr).toContain("quote its findings at the approval gate");
    // No REVIEW_REQUESTED row landed for the refused request.
    const audit = readAllAuditShards(proj);
    const rows = audit.match(/\*\*Event\*\*: REVIEW_REQUESTED/g) ?? [];
    expect(rows.length).toBe(1);
  });

  test("adversarial stage: budget is reviewer_max_iterations (2), iteration 3 refused", () => {
    const proj = seedProject("feature");
    // code-generation declares adversarial, cap 2 — and feature scope has no cap.
    for (const n of ["1", "2"]) {
      const ok = runReview(proj, [
        "--stage", "code-generation",
        "--reviewer", "aidlc-architecture-reviewer-agent",
        "--iteration", n,
      ]);
      expect(ok.status).toBe(0);
    }
    const over = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", "3",
    ]);
    expect(over.status).not.toBe(0);
    expect(over.stderr).toContain("exceeds");
    expect(over.stderr).toContain("review budget (2)");
    expect(over.stderr).toContain("present the gate");
  });

  test("scope review_cap lowers an adversarial budget to 1 (bugfix)", () => {
    const proj = seedProject("bugfix");
    const over = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", "2",
    ]);
    expect(over.status).not.toBe(0);
    expect(over.stderr).toContain("review budget (1)");
  });

  test("Review Override none refuses even iteration 1", () => {
    const proj = seedProject("feature");
    const sf = seededStateFile(proj);
    const state = readFileSync(sf, "utf8");
    writeFileSync(
      sf,
      state.replace(
        "- **Scope**: feature",
        "- **Scope**: feature\n- **Review Override**: none"
      )
    );
    const refused = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("review budget (0)");
  });

  test("per-unit (--unit) requests use the DECLARED class - swarm exemption", () => {
    // bugfix scope caps to advisory, but a --unit request on an adversarial
    // stage keeps the declared budget of 2 (the reviewer is the only
    // verification inside a Bolt).
    const proj = seedProject("bugfix");
    const ok = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "2",
    ]);
    expect(ok.status).toBe(0);
    const over = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "3",
    ]);
    expect(over.status).not.toBe(0);
  });

  test("REVIEW_COMPLETED (--verdict) is never budget-checked", () => {
    // A terminal receipt must always be recordable — the ceiling guards only
    // new dispatches. Iteration 5 with a verdict lands fine.
    const proj = seedProject("feature");
    const done = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "5",
      "--verdict", "READY",
    ]);
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("REVIEW_COMPLETED");
  });

  test("no --iteration stays exempt (older callers)", () => {
    const proj = seedProject("feature");
    const ok = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
    ]);
    expect(ok.status).toBe(0);
  });

  test("unknown stage fails open (resolution failure must not block a review)", () => {
    const proj = seedProject("feature");
    const ok = runReview(proj, [
      "--stage", "not-a-real-stage",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "9",
    ]);
    expect(ok.status).toBe(0);
  });
});
