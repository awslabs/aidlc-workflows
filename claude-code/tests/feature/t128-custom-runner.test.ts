// covers: subcommand:aidlc-graph:compile, subcommand:aidlc-graph:topo, subcommand:aidlc-runner-gen:write, subcommand:aidlc-runner-gen:check, subcommand:aidlc-orchestrate:next, function:emitSingleRunStage
//
// t128 — a CUSTOM stage authored as a FILE becomes drivable through the
// generated runner with NO code change (v0.6.0 Wave 3 milestone 14). Migrated from
// tests/feature/t128-custom-runner.sh (TAP plan 8). This is the proof of the
// extensibility headline — "to add a stage, write a stage file": drop a stage
// `.md` into `aidlc-common/stages/<phase>/`, recompile the graph, run the
// stage-runner generator, and the new stage gets a spec-conformant
// `skills/aidlc-<slug>/` runner that drives `--single` end-to-end.
//
// Mechanism: cli — and necessarily SANDBOX-COPY cli, not shipped-tool cli.
// EVERY aidlc-graph / aidlc-runner-gen / aidlc-orchestrate tool resolves its
// stages tree, data/stage-graph.json, data/scope-grid.json, and skills/ dir
// RELATIVE TO ITS OWN FILE LOCATION (aidlc-graph.ts :144-146 __FILE_DIR /
// DATA_DIR / DEFAULT_STAGES_DIR; aidlc-runner-gen.ts :66-67 TOOLS_DIR /
// SKILLS_DIR), NOT relative to --project-dir (which only locates the audit
// lock). The subject of this test is a tree MUTATION — authoring a stage
// file, recompiling stage-graph.json + scope-grid.json, and generating a
// runner skill. Spawning the SHIPPED tools would corrupt
// dist/claude/.claude/. So, exactly like the .sh, the twin runs the
// SANDBOX-COPY tools under <proj>/.claude/tools/, where every write lands in
// the throwaway temp tree and the shipped tree is never touched. Each
// assertion is observable only across that process boundary (CLI exit code,
// stdout topo/JSON directive, the generated SKILL.md bytes on disk), so each
// case spawns the real tool via the BUN runtime against the sandbox .ts path
// — the same `spawnSync(BUN, [TOOL, ...])` pattern t104.cli / t127 credit.
//
// Sandbox: setupIntegrationProject({ noAidlcDocs, stripEnvScope }) — the TS
// port of `setup_integration_project --no-aidlc-docs --strip-env-scope`
// (fixtures.ts :269) — copies the shipped dist/claude/.claude/ into
// <proj>/.claude and strips AWS_AIDLC_DEFAULT_SCOPE so the explicit --scope
// wins. The custom slug is injected as EXECUTE into a dropped fixture scope
// (mirrors t60's scope-injection) so the stage is in-scope.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-graph.ts
//     :1293 compile — withAuditLock + writeFileAtomic of stage-graph.json +
//            scope-grid.json from the YAML (transposes the custom stage's
//            `scopes: [fixture-scope]` frontmatter into the grid).
//     :1013 compileStageGraph — REQUIRES a pre-seeded {slug, number, name}
//            row (:1083 "not found in stage-graph.json"): sole-writer
//            discipline, a drift guard not an inserter.
//     :1267 topo — topoSort(loadGraph()) one slug per line.
//   dist/claude/.claude/tools/aidlc-runner-gen.ts
//     :214 handleWrite — one skills/aidlc-<slug>/SKILL.md per RUNNABLE
//            (non-init) compiled stage; name == dir (:121); body drives
//            `next --stage <slug> --single` (:143).
//     :273 handleCheck — drift guard: on-disk runner set == compiled
//            stage-slug set, exit 0 in sync / exit 1 + diff otherwise.
//   dist/claude/.claude/tools/aidlc-orchestrate.ts
//     :910 next Branch 4b (--single) → :1246 emitSingleRunStage: builds the
//            lone run-stage directive from the graph node; the membership
//            check (subgraphForScope(scope), :1262) reads the compiled grid,
//            so the custom slug is runnable under fixture-scope only because
//            compile transposed it in. Emits `{"kind":"run-stage","stage":...}`.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1 (graph recompiles after authoring the file)        -> "1: graph recompiles after authoring the custom stage file"
//   .sh 2 (topo lists the custom slug)                       -> "2: the custom stage is in the compiled graph (topo lists it)"
//   .sh 3 (generator emits skills/aidlc-<slug>/SKILL.md)     -> "3: the generator emits a runner SKILL.md for the custom stage"
//   .sh 4 (runner frontmatter name == dir)                   -> "4: the custom runner's frontmatter name equals its dir"
//   .sh 5 (runner body drives next --stage <slug> --single)  -> "5: the custom runner drives next --stage <slug> --single"
//   .sh 6 (drift check passes after regeneration)            -> "6: stage-runner-drift check passes after regenerating"
//   .sh 7 (next --single emits a run-stage directive)        -> "7: next --single drives the custom stage to a run-stage directive"
//   .sh 8 (the run-stage directive targets the custom stage) -> "8: the run-stage directive targets the custom stage"
//
// STRONGER than the .sh: the single shared sandbox of the .sh is rebuilt
// fresh per test (order-independent isolation, same observables); each tool
// exit code is asserted (the .sh swallowed several with `set +e`); and the
// directive JSON is PARSED (kind/stage assertions on the object, not a
// substring grep that could match the prose).

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test

