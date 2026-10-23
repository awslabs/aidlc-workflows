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

// The step for a program the agent, or the agent it sent (Code Generation's
// developer), left running over the project to check the app (Vite, after a
// kill that reached only npx). Only the agent knows whether it did: no tool
// reads its conversation or picks a process, and AI-DLC stops nothing.
const STOP_YOURS = "If you, or an agent you sent, started a dev server, a file watcher or another long-running " +
  "program over the project in this conversation, and the person did not ask to keep it running, stop it and " +
  "everything it started (on Windows, stopping an npx or npm parent leaves the server running: stop the whole " +
  "process tree by its Windows process id, for example `taskkill //T //F //PID <pid>` in Git Bash, or the node " +
  "process whose command line names the server)";

// What the agent reads where an engine command stopped on the held folder
// (`personLine` is the `stopped` line): it stops its program and runs the
// command again, and the person hears the line only when neither started one.
// `again`: the step already stopped once this turn, so the line goes to the
// person. `uncounted`: no chat reached the engine to count the turn's stops,
// so the words bound the retry.
export function lockFolderHeldAgentStep(personLine: string, retry: "first" | "again" | "uncounted"): string {
  if (retry === "again") return `Show the person this line and end your turn: "${personLine}"`;
  return `A program is holding the project folder, so this step stopped. ${STOP_YOURS}, then run the same command ` +
    `again. If neither of you started one, ${retry === "uncounted" ? "or the step stops again after it was stopped, " : ""}` +
    `show the person this line and end your turn: "${personLine}"`;
}

// What the agent reads where a guard let the call go on with the folder held
// (`personLine` is the `goes-on` or `went-through` line): nothing to run again.
export function lockFolderHeldGoesOnStep(personLine: string): string {
  return "A program is holding the project folder, so AI-DLC cannot update its record of this work and each step " +
    `waits on it; this call goes ahead. ${STOP_YOURS}, then carry on. If neither of you started one, tell the ` +
    `person this line once and carry on: "${personLine}"`;
}

// Counts this turn's stops on the held folder, apart from the line said once a
// turn: a guard that went on may have said that one already.
export const LOCK_FOLDER_HELD_STEP_KEY = "lock folder held: the agent's step";

// A guard that went on gave the agent its step this turn; the next hit of the
// turn tells the person (LOCK_FOLDER_HELD_SAID_KEY then keeps it to once).
export const LOCK_FOLDER_HELD_GUARD_STEP_KEY = "lock folder held: the agent's step at a guard";
