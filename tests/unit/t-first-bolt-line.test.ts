// covers: subcommand:aidlc-orchestrate:next
//
// The first Construction step's line. "Starting the first Bolt now: one build
// pass over the code, tests and checks for a piece of the work." is said where
// the plan builds code in Units. A plan whose Construction builds no code
// (stock infra, or a plan made for an analysis that skips Code Generation) is
// not starting a build pass, and a plan with no Units (refactor,
// security-patch) has no Bolt, so their first Construction step gets the
// ordinary line instead.
//
// Mechanism: cli - spawns the shipped tools against temp projects created via
// intent-create, then a forward jump to the first Construction stage.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { cleanupTestProject, runOrchestrateNext, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BOLT_LINE = "Starting the first Bolt now: one build pass over the code, tests and checks for a piece of the work.";

// No chat names itself to the tools: the jump's own line then stays in its
// output, and the step's line is the stage's alone.
const env: Record<string, string | undefined> = { ...process.env };
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

function run(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function firstConstructionLine(createArgs: string[], first: string): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  const created = run(proj, "aidlc-utility.ts", ["intent-create", ...createArgs]);
  expect(created.status, created.out).toBe(0);
  const jumped = run(proj, "aidlc-jump.ts", ["execute", "--target", first, "--direction", "forward"]);
  expect(jumped.status, jumped.out).toBe(0);
  const step = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, [], { env });
  expect(step.directive?.kind, step.out).toBe("run-stage");
  expect(step.directive?.stage, step.out).toBe(first);
  return String(step.directive?.narration ?? "");
}

describe("the first Construction step names a Bolt only where code is built", () => {
  test("stock infra builds no code: its first Construction step gets the ordinary line", () => {
    const line = firstConstructionLine(["--scope", "infra"], "nfr-requirements");
    expect(line).not.toContain("Bolt");
    expect(line).toBe("Now working on NFR Requirements (stage 1 of 8), wearing the architect hat.");
  });

  test("a plan made for an analysis, with Code Generation skipped, gets the ordinary line", () => {
    const line = firstConstructionLine([
      "--scope", "security-patch",
      "--skip", "code-generation,build-and-test,deployment-pipeline,deployment-execution",
      "--label", "analysis plan",
    ], "nfr-requirements");
    expect(line).not.toContain("Bolt");
    expect(line).toBe("Now working on NFR Requirements (stage 1 of 1), wearing the architect hat.");
  });

  test("a plan that builds code in Units still starts the first Bolt", () => {
    expect(firstConstructionLine(["--scope", "feature"], "functional-design"))
      .toBe(`${BOLT_LINE} First step is Functional Design (stage 1 of 14).`);
  });

  test("a plan that builds code without Units starts no Bolt: security-patch gets the ordinary line", () => {
    const line = firstConstructionLine(["--scope", "security-patch"], "nfr-requirements");
    expect(line).not.toContain("Bolt");
    expect(line).toBe("Now working on NFR Requirements (stage 1 of 5), wearing the architect hat.");
  });

  test("refactor, Code Generation without Units, gets the ordinary line too", () => {
    const line = firstConstructionLine(["--scope", "refactor"], "functional-design");
    expect(line).not.toContain("Bolt");
    expect(line).toBe("Now working on Functional Design (stage 1 of 5), wearing the architect hat.");
  });
});
