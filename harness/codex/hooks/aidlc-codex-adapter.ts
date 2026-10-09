#!/usr/bin/env bun
// aidlc-codex-adapter.ts — the Codex CLI hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). Modeled on kiro's aidlc-kiro-adapter.ts: ONE shim
// normalizes the harness payload to the ClaudeCodeHookInput shape and
// subprocess-pipes into the named core hook, forwarding stdout/exit code.
//
// Codex payloads are near-isomorphic to Claude Code's (live corpus,
// tmp/codex-dist/payload-corpus/ in the framework repo) with five
// load-bearing differences:
//   1. Edits arrive as tool_name "apply_patch" with the file paths INSIDE
//      the patch envelope text (tool_input.command) — no file_path field.
//      The shim parses `*** Add|Update File:` lines and fans out one core
//      invocation per file (Add → Write, Update → Edit; Delete skipped —
//      the Claude harness never routes deletes through these hooks either).
//   2. The plan tool is update_plan ({plan:[{step,status}]}), not
//      TaskUpdate — the shim maps the in_progress step to the
//      {status, activeForm} shape the statusline-sync hook keys on.
//   3. Every event is delivered TWICE (×2 duplication observed across the
//      whole corpus). The shim is idempotent by REPLAY: the first delivery
//      runs the core hook and caches {stdout, exit}; the duplicate replays
//      the identical response (never swallowed — we must answer duplicates
//      exactly like originals because Codex's combine rule is unspecified).
//   4. There is no SessionEnd event (D-4): the session-start target
//      reconciles — when the heartbeat file names a DIFFERENT prior
//      session, it pipes an inferred-provenance reason into the core
//      session-end hook (back-dating conveyed via the recorded fields),
//      then records the new session. Rapid exec sessions each reconcile
//      their predecessor — correct, since none of them can emit an end.
//   5. UserPromptSubmit also fires inside subagents, carrying the agent's
//      brief as `prompt` under the root session id. Spawned subagents carry
//      agent_id; internal reviewers carry a transcript_path naming their own
//      thread. record-human-turn never counts either as the person's turn
//      (#1411).
//
// Output contracts:
//   - session-start: the core hook prints
//     {"additionalContext": "..."}; Codex expects the hookSpecificOutput
//     wrapper (verified live, findings E1) — the shim re-wraps.
//   - continue-workflow: {"decision":"block","reason"} passes through VERBATIM — the
//     contract is identical on Codex (stop_hook_active included).
//   - everything else: advisory; stdout ignored, exit 0.
//
// Usage (wired in .codex/hooks.json):
//   bun .codex/hooks/aidlc-codex-adapter.ts <target>
// where <target> ∈ session-start | audit-and-sensors | sync-workflow-state |
//                  rebuild-stage-graph | validate-state | log-subagent | continue-workflow |
//                  record-human-turn | state-transition-guard | reviewer-scope |
//                  review-freeze | deliver-stage-rules | plan-approval-guard |
//                  guard-tool-call
// guard-tool-call is the one PreToolUse registration: it runs the four guards
// in this process, and those guards run their core hook in this process too
// (runCoreHere), so a shell call costs one engine load, not nine (#2066). No
// member rewrites the command: Codex gives every command it runs the session
// as CODEX_THREAD_ID (0.145.0 and later) and the tools read it from there, so
// the words the agent wrote are what runs and what the shipped
// rules/default.rules prefixes match.

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  emptyPickerResult,
  isNonAnswer,
  noteHelperSession,
  sessionsDir,
  stateFilePath,
  validSessionId,
} from "../tools/aidlc-lib.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface CodexHookInput {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  transcript_path?: string | null;
  agent_type?: string;
  agent_id?: string;
  stop_hook_active?: boolean;
  prompt?: string;
  user_prompt?: string;
  message?: string;
}

interface CodexSpawnAgentInput {
  agent_type?: unknown;
  message?: unknown;
  items?: unknown;
}

