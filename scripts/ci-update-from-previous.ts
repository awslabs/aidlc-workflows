#!/usr/bin/env bun
// A person on the last published release types `aidlc update`, gets this
// release, and their next commands and hooks work.
//
// Installs the previous release with its own installer into throwaway
// folders, sets up a project for every harness with it, and runs `aidlc
// update` with that release's own binary to the candidate in <release-dir>.
// Then it does what the person does next: each project's existing hooks run,
// `aidlc config --yes` refreshes the project, the hooks run again, and doctor
// passes. Hooks run through the shell Claude Code uses (Git Bash on Windows,
// sh elsewhere); each must exit 0 and show in the hook phase trace that the
// installed engine ran it. On Windows the Git Bash launcher must exist once the
// first command after the update has run.
//
// Usage: bun scripts/ci-update-from-previous.ts --previous <version> --candidate <release-dir>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"] as const;
const HARNESS_DIRS: Record<(typeof HARNESSES)[number], string> = {
  claude: ".claude",
  codex: ".codex",
  copilot: ".github",
  cursor: ".cursor",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  opencode: ".opencode",
};
const HOOK_COMMAND = /^aidlc engine (?:hook|adapter) [a-z0-9-]+(?: [a-z0-9-]+)*$/;
const WINDOWS = process.platform === "win32";
const REPOSITORY = process.env.GITHUB_REPOSITORY || "awslabs/aidlc-workflows";
const STEP_TIMEOUT_MS = 10 * 60_000;

/** Every hook command a harness tree's JSON config files name. */
export function hookCommands(treeDir: string): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (HOOK_COMMAND.test(value.trim())) found.add(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:json|hook)$/.test(entry.name)) {
        try { visit(JSON.parse(readFileSync(path, "utf-8"))); } catch { /* not a JSON config */ }
      }
    }
  };
  walk(treeDir);
  return [...found].sort();
}

