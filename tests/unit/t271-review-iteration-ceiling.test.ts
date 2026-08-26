// covers: function:isAutonomousSwarmStage, function:reviewArtifactSnapshot,
// function:validateReviewAppendix, function:reviewCompletionMatchesRequest,
// function:reviewRequestBindingFromBlock
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
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createTestProject,
  seedAuditFile,
  seedBoltDagBatches,
  seededAuditDir,
  seededRecordDir,
  seedStateFile,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  boltSlugForUnit,
  freshReviewReceipts,
  readAllAuditShards,
  reviewArtifactFingerprint,
  reviewArtifactSnapshot,
  resolveStage,
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
  const stage = args[args.indexOf("--stage") + 1];
  const reviewer = args[args.indexOf("--reviewer") + 1];
  const iteration = Number(args[args.indexOf("--iteration") + 1]);
  const unitIndex = args.indexOf("--unit");
  const unit = unitIndex === -1 ? undefined : args[unitIndex + 1];
  const definition = resolveStage(stage);
  let reviewArtifact: string | null = null;
  if (definition?.review_artifact) {
    const dir =
      definition.for_each === "unit-of-work"
        ? join(
            seededRecordDir(proj),
            "construction",
            unit ?? "unit-alpha",
            stage,
          )
        : join(seededRecordDir(proj), definition.phase, stage);
    reviewArtifact = join(dir, `${definition.review_artifact}.md`);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(reviewArtifact)) {
      writeFileSync(reviewArtifact, `# ${definition.review_artifact}\n`, "utf-8");
    }
  }
  const verdictIndex = args.indexOf("--verdict");
  if (
    verdictIndex === -1 &&
    !args.includes("--retry-pending") &&
    extraEnv.AIDLC_TEST_KEEP_REVIEW !== "1" &&
    reviewArtifact !== null
  ) {
    const current = readFileSync(reviewArtifact, "utf-8");
    const reviewStart = current.search(/^## Review[ \t]*$/m);
    if (reviewStart !== -1) {
      writeFileSync(
        reviewArtifact,
        `${current.slice(0, reviewStart).replace(/\s+$/, "")}\n`,
        "utf-8",
      );
    }
  }
  if (verdictIndex !== -1) {
    if (reviewArtifact !== null) {
      if (
        !/^## Review[ \t]*$/m.test(readFileSync(reviewArtifact, "utf-8"))
      ) {
        appendFileSync(
          reviewArtifact,
          reviewAppendix(
            reviewer,
            iteration,
            args[verdictIndex + 1].toUpperCase() as "READY" | "NOT-READY",
          ),
          "utf-8",
        );
      }
    }
  }
  const res = spawnSync(
    process.execPath,
    [LOG_TOOL, "review", ...args],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        ...extraEnv,
      },
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
      ).replace(
        "- [S] units-generation — SKIP (bugfix scope)",
        "- [ ] units-generation — EXECUTE",
      ),
    );
  }
  seedBoltDagBatches(proj, [["unit-alpha"]]);
  const stageArtifacts: Array<[string, string[]]> = [
    [
      join(seededRecordDir(proj), "inception", "requirements-analysis"),
      ["requirements.md", "requirements-analysis-questions.md"],
    ],
    [
      join(
        seededRecordDir(proj),
        "construction",
        "unit-alpha",
        "functional-design",
      ),
      ["entities.md", "rules.md", "functional-spec.md", "traceability.json"],
    ],
    [
      join(
        seededRecordDir(proj),
        "construction",
        "unit-alpha",
        "code-generation",
      ),
      [
        "code-generation-plan.md",
        "unit-test-instructions.md",
        "code-summary.md",
        "traceability.json",
      ],
    ],
  ];
  for (const [dir, names] of stageArtifacts) {
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
      writeFileSync(join(dir, name), `# ${name}\n`, "utf-8");
    }
  }
  writeSourceManifest(proj, "unit-alpha");
  return proj;
}

function writeSourceManifest(proj: string, unit: string): void {
  const dir = join(
    seededRecordDir(proj),
    "construction",
    unit,
    "code-generation",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "source-manifest.json"),
    `${JSON.stringify(
      { stage: "code-generation", unit, version: 1, writes: [] },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

function writeReviewedArtifact(
  proj: string,
  stage:
    | "requirements-analysis"
    | "functional-design"
    | "code-generation",
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
      : stage === "functional-design"
        ? "functional-spec.md"
      : "code-generation-plan.md",
  );
  writeFileSync(path, content, "utf-8");
  if (stage === "code-generation" && unit) {
    const dagDir = join(seededRecordDir(proj), "inception", "units-generation");
    mkdirSync(dagDir, { recursive: true });
    writeFileSync(
      join(dagDir, "unit-of-work-dependency.md"),
      `\`\`\`yaml\nunits:\n  - name: ${unit}\n    depends_on: []\n\`\`\`\n`,
      "utf-8",
    );
    writeSourceManifest(proj, unit);
  }
  return path;
}

