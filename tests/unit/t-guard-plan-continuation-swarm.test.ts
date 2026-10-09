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
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  activeIntentUuid, artifactFilename, auditBlockField, boltSlugForUnit, findStageBySlug, getField,
  latestMainWorkflowStageRunFloorForProject, readAuditShardEvents,
  readPlanApprovalReceipt, recordDir, REVIEW_RECORDS_DIR, reviewerDispatchPath, setGuardPolicyLine, setGuardsOffLine, setGuardsOnLine,
  stateDigest, workspaceSourceFingerprint,
  workspaceSourceListing, worktreePath, writeActiveDirectiveMarker, writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approvalFingerprint, codeGenerationExecutionAllowed, codeGenerationPlanApprovalQuestionEvidence, codeGenerationRecordDir,
  evaluateCodeGenerationApproval, parseTestingContract, renderTestingContract,
  resolveCodeGenerationAuthority, resolveTestingPosture, resolveTestingPostureFromSections,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { publishPlanApprovalSkip } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";
import {
  AIDLC_SRC, cleanupWorktreeFixture, fixtureIntentId8, resetAidlcEnv,
  seedAidlcMemory, seedBoltDagBatches, seededStateFile, setupWorktreeFixture,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupWorktreeFixture(projects.pop()!);
});

const STAGE = "code-generation";
const UNIT = "alpha";
const TARGET = { unit: UNIT };
const MODES = ["strict", "relaxed", "off"] as const;
const GROUP_UNITS = [UNIT, "beta"];
const ISOLATED_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // Replacing the runner's global config must keep its Windows long-path
  // support, or deep fixture worktrees cannot be removed.
  ...(process.platform === "win32"
    ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "true" }
    : {}),
};

