// Kiro IDE's Workflows feature. With `kiroAgent.workflows.enabled` on, Kiro IDE
// takes the sub-agent tool away from a chat and hands its helpers to background
// workflows, so AI-DLC's reviews and helpers either never run (the aidlc agent)
// or run out of step (the Default agent). Kiro reads the key from the user
// settings only (its scope is "application"), so the switch covers every
// project on the computer: AI-DLC turns it off only when the person says yes,
// and keeps their answer once per machine so no project asks again.
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { insertJsoncSetting, jsoncRootMembers, jsoncSettingValue, replaceJsoncSetting } from "./aidlc-distribution.ts";
import { installRoot } from "./aidlc-install-paths.ts";
import { setByDotenvFile } from "./aidlc-kiro-session.ts";
import { writeFileAtomic } from "./aidlc-lib.ts";

export const KIRO_WORKFLOWS_SETTING = "kiroAgent.workflows.enabled";
export const KIRO_WORKFLOWS_ISSUE_ID = "kiro-workflows-on";

/** The person's answer, kept per machine: they turned Workflows off or kept it
 *  on, or a chat already asked them. Any answer means AI-DLC does not ask again. */
export type KiroWorkflowsAnswer = "off" | "on" | "asked";
const ANSWERS: readonly KiroWorkflowsAnswer[] = ["off", "on", "asked"];
export const KIRO_WORKFLOWS_ANSWER_FILE = "kiro-ide-workflows";

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

/** True in a process Kiro IDE started (its hooks and the agent's commands). */
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

const RELOAD_STEP =
  "If Kiro is open, run Developer: Reload Window from the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS) " +
  "so open chats pick it up.";

export const KIRO_WORKFLOWS_QUESTION =
  "Kiro's Workflows feature is on. It runs work in the background and stops AI-DLC's reviews and helpers from " +
  "running in your chats. Turn Workflows off? It is a Kiro setting for all your projects, and you can turn it " +
  "back on any time.";

/** The line after AI-DLC turned Workflows off. */
export function kiroWorkflowsOffLine(): string {
  return "Turned Kiro's Workflows feature off, so AI-DLC's reviews and helpers run in your chats. It is a Kiro " +
    `setting for all your projects. ${RELOAD_STEP} You can turn it back on any time.`;
}

export function kiroWorkflowsOnLine(): string {
  return `Turned Kiro's Workflows feature back on (a Kiro setting for all your projects). ${RELOAD_STEP}`;
}

/** The line after the person kept Workflows on at a question. */
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

/**
 * The one chat line a Kiro IDE chat gives the agent while Workflows is on and the
 * person was never asked on this machine, or "". Asking counts as their answer:
 * a "no" is simply not acting, and no chat asks again.
 */
export function kiroIdeWorkflowsAsk(invoke: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!insideKiroIde(env) || !kiroWorkflowsQuestionDue(env)) return "";
  try {
    recordKiroWorkflowsAnswer("asked");
  } catch {
    // Not asked rather than asked in every chat.
    return "";
  }
  return "ASK ONCE: after you answer the person's message, ask them this in their language: " +
    "\"Kiro's Workflows feature is on, and it stops AI-DLC's reviews and helpers from running in this chat. " +
    "Do you want me to turn Workflows off? It is a Kiro setting for all your projects; you can turn it back on " +
    `any time." On yes, run \`${invoke} config trust --kiro-workflows off --yes\` and tell them what it prints. ` +
    "On no, leave it. Do not ask again.";
}
