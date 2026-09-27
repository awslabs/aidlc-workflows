import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

// No SDK imports or test registration: usable by deterministic unit controls.
export function targetsStateFile(
  entry: { input: Readonly<Record<string, unknown>> },
  projectDir: string,
  activeStateFile: string,
): boolean {
  // Mutation authority follows file_path, never prose in content/old_string/
  // new_string. Keep refusing named state files even when the tool errored or
  // the destination no longer exists by the time the live drive ends.
  if (typeof entry.input.file_path !== "string") return false;
  const destination = resolve(projectDir, entry.input.file_path);
  const leaf = basename(destination);
  if ((process.platform === "win32" ? leaf.toLowerCase() : leaf) === "aidlc-state.md") return true;
  const state = activeStateFile;
  try {
    if (realpathSync(destination) === realpathSync(state)) return true;
    // A renamed hard link has a different realpath but still mutates the same
    // file. BigInt identities avoid rounding large filesystem inode numbers.
    const targetIdentity = statSync(destination, { bigint: true });
    const stateIdentity = statSync(state, { bigint: true });
    return stateIdentity.ino !== 0n && targetIdentity.dev === stateIdentity.dev &&
      targetIdentity.ino === stateIdentity.ino;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
