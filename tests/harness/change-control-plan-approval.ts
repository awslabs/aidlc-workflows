// Shared fixture for the t334 Plan Approval Guard Policy suites
// (tests/unit/t334-change-control-*.test.ts). The cases live in two files so
// no unit shard waits on one long file: as one file they ran 9 to 22 minutes
// on a Windows runner.

import {
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "./test-budget.ts";
import { expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  getField,
  GUARD_POLICY_FIELD,
  hooksHealthDir,
  readAuditShardEvents,
  sessionsDir,
  setGuardPolicyLine,
  setGuardsOffLine,
  setGuardsOnLine,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  codeGenerationRecordDir,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  seededRecordDir,
  setupIntegrationProject,
} from "./fixtures.ts";
import { testGuardEnvironment } from "./runner-profile.ts";

export const BUN = process.execPath;
export const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
export const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
export const HUMAN_TURN = join(AIDLC_SRC, "tools", "aidlc.ts");
export const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
export const projects: string[] = [];

/** Remove every project a suite created; each suite runs this once, after all its cases. */
export function cleanupChangeControlProjects(): void {
  for (const project of projects) cleanupTestProject(project);
}

export type Spawned = { code: number; stdout: string; stderr: string };

// Every hook records a swallowed error under the engine's hooks-health dir;
// read it all so a failing assertion can say why the hook fell back.
export function hookDrops(project: string): string {
  const dir = hooksHealthDir(project);
  if (!existsSync(dir)) return "(no hooks-health dir)";
  return readdirSync(dir)
    .map((name) => `${name}:\n${readFileSync(join(dir, name), "utf-8")}`)
    .join("\n");
}

export function runChangeControlTool(cmd: string[], project: string, stdin?: string, env: NodeJS.ProcessEnv = {}): Spawned {
  const result = Bun.spawnSync(cmd, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: project,
    // Real approvals and fence decisions must not pass via the runner's
    // synthetic-fixture bypasses or an inherited machine-wide off switch.
    env: {
      ...testGuardEnvironment(process.env, "production"),
      AIDLC_UNATTENDED: "0",
      CLAUDE_PROJECT_DIR: project,
      ...env,
    },
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
export function changeNotices(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  if (parsed === null || typeof parsed !== "object" || !("change_notices" in parsed)) return [];
  const notices = parsed.change_notices;
  if (!Array.isArray(notices) || !notices.every((entry) => typeof entry === "string")) {
    throw new Error(`change_notices is not a string array: ${stdout}`);
  }
  return notices;
}

export function acceptedRows(project: string) {
  return readAuditShardEvents(project).filter((entry) => entry.event === "CHANGE_ACCEPTED");
}

export type Mode = "strict" | "relaxed" | "off";

/** The one line the human hears when a relaxed or off policy carries source drift through. */
export function driftNotice(count: string, paths: string): string {
  return `${count} changed since this plan was approved: ${paths}. Carrying on. Say 'review the plan again' to reopen approval.`;
}

/** The one line the human hears when other code moved after they approved, on any policy. */
export function movedNotice(count: string, paths: string): string {
  return `${count} changed since this plan was approved: ${paths}. Building the code now.`;
}

/** A code-generation project at the plan step, on `mode`, with a git baseline.
 *  The fixture carries the retired `Change Control` line; the writer renames it. */
export function createProject(mode: Mode, planApprovalFence?: "on" | "off"): string {
  const project = setupIntegrationProject({ withState: "state-brownfield-feature.md" });
  projects.push(project);
  const statePath = join(seededRecordDir(project), "aidlc-state.md");
  let state = readFileSync(statePath, "utf-8")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace(
      /^- \[[ xSR?-]\] code-generation(\s+\S\s+)EXECUTE$/m,
      "- [-] code-generation$1EXECUTE",
    );
  state = setGuardPolicyLine(state, `${mode} (set by you)`);
  if (planApprovalFence === "off") state = setGuardsOffLine(state, ["plan-approval"]);
  if (planApprovalFence === "on") state = setGuardsOnLine(state, ["plan-approval"]);
  expect(getField(state, GUARD_POLICY_FIELD)).toBe(`${mode} (set by you)`);
  expect(state).not.toContain("- **Change Control**:");
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
    const run = Bun.spawnSync(["git", ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: project, stdout: "pipe", stderr: "pipe" });
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
export function presentPlan(project: string): string {
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
  const printed = runChangeControlTool([BUN, POSTURE, "fingerprint", "--stage-level", "--project-dir", project], project);
  expect(printed.code, printed.stderr).toBe(0);
  const tags = printed.stdout.trim().split("\n");
  expect(tags).toHaveLength(2);
  writeFileSync(
    questions,
    ["## Plan Approval", ...tags, "A. Approve Plan", "B. Request Changes", "[Answer]:", ""].join("\n"),
  );
  return questions;
}

export function identity(questions: string, session: string): string[] {
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

export function decide(project: string, questions: string, session: string): Spawned {
  return runChangeControlTool(
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

export function humanTurn(project: string, session: string): void {
  const human = runChangeControlTool(
    [BUN, HUMAN_TURN, "engine", "hook", "record-human-turn"],
    project,
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Approve Plan" }),
  );
  expect(human.code, human.stderr).toBe(0);
}

export function answer(project: string, questions: string, session: string): Spawned {
  writeFileSync(
    questions,
    readFileSync(questions, "utf-8").replace(/\[Answer\]:\s*$/, "[Answer]: Approve Plan"),
  );
  return runChangeControlTool(
    [BUN, LOG, "answer", ...identity(questions, session), "--details", "Approve Plan", "--project-dir", project],
    project,
  );
}

export function begin(project: string): Spawned {
  return runChangeControlTool([BUN, POSTURE, "begin", "--stage-level", "--project-dir", project], project);
}

export function brief(project: string): Spawned {
  return runChangeControlTool([BUN, POSTURE, "brief", "--stage-level", "--project-dir", project], project);
}

export function approvalRows(project: string) {
  return readAuditShardEvents(project).filter((entry) => entry.event === "PLAN_APPROVAL_RECORDED");
}

/** Compare every receipt, including any newly minted one, with the actual human approval. */
export function receiptFiles(project: string): Record<string, string> {
  const dir = join(sessionsDir(project), "plan-approval");
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => /^receipt-.*\.json$/.test(name))
      .sort()
      .map((name) => [name, readFileSync(join(dir, name), "utf-8")]),
  );
}

export function plannedSourceTag(questions: string): string {
  const match = /^\[Planned Source\]: (\S+)$/m.exec(readFileSync(questions, "utf-8"));
  expect(match).not.toBeNull();
  return match![1];
}

export function startSession(project: string, session: string): void {
  appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
}


/** Every file under the intent record (source snapshots included) but the audit
 *  shards, which the caller compares by event, by relative path. */
export function recordFiles(project: string): Record<string, string> {
  const record = seededRecordDir(project);
  return Object.fromEntries(
    (readdirSync(record, { recursive: true }) as string[])
      .filter((name) => name.split(/[\\/]/)[0] !== "audit" && statSync(join(record, name)).isFile())
      .sort()
      .map((name) => [name, readFileSync(join(record, name), "utf-8")]),
  );
}

/** The audit rows other than the best-effort ERROR_LOGGED row a refused command writes. */
export function nonErrorEvents(project: string) {
  return readAuditShardEvents(project).filter((entry) => entry.event !== "ERROR_LOGGED");
}
