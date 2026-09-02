// covers: function:compileStageGraph, function:loadScopeMetadata, function:loadAgents, subcommand:aidlc-utility:doctor

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileStageGraph } from "../../core/tools/aidlc-graph.ts";
import {
  agentsDir,
  loadAgents,
  loadScopeMetadata,
} from "../../core/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  setupIntegrationProject,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTIL = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
const DIST_DATA = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data");

const tempDirs: string[] = [];
const projects: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  for (const p of projects.splice(0)) cleanupTestProject(p);
  delete process.env.AIDLC_STAGES_DIR;
  delete process.env.AIDLC_STAGE_GRAPH;
  delete process.env.AIDLC_SCOPE_GRID;
  delete process.env.AIDLC_RULES_DIR;
  delete process.env.AIDLC_SENSORS_DIR;
  delete process.env.AIDLC_SCOPES_DIR;
  delete process.env.AIDLC_AGENTS_DIR;
  delete process.env.AIDLC_HARNESS_DIR;
  withEnvAndFreshCaches({}, () => undefined);
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function stageFrontmatter(slug: string): string {
  return [
    "---",
    `slug: ${slug}`,
    "phase: construction",
    "execution: ALWAYS",
    "condition: always",
    "lead_agent: aidlc-quality-agent",
    "support_agents: []",
    "mode: inline",
    "produces: []",
    "consumes: []",
    "requires_stage: []",
    "inputs: test input",
    "outputs: test output",
    "---",
    "",
    `# ${slug}`,
    "",
  ].join("\n");
}

function compileStageFixture(filenameStem: string, slug: string): void {
  const root = tempDir("aidlc-t223-compile-");
  const stagesDir = join(root, "stages");
  const construction = join(stagesDir, "construction");
  const rulesDir = join(root, "rules");
  const sensorsDir = join(root, "sensors");
  const graphPath = join(root, "stage-graph.json");
  const gridPath = join(root, "scope-grid.json");
  mkdirSync(construction, { recursive: true });
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(sensorsDir, { recursive: true });
  writeFileSync(join(construction, `${filenameStem}.md`), stageFrontmatter(slug), "utf-8");
  writeFileSync(graphPath, "[]\n", "utf-8");
  writeFileSync(gridPath, "{}\n", "utf-8");

  withEnvAndFreshCaches(
    {
      AIDLC_STAGES_DIR: stagesDir,
      AIDLC_STAGE_GRAPH: graphPath,
      AIDLC_SCOPE_GRID: gridPath,
      AIDLC_RULES_DIR: rulesDir,
      AIDLC_SENSORS_DIR: sensorsDir,
      AIDLC_AGENTS_DIR: undefined,
      AIDLC_HARNESS_DIR: ".claude",
    },
    () => compileStageGraph(),
  );
}

