// Finding a command on PATH the way the person's shell does, and starting a
// Windows .cmd or .bat (npm's copilot.cmd, the native install's aidlc.cmd),
// which Windows runs only through cmd.exe. One owner for config's CLI probes
// (aidlc-config-diagnostics.ts) and opencode's plugin, which loads this file at
// every start and hook, so it imports nothing but node:fs and node:path.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, resolve } from "node:path";

export function pathEntries(value: string, platform: NodeJS.Platform): string[] {
  return value.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
}

function executableCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32" || extname(command)) return [command];
  // Windows runs only a file with an executable extension; npm puts an
  // extensionless shell script beside its copilot.cmd, so it comes last.
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

export function resolveExecutableOnPath(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const directory of pathEntries(pathValue, platform)) {
    for (const candidate of executableCandidates(command, platform)) {
      const path = resolve(directory, candidate);
      try {
        if (!statSync(path).isFile()) continue;
        if (platform !== "win32") accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Keep searching.
      }
    }
  }
  return null;
}

/** An environment variable whatever its case: Windows names PATH "Path". */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export function isCmdScript(path: string): boolean {
  return /\.(?:cmd|bat)$/i.test(path);
}

/**
 * The cmd.exe line that runs a .cmd or .bat with plain-word arguments, to
 * start with windowsVerbatimArguments and `env` added to the environment. The
 * path goes through that variable: cmd.exe expands it once and never reads
 * the value again, so a folder name with % or ! (Windows allows both in an
 * account name, and the default install sits under it) is taken as written,
 * and /v:off keeps ! literal even where the registry turns delayed expansion
 * on. A " (no Windows path holds one) or an argument cmd.exe would read again
 * gives null: such a command is not started.
 */
export function cmdScriptLaunch(
  script: string,
  args: readonly string[],
  comSpec?: string,
): { file: string; args: string[]; env: Record<string, string> } | null {
  if (script.includes('"') || args.some((arg) => !/^[A-Za-z0-9_./:=-]*$/.test(arg))) return null;
  return {
    file: comSpec ?? "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `""%AIDLC_CMD_SCRIPT%" ${args.join(" ")}"`],
    env: { AIDLC_CMD_SCRIPT: script },
  };
}

/**
 * How a bare command starts on Windows when the person's shell would find a
 * .cmd or .bat for it on PATH (the native install's aidlc.cmd): the cmd.exe
 * line, to start with windowsVerbatimArguments; "refused" when that line
 * cannot carry it. Null: it starts as named (another platform, a path, an
 * .exe, or nothing found).
 */
export function windowsScriptLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; env: Record<string, string> } | "refused" | null {
  if (platform !== "win32" || /[\\/]/.test(command)) return null;
  const found = resolveExecutableOnPath(command, envValue(env, "PATH") ?? "", platform);
  if (found === null || !isCmdScript(found)) return null;
  return cmdScriptLaunch(found, args, envValue(env, "ComSpec")) ?? "refused";
}
