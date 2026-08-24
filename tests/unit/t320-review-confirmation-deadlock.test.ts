// covers: function:checkSummaryConfirmationEvidence, function:recoveryGuidance,
// subcommand:aidlc-log:review, hook:aidlc-review-freeze

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  checkSummaryConfirmationEvidence,
  loadStageGraphAll,
  readAllAuditShards,
  recoveryGuidance,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  REVIEW_FREEZE_FALLBACK_GUIDANCE,
  reviewFreezeRecoveryGuidance,
} from "../../dist/claude/.claude/hooks/aidlc-review-freeze.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-review-freeze.ts");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function project(fixture = "state-mid-inception.md"): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, fixture);
  return proj;
}

function run(
  tool: string,
  args: string[],
  proj: string,
  extraEnv: NodeJS.ProcessEnv = {},
  clearEnv: string[] = [],
) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  for (const name of clearEnv) delete env[name];
  const result = Bun.spawnSync({
    cmd: [BUN, tool, ...args, "--project-dir", proj],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return {
    status: result.exitCode,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
  };
}

function requirementsPaths(proj: string) {
  const dir = join(
    seededRecordDir(proj),
    "inception",
    "requirements-analysis",
  );
  mkdirSync(dir, { recursive: true });
  return {
    artifact: join(dir, "requirements.md"),
    questions: join(dir, "requirements-analysis-questions.md"),
  };
}

function writeQuestions(path: string, answer = ""): void {
  writeFileSync(
    path,
    [
      "# Requirements Questions",
      "",
      "## Consolidated Summary Confirmation",
      "",
      "- Looks correct",
      "- Request changes",
      "",
      `[Answer]: ${answer}`,
      "",
    ].join("\n"),
  );
}

function beginConfirmation(proj: string, questions: string): void {
  writeQuestions(questions);
  const decision = run(
    LOG,
    [
      "decision",
      "--stage",
      "requirements-analysis",
      "--checkpoint",
      "summary-confirmation",
      "--questions-file",
      questions,
      "--decision",
      "Does this all look correct?",
    ],
    proj,
    {},
    ["AIDLC_SKIP_HUMAN_PRESENCE_GUARD"],
  );
  expect(decision.status).toBe(0);
  appendAuditEntry("HUMAN_TURN", {}, proj);
  writeQuestions(questions, "Looks correct");
}

function finishConfirmation(proj: string, questions: string): void {
  const answer = run(
    LOG,
    [
      "answer",
      "--stage",
      "requirements-analysis",
      "--checkpoint",
      "summary-confirmation",
      "--questions-file",
      questions,
      "--details",
      "Looks correct",
    ],
    proj,
    {},
    ["AIDLC_SKIP_HUMAN_PRESENCE_GUARD"],
  );
  expect(answer.status).toBe(0);
}

function confirm(proj: string, questions: string): void {
  beginConfirmation(proj, questions);
  finishConfirmation(proj, questions);
}

function writeArtifact(
  proj: string,
  artifact: string,
  event: "ARTIFACT_CREATED" | "ARTIFACT_UPDATED",
  content = "# Requirements\n",
): void {
  writeFileSync(artifact, content);
  appendAuditEntry(event, { File: artifact, Tool: "Write" }, proj);
}

function review(proj: string, verdict?: "READY" | "NOT-READY") {
  return run(
    LOG,
    [
      "review",
      "--stage",
      "requirements-analysis",
      "--reviewer",
      "aidlc-product-lead-agent",
      "--iteration",
      "1",
      ...(verdict ? ["--verdict", verdict] : []),
    ],
    proj,
    {},
    ["AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD"],
  );
}

function runHook(
  proj: string,
  target: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const result = Bun.spawnSync({
    cmd: [BUN, HOOK],
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...extraEnv },
    stdin: Buffer.from(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: target },
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stderr: result.stderr.toString(),
  };
}

function withSummaryGuard<T>(fn: () => T): T {
  const prior = process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  try {
    return fn();
  } finally {
    if (prior === undefined) {
      delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    } else {
      process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = prior;
    }
  }
}

describe("t320 review/summary deadlock prevention", () => {
  test("duplicate same-SHA confirmation keeps authorization, freeze, and gate progress", () => {
    const proj = project();
    const { artifact, questions } = requirementsPaths(proj);
    confirm(proj, questions);
    writeArtifact(proj, artifact, "ARTIFACT_CREATED");
    expect(review(proj).status).toBe(0);
    expect(review(proj, "READY").status).toBe(0);

    confirm(proj, questions);
    const state = readFileSync(seededStateFile(proj), "utf-8");
    const stage = loadStageGraphAll().find(
      (entry) => entry.slug === "requirements-analysis",
    )!;
    expect(
      withSummaryGuard(
        () =>
          checkSummaryConfirmationEvidence(proj, stage, {
            stateContent: state,
          }).ok,
      ),
    ).toBe(true);

    const blocked = runHook(proj, artifact);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain(
      "tell me what should change and I'll record your Request Changes decision",
    );
    expect(
      runHook(proj, artifact, {
        AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "1",
      }).status,
    ).toBe(0);

    const gate = run(
      STATE,
      ["gate-start", "requirements-analysis"],
      proj,
      {
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
        AIDLC_SKIP_SOURCE_FRESHNESS: "1",
      },
      [
        "AIDLC_SKIP_ARTIFACT_GUARD",
        "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
      ],
    );
    expect(gate.status).toBe(0);
  });

  test("late first confirmation cannot be reviewed before evidence exists", () => {
    const proj = project();
    const { artifact, questions } = requirementsPaths(proj);
    beginConfirmation(proj, questions);
    writeArtifact(proj, artifact, "ARTIFACT_CREATED");

    const refused = review(proj);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(
      "no fresh human-backed consolidated summary confirmation is recorded",
    );
    expect(readAllAuditShards(proj)).not.toContain(
      "**Event**: REVIEW_REQUESTED",
    );

    finishConfirmation(proj, questions);
    const wrongOrder = review(proj);
    expect(wrongOrder.status).not.toBe(0);
    expect(wrongOrder.stderr).toContain(
      "was not saved after the confirmed answers",
    );
    expect(wrongOrder.stderr).toContain("Save the document after confirmation");
    expect(wrongOrder.stderr).not.toContain("Request Changes decision");
    writeArtifact(proj, artifact, "ARTIFACT_UPDATED", "# Requirements v2\n");
    expect(review(proj).status).toBe(0);
  });

  test("changed answers refuse evidence with direct confirmation guidance", () => {
    const proj = project();
    const { artifact, questions } = requirementsPaths(proj);
    confirm(proj, questions);
    writeArtifact(proj, artifact, "ARTIFACT_CREATED");
    writeFileSync(questions, `${readFileSync(questions, "utf-8")}\nChanged\n`);

    const stage = loadStageGraphAll().find(
      (entry) => entry.slug === "requirements-analysis",
    )!;
    const evidence = withSummaryGuard(() =>
      checkSummaryConfirmationEvidence(proj, stage, {
        stateContent: readFileSync(seededStateFile(proj), "utf-8"),
      }),
    );
    expect(evidence.ok).toBe(false);
    if (evidence.ok) throw new Error("expected changed-answer refusal");
    expect(evidence.message).toContain(
      "changed after the human confirmed its summary",
    );
    expect(evidence.message).not.toContain("Request Changes decision");
  });

  test("review request refuses when any required output document is missing", () => {
    const proj = project("state-construction-with-worktree.md");
    seedBoltDag(proj, ["alpha"]);
    const dir = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "code-generation",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code-generation-plan.md"), "# Plan\n");

    const refused = run(
      LOG,
      [
        "review",
        "--stage",
        "code-generation",
        "--reviewer",
        "aidlc-architecture-reviewer-agent",
        "--unit",
        "alpha",
        "--iteration",
        "1",
      ],
      proj,
      {},
      [
        "AIDLC_SKIP_ARTIFACT_GUARD",
        "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
      ],
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("a required output document is missing");
    expect(refused.stderr).toContain(
      "Create every required output document for this stage",
    );
  });

  test("an unresolvable Unit set still refuses a per-unit review, and a stage-level review is admitted", () => {
    const proj = project("state-construction-with-worktree.md");
    const dir = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "code-generation",
    );
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "code-generation-plan.md",
      "unit-test-instructions.md",
      "code-summary.md",
      "traceability.json",
    ]) {
      writeFileSync(join(dir, name), `# ${name}\n`);
    }

    const accepted = run(
      LOG,
      [
        "review",
        "--stage",
        "code-generation",
        "--reviewer",
        "aidlc-architecture-reviewer-agent",
        "--unit",
        "alpha",
        "--iteration",
        "1",
      ],
      proj,
      {},
      [
        "AIDLC_SKIP_ARTIFACT_GUARD",
        "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
      ],
    );
    // Base behaviour, deliberately preserved: with no authoritative Unit set
    // and no active Bolt attempt, a per-unit review request is refused and the
    // refusal names both executable routes. Membership admission is only
    // skipped where the set is unverifiable AND a Bolt attempt is live.
    expect(accepted.status).not.toBe(0);
    expect(accepted.stdout + accepted.stderr).toContain(
      "no authoritative unit DAG exists and no matching active Bolt attempt",
    );

    const stageLevelProj = project("state-construction-with-worktree.md");
    const stageLevel = run(
      LOG,
      [
        "review",
        "--stage",
        "code-generation",
        "--reviewer",
        "aidlc-architecture-reviewer-agent",
        "--iteration",
        "1",
      ],
      stageLevelProj,
      {},
      [
        "AIDLC_SKIP_ARTIFACT_GUARD",
        "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
      ],
    );
    expect(stageLevel.status).toBe(0);
    expect(stageLevel.stdout).toContain('"emitted":"REVIEW_REQUESTED"');
  });
});

