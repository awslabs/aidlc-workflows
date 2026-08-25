#!/usr/bin/env bun
// aidlc-kiro-adapter.ts — the Kiro IDE hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). This is the IDE-specific adapter; the CLI harness ships
// its own (harness/kiro/) wired to kiro-cli's agent-JSON hook events and their
// payload shapes. They are deliberately separate files so neither carries a
// runtime "am I CLI or IDE?" branch.
//
// Kiro IDE hook context (live-captured on 0.12-main AND 1.0.165 — see
// docs/reference/kiro-ide-hook-payload.md). The channel changed across IDE
// generations; the adapter accepts BOTH:
//   1. IDE 1.x (v2 hooks, `.kiro/hooks/aidlc-*.json`): context arrives as JSON
//      on STDIN, snake_case: { session_id, hook_event_name, cwd, tool_name,
//      tool_input, tool_response } — no success flag. USER_PROMPT is empty.
//      stdin is written AND closed, so a read resolves promptly. A non-empty
//      USER_PROMPT is nevertheless checked first to identify the legacy channel;
//      the stdin read retains a short broken-channel timeout.
//   2. IDE 0.12 (legacy `.kiro.hook` era): stdin was OPENED BUT NEVER
//      WRITTEN/CLOSED — reading it hangs. Context came through the
//      `USER_PROMPT` env var instead, camelCase: { toolName, toolArgs,
//      toolResult, toolSuccess }; that non-empty payload is consumed immediately.
//   3. Captured PostToolUse write/shell events have empty tool inputs, so their
//      file path is recoverable ONLY from toolResult/tool_response prose and
//      the shell command is not recoverable at all. Later 1.x builds populate
//      some PreToolUse and delegation inputs (#543); do not generalize the
//      PostToolUse limitation to every event.
//   4. The tool name arrives as the IDE tool name: `fs_write`, `str_replace`,
//      `fs_append`, `execute_bash`, etc.
//
// Payload acquisition is GATED to the three tool-payload targets plus the
// lifecycle boundaries that carry modern session identity (SessionStart and
// Stop). Every other target is payload-independent and never touches stdin —
// block fires on EVERY PreToolUse, and a 2s stall on a never-closing stdin
// there would be felt on every tool call.
//
// Consequences, by target:
//   - audit-and-sensors: scrape the written file path from toolResult prose
//     (strict patterns, fail-open) and feed the core hooks the Claude-shaped
//     {tool_input:{file_path}}.
//   - rebuild-stage-graph: the command is unrecoverable, so drop the command
//     filter and always forward — the core hook self-gates on the audit tail.
//   - state-sync: payload-independent — the core hook reads the latest
//     STAGE_STARTED slug from the audit tail (no task payload needed).
//   - log-subagent: recovers the delegate's identity from the result prose or
//     the 1.x `subagent_<agent>` tool name, plus the message (#459/#543).
//   - session-start: retain the modern session_id (or the legacy synthetic id)
//     in workspace-local runtime state.
//   - stop: prefer the event-local modern session_id; use retained identity for
//     the legacy channel and broken modern payloads.
//   - session-end: read retained identity without probing payload.
//
// session-start emits {"additionalContext": "..."} — Kiro's context channel is
// plain stdout at exit 0, so the shim unwraps the JSON and prints the text.
// stop emits {"decision":"block","reason":"..."} — passed through verbatim.
//
// Usage (registered in .kiro/hooks/aidlc-*.json — the IDE's v2 hook schema,
// {"version":"v1","hooks":[{name,trigger,matcher,action}]}):
//   bun .kiro/hooks/aidlc-kiro-adapter.ts <target>
// where <target> ∈ record-human-turn | enforce-approval-gate | session-start |
//                  audit-and-sensors | rebuild-stage-graph |
//                  sync-workflow-state | log-subagent | continue-workflow |
//                  session-end

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasOpenGate,
  hookDebug,
  humanActedSinceGate,
  humanPresenceGuardDisabled,
  isAutonomousMode,
  markHumanTurn,
  recordHookDrop,
  resolveProjectDirFromHook,
  sessionsDir,
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

