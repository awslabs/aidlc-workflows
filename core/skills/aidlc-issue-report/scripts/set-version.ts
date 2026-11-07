// Record a tool version the person read off their screen, for a tool collect.ts could not find
// (safe.json environment.versionsMissing). Only a version-shaped value is accepted, so this cannot
// carry anything else into safe.json. The entry is marked `source: "person"`. The version comes in a file the agent
// writes with its own file tool, never on the command line, since it is what the person typed and no shell should read
// it; the file is removed once applied. Without that file, or with no version in it, the person named the tool but not its
// version: the tool is recorded, its version left null.
//
// Usage: set-version.ts --out <dir> --tool <kiro-ide|kiro-cli|claude|codex|copilot>
//        with <dir>/local/version-<tool>.json: { "version": "<what the person read off the screen>" }

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flagValue, readAgentJson, refuse, reportFolder, versionFile } from "./lib-cli.ts";
import { type PersonTools, recordPersonTool, TOOL_KEYS, type ToolKey } from "./lib-project.ts";
import { exactVersion } from "./lib-shape.ts";

const USAGE = "usage: set-version.ts --out <dir> --tool <key>";
const tool = flagValue("tool") as ToolKey | undefined;
if (!flagValue("out") || !tool) refuse(USAGE);
if (!TOOL_KEYS.includes(tool)) refuse("unknown-tool", { tools: TOOL_KEYS });
const out = reportFolder(flagValue("out")) ?? refuse(`${flagValue("out")} is not a report folder made by collect.ts`);
// Named for this tool, so another tool's call never takes it; it stays until it is applied or refused as no version.
const answerPath = join(out, "local", versionFile(tool));
const taken = readAgentJson(answerPath);
// One key, `version`: a string, or empty or null when the person does not know (the same as no file).
const answerOk = (a: unknown): a is { version?: string | null } =>
  a !== null && typeof a === "object" && !Array.isArray(a) && Object.entries(a).every(([k, v]) => k === "version" && (v === null || typeof v === "string"));
if (taken.kind === "not-json" || (taken.kind === "json" && !answerOk(taken.value)))
  refuse(`local/${versionFile(tool)} is not { "version": "<what the person read>" }`, { file: answerPath }, 1);
const given = taken.kind === "json" ? (taken.value as { version?: string | null }).version?.trim() || undefined : undefined;
// The same rule collect.ts uses: a release, preview or pre-release number, nothing after it.
const version = given === undefined ? null : exactVersion(given);
if (given !== undefined && !version) {
  rmSync(answerPath, { force: true });
  console.log(JSON.stringify({ ok: false, reason: "not-a-version", hint: "Only a number like 1.4.13 is accepted; leave the version unknown otherwise." }));
  process.exit(1);
}

const path = join(out, "safe.json");
const safe = JSON.parse(readFileSync(path, "utf8"));
recordPersonTool(safe, tool, version);
writeFileSync(path, JSON.stringify(safe, null, 2));
// Kept for collect.ts --from, which gives a new report the person's answers again.
const personPath = join(out, "local", "person.json");
const person: PersonTools = existsSync(personPath) ? JSON.parse(readFileSync(personPath, "utf8")) : [];
writeFileSync(personPath, JSON.stringify([...person, { tool, version }], null, 2));
rmSync(answerPath, { force: true });
console.log(JSON.stringify({ ok: true, tool, version, versionsMissing: safe.environment.versionsMissing }));
