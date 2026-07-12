#!/usr/bin/env bun
// aidlc-cursor-adapter.ts — the Cursor hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness).
//
// Cursor's hook wire protocol deliberately mirrors Claude Code's (JSON on
// stdin, one JSON object on stdout, exit 2 = block), but the payloads differ
// in four load-bearing ways (docs-derived from the official hooks reference,
// cursor.com/docs, 2026-07 — field names pending a live-capture pass like the
// Kiro/Codex spikes; every mapping below is defensive/fail-open, and a
// payload-shape miss on the load-bearing audit path records a hook drop so
// `/aidlc --doctor` surfaces the decay instead of it being an invisible
// no-op):
//   1. Event names are camelCase (afterFileEdit, beforeSubmitPrompt, stop)
//      and per-event fields ride the TOP LEVEL (file_path, command, prompt),
//      not a tool_input envelope.
//   2. The session id field is `conversation_id`; the project dir arrives as
//      `workspace_roots[0]` (plus the always-present CLAUDE_PROJECT_DIR env
//      alias Cursor sets for Claude Code compatibility — consumed via the
//      shared resolveProjectDirFromHook ladder, same as the other adapters).
//   3. sessionStart's context channel is `{"additional_context": ...}` — the
//      core hook's `{"additionalContext": ...}` needs re-keying.
//   4. The stop hook CANNOT hard-block: Cursor's continuation channel is
//      `{"followup_message": ...}`, which the harness auto-submits as the
//      next user message (capped by loop_limit in hooks.json). The core stop
//      hook's `{"decision":"block","reason"}` is translated to that shape;
//      `loop_count` maps onto `stop_hook_active`. Because that auto-submitted
//      followup may itself fire beforeSubmitPrompt, every followup carries
//      FOLLOWUP_MARKER and the mint target skips marker-prefixed prompts —
//      a machine nudge must never mint HUMAN_TURN (the human-presence gate
//      exists precisely to refuse model-fabricated approvals).
//
// This shim normalizes a Cursor payload into the ClaudeCodeHookInput shape the
// core hooks parse, then pipes it into the named core hook (same directory)
// as a bun subprocess, forwarding output per the contracts above.
//
// The reviewer-scope PreToolUse hook is DELIBERATELY not a target here:
// Cursor's preToolUse payloads carry no subagent identity and hooks cannot be
// registered per-subagent, so there is no seam to attribute a tool call to a
// dispatched reviewer — the §12a prose bound governs on this harness (the
// Kiro IDE precedent). Wire it if Cursor grows either seam.
//
// Usage (registered in .cursor/hooks.json):
//   bun .cursor/hooks/aidlc-cursor-adapter.ts <target>
// where <target> ∈ session-start | session-end | mint | audit-and-sensors |
//                  shell-sync | runtime-compile | state-sync | log-subagent |
//                  validate-state | stop
// (hooks.json wires shell-sync — one process per shell command fanning to
// runtime-compile THEN state-sync; the two single-purpose targets remain for
// the contract tests and manual invocation.)

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordHookDrop, resolveProjectDirFromHook } from "../tools/aidlc-lib.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? "";

// The stable lead-in every stop-hook followup carries. Load-bearing twice:
// the mint target uses it to recognize (and NOT mint HUMAN_TURN for) the
// harness's auto-submitted continuation, and a human reading the transcript
// sees at a glance that the "user message" was machine-generated. Pinned by
// t222 — keep the literal in sync with the test.
const FOLLOWUP_MARKER = "[AIDLC stop-hook nudge]";

interface CursorHookInput {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  transcript_path?: string;
  // Per-event top-level fields (afterFileEdit / afterShellExecution /
  // beforeSubmitPrompt / stop / subagentStop):
  file_path?: string;
  command?: string;
  prompt?: string;
  status?: string;
  loop_count?: number;
  subagent_id?: string;
  subagent_type?: string;
  agent_type?: string;
  output?: string;
  reason?: string;
  // Defensive: some events may still nest under a tool_input envelope.
  tool_input?: Record<string, unknown>;
}

/** Answer Cursor with one JSON object and exit 0 — the only output shape a
 *  command hook may produce ("exit 0 = use JSON output"). Every path through
 *  this shim, including every fail-open path, ends here. */
function answer(obj: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

let cursor: CursorHookInput = {};
if (!process.stdin.isTTY) {
  try {
    const text = await Bun.stdin.text();
    if (text.length > 0) {
      const parsed = JSON.parse(text) as unknown;
      // A valid-JSON scalar or array (`null`, `0`, `"x"`, `[]`) parses fine
      // but is not a payload — treat it like malformed stdin (fail open)
      // instead of dereferencing null below.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cursor = parsed as CursorHookInput;
      }
    }
  } catch {
    answer({}); // malformed stdin — advisory hooks fail open
  }
}

