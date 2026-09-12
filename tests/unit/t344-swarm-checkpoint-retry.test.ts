// covers: subcommand:aidlc-swarm:prepare, subcommand:aidlc-swarm:finalize,
// subcommand:aidlc-bolt:start, subcommand:aidlc-worktree:merge,
// subcommand:aidlc-bolt:swarm-checkpoint, function:validateCodeGenerationForkApproval,
// audit:SWARM_STARTED, audit:BOLT_STARTED

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  activeIntentUuid, artifactFilename, auditBlockField, boltSlugForUnit,
  findStageBySlug, latestMainWorkflowStageRunFloorForProject, readAuditShardEvents,
  readPlanApprovalReceipt, recordDir,
  setField, stateDigest, workspaceSourceFingerprint, workspaceSourceListing,
  writeActiveDirectiveMarker, writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approvalFingerprint, beginCodeGeneration, codeGenerationRecordDir,
  evaluateCodeGenerationApproval, renderTestingContract, resolveCodeGenerationAuthority,
  resolveTestingPosture, readCodeGenerationWorktreeSourceBaseline,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC, cleanupWorktreeFixture, resetAidlcEnv, seedAidlcMemory,
  runOrchestrateNext, seedBoltDagBatches, seededStateFile, setupWorktreeFixture,
} from "../harness/fixtures.ts";

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupWorktreeFixture(projects.pop()!);
}, 30_000);
const STAGE = "code-generation";

function tool(pd: string, file: string, args: string[], input?: unknown) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, file), ...args], {
    cwd: pd, env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
    stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function swarm(pd: string, args: string[]) {
  return tool(pd, "tools/aidlc-swarm.ts", [...args, "--project-dir", pd]);
}

function git(pd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: pd, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString().trim();
}

function wt(pd: string, unit = "alpha"): string {
  return join(pd, ".aidlc", "worktrees", `bolt-${boltSlugForUnit(unit)}`);
}

function publish(pd: string, units: string[]): void {
  writeActiveDirectiveMarker(pd, {
    kind: "invoke-swarm", stage: STAGE, units,
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
}

function plan(pd: string, unit: string, revision = "initial"): string {
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

function approvePlan(pd: string, unit: string, revision = "initial"): void {
  const questions = plan(pd, unit, revision);
  const session = `${unit}-${revision}`;
  appendAuditEntry("SESSION_STARTED", { Session: session, Source: "t344 fixture" }, pd);
  const identity = [
    "--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval",
    "--unit", unit, "--questions-file", questions, "--session", session,
  ];
  const decision = tool(pd, "tools/aidlc-log.ts", [
    "decision", ...identity, "--decision", `Approve ${revision}?`, "--options", "Approve Plan,Request Changes",
  ]);
  expect(decision.code, decision.err).toBe(0);
  const human = tool(pd, "hooks/aidlc-record-human-turn.ts", [], {
    hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Approve Plan",
  });
  expect(human.code, human.err).toBe(0);
  writeFileSync(questions, readFileSync(questions, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
  const answer = tool(pd, "tools/aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plan"]);
  expect(answer.code, answer.err).toBe(0);
}

function approveGroupedPlans(pd: string, units: string[], revision: string): void {
  const members = units.map((unit) => ({ unit, questionsFile: plan(pd, unit, revision) }));
  const file = join(recordDir(pd)!, "group-plan.json");
  writeFileSync(file, JSON.stringify({ batch: revision, units: members }));
  const identity = ["--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval",
    "--batch-file", file, "--session", revision];
  const decision = tool(pd, "tools/aidlc-log.ts", [
    "decision", ...identity, "--decision", "Approve these plans?", "--options", "Approve Plans,Request Changes",
  ]);
  expect(decision.code, decision.err).toBe(0);
  const human = tool(pd, "hooks/aidlc-record-human-turn.ts", [], {
    hook_event_name: "UserPromptSubmit", session_id: revision, prompt: "Approve Plans",
  });
  expect(human.code, human.err).toBe(0);
  for (const member of members) {
    writeFileSync(member.questionsFile, readFileSync(member.questionsFile, "utf-8")
      .replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
  }
  const answer = tool(pd, "tools/aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plans"]);
  expect(answer.code, answer.err).toBe(0);
}

function fixture(units = ["alpha"]): string {
  const pd = setupWorktreeFixture();
  projects.push(pd);
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
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
  publish(pd, units);
  for (const unit of units) plan(pd, unit);
  git(pd, ["add", "-A"]);
  git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "swarm fixture"]);
  for (const unit of units) approvePlan(pd, unit);
  return pd;
}

function prepare(pd: string, units = ["alpha"], resume = false) {
  return swarm(pd, ["prepare", "--batch", "1", "--units", units.join(","), "--base", "main", ...(resume ? ["--resume-existing"] : [])]);
}

function nextDirective(pd: string) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), pd, [], {
    cwd: pd, env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
  });
  expect(result.status, result.out).toBe(0);
  return result.directive!;
}

