#!/usr/bin/env bun
// aidlc-devin-adapter.ts — the ONLY hand-authored file in the V2 Devin package.
//
// WHY THIS EXISTS, and why it is thin.
//
// Devin's hook contract is already Claude Code's contract: same event names, same
// stdin envelope (`hook_event_name`, `tool_name`, `tool_input`, `session_id`), same
// stdout envelope (`decision`/`reason`, `hookSpecificOutput.additionalContext`,
// `hookSpecificOutput.updatedInput`), and the same "exit 2 blocks, reason on stderr"
// convention. Devin even reads Claude Code's HOOKS by default: per the hooks
// overview's "Where Hooks Live", `.claude/settings.json`,
// `.claude/settings.local.json`, `~/.claude.json`, `~/.claude/settings.json` and
// `~/.claude/settings.local.json` are all hook sources, "loaded when
// `read_config_from.claude` is enabled (the default)". (The read-config-from
// page's own table omits hooks; it is incomplete, not authoritative.)
//
// CONSEQUENCE worth knowing: a project carrying BOTH an AI-DLC Claude install and
// this one would load both hook sets in a Devin session and DOUBLE-WRITE the audit
// ledger. Installing one harness per project avoids it; `read_config_from.claude:
// false` is the escape hatch, and it is the user's call, not ours.
//
// So unlike the Codex adapter (which reshapes a genuinely foreign payload), this
// adapter exists for exactly ONE reason: TOOL NAMES.
//
// Devin names tools in lowercase snake_case (`exec`, `edit`, `grep`, `run_subagent`).
// Three CORE hooks compare `tool_name` against Claude's PascalCase names INTERNALLY,
// not just via the matcher:
//
//   aidlc-review-freeze.ts:652          if (toolName === "Bash")
//   aidlc-reviewer-scope.ts:655,659,739 "Grep" / "Glob" / a 10-name allowlist
//   aidlc-state-transition-guard.ts:946 if (parsed.tool_name !== "Bash") return 0
//
// Fixing only the matchers in hooks.v1.json would leave those three hooks LOADED,
// MATCHING, and SILENTLY NO-OP — enforcement that looks installed and does nothing.
// That is the failure mode this file prevents.
//
// It also normalises the project-dir env var: Devin sets DEVIN_PROJECT_DIR; the core
// hooks read AIDLC_PROJECT_DIR.
//
// Everything else is passed through untouched, including exit codes and stderr.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The adapter's ONLY non-builtin import, and it exists so the picker deny below
// reuses the shared selection resolution instead of re-deriving active-space /
// active-intent / session-binding rules inline. Re-deriving them is how a harness
// drifts from the engine. Copilot's adapter pays the same cost for the same reason.
import { resolveWorkflowSelection, stateFilePathForSelection } from "../tools/aidlc-lib.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Devin tool name -> Claude tool name.
//
// Sources: Devin's matchable tool list (docs.devin.ai/cli/extensibility/hooks/
// lifecycle-hooks "Tool names you can match") mapped onto the names the core hooks
// compare against. The Devin side of this table is DOCUMENTED; the correspondence
// is our mapping and is the thing to re-check when Devin adds tools.
//
// `apply_patch` -> "Edit": it is Devin's structured file-edit tool, so the core
// hooks' Edit handling is the correct destination (Codex's adapter makes the same
// call for the same reason).
// ---------------------------------------------------------------------------
const TOOL_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  notebook_read: "NotebookRead",
  notebook_edit: "NotebookEdit",
  grep: "Grep",
  glob: "Glob",
  exec: "Bash",
  get_output: "Bash",
  write_to_process: "Bash",
  kill_shell: "Bash",
  webfetch: "WebFetch",
  todo_write: "TaskUpdate",
  exit_plan_mode: "ExitPlanMode",
  skill: "Skill",
  run_subagent: "Task",
  read_subagent: "Task",
  request_scope: "RequestScope",
};

// Devin's MCP tools use the same `mcp__<server>__<tool>` shape as Claude, so they
// pass through unmapped by design.
function mapToolName(name: string | undefined): string | undefined {
  if (!name) return name;
  if (name.startsWith("mcp__")) return name;
  return TOOL_MAP[name] ?? name;
}

const subcommand = process.argv[2] ?? "";

