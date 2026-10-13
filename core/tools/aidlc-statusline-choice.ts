// AI-DLC's status line is the person's choice (#1407). Until this release it
// shipped in the team's committed Claude Code settings and Codex config, where
// it took the place of the status line each person had set up for themselves.
//
// Now the value ships in tools/data/harness.json and reaches a settings file
// the host reads only when someone chooses it: the first-run setup asks once,
// and `aidlc config --statusline on|off` (`/aidlc --statusline on|off` in the
// chat) switches it any time. A setup that asks nothing (--yes, a script, the
// copy channel, a teammate's clone at its first chat) adds nothing. A project
// that already had AI-DLC's status line keeps it (C1), and the one person whose
// own status line it covers hears so once.
//
//   Claude Code: the person's own file, .claude/settings.local.json (gitignored),
//   so each teammate chooses. Their answer is kept in aidlc.settings.local.json.
//   Codex CLI: Codex has no per-person project file, so the choice is the
//   project's, in the shared .codex/config.toml, and every line says so. Only
//   AI-DLC's `[tui] status_line` line is ever written there; the person's own
//   ~/.codex/config.toml is read, never written.
//
// This module owns every read and write of that choice; the setup wizard, the
// switch, the refresh, the session-start hook and the doctor call it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 as winPath } from "node:path";
import { aidlcHookTarget, isCustomClaudeStatusLine, jsonFileText, readJsonFile, withoutBom } from "./aidlc-distribution.ts";
import { harnessDataPath, writeFileAtomic } from "./aidlc-lib.ts";
import {
  invalidateSettingsCache,
  localSettingsPath,
  readSettingsTarget,
  serializeAidlcSettings,
  updateSettingsSection,
  type ProjectFlagsRecord,
} from "./aidlc-settings.ts";

/**
 * What a setup that asks no question does about the status line when the person
 * never chose: "nothing" adds nothing (AI-DLC's status line appears only when
 * someone says yes or turns it on); "when-they-have-none" adds AI-DLC's when
 * no status line of their own is in reach. Arden's call (2026-10-12): nothing.
 */
export type StatusLineUnaskedDefault = "nothing" | "when-they-have-none";
export const STATUSLINE_UNASKED_DEFAULT: StatusLineUnaskedDefault = "nothing";

/** The person's recorded answer for this clone: chosen on or off, or "kept"
 *  (a project that already had AI-DLC's status line kept it, and the one line
 *  about it was said). Any value means nothing asks or adds again. */
export type StatusLineChoice = "on" | "off" | "kept";
export const STATUS_LINE_CHOICES: readonly StatusLineChoice[] = ["on", "off", "kept"];

export type StatusLineHarness = "claude" | "codex";

/** The two hosts with a status line AI-DLC can show its progress in. */
export function statusLineHarness(distribution: string): StatusLineHarness | null {
  return distribution === "claude" || distribution === "codex" ? distribution : null;
}

