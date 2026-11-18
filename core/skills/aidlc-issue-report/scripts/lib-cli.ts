// What every script reads from its command line the same way: a flag's value, a refusal, the report folder
// collect.ts made, and the files the agent writes for one call.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// The value after `--<name>`; none when the flag is missing, last, or followed by another flag.
export function flagValue(name: string, argv: readonly string[] = process.argv.slice(2)): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v === undefined || v.startsWith("--") ? undefined : v;
}

export function refuse(reason: string, extra: object = {}, code = 2): never {
  console.log(JSON.stringify({ ok: false, reason, ...extra }));
  process.exit(code);
}

// A folder collect.ts made: it holds collect's safe.json and local/redaction-map.json. null for anything else.
export function reportFolder(given: string | undefined): string | null {
  if (!given) return null;
  const out = resolve(given);
  try {
    if (!statSync(out).isDirectory()) return null;
  } catch {
    return null;
  }
  return existsSync(join(out, "safe.json")) && existsSync(join(out, "local", "redaction-map.json")) ? out : null;
}

// The files the agent writes with its own file tool for one call (what the person typed, kept out of the command
// line). Each stays in local/ until its script has applied it, so a run stopped between writing one and running its
// script leaves it waiting, and the check refuses until it is applied (lib-check pendingAnswers). The names to hide
// everywhere have their own file, so the person's yes to that is kept with them; a version answer is named for its
// tool, so it can only be applied to that tool.
export const NAMES_FILE = "hide-names.json";
export const EVERYWHERE_FILE = "hide-everywhere.json";
export const versionFile = (tool: string) => `version-${tool}.json`;

// One such file's JSON. A leading byte-order mark, which some Windows file tools write, is dropped.
export type AgentFile = { kind: "none" } | { kind: "not-json" } | { kind: "json"; value: unknown };
export function readAgentJson(path: string): AgentFile {
  if (!existsSync(path)) return { kind: "none" };
  try {
    return { kind: "json", value: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) };
  } catch {
    return { kind: "not-json" };
  }
}