function spawnAgentPrompt(input: CodexSpawnAgentInput): string {
  const parts: string[] = [];
  if (typeof input.message === "string") parts.push(input.message);
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (item !== null && typeof item === "object") {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

function offeredOptionLabels(toolInput: unknown): Map<string, Set<string>> {
  const offered = new Map<string, Set<string>>();
  if (toolInput === null || typeof toolInput !== "object") return offered;
  const questions = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return offered;
  for (const question of questions) {
    if (question === null || typeof question !== "object") continue;
    const record = question as Record<string, unknown>;
    if (typeof record.id !== "string" || !Array.isArray(record.options)) continue;
    const labels = new Set<string>();
    for (const option of record.options) {
      if (typeof option === "string") labels.add(option.trim());
      else if (option !== null && typeof option === "object") {
        const candidate = option as Record<string, unknown>;
        for (const key of ["label", "value", "text"] as const) {
          if (typeof candidate[key] === "string") labels.add(candidate[key].trim());
        }
      }
    }
    offered.set(record.id, labels);
  }
  return offered;
}

export function hasExplicitHumanSelection(toolResponse: unknown, toolInput?: unknown): boolean {
  if (typeof toolResponse !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolResponse);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const response = parsed as Record<string, unknown>;
  if (Object.keys(response).length !== 1 || !("answers" in response)) return false;
  const answers = response.answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return false;
  const selections = Object.entries(answers as Record<string, unknown>);
  if (selections.length === 0) return false;
  const offered = offeredOptionLabels(toolInput);
  return selections.every(([questionId, selection]) => {
    if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return false;
    const record = selection as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !Array.isArray(record.answers)) return false;
    return record.answers.length > 0 && record.answers.every((answer) => {
      if (typeof answer !== "string" || answer.trim().length === 0) return false;
      return !isNonAnswer(answer) || offered.get(questionId)?.has(answer.trim()) === true;
    });
  });
}

// True when transcript_path is a Codex rollout file for a thread other than
// the session's root thread (whose id is the session id).
function otherThreadInput(transcriptPath: unknown, sessionId: unknown): boolean {
  if (typeof transcriptPath !== "string" || typeof sessionId !== "string" || !sessionId) return false;
  const name = transcriptPath.split(/[\\/]/).pop() ?? "";
  const thread = name.match(
    /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl(?:\.[a-z0-9]+)?$/i,
  )?.[1];
  return thread !== undefined && thread.toLowerCase() !== sessionId.trim().toLowerCase();
}

function explicitHumanSelectionText(toolResponse: unknown): string {
  if (typeof toolResponse !== "string") return "";
  try {
    const parsed = JSON.parse(toolResponse) as {
      answers?: Record<string, { answers?: unknown[] }>;
    };
    for (const selection of Object.values(parsed.answers ?? {})) {
      for (const answer of selection.answers ?? []) {
        if (typeof answer === "string" && answer.trim()) return answer.trim();
      }
    }
  } catch {
    // Non-structured prompt payloads use the direct fields below.
  }
  return "";
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
let rawInput = "";
let codex: CodexHookInput = {};
if (!process.stdin.isTTY) {
  try {
    rawInput = input;
    if (rawInput.length > 0) codex = JSON.parse(rawInput) as CodexHookInput;
  } catch {
    return 0; // malformed stdin — advisory hooks fail open
  }
}

const projectDirRaw =
  process.env.AIDLC_PROJECT_DIR ?? codex.cwd ?? process.cwd();
const projectDir = isAbsolute(projectDirRaw)
  ? projectDirRaw
  : resolve(process.cwd(), projectDirRaw);
const payloadSessionId = validSessionId(codex.session_id);
if (payloadSessionId) {
  process.env.AIDLC_SESSION_OVERRIDE = payloadSessionId;
  process.env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
  // A spawned agent's payloads carry agent_id = its own thread id, the one its
  // shell gets as CODEX_THREAD_ID. Note the pair once, from the helper's first
  // event (its brief), so an engine command the helper runs resolves to this
  // chat and not to whatever the shared cursor names (aidlc-lib
  // resolveInvokingSessionId reads it).
  if (typeof codex.agent_id === "string") noteHelperSession(projectDir, payloadSessionId, codex.agent_id);
}
const projectEnv = {
  ...process.env,
  AIDLC_PROJECT_DIR: projectDir,
  CLAUDE_PROJECT_DIR: projectDir,
};

// --- Duplicate-delivery replay cache ---------------------------------------
//
// Key = sha256(target + raw stdin): identical deliveries (same turn, same
// tool_use_id, same content) collide; legitimate re-fires differ (turn_id /
// stop_hook_active / tool_use_id change). First delivery takes the slot via
// atomic mkdir (the audit-lock idiom), runs, and persists its response;
// the duplicate waits briefly for that response and replays it byte-for-byte.
// Entries are pruned after 30 minutes. Failure anywhere → fail open (run or
// allow), never trap the turn.
//
// Compact-source SessionStart is EXEMPT: Codex SessionStart input carries no
// turn_id, so two DISTINCT compactions in one session produce byte-identical
// stdin and would replay the FIRST compaction's (stale) workflow context.
// The compact render is read-only (source=compact emits no audit row), so
// re-running a true duplicate is harmless while replaying a stale one is not.
const bypassReplay = target === "session-start" && codex.source === "compact";

const DEDUPE_ROOT = join(
  tmpdir(),
  `aidlc-codex-dedupe-${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}`,
);
const dedupeKey = createHash("sha256").update(`${target}\n${rawInput}`).digest("hex").slice(0, 32);
const slotDir = join(DEDUPE_ROOT, dedupeKey);
const responseFile = join(slotDir, "response.json");

function pruneStale(): void {
  try {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const entry of readdirSync(DEDUPE_ROOT)) {
      const full = join(DEDUPE_ROOT, entry);
      try {
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
      } catch {
        // racing prune — ignore
      }
    }
  } catch {
    // no dedupe root yet — nothing to prune
  }
}

function replayResponse(): { stdout: string; code: number; stderr?: string } {
  // Duplicate delivery: wait up to ~2s for the first runner's response, then
  // answer identically. If it never lands, fail open silently. stderr rides
  // the cache too so a reviewer-scope BLOCK (stderr + exit 2) replays
  // faithfully on the duplicate, not as a silent allow.
  for (let i = 0; i < 20; i++) {
    try {
      const cached = JSON.parse(readFileSync(responseFile, "utf-8")) as {
        stdout: string;
        code: number;
        stderr?: string;
      };
      return cached;
    } catch {
      Bun.sleepSync(100);
    }
  }
  return { stdout: "", code: 0 };
}

function persistResponse(stdout: string, code: number, stderr?: string): void {
  if (bypassReplay) return;
  try {
    writeFileSync(responseFile, JSON.stringify({ stdout, code, ...(stderr ? { stderr } : {}) }), "utf-8");
  } catch {
    // best-effort — a duplicate will fail open instead of replaying
  }
}

if (!bypassReplay) {
  try {
    mkdirSync(DEDUPE_ROOT, { recursive: true });
    pruneStale();
    mkdirSync(slotDir); // atomic claim — throws EEXIST for the duplicate
  } catch {
    const replay = replayResponse();
    if (replay.stdout) process.stdout.write(replay.stdout);
    if (replay.stderr) process.stderr.write(replay.stderr);
    return replay.code;
  }
}

// --- Core-hook subprocess plumbing ------------------------------------------

function runCore(hookFile: string, input: string): { stdout: string; code: number } {
  // Reuse the exact bun binary running this adapter; the child must not depend on
  // PATH containing bun (the hook environment often lacks the bun install dir).
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const hook = hookFile.replace(/^aidlc-|\.ts$/g, "");
  const authorityToken = hook === "record-human-turn" ? randomUUID() : "";
  const command = executable
    ? authorityToken
      ? [executable, "--internal-aidlc-record-human-turn", join(HOOKS_DIR, hookFile)]
      : [executable, "engine", "hook", hook]
    : authorityToken
      ? [
          process.execPath,
          join(HOOKS_DIR, "..", "tools", "aidlc.ts"),
          "--internal-aidlc-record-human-turn",
          join(HOOKS_DIR, hookFile),
        ]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(input, "utf-8"),
    stdout: "pipe",
    stderr: "ignore",
    cwd: projectDir,
    env: authorityToken
      ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken }
      : projectEnv,
  });
  return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
}

