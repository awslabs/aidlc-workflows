// covers: file:core/tools/aidlc-plugin-test.ts

import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_TOOLS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
);
const SOURCE_PLUGIN = join(REPO_ROOT, "plugins", "test-pro");
const CLAUDE_INSTALL = join(REPO_ROOT, "dist", "claude");
const KIRO_INSTALL = join(REPO_ROOT, "dist", "kiro");
const OPENCODE_INSTALL = join(REPO_ROOT, "dist", "opencode");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t316-"));
const copiedTools = join(scratch, "runtime", "tools");
const testTool = join(copiedTools, "aidlc-plugin-test.ts");

cpSync(SOURCE_TOOLS, copiedTools, { recursive: true });

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Run {
  const result = spawnSync(process.execPath, [testTool, ...args], {
    cwd: scratch,
    encoding: "utf-8",
    env: { ...process.env, ...envOverrides },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function copyFixture(
  label: string,
  installSource = CLAUDE_INSTALL,
): { pluginRoot: string; installRoot: string } {
  const root = join(scratch, label);
  const pluginRoot = join(root, "test-pro");
  const installRoot = join(root, "install");
  mkdirSync(root, { recursive: true });
  cpSync(SOURCE_PLUGIN, pluginRoot, { recursive: true });
  cpSync(installSource, installRoot, { recursive: true });
  return { pluginRoot, installRoot };
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      hash.update(rel);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex");
}

function collidingStage(): string {
  return `---
slug: build-and-test
name: Colliding Build and Test
plugin: test-pro
phase: construction
execution: ALWAYS
condition: always
lead_agent: aidlc-quality-agent
support_agents: []
mode: inline
produces:
  - test-pro-collision-output
consumes: []
requires_stage: []
sensors: []
scopes:
  - enterprise
inputs: none
outputs: none
---

# Collision
`;
}

describe("t316 standalone plugin compose test", () => {
  test("test-pro composes cleanly in a disposable Claude candidate", () => {
    const { pluginRoot, installRoot } = copyFixture("clean");
    const before = treeDigest(installRoot);
    const result = run([
      pluginRoot,
      "--install",
      installRoot,
      "--json",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as {
      valid: boolean;
      errors: unknown[];
      warnings: unknown[];
      harness: string;
      composedFiles: string[];
      drops: unknown[];
      graph: {
        compiled: boolean;
        presentStages: string[];
        presentScopes: string[];
      };
      idempotent: boolean;
    };
    expect(Object.keys(json)).toEqual([
      "valid",
      "errors",
      "warnings",
      "harness",
      "composedFiles",
      "changedFiles",
      "drops",
      "graph",
      "idempotent",
    ]);
    expect(json.valid).toBe(true);
    expect(json.harness).toBe("claude");
    expect(json.drops).toEqual([]);
    expect(json.graph.compiled).toBe(true);
    expect(json.graph.presentStages).toContain("test-pro-integration");
    expect(json.graph.presentStages).toContain("test-pro-full-suite");
    expect(json.graph.presentScopes).toContain("test-pro-validation");
    expect(json.composedFiles).toContain(
      ".claude/aidlc-common/stages/construction/test-pro-integration.md",
    );
    expect(json.idempotent).toBe(true);
    expect(treeDigest(installRoot)).toBe(before);
  });

  test("a colliding stage is reported as a compose drop and exits 1", () => {
    const { pluginRoot, installRoot } = copyFixture("collision");
    const stage = join(
      pluginRoot,
      "stages",
      "construction",
      "build-and-test.md",
    );
    mkdirSync(dirname(stage), { recursive: true });
    writeFileSync(stage, collidingStage(), "utf-8");
    const before = treeDigest(installRoot);
    const result = run([
      pluginRoot,
      "--install",
      installRoot,
      "--json",
    ]);
    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout) as {
      valid: boolean;
      errors: Array<{ rule: string; message: string }>;
      drops: Array<{ message: string }>;
    };
    expect(json.valid).toBe(false);
    expect(json.drops.length).toBeGreaterThan(0);
    expect(json.drops.some((drop) => drop.message.includes("collides"))).toBe(
      true,
    );
    expect(json.errors.map((finding) => finding.rule)).toContain(
      "test-compose-drop",
    );
    expect(treeDigest(installRoot)).toBe(before);
  });

  test("linked authored content refuses TEST without touching the live install", () => {
    const { pluginRoot, installRoot } = copyFixture("linked-content");
    const linkedSource = join(scratch, "linked-content-source");
    mkdirSync(linkedSource, { recursive: true });
    writeFileSync(
      join(linkedSource, "payload.txt"),
      "linked payload\n",
      "utf-8",
    );
    const linkedDir = join(pluginRoot, "knowledge", "linked-content");
    symlinkSync(
      linkedSource,
      linkedDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const before = treeDigest(installRoot);

    const result = run([
      pluginRoot,
      "--install",
      installRoot,
      "--json",
    ]);
    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout) as {
      valid: boolean;
      errors: Array<{ file: string; rule: string }>;
      composedFiles: string[];
    };
    expect(json.valid).toBe(false);
    expect(json.errors).toContainEqual(
      expect.objectContaining({
        file: "knowledge/linked-content",
        rule: "content-symlink",
      }),
    );
    expect(json.composedFiles).toEqual([]);
    expect(treeDigest(installRoot)).toBe(before);
  });

  test("OpenCode copies its native shell and ignores inherited path seams", () => {
    const { pluginRoot, installRoot } = copyFixture(
      "opencode-isolation",
      OPENCODE_INSTALL,
    );
    const nativeCollision = join(
      installRoot,
      ".opencode",
      "agents",
      "test-pro-metrics-agent.md",
    );
    writeFileSync(
      nativeCollision,
      "---\nname: test-pro-metrics-agent\n---\n\n# Installed collision\n",
      "utf-8",
    );
    const poisonRoot = join(scratch, "poisoned-host");
    mkdirSync(poisonRoot, { recursive: true });
    const poisonGraph = join(poisonRoot, "stage-graph.json");
    writeFileSync(poisonGraph, '{"sentinel":true}\n', "utf-8");
    const beforeInstall = treeDigest(installRoot);
    const beforePoison = treeDigest(poisonRoot);
    const result = run(
      [
        pluginRoot,
        "--install",
        installRoot,
        "--harness",
        "opencode",
        "--json",
      ],
      {
        CLAUDE_PLUGIN_ROOT: join(poisonRoot, "wrong-plugin"),
        CLAUDE_PROJECT_DIR: poisonRoot,
        AIDLC_STAGE_GRAPH: poisonGraph,
        AIDLC_SCOPE_GRID: join(poisonRoot, "scope-grid.json"),
        AIDLC_STAGES_DIR: join(poisonRoot, "stages"),
        AIDLC_RULES_DIR: join(poisonRoot, "memory"),
        AIDLC_SCOPES_DIR: join(poisonRoot, "scopes"),
        AIDLC_AGENTS_DIR: join(poisonRoot, "agents"),
        AIDLC_SCOPE_MAPPING: join(poisonRoot, "scope-mapping.json"),
      },
    );
    expect(result.status, result.stderr).toBe(1);
    const json = JSON.parse(result.stdout) as {
      harness: string;
      drops: Array<{ message: string }>;
    };
    expect(json.harness).toBe("opencode");
    expect(
      json.drops.some(
        (drop) =>
          drop.message.includes("OpenCode native agents") &&
          drop.message.includes("collides"),
      ),
    ).toBe(true);
    expect(treeDigest(installRoot)).toBe(beforeInstall);
    expect(treeDigest(poisonRoot)).toBe(beforePoison);
  });

  test("shared .kiro leaf requires --harness disambiguation", () => {
    const { pluginRoot, installRoot } = copyFixture(
      "kiro-ambiguity",
      KIRO_INSTALL,
    );
    const result = run([pluginRoot, "--install", installRoot]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("install is ambiguous");
    expect(result.stderr).toContain("--harness <name>");
  });

  test("--dist is reserved and usage errors exit 2", () => {
    const { pluginRoot, installRoot } = copyFixture("usage");
    expect(run([]).status).toBe(2);
    const reserved = run([
      pluginRoot,
      "--install",
      installRoot,
      "--dist",
      "2.6.67",
    ]);
    expect(reserved.status).toBe(2);
    expect(reserved.stderr).toContain("RFC #722 milestone 2");
  });

  test("fixture inputs are ordinary directories in the isolated temp tree", () => {
    const { pluginRoot, installRoot } = copyFixture("isolation");
    expect(statSync(pluginRoot).isDirectory()).toBe(true);
    expect(statSync(installRoot).isDirectory()).toBe(true);
    expect(testTool.startsWith(scratch)).toBe(true);
    expect(pluginRoot.startsWith(scratch)).toBe(true);
    expect(installRoot.startsWith(scratch)).toBe(true);
  });
});
