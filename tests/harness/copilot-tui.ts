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
import { waitForTurn } from "./release-journey.ts";
import type { CapturedToolResult } from "./sdk-drive.ts";
import { assertTuiDriveKill } from "./tui-fixtures.ts";
import { resolveTuiRuntime } from "./tui-runtime.ts";

const { bin: DRIVE_BIN, prefix: DRIVE_PREFIX } = resolveTuiRuntime(join(import.meta.dir, "tui-drive.ts"));

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
}

// The empty prompt above Copilot's footer, and the footer's own words.
const PROMPT_LINE = /^\s*❯\s*$/m;
const FOOTER = "/ commands";
const DIALOG = "enter to select";
const PERMISSION = /Do you want to (?:run|create|edit|write|make|delete|use|allow)\b/;
// How long the screen holds still before a turn counts as ended.
const STILL_MS = 10_000;

const bottom = (screen: string) => screen.split("\n").slice(-25).join("\n");
const AIDLC_COMMAND = /^(?:bun|node|&)?\s*\S*\.aidlc[\\/]+tools[\\/]+aidlc[\w-]*\.ts\b/;

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

  private drive(args: string[], timeout = this.o.workMs(), env?: NodeJS.ProcessEnv): { rc: number; stdout: string; timedOut: boolean } {
    const res = spawnSync(DRIVE_BIN, [...DRIVE_PREFIX, ...args], { timeout, encoding: "utf-8", ...(env ? { env } : {}) });
    return { rc: res.status ?? -1, stdout: res.stdout ?? "", timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" };
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
    const started = this.drive(["start", "--session", this.o.session, "--cwd", this.o.proj, "--width", "200", "--height", "50", "--", this.o.bin], undefined, env);
    if (started.rc !== 0) throw new Error(`tui-drive could not start ${this.o.bin} (exit ${started.rc})`);
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
      if (!this.wait(`${FOOTER}|${DIALOG}`, Math.min(left, 60_000), 1500)) return false;
      const tail = bottom(this.screen());
      if (tail.includes(DIALOG)) {
        if (!PERMISSION.test(tail)) {
          stopped = `a dialog the driver does not answer:\n${tail}`;
          return true;
        }
        this.key("Enter");
        return false;
      }
      if (!this.waiting(tail) || !this.wait(FOOTER, Math.min(left, STILL_MS * 3), STILL_MS)) return false;
      if (!this.waiting(this.screen())) return false;
      return this.recordShowsTurnEnded(line) || ++unclosed >= 6;
    }, this.o.workMs) && stopped === undefined;
    if (!ended && stopped === undefined) stopped = `the time ran out:\n${bottom(this.screen())}`;
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
