// covers: tool:aidlc-init, function:frameworkFilesDoctorCheck
//
// A refresh carries a plugin's additions to core stages and personas over when
// the file, with those additions taken out, is the file the record says AI-DLC
// wrote. The record therefore holds the shipped file the composed one was built
// from, as config records it before any compose: then a later compose (a
// plugin update, or a sync that puts lost additions back) leaves the next
// `config` going through, whichever writer wrote the file and in whatever
// order. A plugin's `adds.scopes` are carried like its other additions. A line
// the person changed outside the additions is still theirs to resolve. Doctor's
// AI-DLC files row leaves the composed stages, personas and the personas'
// per-harness copies to config, as config takes the additions out itself. A
// switch between Kiro CLI and Kiro IDE removes the persona copy only Kiro IDE
// ships, or writes it with the persona's fragments in it.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { frameworkFilesDoctorCheck } from "../../core/tools/aidlc-config-diagnostics.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const HARNESS_DIRS = {
  claude: ".claude",
  codex: ".codex",
  copilot: ".aidlc",
  cursor: ".cursor",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  opencode: ".aidlc",
} as const;
type Harness = keyof typeof HARNESS_DIRS;
const STAGE = "aidlc-common/stages/construction/build-and-test.md";
const PERSONA = "agents/aidlc-quality-agent.md";
const STAGE_LINE = ["Document the coverage run command.", "Document the coverage run command and its output."] as const;
const PERSONA_LINE = [
  "every test plan states which target each suite serves.",
  "every test plan states which target each suite serves, and why.",
] as const;
// Session variables a run under an agent would hand down, which would point
// the tools at another project or plugin.
const INHERITED = [
  "CLAUDECODE",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "PLUGIN_ROOT",
  "AIDLC_PROJECT_DIR",
  "AIDLC_HARNESS_DIR",
  "AIDLC_HARNESS_NAME",
  "AIDLC_PLUGIN_ROOT",
];

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

// A machine of its own: no host plugin list, settings or install of the real one.
function machine(): Record<string, string> {
  const root = temp("aidlc-t-composed-machine-");
  const env: Record<string, string> = {
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    AIDLC_INSTALL_ROOT: join(root, "share"),
    AIDLC_BIN_DIR: join(root, "bin"),
  };
  for (const path of Object.values(env)) mkdirSync(path, { recursive: true });
  return env;
}

