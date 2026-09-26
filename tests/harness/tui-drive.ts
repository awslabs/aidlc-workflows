// tui-drive.ts — drive an interactive TUI (e.g. `claude`) and SEE what a real
// user sees in the terminal — statusline, prompts, slash-command output —
// without headless (`--print`) mode.
//
// Test harness / dev-only tooling. Lives in tests/harness/ beside its SDK
// sibling sdk-drive.ts (logic vs render), assert.ts, and fixtures.ts — NOT in
// the shipped dist/claude/.claude/tools/ distributable. (Relocated from
// the repo-root tools/aidlc-tui-drive.ts spike; the aidlc- prefix is dropped to
// match sdk-drive.ts.)
//
// This is the deterministic half of the harness ("three concerns, three
// mechanisms": the send/capture/assert loop is a tool; the thing it drives
// is the LLM-under-test). It does no reasoning — it scripts keystrokes and
// pattern-matches the rendered pane.
//
// ---------------------------------------------------------------------------
// Native Bun.Terminal on Linux / Windows / macOS. Select explicitly with
// AIDLC_TUI_BACKEND=bun|tmux (auto is the platform default).
// Native sessions use an inline PTY, an owned supervisor and @xterm/headless.
// Each CLI invocation talks to the persistent daemon over framed local IPC.
// tmux remains available for POSIX compatibility.
//
// Shared subcommands (native-only additions are labelled):
//   start  --session <name> --cwd <dir> [--width N] [--height N] -- <cmd...>
//          Launch <cmd> in a fresh session of a fixed size.
//   send   --session <name> --keys "<text>" [--literal] [--no-enter]
//          Type keys into the session (Enter appended unless --no-enter).
//          --literal sends the string verbatim for free text / slash commands;
//          omit it for named keys (Enter, Down, C-c).
//   wait   --session <name> --pattern <regex> [--timeout-ms N] [--stable-ms N]
//          [--view auto|physical|logical]
//          Poll the captured grid until <regex> appears. With --stable-ms > 0 the
//          screen must also be unchanged for that long (use for static menus
//          / prompts). With --stable-ms 0 it matches the instant the pattern
//          appears (use when the screen is actively streaming — the statusline
//          token counter / spinner means it never goes byte-stable).
//          Exits 0 on match, 1 on timeout.
//   startup --session <name> --ready-pattern <regex> [--timeout-ms N]
//          [--view auto|physical|logical]
//          One bounded grid-driven startup loop for Claude: dismiss a visible
//          supported trust / bypass modal, or return immediately once the
//          caller's ready UI/statusline pattern is painted. Exits 1 on timeout.
//   capture --session <name> [--physical | --ansi | --json]
//          Current viewport; ANSI supported by Bun/tmux, full cells by Bun.
//          Plain text defaults to joined logical lines; --physical keeps rows.
//          Menus always inspect physical rows. Wait/readiness patterns default
//          to physical-first with logical fallback from the same frame.
//   resize --session <name> --width N --height N
//          Resize the native PTY and emulator together.
//   paste --session <name> --text "<text>"
//          Native paste honours bracketed-paste mode; no implicit Enter.
//   kill   --session <name>
//          Kill the session (idempotent).
//   wait-dead --session <name> [--timeout-ms N]
//          Poll the backend until the session process tree is gone. Exits 1 if
//          any tracked process survives the bound.
//          With --timeout-ms 0, native records are observed once without RPC
//          waiting. A recorded daemon needing an OS probe remains unconfirmed;
//          missing sessions and completed launches with no daemon can pass.
//   answer-gate --session <name> --project-dir <dir>
//          [--per-gate-timeout-ms N] [--overall-timeout-ms N]
//          [--until-file <relpath>] [--until-state-field <name=regex>]
//          [--also-state-field <name=regex>]
//          [--assert-file-absent-at-option <label>
//           --assert-file-absent <relpath>]
//          [--reject-first-gate] [--stop-at-approval-gate]
//          Answer an AI-DLC AskUserQuestion gate sequence by taking the
//          Recommended default on each tab/menu (Enter per tab; Enter again on
//          the Submit screen), terminating on an ON-DISK signal — never on the
//          screen (§3, D-TUI-3).
//            --reject-first-gate           On the FIRST approval gate (a single-
//                                          select menu containing "Request
//                                          Changes"), select that option instead of
//                                          "Approve" (Down → Enter), then supply the
//                                          free-text revision feedback the
//                                          orchestrator asks for next, then revert to
//                                          approve-only — drives one reject→revise→
//                                          approve cycle (t128 revision-loop). The
//                                          "Request changes" label distinguishes the
//                                          gate from the clarifying-question menus
//                                          that precede it.
//            --stop-at-approval-gate       Answer preparatory menus, then return
//                                          with the first numbered Approve /
//                                          Request Changes gate still painted
//                                          and unanswered.
//          The TERMINATOR is pluggable so the SAME keystroke loop drives ANY gated
//          journey, not just the workshop:
//            --until-file <relpath>        STOP when this file (relative to
//                                          --project-dir; a `*` globs one segment)
//                                          exists & is non-empty — e.g. a stage's
//                                          intent-statement or filled questions file.
//            --until-state-field <n=re>    STOP when aidlc-state.md's `- **<n>**:`
//                                          line value matches /re/ — e.g.
//                                          `Status=Completed`.
//            --also-state-field <n=re>     With --until-state-field, STOP only
//                                          when BOTH state fields match. Approve
//                                          writes Last Completed Stage before
//                                          handleAdvance writes Current Stage
//                                          (aidlc-state.ts:5719 and :4506;
//                                          verified 2026-09-13). Wait for both to
//                                          avoid stopping in that two-write window.
//            --assert-file-absent-at-option <label>
//            --assert-file-absent <relpath>
//                                          When the named option is first painted,
//                                          assert the relative file/glob does not
//                                          exist. The flags must be supplied
//                                          together. The run also fails if the
//                                          option is never observed.
//            (neither)                     STOP on the practices-affirmation
//                                          timestamp (the workshop default;
//                                          existing callers unchanged).
//          One implementation, both backends: it only drives capture + send. The
//          screen DETECTS a waiting menu; the disk signal TERMINATES the loop (the
//          transcript is not a leading event bus — §1.1). The per-gate/overall
//          timeouts are HANG BACKSTOPS: on expiry it ERRORs loud (exit 1), never
//          "concludes done".
//
// Exit codes: 0 success, 1 wait-timeout / assertion miss, 2 usage/spawn error.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { stateFilePathFor } from "./sdk-drive.ts";
import { createBunBackend } from "./tui-bun-backend.ts";
import { nativeCleanupDeadlineMs } from "./tui-bun-process.ts";
import { selectedTuiBackend } from "./tui-runtime.ts";
import { tuiOperationDeadline } from "./tui-time-budget.ts";
import type { TuiSnapshot, TuiTextLayout, TuiTextViews } from "./tui-screen.ts";
import {
  remainingCleanupTimeoutMs,
  LIVE_COMMAND_TIMEOUT_MS,
  LIVE_STARTUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  TestBudgetExhaustedError,
} from "./test-budget.ts";

const POLL_INTERVAL_MS = 150;
const DEFAULT_TIMEOUT_MS = LIVE_COMMAND_TIMEOUT_MS;
const DEFAULT_STABLE_MS = 600;
const DEFAULT_STARTUP_TIMEOUT_MS = LIVE_STARTUP_TIMEOUT_MS;
const DEFAULT_DEAD_TIMEOUT_MS = NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS;
const DEFAULT_TUI_SETTING_SOURCES = "project";
const DEFAULT_ANSWER_GATE_TRACE_POLL_MS = 10_000;

function tuiWorkTimeoutMs(requestedMs: number, phase: string): number {
  // Zero is an immediate TUI poll, not the SDK's "unbounded" convention.
  // Keep that exact contract while checking the shared parent work deadline.
  return Math.min(requestedMs, remainingOperationTimeoutMs(
    Math.max(1, Math.ceil(requestedMs)), { phase, deadlineMs: tuiOperationDeadline.getStore() },
  )!);
}

type Args = {
  positionals: string[];
  flags: Record<string, string>;
  bools: Record<string, boolean>;
  rest: string[]; // everything after a literal `--`
};

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  const bools: Record<string, boolean> = {};
  const positionals: string[] = [];
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        bools[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags, bools, rest };
}

function fail(msg: string, code = 2): never {
  process.stderr.write(`tui-drive: ${msg}\n`);
  process.exit(code);
}

function safeTraceName(s: string): string {
  const safe = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(s).digest("hex").slice(0, 16);
  return `${safe}-${digest}`;
}

function tuiTracePath(session: string): string | undefined {
  if (process.env.AIDLC_TUI_TRACE_FILE) return process.env.AIDLC_TUI_TRACE_FILE;
  if (process.env.AIDLC_TEST_DEBUG === "true" && process.env.AIDLC_TEST_LOG_DIR) {
    return join(process.env.AIDLC_TEST_LOG_DIR, `tui-drive-${safeTraceName(session)}.ndjson`);
  }
  return undefined;
}

function writeTuiTrace(
  session: string,
  event: string,
  data: Record<string, unknown>,
): void {
  const tracePath = tuiTracePath(session);
  if (!tracePath) return;
  mkdirSync(dirname(tracePath), { recursive: true });
  appendFileSync(
    tracePath,
    `${JSON.stringify({ ts: new Date().toISOString(), session, event, ...data })}\n`,
  );
}

// ---------------------------------------------------------------------------
// Resolve a command name to an absolute executable path for native Windows PTY
// launches. POSIX and already resolved paths are returned unchanged.
function resolveWinExecutable(file: string): string {
  if (os.platform() !== "win32") return file;
  // Already an absolute path or one with a directory separator — trust it.
  if (/[\\/]/.test(file) || /^[A-Za-z]:/.test(file)) return file;
  const r = spawnSync("where", [file], { encoding: "utf-8", timeout: tuiWorkTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, "Windows executable lookup") });
  if (r.status === 0) {
    const first = (r.stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) return first.trim();
  }
  // `where` could not resolve it (for example, cmd.exe). Return unchanged so
  // the native launcher reports its own diagnostic.
  return file;
}

export type WindowsLaunchSpec = {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

function escapeCmdArgument(argument: string): string {
  // Quote for CommandLineToArgvW, then protect every cmd.exe metacharacter.
  // This is the focused algorithm used by established Windows spawn adapters.
  let escaped = argument.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, "^$1");
  // Batch shims commonly forward `%*` into another command. Protect the same
  // characters for that second cmd.exe parse as well as the outer /c parse.
  return escaped.replace(CMD_META_CHARS, "^$1");
}

/**
 * Adapt a resolved Windows target without enabling Node's generic shell mode.
 * Batch files require one deliberately quoted cmd.exe command string; PowerShell
 * scripts and ordinary executables retain structured argv.
 */
