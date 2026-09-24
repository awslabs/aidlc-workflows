// covers: subcommand:aidlc-swarm:prepare, function:codeGenerationExecutionAllowed,
// function:bindCodeGenerationWorktreeApproval, hook:aidlc-plan-approval-guard,
// function:codeGenerationPlanApprovalFence,
// function:beginCodeGenerationBatch,
// audit:SWARM_STARTED, audit:BOLT_STARTED
//
// Unit-target consumers of F16: prepare and checkpoint resume must honor a
// lowered fence without certifying changed content as a new human approval.
// Uses the native worktree/approval fixture pattern from t344; no live agent.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  activeIntentUuid, artifactFilename, auditBlockField, boltSlugForUnit, findStageBySlug, getField,
  latestMainWorkflowStageRunFloorForProject, readAuditShardEvents,
  readPlanApprovalReceipt, setGuardPolicyLine, setGuardsOffLine, setGuardsOnLine, stateDigest, workspaceSourceFingerprint,
  workspaceSourceListing, worktreePath, writeActiveDirectiveMarker, writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approvalFingerprint, codeGenerationExecutionAllowed, codeGenerationRecordDir,
  evaluateCodeGenerationApproval, parseTestingContract, renderTestingContract,
  resolveCodeGenerationAuthority, resolveTestingPosture, resolveTestingPostureFromSections,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC, cleanupWorktreeFixture, fixtureIntentId8, resetAidlcEnv,
  seedAidlcMemory, seedBoltDagBatches, seededStateFile, setupWorktreeFixture,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupWorktreeFixture(projects.pop()!);
}, 30_000);

const STAGE = "code-generation";
const UNIT = "alpha";
const TARGET = { unit: UNIT };
const MODES = ["strict", "relaxed", "off"] as const;
const GROUP_UNITS = [UNIT, "beta"];
const ISOLATED_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function tool(pd: string, file: string, args: string[], input?: unknown, env: NodeJS.ProcessEnv = {}) {
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", file), ...args], {
    cwd: pd, env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd, ...env },
    stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function succeeded(result: ReturnType<typeof tool>): void {
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
}

