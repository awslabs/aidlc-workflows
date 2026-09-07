// covers: function:advanceContinuationCursor, function:writeActiveDirectiveMarker, function:writePlanApprovalLegacyOffer, function:readKiroIdeLegacyPlanApprovalHost, function:writePlanApprovalLegacyRecoveryChallenge, function:readPlanApprovalLegacyRecoveryChallenge, function:writePlanApprovalLegacyRecoveryResponse, function:readPlanApprovalLegacyRecoveryResponse, function:clearPlanApprovalLegacyRecovery, subcommand:aidlc-orchestrate:continue

import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  clearPlanApprovalLegacyOffer,
  kiroIdeLegacyPlanApprovalSessionId,
  markKiroIdeLegacyPlanApprovalHost,
  readPlanApprovalChallenge,
  readPlanApprovalLegacyOffer,
  writePlanApprovalChallenge,
} from "../../core/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  REPO_ROOT,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const projects: string[] = [];

interface Directive {
  ask_type?: string;
  kind: string;
  stage?: string;
  continue_token?: string;
  legacy_plan_approval_choices?: {
    approve: string;
    request_changes: string;
  };
  message?: string;
  question?: string;
  recovery_choice?: string;
  response_route?: string;
}

function initGitBaseline(dir: string): void {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
}

function project(harness: "claude" | "kiro-ide" = "claude"): {
  dir: string;
  tool: string;
  markerPath: string;
} {
  const dir = setupIntegrationProject({
    withState: "state-brownfield-feature.md",
  });
  projects.push(dir);
  const harnessDir = harness === "kiro-ide" ? ".kiro" : ".claude";
  const destination = join(dir, harnessDir);
  rmSync(destination, { recursive: true, force: true });
  cpSync(
    join(REPO_ROOT, "dist", harness, harnessDir),
    destination,
    { recursive: true },
  );
  for (const tool of ["aidlc-lib.ts", "aidlc-orchestrate.ts"]) {
    cpSync(
      join(REPO_ROOT, "core", "tools", tool),
      join(destination, "tools", tool),
    );
  }
  writeFileSync(
    join(dir, "aidlc", "spaces", "default", "memory", "org.md"),
    Array.from(
      { length: 180 },
      (_, i) => `## Authority publication ${i}\n\n${"x".repeat(320)}\n\n`,
    ).join(""),
    "utf-8",
  );
  const statePath = join(seededRecordDir(dir), "aidlc-state.md");
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8")
      .replace(
        /^- \*\*Current Stage\*\*:.*$/m,
        "- **Current Stage**: code-generation",
      )
      .replace(
        /^- \[[ xSR?-]\] code-generation(\s+—\s+)EXECUTE$/m,
        "- [-] code-generation$1EXECUTE",
      ),
    "utf-8",
  );
  initGitBaseline(dir);
  return {
    dir,
    tool: join(destination, "tools", "aidlc-orchestrate.ts"),
    markerPath: join(seededRecordDir(dir), ".aidlc-active-directive.json"),
  };
}

function invoke(
  installed: ReturnType<typeof project>,
  verb: "next" | "continue",
  token?: string,
  env: Record<string, string> = {},
): Directive {
  const proc = Bun.spawnSync(
    [
      BUN,
      installed.tool,
      verb,
      ...(verb === "continue" ? [token ?? ""] : []),
      "--project-dir",
      installed.dir,
    ],
    {
      cwd: installed.dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    },
  );
  expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  return JSON.parse(proc.stdout.toString()) as Directive;
}

function marker(
  installed: ReturnType<typeof project>,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(installed.markerPath, "utf-8"),
  ) as Record<string, unknown>;
}

function runToCodeGeneration(
  installed: ReturnType<typeof project>,
  env: Record<string, string> = {},
): Directive {
  let directive = invoke(installed, "next", undefined, env);
  for (let i = 0; directive.kind === "load-steering" && i < 20; i++) {
    directive = invoke(
      installed,
      "continue",
      directive.continue_token,
      env,
    );
  }
  return directive;
}

function startLegacyKiroHost(
  installed: ReturnType<typeof project>,
  env: Record<string, string>,
): void {
  const proc = Bun.spawnSync(
    [
      BUN,
      join(
        installed.dir,
        ".kiro",
        "hooks",
        "aidlc-kiro-adapter.ts",
      ),
      "session-start",
    ],
    {
      cwd: installed.dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...env,
        CLAUDE_PROJECT_DIR: installed.dir,
        USER_PROMPT: JSON.stringify({ prompt: "continue" }),
      },
    },
  );
  expect(proc.exitCode, proc.stderr.toString()).toBe(0);
}

