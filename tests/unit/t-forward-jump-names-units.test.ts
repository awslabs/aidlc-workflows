// covers: subcommand:aidlc-jump:execute, subcommand:aidlc-orchestrate:next
//
// t-forward-jump-names-units: in a Construction that runs one Unit at a time, a
// jump ahead past the Units' steps (to Build and Test, say) names, in the jump's
// own line, the Units whose steps it skips and the ones that start over, and is
// said once with the next step, like a jump back's line. Before, which Units it
// left unbuilt was only an instruction for the agent to pass on (#3530).

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, createTestProject, FIXTURES_DIR, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { forwardJumpNotice } from "../../dist/claude/.claude/tools/aidlc-jump.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject, readAuditShardEvents,
  reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The fixture's documents are not written for the stage checks.
process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const CHAT = "01995000-7a11-7000-8000-0000000000c3";
const TELL_AGENT = "tell the person in one line what was skipped";

// The host session's own markers stay out; `chat` names the person's chat.
function env(chat: boolean): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|CODEX|KIRO|COPILOT|AIDLC_SESSION)/.test(key)) out[key] = value;
  }
  return chat ? { ...out, AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" } : out;
}

// A solo Construction that runs one Unit at a time, on the first per-Unit stage.
function unitWalk(units: string[]): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Forward jump names units
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
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
${STAGES.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} \u2014 EXECUTE`).join("\n")}
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(p, units);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of units) writeFileSync(join(p, "src", `${unit}.ts`), "export const built = 1;\n");
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  hooksRunning(p);
  return p;
}

// This chat's hooks are running, so a line can wait for the next step.
function hooksRunning(p: string): void {
  const health = join(seededRecordDir(p), ".aidlc-engine", "hooks-health");
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "pre-tool-use.last"), new Date().toISOString());
}

// The Unit's documents for each step, with its completion receipt.
function finish(p: string, unit: string, steps: string[]): void {
  for (const slug of steps) {
    const stage = findStageBySlug(slug)!;
    const dir = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(dir, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${unit} ${name}\n`);
    if (stage.workspace_requires) {
      writeFileSync(join(dir, "source-manifest.json"), JSON.stringify({
        stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
      }));
    }
    const fingerprint = reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true });
    expect(fingerprint).not.toBeNull();
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
      "Artifact Fingerprint": fingerprint!,
    }, p);
  }
}

function tool(p: string, name: string, args: string[], chat = true) {
  const run = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    cwd: p, encoding: "utf-8", env: env(chat),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: `${name} ${args[0]}` }),
  });
  return { status: run.status, stdout: run.stdout, out: `${run.stdout}${run.stderr}` };
}

function next(p: string, args: string[] = [], chat = true): Record<string, unknown> {
  const run = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, args, { cwd: p, env: env(chat) });
  expect(run.directive, run.out).not.toBeNull();
  return run.directive!;
}

const notices = (step: Record<string, unknown>): string[] =>
  Array.isArray(step.change_notices) ? (step.change_notices as string[]) : [];
const jumps = (p: string) => readAuditShardEvents(p).filter((row) => row.event === "STAGE_JUMPED");

