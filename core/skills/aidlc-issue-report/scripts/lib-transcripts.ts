// The AI tool's own conversation logs, for the part AI-DLC does not record:
// refusals shown to the model, failed tool calls, repeated calls, approval
// prompts, and the person's own words (kept local only, never in safe.json).

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

// The one annotation the readers add after a model or effort an agent set for itself.
export const OWN = " (agent's own)";

export type Summary = {
  tool: string;
  sessions: number;
  firstTs: string | null;
  lastTs: string | null;
  prompts: number;
  toolCalls: number;
  toolErrors: number;
  denials: Record<string, number>;
  aidlcHookBlocks: Record<string, number>;
  stopFeedback: number;
  approvalPrompts: number;
  questionsAsked: number;
  aidlcCommands: Record<string, number>;
  repeats: { tool: string | undefined; count: number; firstTs: string; lastTs: string }[];
  timeline: { ts: string; kind: string; detail: string }[];
  subagents: Record<string, { dispatches: number; models: Record<string, number>; efforts: Record<string, number> }>;
  // The run as it was, counted per session (the person may have upgraded or switched since).
  engine: "v3" | "v2" | null; // Kiro: which session store the logs came from; null for other tools
  toolVersions: Record<string, number>; // version the tool wrote into its own log: Claude Code `version`, Codex `cli_version`; Kiro writes none
  models: Record<string, number>; // main agent's model (subagents are under `subagents`)
  efforts: Record<string, number>;
  agents: Record<string, number>; // Kiro agent the session ran (v3 `agentMode`, v2 `agent_name`)
  approvalModes: Record<string, number>; // Claude `permissionMode`, Codex `approval_policy`, Kiro `autopilot`
  // Engine checks the agent ran by hand (`engine sensor-<name> [--stage <stage>]`, native or copied): they write no audit row, so this
  // is the only place a later pass (or fail) shows. `pass` is read from the JSON the check printed; null when not found.
  handRunChecks: { ts: string; check: string; pass: boolean | null }[];
  // Sessions that ran this skill's own scripts (the report being made now): counted here, kept out of the run's facts above.
  reportSessions: number;
  // Of those, the ones that held the run before the report began: still sessions the run used.
  mixedSessions: number;
  reportModels: Record<string, number>;
  notes: string[];
};
// A reply the person typed, as the tool logged it. Codex adds how it reached the tool.
export type Prompt = {
  tool: string;
  ts: string;
  text: string;
  inherited?: boolean;
  session?: string;
  // Typed while this skill made its report (from the person's message that asked for it): not part of the run.
  report?: boolean;
  // An AI-DLC command ran after it, before the next reply: the reply was about the AI-DLC work, so AI-DLC's
  // prompt hook should have recorded it. Undefined where the reader cannot tell.
  engineAfter?: boolean;
  turn?: string;
  inRunningTurn?: boolean;
  sameAsBeforeInTurn?: boolean;
};
export type Local = { prompts: Prompt[]; refusals: object[]; errors: object[] };

// The replies of a session from the person's message that started this report: the last one before
// the first call of this skill's scripts, or that call when none came before it.
function markReport(prompts: Prompt[], from: string | null | undefined, pick: (p: Prompt) => boolean) {
  if (!from) return;
  for (const p of prompts) if (pick(p) && p.ts >= from) p.report = true;
}