export function adaptWindowsLaunch(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): WindowsLaunchSpec {
  const lower = file.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const shellCommand = [
      escapeCmdCommand(file),
      ...args.map(escapeCmdArgument),
    ].join(" ");
    return {
      file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${shellCommand}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (lower.endsWith(".ps1")) {
    return {
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        file,
        ...args,
      ],
    };
  }
  return { file, args: [...args] };
}

function requireFlag(a: Args, name: string): string {
  const v = a.flags[name];
  if (!v) fail(`missing required --${name}`);
  return v;
}

function commandBasename(file: string): string {
  return (file.replaceAll("\\", "/").split("/").pop() ?? file).toLowerCase();
}

// Every basename the Claude CLI launches under. npm-on-Windows installs
// `claude.cmd` (and a `claude.ps1` shim) alongside the bare `claude`; missing
// them here would fail OPEN — the command returns unchanged and user-level
// settings leak into a supposedly isolated live TUI run.
const CLAUDE_BASENAMES = new Set(["claude", "claude.exe", "claude.cmd", "claude.ps1"]);

export const TUI_TEST_FIXTURE_MARKER = ".aidlc-tui-fixture.json";

/** Only setupTuiProject's disposable directory, while its owning test is alive. */
export function isOwnedTuiFixture(cwd: string): boolean {
  try {
    const canonical = realpathSync(cwd);
    if (
      dirname(canonical) !== realpathSync(tmpdir()) ||
      !basename(canonical).startsWith("aidlc-tui-")
    ) return false;
    const markerPath = join(canonical, TUI_TEST_FIXTURE_MARKER);
    if (!lstatSync(markerPath).isFile() || lstatSync(markerPath).isSymbolicLink()) {
      return false;
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      marker.cwd !== canonical ||
      !Number.isSafeInteger(marker.ownerPid) ||
      marker.ownerPid <= 0
    ) return false;
    process.kill(marker.ownerPid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Recognize only direct Claude or env's structured, cwd-preserving -u form. */
function claudeCommandIndex(command: string[]): number | null {
  let index = 0;
  if (commandBasename(command[0] ?? "") === "env") {
    index = 1;
    while (command[index] === "-u") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(command[index + 1] ?? "")) return null;
      index += 2;
    }
    // No assignments, -C/--chdir, split strings, nested or unknown wrappers.
    if (index === 1) return null;
  }
  return CLAUDE_BASENAMES.has(commandBasename(command[index] ?? "")) ? index : null;
}

export function claudeFixtureCwd(cwd: string, command: string[]): string | null {
  return claudeCommandIndex(command) !== null && isOwnedTuiFixture(cwd)
    ? realpathSync(cwd)
    : null;
}

function hasSettingSourcesArg(command: string[]): boolean {
  return command.some((arg) => arg === "--setting-sources" || arg.startsWith("--setting-sources="));
}

function tuiSettingSources(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.AIDLC_TUI_SETTING_SOURCES;
  const value = configured === undefined
    ? DEFAULT_TUI_SETTING_SOURCES
    : configured.trim();
  if (value === "" || value === "default") return null;
  return value;
}

/**
 * Keep live TUI runs isolated from developer/user-level Claude settings and
 * hooks by default, mirroring sdk-drive's `settingSources: ["project"]`.
 * Explicit command flags win, and AIDLC_TUI_SETTING_SOURCES=default opts a
 * focused calibration run back into Claude CLI defaults.
 */
export function normalizeTuiCommand(
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (command.length === 0) return command;
  const index = claudeCommandIndex(command);
  if (index === null) return command;
  if (hasSettingSourcesArg(command)) return command;

  const settingSources = tuiSettingSources(env);
  if (!settingSources) return command;

  return [
    ...command.slice(0, index + 1),
    "--setting-sources", settingSources,
    ...command.slice(index + 1),
  ];
}

function answerGateTracePollMs(): number {
  const raw = Number(process.env.AIDLC_TUI_TRACE_POLL_MS ?? DEFAULT_ANSWER_GATE_TRACE_POLL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ANSWER_GATE_TRACE_POLL_MS;
  return Math.max(1_000, raw);
}

// Keep timing independent of runtime-specific sleep APIs.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ---------------------------------------------------------------------------
// Backend contract (§2.3). Both backends satisfy the same operations; the
// CLI dispatch and the `wait` polling loop are backend-agnostic.
// ---------------------------------------------------------------------------

interface Backend {
  /** Launch `cmd` (rest argv) in a fresh session of width x height at cwd. */
  start(
    session: string,
    cwd: string,
    width: number,
    height: number,
    cmd: string[],
  ): void | Promise<void>;
  /** Type keys; Enter is appended unless noEnter. literal sends verbatim. */
  send(
    session: string,
    keys: string,
    literal: boolean,
    noEnter: boolean,
  ): void | Promise<void>;
  /** Public text defaults to logical lines; automation requests physical rows. */
  capture(session: string, ansi: boolean, layout?: TuiTextLayout): string | Promise<string>;
  /** Both text projections of one frame; never independent polling reads. */
  captureViews?(session: string): TuiTextViews | Promise<TuiTextViews>;
  /** Kill the session (idempotent). */
  kill(session: string): void | Promise<void>;
  /** Labels for live backend processes or cleanup-verification blockers. */
  liveProcesses(session: string, deadlineMs?: number): string[] | Promise<string[]>;
  snapshot?(session: string): Promise<TuiSnapshot>;
  resize?(session: string, width: number, height: number): Promise<void>;
  paste?(session: string, text: string): Promise<void>;
  /** Disposable fixture recorded when this session launched Claude. */
  fixtureCwd(session: string): string | null;
}

// ---------------------------------------------------------------------------
// tmux backend (darwin / linux).
// ---------------------------------------------------------------------------

// PRIVATE tmux server socket — the harness runs on its OWN tmux server, never
// the default one the developer's interactive shell is attached to. Without this
// (`spawnSync("tmux", args)` with no `-L`), every harness new-session/kill-session
// lands on the DEFAULT server alongside the user's live session — so server-level
// resource pressure, or a kill targeting a stale name, can take down the session
// the developer is working in (observed: crashes that needed a restart). A fixed
// private label isolates all harness sessions onto a dedicated server; the serial
// tui tests share that one private server among themselves (they already run
// serially), and it can never touch the default server. Override with
// AIDLC_TUI_TMUX_SOCKET if a test needs its own server. The socket name is stable
// across the per-subcommand driver invocations (start/send/capture/kill are
// separate processes that must reach the SAME server), so it is NOT per-PID.
const TMUX_SOCKET = process.env.AIDLC_TUI_TMUX_SOCKET || "aidlc-tui";

function tmux(args: string[], deadlineMs?: number): { code: number; stdout: string; stderr: string } {
  // `-L <socket>` MUST precede the tmux command; it selects the private server.
  const r = spawnSync("tmux", ["-L", TMUX_SOCKET, ...args], { encoding: "utf-8", timeout: deadlineMs !== undefined
    ? remainingCleanupTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { deadlineMs })
    : args[0] === "kill-session" || args[0] === "kill-server" || tuiOperationDeadline.getStore() === undefined
    ? remainingCleanupTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)
    : tuiWorkTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, "tmux operation") });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr || r.error?.message || (r.signal ? `tmux terminated by ${r.signal}` : ""),
  };
}

const tmuxBackend: Backend = {
  start(session, cwd, width, height, cmd) {
    if (cmd.length === 0) fail("no command after `--` to run in the session");

    // Kill any stale session of the same name first (idempotent start).
    tmux(["kill-session", "-t", session]);

    // Build a single shell command so cwd + the target command run in one PTY.
    // We cd then exec so the child replaces the shell (clean kill semantics).
    const inner = cmd.map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(" ");
    const shellCmd = `cd '${cwd.replaceAll("'", "'\\''")}' && exec ${inner}`;

    const r = tmux([
      "new-session",
      // Parallel fixtures use independent profiles. An existing tmux server
      // retains its original environment, so pass this value per session.
      ...(process.env.CLAUDE_CONFIG_DIR ? ["-e", `CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}`] : []),
      "-d",
      "-s",
      session,
      "-x",
      String(width),
      "-y",
      String(height),
      "bash",
      "-lc",
      shellCmd,
    ]);
    if (r.code !== 0) fail(`new-session failed: ${r.stderr.trim()}`);
    const fixture = claudeFixtureCwd(cwd, cmd);
    if (fixture) {
      const recorded = tmux(["set-option", "-t", session, "@aidlc-tui-fixture", fixture]);
      if (recorded.code !== 0) fail(`cannot record fixture session: ${recorded.stderr.trim()}`);
    }
    process.stdout.write(`started session '${session}' (${width}x${height})\n`);
  },

  fixtureCwd(session) {
    const result = tmux(["show-options", "-v", "-t", session, "@aidlc-tui-fixture"]);
    return result.code === 0 ? result.stdout.trim() || null : null;
  },

  send(session, keys, literal, noEnter) {
    // --literal (-l) sends the string verbatim, so free text containing spaces
    // or words that collide with tmux key names ("Enter", "Space", "C-c") is
    // typed as-is rather than interpreted. Use it for prompts / slash commands;
    // omit it for named keys (Enter, Down, C-c).
    const sendArgs = ["send-keys", "-t", session];
    if (literal) sendArgs.push("-l");
    sendArgs.push(keys);
    const r = tmux(sendArgs);
    if (r.code !== 0) fail(`send-keys failed: ${r.stderr.trim()}`, 1);
    if (!noEnter) {
      tmux(["send-keys", "-t", session, "Enter"]);
    }
  },

  capture(session, ansi, layout = "logical") {
    // -J is public logical capture compatibility, never automation's grid.
    const args = ["capture-pane", "-t", session, "-p"];
    if (layout === "logical") args.push("-J");
    if (ansi) args.push("-e");
    const r = tmux(args);
    if (r.code !== 0) fail(`capture-pane failed: ${r.stderr.trim()}`, 1);
    return r.stdout;
  },

  captureViews(session) {
    const separator = `aidlc-frame-${randomUUID()}`;
    // These synchronous commands drain together in one tmux server queue turn.
    // Do not make two client calls: a repaint could fall between the views.
    const result = tmux([
      "capture-pane", "-t", session, "-p", ";",
      "display-message", "-p", separator, ";",
      "capture-pane", "-t", session, "-p", "-J",
    ]);
    if (result.code !== 0) fail(`capture-pane failed: ${result.stderr.trim()}`, 1);
    const views = result.stdout.split(`${separator}\n`);
    if (views.length !== 2) fail("tmux capture returned an ambiguous frame boundary", 1);
    return { physical: views[0], logical: views[1] };
  },

  kill(session) {
    tmux(["kill-session", "-t", session]); // idempotent; ignore errors
  },

  liveProcesses(session, deadlineMs) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return [`unconfirmed-tmux-session:${session}`];
    const r = tmux(["has-session", "-t", session], deadlineMs);
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return [`unconfirmed-tmux-session:${session}`];
    if (r.code === 0) return [`tmux-session:${session}`];
    if (/can't find session|no server running|no such file/i.test(r.stderr)) return [];
    return [`unconfirmed-tmux-session:${session}`];
  },
};


