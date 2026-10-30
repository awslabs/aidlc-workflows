// copilot-tui.ts - GitHub Copilot CLI's own interactive terminal (`copilot`,
// no -p), driven through tui-drive.ts the way a person uses it, for the live
// Copilot journeys. Each line the person types goes in at Copilot's prompt.
// A `copilot -p` session opens with Copilot's own "non-interactive mode ... Do
// not stop to ask questions" system message, which a person in this terminal
// never meets, so the journeys judge what the person meets here.
//
// Copilot asks before each shell command and file write ("Do you want to run
// this command?", "Do you want to create ...?") with "1. Yes" preselected; the
// driver takes it with Enter, as a person on Copilot's default mode does. Any
// other dialog stops the turn: AI-DLC asks its questions as numbered text (its
// PreToolUse guard denies ask_user), so a dialog that is not a permission one
// is not the driver's to answer.
//
// What happened in a turn is read from Copilot's own session record
// (COPILOT_HOME/session-state/<id>/events.jsonl), which carries the events
// `copilot --output-format json` prints, so copilotToolResults and
// copilotReplies read it unchanged; its permission.requested events are the
// dialogs. A turn ends when the screen shows the empty prompt and has held
// still (the spinner's clock moves while the agent works), and the record
// agrees: the line arrived and the agent's last model call closed with no tool
// call open.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { copilotReplies, copilotToolResults } from "./exec-drive.ts";
import { type AgentWords, keepAgentWords, keepLegAudit } from "./leg-evidence.ts";
import { PersonTurnLedger, unbackedFailure } from "./person-turns.ts";
import { waitForTurn } from "./release-journey.ts";
import type { CapturedToolResult } from "./sdk-drive.ts";
import { assertTuiDriveKill } from "./tui-fixtures.ts";
import { resolveTuiRuntime } from "./tui-runtime.ts";