// The NORMALIZED hook context, whichever channel delivered it: 1.x snake_case
// stdin { tool_name, tool_input, tool_response } or 0.12 camelCase USER_PROMPT
// { toolName, toolArgs, toolResult, toolSuccess }. PostToolUse write/shell
// captures have empty inputs; later 1.x builds populate some PreToolUse and
// delegation inputs (#543), so normalization preserves either shape.
interface IdeHookContext {
  sessionId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolSuccess?: boolean;
  malformedFields?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The three targets whose forward depends on the tool payload. Every other
// target builds a fixed input (or reads only the filesystem), so it skips
// payload acquisition entirely and keeps its zero-latency path.
const PAYLOAD_TARGETS = new Set([
  "audit-and-sensors",
  "log-subagent",
  "rebuild-stage-graph",
]);
const SESSION_ID_TARGETS = new Set(["session-start", "continue-workflow"]);
const INPUT_TARGETS = new Set([...PAYLOAD_TARGETS, ...SESSION_ID_TARGETS]);
const LEGACY_SESSION_ID = "kiro-ide-legacy-current";
const KIRO_IDE_SESSION_FILE = ".kiro-ide-current-session";

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
// LOAD-BEARING (not debug-only): this is the base dir for resolve(projectDir,
// rawPath) that turns the IDE's workspace-relative write path into the absolute
// path the core write-audit-log's record-root check needs — the core fix of this
// harness. It also feeds hookDebug/recordHookDrop. Do not remove it.
const projectDir = resolveProjectDirFromHook(import.meta.url);

// Normalize the hook context for the payload-dependent targets. IDE 1.x
// delivers it as JSON on stdin (the `input` argument); 0.12 delivered it via
// USER_PROMPT with stdin open-but-never-written. Prefer stdin, fall back to
// the env var so 0.12 keeps working. Field names differ per channel — 0.12
// camelCase {toolName, toolArgs, toolResult, toolSuccess}; 1.x snake_case
// {tool_name, tool_input, tool_response} (no success flag) — accept both.
let ide: IdeHookContext = {};
if (INPUT_TARGETS.has(target)) {
  let raw = input;
  if (raw.trim().length === 0) raw = process.env.USER_PROMPT ?? "";
  if (raw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        ide = { malformedFields: ["payload"] };
      } else {
        const rawName = parsed.toolName ?? parsed.tool_name;
        const rawArgs = parsed.toolArgs ?? parsed.tool_input;
        const rawResult = parsed.toolResult ?? parsed.tool_response;
        const rawSuccess = parsed.toolSuccess ?? parsed.tool_success;
        const rawSessionId = parsed.session_id;
        const malformedFields: string[] = [];
        if (rawName !== null && rawName !== undefined && typeof rawName !== "string") {
          malformedFields.push("toolName");
        }
        if (rawArgs !== null && rawArgs !== undefined && !isRecord(rawArgs)) {
          malformedFields.push("toolArgs");
        }
        if (rawResult !== null && rawResult !== undefined && typeof rawResult !== "string") {
          malformedFields.push("toolResult");
        }
        if (
          rawSuccess !== null &&
          rawSuccess !== undefined &&
          typeof rawSuccess !== "boolean"
        ) {
          malformedFields.push("toolSuccess");
        }
        ide = {
          sessionId: typeof rawSessionId === "string" ? rawSessionId : undefined,
          toolName: typeof rawName === "string" ? rawName : undefined,
          toolArgs: isRecord(rawArgs) ? rawArgs : undefined,
          toolResult: typeof rawResult === "string" ? rawResult : "",
          toolSuccess: typeof rawSuccess === "boolean" ? rawSuccess : undefined,
          malformedFields: malformedFields.length > 0 ? malformedFields : undefined,
        };
      }
    } catch {
      // Malformed context — advisory hooks fail open without forwarding an
      // event whose fields cannot be trusted.
      ide = { malformedFields: ["JSON"] };
    }
  }
}
hookDebug(projectDir, "kiro-adapter", "invoked", {
  target,
  hasStdinPayload: input.trim().length > 0,
  hasUserPrompt: (process.env.USER_PROMPT ?? "").length > 0,
  toolName: ide.toolName ?? "",
  sessionId: ide.sessionId ?? "",
  toolResult: (ide.toolResult ?? "").slice(0, 160),
});