function git(pd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: pd, env: ISOLATED_GIT_ENV, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function publish(pd: string, units = [UNIT]): void {
  writeActiveDirectiveMarker(pd, {
    kind: "invoke-swarm", stage: STAGE, units,
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
}

function child(pd: string, unit = UNIT): string {
  return worktreePath(pd, fixtureIntentId8(pd), boltSlugForUnit(unit));
}

function prepare(pd: string, resume = false, units = [UNIT], env: NodeJS.ProcessEnv = {}) {
  return tool(pd, "aidlc-swarm.ts", [
    "prepare", "--project-dir", pd, "--batch", "1", "--units", units.join(","), "--base", "main",
    ...(resume ? ["--resume-existing"] : []),
  ], undefined, env);
}

function starts(pd: string) {
  return readAuditShardEvents(pd).filter((row) => row.event === "BOLT_STARTED" &&
    auditBlockField(row.block, "Bolt slug") === boltSlugForUnit(UNIT));
}

function human(pd: string, session: string, prompt: string): void {
  succeeded(tool(pd, "aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: session, prompt,
  }));
}

function fixture(grouped = false): string {
  const pd = setupWorktreeFixture();
  const units = grouped ? GROUP_UNITS : [UNIT];
  projects.push(pd);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), `# State
## Project Information
- **Project**: Lowered guard swarm continuation
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
- **Guard Policy**: strict (set by you)
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
  for (const unit of units) {
    writeFileSync(join(pd, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  }
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);

  const command = "git diff --check";
  const commandIdentity = ["--stage", STAGE, "--checkpoint", "verification-command",
    "--command", command, "--session", "swarm-continuation-command"];
  succeeded(tool(pd, "aidlc-log.ts", ["decision", ...commandIdentity,
    "--decision", "Use this command?", "--options", "Approve,Request Changes"]));
  human(pd, "swarm-continuation-command", "Approve");
  succeeded(tool(pd, "aidlc-log.ts", ["answer", ...commandIdentity, "--details", "Approve"]));
  succeeded(tool(pd, "aidlc-state.ts", ["set-construction-verification-command", command]));
  publish(pd, units);

  const contract = resolveTestingPosture(pd);
  const members = units.map((unit) => {
    const authority = resolveCodeGenerationAuthority(pd, { unit });
    const dir = codeGenerationRecordDir(pd, unit);
    mkdirSync(dir, { recursive: true });
    for (const name of findStageBySlug(STAGE)!.produces ?? []) {
      writeFileSync(join(dir, artifactFilename(name)), `# ${unit} ${name}\n`);
    }
    const plan = `# Plan for ${unit}\n\n${renderTestingContract(contract)}\n## Steps\n- [ ] Implement ${unit}\n`;
    const instructions = `# Test instructions\n\nVerify ${unit} behavior.\n`;
    writeFileSync(join(dir, "code-generation-plan.md"), plan);
    writeFileSync(join(dir, "unit-test-instructions.md"), instructions);
    const questionsFile = join(dir, "code-generation-questions.md");
    writeFileSync(questionsFile, [
      "## Plan Approval",
      `[Approval Fingerprint]: ${approvalFingerprint(plan, instructions, contract.contract_sha256, authority)}`,
      `[Planned Source]: ${workspaceSourceFingerprint(pd)}`,
      "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
    ].join("\n"));
    return { unit, questionsFile };
  });
  const batchFile = "continuation-plan-batch.json";
  if (grouped) {
    writeFileSync(join(dirname(seededStateFile(pd)), batchFile), JSON.stringify({
      batch: "continuation",
      units: members.map(({ unit, questionsFile }) => ({ unit, questionsFile: relative(pd, questionsFile) })),
    }));
  }
  git(pd, ["add", "-A"]);
  git(pd, ["commit", "-qm", "swarm continuation fixture"]);
  const session = "swarm-continuation-plan";
  appendAuditEntry("SESSION_STARTED", { Session: session, Source: "swarm continuation fixture" }, pd);
  const choice = grouped ? "Approve Plans" : "Approve Plan";
  const identity = ["--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval",
    ...(grouped ? ["--batch-file", batchFile] : ["--unit", UNIT, "--questions-file", members[0].questionsFile]),
    "--session", session];
  succeeded(tool(pd, "aidlc-log.ts", ["decision", ...identity,
    "--decision", "Approve these plans?", "--options", `${choice},Request Changes`]));
  human(pd, session, choice);
  for (const { questionsFile } of members) {
    writeFileSync(questionsFile, readFileSync(questionsFile, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
  }
  succeeded(tool(pd, "aidlc-log.ts", ["answer", ...identity, "--details", choice]));
  return pd;
}

function completeAndReject(pd: string): void {
  succeeded(prepare(pd));
  succeeded(tool(pd, "aidlc-bolt.ts", ["complete", "--merge", "--slug", boltSlugForUnit(UNIT),
    "--batch", "1", "--name", UNIT, "--project-dir", pd]));
  // Same completed-Bolt fixture as t344: keep the real fork and merge, then
  // seed the checkpoint event being consumed, without running worker/reviewer agents.
  appendAuditEntry("SWARM_UNIT_CONVERGED", {
    "Batch number": "1", "Unit name": UNIT, Stage: STAGE,
    "Run floor": latestMainWorkflowStageRunFloorForProject(pd, STAGE),
    "Source Fingerprint": workspaceSourceFingerprint(pd)!,
    "Source Commit": git(pd, ["rev-parse", "HEAD"]),
  }, pd);
  appendAuditEntry("HUMAN_TURN", { Source: "swarm continuation checkpoint choice" }, pd);
  appendAuditEntry("GATE_REJECTED", {
    Stage: STAGE, "Gate Stages": STAGE, Checkpoint: "swarm-batch",
    "Batch number": "1", Unit: UNIT, Units: UNIT,
    Intent: activeIntentUuid(pd)!, "Run floor": latestMainWorkflowStageRunFloorForProject(pd, STAGE),
    "User Input": "Request Changes", Reason: "Revise alpha", Feedback: "Revise alpha",
  }, pd);
  publish(pd);
}

function approveReopenedAttempt(pd: string): void {
  const printed = tool(pd, "aidlc-testing-posture.ts", ["fingerprint", "--unit", UNIT, "--reapprove"]);
  succeeded(printed);
  const questions = join(codeGenerationRecordDir(pd, UNIT), "code-generation-questions.md");
  writeFileSync(questions, [
    "## Plan Approval", ...printed.out.trim().split("\n"),
    "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
  ].join("\n"));
  const session = "swarm-continuation-reopened-plan";
  appendAuditEntry("SESSION_STARTED", { Session: session, Source: "swarm continuation fixture" }, pd);
  const identity = ["--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval",
    "--unit", UNIT, "--questions-file", questions, "--session", session];
  succeeded(tool(pd, "aidlc-log.ts", ["decision", ...identity,
    "--decision", "Approve the plan for this reopened attempt?", "--options", "Approve Plan,Request Changes"]));
  human(pd, session, "Approve Plan");
  writeFileSync(questions, readFileSync(questions, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
  succeeded(tool(pd, "aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plan"]));
}

function revise(pd: string, contractChanged: boolean, unit = UNIT): void {
  const dir = codeGenerationRecordDir(pd, unit);
  const path = join(dir, "code-generation-plan.md");
  let plan = readFileSync(path, "utf-8").replace(`Implement ${unit}`, `Implement revised ${unit}`);
  if (contractChanged) {
    const contract = parseTestingContract(plan)!;
    const changed = resolveTestingPostureFromSections(
      { project: `Verify revised ${unit} twice.` },
      { scope: contract.scope, testStrategy: contract.test_strategy, projectType: contract.project_type },
    );
    expect(changed.contract_sha256).not.toBe(contract.contract_sha256);
    plan = plan.replace(renderTestingContract(contract), renderTestingContract(changed));
  }
  writeFileSync(path, plan);
  writeFileSync(join(dir, "unit-test-instructions.md"), `# Test instructions\n\nVerify revised ${unit} twice.\n`);
}

function approvalSnapshot(pd: string, unit = UNIT) {
  const approval = evaluateCodeGenerationApproval(pd, { unit });
  expect(approval.ok, approval.reason).toBe(true);
  const authority = resolveCodeGenerationAuthority(pd, { unit });
  const key = { targetId: authority.targetId, runFloor: authority.runFloor,
    fingerprint: approval.approvalFingerprint! };
  const receipt = readPlanApprovalReceipt(pd, key);
  if (!receipt) throw new Error(`Missing actual approval for ${unit}`);
  const questions = readFileSync(join(codeGenerationRecordDir(pd, unit), "code-generation-questions.md"), "utf-8");
  return { key, receipt, questions };
}

function checkWorkerCommands(worker: string, unit: string, allowed: boolean): void {
  const args = ["--unit", unit, "--project-dir", worker];
  const plan = readFileSync(join(codeGenerationRecordDir(worker, unit), "code-generation-plan.md"), "utf-8");
  const contract = parseTestingContract(plan);
  expect(contract).not.toBeNull();
  const verified = tool(worker, "aidlc-testing-posture.ts", ["verify", ...args]);
  expect(verified.code, `${verified.out}\n${verified.err}`).toBe(allowed ? 0 : 2);
  const verification = JSON.parse(verified.out);
  expect(verification).toMatchObject({
    ok: false, execution_allowed: allowed, approved: true,
    planExists: true, instructionsExist: true, contractHash: contract!.contract_sha256,
  });
  if (allowed) {
    expect(verification.reason).toContain("without a new approval");
    expect(verification.approval_reason).toMatch(/fingerprint|Testing Contract/i);
  } else {
    expect(verification.reason).toMatch(/fingerprint|Testing Contract/i);
  }
  const begun = tool(worker, "aidlc-testing-posture.ts", ["begin", ...args]);
  const brief = tool(worker, "aidlc-testing-posture.ts", ["brief", ...args]);
  if (allowed) {
    succeeded(begun);
    succeeded(brief);
    expect(JSON.parse(begun.out).status).toBe("generation");
    expect(brief.out).toContain(`AIDLC-UNIT: ${unit}\nAIDLC-TESTING-CONTRACT: ${contract!.contract_sha256}`);
    expect(brief.out).toContain(`Implement revised ${unit}`);
    expect(brief.out).toContain(`Verify revised ${unit} twice.`);
    expect(brief.out).toContain("## Current plan");
    expect(brief.out).toContain("## Current unit-test instructions");
    expect(brief.out).not.toContain("## Approved plan");
    expect(brief.out).not.toContain("## Approved unit-test instructions");
  } else {
    expect(begun.code, `${begun.out}\n${begun.err}`).not.toBe(0);
    expect(brief.code, `${brief.out}\n${brief.err}`).not.toBe(0);
    expect(brief.out).toBe("");
  }
}

function checkWorkerWriteHook(worker: string, unit: string, allowed: boolean): void {
  const source = join(worker, "src", `${unit}.ts`);
  const sourceBefore = readFileSync(source, "utf-8");
  const notices = () => readAuditShardEvents(worker).filter((row) => row.event === "GUARD_STOOD_ASIDE" &&
    auditBlockField(row.block, "Guard") === "plan-approval" && auditBlockField(row.block, "Tool") === "Write");
  const blocks = () => readAuditShardEvents(worker).filter((row) => row.event === "PLAN_APPROVAL_BLOCKED" &&
    auditBlockField(row.block, "Tool") === "Write");
  const noticesBefore = notices().length;
  const blocksBefore = blocks().length;
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")], {
    cwd: worker,
    env: {
      ...testGuardEnvironment(ISOLATED_GIT_ENV, "production"),
      AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: worker, CLAUDE_PROJECT_DIR: worker,
    },
    stdin: Buffer.from(JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: source, content: `export const ${unit} = 2;\n` },
      session_id: "swarm-continuation-worker", cwd: worker,
    })),
    stdout: "pipe", stderr: "pipe",
  });
  const out = result.stdout.toString();
  const err = result.stderr.toString();
  expect(result.exitCode, `${out}\n${err}`).toBe(allowed ? 0 : 2);
  expect(notices()).toHaveLength(noticesBefore + (allowed ? 1 : 0));
  expect(blocks()).toHaveLength(blocksBefore + (allowed ? 0 : 1));
  if (allowed) {
    expect(out).toContain("Continuing past the plan-approval check");
    expect(err).not.toContain('"ask_type":"guard-recovery"');
    const notice = notices().at(-1)!;
    expect(auditBlockField(notice.block, "Stage")).toBe(STAGE);
    expect(auditBlockField(notice.block, "Details")).toContain(`src/${unit}.ts`);
  } else {
    expect(err).toMatch(/fingerprint|Testing Contract/i);
    expect(out).not.toContain("Continuing past");
    expect(auditBlockField(blocks().at(-1)!.block, "Unit")).toBe(unit);
  }
  // Invoke only the pre-tool decision; no application source is actually written.
  expect(readFileSync(source, "utf-8")).toBe(sourceBefore);
}

