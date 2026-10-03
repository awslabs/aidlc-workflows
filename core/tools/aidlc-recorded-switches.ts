// How each recorded switch that takes a check away from the person was set,
// and the one line that tells them while it is off.
//
// A recorded switch counts the moment it is in a settings file, however it got
// there (resolveProjectFlag owns that, and nothing here changes it). The
// person drives: the engine never refuses or re-asks their switch. What it
// owes them is to say, in plain words, which check is off, since when, how it
// was set, and the one phrase that turns it back on. Whether a person's chat
// turn stood behind the change decides only that wording. The record lives in
// the clone's protected runtime directory, and every read or write of it
// fails open: it can only ever change a sentence.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  assertNoSymlinkInChainOrThrow,
  delegatedWorktreeIntent,
  isoTimestamp,
  latestPersonTurn,
  personSpokeSinceGate,
  readRegularFileNoFollowOrThrow,
  sessionsDir,
  writeFileAtomic,
} from "./aidlc-lib.ts";
import { aidlcInvocation } from "./aidlc-runtime-paths.ts";
import {
  type AidlcSettingsFile,
  PERSON_CHECK_SWITCH_LABELS,
  PERSON_CHECK_SWITCHES,
  type RecordableProjectBypass,
  resolveAidlcSettings,
  settingsPathForTarget,
  type SettingsTarget,
} from "./aidlc-settings.ts";

const RECORD_FILE = "recorded-switches.json";
const RECORD_MAX_BYTES = 64 * 1024;
const QUOTE_MAX_CHARS = 200;

export interface RecordedSwitch {
  name: RecordableProjectBypass;
  target: SettingsTarget;
  since: string;
  // "chat": a person's turn no decision had used was on record when it was set.
  how: "chat" | "other";
  words?: string;
  // When a directive carried the line, so it is said once per change.
  announced?: string;
}

export interface SwitchOff {
  name: RecordableProjectBypass;
  target: SettingsTarget;
  entry: RecordedSwitch | null;
  settingsPath: string;
}

// A delegated Bolt worktree has no runtime directory of its own for this: the
// switches it reads were set in the checkout it was cut from.
function recordRoot(projectDir: string): string {
  try {
    return delegatedWorktreeIntent(projectDir)?.parent ?? projectDir;
  } catch {
    return projectDir;
  }
}

function validEntry(value: unknown): value is RecordedSwitch {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string" &&
    (PERSON_CHECK_SWITCHES as readonly string[]).includes(entry.name) &&
    (entry.target === "local" || entry.target === "project" || entry.target === "global") &&
    typeof entry.since === "string" &&
    (entry.how === "chat" || entry.how === "other") &&
    (entry.words === undefined || typeof entry.words === "string") &&
    (entry.announced === undefined || typeof entry.announced === "string");
}

function readRecord(projectDir: string): RecordedSwitch[] {
  try {
    const path = join(sessionsDir(recordRoot(projectDir)), RECORD_FILE);
    if (!existsSync(path)) return [];
    const value = JSON.parse(
      readRegularFileNoFollowOrThrow(path, "recorded switches", RECORD_MAX_BYTES).toString("utf-8"),
    ) as { version?: unknown; switches?: unknown } | null;
    return value?.version === 1 && Array.isArray(value.switches) ? value.switches.filter(validEntry) : [];
  } catch {
    return [];
  }
}

function writeRecord(projectDir: string, switches: RecordedSwitch[]): void {
  try {
    const root = recordRoot(projectDir);
    const dir = sessionsDir(root);
    assertNoSymlinkInChainOrThrow(root, relative(root, dir));
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, RECORD_FILE), `${JSON.stringify({ version: 1, switches }, null, 2)}\n`);
  } catch {
    // Only the wording of a notice depends on it.
  }
}

/**
 * The switches that take a check from the person and are off because a
 * settings file says so: the environment form is the launch the person set,
 * and a variable of the same name (any value) decides instead, exactly as
 * resolveProjectFlag reads it.
 */
export function switchesOff(projectDir: string, env: NodeJS.ProcessEnv = process.env): SwitchOff[] {
  let bypasses: readonly string[];
  let layer: string | undefined;
  try {
    const resolved = resolveAidlcSettings(projectDir);
    bypasses = resolved.flags?.bypasses ?? [];
    layer = resolved.sources["flags.bypasses"];
  } catch {
    return [];
  }
  if (layer !== "machine" && layer !== "project" && layer !== "local") return [];
  const target: SettingsTarget = layer === "machine" ? "global" : layer;
  const record = readRecord(projectDir);
  return PERSON_CHECK_SWITCHES
    .filter((name) => bypasses.includes(name) && !Object.hasOwn(env, name))
    .map((name) => ({
      name,
      target,
      entry: record.find((entry) => entry.name === name && entry.target === target) ?? null,
      settingsPath: settingsPathForTarget(projectDir, target),
    }));
}

