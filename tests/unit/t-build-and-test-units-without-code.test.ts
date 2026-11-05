// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next
//
// t-build-and-test-units-without-code: when some Units have no Code Generation
// output, Build and Test says which, in one line, once: with its gate, or with
// the approval when the gate was opened and approved in one step (a typed
// "approve" before the gate was shown), so the person never approves Build and
// Test, or completes the work, without hearing it (#3531). Never a gate: the
// approval goes through as before.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv, runOrchestrateNext, seedAidlcMemory, seedBoltDag,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { artifactFilename, findStageBySlug, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { unitsWithoutInputsNotice } from "../../dist/claude/.claude/tools/aidlc-state.ts";

// The fixture's documents are not written for the stage checks.
process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const CHAT = "01995000-7a11-7000-8000-0000000000d4";
const LINE = "Code Generation has not finished for units beta and gamma, so their code may be missing from Build and Test.";

// The host session's own markers stay out; commands run in the person's chat.
function env(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|CODEX|KIRO|COPILOT|AIDLC_SESSION)/.test(key)) out[key] = value;
  }
  return { ...out, AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
}

// Construction one Unit at a time, past the Units' steps and on Build and
// Test, with Build and Test's documents written; `built` have Code Generation's,
// and `planned` only its code plan.
function atBuildAndTest(built: string[], scope = "feature", planned: string[] = []): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Build and Test units without code
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: ${scope}
- **State Version**: 8
- **Unit Ownership**: solo
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Autonomy Mode**: gated
- **Review Override**: none
- **Change Control**: strict
- **Summary Confirmation**: off (set by you)
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${STAGES.map((stage) => `- [x] ${stage} \u2014 EXECUTE`).join("\n")}
- [-] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: build-and-test
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta", "gamma"]);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: scope }, p);
  appendAuditEntry("STAGE_STARTED", { Stage: "build-and-test", Agent: "aidlc-quality-agent" }, p);
  const health = join(seededRecordDir(p), ".aidlc-engine", "hooks-health");
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "pre-tool-use.last"), new Date().toISOString());
  const codeGeneration = findStageBySlug("code-generation")!;
  for (const unit of built) {
    const dir = join(seededRecordDir(p), "construction", unit, "code-generation");
    mkdirSync(dir, { recursive: true });
    for (const name of codeGeneration.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${unit} ${name}\n`);
  }
  for (const unit of planned) {
    const dir = join(seededRecordDir(p), "construction", unit, "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, artifactFilename("code-generation-plan")), `# ${unit} plan\n`);
  }
  const buildAndTest = findStageBySlug("build-and-test")!;
  const dir = join(seededRecordDir(p), "construction", "build-and-test");
  mkdirSync(dir, { recursive: true });
  for (const name of buildAndTest.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
  return p;
}

function report(p: string, args: string[]): Record<string, unknown> {
  const run = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), "report", ...args, "--project-dir", p], {
    cwd: p, encoding: "utf-8", env: env(),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "report" }),
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  return JSON.parse(run.stdout.trim()) as Record<string, unknown>;
}

// The person types their reply in the chat, as the prompt hook records it.
function says(p: string, prompt: string): void {
  const hookEnv = { ...env(), AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  const run = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: p, encoding: "utf-8", env: hookEnv,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt }),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "human turn" }),
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
}

const lines = (directive: Record<string, unknown>): string[] => String(directive.narration ?? "").split("\n");
const approvedBuildAndTest = (p: string) =>
  readAuditShardEvents(p).filter((row) => row.event === "GATE_APPROVED" && row.block.includes("**Stage**: build-and-test"));

