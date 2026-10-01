// covers: function:routeCodeGenerationPlanApproval, function:recordPlanApprovalAskReply
//
// One approval starts the build, in the shapes a real install produces when
// Code Generation's rules do not fit beside its step:
//
//   - a stock Kiro install whose first stage is Code Generation: that step
//     carries the conductor's persona, so even the stock rules travel as one
//     separate part (part 1 of 1), and the person's "1" is read by Kiro's own
//     userPromptSubmit hook;
//   - one Unit under classic scope, unit-major Construction, Guard Policy off;
//   - under a relaxed Guard Policy, a plan edited after approval keeps
//     building through its rule parts, as it does when the rules fit.
//
// Each drives the real engine one call at a time, as the agent does, and
// checks the answer is still recorded when the build arrives.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const SESSION = "01995000-7a11-7000-8000-000000000021";

/** The directive fields these cases read. */
interface Emitted {
  kind: string;
  ask_type?: string;
  part?: number;
  parts?: number;
  receipt?: string;
  plan_approval?: { status?: string };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function stageDir(proj: string, unit: string | null): string {
  return join(seededRecordDir(proj), "construction", ...(unit ? [unit] : []), "code-generation");
}

function writePlan(proj: string, unit: string | null, extra = ""): void {
  mkdirSync(stageDir(proj, unit), { recursive: true });
  writeFileSync(
    join(stageDir(proj, unit), "code-generation-plan.md"),
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

function answer(proj: string, unit: string | null): string {
  const text = readFileSync(join(stageDir(proj, unit), "code-generation-questions.md"), "utf-8");
  return /^\[Answer\]:.*$/m.exec(text)?.[0] ?? "(none)";
}

function approvalRows(proj: string): number {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8"))
    .join("\n").match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)?.length ?? 0;
}

/** Run one of a project's tools, from the given tree; exit 0 required. */
function tool(proj: string, tools: string, [name, ...args]: string[], input?: string): string {
  const result = spawnSync(BUN, [join(tools, name), ...args], {
    cwd: proj,
    ...(input !== undefined ? { input } : {}),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout ?? "";
}

/** One engine call, as the agent makes it: a rule part is not followed. */
function engine(proj: string, tools: string, args: string[]): Emitted {
  return JSON.parse(tool(proj, tools, ["aidlc-orchestrate.ts", ...args, "--project-dir", proj]).trim()) as Emitted;
}

/** Each `continue` the part names, to the directive after the last part. */
function followParts(proj: string, tools: string, from: Emitted): Emitted {
  let directive = from;
  for (let i = 0; directive.kind === "load-steering" && i < 20; i++) {
    directive = engine(proj, tools, ["continue", String(directive.receipt)]);
  }
  return directive;
}

/** The person's reply, read by the human-turn hook. */
function reply(proj: string, prompt: string): void {
  tool(proj, join(AIDLC_SRC, "tools"), ["aidlc.ts", "engine", "hook", "record-human-turn"], JSON.stringify({
    hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt,
  }));
}

// A team whose memory files grew: Code Generation's rules no longer fit beside
// its step, so the step reaches the agent after numbered rule parts.
function withRulesInParts(proj: string): string {
  const line = "- Keep every exported function documented with its failure modes and its callers.\n";
  appendFileSync(
    join(proj, "aidlc", "spaces", "default", "memory", "project.md"),
    `\n## Team practices\n\n${line.repeat(500)}`,
    "utf-8",
  );
  return proj;
}

describe("one approval starts the build however the rules travel", () => {
  test("a stock Kiro install whose rules come as one separate part", () => {
    const proj = createTestProject();
    created.push(proj);
    cpSync(join(REPO_ROOT, "dist", "kiro", "aidlc"), join(proj, "aidlc"), { recursive: true });
    cpSync(join(REPO_ROOT, "dist", "kiro", ".kiro"), join(proj, ".kiro"), { recursive: true });
    // A quick task that goes straight to Code Generation.
    writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Add a --shout option to greet.py
- **Project Type**: Brownfield
- **Scope**: poc
- **State Version**: 8

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Minimal
- **Test Strategy**: Minimal
- **Guard Policy**: off (from scope poc)
- **Plan Approval**: on (set by you)

## Stage Progress

### INITIALIZATION PHASE
- [x] workspace-scaffold \u2014 EXECUTE
- [x] workspace-detection \u2014 EXECUTE
- [x] state-init \u2014 EXECUTE

### CONSTRUCTION PHASE
- [-] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`, "utf-8");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
    const kiro = join(proj, ".kiro", "tools");

    writePlan(proj, null);
    const ask = engine(proj, kiro, ["next"]);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    // The person types "1" in Kiro CLI chat; its userPromptSubmit hook reads it.
    tool(proj, kiro, ["aidlc.ts", "engine", "adapter", "kiro", "verb-intercept"], JSON.stringify({
      hook_event_name: "userPromptSubmit", cwd: proj, session_id: SESSION, prompt: "1",
    }));
    expect(answer(proj, null)).toBe("[Answer]: A. Approve Plan");

    const part = engine(proj, kiro, ["next"]);
    expect(part, JSON.stringify(part)).toMatchObject({ kind: "load-steering", part: 1, parts: 1 });
    const build = engine(proj, kiro, ["continue", String(part.receipt)]);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(answer(proj, null)).toBe("[Answer]: A. Approve Plan");
    tool(proj, kiro, ["aidlc-testing-posture.ts", "brief", "--stage-level", "--project-dir", proj]);
    expect(approvalRows(proj)).toBe(1);
  });

  test("one Unit under classic scope, unit-major Construction, Guard Policy off", () => {
    const unit = "u1-walking-skeleton";
    const proj = withRulesInParts(createOrchestrationTestProject());
    created.push(proj);
    writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: One-Unit build
- **Project Type**: Greenfield
- **Scope**: classic
- **State Version**: 8
- **Skeleton Stance**: off

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
- **Guard Policy**: off (from scope classic)
- **Plan Approval**: on (from scope classic)

## Runtime State
- **Construction Iteration**: unit-major
- **Construction Execution**: serial
- **Unit Ownership**: solo

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
    const tools = join(AIDLC_SRC, "tools");

    writePlan(proj, unit);
    const ask = followParts(proj, tools, engine(proj, tools, ["next"]));
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    reply(proj, "1");
    expect(answer(proj, unit)).toBe("[Answer]: A. Approve Plan");

    const first = engine(proj, tools, ["next"]);
    expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", part: 1 });
    expect(first.parts).toBeGreaterThan(1);
    const build = followParts(proj, tools, first);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(answer(proj, unit)).toBe("[Answer]: A. Approve Plan");
    tool(proj, tools, ["aidlc-testing-posture.ts", "brief", "--unit", unit, "--project-dir", proj]);
    expect(approvalRows(proj)).toBe(1);
  });

  test("under a relaxed Guard Policy, a plan edited after approval keeps building through its rule parts", () => {
    const proj = withRulesInParts(createOrchestrationTestProject());
    created.push(proj);
    const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
      .replace("- **Scope**: feature", "- **Scope**: poc")
      .replace(
        "- **Change Control**: strict (from scope feature)",
        "- **Guard Policy**: relaxed (from scope poc)\n- **Plan Approval**: on (set by you)",
      )
      .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
    writeFileSync(seededStateFile(proj), state, "utf-8");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
    const tools = join(AIDLC_SRC, "tools");

    writePlan(proj, null);
    expect(followParts(proj, tools, engine(proj, tools, ["next"])).kind).toBe("ask");
    reply(proj, "1");
    writePlan(proj, null, "- [ ] Step 2: add a fast path\n");
    const first = engine(proj, tools, ["next"]);
    expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", part: 1 });
    const build = followParts(proj, tools, first);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });
});