// Claude keeps .claude.json inside an explicit CLAUDE_CONFIG_DIR; without the
// override it uses the legacy home-level file. Explicit inputs let synthetic
// checks exercise the Windows preseed without changing the host environment.
export function preseedClaudeOnboarding(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  trustProject = true,
): void {
  try {
    const configDir = env.CLAUDE_CONFIG_DIR || homeDir;
    mkdirSync(configDir, { recursive: true });
    const cfgPath = join(configDir, ".claude.json");
    let cfg: Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      } catch {
        cfg = {};
      }
    }
    cfg.hasCompletedOnboarding = true;
    if (trustProject) {
      const projects =
        (cfg.projects as Record<string, unknown> | undefined) ?? {};
      // Forward-slash key — Claude normalises project paths this way.
      const key = projectDir.replaceAll("\\", "/");
      if (!(key in projects)) projects[key] = { hasTrustDialogAccepted: true };
      cfg.projects = projects;
    }
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch {
    // best-effort preseed; the interactive path still answers modals by keystroke
  }
}

// ---------------------------------------------------------------------------
// Backend selection — the one os.platform() switch. Everything above the line
// is platform-agnostic.
// ---------------------------------------------------------------------------

function selectBackend(): Backend {
  const selected = selectedTuiBackend();
  if (selected === "bun") {
    if (process.platform !== "linux" && process.platform !== "win32" && process.platform !== "darwin") {
      fail(`native lifecycle is unsupported on ${process.platform}; select AIDLC_TUI_BACKEND=tmux`);
    }
    return createBunBackend({
      fixtureCwd: claudeFixtureCwd,
      windowsCommand(command) {
        return adaptWindowsLaunch(resolveWinExecutable(command[0]), command.slice(1), process.env);
      },
    });
  }
  if (process.platform === "win32") fail("tmux backend requires POSIX");
  return tmuxBackend;
}

// ---------------------------------------------------------------------------
// Subcommands — backend-agnostic. `wait`'s polling loop lives here so its
// --stable-ms semantics are identical on both backends (§2.3).
// ---------------------------------------------------------------------------

async function cmdStart(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const cwd = requireFlag(a, "cwd");
  const width = Number(a.flags.width ?? "120");
  const height = Number(a.flags.height ?? "40");
  const command = normalizeTuiCommand(a.rest);
  if (
    process.env.AIDLC_TEST_WORKER_ROOT &&
    process.env.CLAUDE_CONFIG_DIR &&
    claudeFixtureCwd(cwd, command)
  ) {
    // A fresh worker profile otherwise stops at Claude's first-run theme
    // chooser. Preserve the real trust dialog that these journeys already
    // drive, while keeping first-run setup inside the disposable profile.
    preseedClaudeOnboarding(cwd, process.env, os.homedir(), false);
  }
  if (process.platform === "win32" && selectedTuiBackend() === "bun" && claudeFixtureCwd(cwd, command)) {
    preseedClaudeOnboarding(cwd);
  }
  writeTuiTrace(session, "start", {
    cwd,
    width,
    height,
    command,
    requestedCommand: command.join("\0") === a.rest.join("\0") ? undefined : a.rest,
  });
  await backend.start(session, cwd, width, height, command);
}

async function cmdSend(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const keys = requireFlag(a, "keys");
  // Existing journeys request the old numbered trust choice. Adapt that request
  // only while the known fixture's actual trust menu is visible.
  if (
    keys === "1" && !a.bools.literal && !a.bools["no-enter"] &&
    backend.fixtureCwd(session) &&
    await acceptTuiFixtureTrust(backend, session, await backend.capture(session, false, "physical"))
  ) return;
  if (
    keys === "2" && !a.bools.literal && !a.bools["no-enter"] &&
    backend.fixtureCwd(session) &&
    await acceptTuiFixturePermissionMode(backend, session, await backend.capture(session, false, "physical"))
  ) return;
  writeTuiTrace(session, "send", {
    keys,
    literal: a.bools.literal === true,
    noEnter: a.bools["no-enter"] === true,
  });
  await backend.send(session, keys, a.bools.literal === true, a.bools["no-enter"] === true);
}

/** Preserve the shipped model pin when a fresh profile shows an upgrade offer. */
export function claudeModelUpgradeNavigation(screen: string): "Up" | "Down" | "Enter" | null {
  if (
    /\[AIDLC\]/.test(screen) ||
    !/^\s*Newer .+ model available\s*$/m.test(screen) ||
    !/Currently pinned:/.test(screen) || !/Latest available:/.test(screen) ||
    !/Update settings to use .+\? Claude Code will restart to apply\./.test(screen)
  ) return null;
  const options = screen.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(❯\s*)?(?:\d+\.\s*)?(Yes|No)\s*$/.exec(line);
    return match ? [{ selected: !!match[1], no: match[2] === "No" }] : [];
  });
  if (
    options.length !== 2 || options.filter((option) => option.no).length !== 1 ||
    options.filter((option) => option.selected).length !== 1
  ) return null;
  const selected = options.findIndex((option) => option.selected);
  const no = options.findIndex((option) => option.no);
  return selected === no ? "Enter" : no > selected ? "Down" : "Up";
}

export async function declineOwnedModelUpgrade(
  backend: Pick<Backend, "fixtureCwd" | "capture" | "send">,
  session: string,
  screen: string,
  parentDeadlineMs?: number,
): Promise<boolean> {
  const cwd = backend.fixtureCwd(session);
  if (!cwd || !isOwnedTuiFixture(cwd) || !claudeModelUpgradeNavigation(screen)) return false;
  // The fixture itself is the ownership boundary. Standalone native callers do
  // not necessarily have a parallel runner's AIDLC_TEST_WORKER_ROOT variable.
  const marker = join(cwd, `.model-offer-${createHash("sha256").update(session).digest("hex")}`);
  if (existsSync(marker)) return false;
  // Require the modal to settle before navigating, just like the trust dialog.
  const deadline = Date.now() + remainingOperationTimeoutMs(LIVE_STARTUP_TIMEOUT_MS, { deadlineMs: parentDeadlineMs, phase: "model upgrade modal" })!;
  let previous = screen;
  let stableSince = Date.now();
  let navigation: ReturnType<typeof claudeModelUpgradeNavigation> = null;
  while (Date.now() < deadline) {
    screen = await backend.capture(session, false, "physical");
    navigation = claudeModelUpgradeNavigation(screen);
    if (!navigation) return false;
    if (screen !== previous) stableSince = Date.now();
    previous = screen;
    if (Date.now() - stableSince >= DEFAULT_STABLE_MS) break;
    navigation = null;
    await sleep(POLL_INTERVAL_MS);
  }
  if (!navigation || backend.fixtureCwd(session) !== cwd || !isOwnedTuiFixture(cwd)) return false;
  // One attempt per session: a stale repaint cannot cause another Enter.
  writeFileSync(marker, "attempted\n");
  if (navigation !== "Enter") {
    await backend.send(session, navigation, false, true);
    await sleep(DEFAULT_STABLE_MS);
  }
  const selected = await backend.capture(session, false, "physical");
  if (
    claudeModelUpgradeNavigation(selected) !== "Enter" ||
    backend.fixtureCwd(session) !== cwd || !isOwnedTuiFixture(cwd)
  ) fail("model upgrade offer did not settle on No; refusing Enter", 1);
  await backend.send(session, "Enter", false, true);
  writeTuiTrace(session, "model_upgrade_declined", { screen: selected });
  return true;
}

type TuiPatternView = TuiTextLayout | "auto";

function patternView(a: Args): TuiPatternView {
  const view = a.flags.view ?? "auto";
  if (a.bools.view || !["auto", "physical", "logical"].includes(view)) {
    fail("--view requires auto, physical, or logical");
  }
  return view as TuiPatternView;
}

async function captureTextViews(backend: Backend, session: string): Promise<TuiTextViews> {
  if (backend.captureViews) return await backend.captureViews(session);
  // Legacy Windows has always exposed only physical rows, without wrap metadata.
  const text = await backend.capture(session, false, "physical");
  return { physical: text, logical: text };
}

export function matchTuiPattern(
  views: TuiTextViews, pattern: RegExp, view: TuiPatternView = "auto",
): TuiTextLayout | null {
  if (view !== "logical" && regexMatches(pattern, views.physical)) return "physical";
  if (view !== "physical" && regexMatches(pattern, views.logical)) return "logical";
  return null;
}

async function cmdWait(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const pattern = requireFlag(a, "pattern");
  const timeoutMs = tuiWorkTimeoutMs(
    Number(a.flags["timeout-ms"] ?? DEFAULT_TIMEOUT_MS), "TUI wait",
  );
  const stableMs = Number(a.flags["stable-ms"] ?? DEFAULT_STABLE_MS);
  const re = new RegExp(pattern);
  const view = patternView(a);
  writeTuiTrace(session, "wait_start", { pattern, timeoutMs, stableMs, view });

  // Never outlive the operation deadline every nested capture budgets against.
  const deadline = Math.min(
    Date.now() + timeoutMs,
    tuiOperationDeadline.getStore() ?? Number.POSITIVE_INFINITY,
  );
  let prev = "";
  let stableSince = 0;
  let lastViews: TuiTextViews = { physical: "", logical: "" };
  // An awaited pattern that has not painted by the end of the agent's turn will
  // not paint later: end on that observation, not on the hang backstop.
  const turn = a.bools["through-turn-end"] === true ? null : new TurnWatch();

  while (Date.now() < deadline) {
    let views: TuiTextViews;
    try {
      views = await captureTextViews(backend, session);
    } catch (error) {
      // A capture that ran out of this wait's own budget is the wait timing
      // out, not a driver failure; a file-level exhaustion still propagates.
      const ownBudget = error instanceof TestBudgetExhaustedError && error.layer === "case";
      if (ownBudget || Date.now() >= deadline) break;
      throw error;
    }
    lastViews = views;
    const screen = views.physical;
    if (await declineOwnedModelUpgrade(backend, session, screen, deadline)) {
      prev = "";
      stableSince = 0;
      continue;
    }
    const matchedView = matchTuiPattern(views, re, view);
    const observed = matchedView === "logical" || view === "logical" ? views.logical : views.physical;
    // Stability belongs to the matched view. Physical UI stability must not be
    // reset by stale wrap flags, nor may a newly matching logical view inherit
    // elapsed stability from a different physical observation.
    const observation = `${matchedView ?? view}\0${observed}`;
    const now = Date.now();
    if (observation === prev) {
      if (stableSince === 0) stableSince = now;
    } else {
      stableSince = 0;
      prev = observation;
    }
    // stableMs <= 0 means "match the instant the pattern appears" — no
    // stability requirement. This is essential when asserting against a
    // screen that is actively streaming (the statusline has a live token
    // counter / spinner, so the whole screen never goes byte-stable).
    // stableMs > 0 waits for the screen to settle — use it for menus /
    // prompts that are static while awaiting input.
    const stable =
      stableMs <= 0 || (stableSince !== 0 && now - stableSince >= stableMs);
    if (matchedView && stable) {
      writeTuiTrace(session, "wait_match", {
        pattern,
        stableMs,
        screen,
        matchedView,
        ...(matchedView === "logical" ? { logicalScreen: views.logical } : {}),
      });
      process.stdout.write(`matched /${pattern}/ (stable ${stableMs}ms)\n`);
      return;
    }
    if (!matchedView && turn?.observe(screen, now)) {
      writeTuiTrace(session, "wait_turn_ended", { pattern, screen });
      process.stderr.write(
        `tui-drive: the agent's turn ended without /${pattern}/ appearing\n` +
          `---- last pane ----\n${screen}\n-------------------\n`,
      );
      process.exit(1);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  writeTuiTrace(session, "wait_timeout", {
    pattern,
    timeoutMs,
    stableMs,
    screen: lastViews.physical,
    ...(lastViews.logical !== lastViews.physical ? { logicalScreen: lastViews.logical } : {}),
  });
  process.stderr.write(
    `tui-drive: timed out after ${timeoutMs}ms waiting for /${pattern}/\n` +
      `---- last pane ----\n${lastViews.physical}\n-------------------\n`,
  );
  process.exit(1);
}

export type TuiStartupAction =
  | "wait"
  | "ready"
  | "dismiss-trust"
  | "dismiss-bypass";

export interface TuiStartupState {
  trustDismissed: boolean;
  bypassDismissed: boolean;
}

export function initialTuiStartupState(): TuiStartupState {
  return { trustDismissed: false, bypassDismissed: false };
}

const CLAUDE_TRUST_MODAL_RE =
  /(?:Do you trust (?:the files in )?this folder|Yes, I trust this folder)/i;
const CLAUDE_BYPASS_MODAL_RE = /Bypass Permissions mode/i;

/** Use the painted selection, not a version-dependent option number. */
export function claudeTrustNavigation(screen: string): "Up" | "Down" | "Enter" | null {
  if (!/(?:Accessing workspace:|Do you trust (?:the files in )?this folder)/i.test(screen)) {
    return null;
  }
  const options = screen.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(❯\s*)?(?:\d+\.\s*)?(Yes, I trust this folder|No, exit|No, continue without these permissions)\s*$/.exec(line);
    return match ? [{ selected: !!match[1], yes: match[2] === "Yes, I trust this folder" }] : [];
  });
  if (
    options.length !== 2 ||
    options.filter((option) => option.yes).length !== 1 ||
    options.filter((option) => option.selected).length !== 1
  ) return null;
  const selected = options.findIndex((option) => option.selected);
  const yes = options.findIndex((option) => option.yes);
  return selected === yes ? "Enter" : yes > selected ? "Down" : "Up";
}