function fileTime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return isoTimestamp();
  }
}

function clock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an earlier session";
  const pad = (value: number): string => String(value).padStart(2, "0");
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

function quoted(words: string): string {
  const flat = words.replace(/\s+/g, " ").trim().replaceAll('"', "'");
  return flat.length > QUOTE_MAX_CHARS ? `${flat.slice(0, QUOTE_MAX_CHARS).trimEnd()}...` : flat;
}

function where(target: SettingsTarget): string {
  return target === "global" ? "on this machine" : "for this project";
}

export function clearSwitchCommand(name: RecordableProjectBypass, target: SettingsTarget): string {
  return `${aidlcInvocation()} config flags --clear-bypass ${name} --${target} --yes`;
}

/** The one line the person hears while a switch is off. */
export function switchOffLine(off: SwitchOff, now: Date = new Date()): string {
  const label = PERSON_CHECK_SWITCH_LABELS[off.name] ?? off.name;
  const since = clock(off.entry?.since ?? fileTime(off.settingsPath), now);
  const how = off.entry?.how !== "chat"
    ? "set from a terminal or a file, not from your chat"
    : off.entry.words
    ? `because you said: "${quoted(off.entry.words)}"`
    : "set after your last message in the chat";
  return `The ${label} is off ${where(off.target)} since ${since}, ${how}. ` +
    `Say "turn it back on" to restore it (${clearSwitchCommand(off.name, off.target)}).`;
}

/** Every switch still off, worded: for session start, --show, and doctor. */
export function switchesOffLines(projectDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return switchesOff(projectDir, env).map((off) => switchOffLine(off));
}

/**
 * The lines the engine's next directive carries: each switch that went off,
 * or was first found off, since a directive last said so.
 */
export function switchOffNotices(projectDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return switchesOff(projectDir, env)
    .filter((item) => item.entry?.announced === undefined)
    .map((item) => switchOffLine(item));
}

/**
 * Keep that a directive said them: the said mark, a first-seen entry for a
 * switch nobody recorded (a file edit, or one set before this release), and no
 * entry for a switch that is on again.
 */
export function markSwitchOffNoticesSaid(projectDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const record = readRecord(projectDir);
  const said = isoTimestamp();
  const kept = switchesOff(projectDir, env).map((item): RecordedSwitch => ({
    ...(item.entry ?? {
      name: item.name,
      target: item.target,
      since: fileTime(item.settingsPath),
      how: "other",
    }),
    announced: item.entry?.announced ?? said,
  }));
  if (JSON.stringify(kept) !== JSON.stringify(record)) writeRecord(projectDir, kept);
}

/**
 * Record how `config flags` changed the switches in one settings file, after
 * the write succeeded, and return what the person should read now: a line for
 * each check it turned off, and one for each it turned back on.
 */
export function recordSwitchChange(
  projectDir: string,
  target: SettingsTarget,
  previous: AidlcSettingsFile | null,
  next: AidlcSettingsFile | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const before = new Set<string>(previous?.flags?.bypasses ?? []);
  const after = new Set<string>(next?.flags?.bypasses ?? []);
  const added = PERSON_CHECK_SWITCHES.filter((name) => after.has(name) && !before.has(name));
  const removed = PERSON_CHECK_SWITCHES.filter((name) => before.has(name) && !after.has(name));
  if (added.length === 0 && removed.length === 0) return [];
  let turn: ReturnType<typeof latestPersonTurn> = null;
  if (added.length > 0) {
    try {
      turn = personSpokeSinceGate(projectDir) ? latestPersonTurn(projectDir) : null;
    } catch {
      turn = null;
    }
  }
  const since = isoTimestamp();
  const changed = new Set<string>([...added, ...removed]);
  const switches = readRecord(projectDir)
    .filter((entry) => !(entry.target === target && changed.has(entry.name)));
  for (const name of added) {
    switches.push({
      name,
      target,
      since,
      how: turn ? "chat" : "other",
      ...(turn?.words ? { words: turn.words } : {}),
    });
  }
  writeRecord(projectDir, switches);
  const off = switchesOff(projectDir, env);
  const lines = off.filter((item) => added.includes(item.name)).map((item) => switchOffLine(item));
  for (const name of removed) {
    if (off.some((item) => item.name === name)) continue;
    lines.push(`The ${PERSON_CHECK_SWITCH_LABELS[name] ?? name} is on again ${where(target)}.`);
  }
  return lines;
}
