// covers: function:codeGenerationPlanApprovalQuestionEvidence, function:recordPlanApprovalReceipt,
// function:beginCodeGeneration, function:evaluateCodeGenerationApproval,
// function:recordAcceptedChanges, function:changeAlreadyAccepted,
// function:writeWorkspaceSourceSnapshot, function:readWorkspaceSourceSnapshot,
// function:workspaceSourceChangedPaths, function:sourceListingChangedPaths,
// subcommand:aidlc-log:decision, subcommand:aidlc-log:answer,
// subcommand:aidlc-testing-posture:fingerprint, subcommand:aidlc-testing-posture:begin,
// hook:aidlc-plan-approval-guard, audit:CHANGE_ACCEPTED
//
// t334 - Change Control at the Plan Approval checkpoint. The plan binds to the
// workspace source it was written against; when that source moves after the
// human approved (or is about to approve), `strict` refuses with the remedy and
// `relaxed` records one CHANGE_ACCEPTED row naming the files, tells the human
// once, re-baselines the recorded source, and continues into generation. The
// content members of the approval (plan, instructions, Testing Contract) reopen
// approval under BOTH values: Change Control never touches them.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  CHANGE_CONTROL_FIELD,
  readAuditShardEvents,
  readPlanApprovalReceipt,
  setField,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
const HUMAN_TURN = join(AIDLC_SRC, "hooks", "aidlc-record-human-turn.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
}, 30000);

type Spawned = { code: number; stdout: string; stderr: string };