// Variant capturing stderr - the reviewer-scope block channel (exit 2 + the
// reason on stderr) must survive the pipe, unlike the advisory hooks above.
function runCoreWithStderr(
  hookFile: string,
  input: string,
): { stdout: string; stderr: string; code: number } {
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const hook = hookFile.replace(/^aidlc-|\.ts$/g, "");
  const authorityToken = hook === "record-human-turn" ? randomUUID() : "";
  const command = executable
    ? authorityToken
      ? [executable, "--internal-aidlc-record-human-turn", join(HOOKS_DIR, hookFile)]
      : [executable, "engine", "hook", hook]
    : authorityToken
      ? [
          process.execPath,
          join(HOOKS_DIR, "..", "tools", "aidlc.ts"),
          "--internal-aidlc-record-human-turn",
          join(HOOKS_DIR, hookFile),
        ]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(input, "utf-8"),
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectDir,
    env: authorityToken
      ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken }
      : projectEnv,
  });
  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    code: r.exitCode ?? 0,
  };
}

// The core hooks that run on every shell call run INSIDE this process. A child
// `aidlc engine hook` loaded the whole engine a second time for each of them,
// and Codex starts every matching handler at once, so one `ls` cost nine engine
// loads (#2066). The hook module is imported from beside this file (the packaged
// runtime under the compiled engine, the project copy under the Bun channel),
// the project is pinned the way the child saw it, and its run(input) is called
// with stdout and stderr collected as the child's pipes collected them. A hook
// that cannot be imported or exports no run() runs as a child as before.
async function runCoreHere(
  hookFile: string,
  input: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let mod: { run?: unknown };
  try {
    mod = (await import(pathToFileURL(join(HOOKS_DIR, hookFile)).href)) as { run?: unknown };
  } catch {
    return runCoreWithStderr(hookFile, input);
  }
  if (typeof mod.run !== "function") return runCoreWithStderr(hookFile, input);
  const hookRun = mod.run as (input: string) => number | Promise<number>;
  process.env.AIDLC_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  return await collectOutput(() => hookRun(input));
}

