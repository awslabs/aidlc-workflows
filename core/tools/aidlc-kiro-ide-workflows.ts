// Kiro IDE's Workflows feature. With `kiroAgent.workflows.enabled` on, Kiro IDE
// takes the sub-agent tool away from a chat and hands its helpers to background
// workflows, so AI-DLC's reviews and helpers either never run (the aidlc agent)
// or run out of step (the Default agent). Kiro reads the key from the user
// settings only (its scope is "application"), so the switch covers every
// project on the computer: AI-DLC turns it off only when the person says yes,
// and keeps their answer once per machine so no project asks again.
//
// Kiro CLI, the other host of this row, has a switch of its own,
// `chat.enableWorkflows` in the person's own Kiro CLI settings: on its v3 engine
// it takes both sub-agent tools away from the aidlc agent (measured on Kiro CLI
// 2.31.1 and 2.32.0; 2.23.1, older than this row's oldest checked build, kept
// them). Its interactive chat reads only that personal value, so a project file
// cannot turn it off either. It gets the same
// question, kept as an answer of its own: an answer about Kiro IDE says nothing
// about Kiro CLI.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { insertJsoncSetting, jsoncRootMembers, jsoncSettingValue, replaceJsoncSetting } from "./aidlc-distribution.ts";
import { installRoot } from "./aidlc-install-paths.ts";
import {
  kiroCliPath,
  kiroPersonalSettingsPath,
  readKiroPersonalSettings,
  setByDotenvFile,
  writeKiroPersonalSetting,
} from "./aidlc-kiro-session.ts";
import { writeFileAtomic } from "./aidlc-lib.ts";

export const KIRO_WORKFLOWS_SETTING = "kiroAgent.workflows.enabled";
export const KIRO_WORKFLOWS_ISSUE_ID = "kiro-workflows-on";
export const KIRO_WORKFLOWS_UNREADABLE_ISSUE_ID = "kiro-workflows-unreadable";

/** The person's answer, kept per machine: they turned Workflows off or kept it
 *  on, or a chat already asked them. Any answer means AI-DLC does not ask again. */
export type KiroWorkflowsAnswer = "off" | "on" | "asked";
const ANSWERS: readonly KiroWorkflowsAnswer[] = ["off", "on", "asked"];
export const KIRO_WORKFLOWS_ANSWER_FILE = "kiro-ide-workflows";
/** The settings file error a chat last told the person about. */
const KIRO_SETTINGS_ERROR_TOLD_FILE = "kiro-ide-settings-error-told";

export type KiroIdeWorkflows = {
  /** "" when no Kiro IDE settings are in reach (under the test runner). */
  settingsPath: string;
  /** Kiro's own test: the key is exactly true. Absent or false is off. */
  enabled: boolean;
  /** False when the file is there but is not one JSONC object AI-DLC can edit. */
  readable: boolean;
};

// A value a project's .env file sets is not the person's: Bun loads .env, so a
// repository could otherwise point AI-DLC at a settings file of its choosing or
// hide the question. Every name this file reads goes through here.
function hostValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && !setByDotenvFile(name) ? value : undefined;
}

/** True in a process Kiro IDE started (its hooks, not the agent's commands). */
export function insideKiroIde(env: NodeJS.ProcessEnv = process.env): boolean {
  return hostValue(env, "VSCODE_CODE_CACHE_PATH") !== undefined;
}

/**
 * Kiro IDE's user settings file, or null under the test runner without the
 * AIDLC_TEST_KIRO_IDE_SETTINGS seam, so no test reaches a person's real Kiro.
 * Inside Kiro IDE it is the user data folder of the Kiro that runs
 * (`<user data>/CachedData/<commit>` is in its environment), so a portable or
 * custom user data folder is found too; elsewhere, Kiro's default folder for
 * this platform.
 */
