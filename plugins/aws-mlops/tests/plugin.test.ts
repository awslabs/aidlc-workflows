import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testPluginComposition } from "../../../dist/claude/.claude/tools/aidlc-plugin-test.ts";
import { hooksHealthDir } from "../../../dist/claude/.claude/tools/aidlc-lib.ts";
import { capInlineContextPaths, shippedInlineContextEntries } from "../../../dist/claude/.claude/tools/aidlc-inline-context.ts";
import type { GraphStage } from "../../../dist/claude/.claude/tools/aidlc-graph.ts";
import { HARNESS_MATRIX } from "../../../tests/harness/harness-matrix.ts";
import { runOrchestrateNext } from "../../../tests/harness/fixtures.ts";
import {
  composePluginFixture,
  validatePluginContent,
} from "../../../tests/harness/plugin-kit.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../../../tests/harness/test-budget.ts";
import { methodologies } from "../tools/aws-mlops-methodologies.ts";
import { crispMlqPhases, crispMlqReference } from "../tools/aws-mlops-crisp-mlq.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pluginRoot, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-aws-mlops-compose-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Grid = Record<string, { stages: Record<string, string> }>;

test("authored plugin satisfies the shared schema and reference validator", () => {
  expect(validatePluginContent(pluginRoot)).toEqual([]);
});