// Persist the effective SessionStart identity under the existing gitignored
// runtime dir so separate adapter processes can forward it to payload-free
// SessionEnd and use it when a legacy or broken-channel Stop has no event-local
// session_id. A legacy promptSubmit writes the synthetic id, replacing any
// stale modern value from a prior IDE generation in the same workspace.
function rememberKiroIdeSessionId(sessionId: string): void {
  if (!sessionId) return;
  try {
    const dir = sessionsDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, KIRO_IDE_SESSION_FILE), `${sessionId}\n`, "utf-8");
  } catch {
    // Per-user runtime state; lifecycle hooks retain the legacy fallback.
  }
}

function rememberedKiroIdeSessionId(): string {
  try {
    const sessionId = readFileSync(
      join(sessionsDir(projectDir), KIRO_IDE_SESSION_FILE),
      "utf-8",
    ).trim();
    return sessionId || LEGACY_SESSION_ID;
  } catch {
    return LEGACY_SESSION_ID;
  }
}

// --- mint: record a HUMAN_TURN event on prompt submit ---
//
// Wired by aidlc-mint.json (UserPromptSubmit). Payload-independent (never
// reads stdin — a mint must never wait on it), so resolve the project dir
// from process.cwd() — appendAuditEntry then resolves the
// active intent from the on-disk cursor (aidlc/spaces/<space>/intents/active-intent)
// using only that dir, so the event lands in the correct per-intent shard with
// no payload. One ledger event per human turn; no marker file, no turn counter.
// Gated on workflow state existing (same self-gate as the core mint hook) so a
// prompt in a project that never ran the framework does not scaffold audit
// shards. Fail-open (try/catch, exit 0) so a mint failure never blocks the
// human's turn.
//
// The seam ALSO touches the .aidlc-human-turn marker (markHumanTurn), which is
// what makes the Stop hook's conversational carve-out work on this harness. The
// IDE delivers no `transcript_path`, so the carve-out cannot read the turn
// history; it compares this marker's mtime against .aidlc-engine-touch instead.
// Both writes ride this one seam so the ledger and the marker can never
// disagree about when a human spoke. See the marker family in aidlc-lib.ts.
if (target === "record-human-turn") {
  try {
    const pd = process.cwd();
    if (existsSync(stateFilePath(pd))) {
      appendAuditEntry("HUMAN_TURN", {}, pd);
      markHumanTurn(pd);
    }
  } catch {
    /* advisory - mint never blocks the turn */
  }
  return 0;
}

// --- block: the preToolUse human-presence floor ---
//
// Wired by aidlc-block.json (PreToolUse). Hard-blocks tool calls ONLY while
// an approval gate is actually OPEN (a stage sits at [?] in the state file) and
// no HUMAN_TURN has been recorded since the last gate resolution - the exit-2
// floor behind the core handleApprove check. The gate-open predicate is
// load-bearing: after a legitimate approval the resolution follows the turn's
// HUMAN_TURN, and without it the floor would block the mandated same-turn
// continuation into the next stage. Carve-outs mirror the core gate: autonomous
// Construction (swarm/Bolt has no human at the gate) and the deterministic
// off-switch. The IDE gives no cwd payload, so the project dir is process.cwd().
// All read from disk. Fail-open on any read/parse error (advisory).
if (target === "enforce-approval-gate") {
  try {
    const pd = process.cwd();
    const sp = stateFilePath(pd);
    const content = existsSync(sp) ? readFileSync(sp, "utf-8") : null;
    // Carve-outs first: autonomous Construction, the deterministic off-switch,
    // and no-open-gate (nothing awaits approval, so nothing to floor).
    if (isAutonomousMode(content)) return 0;
    if (humanPresenceGuardDisabled()) return 0;
    if (!hasOpenGate(content)) return 0;
    if (humanActedSinceGate(pd)) return 0; // a human acted at this gate
    process.stderr.write(
      "An approval gate is open and no human has acted since it opened. The gate " +
        "requires a typed human turn before any tool call proceeds. Acknowledge the " +
        "gate as a human, then continue.\n",
    );
    return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  } catch {
    return 0; // advisory - any read/parse failure fails open
  }
}

