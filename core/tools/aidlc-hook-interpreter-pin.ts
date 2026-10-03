// PROTOTYPE — for maintainer review only, not a finished fix.
//
// Problem (issue #1575): on a GUI-launched Windows Claude Code, no AI-DLC hook
// fires at all. Every hook `command` in settings.json invokes an interpreter by
// NAME — `bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" ...` (copy channel)
// or the native `aidlc` launcher — and a GUI launch inherits the login/machine
// PATH, which commonly excludes the per-user launcher dir (`%LOCALAPPDATA%\
// aidlc\bin`, `~/.bun/bin`). The hook subprocess then never spawns, silently;
// the engine CLI keeps working because it is invoked by a resolved absolute
// path. (`$CLAUDE_PROJECT_DIR` itself expands fine — only the interpreter name
// is unresolved.)
//
// Idea: at `aidlc config` time, resolve the hook interpreter to its ABSOLUTE
// install path and pin that into each hook `command`, so dispatch no longer
// depends on the host's inherited PATH.
//
// This module is deliberately pure and standalone so a reviewer can judge the
// approach in isolation. It is wired into the settings materialization behind
// the AIDLC_PIN_HOOK_PATHS=1 env gate (off by default). The open design
// questions (chiefly: how the pinned, machine-local paths interact with the
// baseline drift-hash of the `hooks` key, and portability of a pinned path
// across machines sharing a committed settings.json) are laid out in the PR
// description.

import { existsSync } from "node:fs";
import { commandPath } from "./aidlc-install-paths.ts";

/** The leading interpreter token kinds a hook command can start with. */
type Interpreter = "bun" | "aidlc";

/**
 * Resolve the absolute path of the interpreter a hook command should spawn.
 *
 * - `aidlc` (native install): the compiled launcher at `commandPath()`
 *   (`<binRoot>/aidlc.cmd` on Windows, `<binRoot>/aidlc` elsewhere).
 * - `bun` (copy-channel projection): resolved from the provided PATH value, so
 *   the caller controls which PATH is consulted (the login-independent one, not
 *   the interactive shell's).
 *
 * Returns null when the interpreter cannot be resolved, so the caller can leave
 * the bare-name command untouched rather than pin a path that does not exist.
 */
export function absoluteHookInterpreter(
  interpreter: Interpreter,
  options: {
    pathValue?: string;
    which?: (command: string, pathValue: string) => string | null;
    exists?: (path: string) => boolean;
  } = {},
): string | null {
  const fileExists = options.exists ?? existsSync;
  if (interpreter === "aidlc") {
    const launcher = commandPath();
    return fileExists(launcher) ? launcher : null;
  }
  // bun: resolve from PATH (the caller supplies which + the PATH to search).
  if (!options.which || options.pathValue === undefined) return null;
  return options.which("bun", options.pathValue);
}

/**
 * Rewrite the leading interpreter token of one hook `command` string to an
 * absolute path. Only the first token is touched; the rest of the command
 * (the quoted `$CLAUDE_PROJECT_DIR/...` script path and the engine args) is
 * preserved byte-for-byte. A command that does not begin with a known bare
 * interpreter token is returned unchanged, so the rewrite is a no-op on an
 * already-absolute or unrecognized command (idempotent).
 */
export function pinHookCommand(
  command: string,
  resolve: (interpreter: Interpreter) => string | null,
): string {
  const match = /^(\s*)(bun|aidlc)(\s|$)/.exec(command);
  if (!match) return command;
  const interpreter = match[2] as Interpreter;
  const absolute = resolve(interpreter);
  if (!absolute) return command;
  // Quote the absolute path if it contains spaces (common on Windows:
  // C:\Users\Some Name\...). A plain path is left bare.
  const quoted = /\s/.test(absolute) ? `"${absolute}"` : absolute;
  return command.replace(/^(\s*)(bun|aidlc)/, `$1${quoted}`);
}

/**
 * Walk a parsed settings object's `hooks` tree and pin every hook command's
 * interpreter to an absolute path. Mutates and returns the same object (the
 * materializer already holds a parsed, staged copy). Shape per Claude Code:
 * hooks -> <Event> -> [{ matcher, hooks: [{ type:"command", command }] }].
 */
export function pinSettingsHookInterpreters(
  settings: Record<string, unknown>,
  resolve: (interpreter: Interpreter) => string | null,
): Record<string, unknown> {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return settings;
  for (const matchers of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const inner = (matcher as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        const entry = hook as { type?: unknown; command?: unknown };
        if (entry?.type === "command" && typeof entry.command === "string") {
          entry.command = pinHookCommand(entry.command, resolve);
        }
      }
    }
  }
  return settings;
}

/** Whether the prototype is enabled (off unless AIDLC_PIN_HOOK_PATHS=1). */
export function hookPathPinningEnabled(): boolean {
  return process.env.AIDLC_PIN_HOOK_PATHS === "1";
}
