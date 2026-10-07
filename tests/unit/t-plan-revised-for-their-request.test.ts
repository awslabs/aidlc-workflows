// covers: function:routeCodeGenerationPlanApproval, function:codeGenerationExecutionAllowed, function:evaluateCodeGenerationApproval, hook:aidlc-plan-approval-guard
//
// A change the person asks for at the Code Generation gate is not a reason to
// ask them to approve the plan again. They say "rename the test file"; the
// engine sends the plan back with their words, the agent revises it, and under
// Guard Policy off or relaxed the revised plan builds and comes back at the
// gate for their judgement. Strict still asks, because asking is its purpose.
//
// These cases drive the real `next`, the real human-turn hook, the real
// plan-approval guard and the real generation start over one workflow at Code
// Generation, and check what the person is asked:
//
//   - off and relaxed: no second plan question after their own change request,
//     the guard admits the build, and the gate follows;
//   - strict: the plan question comes back;
//   - a fence the person raised themselves keeps its question, even under off;
//   - a Redo and a reopen (a jump back) are fresh attempts: the plan comes back;
//   - the ticks the earlier build left are cleared, so the revised build starts
//     its steps fresh.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
const SESSION = "01995000-7a11-7000-8000-000000000041";

interface Emitted {
  kind: string;
  ask_type?: string;
  question?: string;
  plan_approval?: { status?: string; feedback?: string };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** A poc workflow at Code Generation with plan approval on, as a scope default. */
function project(policy: "strict" | "relaxed" | "off", guardsOn = false): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace(
      "- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy} (from scope poc)\n- **Plan Approval**: on (from scope poc)` +
        (guardsOn ? "\n- **Guards On**: plan-approval (set by you)" : ""),
    )
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

/** A feature workflow whose Code Generation is per Unit. */
function unitProject(policy: "strict" | "off", unit: string): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Per-Unit build
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: off
- **Guard Policy**: ${policy} (set by you)
- **Plan Approval**: on (from scope feature)

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Minimal

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design \u2014 EXECUTE
- [x] nfr-requirements \u2014 EXECUTE
- [x] nfr-design \u2014 EXECUTE
- [x] infrastructure-design \u2014 EXECUTE
- [-] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`, "utf-8");
  seedBoltDag(proj, [unit]);
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function stageDir(proj: string, unit: string | null = null): string {
  return join(seededRecordDir(proj), "construction", ...(unit ? [unit] : []), "code-generation");
}

function planPath(proj: string, unit: string | null = null): string {
  return join(stageDir(proj, unit), "code-generation-plan.md");
}

function writePlan(proj: string, extra = "", unit: string | null = null): void {
  mkdirSync(stageDir(proj, unit), { recursive: true });
  writeFileSync(
    planPath(proj, unit),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n${extra}\n` +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(
    join(stageDir(proj, unit), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n",
    "utf-8",
  );
}

function next(proj: string, args: string[] = []): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, AIDLC_UNATTENDED: "0" } });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