// Project dir: workspace_roots[0] is the payload-carried source of truth when
// present; otherwise the shared lib ladder (CLAUDE_PROJECT_DIR env — which
// Cursor sets as a Claude Code compatibility alias — then script-path
// derivation from this file's own <project>/.cursor/hooks/ location, then the
// CWD probe). Same resolution every other adapter uses.
const projectDir = cursor.workspace_roots?.[0] ?? resolveProjectDirFromHook(import.meta.url);

// Cheap pre-gate: a project with no aidlc/ workspace shell has nothing for ANY
// core hook to do (each self-gates on workspace state) — skip the child bun
// spawn entirely so an installed-but-idle project pays ~0 per editor event.
if (!existsSync(join(projectDir, "aidlc"))) answer({});

function abs(p: string): string {
  return isAbsolute(p) ? p : join(projectDir, p);
}

type Forward = { hook: string; input: Record<string, unknown> } | null;

// The two afterShellExecution forwards, shared by the fan-in shell-sync
// target and the single-purpose runtime-compile / state-sync targets.
function runtimeCompileInput(): Record<string, unknown> {
  // When the payload carries the command string the core hook applies its
  // normal transition-command filter; if the field is ever absent (payload
  // drift), fall back to the payload-free audit-tail mode the Kiro IDE
  // adapter proved (source marker skips the command filter; the core hook's
  // mtime idempotency keeps it cheap).
  const command = cursor.command ?? ((cursor.tool_input ?? {}).command as string) ?? "";
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: command.length > 0 ? { command } : { command: "", source: "ide-audit-sync" },
  };
}
function stateSyncInput(): Record<string, unknown> {
  // Cursor exposes no TaskUpdate-shaped plan-tool hook event, so stage status
  // syncs in audit-tail mode after shell commands (the Kiro IDE pattern): the
  // core hook reads the audit tail and rolls the state file's stage status
  // forward, never backward.
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { source: "ide-audit-sync" },
  };
}

function buildForward(): Forward {
  const ti = cursor.tool_input ?? {};

  switch (target) {
    case "session-start":
      // conversation_id is forwarded as session_id so the core hook writes
      // its per-session→intent stamp. Cursor's sessionStart payload carries
      // no documented resume discrimination — every session reports as
      // "startup" (SESSION_RESUMED / the P8 resume-rebind offer are
      // structurally unreachable here, a documented harness limitation; we
      // never fake a resume source). The state-file self-gate keeps the
      // whole thing a no-op outside active workflows.
      return {
        hook: "aidlc-session-start.ts",
        input: {
          hook_event_name: "SessionStart",
          source: "startup",
          ...(cursor.conversation_id ? { session_id: cursor.conversation_id } : {}),
        },
      };

    case "session-end":
      return {
        hook: "aidlc-session-end.ts",
        input: {
          hook_event_name: "SessionEnd",
          reason: cursor.reason ?? cursor.status ?? "session-end",
        },
      };

    case "mint": {
      // beforeSubmitPrompt = a real human turn — EXCEPT the harness's own
      // auto-submitted stop-hook followup (see FOLLOWUP_MARKER above). The
      // core presence hook reads nothing from stdin (presence-only) and
      // self-gates on workflow state, exactly like Claude's UserPromptSubmit
      // registration.
      if ((cursor.prompt ?? "").startsWith(FOLLOWUP_MARKER)) return null;
      return {
        hook: "aidlc-mint-presence.ts",
        input: { hook_event_name: "UserPromptSubmit" },
      };
    }

    case "audit-and-sensors": {
      // afterFileEdit → audit-logger THEN sensor-fire (both ship core).
      const filePath = cursor.file_path ?? (ti.file_path as string) ?? "";
      if (!filePath) {
        // The load-bearing audit path: a payload with no recognizable file
        // path means the docs-derived field mapping has drifted — record a
        // doctor-visible drop rather than decaying invisibly.
        recordHookDrop(
          projectDir,
          "cursor-adapter",
          `audit-and-sensors: no file_path in payload (keys: ${Object.keys(cursor).join(",")})`,
        );
        return null;
      }
      return {
        hook: "__audit_and_sensors__", // handled specially below (two hooks)
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: abs(filePath) },
        },
      };
    }

    case "shell-sync":
      // The hooks.json wiring: ONE adapter process per shell command, fanning
      // to runtime-compile then state-sync (mirrors __audit_and_sensors__ —
      // Cursor's hooks.json could register two entries instead, but that
      // doubles the bun spawns on the shell hot path for no gain).
      return { hook: "__shell_sync__", input: runtimeCompileInput() };

    case "runtime-compile":
      return { hook: "aidlc-runtime-compile.ts", input: runtimeCompileInput() };

    case "state-sync":
      return { hook: "aidlc-sync-statusline.ts", input: stateSyncInput() };

    case "log-subagent": {
      // agent_id: a per-subagent identity when the payload carries one;
      // generation_id (per-generation base field) is the closest documented
      // stand-in. NEVER conversation_id — that is the parent session's id,
      // and stamping it would make every SUBAGENT_COMPLETED row in a session
      // carry the same "Agent ID" (misattribution, worse than absence).
      return {
        hook: "aidlc-log-subagent.ts",
        input: {
          hook_event_name: "SubagentStop",
          agent_type: cursor.subagent_type ?? cursor.agent_type ?? "unknown",
          agent_id: cursor.subagent_id ?? cursor.generation_id ?? "",
          ...(cursor.output ? { last_assistant_message: cursor.output } : {}),
        },
      };
    }

    case "validate-state":
      // preCompact → the recovery-breadcrumb hook; it reads nothing from
      // stdin, so the minimal envelope suffices.
      return {
        hook: "aidlc-validate-state.ts",
        input: { hook_event_name: "PreCompact" },
      };

    case "stop": {
      // Only a COMPLETED turn gets the forwarding-discipline check — nudging
      // an aborted or errored turn would fight the user. `loop_count >= 2`
      // maps onto Claude's stop_hook_active ("this stop follows an earlier
      // nudge of ours"): robust whether Cursor counts the followup chain
      // 0-based or 1-based — the worst case is one extra nudge, never a
      // silently-disabled first nudge. transcript_path is Claude-Code-
      // compatible JSONL on Cursor, so the core hook's conversational
      // carve-out works as on Claude.
      if ((cursor.status ?? "completed") !== "completed") return null;
      return {
        hook: "aidlc-stop.ts",
        input: {
          hook_event_name: "Stop",
          stop_hook_active: (cursor.loop_count ?? 0) >= 2,
          ...(cursor.transcript_path ? { transcript_path: cursor.transcript_path } : {}),
        },
      };
    }

    default:
      return null;
  }
}