describe("all shipped harnesses", () => {
  for (const harness of HARNESS_MATRIX) {
    test(`${harness.name}: routes both profiles and preserves core workflows`, () => {
      const fixture = composePluginFixture({
        plugin: "aws-mlops",
        harness: harness.name,
        projectDir: join(scratch, harness.name),
        pluginBuilt: join(repoRoot, "dist", "plugins", "aws-mlops", harness.name),
      });
      expect(fixture.dropLogs).toBe("");
      const engine = join(fixture.projectDir, harness.manifest.harnessDir);
      const graph = JSON.parse(readFileSync(join(engine, "tools/data/stage-graph.json"), "utf-8")) as GraphStage[];
      const grid = JSON.parse(readFileSync(join(engine, "tools/data/scope-grid.json"), "utf-8")) as Grid;
      const baseline = JSON.parse(readFileSync(join(harness.engineRoot, "tools/data/scope-grid.json"), "utf-8")) as Grid;
      const stage = (slug: string) => graph.find((entry) => entry.slug === slug);
      const index = (slug: string) => graph.findIndex((entry) => entry.slug === slug);
      const model = grid["aws-mlops-crisp-mlq"].stages;
      const platform = grid["aws-mlops-platform"].stages;
      const common = [
        "workspace-scaffold", "workspace-detection", "state-init",
        "aws-mlops-methodology-selection", "aws-mlops-platform-design",
        "requirements-analysis", "units-generation", "delivery-planning",
        "aws-mlops-lifecycle-design", "code-generation", "build-and-test",
        "ci-pipeline", "deployment-pipeline", "environment-provisioning",
        "aws-mlops-deployment", "aws-mlops-monitoring",
      ];
      for (const slug of common) {
        expect(model[slug], slug).toBe("EXECUTE");
        expect(platform[slug], slug).toBe("EXECUTE");
      }
      for (const slug of [
        "aws-mlops-business-data", "aws-mlops-data-preparation",
        "aws-mlops-modeling", "aws-mlops-evaluation",
      ]) {
        expect(model[slug], slug).toBe("EXECUTE");
        expect(platform[slug], slug).toBe("SKIP");
      }
      expect(model["aws-mlops-platform-validation"]).toBe("SKIP");
      expect(platform["aws-mlops-platform-validation"]).toBe("EXECUTE");
      // Core operation stages that would precede ML release are not duplicated.
      for (const slug of ["deployment-execution", "observability-setup", "performance-validation"]) {
        expect(model[slug]).toBe("SKIP");
        expect(platform[slug]).toBe("SKIP");
      }
      for (const [scope, before] of Object.entries(baseline)) {
        for (const [slug, verdict] of Object.entries(before.stages)) {
          expect(grid[scope].stages[slug], `${scope}/${slug}`).toBe(verdict);
        }
        for (const entry of graph.filter((entry) => entry.slug.startsWith("aws-mlops-"))) {
          expect(grid[scope].stages[entry.slug], `${scope}/${entry.slug}`).toBe("SKIP");
        }
      }
      const route = [
        "aws-mlops-methodology-selection", "aws-mlops-business-data",
        "aws-mlops-platform-design", "requirements-analysis",
        "delivery-planning", "aws-mlops-lifecycle-design", "code-generation",
        "build-and-test", "ci-pipeline", "aws-mlops-data-preparation",
        "aws-mlops-modeling", "aws-mlops-evaluation", "deployment-pipeline",
        "environment-provisioning", "aws-mlops-deployment", "aws-mlops-monitoring",
      ];
      for (let i = 1; i < route.length; i++) {
        expect(index(route[i]), `${route[i - 1]} before ${route[i]}`).toBeGreaterThan(index(route[i - 1]));
      }
      expect(stage("code-generation")?.consumes).toContainEqual({
        artifact: "aws-mlops-lifecycle-design", required: true,
      });
      expect(stage("code-generation")?.requires_stage).toContain("aws-mlops-lifecycle-design");
      expect(stage("aws-mlops-modeling")?.lead_agent).toBe("aws-mlops-data-scientist-agent");
      expect(stage("aws-mlops-monitoring")?.lead_agent).toBe("aws-mlops-ml-engineer-agent");
      const methodPath = `${harness.manifest.harnessDir}/${crispMlqReference.knowledge_file}`;
      for (const phase of crispMlqPhases) {
        const node = stage(phase.stage);
        if (!node) throw new Error(`Missing method stage: ${phase.stage}`);
        const warnings: string[] = [];
        const roster = shippedInlineContextEntries(node, engine, harness.manifest.harnessDir, warnings, "Standard");
        const delivered = capInlineContextPaths(roster.map((entry) => entry.rel));
        expect(warnings).toEqual([]);
        expect(delivered.paths, phase.stage).toContain(methodPath);
        expect(delivered.omitted, phase.stage).toBe(0);
        expect(readFileSync(join(engine, crispMlqReference.knowledge_file), "utf-8"))
          .toContain(`Reference revision: **${crispMlqReference.revision}**`);
        expect(node.sensors_applicable.map((sensor) => sensor.id)).toContain("aws-mlops-crisp-mlq");
      }
      // Reused core inline stages receive the same shared reference, not only
      // the two new specialist personas.
      const requirements = stage("requirements-analysis");
      if (!requirements) throw new Error("Missing core requirements stage");
      expect(shippedInlineContextEntries(requirements, engine, harness.manifest.harnessDir)
        .map((entry) => entry.rel)).toContain(methodPath);
      const catalog = spawnSync(process.execPath, [join(engine, "tools/aws-mlops-methodologies.ts")], {
        cwd: fixture.projectDir,
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(catalog.status, catalog.stderr).toBe(0);
      expect(JSON.parse(catalog.stdout).methodologies).toEqual(methodologies);

      if (harness.name === "codex") {
        const disable = spawnSync(process.execPath, [
          join(engine, "tools/aidlc-utility.ts"), "select-plugins", "aidlc",
        ], {
          cwd: fixture.projectDir,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".codex", AIDLC_PROJECT_DIR: fixture.projectDir },
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        });
        expect(disable.status, `${disable.stdout}${disable.stderr}`).toBe(0);
        const after = JSON.parse(readFileSync(join(engine, "tools/data/scope-grid.json"), "utf-8")) as Grid;
        expect(after["aws-mlops-crisp-mlq"]).toBeUndefined();
        const disabled = JSON.parse(readFileSync(join(engine, "tools/data/stage-graph.json"), "utf-8")) as GraphStage[];
        expect(disabled.find((entry) => entry.slug === "aws-mlops-evaluation")?.enabled).toBe(false);
        expect(disabled.find((entry) => entry.slug === "code-generation")?.requires_stage)
          .not.toContain("aws-mlops-lifecycle-design");
      }
    });
  }
});

test("the standalone composition check is idempotent and leaves the install intact", () => {
  const result = testPluginComposition({
    pluginRoot,
    installRoot: join(repoRoot, "dist/codex"),
    harness: "codex",
  });
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
  expect(result.drops).toEqual([]);
  expect(result.graph.missingStages).toEqual([]);
  expect(result.graph.missingScopes).toEqual([]);
  expect(result.idempotent).toBe(true);
});

for (const scope of ["aws-mlops-platform", "aws-mlops-crisp-mlq"]) {
  test(`${scope}: a new intent starts at the methodology choice`, () => {
    const project = join(scratch, `first-move-${scope}`);
    // Exercise the shared source-channel engine, not a live host session.
    composePluginFixture({
      plugin: "aws-mlops",
      harness: "claude",
      projectDir: project,
      pluginBuilt: join(repoRoot, "dist/plugins/aws-mlops/claude"),
    });
    const engine = join(project, ".claude/tools");
    const env = { ...process.env, AIDLC_HARNESS_DIR: ".claude", AIDLC_PROJECT_DIR: project };
    const init = spawnSync(process.execPath, [
      join(engine, "aidlc-utility.ts"), "intent-create", "--scope", scope,
      "--project-dir", project,
    ], {
      cwd: project,
      env,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(init.status, `${init.stdout}${init.stderr}`).toBe(0);
    // Model the host heartbeat as the core hooks-off tests do. This receipt
    // lives only in the disposable fixture; no host setting or guard changes.
    const health = hooksHealthDir(project);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    const next = runOrchestrateNext(join(engine, "aidlc-orchestrate.ts"), project, ["--scope", scope], {
      cwd: project, env,
    });
    expect(next.status, next.out).toBe(0);
    expect(next.directive?.kind, next.out).toBe("run-stage");
    expect(next.directive?.stage).toBe("aws-mlops-methodology-selection");
    expect(next.directive?.inline_context_paths).toContain(`.claude/${crispMlqReference.knowledge_file}`);
  });
}
