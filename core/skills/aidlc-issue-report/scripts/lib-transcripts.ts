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
  // The log gave this reply no time of its own (Kiro CLI v2): `ts` is its session's last write, so it cannot be
  // matched to AI-DLC's record by time.
  noTime?: boolean;
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
function noteCheck(t: Tally, pending: Map<string, { ts: string; check: string }>, id: unknown, text: string) {
  const c = typeof id === "string" ? pending.get(id) : undefined;
  if (!c) return;
  pending.delete(id as string);
  const pass = checkPass(text);
  t.add(c.ts, (s) => s.handRunChecks.push({ ts: c.ts, check: c.check, pass }));
}

function bump(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

function subagent(s: Summary, name: string) {
  s.subagents[name] ??= { dispatches: 0, models: {}, efforts: {} };
  return s.subagents[name];
}
// A blocking hook as the host shows it: its configured command in brackets, the `aidlc` command's (`hook <name>`)
// or a copied tree's `aidlc.ts` with the same words, also a harness adapter's (`adapter <harness> <route>`) and a
// quoted Windows path to `aidlc.exe`.
// The command may go on after the name (an agent argument, `--project-dir …`, PowerShell's `; exit $LASTEXITCODE`), Bun
// may be given `--` before the words, and Cursor's adapter may take no route (`adapter cursor`). A copied tree may run
// its adapter script itself (`aidlc-copilot-adapter.ts <route>`, `aidlc-cursor-adapter.ts <event>`).
const HOOK_BLOCK =
  /\[[^\]\n]{0,300}?\b(?:aidlc(?:\.ts|\.exe|\.cmd)?(?:\\?["'])?\s+(?:--\s+)?engine\s+(?:hook\s+(?<hook>[a-z0-9-]+)|adapter\s+(?<harness>[a-z-]+)(?:\s+(?<route>[a-z][a-z0-9-]*))?)|aidlc-(?<script>copilot|cursor|codex|kiro)-adapter\.ts(?:\\?["'])?\s+(?<scriptRoute>[a-z][a-z0-9-]*))\b[^\]\n]{0,200}\]/gi;
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

function noteCommand(t: Tally, ts: string, text: string) {
  const m = text.match(AIDLC_CMD);
  if (!m) return;
  // `aidlc-orchestrate next` and `aidlc orchestrate next` are the same call.
  const words = m[1] ? [m[1], m[2], m[3]] : [m[2], m[3]];
  const kept = [words[0], words[1] && SUBVERBS.has(words[1].toLowerCase()) ? words[1] : null, words[2] && SUBVERBS.has(words[2].toLowerCase()) ? words[2] : null];
  const verb = ["aidlc", ...kept.filter(Boolean)].join(" ").toLowerCase();
  if (!/^aidlc [a-z]/.test(verb)) return;
  t.add(ts, (s) => bump(s.aidlcCommands, verb.slice(0, 60)));
}

function noteText(t: Tally, tool: string, local: Local, ts: string, text: string, isError: boolean) {
  let blocked = false;
  for (const m of text.matchAll(HOOK_BLOCK)) {
    // A hook's or a route's name; Cursor's adapter takes its host's event names (`guards`, `stop`), so its blocks are
    // all `cursor-adapter`, native or copied.
    const g = Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, v?.toLowerCase()]));
    const harness = g.harness ?? g.script;
    const hook = harness === "cursor" ? "cursor-adapter" : (g.hook ?? g.route ?? g.scriptRoute ?? `${harness}-adapter`);
    t.add(ts, (s) => {
      bump(s.aidlcHookBlocks, hook);
      s.timeline.push({ ts, kind: "aidlc-hook-block", detail: hook });
    });
    blocked = true;
  }
  if (/Stop hook (feedback|error)/.test(text)) {
    t.add(ts, (s) => {
      s.stopFeedback++;
      s.timeline.push({ ts, kind: "stop-hook-feedback", detail: "" });
    });
    blocked = true;
  }
  // The report's own refusals and errors are not the run's evidence either.
  if (blocked) t.add(ts, () => local.refusals.push({ tool, ts, text: text.slice(0, 1500) }));
  else if (isError) t.add(ts, () => local.errors.push({ tool, ts, text: text.slice(0, 600) }));
}

// Same tool with the same input three times or more = a loop worth naming.
type Calls = Map<string, { tool: string | undefined; ts: string[] }>;

// What one session counted, each with its time and its place, applied once the session is read: the part from where
// this report began (its own commands, checks and refusals, a check.ts run three times) stays out of the run's counts.
type Op = (s: Summary, calls: Calls) => void;
class Tally {
  private ops: { ts: string; op: Op }[] = [];
  add(ts: string, op: Op) {
    this.ops.push({ ts, op });
  }
  get size(): number {
    return this.ops.length;
  }
  // What came before the time `from`, or before the `before`-th count; all of it when neither is given.
  commit(s: Summary, calls: Calls, cut: { from?: string | null; before?: number | null } = {}) {
    for (let i = 0; i < this.ops.length; i++) {
      const { ts, op } = this.ops[i];
      if ((cut.from && ts >= cut.from) || (cut.before != null && i >= cut.before)) continue;
      op(s, calls);
    }
  }
}

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

function noteCall(t: Tally, rawTool: string | undefined, input: unknown, ts: string) {
  const tool = toolLabel(rawTool);
  const k = callKey(rawTool, input);
  t.add(ts, (_, calls) => {
    const call = calls.get(k);
    if (call) call.ts.push(ts);
    else calls.set(k, { tool, ts: [ts] });
  });
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
// A path and the one it resolves to through links (`/tmp` is `/private/tmp` on macOS; a project opened through a
// link): a tool logs whichever it was given. Asked once per path.
const realPaths = new Map<string, string>();
function realOf(path: string): string {
  let real = realPaths.get(path);
  if (real === undefined) {
    try {
      real = realpathSync(path);
    } catch {
      real = path; // gone since, or never on this machine
    }
    realPaths.set(path, real);
  }
  return real;
}
function within(project: string, cwd: unknown): boolean {
  if (typeof cwd !== "string" || !cwd) return false;
  // macOS stores a folder name decomposed (NFD); the same name typed is composed.
  const fold = (x: string) => (FOLD_CASE ? x.normalize("NFC").toLowerCase() : x.normalize("NFC"));
  const inside = (a: string, p: string) => a === p || a.startsWith(`${p}/`) || a.startsWith(`${p}\\`);
  const as = [resolve(cwd), realOf(resolve(cwd))].map(fold);
  const ps = [resolve(project), realOf(resolve(project))].map(fold);
  return as.some((a) => ps.some((p) => inside(a, p)));
}

// Text the tool put where the person's words go: nothing but tagged blocks, each closed by its own tag, whose names
// carry a dash or an underscore as the tools' own do (`<system-reminder>`, Codex's `<environment_context>`). A reply
// the person typed can start with `<` too (`<div> is not shown`, `<b>approve</b>`). Read block by block: one pattern
// over all the blocks backtracks for minutes on a line of many.
const BLOCK_OPEN = /^<([a-z][a-z0-9]*[-_][\w-]*)\b[^>]*>/i;
function injectedBlock(text: string): boolean {
  let rest = text.trim();
  if (!rest) return false;
  while (rest) {
    const open = rest.match(BLOCK_OPEN);
    if (!open) return false;
    const close = rest.indexOf(`</${open[1]}>`, open[0].length);
    if (close < 0) return false;
    rest = rest.slice(close + open[1].length + 3).trimStart();
  }
  return true;
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
  // decomposed (NFD), which has more of them, and a project opened through a link under the path it resolves to.
  const paths = [resolve(project), realOf(resolve(project))];
  const keys = [...new Set(paths.flatMap((path) => ["NFC", "NFD"].map((f) => path.normalize(f).replace(/[^A-Za-z0-9]/g, "-"))))];
  const s = empty("claude-code");
  const calls: Calls = new Map();
  const sessions = new Map<string, TimedFact[]>();
  const firstEngine = new Map<string, string>();
  const lastPrompt = new Map<string, string>();
  const lastTyped = new Map<string, Prompt>();
  const reportFrom = new Map<string, string>();
  const checks = new Map<string, { ts: string; check: string }>();
  const tallies = new Map<string, Tally>();
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
        const t = tallies.get(id) ?? new Tally();
        tallies.set(id, t);
        log.push({ ts, key: "toolVersions", value: r.version });
        if (!r.isSidechain) {
          if (r.type === "assistant") {
            log.push({ ts, key: "models", value: r.message?.model }, { ts, key: "efforts", value: r.effort });
          }
          if (r.type === "user") log.push({ ts, key: "approvalModes", value: r.permissionMode });
        }
        touch(s, ts);
        if (r.toolDenialKind) {
          const kind = String(r.toolDenialKind);
          t.add(ts, (x) => {
            bump(x.denials, kind);
            x.timeline.push({ ts, kind: "tool-denied", detail: kind });
          });
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
          // A slash command the person typed is logged as `<command-name>/x</command-name>…`; other tagged
          // blocks are injected context.
          const command = text.match(/<command-name>([^<]{1,200})<\/command-name>(?:[\s\S]*?<command-args>([^<]{0,2000})<\/command-args>)?/);
          const typed = command ? `${command[1]} ${command[2] ?? ""}`.trim() : text;
          if (typed.trim() && (command || !injectedBlock(text)) && !text.startsWith("[Request interrupted by user")) {
            t.add(ts, (x) => x.prompts++);
            const prompt: Prompt = { tool: s.tool, ts, text: typed.slice(0, 2000), session: id, engineAfter: false };
            local.prompts.push(prompt);
            lastTyped.set(id, prompt);
            if (!reportFrom.has(id)) lastPrompt.set(id, ts);
          }
        }
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "tool_use") {
              t.add(ts, (x) => x.toolCalls++);
              if (c.name === "AskUserQuestion") t.add(ts, (x) => x.questionsAsked++);
              noteCall(t, c.name, c.input, ts);
              if (typeof c.input?.command === "string") {
                noteCommand(t, ts, c.input.command);
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
              noteCheck(t, checks, c.tool_use_id, text);
              if (c.is_error) t.add(ts, (x) => x.toolErrors++);
              noteText(t, s.tool, local, ts, text, !!c.is_error);
            }
          }
        }
        if (r.type === "system" && r.subtype === "stop_hook_summary" && r.preventedContinuation) {
          t.add(ts, (x) => x.stopFeedback++);
        }
      }
    }
  }
  if (sessions.size === 0) return null;
  for (const [id, from] of reportFrom) markReport(local.prompts, from, (p) => p.tool === s.tool && p.session === id);
  s.sessions = sessions.size;
  for (const [id, log] of sessions) addTimedSession(s, log, reportFrom.get(id), firstEngine.get(id));
  for (const [id, t] of tallies) t.commit(s, calls, { from: reportFrom.get(id) });
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
  // A forked session's file may begin with its parent's history: a call or output already read is not counted again.
  const seen = new Set<string>();
  let inheritedSessions = 0;
  // Where the report began in each session, so a subagent or approval review it started is cut at the same time.
  const reportStart = new Map<string, string>();
  // In time order (the file names carry the start time), so a parent is read before the sessions it started.
  for (const file of recentFiles(root, ".jsonl", since, 4).sort()) {
    // A rollout starts with its session_meta: another project's file is dropped before it is read whole.
    if (!within(project, firstLine<CodexLine>(file)?.payload?.cwd)) continue;
    const lines = readLines<CodexLine>(file);
    const meta = lines.find((l) => l.type === "session_meta");
    if (!meta || !within(project, meta.payload?.cwd)) continue;
    // Only a session the person opened holds their replies. A subagent and Codex's automatic approval review
    // (`thread_source: "guardian_review"`) write their own user lines and carry a parent thread. A fork, the person's
    // own included, starts with a copy of the history it was forked from: those lines, from before its start, are skipped.
    const ts0 = meta.payload?.thread_source;
    const inherited = (ts0 !== undefined && ts0 !== "user") || !!meta.payload?.parent_thread_id;
    const forked = inherited || !!meta.payload?.forked_from_id;
    // A fork with no start time: its copied lines cannot be told from its own, so its replies are not counted.
    const copiedReplies = inherited || (forked && Number.isNaN(Date.parse(meta.timestamp ?? "")));
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
    const t = new Tally();
    const started = Date.parse(meta.timestamp ?? "");
    for (const l of lines) {
      if (!inWindow(l.timestamp, since, until)) continue;
      const ts = l.timestamp;
      const p: CodexPayload = l.payload ?? {};
      // A forked session's lines from before its own start are its parent's history, read with the parent or left
      // out with it.
      if (forked && Date.parse(ts) < started) continue;
      used = true;
      touch(s, ts);
      // A subagent's or reviewer's session runs its own model: only the person's own sessions count here.
      if (l.type === "turn_context") turnStart = ts;
      if (l.type === "turn_context" && !inherited) {
        log.push({ ts, key: "models", value: p.model }, { ts, key: "efforts", value: p.effort }, { ts, key: "approvalModes", value: p.approval_policy });
      }
      if (l.type === "response_item" && p.type === "message" && p.role === "user") {
        const text = (p.content ?? []).map((c) => c?.text ?? "").join("\n");
        const injected = injectedBlock(text) || text.trimStart().startsWith("# AGENTS.md instructions");
        // Codex hands a Stop hook's block back as a user line `<hook_prompt hook_run_id="stop:…">reason</hook_prompt>`
        // (shown to the person as "Blocked by hook"), dozens of them in one turn when a hook loops.
        const stopBlock = text.match(/^\s*<hook_prompt hook_run_id="stop:[^"]*">([\s\S]*?)<\/hook_prompt>/);
        if (stopBlock && !copiedReplies) {
          const reason = stopBlock[1].slice(0, 1500);
          t.add(ts, (x) => {
            x.stopFeedback++;
            x.timeline.push({ ts, kind: "stop-hook-feedback", detail: "" });
            local.refusals.push({ tool: x.tool, ts, text: reason });
          });
        }
        if (text.trim() && !injected) {
          // A subagent's or reviewer's task message is the agent's, not a reply the person typed.
          if (!copiedReplies) t.add(ts, (x) => x.prompts++);
          const turn: string | undefined = p.internal_chat_message_metadata_passthrough?.turn_id;
          const before = turn ? lastInTurn.get(turn) : undefined;
          if (turn) lastInTurn.set(turn, text);
          if (!reportFrom) lastPrompt = turnStart ?? ts;
          lastTyped = {
            tool: s.tool, ts, text: text.slice(0, 2000), inherited: copiedReplies, session: meta.payload?.id, engineAfter: false,
            ...(turn ? { turn, inRunningTurn: before !== undefined, sameAsBeforeInTurn: before === text } : {}),
          };
          local.prompts.push(lastTyped);
        }
      } else if (l.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
        const copied = !!p.call_id && seen.has(`call ${p.call_id}`);
        if (p.call_id) seen.add(`call ${p.call_id}`);
        const input = p.arguments ?? p.input ?? "";
        const inputText = typeof input === "string" ? input : JSON.stringify(input);
        if (!copied) {
          t.add(ts, (x) => x.toolCalls++);
          noteCall(t, p.name, input, ts);
          noteCommand(t, ts, inputText);
        }
        if (ENGINE_CALL.test(inputText)) {
          firstEngineCall ??= ts;
          if (lastTyped) lastTyped.engineAfter = true;
        }
        if (REPORT_RUN.test(inputText) && !reportFrom) reportFrom = lastPrompt ?? ts;
        const check = checkName(inputText);
        if (check && p.call_id) checks.set(p.call_id, { ts, check });
      } else if (l.type === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
        if (p.call_id && seen.has(`output ${p.call_id}`)) continue;
        if (p.call_id) seen.add(`output ${p.call_id}`);
        const text = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        noteCheck(t, checks, p.call_id, text);
        const exit = text.match(/(?:exit code|exited with code|Exit code:)\s*(\d+)/i);
        const failed = CODEX_CALL_FAILED.test(text);
        const isError = (!!exit && exit[1] !== "0") || failed;
        if (isError) t.add(ts, (x) => x.toolErrors++);
        if (failed && CODEX_REVIEW_REJECTED.test(text)) {
          t.add(ts, (x) => {
            bump(x.denials, "policy-denied");
            x.timeline.push({ ts, kind: "tool-denied", detail: "policy-denied" });
          });
        }
        noteText(t, s.tool, local, ts, text, isError);
      }
    }
    markReport(local.prompts.slice(firstPrompt), reportFrom, () => true);
    const parent = meta.payload?.parent_thread_id ?? meta.payload?.forked_from_id;
    const from = reportFrom ?? (inherited && parent ? reportStart.get(parent) : undefined) ?? null;
    if (meta.payload?.id && from) reportStart.set(meta.payload.id, from);
    t.commit(s, calls, { from });
    if (used && inherited) inheritedSessions++;
    else if (used) {
      s.sessions++;
      addTimedSession(s, log, reportFrom ?? undefined, firstEngineCall);
    }
  }
  // Subagent and review sessions alone (the person's own session older than the window) are not a run in it.
  if (s.sessions === 0) return null;
  finishRepeats(s, calls);
  if (inheritedSessions) {
    s.notes.push(`${inheritedSessions} Codex subagent or approval-review session(s): their tool calls are counted with the run; they are not counted as sessions, and their task messages not as replies.`);
  }
  s.notes.push("Codex hook blocks: Stop hook blocks are counted from the hook prompt lines Codex writes for a Stop hook run (measured 10-18, Codex 0.162); other hooks' blocks come from refusal text only.");
  return s;
}