function submitLegacyPrompt(
  installed: ReturnType<typeof project>,
  env: Record<string, string>,
  prompt: string,
): void {
  const proc = Bun.spawnSync(
    [
      BUN,
      join(
        installed.dir,
        ".kiro",
        "hooks",
        "aidlc-kiro-adapter.ts",
      ),
      "record-human-turn",
    ],
    {
      cwd: installed.dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...env,
        CLAUDE_PROJECT_DIR: installed.dir,
        USER_PROMPT: JSON.stringify({ prompt }),
      },
    },
  );
  expect(proc.exitCode, proc.stderr.toString()).toBe(0);
}

function recoverLegacyCapability(
  installed: ReturnType<typeof project>,
  env: Record<string, string>,
): Directive {
  const recovery = invoke(installed, "next", undefined, env);
  expect(recovery).toMatchObject({
    kind: "ask",
    ask_type: "legacy-plan-approval-recovery",
    response_route: "next",
    recovery_choice: "Recover Plan Approval",
  });
  expect(recovery.legacy_plan_approval_choices).toBeUndefined();
  submitLegacyPrompt(installed, env, "Recover Plan Approval");
  return runToCodeGeneration(installed, env);
}

afterAll(() => {
  for (const dir of projects) cleanupTestProject(dir);
}, 30000);

