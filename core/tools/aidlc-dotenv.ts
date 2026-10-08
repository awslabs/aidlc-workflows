// Bun loads the `.env` files of the folder a process runs in into process.env,
// and AI-DLC's hooks and tools run in the person's project. A repository the
// person clones could therefore set any name the engine reads: a check of
// theirs switched off, records pointed at another folder, a tool run from a
// directory of the repository's choosing. The installed engine is built with
// that autoload off, so nothing in its environment came from a file. A Bun-run
// tree cannot carry a build flag, so this module runs first instead:
// `aidlc-runtime-paths.ts` imports it, every entry evaluates that module before
// its own body, and every AI-DLC or host-tool name a `.env` file in the working
// directory assigns is removed from process.env again before any read. A child
// Bun process loads the files again and runs this again on its first import.
//
// Bun never overrides a name the shell already set, and once a file names a
// variable there is no telling the two apart. So the drop is narrow: the
// engine's own namespace and the host tools' names that steer where it reads,
// writes or runs. The person's application names (an AWS profile, a database
// URL, whatever their tests need) stay as the shell had them, so a command the
// engine runs for them sees the same environment their terminal does. Two
// declarations only a host makes are kept even when the file names them: the
// unattended driver's flag (dropping it would let a driver's turns pass for a
// person's) and the dispatcher's internal tokens to its own children.
//
// ponytail: an AI-DLC name set in both the shell and the repository's .env is
// dropped too (a lost setting, never a loosened guard); the environment is the
// documented place for those names, a project .env is not.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const BUN_DOTENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm;
// Names the engine reads as its own, or that the host tools use to tell it
// where the project, the person's settings, a plugin or a git configuration is.
const GUARDED = /^(?:AIDLC_|AWS_AIDLC_|CLAUDE_|KIRO_|CODEX_|CURSOR_|COPILOT_|XDG_|GIT_CONFIG)/i;
// Declarations only the host makes: kept even when a file names them.
const HOST_ONLY = /^AIDLC_(?:UNATTENDED$|INTERNAL_)/i;

// Same test as isCompiledExecutable in aidlc-runtime-paths.ts, which imports
// this module and so cannot be imported back.
function compiledHere(): boolean {
  const executable = basename(process.execPath.replace(/\\/g, "/")).toLowerCase();
  return /\/(?:\$bunfs|%7ebun|~bun)\//i.test(import.meta.url.replace(/\\/g, "/")) || !executable.startsWith("bun");
}

/** Whether Bun loaded the folder's dotenv files into this process at all. */
export function dotenvLoaded(): boolean {
  return !compiledHere() && !process.execArgv.includes("--no-env-file");
}

/** Every name the folder's Bun dotenv files assign, in file order, duplicates included. */
export function dotenvAssignedNames(dir = process.cwd()): string[] {
  const names: string[] = [];
  for (const file of BUN_DOTENV_FILES) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(ASSIGNMENT)) names.push(match[1]);
  }
  return names;
}

/** Whether a dotenv file in the folder assigns the name, in any casing (Windows reads names case-insensitively). */
export function setByDotenvFile(name: string, dir = process.cwd()): boolean {
  const wanted = name.toUpperCase();
  return dotenvAssignedNames(dir).some((assigned) => assigned.toUpperCase() === wanted);
}

/**
 * Remove from `env` every AI-DLC or host-tool name the folder's dotenv files
 * assign, host-only declarations excepted; returns what was dropped. Nothing is
 * dropped when Bun loaded no file (`loaded` false): then everything present
 * came from the host.
 */
export function dropDotenvNames(env: NodeJS.ProcessEnv = process.env, dir = process.cwd(), loaded = dotenvLoaded()): string[] {
  if (!loaded) return [];
  const dropped: string[] = [];
  for (const name of dotenvAssignedNames(dir)) {
    if (!GUARDED.test(name) || HOST_ONLY.test(name) || !(name in env)) continue;
    delete env[name];
    dropped.push(name);
  }
  return dropped;
}

dropDotenvNames();
