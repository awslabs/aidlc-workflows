#!/usr/bin/env bun
// aidlc-kiro-adapter.ts — the Kiro IDE hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). This is the IDE-specific adapter; the CLI harness ships
// its own (harness/kiro/) which reads stdin. They are deliberately separate
// files so neither carries a runtime "am I CLI or IDE?" branch.
//
// Kiro IDE hook context (live-captured on Kiro IDE 0.12-main — see
// docs/reference/kiro-ide-hook-payload.md):
//   1. stdin is OPENED BUT NEVER WRITTEN/CLOSED — reading it hangs. The IDE
//      delivers context through the `USER_PROMPT` environment variable instead.
//   2. USER_PROMPT is JSON: { toolName, toolArgs, toolResult, toolSuccess }.
//      `toolArgs` is ALWAYS empty {} — the IDE never passes tool inputs. So the
//      file path is recoverable ONLY from the `toolResult` prose, and the shell
//      command is not recoverable at all (toolResult carries only stdout+exit).
//   3. toolName arrives as the IDE tool name: `fs_write`, `str_replace`,
//      `fs_append`, `execute_bash`, etc.
//
// Consequences, by target:
//   - audit-and-sensors: scrape the written file path from toolResult prose
//     (strict patterns, fail-open) and feed the core hooks the Claude-shaped
//     {tool_input:{file_path}}.
//   - runtime-compile: the command is unrecoverable, so drop the command
//     filter and always forward — the core hook self-gates on the audit tail.
//   - state-sync: payload-independent — the core hook reads the latest
//     STAGE_STARTED slug from the audit tail (no task payload needed).
//   - session-start/session-end/stop/log-subagent: no file path / command
//     needed; build the same fixed inputs as before.
//
// session-start emits {"additionalContext": "..."} — Kiro's context channel is
// plain stdout at exit 0, so the shim unwraps the JSON and prints the text.
// stop emits {"decision":"block","reason":"..."} — passed through verbatim.
//
// Usage (registered in .kiro/hooks/*.kiro.hook):
//   bun .kiro/hooks/aidlc-kiro-adapter.ts <target>
// where <target> ∈ session-start | audit-and-sensors | runtime-compile |
//                  state-sync | log-subagent | stop | session-end

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasOpenGate,
  hookDebug,
  humanActedSinceGate,
  humanPresenceGuardDisabled,
  isAutonomousMode,
  recordHookDrop,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import { existsSync, readFileSync } from "node:fs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

