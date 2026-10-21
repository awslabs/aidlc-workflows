// The trace audit's extractor: reads every live leg of a Full Suite run, the
// passing ones too, or a local live or debug session folder, and prints one
// table per run of what the record shows. It only counts and matches recorded
// events and fields; reading what they mean is the judgement pass's
// (trace-audit-judge.ts). It never writes inside the folders it reads.
//
//   bun scripts/trace-audit.ts extract --run <full-suite run id> [--run <id>...]
//   bun scripts/trace-audit.ts extract --dir <artifact or session folder> [--label <name>]
//       [--out <dir>] [--cache <dir>] [--gap-minutes <n>] [--repo <owner/name>]
//   bun scripts/trace-audit.ts judge <out-dir> [options]   (see trace-audit-judge.ts)
//
// Per run it writes <out>/table.txt and table.json, and per leg the leg's story
// (what the person typed and picked, what they were asked, what the agent ran
// and said, the rows) to <out>/legs/<leg>/story.md, listed in <out>/index.json.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const CLASSES = [
  "sensor",
  "refusal",
  "engine-error",
  "asked-twice",
  "changed-after-approval",
  "silence",
  "retry",
  "tool-error",
] as const;
export type TraceClass = (typeof CLASSES)[number];

export interface TraceRow {
  cls: TraceClass;
  run: string;
  harness: string;
  os: string;
  test: string;
  attempt: number | null;
  leg: string;
  stage: string;
  event: string;
  detail: string;
  /** The file inside the read folder, with `:line` for a line or `#field` for a JSON field. */
  evidence: string;
}

type EventKind = "person" | "ask" | "pick" | "call" | "result" | "say" | "stop" | "permission" | "note" | "tick";

export interface TraceEvent {
  kind: EventKind;
  /** Milliseconds since the epoch, when the source keeps time. */
  at: number | null;
  text: string;
  tool?: string;
  id?: string;
  isError?: boolean;
  exit?: number | null;
  stage: string;
  src: string;
  turn: number;
  paths?: string[];
}

interface AuditRow {
  event: string;
  at: number | null;
  fields: Record<string, string>;
  src: string;
}

interface DriverReport {
  file: string;
  line: string;
  problems: string[];
  person: string[];
  turns: { line: string; seconds: number }[];
}

export interface TraceSource {
  kind: string;
  path: string;
  count: number;
}

export interface TraceLeg {
  id: string;
  run: string;
  harness: string;
  os: string;
  test: string;
  attempt: number | null;
  status: string;
  dir: string;
  sources: TraceSource[];
  events: TraceEvent[];
  audit: AuditRow[];
  reports: DriverReport[];
  logLines: { text: string; src: string }[];
  rows: TraceRow[];
}

export interface RunAudit {
  label: string;
  run: string;
  root: string;
  legs: TraceLeg[];
  rows: TraceRow[];
  counts: Record<TraceClass, number>;
}

export interface AuditOptions {
  /** The run's name in the table: a run id, or a session's name. */
  label?: string;
  /** A silence at least this long is a row (default 10 minutes). */
  gapMinutes?: number;
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const ARTIFACT = /^(?:(\d{6,})-)?full-suite-live-([a-z]+(?:-[a-z]+)*?)-(\d+)-(Linux|macOS|Windows)$/;
const ATTEMPT = /^attempt-(\d+)$/;
// Folders that hold the tools, plugins and caches a run installed, never its record.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "pkg", "plugins", "tools", "skills", "knowledge", "aidlc-common", "agents",
  "file-history", "shell-snapshots", "todos", "statsig", "cache", ".cache", ".bun", "subagents", "e2e-workers",
]);

let stageSlugs: Set<string> | null = null;
/** The stage slugs this checkout ships, from its stage files. */
function knownStages(): Set<string> {
  if (stageSlugs) return stageSlugs;
  stageSlugs = new Set();
  const stages = join(REPO_ROOT, "core", "aidlc-common", "stages");
  if (existsSync(stages)) {
    for (const phase of readdirSync(stages)) {
      const dir = join(stages, phase);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) if (f.endsWith(".md")) stageSlugs.add(f.slice(0, -3));
    }
  }
  return stageSlugs;
}

