import type { ChildProcess } from "node:child_process";

export interface NativeRootProviderFailure {
  sessionId: string;
  eventId: string;
  timestamp: string;
  turnEndId: string;
  status: number;
  errorType: "server_error";
  message: string;
}

/** Recognize a completed, unrecovered root provider failure, never screen text. */
export function nativeRootProviderFailure(
  transcript: string,
  sessionId: string,
  completedCounter = 0,
): NativeRootProviderFailure | null {
  if (completedCounter >= 5) return null;
  // A partial tail may be the beginning of recovery; wait for a complete snapshot.
  if (!sessionId || !transcript.endsWith("\n")) return null;
  type Row = Record<string, unknown>;
  const object = (value: unknown): Row | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
  const time = (value: unknown): number =>
    typeof value === "string" ? Date.parse(value) : Number.NaN;
  let assistant: Row | null = null;
  let ended: Row | null = null;
  let newest = Number.NEGATIVE_INFINITY;
  const ids = new Map<string, number>();
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let row: Row | null;
    try { row = object(JSON.parse(line)); } catch { return null; }
    if (!row || row.sessionId !== sessionId || row.isSidechain === true || row.agentId != null) continue;
    if (row.session_id !== undefined && row.session_id !== sessionId) return null;
    if (typeof row.uuid === "string") ids.set(row.uuid, (ids.get(row.uuid) ?? 0) + 1);
    const at = time(row.timestamp);
    if (Number.isFinite(at)) newest = Math.max(newest, at);
    if (row.type === "assistant") {
      assistant = row;
      ended = null;
    } else if (
      row.type === "system" && row.subtype === "turn_duration" &&
      assistant && row.parentUuid === assistant.uuid
    ) {
      ended = row;
    } else {
      // A new user turn, queued task, retry/progress event, or other root activity
      // supersedes an old failure. Unknown activity never proves the CLI is idle.
      assistant = null;
      ended = null;
    }
  }
  if (
    !assistant || !ended || assistant.isSidechain !== false || ended.isSidechain !== false ||
    assistant.isApiErrorMessage !== true || assistant.error !== "server_error" ||
    typeof assistant.uuid !== "string" || !assistant.uuid || ids.get(assistant.uuid) !== 1 ||
    typeof ended.uuid !== "string" || !ended.uuid || ids.get(ended.uuid) !== 1 ||
    typeof assistant.apiErrorStatus !== "number" || !Number.isInteger(assistant.apiErrorStatus) ||
    assistant.apiErrorStatus < 500 || assistant.apiErrorStatus > 599 ||
    typeof ended.durationMs !== "number" || !Number.isFinite(ended.durationMs) || ended.durationMs < 0
  ) return null;
  const at = time(assistant.timestamp);
  const finishedAt = time(ended.timestamp);
  if (!Number.isFinite(at) || !Number.isFinite(finishedAt) || finishedAt < at || finishedAt < newest) return null;
  const message = object(assistant.message);
  if (
    message?.role !== "assistant" || message.model !== "<synthetic>" || message.stop_reason !== "stop_sequence" ||
    !Array.isArray(message.content) || message.content.length === 0 ||
    !message.content.every((value) => {
      const block = object(value);
      return block?.type === "text" && typeof block.text === "string";
    })
  ) return null;
  const text = message.content.map((block) => block.text).join("\n");
  if (!text.trim()) return null;
  return {
    sessionId, eventId: assistant.uuid, timestamp: assistant.timestamp as string,
    turnEndId: ended.uuid, status: assistant.apiErrorStatus, errorType: "server_error", message: text,
  };
}

/** Monitor only this owned client; healthy runs retain their driver's deadline. */
export function monitorNativeAnswerGate(
  child: ChildProcess,
  inspect: () => void,
  timing: { pollMs?: number; terminateGraceMs?: number; killWaitMs?: number } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    let failed = false;
    let settled = false;
    const failures: unknown[] = [];
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearInterval(monitor);
      clearTimeout(escalation);
      clearTimeout(stopDeadline);
      if (!failed) resolve(code);
      else if (failures.length === 1) reject(failures[0]);
      else reject(new AggregateError(failures,
        `t139 answer-gate failure: ${failures.map(String).join("; ")}`, { cause: failures[0] }));
    };
    const signal = (name: NodeJS.Signals) => {
      try { child.kill(name); } catch (error) { failures.push(error); }
    };
    const monitor = setInterval(() => {
      try { inspect(); } catch (error) {
        failed = true;
        failures.push(error);
        clearInterval(monitor);
        signal("SIGTERM");
        escalation = setTimeout(() => {
          if (settled) return;
          signal("SIGKILL");
          stopDeadline = setTimeout(() => {
            failures.push(new Error("owned answer-gate client exit remains unconfirmed after forced termination"));
            finish(-1);
          }, timing.killWaitMs ?? 2_000);
        }, timing.terminateGraceMs ?? 1_000);
      }
    }, timing.pollMs ?? 1_000);
    child.once("exit", (code) => finish(code ?? -1));
    child.on("error", (error) => {
      if (settled) return;
      if (failed) failures.push(error); // Preserve the provider error if signalling fails.
      else finish(-1);
    });
  });
}