function tool(pd: string, file: string, args: string[], input?: unknown, env: NodeJS.ProcessEnv = {}) {
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", file), ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

function fixture(grouped = false, approve = true): string {
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
  if (!approve) return pd;
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
  const questions = join(codeGenerationRecordDir(pd, UNIT), "code-generation-questions.md");
  // The earlier attempt's approval stands in the file; blank it before the new fingerprint.
  if (existsSync(questions)) {
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(/^\[Answer\]:.*$/gm, "[Answer]:"));
  }
  const printed = tool(pd, "aidlc-testing-posture.ts", ["fingerprint", "--unit", UNIT]);
  succeeded(printed);
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

function checkWorkerWriteHook(worker: string, unit: string, allowed: boolean, speaks = true): void {
  const source = join(worker, "src", `${unit}.ts`);
  const sourceBefore = readFileSync(source, "utf-8");
  const notices = () => readAuditShardEvents(worker).filter((row) => row.event === "GUARD_STOOD_ASIDE" &&
    auditBlockField(row.block, "Guard") === "plan-approval" && auditBlockField(row.block, "Tool") === "Write");
  const blocks = () => readAuditShardEvents(worker).filter((row) => row.event === "PLAN_APPROVAL_BLOCKED" &&
    auditBlockField(row.block, "Tool") === "Write");
  const noticesBefore = notices().length;
  const blocksBefore = blocks().length;
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
    // Relaxed says it carried on in one line; off records the row and says nothing.
    if (speaks) expect(out).toContain("Continuing past the plan-approval check");
    else expect(out).not.toContain("Continuing past");
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
    const outcome = fault === "later-target"
      ? "rolls back all new starts after later-target and revalidates its retry"
      : "goes ahead when a file is written while its starts are published";
    test.each(["relaxed", "off"] as const)(`a %s dispatch ${outcome}`, async (mode) => {
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
        timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
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
        const deadline = Date.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!;
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
        const cleanupTimer = setTimeout(
          () => processUnderTest.kill("SIGKILL"),
          remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS),
        );
        try {
          await processUnderTest.exited;
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
      if (fault === "source-during-publication") {
        // With the check lowered, a file written during the start is the same
        // accepted change as one written before it.
        expect(processUnderTest.exitCode, await stderr).toBe(0);
        for (const original of originals) {
          expect(readPlanApprovalReceipt(pd, original.key)?.status).toBe("generation");
        }
        expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toEqual(approvals);
        expect(readFileSync(statePath, "utf-8")).toBe(state);
        return;
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
    expect(guarded.stderr.toString()).toContain(" The plan-approval setting is unchanged.");
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
        // The receipt records the parent's realpath; the fixture path is portable.
        expect(delegated.delegation).toMatchObject({ unit: UNIT, parentProjectDir: realpathSync(pd), worktreeDir: child(pd) });
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
        delegation: { unit, parentProjectDir: realpathSync(pd), worktreeDir: worker },
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
    checkWorkerWriteHook(worker, UNIT, true, mode !== "off");
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

// The helper and the reviewer are subagents of the conductor's session on
// Claude Code and Codex, so the hook that judges their writes runs with the
// PARENT as its project (the hook's own install location), under the parent's
// `invoke-swarm` directive. These cases run it exactly so: project and cwd are
// the parent, and the targets are where the engine's own records put them.
describe("a parallel batch's writes judged from the parent", () => {
  function parentHook(pd: string, toolName: "Write" | "Bash", toolInput: Record<string, unknown>) {
    const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: pd,
      env: {
        ...testGuardEnvironment(ISOLATED_GIT_ENV, "production"),
        AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd,
      },
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput,
        session_id: "swarm-parent-session", cwd: pd,
      })),
      stdout: "pipe", stderr: "pipe",
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }
  const write = (pd: string, path: string) => parentHook(pd, "Write", { file_path: path, content: "// written by the test\n" });
  // A path inside a shell command, spelled the way an agent in Git Bash spells it (forward slashes;
  // an unquoted backslash path is what bash itself would mangle, and the guard reads it as bash does).
  const sh = (path: string) => path.replaceAll("\\", "/");
  const win32 = process.platform === "win32";
  const blocked = (pd: string) => readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_BLOCKED").length;
  const stoodAside = (pd: string) => readAuditShardEvents(pd).filter((row) =>
    row.event === "GUARD_STOOD_ASIDE" && auditBlockField(row.block, "Guard") === "plan-approval").length;
  const REFUSAL = "cannot select one approval target";

  test("the helper's write in its prepared worktree passes; a write to the main checkout or a stray folder waits", () => {
    const pd = fixture();
    succeeded(prepare(pd));
    publish(pd);
    const worker = child(pd);
    expect(existsSync(join(worker, "src", `${UNIT}.ts`))).toBe(true);
    const before = blocked(pd);

    // The Unit's code, where prepare put the worker: a file the plan names, a new file, and a shell write.
    for (const target of [join(worker, "src", `${UNIT}.ts`), join(worker, "package.json")]) {
      const result = write(pd, target);
      expect(result.code, `${target}\n${result.out}\n${result.err}`).toBe(0);
      expect(result.out).toBe("");
    }
    const shell = parentHook(pd, "Bash", { command: `echo "export const ${UNIT} = 2;" > ${sh(join(worker, "src", `${UNIT}.ts`))}` });
    expect(shell.code, `${shell.out}\n${shell.err}`).toBe(0);
    if (win32) {
      // A quoted Windows path reaches bash intact and is the worktree's file; unquoted, bash would
      // drop its backslashes and write a file into the current directory, the main checkout.
      const quoted = parentHook(pd, "Bash", { command: `echo "x" > "${join(worker, "src", `${UNIT}.ts`)}"` });
      expect(quoted.code, `${quoted.out}\n${quoted.err}`).toBe(0);
      const mangled = parentHook(pd, "Bash", { command: `echo "x" > ${join(worker, "src", `${UNIT}.ts`)}` });
      expect(mangled.code, `${mangled.out}\n${mangled.err}`).toBe(2);
    }
    expect(blocked(pd)).toBe(before + (win32 ? 1 : 0));
    // The hook decides only; nothing was written for it.
    expect(readFileSync(join(worker, "src", `${UNIT}.ts`), "utf-8")).toBe(`export const ${UNIT} = 1;\n`);

    // The main checkout stays as approved while the batch is out.
    const main = write(pd, join(pd, "src", `${UNIT}.ts`));
    expect(main.code, `${main.out}\n${main.err}`).toBe(2);
    expect(main.err).toContain(REFUSAL);
    expect(blocked(pd)).toBe(before + (win32 ? 2 : 1));

    // A folder under .aidlc/worktrees that prepare did not create carries no approval.
    const stray = join(pd, ".aidlc", "worktrees", "bolt-stray");
    mkdirSync(join(stray, "src"), { recursive: true });
    const strayWrite = write(pd, join(stray, "src", `${UNIT}.ts`));
    expect(strayWrite.code, `${strayWrite.out}\n${strayWrite.err}`).toBe(2);
    expect(strayWrite.err).toContain(REFUSAL);
    expect(blocked(pd)).toBe(before + (win32 ? 3 : 2));
  });

  test("each listed Unit's worker writes in its own worktree and in no other", () => {
    const pd = fixture(true);
    succeeded(prepare(pd, false, GROUP_UNITS));
    publish(pd, GROUP_UNITS);
    for (const unit of GROUP_UNITS) {
      const own = write(pd, join(child(pd, unit), "src", `${unit}.ts`));
      expect(own.code, `${unit}\n${own.out}\n${own.err}`).toBe(0);
    }
    // A worker's worktree bound to beta, written with alpha's file: still beta's worktree, still allowed;
    // the rule admits the worktree the engine bound, whichever file the worker names inside it.
    const cross = write(pd, join(child(pd, "beta"), "src", "alpha.ts"));
    expect(cross.code, `${cross.out}\n${cross.err}`).toBe(0);
    // One write that names both worktrees is not one Unit's work.
    const both = parentHook(pd, "Bash", {
      command: `echo x > ${sh(join(child(pd, "alpha"), "src", "alpha.ts"))} && echo y > ${sh(join(child(pd, "beta"), "src", "beta.ts"))}`,
    });
    expect(both.code, `${both.out}\n${both.err}`).toBe(2);
  });

  test("the reviewer writes the open review file of a listed Unit, and nothing else of the kind", () => {
    const pd = fixture();
    publish(pd);
    const reviews = join(recordDir(pd)!, REVIEW_RECORDS_DIR);
    const slot = (unit: string, id: string) =>
      `${REVIEW_RECORDS_DIR}/code-generation/units/${unit}/1234567890abcdef/1.${id}.review.md`;
    const request = (unit: string, id: string) => appendAuditEntry("REVIEW_REQUESTED", {
      Stage: STAGE, Unit: unit, Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "1",
      "Request Id": `review:${id}`, "Review File": slot(unit, id),
    }, pd);
    const before = blocked(pd);
    request(UNIT, "aaaa0000aaaa0000");
    const own = write(pd, join(recordDir(pd)!, slot(UNIT, "aaaa0000aaaa0000")));
    expect(own.code, `${own.out}\n${own.err}`).toBe(0);
    expect(own.out).toBe("");
    expect(blocked(pd)).toBe(before);
    // Another file in the reviews folder, no request behind it.
    const unrequested = write(pd, join(reviews, "code-generation", "units", UNIT, "1234567890abcdef", "1.ffff.review.md"));
    expect(unrequested.code, `${unrequested.out}\n${unrequested.err}`).toBe(2);
    expect(unrequested.err).toContain(REFUSAL);
    // A request for a Unit the batch does not list.
    request("later", "bbbb0000bbbb0000");
    const foreign = write(pd, join(recordDir(pd)!, slot("later", "bbbb0000bbbb0000")));
    expect(foreign.code, `${foreign.out}\n${foreign.err}`).toBe(2);
    // The verdict is in: the slot is closed again.
    appendAuditEntry("REVIEW_COMPLETED", {
      Stage: STAGE, Unit: UNIT, Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "1",
      "Request Id": "review:aaaa0000aaaa0000", Verdict: "READY",
    }, pd);
    const closed = write(pd, join(recordDir(pd)!, slot(UNIT, "aaaa0000aaaa0000")));
    expect(closed.code, `${closed.out}\n${closed.err}`).toBe(2);
    expect(blocked(pd)).toBe(before + 3);
  });

  test("a read-only probe passes under the batch with the fence on; a shell that writes waits", () => {
    const pd = fixture();
    publish(pd);
    const before = blocked(pd);
    // The shapes the live runs probed with: a compound of read-only commands, a pipe, a
    // read-only git pair, and a cwd change followed by a read. The lexer reads each whole,
    // none names a file it writes, and none is AI-DLC's own, so each passes as it does at
    // every other point of Code Generation.
    for (const command of [
      "printf '%s\\n' settings; ls aidlc.settings*.json",
      `cat ${sh(join(pd, "src", `${UNIT}.ts`))} 2>&1 | head -60`,
      `git -C ${sh(pd)} status --short && git -C ${sh(pd)} log --oneline -3`,
      `cd ${sh(join(pd, "src"))} && ls`,
    ]) {
      const probe = parentHook(pd, "Bash", { command });
      expect(probe.code, `${command}\n${probe.out}\n${probe.err}`).toBe(0);
    }
    expect(blocked(pd)).toBe(before);
    // Anything that writes in the main checkout, whose writes cannot be seen (inline code),
    // or that runs an AI-DLC tool in a spelling the guard does not admit, still waits.
    const refusedProbes = [
      `ls ${sh(pd)} > ${sh(join(pd, "listing.txt"))}`,
      `cat ${sh(join(pd, "src", `${UNIT}.ts`))} | tee ${sh(join(pd, "copy.ts"))}`,
      "node -e 'console.log(1)'",
      `bun ${sh(join(AIDLC_SRC, "tools", "aidlc-swarm.ts"))} --help 2>&1 | head -60`,
      // A Windows-spelled tool path reaches bash only when quoted, and is then AI-DLC's own tool run.
      ...(win32 ? [`bun "${join(AIDLC_SRC, "tools", "aidlc-swarm.ts")}" --help 2>&1 | head -60`] : []),
    ];
    for (const command of refusedProbes) {
      const refused = parentHook(pd, "Bash", { command });
      expect(refused.code, `${command}\n${refused.out}\n${refused.err}`).toBe(2);
      expect(refused.err).toContain(REFUSAL);
    }
    expect(blocked(pd)).toBe(before + refusedProbes.length);
  });

  test("the review request and verdict commands pass when they name a listed Unit's prepared worktree", () => {
    const pd = fixture();
    succeeded(prepare(pd));
    publish(pd);
    const worker = child(pd);
    // The installed spellings resolve the entry point under the project's own tools folder.
    mkdirSync(join(pd, ".claude", "tools"), { recursive: true });
    for (const name of ["aidlc.ts", "aidlc-log.ts"]) {
      copyFileSync(join(AIDLC_SRC, "tools", name), join(pd, ".claude", "tools", name));
    }
    const before = blocked(pd);
    const review = (entry: string, unit: string, dir: string, verdict = "") =>
      `${entry} --stage code-generation --unit ${unit} --reviewer aidlc-architecture-reviewer-agent --iteration 1` +
      `${verdict ? ` --verdict ${verdict}` : ""} --project-dir "${sh(dir)}"`;
    for (const entry of [
      "aidlc engine log review", "bun .claude/tools/aidlc.ts engine log review", "bun .claude/tools/aidlc-log.ts review",
    ]) {
      for (const verdict of ["", "READY"]) {
        const command = review(entry, UNIT, worker, verdict);
        const result = parentHook(pd, "Bash", { command });
        expect(result.code, `${command}\n${result.out}\n${result.err}`).toBe(0);
        expect(result.out).toBe("");
      }
    }
    expect(blocked(pd)).toBe(before);
    // The same route against the parent, an unlisted Unit, a folder prepare did not bind, or behind a pipe: refused.
    mkdirSync(join(pd, ".aidlc", "worktrees", "bolt-stray"), { recursive: true });
    for (const command of [
      review("aidlc engine log review", UNIT, pd),
      review("aidlc engine log review", "later", worker),
      review("aidlc engine log review", UNIT, join(pd, ".aidlc", "worktrees", "bolt-stray")),
      `${review("aidlc engine log review", UNIT, worker)} 2>&1 | head -5`,
    ]) {
      const refused = parentHook(pd, "Bash", { command });
      expect(refused.code, `${command}\n${refused.out}\n${refused.err}`).toBe(2);
      expect(refused.err).toContain(REFUSAL);
    }
    expect(blocked(pd)).toBe(before + 4);
  });

  test("the parent's reviewer dispatch record passes while a listed Unit's worktree holds the open request", () => {
    const pd = fixture();
    succeeded(prepare(pd));
    publish(pd);
    const worker = child(pd);
    const slot = `${REVIEW_RECORDS_DIR}/code-generation/units/${UNIT}/1234567890abcdef/1.cccc0000cccc0000.review.md`;
    const before = blocked(pd);
    // Nothing open yet: the dispatch record waits.
    const early = write(pd, reviewerDispatchPath(pd));
    expect(early.code, `${early.out}\n${early.err}`).toBe(2);
    // The protocol's request is logged against the worktree, so its row lives in the worktree's audit.
    appendAuditEntry("REVIEW_REQUESTED", {
      Stage: STAGE, Unit: UNIT, Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "1",
      "Request Id": "review:cccc0000cccc0000", "Review File": slot,
    }, worker);
    const dispatch = write(pd, reviewerDispatchPath(pd));
    expect(dispatch.code, `${dispatch.out}\n${dispatch.err}`).toBe(0);
    const verdictFile = write(pd, join(recordDir(worker)!, slot));
    expect(verdictFile.code, `${verdictFile.out}\n${verdictFile.err}`).toBe(0);
    expect(blocked(pd)).toBe(before + 1);
    // The verdict is recorded in the same audit: the dispatch record is closed again.
    appendAuditEntry("REVIEW_COMPLETED", {
      Stage: STAGE, Unit: UNIT, Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "1",
      "Request Id": "review:cccc0000cccc0000", Verdict: "READY",
    }, worker);
    const closed = write(pd, reviewerDispatchPath(pd));
    expect(closed.code, `${closed.out}\n${closed.err}`).toBe(2);
    expect(blocked(pd)).toBe(before + 2);
  });

  test.each(["relaxed", "off"] as const)("a %s fence stands aside for a main-checkout write and the worker's changed plan", (mode) => {
    const pd = fixture();
    succeeded(prepare(pd));
    publish(pd);
    const worker = child(pd);
    const statePath = seededStateFile(pd);
    const strict = readFileSync(statePath, "utf-8");
    const source = join(pd, "src", `${UNIT}.ts`);

    // The fence on: the main checkout waits, and so does a worker whose plan changed since approval.
    revise(worker, false);
    expect(write(pd, source).code).toBe(2);
    const changed = write(pd, join(worker, "src", `${UNIT}.ts`));
    expect(changed.code, `${changed.out}\n${changed.err}`).toBe(2);

    // The Guard Policy word lowers it: off means off.
    writeFileSync(statePath, setGuardPolicyLine(strict, `${mode} (set by you)`));
    publish(pd);
    const asideBefore = stoodAside(pd);
    const main = write(pd, source);
    expect(main.code, `${main.out}\n${main.err}`).toBe(0);
    expect(stoodAside(pd)).toBe(asideBefore + 1);
    if (mode === "relaxed") expect(main.out).toContain("Continuing past the plan-approval check");
    else expect(main.out).not.toContain("Continuing past");
    const changedLowered = write(pd, join(worker, "src", `${UNIT}.ts`));
    expect(changedLowered.code, `${changedLowered.out}\n${changedLowered.err}`).toBe(0);

    // The person's own switch does the same.
    writeFileSync(statePath, setGuardsOffLine(strict, ["plan-approval"]));
    publish(pd);
    const switched = write(pd, source);
    expect(switched.code, `${switched.out}\n${switched.err}`).toBe(0);
    expect(stoodAside(pd)).toBe(asideBefore + 2);

    // Raised again: the refusal is back, unchanged.
    writeFileSync(statePath, strict);
    publish(pd);
    const raised = write(pd, source);
    expect(raised.code).toBe(2);
    expect(raised.err).toContain(REFUSAL);
  });
});

// The engine's own recorder writes the person's choice with its option letter
// ("[Answer]: A. Approve Plan"); a hand-recorded answer carries the bare label.
// Both are the same answer to every reader, prepare's source preflight included.
describe("prepare reads the answer the engine recorded", () => {
  test("the lettered Approve Plan line forks the worker like the bare label does", () => {
    const pd = fixture();
    const questions = join(codeGenerationRecordDir(pd, UNIT), "code-generation-questions.md");
    const recorded = readFileSync(questions, "utf-8");
    expect(recorded).toContain("[Answer]: Approve Plan");
    // The receipt binds the answer-blanked prompt, so the line's spelling is free to be the recorder's.
    writeFileSync(questions, recorded.replace("[Answer]: Approve Plan", "[Answer]: A. Approve Plan"));
    expect(evaluateCodeGenerationApproval(pd, TARGET).ok).toBe(true);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    expect(prepared.err).not.toContain("must contain exactly [Answer]");
    expect(existsSync(join(child(pd), "src", `${UNIT}.ts`))).toBe(true);
    expect(starts(pd)).toHaveLength(1);
  });

  test("the reader takes the label however the letter or quotes were written, and still refuses another answer", () => {
    const pd = fixture();
    const questions = join(codeGenerationRecordDir(pd, UNIT), "code-generation-questions.md");
    const recorded = readFileSync(questions, "utf-8");
    const evidence = (line: string, expected: "Approve Plan" | "Request Changes" = "Approve Plan") => {
      writeFileSync(questions, recorded.replace("[Answer]: Approve Plan", `[Answer]: ${line}`));
      return () => codeGenerationPlanApprovalQuestionEvidence(pd, TARGET, questions, expected, { breakGlass: true });
    };
    // The shared approval reader is case-insensitive about the letter; this reader agrees with it.
    for (const line of ["A. Approve Plan", "a. Approve Plan", "A) Approve Plan", "\"Approve Plan\"", "approve plan"]) {
      expect(evidence(line), line).not.toThrow();
    }
    expect(evidence("B. Request Changes", "Request Changes")).not.toThrow();
    for (const line of ["B. Request Changes", "Approve", ""]) {
      expect(evidence(line), line).toThrow("Plan Approval questions file must contain exactly [Answer]: Approve Plan");
    }
  });
});

// With plan approval off the engine builds the plan without asking and keeps its
// own record of that (the questions file reads "Plan approval off", the receipt
// is marked skipped). A parallel batch forks its workers from that record the
// way generation start reads it; nobody is asked for a label the person never gave.
describe("prepare with plan approval off", () => {
  test("the engine's own plan-approval-off record forks the worker and starts the Bolt", () => {
    const pd = fixture(false, false);
    const statePath = seededStateFile(pd);
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace(
      "- **Guard Policy**: strict (set by you)\n",
      "- **Guard Policy**: strict (set by you)\n- **Plan Approval**: off (set by you)\n",
    ));
    publish(pd);
    // The engine's switch, as `next` runs it when it issues the batch: the record it leaves is the one prepare reads.
    const directive = { kind: "invoke-swarm", stage: STAGE, units: [UNIT] } as unknown as Parameters<typeof publishPlanApprovalSkip>[1];
    expect(publishPlanApprovalSkip(pd, directive)).toBe(true);
    const questions = readFileSync(join(codeGenerationRecordDir(pd, UNIT), "code-generation-questions.md"), "utf-8");
    expect(questions).toContain("[Answer]: Plan approval off");
    const approval = evaluateCodeGenerationApproval(pd, TARGET);
    expect(approval.ok, approval.reason).toBe(true);
    expect(approval.skipped).toBe(true);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_SKIPPED")).toHaveLength(1);

    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    expect(`${prepared.out}\n${prepared.err}`).not.toContain("must contain exactly [Answer]");
    const worker = child(pd);
    expect(existsSync(join(worker, "src", `${UNIT}.ts`))).toBe(true);
    expect(starts(pd)).toHaveLength(1);
    // The worker builds from the delegated record, and nobody was asked anything.
    expect(codeGenerationExecutionAllowed(worker, TARGET)).toBe(true);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toHaveLength(0);
    expect(readFileSync(join(codeGenerationRecordDir(pd, UNIT), "code-generation-questions.md"), "utf-8")).toBe(questions);
  });
});