export function kiroIdeUserSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const seam = hostValue(env, "AIDLC_TEST_KIRO_IDE_SETTINGS");
  if (seam) return seam;
  if (hostValue(env, "AIDLC_TEST_NAME") || hostValue(env, "AIDLC_TEST_CONFIG_DETECTION_JSON")) return null;
  const cache = hostValue(env, "VSCODE_CODE_CACHE_PATH");
  if (cache && basename(dirname(cache)) === "CachedData") {
    return join(dirname(dirname(cache)), "User", "settings.json");
  }
  const home = hostValue(env, "HOME") ?? hostValue(env, "USERPROFILE") ?? homedir();
  const appData = platform === "win32"
    ? hostValue(env, "APPDATA") ?? join(home, "AppData", "Roaming")
    : platform === "darwin"
    ? join(home, "Library", "Application Support")
    : hostValue(env, "XDG_CONFIG_HOME") ?? join(home, ".config");
  return join(appData, "Kiro", "User", "settings.json");
}

export function readKiroIdeWorkflows(env: NodeJS.ProcessEnv = process.env): KiroIdeWorkflows {
  const settingsPath = kiroIdeUserSettingsPath(env);
  if (settingsPath === null) return { settingsPath: "", enabled: false, readable: true };
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf-8");
  } catch {
    return { settingsPath, enabled: false, readable: true };
  }
  if (text.trim() && !jsoncRootMembers(text)) return { settingsPath, enabled: false, readable: false };
  return { settingsPath, enabled: jsoncSettingValue(text, KIRO_WORKFLOWS_SETTING) === true, readable: true };
}

/**
 * Set Kiro IDE's Workflows switch, changing only that one key: every other byte
 * of the person's settings file (comments, other keys, layout) stays.
 */
