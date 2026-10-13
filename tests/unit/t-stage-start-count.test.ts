// covers: subcommand:aidlc-orchestrate:next
//
// Refs #1217. Each stage start says which stage of how many this is: "(stage 3
// of 9)" after the stage's name, on every tool, since every tool relays the
// line. N and M are the stages the work runs after Initialization, the count
// the plan offer showed ("9 stages") and the progress line after an approval
// uses, read from one list so the lines never disagree. A stage the person
// skipped is left out of the count, as the progress line leaves it out.
//
// Mechanism: cli - spawns the shipped tools against temp projects created via
// intent-create; a forward jump moves the work, and the stages before the
// target are then marked finished so the stage starts mid-plan.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { cleanupTestProject, runOrchestrateNext, setupIntegrationProject } from "../harness/fixtures.ts";
import { expectedStages, sourceStages } from "../harness/scope-run.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// No chat names itself to the tools, so the step's line is the stage's alone.
const env: Record<string, string | undefined> = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
for (const key of [
  "AIDLC_SCOPE_MAPPING", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID",
]) {
  delete env[key];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function run(proj: string, tool: string, args: string[]): void {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
    cwd: proj,
  });
  expect(res.status, `${res.stdout ?? ""}${res.stderr ?? ""}`).toBe(0);
}

// The stages a scope runs after Initialization on a folder with no code, from
// the source: the count the plan offer shows the person.
function planOf(scope: string): string[] {
  const init = new Set(sourceStages().filter((s) => s.phase === "initialization").map((s) => s.slug));
  return expectedStages(scope, false).filter((slug) => !init.has(slug));
}

// The line said when `stage` starts, with every stage before it finished.
function startLine(scope: string, stage?: string): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  run(proj, "aidlc-utility.ts", ["intent-create", "--scope", scope]);
  if (stage) {
    run(proj, "aidlc-jump.ts", ["execute", "--target", stage, "--direction", "forward"]);
    const before = planOf(scope).slice(0, planOf(scope).indexOf(stage));
    run(proj, "aidlc-state.ts", ["checkbox", ...before.map((slug) => `${slug}=completed`)]);
  }
  const step = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, [], { env });
  expect(step.directive?.kind, step.out).toBe("run-stage");
  if (stage) expect(step.directive?.stage, step.out).toBe(stage);
  return String(step.directive?.narration ?? "");
}

describe("each stage start says which stage of how many", () => {
  test("the first stage is stage 1 of the stages the plan offer counted", () => {
    const total = planOf("feature").length;
    expect(startLine("feature")).toBe(
      `Starting the feature plan for this project. First step is Intent Capture & Framing (stage 1 of ${total}), ` +
        "and I will stop for your review before anything is final.",
    );
  });

  test("a later stage says its place in the plan", () => {
    const plan = planOf("feature");
    expect(startLine("feature", "requirements-analysis")).toBe(
      `Now working on Requirements Analysis (stage ${plan.indexOf("requirements-analysis") + 1} of ${plan.length}), ` +
        "wearing the product manager hat.",
    );
  });

  test("a stage handed to a specialist says it too", () => {
    const plan = planOf("feature");
    expect(startLine("feature", "practices-discovery")).toBe(
      `Bringing in the release engineer to work on Practices Discovery ` +
        `(stage ${plan.indexOf("practices-discovery") + 1} of ${plan.length}).`,
    );
  });

  test("the first Bolt says it on its first step", () => {
    const plan = planOf("feature");
    expect(startLine("feature", "functional-design")).toBe(
      "Starting the first Bolt now: one build pass over the code, tests and checks for a piece of the work. " +
        `First step is Functional Design (stage ${plan.indexOf("functional-design") + 1} of ${plan.length}).`,
    );
  });

  test("Code Generation on a plan with no Units says it with its code plan", () => {
    const plan = planOf("bugfix");
    expect(startLine("bugfix", "code-generation")).toBe(
      `Writing the code plan for Code Generation (stage ${plan.indexOf("code-generation") + 1} of ${plan.length}) ` +
        "first; the developer builds from it.",
    );
  });

  test("Code Generation run on its own outside the plan says no place in the plan", () => {
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    tempDirs.push(proj);
    run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "feature"]);
    const step = runOrchestrateNext(
      join(proj, ".claude", "tools", "aidlc-orchestrate.ts"),
      proj,
      ["--stage", "code-generation", "--single"],
      { env },
    );
    expect(step.directive?.single, step.out).toBe(true);
    expect(String(step.directive?.narration ?? "")).toBe(
      "Writing the code plan for Code Generation first; the developer builds from it.",
    );
  });

  test("stages the person skipped leave the count", () => {
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    tempDirs.push(proj);
    run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "bugfix"]);
    run(proj, "aidlc-jump.ts", ["execute", "--target", "build-and-test", "--direction", "forward"]);
    const step = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, [], { env });
    const plan = planOf("bugfix");
    const left = plan.length - plan.indexOf("build-and-test");
    expect(String(step.directive?.narration ?? "")).toBe(
      `Now working on Build and Test (stage 1 of ${left}), wearing the quality engineer hat.`,
    );
  });
});
