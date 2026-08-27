#!/usr/bin/env bun
// aidlc-codex-adapter.ts — the Codex CLI hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). Modeled on kiro's aidlc-kiro-adapter.ts: ONE shim
// normalizes the harness payload to the ClaudeCodeHookInput shape and
// subprocess-pipes into the named core hook, forwarding stdout/exit code.
//
// Codex payloads are near-isomorphic to Claude Code's (live corpus,
// tmp/codex-dist/payload-corpus/ in the framework repo) with four
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
//
// Output contracts:
//   - session-start: the core hook prints
//     {"additionalContext": "..."}; Codex expects the hookSpecificOutput
//     wrapper (verified live, findings E1) — the shim re-wraps.
//   - bind-bash-session: POSIX Bash input is rewritten through
//     hookSpecificOutput.updatedInput so every command inherits the validated
//     payload session without process inspection.
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
//                  bind-bash-session

import { createHash } from "node:crypto";
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
import { fileURLToPath } from "node:url";
import {
  isNonAnswer,
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
  const command = executable
    ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
    : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(input, "utf-8"),
    stdout: "pipe",
    stderr: "ignore",
    cwd: projectDir,
    env: projectEnv,
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
  const command = executable
    ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
    : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(input, "utf-8"),
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectDir,
    env: projectEnv,
  });
  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    code: r.exitCode ?? 0,
  };
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

function wrapUpdatedInput(updatedInput: Record<string, unknown>): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput,
    },
  })}\n`;
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
  case "bind-bash-session": {
    const command =
      typeof codex.tool_input?.command === "string"
        ? codex.tool_input.command
        : "";
    if (
      process.platform === "win32" ||
      codex.tool_name !== "Bash" ||
      !payloadSessionId ||
      !command
    ) {
      persistResponse("", 0);
      return 0;
    }
    const prefix =
      `export AIDLC_SESSION_OVERRIDE='${payloadSessionId}' ` +
      "AIDLC_SESSION_OVERRIDE_SOURCE='payload'; ";
    const wrapped = wrapUpdatedInput({
      ...codex.tool_input,
      command: command.startsWith(prefix) ? command : `${prefix}${command}`,
    });
    persistResponse(wrapped, 0);
    process.stdout.write(wrapped);
    return 0;
  }

  case "session-start": {
    reconcilePriorSession();
    // Forward session_id so the core hook's per-session→intent stamp (on
    // SESSION_STARTED) and resume-rebind OFFER (on source=resume) become
    // reachable — Codex already carries a real `source`, so with session_id
    // present the whole P8 rebind path works on Codex.
    const fwd = JSON.stringify({
      hook_event_name: "SessionStart",
      source: codex.source ?? "startup",
      ...(codex.session_id ? { session_id: codex.session_id } : {}),
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
    // the core hook's exact contract. Verbatim pipe.
    runCore("aidlc-rebuild-stage-graph.ts", rawInput);
    persistResponse("", 0);
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
    // 0.139.0; the doctor-enforced floor is 0.145.0) + agent_id. Verbatim pipe.
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
      const r = runCoreWithStderr("aidlc-reviewer-scope.ts", rawInput);
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
        const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
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
      const r = runCoreWithStderr("aidlc-review-freeze.ts", rawInput);
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
        const r = runCoreWithStderr("aidlc-review-freeze.ts", fwd);
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
    // contract as Claude. The core hook recognizes spawn_agent and appends the
    // exact active-stage bundle to message/items without adapter re-shaping.
    const r = runCoreWithStderr("aidlc-deliver-stage-rules.ts", rawInput);
    const answeredCode = r.code === 2 ? 2 : 0;
    persistResponse(r.stdout, answeredCode, r.stderr);
    if (r.stdout) process.stdout.write(r.stdout);
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
      const r = runCoreWithStderr("aidlc-plan-approval-guard.ts", rawInput);
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
        const r = runCoreWithStderr(
          "aidlc-plan-approval-guard.ts",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: f.tool,
            tool_input: { file_path: f.path },
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
    const target =
      typeof spawnInput.agent_type === "string" ? spawnInput.agent_type : "";
    if (target !== "aidlc-developer-agent") {
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
    });
    const r = runCoreWithStderr("aidlc-plan-approval-guard.ts", fwd);
    persistResponse(r.stdout, r.code === 2 ? 2 : 0, r.stderr);
    if (r.code === 2) {
      process.stderr.write(r.stderr);
      return 2;
    }
    return 0;
  }

  case "state-transition-guard": {
    // Global PreToolUse lifecycle guard. Only Bash can name aidlc-state.ts;
    // everything else permits immediately. Preserve exit 2 + stderr exactly.
    if ((codex.tool_name ?? "") === "Bash") {
      const r = runCoreWithStderr("aidlc-state-transition-guard.ts", rawInput);
      persistResponse(r.stdout, r.code === 2 ? 2 : 0, r.stderr);
      if (r.code === 2) {
        process.stderr.write(r.stderr);
        process.exit(2);
      }
    }
    persistResponse("", 0);
    process.exit(0);
    break;
  }

  case "record-human-turn": {
    if (
      codex.tool_name === "request_user_input" &&
      !hasExplicitHumanSelection(codex.tool_response, codex.tool_input)
    ) {
      persistResponse("", 0);
      return 0;
    }
    // UserPromptSubmit: a real human acted this turn — record a HUMAN_TURN event
    // in the active intent's audit shard (human-presence gate). Gated on workflow
    // state existing (same self-gate as the core record-human-turn hook) so a prompt in a
    // project that never ran the framework does not scaffold audit shards.
    // Fail-open: a record-human-turn failure must never block the turn. Advisory, no stdout.
    const responseText =
      explicitHumanSelectionText(codex.tool_response) ||
      codex.prompt ||
      codex.user_prompt ||
      codex.message ||
      "";
    runCoreWithStderr(
      "aidlc-record-human-turn.ts",
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        ...(codex.session_id ? { session_id: codex.session_id } : {}),
        prompt: responseText,
      }),
    );
    persistResponse("", 0);
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
