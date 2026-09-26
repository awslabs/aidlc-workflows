// covers: function:recordPlanApprovalReceipt, function:beginCodeGeneration, function:readPlanApprovalViolation, function:recordPlanApprovalOverrideRequest, function:recordPlanApprovalOverrideReceipt, function:resolvePlanApprovalSession, function:resolveInvokingSessionId, audit:PLAN_APPROVAL_OVERRIDDEN, audit:GUARD_DISABLED

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
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
  clearActiveDirectiveMarker,
  hooksHealthDir,
  readAuditShardEvents,
  readPlanApprovalOverrideRequest,
  readPlanApprovalViolation,
  refreshActiveDirectiveMarker,
  sessionsDir,
  setGuardsOffLine,
  writeActiveDirectiveMarker,
  stateDigest,
  stripRecommendedDecorator,
  workspaceSourceFingerprint,
  workspaceSourceState,
  writeSessionPidEntry,
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
  seededAuditShard,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const projects: string[] = [];
const barriers: string[] = [];
const DIST_ROOT = join(REPO_ROOT, "dist", "claude", ".claude");

afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop()!);
  for (const barrier of barriers.splice(0)) {
    rmSync(`${barrier}.published`, { force: true });
    rmSync(`${barrier}.snapshotted`, { force: true });
    rmSync(`${barrier}.release`, { force: true });
  }
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function publicationBarrier(): string {
  const barrier = join(tmpdir(), `aidlc-t328-${randomUUID()}`);
  barriers.push(barrier);
  return barrier;
}

function initGitBaseline(project: string): void {
  const sourceBefore = workspaceSourceState(project);
  expect(sourceBefore).not.toBeNull();
  expect([...sourceBefore!.listing.keys()]).toEqual(["\0src/base.ts"]);
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "--", "src"],
    ["commit", "-qm", "baseline"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  expect(workspaceSourceFingerprint(project)).toBe(sourceBefore!.fingerprint);
}

function createProject(): string {
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
  writeFileSync(statePath, state, "utf-8");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "base.ts"), "export const base = 1;\n");
  initGitBaseline(project);
  writeActiveDirectiveMarker(project, {
    kind: "run-stage",
    stage: "code-generation",
    state_sha256: stateDigest(state),
  });
  return project;
}