// Extract the absolute path of the file a write tool just touched from the
// IDE's toolResult prose. Captured PostToolUse write inputs are empty, so this
// is the ONLY path source on those events. Only the known Kiro wordings match; anything else returns "" so the caller
// can record a visible drop (no silent no-op).
//   fs_write    → "Created the <PATH> file."
//   str_replace → "Replaced text in <PATH>"           (may carry a trailing
//                  " (N occurrences)" or similar suffix — stripped below)
//   fs_append   → "Appended the text to the <PATH> file."
//
// Robustness (finding 4): trim first so a trailing newline does not defeat the
// `$` anchor, and for the open-ended str_replace form stop the capture before a
// trailing " (…)" parenthetical so a "Replaced text in foo.md (2 occurrences)"
// result yields "foo.md", not "foo.md (2 occurrences)".
function extractWrittenPath(toolResult: string): string {
  const s = toolResult.trim();
  let m = s.match(/^Created the (.+) file\.$/);
  if (m) return m[1].trim();
  m = s.match(/^Appended the text to the (.+) file\.$/);
  if (m) return m[1].trim();
  m = s.match(/^Replaced text in (.+?)(?:\s+\([^)]*\))?$/);
  if (m) return m[1].trim();
  return "";
}

// Does this toolResult describe a write that FAILED? Used only to keep the drop
// log honest: a failed write has no artifact to audit, so not forwarding it is
// correct behaviour and must NOT be recorded as harness decay (see the call
// site). The 1.x stdin channel carries no success flag, so error prose is the
// only signal available.
//
// EVIDENCE GRADING — only the first pattern is grounded in a capture:
//   ^Caught an error while   OBSERVED live on IDE 1.x (a str_replace whose old
//                            string matched multiple times). This is the case
//                            that motivated the fix.
//   ^Error:                  DEFENSIVE GUESS. Not observed; no capture in this
//   ^Failed to               repo or in docs/reference/kiro-ide-hook-payload.md
//   ^An error occurred       backs these three shapes.
// They are kept because the risk direction is mild and one-way: a match only
// suppresses a drop when path extraction has ALREADY failed and the payload has
// no structured success flag. Explicit `toolSuccess: true` remains authoritative.
// Masking real decay would therefore require a new flagless SUCCESS wording that
// begins with error prose — and the known success wordings ("Created the …",
// "Replaced text in …", "Appended the text to …") cannot collide with any of
// them. If a capture ever contradicts one, delete it rather than widening the set.
//
// Every pattern is start-anchored on purpose: a loose "contains 'error'" test
// would swallow a successful write to a file whose NAME mentions an error, which
// would hide exactly the decay this log exists to surface. Anything unrecognised
// is treated as a success and still earns a visible drop — the default stays
// biased toward reporting, not toward silence.
function isFailedWriteResult(toolResult: string): boolean {
  const s = toolResult.trim();
  return (
    /^Caught an error while /i.test(s) ||
    /^Error:/i.test(s) ||
    /^Failed to /i.test(s) ||
    /^An error occurred/i.test(s)
  );
}

// Map the IDE tool name to the canonical name the core hooks match on. Write
// creates a (possibly new) file; str_replace/fs_append always target an
// existing file → Edit (forces ARTIFACT_UPDATED in the core write-audit-log).
function canonicalWriteTool(name: string): "Write" | "Edit" | "" {
  if (name === "fs_write") return "Write";
  if (name === "str_replace" || name === "fs_append") return "Edit";
  return "";
}

