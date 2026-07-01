#!/usr/bin/env bun
// aidlc-kiro-adapter.ts — the Kiro CLI hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness).
//
// Kiro hook payloads are near-isomorphic to Claude Code's but differ in
// three load-bearing ways (live-captured on kiro-cli 2.6.1 — see
// docs/spikes/dist-kiro/findings.md §0.2 in the framework repo):
//   1. tool_name arrives as the ALIAS: `shell` (execute_bash), `write`
//      (fs_write).
//   2. the write payload's file path field is `path`, not `file_path`.
//   3. `todo_list` input is command-shaped ({command: "create", tasks:
//      [{task_description}]}) — there is no status/activeForm transition.
//
// This shim normalizes a Kiro payload into the ClaudeCodeHookInput shape the
// core hooks parse, then pipes it into the named core hook (same directory)
// as a bun subprocess, forwarding stdout and the exit code. Two outputs need
// post-processing:
//   - session-start emits {"additionalContext": "..."} — Kiro's context
//     channel is plain stdout at exit 0, so the shim unwraps the JSON and
//     prints the text.
//   - stop emits {"decision":"block","reason":"..."} — Kiro's stop contract
//     is IDENTICAL (verified live), so it passes through verbatim.
//
// Usage (registered in .kiro/agents/aidlc.json):
//   bun .kiro/hooks/aidlc-kiro-adapter.ts <target>
// where <target> ∈ session-start | audit-and-sensors | runtime-compile |
//                  state-sync | log-subagent | stop

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasOpenGate,
  humanActedSinceGate,
  humanPresenceGuardDisabled,
  isAutonomousMode,
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import { existsSync, readFileSync } from "node:fs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? "";

interface KiroHookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  assistant_response?: string;
}

let kiro: KiroHookInput = {};
if (!process.stdin.isTTY) {
  try {
    // Race stdin against a timeout. The IDE may open stdin but never write or
    // close it, causing Bun.stdin.text() to hang forever. A 2s timeout covers
    // the CLI case (payload arrives instantly) and avoids blocking the IDE.
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 2000)),
    ]);
    if (text.length > 0) kiro = JSON.parse(text) as KiroHookInput;
  } catch {
    process.exit(0); // malformed stdin — advisory hooks fail open
  }
}

