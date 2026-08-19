// covers: scope:express, scope:classic, subcommand:aidlc-utility:detect-scope, subcommand:aidlc-utility:intent-create
//
// Deterministic routed journey for the express scope. No SDK/TUI driver and no
// live harness variables: every assertion crosses the shipped CLI boundary and
// reads the compiled routing result or the state written by intent-create.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  runOrchestrateNext,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];
type Directive = Record<string, unknown>;

const EXPRESS_STAGES = [
  "workspace-detection",
  "workspace-scaffold",
  "state-init",
  "reverse-engineering",
  "requirements-analysis",
  "code-generation",
  "build-and-test",
  "deployment-pipeline",
  "deployment-execution",
  "observability-setup",
].sort();

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

function project(): string {
  const p = setupIntegrationProject({
    noAidlcDocs: true,
    stripEnvScope: true,
  });
  projects.push(p);
  return p;
}

function utility(p: string, args: string[]) {
  return spawnSync(BUN, [UTILITY, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
}

function engineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_SKIP_REVISION_BACKSTOP: "1",
  };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

function activeStatePath(p: string): string {
  const spacePath = join(p, "aidlc", "active-space");
  const space = existsSync(spacePath)
    ? readFileSync(spacePath, "utf-8").trim() || "default"
    : "default";
  const intents = join(p, "aidlc", "spaces", space, "intents");
  const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return join(intents, record, "aidlc-state.md");
}

function activeRecordDir(p: string): string {
  return dirname(activeStatePath(p));
}

function stateField(p: string, name: string): string | null {
  const body = readFileSync(activeStatePath(p), "utf-8");
  return body.match(new RegExp(`^- \\*\\*${name}\\*\\*: (.+)$`, "m"))?.[1] ?? null;
}

function writeArtifact(p: string, relative: string): void {
  const path = join(activeRecordDir(p), ...relative.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# ${relative}\n\nfixture\n`, "utf-8");
}

function next(p: string): Directive {
  const result = runOrchestrateNext(ORCHESTRATE, p, [], {
    cwd: p,
    env: engineEnv(),
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.directive, `${result.stdout}\n${result.stderr}`).not.toBeNull();
  return result.directive as Directive;
}

function report(p: string, args: string[]): Directive {
  const result = spawnSync(
    BUN,
    [ORCHESTRATE, "report", ...args, "--project-dir", p],
    { encoding: "utf-8", env: engineEnv() },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim()) as Directive;
}

function approve(p: string, stage: string, artifacts: string[]): void {
  for (const artifact of artifacts) writeArtifact(p, artifact);
  const directive = report(p, [
    "--stage",
    stage,
    "--result",
    "approved",
    "--user-input",
    "Approve",
  ]);
  expect(directive.kind, String(directive.reason ?? directive.message)).toBe("done");
}

function skip(p: string, stage: string, reason: string): void {
  const directive = report(p, [
    "--stage",
    stage,
    "--result",
    "skipped",
    "--reason",
    reason,
  ]);
  expect(directive.kind, String(directive.reason ?? directive.message)).toBe("done");
}

function expectDesignedAbsences(directive: Directive): string[] {
  const absent = (directive.consumes_absent ?? []) as Array<{
    path: string;
    expected: boolean;
  }>;
  expect(absent.length).toBeGreaterThan(0);
  expect(absent.every((entry) => entry.expected)).toBe(true);
  return absent.map((entry) => entry.path);
}

function birthExpress(p: string): void {
  const result = utility(p, [
    "intent-create",
    "--scope",
    "express",
    "--arguments",
    "Ship a lightweight service update",
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function runThroughBuild(p: string): void {
  const requirements = next(p);
  expect(requirements).toMatchObject({
    kind: "run-stage",
    stage: "requirements-analysis",
    gate: true,
  });
  expect(stateField(p, "Lifecycle Phase")).toBe("INCEPTION");
  expect(requirements.reviewer).toBeUndefined();
  approve(p, "requirements-analysis", [
    "inception/requirements-analysis/requirements.md",
  ]);

  const code = next(p);
  expect(code).toMatchObject({
    kind: "run-stage",
    stage: "code-generation",
    gate: true,
  });
  expect(code.unit).toBeUndefined();
  expect(code.reviewer).toBeUndefined();
  expect(code.swarm_settled).toBeUndefined();
  expect(code.protocol_modules).toEqual(["ensemble", "construction"]);
  expect(stateField(p, "Lifecycle Phase")).toBe("CONSTRUCTION");
  expect((code.produces as string[]).every((path) =>
    path.includes("/construction/code-generation/") &&
    !path.includes("{unit-name}")
  )).toBe(true);
  const codeAbsences = expectDesignedAbsences(code);
  expect(codeAbsences.some((path) => path.endsWith("/unit-of-work.md"))).toBe(true);
  approve(p, "code-generation", [
    "construction/code-generation/code-generation-plan.md",
    "construction/code-generation/unit-test-instructions.md",
    "construction/code-generation/code-summary.md",
    "construction/code-generation/traceability.json",
  ]);

  const build = next(p);
  expect(build).toMatchObject({
    kind: "run-stage",
    stage: "build-and-test",
    gate: true,
  });
  expect((build.consumes as string[]).every((path) =>
    path.includes("/construction/code-generation/")
  )).toBe(true);
  approve(p, "build-and-test", [
    "construction/build-and-test/build-and-test-summary.md",
    "construction/build-and-test/build-test-results.md",
  ]);
  expect(stateField(p, "Lifecycle Phase")).toBe("OPERATION");
}

function detectedScope(p: string, input: string): {
  scope: string;
  source: string;
} {
  const result = utility(p, ["detect-scope", "--from-text", "--input", input]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    scope: string;
    source: string;
  };
}

describe("t301 express scope routing (deterministic CLI journey)", () => {
  test('keyword "express" routes to express', () => {
    expect(detectedScope(project(), "express")).toMatchObject({
      scope: "express",
      source: "keyword",
    });
  });

  test("explicit --scope express writes the exact 10-stage plan", () => {
    const p = project();
    const result = utility(p, [
      "intent-create",
      "--scope",
      "express",
      "--arguments",
      "Ship a lightweight service update",
    ]);
    expect(result.status).toBe(0);

    const state = readFileSync(activeStatePath(p), "utf-8");
    expect(state).toContain("- **Scope**: express");
    const grid = JSON.parse(
      readFileSync(
        join(p, ".claude", "tools", "data", "scope-grid.json"),
        "utf-8",
      ),
    ) as Record<string, { stages: Record<string, string> }>;
    const execute = Object.entries(grid.express.stages)
      .filter(([, action]) => action === "EXECUTE")
      .map(([slug]) => slug)
      .sort();
    expect(execute).toEqual(EXPRESS_STAGES);
  });

  test("freeform text with no scope keyword falls back to the classic default", () => {
    expect(detectedScope(project(), "build a simple task tracker")).toMatchObject(
      {
        scope: "classic",
        source: "freeform",
      },
    );
  });

  test("engine completes Express when the conditional deploy tail does not apply", () => {
    const p = project();
    birthExpress(p);
    runThroughBuild(p);

    for (const stage of [
      "deployment-pipeline",
      "deployment-execution",
      "observability-setup",
    ]) {
      const directive = next(p);
      expect(directive.stage).toBe(stage);
      skip(p, stage, "No deployable target exists for this Express run");
    }

    const done = next(p);
    expect(done.kind).toBe("done");
    expect(readFileSync(activeStatePath(p), "utf-8")).toContain(
      "- **Status**: Completed",
    );
  }, 30000);

  test("engine completes the Express deploy tail using explicit workspace fallbacks", () => {
    const p = project();
    birthExpress(p);
    runThroughBuild(p);

    const pipeline = next(p);
    expect(pipeline.stage).toBe("deployment-pipeline");
    const pipelineAbsences = expectDesignedAbsences(pipeline);
    expect(pipelineAbsences).toHaveLength(4);
    approve(p, "deployment-pipeline", [
      "operation/deployment-pipeline/cd-config.md",
      "operation/deployment-pipeline/deployment-strategy.md",
      "operation/deployment-pipeline/rollback-runbook.md",
    ]);

    const deployment = next(p);
    expect(deployment.stage).toBe("deployment-execution");
    const deploymentAbsences = expectDesignedAbsences(deployment);
    expect(deploymentAbsences).toHaveLength(1);
    expect(deploymentAbsences[0]).toEndWith("/environment-inventory.md");
    approve(p, "deployment-execution", [
      "operation/deployment-execution/deployment-log.md",
      "operation/deployment-execution/smoke-test-results.md",
      "operation/deployment-execution/health-check-report.md",
    ]);

    const observability = next(p);
    expect(observability.stage).toBe("observability-setup");
    expect(expectDesignedAbsences(observability)).toHaveLength(5);
    approve(p, "observability-setup", [
      "operation/observability-setup/dashboards.md",
      "operation/observability-setup/alarms.md",
    ]);

    const done = next(p);
    expect(done.kind).toBe("done");
    expect(readFileSync(activeStatePath(p), "utf-8")).toContain(
      "- **Status**: Completed",
    );
  }, 30000);
});