// Recover the delegated agent's identity from the hook payload.
//
// PRECEDENCE IS AN AUDIT-INTEGRITY PROPERTY, NOT A STYLE CHOICE. On IDE 1.x the
// tool name itself carries the delegate as `subagent_<agent>` (#543) — a
// platform-provided identity the delegate cannot author. It therefore WINS over
// the result prose: an incorrect or prompt-injected `**Agent:** <other>` line in
// agent-written output must not be able to misattribute a SUBAGENT_COMPLETED row
// to a different persona while a more authoritative identity is available.
//
// The prose markers (`**Reviewer:** <name>` / `**Agent:** <name>`, #459) stay as
// the fallback because they are the ONLY signal on the 0.12 `invoke_sub_agent`
// shape, which carries no structured identity. They also still cover a
// degenerate `subagent_` whose suffix is empty. With neither, "unknown".
function extractAgentIdentity(toolResult: string, toolName = ""): string {
  const structured =
    toolName.startsWith("subagent_") && toolName !== "subagent_response"
      ? toolName.slice("subagent_".length).trim()
      : "";
  if (structured !== "") return structured;
  const lines = toolResult.split("\n").slice(0, 8);
  for (const line of lines) {
    const m = line.match(/^\s*\*\*(?:Reviewer|Agent)\s*:\*\*\s*(.+?)\s*$/);
    if (m) return m[1].replace(/\*+$/, "").trim() || "unknown";
  }
  return "unknown";
}

type Forward = { hook: string; input: Record<string, unknown> } | null;

