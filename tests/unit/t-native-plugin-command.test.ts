// covers: function:pluginScriptLaunch
//
// On a native install there is no Bun: AI-DLC starts a plugin's script with the
// aidlc binary run as Bun (#3415). This installs this checkout's release the way
// a person's machine has it, puts the compiled engine in place, sets up a
// project with `aidlc config`, composes test-pro with one command through
// `aidlc engine plugin sync` (the session-start hook's route), and runs
// `aidlc test-pro-hello`. The script must get its arguments and exit code
// through, and an `aidlc` it runs itself must reach the engine, not Bun; the
// same holds for the plugin's doctor script under `aidlc doctor`.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { writeReleaseFixture } from "../harness/release-fixture.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const COMMAND = "test-pro-hello";
const EXE = process.platform === "win32" ? "aidlc.exe" : "aidlc";

// What the script was given, and what an `aidlc version` it runs answers.
const HELLO_SCRIPT = `import { spawnSync } from "node:child_process";
const engine = spawnSync(process.env.HELLO_ENGINE ?? "aidlc", ["version"], { encoding: "utf-8" });
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  plugin: process.env.AIDLC_PLUGIN_NAME ?? null,
  beBun: process.env.BUN_BE_BUN ?? null,
  engine: (engine.stdout ?? "").trim(),
}) + "\\n");
process.exit(4);
`;

// test-pro's doctor check, reporting what its own `aidlc version` answered.
const DOCTOR_SCRIPT = `import { spawnSync } from "node:child_process";
const engine = spawnSync(process.env.HELLO_ENGINE ?? "aidlc", ["version"], { encoding: "utf-8" });
const said = (engine.stdout ?? "").trim().split("\\n")[0] ?? "";
process.stdout.write(JSON.stringify({ checks: [{ pass: true, label: "engine answered: " + said, fix: "none", severity: "advisory" }] }) + "\\n");
`;

let root = "";
let project = "";
let aidlc = "";
let engineOnPath = "";
let env: NodeJS.ProcessEnv = {};

function native(args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) {
  const run = spawnSync(aidlc, args, {
    cwd,
    encoding: "utf-8",
    env: { ...env, ...extra },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-native-plugin-command-")));
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
  project = join(root, "project");
  mkdirSync(project);
  env = testGuardEnvironment(process.env, "production");
  for (const key of Object.keys(env)) {
    if (/^(?:AIDLC|CLAUDE|KIRO|CURSOR|CODEX)_|^BUN_BE_BUN$/i.test(key)) delete env[key];
  }
  env = {
    ...env,
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: bin,
    AIDLC_GH_BIN: join(root, "no-gh", process.platform === "win32" ? "gh.exe" : "gh"),
    NO_COLOR: "1",
  };
  const installed = spawnSync(process.execPath, [
    join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts"), "update", "--version", AIDLC_VERSION, "--from", release,
  ], { cwd: project, encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(installed.status, installed.stdout + installed.stderr).toBe(0);
  const engine = join(root, fixture.binaryName);
  const built = spawnSync(process.execPath, [
    "build", join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "aidlc.ts"), "--compile", "--outfile", engine,
  ], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  aidlc = join(machine, "versions", AIDLC_VERSION, EXE);
  expect(existsSync(aidlc), `no installed binary at ${aidlc}`).toBe(true);
  copyFileSync(engine, aidlc);
  engineOnPath = existsSync(join(bin, EXE)) ? join(bin, EXE) : aidlc;

  const configured = native(["config", "--project-dir", project, "--harness", "claude", "--yes"], root);
  expect(configured.status, configured.stdout + configured.stderr).toBe(0);

  // test-pro with one command and a doctor check that runs aidlc itself.
  const source = join(root, "src", "test-pro");
  mkdirSync(join(root, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "plugins", "test-pro"), source, { recursive: true });
  rmSync(join(source, "tests"), { recursive: true, force: true });
  writeFileSync(join(source, "tools", `${COMMAND}.ts`), HELLO_SCRIPT);
  writeFileSync(join(source, "tools", "test-pro-doctor.ts"), DOCTOR_SCRIPT);
  const manifestPath = join(source, ".aidlc-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { aidlc: Record<string, unknown> };
  manifest.aidlc.commands = { [COMMAND]: { script: `tools/${COMMAND}.ts`, description: "Say hello from test-pro" } };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const pluginBuilt = join(root, "built", "test-pro");
  const build = spawnSync(process.execPath, [
    join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-plugin-build.ts"), source, "claude", pluginBuilt,
  ], { encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(build.status, build.stdout + build.stderr).toBe(0);

  const synced = native(["engine", "plugin", "sync"], project, {
    CLAUDE_PLUGIN_ROOT: pluginBuilt,
    CLAUDE_PROJECT_DIR: project,
    AIDLC_HARNESS_DIR: ".claude",
    AIDLC_HARNESS_NAME: "claude",
  });
  expect(synced.status, synced.stdout + synced.stderr).toBe(0);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a plugin's command on a native install", () => {
  test("native install: aidlc test-pro-hello runs under the binary, the script's own aidlc call reaches the engine, and its exit code comes through", () => {
    const run = native([COMMAND, "a", "b c", "--json"], project, { HELLO_ENGINE: engineOnPath });
    expect(run.status, run.stderr).toBe(4);
    const seen = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    expect(seen.argv).toEqual(["a", "b c", "--json"]);
    expect(seen.plugin).toBe("test-pro");
    expect(seen.beBun).toBeNull();
    expect(seen.engine).toBe(`aidlc ${AIDLC_VERSION} (runtime ${AIDLC_VERSION})`);
    // The next command in the same place is the engine as before.
    expect(native(["version"], project).stdout.trim()).toBe(`aidlc ${AIDLC_VERSION} (runtime ${AIDLC_VERSION})`);
  });

  test("native install: aidlc --help lists the command under its plugin", () => {
    const help = native(["--help"], project);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toMatch(new RegExp(`PLUGIN COMMANDS\n  test-pro\n {4}${COMMAND} +Say hello from test-pro\n`));
  });

  test("native install: a plugin doctor script's own aidlc call reaches the engine", () => {
    const doctor = native(["doctor", "--verbose"], project, { HELLO_ENGINE: engineOnPath });
    expect(doctor.stdout + doctor.stderr).toContain(`engine answered: aidlc ${AIDLC_VERSION} (runtime ${AIDLC_VERSION})`);
  });
});
