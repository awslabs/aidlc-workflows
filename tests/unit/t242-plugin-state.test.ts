import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import {
  collectPluginStatus,
  comparePluginState,
  confirmPrune,
  discoverPluginInventory,
  normalizeInstalledPlugin,
  pluginSourceHash,
  renderPluginStatuses,
  syncPlugins,
  type CompositionStamp,
  type InstalledPlugin,
  type PluginInventory,
  type ProjectEvidence,
} from "../../core/tools/aidlc-plugin.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "plugin-inventory");
const TEST_PRO = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
const ORIGINAL_ENV = { ...process.env };
const TEMP: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  TEMP.push(path);
  return path;
}

function surfaceSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (lstatSync(path).isDirectory()) visit(path, rel);
      else snapshot[rel] = readFileSync(path).toString("base64");
    }
  };
  visit(root, "");
  return snapshot;
}

function pluginRoot(
  harness: "claude" | "codex" | "kiro" = "claude",
  version = "0.1.0",
): string {
  const root = temp("aidlc-plugin-fixture-");
  const manifestDir = harness === "claude"
    ? ".claude-plugin"
    : harness === "codex"
    ? ".codex-plugin"
    : ".kiro-plugin";
  mkdirSync(join(root, manifestDir), { recursive: true });
  mkdirSync(join(root, "stages", "construction"), { recursive: true });
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(
    join(root, manifestDir, "plugin.json"),
    `${JSON.stringify({ name: "aidlc-test-pro", version })}\n`,
  );
  writeFileSync(
    join(root, "stages", "construction", "test-pro-stage.md"),
    "---\nname: test\npath: {{HARNESS_DIR}}/tools\n---\n",
  );
  writeFileSync(join(root, "hooks", "compose.ts"), "throw new Error('excluded wrapper');\n");
  return root;
}

function stamp(
  name: string,
  version: string,
  sourceHash: string,
): CompositionStamp {
  return { schemaVersion: 1, name, version, sourceHash };
}

function installed(
  key: string,
  version: string,
  sourceHash: string,
  enabled = true,
): InstalledPlugin {
  return {
    key,
    hostName: `aidlc-${key}`,
    version,
    root: `/plugins/${key}`,
    manifestPath: `/plugins/${key}/.claude-plugin/plugin.json`,
    enabled,
    sourceHash,
  };
}

function evidence(
  stamps: CompositionStamp[] = [],
  legacy: string[] = [],
): ProjectEvidence {
  return {
    stamps: new Map(stamps.map((value) => [value.name, value])),
    legacy: new Set(legacy),
    ownership: new Map(),
  };
}

function inventory(
  plugins: InstalledPlugin[],
  invalid: PluginInventory["invalid"] = [],
): PluginInventory {
  return {
    capability: "full-inventory",
    harness: "claude",
    installed: plugins,
    invalid,
  };
}

