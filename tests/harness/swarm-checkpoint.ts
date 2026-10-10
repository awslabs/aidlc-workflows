// Shared fixture for the t344 swarm checkpoint suites
// (tests/unit/t344-swarm-checkpoint-*.test.ts). The cases live in two files
// so no unit shard waits on one long file: as one file they ran about 22
// minutes on a macOS runner.

import { expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  worktreePath, activeIntentUuid, artifactFilename, auditBlockField, boltSlugForUnit,
  findStageBySlug, latestMainWorkflowStageRunFloorForProject, readAuditShardEvents,
  readPlanApprovalReceipt, recordDir, stateDigest, workspaceSourceFingerprint,
  workspaceSourceListing, writeActiveDirectiveMarker, writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approvalFingerprint, codeGenerationRecordDir, evaluateCodeGenerationApproval,
  renderTestingContract, resolveCodeGenerationAuthority, resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  fixtureIntentId8, AIDLC_SRC, cleanupWorktreeFixture, resetAidlcEnv, seedAidlcMemory,
  runOrchestrateNext, seedBoltDagBatches, seededStateFile, setupWorktreeFixture,
} from "./fixtures.ts";
import {
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "./test-budget.ts";

// Before ISOLATED_GIT_ENV copies the environment below.
resetAidlcEnv();
export const projects: string[] = [];
export const submoduleRepos: string[] = [];

/** Remove the fixtures a case created; each suite runs this after every case. */
export function cleanupCheckpointFixtures(): void {
  while (projects.length) cleanupWorktreeFixture(projects.pop()!);
  while (submoduleRepos.length) rmSync(submoduleRepos.pop()!, { recursive: true, force: true });
}
export const STAGE = "code-generation";
export const CHECK = "git diff --check";
export const ISOLATED_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // Replacing the runner's global config must keep its Windows long-path
  // support, or deep fixture worktrees cannot be removed.
  ...(process.platform === "win32"
    ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "true" }
    : {}),
};

export function runCheckpointTool(pd: string, file: string, args: string[], input?: unknown) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, file), ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd, env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
    stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

