// covers: function:validateRootConfigArgs, function:showEverySection
// `config --show [--json]` shows every config section at once, read-only:
// agents run it first for "show my settings", so it answers with each
// section's own `--show` output instead of "unknown config option".
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { CONFIG_SECTIONS } from "../../core/tools/aidlc-command.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

type Run = { status: number; stdout: string; stderr: string };

function run(tool: string, args: string[], cwd: string, machine: string): Run {
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: join(machine, "home"),
      XDG_CONFIG_HOME: join(machine, "home", ".config"),
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_RUNTIME_ROOT: DIST_RELEASE,
    },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "config --show" }),
  });
  if (result.error || result.status === null) {
    throw new Error(`config subprocess did not exit normally: ${result.status}\n${result.stdout}${result.stderr}`, {
      cause: result.error,
    });
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function project(prefix: string): { dir: string; machine: string } {
  const dir = temp(prefix);
  mkdirSync(join(dir, ".git"));
  const machine = temp(`${prefix}machine-`);
  mkdirSync(join(machine, "home"), { recursive: true });
  return { dir, machine };
}

function installed(): { dir: string; machine: string } {
  const fixture = project("aidlc-tshowall-installed-");
  const result = run(INIT, [
    "config",
    "--project-dir",
    fixture.dir,
    "--from",
    join(DIST_RELEASE, "claude"),
    "--harness",
    "claude",
    "--mcp",
    "none",
    "--yes",
  ], fixture.dir, fixture.machine);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return fixture;
}

// Every file under the roots, with its bytes and modification time, so a
// command that writes anything (or touches a file) shows up. Bun's own
// transpile cache under the test HOME is the runtime's, not AI-DLC's.
function snapshot(...roots: string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) {
        if (name !== ".bun") walk(join(path, name));
      }
      return;
    }
    const bytes = stat.isFile() ? readFileSync(path) : Buffer.from("");
    seen.set(path, `${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(bytes).digest("hex")}`);
  };
  for (const root of roots) walk(root);
  return seen;
}

describe("t-config-show-every-section", () => {
  test("in a project with no install, every section answers and the command still succeeds, writing nothing", () => {
    const fixture = project("aidlc-tshowall-bare-");
    const before = snapshot(fixture.dir, fixture.machine);
    const human = run(DISPATCHER, ["config", "--show", "--no-color"], fixture.dir, fixture.machine);
    expect(human.status, human.stdout + human.stderr).toBe(0);
    expect(human.stdout).not.toContain("unknown config option");
    // One heading line per section, in CONFIG_SECTIONS order.
    const lines = human.stdout.split("\n");
    const headings = CONFIG_SECTIONS.map((section) => lines.indexOf(section));
    expect(headings.every((index) => index >= 0), human.stdout).toBe(true);
    expect([...headings].sort((left, right) => left - right)).toEqual(headings);
    expect(human.stdout).toContain("models settings without an installed harness");
    expect(human.stdout).toContain("config runtime requires an installed project harness");

    const json = run(DISPATCHER, ["config", "--show", "--json"], fixture.dir, fixture.machine);
    expect(json.status, json.stdout + json.stderr).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      ok: boolean;
      data: { sections: Record<string, { ok: boolean; status: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.data.sections)).toEqual([...CONFIG_SECTIONS]);
    expect(parsed.data.sections.models.ok).toBe(true);
    expect(parsed.data.sections.runtime.ok).toBe(false);
    expect(parsed.data.sections.runtime.status).toBe("usage");
    expect(snapshot(fixture.dir, fixture.machine)).toEqual(before);
  });

  test("in an installed project, each section's block is exactly that section's own --show, and nothing is written", () => {
    const fixture = installed();
    const own = Object.fromEntries(CONFIG_SECTIONS.map((section) => [
      section,
      run(DISPATCHER, ["config", section, "--show", "--json"], fixture.dir, fixture.machine).stdout,
    ]));
    const ownHuman = Object.fromEntries(CONFIG_SECTIONS.map((section) => [
      section,
      run(DISPATCHER, ["config", section, "--show", "--no-color"], fixture.dir, fixture.machine),
    ]));
    const before = snapshot(fixture.dir, fixture.machine);

    const json = run(DISPATCHER, ["config", "--show", "--json"], fixture.dir, fixture.machine);
    expect(json.status, json.stdout + json.stderr).toBe(0);
    expect(json.stdout.trim().split("\n")).toHaveLength(1);
    const sections = (JSON.parse(json.stdout) as { data: { sections: Record<string, unknown> } }).data.sections;
    for (const section of CONFIG_SECTIONS) {
      expect(sections[section], section).toEqual(JSON.parse(own[section]));
    }

    const human = run(DISPATCHER, ["config", "--show", "--no-color"], fixture.dir, fixture.machine);
    expect(human.status, human.stdout + human.stderr).toBe(0);
    for (const section of CONFIG_SECTIONS) {
      const block = `${ownHuman[section].stdout}${ownHuman[section].stderr}`.trimEnd();
      expect(human.stdout, section).toContain(`${section}\n${block}`);
    }
    expect(snapshot(fixture.dir, fixture.machine)).toEqual(before);
  });

  test("--show with a change flag is refused, as a section's --show is", () => {
    const fixture = project("aidlc-tshowall-refuse-");
    for (const extra of [["--yes"], ["--dry-run"], ["--force"], ["--pin", "2.10.0"], ["--harness", "claude"]]) {
      const result = run(DISPATCHER, ["config", "--show", ...extra, "--json"], fixture.dir, fixture.machine);
      expect(result.status, `${extra.join(" ")}: ${result.stdout}${result.stderr}`).toBe(2);
      const parsed = JSON.parse(result.stdout) as { status: string; message: string };
      expect(parsed.status).toBe("usage");
      expect(parsed.message).toContain(extra[0]);
      expect(parsed.message).toContain("--show");
    }
  });

  test("config --help names --show for one section or every section", () => {
    const fixture = project("aidlc-tshowall-help-");
    const help = run(DISPATCHER, ["config", "--help"], fixture.dir, fixture.machine);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("config --show");
    expect(help.stdout).toMatch(/--show\s+Show one section, or every section with no section named, without changing it/);
  });
});
