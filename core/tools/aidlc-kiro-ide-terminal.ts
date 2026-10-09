// Kiro IDE's terminal on Windows. Kiro runs its agent's shell tool (still named
// execute_pwsh) in the person's default terminal profile. When that is Command
// Prompt, AI-DLC's PowerShell-shaped commands split the person's words at their
// single quotes, every command reports exit code -1 whether it worked or not,
// and the result carries the echoed command and the prompt path (measured live
// on Kiro IDE 1.2.37, #2167). Kiro itself recommends PowerShell. The default
// profile is the person's own setting for all their projects, so AI-DLC sets it
// only when they say yes, and keeps their answer once per machine.
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { insertJsoncSetting, jsoncRootMembers, jsoncSettingValue, replaceJsoncSetting } from "./aidlc-distribution.ts";
import { installRoot } from "./aidlc-install-paths.ts";
import { setByDotenvFile } from "./aidlc-kiro-session.ts";
import { insideKiroIde, kiroIdeUserSettingsPath } from "./aidlc-kiro-ide-workflows.ts";
import { writeFileAtomic } from "./aidlc-lib.ts";

export const KIRO_TERMINAL_SETTING = "terminal.integrated.defaultProfile.windows";
const KIRO_TERMINAL_PROFILES = "terminal.integrated.profiles.windows";
export const KIRO_TERMINAL_POWERSHELL = "PowerShell";
export const KIRO_TERMINAL_ISSUE_ID = "kiro-terminal-command-prompt";

/** The person's answer, kept per machine: AI-DLC set PowerShell, they kept
 *  their terminal, or a chat already asked them. Any answer means no new ask. */
export type KiroTerminalAnswer = "powershell" | "kept" | "asked";
const ANSWERS: readonly KiroTerminalAnswer[] = ["powershell", "kept", "asked"];
export const KIRO_TERMINAL_ANSWER_FILE = "kiro-ide-terminal";

export type KiroIdeTerminal = {
  /** "" when no Kiro IDE settings are in reach (under the test runner). */
  settingsPath: string;
  /** Kiro runs its agent's commands in Command Prompt on this Windows machine. */
  commandPrompt: boolean;
  /** The default profile's name as the settings file has it, or null for Kiro's default (PowerShell). */
  profile: string | null;
  /** False when the file is there but is not one JSONC object AI-DLC can edit. */
  readable: boolean;
};

// A value a project's .env file sets is not the person's (Bun loads .env).
function hostValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && !setByDotenvFile(name) ? value : undefined;
}

// The key is Kiro's on Windows only. Tests that point AI-DLC at a settings file
// of their own also name the platform that file belongs to.
function kiroPlatform(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.Platform {
  const seamed = hostValue(env, "AIDLC_TEST_KIRO_IDE_SETTINGS") && hostValue(env, "AIDLC_TEST_KIRO_IDE_PLATFORM");
  return (seamed as NodeJS.Platform | undefined) ?? platform;
}

/** Whether Kiro's terminal setting applies here: Kiro reads it on Windows only. */
export function kiroTerminalApplies(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return kiroPlatform(env, platform) === "win32";
}

function runsCommandPrompt(path: unknown): boolean {
  const paths = Array.isArray(path) ? path : [path];
  return paths.some((entry) =>
    typeof entry === "string" &&
    /^cmd(?:\.exe)?$/i.test(entry.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? ""));
}

/** Whether Kiro's default terminal profile is Command Prompt: by its built-in
 *  name, or a profile of the person's own whose program is cmd.exe. */
function profileIsCommandPrompt(text: string, profile: string): boolean {
  if (profile.trim().toLowerCase() === "command prompt") return true;
  const profiles = jsoncSettingValue(text, KIRO_TERMINAL_PROFILES);
  if (!profiles || typeof profiles !== "object") return false;
  const entry = (profiles as Record<string, unknown>)[profile];
  return Boolean(entry && typeof entry === "object" && runsCommandPrompt((entry as { path?: unknown }).path));
}

export function readKiroIdeTerminal(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): KiroIdeTerminal {
  const settingsPath = kiroIdeUserSettingsPath(env, platform);
  if (settingsPath === null) return { settingsPath: "", commandPrompt: false, profile: null, readable: true };
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf-8");
  } catch {
    return { settingsPath, commandPrompt: false, profile: null, readable: true };
  }
  if (text.trim() && !jsoncRootMembers(text)) return { settingsPath, commandPrompt: false, profile: null, readable: false };
  const value = text.trim() ? jsoncSettingValue(text, KIRO_TERMINAL_SETTING) : undefined;
  const profile = typeof value === "string" && value.trim() ? value : null;
  return {
    settingsPath,
    commandPrompt: kiroTerminalApplies(env, platform) && profile !== null && profileIsCommandPrompt(text, profile),
    profile,
    readable: true,
  };
}