// The IDE hands hook context via the USER_PROMPT env var (NOT stdin). Shape:
//   { toolName, toolArgs (always {}), toolResult, toolSuccess }
interface IdeHookContext {
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolSuccess?: boolean;
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
void input;
// LOAD-BEARING (not debug-only): this is the base dir for resolve(projectDir,
// rawPath) that turns the IDE's workspace-relative write path into the absolute
// path the core audit-logger's record-root check needs — the core fix of this
// harness. It also feeds hookDebug/recordHookDrop. Do not remove it.
const projectDir = resolveProjectDirFromHook(import.meta.url);

let ide: IdeHookContext = {};
{
  const raw = process.env.USER_PROMPT ?? "";
  if (raw.length > 0) {
    try {
      ide = JSON.parse(raw) as IdeHookContext;
    } catch {
      // Malformed context — advisory hooks fail open.
      ide = {};
    }
  }
}
hookDebug(projectDir, "kiro-adapter", "invoked", {
  target,
  hasUserPrompt: (process.env.USER_PROMPT ?? "").length > 0,
  toolName: ide.toolName ?? "",
  toolResult: (ide.toolResult ?? "").slice(0, 160),
});

// --- mint: record a HUMAN_TURN event on prompt submit ---
//
// Wired by aidlc-mint.kiro.hook (promptSubmit). The IDE delivers no cwd payload
// (context arrives via USER_PROMPT, which carries no project dir), so resolve
// the project dir from process.cwd() — appendAuditEntry then resolves the
// active intent from the on-disk cursor (aidlc/spaces/<space>/intents/active-intent)
// using only that dir, so the event lands in the correct per-intent shard with
// no payload. One ledger event per human turn; no marker file, no turn counter.
// Gated on workflow state existing (same self-gate as the core mint hook) so a
// prompt in a project that never ran the framework does not scaffold audit
// shards. Fail-open (try/catch, exit 0) so a mint failure never blocks the
// human's turn.
if (target === "mint") {
  try {
    const pd = process.cwd();
    if (existsSync(stateFilePath(pd))) {
      appendAuditEntry("HUMAN_TURN", {}, pd);
    }
  } catch {
    /* advisory - mint never blocks the turn */
  }
  return 0;
}

// --- block: the preToolUse human-presence floor ---
//
// Wired by aidlc-block.kiro.hook (preToolUse). Hard-blocks tool calls ONLY while
// an approval gate is actually OPEN (a stage sits at [?] in the state file) and
// no HUMAN_TURN has been recorded since the last gate resolution - the exit-2
// floor behind the core handleApprove check. The gate-open predicate is
// load-bearing: after a legitimate approval the resolution follows the turn's
// HUMAN_TURN, and without it the floor would block the mandated same-turn
// continuation into the next stage. Carve-outs mirror the core gate: autonomous
// Construction (swarm/Bolt has no human at the gate) and the deterministic
// off-switch. The IDE gives no cwd payload, so the project dir is process.cwd().
// All read from disk. Fail-open on any read/parse error (advisory).
if (target === "block") {
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
// IDE's toolResult prose. toolArgs is always empty, so this is the ONLY source.
// Only the known Kiro wordings match; anything else returns "" so the caller
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

// Map the IDE tool name to the canonical name the core hooks match on. Write
// creates a (possibly new) file; str_replace/fs_append always target an
// existing file → Edit (forces ARTIFACT_UPDATED in the core audit-logger).
function canonicalWriteTool(name: string): "Write" | "Edit" | "" {
  if (name === "fs_write") return "Write";
  if (name === "str_replace" || name === "fs_append") return "Edit";
  return "";
}

// Recover the delegated agent's identity from its result text (#459). The IDE
// surfaces no structured subagent roster, but the framework's delegation-target
// agents self-identify on the first non-empty line as `**Reviewer:** <name>` or
// `**Agent:** <name>` (the workaround pinned in issue #459). Scan the first few
// lines for that marker; return "unknown" when none is present so the core
// hook's default still applies. The captured name is trimmed of any trailing
// markdown emphasis.
function extractAgentIdentity(toolResult: string): string {
  const lines = toolResult.split("\n").slice(0, 8);
  for (const line of lines) {
    const m = line.match(/^\s*\*\*(?:Reviewer|Agent)\s*:\*\*\s*(.+?)\s*$/);
    if (m) return m[1].replace(/\*+$/, "").trim() || "unknown";
  }
  return "unknown";
}

type Forward = { hook: string; input: Record<string, unknown> } | null;

function buildForward(): Forward {
  switch (target) {
    case "session-start":
      // promptSubmit carries no source discrimination — every submit is a
      // startup from the core hook's perspective; its state-file self-gate
      // makes this a no-op outside active workflows.
      return {
        hook: "aidlc-session-start.ts",
        input: { hook_event_name: "SessionStart", source: "startup" },
      };

    case "audit-and-sensors": {
      // postToolUse(write) → audit-logger THEN sensor-fire (both ship core).
      // The file path comes from the toolResult prose (toolArgs is empty).
      //
      // A FAILED write must not be audited as a successful artifact update
      // (#417): the IDE sets toolSuccess=false and toolResult carries error
      // prose, and relying on that prose failing to match extractWrittenPath's
      // patterns is implicit — guard it explicitly. Only false is treated as a
      // failure; an absent toolSuccess (defensive) falls through to the path
      // check so an unknown-shape payload is never silently dropped here.
      if (ide.toolSuccess === false) return null;
      const canon = canonicalWriteTool(ide.toolName ?? "");
      if (canon === "") return null;
      const rawPath = extractWrittenPath(ide.toolResult ?? "");
      if (!rawPath) {
        // A write-class tool ran but its toolResult wording did not match any
        // known pattern → the write is dropped from audit + sensors. Record a
        // visible drop (finding 4) so `--doctor` can surface the decay instead
        // of it being an invisible no-op — the exact failure class this harness
        // exists to eliminate.
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

    case "runtime-compile": {
      // The IDE does not surface the shell command (toolResult is only
      // stdout+exit), so the command filter cannot run here. The
      // ide-audit-sync marker tells the core hook to skip the command filter
      // and gate purely on the audit tail (idempotent + cheap); its own
      // MEMORY_EMPTY emit is not in the transition regex (no recursion).
      return {
        hook: "aidlc-runtime-compile.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "", source: "ide-audit-sync" },
        },
      };
    }

    case "state-sync": {
      // Payload-independent. The IDE gives no task payload (toolArgs is empty),
      // so instead of extracting a slug from the tool call, the core hook reads
      // the latest STAGE_STARTED slug from the audit tail and reconciles the
      // state file's Current Stage. The IDE_AUDIT_SYNC marker tells the core
      // hook to take that audit-tail path rather than parse a TaskUpdate.
      return {
        hook: "aidlc-sync-statusline.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "TaskUpdate",
          tool_input: { source: "ide-audit-sync" },
        },
      };
    }

    case "log-subagent": {
      // The IDE surfaces no structured subagent roster, but the delegate
      // self-identifies on the first line of its result (`**Reviewer:** <name>`
      // / `**Agent:** <name>`, #459). Recover that identity rather than
      // hardcoding "unknown", and forward the result text as the message so
      // SUBAGENT_COMPLETED carries the real agent and a snippet of its output.
      // (The .kiro.hook already filters to invoke_sub_agent, so there is no
      // tool-name gate here — dropping it is what revives the event on the IDE.)
      const result = ide.toolResult ?? "";
      return {
        hook: "aidlc-log-subagent.ts",
        input: {
          hook_event_name: "SubagentStop",
          agent_type: extractAgentIdentity(result),
          agent_id: "",
          last_assistant_message: result,
        },
      };
    }

    case "stop":
      // Kiro provides no stop_hook_active signal; the core hook's own
      // 8-block no-progress ceiling is the loop guard (it defaults the flag
      // to false). The {"decision":"block"} stdout contract is identical.
      return {
        hook: "aidlc-stop.ts",
        input: { hook_event_name: "Stop", stop_hook_active: false },
      };

    case "session-end":
      return {
        hook: "aidlc-session-end.ts",
        input: { hook_event_name: "SessionEnd", reason: "agent_stop" },
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
  runCore("aidlc-audit-logger.ts", fwd.input);
  runCore("aidlc-sensor-fire.ts", fwd.input);
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

// stop (and any future passthrough target): forward stdout + exit code
// verbatim — the {"decision":"block","reason"} contract is shared.
if (result.stdout) process.stdout.write(result.stdout);
return result.code;
}

if (import.meta.main) {
  const input = (process.env.USER_PROMPT ?? "").length > 0 ? "" : await Bun.stdin.text();
  process.exit(await run(process.argv[2] ?? "", input, process.argv.slice(3)));
}
