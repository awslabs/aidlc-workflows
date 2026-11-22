// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:recompose, function:plansReopeningFinishedWork
//
// Issue #3207. A piece of work is finished (Status Completed) on a plan that
// skipped stages after its last one (stock: poc, which ends at Build and Test),
// and the person asks for more of them ("I want to add the operation phase").
// Its own plan takes no more stages: recompose refuses finished work. The
// request reached the in-flight composer, which had nothing it could land, and
// recompose's refusal said to start a new workflow, though a plan that runs the
// stages after the last one reopens the work there (the scope change, #2261).
// Now `next compose` over finished work names the plans that reopen it, with
// the stages each runs, and the plan the person picks reopens it; recompose's
// refusal names the same plans for the stages it was asked to add. One helper
// decides both, from the predicate the scope change itself reads.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  cleanupTestProject,
  createOrchestrationTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const STATE = join(TOOLS, "aidlc-state.ts");
const UTILITY = join(TOOLS, "aidlc-utility.ts");
const ORCH = join(TOOLS, "aidlc-orchestrate.ts");
const LIB = join(TOOLS, "aidlc-lib.ts");

// No chat names itself to the tools: a run from inside a host's own chat would
// otherwise lend the tools that chat.
const env: Record<string, string | undefined> = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
for (const key of ["AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID"]) {
  delete env[key];
}

function run(tool: string, proj: string, args: string[]): { rc: number; out: string } {
  const res = spawnSync(process.execPath, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

type Directive = { kind: string; message?: string; stage?: string; narration?: string };

function next(proj: string, args: string[] = []): Directive {
  const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env });
  expect(res.directive, res.out).not.toBeNull();
  return res.directive as Directive;
}

function recordDir(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
}
const state = (proj: string): string => readFileSync(join(recordDir(proj), "aidlc-state.md"), "utf-8");
const field = (text: string, name: string): string =>
  new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(text)?.[1].trim() ?? "";

const created: string[] = [];
afterEach(() => {
  resetAidlcEnv();
  for (const proj of created.splice(0)) cleanupTestProject(proj);
});

/** A run to its end on `scope`, as complete-workflow leaves it: every stage the plan runs done, Status Completed. */
async function finished(scope: string): Promise<string> {
  const lib = await import(LIB) as typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts");
  const proj = createOrchestrationTestProject();
  created.push(proj);
  expect(run(UTILITY, proj, ["intent-create", "--scope", scope]).rc).toBe(0);
  const grid = lib.scopeGridOnProject(lib.loadScopeMapping()[scope], state(proj));
  const runs = lib.loadStageGraph().filter((stage) => grid[stage.slug] === "EXECUTE");
  const last = runs.at(-1)!;
  expect(run(STATE, proj, ["checkbox", ...runs.map((stage) => `${stage.slug}=completed`)]).rc).toBe(0);
  expect(run(STATE, proj, [
    "set", `Current Stage=${last.slug}`, "Status=Running", `Lifecycle Phase=${last.phase.toUpperCase()}`,
    "Next Stage=none", "In Progress=none", `Last Completed Stage=${last.slug}`,
  ]).rc).toBe(0);
  expect(run(STATE, proj, ["complete-workflow", last.slug]).rc).toBe(0);
  expect(field(state(proj), "Status")).toBe("Completed");
  expect(next(proj).kind).toBe("done");
  return proj;
}

const OPERATION = "Deployment Pipeline, Environment Provisioning, Deployment Execution, Observability Setup, " +
  "Incident Response, Performance Validation, Feedback & Optimization";

