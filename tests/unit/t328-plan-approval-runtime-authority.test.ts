// covers: function:recordPlanApprovalReceipt, function:beginCodeGeneration, function:readPlanApprovalViolation, function:refreshActiveDirectiveUnitState

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  clearActiveDirectiveMarker,
  currentSharedDirectiveWait,
  readActiveDirectiveMarker,
  readAllAuditShards,
  readPlanApprovalChallenge,
  readPlanApprovalReceipt,
  readPlanApprovalResponse,
  readPlanApprovalViolation,
  refreshActiveDirectiveMarker,
  refreshActiveDirectiveUnitState,
  releaseAuditLock,
  sessionsDir,
  writeActiveDirectiveMarker,
} from "../../core/tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  beginCodeGeneration,
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../core/tools/aidlc-testing-posture.ts";
import {
  cleanupTestProject,
  REPO_ROOT,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const projects: string[] = [];
const barriers: string[] = [];
const DIST_ROOT = join(REPO_ROOT, "dist", "claude", ".claude");
const CORE_HUMAN_TURN_HOOK = join(
  REPO_ROOT,
  "core",
  "hooks",
  "aidlc-record-human-turn.ts",
);

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  for (const barrier of barriers) {
    rmSync(`${barrier}.published`, { force: true });
    rmSync(`${barrier}.snapshotted`, { force: true });
    rmSync(`${barrier}.release`, { force: true });
  }
}, 30000);

function publicationBarrier(): string {
  const barrier = join(tmpdir(), `aidlc-t328-${randomUUID()}`);
  barriers.push(barrier);
  return barrier;
}

function initGitBaseline(project: string): void {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
}

function createProject(
  options: {
    expressConstruction?: boolean;
    unit?: string;
    units?: string[];
    inlineUnits?: string[];
  } = {},
): string {
  const project = setupIntegrationProject({
    withState: "state-brownfield-feature.md",
  });
  projects.push(project);
  const statePath = join(seededRecordDir(project), "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8")
    .replace(
      /^- \*\*Current Stage\*\*:.*$/m,
      "- **Current Stage**: code-generation",
    )
    .replace(
      /^- \[[ xSR?-]\] code-generation(\s+—\s+)EXECUTE$/m,
      "- [-] code-generation$1EXECUTE",
    );
  let scopedState =
    options.expressConstruction ||
      options.unit ||
      options.units ||
      options.inlineUnits
    ? state
      .replace(
        /^- \*\*Scope\*\*:.*$/m,
        `- **Scope**: ${options.expressConstruction ? "express" : "feature"}`,
      )
      .replace(
        /^- \*\*Depth\*\*:.*$/m,
        `- **Depth**: ${options.expressConstruction ? "Minimal" : "Standard"}`,
      )
      .replace(
        /^- \*\*Test Strategy\*\*:.*$/m,
        `- **Test Strategy**: ${options.expressConstruction ? "Minimal" : "Standard"}`,
      )
      .replace(
        /^- \*\*Lifecycle Phase\*\*:.*$/m,
        "- **Lifecycle Phase**: CONSTRUCTION",
      )
    : state;
  if (options.units) {
    scopedState = scopedState.replace(
      /^(- \*\*Revision Count\*\*:.*)$/m,
      "$1\n- **Construction Iteration**: stage-major\n- **Construction Autonomy Mode**: autonomous",
    );
  }
  if (options.inlineUnits) {
    scopedState = scopedState.replace(
      /^(- \*\*Revision Count\*\*:.*)$/m,
      "$1\n- **Construction Iteration**: stage-major\n- **Construction Autonomy Mode**: gated",
    );
  }
  writeFileSync(statePath, scopedState, "utf-8");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "base.ts"), "export const base = 1;\n");
  initGitBaseline(project);
  const dagUnits = options.units ?? options.inlineUnits;
  if (dagUnits) {
    writeFileSync(
      join(seededRecordDir(project), "runtime-graph.json"),
      `${JSON.stringify({
        bolt_dag: {
          batches: [dagUnits],
          units: dagUnits.map((name) => ({ name })),
        },
      })}\n`,
    );
  }
  writeActiveDirectiveMarker(project, {
    kind: options.units ? "invoke-swarm" : "run-stage",
    stage: "code-generation",
    ...(options.unit ? { unit: options.unit } : {}),
    ...(options.units ? { units: options.units } : {}),
    state_sha256: createHash("sha256").update(scopedState).digest("hex"),
  });
  return project;
}

function seedPlan(project: string, unit: string | null = null): string {
  const authority = resolveCodeGenerationAuthority(project, { unit });
  const contract = resolveTestingPosture(project);
  const dir = codeGenerationRecordDir(project, unit);
  mkdirSync(dir, { recursive: true });
  const plan =
    `# Plan\n\n${renderTestingContract(contract)}\n## Steps\n\n- [ ] Implement\n`;
  const instructions =
    "# Unit Test Instructions\n\n## Command\n\n`bun test unit.test.ts`\n";
  writeFileSync(join(dir, "code-generation-plan.md"), plan);
  writeFileSync(join(dir, "unit-test-instructions.md"), instructions);
  const fingerprint = approvalFingerprint(
    plan,
    instructions,
    contract.contract_sha256,
    authority,
  );
  const questions = join(dir, "code-generation-questions.md");
  writeFileSync(
    questions,
    [
      "## Plan Approval",
      `[Approval Fingerprint]: ${fingerprint}`,
      "A. Approve Plan",
      "B. Request Changes",
      "[Answer]:",
      "",
    ].join("\n"),
  );
  return questions;
}

