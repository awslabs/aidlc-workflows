// covers: function:codeGenerationPlanApprovalQuestionEvidence, function:recordPlanApprovalReceipt,
// function:evaluateCodeGenerationApproval,
// function:recordAcceptedChanges, function:changeAlreadyAccepted,
// function:writeWorkspaceSourceSnapshot, function:readWorkspaceSourceSnapshot,
// function:workspaceSourceChangedPaths, function:sourceListingChangedPaths,
// subcommand:aidlc-log:decision, subcommand:aidlc-log:answer,
// subcommand:aidlc-testing-posture:fingerprint,
// hook:aidlc-plan-approval-guard, audit:CHANGE_ACCEPTED,
// function:isGuardRecoveryEngineInvocation, function:workerBrief,
// function:codeGenerationExecutionAllowed, subcommand:aidlc-testing-posture:brief
//
// t334, continued: what a lowered plan-approval fence still requires before
// code is written (F22), and the dispatch guard once the human approved, where
// other code moving is never a refusal ((7)). The suite's design is described in
// t334-change-control-plan-approval.test.ts; the cases are split so they run in
// another unit shard.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { isGuardRecoveryEngineInvocation } from "../../dist/claude/.claude/tools/aidlc-guard-operation.ts";
import {
  auditBlockField,
  clearActiveDirectiveMarker,
  readAuditShardEvents,
  sessionsDir,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  parseTestingContract,
  resolveCodeGenerationAuthority,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  seededRecordDir,
} from "../harness/fixtures.ts";
import {
  acceptedRows,
  answer,
  approvalRows,
  brief,
  BUN,
  cleanupChangeControlProjects,
  createProject,
  decide,
  GUARD,
  hookDrops,
  humanTurn,
  movedNotice,
  presentPlan,
  receiptFiles,
  runChangeControlTool,
  startSession,
} from "../harness/change-control-plan-approval.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(cleanupChangeControlProjects, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