describe("t327 Code Generation authority publication", () => {
  test("real load-steering continuations preserve the source floor through run-stage", () => {
    const installed = project();
    let directive = invoke(installed, "next");
    expect(directive.kind).toBe("load-steering");
    const floor = String(marker(installed).code_generation_source_sha256 ?? "");
    expect(floor).toMatch(/^[0-9a-f]{40,64}$/);

    writeFileSync(
      join(installed.dir, "preapproval-mutation.ts"),
      "export const changedBeforeApproval = true;\n",
      "utf-8",
    );
    directive = invoke(installed, "next");
    expect(directive.kind).toBe("load-steering");
    expect(marker(installed).code_generation_source_sha256).toBe(floor);

    for (let i = 0; directive.kind === "load-steering" && i < 20; i++) {
      directive = invoke(installed, "continue", directive.continue_token);
      expect(marker(installed).code_generation_source_sha256).toBe(floor);
    }

    expect(directive).toMatchObject({
      kind: "run-stage",
      stage: "code-generation",
    });
  }, 30000);

  test("legacy Kiro serializes live windows and rotates owner recovery without plaintext storage", () => {
    const installed = project("kiro-ide");
    const envA = {
      VSCODE_IPC_HOOK: `t327-host:${installed.dir}`,
      VSCODE_PID: String(process.pid),
    };
    const sessionA = kiroIdeLegacyPlanApprovalSessionId({
      ...process.env,
      ...envA,
    });
    expect(sessionA).not.toBeNull();
    startLegacyKiroHost(installed, envA);
    const directive = runToCodeGeneration(installed, envA);
    expect(directive).toMatchObject({
      kind: "run-stage",
      stage: "code-generation",
    });
    const choices = directive.legacy_plan_approval_choices;
    expect(choices?.approve).toMatch(/^Approve Plan \[[0-9a-f]{12}\]$/);
    expect(choices?.request_changes).toMatch(
      /^Request Changes \[[0-9a-f]{12}\]$/,
    );

    const runtimeDir = join(
      installed.dir,
      "aidlc",
      ".aidlc-sessions",
      "plan-approval",
    );
    const runtime = readdirSync(runtimeDir)
      .map((name) => readFileSync(join(runtimeDir, name), "utf-8"))
      .join("\n");
    expect(runtime).not.toContain(choices?.approve ?? "missing-approve");
    expect(runtime).not.toContain(
      choices?.request_changes ?? "missing-request-changes",
    );

    const recovered = recoverLegacyCapability(installed, envA);
    expect(recovered.legacy_plan_approval_choices?.approve).toMatch(
      /^Approve Plan \[[0-9a-f]{12}\]$/,
    );
    expect(recovered.legacy_plan_approval_choices).not.toEqual(choices);

    const offer = readPlanApprovalLegacyOffer(
      installed.dir,
      sessionA ?? "",
    );
    expect(offer).not.toBeNull();
    clearPlanApprovalLegacyOffer(installed.dir, sessionA ?? "");
    writePlanApprovalChallenge(installed.dir, {
      version: 1,
      session: sessionA ?? "",
      challengeId: "challenge-before-recovery",
      targetId: "stage:code-generation",
      intentId: offer?.intentId ?? "",
      directiveEpoch: `revision:${offer?.markerRevision ?? 0}`,
      runFloor: "test-run",
      fingerprint: "a".repeat(64),
      questionsFile: "construction/code-generation/code-generation-questions.md",
      promptSha256: "b".repeat(64),
      sourceFloor: "c".repeat(64),
      markerRevision: offer?.markerRevision ?? 0,
      options: offer?.options ?? ["", ""],
      requireExactOptionLabels: true,
      hashedOptionLabels: true,
    });

    const recoveredChallenge = recoverLegacyCapability(installed, envA);
    expect(recoveredChallenge.legacy_plan_approval_choices?.approve).toMatch(
      /^Approve Plan \[[0-9a-f]{12}\]$/,
    );
    const challengeA = readPlanApprovalChallenge(
      installed.dir,
      sessionA ?? "",
    );
    expect(challengeA?.challengeId).not.toBe("challenge-before-recovery");

    const envB = {
      VSCODE_IPC_HOOK: `t327-other-live-host:${installed.dir}`,
      VSCODE_PID: String(process.pid),
    };
    startLegacyKiroHost(installed, envB);
    const foreign = invoke(installed, "next", undefined, envB);
    expect(foreign.kind).toBe("error");
    expect(foreign.message).toContain("owned by another active IDE window");
    expect(foreign.legacy_plan_approval_choices).toBeUndefined();

    markKiroIdeLegacyPlanApprovalHost(installed.dir, sessionA ?? "", {
      VSCODE_IPC_HOOK: envA.VSCODE_IPC_HOOK,
      VSCODE_PID: "99999999",
    });
    const envC = {
      VSCODE_IPC_HOOK: `t327-restarted-host:${installed.dir}`,
      VSCODE_PID: String(process.pid),
    };
    const sessionC = kiroIdeLegacyPlanApprovalSessionId({
      ...process.env,
      ...envC,
    });
    expect(sessionC).not.toBeNull();
    startLegacyKiroHost(installed, envC);
    const takeover = recoverLegacyCapability(installed, envC);
    expect(takeover.legacy_plan_approval_choices?.approve).toMatch(
      /^Approve Plan \[[0-9a-f]{12}\]$/,
    );
    expect(
      readPlanApprovalChallenge(installed.dir, sessionC ?? "")?.session,
    ).toBe(sessionC ?? undefined);
    expect(
      readPlanApprovalChallenge(installed.dir, sessionA ?? ""),
    ).toBeNull();
  }, 30000);

  test("IPC-only legacy ownership blocks while live and permits human recovery after endpoint removal", () => {
    const installed = project("kiro-ide");
    const ipcA = join(installed.dir, "legacy-owner-a.ipc");
    const ipcB = join(installed.dir, "legacy-owner-b.ipc");
    writeFileSync(ipcA, "live\n");
    writeFileSync(ipcB, "live\n");
    const envA = {
      VSCODE_IPC_HOOK: ipcA,
      VSCODE_PID: "",
    };
    const envB = {
      VSCODE_IPC_HOOK: ipcB,
      VSCODE_PID: "",
    };
    startLegacyKiroHost(installed, envA);
    const directiveA = runToCodeGeneration(installed, envA);
    expect(directiveA.legacy_plan_approval_choices?.approve).toMatch(
      /^Approve Plan \[[0-9a-f]{12}\]$/,
    );

    startLegacyKiroHost(installed, envB);
    const blocked = invoke(installed, "next", undefined, envB);
    expect(blocked.kind).toBe("error");
    expect(blocked.message).toContain("owned by another active IDE window");

    rmSync(ipcA, { force: true });
    const takeover = recoverLegacyCapability(installed, envB);
    expect(takeover.legacy_plan_approval_choices?.approve).toMatch(
      /^Approve Plan \[[0-9a-f]{12}\]$/,
    );
  }, 30000);

  test("modern Kiro IDE receives no legacy capability from the same host variables", () => {
    const installed = project("kiro-ide");
    const directive = runToCodeGeneration(installed, {
      VSCODE_IPC_HOOK: `t327-modern:${installed.dir}`,
      VSCODE_PID: "315",
    });
    expect(directive).toMatchObject({
      kind: "run-stage",
      stage: "code-generation",
    });
    expect(directive.legacy_plan_approval_choices).toBeUndefined();
  }, 30000);
});