function buildForward(): Forward {
  if (PAYLOAD_TARGETS.has(target) && (ide.malformedFields?.length ?? 0) > 0) {
    recordHookDrop(
      projectDir,
      "kiro-adapter",
      `${target}: malformed hook context fields (${ide.malformedFields?.join(", ")}) — event not forwarded`,
    );
    return null;
  }

  switch (target) {
    case "session-start": {
      // Modern IDE payloads carry session_id. Legacy promptSubmit does not, so
      // use one workspace-local synthetic id for its promptSubmit/agentStop pair.
      const sessionId = ide.sessionId?.trim() || LEGACY_SESSION_ID;
      rememberKiroIdeSessionId(sessionId);
      return {
        hook: "aidlc-session-start.ts",
        input: {
          hook_event_name: "SessionStart",
          source: "startup",
          session_id: sessionId,
        },
      };
    }

    case "audit-and-sensors": {
      // postToolUse(write) → write-audit-log THEN run-sensors (both ship core).
      // Captured PostToolUse write inputs are empty, so the file path comes
      // from the toolResult prose.
      //
      // A FAILED write must not be audited as a successful artifact update
      // (#417): the 0.12 channel sets toolSuccess=false and toolResult carries
      // error prose, and relying on that prose failing to match
      // extractWrittenPath's patterns is implicit — guard it explicitly. Only
      // false is treated as a failure; an absent success flag (the 1.x stdin
      // channel carries none) falls through to the path check so an
      // unknown-shape payload is never silently dropped here.
      if (ide.toolSuccess === false) return null;
      // A payload target that ends up with NO context at all means acquisition
      // failed on both channels (stdin raced out AND USER_PROMPT was empty) —
      // a broken channel, not a legitimate no-op. Record a visible drop before
      // the tool-name check so `--doctor` can surface it; falling through would
      // exit silently at `canon === ""`, which is exactly the invisible-decay
      // failure class this harness exists to eliminate. Distinguished from a
      // non-write tool name (which DOES carry context and is a real no-op).
      if (!ide.toolName && (ide.toolResult ?? "").trim() === "") {
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          "audit-and-sensors: empty hook context (no stdin payload, no USER_PROMPT) — write not audited",
        );
        return null;
      }
      const canon = canonicalWriteTool(ide.toolName ?? "");
      if (canon === "") return null;
      const rawPath = extractWrittenPath(ide.toolResult ?? "");
      if (!rawPath) {
        // TWO DISTINCT CASES REACH HERE, and conflating them is what made the
        // drop log useless as a health signal:
        //   (a) The write FAILED. There is no artifact to audit, so not
        //       forwarding is CORRECT, not decay. The 1.x stdin channel carries
        //       no success flag (so the `toolSuccess === false` guard above
        //       cannot catch it), and the failure arrives only as error prose —
        //       e.g. a str_replace whose old string matched multiple times.
        //   (b) The write SUCCEEDED but its result wording matched no known
        //       pattern. THIS is the invisible decay this harness exists to
        //       eliminate, and the only case that belongs in the drop log.
        // Recording (a) as a drop made `--doctor` report decay on a workspace
        // whose hooks were working perfectly, which trains the reader to ignore
        // the channel that matters. So classify flagless payloads first: log (a)
        // at debug level and reserve the visible drop for (b). A structured
        // `toolSuccess: true` is authoritative and must never be overridden by
        // defensive prose guesses.
        if (ide.toolSuccess === undefined && isFailedWriteResult(ide.toolResult ?? "")) {
          hookDebug(projectDir, "kiro-adapter", "audit-and-sensors: write failed, nothing to audit", {
            toolName: ide.toolName ?? "?",
            toolResult: (ide.toolResult ?? "").slice(0, 160),
          });
          return null;
        }
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          `audit-and-sensors: ${ide.toolName ?? "?"} yielded no extractable path from toolResult: ${(ide.toolResult ?? "").slice(0, 120)}`,
        );
        return null;
      }
      // Kiro IDE reports the path RELATIVE to the workspace root; the core hooks
      // compare against an ABSOLUTE record root, so resolve it here. Absolute
      // paths (defensive) pass through untouched.
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(projectDir, rawPath);
      return {
        hook: "__audit_and_sensors__", // handled specially below (two hooks)
        input: {
          hook_event_name: "PostToolUse",
          tool_name: canon,
          tool_input: { file_path: filePath },
        },
      };
    }

    case "rebuild-stage-graph": {
      // The IDE does not surface the shell command (toolResult is only
      // stdout+exit), so the command filter cannot run here. The
      // ide-audit-sync marker tells the core hook to skip the command filter
      // and gate purely on the audit tail (idempotent + cheap); its own
      // MEMORY_EMPTY emit is not in the transition regex (no recursion).
      return {
        hook: "aidlc-rebuild-stage-graph.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "", source: "ide-audit-sync" },
          session_id: ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
          tool_response: ide.toolResult ?? "",
        },
      };
    }

    case "sync-workflow-state": {
      // Payload-independent. The IDE gives no task payload (toolArgs is empty),
      // so instead of extracting a slug from the tool call, the core hook reads
      // the latest STAGE_STARTED slug from the audit tail and reconciles the
      // state file's Current Stage. The IDE_AUDIT_SYNC marker tells the core
      // hook to take that audit-tail path rather than parse a TaskUpdate.
      return {
        hook: "aidlc-sync-workflow-state.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "TaskUpdate",
          tool_input: { source: "ide-audit-sync" },
        },
      };
    }

    case "log-subagent": {
      // IDE 1.x has emitted both `invoke_sub_agent` and `subagent_<agent>` for
      // real delegate completions (#543, live on 1.0.89-1.0.138).
      //
      // DIVISION OF RESPONSIBILITY: the v2 matcher is deliberately BROAD
      // (`^(subagent_.+|invoke_sub_agent)$`) so a fork-added delegate whose
      // name does not end in `-agent` still reaches this adapter; narrowing the
      // regex there would silently drop those completions. The exclusion of
      // `subagent_response` — the empty "Response recorded." shell that carries
      // non-empty prose but no identity, and would otherwise fabricate a
      // SUBAGENT_COMPLETED row with `Agent Type: unknown` — lives HERE, where it
      // also covers the direct and dispatcher entry points that bypass the
      // matcher entirely.
      const toolName = ide.toolName ?? "";
      const result = ide.toolResult ?? "";
      // A completely empty context means acquisition failed on both channels.
      // Check it before the tool-name gate; otherwise the empty name returns as
      // a legitimate non-delegate no-op and the broken channel stays invisible.
      if (toolName === "" && result.trim() === "") {
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          "log-subagent: empty hook context (no stdin payload, no USER_PROMPT) — SUBAGENT_COMPLETED not recorded",
        );
        return null;
      }

      const isSubagentCompletion =
        toolName === "invoke_sub_agent" ||
        (toolName.startsWith("subagent_") && toolName !== "subagent_response");
      if (!isSubagentCompletion) return null;

      // Identity comes from the structured `subagent_<agent>` tool name when the
      // platform supplies one, and only otherwise from the result's
      // `**Reviewer:**` / `**Agent:**` prose (#459) — the sole signal on the 0.12
      // `invoke_sub_agent` shape. Agent-authored prose must not override a
      // platform-provided identity. Forward the result text so
      // SUBAGENT_COMPLETED also carries an output snippet.
      //
      // An EMPTY result on an otherwise recognized completion must NOT
      // fabricate a real SUBAGENT_COMPLETED row. Record a visible drop so
      // --doctor can surface the degradation.
      if (result.trim() === "") {
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          "log-subagent: empty tool payload — SUBAGENT_COMPLETED not recorded",
        );
        return null;
      }
      return {
        hook: "aidlc-log-subagent.ts",
        input: {
          hook_event_name: "SubagentStop",
          agent_type: extractAgentIdentity(result, toolName),
          agent_id: "",
          last_assistant_message: result,
        },
      };
    }

    case "continue-workflow":
      // ADVISORY ONLY ON THIS HARNESS. The IDE's `Stop` trigger cannot block and
      // does not forward the hook's output — matching what
      // aidlc-continue-workflow.json and the kiro-ide guide have always said.
      // Measured live on IDE 1.x with a probe hook: the command RAN (witness
      // file written), and neither its stdout nor its stderr reached the
      // agent's context. The Stop payload is only
      // `{session_id, hook_event_name, cwd}` — no transcript, no turn id. Kiro
      // documents `Stop` outside the blockable set (only PreToolUse,
      // UserPromptSubmit and PreTaskExec can block) and forwards stdout only for
      // SessionStart and UserPromptSubmit. There is no `{"decision":"block"}`
      // contract in Kiro for any trigger; that shape is Claude Code's.
      //
      // So the core hook still runs and its side effects are what matter here:
      // the `continue-workflow.drops` carve-out record and the no-progress
      // counter under `.aidlc-stop-hook/`. Its `{"decision":"block"}` stdout is
      // produced and then discarded by the host. Forwarding-loop enforcement on
      // the IDE therefore rests on the conductor's own Stop protocol, NOT on
      // this hook. (An earlier revision of this comment claimed the block
      // contract was "identical to Claude's". It never was; the probe above
      // settles it.)
      //
      // Kiro also provides no `stop_hook_active`, so the flag defaults to false.
      // That makes decideBlock's `prior === null && stopHookActive` seeding branch
      // unreachable here: a hook joining an already-in-flight block sequence
      // starts its count at 1 instead of 2, i.e. one extra counted block before
      // releasing. The ceiling is run-mode aware (INTERACTIVE_BLOCK_CAP=2,
      // AUTONOMOUS_BLOCK_CAP=8), not the fixed 8 a still earlier revision promised.
      //
      // The absent transcript no longer leaves the conversational carve-out inert:
      // the core hook falls back to the `.aidlc-human-turn` / `.aidlc-engine-touch`
      // mtime comparison, and the `record-human-turn` target above writes the
      // former. On this harness that changes which record
      // `continue-workflow.drops` gets and whether the counter advances — not
      // what the human sees.
      // Modern Stop carries the exact chat identity. Prefer it over the
      // workspace-global SessionStart marker so concurrent chats cannot consume
      // one another's post-create handoff receipt; retain the marker for legacy
      // agentStop and broken modern channels.
      return {
        hook: "aidlc-continue-workflow.ts",
        input: {
          hook_event_name: "Stop",
          stop_hook_active: false,
          session_id: ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
        },
      };

    case "session-end":
      return {
        hook: "aidlc-session-end.ts",
        input: {
          hook_event_name: "SessionEnd",
          reason: "agent_stop",
          session_id: rememberedKiroIdeSessionId(),
        },
      };

    default:
      return null;
  }
}