const posix = (p: string) => p.split(sep).join("/");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);
const oneLine = (text: string) => text.replace(/\r?\n+/g, " / ").replace(/\s+/g, " ").trim();
const firstLine = (text: string) => (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
const minutes = (ms: number) => Math.round(ms / 60_000);

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function readLines(abs: string): string[] {
  try {
    return readFileSync(abs, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function parseJson(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const v = JSON.parse(line) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The tools that write a file, by the name each host gives them; a read never changes a stage's files.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "file_change", "edit", "create", "write", "str_replace_editor", "apply_patch"]);

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

// --- What a command line is ---------------------------------------------------

/** True for a call to AI-DLC's own engine or tools. */
export function isAidlcCommand(command: string): boolean {
  return /aidlc(?:-[a-z-]+)?\.ts\b/.test(command) || /(?:^|[\s;&|'"])aidlc\s+(?:engine|status|doctor|config|update|log)\b/.test(command);
}

/** "engine log answer", "orchestrate report", "aidlc doctor": the AI-DLC command a line runs. */
function commandLabel(command: string): string {
  const engine = /aidlc\.ts\s+((?:engine\s+)?[a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)/.exec(command);
  if (engine) return engine[1].replace(/\s+/g, " ");
  const tool = /aidlc-([a-z-]+)\.ts\s+([a-z][a-z-]*)/.exec(command);
  if (tool) return `${tool[1]} ${tool[2]}`;
  const launcher = /\baidlc\s+([a-z-]+(?:\s+[a-z-]+)?)/.exec(command);
  return launcher ? `aidlc ${launcher[1]}` : clip(firstLine(command), 80);
}

/** The stage a command names with --stage, when it is one this checkout ships. */
function stageFlag(command: string): string | null {
  const m = /--stage[=\s]+["']?([a-z0-9-]+)/.exec(command);
  return m && knownStages().has(m[1]) ? m[1] : null;
}

/** The stage an engine reply names first, when it is one this checkout ships. */
function stageInOutput(text: string): string | null {
  const m = /"stage"\s*:\s*"([a-z0-9-]+)"/.exec(text);
  return m && knownStages().has(m[1]) ? m[1] : null;
}

/** The stage a record path belongs to: `<record>/<phase>/<stage>/` or `<record>/construction/<unit>/<stage>/`. */
export function stageOfPath(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  const m = /\/intents\/[^/]+\/(ideation|inception|construction|operation)\/([^/]+)\/(?:([^/]+)\/)?/.exec(p);
  if (!m) return null;
  if (knownStages().has(m[2])) return m[2];
  return m[3] && knownStages().has(m[3]) ? m[3] : null;
}

/** The error text an engine reply carries: its JSON `error`, else its first line after the exit code. */
function errorMessage(text: string): string {
  const json = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (json) {
    try {
      return JSON.parse(`"${json[1]}"`) as string;
    } catch {
      return json[1];
    }
  }
  return firstLine(text.replace(/^Exit code \d+\s*/, ""));
}

// --- Readers, one per recorded format -------------------------------------------

/** A Claude Agent SDK drive trace (tests/harness/sdk-drive.ts, `sdk-drive-<pid>.ndjson`). */
function readSdkTrace(abs: string, rel: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let turn = 0;
  readLines(abs).forEach((line, i) => {
    const e = parseJson(line);
    if (!e) return;
    const at = parseTime(e.ts);
    const src = `${rel}:${i + 1}`;
    const push = (ev: Omit<TraceEvent, "at" | "src" | "turn" | "stage">) => events.push({ at, src, turn, stage: "", ...ev });
    switch (e.event) {
      case "start":
      case "next_message":
        turn++;
        push({ kind: "person", text: str(e.event === "start" ? e.prompt : e.message) });
        break;
      case "tool_use": {
        const name = str(e.name);
        if (name === "AskUserQuestion") break;
        const input = (e.input ?? {}) as Record<string, unknown>;
        const path = str(input.file_path ?? input.notebook_path);
        push({ kind: "call", tool: name, id: str(e.id), text: name === "Bash" ? str(input.command) : callText(input), ...(path && WRITE_TOOLS.has(name) ? { paths: [path] } : {}) });
        break;
      }
      case "tool_result":
        if (e.toolName === "AskUserQuestion") break;
        push({ kind: "result", tool: str(e.toolName), id: str(e.toolUseId), isError: e.isError === true, text: str(e.preview) });
        break;
      case "ask_user_question": {
        const questions = Array.isArray(e.questions) ? (e.questions as Record<string, unknown>[]) : [];
        const answers = (e.answers ?? {}) as Record<string, unknown>;
        for (const q of questions) {
          const options = Array.isArray(q.options) ? q.options.map((o) => str(typeof o === "object" && o ? (o as Record<string, unknown>).label : o)) : [];
          push({ kind: "ask", text: `(question box): "${str(q.question)}" [${options.join(" | ")}]` });
          const answer = answers[str(q.question)];
          if (answer !== undefined) push({ kind: "pick", text: str(answer) });
        }
        break;
      }
      case "ask_user_question_chat":
        for (const q of Array.isArray(e.questions) ? e.questions : []) push({ kind: "ask", text: `(in chat): "${str(q)}"` });
        break;
      case "stop_hook":
        push({ kind: "stop", text: e.blocked === true ? `blocked${e.reason ? `: ${str(e.reason)}` : ""}` : `let the turn end (${str(e.outcome)})` });
        break;
      case "permission_request":
        push({ kind: "permission", text: `${str(e.toolName)} ${str(e.command)}`.trim() });
        break;
      case "timeout":
      case "error":
      case "unbacked_decision":
        push({ kind: "note", text: `${str(e.event)} ${clip(oneLine(JSON.stringify({ ...e, ts: undefined, event: undefined })), 300)}` });
        break;
      case "end":
        push({ kind: "note", text: `drive ended${e.timedOut === true ? " (timed out)" : ""}` });
        break;
      default:
        if (at !== null) push({ kind: "tick", text: str(e.event) });
    }
  });
  return events;
}

function callText(input: Record<string, unknown>): string {
  const target = input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? input.description ?? input.subagent_type;
  return target !== undefined ? str(target) : clip(oneLine(JSON.stringify(input)), 200);
}

/** One typed turn of `codex exec --json` per file (`exec-codex-<label>-<n>.log`), in turn order. */
function readCodexTurns(files: { abs: string; rel: string; n: number }[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const f of [...files].sort((a, b) => a.n - b.n)) {
    const turn = f.n;
    readLines(f.abs).forEach((line, i) => {
      const src = `${f.rel}:${i + 1}`;
      const push = (ev: Omit<TraceEvent, "at" | "src" | "turn" | "stage">) => events.push({ at: null, src, turn, stage: "", ...ev });
      if (line.startsWith("Command: [")) {
        try {
          const argv = JSON.parse(line.slice("Command: ".length)) as unknown[];
          push({ kind: "person", text: str(argv[argv.length - 1]) });
        } catch {
          // A header that is not an argument list types nothing we can read.
        }
        return;
      }
      const e = parseJson(line);
      if (!e) return;
      const item = (e.item ?? {}) as Record<string, unknown>;
      if (e.type === "error" || e.type === "turn.failed") {
        push({ kind: "note", text: `${str(e.type)} ${clip(oneLine(JSON.stringify(e.error ?? e.message ?? e)), 300)}` });
        return;
      }
      if (e.type !== "item.completed") return;
      if (item.type === "command_execution") {
        const exit = typeof item.exit_code === "number" ? item.exit_code : null;
        push({ kind: "call", tool: "command", id: `${f.rel}#${str(item.id)}`, text: str(item.command) });
        push({ kind: "result", tool: "command", id: `${f.rel}#${str(item.id)}`, exit, isError: exit !== null && exit !== 0, text: str(item.aggregated_output) });
      } else if (item.type === "agent_message") {
        push({ kind: "say", text: str(item.text) });
      } else if (item.type === "file_change") {
        const paths = (Array.isArray(item.changes) ? item.changes : []).map((c) => str((c as Record<string, unknown>).path));
        push({ kind: "call", tool: "file_change", id: `${f.rel}#${str(item.id)}`, text: paths.join(", "), paths });
      } else if (item.type === "collab_tool_call") {
        push({ kind: "call", tool: "subagent", id: `${f.rel}#${str(item.id)}`, text: clip(oneLine(str(item.prompt ?? item.tool ?? "")), 200) });
      }
    });
  }
  return events;
}

/** A Claude Code transcript (`projects/<dir>/<session>.jsonl`). */
function readTranscript(abs: string, rel: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  const asks = new Set<string>();
  let turn = 0;
  readLines(abs).forEach((line, i) => {
    const e = parseJson(line);
    if (!e) return;
    const at = parseTime(e.timestamp);
    const src = `${rel}:${i + 1}`;
    const push = (ev: Omit<TraceEvent, "at" | "src" | "turn" | "stage">) => events.push({ at, src, turn, stage: "", ...ev });
    const message = (e.message ?? {}) as Record<string, unknown>;
    const content = message.content;
    if (e.type === "user") {
      // Claude Code writes a hook's feedback and its own notes as user entries marked isMeta: never the person's.
      if (e.isMeta === true) {
        if (typeof content === "string" && content.startsWith("Stop hook feedback:")) push({ kind: "stop", text: `blocked: ${clip(oneLine(content), 300)}` });
        return;
      }
      if (typeof content === "string") {
        turn++;
        const args = /<command-name>([^<]*)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/.exec(content);
        push({ kind: "person", text: args ? `${args[1]} ${args[2]}`.trim() : content });
        return;
      }
      for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
        if (b.type === "tool_result") {
          const text = typeof b.content === "string" ? b.content : (Array.isArray(b.content) ? b.content : []).map((c) => str((c as Record<string, unknown>).text)).join("\n");
          if (asks.has(str(b.tool_use_id))) push({ kind: "pick", text: clip(oneLine(text), 600) });
          else push({ kind: "result", id: str(b.tool_use_id), isError: b.is_error === true, text });
        } else if (b.type === "text" && e.isMeta !== true) {
          turn++;
          push({ kind: "person", text: str(b.text) });
        }
      }
      return;
    }
    if (e.type === "assistant") {
      for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
        if (b.type === "text" && str(b.text).trim()) push({ kind: "say", text: str(b.text) });
        else if (b.type === "tool_use") {
          const name = str(b.name);
          const input = (b.input ?? {}) as Record<string, unknown>;
          if (name === "AskUserQuestion") {
            asks.add(str(b.id));
            for (const q of Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []) {
              const options = (Array.isArray(q.options) ? q.options : []).map((o) => str((o as Record<string, unknown>).label ?? o));
              push({ kind: "ask", text: `(question box): "${str(q.question)}" [${options.join(" | ")}]` });
            }
            continue;
          }
          const path = str(input.file_path ?? input.notebook_path);
          push({ kind: "call", tool: name, id: str(b.id), text: name === "Bash" ? str(input.command) : callText(input), ...(path && WRITE_TOOLS.has(name) ? { paths: [path] } : {}) });
        }
      }
      return;
    }
    if (e.type === "system" && e.subtype === "stop_hook_summary") {
      push({ kind: "stop", text: e.preventedContinuation === true ? "blocked" : "let the turn end" });
      return;
    }
    if (at !== null) push({ kind: "tick", text: str(e.type) });
  });
  return events;
}

/** Copilot CLI's session events (`session-state/<id>/events.jsonl`). */
function readCopilotEvents(abs: string, rel: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let turn = 0;
  readLines(abs).forEach((line, i) => {
    const e = parseJson(line);
    if (!e) return;
    const at = parseTime(e.timestamp);
    const src = `${rel}:${i + 1}`;
    const data = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
    const push = (ev: Omit<TraceEvent, "at" | "src" | "turn" | "stage">) => events.push({ at, src, turn, stage: "", ...ev });
    if (e.type === "user.message") {
      turn++;
      push({ kind: "person", text: str(data.content) });
    } else if (e.type === "assistant.message") {
      if (str(data.content).trim()) push({ kind: "say", text: str(data.content) });
    } else if (e.type === "tool.execution_start") {
      const args = (data.arguments && typeof data.arguments === "object" ? data.arguments : {}) as Record<string, unknown>;
      const name = str(data.toolName);
      push({ kind: "call", tool: name, id: str(data.toolCallId), text: typeof args.command === "string" ? args.command : callText(args) });
    } else if (e.type === "tool.execution_complete") {
      const result = (data.result && typeof data.result === "object" ? data.result : {}) as Record<string, unknown>;
      push({ kind: "result", id: str(data.toolCallId), isError: data.success === false, text: str(result.content) });
    } else if (at !== null) {
      push({ kind: "tick", text: str(e.type) });
    }
  });
  return events;
}

/** A Copilot CLI process log (`logs/process-*.log`): one timestamped line per entry. */
function readCopilotLog(abs: string, rel: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  readLines(abs).forEach((line, i) => {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+(.*)$/.exec(line);
    if (!m) return;
    const text = clip(m[2], 300);
    events.push({ kind: /\[ERROR\]/.test(text) ? "note" : "tick", at: parseTime(m[1]), text, stage: "", src: `${rel}:${i + 1}`, turn: 0 });
  });
  return events;
}

/** A Codex session rollout (`sessions/**\/rollout-*.jsonl`), as a local Codex home keeps it. */
function readCodexRollout(abs: string, rel: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let turn = 0;
  readLines(abs).forEach((line, i) => {
    const e = parseJson(line);
    if (!e) return;
    const at = parseTime(e.timestamp);
    const src = `${rel}:${i + 1}`;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const push = (ev: Omit<TraceEvent, "at" | "src" | "turn" | "stage">) => events.push({ at, src, turn, stage: "", ...ev });
    const text = (Array.isArray(p.content) ? p.content : []).map((c) => str((c as Record<string, unknown>).text)).join("\n");
    const hook = /^<hook_prompt\b[^>]*>([\s\S]*?)(?:<\/hook_prompt>)?\s*$/.exec(text.trim());
    if (e.type === "response_item" && p.type === "message" && p.role === "user" && hook) {
      // A Stop hook carrying the turn on, in a user message: the hook's words.
      push({ kind: "stop", text: `blocked: ${clip(oneLine(hook[1]), 300)}` });
    } else if (e.type === "response_item" && p.type === "message" && p.role === "user" && !/^<(environment_context|user_instructions)/.test(text.trim())) {
      turn++;
      push({ kind: "person", text });
    } else if (e.type === "response_item" && p.type === "message" && p.role === "assistant") {
      if (text.trim()) push({ kind: "say", text });
    } else if (e.type === "response_item" && p.type === "function_call") {
      let command = str(p.arguments);
      try {
        const args = JSON.parse(command) as Record<string, unknown>;
        command = Array.isArray(args.command) ? (args.command as unknown[]).map(str).join(" ") : str(args.command ?? command);
      } catch {
        // Arguments that are not JSON are shown as given.
      }
      push({ kind: "call", tool: str(p.name), id: str(p.call_id), text: command });
    } else if (e.type === "response_item" && p.type === "function_call_output") {
      const out = (p.output && typeof p.output === "object" ? p.output : {}) as Record<string, unknown>;
      const body = typeof p.output === "string" ? p.output : str(out.content ?? out.output);
      const exit = /"exit_code"\s*:\s*(\d+)|Exit code:\s*(\d+)/.exec(body);
      const code = exit ? Number(exit[1] ?? exit[2]) : null;
      push({ kind: "result", id: str(p.call_id), exit: code, isError: code !== null && code !== 0, text: body });
    } else if (at !== null) {
      push({ kind: "tick", text: str(e.type) });
    }
  });
  return events;
}

/** An AI-DLC audit shard (`<record>/audit/<host>-<clone>.md`): one block per row. */
function readAudit(abs: string, rel: string): AuditRow[] {
  const rows: AuditRow[] = [];
  const lines = readLines(abs);
  let start = 0;
  const flush = (end: number) => {
    const block = lines.slice(start, end);
    const fields: Record<string, string> = {};
    for (const l of block) {
      const m = /^\*\*([^*]+)\*\*:[ \t]?(.*)$/.exec(l);
      if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
    }
    if (fields.Event) rows.push({ event: fields.Event, at: parseTime(fields.Timestamp), fields, src: `${rel}:${start + 1}` });
  };
  lines.forEach((l, i) => {
    if (l.trim() === "---") {
      flush(i);
      start = i + 1;
    }
  });
  flush(lines.length);
  return rows;
}

function readReport(abs: string, rel: string): DriverReport | null {
  try {
    const d = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);
    const turns = (Array.isArray(d.turns) ? d.turns : []).map((t) => {
      const r = (t ?? {}) as Record<string, unknown>;
      return { line: str(r.line), seconds: typeof r.seconds === "number" ? r.seconds : 0 };
    });
    return { file: rel, line: str(d.line), problems: list(d.problems), person: list(d.person), turns };
  } catch {
    return null;
  }
}

// --- Finding the legs -----------------------------------------------------------

interface Found {
  abs: string;
  rel: string;
  kind: string;
}

function walk(root: string): Found[] {
  const found: Found[] = [];
  const seen = new Set<string>();
  const visit = (dir: string) => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    // A folder of links to downloaded runs is followed; a link back into a folder already read is not.
    if (seen.has(real)) return;
    seen.add(real);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (!SKIP_DIRS.has(entry.name)) visit(abs);
        continue;
      }
      if (!isFile) continue;
      const rel = posix(relative(root, abs));
      const kind = sourceKind(rel, entry.name);
      if (kind) found.push({ abs, rel, kind });
    }
  };
  visit(root);
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function sourceKind(rel: string, name: string): string | null {
  if (/^sdk-drive-.*\.ndjson$/.test(name)) return "sdk-trace";
  if (/^exec-codex-.+-\d+\.log$/.test(name)) return "codex-exec";
  if (name === "events.jsonl" && rel.includes("/session-state/")) return "copilot-events";
  if (/^process-.*\.log$/.test(name) && /(copilot-home|\.copilot)\/logs\//.test(rel)) return "copilot-log";
  if (/^rollout-.*\.jsonl$/.test(name) && rel.includes("sessions/")) return "codex-rollout";
  if (name.endsWith(".jsonl") && /(^|\/)projects\/[^/]+\/[^/]+\.jsonl$/.test(rel)) return "claude-transcript";
  if (name.endsWith(".md") && /\/intents\/[^/]+\/audit\/[^/]+\.md$/.test(`/${rel}`)) return "audit";
  if (/^(golden|release)-journey-[a-z-]+\.json$/.test(name)) return "driver-report";
  if (name === "e2e-results.json") return "results";
  if (name.endsWith(".log") && !name.startsWith("runner") && /^[^/]+(\/[^/]+)?\/[^/]+\.log$/.test(rel) && !rel.includes("e2e-artifacts")) return "test-log";
  return null;
}

interface Job {
  run: string;
  harness: string;
  os: string;
  key: string;
}

function jobOf(rel: string, fallbackRun: string): Job | null {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    const m = ARTIFACT.exec(parts[i]);
    if (!m) continue;
    const run = m[1] ?? parts.slice(0, i).reverse().find((p) => /^\d{6,}$/.test(p)) ?? fallbackRun;
    return { run, harness: m[2], os: m[4], key: parts.slice(0, i + 1).join("/") };
  }
  return null;
}

const HARNESS_BY_SOURCE: Record<string, string> = {
  "sdk-trace": "claude-sdk",
  "codex-exec": "codex",
  "codex-rollout": "codex",
  "claude-transcript": "claude",
  "copilot-events": "copilot",
  "copilot-log": "copilot",
};

/** Read one folder: a Full Suite run's artifacts, or a local live or debug session. */
export function auditFolder(rootIn: string, opts: AuditOptions = {}): RunAudit {
  const root = resolve(rootIn);
  const found = walk(root);
  const fallbackRun = opts.label ?? basename(root);
  const firstJob = found.map((f) => jobOf(f.rel, fallbackRun)).find((j) => j !== null);
  const run = opts.label ?? firstJob?.run ?? fallbackRun;
  const gapMs = (opts.gapMinutes ?? 10) * 60_000;

  const legs = new Map<string, TraceLeg>();
  const legFor = (f: Found): TraceLeg => {
    const job = jobOf(f.rel, run);
    const parts = f.rel.split("/");
    const e2e = parts.indexOf("e2e-artifacts");
    let key: string;
    let test = "";
    let attempt: number | null = null;
    if (e2e >= 0 && parts[e2e + 1] && ATTEMPT.test(parts[e2e + 2] ?? "")) {
      key = parts.slice(0, e2e + 3).join("/");
      test = parts[e2e + 1];
      attempt = Number(ATTEMPT.exec(parts[e2e + 2])![1]);
    } else if (f.kind === "audit") {
      key = f.rel.replace(/\/audit\/[^/]+$/, "");
      test = key.split("/").slice(-1)[0];
    } else if (f.kind === "codex-exec") {
      key = `${dirname(f.rel)}/${/^exec-codex-(.+)-\d+\.log$/.exec(basename(f.rel))![1]}`;
      test = basename(key);
    } else if (f.kind === "copilot-log") {
      key = f.rel.replace(/\/logs\/[^/]+$/, "");
      test = basename(key);
    } else {
      key = f.rel;
      test = basename(f.rel).replace(/\.[a-z]+$/, "");
    }
    let leg = legs.get(key);
    if (!leg) {
      leg = {
        id: `${job?.run ?? run}/${key}`, run: job?.run ?? run, harness: job?.harness ?? "", os: job?.os ?? "local", test, attempt,
        status: "", dir: e2e >= 0 ? key : dirname(key), sources: [], events: [], audit: [], reports: [], logLines: [], rows: [],
      };
      legs.set(key, leg);
    }
    if (!leg.harness && HARNESS_BY_SOURCE[f.kind]) leg.harness = HARNESS_BY_SOURCE[f.kind];
    return leg;
  };

  const codexGroups = new Map<string, { leg: TraceLeg; files: { abs: string; rel: string; n: number }[] }>();
  const results: Found[] = [];
  const testLogs: Found[] = [];
  for (const f of found) {
    if (f.kind === "results") {
      results.push(f);
      continue;
    }
    if (f.kind === "test-log") {
      testLogs.push(f);
      continue;
    }
    const leg = legFor(f);
    if (f.kind === "codex-exec") {
      const n = Number(/-(\d+)\.log$/.exec(f.rel)![1]);
      const gkey = `${leg.id}|${/^exec-codex-(.+)-\d+\.log$/.exec(basename(f.rel))![1]}`;
      const g = codexGroups.get(gkey) ?? { leg, files: [] };
      g.files.push({ abs: f.abs, rel: f.rel, n });
      codexGroups.set(gkey, g);
      continue;
    }
    let events: TraceEvent[] = [];
    if (f.kind === "sdk-trace") events = readSdkTrace(f.abs, f.rel);
    else if (f.kind === "claude-transcript") events = readTranscript(f.abs, f.rel);
    else if (f.kind === "copilot-events") events = readCopilotEvents(f.abs, f.rel);
    else if (f.kind === "copilot-log") events = readCopilotLog(f.abs, f.rel);
    else if (f.kind === "codex-rollout") events = readCodexRollout(f.abs, f.rel);
    else if (f.kind === "audit") {
      const rows = readAudit(f.abs, f.rel);
      leg.audit.push(...rows);
      leg.sources.push({ kind: f.kind, path: f.rel, count: rows.length });
      continue;
    } else if (f.kind === "driver-report") {
      const report = readReport(f.abs, f.rel);
      if (report) leg.reports.push(report);
      leg.sources.push({ kind: f.kind, path: f.rel, count: report ? 1 : 0 });
      continue;
    }
    leg.events.push(...events);
    leg.sources.push({ kind: f.kind, path: f.rel, count: events.length });
  }
  for (const { leg, files } of codexGroups.values()) {
    const events = readCodexTurns(files);
    leg.events.push(...events);
    for (const f of files) leg.sources.push({ kind: "codex-exec", path: f.rel, count: events.filter((e) => e.src.startsWith(`${f.rel}:`)).length });
  }

  // The runner's per-attempt results give each attempt's status, and the retries.
  const jobRows: { jobKey: string; rows: TraceRow[] }[] = [];
  for (const r of results) {
    const job = jobOf(r.rel, run);
    const dir = dirname(r.rel);
    let files: Record<string, unknown>[] = [];
    try {
      const d = JSON.parse(readFileSync(r.abs, "utf8")) as { files?: unknown };
      files = Array.isArray(d.files) ? (d.files as Record<string, unknown>[]) : [];
    } catch {
      continue;
    }
    const rows: TraceRow[] = [];
    files.forEach((rec, i) => {
      const test = basename(str(rec.file)).replace(/\.test\.ts$/, "");
      const attempts = (Array.isArray(rec.attempts) ? rec.attempts : []) as Record<string, unknown>[];
      for (const a of attempts) {
        const leg = legs.get(`${dir}/e2e-artifacts/${test}/attempt-${str(a.attempt)}`);
        if (leg) leg.status = str(a.status);
      }
      const statuses = attempts.map((a) => `${str(a.status)}${a.timedOut === true ? " timed out" : ""}`);
      const final = str(rec.status);
      let event = "";
      if (attempts.length > 1 && final === "PASS") event = `passed on retry (${statuses.join(", ")})`;
      else if (final === "FAIL") event = `failed (${statuses.join(", ") || "FAIL"})`;
      if (!event) return;
      if (rec.personTurnFailure === true) event += ", a person-turn check failed";
      if (rec.modelApiFailure === true) event += ", the model service failed";
      const last = attempts.length > 0 ? Number(attempts[attempts.length - 1].attempt) : null;
      rows.push({
        cls: "retry", run: job?.run ?? run, harness: job?.harness ?? "", os: job?.os ?? "", test, attempt: last,
        leg: `${job?.run ?? run}/${dir}/e2e-artifacts/${test}/attempt-${last}`, stage: "", event, detail: str(rec.file),
        evidence: `${r.rel}#files[${i}]`,
      });
    });
    jobRows.push({ jobKey: job?.key ?? dir, rows });
  }
  // A test's own log carries the driver's lines; it belongs to the test's last attempt.
  for (const f of testLogs) {
    const test = basename(f.rel).replace(/\.log$/, "");
    const dir = dirname(f.rel);
    const attempts = [...legs.values()].filter((l) => l.test === test && l.dir.startsWith(`${dir}/e2e-artifacts/`));
    const leg = attempts.sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0))[0];
    if (!leg) continue;
    readLines(f.abs).forEach((text, i) => {
      if (/asked twice/i.test(text)) leg.logLines.push({ text: text.trim(), src: `${f.rel}:${i + 1}` });
    });
    leg.sources.push({ kind: "test-log", path: f.rel, count: leg.logLines.length });
  }

  const ordered = [...legs.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : (a.attempt ?? 0) - (b.attempt ?? 0)));
  for (const leg of ordered) {
    settleStages(leg);
    leg.rows = legRows(leg, gapMs);
  }
  const rows: TraceRow[] = [];
  const emitted = new Set<string>();
  for (const leg of ordered) {
    rows.push(...leg.rows);
    const job = jobOf(leg.dir, run);
    const jobKey = job?.key ?? "";
    const isLastOfJob = !ordered.some((l) => l !== leg && ordered.indexOf(l) > ordered.indexOf(leg) && (jobOf(l.dir, run)?.key ?? "") === jobKey);
    if (isLastOfJob) {
      for (const jr of jobRows.filter((j) => j.jobKey === jobKey)) {
        rows.push(...jr.rows);
        emitted.add(jr.jobKey);
      }
    }
  }
  for (const jr of jobRows) if (!emitted.has(jr.jobKey)) rows.push(...jr.rows);
  for (const r of rows.filter((r) => r.cls === "retry")) {
    const leg = ordered.find((l) => l.id === r.leg);
    if (leg && !leg.rows.includes(r)) leg.rows.push(r);
  }
  const counts = Object.fromEntries(CLASSES.map((c) => [c, rows.filter((r) => r.cls === c).length])) as Record<TraceClass, number>;
  return { label: opts.label ?? run, run, root, legs: ordered, rows, counts };
}

/** Give each event the stage the leg was in: a call's --stage, then what the engine's reply named. */
function settleStages(leg: TraceLeg): void {
  let stage = "";
  for (const e of leg.events) {
    if (e.kind === "call") stage = stageFlag(e.text) ?? stage;
    e.stage = stage;
    if (e.kind === "result") stage = stageInOutput(e.text) ?? stage;
  }
}

// --- The rows -------------------------------------------------------------------

const isClaudeFamily = (h: string) => h === "claude-sdk" || h === "claude-tui" || h === "claude";
const TOOL_OWN_ERROR = /^(?:<tool_use_error>|EISDIR|ENOENT|EACCES|EPERM|File does not exist|File has been (?:modified|unexpectedly modified))/;
const HOOK_BLOCK = /^(?:Blocked by (?:a |the )?hook|.*\bblocked by (?:a |the )?(?:pre-?tool-?use )?hook\b)/i;

function legRows(leg: TraceLeg, gapMs: number): TraceRow[] {
  const rows: TraceRow[] = [];
  const add = (cls: TraceClass, stage: string, event: string, detail: string, evidence: string) =>
    rows.push({ cls, run: leg.run, harness: leg.harness, os: leg.os, test: leg.test, attempt: leg.attempt, leg: leg.id, stage, event, detail, evidence });
  const calls = new Map<string, TraceEvent>();
  for (const e of leg.events) if (e.kind === "call" && e.id) calls.set(e.id, e);
  const callOf = (e: TraceEvent, i: number): TraceEvent | undefined =>
    (e.id ? calls.get(e.id) : undefined) ?? [...leg.events.slice(0, i)].reverse().find((c) => c.kind === "call");
  // On Claude Code a hook's block comes back as the tool's error, with no exit code and none of the
  // tool's own error forms.
  const refused = (e: TraceEvent, call: TraceEvent | undefined): boolean => {
    if (e.kind !== "result" || !e.isError) return false;
    if (!isClaudeFamily(leg.harness)) return HOOK_BLOCK.test(firstLine(e.text));
    const tool = call?.tool ?? e.tool ?? "";
    if (tool === "Bash") return !/^Exit code \d+/.test(e.text);
    return WRITE_TOOLS.has(tool) && !TOOL_OWN_ERROR.test(e.text.trim());
  };

  // sensor
  for (const a of leg.audit) {
    const stage = a.fields["Stage slug"] ?? a.fields.Stage ?? "";
    if (a.event === "SENSOR_FAILED") add("sensor", stage, a.event, `${a.fields["Sensor ID"] ?? "?"}: ${a.fields["Findings count"] ?? "?"} findings`, a.src);
    else if (a.event === "SENSOR_PASSED" && a.fields.Note) add("sensor", stage, a.event, `${a.fields["Sensor ID"] ?? "?"}: ${a.fields.Note}`, a.src);
  }
  // refusal
  for (const a of leg.audit) {
    if (a.event.endsWith("_BLOCKED")) add("refusal", a.fields.Stage ?? a.fields["Stage slug"] ?? "", a.event, a.fields.Reason ?? a.fields.Details ?? "", a.src);
  }
  leg.events.forEach((e, i) => {
    const call = callOf(e, i);
    if (refused(e, call)) add("refusal", e.stage, `refused ${isClaudeFamily(leg.harness) ? call?.tool ?? e.tool ?? "Bash" : "command"}`, clip(firstLine(e.text), 200), e.src);
  });
  // engine-error
  for (const a of leg.audit) {
    if (a.event !== "ERROR_LOGGED") continue;
    const where = [a.fields.Tool, a.fields.Command].filter(Boolean).join(" ");
    const what = a.fields.Error ?? a.fields.Details ?? a.fields.Message ?? "";
    add("engine-error", a.fields.Stage ?? "", a.event, clip(where && what ? `${where}: ${what}` : where || what, 300), a.src);
  }
  leg.events.forEach((e, i) => {
    if (e.kind !== "result") return;
    const call = callOf(e, i);
    if (!call || !isAidlcCommand(call.text) || refused(e, call)) return;
    if (e.isError) {
      const code = e.exit ?? Number(/^Exit code (\d+)/.exec(e.text)?.[1] ?? 1);
      add("engine-error", e.stage, `exit ${code}`, `${commandLabel(call.text)}: ${clip(errorMessage(e.text), 200)}`, e.src);
      return;
    }
    // The engine also refuses with exit 0 and a reply of kind "error".
    const reply = parseJson(e.text.trim());
    // A trace may keep only the start of a long reply: then its first "kind" decides.
    const cut = reply === null && e.text.trim().startsWith("{") ? /"kind"\s*:\s*"([a-z-]+)"/.exec(e.text)?.[1] : undefined;
    if (reply?.kind === "error" || cut === "error") {
      const message = reply ? str(reply.message ?? reply.reason ?? reply.error) : (/"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(e.text)?.[1] ?? "");
      add("engine-error", e.stage, "kind error", `${commandLabel(call.text)}: ${clip(message, 200)}`, e.src);
    }
  });
  // asked-twice
  for (const r of leg.reports) {
    r.problems.forEach((p, i) => {
      if (/asked twice/i.test(p)) add("asked-twice", / at ([a-z0-9-]+)\b/.exec(p)?.[1] ?? "", "driver report", p, `${r.file}#problems[${i}]`);
    });
  }
  for (const l of leg.logLines) add("asked-twice", / at ([a-z0-9-]+)\b/.exec(l.text)?.[1] ?? "", "test log", clip(l.text, 300), l.src);
  // The same question box again in one chat after the person answered it (a gate shown again after a
  // change they asked for counts too: which of those is friction is the judgement pass's to say).
  const asked = new Map<string, boolean>();
  for (const e of leg.events) {
    const file = e.src.replace(/:\d+$/, "");
    if (e.kind === "pick" || e.kind === "person") {
      for (const k of asked.keys()) if (k.startsWith(`${file}|`)) asked.set(k, true);
      continue;
    }
    if (e.kind !== "ask") continue;
    const question = /"(.*)"/.exec(e.text)?.[1] ?? e.text;
    // The same words at another stage (the learnings question, say) are that stage's own question.
    const key = `${file}|${e.stage}|${question.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (asked.get(key) === true) add("asked-twice", e.stage, "same question asked again", `"${clip(question, 200)}"`, e.src);
    asked.set(key, false);
  }
  // changed-after-approval
  for (const a of leg.audit) if (a.event === "CHANGE_ACCEPTED") add("changed-after-approval", a.fields.Stage ?? "", a.event, a.fields.Details ?? "", a.src);
  // An approval holds in the chat it was given in: one session's file, or a Codex leg's typed turns together.
  const chat = (src: string) => {
    const file = src.replace(/:\d+$/, "");
    const codex = /^(.*\/exec-codex-.+)-\d+\.log$/.exec(file);
    return codex ? codex[1] : file;
  };
  const approved = new Set<string>();
  leg.events.forEach((e, i) => {
    if (e.kind === "result" && !e.isError) {
      const call = callOf(e, i);
      const s = call && /\breport\b/.test(call.text) && /--result[=\s]+["']?approved\b/.test(call.text) ? stageFlag(call.text) : null;
      if (s) approved.add(`${chat(e.src)}|${s}`);
    }
    if (e.kind === "call" && e.paths) {
      for (const p of e.paths) {
        const s = stageOfPath(p);
        if (s && approved.has(`${chat(e.src)}|${s}`)) add("changed-after-approval", s, "write after approval", basename(p.replace(/\\/g, "/")), e.src);
      }
    }
  });
  // silence
  let last: TraceEvent | null = null;
  let lastCall: TraceEvent | null = null;
  for (const e of [...leg.events].filter((x) => x.at !== null).sort((a, b) => (a.at! - b.at!) || 0)) {
    if (last && e.at! - last.at! >= gapMs) {
      const before = lastCall ? `${lastCall.tool === "command" ? "command" : lastCall.tool}: ${clip(firstLine(lastCall.text), 160)}` : clip(last.text, 160);
      add("silence", e.stage, `gap ${minutes(e.at! - last.at!)} min`, `after ${before}`, e.src);
    }
    last = e;
    if (e.kind === "call") lastCall = e;
  }
  for (const r of leg.reports) {
    r.turns.forEach((t, i) => {
      if (t.seconds * 1000 >= gapMs) add("silence", "", `long turn ${minutes(t.seconds * 1000)} min`, `turn ${i + 1} ("${clip(t.line, 80)}")`, `${r.file}#turns[${i}]`);
    });
  }
  // tool-error
  leg.events.forEach((e, i) => {
    if (e.kind !== "result" || !e.isError) return;
    const call = callOf(e, i);
    const tool = call?.tool ?? e.tool ?? "";
    if (!isClaudeFamily(leg.harness) || tool === "Bash" || tool === "AskUserQuestion" || tool === "" || refused(e, call)) return;
    add("tool-error", e.stage, tool, clip(firstLine(e.text), 200), e.src);
  });
  return rows;
}

