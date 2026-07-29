#!/usr/bin/env bun
// aidlc-cursor-adapter.ts — the Cursor IDE hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). Modeled on the codex/kiro adapters: ONE shim normalizes
// the Cursor hook payload to the ClaudeCodeHookInput shape the core hooks
// parse, subprocess-pipes into the named core hook, and translates the exit
// contract back to Cursor's.
//
// Cursor's contract differs from Claude Code's in three load-bearing ways
// (system-architecture.md §4.1 + cursor-native-surfaces research, MIT-0):
//   1. Blocking is JSON, not an exit code. A gating hook denies by writing
//      {"permission":"deny", "user_message", "agent_message"} to stdout and
//      exiting 0 (ADR-003). The core hooks signal a block with exit code 2 +
//      stderr, so the shim maps `exit 2 + stderr` → the deny JSON (§1.2 / Flow
//      1.2). snake_case field names are load-bearing — camelCase is silently
//      ignored by Cursor.
//   2. Session init rides `beforeSubmitPrompt` (cloud-agent compatible), not a
//      SessionStart event. The shim maps it to the core SessionStart shape and
//      fires the core hook AT MOST ONCE per conversation_id via a marker file
//      under aidlc/ (Flow 1.1).
//   3. Self-correction rides the `stop` hook's `followup_message` channel, not
//      Claude's {decision:"block"} passthrough. The shim maps the core
//      {decision:"block", reason} → {followup_message: reason} (Flow 3.2).
//
// Fail-open contract (Flow 4.2): every stdin JSON.parse is wrapped in try/catch;
// any parse/read exception exits 0 with empty stdout. Cursor itself enforces
// failClosed on beforeShellExecution/preToolUse (a crash blocks the action),
// but the adapter still exits 0 — the block decision it makes is the deny JSON,
// never a non-zero exit.
//
// Child processes spawn with process.execPath (never the bare string "bun") so
// the core hook does not depend on `bun` being on PATH (T-0009).
//
// Do NOT modify any core hook body — all Cursor adaptation lives in this file.
//
// Usage (wired in .cursor/hooks.json):
//   bun .cursor/hooks/aidlc-cursor-adapter.ts <target>
// where <target> ∈ session-start | stop | state-transition-guard |
//                  reviewer-scope | audit-and-sensors | log-subagent |
//                  validate-state

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface CursorHookInput {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  // beforeShellExecution
  command?: string;
  // preToolUse / beforeMCPExecution
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // afterFileEdit
  file_path?: string;
  edits?: unknown;
  // subagentStop
  subagent_id?: string;
  subagent_type?: string;
  // stop
  status?: string;
  loop_count?: number;
}