const CUSTOM_SLUG = "custom-smoke-stage";

const projects: string[] = [];

afterEach(() => {
  for (const p of projects.splice(0)) cleanupTestProject(p);
});

/** Combined stdout+stderr + status of a SANDBOX-COPY tool invocation (the .sh's 2>&1). */
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
 * Build the full sandbox the .sh assembled (t128:31-103): the integration
 * project, plus a dropped fixture scope file, the authored custom stage file,
 * and the pre-seeded {slug, number, name} identity row in the SANDBOX
 * stage-graph.json. Returns the (registered-for-teardown) project dir.
 */
function buildSandbox(): string {
  const proj = setupIntegrationProject({
    noAidlcDocs: true,
    stripEnvScope: true,
  });
  projects.push(proj);
  const claude = join(proj, ".claude");

  // Drop a fixture scope .md so `fixture-scope` is a valid scope (post-PR-12,
  // validScopes() derives from .claude/scopes/*.md presence). The custom stage
  // declares membership via `scopes:` frontmatter; at compile that transposes
  // into the scope-grid marking the custom stage EXECUTE under fixture-scope.
  // Mirrors t60. Byte-for-byte the .sh heredoc.
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
  // stage-graph.json. The compiler is a drift guard, not an inserter
  // (aidlc-graph.ts:1083): it fills a pre-seeded row from the YAML but refuses
  // to invent a row for an unknown slug. Use a 4.8 number (after the last
  // operation stage 4.7) so it sorts last. The .sh did this via `bun -e`; in
  // TS we edit the JSON directly (same effect on the sandbox file).
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

/** The generated runner SKILL.md path for the custom stage, under the sandbox. */
function runnerPath(proj: string): string {
  return join(proj, ".claude", "skills", `aidlc-${CUSTOM_SLUG}`, "SKILL.md");
}

describe("t128 custom stage → drivable runner (migrated from t128-custom-runner.sh, plan 8)", () => {
  test("1: graph recompiles after authoring the custom stage file [.sh 1]", () => {
    const proj = buildSandbox();
    const { graph } = tools(proj);
    const r = run(graph, ["compile", "--project-dir", proj]);
    // STRONGER than the .sh (which set +e then branched on rc): assert exit 0
    // outright. A schema-invalid stage or an unseeded row would exit 1 here.
    expect(r.status).toBe(0);
  }, 60000);

  test("2: the custom stage is in the compiled graph (topo lists it) [.sh 2]", () => {
    const proj = buildSandbox();
    const { graph } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    const topo = run(graph, ["topo", "--project-dir", proj]);
    expect(topo.status).toBe(0);
    expect(topo.out).toContain(CUSTOM_SLUG);
  }, 60000);

  test("3: the generator emits a runner SKILL.md for the custom stage [.sh 3]", () => {
    const proj = buildSandbox();
    const { graph, gen } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    const w = run(gen, ["write", "--project-dir", proj]);
    expect(w.status).toBe(0);
    expect(existsSync(runnerPath(proj))).toBe(true);
  }, 60000);

  test("4: the custom runner's frontmatter name equals its dir [.sh 4]", () => {
    const proj = buildSandbox();
    const { graph, gen } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    expect(run(gen, ["write", "--project-dir", proj]).status).toBe(0);
    const body = readFileSync(runnerPath(proj), "utf-8");
    // The .sh grepped `^name:` and stripped to the value. Spec invariant
    // (runner-gen :121): name == dir == aidlc-<slug>.
    const nameLine = body
      .split("\n")
      .find((l) => /^name:/.test(l));
    expect(nameLine).toBeDefined();
    const name = (nameLine as string).replace(/^name:\s*/, "").trim();
    expect(name).toBe(`aidlc-${CUSTOM_SLUG}`);
  }, 60000);

  test("5: the custom runner drives next --stage <slug> --single [.sh 5]", () => {
    const proj = buildSandbox();
    const { graph, gen } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    expect(run(gen, ["write", "--project-dir", proj]).status).toBe(0);
    const body = readFileSync(runnerPath(proj), "utf-8");
    // The .sh asserted the literal `next --stage <slug> --single` appears in
    // the runner body (the --single signature handleWrite/isRunnerSkill keys on).
    expect(body).toContain(`next --stage ${CUSTOM_SLUG} --single`);
  }, 60000);

  test("6: stage-runner-drift check passes after regenerating (set == compiled list) [.sh 6]", () => {
    const proj = buildSandbox();
    const { graph, gen } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    expect(run(gen, ["write", "--project-dir", proj]).status).toBe(0);
    // After write, the on-disk runner set == the compiled stage-slug set, so
    // check exits 0. STRONGER than the .sh's set +e branch: assert exit 0 AND
    // the in-sync headline.
    const c = run(gen, ["check", "--project-dir", proj]);
    expect(c.status).toBe(0);
    expect(c.out).toContain("in sync with the compiled stage graph");
  }, 60000);

  test("7: next --single drives the custom stage to a run-stage directive [.sh 7]", () => {
    const proj = buildSandbox();
    const { graph, orch } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    const single = run(orch, [
      "next",
      "--stage",
      CUSTOM_SLUG,
      "--single",
      "--scope",
      "fixture-scope",
      "--project-dir",
      proj,
    ]);
    expect(single.status).toBe(0);
    // STRONGER than the .sh substring grep: PARSE the emitted JSON directive
    // (orchestrate emits one compact JSON object to stdout) and assert on the
    // object. kind:"run-stage" proves it is not an error/skip directive.
    const directive = JSON.parse(single.stdout.trim()) as {
      kind: string;
      stage: string;
    };
    expect(directive.kind).toBe("run-stage");
  }, 60000);

  test("8: the run-stage directive targets the custom stage [.sh 8]", () => {
    const proj = buildSandbox();
    const { graph, orch } = tools(proj);
    expect(run(graph, ["compile", "--project-dir", proj]).status).toBe(0);
    const single = run(orch, [
      "next",
      "--stage",
      CUSTOM_SLUG,
      "--single",
      "--scope",
      "fixture-scope",
      "--project-dir",
      proj,
    ]);
    expect(single.status).toBe(0);
    const directive = JSON.parse(single.stdout.trim()) as {
      kind: string;
      stage: string;
    };
    // The directive targets the custom slug (the membership check passed only
    // because compile transposed `scopes: [fixture-scope]` into the grid).
    expect(directive.stage).toBe(CUSTOM_SLUG);
  }, 60000);
});
