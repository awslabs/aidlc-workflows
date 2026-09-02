// covers: function:isAutonomousSwarmStage, function:reviewArtifactSnapshot,
// function:validateReviewAppendix, function:reviewCompletionMatchesRequest,
// function:reviewRequestBindingFromBlock, function:reviewAppendedAfterRequest,
// function:reviewRequestArtifactsCurrent, function:reviewRequestBindingIsModern,
// function:legacyReviewAppendixEchoFields, function:reviewRecordRefFromBlock,
// function:reviewRecordDigest, function:serializeReviewRecord, function:reviewAttemptId,
// function:reviewRecordRelativePath, function:reviewDraftRelativePath,
// function:isReviewRecordRelativePath, function:readReviewRecord,
// function:latestReviewRecordRefs, function:mergeReviewRecordsFromDelta,
// function:reviewRecordMatchesCompletion
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
import { dirname, join } from "node:path";
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
  latestReviewRecordRefs,
  mergeReviewRecordsFromDelta,
  REVIEW_RECORD_MAX_BYTES,
  readAllAuditShards,
  readReviewRecord,
  reviewArtifactFingerprint,
  reviewArtifactSnapshot,
  type ReviewRecord,
  reviewRecordDigest,
  reviewRecordRelativePath,
  resolveStage,
  serializeReviewRecord,
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
  const slotKey = `${proj}\u0000${stage}\u0000${unit ?? ""}\u0000${iteration}`;
  if (verdictIndex !== -1 && reviewArtifact !== null) {
    const verdictValue = args[verdictIndex + 1].toUpperCase() as "READY" | "NOT-READY";
    if (extraEnv.AIDLC_TEST_EMBEDDED === "1") {
      // The deprecated migration path: a reviewer that still appends to the
      // artifact after the request.
      if (!/^## Review[ \t]*$/m.test(readFileSync(reviewArtifact, "utf-8"))) {
        appendFileSync(
          reviewArtifact,
          reviewAppendix(reviewer, iteration, verdictValue),
          "utf-8",
        );
      }
    } else if (extraEnv.AIDLC_TEST_NO_REVIEW_FILE !== "1") {
      // The record path: the review goes to the slot the request named.
      const reviewFile = reviewSlots.get(slotKey);
      if (reviewFile !== undefined) {
        const absolute = join(proj, reviewFile);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(
          absolute,
          reviewAppendix(reviewer, iteration, verdictValue).trimStart(),
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
  if (verdictIndex === -1 && (res.status ?? -1) === 0) {
    try {
      const parsed = JSON.parse((res.stdout ?? "").trim().split("\n").at(-1) ?? "{}") as {
        reviewFile?: string;
      };
      if (typeof parsed.reviewFile === "string") reviewSlots.set(slotKey, parsed.reviewFile);
    } catch {
      // not JSON: nothing to remember
    }
  }
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// The review slot each successful request (or retry) named, per project and
// scope, so a later verdict in the same test writes its review there.
const reviewSlots = new Map<string, string>();

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
  reviewChallenge?: string,
): string {
  return (
    "\n## Review\n\n" +
    `**Verdict:** ${verdict}\n` +
    `**Reviewer:** ${reviewer}\n` +
    `**Iteration:** ${iteration}\n` +
    (reviewChallenge === undefined
      ? "\n"
      : `**Request Challenge:** ${reviewChallenge}\n\n`) +
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

  test("a review recorded from the review file binds the request id, the record digest, and the unchanged artifact", () => {
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

    const requestRun = runReview(proj, request);
    expect(requestRun.status).toBe(0);
    const requestOutput = JSON.parse(requestRun.stdout) as {
      requestId: string;
      reviewFile: string;
    };
    expect(requestOutput.requestId).toMatch(/^review:[0-9a-f]{32}$/);
    expect(requestOutput.reviewFile).toMatch(
      /\/\.aidlc-reviews\/requirements-analysis\/stage-level\/[0-9a-f]{16}\/1\.review\.md$/,
    );
    const requested = auditBlocks(proj, "REVIEW_REQUESTED")[0];
    const requestFingerprint = auditBlockField(
      requested,
      "Artifact Fingerprint",
    );
    expect(requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(auditBlockField(requested, "Request Id")).toBe(requestOutput.requestId);
    // The request pins no appendix boundary: nothing will be appended.
    expect(auditBlockField(requested, "Review Appendix Artifact")).toBeNull();
    expect(auditBlockField(requested, "Review Appendix Offset")).toBeNull();

    const completedRun = runReview(proj, [...request, "--verdict", "READY"]);
    expect(completedRun.status, completedRun.stderr).toBe(0);
    const completedOutput = JSON.parse(completedRun.stdout) as { reviewRecord: string };
    expect(completedOutput.reviewRecord).toMatch(
      /^\.aidlc-reviews\/requirements-analysis\/stage-level\/[0-9a-f]{16}\/1\.json$/,
    );
    // The draft was consumed into the record; the artifact was never written.
    expect(existsSync(join(proj, requestOutput.reviewFile))).toBe(false);
    expect(readFileSync(artifact, "utf-8")).toBe("reviewed requirements\n");

    const completed = auditBlocks(proj, "REVIEW_COMPLETED")[0];
    expect(auditBlockField(completed, "Request Fingerprint")).toBe(
      requestFingerprint,
    );
    expect(auditBlockField(completed, "Artifact Fingerprint")).toBe(
      requestFingerprint,
    );
    expect(auditBlockField(completed, "Request Id")).toBe(requestOutput.requestId);
    expect(auditBlockField(completed, "Review Record")).toBe(
      completedOutput.reviewRecord,
    );
    const recordPath = join(seededRecordDir(proj), completedOutput.reviewRecord);
    const recordBytes = readFileSync(recordPath);
    const recordDigest = auditBlockField(completed, "Review Record Digest") as string;
    expect(recordDigest).toBe(reviewRecordDigest(recordBytes));
    const record = JSON.parse(recordBytes.toString("utf-8")) as ReviewRecord;
    expect(record.verdict).toBe("READY");
    expect(record.reviewer).toBe("aidlc-product-lead-agent");
    expect(record.iteration).toBe(1);
    expect(record.request_id).toBe(requestOutput.requestId);
    expect(record.artifact_fingerprint).toBe(requestFingerprint as string);
    expect(record.body).toContain("**Verdict:** READY");

    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from stage graph");
    const receipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
      { reviewClass: "advisory" },
    );
    expect(receipts.stageVerdict).toBe("READY");
    expect(latestReviewRecordRefs(proj, stage).get("")).toMatchObject({
      path: completedOutput.reviewRecord,
      digest: recordDigest,
      completion: completed,
    });

    // A record edited after the fact no longer hashes to its row: it is not
    // the review any more.
    writeFileSync(recordPath, recordBytes.toString("utf-8").replace("READY", "NOT-READY"));
    expect(
      readReviewRecord(proj, { path: completedOutput.reviewRecord, digest: recordDigest }),
    ).toBeNull();
    writeFileSync(recordPath, recordBytes);

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

  test("the deprecated embedded form is accepted only when the section provably postdates the request", () => {
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
    const requested = runReview(proj, request);
    expect(requested.status).toBe(0);
    const { reviewFile } = JSON.parse(requested.stdout) as { reviewFile: string };
    const requestFingerprint = auditBlockField(
      auditBlocks(proj, "REVIEW_REQUESTED")[0],
      "Artifact Fingerprint",
    );

    appendFileSync(
      artifact,
      reviewAppendix("aidlc-product-lead-agent", 1, "READY"),
      "utf-8",
    );
    // Both a review file and an appended section: the artifact must carry the
    // requested bytes, so this is refused until the section goes.
    const both = runReview(proj, [...request, "--verdict", "READY"]);
    expect(both.status).not.toBe(0);
    expect(both.stderr).toContain("a review file was also written");
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(0);

    // With no review file, the appended section is the (deprecated) review.
    unlinkSync(join(proj, reviewFile));
    const embedded = runReview(proj, [...request, "--verdict", "READY"], {
      AIDLC_TEST_EMBEDDED: "1",
    });
    expect(embedded.status, embedded.stderr).toBe(0);
    const completed = auditBlocks(proj, "REVIEW_COMPLETED")[0];
    expect(auditBlockField(completed, "Request Fingerprint")).toBe(requestFingerprint);
    // The receipt binds the full post-review artifact and names no record.
    expect(auditBlockField(completed, "Artifact Fingerprint")).not.toBe(requestFingerprint);
    expect(auditBlockField(completed, "Review Record")).toBeNull();
    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from stage graph");
    const receipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
      { reviewClass: "advisory" },
    );
    expect(receipts.stageVerdict).toBe("READY");
    expect(latestReviewRecordRefs(proj, stage).get("")).toBeNull();
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
      // The locator sees no appendix: a literal example inside a fence, a
      // comment, or raw HTML is content, so the body view IS the artifact.
      const snapshot = reviewArtifactSnapshot(proj, stage);
      if (!snapshot) throw new Error(`${example.name}: review snapshot failed`);
      expect(snapshot.appendix.length, example.name).toBe(0);
      expect(snapshot.bodyFingerprints, example.name).toEqual([
        snapshot.fingerprint,
      ]);

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
          "Artifact Fingerprint",
        ),
        example.name,
      ).toBe(snapshot.fingerprint);

      // No review was written for the request, and the example is not one:
      // the verdict is refused and the artifact is untouched.
      const unchanged = runReview(
        proj,
        [...request, "--verdict", "READY"],
        { AIDLC_TEST_KEEP_REVIEW: "1", AIDLC_TEST_NO_REVIEW_FILE: "1" },
      );
      expect(unchanged.status, example.name).not.toBe(0);
      expect(unchanged.stderr, example.name).toContain("no review was written");
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
      "output documents changed after review iteration 1 started",
    );

    const retry = runReview(proj, [...request, "--retry-pending"]);
    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain("cannot rebaseline changed content");
    expect(auditBlocks(proj, "REVIEW_REQUESTED")).toHaveLength(1);
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(0);
  });

  test("an incomplete review retries once, and the retry reopens the review slot", () => {
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

    const requested = runReview(proj, request);
    expect(requested.status).toBe(0);
    const { requestId, reviewFile } = JSON.parse(requested.stdout) as {
      requestId: string;
      reviewFile: string;
    };
    const originalFingerprint = auditBlockField(
      auditBlocks(proj, "REVIEW_REQUESTED")[0],
      "Artifact Fingerprint",
    );
    // The reviewer was cut off after starting its review file.
    const draft = join(proj, reviewFile);
    mkdirSync(dirname(draft), { recursive: true });
    writeFileSync(draft, "## Review\n\nfinding without verdict\n", "utf-8");
    const partial = runReview(proj, [...request, "--verdict", "READY"], {
      AIDLC_TEST_NO_REVIEW_FILE: "1",
    });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain("exactly one canonical verdict line");

    // The retry keeps the binding and the id, and empties the slot.
    const retry = runReview(proj, [...request, "--retry-pending"]);
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain('"retry":"pending-request"');
    expect(retry.stdout).toContain(`"requestId":"${requestId}"`);
    expect(existsSync(draft)).toBe(false);
    const requests = auditBlocks(proj, "REVIEW_REQUESTED");
    expect(requests).toHaveLength(2);
    expect(auditBlockField(requests[1], "Artifact Fingerprint")).toBe(
      originalFingerprint,
    );
    expect(auditBlockField(requests[1], "Request Id")).toBe(requestId);
    const secondRetry = runReview(proj, [...request, "--retry-pending"]);
    expect(secondRetry.status).not.toBe(0);
    expect(secondRetry.stderr).toContain(
      "already used its one pending-request retry",
    );
    expect(auditBlocks(proj, "REVIEW_REQUESTED")).toHaveLength(2);

    // The retried dispatch's review completes normally.
    expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);
    expect(readFileSync(artifact, "utf-8")).toBe(original);
  });

  test("a review file that is not a plain file is refused, never read through", () => {
    const proj = seedProject("feature");
    const artifact = writeReviewedArtifact(proj, "requirements-analysis", "reviewed requirements\n");
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];
    const requested = runReview(proj, request);
    expect(requested.status).toBe(0);
    const { reviewFile } = JSON.parse(requested.stdout) as { reviewFile: string };
    const draft = join(proj, reviewFile);
    mkdirSync(dirname(draft), { recursive: true });
    // A genuine review elsewhere on disk, reached only through a symlink.
    const elsewhere = join(proj, "elsewhere-review.md");
    writeFileSync(elsewhere, reviewAppendix("aidlc-product-lead-agent", 1, "READY").trimStart(), "utf-8");
    symlinkSync(elsewhere, draft);
    const viaSlotLink = runReview(proj, [...request, "--verdict", "READY"], {
      AIDLC_TEST_NO_REVIEW_FILE: "1",
    });
    expect(viaSlotLink.status).not.toBe(0);
    expect(viaSlotLink.stderr).toContain("is not a plain readable file");
    unlinkSync(draft);
    const viaFlagLink = runReview(
      proj,
      [...request, "--verdict", "READY", "--review-file", "elsewhere-link.md"],
      { AIDLC_TEST_NO_REVIEW_FILE: "1" },
    );
    expect(viaFlagLink.status).not.toBe(0);
    // A symlinked container for the slot is refused too.
    const attemptDir = dirname(draft);
    const detached = `${attemptDir}.real`;
    renameSync(attemptDir, detached);
    symlinkSync(detached, attemptDir, "dir");
    writeFileSync(join(detached, `${reviewFile.split("/").at(-1)}`), readFileSync(elsewhere), "utf-8");
    const viaDirLink = runReview(proj, [...request, "--verdict", "READY"], {
      AIDLC_TEST_NO_REVIEW_FILE: "1",
    });
    expect(viaDirLink.status).not.toBe(0);
    expect(viaDirLink.stderr).toContain("symlink");
    unlinkSync(attemptDir);
    renameSync(detached, attemptDir);
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(0);
    // The plain file in the slot records normally.
    const completed = runReview(proj, [...request, "--verdict", "READY"]);
    expect(completed.status, completed.stderr).toBe(0);
    expect(readFileSync(artifact, "utf-8")).toBe("reviewed requirements\n");
  });

  test("a retried incomplete review records the NOT-READY fallback without a review", () => {
    const proj = seedProject("feature");
    writeReviewedArtifact(proj, "requirements-analysis", "reviewed requirements\n");
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];
    expect(runReview(proj, request).status).toBe(0);
    // Before the retry the fallback is not open: a missing review is incomplete.
    const early = runReview(proj, [...request, "--verdict", "NOT-READY"], {
      AIDLC_TEST_NO_REVIEW_FILE: "1",
    });
    expect(early.status).not.toBe(0);
    expect(early.stderr).toContain("no review was written");
    expect(runReview(proj, [...request, "--retry-pending"]).status).toBe(0);
    // A READY verdict is never a fallback.
    const ready = runReview(proj, [...request, "--verdict", "READY"], {
      AIDLC_TEST_NO_REVIEW_FILE: "1",
    });
    expect(ready.status).not.toBe(0);
    const fallback = runReview(proj, [...request, "--verdict", "NOT-READY"], {
      AIDLC_TEST_NO_REVIEW_FILE: "1",
    });
    expect(fallback.status, fallback.stderr).toBe(0);
    const completed = auditBlocks(proj, "REVIEW_COMPLETED")[0];
    expect(auditBlockField(completed, "Verdict")).toBe("NOT-READY");
    expect(auditBlockField(completed, "Review Record")).toBeNull();
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

    // Every case is run twice: as the review file (the record path, where the
    // whole file is the section and prose before the heading makes the heading
    // a later H2) and as the deprecated appended section (where the section
    // must open with the heading).
    for (const scenario of cases) {
      for (const path of ["record", "embedded"] as const) {
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
        const requested = runReview(proj, request);
        expect(requested.status, `${scenario.name} (${path})`).toBe(0);
        let expectedError: string = scenario.error;
        if (path === "record") {
          const { reviewFile } = JSON.parse(requested.stdout) as { reviewFile: string };
          const draft = join(proj, reviewFile);
          mkdirSync(dirname(draft), { recursive: true });
          writeFileSync(draft, scenario.suffix, "utf-8");
          if (scenario.name === "semantic bytes before heading") {
            expectedError = "no later rendered H1 or H2 heading";
          }
        } else {
          appendFileSync(artifact, scenario.suffix, "utf-8");
          if (
            scenario.name === "semantic bytes before heading" ||
            scenario.name === "duplicate review section" ||
            scenario.error.includes("H1 or H2 heading")
          ) {
            // Prose or a first section before the terminal section, or a later
            // top-level heading that makes the section non-terminal, all mean
            // the requested bytes changed: the section is not an appendix.
            expectedError = "output documents changed";
          }
        }
        const completed = runReview(proj, [...request, "--verdict", "READY"], {
          AIDLC_TEST_NO_REVIEW_FILE: "1",
        });
        expect(completed.status, `${scenario.name} (${path})`).not.toBe(0);
        expect(completed.stderr, `${scenario.name} (${path})`).toContain(expectedError);
        expect(
          auditBlocks(proj, "REVIEW_COMPLETED"),
          `${scenario.name} (${path})`,
        ).toHaveLength(0);
      }
    }
  }, 60_000); // Native Windows runs every crafted suffix through spawned Bun CLIs.

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
    const completed = runReview(proj, [...request, "--verdict", "READY"], {
      AIDLC_TEST_EMBEDDED: "1",
    });
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
    const completed = runReview(proj, [...request, "--verdict", "READY"], {
      AIDLC_TEST_EMBEDDED: "1",
    });
    expect(completed.status, completed.stderr).toBe(0);
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(1);
  });

  test("an empty primary artifact still takes a review record, and a section appended to it as the deprecated form", () => {
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
    const requested = auditBlocks(proj, "REVIEW_REQUESTED")[0];
    expect(auditBlockField(requested, "Request Id")).toMatch(/^review:[0-9a-f]{32}$/);
    expect(auditBlockField(requested, "Review Appendix Offset")).toBeNull();
    // Deprecated: the whole file becomes the appended section.
    appendFileSync(
      artifact,
      reviewAppendix("aidlc-product-lead-agent", 1, "READY").trimStart(),
      "utf-8",
    );
    const completed = runReview(proj, [...request, "--verdict", "READY"], {
      AIDLC_TEST_EMBEDDED: "1",
    });
    expect(completed.status, completed.stderr).toBe(0);
    expect(auditBlockField(auditBlocks(proj, "REVIEW_COMPLETED")[0], "Review Record")).toBeNull();
  });

  test("review_artifact, not produces order, names the plugin, kind-filtered, and no-DAG reviewed artifact", () => {
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
    expect(pluginSnapshot?.reviewArtifact).toBe(
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
    expect(kindSnapshot?.reviewArtifact).toBe(
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
      snapshotObserver: ({ logicalPath }) => {
        if (!replaced && logicalPath === requested.reviewArtifact) {
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
        // Request Id intentionally omitted: the row cannot pair with the request.
        "Review Record": ".aidlc-reviews/requirements-analysis/stage-level/0123456789abcdef/1.json",
        // Review Record Digest intentionally omitted: a half-named record is no record.
      },
      proj,
    );
    const valid = runReview(proj, [...request, "--verdict", "READY"]);
    expect(valid.status, valid.stderr).toBe(0);
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(2);
    expect(readFileSync(artifact, "utf-8")).toBe("reviewed requirements\n");

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
    // The modern binding is the request id; a fieldless legacy row never had
    // an appendix boundary to echo.
    expect(auditBlockField(requests[1], "Request Id")).toMatch(/^review:[0-9a-f]{32}$/);
    expect(auditBlockField(requests[1], "Review Appendix Artifact")).toBeNull();

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
    expect(auditBlockField(requests[2], "Request Id")).toMatch(/^review:[0-9a-f]{32}$/);
    expect(auditBlockField(requests[2], "Review Appendix Offset")).toBeNull();

    const secondRetry = runReview(proj, [...request, "--retry-pending"]);
    expect(secondRetry.status).not.toBe(0);
    expect(secondRetry.stderr).toContain(
      "already used its one pending-request retry",
    );
    expect(runReview(proj, [...request, "--verdict", "READY"]).status).toBe(0);
  });

  test("a pending legacy request that saw an old appendix completes only from a review file, after one modernizing retry", () => {
    const proj = seedProject("feature");
    const body = "legacy challenge requirements\n";
    const oldAppendix = reviewAppendix(
      "aidlc-product-lead-agent",
      1,
      "READY",
    );
    writeReviewedArtifact(
      proj,
      "requirements-analysis",
      `${body}${oldAppendix}`,
    );
    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from graph");
    const snapshot = reviewArtifactSnapshot(proj, stage);
    if (!snapshot) throw new Error("review snapshot failed");
    // A request the appendix protocol wrote: it fingerprinted the bytes before
    // the section it allowed and pinned that a section already existed.
    appendAuditEntry(
      "REVIEW_REQUESTED",
      {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
        Iteration: "1",
        "Artifact Fingerprint": snapshot.bodyFingerprints[0],
        "Review Appendix Artifact": snapshot.reviewArtifact,
        "Review Appendix Offset": String(Buffer.byteLength(body)),
        "Review Appendix Prior Digest": `sha256:${"c".repeat(64)}`,
        "Review Appendix Prior Length": String(
          Buffer.byteLength(oldAppendix.replace(/^\s+/, "")),
        ),
      },
      proj,
    );
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];

    // The old section is not fresh evidence and there is no review file yet.
    const legacyCompletion = runReview(
      proj,
      [...request, "--verdict", "READY"],
      { AIDLC_TEST_KEEP_REVIEW: "1", AIDLC_TEST_NO_REVIEW_FILE: "1" },
    );
    expect(legacyCompletion.status).not.toBe(0);
    expect(legacyCompletion.stderr).toContain("no review was written");

    // One retry modernizes the request: it gains a request id, keeps its
    // fingerprint, echoes its appendix binding, and is marked as upgraded.
    const upgraded = runReview(proj, [...request, "--retry-pending"]);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toContain('"upgrade":"legacy-request"');
    const requests = auditBlocks(proj, "REVIEW_REQUESTED");
    expect(requests).toHaveLength(2);
    const requestId = auditBlockField(requests[1], "Request Id");
    expect(requestId).toMatch(/^review:[0-9a-f]{32}$/);
    expect(upgraded.stdout).toContain(`"requestId":"${requestId}"`);
    expect(auditBlockField(requests[1], "Artifact Fingerprint")).toBe(
      snapshot.bodyFingerprints[0],
    );
    expect(auditBlockField(requests[1], "Review Appendix Artifact")).toBe(
      snapshot.reviewArtifact,
    );
    expect(auditBlockField(requests[1], "Review Challenge")).toBeNull();

    // The review file completes it; the completion names its record and still
    // pairs with the legacy request through the echoed fields.
    const completed = runReview(
      proj,
      [...request, "--verdict", "READY"],
      { AIDLC_TEST_KEEP_REVIEW: "1" },
    );
    expect(completed.status, completed.stderr).toBe(0);
    const completion = auditBlocks(proj, "REVIEW_COMPLETED")[0];
    expect(auditBlockField(completion, "Request Id")).toBe(requestId);
    expect(auditBlockField(completion, "Review Record")).toMatch(
      /^\.aidlc-reviews\/requirements-analysis\/stage-level\/[0-9a-f]{16}\/1\.json$/,
    );
    expect(auditBlockField(completion, "Review Appendix Artifact")).toBe(
      snapshot.reviewArtifact,
    );
    const receipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
    );
    expect(receipts.stageVerdict).toBe("READY");
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

  test("a pre-request appendix cannot be replayed as fresh reviewer authority", () => {
    const proj = seedProject("feature");
    const body = "reviewed requirements\n";
    const staleAppendix = reviewAppendix(
      "aidlc-product-lead-agent",
      1,
      "READY",
    );
    const artifact = writeReviewedArtifact(
      proj,
      "requirements-analysis",
      `${body}${staleAppendix}`,
    );
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];

    // The request fingerprints the whole artifact, stale section included, and
    // needs no challenge or prior-appendix pin to say so.
    const requestResult = runReview(proj, request, {
      AIDLC_TEST_KEEP_REVIEW: "1",
    });
    expect(requestResult.status, requestResult.stderr).toBe(0);
    const requested = auditBlocks(proj, "REVIEW_REQUESTED")[0];
    expect(auditBlockField(requested, "Request Id")).toMatch(/^review:[0-9a-f]{32}$/);
    expect(auditBlockField(requested, "Review Challenge")).toBeNull();
    expect(auditBlockField(requested, "Review Appendix Prior Digest")).toBeNull();
    const stage = resolveStage("requirements-analysis");
    if (!stage) throw new Error("requirements-analysis missing from graph");
    const requestedSnapshot = reviewArtifactSnapshot(proj, stage);
    if (!requestedSnapshot) throw new Error("review snapshot failed");
    expect(auditBlockField(requested, "Artifact Fingerprint")).toBe(
      requestedSnapshot.fingerprint,
    );

    // No artifact byte changed after the request: the pre-existing canonical
    // section is not fresh evidence, and no review was written.
    const replay = runReview(
      proj,
      [...request, "--verdict", "READY"],
      { AIDLC_TEST_KEEP_REVIEW: "1", AIDLC_TEST_NO_REVIEW_FILE: "1" },
    );
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain("no review was written");
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(0);
    expect(readFileSync(artifact, "utf-8")).toBe(`${body}${staleAppendix}`);

    // Shifting, extending, or mutating the stale section changes the reviewed
    // bytes: the body before the section is not the requested artifact.
    for (const [name, content] of [
      ["shifted", `${body}\n${staleAppendix}`],
      ["extended", `${body}${staleAppendix}\nUnrelated post-request note.\n`],
      ["mutated", `${body}${staleAppendix.replace("No blocking findings.", "No blocking findings!")}`],
      [
        "replaced",
        `${body}${reviewAppendix(
          "aidlc-product-lead-agent",
          1,
          "READY",
          "Fresh reviewer pass over the requested bytes.",
        )}`,
      ],
    ] as const) {
      writeFileSync(artifact, content, "utf-8");
      const refused = runReview(
        proj,
        [...request, "--verdict", "READY"],
        { AIDLC_TEST_KEEP_REVIEW: "1", AIDLC_TEST_NO_REVIEW_FILE: "1" },
      );
      expect(refused.status, name).not.toBe(0);
      expect(refused.stderr, name).toContain("output documents changed");
      expect(auditBlocks(proj, "REVIEW_COMPLETED"), name).toHaveLength(0);
    }

    // The review goes to its record; the artifact keeps the exact requested
    // bytes, stale section and all, as inert content.
    writeFileSync(artifact, `${body}${staleAppendix}`, "utf-8");
    const fresh = runReview(
      proj,
      [...request, "--verdict", "READY"],
      { AIDLC_TEST_KEEP_REVIEW: "1" },
    );
    expect(fresh.status, fresh.stderr).toBe(0);
    const completed = auditBlocks(proj, "REVIEW_COMPLETED")[0];
    expect(auditBlockField(completed, "Request Fingerprint")).toBe(
      requestedSnapshot.fingerprint,
    );
    expect(auditBlockField(completed, "Artifact Fingerprint")).toBe(
      requestedSnapshot.fingerprint,
    );
    expect(auditBlockField(completed, "Review Record")).toMatch(
      /^\.aidlc-reviews\/requirements-analysis\/stage-level\/[0-9a-f]{16}\/1\.json$/,
    );
    expect(auditBlockField(completed, "Review Record Digest")).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(readFileSync(artifact, "utf-8")).toBe(`${body}${staleAppendix}`);
    const receipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
    );
    expect(receipts.stageVerdict).toBe("READY");
  });

  test("an attempt reset cannot reuse the previous attempt's review for the same reviewer, iteration, and verdict", () => {
    const proj = seedProject("feature");
    const body = "reviewed requirements\n";
    const artifact = writeReviewedArtifact(proj, "requirements-analysis", body);
    const request = [
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
      "--iteration", "1",
    ];

    // Attempt 1, the deprecated embedded form: request -> reviewer appends ->
    // READY receipt, so the artifact now carries attempt 1's section.
    expect(runReview(proj, request).status).toBe(0);
    expect(
      runReview(proj, [...request, "--verdict", "READY"], { AIDLC_TEST_EMBEDDED: "1" }).status,
    ).toBe(0);
    const attemptOneAppendix = readFileSync(artifact, "utf-8").slice(
      body.length,
    );
    expect(attemptOneAppendix).toContain("## Review");
    const attemptOneRecord = auditBlockField(
      auditBlocks(proj, "REVIEW_COMPLETED")[0],
      "Review Record",
    );
    expect(attemptOneRecord).toBeNull();

    // Attempt reset: ordinals restart at 1 while the attempt-1 section is
    // still present in the artifact.
    const second = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === second) {}
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, proj);
    appendAuditEntry("STAGE_STARTED", {
      Stage: "requirements-analysis",
      Agent: "aidlc-product-agent",
    }, proj);

    expect(
      runReview(proj, request, { AIDLC_TEST_KEEP_REVIEW: "1" }).status,
    ).toBe(0);
    const requests = auditBlocks(proj, "REVIEW_REQUESTED");
    expect(requests).toHaveLength(2);
    // The new request's artifact fingerprint covers the whole file, section
    // included; each request has its own id.
    expect(auditBlockField(requests[1], "Request Id")).not.toBe(
      auditBlockField(requests[0], "Request Id"),
    );
    expect(auditBlockField(requests[1], "Artifact Fingerprint")).not.toBe(
      auditBlockField(requests[0], "Artifact Fingerprint"),
    );

    // Same reviewer, same iteration ordinal, same verdict, zero byte changes:
    // the attempt-1 section is not attempt-2 reviewer evidence, and no review
    // was written for attempt 2's request.
    const replay = runReview(
      proj,
      [...request, "--verdict", "READY"],
      { AIDLC_TEST_KEEP_REVIEW: "1", AIDLC_TEST_NO_REVIEW_FILE: "1" },
    );
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain("no review was written");
    expect(auditBlocks(proj, "REVIEW_COMPLETED")).toHaveLength(1);

    // Deleting attempt 1's section and writing a fresh one changes the
    // requested bytes; the reset attempt's review belongs in its record.
    writeFileSync(
      artifact,
      `${body}${reviewAppendix(
        "aidlc-product-lead-agent",
        1,
        "READY",
        "Re-reviewed after the attempt reset.",
      )}`,
      "utf-8",
    );
    const rewritten = runReview(
      proj,
      [...request, "--verdict", "READY"],
      { AIDLC_TEST_KEEP_REVIEW: "1", AIDLC_TEST_NO_REVIEW_FILE: "1" },
    );
    expect(rewritten.status).not.toBe(0);
    expect(rewritten.stderr).toContain("output documents changed");
    writeFileSync(artifact, `${body}${attemptOneAppendix}`, "utf-8");
    const fresh = runReview(
      proj,
      [...request, "--verdict", "READY"],
      { AIDLC_TEST_KEEP_REVIEW: "1" },
    );
    expect(fresh.status, fresh.stderr).toBe(0);
    const completions = auditBlocks(proj, "REVIEW_COMPLETED");
    expect(completions).toHaveLength(2);
    expect(auditBlockField(completions[1], "Review Record")).toMatch(
      /^\.aidlc-reviews\/requirements-analysis\/stage-level\/[0-9a-f]{16}\/1\.json$/,
    );
    // Two attempts, two records slots: the reset attempt's record does not
    // overwrite anything attempt 1 could have written.
    expect(auditBlockField(completions[1], "Request Id")).toBe(
      auditBlockField(requests[1], "Request Id"),
    );
  });

  test("an audit merge carries a review record only with a completion that descends from its request, verified, once", () => {
    const worktreeRoot = join(createTestProject(), "wt-record");
    const mainRoot = join(createTestProject(), "main-record");
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(mainRoot, { recursive: true });
    const requestId = `review:${"a".repeat(32)}`;
    const artifactFingerprint = `sha256:${"b".repeat(64)}`;
    const record: ReviewRecord = {
      version: 1,
      stage: "code-generation",
      unit: "alpha",
      workflow: null,
      attempt: "0123456789abcdef",
      iteration: 1,
      reviewer: "aidlc-architecture-reviewer-agent",
      verdict: "READY",
      request_id: requestId,
      request_challenge: null,
      artifact_fingerprint: artifactFingerprint,
      source_fingerprint: null,
      unit_source_fingerprint: null,
      findings: [],
      body: "## Review\n\n**Verdict:** READY\n",
      recorded_at: "2026-09-02T00:00:00Z",
    };
    const bytes = serializeReviewRecord(record);
    const path = reviewRecordRelativePath("code-generation", "alpha", record.attempt, 1);
    const source = join(worktreeRoot, ...path.split("/"));
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, bytes, "utf-8");
    const digest = reviewRecordDigest(bytes);
    const block = (event: string, fields: Record<string, string>, extra = ""): string =>
      [
        `## ${event}`,
        "**Timestamp**: 2026-09-02T00:00:01Z",
        `**Event**: ${event}`,
        ...Object.entries(fields).map(([key, value]) => `**${key}**: ${value}`),
        ...(extra ? [extra] : []),
        "",
        "---",
        "",
      ].join("\n");
    const scope = {
      Stage: "code-generation",
      Reviewer: "aidlc-architecture-reviewer-agent",
      Unit: "alpha",
      Iteration: "1",
    };
    const request = (overrides: Record<string, string> = {}): string =>
      block("REVIEW_REQUESTED", {
        ...scope,
        "Artifact Fingerprint": artifactFingerprint,
        "Request Id": requestId,
        ...overrides,
      });
    const completion = (overrides: Record<string, string> = {}, extra = ""): string =>
      block(
        "REVIEW_COMPLETED",
        {
          ...scope,
          Verdict: "READY",
          "Request Fingerprint": artifactFingerprint,
          "Artifact Fingerprint": artifactFingerprint,
          "Request Id": requestId,
          "Review Record": path,
          "Review Record Digest": digest,
          ...overrides,
        },
        extra,
      );
    const paired = request() + completion();
    const mainCopy = join(mainRoot, ...path.split("/"));

    // Descent, not presence: a completion that names a record must pair with a
    // request in the same delta on every identity field, or the merge refuses.
    for (const [name, delta] of [
      ["no request", completion()],
      ["different request id", request({ "Request Id": `review:${"c".repeat(32)}` }) + completion()],
      ["different reviewer", request({ Reviewer: "aidlc-product-lead-agent" }) + completion()],
      ["different unit", request({ Unit: "beta" }) + completion()],
      ["different workflow", request({ Workflow: "single-stage:code-generation" }) + completion()],
      ["different iteration", request({ Iteration: "2" }) + completion()],
      ["different fingerprint", request({ "Artifact Fingerprint": `sha256:${"d".repeat(64)}` }) + completion()],
      ["completion id differs", request() + completion({ "Request Id": `review:${"c".repeat(32)}` })],
      ["digest missing", request() + completion().replace(`**Review Record Digest**: ${digest}\n`, "")],
    ] as const) {
      expect(() => mergeReviewRecordsFromDelta(delta, worktreeRoot, mainRoot), name).toThrow(
        /does not descend from a REVIEW_REQUESTED row/,
      );
      expect(existsSync(mainCopy), name).toBe(false);
    }
    // A repeated field on either row is refused before any pairing is attempted.
    for (const [name, delta] of [
      ["duplicate request id on the request", request().replace("\n---\n", `\n**Request Id**: review:${"c".repeat(32)}\n---\n`) + completion()],
      ["duplicate record on the completion", request() + completion({}, `**Review Record**: ${path}`)],
      ["duplicate unit on the completion", request() + completion({}, "**Unit**: beta")],
    ] as const) {
      expect(() => mergeReviewRecordsFromDelta(delta, worktreeRoot, mainRoot), name).toThrow(
        /repeated field/,
      );
      expect(existsSync(mainCopy), name).toBe(false);
    }
    // A legacy embedded completion names no record and carries nothing, and it
    // still answers its request: a later row naming a record cannot ride the
    // same request.
    const embeddedCompletion = completion().replace(
      `**Review Record**: ${path}\n**Review Record Digest**: ${digest}\n`,
      "",
    );
    expect(
      mergeReviewRecordsFromDelta(request() + embeddedCompletion, worktreeRoot, mainRoot),
    ).toEqual({ copied: [], present: [] });
    expect(() =>
      mergeReviewRecordsFromDelta(request() + embeddedCompletion + completion(), worktreeRoot, mainRoot),
    ).toThrow(/does not descend from a REVIEW_REQUESTED row/);
    expect(existsSync(mainCopy)).toBe(false);

    // A genuine record from another scope, named with its true digest by a
    // paired row, is still not the review of that row.
    const otherRecord = serializeReviewRecord({ ...record, unit: "beta" });
    const otherPath = reviewRecordRelativePath("code-generation", "beta", record.attempt, 1);
    const otherSource = join(worktreeRoot, ...otherPath.split("/"));
    mkdirSync(dirname(otherSource), { recursive: true });
    writeFileSync(otherSource, otherRecord, "utf-8");
    expect(() =>
      mergeReviewRecordsFromDelta(
        request() + completion({ "Review Record": otherPath, "Review Record Digest": reviewRecordDigest(otherRecord) }),
        worktreeRoot,
        mainRoot,
      ),
    ).toThrow(/is not the review its REVIEW_COMPLETED row describes/);
    expect(existsSync(join(mainRoot, ...otherPath.split("/")))).toBe(false);

    // The paired delta copies once; a retry finds the same bytes present.
    expect(mergeReviewRecordsFromDelta(paired, worktreeRoot, mainRoot)).toEqual({
      copied: [path],
      present: [],
    });
    expect(readFileSync(mainCopy, "utf-8")).toBe(bytes);
    expect(mergeReviewRecordsFromDelta(paired, worktreeRoot, mainRoot)).toEqual({
      copied: [],
      present: [path],
    });

    // Main already holds a different record at that path: refuse, never overwrite.
    writeFileSync(mainCopy, bytes.replace("READY", "NOT-READY"), "utf-8");
    expect(() => mergeReviewRecordsFromDelta(paired, worktreeRoot, mainRoot)).toThrow(/different bytes/);
    writeFileSync(mainCopy, bytes, "utf-8");
    // A main-side container that became a symlink is refused, not written through.
    unlinkSync(mainCopy);
    const mainAttemptDir = dirname(mainCopy);
    const mainDetached = `${mainAttemptDir}.real`;
    renameSync(mainAttemptDir, mainDetached);
    symlinkSync(mainDetached, mainAttemptDir, "dir");
    expect(() => mergeReviewRecordsFromDelta(paired, worktreeRoot, mainRoot)).toThrow(/symlink/);
    unlinkSync(mainAttemptDir);
    renameSync(mainDetached, mainAttemptDir);
    writeFileSync(mainCopy, bytes, "utf-8");

    // The worktree record must be exactly what its row pinned: a regular file,
    // not a hardlink or a symlinked container, within the size a record can have.
    writeFileSync(source, bytes.replace("READY", "NOT-READY"), "utf-8");
    expect(() => mergeReviewRecordsFromDelta(paired, worktreeRoot, mainRoot)).toThrow(/does not match the digest/);
    writeFileSync(source, bytes, "utf-8");
    const alias = `${source}.alias`;
    linkSync(source, alias);
    expect(() => mergeReviewRecordsFromDelta(paired, worktreeRoot, mainRoot)).toThrow(/hardlink/);
    unlinkSync(alias);
    const attemptDir = dirname(source);
    const detached = `${attemptDir}.real`;
    renameSync(attemptDir, detached);
    symlinkSync(detached, attemptDir, "dir");
    expect(() => mergeReviewRecordsFromDelta(paired, worktreeRoot, mainRoot)).toThrow(/symlink/);
    unlinkSync(attemptDir);
    renameSync(detached, attemptDir);
    const oversize = `${bytes}${" ".repeat(REVIEW_RECORD_MAX_BYTES)}`;
    writeFileSync(source, oversize, "utf-8");
    expect(() =>
      mergeReviewRecordsFromDelta(
        request() + completion({ "Review Record Digest": reviewRecordDigest(oversize) }),
        worktreeRoot,
        mainRoot,
      ),
    ).toThrow(/above the .*-byte limit/);
    unlinkSync(source);
    expect(() => mergeReviewRecordsFromDelta(paired, worktreeRoot, mainRoot)).toThrow(
      /unreadable in the worktree/,
    );
  });
});