// Cursor's permission-deny block contract (snake_case is load-bearing).
function denyJson(reason: string): string {
  return JSON.stringify({
    permission: "deny",
    user_message: reason,
    agent_message: reason,
  });
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  let cursor: CursorHookInput = {};
  if (!process.stdin.isTTY) {
    try {
      if (input.length > 0) cursor = JSON.parse(input) as CursorHookInput;
    } catch {
      return 0; // malformed stdin — fail open (Flow 4.2)
    }
  }

  const projectDirRaw =
    process.env.AIDLC_PROJECT_DIR ??
    cursor.cwd ??
    cursor.workspace_roots?.[0] ??
    process.cwd();
  const projectDir = isAbsolute(projectDirRaw)
    ? projectDirRaw
    : resolve(process.cwd(), projectDirRaw);
  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };

  // --- Core-hook subprocess plumbing ----------------------------------------
  //
  // Reuse the exact bun binary running this adapter; the child must not depend
  // on PATH containing bun (the hook environment often lacks the bun install
  // dir). A compiled build routes through the `hook <name>` subcommand.
  function runCore(
    hookFile: string,
    coreInput: string,
  ): { stdout: string; stderr: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(coreInput, "utf-8"),
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

  // Gating targets share one exit-contract translation: core exit 2 + stderr →
  // Cursor deny JSON on stdout + exit 0; core exit 0 → allow (exit 0, no
  // output). Anything else (a crashed core hook) allows — Cursor's own
  // failClosed:true is the floor for a genuine adapter crash, not a clean allow.
  function answerGate(r: {
    stdout: string;
    stderr: string;
    code: number;
  }): number {
    if (r.code === 2) {
      process.stdout.write(denyJson(r.stderr.trim()));
    }
    return 0;
  }

  switch (target) {
    case "session-start": {
      // beforeSubmitPrompt → SessionStart, fired AT MOST ONCE per
      // conversation_id. Cursor fires beforeSubmitPrompt on EVERY prompt, but
      // the core SessionStart record must be emitted only on the first prompt
      // of a conversation — a marker file under aidlc/ (keyed by a hash of the
      // conversation_id) gates it. Marker bookkeeping is best-effort: a failure
      // to record still runs session-start (fail open toward firing once).
      const conversationId = cursor.conversation_id ?? "";
      let alreadyFired = false;
      if (conversationId.length > 0) {
        try {
          const markerDir = join(projectDir, "aidlc", ".aidlc-cursor-sessions");
          const marker = join(
            markerDir,
            createHash("sha256")
              .update(conversationId)
              .digest("hex")
              .slice(0, 32),
          );
          if (existsSync(marker)) {
            alreadyFired = true;
          } else {
            mkdirSync(markerDir, { recursive: true });
            writeFileSync(marker, `${conversationId}\n`, "utf-8");
          }
        } catch {
          // marker I/O failed — proceed to fire (a duplicate SessionStart is a
          // harmless observability re-record; a MISSED first fire is not).
        }
      }
      if (alreadyFired) return 0;

      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        ...(conversationId ? { session_id: conversationId } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd);
      // The core hook emits {"additionalContext": "..."}; Cursor's context
      // channel for beforeSubmitPrompt is plain stdout at exit 0 (Flow 1.1),
      // so unwrap it. Anything unparseable passes through untouched.
      try {
        const parsed = JSON.parse(r.stdout) as { additionalContext?: string };
        if (parsed.additionalContext) {
          process.stdout.write(parsed.additionalContext);
        }
      } catch {
        if (r.stdout) process.stdout.write(r.stdout);
      }
      return 0;
    }

    case "stop": {
      // stop → Stop. Cursor provides neither stop_hook_active nor a
      // transcript_path, so the core hook's run-mode-aware no-progress ceiling
      // is the loop guard (it defaults stop_hook_active to false); the
      // hooks.json loop_limit is the hard cap. Map the core block contract
      // {decision:"block", reason} → Cursor's {followup_message: reason}.
      const fwd = JSON.stringify({
        hook_event_name: "Stop",
        stop_hook_active: false,
      });
      const r = runCore("aidlc-stop.ts", fwd);
      try {
        const parsed = JSON.parse(r.stdout) as {
          decision?: string;
          reason?: string;
        };
        if (parsed.decision === "block" && parsed.reason) {
          process.stdout.write(JSON.stringify({ followup_message: parsed.reason }));
        }
      } catch {
        // unparseable core output — silent allow (Flow 3.2 step 3b parse miss)
      }
      return 0;
    }

    case "state-transition-guard": {
      // beforeShellExecution → PreToolUse Bash. Only Bash can name aidlc-state.ts;
      // the core guard permits everything else. Exit 2 + stderr → deny JSON.
      const fwd = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: cursor.command ?? "" },
      });
      return answerGate(runCore("aidlc-state-transition-guard.ts", fwd));
    }

    case "reviewer-scope": {
      // preToolUse (matcher Read|LS|Glob|Grep) → PreToolUse. Cursor's tool names
      // for these read surfaces match the core hook's switch verbatim, so
      // tool_name + tool_input pipe through unchanged. Exit 2 + stderr → deny.
      const fwd = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: cursor.tool_name ?? "",
        tool_input: cursor.tool_input ?? {},
      });
      return answerGate(runCore("aidlc-reviewer-scope.ts", fwd));
    }

    case "audit-and-sensors": {
      // afterFileEdit {file_path, edits} → PostToolUse Write, then audit-logger
      // THEN sensor-fire (mirrors the Claude settings.json Write registration
      // order). Advisory: exit 0, no output required.
      const filePath = cursor.file_path ?? "";
      if (filePath.length > 0) {
        const fwd = JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: filePath },
        });
        runCore("aidlc-audit-logger.ts", fwd);
        runCore("aidlc-sensor-fire.ts", fwd);
      }
      return 0;
    }

    case "log-subagent": {
      // subagentStop → SubagentStop. Cursor carries subagent_type/subagent_id;
      // the core hook reads agent_type/agent_id. Advisory: exit 0.
      const fwd = JSON.stringify({
        hook_event_name: "SubagentStop",
        agent_type: cursor.subagent_type ?? "unknown",
        agent_id: cursor.subagent_id ?? "",
      });
      runCore("aidlc-log-subagent.ts", fwd);
      return 0;
    }

    case "validate-state": {
      // preCompact → validate-state. The core hook reads no stdin fields (state
      // validation + SESSION_COMPACTED + recovery breadcrumb are self-contained),
      // so the raw payload pipes through. Advisory: exit 0.
      runCore("aidlc-validate-state.ts", input);
      return 0;
    }

    default:
      return 0;
  }
}

if (import.meta.main) {
  process.exit(
    await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)),
  );
}