/** The chat word for AI-DLC on each host, as its skill is typed there. */
export function statusLineEntry(harness: StatusLineHarness): string {
  return harness === "codex" ? "$aidlc" : "/aidlc";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The record of the choice: aidlc.settings.local.json, flags.statusline
// ---------------------------------------------------------------------------

export function readStatusLineChoice(projectDir: string): StatusLineChoice | null {
  try {
    invalidateSettingsCache(localSettingsPath(projectDir));
    const value = readSettingsTarget(projectDir, "local")?.flags?.statusline;
    return value === undefined ? null : value;
  } catch {
    // A file AI-DLC cannot read records no answer; the switch says so when it writes.
    return null;
  }
}

/** The person's own project-local Claude Code status line that `on` replaced. */
export function readStatusLineReplaced(projectDir: string): Record<string, unknown> | null {
  try {
    return readSettingsTarget(projectDir, "local")?.flags?.statuslineReplaced ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep the person's answer in their own aidlc.settings.local.json. `replaced`
 * stores the project-local status line of theirs that `on` took the place of
 * (null clears it; undefined leaves it as it is).
 */
export function recordStatusLineChoice(
  projectDir: string,
  choice: StatusLineChoice,
  replaced?: Record<string, unknown> | null,
): void {
  const path = localSettingsPath(projectDir);
  // Another process (a setup step) may have written the file since this one
  // first read it; the write keeps everything in it, so it reads it fresh.
  invalidateSettingsCache(path);
  let current: ReturnType<typeof readSettingsTarget>;
  try {
    current = readSettingsTarget(projectDir, "local");
  } catch (error) {
    throw new Error(
      `${path} could not be read (${error instanceof Error ? error.message : String(error)}); ` +
        "fix it or move it aside, then run the switch again.",
    );
  }
  const flags: ProjectFlagsRecord = { ...(current?.flags ?? { schemaVersion: 1 }), statusline: choice };
  if (replaced === null) delete flags.statuslineReplaced;
  else if (replaced !== undefined) flags.statuslineReplaced = replaced;
  const next = updateSettingsSection(current, "flags", flags);
  if (next === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, serializeAidlcSettings(next));
  invalidateSettingsCache(path);
}

// ---------------------------------------------------------------------------
// AI-DLC's value, as shipped in tools/data/harness.json
// ---------------------------------------------------------------------------

export type ClaudeStatusLineValue = { type: "command"; command: string };

function shippedStatusLineField(projectDir: string, harnessDir: string): unknown {
  // The project's own tree first; a native engine falls back to its runtime for
  // a project whose harness.json predates the field.
  for (const path of [join(projectDir, harnessDir, "tools", "data", "harness.json"), harnessDataPath()]) {
    try {
      const data = readJsonFile(path);
      if (isRecord(data) && data.statusLine !== undefined) return data.statusLine;
    } catch {
      // The next place may have it.
    }
  }
  return undefined;
}

/** The Claude Code `statusLine` value this install ships, or null before it did. */
export function shippedClaudeStatusLine(projectDir: string): ClaudeStatusLineValue | null {
  const value = shippedStatusLineField(projectDir, ".claude");
  return isRecord(value) && value.type === "command" && typeof value.command === "string" && value.command.trim() !== ""
    ? { type: "command", command: value.command }
    : null;
}

/** The Codex `[tui] status_line` items this install ships, or null before it did. */
export function shippedCodexStatusLineItems(projectDir: string): string[] | null {
  const value = shippedStatusLineField(projectDir, ".codex");
  return isRecord(value) && Array.isArray(value.items) &&
      value.items.length > 0 && value.items.every((item) => typeof item === "string" && item.trim() !== "")
    ? [...value.items as string[]]
    : null;
}

// ---------------------------------------------------------------------------
// Claude Code's settings layers, highest first: managed, the project's
// settings.local.json, the project's settings.json, the person's user file
// ---------------------------------------------------------------------------

/**
 * Resolve the ordered list of Claude Code `managed-settings.json` paths to probe
 * for an organization's setting, most-authoritative first. Pure and
 * platform/env-injected so every OS can be unit-tested without a host of that OS.
 *
 * Paths per Claude Code's settings docs (code.claude.com/docs/en/settings):
 *   - macOS:       /Library/Application Support/ClaudeCode/managed-settings.json
 *   - Linux / WSL: /etc/claude-code/managed-settings.json
 *   - Windows:     %ProgramFiles%\ClaudeCode\managed-settings.json
 *                  (legacy %PROGRAMDATA%\ClaudeCode\ - unsupported since v2.1.75,
 *                   kept only as a secondary probe)
 *
 * AIDLC_MANAGED_SETTINGS_PATH overrides the list entirely: a custom managed
 * path, and the seam tests use to stay hermetic against the host's real file.
 */
export function resolveManagedSettingsCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (env.AIDLC_MANAGED_SETTINGS_PATH) return [env.AIDLC_MANAGED_SETTINGS_PATH];
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") {
    // Use the win32 joiner explicitly so paths carry backslashes regardless of
    // the host OS running doctor's tests (native `join` would use the host's).
    return [
      winPath.join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json"),
      winPath.join(env.PROGRAMDATA || "C:\\ProgramData", "ClaudeCode", "managed-settings.json"),
    ];
  }
  return ["/etc/claude-code/managed-settings.json"];
}

/** A managed settings file and its alphabetical managed-settings.d fragments. */
export function managedSettingsFiles(candidate: string): string[] {
  const files = [candidate];
  const fragmentsDir = join(dirname(candidate), "managed-settings.d");
  try {
    for (const name of readdirSync(fragmentsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const path = join(fragmentsDir, name);
      try {
        if (statSync(path).isFile()) files.push(path);
      } catch {
        // A fragment that vanished during enumeration carries no policy.
      }
    }
  } catch {
    // An absent or unreadable fragment directory carries no policy.
  }
  return files;
}

/** The organization's value for one Claude Code setting; undefined when none sets it. */
export function resolveManagedSetting(
  key: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  for (const candidate of resolveManagedSettingsCandidates(platform, env)) {
    let effective: unknown;
    for (const path of managedSettingsFiles(candidate)) {
      try {
        const parsed = readJsonFile(path);
        if (isRecord(parsed) && parsed[key] !== undefined) effective = parsed[key];
      } catch {
        // Absent, unreadable, or malformed managed files do not define the key.
      }
    }
    if (effective !== undefined) return effective;
  }
  return undefined;
}

/** Claude Code's user settings file: $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json. */
export function claudeUserSettingsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return join(configDir, "settings.json");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home ? join(home, ".claude", "settings.json") : null;
}

export function claudeLocalSettingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.local.json");
}

