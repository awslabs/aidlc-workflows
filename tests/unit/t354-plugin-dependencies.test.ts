// covers: file:core/tools/aidlc-plugin.ts, file:core/tools/aidlc-plugin-validate.ts,
// file:core/tools/aidlc-plugin-emit.ts
//
// t354-plugin-dependencies - a team plugin builds on core and at most one base
// plugin, and a base builds on core alone (#2693). Plugin sync composes the
// bases first, then the plugins built on them, whatever their names and
// whatever order the hosts run their session-start hooks in. A plugin whose
// base is missing, outside its range or built on another plugin, or that names
// two bases, is held with one line: said once by sync, kept by plugin list and
// doctor, while every other plugin still composes. A held plugin composed
// before stays as it was, and its line says so.
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
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
  writeFileSync(stagePath, stage);
  const out = join(dir, "build");
  const built = spawnSync(
    process.execPath,
    [join(TOOLS, "aidlc-plugin-build.ts"), root, spec.harness ?? "claude", out],
    { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), env: cleanEnv({}) },
  );
  expect(built.status, built.stdout + built.stderr).toBe(0);
  return out;
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
    plugins[`aidlc-${name}@aidlc-plugins`] = [
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

  test("on Kiro CLI, which composes only when the person runs sync, the wait names the next plugin sync", () => {
    const base = fresh("kiro-project");
    const dir = join(base, "project");
    mkdirSync(dir, { recursive: true });
    cpSync(join(REPO_ROOT, "dist", "kiro", ".kiro"), join(dir, ".kiro"), { recursive: true });
    const team = plugin({
      name: "alpha",
      dependencies: ["core", "zeta@^0.1.0"],
      requires: ["zeta-example-stage"],
      harness: "kiro",
    });
    const ran = spawnSync(process.execPath, [join(dir, ".kiro", "tools", "aidlc-plugin.ts"), "sync"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      env: cleanEnv({
        AIDLC_PLUGIN_ROOT: team,
        AIDLC_PROJECT_DIR: dir,
        AIDLC_HARNESS_DIR: ".kiro",
        AIDLC_HARNESS_NAME: "kiro",
      }),
    });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(
      "alpha is not composed: it needs zeta ^0.1.0, which this project does not have yet. If zeta is installed, alpha composes at the next plugin sync after zeta; if not, install zeta.",
    );
  });
});

describe("t354 the build carries the plugin's own manifest", () => {
  test("every harness projection has .aidlc-plugin/plugin.json, and no host manifest has dependencies", () => {
    for (const harness of HARNESSES) {
      const out = plugin({ name: "alpha", dependencies: ["core", "zeta@^0.1.0"], harness });
      const carried = JSON.parse(readFileSync(join(out, ".aidlc-plugin", "plugin.json"), "utf-8")) as { dependencies?: unknown };
      expect(carried.dependencies, harness).toEqual(["core", "zeta@^0.1.0"]);
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
      "Stripped merged contributions of disabled plugin(s): alpha (re-enabling restores them on the next session start)",
    );
    expect(off.stdout).not.toContain("paused");
  });

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