export function recordCommand(pd: string, command: string): void {
  const identity = ["--stage", STAGE, "--checkpoint", "verification-command", "--command", command, "--session", "t344-command"];
  const decision = runCheckpointTool(pd, "tools/aidlc-log.ts", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"]);
  expect(decision.code, `${decision.out}\n${decision.err}`).toBe(0);
  humanChoice(pd, "Approve", "t344-command");
  const answer = runCheckpointTool(pd, "tools/aidlc-log.ts", ["answer", ...identity, "--details", "Approve"]);
  expect(answer.code, `${answer.out}\n${answer.err}`).toBe(0);
  const applied = runCheckpointTool(pd, "tools/aidlc-state.ts", ["set-construction-verification-command", command]);
  expect(applied.code, `${applied.out}\n${applied.err}`).toBe(0);
}

export function swarm(pd: string, args: string[]) {
  return runCheckpointTool(pd, "tools/aidlc-swarm.ts", [...args, "--project-dir", pd]);
}

export function git(pd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd, env: ISOLATED_GIT_ENV, stdout: "pipe", stderr: "pipe",
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString().trim();
}

export function wt(pd: string, unit = "alpha"): string {
  return worktreePath(pd, fixtureIntentId8(pd), boltSlugForUnit(unit));
}

export function publish(pd: string, units: string[]): void {
  writeActiveDirectiveMarker(pd, {
    kind: "invoke-swarm", stage: STAGE, units,
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
}

export function plan(pd: string, unit: string, revision = "initial"): string {
  const contract = resolveTestingPosture(pd);
  const authority = resolveCodeGenerationAuthority(pd, { unit });
  const dir = codeGenerationRecordDir(pd, unit);
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug(STAGE)!.produces ?? []) {
    const path = join(dir, artifactFilename(name));
    if (!existsSync(path)) writeFileSync(path, `# ${unit} ${name}\n`);
  }
  const body = `# ${revision} plan for ${unit}\n\n${renderTestingContract(contract)}\n## Steps\n- [ ] Implement ${revision}\n`;
  const instructions = `# Tests for ${unit}\n\nValidate the ${revision} behavior.\n`;
  writeFileSync(join(dir, "code-generation-plan.md"), body);
  writeFileSync(join(dir, "unit-test-instructions.md"), instructions);
  const questions = join(dir, "code-generation-questions.md");
  writeFileSync(questions, [
    "## Plan Approval",
    `[Approval Fingerprint]: ${approvalFingerprint(body, instructions, contract.contract_sha256, authority)}`,
    `[Planned Source]: ${workspaceSourceFingerprint(pd)}`,
    "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
  ].join("\n"));
  return questions;
}

export function approvePlan(pd: string, unit: string, revision = "initial"): void {
  const questions = plan(pd, unit, revision);
  const session = `${unit}-${revision}`;
  appendAuditEntry("SESSION_STARTED", { Session: session, Source: "t344 fixture" }, pd);
  const identity = [
    "--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval",
    "--unit", unit, "--questions-file", questions, "--session", session,
  ];
  const decision = runCheckpointTool(pd, "tools/aidlc-log.ts", [
    "decision", ...identity, "--decision", `Approve ${revision}?`, "--options", "Approve Plan,Request Changes",
  ]);
  expect(decision.code, decision.err).toBe(0);
  const human = runCheckpointTool(pd, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Approve Plan",
  });
  expect(human.code, human.err).toBe(0);
  writeFileSync(questions, readFileSync(questions, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
  const answer = runCheckpointTool(pd, "tools/aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plan"]);
  expect(answer.code, answer.err).toBe(0);
}

export function approveGroupedPlans(pd: string, units: string[], revision: string): void {
  const members = units.map((unit) => ({ unit, questionsFile: plan(pd, unit, revision) }));
  const file = join(recordDir(pd)!, "group-plan.json");
  writeFileSync(file, JSON.stringify({ batch: revision, units: members }));
  const identity = ["--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval",
    "--batch-file", "group-plan.json", "--session", revision];
  const decision = runCheckpointTool(pd, "tools/aidlc-log.ts", [
    "decision", ...identity, "--decision", "Approve these plans?", "--options", "Approve Plans,Request Changes",
  ]);
  expect(decision.code, decision.err).toBe(0);
  const human = runCheckpointTool(pd, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: revision, prompt: "Approve Plans",
  });
  expect(human.code, human.err).toBe(0);
  for (const member of members) {
    writeFileSync(member.questionsFile, readFileSync(member.questionsFile, "utf-8")
      .replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
  }
  const answer = runCheckpointTool(pd, "tools/aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plans"]);
  expect(answer.code, answer.err).toBe(0);
}

export const SUBMODULE_SOURCE = "export const lib = 1;\n";

// A committed, initialized submodule at vendor/sub, added before the fixture's
// source baseline so the approved plan covers it.
export function addSubmodule(pd: string): void {
  const sub = mkdtempSync(join(tmpdir(), "t344-submodule-"));
  submoduleRepos.push(sub);
  git(sub, ["init", "-q"]);
  writeFileSync(join(sub, "lib.ts"), SUBMODULE_SOURCE);
  git(sub, ["add", "-A"]);
  git(sub, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "submodule"]);
  // Tags may name a tree or a blob; landing must not mistake them for
  // work only the worktree has.
  git(sub, ["tag", "tree-tag", git(sub, ["rev-parse", "HEAD^{tree}"])]);
  git(sub, ["tag", "blob-tag", git(sub, ["rev-parse", "HEAD:lib.ts"])]);
  git(pd, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub"]);
}

export function fixture(units = ["alpha"], command = CHECK, withSubmodule = false): string {
  const pd = setupWorktreeFixture();
  projects.push(pd);
  // ISOLATED_GIT_ENV drops the global config, so this new repository gets no
  // long-path support from the runner. Nested Bolt worktrees exceed MAX_PATH.
  if (process.platform === "win32") git(pd, ["config", "core.longpaths", "true"]);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), `# State
## Project Information
- **Project**: Swarm resume
- **Scope**: feature
- **Project Type**: Greenfield
- **State Version**: 8
## Runtime State
- **Construction Checkpoints**: enabled
- **Construction Iteration**: stage-major
- **Construction Execution**: swarm
- **Construction Autonomy Mode**: gated
- **Skeleton Stance**: off
- **Unit Ownership**: solo
- **Review Override**: adversarial
- **Change Control**: strict
- **Bolt Refs**: [empty list]
- **Worktree Path**: -
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
## Current Status
- **Current Stage**: code-generation
- **Lifecycle Phase**: CONSTRUCTION
- **Status**: Running
`);
  writeFileSync(join(pd, ".gitignore"), [
    ".aidlc/", "aidlc/.aidlc-*", "aidlc/active-space",
    "aidlc/spaces/*/intents/active-intent", "aidlc/spaces/*/intents/*/audit/",
    "aidlc/spaces/*/intents/*/runtime-graph.json", "aidlc/spaces/*/intents/*/.aidlc-*", "",
  ].join("\n"));
  seedBoltDagBatches(pd, [units, ["later"]]);
  mkdirSync(join(pd, "src"), { recursive: true });
  for (const unit of units) writeFileSync(join(pd, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  if (withSubmodule) addSubmodule(pd);
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
  recordCommand(pd, command);
  publish(pd, units);
  for (const unit of units) plan(pd, unit);
  git(pd, ["add", "-A"]);
  git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "swarm fixture"]);
  for (const unit of units) approvePlan(pd, unit);
  return pd;
}

