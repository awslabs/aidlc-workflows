// covers: tool:aidlc-init, function:configCommandForHarness, function:compactHumanFileList, function:flagIssues, function:projectChoiceIssues, function:providerSurfaceIssues, function:vscodeWorkspaceRequestCapDoctorCheck
//
// A config command that setup, `config <section> --show` or a refusal prints
// runs as printed on a copy install: it names the project's own tool (no
// `aidlc` there), the harness when the project has more than one (config asks
// which otherwise), and the project folder when the person ran config from
// another folder. A plan token that no longer matches gives back the command
// that was run, with --dry-run, so the new token is for the same plan.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyChannelOmits, projectionFiles } from "../../core/tools/aidlc-distribution.ts";
import { quoteCommandArgument } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

// One copy-channel tool run: no native aidlc on this machine.
function run(tool: string, args: string[], cwd: string, input?: string): { status: number; out: string } {
  const machine = temp("aidlc-printed-config-machine-");
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      ...(input === undefined ? {} : { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: input }),
    },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A copy-channel install, as the install guide's copy channel does: the
// runtime is dist/<harness> without the files a copy leaves out, copied over
// the project, then the project's own tool runs `config --from` it.
function copyInstall(project: string, harness: string, dir: string): string {
  const runtime = join(temp("aidlc-printed-config-runtime-"), harness);
  const shipped = join(REPO_ROOT, "dist", harness);
  cpSync(shipped, runtime, { recursive: true });
  for (const path of copyChannelOmits(projectionFiles(shipped).descriptor)) rmSync(join(runtime, path), { force: true });
  cpSync(runtime, project, { recursive: true });
  const installed = run(join(project, dir, "tools", "aidlc.ts"), [
    "config", "--from", runtime, "--harness", harness, "--mcp", "none", "--yes",
  ], project);
  expect(installed.status, installed.out).toBe(0);
  return runtime;
}

// The project and each harness's runtime folder.
function copyProject(harnesses: ReadonlyArray<[string, string]>): { project: string; runtimes: string[] } {
  const project = temp("aidlc-printed-config-");
  mkdirSync(join(project, ".git"));
  return { project, runtimes: harnesses.map(([harness, dir]) => copyInstall(project, harness, dir)) };
}

const twoHarnessProject = () => copyProject([["claude", ".claude"], ["codex", ".codex"]]);

// The words of a printed command as a POSIX shell reads them.
function words(printed: string): string[] {
  const res = spawnSync("bash", ["-c", `for w in ${printed}; do printf '%s\\0' "$w"; done`], { encoding: "utf-8" });
  return res.stdout.split("\0").slice(0, -1);
}

