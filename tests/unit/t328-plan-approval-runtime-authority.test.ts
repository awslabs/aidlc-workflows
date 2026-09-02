// covers: function:recordPlanApprovalReceipt, function:beginCodeGeneration, function:readPlanApprovalViolation

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
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
  readPlanApprovalViolation,
  refreshActiveDirectiveMarker,
  sessionsDir,
  writeActiveDirectiveMarker,
  stateDigest,
  workspaceSourceFingerprint,
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
  expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
}

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
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(
      true,
    );
  }, 60000);

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