// Each tool's log line, as far as these readers use it. The logs are the tool's
// own and change with its version, so every field is optional and a reader
// checks a field's shape before it relies on it.
type ClaudePart = {
  type?: string;
  text?: string;
  name?: string;
  input?: { command?: unknown };
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type ClaudeLine = {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  version?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  toolDenialKind?: unknown;
  preventedContinuation?: boolean;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  message?: { model?: unknown; content?: string | ClaudePart[] };
};
type CodexPayload = {
  type?: string;
  role?: string;
  cwd?: string;
  thread_source?: string;
  forked_from_id?: string;
  parent_thread_id?: string;
  cli_version?: unknown;
  model?: unknown;
  effort?: unknown;
  approval_policy?: unknown;
  content?: { text?: string }[];
  internal_chat_message_metadata_passthrough?: { turn_id?: string };
  name?: string;
  arguments?: unknown;
  input?: unknown;
  call_id?: string;
  output?: unknown;
};
type CodexLine = { type?: string; timestamp?: string; payload?: CodexPayload & { id?: string } };
type KiroPayload = {
  type?: string;
  content?: unknown;
  _meta?: { kiro?: { agentMode?: unknown; syntheticUserMessageReason?: unknown } };
  toolName?: string;
  args?: { command?: unknown; cmd?: unknown };
  toolCallId?: string;
  success?: boolean;
  interactionType?: string;
  subAgentName?: string;
};
type KiroLine = { timestamp?: string; payload?: KiroPayload };
type KiroLogLine = { conversationId?: string; message?: unknown };
type KiroSession = { workspacePaths?: string[]; modelId?: unknown; effortLevel?: unknown; agentMode?: unknown; autopilot?: unknown };
type KiroV2Meta = {
  cwd?: string;
  updated_at?: string;
  session_state?: { agent_name?: unknown; rts_model_state?: { model_info?: { model_id?: unknown } } };
};
type KiroV2Line = {
  kind?: string;
  data?: {
    meta?: { timestamp?: string };
    timestamp?: string;
    content?: unknown;
    results?: Record<string, { result?: unknown } | null>;
  };
};
type CopilotEvent = { type?: string; timestamp?: string; data?: { content?: unknown; arguments?: unknown; success?: boolean } };
type SubagentStart = { subagentId?: unknown; modelId?: unknown; modelOverride?: unknown; effortLevel?: unknown; effortOverride?: unknown };

function empty(tool: string): Summary {
  return {
    tool, sessions: 0, firstTs: null, lastTs: null, prompts: 0, toolCalls: 0, toolErrors: 0, denials: {}, aidlcHookBlocks: {},
    stopFeedback: 0, approvalPrompts: 0, questionsAsked: 0, aidlcCommands: {}, repeats: [], timeline: [], subagents: {},
    engine: null, toolVersions: {}, models: {}, efforts: {}, agents: {}, approvalModes: {}, handRunChecks: [], reportSessions: 0,
    mixedSessions: 0, reportModels: {}, notes: [],
  };
}

type RunFacts = { toolVersions: Set<string>; models: Set<string>; efforts: Set<string>; agents: Set<string>; approvalModes: Set<string> };
const newFacts = (): RunFacts => ({ toolVersions: new Set(), models: new Set(), efforts: new Set(), agents: new Set(), approvalModes: new Set() });

function note(set: Set<string>, value: unknown) {
  if (typeof value === "boolean") set.add(value ? "on" : "off");
  else if (typeof value === "string" && value && !value.startsWith("<")) set.add(value.slice(0, 60));
}

// An agent name the person made up can name their project, so only AI-DLC's own agents (`aidlc`,
// `aidlc-<role>-agent`) and Kiro's built-ins (`default` = v3, `kiro_default` = v2, the IDE's `vibe`/`spec`)
// keep their name; every other agent, `aidlc-…` look-alikes included, is `custom` (lib-shape.ts keeps both).
export const BUILTIN_AGENTS: ReadonlySet<string> = new Set(["default", "kiro_default", "vibe", "spec"]);
function agentName(name: string): string {
  return /^aidlc(-[a-z]+)*-agent$|^aidlc$/.test(name) || BUILTIN_AGENTS.has(name) ? name : "custom";
}

// A fact with the time it was logged, so a session that held the run and then this report can be
// split where the report began.
type TimedFact = { ts: string; key: keyof RunFacts; value: unknown };
function factsOf(log: TimedFact[], pick: (f: TimedFact) => boolean): RunFacts {
  const f = newFacts();
  for (const e of log) if (pick(e)) note(f[e.key], e.value);
  return f;
}
// The `aidlc` command's engine verbs, or one of AI-DLC's tool scripts run directly (`aidlc-orchestrate.ts next`).
const ENGINE_CALL = /\baidlc(?:\.ts|\.cmd|\.exe)?["']?\s+engine\b|\baidlc-[a-z][a-z-]*\.ts["']?\s+[a-z]/;

// A session's facts: all the run's, unless this report began in it (`from`). Then the part from there is
// the report's, and the part before is the run's only when it drove AI-DLC before the report began.
function addTimedSession(s: Summary, log: TimedFact[], from: string | undefined, firstEngineCall: string | undefined) {
  if (!from) return addSession(s, factsOf(log, () => true), false);
  addSession(s, factsOf(log, (e) => e.ts >= from), true);
  if (firstEngineCall && firstEngineCall < from) {
    addFacts(s, factsOf(log, (e) => e.ts < from));
    s.mixedSessions++;
  }
}

// One count per session for each value it used.
function addFacts(s: Summary, f: RunFacts) {
  for (const k of ["toolVersions", "models", "efforts", "agents", "approvalModes"] as const) for (const v of f[k]) bump(s[k], v);
}

// A run of this skill's scripts, as written or inside JSON text (a Windows path's backslashes doubled).
const REPORT_RUN = /aidlc-issue-report(?:\\{1,2}|\/)scripts(?:\\{1,2}|\/)/;
// A session that ran this skill's scripts is the report session, not part of the run: its model is the
// report's, not the run's.
function addSession(s: Summary, f: RunFacts, isReport: boolean) {
  if (!isReport) return addFacts(s, f);
  s.reportSessions++;
  for (const v of f.models) bump(s.reportModels, v);
}

// `… engine sensor-traceability --stage build-and-test` → "sensor-traceability --stage build-and-test". Only
// AI-DLC's own check and stage names are kept: a check the agent ran by hand writes no audit row, so its
// pass or fail shows only here.
const CHECK_CMD = /\baidlc(?:\.ts|\.cmd|\.exe)?["']?\s+(?:engine\s+)?(sensor-[a-z][a-z-]*)(?:[^\n|;&]*?--stage[ =]["']?([a-z][a-z-]*))?/i;
function checkName(cmd: unknown): string | null {
  if (typeof cmd !== "string") return null;
  const m = cmd.match(CHECK_CMD);
  return m ? `${m[1].toLowerCase()}${m[2] ? ` --stage ${m[2].toLowerCase()}` : ""}`.slice(0, 80) : null;
}
function checkPass(text: string): boolean | null {
  const m = text.match(/"pass"\s*:\s*(true|false)/);
  return m ? m[1] === "true" : null;
}
function noteCheck(s: Summary, pending: Map<string, { ts: string; check: string }>, id: unknown, text: string) {
  const c = typeof id === "string" ? pending.get(id) : undefined;
  if (!c) return;
  pending.delete(id as string);
  s.handRunChecks.push({ ts: c.ts, check: c.check, pass: checkPass(text) });
}

function bump(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

function subagent(s: Summary, name: string) {
  s.subagents[name] ??= { dispatches: 0, models: {}, efforts: {} };
  return s.subagents[name];
}
const HOOK_BLOCK = /\[aidlc\sengine hook ([a-z0-9-]+)\]/gi;
// An AI-DLC command as the agent typed it, native (`engine orchestrate next` after `aidlc`) or from a copied
// tree (the same verbs after the tree's `aidlc.ts`, or after an `aidlc-<tool>.ts` such as `aidlc-log.ts`).
const AIDLC_CMD = /\baidlc(?:-([a-z-]+))?(?:\.ts|\.cmd|\.exe)?["']?\s+(?:engine\s+)?([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/i;

function inWindow(ts: string | undefined, since: number, until: number): ts is string {
  if (!ts) return false;
  const t = Date.parse(ts);
  return !Number.isNaN(t) && t >= since && t <= until;
}

function touch(s: Summary, ts: string) {
  if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
  if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
}

// Words after a verb can be the person's own words (`continue <their words>`),
// so only AI-DLC's own subcommand names are kept.
const SUBVERBS = new Set([
  "next", "report", "continue", "decision", "answer", "answers", "review", "surface", "fire", "unit", "create", "set", "show",
  "check", "checkpoint", "practices-event", "practices-promote", "render", "brief", "doctor", "status", "jump", "execute",
  "set-autonomy", "set-unit-ownership", "set-construction-verification-command", "project-description", "history", "summary",
  "pin", "start", "fail", "abort", "compose", "models", "trust", "flags", "runtime", "providers", "preview", "hook", "adapter",
]);

function noteCommand(s: Summary, text: string) {
  const m = text.match(AIDLC_CMD);
  if (!m) return;
  // `aidlc-orchestrate next` and `aidlc orchestrate next` are the same call.
  const words = m[1] ? [m[1], m[2], m[3]] : [m[2], m[3]];
  const kept = [words[0], words[1] && SUBVERBS.has(words[1].toLowerCase()) ? words[1] : null, words[2] && SUBVERBS.has(words[2].toLowerCase()) ? words[2] : null];
  const verb = ["aidlc", ...kept.filter(Boolean)].join(" ").toLowerCase();
  if (!/^aidlc [a-z]/.test(verb)) return;
  bump(s.aidlcCommands, verb.slice(0, 60));
}

function noteText(s: Summary, local: Local, ts: string, text: string, isError: boolean) {
  let blocked = false;
  for (const m of text.matchAll(HOOK_BLOCK)) {
    bump(s.aidlcHookBlocks, m[1]);
    s.timeline.push({ ts, kind: "aidlc-hook-block", detail: m[1] });
    blocked = true;
  }
  if (/Stop hook (feedback|error)/.test(text)) {
    s.stopFeedback++;
    s.timeline.push({ ts, kind: "stop-hook-feedback", detail: "" });
    blocked = true;
  }
  if (blocked) local.refusals.push({ tool: s.tool, ts, text: text.slice(0, 1500) });
  else if (isError) local.errors.push({ tool: s.tool, ts, text: text.slice(0, 600) });
}

// Same tool with the same input three times or more = a loop worth naming.
type Calls = Map<string, { tool: string | undefined; ts: string[] }>;

function finishRepeats(s: Summary, calls: Calls) {
  for (const c of calls.values()) {
    const ts = [...c.ts].sort();
    if (ts.length >= 3) s.repeats.push({ tool: c.tool, count: ts.length, firstTs: ts[0], lastTs: ts[ts.length - 1] });
  }
  s.repeats.sort((a, b) => b.count - a.count);
  s.repeats = s.repeats.slice(0, 15);
}

function callKey(name: string | undefined, input: unknown): string {
  return createHash("sha256").update(`${name}\0${JSON.stringify(input ?? "")}`).digest("hex").slice(0, 16);
}

// A tool's own name stays (Bash, Read, fs_read …); an MCP tool's name carries its server's, which can
// be a company system, so it is only `mcp`.
function toolLabel(tool: string | undefined): string | undefined {
  if (tool === undefined) return undefined;
  return /^mcp[_-]|[/@.:]/.test(tool) ? "mcp" : tool.slice(0, 60);
}

function noteCall(calls: Calls, rawTool: string | undefined, input: unknown, ts: string) {
  const tool = toolLabel(rawTool);
  const k = callKey(rawTool, input);
  const call = calls.get(k);
  if (call) call.ts.push(ts);
  else calls.set(k, { tool, ts: [ts] });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// The first JSON line of a file, read without loading the rest: chunk by chunk up to its end of line
// (Codex's session_meta line carries the instructions it started with, often past 64 KB).
function firstLine<T>(path: string): T | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let at = 0; at < 64 * 1024 * 1024; ) {
      const n = readSync(fd, buf, 0, buf.length, at);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? n : nl)));
      if (nl >= 0) break;
      at += n;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// One parsed JSON value per line, typed by the caller (see the line types above).
function readLines<T>(path: string): T[] {
  const out: T[] = [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // partial last line while the tool is writing
    }
  }
  return out;
}

// Letter case counts only where the file system usually ignores it (Windows, macOS).
const FOLD_CASE = platform() === "win32" || platform() === "darwin";
function within(project: string, cwd: unknown): boolean {
  if (typeof cwd !== "string" || !cwd) return false;
  // macOS stores a folder name decomposed (NFD); the same name typed is composed.
  const fold = (x: string) => (FOLD_CASE ? x.normalize("NFC").toLowerCase() : x.normalize("NFC"));
  const a = fold(resolve(cwd));
  const p = fold(resolve(project));
  return a === p || a.startsWith(`${p}/`) || a.startsWith(`${p}\\`);
}

function recentFiles(dir: string, ext: string, since: number, depth = 3): string[] {
  const out: string[] = [];
  if (!existsSync(dir) || depth < 0) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...recentFiles(p, ext, since, depth - 1));
    else if (f.endsWith(ext) && st.mtimeMs >= since) out.push(p);
  }
  return out;
}