function writeScope(dir: string, file: string, name: string): void {
  writeFileSync(
    join(dir, file),
    [
      "---",
      `name: ${name}`,
      "depth: Minimal",
      "keywords: []",
      "description: Fixture scope",
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeAgent(dir: string, file: string, name: string): void {
  writeFileSync(
    join(dir, file),
    [
      "---",
      `name: ${name}`,
      `display_name: ${name}`,
      "examples: []",
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("t223 naming enforcement", () => {
  test("stage filename stem must match frontmatter slug at compile", () => {
    expect(() => compileStageFixture("file-stem", "declared-slug")).toThrow(
      /file-stem\.md.*file-stem.*declared-slug.*Rename the file or fix the slug/,
    );
  });

  test("duplicate scope names throw and name both files", () => {
    const dir = tempDir("aidlc-t223-scopes-");
    const first = join(dir, "alpha.md");
    const second = join(dir, "beta.md");
    writeScope(dir, "alpha.md", "shared-scope");
    writeScope(dir, "beta.md", "shared-scope");

    expect(() =>
      withEnvAndFreshCaches({ AIDLC_SCOPES_DIR: dir }, () => loadScopeMetadata()),
    ).toThrow(
      new RegExp(
        `Duplicate scope name "shared-scope".*${second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Rename one of them`,
      ),
    );
  });

  test("duplicate agent slugs throw and name both files", () => {
    const dir = tempDir("aidlc-t223-agents-");
    const first = join(dir, "alpha-agent.md");
    const second = join(dir, "beta-agent.md");
    writeAgent(dir, "alpha-agent.md", "shared-agent");
    writeAgent(dir, "beta-agent.md", "shared-agent");

    expect(() =>
      withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => loadAgents()),
    ).toThrow(
      new RegExp(
        `Duplicate agent slug "shared-agent".*${second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Rename one of them`,
      ),
    );
  });

  test("AIDLC_AGENTS_DIR points loadAgents at a temp fixture dir", () => {
    const dir = tempDir("aidlc-t223-agent-seam-");
    writeAgent(dir, "fixture-agent.md", "fixture-agent");

    withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
      expect(agentsDir()).toBe(dir);
      expect(loadAgents()).toEqual([
        { slug: "fixture-agent", display_name: "fixture-agent", examples: [] },
      ]);
    });
  });

  test("loadAgents skips the IDE conductor aidlc.md", () => {
    const dir = tempDir("aidlc-t223-agent-conductor-");
    writeAgent(dir, "fixture-agent.md", "fixture-agent");
    writeFileSync(
      join(dir, "aidlc.md"),
      [
        "---",
        "name: aidlc",
        "description: IDE conductor without persona metadata",
        'tools: ["read", "write", "shell", "subagent"]',
        "---",
        "",
        "Conductor body.",
        "",
      ].join("\n"),
    );

    withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
      expect(loadAgents()).toEqual([
        { slug: "fixture-agent", display_name: "fixture-agent", examples: [] },
      ]);
    });
  });

  test("doctor reports a scope filename/name stem mismatch as advisory", () => {
    const project = createTestProject();
    projects.push(project);
    const scopes = tempDir("aidlc-t223-doctor-scopes-");
    writeScope(scopes, "wrong-scope.md", "right-scope");

    const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", project], {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_SCOPES_DIR: scopes,
        AIDLC_STAGE_GRAPH: join(DIST_DATA, "stage-graph.json"),
        AIDLC_SCOPE_GRID: join(DIST_DATA, "scope-grid.json"),
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    expect(out).toContain("ok    Scope filename/name consistency");
    expect(out).toContain("Scope filename/name consistency: 1 mismatch(es) (advisory)");
    expect(out).toContain(join(scopes, "wrong-scope.md"));
    expect(out).toContain('stem "wrong-scope"');
    expect(out).toContain('declares name "right-scope"');
    expect(out).toContain("Rename the file or fix the name.");
  }, 30000);

  test("doctor fails active selection coverage when stage frontmatter cannot be parsed", () => {
    const project = setupIntegrationProject();
    projects.push(project);

    const harnessJsonPath = join(project, ".claude", "tools", "data", "harness.json");
    const harnessJson = JSON.parse(readFileSync(harnessJsonPath, "utf-8")) as Record<string, unknown>;
    harnessJson.plugins = ["aidlc"];
    writeFileSync(harnessJsonPath, `${JSON.stringify(harnessJson, null, 2)}\n`, "utf-8");

    const brokenPath = join(project, ".claude", "aidlc-common", "stages", "construction", "bad-frontmatter.md");
    writeFileSync(brokenPath, "not frontmatter\n", "utf-8");

    const res = spawnSync(BUN, [join(project, ".claude", "tools", "aidlc-utility.ts"), "doctor"], {
      cwd: project,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });

    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("Enabled stage compile coverage: 1 enabled stage file(s) missing from the full graph");
    expect(res.stdout).toContain("bad-frontmatter");
    expect(res.stdout).toContain(brokenPath);
    expect(res.stdout).toContain("frontmatter parse failed");
  }, 30000);
});
