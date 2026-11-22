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
