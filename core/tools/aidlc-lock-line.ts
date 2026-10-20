// The line a person meets when a program keeps AI-DLC from moving its lock
// folder. Measured on Windows Server: a watcher that opens every folder it
// watches (Vite's chokidar) holds a lock folder it reached, so the folder cannot
// be renamed until that program stops; a working directory or a recursive watch
// does not. Elsewhere a watcher cannot block a rename, so there is no likely
// cause to name and the caller keeps its own words.

let PLATFORM_FOR_TESTS: NodeJS.Platform | null = null;

export function _setLockFolderHeldPlatformForTests(platform: NodeJS.Platform | null): void {
  PLATFORM_FOR_TESTS = platform;
}

// A folder of a provably dead owner, or our own, refused this long is not a
// passing virus scan or a peer reading the owner stamp: only stopping the
// program frees it, so AI-DLC stops waiting for it before its budget.
export const LOCK_FOLDER_HELD_GIVE_UP_MS = 10_000;

let GIVE_UP_MS_FOR_TESTS: number | null = null;

export function _setLockFolderHeldGiveUpMsForTests(ms: number | null): void {
  GIVE_UP_MS_FOR_TESTS = ms;
}

export function lockFolderHeldGiveUpMs(): number {
  return GIVE_UP_MS_FOR_TESTS ?? LOCK_FOLDER_HELD_GIVE_UP_MS;
}

// `goes-on`: the step went ahead without the record, and every step waits out
// the lock's budget (`waitMs`) until the program stops. `stopped`: the step did
// not run. `went-through`: this step and its record went through, then the
// folder was held, and the next step waits.
export function lockFolderHeldLine(
  outcome: "goes-on" | "stopped" | "went-through",
  waitMs: number,
  platform: NodeJS.Platform = PLATFORM_FOR_TESTS ?? process.platform,
): string | null {
  if (platform !== "win32") return null;
  const program = "A program is watching the project folder (most likely a dev server or a test watcher still running)";
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  const wait = seconds < 60 ? `about ${seconds} second${seconds === 1 ? "" : "s"}` : `about ${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? "" : "s"}`;
  if (outcome === "went-through") {
    return `${program}. This step went through, but AI-DLC cannot update its record of this work after it, and each ` +
      `step waits ${wait}. Stop that program and the work goes back to normal.`;
  }
  const held = `${program}, so AI-DLC cannot update its record of this work`;
  if (outcome === "stopped") return `${held}. Stop that program and the work goes on.`;
  return `${held} and each step waits ${wait}. Stop that program and the work goes back to normal.`;
}

// Said once a turn for this cause, whichever of its lines a step says.
export const LOCK_FOLDER_HELD_SAID_KEY = "lock folder held by a program";
