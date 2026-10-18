// covers: file:core/tools/aidlc-plugin-build.ts, file:core/tools/aidlc-plugin-emit.ts,
// function:runWithOwnerStampedLock

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  utimesSync,
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
import { asShippedBuild } from "../harness/plugin-host-names.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
// A 0500 folder refuses only a process its mode bits bind: Windows ignores
// them for folders, and root ignores them everywhere.
const FOLDER_MODES_BIND = process.platform !== "win32" && process.getuid?.() !== 0;

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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

function withTmpdir<T>(temp: string, action: () => T): T {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  try {
    return action();
  } finally {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
  }
}

function minimalPlugin(name: string, aidlc: Record<string, unknown> = {}): string {
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
        aidlc: { ...aidlc, contributes: { tools: "tools/" } },
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

function treeDiff(
  expected: string,
  actual: string,
  shape: (files: Map<string, Buffer>) => Map<string, Buffer> = (files) => files,
): string[] {
  const expectedFiles = shape(treeFiles(expected));
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
  test("copied tools build test-pro byte for byte as the packager does, under its own names", () => {
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
        treeDiff(join(EXPECTED_ROOT, harness), outDir, asShippedBuild(harness)),
        harness,
      ).toEqual([]);
    }
  });

  test("a plugin someone else builds carries the names its author chose", () => {
    const root = minimalPlugin("acme-standards");
    const named = minimalPlugin("acme-rules", { marketplace: "acme-aidlc-plugins" });
    const catalogue = (outDir: string, dir: string) =>
      JSON.parse(readFileSync(join(outDir, dir, "marketplace.json"), "utf-8")) as {
        name: string;
        plugins: Array<{ name: string }>;
      };
    const hostName = (outDir: string, dir: string) =>
      (JSON.parse(readFileSync(join(outDir, dir, "plugin.json"), "utf-8")) as { name: string }).name;

    const claude = join(scratch, "third-party", "claude");
    expect(run([root, "claude", claude, "--json"]).status).toBe(0);
    expect(hostName(claude, ".claude-plugin")).toBe("acme-standards");
    expect(catalogue(claude, ".claude-plugin").name).toBe("acme-standards");
    expect(catalogue(claude, ".claude-plugin").plugins.map((entry) => entry.name)).toEqual(["acme-standards"]);

    const codex = join(scratch, "third-party", "codex");
    expect(run([named, "codex", codex, "--json"]).status).toBe(0);
    expect(hostName(codex, ".codex-plugin")).toBe("acme-rules");
    expect(catalogue(codex, join(".agents", "plugins")).name).toBe("acme-aidlc-plugins");
    expect(catalogue(codex, join(".agents", "plugins")).plugins.map((entry) => entry.name)).toEqual(["acme-rules"]);

    // On Kiro the whole plugin sits in its own folder, so a second plugin
    // dropped into the same project never lands on the first.
    const kiro = join(scratch, "third-party", "kiro-ide");
    expect(run([root, "kiro-ide", kiro, "--json"]).status).toBe(0);
    const folder = join(".kiro", "aidlc-plugins", "acme-standards");
    expect(hostName(kiro, join(folder, ".kiro-plugin"))).toBe("acme-standards");
    expect(existsSync(join(kiro, folder, ".aidlc-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(kiro, folder, "hooks", "compose.ts"))).toBe(true);
    expect(existsSync(join(kiro, folder, "tools", "acme-standards-tool.ts"))).toBe(true);
    expect(readdirSync(kiro).sort()).toEqual([".aidlc-plugin-projection.json", ".kiro"]);
    expect(readdirSync(join(kiro, ".kiro")).sort()).toEqual(["aidlc-plugins", "hooks"]);
    expect(readdirSync(join(kiro, ".kiro", "hooks"))).toEqual(["aidlc-acme-standards-compose.json"]);
  });

  test("default output is <plugin-root>/dist/<harness>", () => {
    const pluginRoot = copyPlugin("default-output");
    const result = run([pluginRoot, "claude", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      treeDiff(
        join(EXPECTED_ROOT, "claude"),
        join(pluginRoot, "dist", "claude"),
        asShippedBuild("claude"),
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

  test("direct emission reclaims a dead owner-stamped output lock", () => {
    const pluginRoot = copyPlugin("dead-output-lock");
    const outDir = join(scratch, "dead-owner-output");
    const lockDir = pluginBuildLockPath(outDir);
    const token = randomUUID();
    mkdirSync(join(lockDir, token), { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 2_000_000_000,
        startedAtMs: Math.floor(
          performance.timeOrigin + performance.now(),
        ),
        reapLiveOwnerAfterStale: true,
        token,
      }),
      "utf-8",
    );
    const target = readPluginTargets(
      join(SOURCE_TOOLS, "data", "plugin-targets.json"),
    ).claude;

    buildPluginProjection({
      pluginRoot,
      target,
      outDir,
      templateHooksDir: join(
        SOURCE_TOOLS,
        "data",
        "plugin-hooks-template",
      ),
      lockTimeoutMs: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });

    expect(existsSync(outDir)).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  test("direct emission does not reclaim a live owner-stamped output lock", () => {
    const pluginRoot = copyPlugin("live-output-lock");
    const outDir = join(scratch, "live-owner-output");
    const lockDir = pluginBuildLockPath(outDir);
    const token = randomUUID();
    mkdirSync(join(lockDir, token), { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        startedAtMs: Math.floor(
          performance.timeOrigin + performance.now(),
        ),
        reapLiveOwnerAfterStale: true,
        token,
      }),
      "utf-8",
    );
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
      expect(existsSync(lockDir)).toBe(true);
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("direct emission reclaims only an aged unstamped output lock", () => {
    const pluginRoot = copyPlugin("aged-unstamped-output-lock");
    const outDir = join(scratch, "aged-unstamped-output");
    const lockDir = pluginBuildLockPath(outDir);
    mkdirSync(lockDir, { recursive: true });
    utimesSync(lockDir, new Date(0), new Date(0));
    const target = readPluginTargets(
      join(SOURCE_TOOLS, "data", "plugin-targets.json"),
    ).claude;
    const previousGrace = process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS;
    process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS = "1";
    try {
      buildPluginProjection({
        pluginRoot,
        target,
        outDir,
        templateHooksDir: join(
          SOURCE_TOOLS,
          "data",
          "plugin-hooks-template",
        ),
        lockTimeoutMs: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(existsSync(outDir)).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      if (previousGrace === undefined) {
        delete process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS;
      } else {
        process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS = previousGrace;
      }
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!FOLDER_MODES_BIND)("another user's lock folder in a shared temp folder does not hold up a build", () => {
    const pluginRoot = copyPlugin("shared-temp-lock-folder");
    const outDir = join(scratch, "shared-temp-output");
    const temp = join(scratch, "shared-temp");
    // The folder all users' builds share in older releases, made first by
    // another user: this user cannot write it.
    const sharedFolder = join(temp, "aidlc-plugin-build-locks");
    mkdirSync(sharedFolder, { recursive: true });
    chmodSync(sharedFolder, 0o500);
    const target = readPluginTargets(
      join(SOURCE_TOOLS, "data", "plugin-targets.json"),
    ).claude;
    try {
      withTmpdir(temp, () =>
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
      );
      expect(existsSync(outDir)).toBe(true);
    } finally {
      chmodSync(sharedFolder, 0o700);
    }
  });

  test.skipIf(!FOLDER_MODES_BIND)("a lock folder this user cannot write stops the build by name, not as a busy lock", () => {
    const pluginRoot = copyPlugin("unwritable-lock-folder");
    const outDir = join(scratch, "unwritable-lock-folder-output");
    const temp = join(scratch, "unwritable-lock-temp");
    const lockFolder = withTmpdir(temp, () => dirname(pluginBuildLockPath(outDir)));
    mkdirSync(lockFolder, { recursive: true });
    chmodSync(lockFolder, 0o500);
    const target = readPluginTargets(
      join(SOURCE_TOOLS, "data", "plugin-targets.json"),
    ).claude;
    let refusal: unknown;
    try {
      withTmpdir(temp, () =>
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
      );
    } catch (error) {
      refusal = error;
    } finally {
      chmodSync(lockFolder, 0o700);
    }
    expect(refusal).toMatchObject({
      name: "PluginBuildLockFolderError",
      message: `cannot write the plugin build lock folder "${lockFolder}" (EACCES)`,
      fix: "Set TMPDIR to a folder you own, then run the command again.",
    });
    expect(existsSync(outDir)).toBe(false);
  });

  test.skipIf(!FOLDER_MODES_BIND)("plugin build prints the lock folder it cannot write, and the TMPDIR fix as its Fix line", () => {
    const pluginRoot = copyPlugin("unwritable-lock-folder-cli");
    const outDir = join(scratch, "unwritable-lock-folder-cli-output");
    const temp = join(scratch, "unwritable-lock-cli-temp");
    const lockFolder = withTmpdir(temp, () => dirname(pluginBuildLockPath(outDir)));
    mkdirSync(lockFolder, { recursive: true });
    chmodSync(lockFolder, 0o500);
    try {
      const result = withTmpdir(temp, () =>
        run([pluginRoot, "claude", outDir, "--json"])
      );
      expect(result.status, result.stderr).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        errors: Array<{ rule: string; message: string; fix: string }>;
      };
      expect(parsed.errors).toContainEqual(
        expect.objectContaining({
          rule: "build-output",
          message: `cannot write the plugin build lock folder "${lockFolder}" (EACCES)`,
          fix: "Set TMPDIR to a folder you own, then run the command again.",
        }),
      );
      expect(existsSync(outDir)).toBe(false);
    } finally {
      chmodSync(lockFolder, 0o700);
    }
  });

  test.skipIf(!FOLDER_MODES_BIND)("plugin build prints the TMPDIR fix when its lock folder cannot be created", () => {
    const pluginRoot = copyPlugin("uncreatable-lock-folder-cli");
    const outDir = join(scratch, "uncreatable-lock-folder-cli-output");
    const temp = join(scratch, "uncreatable-lock-cli-temp");
    const lockFolder = withTmpdir(temp, () => dirname(pluginBuildLockPath(outDir)));
    mkdirSync(temp, { recursive: true });
    chmodSync(temp, 0o500);
    try {
      const result = withTmpdir(temp, () =>
        run([pluginRoot, "claude", outDir, "--json"])
      );
      expect(result.status, result.stderr).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        errors: Array<{ rule: string; message: string; fix: string }>;
      };
      expect(parsed.errors).toContainEqual(
        expect.objectContaining({
          rule: "build-output",
          message: `cannot write the plugin build lock folder "${lockFolder}" (EACCES)`,
          fix: "Set TMPDIR to a folder you own, then run the command again.",
        }),
      );
      expect(existsSync(lockFolder)).toBe(false);
      expect(existsSync(outDir)).toBe(false);
    } finally {
      chmodSync(temp, 0o700);
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
      treeDiff(join(EXPECTED_ROOT, "claude"), outDir, asShippedBuild("claude")),
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
    expect(treeDiff(join(EXPECTED_ROOT, "claude"), outDir, asShippedBuild("claude"))).toEqual([]);
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

  test("a plugin that orders after another plugin's stage without declaring it does not build, and says the one step", () => {
    const pluginRoot = join(scratch, "undeclared-plugin", "beta");
    const created = spawnSync(process.execPath, [join(copiedTools, "aidlc-plugin-create.ts"), "beta", pluginRoot], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    expect(created.status, created.stderr).toBe(0);
    const stagePath = join(pluginRoot, "stages", "construction", "beta-example-stage.md");
    writeFileSync(
      stagePath,
      readFileSync(stagePath, "utf-8").replace("requires_stage: []", "requires_stage:\n  - zeta-example-stage"),
      "utf-8",
    );
    const outDir = join(scratch, "undeclared-plugin-output");
    const result = run([pluginRoot, "claude", outDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Plugin build: FAILED");
    expect(result.stderr).toContain(
      `ERROR stages/construction/beta-example-stage.md [base-reference]: requires_stage "zeta-example-stage" is not a core stage or one of beta's own`,
    );
    expect(result.stderr).toContain('Fix: If another plugin ships it, add that plugin to dependencies next to "core"');
    expect(existsSync(outDir)).toBe(false);
  });

  test("a team plugin whose stage leads with its base's agent builds, saying once that the agent is not checked", () => {
    const pluginRoot = join(scratch, "team-plugin", "alpha");
    const created = spawnSync(process.execPath, [join(copiedTools, "aidlc-plugin-create.ts"), "alpha", pluginRoot], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    expect(created.status, created.stderr).toBe(0);
    const manifestPath = join(pluginRoot, ".aidlc-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    manifest.dependencies = ["core", "zeta@^0.1.0"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    const stagePath = join(pluginRoot, "stages", "construction", "alpha-example-stage.md");
    writeFileSync(
      stagePath,
      readFileSync(stagePath, "utf-8").replace("lead_agent: alpha-example-agent", "lead_agent: zeta-example-agent"),
      "utf-8",
    );
    const outDir = join(scratch, "team-plugin-output");
    const result = run([pluginRoot, "claude", outDir]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Plugin build: COMPLETE");
    expect(result.stdout).toContain(
      'WARNING stages/construction/alpha-example-stage.md [base-reference]: agent "zeta-example-agent" is not checked: it would come from zeta, the base this plugin builds on',
    );
    expect(existsSync(join(outDir, "stages", "construction", "alpha-example-stage.md"))).toBe(true);
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
