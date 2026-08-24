// covers: file:core/tools/aidlc-plugin-build.ts, file:core/tools/aidlc-plugin-emit.ts

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
const EXPECTED_ROOT = join(REPO_ROOT, "dist", "plugins", "test-pro");
const HARNESSES = readdirSync(EXPECTED_ROOT)
  .filter((name) => statSync(join(EXPECTED_ROOT, name)).isDirectory())
  .sort();
const EXPECTED_HARNESSES = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
];
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t315-"));
const copiedTools = join(scratch, "runtime", "tools");
const buildTool = join(copiedTools, "aidlc-plugin-build.ts");

cpSync(SOURCE_TOOLS, copiedTools, { recursive: true });

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  const result = spawnSync(process.execPath, [buildTool, ...args], {
    cwd: scratch,
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function copyPlugin(label: string): string {
  const root = join(scratch, label, "test-pro");
  mkdirSync(dirname(root), { recursive: true });
  cpSync(SOURCE_PLUGIN, root, { recursive: true });
  return root;
}

function treeFiles(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        out.set(relative(root, path).replaceAll("\\", "/"), readFileSync(path));
      }
    }
  };
  walk(root);
  return out;
}

function treeDiff(expected: string, actual: string): string[] {
  const expectedFiles = treeFiles(expected);
  const actualFiles = treeFiles(actual);
  const names = new Set([...expectedFiles.keys(), ...actualFiles.keys()]);
  const differences: string[] = [];
  for (const name of [...names].sort()) {
    const left = expectedFiles.get(name);
    const right = actualFiles.get(name);
    if (!left) differences.push(`EXTRA ${name}`);
    else if (!right) differences.push(`MISSING ${name}`);
    else if (!left.equals(right)) differences.push(`DIFFERS ${name}`);
  }
  return differences;
}

describe("t315 standalone plugin builder", () => {
  test("copied tools build byte-identical test-pro projections for every harness", () => {
    expect(HARNESSES).toEqual(EXPECTED_HARNESSES);
    const pluginRoot = copyPlugin("all-harnesses");
    for (const harness of HARNESSES) {
      const outDir = join(scratch, "outputs", harness);
      const result = run([pluginRoot, harness, outDir, "--json"]);
      expect(result.status, `${harness}: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(Object.keys(json)).toEqual(["valid", "errors", "warnings"]);
      expect(json.valid).toBe(true);
      expect(
        treeDiff(join(EXPECTED_ROOT, harness), outDir),
        harness,
      ).toEqual([]);
    }
  });

  test("default output is <plugin-root>/dist/<harness>", () => {
    const pluginRoot = copyPlugin("default-output");
    const result = run([pluginRoot, "claude", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      treeDiff(
        join(EXPECTED_ROOT, "claude"),
        join(pluginRoot, "dist", "claude"),
      ),
    ).toEqual([]);
  });

  test("a matching vendored compose hook is used without changing output", () => {
    const pluginRoot = copyPlugin("vendored-hook");
    const vendored = join(pluginRoot, "hooks", "compose.ts");
    mkdirSync(dirname(vendored), { recursive: true });
    writeFileSync(
      vendored,
      readFileSync(
        join(
          copiedTools,
          "data",
          "plugin-hooks-template",
          "compose.ts",
        ),
      ),
    );
    const outDir = join(scratch, "vendored-output");
    const result = run([pluginRoot, "claude", outDir, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(treeDiff(join(EXPECTED_ROOT, "claude"), outDir)).toEqual([]);
  });

  test("validation errors refuse the build with exit 1", () => {
    const pluginRoot = copyPlugin("invalid-plugin");
    rmSync(join(pluginRoot, ".aidlc-plugin", "plugin.json"));
    const outDir = join(scratch, "invalid-output");
    const result = run([pluginRoot, "claude", outDir, "--json"]);
    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout) as {
      valid: boolean;
      errors: Array<{ rule: string }>;
    };
    expect(json.valid).toBe(false);
    expect(json.errors.map((finding) => finding.rule)).toContain(
      "manifest-missing",
    );
    expect(existsSync(outDir)).toBe(false);
  });

  test("usage and unknown harness errors exit 2", () => {
    expect(run([]).status).toBe(2);
    const pluginRoot = copyPlugin("unknown-harness");
    const unknown = run([pluginRoot, "unknown"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("Unknown harness");
  });
});
