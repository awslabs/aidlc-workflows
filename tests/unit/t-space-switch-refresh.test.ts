// covers: tool:aidlc-init, function:withSpace, function:frameworkFilesDoctorCheck, function:instructionFileDoctorCheck
//
// A space switch (`/aidlc space switch <name>`) changes no tracked file: every
// include of the tool reads the engine's git-ignored copy of the active
// space's memory (aidlc-includes.ts), and the switch writes that copy. So a
// later `aidlc config` refresh after a switch plans no conflict and leaves the
// include files as installed. An install whose include files an EARLIER
// release's switch pointed at another space's memory is AI-DLC's own change:
// the refresh writes the shipped files over them with no conflict. A real edit
// is still the person's to resolve.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  frameworkFilesDoctorCheck,
  instructionFileDoctorCheck,
} from "../../core/tools/aidlc-config-diagnostics.ts";
import { walkFiles, withSpace } from "../../core/tools/aidlc-distribution.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const UTILITY = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
const HARNESS_DIRS = {
  claude: ".claude",
  copilot: ".aidlc",
  kiro: ".kiro",
  cursor: ".cursor",
  opencode: ".aidlc",
  codex: ".codex",
} as const;
const COPY = "aidlc/active-memory";
const TEAM = "aidlc/spaces/teamb/memory";
// Every copied file starts with the line naming the file to edit.
const copyHeader = (space: string, rel: string): string =>
  `<!-- AI-DLC keeps this copy in step with aidlc/spaces/${space}/memory/${rel}. Edit that file; this copy is replaced. -->\n`;