function runCore(hookFile: string, input: Record<string, unknown>): { stdout: string; code: number } {
  // Reuse the exact bun binary running this adapter; the child must not depend on
  // PATH containing bun (the hook environment often lacks the bun install dir).
  const r = Bun.spawnSync([process.execPath, join(HOOKS_DIR, hookFile)], {
    stdin: Buffer.from(JSON.stringify(input), "utf-8"),
    cwd: projectDir,
    stdout: "pipe",
    stderr: "ignore",
  });
  return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
}

const fwd = buildForward();
if (fwd === null) {
  // No-op for this payload. Emit an empty JSON object so Cursor's "exit 0 =
  // use JSON output" arm sees a well-formed non-answer.
  answer({});
  throw new Error("unreachable"); // narrows fwd for TS below
}

if (fwd.hook === "__audit_and_sensors__") {
  // Two core hooks ride the same edit event, in audit-then-sensors order
  // (order load-bearing — mirrors the Claude settings.json registration).
  // Both advisory: exit 0.
  runCore("aidlc-audit-logger.ts", fwd.input);
  runCore("aidlc-sensor-fire.ts", fwd.input);
  answer({});
}

if (fwd.hook === "__shell_sync__") {
  // One process per shell command: runtime-compile (with the command payload)
  // then state-sync (audit-tail). Both advisory: exit 0.
  runCore("aidlc-runtime-compile.ts", fwd.input);
  runCore("aidlc-sync-statusline.ts", stateSyncInput());
  answer({});
}

const result = runCore(fwd.hook, fwd.input);

if (target === "session-start") {
  // Re-key {"additionalContext": ...} → Cursor's {"additional_context": ...}.
  // Anything unparseable is swallowed (context injection is advisory).
  try {
    const parsed = JSON.parse(result.stdout) as { additionalContext?: string };
    if (parsed.additionalContext) {
      answer({ additional_context: parsed.additionalContext });
    }
  } catch {
    /* fall through to the empty answer */
  }
  answer({});
}

if (target === "stop") {
  // Translate the core block contract to Cursor's continuation channel:
  // {"decision":"block","reason"} → {"followup_message": marker + reason}.
  // Cursor auto-submits the message as the next user turn (loop_limit-capped
  // in hooks.json; the core hook's own interactive/autonomous ceilings govern
  // first). The marker keeps the mint target from stamping HUMAN_TURN for
  // this machine turn. Anything else — silence, malformed output — ends the
  // turn.
  try {
    const parsed = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    if (parsed.decision === "block" && parsed.reason) {
      answer({ followup_message: `${FOLLOWUP_MARKER} ${parsed.reason}` });
    }
  } catch {
    /* fall through to the empty answer */
  }
  answer({});
}

// Advisory targets: the core hooks' stdout is not a Cursor answer shape —
// answer with the empty object and exit 0.
answer({});
