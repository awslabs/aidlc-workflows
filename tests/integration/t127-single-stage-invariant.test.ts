// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-audit:append, subcommand:aidlc-audit:append-batch, function:emitSingleRunStage, function:handleSingleReport, function:clearActiveDirectiveMarker, function:refuseReservedCliEvent, function:refuseReservedCliBatch
//
// t127 - the `--single` stage-runner invariant.
// Mechanism: cli. The whole subject is the engine's PROCESS boundary —
// `next --stage <slug> --single` / `report --single --stage <slug>` argv,
// the JSON directive on stdout, the bytes the synthetic lifecycle appends
// to the per-intent audit shard, AND the pointer-invariant read of the main
// state file via aidlc-state.ts get. Every assertion is observable only across
// that boundary, so each case SPAWNS the real tool via the BUN runtime
// against the .ts path.
//
// Source under test (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   handleNext - `if (flags.single)` short-circuits BEFORE the
//          jump/scope-change branches (so no mutating path is reached): rejects
//          --single+--phase, requires --stage, else delegates to
//   emitSingleRunStage: builds the lone run-stage directive from the GRAPH
//          NODE alone (stateContent: null -> never reads/writes the main
//          pointer), attaches conductor_persona. Refuses an initialization
//          stage (SINGLE_INIT_ERROR); a SKIP-for-scope stage runs, with a change
//          notice saying it is not part of the plan.
//   handleSingleReport(flags, projectDir): requires --result,
//          and the EXPLICIT half of the pointer rule — refuses a --single report
//          with NO --stage as an attempt to advance the main workflow.
//          `next --single` records STAGE_STARTED before dispatch; on success
//          report records STAGE_COMPLETED under the same synthetic id
//          `single-stage:<slug>`, then emits a `done` directive.
//          report routes here before any main-workflow branch.
//   The companion never dispatches advance/approve/complete-workflow, so the
//   main pointer is structurally untouchable from a single-stage run.
//
// The state-pointer read uses aidlc-state.ts `get "Current Stage"`, spawned the
// same way, asserting the field is `feasibility` before AND after each --single
// leg.
//
// Tests 11/13/14/16 are the tool-enforced REFUSALS - each asserts the `error`
// directive ACTUALLY fires (the verbatim refusal string), and test 12 proves the
// refused report commits NOTHING (zero STAGE_COMPLETED on disk). The happy-path
// pointer cases (5,7) additionally read the real state file back, proving the
// pointer is unmoved - not merely absent of a move directive.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  recordArtifactWriteViaHook,
  runOrchestrateNext,
  seedAuditFile,
  seededAuditShard,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  createCodeGenerationProject,
  next as codeGenerationNext,
  writePlan,
} from "../harness/code-generation-states.ts";
import {
  artifactFilename,
  loadStageGraphAll,
  SUMMARY_CONFIRMATION_HASH_SCOPE,
  summaryConfirmationContentHash,
  stateDigest,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE_TOOL = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const LOG_TOOL = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE_FIXTURE = "state-mid-ideation.md";

function activeDirectiveMarkerPath(proj: string): string {
  return join(seededRecordDir(proj), ".aidlc-engine/active-directive.json");
}

const projects: string[] = [];

afterEach(() => {
  for (const p of projects.splice(0)) cleanupTestProject(p);
});

function freshProject(): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  return proj;
}

/** Combined stdout+stderr of a spawned orchestrate/state invocation. */
function run(tool: string, args: string[]): { out: string; status: number } {
  if (tool === TOOL && args[0] === "next") {
    const projectIndex = args.indexOf("--project-dir");
    const project = args[projectIndex + 1];
    const nextArgs = [
      ...args.slice(1, projectIndex),
      ...args.slice(projectIndex + 2),
    ];
    const result = runOrchestrateNext(tool, project, nextArgs);
    return { out: result.out, status: result.status };
  }
  const res = spawnSync(BUN, [tool, ...args], { encoding: "utf-8" });
  return {
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    status: res.status ?? -1,
  };
}