describe("swarm consumes lowered plan-approval allowance", () => {
  for (const fault of ["later-target", "source-during-publication"] as const) {
    test.each(["relaxed", "off"] as const)(`a %s dispatch rolls back all new starts after ${fault} and revalidates its retry`, async (mode) => {
      const pd = fixture(true);
      const originals = GROUP_UNITS.map((unit) => approvalSnapshot(pd, unit));
      const approvals = readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED");
      const statePath = seededStateFile(pd);
      const state = setGuardPolicyLine(readFileSync(statePath, "utf-8"), `${mode} (set by you)`);
      writeFileSync(statePath, state);
      publish(pd, GROUP_UNITS);
      for (const unit of GROUP_UNITS) revise(pd, false, unit);
      const brief = () => GROUP_UNITS.map((unit) => {
        const result = tool(pd, "aidlc-testing-posture.ts", ["brief", "--unit", unit]);
        succeeded(result);
        return result.out;
      }).join("\n\n");
      const input = {
        hook_event_name: "PreToolUse", tool_name: "Task", cwd: pd,
        tool_input: { subagent_type: "aidlc-developer-agent", prompt: brief() },
      };
      const barrier = join(pd, ".aidlc", "f25-publication");
      mkdirSync(dirname(barrier), { recursive: true });
      const env = {
        ...testGuardEnvironment(ISOLATED_GIT_ENV, "production"),
        AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd,
      };
      const command = [process.execPath, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")];
      const processUnderTest = Bun.spawn(command, {
        cwd: pd,
        env: {
          ...env,
          AIDLC_TEST_PLAN_APPROVAL_PUBLICATION_BARRIER: barrier,
          AIDLC_TEST_PLAN_APPROVAL_PUBLICATION_TARGET: originals[fault === "later-target" ? 0 : 1].key.targetId,
        },
        stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe",
      });
      const stdout = new Response(processUnderTest.stdout).text();
      const stderr = new Response(processUnderTest.stderr).text();
      const instructionsPath = join(codeGenerationRecordDir(pd, "beta"), "unit-test-instructions.md");
      const instructions = readFileSync(instructionsPath, "utf-8");
      try {
        const deadline = Date.now() + 15_000;
        while (!existsSync(`${barrier}.published`) && Date.now() < deadline) await Bun.sleep(5);
        expect(existsSync(`${barrier}.published`)).toBe(true);
        expect(readPlanApprovalReceipt(pd, originals[0].key)?.status).toBe("generation");
        if (fault === "later-target") rmSync(instructionsPath);
        else {
          expect(readPlanApprovalReceipt(pd, originals[1].key)?.status).toBe("generation");
          writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2;\n");
        }
      } finally {
        writeFileSync(`${barrier}.release`, "release\n");
        await processUnderTest.exited;
      }
      expect(processUnderTest.exitCode, await stderr).toBe(2);
      expect(await stdout).not.toContain("Continuing past");
      for (const original of originals) {
        expect(readPlanApprovalReceipt(pd, original.key)).toEqual(original.receipt);
      }
      expect(readFileSync(statePath, "utf-8")).toBe(state);
      expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(approvals);

      writeFileSync(instructionsPath, instructions);
      writeFileSync(join(pd, "src", "retry.ts"), "export const retry = true;\n");
      const source = workspaceSourceFingerprint(pd);
      if (source === null) throw new Error("Retry source must be bindable");
      const retried = Bun.spawnSync(command, {
        cwd: pd, env, stdin: Buffer.from(JSON.stringify({ ...input, tool_input: { ...input.tool_input, prompt: brief() } })),
        stdout: "pipe", stderr: "pipe",
      });
      expect(retried.exitCode, retried.stderr.toString()).toBe(0);
      const changes = readAuditShardEvents(pd).filter((row) => row.event === "CHANGE_ACCEPTED");
      for (const [index, unit] of GROUP_UNITS.entries()) {
        const original = originals[index];
        expect(readPlanApprovalReceipt(pd, original.key)).toEqual({
          ...original.receipt, certifiedSourceSha256: source, status: "generation",
        });
        expect(changes.some((row) => auditBlockField(row.block, "Unit") === unit &&
          auditBlockField(row.block, "Current") === source)).toBe(true);
        expect(readFileSync(join(codeGenerationRecordDir(pd, unit), "code-generation-questions.md"), "utf-8"))
          .toBe(original.questions);
      }
      expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(approvals);
      expect(readFileSync(statePath, "utf-8")).toBe(state);
    });
  }

  test.each(["relaxed", "off"] as const)("a %s dispatch validates every target before starting any", (mode) => {
    const pd = fixture(true);
    const originals = GROUP_UNITS.map((unit) => approvalSnapshot(pd, unit));
    const statePath = seededStateFile(pd);
    const state = setGuardPolicyLine(readFileSync(statePath, "utf-8"), `${mode} (set by you)`);
    writeFileSync(statePath, state);
    publish(pd, GROUP_UNITS);
    const briefs = GROUP_UNITS.map((unit) => {
      const result = tool(pd, "aidlc-testing-posture.ts", ["brief", "--unit", unit]);
      succeeded(result);
      return result.out;
    });
    rmSync(join(codeGenerationRecordDir(pd, "beta"), "code-generation-plan.md"));
    expect(codeGenerationExecutionAllowed(pd, TARGET)).toBe(true);
    expect(codeGenerationExecutionAllowed(pd, { unit: "beta" })).toBe(false);
    const guarded = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")], {
      cwd: pd,
      env: {
        ...testGuardEnvironment(ISOLATED_GIT_ENV, "production"),
        AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd,
      },
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: "PreToolUse", tool_name: "Task", cwd: pd,
        tool_input: { subagent_type: "aidlc-developer-agent", prompt: briefs.join("\n\n") },
      })),
      stdout: "pipe", stderr: "pipe",
    });
    expect(guarded.exitCode, guarded.stderr.toString()).toBe(2);
    expect(guarded.stderr.toString()).toContain("CODE_GENERATION_EXECUTION_INELIGIBLE");
    for (const original of originals) {
      expect(readPlanApprovalReceipt(pd, original.key)).toEqual(original.receipt);
    }
    expect(readFileSync(statePath, "utf-8")).toBe(state);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "GUARD_STOOD_ASIDE")).toHaveLength(0);
  });

  test.each([...MODES])("prepare refuses an unbindable source under a lowered %s fence without changing approval", (mode) => {
    const pd = fixture();
    const original = approvalSnapshot(pd);
    const statePath = seededStateFile(pd);
    let state = setGuardPolicyLine(readFileSync(statePath, "utf-8"), `${mode} (set by you)`);
    if (mode === "strict") state = setGuardsOffLine(state, ["plan-approval"]);
    writeFileSync(statePath, state);
    publish(pd);
    revise(pd, true);
    const startsBefore = starts(pd).length;
    const unbindable = { AIDLC_TEST_SOURCE_MAX_ENTRIES: "1" };
    const result = prepare(pd, false, [UNIT], unbindable);
    expect(result.code, `${result.out}\n${result.err}`).not.toBe(0);
    expect(result.err).toContain("workspace source cannot be bound");
    expect(existsSync(child(pd))).toBe(false);
    expect(starts(pd)).toHaveLength(startsBefore);
    expect(readPlanApprovalReceipt(pd, original.key)).toEqual(original.receipt);
    expect(readFileSync(statePath, "utf-8")).toBe(state);
    expect(readFileSync(join(codeGenerationRecordDir(pd, UNIT), "code-generation-questions.md"), "utf-8"))
      .toBe(original.questions);
    // The source-walk fault is repaired; the lowered fence and original
    // approval now suffice, without another human response or fresh attempt.
    succeeded(prepare(pd));
    expect(evaluateCodeGenerationApproval(pd, TARGET).ok).toBe(false);
    expect(codeGenerationExecutionAllowed(pd, TARGET)).toBe(true);
    expect(readFileSync(statePath, "utf-8")).toContain(`**Guard Policy**: ${mode} (set by you)`);
  });

  test.each(["relaxed", "off"] as const)("prepare records combined content and source drift under %s", (mode) => {
    const pd = fixture();
    const original = approvalSnapshot(pd);
    const approvals = readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED");
    const state = seededStateFile(pd);
    writeFileSync(state, setGuardPolicyLine(readFileSync(state, "utf-8"), `${mode} (set by you)`));
    publish(pd);
    revise(pd, true);
    writeFileSync(join(pd, "src", `${UNIT}.ts`), `export const ${UNIT} = 2;\n`);
    // A native worker needs the selected source to be reproducible from its
    // commit; keep this independent of the existing dirty-source preflight.
    git(pd, ["add", "-A"]);
    git(pd, ["commit", "-qm", "revised execution source"]);
    const source = workspaceSourceFingerprint(pd);
    if (source === null) throw new Error("Combined-drift swarm source must be bindable");
    expect(source).not.toBe(original.receipt.certifiedSourceSha256);
    const result = prepare(pd);
    succeeded(result);
    expect(result.out).toContain(`src/${UNIT}.ts`);
    const changes = readAuditShardEvents(pd).filter((row) => row.event === "CHANGE_ACCEPTED" &&
      auditBlockField(row.block, "Checkpoint") === "plan-approval");
    expect(changes).toHaveLength(1);
    expect(auditBlockField(changes[0].block, "Changed")).toBe(`src/${UNIT}.ts`);
    expect(readPlanApprovalReceipt(pd, original.key)).toEqual({
      ...original.receipt, certifiedSourceSha256: source, status: "generation",
    });
    expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(approvals);
    for (const project of [pd, child(pd)]) {
      expect(evaluateCodeGenerationApproval(project, TARGET).ok).toBe(false);
      expect(codeGenerationExecutionAllowed(project, TARGET)).toBe(true);
      expect(readFileSync(join(codeGenerationRecordDir(project, UNIT), "code-generation-questions.md"), "utf-8"))
        .toBe(original.questions);
    }
    expect(readFileSync(join(child(pd), "src", `${UNIT}.ts`), "utf-8")).toBe(`export const ${UNIT} = 2;\n`);
  });

  for (const operation of ["prepare", "resume"] as const) {
    test.each([...MODES])(`${operation} preserves approval truth and native Unit provenance under %s`, (mode) => {
      const pd = fixture();
      if (operation === "resume") {
        completeAndReject(pd);
        // A checkpoint rejection opens a new attempt. Give that attempt its
        // actual initial approval before exercising subsequent content edits.
        approveReopenedAttempt(pd);
      }
      const originalApproval = evaluateCodeGenerationApproval(pd, TARGET);
      expect(originalApproval.ok, originalApproval.reason).toBe(true);
      const authority = resolveCodeGenerationAuthority(pd, TARGET);
      const key = { targetId: authority.targetId, runFloor: authority.runFloor,
        fingerprint: originalApproval.approvalFingerprint! };
      const originalReceipt = readPlanApprovalReceipt(pd, key)!;
      expect(originalReceipt).not.toBeNull();
      const dir = codeGenerationRecordDir(pd, UNIT);
      const questions = readFileSync(join(dir, "code-generation-questions.md"), "utf-8");
      const originalChildPlan = operation === "resume"
        ? readFileSync(join(codeGenerationRecordDir(child(pd), UNIT), "code-generation-plan.md"), "utf-8")
        : null;
      const startsBefore = starts(pd).length;
      const approvalsBefore = readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED");

      const state = seededStateFile(pd);
      writeFileSync(state, setGuardPolicyLine(readFileSync(state, "utf-8"), `${mode} (set by you)`));
      publish(pd);
      revise(pd, operation === "resume");
      const current = evaluateCodeGenerationApproval(pd, TARGET);
      expect(current.ok).toBe(false);
      expect(current.approvalFingerprint).not.toBeNull();
      expect(current.approvalFingerprint).not.toBe(key.fingerprint);
      if (operation === "resume") expect(current.contractValid).toBe(false);
      expect(codeGenerationExecutionAllowed(pd, TARGET, current)).toBe(mode !== "strict");

      const result = prepare(pd, operation === "resume");
      if (mode === "strict") {
        expect(result.code, `${result.out}\n${result.err}`).not.toBe(0);
        expect(starts(pd)).toHaveLength(startsBefore);
        if (originalChildPlan === null) expect(existsSync(child(pd))).toBe(false);
        else expect(readFileSync(join(codeGenerationRecordDir(child(pd), UNIT), "code-generation-plan.md"), "utf-8"))
          .toBe(originalChildPlan);
        expect(readPlanApprovalReceipt(pd, key)).toEqual(originalReceipt);
      } else {
        succeeded(result);
        expect(JSON.parse(result.out).units[0]).toMatchObject({
          unit: UNIT, ok: true, worktree_path: child(pd),
          ...(operation === "resume" ? { resumed: true } : {}),
        });
        expect(starts(pd)).toHaveLength(startsBefore + 1);
        const childDir = codeGenerationRecordDir(child(pd), UNIT);
        for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "code-generation-questions.md"]) {
          expect(readFileSync(join(childDir, name), "utf-8")).toBe(readFileSync(join(dir, name), "utf-8"));
        }
        for (const project of [pd, child(pd)]) {
          expect(evaluateCodeGenerationApproval(project, TARGET).ok).toBe(false);
          expect(codeGenerationExecutionAllowed(project, TARGET)).toBe(true);
          expect(readPlanApprovalReceipt(project, { ...key, fingerprint: current.approvalFingerprint! })).toBeNull();
          expect(readPlanApprovalReceipt(project, key)).toMatchObject({
            status: "generation", choice: originalReceipt.choice, session: originalReceipt.session,
            fingerprint: originalReceipt.fingerprint, promptSha256: originalReceipt.promptSha256,
            intentId: originalReceipt.intentId, runFloor: originalReceipt.runFloor, targetId: originalReceipt.targetId,
          });
        }
        const delegated = readPlanApprovalReceipt(child(pd), key)!;
        expect(delegated.delegation).toMatchObject({ unit: UNIT, parentProjectDir: pd, worktreeDir: child(pd) });
        if (operation === "resume") {
          const resumedStarts = starts(pd).length;
          succeeded(prepare(pd, true));
          expect(starts(pd)).toHaveLength(resumedStarts);
          const metadataPath = join(child(pd), ".aidlc", "worktree-meta.json");
          const metadata = readFileSync(metadataPath, "utf-8");
          // Lowering approval cannot turn another Unit or attempt into this
          // preserved worker, even on an otherwise idempotent resume.
          for (const field of ["swarmUnit", "swarmFloor"]) {
            writeFileSync(metadataPath, JSON.stringify({
              ...JSON.parse(metadata), [field]: "different-unit-or-attempt",
            }));
            const refused = prepare(pd, true);
            expect(refused.code, `${refused.out}\n${refused.err}`).not.toBe(0);
            expect(starts(pd)).toHaveLength(resumedStarts);
            writeFileSync(metadataPath, metadata);
          }
        }
      }
      expect(readFileSync(join(dir, "code-generation-questions.md"), "utf-8")).toBe(questions);
      expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(approvalsBefore);
    });
  }
});

