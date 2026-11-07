// What every script reads from its command line the same way: a flag's value, a refusal, the report folder
// collect.ts made, and a file the agent wrote for one call.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
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

// A JSON file the agent wrote with its own file tool for one call (what the person typed, kept out of the command line).
// It is removed as soon as it is read, so a later call never takes it. A leading byte-order mark, which some Windows
// file tools write, is dropped.
export type AgentFile = { kind: "none" } | { kind: "not-json" } | { kind: "json"; value: unknown };
export function takeAgentJson(path: string): AgentFile {
  if (!existsSync(path)) return { kind: "none" };
  const text = readFileSync(path, "utf8");
  rmSync(path, { force: true });
  try {
    return { kind: "json", value: JSON.parse(text.replace(/^\uFEFF/, "")) };
  } catch {
    return { kind: "not-json" };
  }
}