/**
 * Set Kiro IDE's default terminal profile to PowerShell, changing only that
 * one key: every other byte of the person's settings file stays.
 */
export function setKiroIdeTerminalPowerShell(
  env: NodeJS.ProcessEnv = process.env,
): { settingsPath: string; changed: boolean } {
  const settingsPath = kiroIdeUserSettingsPath(env);
  if (settingsPath === null) throw new Error("Kiro IDE's settings are not available here");
  const text = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : "";
  if (text.trim() && !jsoncRootMembers(text)) throw new Error(unreadableSettingsMessage(settingsPath));
  const current = text.trim() ? jsoncSettingValue(text, KIRO_TERMINAL_SETTING) : undefined;
  if (current === KIRO_TERMINAL_POWERSHELL) return { settingsPath, changed: false };
  const value = JSON.stringify(KIRO_TERMINAL_POWERSHELL);
  const next = current === undefined
    ? insertJsoncSetting(text, KIRO_TERMINAL_SETTING, value)
    : replaceJsoncSetting(text, KIRO_TERMINAL_SETTING, value);
  if (next === null) throw new Error(unreadableSettingsMessage(settingsPath));
  mkdirSync(dirname(settingsPath), { recursive: true });
  // A settings file linked from elsewhere stays a link: the write goes to the file it points to.
  writeFileAtomic(existsSync(settingsPath) ? realpathSync(settingsPath) : settingsPath, next);
  return { settingsPath, changed: true };
}

function unreadableSettingsMessage(settingsPath: string): string {
  return `${settingsPath} is not a settings file AI-DLC can edit, so Kiro's terminal was not set to PowerShell. ` +
    "In Kiro, run Terminal: Select Default Profile from the Command Palette (Ctrl+Shift+P) and choose PowerShell " +
    "instead, then restart Kiro.";
}

export function kiroTerminalAnswerPath(): string {
  return join(installRoot(), KIRO_TERMINAL_ANSWER_FILE);
}

export function readKiroTerminalAnswer(): KiroTerminalAnswer | null {
  try {
    const value = readFileSync(kiroTerminalAnswerPath(), "utf-8").trim();
    return (ANSWERS as readonly string[]).includes(value) ? value as KiroTerminalAnswer : null;
  } catch {
    return null;
  }
}

export function recordKiroTerminalAnswer(answer: KiroTerminalAnswer): void {
  const path = kiroTerminalAnswerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${answer}\n`);
}

/** Kiro's terminal is Command Prompt and the person was never asked on this machine. */
export function kiroTerminalQuestionDue(env: NodeJS.ProcessEnv = process.env): boolean {
  return readKiroIdeTerminal(env).commandPrompt && readKiroTerminalAnswer() === null;
}

export const KIRO_TERMINAL_QUESTION =
  "Kiro runs its agent's commands in Command Prompt, your default terminal. AI-DLC's commands are written for " +
  "PowerShell, and in Command Prompt your words can get split and every command looks like it failed. Set " +
  "Kiro's terminal to PowerShell? It is a Kiro setting for all your projects.";

/** The line after AI-DLC set Kiro's terminal to PowerShell. */
export function kiroTerminalSetLine(): string {
  return "Set Kiro's terminal to PowerShell (a Kiro setting for all your projects). Restart Kiro so its chats use it.";
}

/** The line after the person kept their terminal at a question. */
export function kiroTerminalKeptLine(invoke: string): string {
  return "Kept Kiro's terminal as it is; AI-DLC will not ask again. To switch later: " +
    `\`${invoke} config trust --kiro-terminal powershell\`.`;
}

export function kiroTerminalIssueMessage(): string {
  return "Kiro runs its agent's commands in Command Prompt, where AI-DLC's commands can split your words and " +
    "every command looks like it failed";
}

export function kiroTerminalFix(invoke: string): string {
  return `ask the agent to set Kiro's terminal to PowerShell, or run \`${invoke} config trust --kiro-terminal powershell\` ` +
    "(a Kiro setting for all your projects); then restart Kiro";
}

/**
 * The one chat line a Kiro IDE chat gives the agent while Kiro's terminal is
 * Command Prompt and the person was never asked on this machine, or "". Asking
 * counts as their answer: a "no" is simply not acting, and no chat asks again.
 */
export function kiroIdeTerminalAsk(invoke: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!insideKiroIde(env) || !kiroTerminalQuestionDue(env)) return "";
  try {
    recordKiroTerminalAnswer("asked");
  } catch {
    // Not asked rather than asked in every chat.
    return "";
  }
  return "ASK ONCE: after you answer the person's message, ask them this in their language: " +
    "\"Kiro runs my commands in Command Prompt here, where AI-DLC's commands can split your words. Do you want " +
    "me to set Kiro's terminal to PowerShell? It is a Kiro setting for all your projects.\" On yes, run " +
    `\`${invoke} config trust --kiro-terminal powershell --yes\` and tell them what it prints. On no, leave it. ` +
    "Do not ask again.";
}