describe.skipIf(process.platform === "win32")("config commands setup and --show print run as printed on a copy install", () => {
  test("with two harnesses, a section's command names the harness, and runs", () => {
    const { project } = twoHarnessProject();
    const tool = join(project, ".claude", "tools", "aidlc.ts");
    const shown = run(tool, ["config", "runtime", "--show", "--harness", "claude"], project);
    expect(shown.status, shown.out).toBe(0);
    const listAll = /\(([^()]*) lists all\)/.exec(shown.out)?.[1] ?? "";
    expect(listAll).toBe("bun .claude/tools/aidlc.ts config runtime --show --json --harness claude");
    const [bun, printedTool, ...args] = words(listAll);
    expect(bun).toBe("bun");
    const again = run(join(project, printedTool), args, project);
    expect(again.status, again.out).toBe(0);
    expect(JSON.parse(again.out).ok).toBe(true);
  });

  test("run from another folder, the command names the project", () => {
    const { project } = twoHarnessProject();
    const elsewhere = temp("aidlc-printed-config-elsewhere-");
    const tool = join(project, ".claude", "tools", "aidlc.ts");
    const shown = run(tool, ["config", "runtime", "--show", "--harness", "claude", "--project-dir", project], elsewhere);
    expect(shown.status, shown.out).toBe(0);
    const listAll = /\(([^()]*) lists all\)/.exec(shown.out)?.[1] ?? "";
    expect(listAll).toEndWith(`--harness claude --project-dir ${quoteCommandArgument(project)}`);
    const [, printedTool, ...args] = words(listAll);
    const again = run(printedTool, args, elsewhere);
    expect(again.status, again.out).toBe(0);
  });

  test("the setup walk's next steps name the harness it set up, and each runs without asking which", () => {
    // As t296 walks setup: the source tool with the release trees, and a hook
    // PATH that holds no aidlc, so the walk asks only its own question.
    const project = temp("aidlc-printed-config-walk-");
    mkdirSync(join(project, ".git"));
    const init = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
    const release = (harness: string) => join(REPO_ROOT, "dist-release", harness);
    const bin = temp("aidlc-printed-config-hook-path-");
    writeFileSync(join(bin, "getconf"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(bin)}\n`, { mode: 0o755 });
    const walkEnv = { PATH: bin, SystemRoot: "", AIDLC_RUNTIME_ROOT: join(REPO_ROOT, "dist-release") };
    const source = (args: string[], input?: string) => {
      const result = spawnSync(BUN, [init, ...args], {
        cwd: project,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...walkEnv, ...(input === undefined ? {} : { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: input }) },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    };
    const first = source(["config", "--project-dir", project, "--from", release("claude"), "--harness", "claude", "--mcp", "none", "--yes"]);
    expect(first.status, first.out).toBe(0);
    const walk = source(["config", "--project-dir", project, "--from", release("codex"), "--harness", "codex", "--mcp", "none"], "n\n");
    expect(walk.status, walk.out).toBe(0);
    const steps = [...walk.out.matchAll(/^\s+(?:models|providers)\s+(bun \S+ config \S+.*)$/gm)].map((match) => match[1].trim());
    expect(steps.length, walk.out).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step).toContain("--harness codex");
      const [, printedTool, ...args] = words(step);
      const again = run(join(project, printedTool), [...args, "--show"], project);
      expect(again.out, step).not.toContain("multiple project harnesses are present");
    }
  });
});

describe.skipIf(process.platform === "win32")("a plan token that no longer matches gives back the command that was run", () => {
  test("the next step keeps the typed options, adds --dry-run and drops the stale token", () => {
    const { project } = copyProject([["claude", ".claude"]]);
    const own = join(project, ".claude", "tools", "aidlc.ts");
    const planned = run(own, ["config", "flags", "--bypass", "AIDLC_DISABLE_SENSORS", "--local", "--dry-run", "--json"], project);
    const token = (JSON.parse(planned.out) as { data: { planToken: string } }).data.planToken;
    expect(token, planned.out).toBeString();
    const refused = run(own, ["config", "flags", "--bypass", "AIDLC_DISABLE_SENSORS", "--project", "--plan-token", token], project);
    expect(refused.out).toContain("config plan changed after approval; run bun .claude/tools/aidlc.ts config --dry-run again");
    const next = refused.out.trim().split("\n").at(-1)?.replace(/^\s*fix:\s*/, "") ?? "";
    expect(next).toStartWith("bun .claude/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_SENSORS --project");
    expect(next).toContain("--dry-run");
    expect(next).not.toContain("--plan-token");
    // Run as printed, it plans the same change and prints the token for it.
    const [, printedTool, ...args] = words(next);
    const replanned = run(join(project, printedTool), args, project);
    expect(replanned.status, replanned.out).toBe(0);
    const fresh = (JSON.parse(replanned.out) as { data: { planToken: string } }).data.planToken;
    expect(fresh).toStartWith("sha256:");
    expect(run(own, ["config", "flags", "--bypass", "AIDLC_DISABLE_SENSORS", "--project", "--plan-token", fresh], project).status).toBe(0);
  });
});

describe("the config lines the doctor and config print name the install's own command", () => {
  // Read from the shipped copy-channel tree, as t251-style pins do: a printed
  // string that starts a command with a bare `aidlc config` or `aidlc system`
  // runs on no copy install.
  test("no config-diagnostics remediation or fix hard-codes `aidlc`", () => {
    const source = readFileSync(join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-config-diagnostics.ts"), "utf-8");
    const hard = source.split("\n").filter((line) =>
      /(?:remediation|fix):/.test(line) && /[`"' ]aidlc (?:config|system) /.test(line)
    );
    expect(hard).toEqual([]);
  });

  test("no init refusal names `aidlc config` as the step", () => {
    const source = readFileSync(join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-init.ts"), "utf-8");
    expect(source.split("\n").filter((line) => /run aidlc config |\(aidlc config \$\{section\}/.test(line))).toEqual([]);
  });
});