// Advisory-by-default: a malformed or absent payload must never block the agent.
let raw = "";
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}

let payload: Record<string, unknown> = {};
if (raw.trim().length > 0) {
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    process.exit(0); // unparseable stdin -> fail open
  }
}

// Devin's native structured-question pickers. Kept SEPARATE from emit.ts's
// DEVIN_TOOL_NAMES on purpose: `ask_user_question` is NOT a documented matchable
// name, so naming it in a hooks.v1.json matcher is build-rejected. The picker is
// therefore governed here, on the matcher-free PreToolUse arm, which fires for
// every tool without naming any. Aliases are included because the deny must not
// depend on one spelling surviving a rename.
export const DEVIN_QUESTION_PICKERS = new Set([
  "ask_user_question",
  "ask_user",
  "askUserQuestion",
]);

// --- the one translation -----------------------------------------------------
const devinTool = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
const mapped = mapToolName(devinTool);
if (mapped && mapped !== devinTool) payload.tool_name = mapped;

// Devin sets DEVIN_PROJECT_DIR; core hooks read AIDLC_PROJECT_DIR.
const projectDir =
  process.env.AIDLC_PROJECT_DIR ??
  process.env.DEVIN_PROJECT_DIR ??
  process.cwd();

const childEnv = {
  ...process.env,
  AIDLC_PROJECT_DIR: projectDir,
  // Record which host we are, so core hooks and the audit trail can attribute
  // behaviour to Devin rather than to Claude Code.
  AIDLC_HOST: "devin",
};

// Events Devin does NOT have. Kept as an explicit, greppable record so the gap is
// visible in the package rather than only in a design doc:
//   SubagentStop -> NO EQUIVALENT. `aidlc-log-subagent` cannot fire per subagent.
//                   `PostToolUse` on run_subagent is unreliable for BACKGROUNDED
//                   subagents (the parent's tool call has already returned).
//   PreCompact    -> Devin has PostCompaction only, which fires AFTER a successful
//                   compaction. `aidlc-validate-state` therefore runs post hoc; it
//                   cannot inspect or veto a compaction, and nothing fires if the
//                   compaction fails.
//   Notification  -> NO EQUIVALENT.
const CORE: Record<string, { file: string; stderr: boolean }> = {
  "session-start":          { file: "aidlc-session-start.ts",          stderr: false },
  "session-end":            { file: "aidlc-session-end.ts",            stderr: false },
  "record-human-turn":      { file: "aidlc-record-human-turn.ts",      stderr: false },
  "deliver-stage-rules":    { file: "aidlc-deliver-stage-rules.ts",    stderr: true  },
  "state-transition-guard": { file: "aidlc-state-transition-guard.ts", stderr: true  },
  "reviewer-scope":         { file: "aidlc-reviewer-scope.ts",         stderr: true  },
  "review-freeze":          { file: "aidlc-review-freeze.ts",          stderr: true  },
  "plan-approval-guard":    { file: "aidlc-plan-approval-guard.ts",    stderr: true  },
  "audit-and-sensors":      { file: "aidlc-write-audit-log.ts",        stderr: false },
  "run-sensors":            { file: "aidlc-run-sensors.ts",            stderr: false },
  "sync-workflow-state":    { file: "aidlc-sync-workflow-state.ts",    stderr: false },
  "rebuild-stage-graph":    { file: "aidlc-rebuild-stage-graph.ts",    stderr: false },
  "validate-state":         { file: "aidlc-validate-state.ts",         stderr: false },
  // Devin has no SubagentStop event, so this rides PostToolUse on the delegation
  // tools instead. That covers FOREGROUND delegates - the parent waits for those,
  // so the tool result is the completion - and misses BACKGROUNDED ones, whose
  // call has already returned. Partial coverage beats none: devin was the only
  // one of the eight harnesses dispatching this hook nowhere at all (kiro and
  // kiro-ide match `.*invoke_sub_agent.*`, opencode uses `tool.execute.after task`).
  "log-subagent":           { file: "aidlc-log-subagent.ts",           stderr: false },
  "continue-workflow":      { file: "aidlc-continue-workflow.ts",      stderr: true  },
};

const target = CORE[subcommand];
if (!target) {
  // Unknown subcommand: fail open rather than block a turn on a packaging slip.
  process.exit(0);
}