function runCore(hookFile: string, input: Record<string, unknown>): { stdout: string; code: number } {
  // Reuse the exact bun binary running this adapter; the child must not depend on
  // PATH containing bun (the hook environment often lacks the bun install dir).
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
    : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(JSON.stringify(input), "utf-8"),
    stdout: "pipe",
    stderr: "ignore",
  });
  return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
}

const fwd = buildForward();
if (fwd === null) {
  hookDebug(projectDir, "kiro-adapter", "forward: null (no-op)", { target });
  return 0;
}
hookDebug(projectDir, "kiro-adapter", "forward", {
  target,
  hook: fwd.hook,
  tool_name: fwd.input.tool_name ?? "",
  file_path: (fwd.input.tool_input as { file_path?: string } | undefined)?.file_path ?? "",
});

if (fwd.hook === "__audit_and_sensors__") {
  // Two core hooks ride the same write event, in audit-then-sensors order
  // (mirrors the Claude settings.json registration). Both advisory: exit 0.
  runCore("aidlc-write-audit-log.ts", fwd.input);
  runCore("aidlc-run-sensors.ts", fwd.input);
  return 0;
}

const result = runCore(fwd.hook, fwd.input);

if (target === "session-start") {
  // Unwrap {"additionalContext": ...} → plain text on stdout (Kiro's context
  // channel). Anything unparseable passes through untouched.
  try {
    const parsed = JSON.parse(result.stdout) as { additionalContext?: string };
    if (parsed.additionalContext) {
      process.stdout.write(parsed.additionalContext);
    }
  } catch {
    if (result.stdout) process.stdout.write(result.stdout);
  }
  return 0;
}