function withClaudeFixture(root: string, version = "0.1.0"): void {
  const fixtureDir = temp("aidlc-claude-inventory-");
  const registry = readFileSync(join(FIXTURES, "claude-installed-plugins.json"), "utf-8")
    .replace("{{PLUGIN_ROOT}}", root.replaceAll("\\", "\\\\"))
    .replaceAll('"version": "0.1.0"', `"version": "${version}"`);
  writeFileSync(join(fixtureDir, "installed.json"), registry);
  cpSync(join(FIXTURES, "claude-settings.json"), join(fixtureDir, "settings.json"));
  process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY = join(fixtureDir, "installed.json");
  process.env.AIDLC_CLAUDE_SETTINGS = join(fixtureDir, "settings.json");
  process.env.AIDLC_HARNESS_DIR = ".claude";
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  for (const path of TEMP.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("t242 plugin manifest and hash contract", () => {
  test("normalizes one host manifest and strips exactly the aidlc- namespace", () => {
    const root = pluginRoot();
    expect(normalizeInstalledPlugin(root, "claude")).toEqual(expect.objectContaining({
      key: "test-pro",
      hostName: "aidlc-test-pro",
      version: "0.1.0",
      root,
      manifestPath: join(root, ".claude-plugin", "plugin.json"),
    }));
  });

  test("rejects invalid namespace, key, version, and host-version mismatch", () => {
    const root = pluginRoot();
    const path = join(root, ".claude-plugin", "plugin.json");
    for (const manifest of [
      { name: "test-pro", version: "0.1.0" },
      { name: "aidlc-Test_Pro", version: "0.1.0" },
      { name: "aidlc-test-pro", version: "latest" },
    ]) {
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => normalizeInstalledPlugin(root, "claude")).toThrow();
    }
    writeFileSync(path, JSON.stringify({ name: "aidlc-test-pro", version: "0.1.0" }));
    expect(() => normalizeInstalledPlugin(root, "claude", true, "0.2.0"))
      .toThrow("does not match host inventory version");
  });

  test("hashes sorted relative paths and LF-normalized source before token substitution", () => {
    const root = pluginRoot();
    const path = join(root, "stages", "construction", "test-pro-stage.md");
    const first = pluginSourceHash(root);
    writeFileSync(path, readFileSync(path, "utf-8").replaceAll("\n", "\r\n"));
    expect(pluginSourceHash(root)).toBe(first);
    writeFileSync(join(root, "hooks", "compose.ts"), "changed host wrapper\n");
    expect(pluginSourceHash(root)).toBe(first);
    const renamed = join(root, "stages", "construction", "renamed.md");
    renameSync(path, renamed);
    expect(pluginSourceHash(root)).not.toBe(first);
    expect(readFileSync(renamed, "utf-8")).toContain("{{HARNESS_DIR}}");
  });
});

describe("t242 fixture-proved host inventories", () => {
  test("Claude reads registry v2, exact installPath, and enabledPlugins", () => {
    const root = pluginRoot();
    withClaudeFixture(root);
    const result = discoverPluginInventory(".claude");
    expect(result.capability).toBe("full-inventory");
    expect(result.source).toBe(process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY);
    expect(result.invalid).toEqual([]);
    expect(result.installed).toEqual([
      expect.objectContaining({ key: "test-pro", version: "0.1.0", root, enabled: true }),
    ]);
  });

  test("Claude uses settings for disablement and the registry for uninstall state", () => {
    const root = pluginRoot();
    withClaudeFixture(root);
    writeFileSync(
      process.env.AIDLC_CLAUDE_SETTINGS as string,
      '{"enabledPlugins":{"aidlc-test-pro@fixture-marketplace":false}}\n',
    );
    expect(discoverPluginInventory(".claude").installed).toEqual([
      expect.objectContaining({ key: "test-pro", enabled: false }),
    ]);

    writeFileSync(
      process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY as string,
      '{"version":2,"plugins":{}}\n',
    );
    expect(discoverPluginInventory(".claude")).toEqual(expect.objectContaining({
      capability: "full-inventory",
      installed: [],
      invalid: [],
    }));
    expect(existsSync(root)).toBe(true);
  });

  test("Claude downgrades malformed enablement settings to unavailable inventory", () => {
    const root = pluginRoot();
    withClaudeFixture(root);
    writeFileSync(process.env.AIDLC_CLAUDE_SETTINGS as string, "{not-json");
    process.env.AIDLC_PLUGIN_ROOT = "";
    process.env.CLAUDE_PLUGIN_ROOT = "";
    process.env.PLUGIN_ROOT = "";

    const result = discoverPluginInventory(".claude");
    expect(result).toEqual(expect.objectContaining({
      capability: "current-root-only",
      installed: [],
      invalid: [],
    }));
    expect(comparePluginState(result, evidence(), null)).toEqual([
      expect.objectContaining({
        state: "inventory-unavailable",
        action: "attention",
      }),
    ]);
  });

  test("Codex enumerates declared IDs and their fixed semver cache path", () => {
    const root = pluginRoot("codex");
    const codexHome = temp("aidlc-codex-home-");
    const installedRoot = join(
      codexHome,
      "plugins",
      "cache",
      "fixture-marketplace",
      "aidlc-test-pro",
      "0.1.0",
    );
    mkdirSync(join(installedRoot, ".."), { recursive: true });
    cpSync(root, installedRoot, { recursive: true });
    cpSync(join(FIXTURES, "codex-config.toml"), join(codexHome, "config.toml"));
    process.env.AIDLC_CODEX_HOME = codexHome;
    process.env.AIDLC_HARNESS_DIR = ".codex";
    const result = discoverPluginInventory(".codex");
    expect(result.capability).toBe("full-inventory");
    expect(result.invalid).toEqual([]);
    expect(result.installed).toEqual([
      expect.objectContaining({ key: "test-pro", root: installedRoot, enabled: true }),
    ]);
  });

  test("Codex accepts the documented local marketplace cache leaf", () => {
    const root = pluginRoot("codex");
    const codexHome = temp("aidlc-codex-local-");
    const installedRoot = join(
      codexHome,
      "plugins",
      "cache",
      "fixture-marketplace",
      "aidlc-test-pro",
      "local",
    );
    mkdirSync(join(installedRoot, ".."), { recursive: true });
    cpSync(root, installedRoot, { recursive: true });
    cpSync(join(FIXTURES, "codex-config.toml"), join(codexHome, "config.toml"));
    process.env.AIDLC_CODEX_HOME = codexHome;
    process.env.AIDLC_HARNESS_DIR = ".codex";

    expect(discoverPluginInventory(".codex")).toEqual(expect.objectContaining({
      capability: "full-inventory",
      invalid: [],
      installed: [
        expect.objectContaining({
          key: "test-pro",
          version: "0.1.0",
          root: installedRoot,
          enabled: true,
        }),
      ],
    }));
  });

  test("Codex rejects traversal marketplace IDs before reading outside its cache", () => {
    const codexHome = temp("aidlc-codex-traversal-");
    writeFileSync(
      join(codexHome, "config.toml"),
      '[plugins."aidlc-test-pro@.."]\nenabled = true\n',
    );
    process.env.AIDLC_CODEX_HOME = codexHome;
    process.env.AIDLC_HARNESS_DIR = ".codex";

    const result = discoverPluginInventory(".codex");
    expect(result.installed).toEqual([]);
    expect(result.invalid).toEqual([
      expect.objectContaining({
        paths: [join(codexHome, "config.toml")],
        message: expect.stringContaining("is not name@marketplace"),
      }),
    ]);
  });

  test("Codex collapses stale semver cache directories to the newest version", () => {
    const oldRoot = pluginRoot("codex", "0.1.0");
    const newRoot = pluginRoot("codex", "0.2.0");
    const codexHome = temp("aidlc-codex-stale-versions-");
    const cacheRoot = join(
      codexHome,
      "plugins",
      "cache",
      "fixture-marketplace",
      "aidlc-test-pro",
    );
    mkdirSync(cacheRoot, { recursive: true });
    cpSync(oldRoot, join(cacheRoot, "0.1.0"), { recursive: true });
    cpSync(newRoot, join(cacheRoot, "0.2.0"), { recursive: true });
    cpSync(join(FIXTURES, "codex-config.toml"), join(codexHome, "config.toml"));
    process.env.AIDLC_CODEX_HOME = codexHome;
    process.env.AIDLC_HARNESS_DIR = ".codex";

    const result = discoverPluginInventory(".codex");
    expect(result.invalid).toEqual([]);
    expect(result.installed).toEqual([
      expect.objectContaining({
        key: "test-pro",
        version: "0.2.0",
        root: join(cacheRoot, "0.2.0"),
      }),
    ]);
  });

  test("Codex uses config disablement and ignores a cache retained after removal", () => {
    const root = pluginRoot("codex");
    const codexHome = temp("aidlc-codex-uninstall-");
    const installedRoot = join(
      codexHome,
      "plugins",
      "cache",
      "fixture-marketplace",
      "aidlc-test-pro",
      "0.1.0",
    );
    mkdirSync(join(installedRoot, ".."), { recursive: true });
    cpSync(root, installedRoot, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      '[plugins."aidlc-test-pro@fixture-marketplace"]\nenabled = false\n',
    );
    process.env.AIDLC_CODEX_HOME = codexHome;
    process.env.AIDLC_HARNESS_DIR = ".codex";
    expect(discoverPluginInventory(".codex").installed).toEqual([
      expect.objectContaining({ key: "test-pro", enabled: false }),
    ]);

    writeFileSync(join(codexHome, "config.toml"), "");
    expect(discoverPluginInventory(".codex")).toEqual(expect.objectContaining({
      capability: "full-inventory",
      installed: [],
      invalid: [],
    }));
    expect(existsSync(installedRoot)).toBe(true);
  });

  test("Kiro and a disappeared full registry remain current-root-only", () => {
    process.env.AIDLC_PLUGIN_ROOT = pluginRoot("kiro");
    expect(discoverPluginInventory(".kiro")).toEqual(expect.objectContaining({
      capability: "current-root-only",
      harness: "kiro",
      installed: [expect.objectContaining({ key: "test-pro" })],
    }));

    process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY = join(temp("aidlc-missing-registry-"), "missing.json");
    process.env.AIDLC_PLUGIN_ROOT = "";
    expect(discoverPluginInventory(".claude")).toEqual(expect.objectContaining({
      capability: "current-root-only",
      installed: [],
    }));
  });

  test("duplicate installed identities are invalid and name every manifest", () => {
    const rootA = pluginRoot();
    const rootB = pluginRoot();
    const fixtureDir = temp("aidlc-claude-duplicates-");
    writeFileSync(join(fixtureDir, "installed.json"), JSON.stringify({
      version: 2,
      plugins: {
        "aidlc-test-pro@one": [{ installPath: rootA, version: "0.1.0" }],
        "aidlc-test-pro@two": [{ installPath: rootB, version: "0.1.0" }],
      },
    }));
    writeFileSync(join(fixtureDir, "settings.json"), "{}");
    process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY = join(fixtureDir, "installed.json");
    process.env.AIDLC_CLAUDE_SETTINGS = join(fixtureDir, "settings.json");
    const result = discoverPluginInventory(".claude");
    expect(result.installed).toEqual([]);
    expect(result.invalid[0].paths).toEqual([
      join(rootA, ".claude-plugin", "plugin.json"),
      join(rootB, ".claude-plugin", "plugin.json"),
    ].sort());
  });
});

describe("t242 pure status comparator", () => {
  test("covers every full-inventory state and keeps version/hash independent", () => {
    const plugins = [
      installed("current", "1.0.0", "sha256:a"),
      installed("version", "2.0.0", "sha256:b"),
      installed("source", "1.0.0", "sha256:new"),
      installed("new", "1.0.0", "sha256:d"),
      installed("legacy", "1.0.0", "sha256:e"),
      installed("disabled", "1.0.0", "sha256:f", false),
    ];
    const state = evidence([
      stamp("current", "1.0.0", "sha256:a"),
      stamp("version", "1.0.0", "sha256:b"),
      stamp("source", "1.0.0", "sha256:old"),
      stamp("disabled", "1.0.0", "sha256:f"),
      stamp("missing", "3.0.0", "sha256:g"),
    ], ["legacy"]);
    const rows = comparePluginState(
      inventory(plugins, [{
        key: "broken",
        paths: ["/one", "/two"],
        message: "ambiguous",
      }]),
      state,
      null,
    );
    expect(Object.fromEntries(rows.map((row) => [row.key ?? "invalid", row.state]))).toEqual({
      broken: "invalid-installed",
      current: "current",
      disabled: "installed-disabled",
      legacy: "legacy-unstamped",
      missing: "installed-missing",
      new: "not-composed",
      source: "source-changed",
      version: "version-differs",
    });
    expect(rows.find((row) => row.key === "version")?.message).toContain("upgrade");
  });

  test("default rendering exposes only the three actions and verbose keeps taxonomy", () => {
    const rows = comparePluginState(
      inventory([
        installed("current", "1.0.0", "sha256:a"),
        installed("drift", "1.0.0", "sha256:new"),
      ], [{
        key: "broken",
        paths: ["/broken"],
        message: "invalid manifest",
      }]),
      evidence([
        stamp("current", "1.0.0", "sha256:a"),
        stamp("drift", "1.0.0", "sha256:old"),
      ]),
      null,
    );
    const rendered = renderPluginStatuses(rows);
    expect(rendered).toContain("current");
    expect(rendered).toContain("run: aidlc config");
    expect(rendered).toContain("needs attention: invalid manifest");
    expect(rendered).not.toContain("[source-changed]");
    expect(renderPluginStatuses(rows, true)).toContain("[source-changed]");
  });

  test("current-root-only never infers disabled or missing aggregate state", () => {
    const rows = comparePluginState({
      capability: "current-root-only",
      harness: "kiro",
      installed: [installed("test-pro", "1.0.0", "sha256:a")],
      invalid: [],
    }, evidence([stamp("missing", "1.0.0", "sha256:b")]), null);
    expect(rows).toEqual([expect.objectContaining({
      state: "inventory-unavailable",
      action: "attention",
    })]);
  });
});

describe("t242 transactional sync and ownership-safe prune", () => {
  function installedProject(): string {
    const project = temp("aidlc-plugin-project-");
    cpSync(join(REPO_ROOT, "dist", "claude"), project, { recursive: true });
    return project;
  }

  test("aggregate sync writes a deterministic stamp and is idempotent", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    const first = await syncPlugins(project, [], ".claude");
    expect(first.synced).toEqual(["test-pro"]);
    expect(first.operations).toBeGreaterThan(0);
    const stampPath = join(project, ".claude", "tools", "data", "plugin-compose-test-pro.json");
    expect(JSON.parse(readFileSync(stampPath, "utf-8"))).toEqual({
      schemaVersion: 1,
      name: "test-pro",
      version: "0.1.0",
      sourceHash: pluginSourceHash(TEST_PRO),
    });
    expect(collectPluginStatus(project, ".claude").statuses).toEqual([
      expect.objectContaining({ key: "test-pro", state: "current" }),
    ]);
    const second = await syncPlugins(project, [], ".claude");
    expect(second.operations).toBe(0);
  }, 60_000);

  test("concurrent syncs converge and the loser replans as an idempotent no-op", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);

    const results = await Promise.all([
      syncPlugins(project, [], ".claude"),
      syncPlugins(project, [], ".claude"),
    ]);
    expect(results.map((result) => result.synced)).toEqual([
      ["test-pro"],
      ["test-pro"],
    ]);
    expect(results.some((result) => result.operations > 0)).toBe(true);
    expect(collectPluginStatus(project, ".claude").statuses).toEqual([
      expect.objectContaining({ key: "test-pro", state: "current" }),
    ]);
  }, 60_000);

  test("public JSON and doctor expose the shared exact comparator state", () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    const list = spawnSync(process.execPath, [
      join(REPO_ROOT, "core", "tools", "aidlc.ts"),
      "engine",
      "plugin",
      "list",
      "--json",
      "--project-dir",
      project,
    ], {
      cwd: project,
      encoding: "utf-8",
      env: process.env,
    });
    expect(list.status, list.stdout + list.stderr).toBe(0);
    expect(JSON.parse(list.stdout).data.statuses).toEqual([
      expect.objectContaining({ key: "test-pro", state: "not-composed", action: "sync" }),
    ]);

    const doctor = spawnSync(process.execPath, [
      join(REPO_ROOT, "core", "tools", "aidlc.ts"),
      "doctor",
      "--json",
      "--project-dir",
      project,
    ], {
      cwd: project,
      encoding: "utf-8",
      env: process.env,
    });
    expect([0, 1]).toContain(doctor.status ?? -1);
    expect(JSON.parse(doctor.stdout).data.checks).toContainEqual(expect.objectContaining({
      pass: false,
      severity: "warn",
      label: "Plugins: 1 require sync",
      fix: "run `aidlc config`",
    }));
  }, 60_000);

  test("one transaction rolls back all plugin bytes on an injected commit fault", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    const before = surfaceSnapshot(project);
    process.env.AIDLC_PLUGIN_SYNC_FAIL_AFTER = "1";
    await expect(syncPlugins(project, [], ".claude")).rejects.toThrow("injected transaction failure");
    expect(surfaceSnapshot(project)).toEqual(before);
    expect(existsSync(join(project, ".aidlc-transaction.lock"))).toBe(false);
    expect(readdirSync(project).some((entry) => entry.startsWith(".aidlc-txn-"))).toBe(false);
  }, 60_000);

  test("sync rejects content whose plugin owner differs from the host manifest key", async () => {
    const project = installedProject();
    const root = temp("aidlc-plugin-identity-");
    cpSync(TEST_PRO, root, { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "aidlc-renamed", version: "0.1.0" }, null, 2)}\n`,
    );
    withClaudeFixture(root);

    await expect(syncPlugins(project, [], ".claude"))
      .rejects.toThrow("plugin renamed composition reported degraded drops");
    expect(existsSync(join(
      project,
      ".claude",
      "aidlc-common",
      "stages",
      "construction",
      "test-pro-integration.md",
    ))).toBe(false);
    expect(existsSync(join(
      project,
      ".claude",
      "tools",
      "data",
      "plugin-compose-renamed.json",
    ))).toBe(false);
    expect(existsSync(join(
      project,
      ".claude",
      "tools",
      "data",
      "plugin-contrib-test-pro.json",
    ))).toBe(false);
  }, 60_000);

  test("a version upgrade replaces prior hash-proven primitive files", async () => {
    const project = installedProject();
    const root = temp("aidlc-plugin-upgrade-");
    cpSync(TEST_PRO, root, { recursive: true });
    withClaudeFixture(root);
    await syncPlugins(project, [], ".claude");

    const source = join(root, "stages", "construction", "test-pro-integration.md");
    const target = join(
      project,
      ".claude",
      "aidlc-common",
      "stages",
      "construction",
      "test-pro-integration.md",
    );
    writeFileSync(source, `${readFileSync(source, "utf-8")}\nversion upgrade marker\n`);
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "aidlc-test-pro", version: "0.2.0" }, null, 2)}\n`,
    );
    writeFileSync(
      process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY as string,
      readFileSync(process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY as string, "utf-8")
        .replaceAll('"version": "0.1.0"', '"version": "0.2.0"'),
    );

    await syncPlugins(project, [], ".claude");
    expect(readFileSync(target, "utf-8")).toContain("version upgrade marker");
    expect(collectPluginStatus(project, ".claude").statuses).toEqual([
      expect.objectContaining({
        key: "test-pro",
        installedVersion: "0.2.0",
        composedVersion: "0.2.0",
        state: "current",
      }),
    ]);
  }, 60_000);

  test("same-version source drift replaces prior hash-proven primitive files", async () => {
    const project = installedProject();
    const root = temp("aidlc-plugin-source-drift-");
    cpSync(TEST_PRO, root, { recursive: true });
    withClaudeFixture(root);
    await syncPlugins(project, [], ".claude");

    const source = join(root, "stages", "construction", "test-pro-integration.md");
    const target = join(
      project,
      ".claude",
      "aidlc-common",
      "stages",
      "construction",
      "test-pro-integration.md",
    );
    writeFileSync(source, `${readFileSync(source, "utf-8")}\nsame-version marker\n`);

    await syncPlugins(project, [], ".claude");
    expect(readFileSync(target, "utf-8")).toContain("same-version marker");
    expect(collectPluginStatus(project, ".claude").statuses).toEqual([
      expect.objectContaining({ key: "test-pro", state: "current" }),
    ]);
  }, 60_000);

  test("sync refuses to replace a locally modified owned primitive", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    await syncPlugins(project, [], ".claude");
    const stage = join(
      project,
      ".claude",
      "aidlc-common",
      "stages",
      "construction",
      "test-pro-integration.md",
    );
    writeFileSync(stage, `${readFileSync(stage, "utf-8")}\nlocal edit\n`);
    await expect(syncPlugins(project, [], ".claude"))
      .rejects.toThrow("cannot sync test-pro: owned path changed since composition");
    expect(readFileSync(stage, "utf-8")).toContain("local edit");
  }, 60_000);

  test("plain sync retains missing content; explicit prune removes only hash-proven ownership", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    await syncPlugins(project, [], ".claude");
    const registry = process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY as string;
    writeFileSync(registry, "{\"version\":2,\"plugins\":{}}\n");
    const stage = join(
      project,
      ".claude",
      "aidlc-common",
      "stages",
      "construction",
      "test-pro-integration.md",
    );
    await syncPlugins(project, [], ".claude");
    expect(existsSync(stage)).toBe(true);
    const result = await syncPlugins(project, ["--prune-missing", "--yes"], ".claude");
    expect(result.pruned).toEqual(["test-pro"]);
    expect(existsSync(stage)).toBe(false);
    expect(readFileSync(
      join(project, ".claude", "skills", "aidlc", "SKILL.md"),
      "utf-8",
    )).not.toContain("| test-pro-integration |");
    expect(existsSync(join(
      project,
      ".claude",
      "tools",
      "data",
      "plugin-compose-test-pro.json",
    ))).toBe(false);
  }, 60_000);

  test("prune refuses a locally modified owned file without deleting it", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    await syncPlugins(project, [], ".claude");
    writeFileSync(
      process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY as string,
      "{\"version\":2,\"plugins\":{}}\n",
    );
    const stage = join(
      project,
      ".claude",
      "aidlc-common",
      "stages",
      "construction",
      "test-pro-integration.md",
    );
    writeFileSync(stage, `${readFileSync(stage, "utf-8")}\nlocal edit\n`);
    await expect(syncPlugins(project, ["--prune-missing", "--yes"], ".claude"))
      .rejects.toThrow("owned path changed since composition");
    expect(readFileSync(stage, "utf-8")).toContain("local edit");
  }, 60_000);

  test("interactive prune confirmation resolves on a line without waiting for EOF", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough();
    input.isTTY = true;
    const confirmation = confirmPrune([], ["test-pro"], input, output);
    input.write("y\n");

    await expect(Promise.race([
      confirmation,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("confirmation waited for EOF")), 1_000)
      ),
    ])).resolves.toBeUndefined();
    expect(output.read()?.toString() ?? "").toContain("Prune composed content");
    input.destroy();
    output.destroy();
  });
});