function spawn(cmd: string[], project: string, stdin?: string): Spawned {
  const result = Bun.spawnSync(cmd, {
    cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The `change_notices` array a tool printed, narrowed at runtime; empty when absent. */
function changeNotices(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  if (parsed === null || typeof parsed !== "object" || !("change_notices" in parsed)) return [];
  const notices = parsed.change_notices;
  if (!Array.isArray(notices) || !notices.every((entry) => typeof entry === "string")) {
    throw new Error(`change_notices is not a string array: ${stdout}`);
  }
  return notices;
}

function acceptedRows(project: string) {
  return readAuditShardEvents(project).filter((entry) => entry.event === "CHANGE_ACCEPTED");
}

/** A code-generation project at the plan step, on `mode`, with a git baseline. */
function createProject(mode: "strict" | "relaxed"): string {
  const project = setupIntegrationProject({ withState: "state-brownfield-feature.md" });
  projects.push(project);
  const statePath = join(seededRecordDir(project), "aidlc-state.md");
  let state = readFileSync(statePath, "utf-8")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace(
      /^- \[[ xSR?-]\] code-generation(\s+\S\s+)EXECUTE$/m,
      "- [-] code-generation$1EXECUTE",
    );
  state = setField(state, CHANGE_CONTROL_FIELD, `${mode} (set by you)`);
  writeFileSync(statePath, state, "utf-8");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "base.ts"), "export const base = 1;\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const run = Bun.spawnSync(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  }
  writeActiveDirectiveMarker(project, {
    kind: "run-stage",
    stage: "code-generation",
    state_sha256: stateDigest(state),
  });
  return project;
}

/** Write the plan and instructions, run the shipped fingerprint command, write the questions file. */
function presentPlan(project: string): string {
  const contract = resolveTestingPosture(project);
  const dir = codeGenerationRecordDir(project, null);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    `# Plan\n\n${renderTestingContract(contract)}\n## Steps\n\n- [ ] Implement\n`,
  );
  writeFileSync(
    join(dir, "unit-test-instructions.md"),
    "# Unit Test Instructions\n\n## Command\n\n`bun test unit.test.ts`\n",
  );
  const questions = join(dir, "code-generation-questions.md");
  writeFileSync(questions, "## Plan Approval\n[Answer]:\n");
  const printed = spawn([BUN, POSTURE, "fingerprint", "--stage-level", "--project-dir", project], project);
  expect(printed.code, printed.stderr).toBe(0);
  const tags = printed.stdout.trim().split("\n");
  expect(tags).toHaveLength(2);
  writeFileSync(
    questions,
    ["## Plan Approval", ...tags, "A. Approve Plan", "B. Request Changes", "[Answer]:", ""].join("\n"),
  );
  return questions;
}

function identity(questions: string, session: string): string[] {
  return [
    "--stage",
    "code-generation",
    "--checkpoint",
    "plan-approval",
    "--questions-file",
    questions,
    "--session",
    session,
    "--stage-level",
  ];
}

function decide(project: string, questions: string, session: string): Spawned {
  return spawn(
    [
      BUN,
      LOG,
      "decision",
      ...identity(questions, session),
      "--decision",
      "Approve this exact Code Generation plan?",
      "--options",
      "Approve Plan,Request Changes",
      "--project-dir",
      project,
    ],
    project,
  );
}

function humanTurn(project: string, session: string): void {
  const human = spawn(
    [BUN, HUMAN_TURN],
    project,
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Approve Plan" }),
  );
  expect(human.code, human.stderr).toBe(0);
}

function answer(project: string, questions: string, session: string): Spawned {
  writeFileSync(
    questions,
    readFileSync(questions, "utf-8").replace(/\[Answer\]:\s*$/, "[Answer]: Approve Plan"),
  );
  return spawn(
    [BUN, LOG, "answer", ...identity(questions, session), "--details", "Approve Plan", "--project-dir", project],
    project,
  );
}

function begin(project: string): Spawned {
  return spawn([BUN, POSTURE, "begin", "--stage-level", "--project-dir", project], project);
}

function plannedSourceTag(questions: string): string {
  const match = /^\[Planned Source\]: (\S+)$/m.exec(readFileSync(questions, "utf-8"));
  expect(match).not.toBeNull();
  return match![1];
}

function startSession(project: string, session: string): void {
  appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
}

describe("t334 (1) relaxed accepts source drift at the checkpoint record and re-baselines the tag", () => {
  test("drift between the fingerprint and the decision is recorded once, told once, and the tag moves", () => {
    const project = createProject("relaxed");
    const questions = presentPlan(project);
    const planned = plannedSourceTag(questions);
    writeFileSync(join(project, "src", "drifted.ts"), "export const drifted = 1;\n");
    startSession(project, "relaxed-decision");

    const decision = decide(project, questions, "relaxed-decision");
    expect(decision.code, decision.stderr).toBe(0);
    expect(changeNotices(decision.stdout)).toEqual([
      "1 file changed since this plan was approved: src/drifted.ts. Continuing (Change Control: relaxed). Say 'review the plan again' to reopen approval.",
    ]);
    const rebaselined = plannedSourceTag(questions);
    expect(rebaselined).not.toBe(planned);

    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Stage")).toBe("code-generation");
    expect(auditBlockField(rows[0].block, "Unit")).toBeNull();
    expect(auditBlockField(rows[0].block, "Checkpoint")).toBe("plan-approval");
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/drifted.ts");
    expect(auditBlockField(rows[0].block, "Recorded")).toBe(planned);
    expect(auditBlockField(rows[0].block, "Current")).toBe(rebaselined);

    // The approval then completes against the re-baselined source and generation begins.
    humanTurn(project, "relaxed-decision");
    const answered = answer(project, questions, "relaxed-decision");
    expect(answered.code, answered.stderr).toBe(0);
    expect(changeNotices(answered.stdout)).toEqual([]);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
    const started = begin(project);
    expect(started.code, started.stderr).toBe(0);
    expect(changeNotices(started.stdout)).toEqual([]);
    expect(acceptedRows(project)).toHaveLength(1);
  }, 60000);
});

describe("t334 (2) relaxed accepts source drift at the answer and certifies the source found", () => {
  test("drift between the decision and the answer records once; the receipt carries the new source and generation begins", () => {
    const project = createProject("relaxed");
    const questions = presentPlan(project);
    const planned = plannedSourceTag(questions);
    startSession(project, "relaxed-answer");
    expect(decide(project, questions, "relaxed-answer").code).toBe(0);
    humanTurn(project, "relaxed-answer");
    writeFileSync(join(project, "src", "late.ts"), "export const late = 1;\n");
    writeFileSync(join(project, "src", "base.ts"), "export const base = 2;\n");

    const answered = answer(project, questions, "relaxed-answer");
    expect(answered.code, answered.stderr).toBe(0);
    expect(changeNotices(answered.stdout)).toEqual([
      "2 files changed since this plan was approved: src/base.ts, src/late.ts. Continuing (Change Control: relaxed). Say 'review the plan again' to reopen approval.",
    ]);
    // The tag is what the human saw; the receipt is what generation compares against.
    expect(plannedSourceTag(questions)).toBe(planned);
    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/base.ts, src/late.ts");
    expect(auditBlockField(rows[0].block, "Recorded")).toBe(planned);

    const approval = evaluateCodeGenerationApproval(project, { unit: null });
    expect(approval.ok).toBe(true);
    const authority = resolveCodeGenerationAuthority(project, { unit: null });
    const receipt = readPlanApprovalReceipt(project, {
      targetId: authority.targetId,
      runFloor: authority.runFloor,
      fingerprint: approval.approvalFingerprint!,
    });
    expect(receipt?.certifiedSourceSha256).toBe(auditBlockField(rows[0].block, "Current") ?? "");
    expect(receipt?.plannedSourceSha256).toBe(planned);

    const started = begin(project);
    expect(started.code, started.stderr).toBe(0);
    expect(changeNotices(started.stdout)).toEqual([]);
    expect(acceptedRows(project)).toHaveLength(1);
  }, 60000);
});

describe("t334 (3) relaxed accepts source drift at generation start and re-baselines the receipt", () => {
  test("drift after approval is accepted once through the shipped begin and dispatch guard", () => {
    const project = createProject("relaxed");
    const questions = presentPlan(project);
    startSession(project, "relaxed-begin");
    expect(decide(project, questions, "relaxed-begin").code).toBe(0);
    humanTurn(project, "relaxed-begin");
    expect(answer(project, questions, "relaxed-begin").code).toBe(0);
    const approval = evaluateCodeGenerationApproval(project, { unit: null });
    expect(approval.ok).toBe(true);
    writeFileSync(join(project, "src", "after.ts"), "export const after = 1;\n");

    // The dispatch guard re-checks the source; under relaxed it stays current.
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
    expect(acceptedRows(project)).toHaveLength(0);

    const guard = spawn(
      [BUN, GUARD],
      project,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "aidlc-developer-agent",
          prompt: `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: sha256:${"0".repeat(64)}`,
        },
        cwd: project,
      }),
    );
    // Whatever the dispatch marker check decides, the accepted drift is the
    // same row: the hook's generation start recorded it once.
    const rowsAfterGuard = acceptedRows(project);
    const started = begin(project);
    expect(started.code, started.stderr).toBe(0);
    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/after.ts");
    expect(auditBlockField(rows[0].block, "Details")).toBe(
      "1 file changed since this plan was approved: src/after.ts. Continuing (Change Control: relaxed). Say 'review the plan again' to reopen approval.",
    );
    const noticed = rowsAfterGuard.length === 1 ? guard.stdout : started.stdout;
    expect(noticed).toContain("1 file changed since this plan was approved: src/after.ts.");
    const authority = resolveCodeGenerationAuthority(project, { unit: null });
    const receipt = readPlanApprovalReceipt(project, {
      targetId: authority.targetId,
      runFloor: authority.runFloor,
      fingerprint: approval.approvalFingerprint!,
    });
    expect(receipt?.status).toBe("generation");
    expect(receipt?.certifiedSourceSha256).toBe(auditBlockField(rows[0].block, "Current") ?? "");
    // Generation has begun; the same change is never reported again.
    expect(begin(project).code).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
    expect(acceptedRows(project)).toHaveLength(1);
  }, 60000);
});

