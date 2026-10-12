// Kiro IDE's terminal on Windows. Kiro runs its agent's shell tool (still named
// execute_pwsh) in the person's default terminal profile. When that is Command
// Prompt, AI-DLC's PowerShell-shaped commands split the person's words at their
// single quotes, every command reports exit code -1 whether it worked or not,
// and the result carries the echoed command and the prompt path (measured live
// on Kiro IDE 1.2.37, #2167). Kiro itself recommends PowerShell. The default
// profile is the person's own setting for all their projects, so AI-DLC sets it
// only when they say yes, and keeps their answer once per machine.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { insertJsoncSetting, jsoncRootMembers, jsoncSettingValue, replaceJsoncSetting } from "./aidlc-distribution.ts";
import { installRoot } from "./aidlc-install-paths.ts";
import { setByDotenvFile } from "./aidlc-kiro-session.ts";
import { insideKiroIde, kiroIdeUserSettingsPath } from "./aidlc-kiro-ide-workflows.ts";
import { writeFileAtomic } from "./aidlc-lib.ts";
import { isCompiledExecutable } from "./aidlc-runtime-paths.ts";

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

// What breaks, measured on Kiro IDE 1.2.37: without shell integration, which
// cmd.exe never has, Kiro reads a command's result one second after sending it
// and shows exit code -1 for every run; AI-DLC's steps take one to seven
// seconds and print their reply at the end, so most replies come back empty.
export const KIRO_TERMINAL_QUESTION =
  "Kiro runs its agent's commands in Command Prompt, your default terminal. In Command Prompt most AI-DLC steps come " +
  "back with no reply and your words can get split. Set Kiro's terminal to PowerShell? It is a Kiro setting for all " +
  "your projects.";

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
  return "Kiro runs its agent's commands in Command Prompt, where most AI-DLC steps come back with no reply and your " +
    "words can get split";
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

/**
 * The mechanics every Kiro IDE chat gets while Kiro's terminal is Command
 * Prompt, whatever the person answered: what an empty result means, how to
 * quote in this shell, and the one command that sets PowerShell when the
 * person asks for it. A fact line, never a question; "" everywhere else.
 */
export function kiroIdeTerminalStandingLine(invoke: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!insideKiroIde(env) || !readKiroIdeTerminal(env).commandPrompt) return "";
  // Live, the agent read a PowerShell command that ran from this terminal as
  // proof the terminal was PowerShell, and "do not raise it" as "do not do it".
  return "Kiro runs your commands in Command Prompt here (your shell tool is still named execute_pwsh and PowerShell " +
    "commands run from it, but the terminal they run in is Command Prompt). It hands you a command's reply only when " +
    "the command finishes within a second: an AI-DLC result that holds only the echoed command and `Exit Code: -1` is " +
    "a command that was still running when Kiro read the result, not a failure and not a lock. Write values in double " +
    "quotes in this shell. When the person asks to set Kiro's terminal to PowerShell, the one way is to run " +
    `\`${invoke} config trust --kiro-terminal powershell --yes\` and tell them what it prints; unless they ask, say ` +
    "nothing about it.";
}

// Kiro's Command Prompt terminal reads a command's result one second after
// sending it (Kiro IDE 1.2.37, measured), so a tool that ran longer lost its
// reply for certain. The engine notes that at exit (the dropped marker); the
// next hook run in the chat tells the person once (the warned marker), and
// neither says anything again on this machine.
const KIRO_TERMINAL_SNAPSHOT_MS = 1000;
export const KIRO_TERMINAL_DROPPED_FILE = "kiro-ide-terminal-dropped";
export const KIRO_TERMINAL_WARNED_FILE = "kiro-ide-terminal-warned";
export const KIRO_TERMINAL_SHELL_FILE = "kiro-ide-terminal-shell";

/**
 * Which shell the running Kiro IDE's terminal is, as the chat's hook saw it
 * (the hook has the running Kiro's user data; the agent's own commands do
 * not, so a portable Kiro or a custom user data folder would otherwise be
 * read from Kiro's default folder). Written at every chat start on Windows.
 */