describe("t334 F22 initial execution requirements survive a lowered fence", () => {
  const faults = [
    "never-approved", "missing-receipt", "missing-plan", "missing-instructions",
    "malformed-contract", "stale-attempt", "invalid-directive", "invalid-target", "missing-target",
  ] as const;
  for (const mode of ["relaxed", "off", "strict"] as const) {
    test.each([...faults])(`${mode}${mode === "strict" ? " with per-work fence off" : ""} refuses %s for direct writes and developer dispatch`, (fault) => {
      const project = createProject(mode, mode === "strict" ? "off" : undefined);
      const questions = presentPlan(project);
      const session = `initial-${mode}-${fault}`;
      if (fault !== "never-approved") {
        startSession(project, session);
        expect(decide(project, questions, session).code).toBe(0);
        humanTurn(project, session);
        expect(answer(project, questions, session).code).toBe(0);
      }
      const dir = codeGenerationRecordDir(project, null);
      const planPath = join(dir, "code-generation-plan.md");
      const instructionsPath = join(dir, "unit-test-instructions.md");
      const plan = readFileSync(planPath, "utf-8");
      const instructions = readFileSync(instructionsPath, "utf-8");
      let prompt = `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${parseTestingContract(plan)!.contract_sha256}\n${plan}\n${instructions}`;
      if (fault === "missing-receipt") {
        const runtime = join(sessionsDir(project), "plan-approval");
        for (const name of readdirSync(runtime).filter((name) => name.startsWith("receipt-"))) {
          rmSync(join(runtime, name));
        }
      } else if (fault === "missing-plan") rmSync(planPath);
      else if (fault === "missing-instructions") rmSync(instructionsPath);
      else if (fault === "malformed-contract") {
        const body = { version: 1 };
        const malformed = {
          ...body,
          contract_sha256: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
        };
        writeFileSync(planPath, `# Plan\n\n## Testing Contract\n\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\`\n`);
      } else if (fault === "stale-attempt") {
        const before = resolveCodeGenerationAuthority(project, { unit: null }).runFloor;
        appendAuditEntry("STAGE_STARTED", { Stage: "code-generation" }, project);
        expect(resolveCodeGenerationAuthority(project, { unit: null }).runFloor).not.toBe(before);
      } else if (fault === "invalid-directive") clearActiveDirectiveMarker(project);
      else if (fault === "invalid-target") {
        prompt = prompt.replace("AIDLC-STAGE: code-generation", "AIDLC-UNIT: foreign-unit");
      } else if (fault === "missing-target") prompt = "Generate the implementation now.";
      const statePath = join(seededRecordDir(project), "aidlc-state.md");
      const state = readFileSync(statePath, "utf-8");
      const receipts = receiptFiles(project);
      const approvals = approvalRows(project);
      const originalQuestions = readFileSync(questions, "utf-8");
      const operations: Array<["Write" | "Task", Record<string, string>]> = [
        ["Task", { subagent_type: "aidlc-developer-agent", prompt }],
      ];
      // A direct write selects the active directive target, so only the
      // dispatch variant can express this intentionally foreign prompt target.
      // Before any approval only the build waits, so that write is to a file
      // the plan names (its test file); after one, every write waits.
      const written = fault === "never-approved" ? "src/unit.test.ts" : "src/base.ts";
      if (fault !== "invalid-target" && fault !== "missing-target") operations.unshift([
        "Write", { file_path: join(project, written), content: "export const base = 2;\n" },
      ]);
      for (const [tool_name, tool_input] of operations) {
        const guarded = runChangeControlTool([BUN, GUARD], project, JSON.stringify({
          hook_event_name: "PreToolUse", session_id: session, cwd: project, tool_name, tool_input,
        }));
        expect(guarded.code, `${guarded.stdout}\n${guarded.stderr}`).toBe(2);
        expect(guarded.stdout).not.toContain("Continuing past");
        expect(guarded.stderr).toContain(" The plan-approval setting is unchanged.");
      }
      expect(receiptFiles(project)).toEqual(receipts);
      expect(approvalRows(project)).toEqual(approvals);
      expect(readFileSync(statePath, "utf-8")).toBe(state);
      expect(readFileSync(questions, "utf-8")).toBe(originalQuestions);
      expect(readFileSync(join(project, "src/base.ts"), "utf-8")).toBe("export const base = 1;\n");
      expect(readAuditShardEvents(project).filter((entry) => entry.event === "GUARD_STOOD_ASIDE")).toHaveLength(0);
      if (fault === "missing-plan") {
        // Repairing the required plan record is planning, not generation, and
        // stays available even while the execution prerequisite is unmet.
        const repair = runChangeControlTool([BUN, GUARD], project, JSON.stringify({
          hook_event_name: "PreToolUse", session_id: session, cwd: project, tool_name: "Write",
          tool_input: { file_path: planPath, content: plan },
        }));
        expect(repair.code, repair.stderr).toBe(0);
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});

describe("t334 (7) at the dispatch guard, other code moving after approval is never a refusal", () => {
  test("strict hands the current brief over, names the moved file once, and asks nothing", () => {
    const project = createProject("strict");
    const questions = presentPlan(project);
    startSession(project, "strict-guard");
    expect(decide(project, questions, "strict-guard").code).toBe(0);
    humanTurn(project, "strict-guard");
    expect(answer(project, questions, "strict-guard").code).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
    // The source moves after approval.
    writeFileSync(join(project, "src", "after.ts"), "export const after = 1;\n");
    const dispatch = (prompt: string) => runChangeControlTool(
      [BUN, GUARD],
      project,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "aidlc-developer-agent", prompt },
        cwd: project,
      }),
    );
    // A stale contract hash is still refused, for the hash alone: the moved
    // file is not a reason, so no drift ask rides on the refusal.
    const stale = dispatch(`AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: sha256:${"0".repeat(64)}`);
    expect(stale.code, stale.stderr).toBe(2);
    expect(stale.stderr).not.toContain("changed since this plan was approved");
    expect(stale.stderr).not.toContain("PLAN_SOURCE_DRIFT");
    expect(stale.stderr).not.toContain("\"ask_type\":\"guard-recovery\"");
    const printed = brief(project);
    expect(printed.code, printed.stderr).toBe(0);
    const handed = dispatch(printed.stdout);
    expect(handed.code, `${handed.stderr}\nDROPS:\n${hookDrops(project)}`).toBe(0);
    expect(handed.stdout).toContain(movedNotice("1 file", "src/after.ts"));
    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/after.ts");
    expect(approvalRows(project)).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("memory strict or not, a plan-approval refusal offers no switch", () => {
    const project = createProject("strict");
    const memory = join(project, "aidlc", "spaces", "default", "memory", "project.md");
    writeFileSync(memory, readFileSync(memory, "utf-8").replace(
      "## Guard Policy\n", "## Guard Policy\n\nMode: strict\n",
    ));
    const questions = presentPlan(project);
    startSession(project, "memory-strict-guard");
    expect(decide(project, questions, "memory-strict-guard").code).toBe(0);
    humanTurn(project, "memory-strict-guard");
    expect(answer(project, questions, "memory-strict-guard").code).toBe(0);

    const guard = runChangeControlTool([BUN, GUARD], project, JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: {
        subagent_type: "aidlc-developer-agent",
        prompt: `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: sha256:${"0".repeat(64)}`,
      },
      cwd: project,
    }));
    expect(guard.code, guard.stderr).toBe(2);
    const lines = guard.stderr.trim().split(/\r?\n/);
    expect(lines[0]).not.toContain("cannot be turned off from chat");
    expect(lines[0]).not.toContain("config set guard.plan-approval off");
    expect(acceptedRows(project)).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the native fence switch a refusal prints is admitted by the hook it lowers, and nothing near it is", () => {
    const project = createProject("strict");
    const questions = presentPlan(project);
    startSession(project, "strict-native");
    // Recorded but not answered: the plan is not approved, so the guard
    // refuses workspace commands and only the exact switch gets through.
    expect(decide(project, questions, "strict-native").code).toBe(0);
    const bash = (command: string) => runChangeControlTool([BUN, GUARD], project, JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: project,
    }));
    const admitted = bash("aidlc engine config set guard.plan-approval off");
    expect(admitted.code, admitted.stderr).toBe(0);
    // Admitted as a prerequisite, not stood aside: the fence is still up.
    expect(admitted.stdout).not.toContain("Continuing past");
    // Turning plan approval on only adds the stop, so it is admitted too.
    expect(bash("aidlc engine config set guard.plan-approval on").code).toBe(0);
    for (const command of [
      "aidlc engine config set guard.plan-approval off --force",
      "aidlc engine config set guard-policy off",
      "aidlc engine config set guard.plan-approval off; touch src/x.ts",
    ]) {
      expect(bash(command).code, command).toBe(2);
    }
    // The argv check behind the admission is exact.
    const argv = ["engine", "config", "set", "guard.plan-approval", "off"];
    expect(isGuardRecoveryEngineInvocation(argv)).toBe(true);
    for (const changed of [
      [...argv, "--force"],
      argv.slice(0, -1),
      argv.map((v) => v === "off" ? "on" : v),
      argv.map((v) => v === "guard.plan-approval" ? "guard.../x" : v),
      ["engine", "config", "list"],
      ["engine", "config", "set", "guard.human-presence", "off"],
    ]) {
      expect(isGuardRecoveryEngineInvocation(changed), changed.join(" ")).toBe(false);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("relaxed says the same: the drift is accepted and no ask is printed", () => {
    const project = createProject("relaxed");
    const questions = presentPlan(project);
    startSession(project, "relaxed-guard");
    expect(decide(project, questions, "relaxed-guard").code).toBe(0);
    humanTurn(project, "relaxed-guard");
    expect(answer(project, questions, "relaxed-guard").code).toBe(0);
    writeFileSync(join(project, "src", "after.ts"), "export const after = 1;\n");
    const guard = runChangeControlTool(
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
    expect(guard.stderr).not.toContain("\"ask_type\":\"guard-recovery\"");
    expect(guard.stderr).not.toContain("PLAN_SOURCE_DRIFT");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
