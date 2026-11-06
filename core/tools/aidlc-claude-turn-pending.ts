// Where a Claude Code turn waits to be settled (aidlc-claude-turn-origin.ts),
// and the one cheap look every engine entry takes first. It loads only node's
// own modules, so the engine's lean entry (aidlc.ts) loads nothing more when
// nothing waits.
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The pending folder, under the project's sessions folder (sessionsDir: aidlc/.aidlc-sessions). */
export const CLAUDE_TURNS_PENDING_DIR = join("aidlc", ".aidlc-sessions", "claude-turns");

/** Whether any chat of this project has a Claude Code turn waiting to be settled. */
export function claudeTurnsPending(projectDir: string): boolean {
  try {
    return readdirSync(join(projectDir, CLAUDE_TURNS_PENDING_DIR)).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

/** The `--project-dir` an engine tool's arguments name (`--project-dir <dir>` or `--project-dir=<dir>`), if any. */
export function projectDirFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = arg === "--project-dir" ? argv[i + 1] : arg.startsWith("--project-dir=") ? arg.slice(14) : undefined;
    if (value) return value;
  }
  return undefined;
}

/**
 * Every engine entry's first step (the human-turn hook, the engine
 * dispatcher's other hooks, and the main of each engine tool that reads a
 * person's turns, with the project it resolves; t-claude-turn-origin lists
 * them): settle the project's pending Claude Code turns before anything reads
 * one. Loads the settle only when a turn waits. Never throws.
 */
export function settleClaudeTurnsFirst(projectDir: string): void {
  try {
    if (!claudeTurnsPending(projectDir)) return;
    // Typed by hand, so the engine's lean entry takes none of the settle's types with it.
    (require("./aidlc-claude-turn-origin.ts") as { settleClaudeTurns(projectDir: string): void }).settleClaudeTurns(projectDir);
  } catch {
    // The turns stay the person's, as they were recorded.
  }
}