// ---------- Claude Code ----------
export function claude(project: string, since: number, until: number, local: Local): Summary | null {
  // CLAUDE_CONFIG_DIR may name ~/.claude itself, through a link or in other letter case on Windows: each folder
  // is read once.
  const real = (r: string) => {
    let path = resolve(r);
    try {
      path = realpathSync(path);
    } catch {
      // not there: nothing to read twice
    }
    return platform() === "win32" ? path.toLowerCase() : path;
  };
  const byReal = new Map<string, string>();
  for (const r of [process.env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude")]) if (r && !byReal.has(real(r))) byReal.set(real(r), r);
  const roots = [...byReal.values()].map((r) => join(r, "projects"));
  // Claude Code names a project's folder after its path, every other character a dash; a macOS path may be stored
  // decomposed (NFD), which has more of them.
  const keys = [...new Set(["NFC", "NFD"].map((f) => resolve(project).normalize(f).replace(/[^A-Za-z0-9]/g, "-")))];
  const s = empty("claude-code");
  const calls: Calls = new Map();
  const sessions = new Map<string, TimedFact[]>();
  const firstEngine = new Map<string, string>();
  const lastPrompt = new Map<string, string>();
  const lastTyped = new Map<string, Prompt>();
  const reportFrom = new Map<string, string>();
  const checks = new Map<string, { ts: string; check: string }>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // The folder key is the path as Claude Code wrote it, the project's own or a folder under it (`<key>-src`); on Windows
    // and macOS the same path may come in another case. A sibling whose name only starts the same (`-Users-x-app-old`
    // beside `-Users-x-app`) is read and its records dropped by within().
    const fold = (x: string) => (FOLD_CASE ? x.toLowerCase() : x);
    for (const d of readdirSync(root).filter((d) => keys.some((key) => fold(d) === fold(key) || fold(d).startsWith(`${fold(key)}-`)))) {
      // A session's lines and its subagents' (`<id>/subagents/*.jsonl`) are read together in time order, so an
      // engine call is tied to the reply before it and the first engine call is the earliest.
      const records = recentFiles(join(root, d), ".jsonl", since).flatMap((file) => readLines<ClaudeLine>(file).map((r) => ({ r, file })));
      records.sort((a, b) => (a.r.timestamp ?? "").localeCompare(b.r.timestamp ?? ""));
      for (const { r, file } of records) {
        if (!within(project, r.cwd) || !inWindow(r.timestamp, since, until)) continue;
        const ts = r.timestamp;
        const id = r.sessionId ?? file;
        const log = sessions.get(id) ?? [];
        sessions.set(id, log);
        log.push({ ts, key: "toolVersions", value: r.version });
        if (!r.isSidechain) {
          if (r.type === "assistant") {
            log.push({ ts, key: "models", value: r.message?.model }, { ts, key: "efforts", value: r.effort });
          }
          if (r.type === "user") log.push({ ts, key: "approvalModes", value: r.permissionMode });
        }
        touch(s, ts);
        if (r.toolDenialKind) {
          bump(s.denials, String(r.toolDenialKind));
          s.timeline.push({ ts, kind: "tool-denied", detail: String(r.toolDenialKind) });
        }
        const content = r.message?.content;
        // Claude Code writes two kinds of user line nobody typed: the summary
        // that opens a compacted session, and the interrupt marker.
        if (r.type === "user" && !r.isMeta && !r.isSidechain && !r.isCompactSummary && !r.isVisibleInTranscriptOnly) {
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((c) => c?.type === "text")
                    .map((c) => c.text)
                    .join("\n")
                : "";
          // A slash command the person typed is logged as `<command-name>/x</command-name>…`; other `<…>`
          // lines are injected context.
          const command = text.match(/<command-name>([^<]{1,200})<\/command-name>(?:[\s\S]*?<command-args>([^<]{0,2000})<\/command-args>)?/);
          const typed = command ? `${command[1]} ${command[2] ?? ""}`.trim() : text;
          if (typed.trim() && (command || !text.startsWith("<")) && !text.startsWith("[Request interrupted by user")) {
            s.prompts++;
            const prompt: Prompt = { tool: s.tool, ts, text: typed.slice(0, 2000), session: id, engineAfter: false };
            local.prompts.push(prompt);
            lastTyped.set(id, prompt);
            if (!reportFrom.has(id)) lastPrompt.set(id, ts);
          }
        }
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "tool_use") {
              s.toolCalls++;
              if (c.name === "AskUserQuestion") s.questionsAsked++;
              noteCall(calls, c.name, c.input, ts);
              if (typeof c.input?.command === "string") {
                noteCommand(s, c.input.command);
                if (ENGINE_CALL.test(c.input.command)) {
                  if (!firstEngine.has(id) || ts < (firstEngine.get(id) ?? ts)) firstEngine.set(id, ts);
                  const last = lastTyped.get(id);
                  if (last) last.engineAfter = true;
                }
                if (REPORT_RUN.test(c.input.command) && !reportFrom.has(id)) reportFrom.set(id, lastPrompt.get(id) ?? ts);
                const check = checkName(c.input.command);
                if (check && c.id) checks.set(c.id, { ts, check });
              }
            } else if (c?.type === "tool_result") {
              const text =
                typeof c.content === "string"
                  ? c.content
                  : Array.isArray(c.content)
                    ? (c.content as ({ text?: string } | null)[]).map((x) => x?.text ?? "").join("\n")
                    : "";
              noteCheck(s, checks, c.tool_use_id, text);
              if (c.is_error) s.toolErrors++;
              noteText(s, local, ts, text, !!c.is_error);
            }
          }
        }
        if (r.type === "system" && r.subtype === "stop_hook_summary" && r.preventedContinuation) {
          s.stopFeedback++;
        }
      }
    }
  }
  if (sessions.size === 0) return null;
  for (const [id, from] of reportFrom) markReport(local.prompts, from, (p) => p.tool === s.tool && p.session === id);
  s.sessions = sessions.size;
  for (const [id, log] of sessions) addTimedSession(s, log, reportFrom.get(id), firstEngine.get(id));
  finishRepeats(s, calls);
  return s;
}