export function prepare(pd: string, units = ["alpha"], resume = false) {
  return swarm(pd, ["prepare", "--batch", "1", "--units", units.join(","), "--base", "main", ...(resume ? ["--resume-existing"] : [])]);
}

export function nextDirective(pd: string) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), pd, [], {
    cwd: pd, env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
  });
  expect(result.status, result.out).toBe(0);
  return result.directive!;
}

export function interruptAfterBoltStart(pd: string, resume: boolean) {
  mkdirSync(join(pd, ".aidlc"), { recursive: true });
  const driver = join(pd, ".aidlc", "interrupt-prepare.ts");
  // Isolated subprocess fault: real create/state/audit/runtime forks finish,
  // then their caller sees an interrupted start before bind or SWARM_STARTED.
  // No production failpoint, global module mock, or modified installation.
  writeFileSync(driver, `
import { mock } from "bun:test";
export const childProcess = await import("node:child_process");
export const realSpawn = childProcess.spawnSync;
mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync(command, args, options) {
    const result = realSpawn(command, args, options);
    if (result.status === 0 && args.some(arg => arg.endsWith("aidlc-bolt.ts")) &&
        args.includes("start")) {
      return { ...result, status: 1, stderr: "test interruption after real Bolt start" };
    }
    return result;
  },
}));
export const { main } = await import(${JSON.stringify(join(AIDLC_SRC, "tools", "aidlc-swarm.ts"))});
main(process.argv.slice(2));
`);
  const result = Bun.spawnSync([process.execPath, driver, "prepare", "--project-dir", pd,
    "--batch", "1", "--units", "alpha", "--base", "main", ...(resume ? ["--resume-existing"] : [])], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd, env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

export function completeOld(pd: string, units = ["alpha"]): void {
  const prepared = prepare(pd, units);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  for (const unit of units) {
    const completed = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
      "complete", "--merge", "--slug", boltSlugForUnit(unit), "--batch", "1", "--name", unit, "--project-dir", pd,
    ]);
    expect(completed.code, completed.err).toBe(0);
    // Fixture authority from the owning native emitter; actual resume uses
    // the real fork, state/audit merge, worktree metadata, and Plan Approval.
    appendAuditEntry("SWARM_UNIT_CONVERGED", {
      "Batch number": "1", "Unit name": unit, Stage: STAGE,
      "Run floor": latestMainWorkflowStageRunFloorForProject(pd, STAGE),
      "Source Fingerprint": workspaceSourceFingerprint(pd)!,
      "Source Commit": git(pd, ["rev-parse", "HEAD"]),
    }, pd);
  }
}