/** One tui-drive.ts command (start, send, wait, capture, kill) and what it returned. */
export type TuiDrive = (args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => { rc: number; stdout: string; stderr?: string; timedOut: boolean };

let runtime: { bin: string; prefix: string[] } | undefined;
const tuiDrive: TuiDrive = (args, timeoutMs, env) => {
  runtime ??= resolveTuiRuntime(join(import.meta.dir, "tui-drive.ts"));
  const res = spawnSync(runtime.bin, [...runtime.prefix, ...args], { timeout: timeoutMs, encoding: "utf-8", ...(env ? { env } : {}) });
  return {
    rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "",
    timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
};

/**
 * The program `tui-drive start` launches for `bin` on Windows. `where` lists npm's extensionless shell shim before
 * its .cmd launcher, and the shim is no Windows program; tui-drive starts a .cmd through cmd.exe. A path is kept as
 * it is, and so is a name `where` does not find (the launch then reports its own error).
 */
export function windowsLauncher(bin: string, where: (name: string) => string[] = whereOnPath): string {
  if (/[\\/]/.test(bin) || /^[A-Za-z]:/.test(bin)) return bin;
  return where(bin).find((hit) => /\.(?:exe|cmd|bat)$/i.test(hit)) ?? bin;
}

function whereOnPath(name: string): string[] {
  const res = spawnSync("where", [name], { encoding: "utf-8", timeout: 30_000 });
  return res.status === 0 ? (res.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

/** One Copilot permission dialog the person answered: what drew it. */
export interface CopilotPrompt {
  /** `aidlc`: one of AI-DLC's own commands; `command`: another shell command; `write`: a file Copilot writes. */
  kind: "aidlc" | "command" | "write";
  what: string;
}

export interface CopilotTerminalTurn {
  /** The turn ended with Copilot waiting at its prompt. */
  ended: boolean;
  /** Why it did not: a dialog the driver does not answer, or the time ran out, with the screen's last lines. */
  stopped?: string;
  prompts: CopilotPrompt[];
  /** The agent's shell commands, in the shape the SDK drive captures them. */
  results: CapturedToolResult[];
  /** What the agent told the person (not its helpers). */
  words: AgentWords[];
  tokens: { input: number; output: number };
}

export interface CopilotTerminalOptions {
  session: string;
  proj: string;
  copilotHome: string;
  bin: string;
  /** The work time left for one drive call, and the time cleanup keeps. */
  workMs: () => number;
  cleanupMs: () => number;
  /** The terminal driver: tui-drive.ts unless a test scripts one. */
  drive?: TuiDrive;
}

// The empty prompt above Copilot's footer, and the footer's own words.
const PROMPT_LINE = /^\s*\u276F\s*$/m;
const FOOTER = "/ commands";
const DIALOG = "enter to select";
const PERMISSION = /Do you want to (?:run|create|edit|write|make|delete|use|allow)\b/;
// How long the screen holds still before a turn counts as ended.
const STILL_MS = 10_000;

const bottom = (screen: string) => screen.split("\n").slice(-25).join("\n");
// A dialog's own box, from its top border down: the lines above it (the shell
// line's clock) keep changing while it waits, the box does not.
const dialogBox = (tail: string) => tail.slice(Math.max(0, tail.lastIndexOf("\u256D")));
// AI-DLC's own command: its dispatcher or a tool under .aidlc/tools, run by bun
// or node, also as PowerShell's `& bun ...`.
const AIDLC_COMMAND = /^(?:&\s*)?(?:["']?\S*?(?:bun|node)(?:\.exe)?["']?\s+)?["']?\S*?\.aidlc[\\/]+tools[\\/]+aidlc[\w-]*\.ts\b/;

interface RecordEvent {
  type?: string;
  data?: {
    content?: unknown;
    parentToolCallId?: unknown;
    permissionRequest?: { kind?: unknown; fullCommandText?: unknown; fileName?: unknown };
    usage?: { inputTokens?: unknown; outputTokens?: unknown };
  };
}

/** Copilot CLI's interactive terminal in one project, with the session record it keeps. */
export class CopilotTerminal {
  private readonly read = new Map<string, number>();

  constructor(private readonly o: CopilotTerminalOptions) {}

  private drive(args: string[], timeout = this.o.workMs(), env?: NodeJS.ProcessEnv): ReturnType<TuiDrive> {
    return (this.o.drive ?? tuiDrive)(args, timeout, env);
  }

  private wait(pattern: string, timeoutMs: number, stableMs: number): boolean {
    const bound = Math.max(1, Math.min(timeoutMs, this.o.workMs()));
    return this.drive(["wait", "--session", this.o.session, "--pattern", pattern, "--timeout-ms", String(bound), "--stable-ms", String(stableMs)]).rc === 0;
  }

  private key(keys: string, literal = false): void {
    this.drive(["send", "--session", this.o.session, "--keys", keys, ...(literal ? ["--literal"] : []), "--no-enter"]);
  }

  screen(timeout?: number): string {
    return this.drive(["capture", "--session", this.o.session], timeout).stdout;
  }

  // Look at the screen until `done` holds or `ms` pass.
  private until(done: (screen: string) => boolean, ms: number): void {
    const end = Date.now() + ms;
    while (!done(this.screen()) && Date.now() < end) Bun.sleepSync(250);
  }

  private waiting(screen: string): boolean {
    const tail = bottom(screen);
    return PROMPT_LINE.test(tail) && tail.includes(FOOTER) && !tail.includes(DIALOG);
  }

  /**
   * Start `copilot` with this project's Copilot home and wait for its prompt.
   * The folder is trusted beforehand, so a dialog here (trust, sign-in) is a
   * problem; it throws with the screen.
   */
  start(): void {
    this.skipRecord();
    const env = { ...process.env, COPILOT_HOME: this.o.copilotHome };
    // A scripted driver gets the name as given.
    const bin = process.platform === "win32" && !this.o.drive ? windowsLauncher(this.o.bin) : this.o.bin;
    const started = this.drive(["start", "--session", this.o.session, "--cwd", this.o.proj, "--width", "200", "--height", "50", "--", bin], undefined, env);
    if (started.rc !== 0) throw new Error(`tui-drive could not start ${bin} (exit ${started.rc})`);
    const ready = waitForTurn((left) => this.wait(`${FOOTER}|${DIALOG}`, Math.min(left, 60_000), 1500), this.o.workMs);
    const screen = this.screen();
    if (!ready || !this.waiting(screen)) throw new Error(`Copilot CLI did not reach its prompt:\n${bottom(screen)}`);
  }

  /** Type `line` at the prompt and drive the turn to its end. */
  turn(line: string): CopilotTerminalTurn {
    this.key(line, true);
    this.key("Enter");
    let stopped: string | undefined;
    // Still screens at the prompt that the record does not close yet: a model
    // error also leaves the person at the prompt, with no closing event.
    let unclosed = 0;
    const ended = waitForTurn((left) => {
      // A dialog's screen never holds still, so the screen is read as soon as either shows.
      if (!this.wait(`${FOOTER}|${DIALOG}`, Math.min(left, 60_000), 0)) return false;
      const tail = bottom(this.screen());
      if (tail.includes(DIALOG)) {
        if (!PERMISSION.test(tail)) {
          stopped = `a dialog the driver does not answer:\n${tail}`;
          return true;
        }
        this.key("Enter");
        // One Enter per dialog: look again once Copilot has taken the answer.
        const box = dialogBox(tail);
        this.until((screen) => dialogBox(bottom(screen)) !== box, Math.min(left, 10_000));
        return false;
      }
      if (!this.waiting(tail)) {
        Bun.sleepSync(Math.max(1, Math.min(left, 1000)));
        return false;
      }
      if (!this.wait(FOOTER, Math.min(left, STILL_MS * 3), STILL_MS)) return false;
      if (!this.waiting(this.screen())) return false;
      return this.recordShowsTurnEnded(line) || ++unclosed >= 6;
    }, this.o.workMs) && stopped === undefined;
    // The work budget is spent here, so the last screen is read on the cleanup's time.
    if (!ended && stopped === undefined) stopped = `the time ran out:\n${bottom(this.screen(this.o.cleanupMs()))}`;
    const events = this.newEvents();
    const text = events.map((event) => JSON.stringify(event)).join("\n");
    const turn: CopilotTerminalTurn = {
      ended, ...(stopped === undefined ? {} : { stopped }),
      prompts: prompts(events), results: copilotToolResults(text), words: copilotReplies(text, true), tokens: tokens(events),
    };
    keepAgentWords("copilot", turn.words);
    keepLegAudit(this.o.proj);
    return turn;
  }

  /** Close the terminal (Copilot and its session); a session left running fails. */
  kill(): void {
    assertTuiDriveKill(this.drive(["kill", "--session", this.o.session], this.o.cleanupMs()), this.o.session);
  }

  private recordFiles(): string[] {
    const dir = join(this.o.copilotHome, "session-state");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((id) => join(dir, id, "events.jsonl")).filter((file) => existsSync(file)).sort();
  }

  private lines(file: string): string[] {
    const text = readFileSync(file, "utf8");
    // A line Copilot is still writing is read with the next turn.
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
  }

  // Sessions already in the home belong to earlier terminals.
  private skipRecord(): void {
    for (const file of this.recordFiles()) this.read.set(file, this.lines(file).length);
  }

  private unread(): RecordEvent[] {
    const events: RecordEvent[] = [];
    for (const file of this.recordFiles()) {
      for (const line of this.lines(file).slice(this.read.get(file) ?? 0)) {
        try {
          events.push(JSON.parse(line) as RecordEvent);
        } catch {
          events.push({});
        }
      }
    }
    return events;
  }

  private newEvents(): RecordEvent[] {
    const events = this.unread();
    for (const file of this.recordFiles()) this.read.set(file, this.lines(file).length);
    return events;
  }

  // The line reached the agent, and its last model call closed with no tool call left open.
  private recordShowsTurnEnded(line: string): boolean {
    const events = this.unread();
    const own = events.filter((event) => !event.data?.parentToolCallId);
    const at = own.findIndex((event) => event.type === "user.message" && event.data?.content === line);
    if (at === -1) return false;
    const last = own.slice(at).filter((event) => /^(?:assistant\.turn_(?:start|end)|tool\.execution_start|permission\.requested)$/.test(event.type ?? "")).at(-1);
    return last?.type === "assistant.turn_end";
  }
}

/**
 * One line the person types in a golden journey: sent on its own ledger
 * before the agent can act on it, so a decision recorded as theirs in a turn
 * that ended with no line of theirs after its question opened (the agent ran
 * ahead) fails as a PersonTurnError. `seen` gets the turn first, so a report
 * keeps the turn that failed.
 */
export function ledgeredTurn(
  terminal: CopilotTerminal, proj: string, line: string, seen?: (turn: CopilotTerminalTurn) => void,
): CopilotTerminalTurn {
  const ledger = new PersonTurnLedger(proj);
  ledger.sent(line);
  const turn = terminal.turn(line);
  seen?.(turn);
  if (!turn.ended) return turn;
  const unbacked = ledger.unbacked();
  if (unbacked.length > 0) throw unbackedFailure(`The Copilot turn "${line}"`, unbacked);
  return turn;
}

function prompts(events: readonly RecordEvent[]): CopilotPrompt[] {
  return events.filter((event) => event.type === "permission.requested").map((event) => {
    const request = event.data?.permissionRequest ?? {};
    if (request.kind === "shell") {
      const command = String(request.fullCommandText ?? "");
      return { kind: AIDLC_COMMAND.test(command.trim()) ? "aidlc" : "command", what: command };
    }
    return { kind: "write", what: String(request.fileName ?? request.kind ?? "") };
  });
}

function tokens(events: readonly RecordEvent[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const event of events) {
    if (event.type !== "session.usage_record") continue;
    input += Number(event.data?.usage?.inputTokens ?? 0) || 0;
    output += Number(event.data?.usage?.outputTokens ?? 0) || 0;
  }
  return { input, output };
}

/** The dialogs of a journey, counted the way its report shows them. */
export function promptCounts(all: readonly CopilotPrompt[]): Record<string, number> {
  return {
    "permission prompts": all.length,
    "for AI-DLC commands": all.filter((p) => p.kind === "aidlc").length,
    "for file writes": all.filter((p) => p.kind === "write").length,
    "for other commands": all.filter((p) => p.kind === "command").length,
  };
}