// --- What a leg was like for the person -----------------------------------------

function stamp(e: TraceEvent, origin: number | null): string {
  if (e.at === null || origin === null) return `[turn ${e.turn}]`;
  const s = Math.max(0, Math.round((e.at - origin) / 1000));
  return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
}

function eventLine(e: TraceEvent): string | null {
  switch (e.kind) {
    case "person":
      return `PERSON typed: ${clip(oneLine(e.text), 600)}`;
    case "pick":
      return `PERSON picked: ${clip(oneLine(e.text), 300)}`;
    case "ask":
      return `ASKED ${clip(oneLine(e.text), 900)}`;
    case "call":
      return e.tool === "Bash" || e.tool === "command" ? `AGENT ran: ${clip(oneLine(e.text), 300)}` : `AGENT used ${e.tool}: ${clip(oneLine(e.text), 200)}`;
    case "result":
      return `  -> ${e.isError ? "ERROR " : ""}${clip(oneLine(e.text), 300)}`;
    case "say":
      return `AGENT said: ${clip(oneLine(e.text), 1500)}`;
    case "stop":
      return `STOP hook: ${e.text}`;
    case "permission":
      return `PERMISSION asked: ${clip(oneLine(e.text), 200)}`;
    case "note":
      return `NOTE: ${clip(oneLine(e.text), 300)}`;
    default:
      return null;
  }
}