export function reject(pd: string, unit = "alpha"): void {
  appendAuditEntry("HUMAN_TURN", { Source: "t344 checkpoint choice" }, pd);
  appendAuditEntry("GATE_REJECTED", {
    Stage: STAGE, "Gate Stages": STAGE, Checkpoint: "swarm-batch",
    "Batch number": "1", Unit: unit, Units: unit,
    Intent: activeIntentUuid(pd)!, "Run floor": latestMainWorkflowStageRunFloorForProject(pd, STAGE),
    "User Input": "Request Changes", Reason: "Please revise this unit", Feedback: "Please revise this unit",
  }, pd);
  publish(pd, [unit]);
}

export function starts(pd: string, unit = "alpha") {
  return readAuditShardEvents(pd).filter((row) => row.event === "BOLT_STARTED" &&
    auditBlockField(row.block, "Bolt slug") === boltSlugForUnit(unit));
}

export function reviewRevisedSource(pd: string, unit = "alpha", writes = [`src/${unit}.ts`]): void {
  const child = wt(pd, unit);
  const dir = codeGenerationRecordDir(child, unit);
  writeFileSync(join(dir, "source-manifest.json"), JSON.stringify({
    stage: STAGE, unit, version: 1, writes: writes.map((path) => ({ path })),
  }));
  const planPath = join(dir, "code-generation-plan.md");
  writeFileSync(planPath, readFileSync(planPath, "utf-8").replace("- [ ] Implement", "- [x] Implement"));
  const args = [
    "review", "--stage", STAGE, "--unit", unit, "--reviewer", "aidlc-architecture-reviewer-agent",
    "--iteration", "1", "--project-dir", child,
  ];
  const request = runCheckpointTool(child, "tools/aidlc-log.ts", args);
  expect(request.code, `${request.out}\n${request.err}`).toBe(0);
  // Deterministic review fixture through the existing protected receipt path.
  appendFileSync(join(dir, "code-generation-plan.md"),
    "\n## Review\n\n**Verdict:** READY\n**Reviewer:** aidlc-architecture-reviewer-agent\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n");
  const receipt = runCheckpointTool(child, "tools/aidlc-log.ts", [...args, "--verdict", "READY"]);
  expect(receipt.code, `${receipt.out}\n${receipt.err}`).toBe(0);
}

export function humanChoice(pd: string, choice: string, session: string): void {
  const human = runCheckpointTool(pd, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: session, prompt: choice,
  });
  expect(human.code, `${human.out}\n${human.err}`).toBe(0);
}

export function checkpointChoice(pd: string, units: string[], choice: string): void {
  const asked = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "swarm-checkpoint", "--action", "ask", "--batch", "1", "--units", units.join(","),
    "--session", "t344-checkpoint", "--project-dir", pd,
  ]);
  expect(asked.code, `${asked.out}\n${asked.err}`).toBe(0);
  humanChoice(pd, choice, "t344-checkpoint");
}

export function writeUnitSource(pd: string, unit: string, value: number): void {
  writeFileSync(join(wt(pd, unit), "src", `${unit}.ts`), `export const ${unit} = ${value};\n`);
}

export function checkReviewFinalizeAndLand(pd: string, values: Record<string, number>): void {
  const units = Object.keys(values);
  for (const unit of units) {
    const checked = swarm(pd, ["check", unit]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, unit);
  }
  const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", units.join(","),
    "--claimed", units.join(",")]);
  expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
  for (const unit of units) {
    const merged = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
      "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
    ]);
    expect(merged.code, `${merged.out}\n${merged.err}`).toBe(0);
    expect(existsSync(wt(pd, unit))).toBe(false);
    expect(readFileSync(join(pd, "src", `${unit}.ts`), "utf-8")).toContain(`${unit} = ${values[unit]};`);
  }
}

