// covers: subcommand:aidlc-graph:compile, subcommand:aidlc-graph:topo, subcommand:aidlc-runner-gen:write, subcommand:aidlc-runner-gen:check, subcommand:aidlc-orchestrate:next, function:emitSingleRunStage
//
// t128 — a CUSTOM stage authored as a FILE becomes drivable through the
// generated runner with NO code change. This is the proof of the extensibility
// headline - "to add a stage, write a stage file": drop a stage `.md` into
// `aidlc-common/stages/<phase>/`, recompile the graph, run the stage-runner
// generator, and the new stage gets a spec-conformant `skills/aidlc-<slug>/`
// runner that drives `--single` end-to-end.
//
// Mechanism: cli — and necessarily SANDBOX-COPY cli, not shipped-tool cli.
// The subject of this test is a tree MUTATION - authoring a stage file,
// recompiling stage-graph.json + scope-grid.json, and generating a runner
// skill. Spawning the SHIPPED tools could modify dist/claude/.claude/. So the
// test runs the SANDBOX-COPY tools under <proj>/.claude/tools/, where every
// write lands in the throwaway temp tree and the shipped tree is never
// touched. Each assertion is observable only across that process boundary
// (CLI exit code, stdout topo/JSON directive, the generated SKILL.md bytes on
// disk), so each case spawns the real tool via the BUN runtime against the
// sandbox .ts path - the same `spawnSync(BUN, [TOOL, ...])` pattern t127
// credits.
//
// Sandbox: setupIntegrationProject({ noAidlcDocs, stripEnvScope }) (fixtures.ts)
// copies the shipped dist/claude/.claude/ into <proj>/.claude and strips
// AWS_AIDLC_DEFAULT_SCOPE so the explicit --scope wins. The custom slug is
// injected as EXECUTE into a dropped fixture scope (mirrors t60's
// scope-injection) so the stage is in-scope.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-graph.ts
//     compile - withAuditLock + writeFileAtomic of stage-graph.json +
//            scope-grid.json from the YAML (transposes the custom stage's
//            `scopes: [fixture-scope]` frontmatter into the grid).
//     compileStageGraph - keeps a pre-seeded {slug, number, name} row's pinned
//            number and auto-seeds a row for a new slug.
//     topo - topoSort(loadGraph()) one slug per line.
//   dist/claude/.claude/tools/aidlc-runner-gen.ts
//     handleWrite - one skills/aidlc-<slug>/SKILL.md per RUNNABLE
//            (non-init) compiled stage; name == dir (runnerDirName); body drives
//            `next --stage <slug> --single` (renderStageRunner).
//     handleCheck - drift guard: on-disk runner set == compiled
//            stage-slug set, exit 0 in sync / exit 1 + diff otherwise.
//   dist/claude/.claude/tools/aidlc-orchestrate.ts
//     handleNext (--single) -> emitSingleRunStage: builds the
//            lone run-stage directive from the graph node; the membership
//            check (subgraphForScope(scope)) reads the compiled grid,
//            so the custom slug is in-plan under fixture-scope because
//            compile transposed it in. Emits `{"kind":"run-stage","stage":...}`.
//
// The sandbox is rebuilt fresh per test (order-independent isolation); each
// tool exit code is asserted; and the directive JSON is PARSED (kind/stage
// assertions on the object, not a substring grep that could match the prose).

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  runOrchestrateNext,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;

const CUSTOM_SLUG = "custom-smoke-stage";

const projects: string[] = [];

afterEach(() => {
  for (const p of projects.splice(0)) cleanupTestProject(p);
});

/** Combined stdout+stderr + status of a SANDBOX-COPY tool invocation. */
function run(
  tool: string,
  args: string[],
): { out: string; status: number; stdout: string } {
  const res = spawnSync(BUN, [tool, ...args], { encoding: "utf-8" });
  return {
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    stdout: res.stdout ?? "",
    status: res.status ?? -1,
  };
}

/** Tool paths under one sandbox's copied .claude/tools (NOT the shipped tree). */
function tools(proj: string): {
  graph: string;
  gen: string;
  orch: string;
} {
  const t = join(proj, ".claude", "tools");
  return {
    graph: join(t, "aidlc-graph.ts"),
    gen: join(t, "aidlc-runner-gen.ts"),
    orch: join(t, "aidlc-orchestrate.ts"),
  };
}

/**
 * Build the full sandbox: the integration project, plus a dropped fixture
 * scope file, the authored custom stage file, and the pre-seeded {slug, number,
 * name} identity row in the SANDBOX stage-graph.json. Returns the
 * (registered-for-teardown) project dir.
 */