function seedPlan(project: string): string {
  const authority = resolveCodeGenerationAuthority(project, { unit: null });
  const contract = resolveTestingPosture(project);
  const dir = codeGenerationRecordDir(project, null);
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
      // The fingerprint command prints this second tag; the approval binds to it
      // rather than to the directive's sticky source floor.
      `[Planned Source]: ${workspaceSourceFingerprint(project) ?? "unbindable"}`,
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
  env: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [BUN, join(DIST_ROOT, "tools", "aidlc-log.ts"), ...args],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function decisionArgs(questions: string, session: string): string[] {
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

function decisionArgsNoSession(questions: string): string[] {
  return [
    "--stage",
    "code-generation",
    "--checkpoint",
    "plan-approval",
    "--questions-file",
    questions,
    "--stage-level",
  ];
}

// Blank the hook-injected session override so a runner launched from a
// harness shell cannot leak its own session into an auto-resolution test.
const NO_SESSION_OVERRIDE = {
  AIDLC_SESSION_OVERRIDE: "",
  AIDLC_SESSION_OVERRIDE_SOURCE: "",
};

// The session each minted Plan Approval receipt is bound to.
function receiptSessions(project: string): string[] {
  const dir = join(sessionsDir(project), "plan-approval");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("receipt-") && name.endsWith(".json"))
    .map((name) =>
      (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { session: string }).session);
}

function approve(project: string, questions: string, session: string): void {
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
    [BUN, join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
  expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
}

// A synthetic human prompt through the shipped human-turn hook. The typed
// override phrase is recorded ONLY from this UserPromptSubmit text path.
function humanPrompt(
  project: string,
  session: string,
  prompt: string,
  env: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [BUN, join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt,
      })),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function markAnswered(questions: string, answer = "Approve Plan"): void {
  writeFileSync(
    questions,
    readFileSync(questions, "utf-8").replace(/\[Answer\]:\s*$/m, `[Answer]: ${answer}`),
  );
}

function overrideAnswer(
  project: string,
  questions: string,
  // null omits --session so the answer resolves it from the invoking session.
  session: string | null,
  reason: string,
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    [
      BUN,
      join(DIST_ROOT, "tools", "aidlc-log.ts"),
      "answer",
      ...(session === null ? decisionArgsNoSession(questions) : decisionArgs(questions, session)),
      "--details",
      "Approve Plan",
      "--override",
      reason,
    ],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runPosture(
  project: string,
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    [BUN, join(DIST_ROOT, "tools", "aidlc-testing-posture.ts"), ...args, "--project-dir", project],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runGuard(
  project: string,
  payload: unknown,
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    [BUN, join(DIST_ROOT, "hooks", "aidlc-plan-approval-guard.ts")],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
      stdin: Buffer.from(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const UNBINDABLE_ENV = { AIDLC_TEST_SOURCE_MAX_ENTRIES: "1" };

describe("t328 Plan Approval runtime authority", () => {
  // Regression for the solo Plan Approval deadlock (#995): the Stop hook's own
  // read-only `next` probe fires at the turn boundary BETWEEN the challenge mint
  // (turn N) and the receipt write (turn N+1). When that probe still published
  // the durable directive marker it bumped code_generation_authority_revision
  // and reset the plan-approval runtime dir, so the approval could never
  // stabilize on a solo (non-team) workflow.
  test("a solo Stop-hook probe between challenge mint and receipt write leaves Plan Approval intact", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "solo-stop-hook-probe";
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
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    const mintedRuntime = readdirSync(runtimeDir).sort();
    expect(mintedRuntime.length).toBeGreaterThan(0);
    const epochBefore =
      resolveCodeGenerationAuthority(project, { unit: null }).directiveEpoch;

    const probe = Bun.spawnSync(
      [
        BUN,
        join(DIST_ROOT, "tools", "aidlc-orchestrate.ts"),
        "next",
        "--project-dir",
        project,
      ],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: project,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          AIDLC_STOP_HOOK_PROBE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(probe.exitCode, probe.stderr.toString()).toBe(0);
    expect(readdirSync(runtimeDir).sort()).toEqual(mintedRuntime);
    expect(
      resolveCodeGenerationAuthority(project, { unit: null }).directiveEpoch,
    ).toBe(epochBefore);

    const human = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(
      true,
    );
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("rejects malformed Plan Approval violation records", () => {
    // The source/Git baseline is built before any malformed-record assertion runs.
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
      [BUN, join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS); // Real hook and approval CLI round-trip exceeded 30s on Windows.

  test("directive churn preserves authority while a moved stage or attempt retires it", () => {
    const project = createProject();
    const questions = seedPlan(project);
    approve(project, questions, "lifecycle-one");
    beginCodeGeneration(project, { unit: null });

    // (a) Generation has begun, so the developer agent writing source is the
    // point, not a violation. The approval covers this work.
    writeFileSync(
      join(project, "src", "generated.ts"),
      "export const generated = true;\n",
    );
    const statePath = join(seededRecordDir(project), "aidlc-state.md");
    const codeGenerationState = readFileSync(statePath, "utf-8");
    writeActiveDirectiveMarker(project, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: stateDigest(codeGenerationState),
    });
    expect(
      evaluateCodeGenerationApproval(project, { unit: null }).reason,
    ).toBe("approved");

    // (b) A routing change is different: moving Current Stage supersedes the
    // live directive, so Code Generation authority no longer resolves at all.
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

    // (c) And the approval was not DESTROYED by any of that: restore the state,
    // re-issue the directive, and the same recorded decision authorizes again.
    // Before this change, a marker clear or republish deleted it, so the only way
    // back was to ask the human the same question a second time.
    clearActiveDirectiveMarker(project);
    writeFileSync(statePath, codeGenerationState);
    writeActiveDirectiveMarker(project, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: stateDigest(codeGenerationState),
    });
    expect(
      evaluateCodeGenerationApproval(project, { unit: null }).reason,
    ).toBe("approved");

    // (d) A new stage attempt DOES retire it: a jump is the human saying "do this
    // again", and the recorded approval belonged to the previous attempt.
    appendAuditEntry(
      "STAGE_JUMPED",
      {
        Stage: "code-generation",
        Direction: "REDO",
        Reason: "fixture redo",
      },
      project,
    );
    const afterJump = evaluateCodeGenerationApproval(project, { unit: null });
    expect(afterJump.ok).toBe(false);
    expect(
      resolveCodeGenerationAuthority(project, { unit: null }).runFloor,
    ).toStartWith("STAGE_JUMPED:");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    const publicationDeadline = Date.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!;
    while (!existsSync(`${barrier}.published`) && Date.now() < publicationDeadline) {
      await Bun.sleep(10);
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
      /Source files changed while code generation was starting\. Retry the step\.|1 file changed since this plan was approved: src\/zz-persistent-publication-race\.ts\. Look them over and approve the plan again to continue\./,
    );
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    const publicationDeadline = Date.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!;
    while (!existsSync(`${barrier}.published`) && Date.now() < publicationDeadline) {
      await Bun.sleep(10);
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
          `state_sha256: ${JSON.stringify(stateDigest(state))}`,
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
    // The publication is serialized behind the authority locks AND has no reason
    // to retire anything: the approval is bound to content and attempt, neither of
    // which a re-issued directive changes. This is what the test's name always
    // claimed; previously the publication retired the receipt anyway.
    expect(
      evaluateCodeGenerationApproval(project, { unit: null }).reason,
    ).toBe("approved");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
      [BUN, join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
    const snapshotDeadline = Date.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!;
    while (!existsSync(`${barrier}.snapshotted`) && Date.now() < snapshotDeadline) {
      await Bun.sleep(10);
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
          `state_sha256: ${JSON.stringify(stateDigest(state))}`,
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
    // The receipt was certified between two source reads while both authority
    // locks were held, and the concurrent legacy-offer publication could not
    // interleave. It also no longer deletes the receipt on its way past, so the
    // human's decision stands.
    expect(
      evaluateCodeGenerationApproval(project, { unit: null }).reason,
    ).toBe("approved");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
      state_sha256: stateDigest(state),
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
      [BUN, join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
    const receiptDeadline = Date.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!;
    while (Date.now() < receiptDeadline) {
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
      // The answer won the race, so a receipt exists and the refusal comes from the
      // source check instead. Which of the two fires is timing, so accept either, and
      // pin what actually matters: the refusal names the changed file and asks for
      // the plan to be approved again (Change Control strict on this fixture).
      expect(approval.reason).toMatch(
        /protected Plan Approval receipt|1 file changed since this plan was approved: src\/zz-after-validation\.ts\. Look them over and approve the plan again to continue\./,
      );
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t328 human-only break-glass override", () => {
  const PHRASE = "Override Plan Approval: the source walk is broken on this machine";
  const REASON = "the source walk is broken on this machine";

  test("only a typed UserPromptSubmit prompt records the override request", () => {
    const project = createProject();
    seedPlan(project);
    const session = "typed-phrase";

    // A picked option carrying the same text is not a typed instruction.
    const picked = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: session,
          tool_name: "AskUserQuestion",
          tool_response: { answers: { "Approve this exact Code Generation plan?": PHRASE } },
        })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(picked.exitCode).toBe(0);
    expect(readPlanApprovalOverrideRequest(project, session)).toBeNull();

    // An unattended driver has no human at the keyboard.
    expect(humanPrompt(project, session, PHRASE, { AIDLC_UNATTENDED: "1" }).exitCode).toBe(0);
    expect(readPlanApprovalOverrideRequest(project, session)).toBeNull();

    // Ordinary prose never opens it either.
    expect(humanPrompt(project, session, "please override plan approval, I am sure").exitCode).toBe(0);
    expect(readPlanApprovalOverrideRequest(project, session)).toBeNull();

    expect(humanPrompt(project, session, `  ${PHRASE}  `).exitCode).toBe(0);
    const request = readPlanApprovalOverrideRequest(project, session);
    expect(request?.reason).toBe(REASON);
    expect(request?.reasonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(sessionsDir(project), "plan-approval", `override-${session}.json`))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("answer --override is refused without the typed phrase, with a mismatched reason, and after consumption", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-refusals";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    markAnswered(questions);

    const noPhrase = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(noPhrase.exitCode).not.toBe(0);
    expect(noPhrase.stderr).toContain("Plan Approval override is human-only");
    expect(noPhrase.stderr).toContain("`Override Plan Approval: <reason>`");
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    expect(
      existsSync(runtimeDir) &&
        readdirSync(runtimeDir).some((name) => name.startsWith("receipt-")),
    ).toBe(false);

    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);
    const mismatch = overrideAnswer(project, questions, session, "a different reason", UNBINDABLE_ENV);
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr).toContain("Plan Approval override is human-only");
    expect(readPlanApprovalOverrideRequest(project, session)).not.toBeNull();

    const blank = overrideAnswer(project, questions, session, "   ", UNBINDABLE_ENV);
    expect(blank.exitCode).not.toBe(0);
    expect(blank.stderr).toContain("nonblank --override reason");

    const minted = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(minted.exitCode, minted.stderr).toBe(0);
    expect(readPlanApprovalOverrideRequest(project, session)).toBeNull();

    // The consumed phrase cannot authorize a second run.
    const again = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toContain("Plan Approval override is human-only");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The override authorization check and the receipt bind both read the one
  // `fields.Session` that resolvePlanApprovalSession returns. The break-glass
  // request is session-keyed, so if the check and the bind ever read different
  // ids, the answer would authorize against one session and record under
  // another. These pin both halves: an auto-resolved answer consumes the request
  // and binds the receipt under the same id, and a request typed under one
  // session cannot be spent while answering under a different --session.
  test("answer --override without --session authorizes, consumes, and binds under the resolved session", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-session-consistency";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    writeSessionPidEntry(project, process.pid, session);
    markAnswered(questions);
    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);
    expect(readPlanApprovalOverrideRequest(project, session)).not.toBeNull();

    const minted = overrideAnswer(project, questions, null, REASON, {
      ...UNBINDABLE_ENV,
      ...NO_SESSION_OVERRIDE,
    });
    expect(minted.exitCode, minted.stderr).toBe(0);
    expect(readPlanApprovalOverrideRequest(project, session)).toBeNull();
    expect(receiptSessions(project)).toEqual([session]);
  }, 60000);

  test("answer --override for a request typed under a different session is refused", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const requestSession = "override-owner-session";
    const answerSession = "override-other-session";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: requestSession }, project);
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: answerSession }, project);
    markAnswered(questions);
    // The human types the override request under requestSession only.
    expect(humanPrompt(project, requestSession, PHRASE).exitCode).toBe(0);
    expect(readPlanApprovalOverrideRequest(project, requestSession)).not.toBeNull();

    // Answering under a different explicit --session must not find that request.
    const refused = overrideAnswer(project, questions, answerSession, REASON, UNBINDABLE_ENV);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("Plan Approval override is human-only");
    // The owner's request is untouched: nothing consumed it under the wrong id.
    expect(readPlanApprovalOverrideRequest(project, requestSession)).not.toBeNull();
    expect(readPlanApprovalOverrideRequest(project, answerSession)).toBeNull();
  }, 60000);

  test("answer --override is refused while [Answer] is blank", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-blank-answer";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);
    const refused = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("must contain exactly [Answer]: Approve Plan");
    // Nothing was spent: the typed request is still there for the retry.
    expect(readPlanApprovalOverrideRequest(project, session)).not.toBeNull();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a missing request answers with the human-only guidance and nothing else, even when the answer is blank", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-guidance-only";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    const refused = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("Plan Approval override is human-only");
    expect(refused.stderr).not.toContain("[Answer]");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS); // Fixture/CLI setup took 32s on Windows; the refusal assertions remain required.

  test("an edited request file or one typed under another intent is not a request", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-tampered";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    markAnswered(questions);
    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);
    const requestPath = join(sessionsDir(project), "plan-approval", `override-${session}.json`);
    const recorded = JSON.parse(readFileSync(requestPath, "utf-8")) as {
      reason: string;
      reasonSha256: string;
      intentId: string;
    };

    // The stored reason no longer hashes to the stored digest: the digest alone
    // matching the command's reason is not enough.
    writeFileSync(requestPath, JSON.stringify({ ...recorded, reason: "something else" }, null, 2));
    const tampered = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(tampered.exitCode).not.toBe(0);
    expect(tampered.stderr).toContain("Plan Approval override is human-only");

    // Typed while another intent was active.
    writeFileSync(
      requestPath,
      JSON.stringify({ ...recorded, intentId: "00000000-0000-7000-8000-00000000dead" }, null, 2),
    );
    const foreign = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(foreign.exitCode).not.toBe(0);
    expect(foreign.stderr).toContain("Plan Approval override is human-only");
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    expect(readdirSync(runtimeDir).some((name) => name.startsWith("receipt-"))).toBe(false);

    // The genuine request still works once restored.
    writeFileSync(requestPath, JSON.stringify(recorded, null, 2));
    const minted = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(minted.exitCode, minted.stderr).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The one injection that breaks the ledger append while every read still
  // works is a read-only shard (the t332 receipt-rollback idiom); root and
  // Windows do not honor the mode bits, so the case is gated the same way.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const runIfChmod = process.platform !== "win32" && !isRoot ? test : test.skip;
  runIfChmod("a PLAN_APPROVAL_OVERRIDDEN row that cannot be appended leaves no receipt and spends no request", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-row-first";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    markAnswered(questions);
    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);
    const shard = seededAuditShard(project);
    chmodSync(shard, 0o444);
    let failed: ReturnType<typeof overrideAnswer>;
    try {
      failed = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    } finally {
      chmodSync(shard, 0o644);
    }
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("Refusing to record Plan Approval override");
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    expect(readdirSync(runtimeDir).some((name) => name.startsWith("receipt-"))).toBe(false);
    expect(readPlanApprovalOverrideRequest(project, session)).not.toBeNull();
    const events = readAuditShardEvents(project);
    expect(events.some((entry) => entry.event === "PLAN_APPROVAL_OVERRIDDEN")).toBe(false);
    expect(events.some((entry) => entry.event === "PLAN_APPROVAL_RECORDED")).toBe(false);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);

    // With the ledger writable again the same typed request completes the run.
    const minted = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(minted.exitCode, minted.stderr).toBe(0);
    expect(readPlanApprovalOverrideRequest(project, session)).toBeNull();
    expect(readAuditShardEvents(project).filter((entry) => entry.event === "PLAN_APPROVAL_OVERRIDDEN")).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("an unbindable workspace mints an override receipt that verify, begin, and the dispatch guard accept", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-unbindable";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    markAnswered(questions);
    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);

    const minted = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(minted.exitCode, minted.stderr).toBe(0);
    const output = JSON.parse(minted.stdout) as {
      emitted: string;
      override: boolean;
      failed_checks: string[];
    };
    expect(output.emitted).toBe("PLAN_APPROVAL_RECORDED");
    expect(output.override).toBe(true);
    expect(output.failed_checks.join("\n")).toContain("workspace source cannot be bound");

    const events = readAuditShardEvents(project);
    const overridden = events.filter((entry) => entry.event === "PLAN_APPROVAL_OVERRIDDEN");
    expect(overridden).toHaveLength(1);
    expect(overridden[0].block).toContain(`**Reason**: ${REASON}`);
    expect(overridden[0].block).toContain("**Unit**: stage-level");
    expect(overridden[0].block).toContain("**Failed Checks**: ");
    const recorded = events.filter((entry) => entry.event === "PLAN_APPROVAL_RECORDED");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].block).toContain("**Override**: yes");

    const runtimeDir = join(sessionsDir(project), "plan-approval");
    const receiptName = readdirSync(runtimeDir).find((name) => name.startsWith("receipt-"));
    expect(receiptName).toBeDefined();
    const receipt = JSON.parse(readFileSync(join(runtimeDir, receiptName!), "utf-8")) as {
      certifiedSourceSha256: string;
      override: { reason: string; failedChecks: string[] };
      status: string;
    };
    expect(receipt.certifiedSourceSha256).toBe("unbindable");
    expect(receipt.override.reason).toBe(REASON);
    expect(receipt.override.failedChecks.length).toBeGreaterThan(0);
    expect(receipt.status).toBe("approved");
    expect(readdirSync(runtimeDir).some((name) => name.startsWith("override-"))).toBe(false);

    const verify = runPosture(project, ["verify", "--stage-level"], UNBINDABLE_ENV);
    expect(verify.exitCode, verify.stderr).toBe(0);
    const verified = JSON.parse(verify.stdout) as { ok: boolean; override?: boolean; reason: string };
    expect(verified.ok).toBe(true);
    expect(verified.override).toBe(true);
    expect(verified.reason).toBe("approved");

    // Generation start and the developer dispatch accept the override receipt
    // even though the workspace still cannot be bound.
    const brief = runPosture(project, ["brief", "--stage-level"], UNBINDABLE_ENV);
    expect(brief.exitCode, brief.stderr).toBe(0);
    const dispatch = runGuard(
      project,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "aidlc-developer-agent", prompt: brief.stdout },
      },
      UNBINDABLE_ENV,
    );
    expect(dispatch.exitCode, dispatch.stderr).toBe(0);
    const published = JSON.parse(readFileSync(join(runtimeDir, receiptName!), "utf-8")) as {
      status: string;
      override: unknown;
    };
    expect(published.status).toBe("generation");
    expect(published.override).toBeDefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a valid break-glass receipt keeps its source exception after content edits under a lowered fence", () => {
    const project = createProject();
    const statePath = join(seededRecordDir(project), "aidlc-state.md");
    const state = setGuardsOffLine(readFileSync(statePath, "utf-8"), ["plan-approval"]);
    writeFileSync(statePath, state);
    writeActiveDirectiveMarker(project, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: stateDigest(state),
    });
    const questions = seedPlan(project);
    const session = "override-lowered-edited-content";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    markAnswered(questions);
    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);
    const minted = overrideAnswer(project, questions, session, REASON, UNBINDABLE_ENV);
    expect(minted.exitCode, minted.stderr).toBe(0);
    const approvalRows = readAuditShardEvents(project).filter((entry) => entry.event === "PLAN_APPROVAL_RECORDED");
    const originalQuestions = readFileSync(questions, "utf-8");
    const runtime = join(sessionsDir(project), "plan-approval");
    const receiptPath = join(runtime, readdirSync(runtime).find((name) => name.startsWith("receipt-"))!);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf-8"));
    expect(receipt.override).toBeDefined();
    expect(receipt.status).toBe("approved");
    const planPath = join(codeGenerationRecordDir(project, null), "code-generation-plan.md");
    writeFileSync(planPath, `${readFileSync(planPath, "utf-8")}\n- [ ] Revised work.\n`);
    const verified = runPosture(project, ["verify", "--stage-level"], UNBINDABLE_ENV);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: false, execution_allowed: true });
    const brief = runPosture(project, ["brief", "--stage-level"], UNBINDABLE_ENV);
    expect(brief.exitCode, brief.stderr).toBe(0);
    for (const [tool_name, tool_input] of [
      ["Write", { file_path: join(project, "src/base.ts"), content: "export const base = 2;\n" }],
      ["Task", { subagent_type: "aidlc-developer-agent", prompt: brief.stdout }],
    ] as const) {
      const guarded = runGuard(project, {
        hook_event_name: "PreToolUse", tool_name, tool_input, cwd: project,
      }, UNBINDABLE_ENV);
      expect(guarded.exitCode, guarded.stderr).toBe(0);
    }
    expect(JSON.parse(readFileSync(receiptPath, "utf-8"))).toEqual({ ...receipt, status: "generation" });
    expect(readAuditShardEvents(project).filter((entry) => entry.event === "PLAN_APPROVAL_RECORDED")).toEqual(approvalRows);
    expect(readFileSync(questions, "utf-8")).toBe(originalQuestions);
    expect(readFileSync(statePath, "utf-8")).toBe(state);
  });

  test("an orphaned response is recoverable through the typed phrase", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-orphaned";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    const identity = decisionArgs(questions, session);
    const decision = [
      "decision",
      ...identity,
      "--decision",
      "Approve this exact Code Generation plan?",
      "--options",
      "Approve Plan,Request Changes",
    ];
    expect(runLog(project, decision).exitCode).toBe(0);
    expect(humanPrompt(project, session, "Approve Plan").exitCode).toBe(0);
    // The conductor re-runs decision after the human already answered: the
    // response now pairs with a challenge that no longer exists.
    expect(runLog(project, decision).exitCode).toBe(0);
    markAnswered(questions);
    const orphaned = runLog(project, ["answer", ...identity, "--details", "Approve Plan"]);
    expect(orphaned.exitCode).not.toBe(0);
    expect(orphaned.stderr?.toString() ?? "").toContain("actual offered choice from this prompt and session");

    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);
    const minted = overrideAnswer(project, questions, session, REASON);
    expect(minted.exitCode, minted.stderr).toBe(0);
    const output = JSON.parse(minted.stdout) as { override: boolean; failed_checks: string[] };
    expect(output.override).toBe(true);
    expect(output.failed_checks.join("\n")).toContain("actual offered choice from this prompt and session");
    expect(evaluateCodeGenerationApproval(project, { unit: null })).toMatchObject({
      ok: true,
      reason: "approved",
      override: true,
    });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a normal receipt that succeeds under --override records no override", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "override-not-needed";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
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
    expect(humanPrompt(project, session, "Approve Plan").exitCode).toBe(0);
    expect(humanPrompt(project, session, PHRASE).exitCode).toBe(0);
    markAnswered(questions);
    const minted = overrideAnswer(project, questions, session, REASON);
    expect(minted.exitCode, minted.stderr).toBe(0);
    const output = JSON.parse(minted.stdout) as { override: boolean; note?: string };
    expect(output.override).toBe(false);
    expect(output.note).toContain("override was not needed");
    const events = readAuditShardEvents(project);
    expect(events.some((entry) => entry.event === "PLAN_APPROVAL_OVERRIDDEN")).toBe(false);
    expect(
      events.find((entry) => entry.event === "PLAN_APPROVAL_RECORDED")?.block,
    ).not.toContain("**Override**");
    // The typed request was still spent by the successful receipt.
    expect(readPlanApprovalOverrideRequest(project, session)).toBeNull();
    expect(evaluateCodeGenerationApproval(project, { unit: null }).override).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the guard off-switch writes one GUARD_DISABLED row per streak", () => {
    const project = createProject();
    seedPlan(project);
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: "guard-off" }, project);
    const dispatch = {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt: "AIDLC-STAGE: code-generation" },
    };
    const disabled = { AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" };
    expect(runGuard(project, dispatch, disabled).exitCode).toBe(0);
    expect(runGuard(project, { ...dispatch, tool_name: "Bash", tool_input: { command: "echo hi" } }, disabled).exitCode).toBe(0);
    expect(runGuard(project, dispatch, disabled).exitCode).toBe(0);
    const rows = readAuditShardEvents(project).filter((entry) => entry.event === "GUARD_DISABLED");
    expect(rows).toHaveLength(1);
    expect(rows[0].block).toContain("**Guard**: plan-approval-guard");
    expect(rows[0].block).toContain("**Tool**: Task");
    // Another row in between ends the streak, so the next disabled call records again.
    appendAuditEntry("HUMAN_TURN", { Session: "guard-off" }, project);
    expect(runGuard(project, dispatch, disabled).exitCode).toBe(0);
    expect(
      readAuditShardEvents(project).filter((entry) => entry.event === "GUARD_DISABLED"),
    ).toHaveLength(2);
    // With the switch off the same dispatch is enforced.
    expect(runGuard(project, dispatch).exitCode).toBe(2);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t328 decision refuses a challenge no answer could ever accept", () => {
  const DECISION_TAIL = [
    "--decision",
    "Approve this exact Code Generation plan?",
    "--options",
    "Approve Plan,Request Changes",
  ];

  test("an unbindable workspace is refused before any challenge is minted, with ordered remedies", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "decision-unbindable";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    const refused = Bun.spawnSync(
      [BUN, join(DIST_ROOT, "tools", "aidlc-log.ts"), "decision", ...decisionArgs(questions, session), ...DECISION_TAIL],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...UNBINDABLE_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(refused.exitCode).not.toBe(0);
    const stderr = refused.stderr.toString();
    expect(stderr).toContain("Plan Approval cannot be presented: the workspace source cannot be bound");
    expect(stderr).toContain("no challenge was minted");
    const remedyLine = stderr.split("\n").find((line) => line.includes('"remedies"'));
    expect(remedyLine).toBeDefined();
    const typed = JSON.parse(remedyLine!) as {
      code: string;
      remedies: Array<{ op: string; requiresHuman: boolean; executableNow: boolean; action: string }>;
    };
    expect(typed.code).toBe("PLAN_APPROVAL_SOURCE_UNBINDABLE");
    expect(typed.remedies.map((remedy) => remedy.op)).toEqual([
      "repair-source-boundary",
      "break-glass-override",
    ]);
    expect(typed.remedies[0].action).toContain(".aidlc-source-paths.json");
    expect(typed.remedies[1]).toMatchObject({ requiresHuman: true, executableNow: false });
    expect(typed.remedies[1].action).toContain("`Override Plan Approval: <reason>`");
    // Repair first, break glass last, in the human sentence as well.
    expect(stderr.indexOf(".aidlc-source-paths.json")).toBeLessThan(stderr.indexOf("Break glass (human only)"));
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    expect(
      existsSync(runtimeDir) && readdirSync(runtimeDir).some((name) => name.startsWith("challenge-")),
    ).toBe(false);
    expect(readAuditShardEvents(project).some((entry) => entry.event === "DECISION_RECORDED")).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a planned source recorded as unbindable is judged as drift once the workspace binds", () => {
    const project = createProject();
    const questions = seedPlan(project);
    writeFileSync(
      questions,
      readFileSync(questions, "utf-8").replace(/^\[Planned Source\]: .*$/m, "[Planned Source]: unbindable"),
    );
    const session = "decision-planned-unbindable";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    // The fixture's Change Control is strict: the remedy is the re-fingerprint,
    // which now records a real source, and no challenge is minted meanwhile.
    const refused = runLog(project, ["decision", ...decisionArgs(questions, session), ...DECISION_TAIL]);
    expect(refused.exitCode).not.toBe(0);
    const stderr = refused.stderr?.toString() ?? "";
    expect(stderr).toContain("Re-run the fingerprint command and re-present the plan.");
    expect(readFileSync(questions, "utf-8")).toContain("[Planned Source]: unbindable");
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    expect(
      existsSync(runtimeDir) && readdirSync(runtimeDir).some((name) => name.startsWith("challenge-")),
    ).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a successful decision prints the challenge id and file", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "decision-prints-challenge";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    const decision = runLog(project, ["decision", ...decisionArgs(questions, session), ...DECISION_TAIL]);
    expect(decision.exitCode, decision.stderr?.toString()).toBe(0);
    const output = JSON.parse(decision.stdout?.toString() ?? "{}") as {
      emitted: string;
      challengeId: string;
      challengeFile: string;
    };
    expect(output.emitted).toBe("DECISION_RECORDED");
    expect(output.challengeId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(output.challengeFile).toBe(`aidlc/.aidlc-sessions/plan-approval/challenge-${session}.json`);
    const challenge = JSON.parse(readFileSync(join(project, output.challengeFile), "utf-8")) as {
      challengeId: string;
    };
    expect(challenge.challengeId).toBe(output.challengeId);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t328 the Codex (Recommended) label decorator", () => {
  // The Codex question guide decorates the recommended option's label; the
  // picked label comes back decorated. One trailing decorator pairs; nothing
  // else about the exact-label match is loosened.
  function pairs(response: string): boolean {
    const project = createProject();
    const questions = seedPlan(project);
    const session = `decorator-${createHash("sha256").update(response).digest("hex").slice(0, 8)}`;
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    expect(
      runLog(project, [
        "decision",
        ...decisionArgs(questions, session),
        "--decision",
        "Approve this exact Code Generation plan?",
        "--options",
        "Approve Plan,Request Changes",
        "--exact-option-labels",
        "true",
      ]).exitCode,
    ).toBe(0);
    expect(humanPrompt(project, session, response).exitCode).toBe(0);
    return existsSync(join(sessionsDir(project), "plan-approval", `response-${session}.json`));
  }

  // Each pairing case builds a Git-backed project and runs decision/human-turn CLIs.
  test('"Approve Plan (Recommended)" pairs as Approve Plan', () => {
    expect(pairs("Approve Plan (Recommended)")).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test('"Approve Plan (recommended) " pairs, case and whitespace tolerant', () => {
    expect(pairs("Approve Plan (recommended) ")).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test('"Approve Planx" does not pair', () => {
    expect(pairs("Approve Planx")).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the decorator is stripped once and only at the end", () => {
    expect(stripRecommendedDecorator("Approve Plan (Recommended)")).toBe("Approve Plan");
    expect(stripRecommendedDecorator("  Approve Plan   (RECOMMENDED)  ")).toBe("Approve Plan");
    expect(stripRecommendedDecorator("Approve Plan (Recommended) (Recommended)")).toBe(
      "Approve Plan (Recommended)",
    );
    expect(stripRecommendedDecorator("(Recommended) Approve Plan")).toBe("(Recommended) Approve Plan");
  });
});

describe("t328 decision refuses while hooks are provably not firing", () => {
  const DECISION_TAIL = [
    "--decision",
    "Approve this exact Code Generation plan?",
    "--options",
    "Approve Plan,Request Changes",
  ];

  function heartbeat(project: string, hook: string, at: Date): void {
    const dir = hooksHealthDir(project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${hook}.last`), at.toISOString().replace(/\.\d{3}Z$/, "Z"), "utf-8");
  }

  test("a workflow that advanced more than the doctor's slack after the last heartbeat is refused before minting", () => {
    const project = createProject();
    const session = "hooks-stale";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    // The engine advanced now (a new stage attempt, so the plan is fingerprinted
    // against it below); the hooks last fired ten minutes ago.
    heartbeat(project, "plan-approval-guard", new Date(Date.now() - 10 * 60 * 1000));
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation" }, project);
    const questions = seedPlan(project);
    const refused = runLog(project, ["decision", ...decisionArgs(questions, session), ...DECISION_TAIL]);
    expect(refused.exitCode).not.toBe(0);
    const stderr = refused.stderr?.toString() ?? "";
    expect(stderr).toContain("hooks are not firing in this session");
    expect(stderr).toContain("Run /hooks to check hook approval and policy state");
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    expect(
      existsSync(runtimeDir) && readdirSync(runtimeDir).some((name) => name.startsWith("challenge-")),
    ).toBe(false);
    expect(readAuditShardEvents(project).some((entry) => entry.event === "DECISION_RECORDED")).toBe(false);

    // A fresh heartbeat (the hook that runs this very command) lifts the refusal.
    heartbeat(project, "plan-approval-guard", new Date());
    const minted = runLog(project, ["decision", ...decisionArgs(questions, session), ...DECISION_TAIL]);
    expect(minted.exitCode, minted.stderr?.toString()).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("no heartbeats at all is not evidence of dead hooks", () => {
    const project = createProject();
    const session = "hooks-never";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation" }, project);
    const questions = seedPlan(project);
    expect(existsSync(hooksHealthDir(project))).toBe(false);
    const minted = runLog(project, ["decision", ...decisionArgs(questions, session), ...DECISION_TAIL]);
    expect(minted.exitCode, minted.stderr?.toString()).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t328 plan-approval session resolution", () => {
  const DECISION_TAIL = [
    "--decision",
    "Approve this exact Code Generation plan?",
    "--options",
    "Approve Plan,Request Changes",
  ];

  // Present the plan and record the human's reply under `humanSession`, then
  // answer. `sessionArgs` builds the log identity, so a test chooses whether
  // --session is passed or resolved.
  function presentAndAnswer(
    project: string,
    questions: string,
    humanSession: string,
    sessionArgs: string[],
    env: Record<string, string>,
  ): { decided: ReturnType<typeof Bun.spawnSync>; answered: ReturnType<typeof Bun.spawnSync> } {
    const decided = runLog(project, ["decision", ...sessionArgs, ...DECISION_TAIL], env);
    expect(decided.exitCode, decided.stderr?.toString()).toBe(0);
    expect(humanPrompt(project, humanSession, "Approve Plan").exitCode).toBe(0);
    markAnswered(questions);
    const answered = runLog(project, ["answer", ...sessionArgs, "--details", "Approve Plan"], env);
    return { decided, answered };
  }

  test("decision and answer without --session bind the invoking conversation's session", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "c-ancestry-session";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    writeSessionPidEntry(project, process.pid, session);
    const { answered } = presentAndAnswer(
      project, questions, session, decisionArgsNoSession(questions), NO_SESSION_OVERRIDE,
    );
    expect(answered.exitCode, answered.stderr?.toString()).toBe(0);
    expect(receiptSessions(project)).toEqual([session]);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
  }, 60000);

  // A harness that injects the validated payload session (Codex rewrites each
  // Bash command to export it) is the authority on which conversation is
  // speaking. An ancestry entry left by another conversation must not win.
  test("a hook-injected payload session wins over a disagreeing ancestry entry", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "c-payload-session";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    writeSessionPidEntry(project, process.pid, "c-other-conversation");
    const { answered } = presentAndAnswer(
      project, questions, session, decisionArgsNoSession(questions), {
        AIDLC_SESSION_OVERRIDE: session,
        AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
      },
    );
    expect(answered.exitCode, answered.stderr?.toString()).toBe(0);
    expect(receiptSessions(project)).toEqual([session]);
  }, 60000);

  test("an exported override that disagrees with the ancestry is refused, not guessed", () => {
    const project = createProject();
    const questions = seedPlan(project);
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: "c-owner" }, project);
    writeSessionPidEntry(project, process.pid, "c-owner");
    const refused = runLog(
      project,
      ["decision", ...decisionArgsNoSession(questions), ...DECISION_TAIL],
      { AIDLC_SESSION_OVERRIDE: "c-stale-export", AIDLC_SESSION_OVERRIDE_SOURCE: "" },
    );
    expect(refused.exitCode).not.toBe(0);
    const stderr = refused.stderr!.toString();
    expect(stderr).toContain("c-stale-export");
    expect(stderr).toContain("conflicts with the owning conversation");
    expect(stderr).toContain("c-owner");
    expect(readAuditShardEvents(project).some((entry) => entry.event === "DECISION_RECORDED")).toBe(false);
  }, 30000);

  test("an explicit --session wins over the resolved session", () => {
    const project = createProject();
    const questions = seedPlan(project);
    const session = "c-explicit-session";
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
    writeSessionPidEntry(project, process.pid, "c-ancestry-loses");
    const { answered } = presentAndAnswer(
      project, questions, session, decisionArgs(questions, session), NO_SESSION_OVERRIDE,
    );
    expect(answered.exitCode, answered.stderr?.toString()).toBe(0);
    expect(receiptSessions(project)).toEqual([session]);
  }, 60000);

  // These projects seed no session/pid entry and blank the override, so nothing
  // can resolve and the refusal must name the argument to add.
  test("decision without a resolvable session fails naming the exact argument", () => {
    const project = createProject();
    const questions = seedPlan(project);
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: "c-unresolvable" }, project);
    const refused = runLog(
      project,
      ["decision", ...decisionArgsNoSession(questions), ...DECISION_TAIL],
      NO_SESSION_OVERRIDE,
    );
    expect(refused.exitCode).not.toBe(0);
    const stderr = refused.stderr!.toString();
    expect(stderr).toContain(
      "Plan Approval requires --session <id> from the invoking SessionStart context.",
    );
    expect(stderr).toContain("pass `--session <the SessionStart id>` explicitly");
  }, 30000);

  test("answer without a resolvable session fails naming the exact argument", () => {
    const project = createProject();
    const questions = seedPlan(project);
    markAnswered(questions);
    const refused = runLog(
      project,
      ["answer", ...decisionArgsNoSession(questions), "--details", "Approve Plan"],
      NO_SESSION_OVERRIDE,
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr!.toString()).toContain(
      "pass `--session <the SessionStart id>` explicitly",
    );
  }, 30000);
});
