// covers: subcommand:aidlc-utility:plugin-validate subcommand:aidlc-utility:plugin-build subcommand:aidlc-utility:plugin-test

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { asShippedBuild } from "../harness/plugin-host-names.ts";
import { ROUTES, type Route, routeOptions } from "../../dist/claude/.claude/tools/aidlc.ts";
import {
  comparablePluginTest,
  helpOptionForms,
  runShippedPluginTest,
  writePluginTestFixtures,
} from "../harness/plugin-test-fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const DISPATCHER = join(TOOLS, "aidlc.ts");
const SOURCE_PLUGIN = join(REPO_ROOT, "plugins", "test-pro");
const EXPECTED = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t327-"));
const pluginRoot = join(scratch, "test-pro");
cpSync(SOURCE_PLUGIN, pluginRoot, { recursive: true });
// A copy-channel project: the dist/claude tree, as t316 installs it.
const install = join(scratch, "install");
cpSync(join(REPO_ROOT, "dist", "claude"), install, { recursive: true });
const plugins = writePluginTestFixtures(join(scratch, "plugin-test"), TOOLS);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[], cwd = pluginRoot) {
  const result = spawnSync(process.execPath, [DISPATCHER, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_DISPATCH_TOOLS_DIR: TOOLS },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out;
}

describe("t327 top-level plugin authoring routes", () => {
  test("plugin validate delegates to the shipped standalone validator", () => {
    const result = run(["plugin", "validate", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test("plugin validate passes --with <base-root> to the validator", () => {
    // test-pro builds on core alone, so the validator itself answers --with.
    const result = run(["plugin", "validate", pluginRoot, "--with", scratch, "--json"], scratch);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).errors).toMatchObject([
      { rule: "base-root", message: `--with names ${scratch}, but this plugin builds on core alone` },
    ]);
    const bare = run(["plugin", "validate", pluginRoot, "--with"], scratch);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("--with <base-root>");
  });

  test("plugin build delegates to the shared emitter with --plugin-root", () => {
    const outDir = join(scratch, "built");
    const result = run(
      [
        "plugin",
        "build",
        "claude",
        outDir,
        "--plugin-root",
        pluginRoot,
        "--json",
      ],
      scratch,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).valid).toBe(true);
    // The shipped route builds test-pro under its own names; the packager's
    // tree is AI-DLC's own, aidlc-test-pro in aidlc-plugins.
    const expected = asShippedBuild("claude")(
      new Map(files(EXPECTED).map((file) => [file, readFileSync(join(EXPECTED, file))])),
    );
    expect(files(outDir).sort()).toEqual([...expected.keys()].sort());
    for (const [file, bytes] of expected) {
      expect(readFileSync(join(outDir, file)).equals(bytes), file).toBe(true);
    }
  });

  // The verb and the shipped runner, on the same plugin and project.
  function both(root: string, extra: string[] = []) {
    const verb = run(["plugin", "test", "--install", install, "--json", ...extra], root);
    const runner = runShippedPluginTest(TOOLS, [root, "--install", install, "--json", ...extra], root);
    return { verb, runner };
  }

  test("plugin test runs the shipped compose test from the plugin folder, pass and fail alike", () => {
    const clean = both(plugins.clean);
    expect(clean.verb.status, clean.verb.stderr).toBe(0);
    expect(comparablePluginTest(clean.verb.stdout)).toEqual(comparablePluginTest(clean.runner.stdout));
    const colliding = both(plugins.colliding);
    expect(colliding.verb.status).toBe(1);
    expect(colliding.runner.status).toBe(1);
    expect(comparablePluginTest(colliding.verb.stdout)).toEqual(comparablePluginTest(colliding.runner.stdout));
    const human = run(["plugin", "test", plugins.clean, "--install", install], scratch);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("Plugin test: CLEAN");
  });

  test("plugin test passes --with <base-root> to the shipped runner", () => {
    const withBase = both(plugins.alpha, ["--with", plugins.zeta]);
    expect(withBase.verb.status, withBase.verb.stderr).toBe(0);
    expect(comparablePluginTest(withBase.verb.stdout)).toEqual(comparablePluginTest(withBase.runner.stdout));
    const without = both(plugins.alpha);
    expect(without.verb.status).toBe(1);
    expect(comparablePluginTest(without.verb.stdout)).toEqual(comparablePluginTest(without.runner.stdout));
  });

  function utility(project: string, args: string[]) {
    const result = spawnSync(process.execPath, [join(project, ".claude", "tools", "aidlc-utility.ts"), ...args], {
      cwd: project,
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".claude" },
    });
    return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }

  // A copy-channel project narrowed to core with its own select line; with
  // `installed`, test-pro's compose hook installs the plugin there first, as a
  // session start does.
  function narrowedProject(name: string, installed: boolean): string {
    const project = join(scratch, name);
    cpSync(join(REPO_ROOT, "dist", "claude"), project, { recursive: true });
    if (installed) {
      const compose = spawnSync(process.execPath, [join(EXPECTED, "hooks", "compose.ts")], {
        cwd: project,
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: EXPECTED, CLAUDE_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".claude" },
      });
      expect(compose.status, compose.stderr).toBe(0);
    }
    const narrowed = utility(project, ["select-plugins", "aidlc"]);
    expect(narrowed.status, narrowed.stderr).toBe(0);
    return project;
  }

  const drops = (stdout: string): string[] =>
    (JSON.parse(stdout) as { drops: Array<{ message: string }> }).drops.map((drop) => drop.message);

  test("plugin test on a project that leaves the plugin off names the copy channel's select line, after installing the plugin there only when it is not", () => {
    const missing = narrowedProject("narrowed-missing", false);
    const notInstalled = run(["plugin", "test", "--install", missing, "--json"], plugins.clean);
    expect(notInstalled.status, notInstalled.stderr).toBe(1);
    expect(drops(notInstalled.stdout)).toEqual([
      'plugin "test-pro" composed but is not enabled by tools/data/harness.json; test-pro is not installed in this project yet: install it there first, then run `bun .claude/tools/aidlc-utility.ts select-plugins aidlc,test-pro` to expose its stages, scopes, and runners',
    ]);
    expect(utility(missing, ["select-plugins", "aidlc,test-pro"]).stderr).toContain("Unknown plugin name(s): test-pro");

    const off = narrowedProject("narrowed-installed", true);
    const installedOff = run(["plugin", "test", "--install", off, "--json"], plugins.clean);
    expect(installedOff.status, installedOff.stderr).toBe(1);
    expect(drops(installedOff.stdout)).toEqual([
      'plugin "test-pro" composed but is not enabled by tools/data/harness.json; run `bun .claude/tools/aidlc-utility.ts select-plugins aidlc,test-pro` to expose its stages, scopes, and runners',
    ]);
    const enabled = utility(off, ["select-plugins", "aidlc,test-pro"]);
    expect(enabled.status, enabled.stderr).toBe(0);
  });

  test("plugin test --help names exactly its options, and a usage error exits 2 with the verb's usage", () => {
    const usage = "bun .claude/tools/aidlc.ts plugin test [path] --install <project-root> [--harness <name>] [--with <base-root>] [--json]";
    const help = run(["plugin", "test", "--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(`\n  ${usage}\n`);
    const route = ROUTES.find((candidate) => candidate.id === "plugin-author") as Route;
    expect(helpOptionForms(help.stdout).sort()).toEqual(
      routeOptions(route, "test").map((option) => option.metavar ? `${option.flag} <${option.metavar}>` : option.flag).sort(),
    );
    expect(helpOptionForms(help.stdout)).toEqual([
      "--harness <name>",
      "--install <project-root>",
      "--with <base-root>",
      "--json",
      "--no-color",
    ]);
    // -h after the plugin's folder is still a request for help, as the
    // standalone tool reads it.
    const short = run(["plugin", "test", ".", "-h"]);
    expect(short.status, short.stderr).toBe(0);
    expect(short.stdout).toBe(help.stdout);
    for (const [args, reason] of [
      [["plugin", "test"], "--install <project-root> is required"],
      [["plugin", "test", "--install", install, "--plugin-root", "."], 'unknown option "--plugin-root"'],
      [["plugin", "test", "--install"], "--install requires a value"],
      [["plugin", "test", "a", "b", "--install", install], 'unexpected positional argument "b"'],
    ] as const) {
      const result = run([...args]);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toBe(`Usage: ${usage}\n${reason}\n`);
    }
  });
});