function runLog(
  project: string,
  args: string[],
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [BUN, join(DIST_ROOT, "tools", "aidlc-log.ts"), ...args],
    {
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function runStatusSync(
  project: string,
  stage: string,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      BUN,
      join(DIST_ROOT, "tools", "aidlc-utility.ts"),
      "set-status",
      "--stage",
      stage,
      "--project-dir",
      project,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        AIDLC_STATUSLINE_OWNER: `statusline:${process.pid}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function runPlanGuard(
  project: string,
  toolName: string,
  toolInput: Record<string, unknown>,
) {
  return Bun.spawnSync(
    [
      BUN,
      join(
        project,
        ".claude",
        "hooks",
        "aidlc-plan-approval-guard.ts",
      ),
    ],
    {
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
      })),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function decisionArgs(
  questions: string,
  session: string,
  unit: string | null = null,
): string[] {
  return [
    "--stage",
    "code-generation",
    "--checkpoint",
    "plan-approval",
    "--questions-file",
    questions,
    "--session",
    session,
    ...(unit === null ? ["--stage-level"] : ["--unit", unit]),
  ];
}

function approve(
  project: string,
  questions: string,
  session: string,
  unit: string | null = null,
): void {
  appendAuditEntry(
    "SESSION_STARTED",
    { Source: "startup", Session: session },
    project,
  );
  const identity = decisionArgs(questions, session, unit);
  expect(
    runLog(project, [
      "decision",
      ...identity,
      "--decision",
      "Approve this exact Code Generation plan?",
      "--options",
      "Approve Plan,Request Changes",
    ]).exitCode,
  ).toBe(0);
  const human = Bun.spawnSync(
    [BUN, join(DIST_ROOT, "hooks", "aidlc-record-human-turn.ts")],
    {
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt: "Approve Plan",
      })),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(human.exitCode).toBe(0);
  writeFileSync(
    questions,
    readFileSync(questions, "utf-8").replace(
      /\[Answer\]:\s*$/,
      "[Answer]: Approve Plan",
    ),
  );
  const answer = runLog(project, [
      "answer",
      ...identity,
      "--details",
      "Approve Plan",
    ]);
  expect(
    answer.exitCode,
    `${answer.stdout?.toString() ?? ""}\n${answer.stderr?.toString() ?? ""}`,
  ).toBe(0);
  expect(evaluateCodeGenerationApproval(project, { unit }).ok).toBe(true);
}

describe("t328 Plan Approval runtime authority", () => {
  test("rejects malformed Plan Approval violation records", () => {
    const project = createProject();
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    const violationPath = join(runtimeDir, "violation.json");
    mkdirSync(runtimeDir, { recursive: true });
    for (const value of [
      { version: 1, markerRevision: 1, reason: "unsupported" },
      { version: 1, markerRevision: 1, reason: "unsupported", target: 42 },
      {
        version: 1,
        markerRevision: -1,
        reason: "unsupported",
        target: project,
      },
      { version: 1, markerRevision: 1, reason: "", target: project },
      {
        version: 1,
        markerRevision: 1,
        reason: "unsupported",
        target: "relative",
      },
    ]) {
    writeFileSync(violationPath, `${JSON.stringify(value)}\n`);
    expect(readPlanApprovalViolation(project)).toBeNull();
  }
  const unresolved = {
    version: 1 as const,
    markerRevision: 1,
    reason: "legacy write target was not recoverable",
    target: "(unresolved write target)",
  };
  writeFileSync(violationPath, `${JSON.stringify(unresolved)}\n`);
  expect(readPlanApprovalViolation(project)).toEqual(unresolved);
});

  test("accepts the native Claude AskUserQuestion PostToolUse response", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "claude-widget-session";
    appendAuditEntry(
      "SESSION_STARTED",
      { Source: "startup", Session: session },
      project,
    );
    const identity = decisionArgs(questions, session);
    expect(
      runLog(project, [
        "decision",
        ...identity,
        "--decision",
        "Approve this exact Code Generation plan?",
        "--options",
        "Approve Plan,Request Changes",
      ]).exitCode,
    ).toBe(0);
    const human = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "hooks", "aidlc-record-human-turn.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: session,
          tool_name: "AskUserQuestion",
          tool_response: {
            answers: {
              "Approve this exact Code Generation plan?": "Approve Plan",
            },
          },
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(human.exitCode).toBe(0);
    writeFileSync(
      questions,
      readFileSync(questions, "utf-8").replace(
        /\[Answer\]:\s*$/,
        "[Answer]: Approve Plan",
      ),
    );
    expect(
      runLog(project, [
        "answer",
        ...identity,
        "--details",
        "Approve Plan",
      ]).exitCode,
    ).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
  }, 30000);

  test("Claude Stop preserves an Express Plan Approval through challenge, response, and receipt", () => {
    const project = createProject({ expressConstruction: true });
    expect(runStatusSync(project, "code-generation").exitCode).toBe(0);
    const statusSyncedState = readFileSync(
      join(seededRecordDir(project), "aidlc-state.md"),
      "utf-8",
    );
    writeActiveDirectiveMarker(project, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: createHash("sha256")
        .update(statusSyncedState)
        .digest("hex"),
    });
    const questions = seedPlan(project);
    const session = "express-stage-level-stop";
    appendAuditEntry(
      "SESSION_STARTED",
      { Source: "startup", Session: session },
      project,
    );
    const identity = decisionArgs(questions, session);
    const decision = runLog(project, [
      "decision",
      ...identity,
      "--decision",
      "Approve this exact Code Generation plan?",
      "--options",
      "Approve Plan,Request Changes",
    ]);
    expect(
      decision.exitCode,
      `${decision.stdout?.toString() ?? ""}\n${decision.stderr?.toString() ?? ""}`,
    ).toBe(0);

    const state = readFileSync(
      join(seededRecordDir(project), "aidlc-state.md"),
      "utf-8",
    );
    const markerBefore = readActiveDirectiveMarker(project, state);
    const authorityBefore = resolveCodeGenerationAuthority(project, {
      unit: null,
    });
    const challengeBefore = readPlanApprovalChallenge(project, session);
    expect(markerBefore?.kind).toBe("run-stage");
    expect(challengeBefore).not.toBeNull();
    const duplicateSync = runStatusSync(project, "code-generation");
    expect(
      duplicateSync.exitCode,
      `${duplicateSync.stdout?.toString() ?? ""}\n${duplicateSync.stderr?.toString() ?? ""}`,
    ).toBe(0);
    expect(JSON.parse(duplicateSync.stdout?.toString() ?? "{}")).toMatchObject({
      updated: false,
    });
    expect(readActiveDirectiveMarker(project, state)).toEqual(markerBefore);
    expect(readPlanApprovalChallenge(project, session)).toEqual(
      challengeBefore,
    );

    const stop = Bun.spawnSync(
      [BUN, join(project, ".claude", "hooks", "aidlc-continue-workflow.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "Stop",
          session_id: session,
          stop_hook_active: false,
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(
      stop.exitCode,
      `${stop.stdout.toString()}\n${stop.stderr.toString()}`,
    ).toBe(0);
    expect(stop.stdout.toString()).toBe("");
    expect(readActiveDirectiveMarker(project, state)).toEqual(markerBefore);
    expect(resolveCodeGenerationAuthority(project, { unit: null })).toEqual(
      authorityBefore,
    );
    expect(readPlanApprovalChallenge(project, session)).toEqual(
      challengeBefore,
    );

    const human = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "hooks", "aidlc-record-human-turn.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: session,
          tool_name: "AskUserQuestion",
          tool_response: {
            answers: {
              "Approve this exact Code Generation plan?": "Approve Plan",
            },
          },
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(human.exitCode, human.stderr.toString()).toBe(0);
    const responseBeforeReceipt = readPlanApprovalResponse(project, session);
    expect(responseBeforeReceipt).toMatchObject({
      choice: "Approve Plan",
    });
    const stopAfterResponse = Bun.spawnSync(
      [BUN, join(project, ".claude", "hooks", "aidlc-continue-workflow.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "Stop",
          session_id: session,
          stop_hook_active: false,
          transcript_path: join(project, "missing-transcript.jsonl"),
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(
      stopAfterResponse.exitCode,
      `${stopAfterResponse.stdout.toString()}\n${stopAfterResponse.stderr.toString()}`,
    ).toBe(0);
    expect(JSON.parse(stopAfterResponse.stdout.toString())).toMatchObject({
      decision: "block",
    });
    expect(readActiveDirectiveMarker(project, state)).toEqual(markerBefore);
    expect(readPlanApprovalChallenge(project, session)).toEqual(
      challengeBefore,
    );
    expect(readPlanApprovalResponse(project, session)).toEqual(
      responseBeforeReceipt,
    );
    writeFileSync(
      questions,
      readFileSync(questions, "utf-8").replace(
        /\[Answer\]:\s*$/,
        "[Answer]: Approve Plan",
      ),
    );
    const answer = runLog(project, [
      "answer",
      ...identity,
      "--details",
      "Approve Plan",
    ]);
    expect(
      answer.exitCode,
      `${answer.stdout?.toString() ?? ""}\n${answer.stderr?.toString() ?? ""}`,
    ).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
    expect(
      readPlanApprovalReceipt(project, {
        targetId: authorityBefore.targetId,
        directiveEpoch: authorityBefore.directiveEpoch,
      }),
    ).toMatchObject({
      choice: "Approve Plan",
      status: "approved",
    });
  }, 30000);

  test("Claude Stop preserves a per-Unit Plan Approval before and after the human response", () => {
    const unit = "alpha";
    const project = createProject({ unit });
    const questions = seedPlan(project, unit);
    const session = "unit-plan-approval-stop";
    appendAuditEntry(
      "SESSION_STARTED",
      { Source: "startup", Session: session },
      project,
    );
    const identity = decisionArgs(questions, session, unit);
    expect(
      runLog(project, [
        "decision",
        ...identity,
        "--decision",
        "Approve this exact Code Generation plan?",
        "--options",
        "Approve Plan,Request Changes",
      ]).exitCode,
    ).toBe(0);

    const state = readFileSync(
      join(seededRecordDir(project), "aidlc-state.md"),
      "utf-8",
    );
    const markerBefore = readActiveDirectiveMarker(project, state);
    const challengeBefore = readPlanApprovalChallenge(project, session);
    expect(challengeBefore).not.toBeNull();
    const stopBeforeAnswer = Bun.spawnSync(
      [BUN, join(project, ".claude", "hooks", "aidlc-continue-workflow.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "Stop",
          session_id: session,
          stop_hook_active: false,
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(stopBeforeAnswer.exitCode, stopBeforeAnswer.stderr.toString()).toBe(
      0,
    );
    expect(stopBeforeAnswer.stdout.toString()).toBe("");

    const human = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "hooks", "aidlc-record-human-turn.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: session,
          prompt: "Approve Plan",
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(human.exitCode, human.stderr.toString()).toBe(0);
    const responseBeforeReceipt = readPlanApprovalResponse(project, session);
    expect(responseBeforeReceipt).toMatchObject({ choice: "Approve Plan" });

    const stopAfterAnswer = Bun.spawnSync(
      [BUN, join(project, ".claude", "hooks", "aidlc-continue-workflow.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "Stop",
          session_id: session,
          stop_hook_active: false,
          transcript_path: join(project, "missing-transcript.jsonl"),
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(stopAfterAnswer.exitCode, stopAfterAnswer.stderr.toString()).toBe(0);
    expect(JSON.parse(stopAfterAnswer.stdout.toString())).toMatchObject({
      decision: "block",
    });
    expect(readActiveDirectiveMarker(project, state)).toEqual(markerBefore);
    expect(readPlanApprovalChallenge(project, session)).toEqual(
      challengeBefore,
    );
    expect(readPlanApprovalResponse(project, session)).toEqual(
      responseBeforeReceipt,
    );

    writeFileSync(
      questions,
      readFileSync(questions, "utf-8").replace(
        /\[Answer\]:\s*$/,
        "[Answer]: Approve Plan",
      ),
    );
    expect(
      runLog(project, [
        "answer",
        ...identity,
        "--details",
        "Approve Plan",
      ]).exitCode,
    ).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit }).ok).toBe(true);
  }, 30000);

  test("Claude Stop preserves per-Unit Plan Approval throughout an invoke-swarm lifecycle", () => {
    const unit = "alpha";
    const project = createProject({ units: [unit, "beta"] });
    appendAuditEntry(
      "STAGE_STARTED",
      { Stage: "code-generation", Agent: "aidlc-developer-agent" },
      project,
    );
    const questions = seedPlan(project, unit);
    const session = "swarm-plan-approval-stop";
    appendAuditEntry(
      "SESSION_STARTED",
      { Source: "startup", Session: session },
      project,
    );
    const identity = decisionArgs(questions, session, unit);
    expect(
      runLog(project, [
        "decision",
        ...identity,
        "--decision",
        "Approve this exact Code Generation plan?",
        "--options",
        "Approve Plan,Request Changes",
      ]).exitCode,
    ).toBe(0);

    const state = readFileSync(
      join(seededRecordDir(project), "aidlc-state.md"),
      "utf-8",
    );
    const markerBefore = readActiveDirectiveMarker(project, state);
    const authority = resolveCodeGenerationAuthority(project, { unit });
    const challengeBefore = readPlanApprovalChallenge(project, session);
    expect(markerBefore).toMatchObject({
      kind: "invoke-swarm",
      units: [unit, "beta"],
    });
    expect(challengeBefore).not.toBeNull();

    const runStop = (withTranscript: boolean) =>
      Bun.spawnSync(
        [BUN, join(project, ".claude", "hooks", "aidlc-continue-workflow.ts")],
        {
          cwd: project,
          env: { ...process.env, CLAUDE_PROJECT_DIR: project },
          stdin: Buffer.from(JSON.stringify({
            hook_event_name: "Stop",
            session_id: session,
            stop_hook_active: false,
            ...(withTranscript
              ? { transcript_path: join(project, "missing-transcript.jsonl") }
              : {}),
          })),
          stdout: "pipe",
          stderr: "pipe",
        },
      );

    const stopBeforeAnswer = runStop(false);
    expect(stopBeforeAnswer.exitCode, stopBeforeAnswer.stderr.toString()).toBe(
      0,
    );
    expect(stopBeforeAnswer.stdout.toString()).toBe("");

    const human = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "hooks", "aidlc-record-human-turn.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: session,
          prompt: "Approve Plan",
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(human.exitCode, human.stderr.toString()).toBe(0);
    const responseBeforeReceipt = readPlanApprovalResponse(project, session);
    expect(responseBeforeReceipt).toMatchObject({ choice: "Approve Plan" });

    const stopAfterAnswer = runStop(true);
    expect(stopAfterAnswer.exitCode, stopAfterAnswer.stderr.toString()).toBe(0);
    expect(JSON.parse(stopAfterAnswer.stdout.toString())).toMatchObject({
      decision: "block",
    });
    expect(readActiveDirectiveMarker(project, state)).toEqual(markerBefore);
    expect(readPlanApprovalChallenge(project, session)).toEqual(
      challengeBefore,
    );
    expect(readPlanApprovalResponse(project, session)).toEqual(
      responseBeforeReceipt,
    );

    writeFileSync(
      questions,
      readFileSync(questions, "utf-8").replace(
        /\[Answer\]:\s*$/,
        "[Answer]: Approve Plan",
      ),
    );
    expect(
      runLog(project, [
        "answer",
        ...identity,
        "--details",
        "Approve Plan",
      ]).exitCode,
    ).toBe(0);
    const receiptBeforeGeneration = readPlanApprovalReceipt(project, {
      targetId: authority.targetId,
      directiveEpoch: authority.directiveEpoch,
    });
    expect(receiptBeforeGeneration).toMatchObject({ status: "approved" });
    expect(runStop(true).exitCode).toBe(0);
    expect(readActiveDirectiveMarker(project, state)).toEqual(markerBefore);
    expect(evaluateCodeGenerationApproval(project, { unit }).ok).toBe(true);

    beginCodeGeneration(project, { unit });
    const generationReceipt = readPlanApprovalReceipt(project, {
      targetId: authority.targetId,
      directiveEpoch: authority.directiveEpoch,
    });
    expect(generationReceipt).toMatchObject({ status: "generation" });
    expect(runStop(true).exitCode).toBe(0);
    expect(readActiveDirectiveMarker(project, state)).toEqual(markerBefore);
    expect(
      readPlanApprovalReceipt(project, {
        targetId: authority.targetId,
        directiveEpoch: authority.directiveEpoch,
      }),
    ).toEqual(generationReceipt);
    expect(evaluateCodeGenerationApproval(project, { unit }).ok).toBe(true);
  }, 30000);

  test("Claude Stop preserves approved and generation-active authority for stage and Unit targets", () => {
    for (const unit of [null, "alpha"] as const) {
      for (const generationStarted of [false, true]) {
        const project = createProject({
          expressConstruction: unit === null,
          ...(unit ? { unit } : {}),
        });
        const questions = seedPlan(project, unit);
        const session = [
          unit ?? "stage",
          generationStarted ? "generation" : "approved",
          "stop",
        ].join("-");
        approve(project, questions, session, unit);
        if (generationStarted) {
          beginCodeGeneration(project, { unit });
        }

        const state = readFileSync(
          join(seededRecordDir(project), "aidlc-state.md"),
          "utf-8",
        );
        const markerBefore = readActiveDirectiveMarker(project, state);
        const authority = resolveCodeGenerationAuthority(project, { unit });
        const receiptBefore = readPlanApprovalReceipt(project, {
          targetId: authority.targetId,
          directiveEpoch: authority.directiveEpoch,
        });
        expect(markerBefore?.kind).toBe("run-stage");
        expect(receiptBefore).toMatchObject({
          choice: "Approve Plan",
          status: generationStarted ? "generation" : "approved",
        });

        const stop = Bun.spawnSync(
          [
            BUN,
            join(project, ".claude", "hooks", "aidlc-continue-workflow.ts"),
          ],
          {
            cwd: project,
            env: { ...process.env, CLAUDE_PROJECT_DIR: project },
            stdin: Buffer.from(JSON.stringify({
              hook_event_name: "Stop",
              session_id: session,
              stop_hook_active: false,
              transcript_path: join(project, "missing-transcript.jsonl"),
            })),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(
          stop.exitCode,
          `${stop.stdout.toString()}\n${stop.stderr.toString()}`,
        ).toBe(0);
        expect(JSON.parse(stop.stdout.toString())).toMatchObject({
          decision: "block",
        });
        expect(readActiveDirectiveMarker(project, state)).toEqual(markerBefore);
        expect(
          readPlanApprovalReceipt(project, {
            targetId: authority.targetId,
            directiveEpoch: authority.directiveEpoch,
          }),
        ).toEqual(receiptBefore);
        expect(evaluateCodeGenerationApproval(project, { unit }).ok).toBe(
          true,
        );
      }
    }
  }, 30000);

  test("approved per-Unit authority survives unit start and authorizes developer dispatch", () => {
    const unit = "alpha";
    const project = createProject({
      unit,
      inlineUnits: [unit],
    });
    const questions = seedPlan(project, unit);
    approve(project, questions, "unit-start-dispatch", unit);

    const statePath = join(seededRecordDir(project), "aidlc-state.md");
    const stateBefore = readFileSync(statePath, "utf-8");
    const markerBefore = readActiveDirectiveMarker(project, stateBefore);
    const authorityBefore = resolveCodeGenerationAuthority(project, { unit });
    const receiptBefore = readPlanApprovalReceipt(project, {
      targetId: authorityBefore.targetId,
      directiveEpoch: authorityBefore.directiveEpoch,
    });
    expect(markerBefore).toMatchObject({
      kind: "run-stage",
      stage: "code-generation",
      unit,
    });
    expect(receiptBefore).toMatchObject({ status: "approved" });
    const unrelatedState = stateBefore.replace(
      "- **Current Stage**: code-generation",
      "- **Current Stage**: build-and-test",
    );
    expect(
      refreshActiveDirectiveUnitState(
        project,
        "code-generation",
        unit,
        stateBefore,
        unrelatedState,
      ),
    ).toBe(false);
    expect(readActiveDirectiveMarker(project, stateBefore)).toEqual(
      markerBefore,
    );

    const started = Bun.spawnSync(
      [
        BUN,
        join(DIST_ROOT, "tools", "aidlc-state.ts"),
        "unit",
        "start",
        "--stage",
        "code-generation",
        "--unit",
        unit,
        "--project-dir",
        project,
      ],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(
      started.exitCode,
      `${started.stdout.toString()}\n${started.stderr.toString()}`,
    ).toBe(0);

    const stateAfter = readFileSync(statePath, "utf-8");
    expect(stateAfter).toContain(`- **Active Unit**: ${unit}`);
    const markerAfter = readActiveDirectiveMarker(project, stateAfter);
    expect(markerAfter).toMatchObject({
      kind: "run-stage",
      stage: "code-generation",
      unit,
      code_generation_authority_revision:
        markerBefore?.code_generation_authority_revision,
      code_generation_authority_state_sha256: markerBefore?.state_sha256,
    });
    expect(markerAfter?.state_sha256).not.toBe(
      markerAfter?.code_generation_authority_state_sha256,
    );
    expect(resolveCodeGenerationAuthority(project, { unit })).toEqual(
      authorityBefore,
    );
    expect(
      readPlanApprovalReceipt(project, {
        targetId: authorityBefore.targetId,
        directiveEpoch: authorityBefore.directiveEpoch,
      }),
    ).toEqual(receiptBefore);
    expect(evaluateCodeGenerationApproval(project, { unit }).ok).toBe(true);

    const contract = resolveTestingPosture(project).contract_sha256;
    const dispatchDeveloper = () =>
      runPlanGuard(
        project,
        "Task",
        {
          subagent_type: "aidlc-developer-agent",
          prompt:
            `AIDLC-UNIT: ${unit}\n` +
            `AIDLC-TESTING-CONTRACT: ${contract}\n` +
            "Implement the approved plan.",
        },
      );
    const dispatch = dispatchDeveloper();
    expect(
      dispatch.exitCode,
      `${dispatch.stdout.toString()}\n${dispatch.stderr.toString()}`,
    ).toBe(0);

    const generationState = readFileSync(statePath, "utf-8");
    const generationMarker = readActiveDirectiveMarker(
      project,
      generationState,
    );
    const stopAfterGeneration = Bun.spawnSync(
      [BUN, join(project, ".claude", "hooks", "aidlc-continue-workflow.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "Stop",
          session_id: "unit-start-dispatch",
          stop_hook_active: false,
          transcript_path: join(project, "missing-transcript.jsonl"),
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(
      stopAfterGeneration.exitCode,
      `${stopAfterGeneration.stdout.toString()}\n${stopAfterGeneration.stderr.toString()}`,
    ).toBe(0);
    expect(JSON.parse(stopAfterGeneration.stdout.toString())).toMatchObject({
      decision: "block",
    });
    expect(
      readActiveDirectiveMarker(project, generationState),
    ).toEqual(generationMarker);

    const reviewArtifact = join(
      codeGenerationRecordDir(project, unit),
      "code-generation-plan.md",
    );
    const reviewerDispatch = join(
      seededRecordDir(project),
      ".aidlc-reviewer-dispatch.json",
    );
    for (const guarded of [
      runPlanGuard(project, "Bash", {
        command: 'date -u +"%Y-%m-%dT%H:%M:%SZ"',
      }),
      runPlanGuard(project, "Bash", {
        command:
          "bun .claude/tools/aidlc-log.ts review --stage code-generation " +
          `--reviewer aidlc-architecture-reviewer-agent --iteration 1 --unit ${unit}`,
      }),
      runPlanGuard(project, "Bash", {
        command:
          `bun ${join(project, ".claude", "tools", "aidlc-state.ts")} unit complete ` +
          `--stage code-generation --unit ${unit} 2>&1`,
      }),
      runPlanGuard(project, "Write", {
        file_path: reviewerDispatch,
        content: "{}\n",
      }),
      runPlanGuard(project, "Edit", {
        file_path: reviewArtifact,
        old_string: "# Plan",
        new_string: "# Plan\n\n## Review",
      }),
    ]) {
      expect(
        guarded.exitCode,
        `${guarded.stdout.toString()}\n${guarded.stderr.toString()}`,
      ).toBe(0);
    }
    expect(
      resolveCodeGenerationAuthority(project, { unit }),
    ).toEqual(authorityBefore);
    expect(
      readPlanApprovalReceipt(project, {
        targetId: authorityBefore.targetId,
        directiveEpoch: authorityBefore.directiveEpoch,
      }),
    ).toMatchObject({ status: "generation" });

    const lifecycle = (
      action: "pause" | "resume" | "complete",
      extra: string[] = [],
    ) =>
      Bun.spawnSync(
        [
          BUN,
          join(DIST_ROOT, "tools", "aidlc-state.ts"),
          "unit",
          action,
          "--stage",
          "code-generation",
          "--unit",
          unit,
          ...extra,
          "--project-dir",
          project,
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: project,
            ...(action === "complete"
              ? { AIDLC_SKIP_ARTIFACT_GUARD: "1" }
              : {}),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

    const paused = lifecycle("pause", [
      "--reason",
      "waiting for input",
      "--next-action",
      "resume generation",
    ]);
    expect(
      paused.exitCode,
      `${paused.stdout.toString()}\n${paused.stderr.toString()}`,
    ).toBe(0);
    const pausedDispatch = dispatchDeveloper();
    expect(pausedDispatch.exitCode).toBe(2);
    expect(
      `${pausedDispatch.stdout.toString()}\n${pausedDispatch.stderr.toString()}`,
    ).toContain(`unit "${unit}" is paused`);
    expect(evaluateCodeGenerationApproval(project, { unit }).ok).toBe(true);

    const resumed = lifecycle("resume");
    expect(
      resumed.exitCode,
      `${resumed.stdout.toString()}\n${resumed.stderr.toString()}`,
    ).toBe(0);
    const resumedDispatch = dispatchDeveloper();
    expect(
      resumedDispatch.exitCode,
      `${resumedDispatch.stdout.toString()}\n${resumedDispatch.stderr.toString()}`,
    ).toBe(0);
    expect(resolveCodeGenerationAuthority(project, { unit })).toEqual(
      authorityBefore,
    );

    const completed = lifecycle("complete");
    expect(
      completed.exitCode,
      `${completed.stdout.toString()}\n${completed.stderr.toString()}`,
    ).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit }).ok).toBe(true);
    const completedDispatch = dispatchDeveloper();
    expect(completedDispatch.exitCode).toBe(2);
    expect(
      `${completedDispatch.stdout.toString()}\n${completedDispatch.stderr.toString()}`,
    ).toContain(`unit "${unit}" is not active`);
  }, 30000);

  test("Code Generation review request, appendix, verdict, and Unit completion remain executable after Stop", () => {
    const unit = "alpha";
    const project = createProject({
      unit,
      inlineUnits: [unit],
    });
    const questions = seedPlan(project, unit);
    approve(project, questions, "review-handoff", unit);
    const authority = resolveCodeGenerationAuthority(project, { unit });

    const runState = (args: string[]) =>
      Bun.spawnSync(
        [
          BUN,
          join(DIST_ROOT, "tools", "aidlc-state.ts"),
          ...args,
          "--project-dir",
          project,
        ],
        {
          cwd: project,
          env: { ...process.env, CLAUDE_PROJECT_DIR: project },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    const started = runState([
      "unit",
      "start",
      "--stage",
      "code-generation",
      "--unit",
      unit,
    ]);
    expect(started.exitCode, started.stderr.toString()).toBe(0);

    const contract = resolveTestingPosture(project).contract_sha256;
    const dispatch = runPlanGuard(project, "Task", {
      subagent_type: "aidlc-developer-agent",
      prompt:
        `AIDLC-UNIT: ${unit}\n` +
        `AIDLC-TESTING-CONTRACT: ${contract}\n` +
        "Implement the approved plan.",
    });
    expect(
      dispatch.exitCode,
      `${dispatch.stdout.toString()}\n${dispatch.stderr.toString()}`,
    ).toBe(0);

    const stageDir = codeGenerationRecordDir(project, unit);
    writeFileSync(join(stageDir, "code-summary.md"), "# Code Summary\n");
    writeFileSync(join(stageDir, "traceability.json"), "{}\n");
    writeFileSync(
      join(stageDir, "source-manifest.json"),
      `${JSON.stringify({
        stage: "code-generation",
        unit,
        version: 1,
        writes: [],
      })}\n`,
    );

    const statePath = join(seededRecordDir(project), "aidlc-state.md");
    const stateBeforeStop = readFileSync(statePath, "utf-8");
    const markerBeforeStop = readActiveDirectiveMarker(
      project,
      stateBeforeStop,
    );
    const stop = Bun.spawnSync(
      [BUN, join(project, ".claude", "hooks", "aidlc-continue-workflow.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "Stop",
          session_id: "review-handoff",
          stop_hook_active: false,
          transcript_path: join(project, "missing-transcript.jsonl"),
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(stop.exitCode, stop.stderr.toString()).toBe(0);
    expect(JSON.parse(stop.stdout.toString())).toMatchObject({
      decision: "block",
    });
    expect(
      readActiveDirectiveMarker(project, stateBeforeStop),
    ).toEqual(markerBeforeStop);

    const reviewArgs = [
      "review",
      "--stage",
      "code-generation",
      "--reviewer",
      "aidlc-architecture-reviewer-agent",
      "--iteration",
      "1",
      "--unit",
      unit,
    ];
    const reviewCommand =
      `bun .claude/tools/aidlc-log.ts ${reviewArgs.join(" ")}`;
    expect(
      runPlanGuard(project, "Bash", { command: reviewCommand }).exitCode,
    ).toBe(0);
    const requested = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "tools", "aidlc-log.ts"), ...reviewArgs],
      {
        cwd: project,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(requested.exitCode, requested.stderr.toString()).toBe(0);

    const reviewerDispatch = join(
      seededRecordDir(project),
      ".aidlc-reviewer-dispatch.json",
    );
    expect(
      runPlanGuard(project, "Write", {
        file_path: reviewerDispatch,
        content: "{}\n",
      }).exitCode,
    ).toBe(0);
    writeFileSync(reviewerDispatch, "{}\n");

    const reviewArtifact = join(stageDir, "code-generation-plan.md");
    expect(
      runPlanGuard(project, "Edit", {
        file_path: reviewArtifact,
        old_string: "# Plan",
        new_string: "# Plan\n\n## Review",
      }).exitCode,
    ).toBe(0);
    appendFileSync(
      reviewArtifact,
      [
        "",
        "## Review",
        "",
        "**Verdict:** READY",
        "**Reviewer:** aidlc-architecture-reviewer-agent",
        "**Iteration:** 1",
        "",
        "### Findings",
        "",
        "No blocking findings.",
        "",
      ].join("\n"),
    );

    const verdictArgs = [...reviewArgs, "--verdict", "READY"];
    expect(
      runPlanGuard(project, "Bash", {
        command:
          `bun .claude/tools/aidlc-log.ts ${verdictArgs.join(" ")}`,
      }).exitCode,
    ).toBe(0);
    const verdict = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "tools", "aidlc-log.ts"), ...verdictArgs],
      {
        cwd: project,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(verdict.exitCode, verdict.stderr.toString()).toBe(0);

    const completeCommand =
      `bun ${join(project, ".claude", "tools", "aidlc-state.ts")} unit complete ` +
      `--stage code-generation --unit ${unit}`;
    expect(
      runPlanGuard(project, "Bash", { command: completeCommand }).exitCode,
    ).toBe(0);
    const completed = runState([
      "unit",
      "complete",
      "--stage",
      "code-generation",
      "--unit",
      unit,
    ]);
    expect(completed.exitCode, completed.stderr.toString()).toBe(0);
    const audit = readAllAuditShards(project);
    expect(audit).toContain("**Event**: REVIEW_COMPLETED");
    expect(audit).toContain("**Event**: UNIT_COMPLETED");
    expect(resolveCodeGenerationAuthority(project, { unit })).toEqual(
      authority,
    );
    expect(
      readPlanApprovalReceipt(project, {
        targetId: authority.targetId,
        directiveEpoch: authority.directiveEpoch,
      }),
    ).toMatchObject({ status: "generation" });
  }, 30000);

  test("audit append failure does not strand a consumed engine ask before the next Stop probe", () => {
    const project = createProject();
    const state = readFileSync(
      join(seededRecordDir(project), "aidlc-state.md"),
      "utf-8",
    );
    writeActiveDirectiveMarker(project, {
      kind: "ask",
      stage: "code-generation",
      state_sha256: createHash("sha256").update(state).digest("hex"),
    });
    expect(currentSharedDirectiveWait(project)).toBe("engine-ask");

    const probeWitness = join(project, ".stop-probed");
    writeFileSync(
      join(project, ".claude", "tools", "aidlc-orchestrate.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(probeWitness)}, "probed\\n", "utf-8");`,
        'console.log(JSON.stringify({ kind: "run-stage", stage: "code-generation" }));',
        "",
      ].join("\n"),
      "utf-8",
    );

    expect(acquireAuditLock(project)).toBe(true);
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
      };
      delete env.AIDLC_UNATTENDED;
      const human = Bun.spawnSync([BUN, CORE_HUMAN_TURN_HOOK], {
        cwd: project,
        env,
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: "Continue the active work",
        })),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(
        human.exitCode,
        `${human.stdout.toString()}\n${human.stderr.toString()}`,
      ).toBe(0);
    } finally {
      releaseAuditLock(project);
    }

    expect(readAllAuditShards(project)).not.toContain("**Event**: HUMAN_TURN");
    expect(currentSharedDirectiveWait(project)).toBeNull();
    expect(readActiveDirectiveMarker(project, state)?.delivery).toBe("consumed");

    const stop = Bun.spawnSync(
      [BUN, join(project, ".claude", "hooks", "aidlc-continue-workflow.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "Stop",
          session_id: "audit-failure-engine-ask",
          stop_hook_active: false,
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(
      stop.exitCode,
      `${stop.stdout.toString()}\n${stop.stderr.toString()}`,
    ).toBe(0);
    expect(existsSync(probeWitness)).toBe(true);
    expect(stop.stdout.toString()).toContain('"decision":"block"');
  }, 30000);

  test("rotates the source floor and retires authority across generation, Build and Test, resume, and new directives", () => {
    const project = createProject();
    let questions = seedPlan(project);
    const firstFloor =
      resolveCodeGenerationAuthority(project, { unit: null }).sourceFloor;
    approve(project, questions, "lifecycle-one");
    beginCodeGeneration(project, { unit: null });
    writeFileSync(
      join(project, "src", "generated.ts"),
      "export const generated = true;\n",
    );

    const statePath = join(seededRecordDir(project), "aidlc-state.md");
    const codeGenerationState = readFileSync(statePath, "utf-8");
    writeActiveDirectiveMarker(project, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: createHash("sha256")
        .update(codeGenerationState)
        .digest("hex"),
    });
    const rotated =
      resolveCodeGenerationAuthority(project, { unit: null }).sourceFloor;
    expect(rotated).not.toBe(firstFloor);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);

    questions = seedPlan(project);
    approve(project, questions, "lifecycle-two");
    const buildState = codeGenerationState.replace(
      "- **Current Stage**: code-generation",
      "- **Current Stage**: build-and-test",
    );
    writeFileSync(statePath, buildState);
    expect(
      refreshActiveDirectiveMarker(
        project,
        "code-generation",
        codeGenerationState,
        buildState,
      ),
    ).toBe(true);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);

    clearActiveDirectiveMarker(project);
    writeFileSync(statePath, codeGenerationState);
    writeActiveDirectiveMarker(project, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: createHash("sha256")
        .update(codeGenerationState)
        .digest("hex"),
    });
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
    expect(
      resolveCodeGenerationAuthority(project, { unit: null }).sourceFloor,
    ).toMatch(/^[0-9a-f]{40,64}$/);
  }, 30000);

  test("concurrent first-generation guards serialize and share one validated publication", async () => {
    const project = createProject();
    const questions = seedPlan(project);
    approve(project, questions, "concurrent-generation");
    const beginCommand = [
      BUN,
      join(DIST_ROOT, "tools", "aidlc-testing-posture.ts"),
      "begin",
      "--stage-level",
      "--project-dir",
      project,
    ];
    const first = Bun.spawn(beginCommand, {
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      stdout: "pipe",
      stderr: "pipe",
    });
    const second = Bun.spawn(beginCommand, {
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [firstExit, secondExit] = await Promise.all([
      first.exited,
      second.exited,
    ]);
    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
  }, 60000);

  test("a persistent mutation crossing generation publication cannot remain certified", async () => {
    const project = createProject();
    const questions = seedPlan(project);
    approve(project, questions, "publication-race");
    const barrier = publicationBarrier();
    const beginEnv = {
      ...process.env,
      CLAUDE_PROJECT_DIR: project,
      AIDLC_TEST_PLAN_APPROVAL_PUBLICATION_BARRIER: barrier,
    };
    const beginCommand = [
      BUN,
      join(DIST_ROOT, "tools", "aidlc-testing-posture.ts"),
      "begin",
      "--stage-level",
      "--project-dir",
      project,
    ];
    const first = Bun.spawn(beginCommand, {
      cwd: project,
      env: beginEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 10_000; i++) {
      if (existsSync(`${barrier}.published`)) break;
      await Bun.sleep(1);
    }
    expect(existsSync(`${barrier}.published`)).toBe(true);
    writeFileSync(
      join(project, "src", "zz-persistent-publication-race.ts"),
      "export const raced = true;\n",
    );
    const second = Bun.spawn(beginCommand, {
      cwd: project,
      env: beginEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(50);
    writeFileSync(`${barrier}.release`, "release\n");
    const [firstExit, secondExit, firstError, secondError] = await Promise.all([
      first.exited,
      second.exited,
      new Response(first.stderr).text(),
      new Response(second.stderr).text(),
    ]);
    expect(firstExit).not.toBe(0);
    expect(secondExit).not.toBe(0);
    expect(`${firstError}\n${secondError}`).toMatch(
      /source changed while Code Generation authority was starting|protected approval receipt/,
    );
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
  }, 60000);

  test("active directive publication cannot retire authority during generation start", async () => {
    const project = createProject();
    const questions = seedPlan(project);
    approve(project, questions, "directive-publication-race");
    const barrier = publicationBarrier();
    const begin = Bun.spawn(
      [
        BUN,
        join(DIST_ROOT, "tools", "aidlc-testing-posture.ts"),
        "begin",
        "--stage-level",
        "--project-dir",
        project,
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          AIDLC_TEST_PLAN_APPROVAL_PUBLICATION_BARRIER: barrier,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    for (let i = 0; i < 10_000; i++) {
      if (existsSync(`${barrier}.published`)) break;
      await Bun.sleep(1);
    }
    expect(existsSync(`${barrier}.published`)).toBe(true);

    const state = readFileSync(
      join(seededRecordDir(project), "aidlc-state.md"),
      "utf-8",
    );
    const libUrl = pathToFileURL(
      join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"),
    ).href;
    const publisher = Bun.spawn(
      [
        BUN,
        "-e",
        [
          `import { writeActiveDirectiveMarker } from ${JSON.stringify(libUrl)};`,
          `writeActiveDirectiveMarker(${JSON.stringify(project)}, {`,
          'kind: "run-stage", stage: "code-generation",',
          `state_sha256: ${JSON.stringify(createHash("sha256").update(state).digest("hex"))}`,
          "});",
        ].join("\n"),
      ],
      {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const publishedEarly = await Promise.race([
      publisher.exited.then(() => true),
      Bun.sleep(100).then(() => false),
    ]);
    expect(publishedEarly).toBe(false);
    writeFileSync(`${barrier}.release`, "release\n");
    const [beginExit, publisherExit, beginError, publisherError] =
      await Promise.all([
        begin.exited,
        publisher.exited,
        new Response(begin.stderr).text(),
        new Response(publisher.stderr).text(),
      ]);
    expect(beginExit, beginError).toBe(0);
    expect(publisherExit, publisherError).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
  }, 60000);

  test("receipt certification excludes concurrent legacy challenge reissue", async () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "legacy-receipt-race";
    appendAuditEntry(
      "SESSION_STARTED",
      { Source: "startup", Session: session },
      project,
    );
    const identity = decisionArgs(questions, session);
    expect(
      runLog(project, [
        "decision",
        ...identity,
        "--decision",
        "Approve this exact Code Generation plan?",
        "--options",
        "Approve Plan,Request Changes",
      ]).exitCode,
    ).toBe(0);
    const human = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "hooks", "aidlc-record-human-turn.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: session,
          prompt: "Approve Plan",
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(human.exitCode).toBe(0);
    writeFileSync(
      questions,
      readFileSync(questions, "utf-8").replace(
        /\[Answer\]:\s*$/,
        "[Answer]: Approve Plan",
      ),
    );

    const barrier = publicationBarrier();
    const answer = Bun.spawn(
      [
        BUN,
        join(DIST_ROOT, "tools", "aidlc-log.ts"),
        "answer",
        ...identity,
        "--details",
        "Approve Plan",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          AIDLC_TEST_PLAN_APPROVAL_RECEIPT_BARRIER: barrier,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    for (let i = 0; i < 10_000; i++) {
      if (existsSync(`${barrier}.snapshotted`)) break;
      await Bun.sleep(1);
    }
    expect(existsSync(`${barrier}.snapshotted`)).toBe(true);

    const state = readFileSync(
      join(seededRecordDir(project), "aidlc-state.md"),
      "utf-8",
    );
    const libUrl = pathToFileURL(
      join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"),
    ).href;
    const publisher = Bun.spawn(
      [
        BUN,
        "-e",
        [
          `import { writeActiveDirectiveMarker } from ${JSON.stringify(libUrl)};`,
          `writeActiveDirectiveMarker(${JSON.stringify(project)}, {`,
          'kind: "run-stage", stage: "code-generation",',
          `state_sha256: ${JSON.stringify(createHash("sha256").update(state).digest("hex"))}`,
          `}, { legacyPlanApprovalSession: ${JSON.stringify(session)},`,
          `legacyPlanApprovalOffer: { session: ${JSON.stringify(session)}, optionHashes: [${JSON.stringify("d".repeat(64))}, ${JSON.stringify("e".repeat(64))}] } });`,
        ].join("\n"),
      ],
      {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const publishedEarly = await Promise.race([
      publisher.exited.then(() => true),
      Bun.sleep(100).then(() => false),
    ]);
    expect(publishedEarly).toBe(false);

    writeFileSync(`${barrier}.release`, "release\n");
    const [answerExit, publisherExit, answerError, publisherError] =
      await Promise.all([
        answer.exited,
        publisher.exited,
        new Response(answer.stderr).text(),
        new Response(publisher.stderr).text(),
      ]);
    expect(answerExit, answerError).toBe(0);
    expect(publisherExit, publisherError).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(
      false,
    );
  }, 60000);

  test("rejects a source mutation that lands after validation but before certification completes", async () => {
    const project = createProject();
    for (let i = 0; i < 3000; i++) {
      writeFileSync(
        join(project, "src", `race-${String(i).padStart(4, "0")}.ts`),
        `export const race${i} = ${i};\n`,
      );
    }
    const state = readFileSync(
      join(seededRecordDir(project), "aidlc-state.md"),
      "utf-8",
    );
    clearActiveDirectiveMarker(project);
    writeActiveDirectiveMarker(project, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: createHash("sha256").update(state).digest("hex"),
    });
    const questions = seedPlan(project);
    const session = "race-session";
    appendAuditEntry(
      "SESSION_STARTED",
      { Source: "startup", Session: session },
      project,
    );
    const identity = decisionArgs(questions, session);
    expect(
      runLog(project, [
        "decision",
        ...identity,
        "--decision",
        "Approve this exact Code Generation plan?",
        "--options",
        "Approve Plan,Request Changes",
      ]).exitCode,
    ).toBe(0);
    const human = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "hooks", "aidlc-record-human-turn.ts")],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: session,
          prompt: "Approve Plan",
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(human.exitCode).toBe(0);
    writeFileSync(
      questions,
      readFileSync(questions, "utf-8").replace(
        /\[Answer\]:\s*$/,
        "[Answer]: Approve Plan",
      ),
    );
    const answer = Bun.spawn(
      [
        BUN,
        join(DIST_ROOT, "tools", "aidlc-log.ts"),
        "answer",
        ...identity,
        "--details",
        "Approve Plan",
      ],
      {
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    let receiptSeen = false;
    for (let i = 0; i < 5000; i++) {
      try {
        receiptSeen = readdirSync(runtimeDir).some((name) =>
          name.startsWith("receipt-")
        );
      } catch {
        receiptSeen = false;
      }
      if (receiptSeen) break;
      await Bun.sleep(1);
    }
    expect(receiptSeen).toBe(true);
    writeFileSync(
      join(project, "src", "zz-after-validation.ts"),
      "export const raced = true;\n",
    );
    const [exitCode, stderr] = await Promise.all([
      answer.exited,
      new Response(answer.stderr).text(),
    ]);
    const approval = evaluateCodeGenerationApproval(project, { unit: null });
    expect(approval.ok).toBe(false);
    if (exitCode !== 0) {
      expect(stderr).toContain("source changed during receipt certification");
    } else {
      expect(approval.reason).toContain("protected Plan Approval receipt");
    }
  }, 60000);
});