describe("t-add-stages-finished-work: more stages for finished work reopen it on a plan that runs them (#3207)", () => {
  test("compose over finished work names the plans that reopen it, with their stages, and dispatches no composer", async () => {
    const proj = await finished("poc");
    const before = state(proj);
    const step = next(proj, ["compose", "I want to add the operation phase"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    const said = step.message ?? "";
    expect(said).not.toContain("aidlc-composer-agent");
    expect(said).not.toContain("recompose");
    expect(said).not.toMatch(/start a new (workflow|intent)/i);
    expect(said).toContain("after Build and Test");
    expect(said).toContain(`feature (CI Pipeline, ${OPERATION})`);
    expect(said).toContain("express (Deployment Pipeline, Deployment Execution, Observability Setup)");
    expect(said).toContain("mvp (CI Pipeline)");
    // classic runs nothing after Build and Test, and poc is the work's own plan.
    expect(said).not.toContain("classic (");
    expect(said).not.toContain("poc (");
    // Their words beside the plan would start new work over finished work.
    expect(said).toContain("next --scope <plan>` (their words beside it would start new work)");
    // A stage they name with their pick goes with it as its own flag.
    expect(said).not.toContain("with nothing else");
    // Nothing moved.
    expect(state(proj)).toBe(before);
  });

  test("the plan they pick reopens the work at its first added stage within three engine calls", async () => {
    const proj = await finished("poc");
    next(proj, ["compose", "I want to add the operation phase"]);
    const switching = next(proj, ["--scope", "feature"]);
    expect(switching.kind, JSON.stringify(switching)).toBe("print");
    expect(switching.message).toContain("engine scope change --scope feature");
    expect(switching.message).toContain("re-run next to carry on with the work.");
    const changed = run(UTILITY, proj, ["scope-change", "--scope", "feature"]);
    expect(changed.rc, changed.out).toBe(0);
    const text = state(proj);
    expect(field(text, "Status")).toBe("Running");
    expect(field(text, "Current Stage")).toBe("ci-pipeline");
    const stage = next(proj);
    expect(stage.kind, JSON.stringify(stage)).toBe("run-stage");
    expect(stage.stage).toBe("ci-pipeline");
  });

  test("every plan named reopens the work at the first stage it lists", async () => {
    const utility = await import(UTILITY) as typeof import("../../dist/claude/.claude/tools/aidlc-utility.ts");
    const proj = await finished("poc");
    const plans = utility.plansReopeningFinishedWork(state(proj));
    expect(plans.map((plan) => plan.scope)).toEqual(
      ["bugfix", "enterprise", "express", "feature", "infra", "mvp", "refactor", "security-patch", "workshop"],
    );
    const said = next(proj, ["compose"]).message ?? "";
    for (const { scope, stages } of plans) {
      expect(said, scope).toContain(`${scope} (${stages.map((stage) => stage.name).join(", ")})`);
      const each = await finished("poc");
      expect(run(UTILITY, each, ["scope-change", "--scope", scope]).rc, scope).toBe(0);
      expect(field(state(each), "Status"), scope).toBe("Running");
      expect(field(state(each), "Current Stage"), scope).toBe(stages[0].slug);
    }
  });

  test("adding stages to finished work names the plans that run them after the last stage, never new work", async () => {
    const proj = await finished("poc");
    const before = state(proj);
    const step = next(proj, ["--add", "deployment-pipeline,deployment-execution"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain("engine recompose --add deployment-pipeline,deployment-execution");
    const refused = run(UTILITY, proj, ["recompose", "--add", "deployment-pipeline,deployment-execution"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("this work is finished");
    expect(refused.out).toContain("after Build and Test");
    expect(refused.out).toContain("bugfix, enterprise, express, feature, infra, refactor, security-patch, workshop");
    expect(refused.out).toContain("--scope <plan>");
    expect(refused.out).not.toMatch(/start a new (workflow|intent)/i);
    expect(state(proj)).toBe(before);
  });

  test("a jump to a stage the finished plan skips is refused with the same plans", async () => {
    const proj = await finished("poc");
    const step = next(proj, ["--stage", "observability-setup"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain("engine recompose --add observability-setup");
    const refused = run(UTILITY, proj, ["recompose", "--add", "observability-setup", "--reason", "jump to observability-setup"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("enterprise, express, feature, infra, workshop");
    expect(refused.out).not.toMatch(/start a new (workflow|intent)/i);
  });

  test("finished work no plan runs anything after says so, and its refusal names no plan", async () => {
    const proj = await finished("feature");
    const step = next(proj, ["compose", "add another stage"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).not.toContain("aidlc-composer-agent");
    expect(step.message).toContain("no plan runs a stage after Feedback & Optimization");
    expect(step.message).not.toContain("next --scope <plan>");
    // The way on is new work, offered.
    expect(step.message).toContain("next --new-intent");
    const refused = run(UTILITY, proj, ["recompose", "--skip", "feedback-optimization"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("this work is finished");
    expect(refused.out).not.toContain("--scope <plan>");
  });

  // A reshape answer to a routing question asked while the work ran, given
  // after it finished, composes over finished work the same way.
  test("a routing question's reshape answer over finished work takes the same step", async () => {
    const store = await import(join(TOOLS, "aidlc-question-store.ts")) as typeof import("../../dist/claude/.claude/tools/aidlc-question-store.ts");
    const proj = await finished("poc");
    const record = recordDir(proj).split(/[\\/]/).at(-1)!;
    const rows = JSON.parse(readFileSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8")) as
      Array<{ dirName: string; uuid?: string }>;
    const uuid = rows.find((row) => row.dirName === record)?.uuid ?? "";
    const asked = store.saveQuestion(proj, "I want to add the operation phase", "", "routing", {
      space: "default",
      targets: [{ intent: record, uuid }],
    });
    const step = next(proj, ["compose", "--request", asked.id]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).not.toContain("aidlc-composer-agent");
    expect(step.message).toContain(`feature (CI Pipeline, ${OPERATION})`);
  });

  test("running work still gets the in-flight composer", async () => {
    const proj = await finished("poc");
    expect(run(STATE, proj, ["set", "Status=Running"]).rc).toBe(0);
    const step = next(proj, ["compose", "I want to add the operation phase"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain("aidlc-composer-agent");
    expect(step.message).toContain("RUNNING workflow");
  });
});
