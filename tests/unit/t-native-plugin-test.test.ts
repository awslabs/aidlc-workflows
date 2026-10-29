// covers: subcommand:aidlc-utility:plugin-test file:core/tools/aidlc-plugin-test.ts
//
// A plugin author on a native install runs the plugin compose test with
// `aidlc plugin test` (#1226). This installs this checkout's release the way a
// person's machine has it, puts the compiled engine in place, sets up a
// project with `aidlc config`, and runs the verb from plugin folders outside
// the repository. It must exit as the shipped runner (aidlc-plugin-test.ts
// under Bun) does: a clean plugin, one whose stage collides with core, and one
// built on a base with and without --with; and it must leave the project as it
// was. In the compiled binary the runner's children (the compose hook, the
// candidate's graph compile) start from `aidlc` itself, so this is the check
// that they still run as Bun there, and that a compose drop's fix line still
// names the native command.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ROUTES, type Route, routeOptions } from "../../core/tools/aidlc.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  comparablePluginTest,
  helpOptionForms,
  type PluginTestFixtures,
  type PluginTestRun,
  runShippedPluginTest,
  writePluginTestFixtures,
} from "../harness/plugin-test-fixtures.ts";
import { writeReleaseFixture } from "../harness/release-fixture.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SHIPPED_TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");

let root = "";
let project = "";
let aidlc = "";
let env: NodeJS.ProcessEnv = {};
let plugins: PluginTestFixtures;