export function nativeCheckpointRevision(units: string[], grouped: boolean): string {
  const pd = fixture(units);
  if (grouped) approveGroupedPlans(pd, units, "initial-discard-group");
  const initial = prepare(pd, units);
  expect(initial.code, `${initial.out}\n${initial.err}`).toBe(0);
  for (const unit of units) writeUnitSource(pd, unit, 2);
  checkReviewFinalizeAndLand(pd, Object.fromEntries(units.map((unit) => [unit, 2])));
  expect(nextDirective(pd)).toMatchObject({
    kind: "run-stage", swarm_checkpoint: { batch: 1, units, ready: true, approved: false },
  });
  checkpointChoice(pd, units, "Request Changes");
  const rejected = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "swarm-checkpoint", "--action", "reject", "--batch", "1", "--units", units.join(","),
    "--session", "t344-checkpoint",
    "--user-input", "Request Changes", "--reason", "Please revise the batch", "--project-dir", pd,
  ]);
  expect(rejected.code, `${rejected.out}\n${rejected.err}`).toBe(0);
  expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm", units, resume_existing: true });
  if (grouped) approveGroupedPlans(pd, units, "native-discard-group");
  else for (const unit of units) approvePlan(pd, unit, "native-discard-revision");
  const revision = prepare(pd, units, true);
  expect(revision.code, `${revision.out}\n${revision.err}`).toBe(0);
  for (const unit of units) expect(existsSync(wt(pd, unit))).toBe(true);
  return pd;
}

export function approvalSnapshot(pd: string, unit: string) {
  const child = wt(pd, unit);
  const authority = resolveCodeGenerationAuthority(child, { unit });
  const approval = evaluateCodeGenerationApproval(child, { unit });
  expect(approval.ok, approval.reason).toBe(true);
  if (!approval.approvalFingerprint) throw new Error("Prepared Unit lacks an approval fingerprint");
  const key = { targetId: authority.targetId, runFloor: authority.runFloor, fingerprint: approval.approvalFingerprint };
  const parentReceipt = readPlanApprovalReceipt(pd, key);
  const childReceipt = readPlanApprovalReceipt(child, key);
  if (!parentReceipt || !childReceipt?.delegation) throw new Error("Prepared Unit lacks native approval delegation");
  expect(childReceipt.delegation.baselineCommit, JSON.stringify(childReceipt.delegation))
    .toBe(git(child, ["rev-parse", "HEAD"]));
  return { key, parentReceipt, childReceipt };
}

export function discarded(pd: string, unit: string) {
  return readAuditShardEvents(pd).filter((row) => row.event === "WORKTREE_DISCARDED" &&
    auditBlockField(row.block, "Bolt slug") === boltSlugForUnit(unit));
}

export function retryAndDiscard(pd: string, unit: string, cycle = 1): void {
  const before = discarded(pd, unit).length;
  humanChoice(pd, "Retry", `${unit}-native-retry-${cycle}`);
  const aborted = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "abort", "--name", unit, "--slug", boltSlugForUnit(unit),
    "--reason", "Human Retry: restart this Unit's reviewer attempt", "--discard", "--project-dir", pd,
  ]);
  expect(aborted.code, `${aborted.out}\n${aborted.err}`).toBe(0);
  expect(existsSync(wt(pd, unit))).toBe(false);
  const rows = discarded(pd, unit);
  expect(rows).toHaveLength(before + 1);
  const row = rows.at(-1)!;
  for (const field of [
    "Approval Source Commit", "Approval Source Listing", "Approval Parent Receipt", "Approval Creation",
  ]) {
    expect(auditBlockField(row.block, field), row.block).not.toBeNull();
  }
}

export function approveNativeCheckpoint(pd: string, units: string[]): void {
  expect(nextDirective(pd)).toMatchObject({
    kind: "run-stage", swarm_checkpoint: { batch: 1, units, ready: true, approved: false },
  });
  checkpointChoice(pd, units, "Approve");
  const approved = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "swarm-checkpoint", "--action", "approve", "--batch", "1", "--units", units.join(","),
    "--session", "t344-checkpoint",
    "--user-input", "Approve", "--project-dir", pd,
  ]);
  expect(approved.code, `${approved.out}\n${approved.err}`).toBe(0);
  expect(JSON.parse(approved.out).approved).toBe(true);
}
