import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import {
  announcePrune,
  collectPluginStatus,
  comparePluginState,
  discoverPluginInventory,
  main as pluginMain,
  normalizeInstalledPlugin,
  pluginSourceHash,
  renderPluginStatuses,
  syncPlugins,
  type CompositionStamp,
  type InstalledPlugin,
  type PluginInventory,
  type ProjectEvidence,
} from "../../core/tools/aidlc-plugin.ts";
import { aidlcInvocation } from "../../core/tools/aidlc-runtime-paths.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

  test("Claude downgrades malformed enablement settings and names the settings file", () => {
    const root = pluginRoot();
    withClaudeFixture(root);
    const settings = process.env.AIDLC_CLAUDE_SETTINGS as string;
    process.env.AIDLC_PLUGIN_ROOT = "";
    process.env.CLAUDE_PLUGIN_ROOT = "";
    process.env.PLUGIN_ROOT = "";

    for (const [body, reason] of [
      ["{not-json", "invalid Claude settings: not valid JSON"],
      // The parser would quote this unquoted value; the message must not.
      ['{"env":{"NOTE": SECRETSECRETSECRET}}', "invalid Claude settings: not valid JSON"],
      ["[]", "invalid Claude settings: expected a JSON object"],
      ['{"enabledPlugins":[]}', "invalid Claude settings: enabledPlugins must be an object"],
    ]) {
      writeFileSync(settings, body);
      const result = discoverPluginInventory(".claude");
      expect(result).toEqual(expect.objectContaining({
        capability: "current-root-only",
        installed: [],
        invalid: [{ paths: [settings], message: reason }],
      }));
      // A broken settings file is something the person can fix, so it warns
      // and names the file instead of passing.
      const rows = comparePluginState(result, evidence(), null);
      expect(rows).toEqual([expect.objectContaining({
        state: "invalid-installed",
        action: "attention",
        paths: [settings],
      })]);
      expect(renderPluginStatuses(rows)).toContain(`needs attention: ${reason}`);
    }
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

  test("local and project Claude records apply only in their own project", () => {
    const cache = pluginRoot();
    const other = pluginRoot();
    const workspace = temp("aidlc-claude-scoped-");
    const [projectA, projectB, projectC] = ["a", "b", "c"].map((name) => {
      mkdirSync(join(workspace, name), { recursive: true });
      return join(workspace, name);
    });
    mkdirSync(join(projectC, "sub", "deep"), { recursive: true });
    const record = (scope: string, installPath: string, projectPath?: string) => ({
      scope,
      installPath,
      version: "0.1.0",
      ...(projectPath === undefined ? {} : { projectPath }),
    });
    const fixtureDir = temp("aidlc-claude-scoped-registry-");
    const writeRegistry = (records: unknown[]): void => {
      writeFileSync(join(fixtureDir, "installed.json"), JSON.stringify({
        version: 2,
        plugins: { "aidlc-test-pro@mkt": records },
      }));
    };
    writeFileSync(join(fixtureDir, "settings.json"), "{}");
    process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY = join(fixtureDir, "installed.json");
    process.env.AIDLC_CLAUDE_SETTINGS = join(fixtureDir, "settings.json");
    const keysIn = (project: string) => {
      const result = discoverPluginInventory(".claude", project);
      return { installed: result.installed.map((item) => item.root), invalid: result.invalid };
    };

    writeRegistry([record("local", cache, projectA), record("local", cache, projectB)]);
    expect(keysIn(projectA)).toEqual({ installed: [cache], invalid: [] });
    expect(keysIn(projectB)).toEqual({ installed: [cache], invalid: [] });
    expect(keysIn(projectC)).toEqual({ installed: [], invalid: [] });

    writeRegistry([record("local", cache, join(projectC, "sub", "deep"))]);
    expect(keysIn(projectC).installed).toEqual([cache]);
    expect(keysIn(`${projectC}x`).installed).toEqual([]);

    writeRegistry([record("project", cache, projectA), record("user", other)]);
    expect(keysIn(projectA).invalid).toEqual([
      expect.objectContaining({ key: "test-pro", message: expect.stringContaining("ambiguous") }),
    ]);
    expect(keysIn(projectB)).toEqual({ installed: [other], invalid: [] });

    writeRegistry([record("user", other, projectA)]);
    expect(keysIn(projectB)).toEqual({ installed: [other], invalid: [] });

    writeRegistry([record("user", cache), record("local", cache, projectA)]);
    expect(keysIn(projectA)).toEqual({ installed: [cache], invalid: [] });

    writeRegistry([record("local", cache, projectA), record("local", other, projectA)]);
    expect(keysIn(projectA).installed).toEqual([]);
    expect(keysIn(projectA).invalid[0].paths).toEqual([
      join(cache, ".claude-plugin", "plugin.json"),
      join(other, ".claude-plugin", "plugin.json"),
    ].sort());
  });

  test("a project Claude record also counts in a clone or worktree whose settings enable it", () => {
    const cache = pluginRoot();
    const other = pluginRoot();
    const workspace = temp("aidlc-claude-clone-");
    const [origin, clone, unrelated] = ["origin", "clone", "unrelated"].map((name) => {
      mkdirSync(join(workspace, name, ".claude"), { recursive: true });
      return join(workspace, name);
    });
    const fixtureDir = temp("aidlc-claude-clone-registry-");
    const writeRegistry = (records: unknown[]): void => {
      writeFileSync(join(fixtureDir, "installed.json"), JSON.stringify({
        version: 2,
        plugins: { "aidlc-test-pro@mkt": records },
      }));
    };
    writeFileSync(join(fixtureDir, "settings.json"), "{}");
    process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY = join(fixtureDir, "installed.json");
    process.env.AIDLC_CLAUDE_SETTINGS = join(fixtureDir, "settings.json");
    const record = (scope: string, installPath: string, projectPath: string) => ({
      scope,
      installPath,
      version: "0.1.0",
      projectPath,
    });
    const keysIn = (project: string) => {
      const result = discoverPluginInventory(".claude", project);
      return { installed: result.installed.map((item) => item.root), invalid: result.invalid };
    };
    const enabled = JSON.stringify({ enabledPlugins: { "aidlc-test-pro@mkt": true } });
    writeFileSync(join(clone, ".claude", "settings.json"), enabled);

    writeRegistry([record("project", cache, origin), record("local", other, unrelated)]);
    expect(keysIn(clone)).toEqual({ installed: [cache], invalid: [] });
    expect(keysIn(join(workspace, "none"))).toEqual({ installed: [], invalid: [] });

    writeRegistry([record("project", cache, origin), record("local", other, clone)]);
    expect(keysIn(clone)).toEqual({ installed: [other], invalid: [] });

    writeRegistry([record("project", cache, origin)]);
    writeFileSync(join(clone, ".claude", "settings.json"), "{");
    expect(keysIn(clone)).toEqual({ installed: [], invalid: [] });
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
      invalid: [{ paths: ["/broken"], message: "invalid manifest" }],
    }, evidence([
      stamp("test-pro", "1.0.0", "sha256:a"),
      stamp("unseen", "1.0.0", "sha256:b"),
    ], ["legacy"]), null);
    expect(rows).toEqual([
      expect.objectContaining({ key: null, state: "invalid-installed", action: "attention" }),
      expect.objectContaining({
        key: "legacy",
        composedVersion: null,
        state: "inventory-unavailable",
        action: "current",
      }),
      expect.objectContaining({ key: "test-pro", state: "current", action: "current" }),
      expect.objectContaining({
        key: "unseen",
        composedVersion: "1.0.0",
        state: "inventory-unavailable",
        action: "current",
      }),
    ]);
    const table = renderPluginStatuses(rows);
    expect(table).toMatch(/unseen +- +1\.0\.0 +not compared: no host plugin list/);
    expect(table).not.toContain("installed plugin missing");
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("doctor on a host without a plugin list passes and names what the project has", () => {
    const project = temp("aidlc-plugin-copilot-");
    cpSync(join(REPO_ROOT, "dist", "copilot"), project, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_HARNESS_DIR: ".aidlc",
      AIDLC_HARNESS_NAME: "copilot",
      AIDLC_INSTALL_ROOT: join(project, ".doctor-install"),
    };
    for (const key of ["AIDLC_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"]) delete env[key];
    const tool = (name: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [join(project, ".aidlc", "tools", name), ...args], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: project,
        encoding: "utf-8",
        env: { ...env, ...extra },
      });
    const pluginRows = () => {
      const doctor = tool("aidlc.ts", ["doctor", "--json", "--project-dir", project]);
      expect([0, 1], doctor.stdout + doctor.stderr).toContain(doctor.status ?? -1);
      return (JSON.parse(doctor.stdout).data.checks as Array<{ label: string }>)
        .filter((check) => check.label.startsWith("Plugins:"));
    };

    // A fresh install: nothing to compare and nothing for the person to do.
    expect(pluginRows()).toEqual([
      expect.objectContaining({ pass: true, label: "Plugins: none in this project" }),
    ]);

    // The plugin's SessionStart hook route composes it; doctor still cannot
    // compare versions, so it reports the plugin instead of warning.
    const synced = tool("aidlc-plugin.ts", ["sync", "--project-dir", project], {
      AIDLC_PLUGIN_ROOT: join(REPO_ROOT, "dist", "plugins", "test-pro", "copilot"),
    });
    expect(synced.status, synced.stdout + synced.stderr).toBe(0);
    expect(pluginRows()).toEqual([
      expect.objectContaining({
        pass: true,
        label: "Plugins: test-pro 0.1.0 in this project (no host plugin list to compare versions with)",
      }),
    ]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("doctor names a malformed Claude settings file without quoting its content", () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    const settings = process.env.AIDLC_CLAUDE_SETTINGS as string;
    const secret = "SECRETSECRETSECRET";
    // Unquoted, so a JSON parser message would name it.
    writeFileSync(settings, `{"env":{"NOTE": ${secret}}}`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ["AIDLC_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"]) delete env[key];
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [
        join(REPO_ROOT, "core", "tools", "aidlc.ts"),
        ...args,
        "--project-dir",
        project,
      ], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: project,
        encoding: "utf-8",
        env,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(output, args.join(" ")).not.toContain(secret);
      return { result, output };
    };

    const json = run(["doctor", "--json"]);
    expect([0, 1], json.output).toContain(json.result.status ?? -1);
    expect(JSON.parse(json.result.stdout).data.checks).toContainEqual(expect.objectContaining({
      pass: false,
      severity: "warn",
      label: "Plugins: 1 need attention",
      fix: `invalid Claude settings: not valid JSON: ${settings}`,
    }));
    expect(run(["doctor"]).output).toContain(`invalid Claude settings: not valid JSON: ${settings}`);
    expect(run(["engine", "plugin", "list"]).output)
      .toContain(`needs attention: invalid Claude settings: not valid JSON: ${settings}`);
    expect(JSON.parse(run(["engine", "plugin", "list", "--json"]).result.stdout).data.statuses)
      .toEqual([expect.objectContaining({ message: `invalid Claude settings: not valid JSON: ${settings}` })]);

    const exported = join(project, "out");
    run(["doctor", "--export", "--output", exported]);
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (lstatSync(path).isDirectory()) walk(path);
        else if (!entry.endsWith(".tar.gz")) files.push(path);
      }
    };
    walk(exported);
    expect(files.some((path) => path.endsWith("report.json"))).toBe(true);
    for (const path of files) expect(readFileSync(path, "utf-8"), path).not.toContain(secret);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("one transaction rolls back all plugin bytes on an injected commit fault", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    const before = surfaceSnapshot(project);
    process.env.AIDLC_PLUGIN_SYNC_FAIL_AFTER = "1";
    await expect(syncPlugins(project, [], ".claude")).rejects.toThrow("injected transaction failure");
    expect(surfaceSnapshot(project)).toEqual(before);
    expect(existsSync(join(project, ".aidlc-transaction.lock"))).toBe(false);
    expect(readdirSync(project).some((entry) => entry.startsWith(".aidlc-txn-"))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    // The plugin's record of the files it composed goes with it, so a pruned
    // plugin no longer claims them.
    const filesRecord = join(project, ".claude", "tools", "data", "plugin-files-test-pro.json");
    expect(existsSync(filesRecord)).toBe(true);
    // Without a terminal or --yes the command is used the wrong way, which
    // exits 2 like every other usage refusal, and removes nothing.
    const saved = { exitCode: process.exitCode, harness: process.env.AIDLC_HARNESS_DIR, write: process.stdout.write };
    process.env.AIDLC_HARNESS_DIR = ".claude";
    let printed = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await pluginMain(["sync", "--prune-missing", "--project-dir", project, "--json"]);
      process.stdout.write = saved.write;
      expect(process.exitCode).toBe(2);
      // Its JSON says so too.
      expect(JSON.parse(printed)).toMatchObject({ ok: false, code: 2, status: "usage" });
    } finally {
      process.stdout.write = saved.write;
      // Bun keeps a set exit code when it is assigned undefined.
      process.exitCode = saved.exitCode ?? 0;
      if (saved.harness === undefined) delete process.env.AIDLC_HARNESS_DIR;
      else process.env.AIDLC_HARNESS_DIR = saved.harness;
    }
    expect(existsSync(stage)).toBe(true);
    const result = await syncPlugins(project, ["--prune-missing", "--yes"], ".claude");
    expect(result.pruned).toEqual(["test-pro"]);
    expect(existsSync(filesRecord)).toBe(false);
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
    // The way back the prune notice names: reinstall in the host, then sync.
    withClaudeFixture(TEST_PRO);
    const restored = await syncPlugins(project, [], ".claude");
    expect(restored.synced).toEqual(["test-pro"]);
    expect(existsSync(stage)).toBe(true);
    expect(readFileSync(
      join(project, ".claude", "skills", "aidlc", "SKILL.md"),
      "utf-8",
    )).toContain("| test-pro-integration |");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // AI-DLC writes its own files only into real folders. A folder a repository
  // links elsewhere (here the data folder, moved outside the project) would
  // take the plugin's records, the stage graph and the scope grid with it, so
  // the command changes nothing, says which folder, and works once it is real.
  const linkedLine = (folder: string) =>
    `${folder} is a link, so AI-DLC changed nothing there. Replace it with a real folder, then run this again.`;

  function linkElsewhere(folder: string): string {
    const outside = temp("aidlc-t242-linked-");
    if (existsSync(folder)) {
      cpSync(folder, outside, { recursive: true });
      rmSync(folder, { recursive: true, force: true });
    }
    symlinkSync(outside, folder, process.platform === "win32" ? "junction" : "dir");
    return outside;
  }

  // What the person sees from `aidlc engine plugin`, both streams, and its exit code.
  async function pluginOutput(argv: string[]): Promise<{ printed: string; code: number }> {
    const saved = { exitCode: process.exitCode, out: process.stdout.write, err: process.stderr.write };
    let printed = "";
    const capture = ((chunk: string | Uint8Array) => {
      printed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = 0;
    process.stdout.write = capture;
    process.stderr.write = capture;
    let code = 0;
    try {
      await pluginMain(argv);
      code = Number(process.exitCode ?? 0);
    } finally {
      process.stdout.write = saved.out;
      process.stderr.write = saved.err;
      process.exitCode = saved.exitCode ?? 0;
    }
    return { printed, code };
  }

  test("sync writes nothing through a data folder that links outside the project and names it", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    const outside = linkElsewhere(join(project, ".claude", "tools", "data"));
    const outsideBefore = surfaceSnapshot(outside);
    const { printed, code } = await pluginOutput(["sync", "--project-dir", project]);
    expect(code).toBe(1);
    expect(printed).toContain(linkedLine(join(".claude", "tools", "data")));
    expect(surfaceSnapshot(outside)).toEqual(outsideBefore);
    expect(existsSync(join(
      project, ".claude", "aidlc-common", "stages", "construction", "test-pro-integration.md",
    ))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("prune changes nothing when the data folder is a link, and prunes once it is a real folder", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    await syncPlugins(project, [], ".claude");
    const data = join(project, ".claude", "tools", "data");
    const outside = linkElsewhere(data);
    const outsideBefore = surfaceSnapshot(outside);
    expect(Object.keys(outsideBefore)).toContain("plugin-contrib-test-pro.json");
    writeFileSync(process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY as string, "{\"version\":2,\"plugins\":{}}\n");
    const stage = join(project, ".claude", "aidlc-common", "stages", "construction", "test-pro-integration.md");
    expect(existsSync(stage)).toBe(true);
    const { printed, code } = await pluginOutput(["sync", "--prune-missing", "--yes", "--project-dir", project]);
    expect(code).toBe(1);
    expect(printed).toContain(linkedLine(join(".claude", "tools", "data")));
    expect(surfaceSnapshot(outside)).toEqual(outsideBefore);
    expect(existsSync(stage)).toBe(true);
    // The way out the line names: a real folder in its place, then the same command.
    rmSync(data, { recursive: true, force: true });
    expect(surfaceSnapshot(outside)).toEqual(outsideBefore);
    cpSync(outside, data, { recursive: true });
    const result = await syncPlugins(project, ["--prune-missing", "--yes"], ".claude");
    expect(result.pruned).toEqual(["test-pro"]);
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(join(data, "plugin-contrib-test-pro.json"))).toBe(false);
    expect(surfaceSnapshot(outside)).toEqual(outsideBefore);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a plugin file that would land behind a person's link changes nothing and names the folder", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    const knowledge = join(project, ".claude", "knowledge");
    const outside = linkElsewhere(knowledge);
    const outsideBefore = surfaceSnapshot(outside);
    const { printed, code } = await pluginOutput(["sync", "--project-dir", project]);
    expect(code).toBe(1);
    expect(printed).toContain(linkedLine(join(".claude", "knowledge")));
    expect(surfaceSnapshot(outside)).toEqual(outsideBefore);
    expect(existsSync(join(project, ".claude", "tools", "data", "plugin-compose-test-pro.json"))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a person's own linked skill stays theirs and sync goes ahead", async () => {
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    const mine = join(project, ".claude", "skills", "mine");
    const outside = linkElsewhere(mine);
    writeFileSync(join(outside, "SKILL.md"), "---\nname: mine\ndescription: my own skill\n---\nMine.\n");
    const outsideBefore = surfaceSnapshot(outside);
    const result = await syncPlugins(project, [], ".claude");
    expect(result.synced).toEqual(["test-pro"]);
    expect(lstatSync(mine).isSymbolicLink()).toBe(true);
    expect(surfaceSnapshot(outside)).toEqual(outsideBefore);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("graph compile writes nothing through a linked data folder and names it", () => {
    const project = installedProject();
    const outside = linkElsewhere(join(project, ".claude", "tools", "data"));
    const outsideBefore = surfaceSnapshot(outside);
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".claude" };
    for (const key of ["AIDLC_STAGE_GRAPH", "AIDLC_SCOPE_GRID", "AIDLC_SCOPES_DIR", "AIDLC_STAGES_DIR"]) delete env[key];
    const result = spawnSync(
      process.execPath,
      [join(project, ".claude", "tools", "aidlc-graph.ts"), "compile"],
      { cwd: project, encoding: "utf-8", env },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(linkedLine(join(".claude", "tools", "data")));
    expect(surfaceSnapshot(outside)).toEqual(outsideBefore);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("prune strips object-form consumes a plugin contributed to a core stage", async () => {
    // Regression for #1247: compose records a plugin's `adds.consumes` as objects
    // ({ artifact, required }) in the sidecar. pruneContributions built a Set of
    // those objects and compared it against artifact-name strings, so it matched
    // nothing and left the plugin's consumes orphaned in the core stage.
    const project = installedProject();
    withClaudeFixture(TEST_PRO);
    await syncPlugins(project, [], ".claude");

    const stage = join(
      project,
      ".claude",
      "aidlc-common",
      "stages",
      "construction",
      "build-and-test.md",
    );
    // Precondition: compose merged test-pro's consumed artifacts into the stage.
    const composed = readFileSync(stage, "utf-8");
    expect(composed).toContain("test-pro-testability-requirements");
    expect(composed).toContain("test-pro-test-harness-design");

    writeFileSync(
      process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY as string,
      "{\"version\":2,\"plugins\":{}}\n",
    );
    const result = await syncPlugins(project, ["--prune-missing", "--yes"], ".claude");
    expect(result.pruned).toEqual(["test-pro"]);

    const pruned = readFileSync(stage, "utf-8");
    expect(pruned).not.toContain("test-pro-testability-requirements");
    expect(pruned).not.toContain("test-pro-test-harness-design");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("at a terminal, prune names what goes and how to get it back, then proceeds without a question", () => {
    const output = new PassThrough();
    try {
      // Nothing is written to stdin: there is no question to answer.
      announcePrune(["--prune-missing"], ["test-pro", "other"], { isTTY: true }, output);
      const said = output.read()?.toString() ?? "";
      expect(said).toBe(
        "Pruning missing plugin(s) test-pro, other: removing the files they added to this project " +
          "and their additions to stage files. To get them back, reinstall " +
          `the plugin(s) in your host, then run ${aidlcInvocation()} engine plugin sync.\n`,
      );
      expect(said).not.toContain("[y/N]");
    } finally {
      output.destroy();
    }
    // Without a terminal (a script or an agent), --yes stays the go-ahead.
    expect(() => announcePrune(["--prune-missing"], ["test-pro"], { isTTY: false }, new PassThrough()))
      .toThrow("plugin sync --prune-missing requires --yes in non-interactive mode");
    const quiet = new PassThrough();
    announcePrune(["--prune-missing", "--yes"], ["test-pro"], { isTTY: false }, quiet);
    announcePrune(["--prune-missing"], [], { isTTY: false }, quiet);
    expect(quiet.read()).toBeNull();
    quiet.destroy();
  });
});
