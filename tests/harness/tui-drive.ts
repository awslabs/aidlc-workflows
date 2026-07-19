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
// Two backends, one subcommand surface (D-TUI-2).
//
//   darwin / linux → tmux backend. A detached tmux session lives in the tmux
//                    server, so each subcommand invocation (start/send/capture/
//                    wait/kill) is a fresh process that re-attaches to the
//                    server-side session by name. Proven; byte-for-byte the
//                    behaviour of the original tools/aidlc-tui-drive.ts spike.
//
//   win32          → node-pty backend, spawned UNDER NODE (never bun — node-pty
//                    input wedges under bun on Windows, microsoft/node-pty #748;
//                    so the tui tests spawn `<resolved-node> --experimental-strip-types
//                    tui-drive.ts`, not bun — resolveWinNode() finds node even when
//                    it is off PATH, and the strip-types flag lets node < 22.18 run
//                    the `.ts` entrypoint). node-pty
//                    has no server: a pty + its rendered grid cannot survive
//                    across separate CLI invocations the way a tmux session does.
//                    So `start` forks a long-lived DAEMON (this file re-exec'd as
//                    `__win-daemon`) that owns the pty, pipes pty.onData into an
//                    @xterm/headless Terminal of the same cols/rows, and snapshots
//                    the reconstructed GRID to a file every poll. send/capture/
//                    wait/kill are thin clients that talk to the daemon through
//                    two on-disk channels (a command log the daemon tails, and the
//                    grid snapshot the readers poll). Piping node-pty's raw stream
//                    through @xterm/headless makes Windows `capture` return the
//                    same current-screen grid tmux capture-pane does, so the test
//                    layer needs ZERO platform branches (D-TUI-2).
//
//                    NOTE: the Windows backend is written faithfully to the spike
//                    but CANNOT be validated in this session (no Windows host). Its
//                    live validation is DEFERRED to the EC2 box. Do not assume it
//                    is proven end-to-end — the tmux path is.
//
// Subcommands (identical on both backends):
//   start  --session <name> --cwd <dir> [--width N] [--height N] -- <cmd...>
//          Launch <cmd> in a fresh session of a fixed size.
//   send   --session <name> --keys "<text>" [--literal] [--no-enter]
//          Type keys into the session (Enter appended unless --no-enter).
//          --literal sends the string verbatim for free text / slash commands;
//          omit it for named keys (Enter, Down, C-c).
//   wait   --session <name> --pattern <regex> [--timeout-ms N] [--stable-ms N]
//          Poll the captured grid until <regex> appears. With --stable-ms > 0 the
//          screen must also be unchanged for that long (use for static menus
//          / prompts). With --stable-ms 0 it matches the instant the pattern
//          appears (use when the screen is actively streaming — the statusline
//          token counter / spinner means it never goes byte-stable).
//          Exits 0 on match, 1 on timeout.
//   capture --session <name> [--ansi]
//          Print the current pane (plain text; --ansi keeps colour escapes —
//          tmux only; the node-pty grid is always plain text).
//   kill   --session <name>
//          Kill the session (idempotent).
//   answer-gate --session <name> --project-dir <dir>
//          [--per-gate-timeout-ms N] [--overall-timeout-ms N]
//          [--until-file <relpath>] [--until-state-field <name=regex>]
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

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stateFilePathFor } from "./sdk-drive.ts";

const POLL_INTERVAL_MS = 150;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STABLE_MS = 600;
const DEFAULT_TUI_SETTING_SOURCES = "project";
const DEFAULT_ANSWER_GATE_TRACE_POLL_MS = 10_000;

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
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
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
// Windows node resolution (D-TUI-7). The driver subprocess MUST run under node
// on Windows — node-pty input wedges under bun (microsoft/node-pty #748) — but
// `node` is frequently installed yet NOT on PATH (proven on the EC2 box: node
// v22.14.0 lives at C:\Program Files\nodejs\node.exe but neither bash nor cmd
// resolve a bare `node`). So we resolve a concrete node binary by trying, in
// order: an explicit AIDLC_NODE_BIN override, a bare `node` if it is actually on
// PATH, then the canonical Program Files install path. Returns the first that
// exists, or null when node cannot be found anywhere (the caller treats that as
// a clean capability-ABSENT skip, not a failure).
//
// NOTE on `node foo.ts`: node < 22.18 does NOT auto-strip TypeScript types and
// errors ERR_UNKNOWN_FILE_EXTENSION on a bare `.ts` entrypoint. The box's node
// is 22.14, so every Windows node invocation of this `.ts` file (the daemon
// re-exec here, and the tests' driver spawn) MUST pass --experimental-strip-types.
// macOS/Linux are unaffected — there the driver runs under bun (process.execPath),
// which executes `.ts` natively with no flag (byte-identical to the tmux spike).
export function resolveWinNode(): string | null {
  // bare `node` is on PATH only if `node --version` succeeds.
  const onPath =
    spawnSync("node", ["--version"], { encoding: "utf-8" }).status === 0;
  const candidates = [
    process.env.AIDLC_NODE_BIN,
    onPath ? "node" : undefined,
    "C:\\Program Files\\nodejs\\node.exe",
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c === "node") return c; // already proven on PATH above
    if (existsSync(c)) return c;
  }
  return null;
}

