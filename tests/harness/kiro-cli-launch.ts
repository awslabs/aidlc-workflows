// How the live Kiro CLI tests start Kiro CLI on each engine, as the guides say.
import { spawnSync } from "node:child_process";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

/**
 * The `kiro-cli chat` flags that start Kiro CLI on its V2 engine, as the Kiro
 * CLI guide's Prerequisites say: `--v2` from Kiro CLI 2.21.4, `--agent-engine v2`
 * on a release that has it (measured on 2.19.2), and none on an older one.
 */
export function kiroCliV2Args(version: string | null = installedKiroCliVersion()): string[] {
  if (kiroCliAtLeast(version, [2, 21, 4]) !== false) return ["--v2"];
  return kiroCliAtLeast(version, [2, 19, 2]) === false ? [] : ["--agent-engine", "v2"];
}

/** Whether Kiro CLI 2.33.0 or later asks once whether to trust a new folder (null: unknown version). */
export function kiroCliAsksWorkspaceTrust(version: string | null = installedKiroCliVersion()): boolean | null {
  return kiroCliAtLeast(version, [2, 33, 0]);
}

function kiroCliAtLeast(version: string | null, floor: readonly [number, number, number]): boolean | null {
  const parts = version?.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return null;
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== floor[index]) return parts[index] > floor[index];
  }
  return true;
}

let probed: string | null | undefined;

/** `kiro-cli --version`, read once per process, with the timeout the journey's own probe uses. */
export function installedKiroCliVersion(): string | null {
  if (probed === undefined) {
    const result = spawnSync("kiro-cli", ["--version"], {
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
    probed = result.status === 0 ? result.stdout : null;
  }
  return probed;
}