// Run one step with its stdout and stderr collected instead of written. A step
// that throws fails alone: code 1 with the error text, as its own crashed
// process would have ended, and never a refusal.
async function collectOutput(
  step: () => number | Promise<number>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const text = (chunk: unknown): string =>
    typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf-8");
  process.stdout.write = ((chunk: unknown) => {
    out.push(text(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err.push(text(chunk));
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await step();
  } catch (error) {
    err.push(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    code = 1;
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  return { stdout: out.join(""), stderr: err.join(""), code };
}

// Re-wrap the core context output ({"additionalContext": ...}) into the
// hookSpecificOutput envelope Codex consumes (verified live for SessionStart).
// CONTRACT WARNING: each Codex event has its OWN output schema — do not reuse
// this envelope for other events without checking the binary's embedded
// <event>.command.output schema. PostCompact in particular allows NO
// hookSpecificOutput and no context channel at all ("this event cannot emit
// additionalContext"); reusing this wrapper there is rejected as invalid
// hook JSON on every compaction.
function wrapContext(coreStdout: string, eventName: string): string {
  try {
    const parsed = JSON.parse(coreStdout) as { additionalContext?: string };
    if (parsed.additionalContext) {
      return `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: parsed.additionalContext,
        },
      })}\n`;
    }
  } catch {
    // unparseable core output — pass through untouched
  }
  return coreStdout;
}

function allowUpdatedInput(coreStdout: string): string {
  try {
    const parsed = JSON.parse(coreStdout) as {
      hookSpecificOutput?: {
        hookEventName?: unknown;
        permissionDecision?: unknown;
        updatedInput?: unknown;
      };
    };
    const output = parsed.hookSpecificOutput;
    if (
      output?.hookEventName === "PreToolUse" &&
      output.updatedInput !== undefined &&
      output.permissionDecision === undefined
    ) {
      output.permissionDecision = "allow";
      return `${JSON.stringify(parsed)}\n`;
    }
  } catch {
    // Unparseable core output is not a successful input rewrite.
  }
  return coreStdout;
}

// --- D-4: SESSION_ENDED reconcile-at-next-start ------------------------------

const heartbeatFile = join(sessionsDir(projectDir), "codex-session.json");

function reconcilePriorSession(): void {
  // The heartbeat is recorded even before a workflow exists. If the first turn
  // creates an intent, the utility can then bind this session to that record and
  // a later Codex session can reconcile its inferred SESSION_ENDED correctly.
  const hasActiveWorkflow = existsSync(stateFilePath(projectDir));
  try {
    if (hasActiveWorkflow && existsSync(heartbeatFile)) {
      const prior = JSON.parse(readFileSync(heartbeatFile, "utf-8")) as {
        session_id?: string;
        ts?: string;
      };
      if (prior.session_id && prior.session_id !== codex.session_id) {
        // The prior Codex session never emitted an end (no SessionEnd event
        // exists). Emit SESSION_ENDED through the byte-shared core hook with
        // inferred provenance; the back-dating is carried in the reason.
        const reason =
          `inferred — Codex has no SessionEnd event (D-4); reconciled at next ` +
          `SessionStart. Prior session ${prior.session_id} last seen ${prior.ts ?? "unknown"}.`;
        runCore(
          "aidlc-session-end.ts",
          JSON.stringify({ reason, session_id: prior.session_id }),
        );
      }
    }
    mkdirSync(dirname(heartbeatFile), { recursive: true });
    writeFileSync(
      heartbeatFile,
      JSON.stringify({ session_id: codex.session_id ?? "unknown", ts: new Date().toISOString() }),
      "utf-8",
    );
  } catch {
    // reconcile is observability — never block the session start
  }
}

// --- apply_patch envelope parsing --------------------------------------------

function patchedFiles(command: string): Array<{ path: string; tool: "Write" | "Edit" }> {
  const out: Array<{ path: string; tool: "Write" | "Edit" }> = [];
  for (const m of command.matchAll(/^\*\*\* (Add|Update) File: (.+)$/gm)) {
    const rel = m[2].trim();
    out.push({
      path: isAbsolute(rel) ? rel : join(projectDir, rel),
      tool: m[1] === "Add" ? "Write" : "Edit",
    });
  }
  return out;
}

// --- Targets ------------------------------------------------------------------

switch (target) {
  case "session-start": {
    reconcilePriorSession();
    // Forward session_id so the core hook's per-session→intent stamp (on
    // SESSION_STARTED) and resume-rebind OFFER (on source=resume) become
    // reachable — Codex already carries a real `source`, so with session_id
    // present the whole P8 rebind path works on Codex.
    // The thread's rollout lets `next` see a compaction no hook reported
    // (#2023). It is not passed as transcript_path, which names a Claude
    // transcript to the usage tools.
    const fwd = JSON.stringify({
      hook_event_name: "SessionStart",
      source: codex.source ?? "startup",
      ...(codex.session_id ? { session_id: codex.session_id } : {}),
      ...(typeof codex.transcript_path === "string" ? { rollout_path: codex.transcript_path } : {}),
    });
    const r = runCore("aidlc-session-start.ts", fwd);
    const wrapped = wrapContext(r.stdout, "SessionStart");
    persistResponse(wrapped, 0);
    if (wrapped) process.stdout.write(wrapped);
    return 0;
  }

  case "audit-and-sensors": {
    // apply_patch → write-audit-log THEN run-sensors per touched file (mirrors
    // the Claude settings.json Write|Edit registration order). Advisory.
    if ((codex.tool_name ?? "") === "apply_patch") {
      const command = (codex.tool_input?.command as string) ?? "";
      for (const f of patchedFiles(command)) {
        const fwd = JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: f.tool,
          tool_input: { file_path: f.path },
        });
        runCore("aidlc-write-audit-log.ts", fwd);
        runCore("aidlc-run-sensors.ts", fwd);
      }
    }
    persistResponse("", 0);
    return 0;
  }

  case "sync-workflow-state": {
    // update_plan → the first in_progress step maps to the TaskUpdate
    // in_progress transition; the core hook extracts the "[slug]" suffix.
    if ((codex.tool_name ?? "") === "update_plan") {
      const plan = (codex.tool_input?.plan as Array<{ step?: string; status?: string }>) ?? [];
      const active = plan.find((p) => p.status === "in_progress");
      if (active?.step) {
        const fwd = JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "TaskUpdate",
          tool_input: { status: "in_progress", activeForm: active.step },
        });
        runCore("aidlc-sync-workflow-state.ts", fwd);
      }
    }
    persistResponse("", 0);
    return 0;
  }

  case "rebuild-stage-graph": {
    // Codex already names the shell tool "Bash" with tool_input.command —
    // the core hook's exact contract. Verbatim pipe. The core hook's only
    // stdout is the engine-error relay, one {"systemMessage": ...} line that
    // Codex surfaces as a warning in the UI (documented for PostToolUse), so
    // forward it. It is display-only, so unlike a decision it is deliberately
    // NOT cached for the duplicate delivery: replaying it would show the same
    // warning twice. The hook stays advisory (exit 0) either way.
    const r = await runCoreHere("aidlc-rebuild-stage-graph.ts", rawInput);
    persistResponse("", 0);
    if (r.stdout) process.stdout.write(r.stdout);
    return 0;
  }

  case "validate-state": {
    // PreCompact: the core hook reads no stdin fields — state validation +
    // SESSION_COMPACTED + recovery breadcrumb are all self-contained.
    runCore("aidlc-validate-state.ts", rawInput);
    persistResponse("", 0);
    return 0;
  }

  case "log-subagent": {
    // SubagentStop already carries agent_type (real role name since Codex
    // 0.139.0; the doctor-advised floor is 0.145.0) + agent_id. Verbatim pipe.
    runCore("aidlc-log-subagent.ts", rawInput);
    persistResponse("", 0);
    return 0;
  }

  case "continue-workflow": {
    // Contract identical on Codex (stop_hook_active included): pass stdin
    // verbatim, forward {"decision":"block","reason"} stdout + exit code.
    const r = runCore("aidlc-continue-workflow.ts", rawInput);
    persistResponse(r.stdout, r.code);
    if (r.stdout) process.stdout.write(r.stdout);
    return r.code;
  }

  case "reviewer-scope": {
    // PreToolUse: the per-unit reviewer read-scope bound. Codex delivers the
    // spawned agent's name as agent_type on subagent tool calls (verified on
    // 0.142.5) and the shell tool as "Bash" with tool_input.command - the
    // core hook's exact contract - so Bash pipes verbatim. apply_patch (the
    // edit surface) fans out one Write per touched file, agent identity
    // forwarded, and blocks when ANY file is out of scope. Everything else
    // (spawn_agent, wait, plan, ...) allows instantly. The block contract is
    // exit 2 + stderr (probe-verified: Codex refuses the call and relays the
    // reason); the response cache carries stderr so the duplicate delivery
    // replays the block faithfully. Fail-open on any spawn failure.
    const tool = codex.tool_name ?? "";
    if (tool === "Bash") {
      const r = await runCoreHere("aidlc-reviewer-scope.ts", rawInput);
      // Persist the ANSWERED code, not the raw one: anything that is not the
      // block contract (2) is answered 0 below, and the duplicate must replay
      // exactly what the original answered (a crashed core hook exiting 1
      // must not replay as 1 when the original delivery allowed).
      persistResponse(r.stdout, r.code === 2 ? 2 : 0, r.stderr);
      if (r.code === 2) {
        process.stderr.write(r.stderr);
        return 2;
      }
      return 0;
    }
    if (tool === "apply_patch") {
      const command = (codex.tool_input?.command as string) ?? "";
      // Every file-path directive in the envelope is a mutation of that path:
      // Add/Update (patchedFiles - shared with the audit fan-out), plus
      // Delete File and Move to, which patchedFiles deliberately skips for
      // the PostToolUse audit surface but ARE sibling writes for scope
      // purposes (deleting or moving onto a sibling's file is out of a
      // reviewer's contract exactly like editing it).
      const targets: Array<{ path: string; tool: string }> = patchedFiles(command);
      for (const m of command.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)) {
        const rel = m[1].trim();
        targets.push({ path: isAbsolute(rel) ? rel : join(projectDir, rel), tool: "Edit" });
      }
      for (const f of targets) {
        const fwd = JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: f.tool,
          tool_input: { file_path: f.path },
          ...(codex.agent_type ? { agent_type: codex.agent_type } : {}),
          ...(codex.agent_id ? { agent_id: codex.agent_id } : {}),
        });
        const r = await runCoreHere("aidlc-reviewer-scope.ts", fwd);
        if (r.code === 2) {
          persistResponse("", 2, r.stderr);
          process.stderr.write(r.stderr);
          return 2;
        }
      }
    }
    persistResponse("", 0);
    return 0;
  }

  case "review-freeze": {
    // PreToolUse: the §12a terminal-receipt write-freeze. Bash already carries
    // the core hook's command shape, while apply_patch fans out one Write per
    // touched path (Delete File / Move to included). Block contract: exit 2 +
    // stderr; the response cache replays the block on duplicate delivery.
    const tool = codex.tool_name ?? "";
    if (tool === "Bash") {
      const r = await runCoreHere("aidlc-review-freeze.ts", rawInput);
      persistResponse(r.stdout, r.code === 2 ? 2 : 0, r.stderr);
      if (r.code === 2) {
        process.stderr.write(r.stderr);
        return 2;
      }
      return 0;
    }
    if (tool === "apply_patch") {
      const command = (codex.tool_input?.command as string) ?? "";
      const targets: Array<{ path: string; tool: string }> = patchedFiles(command);
      for (const m of command.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)) {
        const rel = m[1].trim();
        targets.push({ path: isAbsolute(rel) ? rel : join(projectDir, rel), tool: "Edit" });
      }
      for (const f of targets) {
        const fwd = JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: f.tool,
          tool_input: { file_path: f.path },
        });
        const r = await runCoreHere("aidlc-review-freeze.ts", fwd);
        if (r.code === 2) {
          persistResponse("", 2, r.stderr);
          process.stderr.write(r.stderr);
          return 2;
        }
      }
    }
    persistResponse("", 0);
    return 0;
  }

  case "deliver-stage-rules": {
    // Codex 0.145 consumes the same PreToolUse hookSpecificOutput.updatedInput
    // contract as Claude, plus an explicit allow decision for rewritten input.
    // The core hook recognizes spawn_agent and appends the exact active-stage
    // bundle to message/items; the adapter completes the Codex envelope.
    const r = runCoreWithStderr("aidlc-deliver-stage-rules.ts", rawInput);
    const answeredCode = r.code === 2 ? 2 : 0;
    const stdout = r.code === 2 ? r.stdout : allowUpdatedInput(r.stdout);
    persistResponse(stdout, answeredCode, r.stderr);
    if (stdout) process.stdout.write(stdout);
    if (r.code === 2) {
      process.stderr.write(r.stderr);
      return 2;
    }
    return 0;
  }

  case "plan-approval-guard": {
    // PreToolUse: code-generation's plan-before-generation ordering. Bash
    // forwards directly; apply_patch fans out one Write call per touched path;
    // spawn_agent is normalized to the core Task shape. The block contract is
    // exit 2 + stderr, cached like reviewer-scope so duplicate delivery replays
    // the block faithfully.
    const tool = codex.tool_name ?? "";
    if (tool === "Bash") {
      const r = await runCoreHere("aidlc-plan-approval-guard.ts", rawInput);
      persistResponse(r.stdout, r.code === 2 ? 2 : 0, r.stderr);
      if (r.code === 2) {
        process.stderr.write(r.stderr);
        return 2;
      }
      return 0;
    }
    if (tool === "apply_patch") {
      const command = (codex.tool_input?.command as string) ?? "";
      const targets: Array<{ path: string; tool: string }> = patchedFiles(command);
      for (const m of command.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)) {
        const rel = m[1].trim();
        targets.push({ path: isAbsolute(rel) ? rel : join(projectDir, rel), tool: "Edit" });
      }
      for (const f of targets) {
        const r = await runCoreHere(
          "aidlc-plan-approval-guard.ts",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: f.tool,
            tool_input: { file_path: f.path },
            ...(payloadSessionId ? { session_id: payloadSessionId } : {}),
          }),
        );
        if (r.code === 2) {
          persistResponse("", 2, r.stderr);
          process.stderr.write(r.stderr);
          return 2;
        }
      }
      persistResponse("", 0);
      return 0;
    }
    if (tool !== "spawn_agent") {
      persistResponse("", 0);
      return 0;
    }
    const spawnInput: CodexSpawnAgentInput = codex.tool_input ?? {};
    // Every named dispatch goes to the core guard, which judges only the
    // developer's and records a reviewer brief that already carries its verdict.
    const target =
      typeof spawnInput.agent_type === "string" ? spawnInput.agent_type : "";
    if (target === "") {
      persistResponse("", 0);
      return 0;
    }
    const fwd = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: {
        subagent_type: target,
        prompt: spawnAgentPrompt(spawnInput),
      },
      ...(payloadSessionId ? { session_id: payloadSessionId } : {}),
    });
    const r = await runCoreHere("aidlc-plan-approval-guard.ts", fwd);
    persistResponse(r.stdout, r.code === 2 ? 2 : 0, r.stderr);
    if (r.code === 2) {
      process.stderr.write(r.stderr);
      return 2;
    }
    return 0;
  }

  case "state-transition-guard": {
    // Global PreToolUse lifecycle guard. Only Bash can name aidlc-state.ts;
    // everything else permits immediately. Preserve exit 2 + stderr exactly;
    // returned, never process.exit, since this runs as a guard-tool-call member.
    if ((codex.tool_name ?? "") === "Bash") {
      const r = await runCoreHere("aidlc-state-transition-guard.ts", rawInput);
      persistResponse(r.stdout, r.code === 2 ? 2 : 0, r.stderr);
      if (r.code === 2) {
        process.stderr.write(r.stderr);
        return 2;
      }
    }
    persistResponse("", 0);
    return 0;
  }

  case "guard-tool-call": {
    // The one PreToolUse registration: the four checks a shell call used to
    // start as four handlers run here in order, in this process. Every member
    // runs even after one refuses, as Codex ran every handler; the call is
    // refused when any member refuses, with each refusal once on stderr and
    // nothing on stdout. When every member lets the call through nothing is
    // printed and the command runs as the agent wrote it. A member that fails
    // on its own (its own case answers that 0; a thrown error lands here as
    // code 1) refuses nothing, as its crashed process did not. The group
    // persists its own answer for the duplicate delivery.
    const members = [
      "state-transition-guard",
      "reviewer-scope",
      "review-freeze",
      "plan-approval-guard",
    ];
    let code = 0;
    let allowed = "";
    const refusals: string[] = [];
    for (const member of members) {
      const said = await collectOutput(() => run(member, rawInput, _extraArgs));
      if (said.code === 2) {
        code = 2;
        if (said.stderr && !refusals.includes(said.stderr)) refusals.push(said.stderr);
      } else if (said.code === 0) {
        allowed += said.stdout;
      }
    }
    const stdout = code === 0 ? allowed : "";
    const stderr = refusals.join("");
    persistResponse(stdout, code, stderr || undefined);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return code;
  }

  case "record-human-turn": {
    // Codex's question box runs out after two minutes with no answer. The core
    // hook records that nobody answered and tells the agent to ask again;
    // its PostToolUse context goes back to Codex as it is.
    if (codex.tool_name === "request_user_input" && emptyPickerResult(codex.tool_response)) {
      const r = runCoreWithStderr("aidlc-record-human-turn.ts", JSON.stringify({
        hook_event_name: "PostToolUse",
        ...(codex.session_id ? { session_id: codex.session_id } : {}),
        tool_name: "request_user_input",
        tool_input: codex.tool_input,
        tool_response: { answers: {} },
      }));
      persistResponse(r.stdout, 0);
      if (r.stdout) process.stdout.write(r.stdout);
      return 0;
    }
    if (
      codex.tool_name === "request_user_input" &&
      !hasExplicitHumanSelection(codex.tool_response, codex.tool_input)
    ) {
      persistResponse("", 0);
      return 0;
    }
    // Codex runs UserPromptSubmit for every input to a thread, so a spawned
    // subagent's brief, and each follow-up the agent sends it, arrive as
    // `prompt` under the root session id. Codex marks those with agent_id
    // (the subagent's thread id); the root thread's prompts never carry it.
    // A subagent's prompt is the agent speaking: no HUMAN_TURN, no kept
    // words, no answer, no typed switch (#1411).
    // Codex's internal reviewers (the /review reviewer, Guardian auto-review)
    // run as their own threads under the same root session id but carry no
    // agent_id. transcript_path names the thread whose input this is
    // (rollout-<timestamp>-<thread id>[_<rollout id>].jsonl), and the root
    // thread's id is the session id, so a rollout naming another thread is not
    // the main chat. A path in any other form decides nothing.
    if (
      codex.tool_name !== "request_user_input" &&
      ((typeof codex.agent_id === "string" && codex.agent_id.trim().length > 0) ||
        otherThreadInput(codex.transcript_path, codex.session_id))
    ) {
      persistResponse("", 0);
      return 0;
    }
    // UserPromptSubmit: a real human acted this turn — record a HUMAN_TURN event
    // in the active intent's audit shard (human-presence gate). Gated on workflow
    // state existing (same self-gate as the core record-human-turn hook) so a prompt in a
    // project that never ran the framework does not scaffold audit shards.
    // Fail-open: a record-human-turn failure must never block the turn. Advisory, no stdout.
    //
    // A structured request_user_input selection is forwarded as the tool
    // response it is, never as typed prompt text: the core hook records the
    // Plan Approval choice from either channel, but the break-glass override
    // phrase counts only when the human typed it as a prompt. The box's reply
    // goes along as it came, so each question's reply is kept word for word.
    const selectionText = explicitHumanSelectionText(codex.tool_response);
    const forwarded =
      codex.tool_name === "request_user_input"
        ? {
            hook_event_name: "PostToolUse",
            ...(codex.session_id ? { session_id: codex.session_id } : {}),
            tool_name: "request_user_input",
            tool_input: codex.tool_input,
            tool_response: { answer: selectionText },
            picker_reply: codex.tool_response,
          }
        : {
            hook_event_name: "UserPromptSubmit",
            ...(codex.session_id ? { session_id: codex.session_id } : {}),
            prompt: codex.prompt || codex.user_prompt || codex.message || "",
          };
    const turn = runCoreWithStderr("aidlc-record-human-turn.ts", JSON.stringify(forwarded));
    // The core hook's note says what a switch the person typed did, and that the
    // engine already tells them. Dropping it is why the agent ran a setter of its
    // own on the piece of work that was open instead of the one they asked about.
    // Same context envelope as session-start; an output with nothing in it stays
    // empty, so a turn with no note answers exactly as before.
    const context = wrapContext(turn.stdout, "UserPromptSubmit");
    persistResponse(context, 0);
    if (context) process.stdout.write(context);
    return 0;
  }

  default:
    persistResponse("", 0);
    return 0;
}
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
}