function auditBlocks(proj: string, event: string): string[] {
  return readAllAuditShards(proj)
    .replace(/\r\n/g, "\n")
    .split(/\n---\n/)
    .filter((block) => auditBlockField(block, "Event") === event);
}

function reviewAppendix(
  reviewer: string,
  iteration: number,
  verdict: "READY" | "NOT-READY",
  findings = "No blocking findings.",
): string {
  return (
    "\n## Review\n\n" +
    `**Verdict:** ${verdict}\n` +
    `**Reviewer:** ${reviewer}\n` +
    `**Iteration:** ${iteration}\n\n` +
    `### Findings\n\n${findings}\n`
  );
}

describe("t271 review iteration ceiling", () => {
  test("autonomous and historical Bolt boundaries cannot authorize a ghost unit", () => {
    for (const autonomy of [false, true]) {
      const proj = seedProject("feature");
      writeReviewedArtifact(proj, "code-generation", "plan\n", "unit-alpha");
      if (autonomy) {
        const state = seededStateFile(proj);
        writeFileSync(
          state,
          `${readFileSync(state, "utf-8")}\n- **Construction Autonomy Mode**: autonomous\n`,
        );
      }
      appendAuditEntry("BOLT_STARTED", {
        "Bolt names": "ghost",
        "Batch number": "1",
        "Walking skeleton": "false",
        "Bolt slug": "ghost",
      }, proj);
      const ghost = runReview(proj, [
        "--stage", "code-generation",
        "--reviewer", "aidlc-architecture-reviewer-agent",
        "--unit", "ghost",
        "--iteration", "1",
      ]);
      expect(ghost.status).not.toBe(0);
      expect(ghost.stderr).toContain("not present in the authoritative unit DAG");
    }
  });

  test("a fresh STAGE_STARTED clears an earlier cross-shard boundary ambiguity", () => {
    const proj = seedProject("feature");
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    const tieSecond = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const block = (event: string, extra: string) =>
      `# AI-DLC Audit Log\n\n## ${event}\n**Timestamp**: ${tieSecond}\n**Event**: ${event}\n${extra}\n---\n`;
    writeFileSync(join(auditDir, "tie-a.md"), block("WORKFLOW_STARTED", "**Scope**: feature"));
    writeFileSync(
      join(auditDir, "tie-b.md"),
      block("GATE_REJECTED", "**Stage**: requirements-analysis"),
    );
    const second = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === second) {}
    appendAuditEntry("STAGE_STARTED", {
      Stage: "requirements-analysis",
      Agent: "aidlc-product-agent",
    }, proj);
    const review = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ]);
    expect(review.status).toBe(0);
  });

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
    expect(over.stderr).toContain("allows 1 review pass");
    // The refusal must teach the terminal path, not re-trigger a review loop.
    expect(over.stderr).toContain("include the findings in the approval summary");
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
    expect(retry.stderr).toContain(
      "completed before the stage output or project source changed",
    );
    expect(retry.stderr).toContain("--iteration 2");

    const wrongOrdinal = runReview(proj, [...base, "--iteration", "1"]);
    expect(wrongOrdinal.status).not.toBe(0);
    expect(wrongOrdinal.stderr).toContain("next iteration is 2");

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
    expect(spent.stderr).toContain("one recovery review was already used");
    expect(spent.stderr).toContain("human Request Changes decision");
    expect(spent.stderr).toContain("human's behalf");
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
      "one recovery review was already used",
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
    expect(over.stderr).toContain("allows 2 review passes");
    expect(over.stderr).toContain("approval gate");
  });

  test("scope review_cap lowers an adversarial budget to 1 (bugfix)", () => {
    const proj = seedProject("bugfix");
    const over = runReview(proj, [
      "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", "2",
    ]);
    expect(over.status).not.toBe(0);
    expect(over.stderr).toContain("allows 1 review pass");
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
    expect(refused.stderr).toContain("allows 0 review passes");
  });

  test("inline per-unit reviews remain subject to scope caps", () => {
    const proj = seedProject("bugfix");
    const dagDir = join(seededRecordDir(proj), "inception", "units-generation");
    mkdirSync(dagDir, { recursive: true });
    writeFileSync(
      join(dagDir, "unit-of-work-dependency.md"),
      "```yaml\nunits:\n  - name: unit-alpha\n    depends_on: []\n```\n",
      "utf-8",
    );
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
    expect(over.stderr).toContain("allows 1 review pass");
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
    writeSourceManifest(proj, "unit-alpha");
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
    expect(over.stderr).toContain("allows 2 review passes");

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
    expect(afterFailure.stderr).toContain("allows 0 review passes");
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
    writeSourceManifest(proj, "unit-alpha");

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
    expect(refused.stderr).toContain("allows 1 review pass");
    expect(refused.stderr).toContain("Do not ask the reviewer again");
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
    expect(noLongerPending.stderr).toContain("no pending request with that number exists");

    const overBudget = runReview(proj, [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "2",
    ], { AIDLC_TEST_KEEP_REVIEW: "1" });
    expect(overBudget.status).not.toBe(0);
    expect(overBudget.stderr).toContain("allows 1 review pass");
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
    expect(unpaired.stderr).toContain("no pending request with that number exists");

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
    expect(duplicate.stderr).toContain("no pending request with that number exists");
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
    expect(duplicate.stderr).toContain("still waiting for a verdict");
    const concurrentNext = runReview(proj, args("2"));
    expect(concurrentNext.status).not.toBe(0);
    expect(concurrentNext.stderr).toContain("still waiting for a verdict");

    expect(
      runReview(proj, [...args("1"), "--verdict", "NOT-READY"]).status,
    ).toBe(0);
    expect(runReview(proj, args("2")).status).toBe(0);
    const rows =
      readAllAuditShards(proj).match(/\*\*Event\*\*: REVIEW_REQUESTED/g) ?? [];
    expect(rows.length).toBe(2);
  });

  test("a compliant reviewer appendix completes without retry and the receipt binds the full result", () => {
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
    const requested = auditBlocks(proj, "REVIEW_REQUESTED")[0];
    const requestFingerprint = auditBlockField(
      requested,
      "Artifact Fingerprint",
    );
    expect(requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(auditBlockField(requested, "Review Appendix Artifact")).toBe(
      "inception/requirements-analysis/requirements.md",
    );
    expect(auditBlockField(requested, "Review Appendix Offset")).toBe(
      String(Buffer.byteLength("reviewed requirements\n")),
    );

    appendFileSync(
      artifact,
      reviewAppendix("aidlc-product-lead-agent", 1, "READY"),
      "utf-8",
    );
    expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);

    const completed = auditBlocks(proj, "REVIEW_COMPLETED")[0];
    expect(auditBlockField(completed, "Request Fingerprint")).toBe(
      requestFingerprint,
    );
    expect(auditBlockField(completed, "Artifact Fingerprint")).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(auditBlockField(completed, "Artifact Fingerprint")).not.toBe(
      requestFingerprint,
    );

    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from stage graph");
    const receipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
      { reviewClass: "advisory" },
    );
    expect(receipts.stageVerdict).toBe("READY");

    appendFileSync(artifact, "\npost-receipt mutation\n", "utf-8");
    const stale = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
      { reviewClass: "advisory" },
    );
    expect(stale.stageVerdict).toBeNull();
    expect(stale.stageStale).toBe(true);
  });

  test("literal Review examples cannot become the existing reviewer appendix", () => {
    const examples = [
      {
        name: "fenced",
        lines: [
          "```markdown",
          "## Review",
          "",
          "**Verdict:** READY",
          "**Reviewer:** aidlc-product-lead-agent",
          "**Iteration:** 1",
          "```",
        ],
      },
      {
        name: "commented",
        lines: [
          "<!--",
          "## Review",
          "",
          "**Verdict:** READY",
          "**Reviewer:** aidlc-product-lead-agent",
          "**Iteration:** 1",
          "-->",
        ],
      },
      {
        name: "raw HTML",
        lines: [
          "<pre>",
          "## Review",
          "",
          "**Verdict:** READY",
          "**Reviewer:** aidlc-product-lead-agent",
          "**Iteration:** 1",
          "</pre>",
        ],
      },
    ] as const;

    for (const example of examples) {
      const proj = seedProject("feature");
      const body = [
        "# Requirements",
        "",
        "The following is only a formatting example:",
        "",
        ...example.lines,
        "",
        "Actual reviewed requirements remain unchanged.",
        "",
      ].join("\n");
      const artifact = writeReviewedArtifact(
        proj,
        "requirements-analysis",
        body,
      );
      const stage = resolveStage("requirements-analysis");
      if (!stage) {
        throw new Error("requirements-analysis missing from stage graph");
      }
      const snapshot = reviewArtifactSnapshot(proj, stage);
      expect(snapshot?.appendixOffset, example.name).toBe(
        Buffer.byteLength(body),
      );

      const request = [
        "--stage", "requirements-analysis",
        "--reviewer", "aidlc-product-lead-agent",
        "--iteration", "1",
      ];
      expect(
        runReview(proj, request, { AIDLC_TEST_KEEP_REVIEW: "1" }).status,
        example.name,
      ).toBe(0);
      expect(
        auditBlockField(
          auditBlocks(proj, "REVIEW_REQUESTED")[0],
          "Review Appendix Offset",
        ),
        example.name,
      ).toBe(String(Buffer.byteLength(body)));

      const unchanged = runReview(
        proj,
        [...request, "--verdict", "READY"],
        { AIDLC_TEST_KEEP_REVIEW: "1" },
      );
      expect(unchanged.status, example.name).not.toBe(0);
      expect(auditBlocks(proj, "REVIEW_COMPLETED"), example.name).toHaveLength(
        0,
      );
      expect(readFileSync(artifact, "utf-8"), example.name).toBe(body);
    }
  });

  test("--retry-pending cannot rebaseline changed review input into a READY receipt", () => {
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
    writeFileSync(
      artifact,
      `changed while reviewer was running\n${reviewAppendix(
        "aidlc-product-lead-agent",
        1,
        "READY",
      )}`,
      "utf-8",
    );

    const staleVerdict = runReview(proj, [...request, "--verdict", "READY"]);
    expect(staleVerdict.status).not.toBe(0);
    expect(staleVerdict.stderr).toContain(
      "changed outside the reviewer-authored appendix",
    );

    const retry = runReview(proj, [...request, "--retry-pending"]);
    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain("cannot rebaseline changed content");
    expect(auditBlocks(proj, "REVIEW_REQUESTED")).toHaveLength(1);
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(0);
  });

  test("an incomplete review can retry after its partial appendix is removed", () => {
    const proj = seedProject("feature");
    const original = "reviewed requirements\n";
    const artifact = writeReviewedArtifact(
      proj,
      "requirements-analysis",
      original,
    );
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];

    expect(runReview(proj, request).status).toBe(0);
    const originalFingerprint = auditBlockField(
      auditBlocks(proj, "REVIEW_REQUESTED")[0],
      "Artifact Fingerprint",
    );
    appendFileSync(artifact, "\n## Review\n\nfinding without verdict\n", "utf-8");

    writeFileSync(artifact, original, "utf-8");
    const retry = runReview(proj, [...request, "--retry-pending"]);
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('"retry":"pending-request"');
    const requests = auditBlocks(proj, "REVIEW_REQUESTED");
    expect(requests).toHaveLength(2);
    expect(auditBlockField(requests[1], "Artifact Fingerprint")).toBe(
      originalFingerprint,
    );
    const secondRetry = runReview(proj, [...request, "--retry-pending"]);
    expect(secondRetry.status).not.toBe(0);
    expect(secondRetry.stderr).toContain(
      "already used its one pending-request retry",
    );
    expect(auditBlocks(proj, "REVIEW_REQUESTED")).toHaveLength(2);

    appendFileSync(
      artifact,
      reviewAppendix(
        "aidlc-product-lead-agent",
        1,
        "READY",
        "Recovered review.",
      ),
      "utf-8",
    );
    expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);
  });

  test("only one owned canonical Review section may occupy the appended suffix", () => {
    const cases = [
      {
        name: "semantic bytes before heading",
        suffix:
          "\nUnreviewed acceptance criteria.\n" +
          reviewAppendix("aidlc-product-lead-agent", 1, "READY"),
        error: "must begin with only blank lines",
      },
      {
        name: "duplicate review section",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          reviewAppendix("aidlc-product-lead-agent", 1, "READY"),
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "later H1 section",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\n# Unreviewed Top Level\n\nSemantic content.\n",
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "indented later H1 section",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\n   # Unreviewed Top Level\n\nSemantic content.\n",
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "later setext H1",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\nUnreviewed Top Level\n====================\n\nSemantic content.\n",
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "later setext H2",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\nUnreviewed Top Level\n--------------------\n\nSemantic content.\n",
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "indented later setext H2",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\nUnreviewed Top Level\n   --------------------\n\nSemantic content.\n",
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "rendered HTML H1",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\n<h1>Unreviewed Top Level</h1>\n\nSemantic content.\n",
        error: "no rendered HTML H1 or H2 heading",
      },
      {
        name: "nested rendered HTML H2",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          '\n<section><H2 class="replacement">Unreviewed</H2></section>\n',
        error: "no rendered HTML H1 or H2 heading",
      },
      {
        name: "multiline rendered HTML H1",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          '\n<h1\n class="replacement">Unreviewed</h1>\n',
        error: "no rendered HTML H1 or H2 heading",
      },
      {
        name: "inline code cannot open a fake HTML comment",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\nLiteral `<!--`\n# Unreviewed Top Level\n-->\n",
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "list continuation code cannot open a fake HTML comment",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\n- Literal `<!--\n  continued`\n\n# Unreviewed Top Level\n-->\n",
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "blockquote continuation code cannot open a fake HTML comment",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\n> Literal `<!--\n> continued`\n\n# Unreviewed Top Level\n-->\n",
        error: "no later rendered H1 or H2 heading",
      },
      {
        name: "multiline code cannot cross into a list HTML heading",
        suffix:
          reviewAppendix("aidlc-product-lead-agent", 1, "READY") +
          "\nLiteral `not code across blocks\n- <h1>Unreviewed</h1>\n`\n",
        error: "no rendered HTML H1 or H2 heading",
      },
      {
        name: "renderer sentinel injection",
        suffix: [
          "",
          "## Review",
          "",
          "\u0001Verdict:\u0002 READY",
          "\u0001Reviewer:\u0002 aidlc-product-lead-agent",
          "\u0001Iteration:\u0002 1",
          "",
        ].join("\n"),
        error: "exactly one canonical verdict line",
      },
      {
        name: "malformed verdict",
        suffix: reviewAppendix(
          "aidlc-product-lead-agent",
          1,
          "READY",
        ).replace("**Verdict:** READY", "**Verdict:** READY enough"),
        error: "exactly one canonical verdict line",
      },
      {
        name: "conflicting duplicate verdict",
        suffix: reviewAppendix(
          "aidlc-product-lead-agent",
          1,
          "READY",
        ).replace(
          "**Verdict:** READY",
          "**Verdict:** READY\n**Verdict:** NOT-READY",
        ),
        error: "exactly one canonical verdict line",
      },
      {
        name: "forged reviewer",
        suffix: reviewAppendix("aidlc-architecture-reviewer-agent", 1, "READY"),
        error: "Reviewer line matching the requested reviewer",
      },
      {
        name: "wrong iteration",
        suffix: reviewAppendix("aidlc-product-lead-agent", 2, "READY"),
        error: "Iteration line matching the request",
      },
      {
        name: "conflicting duplicate reviewer",
        suffix: reviewAppendix(
          "aidlc-product-lead-agent",
          1,
          "READY",
        ).replace(
          "**Reviewer:** aidlc-product-lead-agent",
          "**Reviewer:** aidlc-product-lead-agent\n**Reviewer:** aidlc-architecture-reviewer-agent",
        ),
        error: "exactly one Reviewer line",
      },
      {
        name: "conflicting indented duplicate reviewer",
        suffix: reviewAppendix(
          "aidlc-product-lead-agent",
          1,
          "READY",
        ).replace(
          "**Reviewer:** aidlc-product-lead-agent",
          "**Reviewer:** aidlc-product-lead-agent\n   **Reviewer:** aidlc-architecture-reviewer-agent",
        ),
        error: "exactly one Reviewer line",
      },
      {
        name: "conflicting duplicate iteration",
        suffix: reviewAppendix(
          "aidlc-product-lead-agent",
          1,
          "READY",
        ).replace(
          "**Iteration:** 1",
          "**Iteration:** 1\n**Iteration:** 2",
        ),
        error: "exactly one Iteration line",
      },
    ] as const;

    for (const scenario of cases) {
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
      expect(runReview(proj, request).status, scenario.name).toBe(0);
      appendFileSync(artifact, scenario.suffix, "utf-8");
      const completed = runReview(proj, [...request, "--verdict", "READY"]);
      expect(completed.status, scenario.name).not.toBe(0);
      expect(completed.stderr, scenario.name).toContain(scenario.error);
      expect(auditBlocks(proj, "REVIEW_COMPLETED"), scenario.name).toHaveLength(
        0,
      );
    }
  }, 30_000); // Native Windows runs every crafted suffix through spawned Bun CLIs.

  test("fenced and inline examples cannot conflict with review ownership", () => {
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
    appendFileSync(
      artifact,
      reviewAppendix(
        "aidlc-product-lead-agent",
        1,
        "READY",
        [
          "The tool emitted these literal examples:",
          "",
          "```markdown",
          "# Example H1",
          "Example setext",
          "==============",
          "<h2>Example HTML heading</h2>",
          "**Verdict:** NOT-READY",
          "**Reviewer:** aidlc-architecture-reviewer-agent",
          "**Iteration:** 99",
          "```",
          "",
          "~~~text",
          "## Another example",
          "**Reviewer:** not-authority",
          "~~~",
          "",
          "Inline code such as `<h1>Example</h1>` is not rendered authority.",
          "",
          "<!--",
          "<h1>Commented example</h1>",
          "**Reviewer:** commented-not-authority",
          "-->",
        ].join("\n"),
      ),
      "utf-8",
    );
    const completed = runReview(proj, [...request, "--verdict", "READY"]);
    expect(completed.status, completed.stderr).toBe(0);
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(1);
  });

  test("multiline code spans cannot hide or erase canonical ownership fields", () => {
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
    appendFileSync(
      artifact,
      [
        "",
        "## Review",
        "",
        "### Findings",
        "",
        "Literal `<!--",
        "continued -->` remains code.",
        "",
        "**Verdict:** READY",
        "**Reviewer:** aidlc-product-lead-agent",
        "**Iteration:** 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    const completed = runReview(proj, [...request, "--verdict", "READY"]);
    expect(completed.status, completed.stderr).toBe(0);
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(1);
  });

  test("an empty primary artifact accepts only a canonical owned review appendix", () => {
    const proj = seedProject("feature");
    const artifact = writeReviewedArtifact(
      proj,
      "requirements-analysis",
      "",
    );
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];
    expect(runReview(proj, request).status).toBe(0);
    expect(
      auditBlockField(
        auditBlocks(proj, "REVIEW_REQUESTED")[0],
        "Review Appendix Offset",
      ),
    ).toBe("0");
    appendFileSync(
      artifact,
      reviewAppendix("aidlc-product-lead-agent", 1, "READY").trimStart(),
      "utf-8",
    );
    expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);
  });

  test("review_artifact, not produces order, owns plugin, kind-filtered, and no-DAG append selection", () => {
    const noDag = createTestProject();
    seedStateFile(noDag, "state-mid-inception.md");
    seedAuditFile(noDag);
    for (const unit of ["zeta", "alpha"]) {
      const dir = join(
        seededRecordDir(noDag),
        "construction",
        unit,
        "plugin-review-stage",
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin-preface.md"), "plugin output\n", "utf-8");
      writeFileSync(join(dir, "primary.md"), `${unit} primary\n`, "utf-8");
    }
    const pluginStage = {
      slug: "plugin-review-stage",
      phase: "construction",
      for_each: "unit-of-work",
      review_artifact: "primary",
      produces: ["plugin-preface", "primary"],
    };
    const pluginSnapshot = reviewArtifactSnapshot(noDag, pluginStage);
    expect(pluginSnapshot?.appendixArtifact).toBe(
      "construction/alpha/plugin-review-stage/primary.md",
    );

    const kindProject = seedProject("feature");
    const kindDir = join(
      seededRecordDir(kindProject),
      "construction",
      "unit-alpha",
      "functional-design",
    );
    mkdirSync(kindDir, { recursive: true });
    writeFileSync(join(kindDir, "functional-spec.md"), "spec unit\n", "utf-8");
    const functional = resolveStage("functional-design");
    if (!functional) throw new Error("functional-design missing from graph");
    const kindSnapshot = reviewArtifactSnapshot(
      kindProject,
      functional,
      "unit-alpha",
    );
    expect(kindSnapshot?.appendixArtifact).toBe(
      "construction/unit-alpha/functional-design/functional-spec.md",
    );
  });

  test("a controlled atomic replacement invalidates the coherent artifact snapshot", () => {
    const proj = seedProject("feature");
    const artifact = writeReviewedArtifact(
      proj,
      "requirements-analysis",
      "reviewed requirements\n",
    );
    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from graph");
    const requested = reviewArtifactSnapshot(proj, stage);
    if (!requested) throw new Error("request snapshot failed");
    appendFileSync(
      artifact,
      reviewAppendix("aidlc-product-lead-agent", 1, "READY"),
      "utf-8",
    );
    const replacement = `${artifact}.replacement`;
    writeFileSync(
      replacement,
      `replacement content\n${reviewAppendix(
        "aidlc-product-lead-agent",
        1,
        "READY",
      )}`,
      "utf-8",
    );
    let replaced = false;
    const raced = reviewArtifactSnapshot(proj, stage, undefined, {
      appendixBinding: {
        artifact: requested.appendixArtifact,
        offset: requested.appendixOffset,
      },
      snapshotObserver: ({ logicalPath }) => {
        if (!replaced && logicalPath === requested.appendixArtifact) {
          if (process.platform === "win32") {
            // Windows renameSync does not replace an existing destination.
            // Mutate the already-open file instead; the stable descriptor/path
            // identity check must reject this race too.
            writeFileSync(artifact, readFileSync(replacement));
          } else {
            renameSync(replacement, artifact);
          }
          replaced = true;
        }
      },
    });
    expect(replaced).toBe(true);
    expect(raced).toBeNull();
    expect(readFileSync(artifact, "utf-8")).toContain("replacement content");
  });

  test("review snapshots reject symlinked and hardlinked artifact leaves", () => {
    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from graph");

    for (const alias of ["symlink", "hardlink"] as const) {
      for (const name of [
        "requirements.md",
        "requirements-analysis-questions.md",
      ]) {
        const proj = seedProject("feature");
        const artifact = join(
          seededRecordDir(proj),
          "inception",
          "requirements-analysis",
          name,
        );
        const external = join(proj, `external-${alias}-${name}`);
        const canary = `external ${alias} canary\n`;
        writeFileSync(external, canary, "utf-8");
        unlinkSync(artifact);
        if (alias === "symlink") {
          try {
            symlinkSync(external, artifact);
          } catch {
            continue; // Windows without symlink privilege.
          }
        } else {
          linkSync(external, artifact);
        }

        expect(reviewArtifactSnapshot(proj, stage)).toBeNull();
        expect(reviewArtifactFingerprint(proj, stage)).toBeNull();
        const request = spawnSync(
          process.execPath,
          [
            LOG_TOOL,
            "review",
            "--stage",
            "requirements-analysis",
            "--reviewer",
            "aidlc-product-lead-agent",
            "--iteration",
            "1",
            "--project-dir",
            proj,
          ],
          {
            encoding: "utf-8",
            env: {
              ...process.env,
              AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
            },
          },
        );
        expect(request.status).not.toBe(0);
        expect(readFileSync(external, "utf-8")).toBe(canary);
        expect(auditBlocks(proj, "REVIEW_REQUESTED")).toHaveLength(0);
      }
    }
  });

  test("malformed completion rows do not consume a pending modern request", () => {
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
    const requested = auditBlocks(proj, "REVIEW_REQUESTED")[0];
    appendAuditEntry(
      "REVIEW_COMPLETED",
      {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
        Iteration: "1",
        Verdict: "READY",
        "Request Fingerprint":
          auditBlockField(requested, "Artifact Fingerprint") ?? "",
        "Artifact Fingerprint":
          auditBlockField(requested, "Artifact Fingerprint") ?? "",
        "Review Appendix Artifact":
          auditBlockField(requested, "Review Appendix Artifact") ?? "",
        // Review Appendix Offset intentionally omitted.
      },
      proj,
    );
    appendFileSync(
      artifact,
      reviewAppendix("aidlc-product-lead-agent", 1, "READY"),
      "utf-8",
    );
    const valid = runReview(proj, [...request, "--verdict", "READY"]);
    expect(valid.status, valid.stderr).toBe(0);
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(2);

    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from graph");
    const receipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
      { reviewClass: "advisory" },
    );
    expect(receipts.stageVerdict).toBe("READY");
  });

  test("legacy equal-fingerprint request/completion rows remain readable", () => {
    const proj = seedProject("feature");
    writeReviewedArtifact(
      proj,
      "requirements-analysis",
      "legacy reviewed requirements\n",
    );
    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from graph");
    const fingerprint = reviewArtifactFingerprint(proj, stage);
    if (!fingerprint) throw new Error("legacy fingerprint failed");
    const identity = {
      Stage: "requirements-analysis",
      Reviewer: "aidlc-product-lead-agent",
      Iteration: "1",
      "Artifact Fingerprint": fingerprint,
    };
    appendAuditEntry("REVIEW_REQUESTED", identity, proj);
    appendAuditEntry(
      "REVIEW_COMPLETED",
      { ...identity, Verdict: "READY" },
      proj,
    );
    const receipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
      { reviewClass: "advisory" },
    );
    expect(receipts.stageVerdict).toBe("READY");
  });

  test("one pending retry upgrades a valid legacy request to a modern binding", () => {
    const proj = seedProject("feature");
    writeReviewedArtifact(
      proj,
      "requirements-analysis",
      "legacy pending requirements\n",
    );
    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from graph");
    const fingerprint = reviewArtifactFingerprint(proj, stage);
    if (!fingerprint) throw new Error("legacy fingerprint failed");
    appendAuditEntry(
      "REVIEW_REQUESTED",
      {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
        Iteration: "1",
        "Artifact Fingerprint": fingerprint,
      },
      proj,
    );
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];
    const upgraded = runReview(proj, [...request, "--retry-pending"]);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toContain('"upgrade":"legacy-request"');
    const requests = auditBlocks(proj, "REVIEW_REQUESTED");
    expect(requests).toHaveLength(2);
    expect(auditBlockField(requests[1], "Upgrade")).toBe("legacy-request");
    expect(auditBlockField(requests[1], "Review Appendix Artifact")).toBe(
      "inception/requirements-analysis/requirements.md",
    );

    const secondRetry = runReview(proj, [...request, "--retry-pending"]);
    expect(secondRetry.status).not.toBe(0);
    expect(secondRetry.stderr).toContain(
      "already used its one pending-request retry",
    );
    expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);
  });

  test("a historical field-light retry gets one bounded modernizing dispatch", () => {
    const proj = seedProject("feature");
    writeReviewedArtifact(
      proj,
      "requirements-analysis",
      "legacy retried requirements\n",
    );
    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from graph");
    const fingerprint = reviewArtifactFingerprint(proj, stage);
    if (!fingerprint) throw new Error("legacy fingerprint failed");
    const legacy = {
      Stage: "requirements-analysis",
      Reviewer: "aidlc-product-lead-agent",
      Iteration: "1",
      "Artifact Fingerprint": fingerprint,
    };
    appendAuditEntry("REVIEW_REQUESTED", legacy, proj);
    appendAuditEntry(
      "REVIEW_REQUESTED",
      { ...legacy, Retry: "pending-request" },
      proj,
    );
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];
    const upgraded = runReview(proj, [...request, "--retry-pending"]);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toContain('"upgrade":"legacy-request"');
    const requests = auditBlocks(proj, "REVIEW_REQUESTED");
    expect(requests).toHaveLength(3);
    expect(auditBlockField(requests[2], "Upgrade")).toBe("legacy-request");
    expect(auditBlockField(requests[2], "Review Appendix Offset")).not.toBeNull();

    const secondRetry = runReview(proj, [...request, "--retry-pending"]);
    expect(secondRetry.status).not.toBe(0);
    expect(secondRetry.stderr).toContain(
      "already used its one pending-request retry",
    );
    expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);
  });

  test("malformed pending requests are safely invalidated and do not consume their ordinal", () => {
    for (const malformed of ["partial appendix", "invalid source"] as const) {
      const proj = seedProject("feature");
      writeReviewedArtifact(
        proj,
        "requirements-analysis",
        `${malformed} requirements\n`,
      );
      const stage = resolveStage("requirements-analysis");
      if (!stage) throw new Error("requirements-analysis missing from graph");
      const fingerprint = reviewArtifactFingerprint(proj, stage);
      if (!fingerprint) throw new Error("request fingerprint failed");
      appendAuditEntry(
        "REVIEW_REQUESTED",
        {
          Stage: "requirements-analysis",
          Reviewer: "aidlc-product-lead-agent",
          Iteration: "1",
          "Artifact Fingerprint": fingerprint,
          ...(malformed === "partial appendix"
            ? {
                "Review Appendix Artifact":
                  "inception/requirements-analysis/requirements.md",
                // Offset intentionally absent, so the row has no valid binding.
              }
            : { "Source Fingerprint": "sha256:not-valid" }),
        },
        proj,
      );
      const request = [
        "--stage", "requirements-analysis",
        "--reviewer", "aidlc-product-lead-agent",
        "--iteration", "1",
      ];
      const fresh = runReview(proj, request);
      expect(fresh.status, `${malformed}: ${fresh.stderr}`).toBe(0);
      expect(auditBlocks(proj, "REVIEW_REQUESTED")).toHaveLength(2);
      expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);
    }
  });

  test("--unit requires an authoritative DAG or a matching active or merged Bolt", () => {
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
    appendAuditEntry("STAGE_STARTED", {
      Stage: "code-generation",
    }, boltBacked);
    appendAuditEntry("BOLT_STARTED", {
      "Bolt names": "2fa",
      "Batch number": "1",
      "Walking skeleton": "false",
      "Bolt slug": boltSlugForUnit("2fa"),
    }, boltBacked);
    writeSourceManifest(boltBacked, "2fa");
    const boltReview = runReview(boltBacked, [...base, "--unit", "2fa"]);
    expect(boltReview.status, boltReview.stderr).toBe(0);

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
    expect(mismatched.stderr).toContain(
      "no matching active or merged Bolt attempt",
    );

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
    expect(closed.stderr).toContain(
      "no matching active or merged Bolt attempt",
    );

    const proj = seedProject("feature");
    const unknown = runReview(proj, [...base, "--unit", "ghost"]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("not present in the authoritative unit DAG");
    writeSourceManifest(proj, "unit-alpha");
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