// Resolve a command name to an absolute executable path on Windows. node-pty's
// Windows backend (ConPTY `startProcess`) does NOT do PATH lookup the way
// child_process.spawn does, so a bare command like `claude` throws
// "File not found:" even when it is on PATH (PROVEN on the EC2 box:
// pty.spawn("claude", ...) SPAWN_THREW "File not found"; the absolute
// claude.exe SPAWN_OK with data). `cmd.exe` happens to work bare only because
// Windows resolves System32 implicitly. So before pty.spawn we resolve the
// executable via `where` (the Windows `which`). An already-absolute path, or a
// name that `where` cannot resolve (e.g. `cmd.exe`, which node-pty handles
// itself), is returned unchanged so the daemon's own error path still applies.
// POSIX is unaffected — the tmux backend never calls this.
function resolveWinExecutable(file: string): string {
  if (os.platform() !== "win32") return file;
  // Already an absolute path or one with a directory separator — trust it.
  if (/[\\/]/.test(file) || /^[A-Za-z]:/.test(file)) return file;
  const r = spawnSync("where", [file], { encoding: "utf-8" });
  if (r.status === 0) {
    const first = (r.stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) return first.trim();
  }
  // `where` could not resolve it (e.g. cmd.exe, which ConPTY resolves itself).
  // Return unchanged; node-pty either resolves it or throws its own diagnostic.
  return file;
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
  const exe = commandBasename(command[0]);
  if (!CLAUDE_BASENAMES.has(exe)) return command;
  if (hasSettingSourcesArg(command)) return command;

  const settingSources = tuiSettingSources(env);
  if (!settingSources) return command;

  return [command[0], "--setting-sources", settingSources, ...command.slice(1)];
}

function answerGateTracePollMs(): number {
  const raw = Number(process.env.AIDLC_TUI_TRACE_POLL_MS ?? DEFAULT_ANSWER_GATE_TRACE_POLL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ANSWER_GATE_TRACE_POLL_MS;
  return Math.max(1_000, raw);
}

// A small sleep that works under both bun and node (the Windows daemon runs
// under node where Bun.sleep is absent).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Backend contract (§2.3). Both backends satisfy the same five operations; the
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
  ): void;
  /** Current visible grid as text. ansi keeps colour escapes (tmux only). */
  capture(session: string, ansi: boolean): string;
  /** Kill the session (idempotent). */
  kill(session: string): void;
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