function native(args: string[], cwd: string): PluginTestRun {
  const r = spawnSync(aidlc, args, {
    cwd,
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function treeDigest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      hash.update(relative(dir, path).replaceAll("\\", "/"));
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

// The verb and the shipped runner, on the same plugin and project, as JSON.
function both(pluginRoot: string, extra: string[] = []) {
  const verb = native(["plugin", "test", "--install", project, "--json", ...extra], pluginRoot);
  const runner = runShippedPluginTest(SHIPPED_TOOLS, [pluginRoot, "--install", project, "--json", ...extra], pluginRoot, env);
  return { verb, runner };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-native-plugin-test-")));
  const release = join(root, "release");
  mkdirSync(release);
  const fixture = writeReleaseFixture({
    root: release,
    repoRoot: REPO_ROOT,
    version: AIDLC_VERSION,
    binary: "executable",
    distributions: ["claude"],
  });
  const machine = join(root, "machine");
  const bin = join(machine, "bin");
  // An empty folder, as the guide's CI recipe sets up its scratch install.
  project = join(root, "project");
  mkdirSync(project);
  env = testGuardEnvironment(process.env, "production");
  for (const key of Object.keys(env)) {
    if (/^(?:AIDLC|CLAUDE|KIRO|CURSOR)_PROJECT_DIR$|^AIDLC_TEST_CONFIG_TTY$/i.test(key)) delete env[key];
  }
  env = {
    ...env,
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: bin,
    // A missing gh: the fixture release has no real attestation to verify.
    AIDLC_GH_BIN: join(root, "no-gh", process.platform === "win32" ? "gh.exe" : "gh"),
    NO_COLOR: "1",
  };
  const installed = spawnSync(process.execPath, [
    join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts"), "update", "--version", AIDLC_VERSION, "--from", release,
  ], { cwd: project, encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(installed.status, installed.stdout + installed.stderr).toBe(0);

  // The fixture's binary only answers `version`; put this checkout's compiled
  // engine in its place, as t-native-install-hooks does.
  const engine = join(root, fixture.binaryName);
  const built = spawnSync(process.execPath, [
    "build", join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "aidlc.ts"), "--compile", "--outfile", engine,
  ], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  aidlc = join(machine, "versions", AIDLC_VERSION, process.platform === "win32" ? "aidlc.exe" : "aidlc");
  expect(existsSync(aidlc), `no installed binary at ${aidlc}`).toBe(true);
  copyFileSync(engine, aidlc);

  const configured = native(["config", "--project-dir", project, "--harness", "claude", "--yes"], root);
  expect(configured.status, configured.stdout + configured.stderr).toBe(0);
  // The plugin folders sit outside the repository and outside the project.
  plugins = writePluginTestFixtures(join(root, "plugins"), SHIPPED_TOOLS);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("aidlc plugin test on a native install", () => {
  test("a clean plugin composes, exits 0 and reports what the shipped runner reports", () => {
    const before = treeDigest(project);
    const human = native(["plugin", "test", "--install", project], plugins.clean);
    expect(human.status, human.stdout + human.stderr).toBe(0);
    expect(human.stdout).toContain("Plugin test: CLEAN");
    expect(human.stdout).toContain("Plugin stages present: test-pro-full-suite, test-pro-integration");
    expect(human.stdout).toContain("Idempotent second compose: true");
    const { verb, runner } = both(plugins.clean);
    expect(verb.status, verb.stderr).toBe(0);
    expect(runner.status, runner.stderr).toBe(0);
    expect(comparablePluginTest(verb.stdout)).toEqual(comparablePluginTest(runner.stdout));
    expect(treeDigest(project)).toBe(before);
  });

  test("a stage that collides with core is a compose drop: exit 1, as the shipped runner", () => {
    const before = treeDigest(project);
    const { verb, runner } = both(plugins.colliding);
    expect(verb.status, verb.stderr).toBe(1);
    expect(runner.status, runner.stderr).toBe(1);
    const json = JSON.parse(verb.stdout) as { errors: Array<{ rule: string }>; drops: Array<{ message: string }> };
    expect(json.errors.map((finding) => finding.rule)).toContain("test-compose-drop");
    expect(json.drops.some((drop) => drop.message.includes("collides"))).toBe(true);
    expect(comparablePluginTest(verb.stdout)).toEqual(comparablePluginTest(runner.stdout));
    expect(treeDigest(project)).toBe(before);
  });

  test("--with <base-root> composes the base first; without it the plugin built on it fails, as the shipped runner", () => {
    const withBase = both(plugins.alpha, ["--with", plugins.zeta]);
    expect(withBase.verb.status, withBase.verb.stderr).toBe(0);
    expect(comparablePluginTest(withBase.verb.stdout)).toEqual(comparablePluginTest(withBase.runner.stdout));
    expect((JSON.parse(withBase.verb.stdout) as { graph: { presentStages: string[] } }).graph.presentStages)
      .toEqual(["alpha-example-stage"]);
    const without = both(plugins.alpha);
    expect(without.verb.status).toBe(1);
    expect(without.runner.status).toBe(1);
    expect(comparablePluginTest(without.verb.stdout)).toEqual(comparablePluginTest(without.runner.stdout));
  });

  test("a project that leaves the plugin off and does not have it: the fix line is the native select, after installing it there", () => {
    const selected = join(root, "selected");
    mkdirSync(selected);
    const configured = native(["config", "--project-dir", selected, "--harness", "claude", "--yes"], root);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    const narrowed = native(["engine", "plugin", "select", "aidlc"], selected);
    expect(narrowed.status, narrowed.stdout + narrowed.stderr).toBe(0);
    const result = native(["plugin", "test", "--install", selected, "--json"], plugins.clean);
    expect(result.status, result.stderr).toBe(1);
    const json = JSON.parse(result.stdout) as { drops: Array<{ message: string }> };
    expect(json.drops.map((drop) => drop.message)).toEqual([
      'plugin "test-pro" composed but is not enabled by tools/data/harness.json; test-pro is not installed in this project yet: install it there first, then run `aidlc engine plugin select aidlc,test-pro` to expose its stages, scopes, and runners',
    ]);
    // Why the line says so: the select knows only the plugins installed in the project.
    const refused = native(["engine", "plugin", "select", "aidlc,test-pro"], selected);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("Unknown plugin name(s): test-pro");
  });

  test("--help names exactly the options the verb takes, in the native invocation", () => {
    const help = native(["plugin", "test", "--help"], plugins.clean);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(
      "\n  aidlc plugin test [path] --install <project-root> [--harness <name>] [--with <base-root>] [--json]\n",
    );
    const route = ROUTES.find((candidate) => candidate.id === "plugin-author") as Route;
    expect(helpOptionForms(help.stdout).sort()).toEqual(
      routeOptions(route, "test").map((option) => option.metavar ? `${option.flag} <${option.metavar}>` : option.flag).sort(),
    );
    const unknown = native(["plugin", "test", "--install", project, "--dist", "1.0.0"], plugins.clean);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option "--dist"');
    expect(unknown.stderr).toContain("Usage: aidlc plugin test [path]");
  });
});
