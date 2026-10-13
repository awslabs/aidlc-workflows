// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// A stage the person asks to skip while it is in progress is skipped where it
// stands, whatever kind of stage it is, and the work goes on; on the last
// stage of the plan the work ends. The engine names the report that skips it
// and the agent runs it as named. A stage that must run for every piece of
// work (Requirements Analysis, Code Generation, Build and Test, ...) used to
// be sent to recompose, which refused it as already started and named a jump
// instead, or, on the last stage, only "It is the last stage on the plan."
//
// Mechanism: cli - spawns the shipped tools against temp projects created via
// intent-create; the stage is put in progress by a forward jump, as the engine
// does it.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { cleanupTestProject, runOrchestrateNext, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const env: Record<string, string | undefined> = { ...process.env };
for (const key of ["AIDLC_SCOPE_MAPPING", "AIDLC_SCOPE_GRID", "AIDLC_SCOPES_DIR", "AIDLC_COMPOSED_SCOPES_DIR", "AIDLC_STAGE_GRAPH"]) {
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
    env: { ...env, CLAUDE_PROJECT_DIR: proj },
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function stateFile(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const record = readdirSync(intents).find((name) => existsSync(join(intents, name, "aidlc-state.md")));
  return join(intents, String(record), "aidlc-state.md");
}

// A piece of work of `scope` whose `stage` the engine has started.
function startedAt(scope: string, stage: string): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", scope]);
  expect(created.status, created.out).toBe(0);
  const jumped = run(proj, "aidlc-jump.ts", ["execute", "--target", stage, "--direction", "forward", "--scope", scope]);
  expect(jumped.status, jumped.out).toBe(0);
  expect(readFileSync(stateFile(proj), "utf-8")).toContain(`- [-] ${stage} \u2014 EXECUTE`);
  return proj;
}

// The person asks to skip `stage`; the agent runs the one command the step
// names, as it names it. Returns the step's message.
function personSkips(proj: string, stage: string): string {
  const res = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, ["--skip", stage], {
    cwd: proj,
    env: { ...env, CLAUDE_PROJECT_DIR: proj },
  });
  const step = res.directive as { kind?: string; message?: string } | null;
  expect(step?.kind, res.out).toBe("print");
  const message = String(step?.message);
  expect(message).not.toContain("engine recompose");
  const named = /`[^`]*\.ts (report --stage ([a-z-]+) --result skipped --reason '([^']*)')`/.exec(message);
  expect(named, message).not.toBeNull();
  expect(named?.[2]).toBe(stage);
  const skipped = run(proj, "aidlc-orchestrate.ts", [
    "report", "--stage", stage, "--result", "skipped", "--reason", String(named?.[3]),
  ]);
  expect(skipped.status, skipped.out).toBe(0);
  expect(skipped.out).toContain('"kind":"done"');
  return message;
}

describe("a stage the person asks to skip while it is in progress is skipped", () => {
  for (const stage of ["requirements-analysis", "units-generation", "delivery-planning", "code-generation"]) {
    test(`${stage}: skipped where it stands, and the work goes on`, () => {
      const proj = startedAt("feature", stage);
      const message = personSkips(proj, stage);
      expect(message).toMatch(/"Skipped [A-Z][^."]*\. It can still be run on its own with `\/aidlc --stage <stage> --single`\."/);
      expect(message).toContain("re-run `next`");
      const after = readFileSync(stateFile(proj), "utf-8");
      expect(after).toContain(`- [S] ${stage} \u2014 EXECUTE`);
      expect(after).not.toContain(`- **Current Stage**: ${stage}\n`);
      expect(after).toContain("- **Status**: Running");
    });
  }

  test("the last stage on the plan is skipped and the work ends", () => {
    const proj = startedAt("poc", "build-and-test");
    const message = personSkips(proj, "build-and-test");
    expect(message).toContain('"Skipped Build and Test. It can still be run on its own with');
    expect(message).not.toContain("last stage on the plan");
    const after = readFileSync(stateFile(proj), "utf-8");
    expect(after).toContain("- [S] build-and-test \u2014 EXECUTE");
    expect(after).toContain("- **Status**: Completed");
  });

  test("a stage being revised after the person asked for changes is skipped the same way", () => {
    const proj = startedAt("feature", "requirements-analysis");
    const path = stateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace(
      "- [-] requirements-analysis \u2014 EXECUTE",
      "- [R] requirements-analysis \u2014 EXECUTE",
    ));
    personSkips(proj, "requirements-analysis");
    expect(readFileSync(path, "utf-8")).toContain("- [S] requirements-analysis \u2014 EXECUTE");
  });

  // What keeps a stage that must run from being dropped by the agent's own
  // reading of it: a skip the agent reports with its own reason is refused.
  test("a skip the agent reports on its own for a stage that must run is still refused", () => {
    const proj = startedAt("feature", "requirements-analysis");
    const before = readFileSync(stateFile(proj), "utf-8");
    const own = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "requirements-analysis", "--result", "skipped", "--reason", "nothing to analyse",
    ]);
    expect(own.out).toContain("only a CONDITIONAL stage can report skipped");
    expect(readFileSync(stateFile(proj), "utf-8")).toBe(before);
  });
});