// ---------- Codex CLI ----------
// A call Codex could not make writes no exit code: `exec_command failed: …` (its approval review rejected it, or
// the process could not start), `apply_patch verification failed: …`, `failed to parse function arguments …`
// (measured 10-29 on Codex 0.16x logs). A rejection by the approval review is a denial as well.
const CODEX_CALL_FAILED = /^\s*(?:[a-z_]+ failed:|apply_patch verification failed|failed to parse function arguments)/;
const CODEX_REVIEW_REJECTED = /Rejected\(\\?"This action was rejected/;

export function codex(project: string, since: number, until: number, local: Local): Summary | null {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const s = empty("codex");
  const calls: Calls = new Map();
  for (const file of recentFiles(root, ".jsonl", since, 4)) {
    // A rollout starts with its session_meta: another project's file is dropped before it is read whole.
    if (!within(project, firstLine<CodexLine>(file)?.payload?.cwd)) continue;
    const lines = readLines<CodexLine>(file);
    const meta = lines.find((l) => l.type === "session_meta");
    if (!meta || !within(project, meta.payload?.cwd)) continue;
    // Only a session the person opened holds their replies. A subagent's file starts with its parent's history (copies),
    // and Codex's automatic approval review (`thread_source: "guardian_review"`) writes
    // its own user lines; both carry a parent thread.
    const ts0 = meta.payload?.thread_source;
    const inherited = (ts0 !== undefined && ts0 !== "user") || !!meta.payload?.forked_from_id || !!meta.payload?.parent_thread_id;
    // Codex folds a reply typed before the turn has ended into that same turn (same turn_id, no new
    // task_started); AI-DLC's prompt hook then may not record it (the replies seen not
    // recorded were exactly these, each the same text as the reply before it in that turn).
    const lastInTurn = new Map<string, string>();
    const log: TimedFact[] = [{ ts: meta.timestamp ?? "", key: "toolVersions", value: meta.payload?.cli_version }];
    let firstEngineCall: string | undefined;
    let used = false;
    // Codex logs a turn's turn_context (its model) a moment before the person's message, so a turn is
    // cut where its turn_context starts.
    let turnStart: string | null = null;
    let lastPrompt: string | null = null;
    let lastTyped: Prompt | null = null;
    let reportFrom: string | null = null;
    const firstPrompt = local.prompts.length;
    const checks = new Map<string, { ts: string; check: string }>();
    for (const l of lines) {
      if (!inWindow(l.timestamp, since, until)) continue;
      const ts = l.timestamp;
      const p: CodexPayload = l.payload ?? {};
      used = true;
      touch(s, ts);
      // A subagent's or reviewer's session runs its own model: only the person's own sessions count here.
      if (l.type === "turn_context") turnStart = ts;
      if (l.type === "turn_context" && !inherited) {
        log.push({ ts, key: "models", value: p.model }, { ts, key: "efforts", value: p.effort }, { ts, key: "approvalModes", value: p.approval_policy });
      }
      if (l.type === "response_item" && p.type === "message" && p.role === "user") {
        const text = (p.content ?? []).map((c) => c?.text ?? "").join("\n");
        const injected = text.trimStart().startsWith("<") || text.trimStart().startsWith("# AGENTS.md instructions");
        // Codex hands a Stop hook's block back as a user line `<hook_prompt hook_run_id="stop:…">reason</hook_prompt>`
        // (shown to the person as "Blocked by hook"), dozens of them in one turn when a hook loops.
        const stopBlock = text.match(/^\s*<hook_prompt hook_run_id="stop:[^"]*">([\s\S]*?)<\/hook_prompt>/);
        if (stopBlock && !inherited) {
          s.stopFeedback++;
          s.timeline.push({ ts, kind: "stop-hook-feedback", detail: "" });
          local.refusals.push({ tool: s.tool, ts, text: stopBlock[1].slice(0, 1500) });
        }
        if (text.trim() && !injected) {
          s.prompts++;
          const turn: string | undefined = p.internal_chat_message_metadata_passthrough?.turn_id;
          const before = turn ? lastInTurn.get(turn) : undefined;
          if (turn) lastInTurn.set(turn, text);
          if (!reportFrom) lastPrompt = turnStart ?? ts;
          lastTyped = {
            tool: s.tool, ts, text: text.slice(0, 2000), inherited, session: meta.payload?.id, engineAfter: false,
            ...(turn ? { turn, inRunningTurn: before !== undefined, sameAsBeforeInTurn: before === text } : {}),
          };
          local.prompts.push(lastTyped);
        }
      } else if (l.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
        s.toolCalls++;
        const input = p.arguments ?? p.input ?? "";
        noteCall(calls, p.name, input, ts);
        const inputText = typeof input === "string" ? input : JSON.stringify(input);
        noteCommand(s, inputText);
        if (ENGINE_CALL.test(inputText)) {
          firstEngineCall ??= ts;
          if (lastTyped) lastTyped.engineAfter = true;
        }
        if (REPORT_RUN.test(inputText) && !reportFrom) reportFrom = lastPrompt ?? ts;
        const check = checkName(inputText);
        if (check && p.call_id) checks.set(p.call_id, { ts, check });
      } else if (l.type === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
        const text = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        noteCheck(s, checks, p.call_id, text);
        const exit = text.match(/(?:exit code|exited with code|Exit code:)\s*(\d+)/i);
        const failed = CODEX_CALL_FAILED.test(text);
        const isError = (!!exit && exit[1] !== "0") || failed;
        if (isError) s.toolErrors++;
        if (failed && CODEX_REVIEW_REJECTED.test(text)) {
          bump(s.denials, "policy-denied");
          s.timeline.push({ ts, kind: "tool-denied", detail: "policy-denied" });
        }
        noteText(s, local, ts, text, isError);
      }
    }
    markReport(local.prompts.slice(firstPrompt), reportFrom, () => true);
    if (used) {
      s.sessions++;
      addTimedSession(s, log, reportFrom ?? undefined, firstEngineCall);
    }
  }
  if (s.sessions === 0) return null;
  finishRepeats(s, calls);
  s.notes.push("Codex hook blocks: Stop hook blocks are counted from the hook prompt lines Codex writes for a Stop hook run (measured 10-18, Codex 0.162); other hooks' blocks come from refusal text only.");
  return s;
}

// ---------- Kiro CLI v3 and Kiro IDE 1.x (shared store) ----------
// A failed tool result; the agent profile's own refusal says `Rule: deny` (Kiro CLI v3 also `Blocked by a
// permission rule (deny …)`, docs/guide/15-troubleshooting.md).
function kiroFailure(s: Summary, local: Local, ts: string, text: string) {
  s.toolErrors++;
  if (/Rule: deny|Blocked by a permission rule \(deny\b/.test(text)) {
    bump(s.denials, "agent-profile-deny");
    s.timeline.push({ ts, kind: "tool-denied", detail: "agent-profile-deny" });
  }
  noteText(s, local, ts, text, true);
}

export function kiroV3(project: string, since: number, until: number, local: Local): Summary | null {
  const root = join(homedir(), ".kiro", "sessions");
  if (!existsSync(root)) return null;
  const ws16 = createHash("sha256").update(resolve(project)).digest("hex").slice(0, 16);
  const s = empty("kiro (v3)");
  s.engine = "v3";
  const calls: Calls = new Map();
  const sessionIds = new Set<string>();
  const wsDirs = existsSync(join(root, ws16)) ? [join(root, ws16)] : [];
  // Windows path strings may hash differently: fall back to session.json.
  if (wsDirs.length === 0) {
    for (const d of readdirSync(root)) {
      if (d === "cli") continue;
      const dir = join(root, d);
      for (const sess of existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((x) => x.startsWith("sess_")) : []) {
        try {
          const j = readJson<KiroSession>(join(dir, sess, "session.json"));
          if ((j.workspacePaths ?? []).some((w) => within(project, w))) {
            wsDirs.push(dir);
            break;
          }
        } catch {
          // not a session folder
        }
      }
    }
  }
  for (const ws of wsDirs) {
    for (const sess of readdirSync(ws).filter((x) => x.startsWith("sess_"))) {
      const files = [join(ws, sess, "messages.jsonl"), ...recentFiles(join(ws, sess, "sub-executions"), ".jsonl", since, 0)];
      let used = false;
      let isReport = false;
      const checks = new Map<string, { ts: string; check: string }>();
      // The person may make the report in the session of the run itself, after switching model or agent (e.g. Haiku and
      // Sonnet runs, then Opus/`vibe` for the report). session.json then holds the report's values, so the run's are read
      // from the messages before the first call of this skill's scripts: the model Kiro names in its session-context note
      // and the agent mode of each message.
      let reportFrom: string | null = null;
      let lastPromptTs: string | null = null; // the report starts with the person's message that asked for it
      const modelNotes: { ts: string; v: string }[] = [];
      const modes: { ts: string; v: string }[] = [];
      const promptTs: string[] = [];
      // The run shows as AI-DLC engine calls, in the main file or a sub-execution's; read after all of them.
      const engineCalls: string[] = [];
      const firstPrompt = local.prompts.length;
      for (const file of files) {
        if (!existsSync(file) || statSync(file).mtimeMs < since) continue;
        const sub = file.includes("sub-executions");
        for (const l of readLines<KiroLine>(file)) {
          if (!inWindow(l.timestamp, since, until)) continue;
          const ts = l.timestamp;
          const p: KiroPayload = l.payload ?? {};
          used = true;
          touch(s, ts);
          if (!sub) {
            if (p.type === "agent_note" && typeof p.content === "string") {
              // "Auto (model selected …).", "Claude Opus 5.5.", "claude-sonnet-5.5." → auto, claude-opus-5.5, claude-sonnet-5.5
              for (const m of p.content.matchAll(/The current model is ([^\n(]+?)(?:\s*\(|\.(?:\s|$)|$)/g)) {
                modelNotes.push({ ts, v: m[1].trim().toLowerCase().replace(/\s+/g, "-") });
              }
            }
            const mode = p._meta?.kiro?.agentMode;
            if (typeof mode === "string") modes.push({ ts, v: mode });
          }
          if (p.type === "user" && !sub && !p._meta?.kiro?.syntheticUserMessageReason) {
            if (!reportFrom) lastPromptTs = ts;
            promptTs.push(ts);
            const text = typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
            if (text.trim()) {
              s.prompts++;
              local.prompts.push({ tool: s.tool, ts, text: text.slice(0, 2000) });
            }
          } else if (p.type === "tool_call") {
            s.toolCalls++;
            noteCall(calls, p.toolName, p.args, ts);
            const cmd = p.args?.command ?? p.args?.cmd;
            if (typeof cmd === "string") {
              noteCommand(s, cmd);
              if (ENGINE_CALL.test(cmd)) engineCalls.push(ts);
              if (REPORT_RUN.test(cmd)) {
                isReport = true;
                if (!reportFrom) reportFrom = lastPromptTs ?? ts;
              }
              const check = checkName(cmd);
              if (check && p.toolCallId) checks.set(p.toolCallId, { ts, check });
            }
          } else if (p.type === "tool_result" && p.toolCallId !== undefined && checks.has(p.toolCallId)) {
            const text = typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
            noteCheck(s, checks, p.toolCallId, text);
            if (p.success === false) kiroFailure(s, local, ts, text);
          } else if (p.type === "tool_result" && p.success === false) {
            kiroFailure(s, local, ts, typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? ""));
          } else if (p.type === "pending_interaction" && p.interactionType === "tool_approval") {
            s.approvalPrompts++;
            s.timeline.push({ ts, kind: "approval-prompt", detail: "" });
          } else if (p.type === "sub_agent_start" && p.subAgentName) {
            subagent(s, agentName(p.subAgentName)).dispatches++;
          }
        }
      }
      // A reply after which no engine call ran (before the next reply) was not about the work; the files are not in
      // time order, so this is read once all are.
      const typed = local.prompts.slice(firstPrompt).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      typed.forEach((prompt, i) => {
        const next = typed[i + 1]?.ts;
        prompt.engineAfter = engineCalls.some((t) => t >= prompt.ts && (!next || t < next));
      });
      if (used) {
        s.sessions++;
        sessionIds.add(sess);
        const facts = newFacts();
        try {
          const j = readJson<KiroSession>(join(ws, sess, "session.json"));
          note(facts.models, j.modelId);
          note(facts.efforts, j.effortLevel);
          if (typeof j.agentMode === "string") note(facts.agents, agentName(j.agentMode));
          note(facts.approvalModes, typeof j.autopilot === "boolean" ? `autopilot ${j.autopilot ? "on" : "off"}` : undefined);
        } catch {
          // session.json missing or mid-write
        }
        // A session that holds the run and then the report: session.json (now the report's) goes to the report counts,
        // and the run gets what its own messages named. Effort and autopilot are not in the messages: left out for the run.
        // The report part begins at the person's message that asked for it, or earlier, where the agent last switched to
        // the one the report ran in (the person can switch to `vibe` and talk before asking for the report) — but
        // never before the run's last engine call: a switch the run itself went on in is the run's.
        engineCalls.sort();
        const firstEngineCall = engineCalls[0] ?? null;
        const asked = reportFrom;
        const lastRunEngineCall = asked ? ([...engineCalls].reverse().find((t) => t < asked) ?? null) : null;
        let from = reportFrom;
        if (from) {
          const last = modes.at(-1)?.v;
          let i = modes.length;
          while (i > 0 && modes[i - 1].v === last) i--;
          if (i > 0 && i < modes.length) {
            const switched = modes[i].ts;
            const prompt = [...promptTs].reverse().find((t) => t <= switched) ?? switched;
            if (prompt < from && (!lastRunEngineCall || prompt > lastRunEngineCall)) from = prompt;
          }
        }
        // Only read while `from` is set; "" sorts before every timestamp.
        const cut = from ?? "";
        const runPrompts = from ? promptTs.filter((t) => t < cut).length : 0;
        if (isReport) markReport(local.prompts.slice(firstPrompt), from, () => true);
        // The part before is a run only when it drove AI-DLC (an engine call before the report began); a report session
        // that only asked the person a question first is all report. Same agent and model on both sides (the
        // report was asked for inside the run's conversation): session.json then describes the run too.
        const runBefore = !!from && runPrompts > 0 && !!firstEngineCall && firstEngineCall < from;
        const reportMode = modes.at(-1)?.v;
        const reportModel = modelNotes.at(-1)?.v;
        const differs =
          runBefore && (modes.some((m) => m.ts < cut && m.v !== reportMode) || modelNotes.some((m) => m.ts < cut && m.v !== reportModel));
        if (isReport && runBefore) s.mixedSessions++;
        if (isReport && runBefore && !differs) addFacts(s, facts);
        const mixed = isReport && differs;
        if (mixed) {
          addSession(s, facts, true);
          const run = newFacts();
          for (const m of modelNotes) if (m.ts < cut) note(run.models, m.v);
          for (const m of modes) if (m.ts < cut) note(run.agents, agentName(m.v));
          addFacts(s, run);
          s.notes.push(`One Kiro session held the run and then this report (from ${new Date(Date.parse(cut)).toISOString()}): the run's model and agent are read from its messages before that time; its effort and autopilot setting are not known.`);
        } else addSession(s, facts, isReport);
      }
    }
  }
  if (s.sessions === 0) return null;
  // Which surface: Kiro CLI v3 keeps the session's input history in ~/.kiro/sessions/cli/<id>.history; Kiro IDE does
  // not (measured 2026-10-18 on CLI 2.32.0 and IDE 1.3.11). The store itself is shared, and the AI-DLC row `kiro-ide`
  // serves both, so neither tells the surface.
  const cliIds = [...sessionIds].filter((id) => existsSync(join(root, "cli", `${id}.history`)));
  const ideCount = sessionIds.size - cliIds.length;
  s.tool = cliIds.length && ideCount ? "kiro (v3: Kiro CLI + Kiro IDE)" : cliIds.length ? "kiro (v3: Kiro CLI)" : "kiro (v3: Kiro IDE)";
  s.notes.push(`Kiro surface per session: ${cliIds.length} Kiro CLI, ${ideCount} Kiro IDE (told apart by the input history Kiro CLI keeps per session in the cli folder of its sessions folder).`);
  // Model and effort per dispatched agent from the engine log.
  const logs = join(homedir(), ".kiro", "logs");
  for (const run of existsSync(logs) ? readdirSync(logs) : []) {
    const file = join(logs, run, "kiro.log");
    if (!existsSync(file) || statSync(file).mtimeMs < since) continue;
    for (const l of readLines<KiroLogLine>(file)) {
      const message = l.message;
      if (l.conversationId === undefined || !sessionIds.has(l.conversationId)) continue;
      if (typeof message !== "string" || !message.startsWith("invoke_subagent.starting")) continue;
      try {
        const j = JSON.parse(message.slice(message.indexOf("{"))) as SubagentStart;
        if (typeof j.subagentId !== "string") continue;
        const a = subagent(s, agentName(j.subagentId));
        if (typeof j.modelId === "string") bump(a.models, `${j.modelId}${j.modelOverride ? OWN : ""}`);
        if (typeof j.effortLevel === "string") bump(a.efforts, `${j.effortLevel}${j.effortOverride ? OWN : ""}`);
      } catch {
        // line shape changed
      }
    }
  }
  finishRepeats(s, calls);
  s.notes.push("Kiro records hook runs by name only; the text of a hook refusal is not in Kiro's session store.");
  s.notes.push("Kiro writes no client version into its session store (measured 2026-10-22, CLI 2.33.1): its version is the one measured at collection time.");
  return s;
}

// ---------- Kiro CLI v2 engine ----------
export function kiroV2(project: string, since: number, until: number, local: Local): Summary | null {
  const dir = join(homedir(), ".kiro", "sessions", "cli");
  if (!existsSync(dir)) return null;
  const s = empty("kiro-cli (v2)");
  s.engine = "v2";
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    // A session last written before the window holds nothing in it: its meta is not read.
    try {
      if (statSync(join(dir, f.replace(/\.json$/, ".jsonl"))).mtimeMs < since && statSync(join(dir, f)).mtimeMs < since) continue;
    } catch {
      // no .jsonl beside it: read the meta as before
    }
    let meta: KiroV2Meta;
    try {
      meta = readJson<KiroV2Meta>(join(dir, f));
    } catch {
      continue;
    }
    if (!within(project, meta.cwd)) continue;
    const lines = readLines<KiroV2Line>(join(dir, f.replace(/\.json$/, ".jsonl")));
    let used = false;
    let isReport = false;
    let reportFromPrompt: number | null = null;
    let lastTyped: Prompt | null = null;
    // An engine call before the report began: the session held the run too.
    let ranBefore = false;
    const firstPrompt = local.prompts.length;
    for (const l of lines) {
      const ts: string | undefined = l.data?.meta?.timestamp ?? l.data?.timestamp ?? meta.updated_at;
      if (!inWindow(ts, since, until)) continue;
      used = true;
      touch(s, ts);
      if (l.kind === "Prompt") {
        s.prompts++;
        lastTyped = { tool: s.tool, ts, text: JSON.stringify(l.data?.content ?? "").slice(0, 2000), engineAfter: false };
        local.prompts.push(lastTyped);
      } else if (l.kind === "AssistantMessage") {
        const content = l.data?.content;
        // v2 lines share the session's time: an engine call is the reply's when it comes after it in the file.
        if (ENGINE_CALL.test(JSON.stringify(content ?? ""))) {
          if (lastTyped) lastTyped.engineAfter = true;
          if (!isReport) ranBefore = true;
        }
        const parts = Array.isArray(content) ? (content as ({ kind?: string; toolUse?: unknown } | null)[]) : [];
        for (const c of parts) if (c?.kind === "toolUse" || c?.toolUse) s.toolCalls++;
        // v2 lines share the session's time, so the report starts at the reply before the first call of
        // this skill's scripts, counted in order.
        if (!isReport && REPORT_RUN.test(JSON.stringify(content ?? ""))) {
          isReport = true;
          reportFromPrompt = Math.max(firstPrompt, local.prompts.length - 1);
        }
      } else if (l.kind === "ToolResults") {
        for (const r of Object.values(l.data?.results ?? {})) {
          const text = JSON.stringify(r?.result ?? "");
          // Kiro v2 wraps each result as `{"Success": …}` or `{"Error": …}`; the word inside file text is not one.
          const res = r?.result;
          const isError = !!res && typeof res === "object" && "Error" in res;
          if (isError) s.toolErrors++;
          noteText(s, local, ts, text, isError);
        }
      }
    }
    if (reportFromPrompt !== null) for (const p of local.prompts.slice(reportFromPrompt)) p.report = true;
    if (used) {
      s.sessions++;
      const facts = newFacts();
      note(facts.models, meta.session_state?.rts_model_state?.model_info?.model_id);
      if (typeof meta.session_state?.agent_name === "string") note(facts.agents, agentName(meta.session_state.agent_name));
      addSession(s, facts, isReport);
      // One session held the run and then the report: the run's facts are the session's.
      if (isReport && ranBefore) {
        s.mixedSessions++;
        addFacts(s, facts);
      }
    }
  }
  if (s.sessions) s.notes.push("Kiro CLI v2 logs hold no commands: AI-DLC commands, repeated calls and checks run by hand are not known.");
  return s.sessions ? s : null;
}

// ---------- GitHub Copilot CLI (documented layout; not measured here) ----------
export function copilotCli(project: string, since: number, until: number, local: Local): Summary | null {
  const root = join(homedir(), ".copilot", "session-state");
  if (!existsSync(root)) return null;
  const s = empty("copilot-cli");
  for (const id of readdirSync(root)) {
    const ws = join(root, id, "workspace.yaml");
    if (!existsSync(ws)) continue;
    const cwd = readFileSync(ws, "utf8").match(/^cwd:\s*["']?(.+?)["']?\s*$/m)?.[1];
    if (!within(project, cwd)) continue;
    let used = false;
    let isReport = false;
    let lastPrompt: string | null = null;
    let reportFrom: string | null = null;
    let lastTyped: Prompt | null = null;
    let ranBefore = false;
    const firstPrompt = local.prompts.length;
    for (const e of readLines<CopilotEvent>(join(root, id, "events.jsonl"))) {
      if (!inWindow(e.timestamp, since, until)) continue;
      used = true;
      touch(s, e.timestamp);
      if (e.type === "user.message") {
        s.prompts++;
        lastTyped = { tool: s.tool, ts: e.timestamp, text: String(e.data?.content ?? "").slice(0, 2000), engineAfter: false };
        local.prompts.push(lastTyped);
        if (!reportFrom) lastPrompt = e.timestamp;
      } else if (e.type === "tool.execution_start") {
        s.toolCalls++;
        const args = JSON.stringify(e.data?.arguments ?? "");
        noteCommand(s, args);
        if (ENGINE_CALL.test(args)) {
          if (lastTyped) lastTyped.engineAfter = true;
          if (!isReport) ranBefore = true;
        }
        if (REPORT_RUN.test(args)) {
          isReport = true;
          if (!reportFrom) reportFrom = lastPrompt ?? e.timestamp;
        }
      } else if (e.type === "tool.execution_complete" && e.data?.success === false) {
        s.toolErrors++;
        noteText(s, local, e.timestamp, JSON.stringify(e.data ?? ""), true);
      }
    }
    markReport(local.prompts.slice(firstPrompt), reportFrom, () => true);
    if (used) {
      s.sessions++;
      addSession(s, newFacts(), isReport);
      if (isReport && ranBefore) s.mixedSessions++;
    }
  }
  if (!s.sessions) return null;
  s.notes.push("Copilot CLI fields are from public docs, not measured; hook refusals may be missed.");
  return s;
}

// VS Code Copilot Chat and Cursor keep chats in workspaceStorage (SQLite or
// patched JSON). This version only says whether they exist.
export function editorStores(project: string): string[] {
  const found: string[] = [];
  const appData = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32"
    ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : join(homedir(), ".config");
  for (const app of ["Code", "Cursor"]) {
    const ws = join(appData, app, "User", "workspaceStorage");
    if (!existsSync(ws)) continue;
    for (const h of readdirSync(ws)) {
      try {
        const j = readJson<{ folder?: unknown }>(join(ws, h, "workspace.json"));
        const folder = decodeURIComponent(String(j.folder ?? "").replace(/^file:\/\//, ""));
        if (within(project, folder.replace(/^\/([A-Za-z]:)/, "$1"))) found.push(`${app === "Code" ? "VS Code" : "Cursor"} chat store (not read by this version)`);
      } catch {
        // no workspace.json
      }
    }
  }
  return [...new Set(found)];
}
