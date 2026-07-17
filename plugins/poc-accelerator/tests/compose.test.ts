import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude", ".claude");
const PLUGIN = "poc-accelerator";
const BUN = process.execPath;
const TIMEOUT_MS = 60_000;
const STAGES = [
  "poc-accelerator-step-01-requirements-capture",
  "poc-accelerator-step-02-solution-design",
  "poc-accelerator-step-03-environment-readiness",
  "poc-accelerator-step-04-walking-skeleton",
  "poc-accelerator-step-05-feature-expansion",
  "poc-accelerator-step-06-test-validation",
  "poc-accelerator-step-07-deployment",
  "poc-accelerator-step-08-demo-handoff",
];

function graph(projectDir: string): Array<Record<string, unknown>> {
  return JSON.parse(
    readFileSync(join(projectDir, ".claude", "tools", "data", "stage-graph.json"), "utf-8"),
  );
}

describe(`${PLUGIN} plugin — compose smoke test`, () => {
  let tempDir: string;
  let projectDir: string;
  let pluginDir: string;
  let baseStageCount: number;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "aidlc-poc-accelerator-"));
    pluginDir = join(tempDir, "plugin", "claude");

    const build = spawnSync(BUN, [PACKAGE_TS, "plugin", "build", PLUGIN, "claude", pluginDir], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
    });
    if (build.status !== 0) throw new Error(`plugin build failed: ${build.stderr}`);

    projectDir = join(tempDir, "project");
    cpSync(CLAUDE_DIST, join(projectDir, ".claude"), { recursive: true });
    baseStageCount = graph(projectDir).length;

    const compose = spawnSync(BUN, [join(pluginDir, "hooks", "compose.ts")], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginDir,
        CLAUDE_PROJECT_DIR: projectDir,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    if (compose.status !== 0) throw new Error(`plugin compose failed: ${compose.stderr}`);
  });

  afterAll(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("composes all eight stages into the graph and delivery scope", () => {
    const composed = graph(projectDir);
    const slugs = composed.map((stage) => stage.slug);
    expect(composed).toHaveLength(baseStageCount + STAGES.length);
    expect(slugs).toEqual(expect.arrayContaining(STAGES));

    const scope = readFileSync(
      join(projectDir, ".claude", "scopes", "poc-accelerator-cde.md"),
      "utf-8",
    );
    expect(scope).toContain("name: poc-accelerator-cde");
  });

  test("regenerates stage and scope runners for the customer delivery flow", () => {
    expect(
      existsSync(
        join(projectDir, ".claude", "skills", "poc-accelerator-step-04-walking-skeleton", "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(projectDir, ".claude", "skills", "poc-accelerator-cde", "SKILL.md"),
      ),
    ).toBe(true);
  });

  test("composes the PoC playbook, CDK patterns, and MCP guidance", () => {
    expect(
      existsSync(
        join(projectDir, ".claude", "knowledge", "aidlc-product-agent", "poc-playbook.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(projectDir, ".claude", "knowledge", "aidlc-architect-agent", "cdk-patterns.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(projectDir, ".claude", "knowledge", "aidlc-pipeline-deploy-agent", "mcp-setup.md"),
      ),
    ).toBe(true);
  });

  test("is idempotent on a second compose", () => {
    const compose = spawnSync(BUN, [join(pluginDir, "hooks", "compose.ts")], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginDir,
        CLAUDE_PROJECT_DIR: projectDir,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    expect(compose.status).toBe(0);
    expect(graph(projectDir)).toHaveLength(baseStageCount + STAGES.length);
  });
});