// --- log-subagent fires for a DELEGATION, never for a read -------------------
// aidlc-log-subagent.ts appends SUBAGENT_COMPLETED unconditionally: no dedupe, no
// per-delegate key. So the number of times this arm runs IS the number of events in
// an append-only ledger. `read_subagent` is a poll -- an agent may read one
// backgrounded delegate repeatedly, and its payload carries no agent_type, so each
// read would log a duplicate completion attributed to "unknown".
//
// The matcher in emit.ts is already `^run_subagent$`; this is the second line of
// defence, because a widened matcher would corrupt audit history silently rather
// than fail a test. Note mapToolName has already rewritten payload.tool_name to
// "Task", so the ORIGINAL Devin name is the only thing that can be checked here.
if (subcommand === "log-subagent" && devinTool !== "run_subagent") {
  process.exit(0);
}

// --- deny the native picker while a workflow is running ----------------------
// A picker answer arrives as a TOOL RESULT, not a submitted message, so it never
// fires UserPromptSubmit and never mints HUMAN_TURN. Left available, the model
// would ask, receive an answer, and then find answer/approval logging refusing
// the selection - so the question gets asked again. Two Devin-specific facts make
// this a correctness rule rather than a presentation preference: a picker question
// can be SKIPPED without blocking progress (CLI v3000.3.22), and answered prompts
// are revertable via /steps (v3000.4.16) while the audit ledger is append-only.
//
// Rides `deliver-stage-rules` because that is the matcher-free arm; see
// DEVIN_QUESTION_PICKERS above for why a named matcher is not an option.
// FAILS OPEN in every uncertain case: no workflow, unreadable state, any throw.
if (subcommand === "deliver-stage-rules" && devinTool && DEVIN_QUESTION_PICKERS.has(devinTool)) {
  let running = false;
  try {
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
    const selection = resolveWorkflowSelection(projectDir, sessionId ? { sessionId } : {});
    const stateContent = readFileSync(stateFilePathForSelection(projectDir, selection), "utf-8");
    running = stateContent.match(/^- \*\*Status\*\*:\s*(\S+)\s*$/m)?.[1] === "Running";
  } catch {
    running = false; // fail open
  }
  if (running) {
    // Devin's own documented block channel (exit 0 + decision on stdout). NOT
    // Copilot's hookSpecificOutput.permissionDecision, which is undocumented here.
    process.stdout.write(`${JSON.stringify({
      decision: "block",
      reason:
        "Render this AI-DLC question as numbered prose in chat per question-rendering.md, " +
        "then end the turn and wait for the user's next chat message. ask_user_question " +
        "answers arrive as a tool result and do not fire the trusted UserPromptSubmit event " +
        "that records HUMAN_TURN, so answer and approval logging would refuse the selection.",
    })}\n`);
    process.exit(0);
  }
}

const input = JSON.stringify(payload);
// Under the compiled single-binary release the `.ts` hook bodies are not on disk,
// so spawning a path inside HOOKS_DIR would fail and (with `process.exit(r.status
// ?? 0)` below) could surface a spawn failure as a BLOCK. Every other adapter
// reads this env var; devin was the only one that did not.
const compiled = process.env.AIDLC_COMPILED_EXECUTABLE;
const command = compiled
  ? [compiled, "hook", target.file.replace(/^aidlc-|\.ts$/g, "")]
  : [process.execPath, join(HOOKS_DIR, target.file)];
const r = spawnSync(command[0], command.slice(1), {
  input,
  cwd: projectDir,
  env: childEnv,
  encoding: "utf-8",
  stdio: ["pipe", "pipe", target.stderr ? "pipe" : "ignore"],
});

// Pass the core hook's contract straight through. Devin's envelope IS Claude's, so
// no re-wrapping is needed or wanted — re-wrapping is how Codex's adapter had to
// handle a per-event output schema, and doing it here would corrupt valid output.
if (r.stdout) process.stdout.write(r.stdout);
if (target.stderr && r.stderr) process.stderr.write(r.stderr);

// Exit 2 = block, with the reason taken from stderr. Devin adopted Claude Code's
// convention in CLI v3000.3.22, so the core hooks' block channel survives unchanged.
process.exit(r.status ?? 0);
