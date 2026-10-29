// Record a tool version the person read off their screen, for a tool collect.ts could not find
// (safe.json environment.versionsMissing). Only a version-shaped value is accepted, so this cannot
// carry anything else into safe.json. The entry is marked `source: "person"`.
//
// Usage: set-version.ts --out <dir> --tool <kiro-ide|kiro-cli|claude|codex|copilot> --version <x.y[.z]>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_KEYS, type ToolKey } from "./lib-project.ts";
import { exactVersion } from "./lib-shape.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const out = arg("out");
const tool = arg("tool") as ToolKey | undefined;
const given = arg("version")?.trim();
if (!out || !tool || !given) {
  console.log(JSON.stringify({ ok: false, reason: "usage: set-version.ts --out <dir> --tool <key> --version <x.y[.z]>" }));
  process.exit(2);
}
if (!TOOL_KEYS.includes(tool)) {
  console.log(JSON.stringify({ ok: false, reason: "unknown-tool", tools: TOOL_KEYS }));
  process.exit(2);
}
// The same rule collect.ts uses: a release, preview or pre-release number, nothing after it.
const version = exactVersion(given);
if (!version) {
  console.log(JSON.stringify({ ok: false, reason: "not-a-version", hint: "Only a number like 1.4.13 is accepted; leave the version unknown otherwise." }));
  process.exit(1);
}

const path = join(out, "safe.json");
if (!existsSync(path) || !existsSync(join(out, "local", "redaction-map.json"))) {
  console.log(JSON.stringify({ ok: false, reason: `${out} is not a report folder made by collect.ts` }));
  process.exit(2);
}
const safe = JSON.parse(readFileSync(path, "utf8"));
safe.environment.tools[tool] = { version, source: "person" };
safe.environment.versionsMissing = (safe.environment.versionsMissing ?? []).filter((k: string) => k !== tool);
writeFileSync(path, JSON.stringify(safe, null, 2));
console.log(JSON.stringify({ ok: true, tool, version, versionsMissing: safe.environment.versionsMissing }));