describe("t334 (4) strict is today's refusal, in the human's words", () => {
  test("drift before the answer refuses and names the file; re-presenting completes it", () => {
    const project = createProject("strict");
    const questions = presentPlan(project);
    startSession(project, "strict-answer");
    expect(decide(project, questions, "strict-answer").code).toBe(0);
    humanTurn(project, "strict-answer");
    writeFileSync(join(project, "src", "drifted.ts"), "export const drifted = 1;\n");
    const refused = answer(project, questions, "strict-answer");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      JSON.stringify({
        error:
          "1 file changed since this plan was approved: src/drifted.ts. Look them over and approve the plan again to continue.",
      }),
    );
    expect(refused.stderr).toContain(
      JSON.stringify({ remedy: "Re-run the fingerprint command and re-present the plan." }),
    );
    expect(acceptedRows(project)).toHaveLength(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);

    const again = presentPlan(project);
    startSession(project, "strict-again");
    expect(decide(project, again, "strict-again").code).toBe(0);
    humanTurn(project, "strict-again");
    expect(answer(project, again, "strict-again").code).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
  }, 60000);

  test("drift after approval refuses generation, keeps the receipt, and carries the remedy beside the sentence", () => {
    const project = createProject("strict");
    const questions = presentPlan(project);
    startSession(project, "strict-begin");
    expect(decide(project, questions, "strict-begin").code).toBe(0);
    humanTurn(project, "strict-begin");
    expect(answer(project, questions, "strict-begin").code).toBe(0);
    writeFileSync(join(project, "src", "late.ts"), "export const late = 1;\n");
    const approval = evaluateCodeGenerationApproval(project, { unit: null });
    expect(approval.ok).toBe(false);
    expect(approval.reason).toBe(
      "1 file changed since this plan was approved: src/late.ts. Look them over and approve the plan again to continue.",
    );
    const refused = begin(project);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toBe(
      `${JSON.stringify({
        error:
          "1 file changed since this plan was approved: src/late.ts. Look them over and approve the plan again to continue.",
        remedy: "Re-run the fingerprint command and re-present the plan.",
      })}\n`,
    );
    const authority = resolveCodeGenerationAuthority(project, { unit: null });
    expect(
      readPlanApprovalReceipt(project, {
        targetId: authority.targetId,
        runFloor: authority.runFloor,
        fingerprint: approval.approvalFingerprint!,
      })?.status,
    ).toBe("approved");
    expect(acceptedRows(project)).toHaveLength(0);
  }, 60000);
});