export function setKiroIdeWorkflows(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { settingsPath: string; changed: boolean } {
  const settingsPath = kiroIdeUserSettingsPath(env);
  if (settingsPath === null) throw new Error("Kiro IDE's settings are not available here");
  const text = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : "";
  if (text.trim() && !jsoncRootMembers(text)) throw new Error(unreadableSettingsMessage(settingsPath, enabled));
  const current = text.trim() ? jsoncSettingValue(text, KIRO_WORKFLOWS_SETTING) : undefined;
  if (current === enabled) return { settingsPath, changed: false };
  const value = JSON.stringify(enabled);
  const next = current === undefined
    ? insertJsoncSetting(text, KIRO_WORKFLOWS_SETTING, value)
    : replaceJsoncSetting(text, KIRO_WORKFLOWS_SETTING, value);
  if (next === null) throw new Error(unreadableSettingsMessage(settingsPath, enabled));
  mkdirSync(dirname(settingsPath), { recursive: true });
  // A settings file linked from elsewhere (a dotfiles folder, say) stays a link:
  // the write goes to the file it points to.
  writeFileAtomic(existsSync(settingsPath) ? realpathSync(settingsPath) : settingsPath, next);
  return { settingsPath, changed: true };
}

function unreadableSettingsMessage(settingsPath: string, enabled: boolean): string {
  return `${settingsPath} is not a settings file AI-DLC can edit, so Kiro's Workflows feature was not turned ` +
    `${enabled ? "on" : "off"}. In Kiro, run ${enabled ? "Enable" : "Disable"} Workflows from the Command Palette ` +
    "(Ctrl+Shift+P, or Cmd+Shift+P on macOS) instead.";
}

export function kiroWorkflowsAnswerPath(): string {
  return join(installRoot(), KIRO_WORKFLOWS_ANSWER_FILE);
}

export function readKiroWorkflowsAnswer(): KiroWorkflowsAnswer | null {
  try {
    const value = readFileSync(kiroWorkflowsAnswerPath(), "utf-8").trim();
    return (ANSWERS as readonly string[]).includes(value) ? value as KiroWorkflowsAnswer : null;
  } catch {
    return null;
  }
}

export function recordKiroWorkflowsAnswer(answer: KiroWorkflowsAnswer): void {
  const path = kiroWorkflowsAnswerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${answer}\n`);
}

/** Workflows is on and the person was never asked on this machine. */
export function kiroWorkflowsQuestionDue(env: NodeJS.ProcessEnv = process.env): boolean {
  return readKiroIdeWorkflows(env).enabled && readKiroWorkflowsAnswer() === null;
}

// Both once-only asks open with this: a first message that already says what
// to do with Workflows is the answer. Which Kiro's switch it means is the Kiro
// skill's Workflows note, its one reader.
const ALREADY_ANSWERED =
  "if the person's message already asks to turn this Kiro's Workflows feature off or to keep it on (the Kiro " +
  "skill's Workflows note says which Kiro a request means), that is their answer and you do not ask: do what it " +
  "asks as that note says (keeping a switch on runs its setter with `on --yes`, so the answer is kept) and tell " +
  "them what it prints. ";

const RELOAD_STEP =
  "If Kiro is open, run Developer: Reload Window from the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS) " +
  "so open chats pick it up.";

export const KIRO_WORKFLOWS_QUESTION =
  "Kiro's Workflows feature is on. It runs work in the background and stops AI-DLC's reviews and helpers from " +
  "running in your chats. Turn Workflows off? It is a Kiro setting for all your projects, and you can turn it " +
  "back on any time.";

export function kiroWorkflowsOffLine(): string {
  return "Turned Kiro's Workflows feature off, so AI-DLC's reviews and helpers run in your chats. It is a Kiro " +
    `setting for all your projects. ${RELOAD_STEP} You can turn it back on any time.`;
}

export function kiroWorkflowsOnLine(): string {
  return `Turned Kiro's Workflows feature back on (a Kiro setting for all your projects). ${RELOAD_STEP}`;
}

export function kiroWorkflowsAlreadyOffLine(): string {
  return "Kiro's Workflows feature is already off; nothing changed.";
}

export function kiroWorkflowsKeptLine(invoke: string): string {
  return "Kept Kiro's Workflows feature on; AI-DLC will not ask again. To turn it off later: " +
    `\`${invoke} config trust --kiro-workflows off\`.`;
}

export function kiroWorkflowsIssueMessage(): string {
  return "Kiro's Workflows feature is on, so AI-DLC's reviews and helpers do not run in your Kiro IDE chats " +
    "(Kiro hands them to background workflows)";
}

export function kiroWorkflowsFix(invoke: string): string {
  return `ask the agent to turn Kiro Workflows off, or run \`${invoke} config trust --kiro-workflows off\` ` +
    "(a Kiro setting for all your projects); then run Developer: Reload Window from the Command Palette";
}

// A settings file AI-DLC cannot read as JSONC may still be one Kiro reads
// (measured: Kiro IDE 1.2.37 turned Workflows on from a file missing a comma),
// so it is named as unknown, never as off, until the file reads again. AI-DLC
// cannot edit it, and Kiro's own settings commands write the same file, so the
// step is fixing the error; it names the file, since setup's list shows it alone.
export function kiroWorkflowsUnreadableMessage(): string {
  return "Kiro Workflows: Kiro's settings file has an error, so AI-DLC cannot tell whether Workflows is on";
}

export function kiroWorkflowsUnreadableFix(settingsPath: string): string {
  return `fix the error in ${settingsPath}`;
}

// The chat line for that file, once for each error: the marker keeps one line
// per settings file (its path, then a fingerprint of its text), so a different
// error is told again and another Kiro's file keeps its own line. null while
// the file reads.
function kiroSettingsErrorNotice(env: NodeJS.ProcessEnv): string | null {
  const state = readKiroIdeWorkflows(env);
  if (state.readable) return null;
  let error: string;
  try {
    error = createHash("sha256").update(readFileSync(state.settingsPath)).digest("hex");
  } catch {
    return "";
  }
  const told = join(installRoot(), KIRO_SETTINGS_ERROR_TOLD_FILE);
  const lines = new Map<string, string>();
  try {
    for (const line of readFileSync(told, "utf-8").split("\n")) {
      const tab = line.lastIndexOf("\t");
      if (tab > 0) lines.set(line.slice(0, tab), line.slice(tab + 1));
    }
  } catch {
    // Not told yet.
  }
  if (lines.get(state.settingsPath) === error) return "";
  lines.set(state.settingsPath, error);
  try {
    mkdirSync(dirname(told), { recursive: true });
    writeFileAtomic(told, [...lines].map(([path, hash]) => `${path}\t${hash}\n`).join(""));
  } catch {
    // Not told rather than told in every chat.
    return "";
  }
  return "TELL ONCE: after you answer the person's message, tell them this in their language: " +
    `"Kiro's settings file (${state.settingsPath}) has an error, so AI-DLC cannot tell whether Kiro's Workflows ` +
    "feature is on. While Kiro's Workflows feature is on, AI-DLC's reviews and helpers do not run in your chats. " +
    "Fix the error in that file and AI-DLC can tell again.\" Do not say it again.";
}

/**
 * The one chat line a Kiro IDE chat gives the agent while Workflows is on and the
 * person was never asked on this machine, or "". Asking counts as their answer:
 * a "no" is simply not acting, and no chat asks again. While the settings file
 * has an error, the line tells them that instead, whatever they answered.
 */
export function kiroIdeWorkflowsAsk(invoke: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!insideKiroIde(env)) return "";
  // A settings file with an error is told instead, since a yes could not turn
  // Workflows off in it.
  const notice = kiroSettingsErrorNotice(env);
  if (notice !== null) return notice;
  if (!kiroWorkflowsQuestionDue(env)) return "";
  try {
    recordKiroWorkflowsAnswer("asked");
  } catch {
    // Not asked rather than asked in every chat.
    return "";
  }
  return "ASK ONCE: " + ALREADY_ANSWERED + "Otherwise, after you answer their message, ask them this in their language: " +
    "\"Kiro's Workflows feature is on, and it stops AI-DLC's reviews and helpers from running in this chat. " +
    "Do you want me to turn Workflows off? It is a Kiro setting for all your projects; you can turn it back on " +
    `any time." On yes, run \`${invoke} config trust --kiro-workflows off --yes\` and tell them what it prints. ` +
    "On no, leave it. Do not ask again.";
}

