// covers: scope:express, scope:classic, subcommand:aidlc-utility:detect-scope, subcommand:aidlc-utility:intent-create
//
// Deterministic routed journey for the express scope. No SDK/TUI driver and no
// live harness variables: every assertion crosses the shipped CLI boundary and
// reads the compiled routing result or the state written by intent-create.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const projects: string[] = [];

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

function activeStatePath(p: string): string {
  const spacePath = join(p, "aidlc", "active-space");
  const space = existsSync(spacePath)
    ? readFileSync(spacePath, "utf-8").trim() || "default"
    : "default";
  const intents = join(p, "aidlc", "spaces", space, "intents");
  const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return join(intents, record, "aidlc-state.md");
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

describe("t291 express scope routing (deterministic CLI journey)", () => {
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

  test("freeform text with no scope keyword falls back to classic", () => {
    expect(detectedScope(project(), "build a simple task tracker")).toMatchObject(
      {
        scope: "classic",
        source: "freeform",
      },
    );
  });
});