describe("delegated continuation follows the parent approval and live fence", () => {
  test.each(["relaxed", "off"])("grouped approval permits edited worker content under %s", (mode) => {
    const pd = fixture(true);
    const originals = new Map(GROUP_UNITS.map((unit) => [unit, approvalSnapshot(pd, unit)]));
    const approvalRows = readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED");
    const state = seededStateFile(pd);
    writeFileSync(state, setGuardPolicyLine(readFileSync(state, "utf-8"), `${mode} (set by you)`));
    publish(pd, GROUP_UNITS);
    // Alpha also changes its valid contract; beta changes only plan/instructions.
    // Both retain the group's original fingerprints and actual human answers.
    for (const unit of GROUP_UNITS) revise(pd, unit === UNIT, unit);
    succeeded(prepare(pd, false, GROUP_UNITS));
    const startsBefore = readAuditShardEvents(pd).filter((row) => row.event === "BOLT_STARTED");
    for (const unit of GROUP_UNITS) {
      const original = originals.get(unit)!;
      const worker = child(pd, unit);
      const parentReceipt = readPlanApprovalReceipt(pd, original.key);
      const workerReceipt = readPlanApprovalReceipt(worker, original.key);
      expect(parentReceipt).toEqual({ ...original.receipt, status: "generation" });
      expect(workerReceipt).toMatchObject({
        ...original.receipt, status: "generation",
        delegation: { unit, parentProjectDir: pd, worktreeDir: worker },
      });
      expect(workerReceipt?.batch?.members.map((member) => member.unit)).toEqual(GROUP_UNITS);
      const workerApprovals = readAuditShardEvents(worker).filter((row) => row.event === "PLAN_APPROVAL_RECORDED");
      for (let repeat = 0; repeat < 2; repeat++) {
        checkWorkerCommands(worker, unit, true);
        const current = evaluateCodeGenerationApproval(worker, { unit });
        expect(current.approvalFingerprint).not.toBeNull();
        expect(current.approvalFingerprint).not.toBe(original.key.fingerprint);
        expect(readPlanApprovalReceipt(worker, { ...original.key, fingerprint: current.approvalFingerprint! })).toBeNull();
        expect(readPlanApprovalReceipt(pd, original.key)).toEqual(parentReceipt);
        expect(readPlanApprovalReceipt(worker, original.key)).toEqual(workerReceipt);
        for (const project of [pd, worker]) {
          expect(readFileSync(join(codeGenerationRecordDir(project, unit), "code-generation-questions.md"), "utf-8"))
            .toBe(original.questions);
        }
      }
      expect(readAuditShardEvents(worker).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(workerApprovals);
    }
    expect(readAuditShardEvents(pd).filter((row) => row.event === "BOLT_STARTED")).toEqual(startsBefore);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(approvalRows);
  });

  test.each(["relaxed", "off"])("an existing strict worker follows parent lowering to %s and explicit raising", (mode) => {
    const pd = fixture();
    succeeded(prepare(pd));
    const worker = child(pd);
    const original = approvalSnapshot(worker);
    const parentReceipt = readPlanApprovalReceipt(pd, original.key);
    const startsBefore = starts(pd);
    const parentApprovals = readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED");
    const workerApprovals = readAuditShardEvents(worker).filter((row) => row.event === "PLAN_APPROVAL_RECORDED");
    const parentState = seededStateFile(pd);
    const workerState = seededStateFile(worker);
    const strictWorkerState = readFileSync(workerState, "utf-8");
    expect(getField(strictWorkerState, "Guard Policy")).toBe("strict (set by you)");
    writeFileSync(parentState, setGuardPolicyLine(readFileSync(parentState, "utf-8"), `${mode} (set by you)`));
    publish(pd);
    revise(worker, true);
    checkWorkerWriteHook(worker, UNIT, true);
    checkWorkerCommands(worker, UNIT, true);
    // The parent choice is effective without re-forking or rewriting child state.
    expect(readFileSync(workerState, "utf-8")).toBe(strictWorkerState);
    expect(readPlanApprovalReceipt(worker, original.key)).toEqual(original.receipt);

    // Model a worker retaining an earlier lowered snapshot when the parent
    // subsequently raises the fence. Neither stale direction may override it.
    const loweredWorkerState = setGuardPolicyLine(strictWorkerState, `${mode} (set by you)`);
    writeFileSync(workerState, loweredWorkerState);
    writeActiveDirectiveMarker(worker, {
      kind: "run-stage", stage: STAGE, unit: UNIT, state_sha256: stateDigest(loweredWorkerState),
    });
    writeFileSync(parentState, setGuardsOnLine(readFileSync(parentState, "utf-8"), ["plan-approval"]));
    publish(pd);
    for (let repeat = 0; repeat < 2; repeat++) {
      checkWorkerWriteHook(worker, UNIT, false);
      checkWorkerCommands(worker, UNIT, false);
    }
    expect(readFileSync(workerState, "utf-8")).toBe(loweredWorkerState);
    expect(readPlanApprovalReceipt(pd, original.key)).toEqual(parentReceipt);
    expect(readPlanApprovalReceipt(worker, original.key)).toEqual(original.receipt);
    for (const project of [pd, worker]) {
      expect(readFileSync(join(codeGenerationRecordDir(project, UNIT), "code-generation-questions.md"), "utf-8"))
        .toBe(original.questions);
    }
    expect(starts(pd)).toEqual(startsBefore);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(parentApprovals);
    expect(readAuditShardEvents(worker).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(workerApprovals);
  });
});
