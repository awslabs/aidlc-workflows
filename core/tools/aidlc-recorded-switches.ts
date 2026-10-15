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
import { basename, join, relative, resolve } from "node:path";
import {
  assertNoSymlinkInChainOrThrow,
  CEREMONY_ENV,
  getField,
  GUARD_FENCE_ENV,
  readStateFile,
  resolveCeremony,
  resolveFences,
  resolveGuardPolicy,
  SWITCHABLE_GUARD_FENCES,
  delegatedWorktreeIntent,
  isoTimestamp,
  latestPersonTurn,
  memoryGuardPolicyDeclarations,
  normalizeDriveLetter,
  personSpokeSinceGate,
  readRegularFileNoFollowOrThrow,
  commandAtPersonsTerminal,
  sessionsDir,
  writeFileAtomic,
} from "./aidlc-lib.ts";
import { aidlcInvocation, quoteCommandArgument } from "./aidlc-runtime-paths.ts";
import {
  type AidlcSettingsFile,
  bypassRecordedIn,
  invalidateSettingsCache,
  normalizeProjectFlagsRecord,
  PERSON_CHECK_SWITCH_LABELS,
  PERSON_CHECK_SWITCHES,
  type ProjectFlagsRecord,
  settingPurpose,
  type RecordableProjectBypass,
  readSettingsTarget,
  resolveAidlcSettings,
  serializeAidlcSettings,
  settingsPathForTarget,
  type SettingsTarget,
  updateSettingsSection,
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
  // The project the switch belongs to, so the way back names it when the
  // command printing it ran from somewhere else.
  projectDir?: string;
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
  try {
    bypasses = resolveAidlcSettings(projectDir).flags?.bypasses ?? [];
  } catch {
    return [];
  }
  // The file a switch is turned back on in: the nearest one that records it.
  const holder = (name: string): SettingsTarget | null => bypassRecordedIn(projectDir, name)?.target ?? null;
  const record = readRecord(projectDir);
  return PERSON_CHECK_SWITCHES
    .filter((name) => bypasses.includes(name) && !Object.hasOwn(env, name))
    .flatMap((name) => {
      const target = holder(name);
      return target === null ? [] : [{
        name,
        target,
        entry: record.find((entry) => entry.name === name && entry.target === target) ?? null,
        settingsPath: settingsPathForTarget(projectDir, target),
        projectDir,
      }];
    });
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

/** The person's words as a switch line quotes them: one line, capped. */
export function quoted(words: string): string {
  const flat = words.replace(/\s+/g, " ").trim().replaceAll('"', "'");
  return flat.length > QUOTE_MAX_CHARS ? `${flat.slice(0, QUOTE_MAX_CHARS).trimEnd()}...` : flat;
}

function where(target: SettingsTarget): string {
  return target === "global" ? "on this machine" : "for this project";
}

// The way back: a clear with no layer turns the switch off in every settings
// file that records it, so the check is really back on. Printed from another
// folder it names the project, quoted for the platform's shell. Native Windows
// `aidlc` is aidlc.cmd, and cmd.exe acts on & | < > ^ in an argument with no
// space and on %NAME% even inside quotes, so for a folder holding one the line
// says to run the command from the project's folder and never prints the path.
export function clearSwitchCommand(
  name: RecordableProjectBypass,
  projectDir?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const command = `${aidlcInvocation()} config flags --clear-bypass ${name} --yes`;
  if (
    projectDir === undefined ||
    normalizeDriveLetter(resolve(projectDir)) === normalizeDriveLetter(resolve(process.cwd()))
  ) {
    return command;
  }
  if (platform !== "win32") return `${command} --project-dir ${quoteCommandArgument(projectDir, "posix")}`;
  return /[&|<>^%]/.test(projectDir)
    ? `${command}, run from the project's folder`
    : `${command} --project-dir ${quoteCommandArgument(projectDir, "powershell")}`;
}

/**
 * How the one line ends, which is what the person can do about it:
 * - `offer`: a plain question they answer in their own words, for a chat (session
 *   start, the engine's next step). The agent runs the command if they want it.
 * - `statement`: they just turned it off themselves, so the line states that the
 *   way back is there. Putting their own decision back to them as a question
 *   asks them to think again about what they decided a moment ago. The switch's
 *   own line may still offer a wider place (widerPlaceOffer), which is a new
 *   choice, not their decision put back to them.
 * - `command`: nobody is listening (`config flags --show`, a doctor fix line), so
 *   the one command that turns it back on is named instead of an offer.
 */
export type SwitchWayBack = "offer" | "statement" | "command";

/**
 * The one question a check's switch line ends with when a wider place would
 * change something: the whole project after this piece of work, this whole
 * machine after this project. None for a check with no switch of that kind,
 * where the environment decides, where a settings file already keeps it off
 * there (any file, for the project; the machine's, for the machine), or for a
 * command run at the person's own terminal, where no chat is there to answer.
 * The agent relays it as written and, on a yes, sets it there.
 */
export function widerPlaceOffer(
  projectDir: string,
  name: string | undefined,
  from: "work" | "project",
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (name === undefined || !(PERSON_CHECK_SWITCHES as readonly string[]).includes(name)) return null;
  if (Object.hasOwn(env, name) || commandAtPersonsTerminal(env)) return null;
  const recordedIn = (target: SettingsTarget): boolean => {
    try {
      return (readSettingsTarget(projectDir, target)?.flags?.bypasses ?? []).includes(name as RecordableProjectBypass);
    } catch {
      return false;
    }
  };
  if (from === "work") {
    return (["local", "project", "global"] as const).some(recordedIn)
      ? null
      : "Do you want it off for the whole project instead?";
  }
  return recordedIn("global") ? null : "Do you want it off for this whole machine instead?";
}

/**
 * What `config flags --bypass` says for a check the person asked to turn off
 * that a settings file already keeps off at that place: that it is, and the
 * one wider-place offer. Empty for anything else (the command's own line).
 */
export function alreadyOffLines(
  projectDir: string,
  target: SettingsTarget,
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return names.flatMap((name) => {
    const label = PERSON_CHECK_SWITCH_LABELS[name as RecordableProjectBypass];
    if (label === undefined) return [];
    let held = false;
    try {
      held = (readSettingsTarget(projectDir, target)?.flags?.bypasses ?? []).includes(name as RecordableProjectBypass);
    } catch {
      held = false;
    }
    if (!held) return [];
    const offer = target === "global" ? null : widerPlaceOffer(projectDir, name, "project", env);
    return [`The ${label}${settingPurpose(label)} is already off ${where(target)}.${offer ? ` ${offer}` : ""}`];
  });
}

/**
 * What still keeps a check off after the person turned it back on, and the way
 * to it, or null when nothing does: the environment this command ran in first
 * (only a launch without it changes that), then the nearest settings file that
 * records the switch. `reason` is how that file stands to what they did: it
 * `keeps` the check off when they turned it on for this piece of work, and
 * `also` records it when they cleared it in another file. The line ends with
 * the offer to clear it there, or at the person's own terminal names the
 * command that does.
 */
export function stillOffLine(
  projectDir: string,
  name: string | undefined,
  reason: "keeps" | "also",
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const subject = name === undefined ? null : backOnSubject(name);
  const by = name === undefined || subject === null ? null : keptOffBy(projectDir, name, env);
  if (name === undefined || subject === null || by === null) return null;
  const named = `${capitalized(subject.said)} ${subject.is} still off`;
  if (by === "environment") {
    return `${named}: ${name}=1 is set in the environment this command ran in. ` +
      `Start the editor or CLI without it to turn ${subject.it === "it" ? "the check" : "them"} back on.`;
  }
  const target = by[0];
  const path = settingsPathForTarget(projectDir, target);
  const file = target === "global" ? path : basename(path);
  if (reason === "also") return `${named}: ${file} also records ${subject.it}. Do you want it cleared there too?`;
  const back = commandAtPersonsTerminal(env)
    ? `To turn ${subject.it} back on: ${clearSwitchCommand(name as RecordableProjectBypass, projectDir)}`
    : "Do you want it cleared there?";
  return `${named}: ${file} keeps ${subject.it} off ${where(target)}. ${back}`;
}

/**
 * The setter's line for a check the person asked to turn back on while a
 * settings file keeps it off, or null when nothing does. On their own request
 * (`theirs`, the setter's rule) their own aidlc.settings.local.json entry is
 * cleared, since nothing else turns the check on, and the line says so. The
 * project's shared file and this machine's are not changed from this request:
 * the line names the file and that changing it changes it, as a team's lock is
 * said, or at their own terminal the command. The environment and a command's
 * on are stillOffLine's.
 */
export function backOnLine(
  projectDir: string,
  name: string | undefined,
  theirs: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const subject = name === undefined ? null : backOnSubject(name);
  const by = name === undefined || subject === null ? null : keptOffBy(projectDir, name, env);
  if (name === undefined || subject === null || by === null || by === "environment" || !theirs) {
    return stillOffLine(projectDir, name, "keeps", env);
  }
  const local = basename(settingsPathForTarget(projectDir, "local"));
  // Their own entry goes whatever else records the switch, so a line naming a
  // shared file is the whole way back. A clear that failed keeps today's line.
  if (by.includes("local") && !clearLocalSwitch(projectDir, name as RecordableProjectBypass, env)) {
    return stillOffLine(projectDir, name, "keeps", env);
  }
  if (by.every((target) => target === "local")) {
    return `${capitalized(subject.said)} ${subject.is} back on: ${local} had kept ${subject.it} off for this project, ` +
      `and that entry is cleared.`;
  }
  const alsoCleared = by.includes("local") ? ` The entry in ${local} is cleared too.` : "";
  // At the person's own terminal the line names the command instead.
  const atTerminal = commandAtPersonsTerminal(env) ? stillOffLine(projectDir, name, "keeps", env) : null;
  if (atTerminal !== null) return `${atTerminal}${alsoCleared}`;
  // Every file's switch counts, so a line naming one of two holders would send them to half the way back.
  if (by.includes("project") && by.includes("global")) {
    return `The project's shared settings in ${basename(settingsPathForTarget(projectDir, "project"))} and this machine's ` +
      `settings in ${settingsPathForTarget(projectDir, "global")} keep ${subject.said} off. Changing both changes it.` +
      alsoCleared;
  }
  return (by.includes("project")
    ? `The project's shared settings in ${basename(settingsPathForTarget(projectDir, "project"))} keep ${subject.said} ` +
      "off for everyone on this project. Changing that file changes it."
    : `This machine's settings in ${settingsPathForTarget(projectDir, "global")} keep ${subject.said} ` +
      "off for every project here. Changing that file changes it.") + alsoCleared;
}

// How a line names the setting a switch turns off: a check by its label and
// what it is for; sensors and learnings, which take no decision from the
// person and so stay out of the switch-off notices, by their own names.
function backOnSubject(name: string): { said: string; is: "is" | "are"; it: "it" | "them" } | null {
  const label = PERSON_CHECK_SWITCH_LABELS[name as RecordableProjectBypass];
  if (label !== undefined) return { said: `the ${label}${settingPurpose(label)}`, is: "is", it: "it" };
  if (name === "AIDLC_DISABLE_SENSORS") return { said: "sensors", is: "are", it: "them" };
  if (name === "AIDLC_DISABLE_LEARNINGS") return { said: "learnings", is: "are", it: "them" };
  return null;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// What keeps a switch's check off, read as resolveProjectFlag reads it: the
// environment this command ran in (a variable of the switch's name decides over
// the files, and only 1 keeps it off), else every settings file that records
// it, nearest first. Null when nothing does.
function keptOffBy(projectDir: string, name: string, env: NodeJS.ProcessEnv): "environment" | SettingsTarget[] | null {
  if (env[name] === "1") return "environment";
  if (Object.hasOwn(env, name)) return null;
  try {
    if (!(resolveAidlcSettings(projectDir).flags?.bypasses ?? []).includes(name as RecordableProjectBypass)) return null;
  } catch {
    return null;
  }
  const files = (["local", "project", "global"] as const).filter((target) => {
    try {
      return (readSettingsTarget(projectDir, target)?.flags?.bypasses ?? []).includes(name as RecordableProjectBypass);
    } catch {
      return false;
    }
  });
  return files.length > 0 ? files : null;
}

// Take one switch out of the person's aidlc.settings.local.json, keeping
// everything else the file records, the way `config flags --clear-bypass
// --local` leaves it, and keep the switch record in step. False when the file
// cannot be read or written: the caller then says the check is still off.
function clearLocalSwitch(projectDir: string, name: RecordableProjectBypass, env: NodeJS.ProcessEnv): boolean {
  const path = settingsPathForTarget(projectDir, "local");
  try {
    // Another process may have written the file since it was read.
    invalidateSettingsCache(path);
    const previous = readSettingsTarget(projectDir, "local");
    const bypasses = previous?.flags?.bypasses ?? [];
    if (previous === null || !bypasses.includes(name)) return false;
    const flags: ProjectFlagsRecord = { ...(previous.flags ?? { schemaVersion: 1 }) };
    const kept = bypasses.filter((recorded) => recorded !== name).sort();
    if (kept.length > 0) flags.bypasses = kept;
    else delete flags.bypasses;
    const next = updateSettingsSection(previous, "flags", normalizeProjectFlagsRecord(flags));
    if (next === null) return false;
    writeFileAtomic(path, serializeAidlcSettings(next));
    invalidateSettingsCache(path);
    recordSwitchChange(projectDir, "local", previous, next, { env, otherFiles: false });
    return true;
  } catch {
    invalidateSettingsCache(path);
    return false;
  }
}

/**
 * The one line the person hears while a switch is off: what the check is for,
 * what is off, where, since when, how it was set, and the way back.
 */
export function switchOffLine(off: SwitchOff, now: Date = new Date(), wayBack: SwitchWayBack = "offer"): string {
  const label = PERSON_CHECK_SWITCH_LABELS[off.name] ?? off.name;
  const since = clock(off.entry?.since ?? fileTime(off.settingsPath), now);
  // Where it came from is said only when the person's own words are on record:
  // a switch nothing ties to words of theirs may still be theirs, so the line
  // claims nothing about it and says what is off, since when, and the way back.
  const how = off.entry?.how === "chat" && off.entry.words
    ? `, because you said: "${quoted(off.entry.words)}"`
    : "";
  const back = wayBack === "statement"
    ? "You can turn it back on any time."
    : wayBack === "command"
    ? `To turn it back on: ${clearSwitchCommand(off.name, off.projectDir)}`
    : "Do you want it back on?";
  return `The ${label}${settingPurpose(label)} is off ${where(off.target)} since ${since}${how}. ${back}`;
}

/**
 * Every switch still off, worded: for session start (an offer the person answers
 * in the chat) and for `--show` and doctor, where nobody is listening, so the
 * line names the command instead.
 */
export function switchesOffLines(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  wayBack: SwitchWayBack = "offer",
): string[] {
  return switchesOff(projectDir, env).map((off) => switchOffLine(off, new Date(), wayBack));
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
 * entry for a switch that is on again, however it was turned back on, so the
 * next time it goes off is a new change that is said again.
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
 * each check it turned off, and one for each it turned back on. A caller that
 * already names the other files still recording a cleared switch passes
 * `otherFiles: false`, so the person reads that once.
 */
export function recordSwitchChange(
  projectDir: string,
  target: SettingsTarget,
  previous: AidlcSettingsFile | null,
  next: AidlcSettingsFile | null,
  { env = process.env, otherFiles = true }: { env?: NodeJS.ProcessEnv; otherFiles?: boolean } = {},
): string[] {
  const before = new Set<string>(previous?.flags?.bypasses ?? []);
  const after = new Set<string>(next?.flags?.bypasses ?? []);
  const added = PERSON_CHECK_SWITCHES.filter((name) => after.has(name) && !before.has(name));
  const removed = PERSON_CHECK_SWITCHES.filter((name) => before.has(name) && !after.has(name));
  if (added.length === 0 && removed.length === 0) return [];
  // Their words are behind a switch the agent set from their chat. A command they
  // ran themselves, at their own terminal, belongs to no chat, so the record
  // claims none and a later chat quotes no message at them.
  let turn: ReturnType<typeof latestPersonTurn> = null;
  if (added.length > 0 && !commandAtPersonsTerminal()) {
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
      // Only what the line can show is kept (one more character marks a cut).
      ...(turn?.words ? { words: turn.words.replace(/\s+/g, " ").trim().slice(0, QUOTE_MAX_CHARS + 1) } : {}),
    });
  }
  writeRecord(projectDir, switches);
  const off = switchesOff(projectDir, env);
  // They ran the command that turned these off a moment ago, so each line states
  // where that leaves them and that the way back is there, and puts nothing of
  // theirs back to them; it ends with the one wider place, when there is one.
  const lines = off.filter((item) => added.includes(item.name))
    .map((item) => {
      const line = switchOffLine(item, new Date(), "statement");
      const offer = item.target === "global" ? null : widerPlaceOffer(projectDir, item.name, "project", env);
      return offer ? `${line} ${offer}` : line;
    });
  // "On again" only when nothing else still keeps the check off.
  for (const name of removed) {
    const label = PERSON_CHECK_SWITCH_LABELS[name] ?? name;
    if (env[name] !== "1" && !otherFiles && off.some((item) => item.name === name)) continue;
    const still = stillOffLine(projectDir, name, "also", env);
    if (still !== null) {
      lines.push(still);
    } else {
      const held = heldOffByWork(projectDir, name);
      lines.push(held === null
        ? `The ${label} is on again ${where(target)}.`
        : `The ${label}${settingPurpose(label)} switch is cleared ${where(target)}, but it stays off for this ` +
          `piece of work: ${held.source}. Do you want it on for this piece of work too?`);
    }
  }
  return lines;
}

/**
 * The one line for a `--clear-bypass` of a switch no settings file records.
 * It makes the two checks a real clear makes, so it never says a check is on
 * while something else keeps it off: the environment this command ran in, or
 * the open piece of work (its scope or Guard Policy, the default under off).
 */
export function unrecordedSwitchLine(
  projectDir: string,
  name: RecordableProjectBypass,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const label = PERSON_CHECK_SWITCH_LABELS[name];
  if (label === undefined) return `${name} is not recorded for this project, so there is nothing to clear.`;
  const named = `The ${label}${settingPurpose(label)} is not recorded for this project`;
  if (env[name] === "1") {
    return `${named}, but it is off: ${name}=1 is set in the environment this command ran in. ` +
      "Start the editor or CLI without it to turn the check back on.";
  }
  const held = heldOffByWork(projectDir, name);
  if (held !== null) return `${named}, but it is off for this piece of work: ${held.source}.`;
  return `The ${label}${settingPurpose(label)} is not off for this project, so there is nothing to turn back on.`;
}

// What still keeps a check off for the open piece of work once its switch is
// cleared, in the words `config get` shows: its scope or its Guard Policy.
// Null when nothing does, or nothing can be read: it only words a line.
function heldOffByWork(projectDir: string, name: RecordableProjectBypass): { source: string; key: string } | null {
  try {
    const state = readStateFile(projectDir);
    if (!state) return null;
    const fence = SWITCHABLE_GUARD_FENCES.find((item) => GUARD_FENCE_ENV[item] === name);
    if (fence !== undefined && fence !== "plan-approval") {
      const resolved = resolveFences(resolveGuardPolicy(projectDir, state), state)[fence];
      return resolved.value === "off" ? { source: resolved.source, key: `guard.${fence}` } : null;
    }
    for (const key of ["plan_approval", "summary_confirmation"] as const) {
      if (CEREMONY_ENV[key] !== name) continue;
      const resolved = resolveCeremony(key, getField(state, "Scope"), state);
      if (resolved.value !== "off") return null;
      // Guard Policy strict in memory keeps plan approval on whatever the work says.
      if (key === "plan_approval" && memoryGuardPolicyDeclarations(projectDir).some((item) => item.value === "strict")) return null;
      return { source: resolved.source, key: key.replace("_", "-") };
    }
  } catch {
    // Unreadable work state keeps the plain line.
  }
  return null;
}
