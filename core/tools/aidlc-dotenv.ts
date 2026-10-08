// Bun loads the `.env` files of the folder a process runs in into process.env,
// and AI-DLC's hooks and tools run in the person's project. A repository the
// person clones could therefore set any name the engine reads: a check of
// theirs switched off, records pointed at another folder, a tool run from a
// directory of the repository's choosing. The installed engine is built with
// that autoload off; a Bun-run tree cannot carry a build flag, so this module
// runs first instead. `aidlc-runtime-paths.ts` imports it, and every entry
// evaluates that module before its own body, so every name a `.env` file in
// the working directory assigns is removed from process.env again before any
// read. Bun never overrides a name the shell already set, so only a name the
// shell did not set can come from the file. PATH is kept regardless: a
// repository line assigning it must not take the engine's executables away. A
// child Bun process loads the files again and runs this again on its first
// import.
//
// ponytail: a name set in both the shell and the repository's .env is dropped
// too (fail closed for a guard, a lost setting otherwise); compare the process
// value with the file's literal and keep a differing one if someone hits it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Remove every name the folder's dotenv files assign from `env`, PATH excepted; returns what was dropped. */
export function dropDotenvNames(env: NodeJS.ProcessEnv = process.env, dir = process.cwd()): string[] {
  const dropped: string[] = [];
  for (const name of dotenvAssignedNames(dir)) {
    if (name.toUpperCase() === "PATH" || !(name in env)) continue;
    delete env[name];
    dropped.push(name);
  }
  return dropped;
}

dropDotenvNames();