export const KIRO_CLI_WORKFLOWS_SETTING = "chat.enableWorkflows";
export const KIRO_CLI_WORKFLOWS_ISSUE_ID = "kiro-cli-workflows-on";
export const KIRO_CLI_WORKFLOWS_ANSWER_FILE = "kiro-cli-workflows";
// Read on a chat's start and by doctor, so a Kiro that hangs costs seconds, not
// the 30 a model write may take; Kiro answers in about a tenth of a second.
const KIRO_CLI_READ_TIMEOUT_MS = 5_000;

export type KiroCliWorkflows = {
  /** Where Kiro keeps the person's own Kiro CLI settings, for display. */
  settingsPath: string;
  /** Kiro's own test: the value is exactly true. */
  enabled: boolean;
};

/**
 * Kiro CLI's Workflows switch in the person's own Kiro CLI settings, read
 * through Kiro in an empty folder so no project file joins in. null when there
 * is no Kiro CLI here or it did not answer: not checked, never read as off.
 */
export function readKiroCliWorkflows(env: NodeJS.ProcessEnv = process.env): KiroCliWorkflows | null {
  const cli = kiroCliPath(env);
  if (!cli) return null;
  let values: Record<string, unknown> | null;
  try {
    values = readKiroPersonalSettings(cli, env, KIRO_CLI_READ_TIMEOUT_MS);
  } catch {
    // Whatever stops the read leaves the switch not checked, never off.
    return null;
  }
  if (!values) return null;
  return { settingsPath: kiroPersonalSettingsPath(env), enabled: values[KIRO_CLI_WORKFLOWS_SETTING] === true };
}