export function recordKiroTerminalShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (!insideKiroIde(env) || !kiroTerminalApplies(env, platform)) return;
  const path = join(installRoot(), KIRO_TERMINAL_SHELL_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${readKiroIdeTerminal(env, platform).commandPrompt ? "cmd" : "powershell"}\n`);
}

/** "cmd" or "powershell" as the last chat start recorded it, or null before any chat recorded it. */
export function readKiroTerminalShell(): "cmd" | "powershell" | null {
  try {
    const value = readFileSync(join(installRoot(), KIRO_TERMINAL_SHELL_FILE), "utf-8").trim();
    return value === "cmd" || value === "powershell" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Note a tool run Kiro's Command Prompt terminal could not have shown: over a
 * second, in Kiro's terminal (TERM_PROGRAM=kiro; the agent's commands carry no
 * VSCODE_CODE_CACHE_PATH, so the settings come from Kiro's default folder),
 * for a person who kept Command Prompt or was asked and did not act. Nothing is
 * noted before the question was asked, after the switch, or once warned.
 */
export function noteSlowReply(
  elapsedMs: number,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (elapsedMs <= KIRO_TERMINAL_SNAPSHOT_MS || !inCommandPromptTerminal(env, platform)) return;
  const answer = readKiroTerminalAnswer();
  if (answer !== "kept" && answer !== "asked") return;
  const root = installRoot();
  if (existsSync(join(root, KIRO_TERMINAL_WARNED_FILE))) return;
  try {
    mkdirSync(root, { recursive: true });
    writeFileAtomic(join(root, KIRO_TERMINAL_DROPPED_FILE), `${new Date().toISOString()}\n`);
  } catch {
    // Not noted rather than a failed tool run.
  }
}

/**
 * This process runs in Kiro IDE's terminal (TERM_PROGRAM=kiro; the chat's hooks
 * carry no TERM_PROGRAM) and that terminal is Command Prompt: as the chat's hook
 * recorded it, or before any chat recorded it, as Kiro's default settings folder
 * says (the agent's commands carry no VSCODE_CODE_CACHE_PATH).
 */
export function inCommandPromptTerminal(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (hostValue(env, "TERM_PROGRAM") !== "kiro") return false;
  const recorded = readKiroTerminalShell();
  return recorded !== null
    ? recorded === "cmd"
    : kiroTerminalApplies(env, platform) && readKiroIdeTerminal(env, platform).commandPrompt;
}

/**
 * The quote pair Command Prompt left on the words. cmd.exe passes single quotes
 * on as characters, so a value written for PowerShell (`'fix the greeter'`)
 * arrives as several arguments, the quotes stuck to the first and the last. The
 * pair a shell should have eaten is structure, not meaning: in Kiro's Command
 * Prompt terminal each group from an argument that opens with `'` to the first
 * that closes with `'` becomes one argument without that one pair. An opener
 * with no closer (`'tis`), and every other argument, stay as they came.
 */
export function rejoinCommandPromptQuotes(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!args.some((arg) => arg.startsWith("'")) || !inCommandPromptTerminal(env, platform)) return [...args];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("'")) {
      out.push(args[i]);
      continue;
    }
    let close = i;
    while (close < args.length && !(args[close].endsWith("'") && (close > i || args[close].length >= 2))) close++;
    if (close === args.length) {
      out.push(args[i]);
      continue;
    }
    out.push(args.slice(i, close + 1).join(" ").slice(1, -1));
    i = close;
  }
  return out;
}

export const KIRO_REPLY_TEE_ENV = "AIDLC_CMD_REPLY_TEE";
export const KIRO_REPLY_DIR = join("aidlc", ".aidlc-sessions", "replies");
const KIRO_REPLIES_KEPT = 20;

/**
 * The same command again, as a child. Under bun the script path is argv[1] and
 * stays; in the compiled binary argv is ["bun", "/$bunfs/root/<entry>", ...args]
 * (measured with `bun build --compile`), so the embedded entry is dropped and the
 * binary gets its own arguments back.
 */
export function commandPromptChildCommand(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
  compiled: boolean = isCompiledExecutable(),
): string[] {
  return [execPath, ...argv.slice(compiled ? 2 : 1)];
}

// Kiro reads the terminal one second after sending the command. The child's
// output is held for a little longer than that, then relayed as it comes: the
// agent's result keeps the shape the live run proved (the pointer alone, or the
// pointer and the whole reply when the command finished within the second),
// while a question a command asks on the terminal shows a moment later instead
// of never, and a person at Kiro's own terminal panel can answer it.
const KIRO_RELAY_HOLD_MS = 1500;

/**
 * Relay the child's stdout and stderr to this process's (held for the first
 * KIRO_RELAY_HOLD_MS, flushed at once when the child exits sooner), keeping a
 * copy of both streams for the reply file.
 */