// ---------- Kiro CLI v3 and Kiro IDE 1.x (shared store) ----------
// A failed tool result; the agent profile's own refusal says `Rule: deny` (Kiro CLI v3 also `Blocked by a
// permission rule (deny …)`, docs/guide/15-troubleshooting.md).
function kiroFailure(t: Tally, tool: string, local: Local, ts: string, text: string) {
  t.add(ts, (s) => s.toolErrors++);
  if (/Rule: deny|Blocked by a permission rule \(deny\b/.test(text)) {
    t.add(ts, (s) => {
      bump(s.denials, "agent-profile-deny");
      s.timeline.push({ ts, kind: "tool-denied", detail: "agent-profile-deny" });
    });
  }
  noteText(t, tool, local, ts, text, true);
}

export function kiroV3(project: string, since: number, until: number, local: Local): Summary | null {
  const root = join(homedir(), ".kiro", "sessions");
  if (!existsSync(root)) return null;
  const ws16 = createHash("sha256").update(resolve(project)).digest("hex").slice(0, 16);
  const s = empty("kiro (v3)");
  s.engine = "v3";
  const calls: Calls = new Map();
  const sessionIds = new Set<string>();
  // Kiro names a workspace's folder after a hash of its path. The project's own hash is one; a folder under the
  // project, or the same path spelled another way (Windows path strings may hash differently), has its own, so each
  // other folder is told by the workspace its first readable session.json names (one folder, one workspace).
  const wsDirs: string[] = [];
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // gone while listed
    }
    if (d === "cli" || !isDir) continue;
    if (d === ws16) {
      wsDirs.push(dir);
      continue;
    }
    let sessions: string[] = [];
    try {
      sessions = readdirSync(dir).filter((x) => x.startsWith("sess_"));
    } catch {
      // unreadable or gone while listed
    }
    for (const sess of sessions) {
      let j: KiroSession;
      try {
        j = readJson<KiroSession>(join(dir, sess, "session.json"));
      } catch {
        continue; // not a session folder, or mid-write
      }
      // A session.json that names no workspace (an older build, a write cut short) says nothing: the next one is read.
      const paths = j && Array.isArray(j.workspacePaths) ? j.workspacePaths : [];
      if (!paths.length) continue;
      if (paths.some((w) => within(project, w))) wsDirs.push(dir);
      break;
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
      const t = new Tally();
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
              t.add(ts, (x) => x.prompts++);
              local.prompts.push({ tool: s.tool, ts, text: text.slice(0, 2000) });
            }
          } else if (p.type === "tool_call") {
            t.add(ts, (x) => x.toolCalls++);
            noteCall(t, p.toolName, p.args, ts);
            const cmd = p.args?.command ?? p.args?.cmd;
            if (typeof cmd === "string") {
              noteCommand(t, ts, cmd);
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
            noteCheck(t, checks, p.toolCallId, text);
            if (p.success === false) kiroFailure(t, s.tool, local, ts, text);
          } else if (p.type === "tool_result" && p.success === false) {
            kiroFailure(t, s.tool, local, ts, typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? ""));
          } else if (p.type === "pending_interaction" && p.interactionType === "tool_approval") {
            t.add(ts, (x) => {
              x.approvalPrompts++;
              x.timeline.push({ ts, kind: "approval-prompt", detail: "" });
            });
          } else if (p.type === "sub_agent_start" && p.subAgentName) {
            const name = agentName(p.subAgentName);
            t.add(ts, (x) => subagent(x, name).dispatches++);
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
        t.commit(s, calls, { from });
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
  let timeless = false;
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
    // v2 lines share the session's time, so the report's part is cut by place: from the last reply before the first
    // call of this skill's scripts.
    const t = new Tally();
    let lastPromptAt: number | null = null;
    let reportAt: number | null = null;
    for (const l of lines) {
      const own: string | undefined = l.data?.meta?.timestamp ?? l.data?.timestamp;
      const ts: string | undefined = own ?? meta.updated_at;
      if (!inWindow(ts, since, until)) continue;
      if (!own) timeless = true;
      used = true;
      touch(s, ts);
      if (l.kind === "Prompt") {
        lastPromptAt = t.size;
        t.add(ts, (x) => x.prompts++);
        lastTyped = {
          tool: s.tool, ts, text: JSON.stringify(l.data?.content ?? "").slice(0, 2000), engineAfter: false, ...(own ? {} : { noTime: true }),
        };
        local.prompts.push(lastTyped);
      } else if (l.kind === "AssistantMessage") {
        const content = l.data?.content;
        // v2 lines share the session's time: an engine call is the reply's when it comes after it in the file.
        if (ENGINE_CALL.test(JSON.stringify(content ?? ""))) {
          if (lastTyped) lastTyped.engineAfter = true;
          if (!isReport) ranBefore = true;
        }
        // v2 lines share the session's time, so the report starts at the reply before the first call of
        // this skill's scripts, counted in order (with no reply before it, at this message, before its calls count).
        if (!isReport && REPORT_RUN.test(JSON.stringify(content ?? ""))) {
          isReport = true;
          reportFromPrompt = Math.max(firstPrompt, local.prompts.length - 1);
          reportAt = lastPromptAt ?? t.size;
        }
        const parts = Array.isArray(content) ? (content as ({ kind?: string; toolUse?: unknown } | null)[]) : [];
        for (const c of parts) if (c?.kind === "toolUse" || c?.toolUse) t.add(ts, (x) => x.toolCalls++);
      } else if (l.kind === "ToolResults") {
        for (const r of Object.values(l.data?.results ?? {})) {
          const text = JSON.stringify(r?.result ?? "");
          // Kiro v2 wraps each result as `{"Success": …}` or `{"Error": …}`; the word inside file text is not one.
          const res = r?.result;
          const isError = !!res && typeof res === "object" && "Error" in res;
          if (isError) t.add(ts, (x) => x.toolErrors++);
          noteText(t, s.tool, local, ts, text, isError);
        }
      }
    }
    if (reportFromPrompt !== null) for (const p of local.prompts.slice(reportFromPrompt)) p.report = true;
    t.commit(s, new Map(), { before: reportAt });
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
  if (s.sessions && timeless) {
    s.notes.push("Kiro CLI v2 lines carry no time of their own: a session last written in the window is read whole, its lines take that last time, and its replies are not matched to AI-DLC's record.");
  }
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
    const t = new Tally();
    for (const e of readLines<CopilotEvent>(join(root, id, "events.jsonl"))) {
      if (!inWindow(e.timestamp, since, until)) continue;
      used = true;
      touch(s, e.timestamp);
      if (e.type === "user.message") {
        t.add(e.timestamp, (x) => x.prompts++);
        lastTyped = { tool: s.tool, ts: e.timestamp, text: String(e.data?.content ?? "").slice(0, 2000), engineAfter: false };
        local.prompts.push(lastTyped);
        if (!reportFrom) lastPrompt = e.timestamp;
      } else if (e.type === "tool.execution_start") {
        t.add(e.timestamp, (x) => x.toolCalls++);
        const args = JSON.stringify(e.data?.arguments ?? "");
        noteCommand(t, e.timestamp, args);
        if (ENGINE_CALL.test(args)) {
          if (lastTyped) lastTyped.engineAfter = true;
          if (!isReport) ranBefore = true;
        }
        if (REPORT_RUN.test(args)) {
          isReport = true;
          if (!reportFrom) reportFrom = lastPrompt ?? e.timestamp;
        }
      } else if (e.type === "tool.execution_complete" && e.data?.success === false) {
        t.add(e.timestamp, (x) => x.toolErrors++);
        noteText(t, s.tool, local, e.timestamp, JSON.stringify(e.data ?? ""), true);
      }
    }
    markReport(local.prompts.slice(firstPrompt), reportFrom, () => true);
    t.commit(s, new Map(), { from: reportFrom });
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
