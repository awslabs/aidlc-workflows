// Where a Claude Code turn waits to be settled (aidlc-claude-turn-origin.ts),
// and the one cheap look every engine entry takes first. It loads only node's
// own modules and the runtime paths, so the engine's lean entry (aidlc.ts)
// loads nothing more when nothing waits.
import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { runtimeProjectDir } from "./aidlc-runtime-paths.ts";

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

// The project an engine tool's arguments name (`--project-dir <dir>` or
// `--project-dir=<dir>`), else the one it runs in.
function argvProjectDir(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = arg === "--project-dir" ? argv[i + 1] : arg.startsWith("--project-dir=") ? arg.slice(14) : undefined;
    if (value) return isAbsolute(value) ? value : resolve(value);
  }
  return runtimeProjectDir();
}

/**
 * Every engine entry's first step (the engine dispatcher's hooks, and the main
 * of aidlc-state, aidlc-orchestrate, aidlc-log, aidlc-audit and aidlc-utility):
 * settle the project's pending Claude Code turns before anything reads one.
 * Loads the settle only when a turn waits. Never throws.
 */
export function settleClaudeTurnsFirst(argv: readonly string[] = [], projectDir = argvProjectDir(argv)): void {
  try {
    if (!claudeTurnsPending(projectDir)) return;
    (require("./aidlc-claude-turn-origin.ts") as typeof import("./aidlc-claude-turn-origin.ts")).settleClaudeTurns(projectDir);
  } catch {
    // The turns stay the person's, as they were recorded.
  }
}
