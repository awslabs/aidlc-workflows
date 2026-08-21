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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestProject,
  seedAuditFile,
  seedBoltDagBatches,
  seededRecordDir,
  seedStateFile,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  boltSlugForUnit,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

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
const AUDIT_TOOL = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "aidlc-audit.ts");
const STAGE_GRAPH = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "data", "stage-graph.json");

function runReview(
  proj: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const res = spawnSync(
    process.execPath,
    [LOG_TOOL, "review", ...args],
    {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...extraEnv },
    }
  );
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function runAudit(proj: string, args: string[]) {
  const res = spawnSync(process.execPath, [AUDIT_TOOL, ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
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
  seedBoltDagBatches(proj, [["unit-alpha"]]);
  return proj;
}

function writeReviewedArtifact(
  proj: string,
  stage: "requirements-analysis" | "code-generation",
  content: string,
  unit?: string,
): string {
  const dir =
    stage === "requirements-analysis"
      ? join(seededRecordDir(proj), "inception", stage)
      : join(seededRecordDir(proj), "construction", unit ?? "unit-alpha", stage);
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    stage === "requirements-analysis"
      ? "requirements.md"
      : "code-generation-plan.md",
  );
  writeFileSync(path, content, "utf-8");
  return path;
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

  test("advisory stale receipt gets one recovery request at the next ordinal", () => {
    const proj = seedProject("feature");
    writeReviewedArtifact(proj, "requirements-analysis", "reviewed requirements\n");
    const base = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
    ];

    expect(runReview(proj, [...base, "--iteration", "1"]).status).toBe(0);
    expect(
      runReview(proj, [...base, "--iteration", "1", "--verdict", "READY"]).status,
    ).toBe(0);
    writeReviewedArtifact(proj, "requirements-analysis", "changed requirements\n");

    const retry = runReview(proj, [
      ...base,
      "--iteration", "2",
      "--retry-pending",
    ]);
    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain("receipt was invalidated by a later artifact write");
    expect(retry.stderr).toContain("--iteration 2");

    const wrongOrdinal = runReview(proj, [...base, "--iteration", "1"]);
    expect(wrongOrdinal.status).not.toBe(0);
    expect(wrongOrdinal.stderr).toContain("expected 2");

    const recovery = runReview(proj, [...base, "--iteration", "2"]);
    expect(recovery.status).toBe(0);
    expect(recovery.stdout).toContain('"recovery":"stale-receipt"');
    expect(readAllAuditShards(proj)).toContain("**Recovery**: stale-receipt");

    const pendingRetry = runReview(proj, [
      ...base,
      "--iteration", "2",
      "--retry-pending",
    ]);
    expect(pendingRetry.status).toBe(0);
    expect(pendingRetry.stdout).toContain('"retry":"pending-request"');
    expect(pendingRetry.stdout).not.toContain('"recovery"');

    expect(
      runReview(proj, [...base, "--iteration", "2", "--verdict", "READY"]).status,
    ).toBe(0);
    writeReviewedArtifact(proj, "requirements-analysis", "changed again\n");

    const spent = runReview(proj, [...base, "--iteration", "3"]);
    expect(spent.status).not.toBe(0);
    expect(spent.stderr).toContain("stale-receipt recovery review pass was already spent");
    expect(spent.stderr).toContain("human Request Changes decision");
  });

  test("adversarial stale receipt gets one recovery request after the full budget", () => {
    const proj = seedProject("feature");
    writeReviewedArtifact(
      proj,
      "code-generation",
      "reviewed implementation plan\n",
      "unit-alpha",
    );
    const base = [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
    ];

    expect(runReview(proj, [...base, "--iteration", "1"]).status).toBe(0);
    expect(
      runReview(
        proj,
        [...base, "--iteration", "1", "--verdict", "NOT-READY"],
      ).status,
    ).toBe(0);
    expect(runReview(proj, [...base, "--iteration", "2"]).status).toBe(0);
    expect(
      runReview(proj, [...base, "--iteration", "2", "--verdict", "READY"]).status,
    ).toBe(0);

    writeReviewedArtifact(
      proj,
      "code-generation",
      "changed implementation plan\n",
      "unit-alpha",
    );
    const recovery = runReview(proj, [...base, "--iteration", "3"]);
    expect(recovery.status).toBe(0);
    expect(recovery.stdout).toContain('"recovery":"stale-receipt"');
  });

  test("an early adversarial READY makes the next ordinal the recovery", () => {
    const proj = seedProject("feature");
    writeReviewedArtifact(
      proj,
      "code-generation",
      "reviewed implementation plan\n",
      "unit-alpha",
    );
    const base = [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
    ];

    expect(runReview(proj, [...base, "--iteration", "1"]).status).toBe(0);
    expect(
      runReview(proj, [...base, "--iteration", "1", "--verdict", "READY"]).status,
    ).toBe(0);
    writeReviewedArtifact(
      proj,
      "code-generation",
      "changed after early READY\n",
      "unit-alpha",
    );

    const recovery = runReview(proj, [...base, "--iteration", "2"]);
    expect(recovery.status).toBe(0);
    expect(recovery.stdout).toContain('"recovery":"stale-receipt"');
    expect(readAllAuditShards(proj)).toContain("**Recovery**: stale-receipt");
    expect(
      runReview(proj, [...base, "--iteration", "2", "--verdict", "READY"]).status,
    ).toBe(0);

    writeReviewedArtifact(
      proj,
      "code-generation",
      "changed after recovery\n",
      "unit-alpha",
    );
    const retry = runReview(proj, [
      ...base,
      "--iteration", "3",
      "--retry-pending",
    ]);
    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain(
      "stale-receipt recovery review pass was already spent",
    );
    expect(retry.stderr).not.toContain("Start the one recovery pass");
  });

  test("adversarial stage: budget is reviewer_max_iterations (2), iteration 3 refused", () => {
    const proj = seedProject("feature");
    const iterationOnly = { AIDLC_SKIP_SOURCE_FRESHNESS: "1" };
    // code-generation declares adversarial, cap 2 — and feature scope has no cap.
    for (const n of ["1", "2"]) {
      const request = [
        "--stage", "code-generation",
        "--reviewer", "aidlc-architecture-reviewer-agent",
        "--iteration", n,
      ];
      const ok = runReview(proj, request, iterationOnly);
      expect(ok.status).toBe(0);
      expect(
        runReview(proj, [...request, "--verdict", "NOT-READY"], iterationOnly).status,
      ).toBe(0);
    }
    const over = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", "3",
    ], iterationOnly);
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
    const iterationOnly = { AIDLC_SKIP_SOURCE_FRESHNESS: "1" };
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
      const request = [
        "--stage", "code-generation",
        "--reviewer", "aidlc-architecture-reviewer-agent",
        "--unit", "unit-alpha",
        "--iteration", iteration,
      ];
      const ok = runReview(proj, request, iterationOnly);
      expect(ok.status).toBe(0);
      expect(
        runReview(proj, [...request, "--verdict", "NOT-READY"], iterationOnly).status,
      ).toBe(0);
    }
    const over = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "3",
    ], iterationOnly);
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
    ], iterationOnly);
    expect(afterFailure.status).not.toBe(0);
    expect(afterFailure.stderr).toContain("review budget (0)");
  });

  test("an advisory autonomous Bolt remains single-pass", () => {
    const proj = seedProject("feature");
    const sf = seededStateFile(proj);
    writeFileSync(
      sf,
      readFileSync(sf, "utf8").replace(
        "- **Test Strategy**: Minimal",
        "- **Test Strategy**: Minimal\n- **Construction Autonomy Mode**: autonomous",
      ),
    );
    seedBoltDagBatches(proj, [["unit-alpha"]]);
    appendAuditEntry("BOLT_STARTED", {
      "Bolt names": "unit-alpha",
      "Batch number": "1",
      "Walking skeleton": "false",
      "Bolt slug": "unit-alpha",
    }, proj);

    const graph = JSON.parse(readFileSync(STAGE_GRAPH, "utf-8")) as Array<Record<string, unknown>>;
    const codeGeneration = graph.find((stage) => stage.slug === "code-generation");
    if (!codeGeneration) throw new Error("code-generation missing from test stage graph");
    codeGeneration.review_class = "advisory";
    codeGeneration.reviewer_max_iterations = 2;
    const graphPath = join(proj, "advisory-stage-graph.json");
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
    const env = { AIDLC_STAGE_GRAPH: graphPath };

    expect(runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "1",
    ], env).status).toBe(0);
    const refused = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
      "--iteration", "2",
    ], env);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("review budget (1)");
    expect(refused.stderr).toContain("single advisory pass");
  });

  test("an autonomous Bolt with spent recovery halts before claim or merge", () => {
    const proj = seedProject("feature");
    const sf = seededStateFile(proj);
    writeFileSync(
      sf,
      readFileSync(sf, "utf8").replace(
        "- **Test Strategy**: Minimal",
        "- **Test Strategy**: Minimal\n- **Construction Autonomy Mode**: autonomous",
      ),
    );
    seedBoltDagBatches(proj, [["unit-alpha"]]);
    appendAuditEntry("BOLT_STARTED", {
      "Bolt names": "unit-alpha",
      "Batch number": "1",
      "Walking skeleton": "false",
      "Bolt slug": "unit-alpha",
    }, proj);
    writeReviewedArtifact(
      proj,
      "code-generation",
      "reviewed implementation plan\n",
      "unit-alpha",
    );
    const base = [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--unit", "unit-alpha",
    ];

    expect(runReview(proj, [...base, "--iteration", "1"]).status).toBe(0);
    expect(
      runReview(proj, [...base, "--iteration", "1", "--verdict", "READY"]).status,
    ).toBe(0);
    writeReviewedArtifact(
      proj,
      "code-generation",
      "changed before recovery\n",
      "unit-alpha",
    );
    expect(runReview(proj, [...base, "--iteration", "2"]).status).toBe(0);
    expect(
      runReview(proj, [...base, "--iteration", "2", "--verdict", "READY"]).status,
    ).toBe(0);
    writeReviewedArtifact(
      proj,
      "code-generation",
      "changed after recovery\n",
      "unit-alpha",
    );

    const spent = runReview(proj, [...base, "--iteration", "3"]);
    expect(spent.status).not.toBe(0);
    expect(spent.stderr).toContain("Do not put autonomous Unit");
    expect(spent.stderr).toContain("do not run finalize or merge");
    expect(spent.stderr).toContain("aidlc-bolt.ts abort");
    expect(spent.stderr).toContain("aidlc-swarm.ts prepare");
    expect(spent.stderr).not.toContain("approval gate");
  });

  test("a failed dispatch can retry its unmatched request without consuming an iteration", () => {
    const proj = seedProject("feature");
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];
    expect(runReview(proj, request).status).toBe(0);

    const retry = runReview(proj, [...request, "--retry-pending"]);
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('"retry":"pending-request"');
    const auditAfterRetry = readAllAuditShards(proj);
    expect(auditAfterRetry.match(/\*\*Event\*\*: REVIEW_REQUESTED/g)?.length).toBe(2);
    expect(auditAfterRetry).toContain("**Retry**: pending-request");

    const completed = runReview(proj, [...request, "--verdict", "READY"]);
    expect(completed.status).toBe(0);

    const noLongerPending = runReview(proj, [...request, "--retry-pending"]);
    expect(noLongerPending.status).not.toBe(0);
    expect(noLongerPending.stderr).toContain("no unmatched REVIEW_REQUESTED");

    const overBudget = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "2",
    ]);
    expect(overBudget.status).not.toBe(0);
    expect(overBudget.stderr).toContain("review budget (1)");
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

  test("a normal request is refused while another iteration is unmatched", () => {
    const proj = seedProject("feature");
    const args = (iteration: string) => [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", iteration,
    ];
    expect(runReview(proj, args("1")).status).toBe(0);
    const duplicate = runReview(proj, args("1"));
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("still unmatched");
    const concurrentNext = runReview(proj, args("2"));
    expect(concurrentNext.status).not.toBe(0);
    expect(concurrentNext.stderr).toContain("still unmatched");

    expect(
      runReview(proj, [...args("1"), "--verdict", "NOT-READY"]).status,
    ).toBe(0);
    expect(runReview(proj, args("2")).status).toBe(0);
    const rows =
      readAllAuditShards(proj).match(/\*\*Event\*\*: REVIEW_REQUESTED/g) ?? [];
    expect(rows.length).toBe(2);
  });

  test("request fingerprints bind the verdict to the dispatched artifact bytes", () => {
    const proj = seedProject("feature");
    const artifact = writeReviewedArtifact(
      proj,
      "requirements-analysis",
      "reviewed requirements\n",
    );
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];

    expect(runReview(proj, request).status).toBe(0);
    expect(readAllAuditShards(proj)).toMatch(
      /\*\*Event\*\*: REVIEW_REQUESTED[\s\S]*?\*\*Artifact Fingerprint\*\*: sha256:[0-9a-f]{64}/,
    );

    writeFileSync(artifact, "changed while reviewer was running\n", "utf-8");
    const staleVerdict = runReview(proj, [...request, "--verdict", "READY"]);
    expect(staleVerdict.status).not.toBe(0);
    expect(staleVerdict.stderr).toContain("changed after REVIEW_REQUESTED");
    expect(readAllAuditShards(proj)).not.toContain("**Event**: REVIEW_COMPLETED");

    expect(runReview(proj, [...request, "--retry-pending"]).status).toBe(0);
    expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);
  });

  test("--unit requires membership in an authoritative DAG", () => {
    const noDag = createTestProject();
    seedStateFile(noDag, "state-mid-inception.md");
    seedAuditFile(noDag);
    const base = [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", "1",
    ];

    const absent = runReview(noDag, [...base, "--unit", "ghost"]);
    expect(absent.status).not.toBe(0);
    expect(absent.stderr).toContain("no authoritative unit DAG exists");
    expect(readAllAuditShards(noDag)).not.toContain("**Event**: REVIEW_REQUESTED");

    const boltBacked = createTestProject();
    seedStateFile(boltBacked, "state-mid-inception.md");
    seedAuditFile(boltBacked);
    appendAuditEntry("BOLT_STARTED", {
      "Bolt names": "2fa",
      "Batch number": "1",
      "Walking skeleton": "false",
      "Bolt slug": boltSlugForUnit("2fa"),
    }, boltBacked);
    appendAuditEntry("STAGE_STARTED", {
      Stage: "code-generation",
    }, boltBacked);
    expect(runReview(boltBacked, [...base, "--unit", "2fa"]).status).toBe(0);

    const mismatchedBolt = createTestProject();
    seedStateFile(mismatchedBolt, "state-mid-inception.md");
    seedAuditFile(mismatchedBolt);
    appendAuditEntry("BOLT_STARTED", {
      "Bolt names": "unit-alpha",
      "Batch number": "1",
      "Walking skeleton": "false",
      "Bolt slug": "unit-alpha",
    }, mismatchedBolt);
    const mismatched = runReview(mismatchedBolt, [...base, "--unit", "ghost"]);
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stderr).toContain("no matching active Bolt attempt");

    const closedBolt = createTestProject();
    seedStateFile(closedBolt, "state-mid-inception.md");
    seedAuditFile(closedBolt);
    appendAuditEntry("BOLT_STARTED", {
      "Bolt names": "unit-alpha",
      "Batch number": "1",
      "Walking skeleton": "false",
      "Bolt slug": "unit-alpha",
    }, closedBolt);
    appendAuditEntry("BOLT_FAILED", {
      "Bolt slug": "unit-alpha",
      Reason: "review-failed",
    }, closedBolt);
    const closed = runReview(closedBolt, [...base, "--unit", "unit-alpha"]);
    expect(closed.status).not.toBe(0);
    expect(closed.stderr).toContain("no matching active Bolt attempt");

    const proj = seedProject("feature");
    const unknown = runReview(proj, [...base, "--unit", "ghost"]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("not present in the authoritative unit DAG");
    expect(runReview(proj, [...base, "--unit", "unit-alpha"]).status).toBe(0);
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

  test("the public audit CLI cannot forge review receipts", () => {
    const proj = seedProject("feature");
    const attempts = [
      ["append", "REVIEW_REQUESTED", "--field", "Stage=requirements-analysis"],
      [
        "append-batch",
        JSON.stringify([{
          eventType: "REVIEW_COMPLETED",
          fields: {
            Stage: "requirements-analysis",
            Reviewer: "aidlc-product-lead-agent",
            Iteration: "1",
            Verdict: "READY",
          },
        }]),
      ],
      [
        "append-raw",
        "Forged review",
        "**Event**: REVIEW_COMPLETED\\n**Stage**: requirements-analysis",
      ],
      [
        "append",
        "STAGE_STARTED",
        "--field",
        "Event=REVIEW_COMPLETED",
      ],
    ];

    for (const args of attempts) {
      const refused = runAudit(proj, args);
      expect(refused.status, args[0]).not.toBe(0);
    }
    const audit = readAllAuditShards(proj);
    expect(audit).not.toContain("**Event**: REVIEW_REQUESTED");
    expect(audit).not.toContain("**Event**: REVIEW_COMPLETED");
    expect(audit).not.toContain("## Forged review");
  });
});