describe("t334 (5) the approval's content members reopen approval under both values", () => {
  for (const mode of ["strict", "relaxed"] as const) {
    test(`an edited plan, instructions, or Testing Contract is refused under ${mode}`, () => {
      const project = createProject(mode);
      const questions = presentPlan(project);
      startSession(project, `content-${mode}`);
      expect(decide(project, questions, `content-${mode}`).code).toBe(0);
      humanTurn(project, `content-${mode}`);
      const dir = codeGenerationRecordDir(project, null);
      const plan = join(dir, "code-generation-plan.md");
      const original = readFileSync(plan, "utf-8");
      writeFileSync(plan, original.replace("- [ ] Implement", "- [ ] Implement differently"));
      const planEdit = answer(project, questions, `content-${mode}`);
      expect(planEdit.code).not.toBe(0);
      expect(planEdit.stderr).toContain("Plan Approval fingerprint does not match");
      writeFileSync(plan, original);

      const instructions = join(dir, "unit-test-instructions.md");
      const originalInstructions = readFileSync(instructions, "utf-8");
      writeFileSync(instructions, `${originalInstructions}\nRun twice.\n`);
      const instructionsEdit = answer(project, questions, `content-${mode}`);
      expect(instructionsEdit.code).not.toBe(0);
      expect(instructionsEdit.stderr).toContain("Plan Approval fingerprint does not match");
      writeFileSync(instructions, originalInstructions);

      writeFileSync(plan, original.replace('"version": 1', '"version": 1, "note": "edited"'));
      const contractEdit = answer(project, questions, `content-${mode}`);
      expect(contractEdit.code).not.toBe(0);
      expect(contractEdit.stderr).toMatch(/Testing Contract|fingerprint does not match/);
      expect(acceptedRows(project)).toHaveLength(0);
      expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
    }, 60000);
  }
});