export function claudePermissionNavigation(screen: string): "Up" | "Down" | "Enter" | null {
  if (!CLAUDE_BYPASS_MODAL_RE.test(screen)) return null;
  const options = screen.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(❯\s*)?(?:\d+\.\s*)?(Yes, I accept|No, exit)\s*$/.exec(line);
    return match ? [{ selected: !!match[1], yes: match[2] === "Yes, I accept" }] : [];
  });
  if (
    options.length !== 2 || options.filter((option) => option.yes).length !== 1 ||
    options.filter((option) => option.selected).length !== 1
  ) return null;
  const selected = options.findIndex((option) => option.selected);
  const yes = options.findIndex((option) => option.yes);
  return selected === yes ? "Enter" : yes > selected ? "Down" : "Up";
}

type FixtureMenuBackend = Pick<Backend, "fixtureCwd" | "capture" | "send">;
type FixtureMenuTiming = { now?: () => number; sleep?: (ms: number) => Promise<void>; deadlineMs?: number };

export function acceptTuiFixtureTrust(
  backend: FixtureMenuBackend, session: string, screen: string, timing: FixtureMenuTiming = {},
): Promise<boolean> {
  return acceptTuiFixtureMenu(backend, session, screen, timing, "trust");
}

export function acceptTuiFixturePermissionMode(
  backend: FixtureMenuBackend, session: string, screen: string, timing: FixtureMenuTiming = {},
): Promise<boolean> {
  return acceptTuiFixtureMenu(backend, session, screen, timing, "permission");
}

async function acceptTuiFixtureMenu(
  backend: Pick<Backend, "fixtureCwd" | "capture" | "send">,
  session: string,
  screen: string,
  timing: FixtureMenuTiming,
  kind: "trust" | "permission",
): Promise<boolean> {
  const cwd = backend.fixtureCwd(session);
  if (!cwd || !isOwnedTuiFixture(cwd)) return false;
  const modal = kind === "trust" ? CLAUDE_TRUST_MODAL_RE : CLAUDE_BYPASS_MODAL_RE;
  const choose = kind === "trust" ? claudeTrustNavigation : claudePermissionNavigation;
  if (!modal.test(screen)) return false;
  const now = timing.now ?? Date.now;
  const pause = timing.sleep ?? sleep;
  const startedAt = now();
  const readyDeadline = startedAt + remainingOperationTimeoutMs(LIVE_STARTUP_TIMEOUT_MS, { deadlineMs: timing.deadlineMs, phase: "fixture menu" })!;
  let previous = "";
  let stableSince = startedAt;
  let navigation: ReturnType<typeof claudeTrustNavigation> = null;
  // First paint can precede Claude's input handler. Require the complete menu
  // to remain byte-stable, as legacy `wait --stable-ms 600` callers do, before
  // sending even one navigation key. Partial/repainting grids reset the wait.
  while (now() < readyDeadline) {
    screen = await backend.capture(session, false, "physical");
    navigation = choose(screen);
    if (!navigation || screen !== previous) stableSince = now();
    previous = screen;
    if (navigation && now() - stableSince >= DEFAULT_STABLE_MS) break;
    navigation = null;
    await pause(POLL_INTERVAL_MS);
  }
  if (!navigation) {
    throw new Error(`fixture ${kind} menu never became stable; refusing navigation`);
  }
  if (backend.fixtureCwd(session) !== cwd || !isOwnedTuiFixture(cwd)) {
    throw new Error(`fixture ${kind} context changed; refusing navigation`);
  }
  writeTuiTrace(session, `fixture_${kind}_action`, {
    cwd, navigation, screen, readyAfterMs: now() - startedAt, stableMs: DEFAULT_STABLE_MS,
  });
  if (navigation !== "Enter") {
    await backend.send(session, navigation, false, true);
    const deadline = readyDeadline;
    do {
      await pause(POLL_INTERVAL_MS);
      screen = await backend.capture(session, false, "physical");
      if (choose(screen) === "Enter") break;
    } while (now() < deadline);
    if (choose(screen) !== "Enter") {
      throw new Error(`fixture ${kind} selection never moved to Yes; refusing Enter`);
    }
  }
  // Revalidate both the fixture and visible selection immediately before Enter.
  screen = await backend.capture(session, false, "physical");
  if (
    backend.fixtureCwd(session) !== cwd || !isOwnedTuiFixture(cwd) ||
    choose(screen) !== "Enter"
  ) {
    throw new Error(`fixture ${kind} context changed; refusing Enter`);
  }
  await backend.send(session, "Enter", false, true);
  writeTuiTrace(session, `fixture_${kind}_accepted`, { cwd, screen });
  return true;
}