/** Whether the hook phase trace in `directory` shows the engine ran a hook and it ended with code 0. */
export function tracedToCompletion(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return readdirSync(directory).some((file) => {
    const phases = readFileSync(join(directory, file), "utf-8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as { phase?: string; code?: unknown }; } catch { return {}; } });
    const started = phases.some((p) => p.phase === "dispatcher-start");
    // A hook loads its code in this process, or (the human-turn hook) in a child.
    const loaded = phases.some((p) =>
      p.phase === "hook-import-end" || p.phase === "adapter-import-end" || p.phase === "hook-child-started");
    const ended = phases.filter((p) => p.phase === "hook-run-end" || p.phase === "adapter-run-end" || p.phase === "exit");
    return started && loaded && ended.length > 0 && ended.every((p) => p.code === 0);
  });
}

function gitBash(): string {
  for (const root of [process.env.ProgramW6432, process.env.ProgramFiles, "C:\\Program Files"]) {
    const bash = root ? join(root, "Git", "bin", "bash.exe") : "";
    if (bash && existsSync(bash)) return bash;
  }
  throw new Error("Git for Windows is not installed: Claude Code runs hooks through its Git Bash");
}

function main(argv: string[]): number {
  const option = (flag: string) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const previous = option("--previous")?.replace(/^v/, "");
  const candidate = option("--candidate");
  if (!previous || !candidate || !existsSync(join(candidate, "version.json"))) {
    console.error("Usage: bun scripts/ci-update-from-previous.ts --previous <version> --candidate <release-dir>");
    return 2;
  }
  const target = (JSON.parse(readFileSync(join(candidate, "version.json"), "utf-8")) as { version?: string }).version ?? "";
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "aidlc-update-from-previous-"));
  const machine = join(root, "machine");
  const bin = join(machine, "bin");
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: bin,
    // No gh: both releases take the installer's checksum-only path.
    AIDLC_GH_BIN: join(root, "no-gh", WINDOWS ? "gh.exe" : "gh"),
    COPILOT_HOME: join(root, "copilot-home"),
    NO_COLOR: "1",
    // CI runners are elevated; the Windows installer refuses that unless told.
    ...(WINDOWS ? { AIDLC_ALLOW_ADMIN_INSTALL: "1" } : {}),
    [pathKey]: [bin, process.env[pathKey] ?? ""].join(WINDOWS ? ";" : ":"),
  };
  for (const key of ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR"]) delete env[key];
  mkdirSync(env.COPILOT_HOME!, { recursive: true });
  const shell = WINDOWS ? gitBash() : "/bin/sh";
  const failures: string[] = [];
  const run = (what: string, command: string, args: string[], extra: NodeJS.ProcessEnv = {}, cwd = root, input = "") => {
    const r = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: "utf-8", input, timeout: STEP_TIMEOUT_MS });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`.trim();
    if (r.status !== 0) failures.push(`${what}: exited ${r.status}: ${output.split("\n").slice(-3).join(" | ")}`);
    return { ok: r.status === 0, output };
  };
  // A person on Windows types aidlc in PowerShell, which runs aidlc.cmd; -File
  // binds each argument literally.
  const wrapper = join(root, "aidlc.ps1");
  if (WINDOWS) writeFileSync(wrapper, "& (Join-Path $env:AIDLC_BIN_DIR 'aidlc.cmd') @args\r\nexit $LASTEXITCODE\r\n");
  const aidlc = (what: string, args: string[], cwd = root) => WINDOWS
    ? run(what, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...args], {}, cwd)
    : run(what, join(bin, "aidlc"), args, {}, cwd);

  // 1. The previous release, installed the way its README says.
  const installer = join(root, WINDOWS ? "install.ps1" : "install.sh");
  const fetched = spawnSync("curl", ["-fsSL", "-o", installer,
    `https://github.com/${REPOSITORY}/releases/download/v${previous}/${WINDOWS ? "install.ps1" : "install.sh"}`],
  { encoding: "utf-8", timeout: STEP_TIMEOUT_MS });
  if (fetched.status !== 0) {
    console.error(`Could not download the ${previous} installer: ${fetched.stderr}`);
    return 1;
  }
  const installed = WINDOWS
    ? run(`install ${previous}`, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installer, "-Version", previous])
    : run(`install ${previous}`, "sh", [installer, "--version", previous]);
  if (!installed.ok) return report(failures);
  const before = aidlc("version before the update", ["version"]);
  if (!before.output.includes(previous)) failures.push(`the installed release reports "${before.output}", not ${previous}`);

  // 2. A project for every harness, set up by the previous release.
  const projects = HARNESSES.map((harness) => {
    const project = join(root, `project-${harness}`);
    mkdirSync(project, { recursive: true });
    spawnSync("git", ["init", "--quiet", project], { encoding: "utf-8", timeout: STEP_TIMEOUT_MS });
    if (harness === "copilot") writeFileSync(join(env.COPILOT_HOME!, "config.json"), `${JSON.stringify({ trustedFolders: [project] })}\n`);
    aidlc(`aidlc config --harness ${harness} on ${previous}`, ["config", "--project-dir", project, "--harness", harness, "--mcp", "none", "--quiet"]);
    return { harness, project };
  });
  if (failures.length > 0) return report(failures);

  // 3. The person's update, run by the previous release's own binary.
  const updated = aidlc(`aidlc update from ${previous}`, ["update", "--from", candidate, "--offline"]);
  if (!updated.ok) return report(failures);
  const after = aidlc("version after the update", ["version"]);
  if (!after.output.includes(target)) failures.push(`after the update aidlc reports "${after.output}", not ${target}`);
  if (WINDOWS && !existsSync(join(bin, "aidlc"))) {
    failures.push(`${join(bin, "aidlc")} is missing after the update and its first command, so Git Bash cannot run a bare aidlc and Claude Code's hooks fail`);
  }

  // 4. What the person does next, per project.
  let traces = 0;
  const hooks = (harness: string, project: string, when: string) => {
    const commands = hookCommands(join(project, HARNESS_DIRS[harness as (typeof HARNESSES)[number]]));
    for (const command of commands) {
      const trace = join(root, "trace", String(++traces));
      const r = spawnSync(shell, ["-c", command], {
        cwd: project,
        env: { ...env, CLAUDE_PROJECT_DIR: project, AIDLC_HOOK_TRACE_DIR: trace },
        encoding: "utf-8",
        input: "{}",
        timeout: STEP_TIMEOUT_MS,
      });
      if (r.status !== 0 || !tracedToCompletion(trace)) {
        failures.push(`${harness} hook ${when}: \`${command}\` exited ${r.status}: ${`${r.stderr ?? ""}`.trim().split("\n").at(-1) ?? ""}`);
      }
    }
    return commands.length;
  };
  for (const { harness, project } of projects) {
    const count = hooks(harness, project, `before the refresh`);
    aidlc(`aidlc config --yes for ${harness}`, ["config", "--project-dir", project, "--harness", harness, "--mcp", "none", "--yes", "--quiet"]);
    hooks(harness, project, "after the refresh");
    aidlc(`aidlc doctor for ${harness}`, ["doctor", "--project-dir", project, "--quiet"]);
    console.log(`${harness}: ${count} hook command(s) ran before and after the refresh; doctor ran`);
  }
  return report(failures, `Updated from ${previous} to ${target}; every harness's hooks, refresh and doctor work.`);
}

function report(failures: string[], success = ""): number {
  if (failures.length === 0) {
    console.log(success);
    return 0;
  }
  for (const failure of failures) console.error(`FAIL ${failure}`);
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
