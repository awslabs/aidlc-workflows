import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION_ID } from "./aidlc-channel.ts";
import { installedExecutablePath } from "./aidlc-install-paths.ts";
import { regenerateRunnerSurfaces } from "./aidlc-runner-gen.ts";
import { compiledExecutable } from "./aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

function stampedRelease(stagedHarness: string): string | null {
  try {
    const stamp = JSON.parse(readFileSync(join(stagedHarness, "tools", "data", "aidlc-stamp.json"), "utf-8"));
    return typeof stamp.frameworkVersion === "string" && VERSION_ID.test(stamp.frameworkVersion)
      ? stamp.frameworkVersion
      : null;
  } catch {
    return null;
  }
}

export function runnerGenerator(stagedHarness: string, pinned: boolean): { release: string; commands: string[][] } | null {
  const release = stampedRelease(stagedHarness);
  if (!pinned || release === null || release === AIDLC_VERSION) return null;

  // native
  if (compiledExecutable() !== null) {
    const executable = installedExecutablePath(release);
    if (!existsSync(executable)) {
      throw new Error(
        `aidlc ${release} is not installed on this machine, and its runner skills come from its own aidlc; ` +
          `run \`aidlc versions install ${release}\`, then run this again`,
      );
    }
    return { release, commands: [[executable, "engine", "gen", "runners"], [executable, "engine", "gen", "runner-scopes"]] };
  }

  // source
  const tool = join(stagedHarness, "tools", "aidlc-runner-gen.ts");
  if (!existsSync(tool)) throw new Error(`the ${release} source has no tools/aidlc-runner-gen.ts to write its runner skills`);
  return { release, commands: [[process.execPath, tool, "write"], [process.execPath, tool, "scopes"]] };
}

export function regenerateRunnersFor(stagedRoot: string, stagedHarness: string, pinned: boolean): void {
  const generator = runnerGenerator(stagedHarness, pinned);
  if (generator === null) {
    regenerateRunnerSurfaces();
    return;
  }
  for (const [command, ...args] of generator.commands) {
    const result = spawnSync(command, args, { cwd: stagedRoot, encoding: "utf-8", env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const reason = (result.stderr || result.stdout || `exit ${result.status ?? 1}`).trim();
      throw new Error(`${generator.release}'s runner generator failed: ${reason}`);
    }
  }
}