// Preserve the core hook's stdout and exit code for passthrough targets. On
// Kiro IDE 1.x the host discards Stop-hook output, so this relay does not imply
// a shared `{"decision":"block","reason"}` contract.
if (result.stdout) process.stdout.write(result.stdout);
return result.code;
}

// The broken-channel ceiling for the 1.x stdin read. 2s in production; the
// AIDLC_IDE_STDIN_TIMEOUT_MS seam lets the latency tests raise it far above any
// plausible CI scheduling delay, so "did this path probe stdin at all?" becomes
// a deterministic assertion instead of a tight millisecond budget.
function stdinTimeoutMs(): number {
  const override = Number(process.env.AIDLC_IDE_STDIN_TIMEOUT_MS ?? "");
  return Number.isFinite(override) && override > 0 ? override : 2000;
}

async function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((settle) => {
        timeout = setTimeout(() => settle(""), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

if (import.meta.main) {
  const target = process.argv[2] ?? "";
  // Acquire input only for targets that need tool payload or session identity. A non-empty
  // USER_PROMPT identifies the 0.12 channel and is consumed immediately: that
  // IDE leaves stdin open forever, so probing stdin first imposed a mandatory
  // 2s delay on every payload hook. IDE 1.x sends USER_PROMPT empty and writes
  // + closes stdin; retain the timeout only as a defensive broken-channel
  // ceiling. Every other target skips both channels (zero latency).
  let input = "";
  if (INPUT_TARGETS.has(target)) {
    const legacyPayload = process.env.USER_PROMPT ?? "";
    if (legacyPayload.trim().length > 0) {
      input = legacyPayload;
    } else if (!process.stdin.isTTY) {
      try {
        input = await readStdinWithTimeout(stdinTimeoutMs());
      } catch {
        input = "";
      }
    }
  }
  process.exit(await run(target, input, process.argv.slice(3)));
}
