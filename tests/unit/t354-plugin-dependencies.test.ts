// covers: file:core/tools/aidlc-plugin.ts, file:core/tools/aidlc-plugin-validate.ts,
// file:core/tools/aidlc-plugin-emit.ts
//
// t354-plugin-dependencies - a team plugin builds on core and at most one base
// plugin, and a base builds on core alone (#2693). Plugin sync composes the
// bases first, then the plugins built on them, whatever their names and
// whatever order the hosts run their session-start hooks in. A plugin whose
// base is missing, outside its range, built on another plugin or lacks a stage
// the plugin's scopes include, or that names two bases, is held with one line:
// said once by sync, kept by plugin list and doctor, while every other plugin
// still composes. A held plugin composed before stays as it was, and its line
// says so.
//
// Mechanism: cli. Tiny plugins are built with the shipped builder into temp
// roots; each case copies dist/claude into a fresh project with a fixture
// Claude plugin registry and runs the project's own aidlc-plugin.ts (sync,
// list) and aidlc-doctor.ts. Zero tokens.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
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
import { join, resolve } from "node:path";
import { projectionPluginRoot, readPluginTargets } from "../../dist/claude/.claude/tools/aidlc-plugin-emit.ts";
import { quoteCommandArgument } from "../../core/tools/aidlc-runtime-paths.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const TARGETS = readPluginTargets(join(TOOLS, "data", "plugin-targets.json"));
const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"] as const;
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t354-"));
let counter = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fresh(label: string): string {
  const dir = join(scratch, `${label}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "CLAUDECODE" || key === "PLUGIN_ROOT" || key === "CLAUDE_CONFIG_DIR" ||
      key.startsWith("CLAUDE_PLUGIN") || key.startsWith("CLAUDE_PROJECT") ||
      key.startsWith("AIDLC_")
    ) delete env[key];
  }
  return { ...env, ...extra };
}

type PluginSpec = {
  name: string;
  version?: string;
  dependencies?: string[];
  requires?: string[];
  consumes?: string[];
  // More stages like the example one, each producing <slug>-output.
  stages?: string[];
  // The example scope's include_stages; the example stage leaves the scope
  // when `includesOnly` is set.
  includes?: string[];
  includesOnly?: boolean;
  harness?: (typeof HARNESSES)[number];
};

// The plugin create scaffold (one stage <name>-example-stage producing
// <name>-example-output, its agent and scope), with the manifest and the
// stage's edges set, built by the shipped builder.
function plugin(spec: PluginSpec): string {
  const dir = fresh(`plugin-${spec.name}`);
  const root = join(dir, "src", spec.name);
  const created = spawnSync(process.execPath, [join(TOOLS, "aidlc-plugin-create.ts"), spec.name, root], {
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: cleanEnv({}),
  });
  expect(created.status, created.stderr).toBe(0);
  const manifestPath = join(root, ".aidlc-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.version = spec.version ?? "0.1.0";
  manifest.dependencies = spec.dependencies ?? ["core"];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const stagePath = join(root, "stages", "construction", `${spec.name}-example-stage.md`);
  let stage = readFileSync(stagePath, "utf-8");
  if (spec.requires) {
    stage = stage.replace("requires_stage: []", `requires_stage:\n${spec.requires.map((slug) => `  - ${slug}`).join("\n")}`);
  }
  if (spec.consumes) {
    stage = stage.replace(
      "consumes: []",
      `consumes:\n${spec.consumes.map((artifact) => `  - artifact: ${artifact}\n    required: true`).join("\n")}`,
    );
  }
  for (const slug of spec.stages ?? []) {
    writeFileSync(
      join(root, "stages", "construction", `${slug}.md`),
      stage.replaceAll(`${spec.name}-example-stage`, slug).replaceAll(`${spec.name}-example-output`, `${slug}-output`),
    );
  }
  if (spec.includesOnly) stage = stage.replace(`scopes:\n  - ${spec.name}-example\n`, "scopes: []\n");
  writeFileSync(stagePath, stage);
  if (spec.includes) {
    const scopePath = join(root, "scopes", `${spec.name}-example.md`);
    writeFileSync(
      scopePath,
      readFileSync(scopePath, "utf-8").replace("runner: true", `runner: true\ninclude_stages: [${spec.includes.join(", ")}]`),
    );
  }
  const out = join(dir, "build");
  const built = spawnSync(
    process.execPath,
    [join(TOOLS, "aidlc-plugin-build.ts"), root, spec.harness ?? "claude", out],
    { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), env: cleanEnv({}) },
  );
  expect(built.status, built.stdout + built.stderr).toBe(0);
  return projectionPluginRoot(out, TARGETS[spec.harness ?? "claude"]);
}

// What alpha (the team plugin) is in most cases: it builds on zeta, orders its
// stage after zeta's and reads zeta's artifact.
function alpha(spec: Partial<PluginSpec> = {}): string {
  return plugin({
    name: "alpha",
    dependencies: ["core", "zeta@^0.1.0"],
    requires: ["zeta-example-stage"],
    consumes: ["zeta-example-output"],
    ...spec,
  });
}

type Installed = Record<string, { root: string; version?: string }>;

type Project = {
  dir: string;
  registry: string;
  settings: string;
};

function project(installed: Installed): Project {
  const base = fresh("project");
  const dir = join(base, "project");
  cpSync(join(REPO_ROOT, "dist", "claude"), dir, { recursive: true });
  const registry = join(base, "installed_plugins.json");
  const settings = join(base, "settings.json");
  setInstalled({ dir, registry, settings }, installed);
  writeFileSync(settings, "{}\n");
  return { dir, registry, settings };
}

function setInstalled(target: Project, installed: Installed): void {
  const plugins: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(installed)) {
    // Built by the shipped builder, so the host lists it under its own names.
    plugins[`${name}@${name}`] = [
      { scope: "user", installPath: entry.root, version: entry.version ?? "0.1.0" },
    ];
  }
  writeFileSync(target.registry, `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
}

type Ran = { status: number | null; stdout: string; stderr: string };

// The project's own plugin tool. `hookRoot` stands in for a host's
// session-start hook, which names only its own plugin; `hostList: false`
// stands in for a host with no plugin list (Kiro, Cursor, Copilot, opencode).
function pluginTool(
  target: Project,
  args: string[],
  options: { hookRoot?: string; hostList?: boolean } = {},
): Ran {
  const result = spawnSync(process.execPath, [join(target.dir, ".claude", "tools", "aidlc-plugin.ts"), ...args], {
    cwd: target.dir,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
    env: cleanEnv({
      AIDLC_CLAUDE_PLUGIN_REGISTRY: options.hostList === false ? join(target.dir, "no-host-list.json") : target.registry,
      AIDLC_CLAUDE_SETTINGS: target.settings,
      CLAUDE_PROJECT_DIR: target.dir,
      AIDLC_HARNESS_DIR: ".claude",
      AIDLC_HARNESS_NAME: "claude",
      ...(options.hookRoot ? { CLAUDE_PLUGIN_ROOT: options.hookRoot } : {}),
    }),
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function sync(target: Project, options: { hookRoot?: string; hostList?: boolean } = {}): Ran {
  return pluginTool(target, ["sync"], options);
}

type Status = { key: string; state: string; action: string; message: string; installedVersion: string | null; composedVersion: string | null };

function statuses(target: Project, options: { hostList?: boolean } = {}): Status[] {
  const listed = pluginTool(target, ["list", "--json"], options);
  expect(listed.status, listed.stdout + listed.stderr).toBe(0);
  return (JSON.parse(listed.stdout) as { data: { statuses: Status[] } }).data.statuses;
}

function statusOf(target: Project, key: string, options: { hostList?: boolean } = {}): Status | undefined {
  return statuses(target, options).find((status) => status.key === key);
}

function pluginStageNumbers(target: Project): Record<string, string> {
  const graph = JSON.parse(
    readFileSync(join(target.dir, ".claude", "tools", "data", "stage-graph.json"), "utf-8"),
  ) as Array<{ slug: string; number: string; plugin?: string }>;
  return Object.fromEntries(graph.filter((node) => node.plugin).map((node) => [node.slug, node.number]));
}

function stamp(target: Project, key: string): Record<string, unknown> | null {
  const path = join(target.dir, ".claude", "tools", "data", `plugin-compose-${key}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown> : null;
}

function before(numbers: Record<string, string>, first: string, second: string): boolean {
  const [a, b] = [numbers[first], numbers[second]].map((value) => value.split(".").map(Number));
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

// alpha's prose contribution to a core stage, so "what alpha adds" can be read
// in that stage's source.
const CONTRIBUTION = [
  "---",
  "target: build-and-test",
  "plugin: alpha",
  "fragments:",
  "  - anchor: end-of-steps",
  "    order: 100",
  "---",
  "",
  "## fragment: end-of-steps",
  "",
  "ALPHA-CONTRIBUTION: check the alpha things.",
  "",
].join("\n");

const ZETA = (): string => plugin({ name: "zeta" });

describe("t354 the base composes first", () => {
  test("a team plugin whose name sorts before its base composes after it (the reporter's case)", () => {
    const target = project({ alpha: { root: alpha() }, zeta: { root: ZETA() } });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stderr).not.toContain("retry marker remains");
    expect(statusOf(target, "alpha")?.state).toBe("current");
    expect(statusOf(target, "zeta")?.state).toBe("current");
    expect(before(pluginStageNumbers(target), "zeta-example-stage", "alpha-example-stage")).toBe(true);
  });

  test("without an ordering edge the team stage still comes after the base stage that feeds it", () => {
    const target = project({ alpha: { root: alpha({ requires: undefined }) }, zeta: { root: ZETA() } });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(before(pluginStageNumbers(target), "zeta-example-stage", "alpha-example-stage")).toBe(true);
  });

  test("plugins with no base compose as before, with stamps that name no base", () => {
    const target = project({ mid: { root: plugin({ name: "mid" }) }, zeta: { root: ZETA() } });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe("plugin sync complete: 2 plugin(s)");
    for (const key of ["mid", "zeta"]) {
      expect(Object.keys(stamp(target, key) ?? {}).sort()).toEqual(["name", "schemaVersion", "sourceHash", "version"]);
    }
  });
});

describe("t354 a plugin that cannot build on its base is held, and the rest compose", () => {
  test("base not installed: one line, plugin list keeps it, the unrelated plugin composes", () => {
    const target = project({ alpha: { root: alpha() }, mid: { root: plugin({ name: "mid" }) } });
    const ran = sync(target);
    const line = "alpha is not composed: it needs zeta ^0.1.0, which is not installed. Install zeta and alpha composes at the next session start.";
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(line);
    expect(statusOf(target, "mid")?.state).toBe("current");
    expect(statusOf(target, "alpha")).toEqual(expect.objectContaining({
      state: "dependency-unmet",
      action: "attention",
      message: line,
    }));
    const listed = pluginTool(target, ["list"]);
    expect(listed.stdout).toContain(`needs attention: ${line}`);
  });

  test("base outside the range: the line names both versions, and doctor carries it", () => {
    const target = project({
      alpha: { root: alpha() },
      zeta: { root: plugin({ name: "zeta", version: "0.2.0" }), version: "0.2.0" },
      mid: { root: plugin({ name: "mid" }) },
    });
    const ran = sync(target);
    const line = "alpha is not composed: it needs zeta ^0.1.0, and zeta 0.2.0 is installed. Install a zeta version in that range, or a version of alpha made for zeta 0.2.0.";
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(line);
    expect(statusOf(target, "zeta")?.state).toBe("current");
    expect(statusOf(target, "mid")?.state).toBe("current");
    const doctor = spawnSync(process.execPath, [join(target.dir, ".claude", "tools", "aidlc-doctor.ts"), "--json"], {
      cwd: target.dir,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      env: cleanEnv({
        AIDLC_CLAUDE_PLUGIN_REGISTRY: target.registry,
        AIDLC_CLAUDE_SETTINGS: target.settings,
        CLAUDE_PROJECT_DIR: target.dir,
        AIDLC_HARNESS_DIR: ".claude",
        AIDLC_HARNESS_NAME: "claude",
      }),
    });
    const checks = (JSON.parse(doctor.stdout) as { data: { checks: Array<{ label: string; fix?: string; pass: boolean }> } }).data.checks;
    expect(checks.find((check) => check.label.startsWith("Plugins:"))).toEqual(expect.objectContaining({
      pass: false,
      label: "Plugins: 1 need attention",
      fix: line,
    }));
  });

  test("a base that builds on another plugin is never resolved: a chain of three and a loop", () => {
    const chain = project({
      alpha: { root: alpha() },
      zeta: { root: plugin({ name: "zeta", dependencies: ["core", "omega@^0.1.0"] }) },
      omega: { root: plugin({ name: "omega" }) },
    });
    const chained = sync(chain);
    expect(chained.status, chained.stdout + chained.stderr).toBe(0);
    expect(chained.stdout).toContain(
      "alpha is not composed: it builds on zeta, which builds on omega. A plugin can build only on a base that builds on core alone.",
    );
    expect(statusOf(chain, "zeta")?.state).toBe("current");
    expect(statusOf(chain, "omega")?.state).toBe("current");

    const loop = project({
      alpha: { root: alpha() },
      zeta: { root: plugin({ name: "zeta", dependencies: ["core", "alpha"] }) },
      mid: { root: plugin({ name: "mid" }) },
    });
    const looped = sync(loop);
    expect(looped.status, looped.stdout + looped.stderr).toBe(0);
    expect(looped.stdout).toContain("alpha is not composed: it builds on zeta, which builds on alpha.");
    expect(looped.stdout).toContain("zeta is not composed: it builds on alpha, which builds on zeta.");
    expect(statusOf(loop, "mid")?.state).toBe("current");
  });

  test("an installed plugin naming two bases is held; the build would have refused it", () => {
    const twoBases = alpha({ requires: undefined, consumes: undefined, dependencies: ["core", "zeta"] });
    const manifestPath = join(twoBases, ".aidlc-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    manifest.dependencies = ["core", "zeta", "mid"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const target = project({ alpha: { root: twoBases }, zeta: { root: ZETA() }, mid: { root: plugin({ name: "mid" }) } });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(
      "alpha is not composed: it names more than one base plugin (zeta, mid). A plugin builds on core and at most one base.",
    );
    expect(statusOf(target, "zeta")?.state).toBe("current");
    expect(statusOf(target, "mid")?.state).toBe("current");
  });

  test("an installed manifest whose dependencies cannot be read holds only that plugin", () => {
    const unreadable = alpha({ requires: undefined, consumes: undefined, dependencies: ["core"] });
    const manifestPath = join(unreadable, ".aidlc-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    manifest.dependencies = ["core", "zeta@>=1, <2"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const target = project({ alpha: { root: unreadable }, mid: { root: plugin({ name: "mid" }) } });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toMatch(
      /alpha is not composed: it has a \.aidlc-plugin\/plugin\.json that cannot be read \(.+\)\. Its author needs to fix that file\./,
    );
    expect(statusOf(target, "mid")?.state).toBe("current");
    expect(statusOf(target, "alpha")?.state).toBe("dependency-unmet");
  });

  test("a held plugin composed before stays as it was, and its line says so", () => {
    const target = project({ alpha: { root: alpha() }, zeta: { root: ZETA() } });
    expect(sync(target).status).toBe(0);
    setInstalled(target, {
      alpha: { root: alpha() },
      zeta: { root: plugin({ name: "zeta", version: "0.2.0" }), version: "0.2.0" },
    });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(
      "alpha stays as composed before, but it needs zeta ^0.1.0, and zeta 0.2.0 is installed. Install a zeta version in that range, or a version of alpha made for zeta 0.2.0.",
    );
    expect(stamp(target, "alpha")?.version).toBe("0.1.0");
    expect(stamp(target, "zeta")?.version).toBe("0.2.0");
    expect(pluginStageNumbers(target)["alpha-example-stage"]).toBeDefined();
  });

  test("said once: a second sync with the same held plugin prints no line, and --json still lists it", () => {
    const target = project({ alpha: { root: alpha() }, mid: { root: plugin({ name: "mid" }) } });
    expect(sync(target).stdout).toContain("alpha is not composed");
    const again = sync(target);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain("alpha");
    const json = pluginTool(target, ["sync", "--json"]);
    const data = (JSON.parse(json.stdout) as { data: { held: Array<{ name: string }>; newlyHeld: unknown[] } }).data;
    expect(data.held.map((record) => record.name)).toEqual(["alpha"]);
    expect(data.newlyHeld).toEqual([]);
  });
});

describe("t354 session-start hooks need no order", () => {
  test("with a host plugin list, the team plugin's own hook composes its installed base first", () => {
    const team = alpha();
    const base = ZETA();
    const target = project({ alpha: { root: team }, zeta: { root: base } });
    const first = sync(target, { hookRoot: team });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(statusOf(target, "alpha")?.state).toBe("current");
    expect(statusOf(target, "zeta")?.state).toBe("current");
    const second = sync(target, { hookRoot: base });
    expect(second.status, second.stdout + second.stderr).toBe(0);
  });

  test("with no host plugin list, the team plugin waits for its base and composes at the next sync", () => {
    const team = alpha();
    const base = ZETA();
    const target = project({});
    const first = sync(target, { hookRoot: team, hostList: false });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain(
      "alpha is not composed: it needs zeta ^0.1.0, which this project does not have yet. If zeta is installed, alpha composes at the next session start; if not, install zeta.",
    );
    expect(statusOf(target, "alpha", { hostList: false })?.state).toBe("dependency-unmet");
    expect(sync(target, { hookRoot: base, hostList: false }).status).toBe(0);
    const third = sync(target, { hookRoot: team, hostList: false });
    expect(third.status, third.stdout + third.stderr).toBe(0);
    expect(stamp(target, "alpha")).toEqual(expect.objectContaining({ version: "0.1.0", base: "zeta" }));
    expect(existsSync(join(target.dir, ".claude", "tools", "data", "plugin-held-alpha.json"))).toBe(false);
  });

  test("with no host plugin list, a chain is still held: the base's stamp names what it builds on", () => {
    const target = project({});
    const omega = plugin({ name: "omega" });
    const zeta = plugin({ name: "zeta", dependencies: ["core", "omega@^0.1.0"] });
    expect(sync(target, { hookRoot: omega, hostList: false }).status).toBe(0);
    expect(sync(target, { hookRoot: zeta, hostList: false }).status).toBe(0);
    const ran = sync(target, { hookRoot: alpha(), hostList: false });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain("alpha is not composed: it builds on zeta, which builds on omega.");
  });

  // Kiro CLI and opencode run no compose hook (opencode reads no hooks.json).
  test.each([["kiro", ".kiro"], ["opencode", ".aidlc"]] as const)(
    "on %s, which composes only when the person runs sync, the wait names the sync command",
    (harness, leaf) => {
      const base = fresh(`${harness}-project`);
      const dir = join(base, "project");
      mkdirSync(dir, { recursive: true });
      cpSync(join(REPO_ROOT, "dist", harness, leaf), join(dir, leaf), { recursive: true });
      const team = plugin({
        name: "alpha",
        dependencies: ["core", "zeta@^0.1.0"],
        requires: ["zeta-example-stage"],
        harness,
      });
      const ran = spawnSync(process.execPath, [join(dir, leaf, "tools", "aidlc-plugin.ts"), "sync"], {
        cwd: dir,
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
        env: cleanEnv({
          AIDLC_PLUGIN_ROOT: team,
          AIDLC_PROJECT_DIR: dir,
          AIDLC_HARNESS_DIR: leaf,
          AIDLC_HARNESS_NAME: harness,
        }),
      });
      expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      expect(ran.stdout).toContain(
        "alpha is not composed: it needs zeta ^0.1.0, which this project does not have yet. If zeta is installed, " +
          `alpha composes when you run \`bun ${leaf}/tools/aidlc.ts engine plugin sync --plugin-root ${quoteCommandArgument(team)}\` ` +
          "after zeta composes; if not, install zeta.",
      );
    },
  );

  // opencode and Copilot share .aidlc; the install's harness.json says which,
  // so the sync the person types needs only the plugin's folder.
  test.each(["opencode", "copilot"] as const)("on %s, a sync typed with only --plugin-root composes", (harness) => {
    const dir = join(fresh(`${harness}-typed`), "project");
    cpSync(join(REPO_ROOT, "dist", harness), dir, { recursive: true });
    const built = plugin({ name: "alpha", harness });
    const ran = spawnSync(
      process.execPath,
      [join(dir, ".aidlc", "tools", "aidlc.ts"), "engine", "plugin", "sync", "--plugin-root", built],
      {
        cwd: dir,
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
        env: cleanEnv({}),
      },
    );
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(existsSync(join(dir, ".aidlc", "tools", "data", "plugin-compose-alpha.json"))).toBe(true);
  });
});

const INIT = ["workspace-scaffold", "workspace-detection", "state-init"];

// The stages a scope runs, from the project's compiled grid; null when the
// grid has no column for it.
function column(target: Project, scope: string): string[] | null {
  const grid = JSON.parse(
    readFileSync(join(target.dir, ".claude", "tools", "data", "scope-grid.json"), "utf-8"),
  ) as Record<string, { stages: Record<string, string> }>;
  const stages = grid[scope]?.stages;
  return stages ? Object.keys(stages).filter((slug) => stages[slug] === "EXECUTE") : null;
}

// zeta at a version, with the stages it has besides its example stage.
function zetaWith(version: string, stages: string[]): Installed[string] {
  return { root: plugin({ name: "zeta", version, stages }), version };
}

describe("t354 a team scope runs the base stages it includes", () => {
  test("the team scope runs them, and the base's stages and scope stay as they were (the reporter's case B)", () => {
    const target = project({
      alpha: { root: alpha({ includes: ["zeta-intake"] }) },
      zeta: zetaWith("0.1.0", ["zeta-intake", "zeta-research"]),
    });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe("plugin sync complete: 2 plugin(s)");
    expect(column(target, "alpha-example")).toEqual([...INIT, "zeta-intake", "alpha-example-stage"]);
    expect(column(target, "zeta-example")).toEqual([...INIT, "zeta-example-stage", "zeta-intake", "zeta-research"]);
    const intake = join(target.dir, ".claude", "aidlc-common", "stages", "construction", "zeta-intake.md");
    expect(readFileSync(intake, "utf-8")).not.toContain("alpha-example");
  });

  test("a base that no longer has an included stage holds the team plugin, with one line naming every stage", () => {
    const target = project({
      alpha: { root: alpha({ includes: ["zeta-intake", "zeta-research"] }) },
      zeta: zetaWith("0.1.1", ["zeta-intake-v2"]),
    });
    const ran = sync(target);
    const line = "alpha is not composed: it needs zeta-intake and zeta-research for its alpha-example scope, which zeta 0.1.1 does not have. Install a version of zeta that has them, or a version of alpha made for zeta 0.1.1.";
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(line);
    expect(statusOf(target, "zeta")?.state).toBe("current");
    expect(statusOf(target, "alpha")).toEqual(expect.objectContaining({ state: "dependency-unmet", message: line }));
  });

  test("composed before: the team plugin stays, its scope runs without the stage, the line is said once, and the old column is not kept", () => {
    const team = alpha({ includes: ["zeta-intake"], includesOnly: true });
    const target = project({ alpha: { root: team }, zeta: zetaWith("0.1.0", ["zeta-intake"]) });
    expect(sync(target).status).toBe(0);
    expect(column(target, "alpha-example")).toEqual([...INIT, "zeta-intake"]);
    setInstalled(target, { alpha: { root: team }, zeta: zetaWith("0.1.1", ["zeta-intake-v2"]) });
    const ran = sync(target);
    const line = "alpha stays as composed before, but it needs zeta-intake for its alpha-example scope, which zeta 0.1.1 does not have, so alpha-example runs without it. Install a version of zeta that has it, or a version of alpha made for zeta 0.1.1.";
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(line);
    expect(stamp(target, "alpha")?.version).toBe("0.1.0");
    expect(stamp(target, "zeta")?.version).toBe("0.1.1");
    // Only include_stages put alpha-example in the grid, so it is no
    // composer-authored scope whose old column a recompile keeps.
    expect(column(target, "alpha-example") ?? []).not.toContain("zeta-intake");
    expect(existsSync(join(target.dir, "aidlc", "scopes", "alpha-example.md"))).toBe(false);
    const again = sync(target);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain("alpha");
    expect(statusOf(target, "alpha")?.message).toBe(line);
  });

  test("with no host plugin list, the check reads the stages the base composed in the project", () => {
    const held = project({});
    expect(sync(held, { hookRoot: zetaWith("0.1.1", ["zeta-intake-v2"]).root, hostList: false }).status).toBe(0);
    const ran = sync(held, { hookRoot: alpha({ includes: ["zeta-intake"] }), hostList: false });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(
      "alpha is not composed: it needs zeta-intake for its alpha-example scope, which zeta 0.1.1 does not have. Install a version of zeta that has it, or a version of alpha made for zeta 0.1.1.",
    );

    const composed = project({});
    expect(sync(composed, { hookRoot: zetaWith("0.1.0", ["zeta-intake"]).root, hostList: false }).status).toBe(0);
    const fits = sync(composed, { hookRoot: alpha({ includes: ["zeta-intake"] }), hostList: false });
    expect(fits.status, fits.stdout + fits.stderr).toBe(0);
    expect(fits.stdout).not.toContain("alpha is not composed");
    expect(column(composed, "alpha-example")).toEqual([...INIT, "zeta-intake", "alpha-example-stage"]);
  });

  test("a base outside the range says only the range line", () => {
    const target = project({ alpha: { root: alpha({ includes: ["zeta-intake"] }) }, zeta: zetaWith("0.2.0", []) });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain("alpha is not composed: it needs zeta ^0.1.0, and zeta 0.2.0 is installed.");
    expect(ran.stdout).not.toContain("zeta-intake");
  });
});

describe("t354 the build carries the plugin's own manifest", () => {
  test("every harness projection has .aidlc-plugin/plugin.json and the scope's include_stages, and no host manifest has dependencies", () => {
    for (const harness of HARNESSES) {
      const out = plugin({ name: "alpha", dependencies: ["core", "zeta@^0.1.0"], includes: ["zeta-intake"], harness });
      const carried = JSON.parse(readFileSync(join(out, ".aidlc-plugin", "plugin.json"), "utf-8")) as { dependencies?: unknown };
      expect(carried.dependencies, harness).toEqual(["core", "zeta@^0.1.0"]);
      expect(readFileSync(join(out, "scopes", "alpha-example.md"), "utf-8"), harness).toContain("include_stages: [zeta-intake]");
      for (const entry of readdirSync(out)) {
        const hostManifest = join(out, entry, "plugin.json");
        if (entry === ".aidlc-plugin" || !existsSync(hostManifest)) continue;
        expect(Object.keys(JSON.parse(readFileSync(hostManifest, "utf-8"))), `${harness} ${entry}`).not.toContain("dependencies");
      }
    }
  });
});

// C: `/aidlc plugin select` takes the whole list, so a person who leaves the
// base out and keeps the team plugin typed the team plugin themselves. The
// select goes through as typed; the team plugin is paused (nothing it adds
// runs) until its base is on again; one line says so at that select, then
// silence; turning the base back on brings it back at the next session start.
describe("t354 turning a base off pauses the plugin built on it", () => {
  const PAUSE_LINE =
    "zeta is off. alpha builds on zeta, so alpha is paused until zeta is on again. To turn alpha off as well: /aidlc plugin select aidlc.";

  // alpha with a prose contribution to a core stage, so "nothing alpha adds
  // runs" can be read in that stage's source.
  function contributingAlpha(): string {
    const out = alpha();
    mkdirSync(join(out, "contributions", "construction"), { recursive: true });
    writeFileSync(join(out, "contributions", "construction", "build-and-test.md"), CONTRIBUTION);
    return out;
  }

  function engine(target: Project, args: string[]): Ran {
    const result = spawnSync(process.execPath, [join(target.dir, ".claude", "tools", "aidlc.ts"), ...args], {
      cwd: target.dir,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      env: cleanEnv({
        AIDLC_CLAUDE_PLUGIN_REGISTRY: target.registry,
        AIDLC_CLAUDE_SETTINGS: target.settings,
        CLAUDE_PROJECT_DIR: target.dir,
        AIDLC_HARNESS_DIR: ".claude",
        AIDLC_HARNESS_NAME: "claude",
      }),
    });
    return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }

  const select = (target: Project, names: string): Ran => engine(target, ["engine", "plugin", "select", names]);
  const buildAndTest = (target: Project): string =>
    readFileSync(join(target.dir, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
  const selection = (target: Project): unknown =>
    (JSON.parse(readFileSync(join(target.dir, ".claude", "tools", "data", "harness.json"), "utf-8")) as { plugins?: unknown }).plugins;
  const stageEnabled = (target: Project, slug: string): boolean => {
    const graph = JSON.parse(
      readFileSync(join(target.dir, ".claude", "tools", "data", "stage-graph.json"), "utf-8"),
    ) as Array<{ slug: string; enabled?: boolean }>;
    return graph.find((node) => node.slug === slug)?.enabled !== false;
  };
  const doctorChecks = (target: Project): Array<{ label: string; pass: boolean; fix?: string; severity?: string }> => {
    const ran = engine(target, ["doctor", "--json"]);
    return (JSON.parse(ran.stdout) as { data: { checks: Array<{ label: string; pass: boolean; fix?: string; severity?: string }> } }).data.checks;
  };

  let alphaRoot = "";
  function composedPair(): Project {
    alphaRoot = contributingAlpha();
    const target = project({ alpha: { root: alphaRoot }, zeta: { root: ZETA() } });
    const ran = sync(target);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(buildAndTest(target)).toContain("ALPHA-CONTRIBUTION");
    return target;
  }

  test("the select goes through exactly as typed and says the pause once", () => {
    const target = composedPair();
    const first = select(target, "aidlc,alpha");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(selection(target)).toEqual(["aidlc", "alpha"]);
    // The pause line carries it: alpha is not turned off, and turning zeta
    // on, not alpha, brings it back.
    expect(first.stdout.trim().split("\n")).toEqual(["Enabled plugins: aidlc, alpha", PAUSE_LINE]);
    const again = select(target, "aidlc,alpha");
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain("paused");
  });

  test("while paused nothing alpha adds runs, and session start and sync say nothing about it", () => {
    const target = composedPair();
    expect(select(target, "aidlc,alpha").status).toBe(0);
    expect(stageEnabled(target, "alpha-example-stage")).toBe(false);
    expect(buildAndTest(target)).not.toContain("ALPHA-CONTRIBUTION");
    const agreement = doctorChecks(target).find((check) => check.label.startsWith("Plugin selection flags"));
    expect(agreement?.pass).toBe(true);
    const synced = sync(target);
    expect(synced.status, synced.stdout + synced.stderr).toBe(0);
    expect(synced.stdout).not.toContain("alpha");
    expect(buildAndTest(target)).not.toContain("ALPHA-CONTRIBUTION");
    const hook = sync(target, { hookRoot: alphaRoot });
    expect(hook.status, hook.stdout + hook.stderr).toBe(0);
    expect(hook.stdout).not.toContain("alpha");
    expect(buildAndTest(target)).not.toContain("ALPHA-CONTRIBUTION");
  });

  test("plugin list shows the pause as a plain state, and doctor as information only", () => {
    const target = composedPair();
    expect(select(target, "aidlc,alpha").status).toBe(0);
    expect(statusOf(target, "alpha")).toEqual(expect.objectContaining({
      state: "paused",
      action: "current",
      message: "paused: needs zeta, which is off",
    }));
    expect(pluginTool(target, ["list"]).stdout).toMatch(/alpha\s+0\.1\.0\s+0\.1\.0\s+paused: needs zeta, which is off/);
    const inChat = spawnSync(process.execPath, [join(target.dir, ".claude", "tools", "aidlc-utility.ts"), "plugin-list"], {
      cwd: target.dir,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      env: cleanEnv({ CLAUDE_PROJECT_DIR: target.dir, AIDLC_HARNESS_DIR: ".claude", AIDLC_HARNESS_NAME: "claude" }),
    });
    expect(String(inChat.stdout)).toContain("alpha paused: needs zeta, which is off");
    const plugins = doctorChecks(target).find((check) => check.label.startsWith("Plugins:"));
    expect(plugins?.pass).toBe(true);
    expect(plugins?.label).toContain("alpha paused: needs zeta, which is off");
    expect(plugins?.fix).toBeUndefined();
  });

  test("a plugin turned off, not paused, still gets the strip line", () => {
    const target = composedPair();
    const off = select(target, "aidlc,zeta");
    expect(off.status, off.stdout + off.stderr).toBe(0);
    expect(off.stdout).toContain(
      "What alpha added to other stages and agents is taken out; turn alpha back on and it returns at the next session start.",
    );
    expect(off.stdout).not.toContain("paused");
  });

  test.each([["kiro", ".kiro"], ["opencode", ".aidlc"]] as const)(
    "on %s, turning a plugin off names the sync command that brings back what it added",
    (harness, leaf) => {
      const dir = join(fresh(`${harness}-off`), "project");
      mkdirSync(dir, { recursive: true });
      cpSync(join(REPO_ROOT, "dist", harness, leaf), join(dir, leaf), { recursive: true });
      const built = plugin({ name: "alpha", harness });
      mkdirSync(join(built, "contributions", "construction"), { recursive: true });
      writeFileSync(join(built, "contributions", "construction", "build-and-test.md"), CONTRIBUTION);
      const run = (tool: string, args: string[], extra: Record<string, string> = {}): Ran => {
        const result = spawnSync(process.execPath, [join(dir, leaf, "tools", tool), ...args], {
          cwd: dir,
          encoding: "utf-8",
          timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
          env: cleanEnv({ AIDLC_PROJECT_DIR: dir, AIDLC_HARNESS_DIR: leaf, AIDLC_HARNESS_NAME: harness, ...extra }),
        });
        return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
      };
      const synced = run("aidlc-plugin.ts", ["sync"], { AIDLC_PLUGIN_ROOT: built });
      expect(synced.status, synced.stdout + synced.stderr).toBe(0);
      const off = run("aidlc.ts", ["engine", "plugin", "select", "aidlc"]);
      expect(off.status, off.stdout + off.stderr).toBe(0);
      expect(off.stdout).toContain(
        "What alpha added to other stages and agents is taken out; turn alpha back on and it returns when you run " +
          `\`bun ${leaf}/tools/aidlc.ts engine plugin sync --plugin-root <alpha's folder>\`.`,
      );
    },
  );

  test("turning zeta back on brings alpha back at the next session start, with nothing else to do", () => {
    const target = composedPair();
    expect(select(target, "aidlc,alpha").status).toBe(0);
    const back = select(target, "aidlc,alpha,zeta");
    expect(back.status, back.stdout + back.stderr).toBe(0);
    expect(back.stdout).not.toContain("paused");
    expect(stageEnabled(target, "alpha-example-stage")).toBe(true);
    const synced = sync(target);
    expect(synced.status, synced.stdout + synced.stderr).toBe(0);
    expect(buildAndTest(target)).toContain("ALPHA-CONTRIBUTION");
    expect(statusOf(target, "alpha")?.state).toBe("current");
  });

  test("through aidlc config project --plugins the same pause goes through and says its own command", () => {
    const target = composedPair();
    const recorded = engine(target, ["config", "--from", join(REPO_ROOT, "dist", "claude"), "--force", "--yes"]);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const ran = engine(target, ["config", "project", "--plugins", "aidlc,alpha", "--yes"]);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(selection(target)).toEqual(["aidlc", "alpha"]);
    expect(ran.stdout).toMatch(
      /zeta is off\. alpha builds on zeta, so alpha is paused until zeta is on again\. To turn alpha off as well: .*config project --plugins aidlc --yes/,
    );
    expect(stageEnabled(target, "alpha-example-stage")).toBe(false);
    // While paused nothing alpha adds runs, as through plugin select.
    expect(buildAndTest(target)).not.toContain("ALPHA-CONTRIBUTION");
    expect(existsSync(join(target.dir, ".claude", "tools", "data", "plugin-contrib-alpha.json"))).toBe(false);
    // Turning zeta back on there brings alpha back at the next session start.
    const back = engine(target, ["config", "project", "--plugins", "aidlc,alpha,zeta", "--yes"]);
    expect(back.status, back.stdout + back.stderr).toBe(0);
    expect(back.stdout).not.toContain("paused");
    const synced = sync(target);
    expect(synced.status, synced.stdout + synced.stderr).toBe(0);
    expect(buildAndTest(target)).toContain("ALPHA-CONTRIBUTION");
  });

  test("a select that would pause the plugin open work runs on is refused as a turn-off is, naming both", () => {
    const target = composedPair();
    const dirName = "pause-probe-deadbeef";
    const intentDir = join(target.dir, "aidlc", "spaces", "default", "intents", dirName);
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(
      join(target.dir, "aidlc", "spaces", "default", "intents", "intents.json"),
      `${JSON.stringify([{ uuid: "deadbeef-0000-4000-8000-000000000000", slug: "pause-probe", dirName, scope: "alpha-example", status: "in-flight" }], null, 2)}\n`,
    );
    writeFileSync(
      join(intentDir, "aidlc-state.md"),
      [
        "# AI-DLC State Tracking",
        "",
        "## Project Information",
        "- **Project**: pause probe",
        "- **Scope**: alpha-example",
        "",
        "## Current Status",
        "- **Status**: Running",
        "",
      ].join("\n"),
    );
    const ran = select(target, "aidlc,alpha");
    expect(ran.status).not.toBe(0);
    const said = (JSON.parse((ran.stdout + ran.stderr).trim()) as { error: string }).error;
    expect(said).toContain('owned by plugin "alpha"');
    expect(said).toContain("alpha builds on zeta");
    expect(selection(target)).toBeUndefined();
  });
});

// Kiro CLI and opencode keep no list of the plugins installed, so every line
// that sends the person to sync names the plugin's folder; in a project with
// more than one harness, the native aidlc also names the harness.
describe("t354 every line that sends the person to sync names a command that works there", () => {
  // A copy of `tree`/<harness> with alpha, which adds to build-and-test,
  // composed from its folder, and a runner for that copy's own tools in the
  // person's shell: no plugin folder or harness in the environment.
  function composedAlpha(harness: "kiro" | "opencode", leaf: string, tree = "dist") {
    const dir = join(fresh(`${harness}-sync`), "project");
    mkdirSync(dir, { recursive: true });
    cpSync(join(REPO_ROOT, tree, harness, leaf), join(dir, leaf), { recursive: true });
    const built = plugin({ name: "alpha", harness });
    mkdirSync(join(built, "contributions", "construction"), { recursive: true });
    writeFileSync(join(built, "contributions", "construction", "build-and-test.md"), CONTRIBUTION);
    const run = (tool: string, args: string[]): Ran => {
      const result = spawnSync(process.execPath, [join(dir, leaf, "tools", tool), ...args], {
        cwd: dir,
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
        env: cleanEnv({}),
      });
      return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    };
    const synced = run("aidlc.ts", ["engine", "plugin", "sync", "--plugin-root", built]);
    expect(synced.status, synced.stdout + synced.stderr).toBe(0);
    return { dir, built, run };
  }

  test.each([["kiro", ".kiro"], ["opencode", ".aidlc"]] as const)(
    "on %s, a sync with no folder says nothing synced and names each composed plugin's folder command",
    (harness, leaf) => {
      const { run } = composedAlpha(harness, leaf);
      const bare = run("aidlc.ts", ["engine", "plugin", "sync"]);
      expect(bare.status).toBe(1);
      expect(bare.stderr).toContain(
        "Nothing synced: this tool keeps no list of your plugins, so name each one's folder: " +
          `\`bun ${leaf}/tools/aidlc.ts engine plugin sync --plugin-root <alpha's folder>\`.`,
      );
    },
  );

  test("on Kiro CLI's copied install, the chat sync says the same with no folder and composes with one", () => {
    const { dir, built, run } = composedAlpha("kiro", ".kiro");
    const bare = run("aidlc-utility.ts", ["plugin-sync"]);
    expect(bare.status, bare.stdout + bare.stderr).toBe(0);
    expect(bare.stdout).toContain(
      "Nothing synced: this tool keeps no list of your plugins, so name each one's folder: " +
        "`bun .kiro/tools/aidlc.ts engine plugin sync --plugin-root <alpha's folder>`.",
    );
    const stage = join(dir, ".kiro", "aidlc-common", "stages", "construction", "build-and-test.md");
    writeFileSync(stage, readFileSync(join(REPO_ROOT, "dist", "kiro", ".kiro", "aidlc-common", "stages", "construction", "build-and-test.md")));
    rmSync(join(dir, ".kiro", "tools", "data", "plugin-contrib-alpha.json"), { force: true });
    const withFolder = run("aidlc-utility.ts", ["plugin-sync", "--plugin-root", built]);
    expect(withFolder.status, withFolder.stdout + withFolder.stderr).toBe(0);
    expect(withFolder.stdout).toContain("plugin sync complete: 1 plugin(s)");
    expect(readFileSync(stage, "utf-8")).toContain("ALPHA-CONTRIBUTION");
  });

  test("on Kiro CLI, a sync refused over a changed file names the folder it ran with", () => {
    const { dir, built, run } = composedAlpha("kiro", ".kiro");
    const owned = join(dir, ".kiro", "aidlc-common", "stages", "construction", "alpha-example-stage.md");
    writeFileSync(owned, `${readFileSync(owned, "utf-8")}\nlocal edit\n`);
    const refused = run("aidlc.ts", ["engine", "plugin", "sync", "--plugin-root", built]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `then run \`bun .kiro/tools/aidlc.ts engine plugin sync --plugin-root ${quoteCommandArgument(built)}\` again`,
    );
  });

  test("on Kiro CLI, a sync that leaves a plugin uncomposed names that plugin's folder command", () => {
    const dir = join(fresh("kiro-uncomposed"), "project");
    mkdirSync(dir, { recursive: true });
    cpSync(join(REPO_ROOT, "dist", "kiro", ".kiro"), join(dir, ".kiro"), { recursive: true });
    const built = plugin({ name: "alpha", harness: "kiro" });
    mkdirSync(join(built, "contributions", "construction"), { recursive: true });
    writeFileSync(join(built, "contributions", "construction", "build-and-test.md"), CONTRIBUTION);
    // A compose hook that merges nothing stands in for a composition lost
    // after the sync committed: alpha's record of what it added never lands.
    writeFileSync(join(built, "hooks", "compose.ts"), "export async function compose(): Promise<void> {}\n");
    const ran = spawnSync(
      process.execPath,
      [join(dir, ".kiro", "tools", "aidlc.ts"), "engine", "plugin", "sync", "--plugin-root", built],
      { cwd: dir, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), env: cleanEnv({}) },
    );
    expect(ran.status).toBe(1);
    expect(String(ran.stderr)).toContain(
      "plugin sync finished but alpha is not composed; " +
        `run bun .kiro/tools/aidlc.ts engine plugin sync --plugin-root ${quoteCommandArgument(built)} again`,
    );
  });

  test("on Kiro CLI, doctor's fix for what a refresh took out names the folder command", () => {
    const { dir, run } = composedAlpha("kiro", ".kiro");
    const stock = join(REPO_ROOT, "dist", "kiro", ".kiro");
    for (const rel of [join("tools", "data", "stage-graph.json"), join("aidlc-common", "stages", "construction", "build-and-test.md")]) {
      writeFileSync(join(dir, ".kiro", rel), readFileSync(join(stock, rel)));
    }
    const doctor = run("aidlc.ts", ["doctor", "--json"]);
    const checks = (JSON.parse(doctor.stdout) as { data: { checks: Array<{ label: string; pass: boolean; fix?: string }> } }).data.checks;
    const surface = checks.find((check) => check.label.startsWith("Composed plugin surface"));
    expect(surface?.pass).toBe(false);
    expect(surface?.fix).toContain("then re-run `bun .kiro/tools/aidlc.ts engine plugin sync --plugin-root <alpha's folder>`.");
    const uncompiled = checks.find((check) => check.label.startsWith("Uncompiled stage files"));
    expect(uncompiled?.label).toContain(
      "plugin-owned files alpha-example-stage (alpha) require `bun .kiro/tools/aidlc.ts engine plugin sync --plugin-root <alpha's folder>`",
    );
  });

  // The native aidlc picks the first harness installed, so with a second one
  // here the command names Kiro CLI's; with one it needs nothing more.
  test.each([["one harness folder", false], ["a .claude folder too", true]] as const)(
    "the native aidlc's command with %s",
    (_, withClaude) => {
      const { dir, run } = composedAlpha("kiro", ".kiro", "dist-release");
      if (withClaude) {
        cpSync(join(REPO_ROOT, "dist-release", "claude", ".claude"), join(dir, ".claude"), { recursive: true });
      }
      const off = run("aidlc.ts", ["engine", "plugin", "select", "aidlc"]);
      expect(off.status, off.stdout + off.stderr).toBe(0);
      expect(off.stdout).toContain(
        `turn alpha back on and it returns when you run \`aidlc engine plugin sync${withClaude ? " --harness-dir .kiro" : ""} ` +
          "--plugin-root <alpha's folder>`.",
      );
    },
  );

  test("native Claude Code's changed-file refusal stays the bare command, with a .kiro folder beside it", () => {
    const dir = join(fresh("claude-native"), "project");
    mkdirSync(dir, { recursive: true });
    for (const [harness, leaf] of [["claude", ".claude"], ["kiro", ".kiro"]]) {
      cpSync(join(REPO_ROOT, "dist-release", harness, leaf), join(dir, leaf), { recursive: true });
    }
    const built = plugin({ name: "alpha" });
    const sync = (): Ran => {
      const result = spawnSync(
        process.execPath,
        [join(dir, ".claude", "tools", "aidlc.ts"), "engine", "plugin", "sync", "--plugin-root", built],
        {
          cwd: dir,
          encoding: "utf-8",
          timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
          env: cleanEnv({ AIDLC_CLAUDE_PLUGIN_REGISTRY: join(dir, "no-registry.json") }),
        },
      );
      return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    };
    const composed = sync();
    expect(composed.status, composed.stdout + composed.stderr).toBe(0);
    const owned = join(dir, ".claude", "aidlc-common", "stages", "construction", "alpha-example-stage.md");
    writeFileSync(owned, `${readFileSync(owned, "utf-8")}\nlocal edit\n`);
    const refused = sync();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("then run `aidlc engine plugin sync` again; it puts the plugin's own version back.");
  });
});