function tmux(args: string[]): { code: number; stdout: string; stderr: string } {
  // `-L <socket>` MUST precede the tmux command; it selects the private server.
  const r = spawnSync("tmux", ["-L", TMUX_SOCKET, ...args], { encoding: "utf-8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
    process.stdout.write(`started session '${session}' (${width}x${height})\n`);
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

  capture(session, ansi) {
    // -p print to stdout, -J join wrapped lines, -e keep escapes (ansi mode).
    const args = ["capture-pane", "-t", session, "-p", "-J"];
    if (ansi) args.push("-e");
    const r = tmux(args);
    if (r.code !== 0) fail(`capture-pane failed: ${r.stderr.trim()}`, 1);
    return r.stdout;
  },

  kill(session) {
    tmux(["kill-session", "-t", session]); // idempotent; ignore errors
  },
};

// ---------------------------------------------------------------------------
// win32 backend (node-pty + @xterm/headless), via a per-session daemon.
//
// The win32 path (node-pty under node, not bun — node-pty input wedges under
// bun's ConPTY, microsoft/node-pty#748) is validated on a Windows Server 2022
// EC2 host stood up from tests/harness/windows/windows-test.cfn.yaml; see the
// Windows runbook in docs/reference/09-testing.md.
//
// Cross-invocation state model: tmux keeps the session in its server; node-pty
// has no server, so `start` forks a long-lived daemon (this file re-exec'd as
// `__win-daemon`) that owns the pty + xterm Terminal. The thin clients talk to
// it through two on-disk channels under a per-session dir:
//   <dir>/cmd.log   — append-only command log the daemon tails (send/kill).
//   <dir>/grid.txt  — the latest reconstructed grid the daemon snapshots; the
//                     capture/wait clients read it.
//   <dir>/meta.json — { cols, rows } so a client can resize/diagnose.
//   <dir>/pid       — the daemon pid, for kill's force-terminate backstop.
// The channels are deliberately dumb files (no named pipes / sockets) so the
// same code runs anywhere a filesystem does.
// ---------------------------------------------------------------------------

function winSessionDir(session: string): string {
  // Namespaced under tmpdir so parallel sessions never collide. The session
  // name is sanitised to a filesystem-safe token.
  const safe = session.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(tmpdir(), "tui-drive", safe);
}

const win32Backend: Backend = {
  async start(session, cwd, width, height, cmd) {
    if (cmd.length === 0) fail("no command after `--` to run in the session");

    const dir = winSessionDir(session);
    // Idempotent start: tear down any stale daemon + channel dir first.
    win32Backend.kill(session);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cols: width, rows: height }));

    // Fork the daemon UNDER NODE (never bun — node-pty input wedges under bun,
    // microsoft/node-pty #748). We re-exec THIS file with the `__win-daemon`
    // subcommand. Resolve a concrete node binary (PATH may not carry `node` even
    // when it is installed — proven on the EC2 box), and pass
    // --experimental-strip-types because node < 22.18 cannot run a bare `.ts`
    // entrypoint (ERR_UNKNOWN_FILE_EXTENSION). resolveWinNode never returns null
    // here in practice: this branch only runs on win32 after `start` was dispatched,
    // which the preflight gates on node being present.
    const nodeBin = resolveWinNode();
    if (!nodeBin) {
      fail(
        "cannot launch the Windows daemon — node.exe not found (set AIDLC_NODE_BIN " +
          "or install node so it is on PATH / at C:\\Program Files\\nodejs). #748: " +
          "the daemon must run under node, never bun.",
      );
    }
    const selfPath = fileURLToPathSafe(import.meta.url);
    const child = spawn(
      nodeBin,
      [
        "--experimental-strip-types",
        selfPath,
        "__win-daemon",
        "--session",
        session,
        "--cwd",
        cwd,
        "--width",
        String(width),
        "--height",
        String(height),
        "--",
        ...cmd,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    if (child.pid !== undefined) {
      writeFileSync(join(dir, "pid"), String(child.pid));
    }
    child.unref();
    process.stdout.write(`started session '${session}' (${width}x${height})\n`);
  },

  send(session, keys, literal, noEnter) {
    const dir = winSessionDir(session);
    if (!existsSync(dir)) fail(`no live session '${session}'`, 1);
    // The daemon translates these the same way tmux does: named keys (Enter,
    // Down, ...) vs literal text. We forward the raw intent; the daemon owns the
    // keystroke encoding (CSI sequences for arrows, \r for Enter).
    const record = `${JSON.stringify({ kind: "send", keys, literal, noEnter })}\n`;
    appendFileSync(join(dir, "cmd.log"), record);
  },

  capture(session, _ansi) {
    // node-pty has no colour-escape passthrough equivalent to tmux -e; the grid
    // is always reconstructed as plain text (xterm strips SGR into cell attrs we
    // do not re-serialise). _ansi is accepted for surface parity and ignored.
    const dir = winSessionDir(session);
    const gridPath = join(dir, "grid.txt");
    if (!existsSync(gridPath)) return "";
    return readFileSync(gridPath, "utf8");
  },

  kill(session) {
    const dir = winSessionDir(session);
    if (!existsSync(dir)) return;
    // 1) Ask the daemon to tear the pty down cleanly (it filters the ConPTY
    //    "Socket is closed" / AttachConsole teardown noise itself).
    try {
      appendFileSync(join(dir, "cmd.log"), `${JSON.stringify({ kind: "kill" })}\n`);
    } catch {
      // channel already gone — fall through to the force-kill backstop.
    }
    // 2) Force-kill backstop: node-pty hangs on ConPTY teardown (p.kill() →
    //    "Socket is closed"), so never block on it. Hard-terminate the daemon
    //    pid after a short grace; the daemon's process.exit closes the pty.
    const pidPath = join(dir, "pid");
    if (existsSync(pidPath)) {
      const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (Number.isFinite(pid)) {
        // Best-effort: SIGTERM, then the OS reaps. On Windows taskkill /F /PID
        // is the reliable force-terminate (Stop-Process equivalent from the
        // capture-v3 spike); on POSIX a plain kill suffices (this branch only
        // runs on win32 in practice, but stays portable for local inspection).
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
            stdio: "ignore",
          });
        } else {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already dead
          }
        }
      }
    }
  },
};