export async function relayCommandPromptChild(
  child: ReturnType<typeof Bun.spawn>,
  holdMs: number = KIRO_RELAY_HOLD_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let holding = true;
  const held: Array<[number, Uint8Array]> = [];
  const release = (): void => {
    holding = false;
    for (const [fd, chunk] of held.splice(0)) writeSync(fd, chunk);
  };
  const timer = setTimeout(release, holdMs);
  const relay = async (stream: ReadableStream<Uint8Array>, fd: number): Promise<string> => {
    const parts: Uint8Array[] = [];
    for await (const chunk of stream) {
      if (holding) held.push([fd, chunk]);
      else writeSync(fd, chunk);
      parts.push(chunk);
    }
    return Buffer.concat(parts).toString();
  };
  const [stdout, stderr] = await Promise.all([
    relay(child.stdout as ReadableStream<Uint8Array>, 1),
    relay(child.stderr as ReadableStream<Uint8Array>, 2),
  ]);
  clearTimeout(timer);
  release();
  return { code: await child.exited, stdout, stderr };
}

/**
 * Kiro's Command Prompt terminal hands the agent what a command printed within
 * a second and drops the rest. So in that terminal, in a project with an
 * `aidlc/` folder, a tool prints one pointer line first, runs itself as a child
 * process (the engine writes its reply straight to fd 1, so nothing in-process
 * can copy it), relays the child's output and writes it to the file the pointer
 * names under `aidlc/.aidlc-sessions/` (gitignored, per-user scratch, the newest
 * twenty kept) when the child exits. The agent reads the file when its result
 * ends at the pointer, instead of running the command again. Resolves false,
 * having done nothing, everywhere else and in the child; otherwise it exits
 * with the child's code.
 */
export async function commandPromptReplyTee(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (env[KIRO_REPLY_TEE_ENV] === "1" || !inCommandPromptTerminal(env, platform)) return false;
  const project = process.cwd();
  if (!existsSync(join(project, "aidlc"))) return false;
  const replies = resolve(project, KIRO_REPLY_DIR);
  const file = join(KIRO_REPLY_DIR, `${Date.now().toString(36)}-${process.pid}.txt`).replace(/\\/g, "/");
  const command = commandPromptChildCommand();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    mkdirSync(replies, { recursive: true });
    for (const old of readdirSync(replies).sort().slice(0, -(KIRO_REPLIES_KEPT - 1))) rmSync(join(replies, old), { force: true });
    child = Bun.spawn(command, {
      cwd: project,
      env: { ...env, [KIRO_REPLY_TEE_ENV]: "1" },
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return false;
  }
  writeSync(
    1,
    `AI-DLC reply: ${file} (Command Prompt shows a reply only when it is ready within a second; when this result ends here, ` +
      "the command is still running: read that file, which appears when it finishes)\n",
  );
  const started = performance.now();
  const result = await relayCommandPromptChild(child);
  try {
    writeFileAtomic(resolve(project, file), `# ${command.slice(1).join(" ")}\n${result.stdout}${result.stderr}`);
  } catch {
    // The reply reached the terminal; the file is the copy.
  }
  noteSlowReply(performance.now() - started, env, platform);
  process.exit(result.code);
}

/** Called once as a tool starts: at exit it notes a run Kiro's Command Prompt terminal dropped. Nothing outside Kiro's terminal on Windows. */
export function noteSlowReplyAtExit(env: NodeJS.ProcessEnv = process.env): void {
  if (hostValue(env, "TERM_PROGRAM") !== "kiro" || process.platform !== "win32") return;
  process.on("exit", () => {
    try {
      noteSlowReply(performance.now(), env);
    } catch {
      // Not noted rather than a failed exit.
    }
  });
}

/**
 * The one line for the person after Kiro's Command Prompt terminal dropped a
 * reply, said by the next hook run in a Kiro IDE chat and never again on this
 * machine: a warning with no question, so their next message stays theirs.
 */
export function kiroTerminalBreakWarning(env: NodeJS.ProcessEnv = process.env): string {
  if (!insideKiroIde(env) || !readKiroIdeTerminal(env).commandPrompt) return "";
  const root = installRoot();
  const dropped = join(root, KIRO_TERMINAL_DROPPED_FILE);
  if (!existsSync(dropped) || existsSync(join(root, KIRO_TERMINAL_WARNED_FILE))) return "";
  try {
    writeFileAtomic(join(root, KIRO_TERMINAL_WARNED_FILE), `${new Date().toISOString()}\n`);
    rmSync(dropped, { force: true });
  } catch {
    return "";
  }
  return "Tell the person this once, in their language, then go on with their request: \"Kiro's Command Prompt " +
    "terminal is cutting off AI-DLC's replies, so steps here take extra turns. Tell me if you want Kiro's terminal " +
    "set to PowerShell, which avoids this.\"";
}