// The print's jump command, run as the agent runs it.
function runPrintedJump(p: string, print: Record<string, unknown>, chat = true) {
  expect(print.kind, JSON.stringify(print)).toBe("print");
  const command = /`[^`]*aidlc-jump\.ts (execute [^`]+)`/.exec(String(print.message))?.[1];
  expect(command, String(print.message)).toBeDefined();
  const ran = tool(p, "jump", command!.split(" "), chat);
  expect(ran.status, ran.out).toBe(0);
  return JSON.parse(ran.stdout) as { notice?: string; stages_skipped: string[] };
}

describe("t-forward-jump-names-units: the jump's own line names the Units it leaves unbuilt", () => {
  test("in a chat, the jump `next` makes names the Units whose steps it skips, said once with the step it lands on", () => {
    const p = unitWalk(["alpha", "beta", "gamma"]);
    finish(p, "alpha", STAGES);
    finish(p, "beta", STAGES.slice(0, 1));
    next(p);
    const step = next(p, ["--stage", "build-and-test"]);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("build-and-test");
    const line =
      "Moved to Build and Test. Skipped for unit beta: NFR Requirements, NFR Design, Infrastructure Design and " +
      "Code Generation. Skipped for unit gamma: Functional Design, NFR Requirements, NFR Design, Infrastructure " +
      "Design and Code Generation. Their files stay. You can go back to Functional Design any time.";
    expect(notices(step).filter((notice) => notice === line), JSON.stringify(notices(step))).toHaveLength(1);
    expect(JSON.stringify(step)).not.toContain(TELL_AGENT);
    expect(jumps(p)).toHaveLength(1);
  });

  test("in a chat, where Code Generation is the step, the printed jump's line rides the next step and its output carries none", () => {
    const p = unitWalk(["alpha", "beta"]);
    finish(p, "alpha", STAGES);
    finish(p, "beta", STAGES.slice(0, 4));
    expect(next(p)).toMatchObject({ stage: "code-generation", unit: "beta" });
    const print = next(p, ["--stage", "build-and-test"]);
    expect(String(print.message)).not.toContain("This skips the steps");
    expect(String(print.message)).not.toContain(TELL_AGENT);
    const ran = runPrintedJump(p, print);
    expect(ran.notice).toBeUndefined();
    const step = next(p);
    expect(step.stage).toBe("build-and-test");
    expect(notices(step)).toContain(
      "Moved to Build and Test. Skipped for unit beta: Code Generation. Their files stay. " +
        "You can go back to Code Generation any time.",
    );
    expect(notices(next(p)).filter((notice) => notice.startsWith("Moved to "))).toEqual([]);
  });

  test("with no chat, the jump's output carries the line", () => {
    const p = unitWalk(["alpha", "beta"]);
    finish(p, "alpha", STAGES);
    finish(p, "beta", STAGES.slice(0, 4));
    next(p, [], false);
    const ran = runPrintedJump(p, next(p, ["--stage", "build-and-test"], false), false);
    expect(ran.notice).toBe(
      "Moved to Build and Test. Skipped for unit beta: Code Generation. Their files stay. " +
        "You can go back to Code Generation any time.",
    );
  });

  test("a step already skipped for a Unit (it does not apply there) is not one the jump skips", () => {
    const p = unitWalk(["alpha", "beta"]);
    finish(p, "alpha", ["functional-design", "nfr-requirements", "nfr-design"]);
    appendAuditEntry("UNIT_SKIPPED", {
      Stage: "infrastructure-design", Unit: "alpha", Reason: "No infrastructure is needed.",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, "infrastructure-design", true, "alpha"),
    }, p);
    finish(p, "alpha", ["code-generation"]);
    finish(p, "beta", ["functional-design"]);
    next(p);
    const step = next(p, ["--stage", "build-and-test"]);
    expect(step.stage, JSON.stringify(step)).toBe("build-and-test");
    expect(notices(step)).toContain(
      "Moved to Build and Test. Skipped for unit beta: NFR Requirements, NFR Design, Infrastructure Design and " +
        "Code Generation. Their files stay. You can go back to NFR Requirements any time.",
    );
  });

  // With Unit checkpoints off, every Unit finished and the one late question
  // open, the jump skips those stages' approval: the line still names them.
  test("a jump from the late question, every Unit finished, names the stages whose approval it skips", () => {
    const p = unitWalk(["alpha", "beta"]);
    finish(p, "alpha", STAGES);
    finish(p, "beta", STAGES);
    next(p);
    const step = next(p, ["--stage", "build-and-test"]);
    expect(step.stage, JSON.stringify(step)).toBe("build-and-test");
    expect(notices(step)).toContain(
      "Moved to Build and Test; skipped Functional Design, NFR Requirements, NFR Design, Infrastructure Design and " +
        "Code Generation. You can go back to Functional Design any time.",
    );
  });

  test("Units with the same steps share a sentence, and a Unit that starts over is named with its approvals", () => {
    const stage = (slug: string) => findStageBySlug(slug)!;
    expect(forwardJumpNotice(stage("build-and-test"), [stage("functional-design"), stage("code-generation")], "code-generation", {
      skipped: [["beta", ["code-generation"]], ["gamma", ["functional-design", "code-generation"]], ["delta", ["code-generation"]]],
      redone: [],
    })).toBe(
      "Moved to Build and Test. Skipped for units beta and delta: Code Generation. Skipped for unit gamma: " +
        "Functional Design and Code Generation. Their files stay. You can go back to Functional Design any time.",
    );
    // No Unit sentence to say: the stage list names the per-Unit stages.
    expect(forwardJumpNotice(stage("build-and-test"), [stage("nfr-design"), stage("code-generation")], "code-generation", {
      skipped: [],
      redone: [],
    })).toBe("Moved to Build and Test; skipped NFR Design and Code Generation. You can go back to Code Generation any time.");
    expect(forwardJumpNotice(stage("code-generation"), [], "functional-design", {
      skipped: [],
      redone: [["alpha", ["code-generation"]]],
    })).toBe(
      "Moved to Code Generation. Starting over for unit alpha, which needs your approval again: Code Generation. " +
        "You can go back to Functional Design any time.",
    );
  });
});

describe("t-forward-jump-names-units: a forward jump outside a Unit walk", () => {
  test("keeps its line, and in a chat it waits for the next step instead of the jump's output", () => {
    const p = createOrchestrationTestProject();
    projects.push(p);
    seedStateFile(p, join(FIXTURES_DIR, "state-mid-ideation.md"));
    hooksRunning(p);
    const ran = tool(p, "jump", ["execute", "--target", "requirements-analysis", "--direction", "forward"]);
    expect(ran.status, ran.out).toBe(0);
    expect((JSON.parse(ran.stdout) as { notice?: string }).notice).toBeUndefined();
    const moved = notices(next(p)).filter((notice) => notice.startsWith("Moved to Requirements Analysis; skipped "));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toEndWith("You can go back to Feasibility & Constraints any time.");
  });
});
