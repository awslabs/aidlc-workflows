// covers: tool:aidlc-doctor, tool:aidlc-init, function:otherFolderLine
//
// Doctor's and config's fixes are written for the project folder ("run
// `aidlc config --force`", "move the file somewhere else", git commands). Run
// with --project-dir from another folder, the report names the project folder
// once, above the fixes. Run from the project folder, the report is as it was.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyChannelOmits, projectionFiles } from "../../core/tools/aidlc-distribution.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(path);
  return path;
}

// One copy-channel tool run: no native aidlc on this machine.
function run(tool: string, args: string[], cwd: string, input?: string): { status: number; out: string } {
  const machine = temp("aidlc-fix-folder-machine-");
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    encoding: "utf-8",
    // The dispatcher hands config the answers on stdin.
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] as const } : { input }),
    env: {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      // A project the parent names would outrank the folder the tool runs in.
      AIDLC_PROJECT_DIR: undefined,
      CLAUDE_PROJECT_DIR: undefined,
      ...(input === undefined ? {} : { AIDLC_TEST_CONFIG_TTY: "1" }),
    },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A Claude Code copy install; edited, one shipped file is changed, so doctor's
// AI-DLC files row prints its keep-or-take-shipped fix.
function copyProject(edited: boolean): { project: string; tool: string; runtime: string } {
  const project = temp("aidlc-fix-folder-project-");
  mkdirSync(join(project, ".git"));
  const runtime = join(temp("aidlc-fix-folder-runtime-"), "claude");
  const shipped = join(REPO_ROOT, "dist", "claude");
  cpSync(shipped, runtime, { recursive: true });
  for (const path of copyChannelOmits(projectionFiles(shipped).descriptor)) rmSync(join(runtime, path), { force: true });
  cpSync(runtime, project, { recursive: true });
  const tool = join(project, ".claude", "tools", "aidlc.ts");
  const installed = run(tool, ["config", "--from", runtime, "--harness", "claude", "--mcp", "none", "--yes"], project);
  expect(installed.status, installed.out).toBe(0);
  if (edited) appendFileSync(join(project, ".claude", "agents", "aidlc-architect-agent.md"), "\n# my edit\n");
  return { project, tool, runtime };
}

const line = (project: string, command: string) =>
  `Project folder for this report: ${project} (not the folder you ran ${command} from).`;

describe.skipIf(process.platform === "win32")("doctor and config run from another folder say which folder their fixes are for", () => {
  test("doctor from another folder names the project folder above its fixes, in the report and in --json", () => {
    const { project, tool } = copyProject(true);
    const elsewhere = temp("aidlc-fix-folder-elsewhere-");
    const report = run(tool, ["doctor", "--project-dir", project], elsewhere);
    expect(report.out).toContain("run `bun .claude/tools/aidlc.ts config --force`");
    const lines = report.out.split("\n");
    const said = lines.indexOf(line(project, "doctor"));
    expect(said, report.out).toBeGreaterThan(0);
    expect(said).toBeLessThan(lines.findIndex((row) => row.includes("config --force")));
    const json = JSON.parse(run(tool, ["doctor", "--project-dir", project, "--json"], elsewhere).out);
    expect(json.data.notes).toEqual([line(project, "doctor")]);
  });

  test("doctor from the project folder says nothing more, however --project-dir spells that folder", () => {
    const { project, tool } = copyProject(true);
    const link = join(temp("aidlc-fix-folder-link-"), "project");
    symlinkSync(project, link);
    for (const args of [["doctor"], ["doctor", "--project-dir", link]]) {
      const report = run(tool, args, project);
      expect(report.out).toContain("config --force");
      expect(report.out).not.toContain("Project folder for this report");
      expect(JSON.parse(run(tool, [...args, "--json"], project).out).data.notes).toBeUndefined();
    }
  });

  test("config's list of what still needs the person names the project folder only from another folder", () => {
    const { project, tool, runtime } = copyProject(false);
    const elsewhere = temp("aidlc-fix-folder-elsewhere-");
    const away = run(tool, ["config", "--project-dir", project, "--from", runtime, "--mcp", "none"], elsewhere, "n\n");
    expect(away.out).toContain("still need");
    expect(away.out).toContain(line(project, "config"));
    const home = run(tool, ["config", "--from", runtime, "--mcp", "none"], project, "n\n");
    expect(home.out).toContain("still need");
    expect(home.out).not.toContain("Project folder for this report");
  });

  test("config's section report names the project folder only from another folder", () => {
    const { project, tool } = copyProject(false);
    const elsewhere = temp("aidlc-fix-folder-elsewhere-");
    const away = run(tool, ["config", "providers", "--show", "--project-dir", project], elsewhere);
    expect(away.out.split("\n")[1]).toBe(`  ${line(project, "config")}`);
    const home = run(tool, ["config", "providers", "--show"], project);
    expect(home.out).toContain("Providers configuration for");
    expect(home.out).not.toContain("Project folder for this report");
  });
});