// Resolve import.meta.url to a filesystem path without pulling node:url into the
// hot path twice. Kept tiny + dependency-light.
function fileURLToPathSafe(url: string): string {
  if (url.startsWith("file://")) {
    let p = decodeURIComponent(url.slice("file://".length));
    // Windows file URLs look like file:///C:/path — strip the leading slash.
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  }
  return url;
}

// ---------------------------------------------------------------------------
// win32 DAEMON — owns the pty + @xterm/headless Terminal for one session.
//
// Runs UNDER NODE only. node-pty + @xterm/headless are imported HERE (inside the
// daemon path) via dynamic import so the macOS/Linux tmux path — and any bun
// process that merely loads this module — never touches node-pty (the #748
// in-process wedge can only happen if node-pty is loaded; we keep it out of
// every path except the node daemon).
// ---------------------------------------------------------------------------

async function runWinDaemon(a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const cwd = requireFlag(a, "cwd");
  const cols = Number(a.flags.width ?? "120");
  const rows = Number(a.flags.height ?? "40");
  const cmd = a.rest;
  if (cmd.length === 0) {
    process.stderr.write("tui-drive __win-daemon: no command after `--`\n");
    process.exit(2);
  }

  const dir = winSessionDir(session);
  mkdirSync(dir, { recursive: true });
  const gridPath = join(dir, "grid.txt");
  const cmdLogPath = join(dir, "cmd.log");

  // Dynamic imports: keep node-pty + @xterm/headless out of every non-daemon
  // path. These resolve only here, under node.
  const pty = await import("node-pty");
  // @xterm/headless is a CommonJS module (package main = lib-headless/...). bun's
  // ESM interop hoists its `Terminal` export to the namespace top level, but
  // node's CJS interop nests the whole module under `default` — so a bare
  // `{ Terminal }` destructure reads `undefined` under node and `new Terminal()`
  // throws "Terminal is not a constructor" (proven on the EC2 box: keys=["default"],
  // typeof m.Terminal=undefined, typeof m.default.Terminal=function). Resolve the
  // constructor across BOTH interop shapes so the daemon builds the grid on every
  // runtime (bun on POSIX, node on Windows).
  const xterm = (await import("@xterm/headless")) as {
    Terminal?: typeof import("@xterm/headless").Terminal;
    default?: { Terminal?: typeof import("@xterm/headless").Terminal };
  };
  const Terminal = xterm.Terminal ?? xterm.default?.Terminal;
  if (typeof Terminal !== "function") {
    process.stderr.write(
      "tui-drive __win-daemon: @xterm/headless Terminal constructor not found " +
        "in either interop shape (m.Terminal / m.default.Terminal)\n",
    );
    process.exit(2);
  }

  // Preseed onboarding so the zero-keystroke statusline path skips the startup
  // modals (§2.3 Windows preseed). Forward-slash project key — claude normalises
  // to forward-slash; a backslash key silently misses and the trust modal
  // reappears.
  preseedClaudeOnboarding(cwd);

  const term = new Terminal({ cols, rows, allowProposedApi: true });

  // Resolve to an absolute path on Windows: node-pty's ConPTY backend does no
  // PATH lookup, so a bare `claude` throws "File not found:" even when on PATH.
  const file = resolveWinExecutable(cmd[0]);
  const args = cmd.slice(1);
  const child = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  child.onData((data) => term.write(data));

  // Snapshot the reconstructed grid on a timer so capture/wait clients always
  // read a current screen — the tmux capture-pane equivalent. We serialise the
  // viewport (baseY .. baseY+rows-1) so scrollback never leaks into a match (the
  // scrollback false-positive that bit the raw-stream spike, §2.2).
  const snapshot = (): void => {
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    // trimEnd trailing blank lines so the grid shape matches tmux capture-pane
    // (which does not pad to full height).
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    try {
      writeFileSync(gridPath, lines.join("\n") + (lines.length ? "\n" : ""));
    } catch {
      // best-effort; next tick retries
    }
  };
  const snapTimer = setInterval(snapshot, POLL_INTERVAL_MS);

  // Tail the command log for send/kill. We track the byte offset consumed so we
  // never re-process a record.
  let consumed = 0;
  const teardown = (): void => {
    clearInterval(snapTimer);
    snapshot(); // final grid
    try {
      // node-pty hangs on ConPTY teardown; don't block. Best-effort kill, then
      // hard-exit so the OS reaps the pty. Filter the AttachConsole stderr noise
      // by simply not surfacing it.
      child.kill();
    } catch {
      // "Socket is closed" / AttachConsole — expected on ConPTY teardown.
    }
    process.exit(0);
  };

  child.onExit(() => {
    clearInterval(snapTimer);
    snapshot();
    // Leave the grid in place so a final capture sees the end-state, then exit.
    process.exit(0);
  });

  const pump = async (): Promise<void> => {
    for (;;) {
      if (existsSync(cmdLogPath)) {
        const raw = readFileSync(cmdLogPath, "utf8");
        if (raw.length > consumed) {
          const fresh = raw.slice(consumed);
          consumed = raw.length;
          for (const line of fresh.split("\n")) {
            if (!line.trim()) continue;
            let rec: { kind: string; keys?: string; literal?: boolean; noEnter?: boolean };
            try {
              rec = JSON.parse(line);
            } catch {
              continue;
            }
            if (rec.kind === "kill") {
              teardown();
              return;
            }
            if (rec.kind === "send") {
              child.write(encodeKeys(rec.keys ?? "", rec.literal === true));
              if (rec.noEnter !== true) child.write("\r");
            }
          }
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };
  await pump();
}

// Translate the send intent into a byte stream node-pty.write understands. For
// literal text we pass it verbatim. For named keys we map the tmux key names the
// callers already use (Enter / Down / Up / C-c / Space) to their control / CSI
// sequences, so the same test script drives both backends unchanged.
function encodeKeys(keys: string, literal: boolean): string {
  if (literal) return keys;
  const named: Record<string, string> = {
    Enter: "\r",
    Down: "\x1b[B",
    Up: "\x1b[A",
    Right: "\x1b[C",
    Left: "\x1b[D",
    Space: " ",
    Tab: "\t",
    Escape: "\x1b",
    BSpace: "\x7f",
    "C-c": "\x03",
  };
  return keys in named ? named[keys] : keys;
}

// Write ~/.claude.json with hasCompletedOnboarding + a forward-slash project key
// so the Windows zero-keystroke path skips the startup modals (§2.3). Best-effort
// and additive: never clobbers an existing config beyond the two keys.
function preseedClaudeOnboarding(projectDir: string): void {
  try {
    const home = os.homedir();
    const cfgPath = join(home, ".claude.json");
    let cfg: Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      } catch {
        cfg = {};
      }
    }
    cfg.hasCompletedOnboarding = true;
    const projects =
      (cfg.projects as Record<string, unknown> | undefined) ?? {};
    // Forward-slash key — claude normalises to forward-slash; a backslash key
    // silently misses and the trust modal reappears.
    const key = projectDir.replaceAll("\\", "/");
    if (!(key in projects)) projects[key] = { hasTrustDialogAccepted: true };
    cfg.projects = projects;
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
  const plat = os.platform();
  if (plat === "win32") return win32Backend;
  // darwin / linux (and any other POSIX) → tmux. The original spike's behaviour.
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
  writeTuiTrace(session, "start", {
    cwd,
    width,
    height,
    command,
    requestedCommand: command.join("\0") === a.rest.join("\0") ? undefined : a.rest,
  });
  await backend.start(session, cwd, width, height, command);
}

function cmdSend(backend: Backend, a: Args): void {
  const session = requireFlag(a, "session");
  const keys = requireFlag(a, "keys");
  writeTuiTrace(session, "send", {
    keys,
    literal: a.bools.literal === true,
    noEnter: a.bools["no-enter"] === true,
  });
  backend.send(session, keys, a.bools.literal === true, a.bools["no-enter"] === true);
}

async function cmdWait(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const pattern = requireFlag(a, "pattern");
  const timeoutMs = Number(a.flags["timeout-ms"] ?? DEFAULT_TIMEOUT_MS);
  const stableMs = Number(a.flags["stable-ms"] ?? DEFAULT_STABLE_MS);
  const re = new RegExp(pattern);
  writeTuiTrace(session, "wait_start", { pattern, timeoutMs, stableMs });

  const deadline = Date.now() + timeoutMs;
  let prev = "";
  let stableSince = 0;

  while (Date.now() < deadline) {
    const screen = backend.capture(session, false);
    const now = Date.now();
    if (screen === prev) {
      if (stableSince === 0) stableSince = now;
    } else {
      stableSince = 0;
      prev = screen;
    }
    // stableMs <= 0 means "match the instant the pattern appears" — no
    // stability requirement. This is essential when asserting against a
    // screen that is actively streaming (the statusline has a live token
    // counter / spinner, so the whole screen never goes byte-stable).
    // stableMs > 0 waits for the screen to settle — use it for menus /
    // prompts that are static while awaiting input.
    const stable =
      stableMs <= 0 || (stableSince !== 0 && now - stableSince >= stableMs);
    if (re.test(screen) && stable) {
      writeTuiTrace(session, "wait_match", {
        pattern,
        stableMs,
        screen,
      });
      process.stdout.write(`matched /${pattern}/ (stable ${stableMs}ms)\n`);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  writeTuiTrace(session, "wait_timeout", {
    pattern,
    timeoutMs,
    stableMs,
    screen: prev,
  });
  process.stderr.write(
    `tui-drive: timed out after ${timeoutMs}ms waiting for /${pattern}/\n` +
      `---- last pane ----\n${prev}\n-------------------\n`,
  );
  process.exit(1);
}

function cmdCapture(backend: Backend, a: Args): void {
  const session = requireFlag(a, "session");
  const ansi = a.bools.ansi === true;
  const screen = backend.capture(session, ansi);
  writeTuiTrace(session, "capture", { ansi, screen });
  process.stdout.write(screen);
}

function cmdKill(backend: Backend, a: Args): void {
  const session = requireFlag(a, "session");
  writeTuiTrace(session, "kill", {});
  backend.kill(session);
  process.stdout.write(`killed session '${session}'\n`);
}

// ---------------------------------------------------------------------------
// answer-gate — the shared AskUserQuestion answer loop (§3, D-TUI-3).
//
// One implementation, both backends: it only uses backend.capture + backend.send,
// so the tmux and node-pty paths drive it identically. It is the value of the
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
//   (none)                          terminate on the practices-affirmation timestamp
type Terminator = { describe: string; done: () => boolean };

// Does a relative path (optionally containing a single `*` glob in its last
// segment, or any segment) resolve to an existing, non-empty file under root?
function fileSignalMet(root: string, rel: string): boolean {
  // Walk the path segment by segment, expanding a `*` segment to its dir entries.
  let dirs = [root];
  const segs = rel.split("/").filter((s) => s.length > 0);
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
        const re = new RegExp(
          `^${seg.replaceAll(".", "\\.").replaceAll("*", ".*")}$`,
        );
        for (const e of entries) {
          if (re.test(e)) next.push(join(d, e));
        }
      } else {
        next.push(join(d, seg));
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
      if (existsSync(p) && statSync(p).isFile() && statSync(p).size > 0) return true;
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

// The AUQ highlighted-option caret, as a PLATFORM-INVARIANT signal. The real claude
// renders the highlighted option's caret as `❯` (U+276F) under tmux on macOS/Linux,
// but DOWNGRADES it to an ASCII `>` under Windows ConPTY (PROVEN by reading the
// reconstructed grid.txt on the EC2 box 2026-06-06: the option line came through as
// `> 1. feature ...`, codepoint 62, while `❯` was absent — even though every OTHER
// glyph, `▎`/`→`/box-drawing, survived; it is specifically claude's caret choice
// that varies by terminal). A caret-only `❯` check (the original gridHasMenu) thus
// never matched on Windows and hung every answer-gate journey there.
//
// We match the caret ONLY when it precedes a numbered option (`❯ 1.` / `> 1.`), which
// is what AUQ paints on its highlighted row. This is the load-bearing reason a bare
// `>` is SAFE here: the claude input prompt line is also `>` (`> /aidlc feature`,
// `> `), but it is NEVER followed by `<digit>.`, so it cannot satisfy this pattern.
// Anchored per-line so the prompt elsewhere on screen can't bleed in.
const AUQ_CARET_OPTION = /^\s*(?:❯|>)\s+\d+\.\s/m;
function gridHasCaret(grid: string): boolean {
  return AUQ_CARET_OPTION.test(grid);
}

// Is a waiting AskUserQuestion menu painted on the grid right now? A menu shows
// the highlighted-default caret (`❯` on tmux, `>` on Windows ConPTY — see
// gridHasCaret) on a numbered option AND a footer. CRITICAL: the Submit screen
// DROPS the `Enter to select` footer and shows `Submit answers` instead — a
// footer-only waiter sails past Submit and hangs forever (cost a full macOS run
// during the spike). So we accept EITHER footer.
export function gridHasMenu(grid: string): boolean {
  return gridHasCaret(grid) && (grid.includes("Enter to select") || grid.includes("Submit answers"));
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
// We detect a multi-select question by the checkbox markers it paints on its OPTION
// lines only — `❯ 1. [ ] Option` / `  2. [✔] Option` (tmux paints `✔`; claude -p /
// node-pty paint `x`). We deliberately do NOT key off the prose "select all that
// apply" (it echoes on the Submit review screen) nor the tab-strip `☐`/`☒` glyphs
// (present on EVERY tab, single-select ones included) — both misfire.
function gridIsMultiSelect(grid: string): boolean {
  return /\d+\.\s*\[[ xX✔]\]/.test(grid); // a numbered option line carrying a checkbox
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
    const m = /^\s*(?:❯|>)?\s*(\d+)\.\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ num: Number(m[1]), label: m[2].trim() });
  }
  return out;
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
    backend.send(session, "Down", false, true);
    await sleep(120);
  }
  backend.send(session, "Enter", false, true);
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

async function handleRevisionRecovery(
  backend: Backend,
  session: string,
  answered: number,
): Promise<boolean> {
  const recoveryDeadline = Date.now() + 60_000;
  while (Date.now() < recoveryDeadline) {
    await sleep(POLL_INTERVAL_MS);
    const after = backend.capture(session, false);
    const typeSomethingNum = pickRevisionTypeSomethingOption(after);
    if (typeSomethingNum !== null) {
      await chooseNumberedMenuOption(backend, session, typeSomethingNum);
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "reject_choose_type_something",
        optionNum: typeSomethingNum,
        screen: after,
      });

      const promptDeadline = Date.now() + 10_000;
      while (Date.now() < promptDeadline) {
        await sleep(POLL_INTERVAL_MS);
        const prompt = backend.capture(session, false);
        if (!gridHasMenu(prompt)) {
          backend.send(session, REVISION_FEEDBACK, true, true);
          await sleep(300);
          backend.send(session, "Enter", false, true);
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
    // No recovery menu painted yet. If the turn has gone quiet without a menu
    // for long enough, treat it as the free-text shape and supply feedback.
    // The quiet threshold must outlast a structured question's paint time: a
    // conductor that (correctly, per stage-protocol Part 0) answers the reject
    // with a structured clarifying menu takes ~13s to render it, and a 10s
    // hedge races that paint and injects free text a structured-only driver
    // would never send. 30s of quiet before hedging leaves the positive
    // free-text detection above instant and keeps the 60s hang-backstop.
    if (
      gridLooksLikeRevisionFreeTextPrompt(after) ||
      (!gridHasMenu(after) && Date.now() > recoveryDeadline - 30_000)
    ) {
      backend.send(session, REVISION_FEEDBACK, true, true);
      await sleep(300);
      backend.send(session, "Enter", false, true);
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

async function cmdAnswerGate(backend: Backend, a: Args): Promise<void> {
  const session = requireFlag(a, "session");
  const projectDir = requireFlag(a, "project-dir");
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
  const overallMs = Number(a.flags["overall-timeout-ms"] ?? "600000");
  const perGateMs = Number(a.flags["per-gate-timeout-ms"] ?? String(overallMs));
  // The on-disk signal that means STOP answering — workshop affirmation by
  // default, or a journey-specific file/state-field via --until-* (see
  // makeTerminator). The keystroke strategy is the same for every journey;
  // only this terminator differs.
  const term = makeTerminator(projectDir, a);

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
        screen: backend.capture(session, false),
      });
      fail(
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
    while (Date.now() < gateDeadline) {
      if (!stopAtApprovalGate && term.done()) {
        writeTuiTrace(session, "answer_gate_done", {
          answered,
          terminator: term.describe,
        });
        process.stdout.write(
          `answer-gate: terminator met (${term.describe}) after ${answered} answer(s)\n`,
        );
        return;
      }
      const grid = backend.capture(session, false);
      maybeTracePoll(grid, gateDeadline);
      if (gridHasMenu(grid)) {
        sawMenu = true;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    if (!sawMenu) {
      const screen = backend.capture(session, false);
      writeTuiTrace(session, "answer_gate_menu_timeout", {
        answered,
        perGateMs,
        terminator: term.describe,
        screen,
      });
      fail(
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
    const grid = backend.capture(session, false);
    if (stopAtApprovalGate && gridIsApprovalGate(grid)) {
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
      backend.send(session, "Enter", false, true); // commit the whole form
      if (revisionFeedbackPending) {
        revisionFeedbackPending = false;
        await handleRevisionRecovery(backend, session, answered);
      }
    } else if (gridIsMultiSelect(grid)) {
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: gridIsMultiTabForm(grid) ? "multi_select_next_tab" : "multi_select_commit",
        screen: grid,
      });
      backend.send(session, "Space", false, true); // toggle the Recommended option ON
      await sleep(150);
      if (gridIsMultiTabForm(grid)) {
        backend.send(session, "Right", false, true); // advance to the next tab / Submit
      } else {
        backend.send(session, "Enter", false, true); // lone multi-select: commit it
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
      backend.send(session, "Down", false, true);
      await sleep(150);
      backend.send(session, "Enter", false, true);
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
        await handleRevisionRecovery(backend, session, answered);
      }
    } else {
      writeTuiTrace(session, "answer_gate_action", {
        answered,
        action: "single_select_default",
        screen: grid,
      });
      backend.send(session, "Enter", false, true); // select Recommended + advance
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

  // The internal daemon entrypoint (win32 only) is dispatched before backend
  // selection so it owns the pty itself rather than proxying to a backend.
  if (sub === "__win-daemon") {
    return runWinDaemon(a);
  }

  const backend = selectBackend();
  switch (sub) {
    case "start":
      return cmdStart(backend, a);
    case "send":
      return cmdSend(backend, a);
    case "wait":
      return cmdWait(backend, a);
    case "capture":
      return cmdCapture(backend, a);
    case "kill":
      return cmdKill(backend, a);
    case "answer-gate":
      return cmdAnswerGate(backend, a);
    default:
      fail(
        `unknown subcommand '${sub ?? ""}'. ` +
          `Use: start | send | wait | capture | kill | answer-gate`,
      );
  }
}

// Run main() ONLY when this file is the executed entrypoint — never when it is
// imported (the tui tests import resolveWinNode() from here; an unguarded
// top-level `await main()` would parse the TEST RUNNER's argv, hit the default
// case, and process.exit(2) the importer). bun sets import.meta.main; node < 23
// does not, so fall back to comparing this module's path to argv[1] (covers the
// Windows daemon re-exec, which runs under node directly).
function isEntrypoint(): boolean {
  // import.meta.main is a bun extension (a boolean at runtime); under node < 23
  // it is undefined, so fall back to the argv[1] path comparison.
  const metaMain = (import.meta as { main?: boolean }).main;
  if (typeof metaMain === "boolean") return metaMain;
  const entry = process.argv[1];
  if (!entry) return false;
  // Normalise BOTH paths before comparing. On Windows under node, argv[1] is a
  // BACKSLASH path (C:\...\tui-drive.ts) while fileURLToPathSafe(import.meta.url)
  // yields a FORWARD-slash path (C:/.../tui-drive.ts), so a raw === is always
  // false there — main() never runs, every subcommand (start / capture /
  // __win-daemon) silently no-ops with exit 0, and the Windows backend produces
  // an empty grid (PROVEN on the EC2 box: resolved=C:/probe-entry.ts vs
  // argv[1]=C:\probe-entry.ts, EQUAL=false). Fold separators to `/` and lowercase
  // (Windows paths are case-insensitive) so the daemon re-exec is recognised as
  // the entrypoint. macOS/Linux are unaffected — the bun branch returns above.
  const norm = (p: string): string => p.replaceAll("\\", "/").toLowerCase();
  return norm(fileURLToPathSafe(import.meta.url)) === norm(entry);
}

if (isEntrypoint()) {
  await main();
}