function buildSandbox(): string {
  const proj = setupIntegrationProject({
    noAidlcDocs: true,
    stripEnvScope: true,
  });
  projects.push(proj);
  const claude = join(proj, ".claude");

  // Drop a fixture scope .md so `fixture-scope` is a valid scope (validScopes()
  // derives from .claude/scopes/*.md presence). The custom stage declares
  // membership via `scopes:` frontmatter; at compile that transposes into the
  // scope-grid marking the custom stage EXECUTE under fixture-scope. Mirrors t60.
  mkdirSync(join(claude, "scopes"), { recursive: true });
  writeFileSync(
    join(claude, "scopes", "aidlc-fixture-scope.md"),
    `---
name: fixture-scope
depth: Minimal
keywords:
  - fixture-scope-keyword
description: Test-only scope dropped to prove the extensibility path end-to-end
---
# fixture-scope

Test-only scope authored to drive the custom stage via --single.
`,
  );

  // Author the custom stage file (operation phase, minimal valid frontmatter).
  // No produces/consumes edges so it slots in without disturbing the graph;
  // lead_agent is a real shipped agent so loadAgents() validation passes.
  // `scopes: [fixture-scope]` is the transpose source.
  mkdirSync(join(claude, "aidlc-common", "stages", "operation"), {
    recursive: true,
  });
  writeFileSync(
    join(claude, "aidlc-common", "stages", "operation", `${CUSTOM_SLUG}.md`),
    `---
slug: ${CUSTOM_SLUG}
phase: operation
execution: ALWAYS
condition: Always runs — a custom stage authored to prove the extensibility path
lead_agent: aidlc-operations-agent
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
scopes:
  - fixture-scope
inputs: None — this is a standalone custom stage with no upstream artifacts
outputs: None — the stage body is illustrative
---

# Custom Smoke Stage

## Steps

1. A custom stage authored as a file to prove the extensibility path.

## Sensors

## Learn
`,
  );

  // Pre-seed the new stage's {slug, number, name} row in the SANDBOX
  // stage-graph.json. The compiler (compileStageGraph) keeps a pre-seeded row's
  // pinned number and auto-seeds a new slug, so pre-seeding pins this fixture's
  // number. Use a 4.8 number (after the last operation stage 4.7) so it sorts
  // last.
  const graphJsonPath = join(claude, "tools", "data", "stage-graph.json");
  const graph = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as Array<
    Record<string, unknown>
  >;
  graph.push({
    slug: CUSTOM_SLUG,
    number: "4.8",
    name: "Custom Smoke Stage",
    phase: "operation",
  });
  writeFileSync(graphJsonPath, JSON.stringify(graph, null, 2));

  return proj;
}

function runnerPath(proj: string): string {
  return join(proj, ".claude", "skills", `aidlc-${CUSTOM_SLUG}`, "SKILL.md");
}

describe("t128 custom stage → drivable runner (migrated from t128-custom-runner.sh, plan 8)", () => {
  test("1: graph recompiles after authoring the custom stage file [.sh 1]", () => {
    const proj = buildSandbox();
    const { graph } = tools(proj);
    const r = run(graph, ["compile", "--project-dir", proj]);
    expect(r.status).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("2: the custom stage is in the compiled graph (topo lists it) [.sh 2]", () => {
    const proj = buildSandbox();
    const { graph } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    const topo = run(graph, ["topo", "--project-dir", proj]);
    expect(topo.status).toBe(0);
    expect(topo.out).toContain(CUSTOM_SLUG);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("3: the generator emits a runner SKILL.md for the custom stage [.sh 3]", () => {
    const proj = buildSandbox();
    const { graph, gen } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    const w = run(gen, ["write", "--project-dir", proj]);
    expect(w.status).toBe(0);
    expect(existsSync(runnerPath(proj))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("4: the custom runner's frontmatter name equals its dir [.sh 4]", () => {
    const proj = buildSandbox();
    const { graph, gen } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    expect(run(gen, ["write", "--project-dir", proj]).status).toBe(0);
    const body = readFileSync(runnerPath(proj), "utf-8");
    // Spec invariant (runner-gen runnerDirName): name == dir == aidlc-<slug>.
    const nameLine = body
      .split("\n")
      .find((l) => /^name:/.test(l));
    expect(nameLine).toBeDefined();
    const name = (nameLine as string).replace(/^name:\s*/, "").trim();
    expect(name).toBe(`aidlc-${CUSTOM_SLUG}`);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("5: the custom runner drives next --stage <slug> --single [.sh 5]", () => {
    const proj = buildSandbox();
    const { graph, gen } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    expect(run(gen, ["write", "--project-dir", proj]).status).toBe(0);
    const body = readFileSync(runnerPath(proj), "utf-8");
    // The literal `next --stage <slug> --single` appears in the runner body (the
    // --single signature handleWrite/isRunnerSkill keys on).
    expect(body).toContain(`next --stage ${CUSTOM_SLUG} --single`);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("6: stage-runner-drift check passes after regenerating (set == compiled list) [.sh 6]", () => {
    const proj = buildSandbox();
    const { graph, gen } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    expect(run(gen, ["write", "--project-dir", proj]).status).toBe(0);
    const c = run(gen, ["check", "--project-dir", proj]);
    expect(c.status).toBe(0);
    expect(c.out).toContain("in sync with the compiled stage graph");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("7: next --single drives the custom stage to a run-stage directive [.sh 7]", () => {
    const proj = buildSandbox();
    const { graph, orch } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    const single = runOrchestrateNext(orch, proj, [
      "--stage",
      CUSTOM_SLUG,
      "--single",
      "--scope",
      "fixture-scope",
    ]);
    expect(single.status).toBe(0);
    const directive = JSON.parse(single.stdout.trim()) as {
      kind: string;
      stage: string;
    };
    expect(directive.kind).toBe("run-stage");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("8: the run-stage directive targets the custom stage [.sh 8]", () => {
    const proj = buildSandbox();
    const { graph, orch } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    const single = runOrchestrateNext(orch, proj, [
      "--stage",
      CUSTOM_SLUG,
      "--single",
      "--scope",
      "fixture-scope",
    ]);
    expect(single.status).toBe(0);
    const directive = JSON.parse(single.stdout.trim()) as {
      kind: string;
      stage: string;
    };
    // The directive targets the custom slug (it is in-plan because compile
    // transposed `scopes: [fixture-scope]` into the grid).
    expect(directive.stage).toBe(CUSTOM_SLUG);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