const rowLine = (r: TraceRow) => `${r.cls}: ${r.stage || "-"} ${r.event}${r.detail ? `: ${r.detail}` : ""} (${r.evidence})`;

/** The leg as the person lived it, within `budget` bytes: calls and replies are cut from the middle first. */
export function storyText(leg: TraceLeg, budget = 40_000, gapMinutes = 10): string {
  const head = [
    `# ${leg.test}${leg.attempt !== null ? ` attempt ${leg.attempt}` : ""}: ${leg.harness || "unknown harness"} ${leg.os}, run ${leg.run}${leg.status ? `, ${leg.status}` : ""}`,
    "",
    `Sources: ${leg.sources.map((s) => `${s.kind} ${s.path} (${s.count})`).join("; ") || "none"}`,
    ...(leg.sources.some((s) => s.kind === "audit") ? [] : ["Not kept for this leg: the project's audit shard."]),
    "",
    "## Rows",
    ...(leg.rows.length ? leg.rows.map(rowLine) : ["(none)"]),
    "",
    "## What happened",
  ];
  const timed = leg.events.filter((e) => e.at !== null);
  const origin = timed.length ? Math.min(...timed.map((e) => e.at!)) : null;
  type Line = { text: string; prio: number; src: string };
  const body: Line[] = [];
  let prev: TraceEvent | null = null;
  for (const e of leg.events) {
    if (prev && e.at !== null && prev.at !== null && e.at - prev.at >= gapMinutes * 60_000) {
      body.push({ text: `(silent ${minutes(e.at - prev.at)} min)`, prio: 0, src: e.src });
    }
    if (e.at !== null) prev = e;
    const line = eventLine(e);
    if (line === null) continue;
    const prio = e.kind === "call" ? 1 : e.kind === "result" ? 2 : 0;
    body.push({ text: `${stamp(e, origin)} ${line}`, prio, src: e.src });
  }
  const tail: string[] = [];
  for (const r of leg.reports) {
    tail.push("", `## Driver report (${r.file})`, r.line, ...r.person.map((p) => `person: ${p}`), ...r.problems.map((p) => `problem: ${p}`));
  }
  const render = (keep: (i: number) => boolean): string => {
    const out: string[] = [...head];
    let cut = 0;
    let cutSrc = "";
    body.forEach((l, i) => {
      if (keep(i)) {
        if (cut > 0) out.push(`(${cut} events cut here; the full trace is ${cutSrc})`);
        cut = 0;
        out.push(l.text);
      } else {
        cut++;
        cutSrc = l.src.replace(/:\d+$/, "");
      }
    });
    if (cut > 0) out.push(`(${cut} events cut here; the full trace is ${cutSrc})`);
    return `${[...out, ...tail].join("\n")}\n`;
  };
  const full = render(() => true);
  if (Buffer.byteLength(full) <= budget) return full;
  // Keep every line the person met; keep calls and replies only at the start and the end.
  const optional = body.map((l, i) => (l.prio > 0 ? i : -1)).filter((i) => i >= 0);
  let lo = 0;
  let hi = Math.ceil(optional.length / 2);
  let best = render((i) => body[i].prio === 0);
  while (lo <= hi) {
    const k = Math.floor((lo + hi) / 2);
    const kept = new Set([...optional.slice(0, k), ...optional.slice(optional.length - k)]);
    const text = render((i) => body[i].prio === 0 || kept.has(i));
    if (Buffer.byteLength(text) <= budget) {
      best = text;
      lo = k + 1;
    } else {
      hi = k - 1;
    }
  }
  if (Buffer.byteLength(best) <= budget) return best;
  const bytes = Buffer.from(best);
  const note = "\n(the rest is cut to fit; read the sources above)\n";
  return `${bytes.subarray(0, budget - Buffer.byteLength(note)).toString("utf8").replace(/\uFFFD+$/, "")}${note}`;
}

