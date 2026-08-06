// covers: function:isAutonomousSwarmStage
//
// t271 — engine-enforced review iteration ceiling (aidlc-log review).
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
// (a terminal receipt must always be recordable), request ordinals are owned
// by the audit ledger, inline per-unit work remains capped, and only a matching
// autonomous Bolt attempt receives the declared-class exemption.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestProject,
  seedAuditFile,
  seedBoltDagBatches,
  seedStateFile,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
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

describe("t271 review iteration ceiling", () => {
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

  test("inline per-unit reviews remain subject to scope caps", () => {
    const proj = seedProject("bugfix");
    const ok = runReview(proj, [
      "--stage", "functional-design",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "1",
    ]);
    expect(ok.status).toBe(0);
    appendAuditEntry("BOLT_STARTED", {
      "Bolt names": "unit-alpha",
      "Batch number": "1",
      "Walking skeleton": "false",
      "Bolt slug": "unit-alpha",
    }, proj);
    const over = runReview(proj, [
      "--stage", "functional-design",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "2",
    ]);
    expect(over.status).not.toBe(0);
    expect(over.stderr).toContain("review budget (1)");
  });

  test("a matching autonomous Bolt attempt uses the declared class", () => {
    const proj = seedProject("feature");
    const sf = seededStateFile(proj);
    writeFileSync(
      sf,
      readFileSync(sf, "utf8").replace(
        "- **Test Strategy**: Minimal",
        "- **Test Strategy**: Minimal\n- **Review Override**: none\n- **Construction Autonomy Mode**: autonomous",
      ),
    );
    seedBoltDagBatches(proj, [["unit-alpha"]]);
    appendAuditEntry("BOLT_STARTED", {
      "Bolt names": "unit-alpha",
      "Batch number": "1",
      "Walking skeleton": "false",
      "Bolt slug": "unit-alpha",
    }, proj);
    for (const iteration of ["1", "2"]) {
      const ok = runReview(proj, [
        "--stage", "code-generation",
        "--reviewer", "aidlc-architecture-reviewer-agent",
        "--unit", "unit-alpha",
        "--iteration", iteration,
      ]);
      expect(ok.status).toBe(0);
    }
    const over = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "3",
    ]);
    expect(over.status).not.toBe(0);
    expect(over.stderr).toContain("review budget (2)");

    appendAuditEntry("BOLT_FAILED", {
      "Bolt slug": "unit-alpha",
      Reason: "review-failed",
    }, proj);
    const afterFailure = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "1",
    ]);
    expect(afterFailure.status).not.toBe(0);
    expect(afterFailure.stderr).toContain("review budget (0)");
  });

  test("REVIEW_COMPLETED must pair to an unmatched request iteration", () => {
    const proj = seedProject("feature");
    const unpaired = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "5",
      "--verdict", "READY",
    ]);
    expect(unpaired.status).not.toBe(0);
    expect(unpaired.stderr).toContain("no unmatched REVIEW_REQUESTED");

    expect(runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ]).status).toBe(0);
    const done = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
      "--verdict", "READY",
    ]);
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("REVIEW_COMPLETED");
    const duplicate = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
      "--verdict", "READY",
    ]);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("no unmatched REVIEW_REQUESTED");
  });

  test("missing and malformed request iterations are refused", () => {
    for (const iteration of [undefined, "0", "-1", "1.5", "not-a-number"]) {
      const proj = seedProject("feature");
      const args = [
        "--stage", "requirements-analysis",
        "--reviewer", "aidlc-product-lead-agent",
      ];
      if (iteration !== undefined) args.push("--iteration", iteration);
      const refused = runReview(proj, args);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("--iteration <positive integer>");
      expect(readAllAuditShards(proj)).not.toContain("**Event**: REVIEW_REQUESTED");
    }
  });

  test("duplicate and out-of-order ordinals are refused from audit history", () => {
    const proj = seedProject("feature");
    const request = (iteration: string) => runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", iteration,
    ]);
    expect(request("1").status).toBe(0);
    const duplicate = request("1");
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("expected 2");
    expect(request("2").status).toBe(0);
    const rows =
      readAllAuditShards(proj).match(/\*\*Event\*\*: REVIEW_REQUESTED/g) ?? [];
    expect(rows.length).toBe(2);
  });

  test("unknown stages and wrong reviewers are refused", () => {
    const proj = seedProject("feature");
    const unknown = runReview(proj, [
      "--stage", "not-a-real-stage",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("has no declared reviewer");

    const wrongReviewer = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "not-the-declared-reviewer",
      "--iteration", "1",
    ]);
    expect(wrongReviewer.status).not.toBe(0);
    expect(wrongReviewer.stderr).toContain("does not match the declared reviewer");
  });
});