function reply(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

/** The person's own Request Changes at the gate: the row `report --result rejected` writes. */
function rejectedAtGate(proj: string, feedback: string, unit: string | null = null): void {
  appendAuditEntry("GATE_REJECTED", {
    Stage: "code-generation",
    ...(unit ? { Unit: unit, "Gate Stages": "code-generation", "Gate Scope": "unit-end" } : {}),
    Feedback: feedback,
  }, proj);
  appendAuditEntry("STAGE_REVISING", {
    Stage: "code-generation",
    ...(unit ? { Unit: unit } : {}),
    "Revision count": "1",
    Feedback: feedback,
  }, proj);
}

/** What `aidlc-jump.ts reopen` writes: a fresh attempt, marked as a reopen. */
function reopened(proj: string, unit: string, how: "jump" | "redo"): void {
  appendAuditEntry("GATE_REJECTED", {
    Stage: "code-generation",
    "Gate Stages": "code-generation",
    "Gate Scope": "unit-end",
    Unit: unit,
    Reopen: how,
    Feedback: `Reopened Code Generation for unit ${unit} at the person's request (/aidlc --stage code-generation).`,
  }, proj);
}

/**
 * The developer handoff as the conductor makes it: the brief the engine writes,
 * handed to the guard. Returns the guard's exit code and what it said.
 */
function guardAdmitsBuild(proj: string, unit: string | null = null): { code: number; stderr: string } {
  const brief = posture(proj, "brief", unit);
  expect(brief.status, brief.out).toBe(0);
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Task",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt: brief.out },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

function posture(
  proj: string,
  verb: "verify" | "begin" | "brief",
  unit: string | null = null,
): { status: number; out: string } {
  const result = spawnSync(BUN, [
    POSTURE, verb, ...(unit ? ["--unit", unit] : ["--stage-level"]), "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  // `brief` output is handed to the worker verbatim, so stdout stays on its own.
  return {
    status: result.status ?? -1,
    out: verb === "brief" ? (result.stdout ?? "") : `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

/** Approve the plan the way the person does: the engine asks, they pick the first choice. */
function approved(proj: string, unit: string | null = null): void {
  writePlan(proj, "", unit);
  const ask = next(proj);
  expect(ask.kind, JSON.stringify(ask)).toBe("ask");
  expect(ask.ask_type).toBe("plan-approval");
  reply(proj, "1");
  expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
  expect(next(proj).plan_approval).toEqual({ status: "approved" });
}

describe("a plan revised only for the person's own change request", () => {
  for (const policy of ["off", "relaxed"] as const) {
    test(`Guard Policy ${policy}: their change is built, with no second plan question`, () => {
      const proj = project(policy);
      approved(proj);
      // At the gate: "rename the test file to price.spec.js please".
      reply(proj, "Before I approve: rename the test file to price.spec.js please.");
      rejectedAtGate(proj, "Before I approve: rename the test file to price.spec.js please.");
      const revise = next(proj);
      expect(revise.kind, JSON.stringify(revise)).toBe("run-stage");
      expect(revise.plan_approval).toEqual({
        status: "revise",
        feedback: "Before I approve: rename the test file to price.spec.js please.",
      });
      // The agent revises the plan for exactly what they asked.
      writePlan(proj, "- [ ] Step 2: rename the test file to price.spec.js\n");
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval?.status, JSON.stringify(build)).toBe("approved");
      expect(build.ask_type).toBeUndefined();
      // The build runs: the guard admits the developer, and generation starts.
      const handed = guardAdmitsBuild(proj);
      expect(handed.code, handed.stderr).toBe(0);
      const verify = posture(proj, "verify");
      expect(verify.out).toContain('"execution_allowed": true');
      expect(posture(proj, "begin").status, posture(proj, "verify").out).toBe(0);
    });
  }

  test("strict: the plan question comes back for the revised plan", () => {
    const proj = project("strict");
    approved(proj);
    reply(proj, "rename the test file please");
    rejectedAtGate(proj, "rename the test file please");
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "rename the test file please" });
    writePlan(proj, "- [ ] Step 2: rename the test file\n");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
  });

  test("the person raised the plan-approval fence themselves: their question stands, even under off", () => {
    const proj = project("off", true);
    approved(proj);
    reply(proj, "rename the test file please");
    rejectedAtGate(proj, "rename the test file please");
    expect(next(proj).plan_approval?.status).toBe("revise");
    writePlan(proj, "- [ ] Step 2: rename the test file\n");
    expect(next(proj).ask_type).toBe("plan-approval");
  });

  test("a Redo is a fresh attempt: the plan comes back under off", () => {
    const proj = project("off");
    approved(proj);
    appendAuditEntry("STAGE_JUMPED", { Stage: "code-generation", Direction: "redo" }, proj);
    expect(next(proj).ask_type).toBe("plan-approval");
  });

  test("the revised build starts its steps fresh: the earlier build's ticks are cleared", () => {
    const proj = project("off");
    approved(proj);
    expect(posture(proj, "begin").status).toBe(0);
    // The earlier build ticked its step before the person asked for a change.
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8").replace("- [ ] Step 1:", "- [x] Step 1:"), "utf-8");
    reply(proj, "rename the test file please");
    rejectedAtGate(proj, "rename the test file please");
    expect(next(proj).plan_approval?.status).toBe("revise");
    writePlan(proj, "- [ ] Step 2: rename the test file\n");
    expect(next(proj).plan_approval?.status).toBe("approved");
    expect(posture(proj, "begin").status).toBe(0);
    expect(readFileSync(planPath(proj), "utf-8")).not.toContain("- [x]");
  });
});

describe("one Unit's own change request and its reopen", () => {
  const UNIT = "unit-2";

  test("off: the Unit's change is built with no second plan question", () => {
    const proj = unitProject("off", UNIT);
    approved(proj, UNIT);
    reply(proj, "use a lookup table in that unit please");
    rejectedAtGate(proj, "use a lookup table in that unit please", UNIT);
    const revise = next(proj);
    expect(revise.plan_approval).toEqual({ status: "revise", feedback: "use a lookup table in that unit please" });
    writePlan(proj, "- [ ] Step 2: use a lookup table\n", UNIT);
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval?.status, JSON.stringify(build)).toBe("approved");
    const handed = guardAdmitsBuild(proj, UNIT);
    expect(handed.code, handed.stderr).toBe(0);
  });

  // A jump back from Build and Test reopens this Unit's Code Generation. That is
  // a fresh attempt, not a change to the built result, so its plan comes back
  // for approval even under off: the engine asks for the rewritten plan.
  for (const how of ["jump", "redo"] as const) {
    test(`off: a one-Unit reopen (${how}) brings the plan question back`, () => {
      const proj = unitProject("off", UNIT);
      approved(proj, UNIT);
      reopened(proj, UNIT, how);
      // The reopened step writes its plan again, as any fresh attempt does.
      const reopen = next(proj);
      expect(reopen.kind, JSON.stringify(reopen)).toBe("run-stage");
      expect(reopen.plan_approval?.status).toBe("revise");
      writePlan(proj, "- [ ] Step 2: a different approach\n", UNIT);
      const asked = next(proj);
      expect(asked.kind, JSON.stringify(asked)).toBe("ask");
      expect(asked.ask_type).toBe("plan-approval");
    });
  }
});