// --- Writing it out ---------------------------------------------------------------

/** One plain table per run: what was read, the counts per class, then one line per row. */
export function tableText(audits: RunAudit[]): string {
  const out: string[] = [];
  for (const a of audits) {
    const byHarness = new Map<string, number>();
    for (const l of a.legs) byHarness.set(l.harness || "unknown", (byHarness.get(l.harness || "unknown") ?? 0) + 1);
    out.push(`Trace audit: ${a.label} (${a.legs.length} legs read: ${[...byHarness].map(([h, n]) => `${h} ${n}`).join(", ") || "none"})`);
    out.push(`Counts: ${CLASSES.map((c) => `${c} ${a.counts[c]}`).join(", ")}`);
    out.push("class | harness | OS | test | attempt | stage | event | detail | evidence");
    for (const r of a.rows) {
      out.push([r.cls, r.harness, r.os, r.test, r.attempt ?? "-", r.stage || "-", r.event, r.detail || "-", r.evidence].join(" | "));
    }
    out.push("");
  }
  return `${out.join("\n")}`;
}

const safe = (p: string) => p.split("/").map((s) => s.replace(/[^A-Za-z0-9._-]/g, "_")).join("/");

/** The table, its JSON, each leg's story and the index the judgement pass reads, all under `outDir`. */
export function writeAudit(audits: RunAudit[], outDir: string, opts: { storyBytes?: number; gapMinutes?: number } = {}): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "table.txt"), tableText(audits));
  const index: Record<string, unknown>[] = [];
  for (const a of audits) {
    for (const leg of a.legs) {
      const dir = join("legs", safe(leg.id));
      mkdirSync(join(outDir, dir), { recursive: true });
      writeFileSync(join(outDir, dir, "story.md"), storyText(leg, opts.storyBytes, opts.gapMinutes));
      writeFileSync(join(outDir, dir, "leg.json"), `${JSON.stringify({ ...leg, events: undefined, audit: undefined, root: a.root }, null, 1)}\n`);
      index.push({
        id: leg.id, run: leg.run, harness: leg.harness, os: leg.os, test: leg.test, attempt: leg.attempt, status: leg.status,
        root: a.root, dir: leg.dir, story: posix(join(dir, "story.md")), rows: leg.rows.length, sources: leg.sources.map((s) => s.kind),
      });
    }
  }
  writeFileSync(join(outDir, "table.json"), `${JSON.stringify({
    runs: audits.map((a) => ({ label: a.label, run: a.run, root: a.root, legs: a.legs.length, counts: a.counts, rows: a.rows })),
  }, null, 1)}\n`);
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify({ legs: index }, null, 1)}\n`);
}

// --- Getting a run's artifacts ----------------------------------------------------

/** Download a Full Suite run's live artifacts with the person's own `gh` into `cache/<run>/`, once. */
export function downloadRun(runId: string, cache: string, repo: string): string {
  const dir = join(cache, runId);
  const list = spawnSync("gh", ["api", `repos/${repo}/actions/runs/${runId}/artifacts`, "--paginate", "--jq",
    '.artifacts[] | select(.expired == false) | select(.name | startswith("full-suite-live-")) | select(.name | startswith("full-suite-live-deps") | not) | .name'],
  { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`gh could not list the artifacts of run ${runId}: ${firstLine(list.stderr ?? "")}`);
  for (const name of list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const target = join(dir, name);
    if (existsSync(join(target, ".trace-audit-complete"))) continue;
    mkdirSync(target, { recursive: true });
    const got = spawnSync("gh", ["run", "download", runId, "-R", repo, "-n", name, "-D", target], { encoding: "utf8" });
    if (got.status !== 0) {
      console.error(`trace-audit: ${name} of run ${runId} did not download: ${firstLine(got.stderr ?? "")}`);
      continue;
    }
    writeFileSync(join(target, ".trace-audit-complete"), "");
  }
  return dir;
}

function parseArgs(argv: string[]): { flags: Map<string, string[]>; positional: string[] } {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a.slice(2), argv[i + 1]?.startsWith("--") ? "" : argv[++i] ?? ""];
      flags.set(k, [...(flags.get(k) ?? []), v]);
    } else positional.push(a);
  }
  return { flags, positional };
}

const USAGE = [
  "usage: bun scripts/trace-audit.ts extract (--run <id> | --dir <folder>)... [--label <name>] [--out <dir>] [--cache <dir>] [--gap-minutes <n>] [--repo <owner/name>]",
  "       bun scripts/trace-audit.ts judge <out-dir> [options]   (bun scripts/trace-audit-judge.ts --help)",
].join("\n");

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "judge") {
    const judge = await import("./trace-audit-judge.ts");
    return judge.main(rest);
  }
  if (command !== "extract") {
    console.log(USAGE);
    return command === "--help" || command === "-h" ? 0 : 2;
  }
  const { flags } = parseArgs(rest);
  const gapMinutes = Number(flags.get("gap-minutes")?.[0] ?? 10);
  const out = resolve(flags.get("out")?.[0] ?? join(tmpdir(), "aidlc-trace-audit", new Date().toISOString().slice(0, 10)));
  const cache = resolve(flags.get("cache")?.[0] ?? join(tmpdir(), "aidlc-trace-audit", "runs"));
  const repo = flags.get("repo")?.[0] ?? "awslabs/aidlc-workflows";
  const folders: { dir: string; label?: string }[] = [];
  for (const id of flags.get("run") ?? []) folders.push({ dir: downloadRun(id, cache, repo), label: id });
  const labels = flags.get("label") ?? [];
  for (const [i, d] of (flags.get("dir") ?? []).entries()) folders.push({ dir: resolve(d), label: labels[i] });
  if (folders.length === 0) {
    console.log(USAGE);
    return 2;
  }
  if (folders.some((f) => resolve(out).startsWith(`${resolve(f.dir)}${sep}`) || resolve(out) === resolve(f.dir))) {
    console.error("trace-audit: --out must be outside the folders it reads; it never writes into them.");
    return 2;
  }
  const audits = folders.map((f) => auditFolder(f.dir, { label: f.label, gapMinutes }));
  writeAudit(audits, out, { gapMinutes });
  process.stdout.write(tableText(audits));
  console.log(`trace-audit: wrote ${join(out, "table.txt")}, table.json and ${audits.reduce((n, a) => n + a.legs.length, 0)} leg stories under ${join(out, "legs")}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