describe("t320 recovery guidance", () => {
  test("maps every checkbox and absent-stage state to one executable exit", () => {
    expect(
      recoveryGuidance(
        "/p",
        "- [-] requirements-analysis — EXECUTE",
        "requirements-analysis",
      ),
    ).toContain("Request Changes decision");
    expect(
      recoveryGuidance(
        "/p",
        "- [R] requirements-analysis — EXECUTE",
        "requirements-analysis",
      ),
    ).toContain("/aidlc --stage requirements-analysis");
    expect(
      recoveryGuidance(
        "/p",
        "- [x] requirements-analysis — EXECUTE",
        "requirements-analysis",
      ),
    ).toContain("restore the reviewed source state");
    for (const state of [
      "- [ ] requirements-analysis — EXECUTE",
      "- [-] another-stage — EXECUTE",
    ]) {
      expect(
        recoveryGuidance("/p", state, "requirements-analysis"),
      ).toContain("/aidlc --stage requirements-analysis");
    }

    const proj = project();
    const statePath = seededStateFile(proj);
    const skippedState = readFileSync(statePath, "utf-8")
      .replace(
        "## Stage Progress\n\n",
        "## Stage Progress\n<!-- Checkbox states -->\n",
      )
      .replace(
        "- [S] user-stories — SKIP (bugfix scope)",
        "- [ ] user-stories — SKIP (bugfix scope)",
      );
    writeFileSync(statePath, skippedState);
    const skippedGuidance = recoveryGuidance(
      proj,
      skippedState,
      "user-stories",
    );
    expect(skippedGuidance).toContain("/aidlc --scope");
    expect(skippedGuidance).not.toContain("/aidlc compose");
    expect(skippedGuidance).not.toContain("/aidlc --stage user-stories");
    expect(
      run(JUMP, ["resolve", "--stage", "user-stories"], proj).status,
    ).not.toBe(0);

    const scopeChange = run(
      UTILITY,
      ["scope-change", "--scope", "feature"],
      proj,
    );
    expect(scopeChange.status).toBe(0);
    const onPlanState = readFileSync(statePath, "utf-8");
    expect(onPlanState).toContain("user-stories — EXECUTE");
    expect(
      recoveryGuidance(proj, onPlanState, "user-stories"),
    ).toContain("/aidlc --stage user-stories");
    expect(
      run(JUMP, ["resolve", "--stage", "user-stories"], proj).status,
    ).toBe(0);
  });

  test("freeze guidance falls back to static text when the helper throws", () => {
    expect(
      reviewFreezeRecoveryGuidance(
        "/p",
        "- [-] requirements-analysis — EXECUTE",
        "requirements-analysis",
        () => {
          throw new Error("injected failure");
        },
      ),
    ).toBe(REVIEW_FREEZE_FALLBACK_GUIDANCE);
  });
});
