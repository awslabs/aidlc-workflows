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
    const text = await Bun.stdin.text();
    if (text.length > 0) kiro = JSON.parse(text) as KiroHookInput;
  } catch {
    process.exit(0); // malformed stdin — advisory hooks fail open
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
      // session_id is forwarded when present so the core hook writes its
      // per-session→intent STAMP (the session→intent record). BUT agentSpawn
      // carries no source discrimination — every spawn reports as "startup"
      // from the core hook's perspective (Kiro has no resume signal in this
      // payload), so SESSION_RESUMED can never fire and the P8 resume-rebind
      // OFFER is structurally unreachable on Kiro — a documented harness
      // limitation, not a bug. We never fake a resume source. The state-file
      // self-gate keeps the whole thing a no-op outside active workflows.
      return {
        hook: "aidlc-session-start.ts",
        input: {
          hook_event_name: "SessionStart",
          source: "startup",
          ...(kiro.session_id ? { session_id: kiro.session_id } : {}),
        },
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
