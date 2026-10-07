// covers: tool:aidlc-init, function:withSpace, function:frameworkFilesDoctorCheck, function:instructionFileDoctorCheck
//
// A space switch (`/aidlc space switch <name>`) points the tool's include
// files at that space's memory: Claude Code's .claude/rules/aidlc.md, the
// @-lines in AI-DLC's part of Copilot's AGENTS.md, the agent files of Copilot,
// Kiro CLI, Cursor and opencode. That is the engine's own change, so a later
// `aidlc config` refresh is not a conflict: the files stay at the space the
// person chose, a file the release changed is written at that space, and a
// real edit is still the person's to resolve.

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
import { repointedIncludeText } from "../../core/tools/aidlc-includes.ts";
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
} as const;
const TEAM = "aidlc/spaces/teamb/memory";

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

// The files that point at a space, by what they point at.
function pointing(project: string, at: string): string[] {
  return walkFiles(project)
    .map((rel) => rel.replaceAll("\\", "/"))
    .filter((rel) => !rel.startsWith("aidlc/") && !rel.startsWith(".git/") && !rel.includes("/tools/"))
    .filter((rel) => readFileSync(join(project, rel), "utf-8").includes(at))
    .sort();
}

// A configured project switched to the space `teamb`, as the person does it.
function switched(
  harness: keyof typeof HARNESS_DIRS,
  from: string,
): { project: string; repointed: Map<string, string> } {
  const project = temp(`aidlc-t-space-${harness}-`);
  mkdirSync(join(project, ".git"));
  const installed = config(project, from, harness, "--yes");
  expect(installed.status, installed.out).toBe(0);
  const env = { AIDLC_HARNESS_DIR: HARNESS_DIRS[harness] };
  const created = run(UTILITY, ["space", "create", "teamb", "--project-dir", project], project, env);
  expect(created.status, created.out).toBe(0);
  const moved = run(UTILITY, ["space", "switch", "teamb", "--project-dir", project], project, env);
  expect(moved.status, moved.out).toBe(0);
  const repointed = new Map(pointing(project, TEAM).map((rel) => [rel, readFileSync(join(project, rel), "utf-8")]));
  expect(repointed.size, moved.out).toBeGreaterThan(0);
  return { project, repointed };
}

function release(harness: string): string {
  return join(REPO_ROOT, "dist-release", harness);
}

describe("a space switch is not a config conflict", () => {
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
    test(`${harness}: a refresh after a space switch plans no conflict and keeps the switch`, () => {
      const { project, repointed } = switched(harness, release(harness));
      expect(conflicts(project, release(harness), harness)).toEqual([]);
      expect(frameworkFilesDoctorCheck(project, harnessDir).pass).toBe(true);
      expect(instructionFileDoctorCheck(project, harnessDir).pass).toBe(true);
      const refreshed = config(project, release(harness), harness, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      // Every line naming a space stays as the switch wrote it.
      const spaceLines = (text: string): string[] => text.split("\n").filter((line) => line.includes("aidlc/spaces/"));
      expect(pointing(project, TEAM)).toEqual([...repointed.keys()]);
      for (const [rel, text] of repointed) {
        expect(spaceLines(readFileSync(join(project, rel), "utf-8")), rel).toEqual(spaceLines(text));
      }
    });
  }

  test("claude: a real edit to the repointed include is still the person's to resolve", () => {
    const { project } = switched("claude", release("claude"));
    const rules = join(project, ".claude", "rules", "aidlc.md");
    writeFileSync(rules, `${readFileSync(rules, "utf-8")}\nmy own rule\n`);
    expect(conflicts(project, release("claude"), "claude")).toEqual([".claude/rules/aidlc.md (locally modified or unowned)"]);
    expect(frameworkFilesDoctorCheck(project, ".claude").label).toContain(".claude/rules/aidlc.md");
  });

  for (const [harness, rel, part] of [
    ["claude", ".claude/rules/aidlc.md", ".claude/rules/aidlc.md"],
    ["copilot", "AGENTS.md", ".aidlc/tools/data/root-blocks/agents"],
  ] as const) {
    test(`${harness}: a release that changed a repointed include updates it at the chosen space`, () => {
      const { project } = switched(harness, release(harness));
      const next = join(temp(`aidlc-t-space-${harness}-next-`), harness);
      cpSync(release(harness), next, { recursive: true });
      const shipped = join(next, part);
      writeFileSync(shipped, readFileSync(shipped, "utf-8").replace("\n", "\nA line the next release added.\n"));
      expect(conflicts(project, next, harness)).toEqual([]);
      const refreshed = config(project, next, harness, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      const text = readFileSync(join(project, rel), "utf-8");
      expect(text).toContain("A line the next release added.");
      // As a space switch writes it: every include line at the chosen space.
      expect(repointedIncludeText(rel, text, "teamb")).toBeNull();
      expect(text).toContain(TEAM);
    });
  }
});