const DEFAULT = "aidlc/spaces/default/memory";

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function run(tool: string, args: string[], cwd: string, env: Record<string, string> = {}): { status: number; out: string } {
  const machine = temp("aidlc-t-space-machine-");
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env: { ...process.env, AIDLC_INSTALL_ROOT: join(machine, "share"), AIDLC_BIN_DIR: join(machine, "bin"), ...env },
    encoding: "utf-8",
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function config(project: string, from: string, harness: string, ...extra: string[]): { status: number; out: string } {
  return run(INIT, ["config", "--project-dir", project, "--from", from, "--harness", harness, "--mcp", "none", ...extra], project);
}

function conflicts(project: string, from: string, harness: string): string[] {
  const planned = config(project, from, harness, "--dry-run", "--json");
  const parsed = JSON.parse(planned.status === 0 || planned.status === 4 ? planned.out.slice(planned.out.indexOf("{")) : "{}") as {
    data?: { actions?: Array<{ path: string; action: string; detail?: string }> };
  };
  expect(parsed.data?.actions, planned.out.slice(0, 2000)).toBeDefined();
  return (parsed.data?.actions ?? []).filter((item) => item.action === "conflict").map((item) => `${item.path} (${item.detail})`);
}

// The tool's files that carry `at`, by workspace-relative path (the shipped
// tools and the memory itself left out).
function pointing(project: string, at: string): string[] {
  return walkFiles(project)
    .map((rel) => rel.replaceAll("\\", "/"))
    .filter((rel) => !rel.startsWith("aidlc/") && !rel.startsWith(".git/") && !rel.includes("/tools/") && !rel.endsWith(".ts"))
    .filter((rel) => readFileSync(join(project, rel), "utf-8").includes(at))
    .sort();
}

function release(harness: string): string {
  return join(REPO_ROOT, "dist-release", harness);
}

function installed(harness: keyof typeof HARNESS_DIRS, from: string): string {
  const project = temp(`aidlc-t-space-${harness}-`);
  mkdirSync(join(project, ".git"));
  const result = config(project, from, harness, "--yes");
  expect(result.status, result.out).toBe(0);
  return project;
}

// A configured project switched to the space `teamb`, as the person does it.
function switched(harness: keyof typeof HARNESS_DIRS, from: string): { project: string; includes: Map<string, string> } {
  const project = installed(harness, from);
  const includes = new Map(pointing(project, COPY).map((rel) => [rel, readFileSync(join(project, rel), "utf-8")]));
  const env = { AIDLC_HARNESS_DIR: HARNESS_DIRS[harness] };
  const created = run(UTILITY, ["space", "create", "teamb", "--project-dir", project], project, env);
  expect(created.status, created.out).toBe(0);
  writeFileSync(join(project, TEAM, "team.md"), "# Team\n\nEvery queue has a dead-letter alarm.\n");
  const moved = run(UTILITY, ["space", "switch", "teamb", "--project-dir", project], project, env);
  expect(moved.status, moved.out).toBe(0);
  return { project, includes };
}

// The release as the one before the copy shipped it: include files naming the
// default space's memory itself, and Codex's config.toml with the seam.
function earlierRelease(harness: string): string {
  const prior = join(temp(`aidlc-t-space-${harness}-prior-`), harness);
  cpSync(release(harness), prior, { recursive: true });
  for (const rel of walkFiles(prior).map((file) => file.replaceAll("\\", "/"))) {
    if (rel.endsWith(".ts") || rel.startsWith("aidlc/")) continue;
    const path = join(prior, rel);
    const text = readFileSync(path, "utf-8");
    if (!text.includes(`${COPY}/`)) continue;
    writeFileSync(path, text.replaceAll(`${COPY}/`, `${DEFAULT}/`));
  }
  if (harness === "codex") {
    const path = join(prior, ".codex", "config.toml");
    writeFileSync(path, readFileSync(path, "utf-8").replace(
      "[sandbox_workspace_write]",
      `[shell_environment_policy]\nset = { AIDLC_RULES_DIR = "${DEFAULT}" }\n\n[sandbox_workspace_write]`,
    ));
  }
  return prior;
}

describe("a space switch changes no tracked file, and a refresh after it is no conflict", () => {
  test("withSpace sets the active-space memory paths and leaves placeholders alone", () => {
    const text = [
      "@aidlc/spaces/teamb/memory/org.md",
      "@../aidlc/spaces/default/memory/team.md",
      '"file://aidlc/spaces/teamb/memory/**/*.md"',
      'AIDLC_RULES_DIR = "aidlc/spaces/teamb/memory"',
      `aidlc/spaces/<space>/memory/ and aidlc/spaces/\${space}/memory/`,
    ].join("\n");
    expect(withSpace(text, "default")).toBe([
      "@aidlc/spaces/default/memory/org.md",
      "@../aidlc/spaces/default/memory/team.md",
      '"file://aidlc/spaces/default/memory/**/*.md"',
      'AIDLC_RULES_DIR = "aidlc/spaces/default/memory"',
      `aidlc/spaces/<space>/memory/ and aidlc/spaces/\${space}/memory/`,
    ].join("\n"));
  });

  for (const [harness, harnessDir] of Object.entries(HARNESS_DIRS) as Array<[keyof typeof HARNESS_DIRS, string]>) {
    test(`${harness}: the switch writes the copy and no include; a refresh plans no conflict and changes nothing`, () => {
      const { project, includes } = switched(harness, release(harness));
      // Codex has no include; every other harness reads the copy from at least one file.
      if (harness !== "codex") expect(includes.size, harness).toBeGreaterThan(0);
      expect(pointing(project, TEAM)).toEqual([]);
      for (const [rel, text] of includes) expect(readFileSync(join(project, rel), "utf-8"), rel).toBe(text);
      expect(readFileSync(join(project, COPY, "team.md"), "utf-8")).toContain("dead-letter alarm");
      expect(readFileSync(join(project, COPY, "org.md"), "utf-8"))
        .toBe(`${copyHeader("teamb", "org.md")}${readFileSync(join(project, TEAM, "org.md"), "utf-8")}`);

      expect(conflicts(project, release(harness), harness)).toEqual([]);
      expect(frameworkFilesDoctorCheck(project, harnessDir).pass).toBe(true);
      expect(instructionFileDoctorCheck(project, harnessDir).pass).toBe(true);
      const refreshed = config(project, release(harness), harness, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      for (const [rel, text] of includes) expect(readFileSync(join(project, rel), "utf-8"), rel).toBe(text);
      expect(readFileSync(join(project, COPY, "team.md"), "utf-8")).toContain("dead-letter alarm");
    });

    test(`${harness}: include files an earlier release's switch pointed at another space are brought to the shipped files, no conflict`, () => {
      const prior = earlierRelease(harness);
      const project = installed(harness, prior);
      const before = pointing(project, DEFAULT);
      if (harness !== "codex") expect(before, harness).not.toEqual([]);
      // As that release's switch wrote them: every include at the other space.
      for (const rel of before) {
        const path = join(project, rel);
        writeFileSync(path, readFileSync(path, "utf-8").replaceAll(`${DEFAULT}`, TEAM));
      }
      expect(pointing(project, TEAM)).toEqual(before);
      if (harness === "codex") {
        expect(readFileSync(join(project, ".codex", "config.toml"), "utf-8")).toContain(`AIDLC_RULES_DIR = "${TEAM}"`);
      }

      expect(conflicts(project, release(harness), harness)).toEqual([]);
      const refreshed = config(project, release(harness), harness, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      // No file names the other space any more: the includes read the copy,
      // and Codex's config.toml has no pointer at all.
      expect(pointing(project, TEAM)).toEqual([]);
      if (harness === "codex") {
        expect(readFileSync(join(project, ".codex", "config.toml"), "utf-8")).not.toContain("AIDLC_RULES_DIR");
      } else {
        expect(pointing(project, COPY).length).toBeGreaterThan(0);
      }
    });
  }

  test("claude: a real edit to the include is still the person's to resolve", () => {
    const { project } = switched("claude", release("claude"));
    const rules = join(project, ".claude", "rules", "aidlc.md");
    writeFileSync(rules, `${readFileSync(rules, "utf-8")}\nmy own rule\n`);
    expect(conflicts(project, release("claude"), "claude")).toEqual([".claude/rules/aidlc.md (locally modified or unowned)"]);
    expect(frameworkFilesDoctorCheck(project, ".claude").label).toContain(".claude/rules/aidlc.md");
  });

  // The title line of AI-DLC's part is the person's to replace (#2058); a
  // space switch after that is still no conflict, and both stay.
  test("copilot: a replaced title and a space switch together are no conflict", () => {
    const project = installed("copilot", release("copilot"));
    const agents = join(project, "AGENTS.md");
    const text = readFileSync(agents, "utf-8");
    expect(text.split("\n")).toContain("# AI-DLC");
    writeFileSync(agents, text.split("\n").map((line) => line === "# AI-DLC" ? "# Demo Project" : line).join("\n"));
    const env = { AIDLC_HARNESS_DIR: ".aidlc" };
    expect(run(UTILITY, ["space", "create", "teamb", "--project-dir", project], project, env).status).toBe(0);
    expect(run(UTILITY, ["space", "switch", "teamb", "--project-dir", project], project, env).status).toBe(0);
    expect(conflicts(project, release("copilot"), "copilot")).toEqual([]);
    expect(instructionFileDoctorCheck(project, ".aidlc").pass).toBe(true);
    const refreshed = config(project, release("copilot"), "copilot", "--yes");
    expect(refreshed.status, refreshed.out).toBe(0);
    const after = readFileSync(agents, "utf-8");
    expect(after.split("\n")).toContain("# Demo Project");
    expect(after).toContain(`@${COPY}/org.md`);
    expect(after).not.toContain("@aidlc/spaces/");
    expect(instructionFileDoctorCheck(project, ".aidlc").pass).toBe(true);
  });
});