describe("t-build-and-test-units-without-code: Build and Test names the Units with no code, once", () => {
  test("the gate names the Units with no Code Generation output", () => {
    const p = atBuildAndTest(["alpha"]);
    const gate = report(p, ["--result", "awaiting-approval"]);
    expect(lines(gate), JSON.stringify(gate)).toContain(LINE);
    expect(lines(gate)[0]).toStartWith("Build and Test is ready for your review.");
  });

  test("approving at the gate that said it does not say it again, and the approval goes through", () => {
    const p = atBuildAndTest(["alpha"]);
    report(p, ["--result", "awaiting-approval"]);
    says(p, "approve");
    const done = report(p, ["--result", "approved", "--user-input", "Approve"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(lines(done)).not.toContain(LINE);
    expect(approvedBuildAndTest(p)).toHaveLength(1);
  });

  test("the gate shown again says it", () => {
    const p = atBuildAndTest(["alpha"]);
    report(p, ["--result", "awaiting-approval"]);
    const shown = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], { cwd: p, env: env() }).directive!;
    expect(shown, JSON.stringify(shown)).toMatchObject({ kind: "run-stage", stage: "build-and-test", gate_only: true });
    expect(lines(shown)).toContain(LINE);
  });

  test("a typed approve that opens and approves Build and Test at once says it with the approval", () => {
    const p = atBuildAndTest(["alpha"]);
    says(p, "approve");
    const done = report(p, ["--result", "approved", "--stage", "build-and-test", "--user-input", "Approve"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(String(done.reason)).toContain("gate-start + approve");
    expect(lines(done)[0]).toBe(LINE);
    expect(approvedBuildAndTest(p)).toHaveLength(1);
  });

  test("a typed approve that opens Build and Test's gate and asks to stop for now says it with the pause", () => {
    const p = atBuildAndTest(["alpha"]);
    says(p, "approve, and let's stop here for today");
    const parked = report(p, ["--result", "approved", "--stage", "build-and-test", "--user-input", "Approve", "--park"]);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(lines(parked)[0]).toBe(LINE);
    expect(approvedBuildAndTest(p)).toHaveLength(1);
  });

  test("classic: the approval that completes the work says it", () => {
    const p = atBuildAndTest(["alpha"], "classic");
    says(p, "approve");
    const done = report(p, ["--result", "approved", "--stage", "build-and-test", "--user-input", "Approve"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(done.narration).toBe(LINE);
  });

  test("one Unit missing, and none built, are said in the same plain words", () => {
    const one = atBuildAndTest(["alpha", "gamma"]);
    expect(lines(report(one, ["--result", "awaiting-approval"]))).toContain(
      "Code Generation has not finished for unit beta, so its code may be missing from Build and Test.",
    );
    const none = atBuildAndTest([]);
    expect(lines(report(none, ["--result", "awaiting-approval"]))).toContain(
      "Code Generation has not finished for units alpha, beta and gamma, so their code may be missing from Build and Test.",
    );
  });

  test("a Unit with only its code plan has not finished, and the Units come in their own order", () => {
    const p = atBuildAndTest(["alpha"], "feature", ["beta"]);
    expect(lines(report(p, ["--result", "awaiting-approval"]))).toContain(LINE);
  });

  // A design stage runs for a Unit only when its condition holds, so a Unit
  // with none of its documents is the plan, not a gap: the Operation stages
  // that read them say nothing, and Build and Test is the one that says it.
  test("a stage reading a design stage some Units skip on its own condition says nothing", () => {
    const p = atBuildAndTest(["alpha"]);
    for (const slug of ["deployment-pipeline", "environment-provisioning", "observability-setup", "performance-validation"]) {
      expect(unitsWithoutInputsNotice(p, findStageBySlug(slug)!, null), slug).toBeNull();
    }
    expect(unitsWithoutInputsNotice(p, findStageBySlug("build-and-test")!, null)).toBe(LINE);
    expect(unitsWithoutInputsNotice(p, findStageBySlug("ci-pipeline")!, null)).toBeNull();
  });

  test("every Unit built: nothing is said", () => {
    const p = atBuildAndTest(["alpha", "beta", "gamma"]);
    const gate = report(p, ["--result", "awaiting-approval"]);
    expect(String(gate.narration ?? "")).not.toContain("has not finished");
    expect(String(gate.narration ?? "")).not.toContain("may be missing");
  });
});
