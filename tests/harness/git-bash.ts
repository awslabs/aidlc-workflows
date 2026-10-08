// Claude Code on Windows runs every hook command through Git Bash. Bun runs as
// a native Windows process, so Git Bash's /bin is not a path it can see
// (existsSync("/bin/sh") looks for C:\bin\sh): find the shells where Git for
// Windows installs them.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

const MISSING = "Git for Windows is not installed: Claude Code runs hooks through its Git Bash, so this case needs it";

function gitForWindowsRoots(): string[] {
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, "C:\\Program Files"]
    .filter((dir): dir is string => !!dir)
    .map((dir) => join(dir, "Git"));
  // git --exec-path names <root>/mingw64/libexec/git-core.
  const exec = spawnSync("git", ["--exec-path"], {
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const core = exec.status === 0 ? (exec.stdout ?? "").trim() : "";
  if (core) roots.push(resolve(core, "..", "..", ".."));
  return [...new Set(roots)];
}

function findGitForWindowsTool(name: string): string | null {
  for (const root of gitForWindowsRoots()) {
    const tool = join(root, "bin", name);
    if (existsSync(tool)) return tool;
  }
  return null;
}

function gitForWindowsTool(name: string): string {
  const tool = findGitForWindowsTool(name);
  if (tool === null) throw new Error(MISSING);
  return tool;
}

/**
 * Why a case that runs Git Bash cannot run on this machine, or null. Git for
 * Windows is a prerequisite of the full suite there, not of the native runner
 * (docs/reference/09-testing.md), so a local run without it skips these cases;
 * in GitHub Actions they always run, and fail if Git Bash is missing.
 */
export function gitBashSkipReason(): string | null {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true") return null;
  return findGitForWindowsTool("bash.exe") === null ? "Git for Windows is not installed" : null;
}

/** The bash Claude Code runs hook commands with on Windows. */
export function gitBashPath(): string {
  return gitForWindowsTool("bash.exe");
}

/** The POSIX sh a launcher script runs under: /bin/sh, or Git Bash's sh on Windows. */
export function posixShellPath(): string {
  return process.platform === "win32" ? gitForWindowsTool("sh.exe") : "/bin/sh";
}