export interface NativeToolCall {
  name: string;
  input: Record<string, unknown>;
}

export function nativeToolCalls(transcript: string): NativeToolCall[] {
  return transcript.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const row = JSON.parse(line);
    if (row.type !== "assistant" || !Array.isArray(row.message?.content)) return [];
    return row.message.content.filter((block: { type?: string }) => block.type === "tool_use");
  });
}

interface Word {
  value: string;
  assignment: boolean;
}

/** Lex shell words, keeping quoted data and here-document bodies out of commands. */
function commandWords(source: string): Word[][] {
  return readCommandWords(source, 0, false).commands;
}

function readCommandWords(
  source: string,
  start: number,
  parenthesized: boolean,
): { commands: Word[][]; end: number } {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let index = start;
  const documents: Array<{ delimiter: string; tabs: boolean; quoted: boolean }> = [];
  const finish = () => {
    if (words.length) commands.push(words);
    words = [];
  };

  const substitution = (opening: number): number => {
    // Use the same lexer inside $(): quotes and heredoc bodies can contain
    // literal parentheses, so counting parentheses alone is insufficient.
    const nested = readCommandWords(source, opening + 2, true);
    commands.push(...nested.commands);
    return nested.end;
  };

  const backtickSubstitution = (opening: number): number => {
    let script = "";
    for (let end = opening + 1; end < source.length; end++) {
      const char = source[end];
      if (char === "`") {
        commands.push(...commandWords(script));
        return end + 1;
      }
      if (char === "\\" && '$`\\\n'.includes(source[end + 1] ?? "")) {
        const escaped = source[++end];
        if (escaped !== "\n") script += escaped;
      } else {
        script += char;
      }
    }
    throw new Error("Unterminated shell backtick substitution in native evidence");
  };

  const word = (expand = true): Word => {
    const start = index;
    let value = "";
    let quote = "";
    while (index < source.length) {
      const char = source[index];
      if (!quote && /[ \t\r\n;|&()<>]/.test(char)) break;
      if (char === "\\" && quote !== "'") {
        const next = source[index + 1] ?? "";
        if (quote === '"' && !'$`"\\\n'.includes(next)) {
          value += char;
          index++;
        } else {
          if (next !== "\n") value += next;
          index += 2;
        }
      } else if (quote && char === quote) {
        quote = "";
        index++;
      } else if (!quote && (char === "'" || char === '"')) {
        quote = char;
        index++;
      } else if (expand && quote !== "'" && source.startsWith("$(", index)) {
        index = substitution(index);
        value += "$()";
      } else if (expand && quote !== "'" && char === "`") {
        index = backtickSubstitution(index);
        value += "`...`";
      } else {
        value += char;
        index++;
      }
    }
    if (quote) throw new Error("Unterminated shell quote in native evidence");
    return { value, assignment: /^[A-Za-z_]\w*=/.test(source.slice(start, index)) };
  };

  while (index < source.length) {
    const char = source[index];
    if (char === "\\" && source[index + 1] === "\n") { index += 2; continue; }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "\n") {
      finish();
      index++;
      for (const document of documents.splice(0)) {
        let closed = false;
        while (index < source.length) {
          const end = source.indexOf("\n", index);
          const stop = end === -1 ? source.length : end;
          const line = source.slice(index, stop);
          if ((document.tabs ? line.replace(/^\t+/, "") : line) === document.delimiter) {
            index = end === -1 ? stop : stop + 1;
            closed = true;
            break;
          }
          // An unquoted heredoc can execute substitutions, but its ordinary
          // assignment-looking text is still stdin data, never a shell command.
          if (!document.quoted) {
            while (index < stop) {
              if (source[index] === "\\") index += 2;
              else if (source.startsWith("$(", index)) index = substitution(index);
              else if (source[index] === "`") index = backtickSubstitution(index);
              else index++;
            }
          }
          index = end === -1 ? stop : stop + 1;
        }
        if (!closed) throw new Error("Unterminated shell heredoc in native evidence");
      }
      continue;
    }
    if (/[ \t\r]/.test(char)) { index++; continue; }
    if (char === ")") {
      finish();
      index++;
      if (parenthesized) {
        if (documents.length) throw new Error("Missing shell heredoc body in native evidence");
        return { commands, end: index };
      }
      continue;
    }
    if (char === "(") {
      finish();
      const nested = readCommandWords(source, index + 1, true);
      commands.push(...nested.commands);
      index = nested.end;
      continue;
    }
    if (";|&".includes(char)) { finish(); index++; continue; }
    if (char === "<" || char === ">") {
      if (/^\d+$/.test(words.at(-1)?.value ?? "")) words.pop();
      if (source.startsWith("<<", index) && !source.startsWith("<<<", index)) {
        index += 2;
        const tabs = source[index] === "-";
        if (tabs) index++;
        while (/[ \t]/.test(source[index] ?? "")) index++;
        const start = index;
        const delimiter = word(false).value;
        if (!delimiter) throw new Error("Missing shell heredoc delimiter in native evidence");
        documents.push({ delimiter, tabs, quoted: /['"\\]/.test(source.slice(start, index)) });
      } else {
        while (/[<>&]/.test(source[index] ?? "")) index++;
        while (/[ \t]/.test(source[index] ?? "")) index++;
        word(); // A redirection destination is not an assignment operand.
      }
      continue;
    }
    words.push(word());
  }
  if (documents.length) throw new Error("Missing shell heredoc body in native evidence");
  if (parenthesized) throw new Error("Unterminated shell command substitution in native evidence");
  finish();
  return { commands, end: index };
}

const GUARD_NAME = /^AIDLC_(?:(?:DISABLE|SKIP)_[A-Z0-9_]+|ALLOW_DIRECT_STATE_TRANSITIONS)$/;
const executable = (value: string) => value.replaceAll("\\", "/").split("/").pop() ?? value;

function enablesGuard(words: Word[]): boolean {
  return invocationEnablesGuard(words, new Map());
}

function invocationEnablesGuard(words: Word[], inherited: Map<string, string>): boolean {
  const assignments = new Map(inherited);
  let index = 0;
  const assign = (value: string) => {
    const equals = value.indexOf("=");
    assignments.set(value.slice(0, equals), value.slice(equals + 1));
  };
  const leadingAssignments = () => {
    while (words[index]?.assignment) assign(words[index++].value);
  };
  leadingAssignments();
  while (["!", "{", "then", "do", "else", "if", "elif", "while", "until", "command", "exec", "builtin"].includes(words[index]?.value ?? "")) {
    index++;
    while (words[index]?.value.startsWith("-")) index++;
    leadingAssignments();
  }
  const name = executable(words[index]?.value ?? "");
  if (["export", "readonly", "declare", "typeset"].includes(name)) {
    for (const operand of words.slice(index + 1)) {
      if (/^[A-Za-z_]\w*=/.test(operand.value)) assign(operand.value);
    }
  } else if (name === "env") {
    index++;
    while (index < words.length) {
      const option = words[index].value;
      if (option === "--") { index++; break; }
      if (["-u", "--unset", "-C", "--chdir", "-a", "--argv0"].includes(option)) {
        if (option === "-u" || option === "--unset") assignments.delete(words[index + 1]?.value ?? "");
        index += 2;
      } else if (option === "-S" || option === "--split-string") {
        if (commandWords(words[index + 1]?.value ?? "").some(enablesGuard)) return true;
        index += 2;
      } else if (option.startsWith("--split-string=") || /^-S.+/.test(option)) {
        const split = option.startsWith("-S") ? option.slice(2) : option.slice("--split-string=".length);
        if (commandWords(split).some(enablesGuard)) return true;
        index++;
      } else if (option.startsWith("--unset=")) {
        assignments.delete(option.slice("--unset=".length));
        index++;
      } else if (/^-u.+/.test(option)) {
        assignments.delete(option.slice(2));
        index++;
      } else if (["-i", "-", "--ignore-environment"].includes(option)) {
        assignments.clear();
        index++;
      } else if (option.startsWith("-")) {
        index++;
      } else {
        break;
      }
    }
    while (/^[A-Za-z_]\w*=/.test(words[index]?.value ?? "")) assign(words[index++].value);
    // env's options/assignments and its utility are one invocation. Preserve
    // the resulting environment while inspecting a nested env or shell -c.
    return invocationEnablesGuard(words.slice(index), assignments);
  } else if (["bash", "sh", "zsh"].includes(name)) {
    const script = words.findIndex((item, i) => i > index && /^-[^-]*c/.test(item.value));
    if (script !== -1 && commandWords(words[script + 1]?.value ?? "").some(enablesGuard)) return true;
  }
  return [...assignments].some(([key, value]) => GUARD_NAME.test(key) && value === "1");
}

export function guardBypassCommands(calls: NativeToolCall[]): string[] {
  return calls.flatMap((call) => {
    const command = call.name === "Bash" ? call.input.command : undefined;
    return typeof command === "string" && commandWords(command).some(enablesGuard) ? [command] : [];
  });
}

export interface MilestoneState {
  completedCounter: number;
  completedSlugs: string[];
  currentStage: string | undefined;
}

export function hasAdvancedMilestone(state: MilestoneState): boolean {
  return state.completedCounter >= 5 &&
    !!state.currentStage &&
    !state.completedSlugs.includes(state.currentStage);
}

/** Observe advance's state write; never normalize a phase or issue a transition. */
export async function comparableTerminal<T extends MilestoneState>(
  read: () => T,
  deadline: number,
  timing: { now?: () => number; pause?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const now = timing.now ?? Date.now;
  const pause = timing.pause ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = Math.min(deadline, now() + 5_000);
  while (now() < until) {
    const state = read();
    if (now() >= until) break;
    if (hasAdvancedMilestone(state)) return state;
    await pause(Math.min(25, until - now()));
  }
  throw new Error("t139 completed milestone did not advance its cursor before the existing deadline");
}