/** Set Kiro CLI's Workflows switch through Kiro's own `kiro-cli settings`. */
export function setKiroCliWorkflows(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { settingsPath: string; changed: boolean } {
  const cli = kiroCliPath(env);
  const state = readKiroCliWorkflows(env);
  if (!cli || !state) throw new Error("Kiro CLI did not answer here, so its Workflows feature was not changed");
  if (state.enabled === enabled) return { settingsPath: state.settingsPath, changed: false };
  let saved = false;
  try {
    saved = writeKiroPersonalSetting(cli, KIRO_CLI_WORKFLOWS_SETTING, JSON.stringify(enabled), env);
  } catch {
    // Whatever stops the write is reported as not saved, with the same step.
  }
  if (!saved) {
    throw new Error(
      `Kiro CLI did not save the change, so its Workflows feature was not turned ${enabled ? "on" : "off"}. ` +
        `In Kiro CLI, open /settings and turn Workflows ${enabled ? "on" : "off"} instead.`,
    );
  }
  return { settingsPath: state.settingsPath, changed: true };
}

export function kiroCliWorkflowsAnswerPath(): string {
  return join(installRoot(), KIRO_CLI_WORKFLOWS_ANSWER_FILE);
}

export function readKiroCliWorkflowsAnswer(): KiroWorkflowsAnswer | null {
  try {
    const value = readFileSync(kiroCliWorkflowsAnswerPath(), "utf-8").trim();
    return (ANSWERS as readonly string[]).includes(value) ? value as KiroWorkflowsAnswer : null;
  } catch {
    return null;
  }
}

export function recordKiroCliWorkflowsAnswer(answer: KiroWorkflowsAnswer): void {
  const path = kiroCliWorkflowsAnswerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${answer}\n`);
}

/** Kiro CLI's Workflows is on and the person was never asked about it on this machine. */
export function kiroCliWorkflowsQuestionDue(env: NodeJS.ProcessEnv = process.env): boolean {
  return readKiroCliWorkflowsAnswer() === null && readKiroCliWorkflows(env)?.enabled === true;
}

const KIRO_CLI_RESTART_STEP = "Quit Kiro CLI and start `kiro-cli --v3` again so your chats pick it up.";

export const KIRO_CLI_WORKFLOWS_QUESTION =
  "Kiro CLI's Workflows feature is on. It stops AI-DLC's reviews and helpers from running in your Kiro CLI " +
  "chats. Turn it off? It is a Kiro CLI setting for all your projects, and you can turn it back on any time.";

export function kiroCliWorkflowsOffLine(): string {
  return "Turned Kiro CLI's Workflows feature off, so AI-DLC's reviews and helpers run in your Kiro CLI chats. It " +
    `is a Kiro CLI setting for all your projects. ${KIRO_CLI_RESTART_STEP} You can turn it back on any time.`;
}

export function kiroCliWorkflowsOnLine(): string {
  return `Turned Kiro CLI's Workflows feature back on (a Kiro CLI setting for all your projects). ${KIRO_CLI_RESTART_STEP}`;
}

export function kiroCliWorkflowsAlreadyOffLine(): string {
  return "Kiro CLI's Workflows feature is already off; nothing changed.";
}

export function kiroCliWorkflowsKeptLine(invoke: string): string {
  return "Kept Kiro CLI's Workflows feature on; AI-DLC will not ask again. To turn it off later: " +
    `\`${invoke} config trust --kiro-cli-workflows off\`.`;
}

export function kiroCliWorkflowsIssueMessage(): string {
  return "Kiro CLI's Workflows feature is on, so AI-DLC's reviews and helpers do not run in your Kiro CLI chats " +
    "(Kiro CLI takes away the tool AI-DLC hands them to)";
}

export function kiroCliWorkflowsFix(invoke: string): string {
  return `ask the agent to turn Kiro CLI Workflows off, or run \`${invoke} config trust --kiro-cli-workflows off\` ` +
    "(a Kiro CLI setting for all your projects); then quit Kiro CLI and start `kiro-cli --v3` again";
}

/**
 * The one chat line a Kiro CLI chat gives the agent while Kiro CLI's Workflows
 * is on and the person was never asked about it on this machine, or "". A Kiro
 * IDE chat gets Kiro IDE's question instead (kiroIdeWorkflowsAsk).
 */
export function kiroCliWorkflowsAsk(invoke: string, env: NodeJS.ProcessEnv = process.env): string {
  if (insideKiroIde(env) || !kiroCliWorkflowsQuestionDue(env)) return "";
  try {
    recordKiroCliWorkflowsAnswer("asked");
  } catch {
    // Not asked rather than asked in every chat.
    return "";
  }
  return "ASK ONCE: " + ALREADY_ANSWERED + "Otherwise, after you answer their message, ask them this in their language: " +
    "\"Kiro CLI's Workflows feature is on, and it stops AI-DLC's reviews and helpers from running in this chat. " +
    "Do you want me to turn Workflows off? It is a Kiro CLI setting for all your projects; you can turn it back on " +
    `any time." On yes, run \`${invoke} config trust --kiro-cli-workflows off --yes\` and tell them what it prints. ` +
    "On no, leave it. Do not ask again.";
}