// --- mint: record a HUMAN_TURN event on prompt submit ---
//
// Wired by aidlc-mint.kiro.hook (promptSubmit). stdin is empty on Kiro IDE (the
// race-to-2s above), so this carries NO intent context - but appendAuditEntry
// resolves the active intent from the on-disk cursor
// (aidlc/spaces/<space>/intents/active-intent) using only cwd, so the event lands
// in the correct per-intent shard with no payload. One ledger event per human
// turn; no marker file, no turn counter. Gated on workflow state existing (same
// self-gate as the core mint hook) so a prompt in a project that never ran the
// framework does not scaffold audit shards. Fail-open (try/catch, exit 0) so a
// mint failure never blocks the human's turn.
if (target === "mint") {
  try {
    const pd = kiro.cwd ?? process.cwd();
    if (existsSync(stateFilePath(pd))) {
      appendAuditEntry("HUMAN_TURN", {}, pd);
    }
  } catch {
    /* advisory - mint never blocks the turn */
  }
  process.exit(0);
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
// off-switch. All read from disk (empty stdin is fine). Fail-open on any
// read/parse error (advisory).
if (target === "block") {
  try {
    const pd = kiro.cwd ?? process.cwd();
    const sp = stateFilePath(pd);
    const content = existsSync(sp) ? readFileSync(sp, "utf-8") : null;
    // Carve-outs first: autonomous Construction, the deterministic off-switch,
    // and no-open-gate (nothing awaits approval, so nothing to floor).
    if (isAutonomousMode(content)) process.exit(0);
    if (humanPresenceGuardDisabled()) process.exit(0);
    if (!hasOpenGate(content)) process.exit(0);
    if (humanActedSinceGate(pd)) process.exit(0); // a human acted at this gate
    process.stderr.write(
      "An approval gate is open and no human has acted since it opened. The gate " +
        "requires a typed human turn before any tool call proceeds. Acknowledge the " +
        "gate as a human, then continue.\n",
    );
    process.exit(2); // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  } catch {
    process.exit(0); // advisory - any read/parse failure fails open
  }
}

// Normalize Kiro's alias tool names to the canonical names the core hooks
// match on. Both alias and canonical forms are accepted defensively.
function canonicalTool(name: string): string {
  if (name === "write" || name === "fs_write") return "Write";
  if (name === "shell" || name === "execute_bash") return "Bash";
  return name;
}

type Forward = { hook: string; input: Record<string, unknown> } | null;

function buildForward(): Forward {
  const tool = canonicalTool(kiro.tool_name ?? "");
  const ti = kiro.tool_input ?? {};

  switch (target) {
    case "session-start":
      // agentSpawn carries no source discrimination — every spawn is a
      // startup from the core hook's perspective; its state-file self-gate
      // makes this a no-op outside active workflows.
      return {
        hook: "aidlc-session-start.ts",
        input: { hook_event_name: "SessionStart", source: "startup" },
      };

    case "audit-and-sensors": {
      // postToolUse(write) → audit-logger THEN sensor-fire (both ship core).
      if (tool !== "Write") return null;
      const filePath = (ti.path as string) ?? (ti.file_path as string) ?? "";
      if (!filePath) return null;
      return {
        hook: "__audit_and_sensors__", // handled specially below (two hooks)
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: filePath },
        },
      };
    }

    case "runtime-compile": {
      if (tool !== "Bash") return null;
      return {
        hook: "aidlc-runtime-compile.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: (ti.command as string) ?? "" },
        },
      };
    }

    case "state-sync": {
      // Kiro's todo_list is command-shaped. A `create` whose first task
      // description carries the stage-protocol "[slug]" suffix maps to the
      // Claude TaskUpdate in_progress transition the core hook keys on.
      if ((kiro.tool_name ?? "") !== "todo_list") return null;
      if ((ti.command as string) !== "create") return null;
      const tasks = (ti.tasks as Array<{ task_description?: string }>) ?? [];
      const desc = tasks[0]?.task_description ?? "";
      if (!desc) return null;
      return {
        hook: "aidlc-sync-statusline.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "TaskUpdate",
          tool_input: { status: "in_progress", activeForm: desc },
        },
      };
    }

    case "log-subagent": {
      if ((kiro.tool_name ?? "") !== "subagent") return null;
      const stages = (ti.stages as Array<{ role?: string }>) ?? [];
      const roles = [...new Set(stages.map((s) => s.role ?? "unknown"))].join(",");
      return {
        hook: "aidlc-log-subagent.ts",
        input: {
          hook_event_name: "SubagentStop",
          agent_type: roles || "unknown",
          agent_id: kiro.session_id ?? "",
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
  const r = Bun.spawnSync(["bun", join(HOOKS_DIR, hookFile)], {
    stdin: Buffer.from(JSON.stringify(input), "utf-8"),
    stdout: "pipe",
    stderr: "ignore",
  });
  return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
}

const fwd = buildForward();
if (fwd === null) {
  process.exit(0);
  throw new Error("unreachable"); // narrows fwd for TS below
}

if (fwd.hook === "__audit_and_sensors__") {
  // Two core hooks ride the same write event, in audit-then-sensors order
  // (mirrors the Claude settings.json registration). Both advisory: exit 0.
  runCore("aidlc-audit-logger.ts", fwd.input);
  runCore("aidlc-sensor-fire.ts", fwd.input);
  process.exit(0);
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
  process.exit(0);
}

// stop (and any future passthrough target): forward stdout + exit code
// verbatim — the {"decision":"block","reason"} contract is shared.
if (result.stdout) process.stdout.write(result.stdout);
process.exit(result.code);