function interruptAfterBoltStart(pd: string, resume: boolean) {
  mkdirSync(join(pd, ".aidlc"), { recursive: true });
  const driver = join(pd, ".aidlc", "interrupt-prepare.ts");
  // Isolated subprocess fault: real create/state/audit/runtime forks finish,
  // then their caller sees an interrupted start before bind or SWARM_STARTED.
  // No production failpoint, global module mock, or modified installation.
  writeFileSync(driver, `
import { mock } from "bun:test";
const childProcess = await import("node:child_process");
const realSpawn = childProcess.spawnSync;
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
const { main } = await import(${JSON.stringify(join(AIDLC_SRC, "tools", "aidlc-swarm.ts"))});
main(process.argv.slice(2));
`);
  const result = Bun.spawnSync([process.execPath, driver, "prepare", "--project-dir", pd,
    "--batch", "1", "--units", "alpha", "--base", "main", ...(resume ? ["--resume-existing"] : [])], {
    cwd: pd, env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function completeOld(pd: string, units = ["alpha"]): void {
  const prepared = prepare(pd, units);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  for (const unit of units) {
    const completed = tool(pd, "tools/aidlc-bolt.ts", [
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

function reject(pd: string, unit = "alpha"): void {
  appendAuditEntry("HUMAN_TURN", { Source: "t344 checkpoint choice" }, pd);
  appendAuditEntry("GATE_REJECTED", {
    Stage: STAGE, "Gate Stages": STAGE, Checkpoint: "swarm-batch",
    "Batch number": "1", Unit: unit, Units: unit,
    Intent: activeIntentUuid(pd)!, "Run floor": latestMainWorkflowStageRunFloorForProject(pd, STAGE),
    "User Input": "Request Changes", Reason: "Please revise this unit", Feedback: "Please revise this unit",
  }, pd);
  publish(pd, [unit]);
}

function starts(pd: string, unit = "alpha") {
  return readAuditShardEvents(pd).filter((row) => row.event === "BOLT_STARTED" &&
    auditBlockField(row.block, "Bolt slug") === boltSlugForUnit(unit));
}

function reviewRevisedSource(pd: string, unit = "alpha"): void {
  const child = wt(pd, unit);
  const dir = codeGenerationRecordDir(child, unit);
  writeFileSync(join(dir, "source-manifest.json"), JSON.stringify({
    stage: STAGE, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
  }));
  const planPath = join(dir, "code-generation-plan.md");
  writeFileSync(planPath, readFileSync(planPath, "utf-8").replace("- [ ] Implement", "- [x] Implement"));
  const args = [
    "review", "--stage", STAGE, "--unit", unit, "--reviewer", "aidlc-architecture-reviewer-agent",
    "--iteration", "1", "--project-dir", child,
  ];
  const request = tool(child, "tools/aidlc-log.ts", args);
  expect(request.code, `${request.out}\n${request.err}`).toBe(0);
  // Deterministic review fixture through the existing protected receipt path.
  appendFileSync(join(dir, "code-generation-plan.md"),
    "\n## Review\n\n**Verdict:** READY\n**Reviewer:** aidlc-architecture-reviewer-agent\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n");
  const receipt = tool(child, "tools/aidlc-log.ts", [...args, "--verdict", "READY"]);
  expect(receipt.code, `${receipt.out}\n${receipt.err}`).toBe(0);
}

describe("t344 explicit swarm checkpoint re-entry", () => {
  test.each(["checkpoints", "legacy autonomy"])("dirty approved parent preflight leaves no orphan for %s and commit then retry works", (policy) => {
    const pd = fixture();
    if (policy === "legacy autonomy") {
      let state = readFileSync(seededStateFile(pd), "utf-8");
      state = setField(state, "Construction Checkpoints", "disabled");
      state = setField(state, "Construction Autonomy Mode", "autonomous");
      writeFileSync(seededStateFile(pd), state);
      publish(pd, ["alpha"]);
    }
    writeFileSync(join(pd, "src", "skeleton.ts"), "export const skeleton = true;\n");
    approvePlan(pd, "alpha", "dirty-parent");
    const refused = prepare(pd);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("before creating worktrees");
    expect(refused.err).toMatch(/commit/i);
    expect(existsSync(wt(pd))).toBe(false);
    expect(starts(pd)).toHaveLength(0);
    git(pd, ["add", "src/skeleton.ts"]);
    git(pd, ["commit", "-qm", "approved skeleton baseline"]);
    const retried = prepare(pd);
    expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
    expect(readFileSync(join(wt(pd), "src", "skeleton.ts"), "utf-8")).toContain("skeleton = true");
    expect(evaluateCodeGenerationApproval(wt(pd), { unit: "alpha" }).ok).toBe(true);
  }, 60_000);

  test("interrupted resume after the real Bolt fork retries the same revision without losing its archive", () => {
    const pd = fixture();
    completeOld(pd);
    const child = wt(pd);
    const originalPlan = readFileSync(join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md"), "utf-8");
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const failed = interruptAfterBoltStart(pd, true);
    expect(failed.code, `${failed.out}\n${failed.err}`).toBe(2);
    expect(failed.out).toContain("resume Bolt start failed");
    const archive = JSON.parse(failed.out).units[0].archive_path;
    expect(readFileSync(join(archive, "plan.md"), "utf-8")).toBe(originalPlan);
    expect(nextDirective(pd)).toMatchObject({
      kind: "invoke-swarm", units: ["alpha"], resume_existing: true,
    });
    const recovered = prepare(pd, ["alpha"], true);
    expect(recovered.code, `${recovered.out}\n${recovered.err}`).toBe(0);
    expect(readFileSync(join(archive, "plan.md"), "utf-8")).toBe(originalPlan);
    expect(readdirSync(join(archive, "attempts")).length).toBeGreaterThan(0);
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(true);
    const continued = nextDirective(pd);
    expect(continued).toMatchObject({ kind: "invoke-swarm", units: ["alpha"] });
    expect(continued).not.toHaveProperty("resume_existing");
    const startedCount = starts(pd).length;
    expect(prepare(pd, ["alpha"], true).code).toBe(0);
    expect(starts(pd)).toHaveLength(startedCount);
  }, 60_000);

  test("failed initial fork preserves source and releases registration so discard then retry works", () => {
    const pd = fixture();
    const failed = interruptAfterBoltStart(pd, false);
    expect(failed.code, `${failed.out}\n${failed.err}`).toBe(2);
    expect(failed.out).toContain("aidlc-worktree discard");
    expect(readFileSync(join(wt(pd), "src", "alpha.ts"), "utf-8")).toContain("alpha = 1");
    expect(readFileSync(seededStateFile(pd), "utf-8")).toContain("**Bolt Refs**: [empty list]");
    const discarded = tool(pd, "tools/aidlc-worktree.ts", ["discard", "--slug", "alpha", "--project-dir", pd]);
    expect(discarded.code, discarded.err).toBe(0);
    const retried = prepare(pd);
    expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
  }, 60_000);

  test("an earlier stage's checkpoint rejection does not block fresh prepare or finalize", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    const discarded = tool(pd, "tools/aidlc-worktree.ts", ["discard", "--slug", "alpha", "--project-dir", pd]);
    expect(discarded.code, discarded.err).toBe(0);
    const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
    publish(pd, ["alpha"]);
    approvePlan(pd, "alpha", "new-stage");
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    writeFileSync(join(wt(pd), "src", "alpha.ts"), "export const alpha = 3;\n");
    reviewRevisedSource(pd);
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha",
      "--claimed", "alpha", "--check-cmd", "git diff --check"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
  }, 60_000);

  test.each(["individual", "grouped"])("native source landing and batch Request Changes can revise work with %s Plan Approval", (approvalMode) => {
    const units = approvalMode === "grouped" ? ["alpha", "beta"] : ["alpha"];
    const pd = fixture(units);
    if (approvalMode === "grouped") approveGroupedPlans(pd, units, "initial-group");
    const initial = prepare(pd, units);
    expect(initial.code, `${initial.out}\n${initial.err}`).toBe(0);
    const finalizeAndLand = (value: number) => {
      for (const unit of units) {
        writeFileSync(join(wt(pd, unit), "src", `${unit}.ts`), `export const ${unit} = ${value};\n`);
        reviewRevisedSource(pd, unit);
      }
      const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", units.join(","),
        "--claimed", units.join(","), "--check-cmd", "git diff --check"]);
      expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
      for (const unit of units) {
      const merged = tool(pd, "tools/aidlc-worktree.ts", [
        "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
      ]);
      expect(merged.code, `${merged.out}\n${merged.err}`).toBe(0);
      expect(existsSync(wt(pd, unit))).toBe(false);
      expect(readFileSync(join(pd, "src", `${unit}.ts`), "utf-8")).toContain(`${unit} = ${value}`);
      }
    };
    finalizeAndLand(2);
    const next = () => {
      const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), pd, [], {
        cwd: pd, env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
    const checkpoint = next();
    expect(checkpoint.code, checkpoint.err).toBe(0);
    expect(JSON.parse(checkpoint.out).swarm_checkpoint, checkpoint.out).toBeTruthy();
    if (approvalMode === "grouped") {
      for (const unit of units) {
        const approval = evaluateCodeGenerationApproval(pd, { unit });
        expect(approval.ok, approval.reason).toBe(true);
      }
    }
    appendAuditEntry("HUMAN_TURN", { Source: "t344 native checkpoint choice" }, pd);
    const rejected = tool(pd, "tools/aidlc-bolt.ts", [
      "swarm-checkpoint", "--action", "reject", "--batch", "1", "--units", units.join(","),
      "--user-input", "Request Changes", "--reason", "Please revise alpha", "--project-dir", pd,
    ]);
    expect(rejected.code, `${rejected.out}\n${rejected.err}`).toBe(0);
    const revision = next();
    expect(revision.code, revision.err).toBe(0);
    expect(JSON.parse(revision.out)).toMatchObject({ kind: "invoke-swarm", units, resume_existing: true });
    if (approvalMode === "grouped") approveGroupedPlans(pd, units, "landed-revision");
    else approvePlan(pd, "alpha", "landed-revision");
    const prepared = prepare(pd, units, true);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    expect(JSON.parse(prepared.out).units[0].resumed).toBe(true);
    expect(readFileSync(join(wt(pd), "src", "alpha.ts"), "utf-8")).toContain("alpha = 2");
    finalizeAndLand(3);
    const afterRevision = next();
    expect(afterRevision.code, afterRevision.err).toBe(0);
    expect(JSON.parse(afterRevision.out).swarm_checkpoint, afterRevision.out).toBeTruthy();
    appendAuditEntry("HUMAN_TURN", { Source: "t344 native checkpoint approve" }, pd);
    const approved = tool(pd, "tools/aidlc-bolt.ts", [
      "swarm-checkpoint", "--action", "approve", "--batch", "1", "--units", units.join(","),
      "--user-input", "Approve", "--project-dir", pd,
    ]);
    expect(approved.code, `${approved.out}\n${approved.err}`).toBe(0);
  }, 90_000);

  test.each(["initial batch", "prepared checkpoint revision"])("partial native landing continues the preserved worker and grouped receipt for %s", (phase) => {
    const units = ["alpha", "beta"];
    const pd = fixture(units);
    approveGroupedPlans(pd, units, "partial-native-group");
    const prepared = prepare(pd, units);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const land = (unit: string) => tool(pd, "tools/aidlc-worktree.ts", [
      "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
    ]);
    const next = () => nextDirective(pd);
    const isRevision = phase === "prepared checkpoint revision";
    if (isRevision) {
      for (const unit of units) {
        writeFileSync(join(wt(pd, unit), "src", `${unit}.ts`), `export const ${unit} = 2;\n`);
        reviewRevisedSource(pd, unit);
      }
      const completed = swarm(pd, ["finalize", "--batch", "1", "--units", units.join(","),
        "--claimed", units.join(","), "--check-cmd", "git diff --check"]);
      expect(completed.code, `${completed.out}\n${completed.err}`).toBe(0);
      for (const unit of units) {
        const merged = land(unit);
        expect(merged.code, `${merged.out}\n${merged.err}`).toBe(0);
        expect(existsSync(wt(pd, unit))).toBe(false);
      }
      expect(next()).toMatchObject({
        kind: "run-stage", swarm_checkpoint: { batch: 1, units, ready: true, approved: false },
      });
      appendAuditEntry("HUMAN_TURN", { Source: "t344 partial revision Request Changes" }, pd);
      const rejected = tool(pd, "tools/aidlc-bolt.ts", [
        "swarm-checkpoint", "--action", "reject", "--batch", "1", "--units", units.join(","),
        "--user-input", "Request Changes", "--reason", "Please revise both units", "--project-dir", pd,
      ]);
      expect(rejected.code, `${rejected.out}\n${rejected.err}`).toBe(0);
      expect(next()).toMatchObject({ kind: "invoke-swarm", units, resume_existing: true });
      approveGroupedPlans(pd, units, "partial-native-revision");
      // Plan Approval alone does not finish revision preparation.
      expect(next()).toMatchObject({ kind: "invoke-swarm", units, resume_existing: true });
      const revision = prepare(pd, units, true);
      expect(revision.code, `${revision.out}\n${revision.err}`).toBe(0);
      expect(JSON.parse(revision.out).units).toMatchObject([
        { unit: "alpha", resumed: true }, { unit: "beta", resumed: true },
      ]);
    }
    const beta = wt(pd, "beta");
    const authority = resolveCodeGenerationAuthority(beta, { unit: "beta" });
    const key = {
      targetId: authority.targetId, runFloor: authority.runFloor,
      fingerprint: evaluateCodeGenerationApproval(beta, { unit: "beta" }).approvalFingerprint!,
    };
    const parentReceipt = readPlanApprovalReceipt(pd, key)!;
    const workerReceipt = readPlanApprovalReceipt(beta, key)!;
    expect(workerReceipt.batch!.members.map((member) => member.unit)).toEqual(units);
    expect(workerReceipt.delegation!.parentReceiptSha256).toBeTruthy();
    const betaStarts = starts(pd, "beta").length;
    const unchangedAuthority = () => {
      expect(readPlanApprovalReceipt(pd, key)).toEqual(parentReceipt);
      expect(readPlanApprovalReceipt(beta, key)).toEqual(workerReceipt);
      expect(starts(pd, "beta")).toHaveLength(betaStarts);
    };
    const preparedDirective = next();
    expect(preparedDirective).toMatchObject({ kind: "invoke-swarm", units });
    expect(preparedDirective).not.toHaveProperty("resume_existing");
    unchangedAuthority();
    // Pending work predates the other member's source merge and must survive
    // resume in the existing worktree, without another prepare or approval.
    const alphaValue = isRevision ? 4 : 2;
    writeFileSync(join(beta, "src", "beta.ts"), "export const beta = 3;\n");
    writeFileSync(join(wt(pd, "alpha"), "src", "alpha.ts"), `export const alpha = ${alphaValue};\n`);
    reviewRevisedSource(pd, "alpha");
    const alpha = swarm(pd, ["finalize", "--batch", "1", "--units", units.join(","),
      "--claimed", "alpha", "--check-cmd", "git diff --check"]);
    expect(alpha.code, `${alpha.out}\n${alpha.err}`).toBe(2);
    expect(JSON.parse(alpha.out)).toMatchObject({
      converged: 1, failed: 1, merge_failures: [],
      units: [
        { unit: "alpha", status: "converged" },
        { unit: "beta", status: "failed" },
      ],
    });
    expect(readAuditShardEvents(pd).some((row) => row.event === "BOLT_FAILED" &&
      auditBlockField(row.block, "Bolt slug") === boltSlugForUnit("beta"))).toBe(true);
    const landedAlpha = land("alpha");
    expect(landedAlpha.code, `${landedAlpha.out}\n${landedAlpha.err}`).toBe(0);
    expect(existsSync(wt(pd, "alpha"))).toBe(false);
    expect(readFileSync(join(pd, "src", "alpha.ts"), "utf-8")).toContain(`alpha = ${alphaValue}`);
    for (let repeat = 0; repeat < 2; repeat++) {
      const pending = next();
      expect(pending).toMatchObject({ kind: "invoke-swarm", units: ["beta"] });
      expect(pending).not.toHaveProperty("resume_existing");
      unchangedAuthority();
    }
    const parentApproval = evaluateCodeGenerationApproval(pd, { unit: "beta" });
    expect(parentApproval.ok, parentApproval.reason).toBe(true);
    const approval = evaluateCodeGenerationApproval(beta, { unit: "beta" });
    expect(approval.ok, approval.reason).toBe(true);
    expect(readCodeGenerationWorktreeSourceBaseline(beta, "beta")).not.toBeNull();
    const began = tool(beta, "tools/aidlc-testing-posture.ts", ["begin", "--unit", "beta"]);
    expect(began.code, `${began.out}\n${began.err}`).toBe(0);
    unchangedAuthority();
    expect(readFileSync(join(beta, "src", "beta.ts"), "utf-8")).toContain("beta = 3");
    const executable = process.platform === "win32"
      ? `"${process.execPath.replaceAll('"', '""')}"`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const check = `${executable} -e "if (!require('fs').readFileSync('src/beta.ts','utf8').includes('beta = 3')) process.exit(1)"`;
    const ran = swarm(pd, ["check", "beta", "--check-cmd", check]);
    expect(ran.code, `${ran.out}\n${ran.err}`).toBe(0);
    reviewRevisedSource(pd, "beta");
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "beta",
      "--claimed", "beta", "--check-cmd", check]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    unchangedAuthority();
    const landedBeta = land("beta");
    expect(landedBeta.code, `${landedBeta.out}\n${landedBeta.err}`).toBe(0);
    expect(existsSync(beta)).toBe(false);
    expect(readFileSync(join(pd, "src", "alpha.ts"), "utf-8")).toContain(`alpha = ${alphaValue}`);
    expect(readFileSync(join(pd, "src", "beta.ts"), "utf-8")).toContain("beta = 3");
    expect(next()).toMatchObject({
      kind: "run-stage", swarm_checkpoint: { batch: 1, units, ready: true, approved: false },
    });
    expect(readPlanApprovalReceipt(pd, key)).toEqual(parentReceipt);
    for (const unit of units) {
      const current = evaluateCodeGenerationApproval(pd, { unit });
      expect(current.ok, current.reason).toBe(true);
    }
    appendAuditEntry("HUMAN_TURN", { Source: "t344 partial batch checkpoint approval" }, pd);
    const approved = tool(pd, "tools/aidlc-bolt.ts", [
      "swarm-checkpoint", "--action", "approve", "--batch", "1", "--units", units.join(","),
      "--user-input", "Approve", "--project-dir", pd,
    ]);
    expect(approved.code, `${approved.out}\n${approved.err}`).toBe(0);
    expect(JSON.parse(approved.out).approved).toBe(true);
  }, 120_000);

  test("resumes the current rejected Unit with fresh authority and preserves source, history, and peers", () => {
    const pd = fixture(["alpha", "beta"]);
    completeOld(pd, ["alpha", "beta"]);
    const child = wt(pd);
    const planPath = join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md");
    const oldPlan = readFileSync(planPath, "utf-8");
    const oldState = readFileSync(seededStateFile(child), "utf-8");
    const head = git(child, ["rev-parse", "HEAD"]);
    writeFileSync(join(child, "src", "alpha.ts"), "export const alpha = 2; // preserved work\n");
    // The retained source is actually covered by the newly reviewed baseline.
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2; // preserved work\n");
    writeFileSync(join(child, ".aidlc", "private-note.txt"), "unfinished user notes\n");
    const peerState = readFileSync(seededStateFile(wt(pd, "beta")), "utf-8");
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const resumed = prepare(pd, ["alpha"], true);
    expect(resumed.code, `${resumed.out}\n${resumed.err}`).toBe(0);
    const unit = JSON.parse(resumed.out).units[0];
    expect(unit.resumed).toBe(true);
    expect(unit.worktree_path).toBe(child);
    expect(readFileSync(join(unit.archive_path, "plan.md"), "utf-8")).toBe(oldPlan);
    expect(readFileSync(join(unit.archive_path, "state.md"), "utf-8")).toBe(oldState);
    expect(readdirSync(join(unit.archive_path, "audit")).length).toBeGreaterThan(0);
    expect(readFileSync(join(child, "src", "alpha.ts"), "utf-8")).toContain("preserved work");
    expect(readFileSync(join(child, ".aidlc", "private-note.txt"), "utf-8")).toContain("unfinished user notes");
    expect(git(child, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(seededStateFile(wt(pd, "beta")), "utf-8")).toBe(peerState);
    expect(starts(pd)).toHaveLength(2);
    expect(starts(pd, "beta")).toHaveLength(1);
    expect(readFileSync(planPath, "utf-8")).toBe(readFileSync(join(codeGenerationRecordDir(pd, "alpha"), "code-generation-plan.md"), "utf-8"));
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(true);
    expect(() => beginCodeGeneration(child, { unit: "alpha" })).not.toThrow();
    const repeat = prepare(pd, ["alpha"], true);
    expect(repeat.code, repeat.err).toBe(0);
    expect(starts(pd)).toHaveLength(2);
  }, 60_000);

  test("ordinary prepare creates worktrees and still refuses an existing directory", () => {
    const pd = fixture();
    const first = prepare(pd);
    expect(first.code, `${first.out}\n${first.err}`).toBe(0);
    expect(JSON.parse(first.out).units[0].worktree_path).toBe(wt(pd));
    const second = prepare(pd);
    expect(second.code).toBe(2);
    expect(second.out).toContain("already exists");
    expect(starts(pd)).toHaveLength(1);
  }, 60_000);

  test("no checkpoint rejection means no implicit reuse", () => {
    const pd = fixture();
    completeOld(pd);
    const before = readFileSync(seededStateFile(wt(pd)), "utf-8");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("Request Changes");
    expect(readFileSync(seededStateFile(wt(pd)), "utf-8")).toBe(before);
    expect(starts(pd)).toHaveLength(1);
  }, 60_000);

  test("rejection requires a fresh human-backed Plan Approval before any re-fork", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    const before = readFileSync(seededStateFile(wt(pd)), "utf-8");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("approved Code Generation plan");
    expect(readFileSync(seededStateFile(wt(pd)), "utf-8")).toBe(before);
    expect(starts(pd)).toHaveLength(1);
  }, 60_000);

  test("unreviewed dirty source is refused before any re-fork and remains intact", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const child = wt(pd);
    const source = join(child, "src", "alpha.ts");
    writeFileSync(source, "export const alpha = 99; // private WIP\n");
    writeFileSync(join(child, ".aidlc", "private-note.txt"), "keep this note\n");
    const beforeState = readFileSync(seededStateFile(child), "utf-8");
    const beforePlan = readFileSync(join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md"), "utf-8");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("dirty or untracked source");
    expect(readFileSync(source, "utf-8")).toContain("private WIP");
    expect(readFileSync(join(child, ".aidlc", "private-note.txt"), "utf-8")).toBe("keep this note\n");
    expect(readFileSync(seededStateFile(child), "utf-8")).toBe(beforeState);
    expect(readFileSync(join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md"), "utf-8")).toBe(beforePlan);
    expect(existsSync(join(recordDir(child)!, ".aidlc-swarm-resumes"))).toBe(false);
    expect(starts(pd)).toHaveLength(1);
  }, 60_000);

  test("a clean worktree fast-forwards to approved parent source and retains ignored notes", () => {
    const pd = fixture(["alpha", "beta"]);
    completeOld(pd, ["alpha", "beta"]);
    const child = wt(pd);
    const oldHead = git(child, ["rev-parse", "HEAD"]);
    writeFileSync(join(child, ".aidlc", "private-note.txt"), "keep this note\n");
    writeFileSync(join(pd, "src", "beta.ts"), "export const beta = 2;\n");
    git(pd, ["add", "src/beta.ts"]);
    git(pd, ["commit", "-qm", "approved peer source"]);
    const parentHead = git(pd, ["rev-parse", "HEAD"]);
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(git(child, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(git(child, ["merge-base", "--is-ancestor", oldHead, parentHead])).toBe("");
    expect(readFileSync(join(child, "src", "beta.ts"), "utf-8")).toBe("export const beta = 2;\n");
    expect(readFileSync(join(child, ".aidlc", "private-note.txt"), "utf-8")).toBe("keep this note\n");
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(true);
    // The synchronized peer is baseline source, not a write attributed to alpha.
    writeFileSync(join(child, "src", "alpha.ts"), "export const alpha = 3;\n");
    reviewRevisedSource(pd);
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha", "--check-cmd", "git diff --quiet -- src/beta.ts"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
  }, 60_000);

  test("initial prepare retains grouped parent authority and a changed peer plan invalidates the child", () => {
    const pd = fixture(["alpha", "beta"]);
    const units = ["alpha", "beta"].map((unit) => ({ unit, questionsFile: plan(pd, unit, "group") }));
    const file = join(recordDir(pd)!, "group-plan.json");
    writeFileSync(file, JSON.stringify({ batch: "group", units }));
    const identity = ["--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval", "--batch-file", file, "--session", "group"];
    const decision = tool(pd, "tools/aidlc-log.ts", [
      "decision", ...identity, "--decision", "Approve both plans?", "--options", "Approve Plans,Request Changes",
    ]);
    expect(decision.code, decision.err).toBe(0);
    expect(tool(pd, "hooks/aidlc-record-human-turn.ts", [], {
      hook_event_name: "UserPromptSubmit", session_id: "group", prompt: "Approve Plans",
    }).code).toBe(0);
    for (const entry of units) {
      writeFileSync(entry.questionsFile, readFileSync(entry.questionsFile, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
    }
    const answer = tool(pd, "tools/aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plans"]);
    expect(answer.code, answer.err).toBe(0);
    const result = prepare(pd, ["alpha", "beta"]);
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    const child = wt(pd);
    const approval = evaluateCodeGenerationApproval(child, { unit: "alpha" });
    expect(approval.ok, approval.reason).toBe(true);
    const authority = resolveCodeGenerationAuthority(child, { unit: "alpha" });
    const receipt = readPlanApprovalReceipt(child, {
      targetId: authority.targetId, runFloor: authority.runFloor, fingerprint: approval.approvalFingerprint!,
    })!;
    expect(receipt.batch!.members).toHaveLength(2);
    expect(receipt.delegation!.parentProjectDir).toBe(pd);
    const childPlan = join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md");
    const approvedPlan = readFileSync(childPlan, "utf-8");
    appendFileSync(childPlan, "\nUnapproved child plan change.\n");
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(false);
    expect(() => readCodeGenerationWorktreeSourceBaseline(child, "alpha")).toThrow("Delegated plan");
    writeFileSync(childPlan, approvedPlan);
    appendFileSync(join(codeGenerationRecordDir(pd, "beta"), "code-generation-plan.md"), "\nChanged reviewed peer plan.\n");
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(false);
  }, 60_000);

  test.each(["intentRecord", "swarmUnit", "swarmBatch", "repoSelector"])("refuses foreign %s provenance without changing files", (field) => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const file = join(wt(pd), ".aidlc", "worktree-meta.json");
    const meta = JSON.parse(readFileSync(file, "utf-8"));
    meta[field] = "foreign";
    writeFileSync(file, JSON.stringify(meta));
    const before = readFileSync(seededStateFile(wt(pd)), "utf-8");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("provenance");
    expect(readFileSync(seededStateFile(wt(pd)), "utf-8")).toBe(before);
    expect(starts(pd)).toHaveLength(1);
  }, 60_000);

  test("an old stage attempt cannot be relabeled by resume", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, pd);
    publish(pd, ["alpha"]);
    approvePlan(pd, "alpha", "new-attempt");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("current");
    expect(starts(pd)).toHaveLength(1);
  }, 60_000);

  test("finalize requires the resumed boundary, then checks and merges the revised work", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const executable = process.platform === "win32"
      ? `"${process.execPath.replaceAll('"', '""')}"`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const check = `${executable} -e "if (!require('fs').readFileSync('src/alpha.ts','utf8').includes('alpha = 3')) process.exit(1)"`;
    const args = ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha", "--check-cmd", check];
    const stale = swarm(pd, args);
    expect(stale.code).toBe(2);
    expect(stale.out).toContain("no stamped SWARM_STARTED");
    const resumed = prepare(pd, ["alpha"], true);
    expect(resumed.code, resumed.err).toBe(0);
    writeFileSync(join(wt(pd), "src", "alpha.ts"), "export const alpha = 3;\n");
    reviewRevisedSource(pd);
    const finalized = swarm(pd, args);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(JSON.parse(finalized.out).units[0].status).toBe("converged");
    const start = readAuditShardEvents(pd).filter((row) => row.event === "SWARM_STARTED").at(-1)!;
    expect(auditBlockField(start.block, "Resumed")).toBe("true");
    expect(JSON.parse(auditBlockField(start.block, "Resume revisions")!).alpha).toBeTruthy();
  }, 60_000);
});
