// covers: file:core/tools/aidlc-plugin-create.ts

import { createHash } from "node:crypto";
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
const CLAUDE_INSTALL = join(REPO_ROOT, "dist", "claude");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t317-"));
const copiedTools = join(scratch, "runtime", "tools");
const createTool = join(copiedTools, "aidlc-plugin-create.ts");
const validateTool = join(copiedTools, "aidlc-plugin-validate.ts");
const buildTool = join(copiedTools, "aidlc-plugin-build.ts");
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

function run(tool: string, args: string[], cwd = scratch): Run {
  const result = spawnSync(process.execPath, [tool, ...args], {
    cwd,
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
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

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const [path, content] of treeFiles(root)) {
    hash.update(path);
    hash.update(content);
  }
  return hash.digest("hex");
}

describe("t317 standalone plugin creator", () => {
  test("create is deterministic and emits a stable JSON shape", () => {
    const name = "example-plugin";
    const firstCwd = join(scratch, "determinism-a");
    const secondCwd = join(scratch, "determinism-b");
    mkdirSync(firstCwd, { recursive: true });
    mkdirSync(secondCwd, { recursive: true });

    const first = run(createTool, [name, "--json"], firstCwd);
    const second = run(createTool, [name, "--json"], secondCwd);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const json = JSON.parse(first.stdout) as {
      valid: boolean;
      errors: unknown[];
      warnings: unknown[];
      targetDir: string;
      files: string[];
    };
    expect(Object.keys(json)).toEqual([
      "valid",
      "errors",
      "warnings",
      "targetDir",
      "files",
    ]);
    expect(json.valid).toBe(true);
    expect(json.files).toEqual([
      ".aidlc-plugin/plugin.json",
      "README.md",
      "agents/example-plugin-example-agent.md",
      "scopes/example-plugin-example.md",
      "stages/construction/example-plugin-example-stage.md",
      "tests/README.md",
    ]);
    expect(
      treeFiles(join(firstCwd, name)),
    ).toEqual(treeFiles(join(secondCwd, name)));
    expect(existsSync(join(firstCwd, name, "hooks", "compose.ts"))).toBe(
      false,
    );
  });

  test("fresh scaffold validates, builds, and composes cleanly", () => {
    const name = "toolchain-plugin";
    const parent = join(scratch, "whole-toolchain");
    mkdirSync(parent, { recursive: true });
    const created = run(createTool, [name], parent);
    expect(created.status, created.stderr).toBe(0);
    const pluginRoot = join(parent, name);

    const validated = run(validateTool, [pluginRoot, "--json"]);
    expect(validated.status, validated.stderr).toBe(0);
    const validationJson = JSON.parse(validated.stdout) as {
      valid: boolean;
      warnings: Array<{ rule: string }>;
    };
    expect(validationJson.valid).toBe(true);
    expect(validationJson.warnings.map((finding) => finding.rule)).toEqual([
      "compose-hook-absent",
    ]);

    const built = run(buildTool, [pluginRoot, "claude", "--json"]);
    expect(built.status, built.stderr).toBe(0);
    expect(
      existsSync(join(pluginRoot, "dist", "claude", "hooks", "compose.ts")),
    ).toBe(true);

    const installRoot = join(scratch, "whole-toolchain-install");
    cpSync(CLAUDE_INSTALL, installRoot, { recursive: true });
    const before = treeDigest(installRoot);
    const tested = run(testTool, [
      pluginRoot,
      "--install",
      installRoot,
      "--json",
    ]);
    expect(tested.status, tested.stderr).toBe(0);
    const testJson = JSON.parse(tested.stdout) as {
      valid: boolean;
      drops: unknown[];
      graph: {
        compiled: boolean;
        presentStages: string[];
        presentScopes: string[];
      };
      composedFiles: string[];
      idempotent: boolean;
    };
    expect(testJson.valid).toBe(true);
    expect(testJson.drops).toEqual([]);
    expect(testJson.graph.compiled).toBe(true);
    expect(testJson.graph.presentStages).toContain(
      "toolchain-plugin-example-stage",
    );
    expect(testJson.graph.presentScopes).toContain(
      "toolchain-plugin-example",
    );
    expect(testJson.composedFiles).toContain(
      ".claude/skills/toolchain-plugin-example-stage/SKILL.md",
    );
    expect(testJson.composedFiles).toContain(
      ".claude/skills/toolchain-plugin-example/SKILL.md",
    );
    expect(testJson.idempotent).toBe(true);
    expect(treeDigest(installRoot)).toBe(before);
  });

  test("non-empty targets and invalid names are refused without writes", () => {
    const name = "occupied-plugin";
    const occupied = join(scratch, "occupied", name);
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "existing.txt"), "keep\n", "utf-8");
    const refused = run(createTool, [name, occupied, "--json"]);
    expect(refused.status).toBe(1);
    const refusedJson = JSON.parse(refused.stdout) as {
      errors: Array<{ rule: string; message: string }>;
    };
    expect(refusedJson.errors).toContainEqual(
      expect.objectContaining({
        rule: "create-target",
        message: expect.stringContaining("existing.txt"),
      }),
    );
    expect(readFileSync(join(occupied, "existing.txt"), "utf-8")).toBe(
      "keep\n",
    );

    const badTarget = join(scratch, "bad-name", "Bad_Name");
    const badName = run(createTool, ["Bad_Name", badTarget, "--json"]);
    expect(badName.status).toBe(1);
    const badJson = JSON.parse(badName.stdout) as {
      errors: Array<{
        file: string;
        rule: string;
        message: string;
        fix: string;
      }>;
    };
    expect(badJson.errors).toContainEqual({
      rule: "manifest-name",
      file: ".aidlc-plugin/plugin.json",
      message: 'manifest name "Bad_Name" must be lowercase kebab-case',
      fix: "Use a name matching /^[a-z][a-z0-9-]*$/.",
    });
    expect(existsSync(badTarget)).toBe(false);
  });

  test("usage errors exit 2 and all executable inputs are isolated", () => {
    expect(run(createTool, []).status).toBe(2);
    expect(run(createTool, ["one", "two", "three"]).status).toBe(2);
    for (const tool of [createTool, validateTool, buildTool, testTool]) {
      expect(tool.startsWith(scratch)).toBe(true);
      expect(existsSync(tool)).toBe(true);
    }
  });
});