function regexMatches(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

/**
 * Pure reducer for Claude's startup grid. Visible supported modals take
 * precedence over a ready marker because older Claude versions can paint the
 * underlying UI before the modal is dismissed. Each modal is answered at most
 * once so a slow repaint cannot spill repeated numeric input into the prompt.
 */
export function advanceTuiStartup(
  state: TuiStartupState,
  screen: string,
  readyPattern: RegExp,
  readyText: string | null = screen,
): { state: TuiStartupState; action: TuiStartupAction } {
  const trustVisible = regexMatches(CLAUDE_TRUST_MODAL_RE, screen);
  const bypassVisible = regexMatches(CLAUDE_BYPASS_MODAL_RE, screen);

  if (trustVisible && !state.trustDismissed) {
    return {
      state: { ...state, trustDismissed: true },
      action: "dismiss-trust",
    };
  }
  if (bypassVisible && !state.bypassDismissed) {
    return {
      state: { ...state, bypassDismissed: true },
      action: "dismiss-bypass",
    };
  }
  if (trustVisible || bypassVisible) {
    return { state, action: "wait" };
  }
  if (readyText !== null && regexMatches(readyPattern, readyText)) {
    return { state, action: "ready" };
  }
  return { state, action: "wait" };
}

async function cmdStartup(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const readyPatternText = requireFlag(a, "ready-pattern");
  const timeoutMs = tuiWorkTimeoutMs(
    Number(a.flags["timeout-ms"] ?? DEFAULT_STARTUP_TIMEOUT_MS), "TUI startup",
  );
  const readyPattern = new RegExp(readyPatternText);
  const view = patternView(a);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let state = initialTuiStartupState();
  let screen = "";

  writeTuiTrace(session, "startup_begin", {
    readyPattern: readyPatternText,
    timeoutMs,
    view,
  });

  while (Date.now() < deadline) {
    const views = await captureTextViews(backend, session);
    screen = views.physical;
    if (await declineOwnedModelUpgrade(backend, session, screen, deadline)) continue;
    const matchedView = matchTuiPattern(views, readyPattern, view);
    const step = advanceTuiStartup(state, screen, readyPattern, matchedView ? views[matchedView] : null);
    state = step.state;

    if (step.action === "ready") {
      const elapsedMs = Date.now() - startedAt;
      writeTuiTrace(session, "startup_ready", {
        readyPattern: readyPatternText,
        elapsedMs,
        state,
        screen,
        matchedView,
      });
      process.stdout.write(
        `startup ready /${readyPatternText}/ after ${elapsedMs}ms\n`,
      );
      return;
    }

    if (step.action === "dismiss-trust") {
      writeTuiTrace(session, "startup_action", {
        action: step.action,
        screen,
      });
      if (!await acceptTuiFixtureTrust(backend, session, screen, { deadlineMs: deadline })) {
        throw new Error("refusing automatic trust outside a known disposable TUI fixture");
      }
    } else if (step.action === "dismiss-bypass") {
      writeTuiTrace(session, "startup_action", {
        action: step.action,
        screen,
      });
      if (!await acceptTuiFixturePermissionMode(backend, session, screen, { deadlineMs: deadline })) {
        throw new Error("refusing automatic permission-mode acceptance outside a disposable TUI fixture");
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  writeTuiTrace(session, "startup_timeout", {
    readyPattern: readyPatternText,
    timeoutMs,
    state,
    screen,
  });
  process.stderr.write(
    `tui-drive: timed out after ${timeoutMs}ms waiting for startup ` +
      `ready /${readyPatternText}/\n` +
      `---- last pane ----\n${screen}\n-------------------\n`,
  );
  process.exit(1);
}

async function cmdCapture(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  if (a.bools.physical && (a.bools.ansi || a.bools.json)) {
    fail("capture --physical selects plain text; use it without --ansi or --json");
  }
  if (a.bools.json) {
    if (a.bools.ansi) fail("capture accepts either --json or --ansi");
    if (!backend.snapshot) fail("capture --json requires AIDLC_TUI_BACKEND=bun");
    process.stdout.write(`${JSON.stringify(await backend.snapshot(session))}\n`);
    return;
  }
  const ansi = a.bools.ansi === true;
  const layout = a.bools.physical ? "physical" : "logical";
  const screen = await backend.capture(session, ansi, layout);
  writeTuiTrace(session, "capture", { ansi, layout, screen });
  process.stdout.write(screen);
}

async function cmdKill(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  writeTuiTrace(session, "kill", {});
  await backend.kill(session);
  process.stdout.write(`killed session '${session}'\n`);
}

async function cmdWaitDead(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const requestedMs = Number(a.flags["timeout-ms"] ?? DEFAULT_DEAD_TIMEOUT_MS);
  const startedAt = Date.now();
  const deadline = nativeCleanupDeadlineMs(requestedMs);
  const timeoutMs = Math.max(0, deadline - startedAt);
  let live = await backend.liveProcesses(session, deadline);
  writeTuiTrace(session, "wait_dead_begin", { timeoutMs, live });

  while (live.length > 0 && Date.now() < deadline) {
    await sleep(Math.max(0, Math.min(POLL_INTERVAL_MS, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    live = await backend.liveProcesses(session, deadline);
  }

  const elapsedMs = Date.now() - startedAt;
  if (live.length === 0) {
    writeTuiTrace(session, "wait_dead_complete", { elapsedMs });
    process.stdout.write(
      `session '${session}' process tree exited after ${elapsedMs}ms\n`,
    );
    return;
  }

  writeTuiTrace(session, "wait_dead_timeout", {
    timeoutMs,
    elapsedMs,
    live,
  });
  process.stderr.write(
    `tui-drive: session '${session}' still has live processes after ` +
      `${timeoutMs}ms: ${live.join(", ")}\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// answer-gate — the shared AskUserQuestion answer loop (§3, D-TUI-3).
//
// One implementation, both backends: it only uses backend.capture + backend.send,
// so the Bun and tmux paths drive it identically. It is the value of the
// whole exercise — the per-tab Enter loop proven in tmp/auq-loop.sh, made reusable.
//
// Detection is SCREEN-based (the `Enter to select` / `Submit answers` footer on
// the captured grid); termination is the ON-DISK affirmation timestamp. The
// transcript JSONL is NOT a leading event bus (the AUQ tool_use is written on
// RESOLUTION, not presentation — §1.1), so an event-driven detect-loop would
// deadlock. Disk is the terminator; the screen only tells us WHEN to press Enter.
// ---------------------------------------------------------------------------

// Read the active intent record's aidlc-state.md and report whether practices affirmation has
// committed. The DIGIT-ANCHORED same-line regex is load-bearing: a greedy
// `\s*(\S.*)` bleeds past an EMPTY field into the next heading
// (`## Scope Configuration`), a false-positive that bailed a run at 57s during
// the spike. Anchoring on `\d` requires a real value (an ISO timestamp starts
// with a year digit), so an unfilled `- **Practices Affirmed Timestamp**:` line
// reads as not-yet-affirmed.
const AFFIRMED_RE = /Affirmed Timestamp\*\*:[ \t]*(\d[^\r\n]*)/;

function affirmedOnDisk(projectDir: string): boolean {
  const statePath = stateFilePathFor(projectDir);
  if (!existsSync(statePath)) return false;
  let md: string;
  try {
    md = readFileSync(statePath, "utf8");
  } catch {
    return false;
  }
  const m = AFFIRMED_RE.exec(md);
  return m !== null && m[1].trim().length > 0;
}

// A terminator answers the only question the answer-gate loop needs: "has the
// journey reached the on-disk signal that means STOP answering?" The workshop
// journey's signal is the practices-affirmation timestamp (default). Other
// journeys land a different artifact — a stage's questions/answer file, an
// intent-statement, a memory.md, a state field reaching a value. So the
// terminator is PLUGGABLE: a test names its journey's real on-disk completion
// signal, and the SAME keystroke loop (Enter = Recommended per menu) drives ANY
// gated journey to it. This is the generalisation of the workshop-only affirmed
// terminator — the keystroke STRATEGY was always journey-agnostic; only the
// TERMINATOR was hardcoded.
//
// Flags (all relative to --project-dir; the affirmation default holds when none
// is given, so existing callers are unchanged):
//   --until-file <relpath>          terminate when this file exists & is non-empty
//                                   (a glob segment `*` matches within one dir level)
//   --until-state-field <name=re>   terminate when aidlc-state.md's
//                                   `- **<name>**:` line matches the regex <re>
//   --also-state-field <name=re>    require BOTH this state field and
//                                   --until-state-field to match; requires the latter
//   (none)                          terminate on the practices-affirmation timestamp
//
// --also-state-field closes the approve tool's two-write window: handleApprove
// writes Last Completed Stage (aidlc-state.ts:5719), then handleAdvance writes
// Current Stage (aidlc-state.ts:4506; verified 2026-09-13). Wait for both before
// returning, so a caller's session kill cannot land between those writes.
type Terminator = { describe: string; done: () => boolean };

export type PortablePathKind =
  | "relative"
  | "posix-absolute"
  | "git-bash-absolute"
  | "drive-absolute"
  | "unc-absolute";

export type PortablePathParts = {
  kind: PortablePathKind;
  root: string;
  segments: string[];
};

export type PortablePathPlatform = "posix" | "win32";

function portableSegments(rest: string | undefined): string[] {
  return (rest ?? "")
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/** Parse path roots and separators without depending on the host OS. */
export function parsePortablePath(
  input: string,
  platform: PortablePathPlatform = portablePathPlatform(),
): PortablePathParts {
  const unc =
    input.startsWith("\\\\") || platform === "win32"
      ? /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/.exec(input)
      : null;
  if (unc) {
    return {
      kind: "unc-absolute",
      root: `\\\\${unc[1]}\\${unc[2]}\\`,
      segments: portableSegments(unc[3]),
    };
  }

  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (drive) {
    return {
      kind: "drive-absolute",
      root: `${drive[1].toUpperCase()}:\\`,
      segments: portableSegments(drive[2]),
    };
  }

  const gitBash =
    platform === "win32"
      ? /^\/([A-Za-z])(?:[\\/](.*))?$/.exec(input)
      : null;
  if (gitBash) {
    return {
      kind: "git-bash-absolute",
      root: `${gitBash[1].toUpperCase()}:\\`,
      segments: portableSegments(gitBash[2]),
    };
  }

  if (input.startsWith("/")) {
    return {
      kind: "posix-absolute",
      root: "/",
      segments: portableSegments(input.slice(1)),
    };
  }

  return {
    kind: "relative",
    root: "",
    segments: portableSegments(input),
  };
}

function portablePathPlatform(): PortablePathPlatform {
  return os.platform() === "win32" ? "win32" : "posix";
}

function portablePathToNative(
  parts: PortablePathParts,
  platform: PortablePathPlatform,
  base?: string,
): string {
  if (parts.kind === "relative") {
    const pathApi = platform === "win32" ? win32 : posix;
    return pathApi.resolve(base ?? ".", ...parts.segments);
  }
  if (parts.kind === "posix-absolute") {
    if (platform === "posix") return posix.join("/", ...parts.segments);
    const driveRoot = win32.parse(base ?? process.cwd()).root || "\\";
    return win32.join(driveRoot, ...parts.segments);
  }
  return win32.join(parts.root, ...parts.segments);
}

/**
 * Resolve a portable path pattern into a native absolute anchor plus glob
 * segments. Absolute drive, UNC, Git-Bash, and POSIX roots stay structural;
 * relative patterns remain anchored under projectRoot.
 */
export function resolvePortablePathPattern(
  projectRoot: string,
  pattern: string,
  platform: PortablePathPlatform = portablePathPlatform(),
): PortablePathParts {
  const rootParts = parsePortablePath(projectRoot, platform);
  const nativeProjectRoot = portablePathToNative(rootParts, platform);
  const patternParts = parsePortablePath(pattern, platform);
  if (patternParts.kind === "relative") {
    return {
      ...patternParts,
      root: nativeProjectRoot,
    };
  }
  if (patternParts.kind === "posix-absolute" && platform === "win32") {
    return {
      ...patternParts,
      root: win32.parse(nativeProjectRoot).root || "\\",
    };
  }
  return patternParts;
}

function globSegmentRegex(segment: string, caseInsensitive: boolean): RegExp {
  const escaped = segment
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, caseInsensitive ? "i" : "");
}

// Does a portable path (optionally containing `*` in any segment) resolve to an
// existing, non-empty file? Relative patterns are anchored under root.
export function fileSignalMet(
  root: string,
  rel: string,
  requireNonEmpty = true,
): boolean {
  const platform = portablePathPlatform();
  const resolved = resolvePortablePathPattern(root, rel, platform);
  const joinPath = platform === "win32" ? win32.join : posix.join;
  // Walk the path segment by segment, expanding a `*` segment to its dir entries.
  let dirs = [resolved.root];
  const segs = resolved.segments;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;
    const next: string[] = [];
    for (const d of dirs) {
      if (seg.includes("*")) {
        // glob this segment against the dir's entries
        let entries: string[] = [];
        try {
          entries = existsSync(d) ? readdirSync(d) : [];
        } catch {
          entries = [];
        }
        const re = globSegmentRegex(seg, platform === "win32");
        for (const e of entries) {
          if (re.test(e)) next.push(joinPath(d, e));
        }
      } else {
        next.push(joinPath(d, seg));
      }
    }
    dirs = next;
    if (dirs.length === 0) return false;
    if (!isLast) {
      // keep only existing directories to descend into
      dirs = dirs.filter((p) => {
        try {
          return existsSync(p) && statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    }
  }
  // Any matched terminal path that is an existing, non-empty file = signal met.
  for (const p of dirs) {
    try {
      if (
        existsSync(p) &&
        statSync(p).isFile() &&
        (!requireNonEmpty || statSync(p).size > 0)
      ) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

function stateFieldSignalMet(projectDir: string, name: string, re: RegExp): boolean {
  const statePath = stateFilePathFor(projectDir);
  if (!existsSync(statePath)) return false;
  let md: string;
  try {
    md = readFileSync(statePath, "utf8");
  } catch {
    return false;
  }
  // Match the `- **<name>**: <value>` line, then test <value> against re.
  const fieldRe = new RegExp(
    `\\*\\*${name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*:[ \\t]*([^\\r\\n]*)`,
  );
  const m = fieldRe.exec(md);
  if (m === null) return false;
  return re.test(m[1].trim());
}

function makeTerminator(projectDir: string, a: Args): Terminator {
  const untilFile = a.flags["until-file"];
  const untilField = a.flags["until-state-field"];
  const alsoField = a.flags["also-state-field"] ??
    (a.bools["also-state-field"] ? "" : undefined);
  if (alsoField !== undefined && !untilField) {
    fail("--also-state-field requires --until-state-field", 2);
  }
  if (untilFile) {
    return {
      describe: `file '${untilFile}' exists & non-empty`,
      done: () => fileSignalMet(projectDir, untilFile),
    };
  }
  if (untilField) {
    const eq = untilField.indexOf("=");
    if (eq <= 0) {
      fail(`--until-state-field expects <name>=<regex>, got '${untilField}'`, 2);
    }
    const name = untilField.slice(0, eq);
    const reStr = untilField.slice(eq + 1);
    const re = new RegExp(reStr);
    if (alsoField !== undefined) {
      const alsoEq = alsoField.indexOf("=");
      if (alsoEq <= 0) {
        fail(`--also-state-field expects <name>=<regex>, got '${alsoField}'`, 2);
      }
      const alsoName = alsoField.slice(0, alsoEq);
      const alsoReStr = alsoField.slice(alsoEq + 1);
      const alsoRe = new RegExp(alsoReStr);
      return {
        describe: `state field '${name}' matches /${reStr}/ AND state field '${alsoName}' matches /${alsoReStr}/`,
        done: () =>
          stateFieldSignalMet(projectDir, name, re) &&
          stateFieldSignalMet(projectDir, alsoName, alsoRe),
      };
    }
    return {
      describe: `state field '${name}' matches /${reStr}/`,
      done: () => stateFieldSignalMet(projectDir, name, re),
    };
  }
  return {
    describe: "practices-affirmation timestamp committed",
    done: () => affirmedOnDisk(projectDir),
  };
}

// The AUQ highlighted-option caret. The Windows ConPTY boundary is UTF-8, so the
// reconstructed grid must carry the same exact `❯` (U+276F) glyph as tmux.
// Anchor it to a numbered option so the ordinary `>` input prompt cannot match.
const AUQ_CARET_OPTION = /^\s*❯\s+\d+\.\s/m;
function gridHasCaret(grid: string): boolean {
  return AUQ_CARET_OPTION.test(grid);
}

// Is a waiting AskUserQuestion menu painted on the grid right now? A menu shows
// the highlighted-default `❯` caret on a numbered option AND a footer. CRITICAL:
// the Submit screen DROPS the `Enter to select` footer and shows `Submit answers`
// instead — a footer-only waiter sails past Submit and hangs forever (cost a full
// macOS run during the spike). So we accept EITHER footer.
export function gridHasMenu(grid: string): boolean {
  return gridHasCaret(grid) && (grid.includes("Enter to select") || grid.includes("Submit answers"));
}

// Claude Code paints one of these while the agent still has work in flight: the
// status spinner (a glyph, then a word ending in an ellipsis) or its live
// elapsed-time counter, a wait for a background agent, a running subagent row,
// the subagent footer, or a running command's background hint. Only a
// positively recognized idle prompt is idle.
const CLAUDE_WORKING_RE =
  /^\s*\S\s+[A-Z][A-Za-z'-]*…(?:\s|$)|\((?:\d+m )?\d+s ·|Waiting for \d+ background|^\s*◯\s|\/tasks to see|ctrl\+b to run in background/m;
const CLAUDE_EMPTY_INPUT_RE = /^\s*❯\s*$/m;
const CLAUDE_IDLE_FOOTER_RE = /^\s*(?:⏵⏵ .*\(shift\+tab to cycle\)|\? for shortcuts)/m;

export function gridShowsAgentWorking(grid: string): boolean {
  return CLAUDE_WORKING_RE.test(grid);
}

/** Claude's empty input prompt with no menu and no sign of work in flight. */
export function gridShowsIdlePrompt(grid: string): boolean {
  return !gridHasMenu(grid) && !gridShowsAgentWorking(grid) &&
    CLAUDE_EMPTY_INPUT_RE.test(grid) && CLAUDE_IDLE_FOOTER_RE.test(grid);
}

/** How long an idle prompt must stay unchanged before a turn counts as ended. */
export const TURN_IDLE_SETTLE_MS = 30_000;

/**
 * Observes one agent turn by the screen alone. The turn has ended once work was
 * seen and an idle prompt then stayed byte-identical for the settle period. A
 * wait whose condition is still unmet at that point can never be met by this
 * turn, so it ends on that observation instead of on its hang backstop.
 */
export class TurnWatch {
  // Plain fields: Node's strip-only TypeScript loads this driver too.
  private readonly settleMs: number;
  private sawWorking = false;
  private idleGrid: string | null = null;
  private idleSince = 0;

  constructor(settleMs = TURN_IDLE_SETTLE_MS) {
    this.settleMs = settleMs;
  }

  /** Forget the previous turn; call after sending input. */
  begin(): void {
    this.sawWorking = false;
    this.idleGrid = null;
  }

  observe(grid: string, now = Date.now()): boolean {
    if (gridShowsAgentWorking(grid)) {
      this.sawWorking = true;
      this.idleGrid = null;
      return false;
    }
    if (!gridShowsIdlePrompt(grid)) {
      this.idleGrid = null;
      return false;
    }
    if (grid !== this.idleGrid) {
      this.idleGrid = grid;
      this.idleSince = now;
    }
    return this.sawWorking && now - this.idleSince >= this.settleMs;
  }
}

// Is the gate currently on the multi-tab AUQ's final SUBMIT screen? That screen
// drops the per-question UI for a confirm widget (`confirmLabel:"Submit answers"`,
// verified in the claude bundle) — `❯ 1. Submit answers / 2. Cancel` under "Ready
// to submit your answers?". Enter on it commits the WHOLE form (verified live). The
// option label "Submit answers" is unique to this screen (the tab STRIP only ever
// shows the short "Submit" label), so it is the reliable signal.
function gridIsSubmitScreen(grid: string): boolean {
  return grid.includes("Submit answers");
}

// Is the painted question a MULTI-SELECT ("select all that apply")? The AUQ key
// model, confirmed from the claude bundle AND by live single-keystroke probing of
// the real widget (2026-06-06):
//   - single-select option: Enter SELECTS the highlighted option and auto-advances
//     (`chord:"enter" action:"select"`).
//   - multi-select option:  Space TOGGLES the highlighted option (`chord:"space"
//     action:"toggle"`). Enter ALSO toggles it — so a Space-then-Enter pair nets to
//     zero and the gate never advances (the t73 1409-answer / 14.5min hang: the loop
//     toggled `[ ]`↔`[✔]` forever). A multi-tab form is advanced with the ARROW keys
//     (`"Tab/Arrow keys to navigate"`, rendered only when there is >1 tab); the
//     toggled selection PERSISTS across the navigation (verified live).
// We detect a multi-select question by the exact checkbox markers it paints on
// its OPTION lines only — `❯ 1. [ ] Option` / `  2. [✔] Option`. We deliberately
// do NOT key off the prose "select all that apply" (it echoes on the Submit
// review screen) nor the tab-strip `☐`/`☒` glyphs (present on EVERY tab,
// single-select ones included) — both misfire.
function gridIsMultiSelect(grid: string): boolean {
  return /\d+\.\s*\[[ ✔]\]/.test(grid); // a numbered option line carrying a checkbox
}

// Is this a MULTI-TAB AUQ form (more than one question batched into one gate)? Such
// a form paints a tab strip with the `←` / `→` navigation affordances at its ends
// (e.g. `←  ☒ Success / scope  ☐ Trigger  ☐ Constraints  ✔ Submit  →`) and ends in a
// Submit tab. A lone single-question gate paints no such strip. This decides how a
// multi-select tab is left: a multi-tab form advances with the ARROW key (the toggle
// persists across tabs — verified live); a single-question multi-select has no other
// tab to move to, so it commits with Enter once toggled.
function gridIsMultiTabForm(grid: string): boolean {
  return grid.includes("←") && grid.includes("→");
}

// Parse the numbered options off a painted single-select menu, in screen order.
// Returns `[{ num, label }]` for every `❯ 1. Label` / `  2. Label` line (the
// caret-or-blank prefix, a number, a dot, then the label). The option's
// continuation/description lines (indented prose under it) are ignored — we key
// off the numbered headers only. Used to choose an option by its label content
// rather than a hard-coded ordinal, so the driver reacts to what the engine
// actually rendered.
function parseMenuOptions(grid: string): { num: number; label: string }[] {
  const out: { num: number; label: string }[] = [];
  for (const line of grid.split("\n")) {
    const m = /^\s*❯?\s*(\d+)\.\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ num: Number(m[1]), label: m[2].trim() });
  }
  return out;
}

/** True when the painted menu contains an option with the given label text. */
export function gridHasOption(grid: string, optionLabel: string): boolean {
  const wanted = optionLabel.trim().toLowerCase();
  return (
    wanted.length > 0 &&
    parseMenuOptions(grid).some((option) =>
      option.label.toLowerCase().includes(wanted)
    )
  );
}

/** True only for a numbered approval menu carrying both canonical choices. */
export function gridIsApprovalGate(grid: string): boolean {
  if (!gridHasMenu(grid)) return false;
  const labels = parseMenuOptions(grid).map((option) => option.label);
  return (
    labels.some((label) => /\bApprove(?:\s+Plan)?\b/i.test(label)) &&
    labels.some((label) => /\bRequest Changes\b/i.test(label))
  );
}

function pickMenuOption(grid: string, label: RegExp): number | null {
  for (const opt of parseMenuOptions(grid)) {
    if (label.test(opt.label)) return opt.num;
  }
  return null;
}

async function chooseNumberedMenuOption(
  backend: Backend,
  session: string,
  optionNum: number,
): Promise<void> {
  for (let i = 1; i < optionNum; i++) {
    await backend.send(session, "Down", false, true);
    await sleep(120);
  }
  await backend.send(session, "Enter", false, true);
}

const REVISION_FEEDBACK =
  "Update architecture.md to add a Persistence Design (Target State) section with hydrate-on-mount and write-on-change localStorage flow, plus corrupt JSON and quota-error handling.";

function gridLooksLikeRevisionTypeMenu(grid: string): boolean {
  if (!gridHasMenu(grid)) return false;
  return /what would you like changed|request(?:ed)? changes|reverse-engineering artifacts/i.test(grid);
}

export function pickRevisionTypeSomethingOption(grid: string): number | null {
  if (!gridLooksLikeRevisionTypeMenu(grid)) return null;
  return pickMenuOption(grid, /^type something\.?$/i);
}

function gridLooksLikeRevisionFreeTextPrompt(grid: string): boolean {
  return /which artifact needs fixing|what(?:'|’)s wrong with it|tell me the file/i.test(grid);
}

// After "Request changes" on an approval gate, the v0.6.0 engine no longer asks
// for revision feedback as FREE TEXT. It paints a RECOVERY MENU (verified live
// 2026-06-09) — e.g. `1. Actually approve & continue` (which UN-rejects), then
// real revise directives (`2. Narrow root cause…`, `3. Drop … steer`, `4. Add
// more detail`), plus generic `Type something` / `Chat about this` trailers.
// Picking the right option is what makes `reject --feedback` fire (Revision
// Count++); option 1 silently records approval and the reject never takes.
//
// A Request Changes choice can also live inside a multi-tab form with later tabs
// (for example the stage learnings tab) and a final Submit screen. Those
// intermediate tabs are still the original form, not the revision recovery menu,
// so they must return null and let answer-gate submit the form first.
// This returns the option number of the FIRST genuine revision directive — the
// lowest-numbered option that is NOT the approve/cancel/type/chat escape
// hatches — or null when no such menu is painted (the engine asked free text).
export function pickRevisionOption(grid: string): number | null {
  if (!gridHasMenu(grid)) return null;
  if (gridIsSubmitScreen(grid) || gridIsMultiSelect(grid) || gridIsMultiTabForm(grid)) {
    return null;
  }
  const options = parseMenuOptions(grid);
  const RECOVERY_ESCAPE =
    /(actually approve|approve & continue|approve and continue|didn't mean to reject|nevermind|never mind)/i;
  if (!options.some((opt) => RECOVERY_ESCAPE.test(opt.label))) return null;
  const NON_REVISE =
    /(actually approve|approve & continue|approve and continue|didn't mean to reject|cancel|type something|chat about|nevermind|never mind|^none(?:\s*\(recommended\))?$)/i;
  for (const opt of options) {
    if (!NON_REVISE.test(opt.label)) return opt.num;
  }
  return null;
}

export async function handleRevisionRecovery(
  backend: Backend,
  session: string,
  answered: number,
  parentDeadlineMs: number,
  turn = new TurnWatch(),
): Promise<boolean> {
  const recoveryStarted = Date.now();
  const recoveryDeadline = recoveryStarted + remainingOperationTimeoutMs(LIVE_COMMAND_TIMEOUT_MS, { deadlineMs: parentDeadlineMs, phase: "revision recovery" })!;
  // The rejected gate is closed once a menu-free frame paints; any menu after
  // that belongs to the revision turn, never to the stale gate.
  let turnStarted = false;
  let previous: string | null = null;
  while (Date.now() < recoveryDeadline) {
    await sleep(POLL_INTERVAL_MS);
    const after = await backend.capture(session, false, "physical");
    const settled = after === previous;
    previous = after;
    if (!gridHasMenu(after)) turnStarted = true;
    if (gridHasMenu(after) && gridIsMultiSelect(after)) {
      // A structured feedback question is already ready. The outer answer-gate
      // loop owns checkbox selection/submission; do not spend a minute waiting
      // for this real question to turn into a recovery menu or free-text prompt.
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "reject_structured_followup",
        screen: after,
      });
      process.stdout.write("answer-gate: structured revision feedback ready for normal menu handling\n");
      return false;
    }
    const typeSomethingNum = pickRevisionTypeSomethingOption(after);
    if (typeSomethingNum !== null) {
      await chooseNumberedMenuOption(backend, session, typeSomethingNum);
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "reject_choose_type_something",
        optionNum: typeSomethingNum,
        screen: after,
      });

      const promptDeadline = recoveryDeadline;
      while (Date.now() < promptDeadline) {
        await sleep(POLL_INTERVAL_MS);
        const prompt = await backend.capture(session, false, "physical");
        if (!gridHasMenu(prompt)) {
          await backend.send(session, REVISION_FEEDBACK, true, true);
          await sleep(300);
          await backend.send(session, "Enter", false, true);
          writeTuiTrace(session, "answer_gate_action", {
            answered,
            action: "reject_free_text_feedback",
            screen: prompt,
          });
          process.stdout.write("answer-gate: supplied free-text revision feedback\n");
          return true;
        }
      }
    }
    const reviseNum = pickRevisionOption(after);
    if (reviseNum !== null) {
      // Shape A: navigate the caret from option 1 down to the revise option,
      // then select it. (The caret starts on option 1 when the menu paints.)
      await chooseNumberedMenuOption(backend, session, reviseNum);
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "reject_pick_revision_option",
        optionNum: reviseNum,
        screen: after,
      });
      process.stdout.write(
        `answer-gate: chose revision option ${reviseNum} on the recovery menu\n`,
      );
      return true;
    }
    // Any other settled menu of the revision turn is the structured clarifying
    // question stage-protocol.md requires a structured-only driver to be able to
    // answer (or the re-presented gate). The outer answer-gate loop owns it.
    if (turnStarted && settled && gridHasMenu(after)) {
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "reject_structured_followup",
        screen: after,
      });
      process.stdout.write("answer-gate: structured revision feedback ready for normal menu handling\n");
      return false;
    }
    // No recovery menu painted. Free text goes in only at an idle prompt, never
    // while the agent is still working: at once when the prompt names the
    // free-text question, otherwise once the turn has ended without a menu.
    // Typing on a quiet timer raced a structured menu still being painted.
    if (
      (gridLooksLikeRevisionFreeTextPrompt(after) && gridShowsIdlePrompt(after)) ||
      turn.observe(after)
    ) {
      await backend.send(session, REVISION_FEEDBACK, true, true);
      await sleep(300);
      await backend.send(session, "Enter", false, true);
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "reject_free_text_feedback",
        screen: after,
      });
      process.stdout.write("answer-gate: supplied free-text revision feedback\n");
      return true;
    }
  }
  process.stdout.write(
    "answer-gate: WARNING — no recovery menu or free-text prompt resolved after reject; continuing\n",
  );
  return false;
}

async function teardownAnswerGate(
  backend: Backend,
  session: string,
  reason: string,
): Promise<void> {
  writeTuiTrace(session, "answer_gate_teardown", { reason });
  await backend.kill(session);
}

async function failAnswerGate(
  backend: Backend,
  session: string,
  msg: string,
  code = 1,
): Promise<never> {
  await teardownAnswerGate(backend, session, "error");
  fail(msg, code);
}

async function cmdAnswerGate(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const projectDir = a.flags["project-dir"];
  if (!projectDir) {
    return failAnswerGate(backend, session, "missing required --project-dir", 2);
  }
  // The journey's pass condition is the ON-DISK terminator (--until-*); these
  // timeouts are pure HANG-BACKSTOPS, never budgets — a healthy run returns the
  // instant the disk signal lands, long before any timer.
  //
  // Per-gate timeout = how long to wait for the NEXT menu before declaring a wedge.
  // It deliberately DEFAULTS TO THE OVERALL DEADLINE (one backstop, not a per-stage
  // budget): a tight per-stage value is whack-a-mole — a subagent stage (reverse-
  // engineering) legitimately runs minutes with no menu, and runs SLOWER on a slower
  // box, so any fixed per-stage number eventually false-fires on a working run (it
  // killed t50's RE stage at 360s on the Windows box, mid-work, 2026-06-06). Folding
  // it into the overall deadline means the only thing that can trip it is a genuine
  // wedge (nothing ever reaches the disk terminator), and bun's own test timeout is
  // the hard ceiling above it. An explicit --per-gate-timeout-ms still overrides for
  // the rare case that wants faster wedge-detection.
  let overallMs: number;
  try {
    overallMs = tuiWorkTimeoutMs(Number(a.flags["overall-timeout-ms"] ?? LIVE_COMMAND_TIMEOUT_MS), "TUI answer gates");
    tuiOperationDeadline.enterWith(Date.now() + overallMs);
  } catch (error) {
    await teardownAnswerGate(backend, session, "work-budget-exhausted");
    throw error;
  }
  const perGateMs = Number(a.flags["per-gate-timeout-ms"] ?? String(overallMs));
  // The on-disk signal that means STOP answering — workshop affirmation by
  // default, or a journey-specific file/state-field via --until-* (see
  // makeTerminator). The keystroke strategy is the same for every journey;
  // only this terminator differs.
  const untilField = a.flags["until-state-field"];
  if (untilField && untilField.indexOf("=") <= 0) {
    await failAnswerGate(
      backend,
      session,
      `--until-state-field expects <name>=<regex>, got '${untilField}'`,
      2,
    );
  }
  const alsoField = a.flags["also-state-field"] ??
    (a.bools["also-state-field"] ? "" : undefined);
  if (alsoField !== undefined && !untilField) {
    failAnswerGate(
      backend,
      session,
      "--also-state-field requires --until-state-field",
      2,
    );
  }
  if (alsoField !== undefined && alsoField.indexOf("=") <= 0) {
    failAnswerGate(
      backend,
      session,
      `--also-state-field expects <name>=<regex>, got '${alsoField}'`,
      2,
    );
  }
  let term: Terminator;
  try {
    term = makeTerminator(projectDir, a);
  } catch (err) {
    await teardownAnswerGate(backend, session, "invalid-terminator");
    throw err;
  }

  // --reject-first-gate: on the FIRST approval gate (a single-select menu whose
  // options include "Request changes"), select that option (Down → Enter) instead
  // of the Recommended "Approve" default, then revert to approve-only for the rest
  // of the run. This is the ONLY way to drive a reject→revise→approve cycle: the
  // gate must be distinguished from the clarifying-QUESTION menus that precede it
  // (which carry A–E option text, never "Request changes"), so a blind pre-loop
  // keystroke can't target it (it lands on a question — the t128 finding,
  // 2026-06-07). Keyed on the option label "Request changes"
  // (stage-protocol.md:42), the option unique to an approval gate. Once consumed,
  // the loop is approve-only, so the rejected stage re-presents its gate and gets
  // approved on the next pass — the full cycle, driven like a human.
  // Bare valueless flag → parseArgs stores it in `bools`, not `flags` (see how
  // --literal / --no-enter / --ansi are read). Reading a.flags here was the bug
  // that left this always-false (the t128 third-red finding, 2026-06-07).
  let rejectFirstGate = a.bools["reject-first-gate"] === true;
  const stopAtApprovalGate =
    a.bools["stop-at-approval-gate"] === true;
  const assertFileAbsentAtOption =
    a.flags["assert-file-absent-at-option"];
  const assertFileAbsent = a.flags["assert-file-absent"];
  if (
    (assertFileAbsentAtOption === undefined) !==
      (assertFileAbsent === undefined)
  ) {
    await failAnswerGate(
      backend,
      session,
      "--assert-file-absent-at-option and --assert-file-absent must be supplied together",
      2,
    );
  }
  let absenceAssertionObserved = false;
  const assertAbsenceObservationCompleted = async (): Promise<void> => {
    if (assertFileAbsentAtOption && !absenceAssertionObserved) {
      await failAnswerGate(
        backend,
        session,
        `option '${assertFileAbsentAtOption}' was never observed; ` +
          `could not assert '${assertFileAbsent}' absent`,
        1,
      );
    }
  };
  let revisionFeedbackPending = false;

  const overallDeadline = Date.now() + overallMs;
  const tracePollMs = answerGateTracePollMs();
  let answered = 0;
  let lastPollTraceAt = 0;
  writeTuiTrace(session, "answer_gate_start", {
    projectDir,
    overallMs,
    perGateMs,
    terminator: term.describe,
    rejectFirstGate,
    stopAtApprovalGate,
    assertFileAbsentAtOption,
    assertFileAbsent,
  });

  const maybeTracePoll = (grid: string, gateDeadline: number): void => {
    const now = Date.now();
    if (now - lastPollTraceAt < tracePollMs) return;
    lastPollTraceAt = now;
    writeTuiTrace(session, "answer_gate_poll", {
      answered,
      terminator: term.describe,
      hasMenu: gridHasMenu(grid),
      remainingOverallMs: Math.max(0, overallDeadline - now),
      remainingGateMs: Math.max(0, gateDeadline - now),
      screen: grid,
    });
  };

  for (;;) {
    // Disk is the terminator — check it FIRST so we exit the instant the
    // journey's completion signal lands, even if a stale menu lingers on screen.
    if (!stopAtApprovalGate && term.done()) {
      await assertAbsenceObservationCompleted();
      writeTuiTrace(session, "answer_gate_done", {
        answered,
        terminator: term.describe,
      });
      process.stdout.write(
        `answer-gate: terminator met (${term.describe}) after ${answered} answer(s)\n`,
      );
      return;
    }
    if (Date.now() >= overallDeadline) {
      writeTuiTrace(session, "answer_gate_overall_timeout", {
        answered,
        terminator: term.describe,
        overallMs,
        screen: await backend.capture(session, false, "physical"),
      });
      await failAnswerGate(
        backend,
        session,
        `answer-gate: overall timeout (${overallMs}ms) — terminator (${term.describe}) ` +
          `never met after ${answered} answer(s). HANG BACKSTOP, not a pass.`,
        1,
      );
    }

    // Wait for the next menu to paint. Poll the grid; re-check disk each tick
    // (the affirmation can land mid-wait, between the last Enter and the next
    // menu). The screen never goes byte-stable while a turn streams, so we match
    // on appearance (no stability requirement) — the static menu IS the settled
    // state once it is up.
    const gateDeadline = Math.min(Date.now() + perGateMs, overallDeadline);
    let sawMenu = false;
    // Every gate follows input (the launch prompt or the last answer), so this
    // watches a fresh turn.
    const turn = new TurnWatch();
    while (Date.now() < gateDeadline) {
      if (!stopAtApprovalGate && term.done()) {
        await assertAbsenceObservationCompleted();
        writeTuiTrace(session, "answer_gate_done", {
          answered,
          terminator: term.describe,
        });
        process.stdout.write(
          `answer-gate: terminator met (${term.describe}) after ${answered} answer(s)\n`,
        );
        return;
      }
      const grid = await backend.capture(session, false, "physical");
      maybeTracePoll(grid, gateDeadline);
      if (gridHasMenu(grid)) {
        sawMenu = true;
        break;
      }
      if (turn.observe(grid)) {
        writeTuiTrace(session, "answer_gate_turn_ended", {
          answered,
          terminator: term.describe,
          screen: grid,
        });
        await failAnswerGate(
          backend,
          session,
          `answer-gate: the agent ended its turn with no menu, and the terminator ` +
            `(${term.describe}) is not met after ${answered} answer(s).\n` +
            `---- last pane ----\n${grid}\n-------------------`,
          1,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // The gate deadline is the overall one once less than a gate remains; the
    // overall backstop then owns the report at the top of the loop.
    if (!sawMenu && gateDeadline >= overallDeadline) continue;
    if (!sawMenu) {
      const screen = await backend.capture(session, false, "physical");
      writeTuiTrace(session, "answer_gate_menu_timeout", {
        answered,
        perGateMs,
        terminator: term.describe,
        screen,
      });
      await failAnswerGate(
        backend,
        session,
        `answer-gate: per-gate timeout (${perGateMs}ms) — no menu appeared and ` +
          `terminator (${term.describe}) not yet met (answered ${answered} so far). ` +
          `HANG BACKSTOP, not a pass.\n---- last pane ----\n${screen}\n-------------------`,
        1,
      );
    }

    // A menu is up. Answer it by the SHAPE of the gate (see gridIsMultiSelect for
    // the AUQ key model — verified against the claude bundle AND live probing):
    //
    // SUBMIT SCREEN (`❯ 1. Submit answers / 2. Cancel`): the multi-tab form's final
    // confirm. Enter commits the WHOLE form and the journey resumes. Check this
    // FIRST — its option line carries no checkbox, so it must not fall through to
    // either branch below.
    //
    // MULTI-SELECT question (`❯ N. [ ] Option`): Space TOGGLES the highlighted
    // (Recommended) option ON. Enter must NOT be used to advance — Enter also
    // toggles, so Space+Enter nets to zero and spins forever (the t73 1409-answer
    // hang). We toggle exactly the one highlighted option (a deterministic, minimal
    // valid selection), then leave the tab by the shape of the gate:
    //   - multi-tab form (has the `←`/`→` strip): Right advances to the next tab; the
    //     toggle persists across the move (verified live), and the final Submit tab
    //     is handled by the gridIsSubmitScreen branch on the next iteration.
    //   - lone single-question multi-select (no tab strip): there is nowhere to
    //     navigate, so Enter commits it now that one option is toggled on.
    //
    // SINGLE-SELECT question (no checkbox): Enter SELECTS the highlighted/Recommended
    // option and auto-advances to the next tab (or approves a lone-question gate).
    const grid = await backend.capture(session, false, "physical");
    if (
      !absenceAssertionObserved &&
      assertFileAbsentAtOption &&
      assertFileAbsent &&
      gridHasOption(grid, assertFileAbsentAtOption)
    ) {
      if (fileSignalMet(projectDir, assertFileAbsent, false)) {
        await failAnswerGate(
          backend,
          session,
          `'${assertFileAbsent}' already exists while option ` +
            `'${assertFileAbsentAtOption}' is awaiting an answer`,
          1,
        );
      }
      absenceAssertionObserved = true;
      writeTuiTrace(session, "answer_gate_absence_assertion", {
        option: assertFileAbsentAtOption,
        absentFile: assertFileAbsent,
        screen: grid,
      });
    }
    if (stopAtApprovalGate && gridIsApprovalGate(grid)) {
      await assertAbsenceObservationCompleted();
      writeTuiTrace(session, "answer_gate_stopped_at_approval", {
        answered,
        screen: grid,
      });
      process.stdout.write(
        `answer-gate: stopped at approval gate after ${answered} preparatory answer(s)\n`,
      );
      return;
    }
    if (gridIsSubmitScreen(grid)) {
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "submit",
        screen: grid,
      });
      await backend.send(session, "Enter", false, true); // commit the whole form
      if (revisionFeedbackPending) {
        revisionFeedbackPending = false;
        await handleRevisionRecovery(backend, session, answered, overallDeadline);
      }
    } else if (gridIsMultiSelect(grid)) {
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: gridIsMultiTabForm(grid) ? "multi_select_next_tab" : "multi_select_commit",
        screen: grid,
      });
      await backend.send(session, "Space", false, true); // toggle the Recommended option ON
      await sleep(150);
      if (gridIsMultiTabForm(grid)) {
        await backend.send(session, "Right", false, true); // advance to the next tab / Submit
      } else {
        await backend.send(session, "Enter", false, true); // lone multi-select: commit it
      }
    } else if (rejectFirstGate && gridIsApprovalGate(grid)) {
      const requestChangesNeedsSubmit = gridIsMultiTabForm(grid);
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "reject_first_gate",
        requestChangesNeedsSubmit,
        screen: grid,
      });
      // The FIRST approval gate, once: select "Request changes" (option 2) rather
      // than the highlighted "Approve" (option 1). Down moves the caret to option
      // 2; Enter selects it → handleReject (GATE_REJECTED + STAGE_REVISING +
      // Revision Count++). Consume the one-shot so every later gate is approved.
      await backend.send(session, "Down", false, true);
      await sleep(150);
      await backend.send(session, "Enter", false, true);
      rejectFirstGate = false;
      process.stdout.write("answer-gate: rejected first approval gate (Request changes)\n");
      // What the engine does NEXT changed in v0.6.0, so we READ the screen and
      // respond to whatever actually painted instead of blind-typing a fixed
      // string (the old code typed free-text feedback unconditionally; against
      // the new recovery MENU that text landed in the filter slot, the reject
      // never committed, and Revision Count stayed 0 — the t139 finding,
      // 2026-06-09). A multi-tab form must be submitted first: after selecting
      // Request Changes the user still needs to answer later tabs such as
      // Learnings and press Submit before the real revision prompt appears.
      if (requestChangesNeedsSubmit) {
        revisionFeedbackPending = true;
        process.stdout.write(
          "answer-gate: waiting for the multi-tab form submit before revision feedback\n",
        );
      } else {
        await handleRevisionRecovery(backend, session, answered, overallDeadline);
      }
    } else {
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "single_select_default",
        screen: grid,
      });
      await backend.send(session, "Enter", false, true); // select Recommended + advance
    }
    answered++;

    // Brief settle so the next capture does not re-detect the SAME menu before
    // the TUI has consumed the keystroke and begun the next turn. The post-answer
    // screen either advances to the next tab or starts streaming the next turn;
    // either way it stops matching the just-answered menu shortly.
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const sub = a.positionals[0];

  if (["start", "send", "paste", "resize"].includes(sub)) {
    remainingOperationTimeoutMs(undefined, { phase: `TUI ${sub}` });
  }
  // Capture and retirement remain available during the reserved cleanup phase.

  const backend = selectBackend();
  const withinWorkDeadline = (requestedMs: number, run: () => Promise<void>): Promise<void> => {
    // Zero is an immediate poll. Leave its existing result/error contract intact.
    if (requestedMs === 0) return run();
    return tuiOperationDeadline.run(Date.now() + tuiWorkTimeoutMs(requestedMs, `TUI ${sub}`), run);
  };
  switch (sub) {
    case "start":
      return cmdStart(backend, a);
    case "send":
      return cmdSend(backend, a);
    case "wait":
      return withinWorkDeadline(Number(a.flags["timeout-ms"] ?? DEFAULT_TIMEOUT_MS), () => cmdWait(backend, a));
    case "startup":
      return withinWorkDeadline(Number(a.flags["timeout-ms"] ?? DEFAULT_STARTUP_TIMEOUT_MS), () => cmdStartup(backend, a));
    case "capture":
      return cmdCapture(backend, a);
    case "resize":
      if (!backend.resize) fail("resize requires AIDLC_TUI_BACKEND=bun");
      return backend.resize(requireFlag(a, "session"), Number(requireFlag(a, "width")), Number(requireFlag(a, "height")));
    case "paste":
      if (!backend.paste) fail("paste requires AIDLC_TUI_BACKEND=bun");
      return backend.paste(requireFlag(a, "session"), requireFlag(a, "text"));
    case "kill":
      return cmdKill(backend, a);
    case "wait-dead":
      return cmdWaitDead(backend, a);
    case "answer-gate":
      return cmdAnswerGate(backend, a);
    default:
      fail(
        `unknown subcommand '${sub ?? ""}'. ` +
          `Use: start | send | wait | startup | capture | resize | paste | kill | wait-dead | answer-gate`,
      );
  }
}

if ((import.meta as { main?: boolean }).main) {
  await main();
}