function runSummaryGuarded(
  tool: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { out: string; status: number } {
  const env = { ...process.env, ...extraEnv };
  delete env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const res = spawnSync(BUN, [tool, ...args], { encoding: "utf-8", env });
  return {
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    status: res.status ?? -1,
  };
}

function startSingle(proj: string, stage: string): void {
  const result = run(TOOL, [
    "next",
    "--stage",
    stage,
    "--single",
    "--project-dir",
    proj,
  ]);
  expect(result.status, result.out).toBe(0);
  expect(result.out).toContain('"kind":"run-stage"');
  expect(result.out).toContain(`"stage":"${stage}"`);
}

function currentStage(proj: string): string {
  return run(STATE_TOOL, ["get", "Current Stage", "--project-dir", proj]).out.trim();
}

function countEvent(proj: string, event: string): number {
  // The synthetic pair lands in the seeded record's per-clone shard
  // (the fixture pins the clone-id, so the report subprocess and the test
  // resolve the SAME shard).
  const body = readFileSync(seededAuditShard(proj), "utf-8");
  return body.split("\n").filter((l) => l === `**Event**: ${event}`).length;
}

// ===========================================================================
// Tests 1-7: pointer invariant across next --single + report --single.
// Seed an ACTIVE feature workflow parked at `feasibility` (Current Stage),
// run a DIFFERENT stage (code-generation) via --single, and prove neither
// leg moves the main pointer off `feasibility`. Each test rebuilds the same
// seeded project so the cases are order-independent.
// ===========================================================================
describe("t127 --single pointer invariant (migrated from t127-single-stage-invariant.sh, plan 16)", () => {
  test("1: main workflow starts parked at feasibility [.sh 1]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    expect(currentStage(proj)).toBe("feasibility");
  });

  test("2: next --single emits a run-stage directive [.sh 2]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "code-generation", "--single", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"kind":"run-stage"');
  });

  test("2b: next --single marks the isolated non-gated conductor branch", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "code-generation", "--single", "--project-dir", proj,
    ]);
    const directive = JSON.parse(r.out.trim()) as Record<string, unknown>;
    expect(directive.single).toBe(true);
    expect(directive.gate).toBe(false);
    expect(directive.next_stage).toBeNull();
  });

  test("3: next --single targets the requested stage, not Current Stage [.sh 3]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "code-generation", "--single", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"stage":"code-generation"');
  });

  test("4: next --single delivers the conductor persona on the first directive (D-E) [.sh 4]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "code-generation", "--single", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"conductor_persona"');
  });

  test("5: next --single leaves the main Current Stage untouched [.sh 5]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    expect(currentStage(proj)).toBe("feasibility");
    run(TOOL, ["next", "--stage", "code-generation", "--single", "--project-dir", proj]);
    expect(currentStage(proj)).toBe("feasibility");
  });

  test("6: report --single emits a done directive [.sh 6]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    startSingle(proj, "code-generation");
    const r = run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    expect(r.out).toContain('"kind":"done"');
    // The isolated run is over; its done never says the main workflow goes on.
    expect(r.out).not.toContain("workflow_continues");
  });

  test("7: report --single leaves the main Current Stage untouched [.sh 7]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    startSingle(proj, "code-generation");
    run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    expect(currentStage(proj)).toBe("feasibility");
  });

  // =========================================================================
  // Tests 8-10: the synthetic-id audit pair lands, tagged, audit-only.
  // Seed audit-sample.md (which carries ZERO STAGE_STARTED/STAGE_COMPLETED
  // rows — verified), so the post-commit counts are exactly the pair the
  // --single report wrote.
  // =========================================================================
  test("8: next --single commits exactly one STAGE_STARTED [.sh 8]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    startSingle(proj, "code-generation");
    run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    expect(countEvent(proj, "STAGE_STARTED")).toBe(1);
  });

  test("9: report --single commits exactly one STAGE_COMPLETED [.sh 9]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    startSingle(proj, "code-generation");
    run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    expect(countEvent(proj, "STAGE_COMPLETED")).toBe(1);
  });

  test("10: the synthetic pair is tagged with the single-stage workflow id [.sh 10]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    startSingle(proj, "code-generation");
    run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    const body = readFileSync(seededAuditShard(proj), "utf-8");
    // syntheticWorkflowId("code-generation") === "single-stage:code-generation".
    const tagged = body
      .split("\n")
      .filter((l) => l === "**Workflow**: single-stage:code-generation").length;
    expect(tagged).toBe(2);
  });

  test("10b: append-batch validates the complete pair before writing either row", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const before = readFileSync(seededAuditShard(proj), "utf-8");
    const entries = JSON.stringify([
      {
        eventType: "STAGE_STARTED",
        fields: {
          Stage: "code-generation",
          Workflow: "single-stage:code-generation",
        },
      },
      {
        eventType: "NOT_A_REAL_EVENT",
        fields: {
          Stage: "code-generation",
          Workflow: "single-stage:code-generation",
        },
      },
    ]);

    const result = run(AUDIT_TOOL, [
      "append-batch",
      entries,
      "--project-dir",
      proj,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.out).toContain("Invalid event type: NOT_A_REAL_EVENT");
    expect(readFileSync(seededAuditShard(proj), "utf-8")).toBe(before);
  });

  test("10c: public audit append cannot forge a summary-confirmation receipt", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const before = readFileSync(seededAuditShard(proj), "utf-8");
    const result = run(AUDIT_TOOL, [
      "append",
      "SUMMARY_CONFIRMATION_RECORDED",
      "--field",
      "Stage=requirements-analysis",
      "--project-dir",
      proj,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("reserved for its owning hook/tool");
    expect(readFileSync(seededAuditShard(proj), "utf-8")).toBe(before);
  });

  // =========================================================================
  // Tests 11-12: report --single with NO --stage is an attempt to advance the
  // main workflow -> error (tool-enforced refusal), committing nothing.
  // =========================================================================
  test("11: report --single with no --stage errors (refuses to advance the main workflow) [.sh 11]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const r = run(TOOL, [
      "report", "--single", "--result", "completed", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("must not advance the main workflow");
  });

  test("12: the refused report --single commits no STAGE_COMPLETED [.sh 12]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    run(TOOL, ["report", "--single", "--result", "completed", "--project-dir", proj]);
    expect(countEvent(proj, "STAGE_COMPLETED")).toBe(0);
  });

  test("12b: report --single rejects skipped because it is a main-workflow routing outcome", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const r = run(TOOL, [
      "report",
      "--single",
      "--stage",
      "code-generation",
      "--result",
      "skipped",
      "--reason",
      "not applicable",
      "--project-dir",
      proj,
    ]);
    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("commits forward outcomes only");
    expect(currentStage(proj)).toBe("feasibility");
    expect(countEvent(proj, "STAGE_STARTED")).toBe(0);
    expect(countEvent(proj, "STAGE_COMPLETED")).toBe(0);
    expect(countEvent(proj, "STAGE_SKIPPED")).toBe(0);
  });

  test("12c: report --single refuses a question-bearing stage without summary confirmation", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    startSingle(proj, "requirements-analysis");
    const result = runSummaryGuarded(TOOL, [
      "report",
      "--single",
      "--stage",
      "requirements-analysis",
      "--result",
      "completed",
      "--project-dir",
      proj,
    ]);
    expect(result.out).toContain('"kind":"error"');
    expect(result.out).toContain("has no requirements-analysis-questions.md");
    expect(countEvent(proj, "STAGE_COMPLETED")).toBe(0);
  });

  test("12d: report --single accepts a human-backed receipt and post-confirmation artifact", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const state = readFileSync(join(seededRecordDir(proj), "aidlc-state.md"), "utf-8");
    mkdirSync(dirname(activeDirectiveMarkerPath(proj)), { recursive: true });
    writeFileSync(
      activeDirectiveMarkerPath(proj),
      `${JSON.stringify({
        version: 1,
        stage: "feasibility",
        state_sha256: stateDigest(state),
      })}\n`,
    );
    expect(
      run(TOOL, [
        "next",
        "--stage",
        "requirements-analysis",
        "--single",
        "--project-dir",
        proj,
      ]).out,
    ).toContain('"stage":"requirements-analysis"');
    expect(
      JSON.parse(
        readFileSync(activeDirectiveMarkerPath(proj), "utf-8"),
      ) as { stage?: string },
    ).toMatchObject({ stage: "requirements-analysis" });
    const stageDir = join(
      seededRecordDir(proj),
      "inception",
      "requirements-analysis",
    );
    mkdirSync(stageDir, { recursive: true });
    const questions = join(stageDir, "requirements-analysis-questions.md");
    writeFileSync(
      questions,
      "# Questions\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: \n",
    );

    expect(
      runSummaryGuarded(LOG_TOOL, [
        "decision",
        "--stage",
        "requirements-analysis",
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--single",
        "--decision",
        "Does this all look correct?",
        "--project-dir",
        proj,
      ]).status,
    ).toBe(0);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    writeFileSync(
      questions,
      "# Questions\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: Looks correct\n",
    );
    expect(
      runSummaryGuarded(LOG_TOOL, [
        "answer",
        "--stage",
        "requirements-analysis",
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--single",
        "--details",
        "Looks correct",
        "--project-dir",
        proj,
      ]).status,
    ).toBe(0);

    const artifact = join(stageDir, "requirements.md");
    writeFileSync(artifact, "# Requirements\n");
    recordArtifactWriteViaHook(proj, artifact);

    const result = runSummaryGuarded(TOOL, [
      "report",
      "--single",
      "--stage",
      "requirements-analysis",
      "--result",
      "completed",
      "--project-dir",
      proj,
    ]);
    expect(result.out).toContain('"kind":"done"');
    expect(countEvent(proj, "STAGE_COMPLETED")).toBe(1);
    expect(existsSync(activeDirectiveMarkerPath(proj))).toBe(false);
  });

  test("12e: an isolated per-unit stage binds its receipt to the selected questions file", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    startSingle(proj, "functional-design");
    const stageDir = join(
      seededRecordDir(proj),
      "construction",
      "api",
      "functional-design",
    );
    mkdirSync(stageDir, { recursive: true });
    const questions = join(stageDir, "functional-design-questions.md");
    writeFileSync(
      questions,
      "# Questions\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: \n",
    );
    expect(
      runSummaryGuarded(LOG_TOOL, [
        "decision",
        "--stage",
        "functional-design",
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--single",
        "--decision",
        "Does this all look correct?",
        "--project-dir",
        proj,
      ]).status,
    ).toBe(0);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    writeFileSync(
      questions,
      "# Questions\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: Looks correct\n",
    );
    expect(
      runSummaryGuarded(LOG_TOOL, [
        "answer",
        "--stage",
        "functional-design",
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--single",
        "--details",
        "Looks correct",
        "--project-dir",
        proj,
      ]).status,
    ).toBe(0);
    for (const name of [
      "entities",
      "rules",
      "functional-spec",
    ]) {
      const artifact = join(stageDir, `${name}.md`);
      writeFileSync(artifact, `# ${name}\n`);
      recordArtifactWriteViaHook(proj, artifact);
    }

    const result = runSummaryGuarded(TOOL, [
      "report",
      "--single",
      "--stage",
      "functional-design",
      "--result",
      "completed",
      "--project-dir",
      proj,
    ]);
    expect(result.out).toContain('"kind":"done"');
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  describe("isolated NFR review with a parent plan that skips Units Generation", () => {
    const stage = "nfr-requirements";
    const guardedEnv = {
      AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
      AIDLC_SKIP_ARTIFACT_GUARD: "0",
    };

    function prepare(
      parentScope: "feature" | "classic",
      confirmation: "single" | "main" | "none" = "single",
    ) {
      const proj = freshProject();
      seedStateFile(proj, STATE_FIXTURE);
      seedAuditFile(proj);
      const statePath = join(seededRecordDir(proj), "aidlc-state.md");
      const parentState = readFileSync(statePath, "utf-8")
        .replace("- **Scope**: feature", `- **Scope**: ${parentScope}`)
        .replace(
          /^- \[[^\]]+\] units-generation.*$/m,
          "- [S] units-generation — SKIP",
        )
        .replace(
          "## Scope Configuration",
          "## Scope Configuration\n- **Summary Confirmation**: on (set by you)",
        );
      writeFileSync(statePath, parentState);
      const started = runOrchestrateNext(
        TOOL,
        proj,
        ["--stage", stage, "--single"],
        { env: { ...process.env, ...guardedEnv } },
      );
      expect(started.status, started.out).toBe(0);
      expect(started.directive).toMatchObject({
        kind: "run-stage",
        single: true,
        ceremony: { summary_confirmation: parentScope === "classic" ? "off" : "on" },
      });
      expect(started.directive?.produces).toContain(
        `${relative(proj, seededRecordDir(proj)).replaceAll("\\", "/")}/construction/{unit-name}/${stage}/security-requirements.md`,
      );
      const stageDir = join(seededRecordDir(proj), "construction", "api", stage);
      mkdirSync(stageDir, { recursive: true });
      const questions = join(stageDir, `${stage}-questions.md`);
      const body = "# Questions\n\n## Q1\nEncrypt stored credentials.\n\n" +
        "## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: ";
      writeFileSync(questions, `${body}\n`);
      const identity = [
        "--stage", stage, "--checkpoint", "summary-confirmation",
        "--questions-file", questions,
        ...(confirmation === "single" ? ["--single"] : []),
        "--project-dir", proj,
      ];
      if (confirmation !== "none") {
        const decision = runSummaryGuarded(LOG_TOOL, [
          "decision", ...identity, "--decision", "Does this all look correct?",
        ], guardedEnv);
        expect(decision.status, decision.out).toBe(0);
        appendAuditEntry("HUMAN_TURN", {}, proj);
      }
      writeFileSync(questions, `${body}Looks correct\n`);
      if (confirmation !== "none") {
        const answer = runSummaryGuarded(LOG_TOOL, [
          "answer", ...identity, "--details", "Looks correct",
        ], guardedEnv);
        expect(answer.status, answer.out).toBe(0);
      }
      const node = loadStageGraphAll().find((entry) => entry.slug === stage)!;
      for (const name of node.produces ?? []) {
        const artifact = join(stageDir, artifactFilename(name));
        writeFileSync(artifact, `# ${name}\n`);
        recordArtifactWriteViaHook(proj, artifact);
      }
      return { proj, questions, statePath, parentState };
    }

    function requestReview(proj: string) {
      return runSummaryGuarded(LOG_TOOL, [
        "review", "--stage", stage, "--single",
        "--reviewer", "aidlc-architecture-reviewer-agent", "--iteration", "1",
        "--project-dir", proj,
      ], guardedEnv);
    }

    test(
      "review and completion accept the isolated Unit's confirmation",
      () => {
        const { proj, statePath, parentState } = prepare("feature");
        const review = requestReview(proj);
        expect(review.status, review.out).toBe(0);
        expect(review.out).toContain('"emitted":"REVIEW_REQUESTED"');
        const report = runSummaryGuarded(TOOL, [
          "report", "--single", "--stage", stage, "--result", "completed",
          "--project-dir", proj,
        ], guardedEnv);
        expect(report.out).toContain('"kind":"done"');
        expect(readFileSync(statePath, "utf-8")).toBe(parentState);
      },
      NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
    );

    test.each([
      ["none", "no fresh human-backed"],
      ["main", "no fresh human-backed"],
      ["stale", "changed after the human confirmed"],
    ] as const)("review still refuses %s confirmation evidence", (condition, message) => {
      const { proj, questions } = prepare("feature", condition === "stale" ? "single" : condition);
      if (condition === "stale") {
        writeFileSync(questions, readFileSync(questions, "utf-8").replace(
          "Encrypt stored credentials.", "Require hardware-backed keys.",
        ));
      }
      const review = requestReview(proj);
      expect(review.status, review.out).not.toBe(0);
      expect(review.out).toContain(message);
      expect(countEvent(proj, "REVIEW_REQUESTED")).toBe(0);
    });

    test("placement isolation preserves the review caller's explicit ceremony setting", () => {
      const { proj, questions, statePath, parentState } = prepare("classic", "none");
      writeFileSync(statePath, parentState.replace(
        "**Summary Confirmation**: on (set by you)",
        "**Summary Confirmation**: off (set by you)",
      ));
      rmSync(questions);
      const review = requestReview(proj);
      expect(review.status, review.out).toBe(0);
      expect(review.out).toContain('"emitted":"REVIEW_REQUESTED"');
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  });

  test("12f: isolated hash recovery stays on the --single workflow", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    startSingle(proj, "requirements-analysis");
    const stageDir = join(
      seededRecordDir(proj),
      "inception",
      "requirements-analysis",
    );
    mkdirSync(stageDir, { recursive: true });
    const questions = join(stageDir, "requirements-analysis-questions.md");
    const confirmed =
      "# Questions\n\n## Consolidated Summary Confirmation\n\n" +
      "- Keep the confirmed requirement.\n\n[Answer]: Looks correct\n";
    writeFileSync(questions, confirmed);
    appendAuditEntry(
      "SUMMARY_CONFIRMATION_RECORDED",
      {
        Stage: "requirements-analysis",
        Details: "Looks correct",
        Checkpoint: "Consolidated Summary Confirmation",
        Workflow: "single-stage:requirements-analysis",
        "Questions File": relative(proj, questions).replaceAll("\\", "/"),
        "Questions SHA-256": summaryConfirmationContentHash(confirmed),
        "Hash Scope": SUMMARY_CONFIRMATION_HASH_SCOPE,
      },
      proj,
    );
    writeFileSync(
      questions,
      confirmed.replace("confirmed requirement", "modified requirement"),
    );
    const artifact = join(stageDir, "requirements.md");
    writeFileSync(artifact, "# Requirements\n");
    recordArtifactWriteViaHook(proj, artifact);

    const result = runSummaryGuarded(TOOL, [
      "report",
      "--single",
      "--stage",
      "requirements-analysis",
      "--result",
      "completed",
      "--project-dir",
      proj,
    ]);
    expect(result.out).toContain('"kind":"error"');
    expect(result.out).toContain("aidlc-log.ts decision");
    expect(result.out).toContain("aidlc-log.ts answer");
    expect(result.out).toContain("--single");
    expect(result.out).toContain("report --single");
    expect(result.out).toContain("--result completed");
    expect(result.out).not.toContain("--result rejected");
    expect(result.out).not.toContain("--result revised");
  });

  // =========================================================================
  // Test 13: next --single requires --stage.
  // =========================================================================
  test("13: next --single with no --stage errors [.sh 13]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, ["next", "--single", "--project-dir", proj]);
    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("--single requires --stage");
  });

  // =========================================================================
  // Test 14: an initialization stage cannot run via --single.
  // =========================================================================
  test("14: next --single rejects an initialization stage (use --init) [.sh 14]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "workspace-detection", "--single", "--project-dir", proj,
    ]);
    expect(r.out).toContain("initialization stage with --single");
  });

  // =========================================================================
  // Test 15: a SKIP-for-scope stage runs via --single when asked for.
  // `user-stories` is SKIP for bugfix. An isolated run never touches the plan
  // or the cursor, so it runs, with one change notice saying it is not part
  // of the plan. Use a NO-STATE project so the explicit --scope bugfix
  // resolves (an active workflow's state Scope would win the precedence ladder).
  // =========================================================================
  test("15: next --single runs a SKIP-for-scope stage and says it is not in the plan [.sh 15]", () => {
    const proj = freshProject();
    // No-state project: freshProject leaves no aidlc-state.md. The flag --scope
    // bugfix therefore resolves.
    const r = run(TOOL, [
      "next", "--stage", "user-stories", "--single", "--scope", "bugfix",
      "--project-dir", proj,
    ]);
    const directive = JSON.parse(r.out.split("\n").find((line) => line.startsWith("{")) ?? "{}") as {
      kind?: string;
      stage?: string;
      single?: boolean;
      change_notices?: string[];
    };
    expect(directive.kind, r.out).toBe("run-stage");
    expect(directive.stage).toBe("user-stories");
    expect(directive.single).toBe(true);
    expect(directive.change_notices).toContain(
      "\"user-stories\" is not part of the bugfix plan. It runs on its own because you asked for it; " +
        "the plan and your workflow stay as they are.",
    );
    expect(r.out).not.toContain("is skipped for scope");
  });

  // =========================================================================
  // Test 16: --single + --phase is mutually exclusive.
  // =========================================================================
  test("16: next --single --phase errors (one stage, not a range) [.sh 16]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--single", "--phase", "inception", "--project-dir", proj,
    ]);
    expect(r.out).toContain("Cannot use --single with --phase");
  });

  // =========================================================================
  // Test 17 (#2654): a depth or test strategy typed with --single is that
  // run's alone. It is recorded on the isolated start and rides on the
  // run-stage; the workflow's own settings stay as they are. A Guard Policy or
  // check cannot be the run's own, so it is refused, naming no config set.
  // Review and ceremony flags meet their own refusals earlier in handleNext.
  // =========================================================================
  type SingleDirective = {
    kind?: string;
    message?: string;
    single?: boolean;
    depth?: string;
    test_strategy?: string;
  };

  function nextSingleStage(proj: string, stage: string, extra: string[]): SingleDirective {
    const r = run(TOOL, ["next", "--stage", stage, "--single", ...extra, "--project-dir", proj]);
    return JSON.parse(r.out.trim()) as SingleDirective;
  }

  function nextSingle(proj: string, extra: string[]): SingleDirective {
    const r = run(TOOL, ["next", "--stage", "build-and-test", "--single", ...extra, "--project-dir", proj]);
    return JSON.parse(r.out.trim()) as SingleDirective;
  }

  function startedBlocks(proj: string): string[] {
    return readFileSync(seededAuditShard(proj), "utf-8")
      .split("\n---")
      .filter((block) => block.includes("**Event**: STAGE_STARTED"));
  }

  function seededSingleProject(): string {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    return proj;
  }

  test("17: next --single --test-strategy runs the stage with it and leaves the workflow's as it is", () => {
    const proj = seededSingleProject();
    const directive = nextSingle(proj, ["--test-strategy", "comprehensive"]);
    expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
    expect(directive.single).toBe(true);
    expect(directive.test_strategy).toBe("Comprehensive");
    expect(directive.depth).toBeUndefined();
    const started = startedBlocks(proj);
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("**Workflow**: single-stage:build-and-test");
    expect(started[0]).toContain("**Test Strategy**: Comprehensive");
    expect(run(STATE_TOOL, ["get", "Test Strategy", "--project-dir", proj]).out.trim()).toBe("Standard");
    expect(currentStage(proj)).toBe("feasibility");
  });

  test("17b: next --single with a depth and a test strategy carries both", () => {
    const proj = seededSingleProject();
    const directive = nextSingle(proj, ["--depth", "minimal", "--test-strategy", "comprehensive"]);
    expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
    expect(directive.depth).toBe("Minimal");
    expect(directive.test_strategy).toBe("Comprehensive");
    expect(startedBlocks(proj)[0]).toContain("**Depth**: Minimal");
  });

  test("17c: a re-run of the open attempt keeps its settings; a different one starts it over", () => {
    const proj = seededSingleProject();
    expect(nextSingle(proj, ["--depth", "minimal"]).kind).toBe("run-stage");
    const again = nextSingle(proj, []);
    expect(again.kind, JSON.stringify(again)).toBe("run-stage");
    expect(again.depth).toBe("Minimal");
    expect(startedBlocks(proj)).toHaveLength(1);
    // The person asked for Standard: the stage starts over with it. The
    // unfinished attempt is set aside, never recorded as completed.
    const other = nextSingle(proj, ["--depth", "standard"]) as SingleDirective & { change_notices?: string[] };
    expect(other.kind, JSON.stringify(other)).toBe("run-stage");
    expect(other.depth).toBe("Standard");
    expect(other.change_notices?.join("\n")).toContain("starts over with the settings you gave");
    const started = startedBlocks(proj);
    expect(started).toHaveLength(2);
    expect(started[1]).toContain("**Depth**: Standard");
    expect(readFileSync(seededAuditShard(proj), "utf-8")).not.toContain("**Event**: STAGE_COMPLETED");
    // Its re-run keeps the new attempt's setting.
    expect(nextSingle(proj, []).depth).toBe("Standard");
  });

  test("17c2: a typed depth picks the knowledge the stage loads, on the first part and after the steering continuation", () => {
    const roster = (extra: string[], steered: boolean) => {
      const proj = freshProject();
      // Rules too large for one message make the step arrive in parts, so the
      // final run-stage is the one `continue` rebuilds from the recorded start.
      if (steered) {
        writeFileSync(join(proj, "aidlc/spaces/default/memory/org.md"),
          Array.from({ length: 180 }, (_, i) => `## Rule ${i}\n\n${"x".repeat(320)}\n`).join("\n"));
      }
      const r = runOrchestrateNext(TOOL, proj, [
        "--scope", "bugfix", "--stage", "requirements-analysis", "--single", ...extra,
      ]);
      const directive = r.directive as { kind?: string; depth?: string; test_strategy?: string; inline_context_paths?: string[] } | null;
      expect(directive?.kind, r.out).toBe("run-stage");
      if (steered) expect(r.steering.length, r.out).toBeGreaterThan(1);
      return { paths: directive?.inline_context_paths ?? [], depth: directive?.depth, testStrategy: directive?.test_strategy };
    };
    // bugfix runs at Minimal, which prunes the lead's knowledge.
    const minimal = roster([], false);
    const comprehensive = roster(["--depth", "comprehensive"], false);
    expect(comprehensive.paths.length).toBeGreaterThan(minimal.paths.length);
    for (const path of minimal.paths) expect(comprehensive.paths).toContain(path);
    const continued = roster(["--depth", "comprehensive", "--test-strategy", "comprehensive"], true);
    expect(continued.depth).toBe("Comprehensive");
    expect(continued.testStrategy).toBe("Comprehensive");
    expect(continued.paths).toEqual(comprehensive.paths);
  });

  test("17c3: an isolated Code Generation run's Testing Contract follows its own test strategy; the workflow's does not", () => {
    const proj = seededSingleProject();
    const POSTURE_TOOL = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
    const contractStrategy = (): string => {
      const r = spawnSync(BUN, [POSTURE_TOOL, "render", "--project-dir", proj], { encoding: "utf-8" });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      const json = r.stdout.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "{}";
      return (JSON.parse(json) as { test_strategy?: string }).test_strategy ?? "";
    };
    expect(contractStrategy()).toBe("standard");

    const started = nextSingleStage(proj, "code-generation", ["--test-strategy", "comprehensive"]);
    expect(started.kind, JSON.stringify(started)).toBe("run-stage");
    expect(started.test_strategy).toBe("Comprehensive");
    expect(contractStrategy()).toBe("comprehensive");

    // The plan carries that contract, and the engine takes it: it asks for
    // Plan Approval instead of calling the contract out of date.
    const planDir = join(seededRecordDir(proj), "construction", "code-generation");
    mkdirSync(planDir, { recursive: true });
    const render = spawnSync(BUN, [POSTURE_TOOL, "render", "--project-dir", proj], { encoding: "utf-8" });
    writeFileSync(
      join(planDir, "code-generation-plan.md"),
      "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" + render.stdout,
      "utf-8",
    );
    writeFileSync(join(planDir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n", "utf-8");
    const asked = nextSingleStage(proj, "code-generation", []) as SingleDirective & { ask_type?: string };
    expect(asked.kind, JSON.stringify(asked)).toBe("ask");
    expect(asked.ask_type).toBe("plan-approval");
    expect(contractStrategy()).toBe("comprehensive");

    // The workflow's own setting and contract stay as they were.
    expect(run(STATE_TOOL, ["get", "Test Strategy", "--project-dir", proj]).out.trim()).toBe("Standard");
    expect(run(TOOL, ["next", "--project-dir", proj]).status).toBe(0);
    expect(contractStrategy()).toBe("standard");
  });

  test("17c4: an interrupted isolated Code Generation run leaves the workflow's own plan approval as it was", () => {
    const proj = createCodeGenerationProject();
    projects.push(proj);
    writePlan(proj);
    // The workflow's Standard plan is ready: the engine asks to approve it.
    expect(codeGenerationNext(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    // An isolated Comprehensive run starts and is left open.
    const isolated = codeGenerationNext(proj, ["--stage", "code-generation", "--single", "--test-strategy", "comprehensive"]);
    expect(isolated).toMatchObject({ kind: "run-stage", single: true, test_strategy: "Comprehensive" });
    // Back on the workflow, its plan still matches its own Testing Contract.
    expect(codeGenerationNext(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("17d: with no workflow, next --single --test-strategy runs the stage with it", () => {
    const proj = freshProject();
    const directive = nextSingle(proj, ["--test-strategy", "comprehensive"]);
    expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
    expect(directive.test_strategy).toBe("Comprehensive");
  });

  for (const [flag, value] of [
    ["--guard-policy", "relaxed"],
    ["--guard.review-freeze", "off"],
  ] as const) {
    test(`17e: next --single ${flag} errors, names no config set and starts nothing`, () => {
      const proj = seededSingleProject();
      const directive = nextSingle(proj, [flag, value]);
      expect(directive.kind, JSON.stringify(directive)).toBe("error");
      expect(directive.message).toContain(`Cannot use --single with ${flag}.`);
      expect(directive.message).not.toContain("config set");
      expect(startedBlocks(proj)).toHaveLength(0);
    });
  }

  test("17f: next --single with a ceremony flag stays refused", () => {
    const proj = seededSingleProject();
    const directive = nextSingle(proj, ["--sensors", "off"]);
    expect(directive.kind, JSON.stringify(directive)).toBe("error");
    expect(directive.message).toContain("Cannot combine ceremony flags");
    expect(startedBlocks(proj)).toHaveLength(0);
  });

  test("17g: plain next --stage build-and-test --single carries no settings of its own", () => {
    const proj = seededSingleProject();
    const directive = nextSingle(proj, []);
    expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
    expect(directive.single).toBe(true);
    expect(directive.depth).toBeUndefined();
    expect(directive.test_strategy).toBeUndefined();
    expect(startedBlocks(proj)).toHaveLength(1);
  });
});