function run(args: string[], cwd: string, env: Record<string, string>): { status: number; out: string } {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const name of INHERITED) delete base[name];
  const result = spawnSync(BUN, args, {
    cwd,
    env: { ...base, ...env },
    encoding: "utf-8",
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

type Project = { dir: string; harness: Harness; env: Record<string, string>; plugin: string };

function config(project: Project, ...extra: string[]): { status: number; out: string } {
  return run(
    [INIT, "config", "--project-dir", project.dir, "--from", join(REPO_ROOT, "dist", project.harness), "--harness", typedHarnessName(project.harness), "--mcp", "none", ...extra],
    project.dir,
    project.env,
  );
}

function conflicts(project: Project): string[] {
  const planned = config(project, "--dry-run", "--json");
  const parsed = JSON.parse(planned.status === 0 || planned.status === 4 ? planned.out.slice(planned.out.indexOf("{")) : "{}") as {
    data?: { actions?: Array<{ path: string; action: string; detail?: string }> };
  };
  expect(parsed.data?.actions, planned.out.slice(0, 2000)).toBeDefined();
  return (parsed.data?.actions ?? []).filter((item) => item.action === "conflict").map((item) => `${item.path} (${item.detail})`);
}

// test-pro as the host installs it: its own copy, which a later version replaces.
function pluginCopy(harness: Harness): string {
  const copy = join(temp(`aidlc-t-composed-plugin-${harness}-`), "test-pro");
  cpSync(join(REPO_ROOT, "dist", "plugins", "test-pro", harness), copy, { recursive: true });
  const nested = join(copy, ".kiro", "aidlc-plugins");
  return existsSync(nested) ? join(nested, readdirSync(nested)[0]) : copy;
}

function sync(project: Project): void {
  const harnessDir = HARNESS_DIRS[project.harness];
  const synced = run(
    [join(project.dir, harnessDir, "tools", "aidlc.ts"), "engine", "plugin", "sync"],
    project.dir,
    {
      ...project.env,
      AIDLC_PLUGIN_ROOT: project.plugin,
      AIDLC_HARNESS_DIR: harnessDir,
      AIDLC_HARNESS_NAME: project.harness,
      AIDLC_PROJECT_DIR: project.dir,
    },
  );
  expect(synced.status, synced.out).toBe(0);
  expect(synced.out).toContain("plugin sync complete");
}

function edit(path: string, from: string, to: string): void {
  const text = readFileSync(path, "utf-8");
  expect(text, path).toContain(from);
  writeFileSync(path, text.replace(from, to));
}

// test-pro's next patch version: one sentence of its build-and-test fragment
// and one of its quality-agent fragment say more.
function update(plugin: string): void {
  for (const dir of readdirSync(plugin).filter((name) => name.startsWith("."))) {
    const manifest = join(plugin, dir, "plugin.json");
    if (!existsSync(manifest)) continue;
    const version = (JSON.parse(readFileSync(manifest, "utf-8")) as { version: string }).version;
    edit(manifest, `"version": "${version}"`, `"version": "${version.replace(/\d+$/, (patch) => String(Number(patch) + 1))}"`);
  }
  edit(join(plugin, "contributions", "construction", "build-and-test.md"), ...STAGE_LINE);
  edit(join(plugin, "contributions", "agents", "aidlc-quality-agent.md"), ...PERSONA_LINE);
}

function composed(harness: Harness, prepare?: (plugin: string) => void): Project {
  const dir = temp(`aidlc-t-composed-${harness}-`);
  mkdirSync(join(dir, ".git"));
  const project: Project = { dir, harness, env: machine(), plugin: pluginCopy(harness) };
  prepare?.(project.plugin);
  const installed = config(project, "--yes");
  expect(installed.status, installed.out).toBe(0);
  sync(project);
  return project;
}

describe("a refresh after a later compose carries the plugin's additions over", () => {
  for (const harness of Object.keys(HARNESS_DIRS) as Harness[]) {
    test(`${harness}: config, a plugin update synced, then config: no conflict, the new additions in place`, () => {
      const project = composed(harness);
      const refreshed = config(project, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      update(project.plugin);
      sync(project);

      expect(conflicts(project)).toEqual([]);
      const again = config(project, "--yes");
      expect(again.status, again.out).toBe(0);
      const harnessDir = HARNESS_DIRS[harness];
      const stage = readFileSync(join(project.dir, harnessDir, STAGE), "utf-8");
      expect(stage).toContain(STAGE_LINE[1]);
      expect(stage).toContain("  - test-pro-api-contract-instructions\n");
      expect(readFileSync(join(project.dir, harnessDir, PERSONA), "utf-8")).toContain(PERSONA_LINE[1]);
    });
  }

  for (const harness of Object.keys(HARNESS_DIRS) as Harness[]) {
    test(`${harness}: after config with the plugin composed, doctor's AI-DLC files row passes`, () => {
      const project = composed(harness);
      const refreshed = config(project, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      expect(frameworkFilesDoctorCheck(project.dir, HARNESS_DIRS[harness])).toMatchObject({ pass: true });
    });
  }

  test("kiro-ide: config, then the switch to Kiro CLI: no conflict, the persona copy only Kiro IDE ships removed, the fragment kept", () => {
    const project = composed("kiro-ide");
    expect(config(project, "--yes").status).toBe(0);
    const twin = join(project.dir, ".kiro", "aidlc-common", "personas", "aidlc-quality-agent.md");
    expect(readFileSync(twin, "utf-8")).toContain(PERSONA_LINE[0]);
    const cli: Project = { ...project, harness: "kiro" };

    expect(conflicts(cli)).toEqual([]);
    const switched = config(cli, "--yes");
    expect(switched.status, switched.out).toBe(0);
    expect(existsSync(twin)).toBe(false);
    expect(readFileSync(join(project.dir, ".kiro", PERSONA), "utf-8")).toContain(PERSONA_LINE[0]);
  });

  test("kiro: config, then the switch to Kiro IDE: no conflict, the persona copy Kiro IDE adds holds the fragment, doctor's composed row passes", () => {
    const project = composed("kiro");
    expect(config(project, "--yes").status).toBe(0);
    const twin = join(project.dir, ".kiro", "aidlc-common", "personas", "aidlc-quality-agent.md");
    expect(existsSync(twin)).toBe(false);
    const ide: Project = { ...project, harness: "kiro-ide" };

    expect(conflicts(ide)).toEqual([]);
    const switched = config(ide, "--yes");
    expect(switched.status, switched.out).toBe(0);
    expect(readFileSync(twin, "utf-8")).toContain(PERSONA_LINE[0]);
    const doctor = run([join(project.dir, ".kiro", "tools", "aidlc.ts"), "doctor", "--verbose"], project.dir, {
      ...project.env,
      AIDLC_HARNESS_DIR: ".kiro",
      AIDLC_PROJECT_DIR: project.dir,
    });
    expect(doctor.out).toContain("Composed plugin surface: all enabled plugin stages and recorded contributions are present");
    expect(conflicts(ide)).toEqual([]);
  });

  test("kiro-ide: a persona the plugin did not compose, changed by the person, still shows in doctor's row", () => {
    const project = composed("kiro-ide");
    expect(config(project, "--yes").status).toBe(0);
    const persona = join(project.dir, ".kiro", "agents", "aidlc-developer-agent.md");
    expect(readFileSync(persona, "utf-8")).not.toContain("<!-- plugin:");
    writeFileSync(persona, `${readFileSync(persona, "utf-8")}\nOur team's note.\n`);
    const row = frameworkFilesDoctorCheck(project.dir, ".kiro");
    expect(row.pass).toBe(false);
    expect(row.label).toContain(".kiro/agents/aidlc-developer-agent.md");
    expect(row.label).not.toContain("aidlc-quality-agent");
  });

  // The copy channel's install lines, with the tool opened before the setup
  // line: its session start composes the plugin into files with no record yet.
  for (const harness of ["claude", "kiro"] as const) {
    test(`${harness}: copied files, the plugin composed, then the first config: no conflict, the composed files as compose wrote them`, () => {
      const dir = temp(`aidlc-t-composed-copy-${harness}-`);
      mkdirSync(join(dir, ".git"));
      cpSync(join(REPO_ROOT, "dist", harness), dir, { recursive: true });
      const project: Project = { dir, harness, env: machine(), plugin: pluginCopy(harness) };
      sync(project);
      const stagePath = join(dir, HARNESS_DIRS[harness], STAGE);
      const asComposed = readFileSync(stagePath, "utf-8");

      expect(conflicts(project)).toEqual([]);
      const installed = config(project, "--yes");
      expect(installed.status, installed.out).toBe(0);
      expect(readFileSync(stagePath, "utf-8")).toBe(asComposed);
    });
  }

  test("kiro: a line the person changed outside the plugin's additions keeps the conflict", () => {
    const project = composed("kiro");
    expect(config(project, "--yes").status).toBe(0);
    update(project.plugin);
    sync(project);
    edit(join(project.dir, ".kiro", STAGE), "### Step 1: Analyze Testing Requirements", "### Step 1: Analyze Testing Requirements (our team's)");
    expect(conflicts(project)).toEqual([`.kiro/${STAGE} (locally modified or unowned)`]);
  });

  test("kiro: a line the person wrote that matches one the plugin added is theirs: config keeps the conflict and the line", () => {
    const project = composed("kiro");
    expect(config(project, "--yes").status).toBe(0);
    const stagePath = join(project.dir, ".kiro", STAGE);
    edit(stagePath, "  - nfr-design\n", "  - \"nfr-design\"\n  - nfr-design\n");
    expect(conflicts(project)).toEqual([`.kiro/${STAGE} (locally modified or unowned)`]);
    config(project, "--yes");
    expect(readFileSync(stagePath, "utf-8")).toContain("  - \"nfr-design\"\n");
  });

  test("kiro: a project set up with no record, then a plugin update synced, then config: no conflict", () => {
    const project = composed("kiro");
    rmSync(join(project.dir, ".kiro", "tools", "data", "aidlc-manifest.json"));
    const forced = config(project, "--yes", "--force");
    expect(forced.status, forced.out).toBe(0);
    update(project.plugin);
    sync(project);
    expect(conflicts(project)).toEqual([]);
  });

  test("kiro: a plugin's adds.scopes is carried: config after its compose has no conflict and keeps the scope", () => {
    const project = composed("kiro", (plugin) =>
      edit(join(plugin, "contributions", "construction", "build-and-test.md"), "adds:\n", "adds:\n  scopes:\n    - test-pro-validation\n")
    );
    const stagePath = join(project.dir, ".kiro", STAGE);
    expect(readFileSync(stagePath, "utf-8")).toContain("  - test-pro-validation\n");
    expect(conflicts(project)).toEqual([]);
    const refreshed = config(project, "--yes");
    expect(refreshed.status, refreshed.out).toBe(0);
    expect(readFileSync(stagePath, "utf-8")).toContain("  - test-pro-validation\n");
  });
});