export function claudeTeamSettingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.json");
}

/** True for AI-DLC's own status line command, on either channel. */
export function isAidlcClaudeStatusLine(value: unknown, projectDir?: string): boolean {
  return isRecord(value) && typeof value.command === "string" &&
    aidlcHookTarget(value.command, projectDir) === "statusline";
}

function statusLineIn(path: string | null): unknown {
  if (path === null) return undefined;
  try {
    const parsed = readJsonFile(path);
    return isRecord(parsed) ? parsed.statusLine : undefined;
  } catch {
    return undefined;
  }
}

export type ClaudeStatusLineLayers = {
  managed: unknown;
  local: unknown;
  team: unknown;
  user: unknown;
};

/** The `statusLine` value each of Claude Code's settings layers sets, read only. */
export function claudeStatusLineLayers(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ClaudeStatusLineLayers {
  return {
    managed: resolveManagedSetting("statusLine", platform, env),
    local: statusLineIn(claudeLocalSettingsPath(projectDir)),
    team: statusLineIn(claudeTeamSettingsPath(projectDir)),
    user: statusLineIn(claudeUserSettingsPath(env)),
  };
}

/** A status line of the person's (or their team's or organization's), not AI-DLC's. */
export function isOwnClaudeStatusLine(value: unknown, projectDir: string): boolean {
  return isCustomClaudeStatusLine(value, projectDir);
}

/** The person has a status line of their own that AI-DLC's in settings.local.json would cover. */
export function claudeOwnStatusLineBelowLocal(layers: ClaudeStatusLineLayers, projectDir: string): boolean {
  return isOwnClaudeStatusLine(layers.team, projectDir) || isOwnClaudeStatusLine(layers.user, projectDir);
}

/** Any status line of their own, in any layer: what the setup question's recommendation reads. */
export function claudeHasOwnStatusLine(layers: ClaudeStatusLineLayers, projectDir: string): boolean {
  return isOwnClaudeStatusLine(layers.managed, projectDir) || isOwnClaudeStatusLine(layers.local, projectDir) ||
    claudeOwnStatusLineBelowLocal(layers, projectDir);
}

// ---------------------------------------------------------------------------
// Claude Code: AI-DLC's status line in the person's .claude/settings.local.json
// ---------------------------------------------------------------------------

function readSettingsObject(path: string): { text: string; value: Record<string, unknown> } {
  if (!existsSync(path)) return { text: "", value: {} };
  const text = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom(text));
  } catch (error) {
    throw new Error(
      `${path} is not JSON AI-DLC can edit (${error instanceof Error ? error.message : String(error)}); ` +
        "fix it or move it aside, then run the switch again.",
    );
  }
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object AI-DLC can edit; fix it or move it aside, then run the switch again.`);
  return { text, value: parsed };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type ClaudeStatusLineWrite = {
  changed: boolean;
  /** A status line of the person's own in settings.local.json that `on` took the place of. */
  replaced?: Record<string, unknown>;
  /** `off` put the replaced one back. */
  restored?: boolean;
};

/**
 * Put AI-DLC's status line into, or take it out of, the person's
 * .claude/settings.local.json. Every other key of the file stays; a file that
 * is then empty goes, since nothing of theirs was in it.
 */
export function setClaudeStatusLine(
  projectDir: string,
  on: boolean,
  shipped: ClaudeStatusLineValue,
  options: { restore?: Record<string, unknown> | null } = {},
): ClaudeStatusLineWrite {
  const path = claudeLocalSettingsPath(projectDir);
  const { text, value } = readSettingsObject(path);
  const current = value.statusLine;
  if (on) {
    if (isAidlcClaudeStatusLine(current, projectDir)) {
      if (sameValue(current, shipped)) return { changed: false };
      value.statusLine = shipped;
      writeSettingsObject(path, value, text);
      return { changed: true };
    }
    const replaced = isRecord(current) ? current : undefined;
    value.statusLine = shipped;
    writeSettingsObject(path, value, text);
    return { changed: true, ...(replaced ? { replaced } : {}) };
  }
  if (!isAidlcClaudeStatusLine(current, projectDir)) return { changed: false };
  if (options.restore) value.statusLine = options.restore;
  else delete value.statusLine;
  if (Object.keys(value).length === 0) {
    unlinkSync(path);
  } else {
    writeSettingsObject(path, value, text);
  }
  return { changed: true, restored: Boolean(options.restore) };
}

function writeSettingsObject(path: string, value: Record<string, unknown>, like: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, jsonFileText(value, like));
}

/**
 * An earlier release put AI-DLC's status line in the team's .claude/settings.json.
 * Take it out of there (the refresh does the same by shipping none) and mark
 * the project as one that had it, so each teammate's clone keeps it (C1).
 */
export function removeAidlcStatusLineFromTeamSettings(projectDir: string): boolean {
  const path = claudeTeamSettingsPath(projectDir);
  if (!existsSync(path)) return false;
  const { text, value } = readSettingsObject(path);
  if (!isAidlcClaudeStatusLine(value.statusLine, projectDir)) return false;
  delete value.statusLine;
  writeSettingsObject(path, value, text);
  markClaudeStatusLineKept(projectDir);
  return true;
}

const CLAUDE_BASELINE = [".claude", "tools", "data", "aidlc-manifest.json"] as const;

/** The project had AI-DLC's status line before this release (recorded by the refresh that moved it). */
export function claudeStatusLineKeptMarker(projectDir: string): boolean {
  try {
    const baseline = readJsonFile(join(projectDir, ...CLAUDE_BASELINE));
    return isRecord(baseline) && baseline.statusLineKept === true;
  } catch {
    return false;
  }
}

function markClaudeStatusLineKept(projectDir: string): void {
  const path = join(projectDir, ...CLAUDE_BASELINE);
  let baseline: unknown;
  try {
    baseline = readJsonFile(path);
  } catch {
    return;
  }
  if (!isRecord(baseline) || baseline.statusLineKept === true) return;
  writeFileAtomic(path, `${JSON.stringify({ ...baseline, statusLineKept: true }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Lines the person reads (Claude Code)
// ---------------------------------------------------------------------------

export const CLAUDE_STATUS_LINE_QUESTION =
  "Show AI-DLC's progress in your status line? It takes the place of your own while you work in this project.";

/** The setup question's two answers, the recommended one first. */
export function claudeStatusLineAnswers(hasOwn: boolean): Array<{ on: boolean; label: string }> {
  const yes = { on: true, label: "Yes" };
  const no = { on: false, label: "No, keep mine" };
  return hasOwn ? [no, yes] : [yes, no];
}

export function claudeStatusLineOnLine(
  ownCovered: boolean,
  options: { already?: boolean; managed?: boolean; replacedLocal?: boolean } = {},
): string {
  const entry = statusLineEntry("claude");
  if (options.managed) {
    return `AI-DLC's status line is on for you in this project, but your organization's Claude Code settings choose the status line, so theirs still shows.`;
  }
  if (options.replacedLocal) {
    return `AI-DLC's status line shows in this project in place of the one in .claude/settings.local.json; ${entry} --statusline off puts that one back.`;
  }
  const shows = options.already ? "already shows" : "shows";
  return ownCovered
    ? `AI-DLC's status line ${shows} in this project; ${entry} --statusline off gives yours back.`
    : `AI-DLC's status line ${shows} in this project; ${entry} --statusline off turns it off.`;
}

export function claudeStatusLineOffLine(
  ownBelow: boolean,
  options: { restoredLocal?: boolean; leftTeamFile?: boolean } = {},
): string {
  const entry = statusLineEntry("claude");
  let line = options.restoredLocal
    ? `The status line from .claude/settings.local.json shows again in this project; ${entry} --statusline on brings AI-DLC's back.`
    : ownBelow
    ? `Your own status line shows again in this project; ${entry} --statusline on brings AI-DLC's back.`
    : `AI-DLC's status line is off in this project; ${entry} --statusline on brings it back.`;
  if (options.leftTeamFile) {
    line += " It also left the shared .claude/settings.json, where an earlier release put it; your teammates keep it through their own settings from their next chat.";
  }
  return line;
}

/** The setup question answered No. */
export function claudeStatusLineKeptMineLine(hasOwn: boolean): string {
  const entry = statusLineEntry("claude");
  return hasOwn
    ? `Your own status line stays in this project; ${entry} --statusline on shows AI-DLC's progress there instead.`
    : `No status line from AI-DLC in this project; ${entry} --statusline on shows its progress there.`;
}

/** Said once to the person whose own status line a kept project status line covers (C1). */
export function claudeStatusLineReplacesYoursLine(): string {
  return `AI-DLC's status line replaces yours here; ${statusLineEntry("claude")} --statusline off gives yours back.`;
}

export type StatusLineDefaultResult = {
  /** AI-DLC's status line was written for this person. */
  wrote: boolean;
  /** The one line to say, or null when nothing of theirs is covered. */
  line: string | null;
};

/**
 * What a setup, refresh or first chat that asks no question does for this
 * clone on Claude Code, once: a project that had AI-DLC's status line keeps it
 * (C1: it goes into this person's settings.local.json, and the person whose own
 * it covers hears so); otherwise the unasked default. Nothing happens when the
 * person already answered, already has a status line in settings.local.json,
 * or their organization chooses the status line.
 */
export function applyClaudeStatusLineDefault(
  projectDir: string,
  options: {
    marker?: boolean;
    mode?: StatusLineUnaskedDefault;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): StatusLineDefaultResult | null {
  if (readStatusLineChoice(projectDir) !== null) return null;
  const shipped = shippedClaudeStatusLine(projectDir);
  if (shipped === null) return null;
  const layers = claudeStatusLineLayers(projectDir, options.env, options.platform);
  if (layers.local !== undefined) return null;
  if (isOwnClaudeStatusLine(layers.managed, projectDir)) return null;
  const marker = options.marker ?? claudeStatusLineKeptMarker(projectDir);
  const ownBelow = claudeOwnStatusLineBelowLocal(layers, projectDir);
  if (marker) {
    setClaudeStatusLine(projectDir, true, shipped);
    recordStatusLineChoice(projectDir, "kept");
    return { wrote: true, line: ownBelow ? claudeStatusLineReplacesYoursLine() : null };
  }
  const mode = options.mode ?? STATUSLINE_UNASKED_DEFAULT;
  if (mode === "when-they-have-none" && !ownBelow) {
    setClaudeStatusLine(projectDir, true, shipped);
    recordStatusLineChoice(projectDir, "kept");
    return { wrote: true, line: null };
  }
  return null;
}

export type StatusLineSwitchResult = {
  changed: boolean;
  line: string;
};

/**
 * The person's explicit `--statusline on|off` on Claude Code: apply it once,
 * record it, and say in one line what happened and the way back.
 */
export function switchClaudeStatusLine(
  projectDir: string,
  on: boolean,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): StatusLineSwitchResult {
  const shipped = shippedClaudeStatusLine(projectDir);
  if (shipped === null) {
    throw new Error("AI-DLC's status line is not in this project's files yet; run `aidlc config` to update the project, then switch it.");
  }
  const layers = claudeStatusLineLayers(projectDir, options.env, options.platform);
  const ownBelow = claudeOwnStatusLineBelowLocal(layers, projectDir);
  const managed = isOwnClaudeStatusLine(layers.managed, projectDir);
  if (on) {
    const result = setClaudeStatusLine(projectDir, true, shipped);
    recordStatusLineChoice(projectDir, "on", result.replaced ?? undefined);
    return {
      changed: result.changed,
      line: claudeStatusLineOnLine(ownBelow, {
        already: !result.changed,
        managed,
        replacedLocal: result.replaced !== undefined,
      }),
    };
  }
  const leftTeamFile = removeAidlcStatusLineFromTeamSettings(projectDir);
  const restore = readStatusLineReplaced(projectDir);
  const result = setClaudeStatusLine(projectDir, false, shipped, { restore });
  recordStatusLineChoice(projectDir, "off", null);
  return {
    changed: result.changed || leftTeamFile,
    line: claudeStatusLineOffLine(ownBelow, { restoredLocal: result.restored, leftTeamFile }),
  };
}

// ---------------------------------------------------------------------------
// Codex CLI: AI-DLC's `[tui] status_line` in the project's shared .codex/config.toml
// ---------------------------------------------------------------------------

export const CODEX_STATUS_LINE_PATH = ["tui", "status_line"] as const;

export function codexSharedConfigPath(projectDir: string): string {
  return join(projectDir, ".codex", "config.toml");
}

function parseToml(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = Bun.TOML.parse(withoutBom(text));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function codexStatusLineValue(parsed: Record<string, unknown>): unknown {
  const tui = parsed.tui;
  return isRecord(tui) ? tui.status_line : undefined;
}

function sameItems(value: unknown, items: readonly string[]): boolean {
  return Array.isArray(value) && value.length === items.length && value.every((item, at) => item === items[at]);
}

export type CodexStatusLineState = "aidlc" | "own" | "none" | "unreadable";

/** What the project's shared config says about its status line. */
export function codexStatusLineState(projectDir: string, items: readonly string[]): CodexStatusLineState {
  const path = codexSharedConfigPath(projectDir);
  if (!existsSync(path)) return "none";
  const parsed = parseToml(readFileSync(path, "utf-8"));
  if (parsed === null) return "unreadable";
  const value = codexStatusLineValue(parsed);
  if (value === undefined) return "none";
  return sameItems(value, items) ? "aidlc" : "own";
}

/** Codex's own config file for this person: $CODEX_HOME/config.toml, else ~/.codex/config.toml. Read only. */
export function codexUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim();
  if (home) return join(home, "config.toml");
  return join(env.HOME?.trim() || env.USERPROFILE?.trim() || homedir(), ".codex", "config.toml");
}

/** The person set a status line of their own in their Codex config. */
export function codexOwnStatusLine(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = codexUserConfigPath(env);
  if (!existsSync(path)) return false;
  const parsed = parseToml(readFileSync(path, "utf-8"));
  return parsed !== null && codexStatusLineValue(parsed) !== undefined;
}

const CODEX_STATUS_LINE_COMMENT =
  "# AI-DLC's progress in the status line, for everyone working in this project; $aidlc --statusline off takes it out.";
// The comment lines earlier releases shipped above the table, removed with it.
const CODEX_STATUS_LINE_OLD_COMMENTS = [
  "# Statusline (D-6): predefined item IDs only; task-progress is fed by the",
  "# update_plan tool, which the orchestrator skill keeps current per stage.",
];

function codexStatusLineText(items: readonly string[]): string {
  return `status_line = [${items.map((item) => JSON.stringify(item)).join(", ")}]`;
}

const TUI_HEADER = /^\s*\[tui\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const STATUS_LINE_KEY = /^\s*(?:status_line|"status_line"|'status_line')\s*=/;
const ROOT_DOTTED_KEY = /^\s*tui\s*\.\s*(?:status_line|"status_line"|'status_line')\s*=/;
const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/;

function codexShapeError(projectDir: string): Error {
  return new Error(
    `${codexSharedConfigPath(projectDir)} spells its [tui] status_line in a way AI-DLC does not edit (an inline table, ` +
      "or a value over several lines); change status_line there yourself.",
  );
}

export type CodexStatusLineWrite = {
  changed: boolean;
  /** `on` took the place of a status line the project had set itself. */
  replacedOwn?: boolean;
  /** `off` left a status line that is the project's own, not AI-DLC's. */
  keptOwn?: boolean;
};

/**
 * Put AI-DLC's `status_line` into, or take it out of, the project's shared
 * .codex/config.toml. Only that line (and the `[tui]` header when nothing else
 * is in the table) is written; every other byte, comments and spelling stay,
 * and the result is parsed back and compared before it is written.
 */
export function setCodexStatusLine(projectDir: string, on: boolean, items: readonly string[]): CodexStatusLineWrite {
  const path = codexSharedConfigPath(projectDir);
  const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = raw.slice(bom.length);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const before = body === "" ? {} : parseToml(body);
  if (before === null) {
    throw new Error(`${path} could not be read as TOML, so AI-DLC did not change it; fix it, then run the switch again.`);
  }
  const current = codexStatusLineValue(before);
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  // A trailing newline leaves one empty last element; keep the file's ending.
  const endsWithNewline = body.endsWith("\n");
  if (endsWithNewline) lines.pop();
  const headerAt = lines.findIndex((line) => TUI_HEADER.test(line));
  const sectionEnd = headerAt < 0
    ? -1
    : (() => {
      const next = lines.findIndex((line, at) => at > headerAt && ANY_HEADER.test(line));
      return next < 0 ? lines.length : next;
    })();
  const keyAt = headerAt < 0
    ? lines.findIndex((line, at) => ROOT_DOTTED_KEY.test(line) && !lines.slice(0, at).some((earlier) => ANY_HEADER.test(earlier)))
    : lines.findIndex((line, at) => at > headerAt && at < sectionEnd && STATUS_LINE_KEY.test(line));
  const result: CodexStatusLineWrite = { changed: false };
  if (on) {
    if (sameItems(current, items)) return result;
    if (current !== undefined) {
      if (keyAt < 0) throw codexShapeError(projectDir);
      lines[keyAt] = headerAt < 0 ? `tui.${codexStatusLineText(items)}` : codexStatusLineText(items);
      result.replacedOwn = true;
    } else if (headerAt >= 0) {
      let insertAt = headerAt + 1;
      for (let at = headerAt + 1; at < sectionEnd; at++) {
        if (!BLANK_OR_COMMENT.test(lines[at])) insertAt = at + 1;
      }
      lines.splice(insertAt, 0, codexStatusLineText(items));
    } else {
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      if (lines.length > 0) lines.push("");
      lines.push(CODEX_STATUS_LINE_COMMENT, "[tui]", codexStatusLineText(items));
    }
  } else {
    if (current === undefined) return result;
    if (!sameItems(current, items)) return { changed: false, keptOwn: true };
    if (keyAt < 0) throw codexShapeError(projectDir);
    lines.splice(keyAt, 1);
    if (headerAt >= 0) {
      const end = sectionEnd - 1;
      const bodyLeft = lines.slice(headerAt + 1, end).some((line) => !BLANK_OR_COMMENT.test(line));
      if (!bodyLeft) {
        // The table held only AI-DLC's line: its header goes, with AI-DLC's own
        // comment lines right above it, and the blank lines that framed it.
        let from = headerAt;
        while (
          from > 0 &&
          [CODEX_STATUS_LINE_COMMENT, ...CODEX_STATUS_LINE_OLD_COMMENTS].includes(lines[from - 1].trim())
        ) from--;
        lines.splice(from, end - from);
        // One blank line stays between what was before and after the table.
        while (from > 0 && lines[from - 1].trim() === "" && (from === lines.length || lines[from].trim() === "")) {
          lines.splice(from - 1, 1);
          from--;
        }
      }
    }
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const text = lines.length === 0 ? "" : `${lines.join(newline)}${newline}`;
  const after = text === "" ? {} : parseToml(text);
  if (after === null) throw codexShapeError(projectDir);
  const expected = on ? items : undefined;
  const got = codexStatusLineValue(after);
  if ((expected === undefined && got !== undefined) || (expected !== undefined && !sameItems(got, expected))) {
    throw codexShapeError(projectDir);
  }
  if (!sameValue(withoutStatusLine(before), withoutStatusLine(after))) throw codexShapeError(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${bom}${text}`);
  return { ...result, changed: true };
}

function withoutStatusLine(parsed: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...parsed };
  if (isRecord(copy.tui)) {
    const tui = { ...copy.tui };
    delete tui.status_line;
    if (Object.keys(tui).length === 0) delete copy.tui;
    else copy.tui = tui;
  }
  return sortKeys(copy) as Record<string, unknown>;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

// ---------------------------------------------------------------------------
// Lines the person reads (Codex)
// ---------------------------------------------------------------------------

export const CODEX_STATUS_LINE_QUESTION =
  "Show AI-DLC's progress in the status line? This is a setting of the project, so it applies to everyone working " +
  "in it and takes the place of each person's own status line here. Each person can instead add task progress to " +
  "their own status line with Codex's /statusline.";

export function codexStatusLineAnswers(hasOwn: boolean): Array<{ on: boolean; label: string }> {
  const yes = { on: true, label: "Yes, for everyone in this project" };
  const no = { on: false, label: "No, leave status lines alone" };
  return hasOwn ? [no, yes] : [yes, no];
}

const CODEX_OWN_WAY = "Each person can add task progress to their own status line with Codex's /statusline";

export function codexStatusLineOnLine(options: { already?: boolean; replacedOwn?: boolean } = {}): string {
  const entry = statusLineEntry("codex");
  if (options.replacedOwn) {
    return `AI-DLC's progress shows in the status line for everyone working in this project, in place of the status line ` +
      `.codex/config.toml had (git history keeps it); ${entry} --statusline off takes AI-DLC's out. ${CODEX_OWN_WAY} instead.`;
  }
  const shows = options.already ? "already shows" : "shows";
  return `AI-DLC's progress ${shows} in the status line for everyone working in this project (.codex/config.toml); ` +
    `${entry} --statusline off takes it out. ${CODEX_OWN_WAY} instead.`;
}

export function codexStatusLineOffLine(options: { keptOwn?: boolean } = {}): string {
  const entry = statusLineEntry("codex");
  if (options.keptOwn) {
    return `The status line in .codex/config.toml is this project's own, not AI-DLC's, so it stays for everyone working here. ` +
      `${CODEX_OWN_WAY}.`;
  }
  return `AI-DLC's progress is out of the status line for everyone working in this project (.codex/config.toml); ` +
    `${entry} --statusline on puts it in. ${CODEX_OWN_WAY}.`;
}

/** The setup question answered No. */
export function codexStatusLineLeftAloneLine(): string {
  return `Status lines stay as they are for everyone working in this project; ${statusLineEntry("codex")} --statusline on ` +
    `shows AI-DLC's progress there for everyone. ${CODEX_OWN_WAY}.`;
}

/** Said once to the person whose own status line the project's AI-DLC status line covers (C1). */
export function codexStatusLineReplacesYoursLine(): string {
  return `AI-DLC's status line replaces yours in this project; ${statusLineEntry("codex")} --statusline off takes it out ` +
    "for everyone working here, or add task progress to your own with Codex's /statusline.";
}

/**
 * What a refresh or first chat that asks no question does on Codex, once per
 * person: a project whose shared config already carries AI-DLC's status line
 * keeps it (C1), and the person whose own Codex status line it covers hears so.
 * Nothing is written to the project; the shared file is the state.
 */
export function applyCodexStatusLineDefault(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): StatusLineDefaultResult | null {
  if (readStatusLineChoice(projectDir) !== null) return null;
  const items = shippedCodexStatusLineItems(projectDir);
  if (items === null) return null;
  if (codexStatusLineState(projectDir, items) !== "aidlc") return null;
  // Only the person whose own status line it covers has something to hear;
  // the record keeps it to once.
  if (!codexOwnStatusLine(env)) return null;
  recordStatusLineChoice(projectDir, "kept");
  return { wrote: false, line: codexStatusLineReplacesYoursLine() };
}

/** The person's explicit `--statusline on|off` on Codex. */
export function switchCodexStatusLine(projectDir: string, on: boolean): StatusLineSwitchResult {
  const items = shippedCodexStatusLineItems(projectDir);
  if (items === null) {
    throw new Error("AI-DLC's status line is not in this project's files yet; run `aidlc config` to update the project, then switch it.");
  }
  const result = setCodexStatusLine(projectDir, on, items);
  recordStatusLineChoice(projectDir, on ? "on" : "off");
  return {
    changed: result.changed,
    line: on
      ? codexStatusLineOnLine({ already: !result.changed, replacedOwn: result.replacedOwn })
      : codexStatusLineOffLine({ keptOwn: result.keptOwn }),
  };
}

// ---------------------------------------------------------------------------
// One entry for the callers that do not know the harness
// ---------------------------------------------------------------------------

/**
 * AI-DLC's own status line in this person's settings.local.json follows the
 * release (a copy install that became a native one runs another command). A
 * status line that is not AI-DLC's is never touched.
 */
export function refreshClaudeStatusLineValue(projectDir: string): boolean {
  const shipped = shippedClaudeStatusLine(projectDir);
  if (shipped === null) return false;
  const local = statusLineIn(claudeLocalSettingsPath(projectDir));
  if (!isAidlcClaudeStatusLine(local, projectDir) || sameValue(local, shipped)) return false;
  return setClaudeStatusLine(projectDir, true, shipped).changed;
}

/** Apply the no-question default for this clone on either host; null when nothing happens. */
export function applyStatusLineDefault(
  projectDir: string,
  harness: StatusLineHarness,
  options: { mode?: StatusLineUnaskedDefault; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): StatusLineDefaultResult | null {
  if (harness === "codex") return applyCodexStatusLineDefault(projectDir, options.env);
  refreshClaudeStatusLineValue(projectDir);
  return applyClaudeStatusLineDefault(projectDir, options);
}

/** The person's `--statusline on|off` on either host. */
export function switchStatusLine(
  projectDir: string,
  harness: StatusLineHarness,
  on: boolean,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): StatusLineSwitchResult {
  return harness === "claude"
    ? switchClaudeStatusLine(projectDir, on, options)
    : switchCodexStatusLine(projectDir, on);
}

/** The setup question's answer applied: on writes AI-DLC's status line, off records the no. */
export function applyStatusLineAnswer(
  projectDir: string,
  harness: StatusLineHarness,
  on: boolean,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string {
  if (on) return switchStatusLine(projectDir, harness, true, options).line;
  recordStatusLineChoice(projectDir, "off");
  if (harness === "codex") return codexStatusLineLeftAloneLine();
  const layers = claudeStatusLineLayers(projectDir, options.env, options.platform);
  return claudeStatusLineKeptMineLine(claudeHasOwnStatusLine(layers, projectDir));
}

/** Whether the person has a status line of their own on this host (read only): what the question recommends on. */
export function hasOwnStatusLine(
  projectDir: string,
  harness: StatusLineHarness,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): boolean {
  return harness === "claude"
    ? claudeHasOwnStatusLine(claudeStatusLineLayers(projectDir, options.env, options.platform), projectDir)
    : codexOwnStatusLine(options.env);
}

/** The one line for a host with no status line for AI-DLC's progress. */
export function noStatusLineLine(productName: string, entry: string): string {
  return `${productName} has no status line for AI-DLC's progress; ${entry} --status shows where the work stands.`;
}
