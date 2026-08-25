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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPluginProjection,
  pluginBuildLockPath,
  readPluginTargets,
} from "../../dist/claude/.claude/tools/aidlc-plugin-emit.ts";

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
const PROJECTION_MARKER = ".aidlc-plugin-projection.json";

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

function minimalPlugin(name: string): string {
  const root = join(scratch, "minimal-plugins", name);
  mkdirSync(join(root, ".aidlc-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".aidlc-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        description: "Minimal plugin",
        author: { name: "Fixture" },
        dependencies: ["core"],
        aidlc: { contributes: { tools: "tools/" } },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf-8", flag: "w" },
  );
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(
    join(root, "tools", `${name}-tool.ts`),
    'console.log("fixture");\n',
    "utf-8",
  );
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

  test("the same plugin and harness can rebuild its owned projection", () => {
    const pluginRoot = copyPlugin("same-owner-rebuild");
    const outDir = join(scratch, "same-owner-output");
    expect(run([pluginRoot, "claude", outDir, "--json"]).status).toBe(0);
    const marker = JSON.parse(
      readFileSync(join(outDir, PROJECTION_MARKER), "utf-8"),
    ) as Record<string, unknown>;
    expect(marker).toEqual({
      schema: 1,
      producer: "aidlc-plugin-build",
      plugin: "test-pro",
      harness: "claude",
    });
    writeFileSync(join(outDir, "stale-sentinel.txt"), "stale\n", "utf-8");

    const rebuilt = run([pluginRoot, "claude", outDir, "--json"]);
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(existsSync(join(outDir, "stale-sentinel.txt"))).toBe(false);
  });

  test("a different plugin cannot replace another plugin's projection", () => {
    const owner = copyPlugin("different-plugin-owner");
    const other = minimalPlugin("other-plugin");
    const outDir = join(scratch, "different-plugin-output");
    expect(run([owner, "claude", outDir, "--json"]).status).toBe(0);
    const manifestPath = join(outDir, ".claude-plugin", "plugin.json");
    const originalManifest = readFileSync(manifestPath, "utf-8");
    writeFileSync(join(outDir, "sentinel.txt"), "preserve\n", "utf-8");

    const refused = run([other, "claude", outDir, "--json"]);
    expect(refused.status).toBe(1);
    const parsed = JSON.parse(refused.stdout) as {
      errors: Array<{ rule: string; message: string }>;
    };
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({
        rule: "build-output",
        message: expect.stringContaining(
          'belongs to plugin "test-pro" for harness "claude"',
        ),
      }),
    );
    expect(readFileSync(join(outDir, "sentinel.txt"), "utf-8")).toBe(
      "preserve\n",
    );
    expect(readFileSync(manifestPath, "utf-8")).toBe(originalManifest);
  });

  test("shared Kiro output shapes remain bound to the exact harness", () => {
    const pluginRoot = copyPlugin("kiro-owner");
    const outDir = join(scratch, "kiro-owned-output");
    expect(run([pluginRoot, "kiro", outDir, "--json"]).status).toBe(0);
    writeFileSync(join(outDir, "sentinel.txt"), "preserve\n", "utf-8");

    const refused = run([pluginRoot, "kiro-ide", outDir, "--json"]);
    expect(refused.status).toBe(1);
    const parsed = JSON.parse(refused.stdout) as {
      errors: Array<{ message: string }>;
    };
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          'belongs to plugin "test-pro" for harness "kiro"',
        ),
      }),
    );
    expect(existsSync(join(outDir, "sentinel.txt"))).toBe(true);
  });

  test("missing and malformed ownership markers refuse rebuilds without mutation", () => {
    const pluginRoot = copyPlugin("invalid-marker-owner");
    for (const [label, markerBody] of [
      ["missing", null],
      ["malformed", "{not-json}\n"],
    ] as const) {
      const outDir = join(scratch, `invalid-marker-${label}`);
      expect(run([pluginRoot, "claude", outDir, "--json"]).status).toBe(0);
      const markerPath = join(outDir, PROJECTION_MARKER);
      if (markerBody === null) rmSync(markerPath);
      else writeFileSync(markerPath, markerBody, "utf-8");
      writeFileSync(join(outDir, "sentinel.txt"), "preserve\n", "utf-8");

      const refused = run([pluginRoot, "claude", outDir, "--json"]);
      expect(refused.status).toBe(1);
      const parsed = JSON.parse(refused.stdout) as {
        errors: Array<{ rule: string; message: string }>;
      };
      expect(parsed.errors).toContainEqual(
        expect.objectContaining({
          rule: "build-output",
          message: expect.stringContaining("no valid"),
        }),
      );
      expect(existsSync(join(outDir, "sentinel.txt"))).toBe(true);
    }
  });

  test("direct emission refuses a contended output lock before creating output", () => {
    const pluginRoot = copyPlugin("contended-output-lock");
    const outDir = join(scratch, "contended-output");
    const lockDir = pluginBuildLockPath(outDir);
    mkdirSync(lockDir, { recursive: true });
    const target = readPluginTargets(
      join(SOURCE_TOOLS, "data", "plugin-targets.json"),
    ).claude;
    try {
      expect(() =>
        buildPluginProjection({
          pluginRoot,
          target,
          outDir,
          templateHooksDir: join(
            SOURCE_TOOLS,
            "data",
            "plugin-hooks-template",
          ),
          lockTimeoutMs: 25,
        })
      ).toThrow("could not acquire plugin build output lock");
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("custom output under a symlinked environmental ancestor remains valid", () => {
    const pluginRoot = copyPlugin("symlinked-environment-custom");
    const realEnvironment = join(scratch, "real-environment");
    const linkedEnvironment = join(scratch, "linked-environment");
    mkdirSync(realEnvironment, { recursive: true });
    symlinkSync(
      realEnvironment,
      linkedEnvironment,
      process.platform === "win32" ? "junction" : "dir",
    );
    const outDir = join(linkedEnvironment, "owned-output");

    const result = run([pluginRoot, "claude", outDir, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      treeDiff(join(EXPECTED_ROOT, "claude"), outDir),
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

  test("non-canonical contribution paths refuse BUILD before output creation", () => {
    const pluginRoot = copyPlugin("custom-contribution-path");
    renameSync(join(pluginRoot, "stages"), join(pluginRoot, "custom-stages"));
    const manifestPath = join(pluginRoot, ".aidlc-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      aidlc: { contributes: Record<string, string> };
    };
    manifest.aidlc.contributes.stages = "custom-stages/";
    writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
    const outDir = join(scratch, "custom-contribution-output");

    const result = run([pluginRoot, "claude", outDir, "--json"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      errors: Array<{ rule: string; message: string }>;
    };
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({
        rule: "manifest-shape",
        message: expect.stringContaining(
          'aidlc.contributes.stages must be "stages/"',
        ),
      }),
    );
    expect(existsSync(outDir)).toBe(false);
  });

  test("direct emission rejects absolute contribution paths before output creation", () => {
    const pluginRoot = copyPlugin("absolute-contribution-path");
    const manifestPath = join(pluginRoot, ".aidlc-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      aidlc: { contributes: Record<string, string> };
    };
    manifest.aidlc.contributes.stages = join(
      scratch,
      "outside-plugin-stages",
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
    const outDir = join(scratch, "absolute-contribution-output");
    const target = readPluginTargets(
      join(SOURCE_TOOLS, "data", "plugin-targets.json"),
    ).claude;

    expect(() =>
      buildPluginProjection({
        pluginRoot,
        target,
        outDir,
        templateHooksDir: join(
          SOURCE_TOOLS,
          "data",
          "plugin-hooks-template",
        ),
      })
    ).toThrow('aidlc.contributes.stages must be "stages/"');
    expect(existsSync(outDir)).toBe(false);
  });

  test("default output refuses a symlinked dist parent without touching its target", () => {
    const pluginRoot = copyPlugin("symlinked-default-parent");
    const linkedTarget = join(scratch, "symlinked-dist-target");
    mkdirSync(linkedTarget, { recursive: true });
    writeFileSync(join(linkedTarget, "sentinel.txt"), "unchanged\n", "utf-8");
    const distLink = join(pluginRoot, "dist");
    symlinkSync(
      linkedTarget,
      distLink,
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = run([pluginRoot, "claude", "--json"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      errors: Array<{ rule: string; message: string }>;
    };
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({
        rule: "build-output",
        message: expect.stringContaining(
          `parent path component "${distLink}" is a symlink`,
        ),
      }),
    );
    expect(readdirSync(linkedTarget)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(linkedTarget, "sentinel.txt"), "utf-8")).toBe(
      "unchanged\n",
    );
  });

  test("linked authored content refuses the build before output creation", () => {
    const pluginRoot = copyPlugin("symlinked-content");
    const linkedSource = join(scratch, "linked-plugin-tool.ts");
    writeFileSync(linkedSource, 'console.log("linked");\n', "utf-8");
    const linkedTool = join(pluginRoot, "tools", "linked-plugin-tool.ts");
    symlinkSync(linkedSource, linkedTool, "file");
    const outDir = join(scratch, "symlinked-content-output");

    const result = run([pluginRoot, "claude", outDir, "--json"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      errors: Array<{ file: string; rule: string }>;
    };
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({
        file: "tools/linked-plugin-tool.ts",
        rule: "content-symlink",
      }),
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
