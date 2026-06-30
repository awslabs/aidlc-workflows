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
//   - session-start / post-compact: the core hook prints
//     {"additionalContext": "..."}; Codex expects the hookSpecificOutput
//     wrapper (verified live, findings E1) — the shim re-wraps.
//   - stop: {"decision":"block","reason"} passes through VERBATIM — the
//     contract is identical on Codex (stop_hook_active included).
//   - everything else: advisory; stdout ignored, exit 0.
//
// Usage (wired in .codex/hooks.json):
//   bun .codex/hooks/aidlc-codex-adapter.ts <target>
// where <target> ∈ session-start | audit-and-sensors | state-sync |
//                  runtime-compile | validate-state | post-compact |
//                  log-subagent | stop

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
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? "";

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
}

let rawInput = "";
let codex: CodexHookInput = {};
if (!process.stdin.isTTY) {
  try {
    rawInput = await Bun.stdin.text();
    if (rawInput.length > 0) codex = JSON.parse(rawInput) as CodexHookInput;
  } catch {
    process.exit(0); // malformed stdin — advisory hooks fail open
  }
}

const projectDir = codex.cwd ?? process.cwd();

// --- Duplicate-delivery replay cache ---------------------------------------
//
// Key = sha256(target + raw stdin): identical deliveries (same turn, same
// tool_use_id, same content) collide; legitimate re-fires differ (turn_id /
// stop_hook_active / tool_use_id change). First delivery takes the slot via
// atomic mkdir (the audit-lock idiom), runs, and persists its response;
// the duplicate waits briefly for that response and replays it byte-for-byte.
// Entries are pruned after 30 minutes. Failure anywhere → fail open (run or
// allow), never trap the turn.

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

function replayAndExit(): never {
  // Duplicate delivery: wait up to ~2s for the first runner's response, then
  // answer identically. If it never lands, fail open silently.
  for (let i = 0; i < 20; i++) {
    try {
      const cached = JSON.parse(readFileSync(responseFile, "utf-8")) as {
        stdout: string;
        code: number;
      };
      if (cached.stdout) process.stdout.write(cached.stdout);
      process.exit(cached.code);
    } catch {
      Bun.sleepSync(100);
    }
  }
  process.exit(0);
}

function persistResponse(stdout: string, code: number): void {
  try {
    writeFileSync(responseFile, JSON.stringify({ stdout, code }), "utf-8");
  } catch {
    // best-effort — a duplicate will fail open instead of replaying
  }
}

try {
  mkdirSync(DEDUPE_ROOT, { recursive: true });
  pruneStale();
  mkdirSync(slotDir); // atomic claim — throws EEXIST for the duplicate
} catch {
  replayAndExit();
}

// --- Core-hook subprocess plumbing ------------------------------------------

function runCore(hookFile: string, input: string): { stdout: string; code: number } {
  const r = Bun.spawnSync(["bun", join(HOOKS_DIR, hookFile)], {
    stdin: Buffer.from(input, "utf-8"),
    stdout: "pipe",
    stderr: "ignore",
    cwd: projectDir,
  });
  return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
}

// Re-wrap the core context output ({"additionalContext": ...}) into the
// hookSpecificOutput envelope Codex consumes (verified live for SessionStart).
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

// --- D-4: SESSION_ENDED reconcile-at-next-start ------------------------------

const heartbeatFile = join(projectDir, "aidlc-docs", ".aidlc-hooks-health", "codex-session.json");

function reconcilePriorSession(): void {
  // Only meaningful inside an active workflow; the heartbeat lives in the
  // same health dir the core hooks already maintain.
  if (!existsSync(join(projectDir, "aidlc-docs"))) return;
  try {
    if (existsSync(heartbeatFile)) {
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
        runCore("aidlc-session-end.ts", JSON.stringify({ reason }));
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
    const fwd = JSON.stringify({
      hook_event_name: "SessionStart",
      source: codex.source ?? "startup",
      ...(codex.session_id ? { session_id: codex.session_id } : {}),
    });
    const r = runCore("aidlc-session-start.ts", fwd);
    const wrapped = wrapContext(r.stdout, "SessionStart");
    persistResponse(wrapped, 0);
    if (wrapped) process.stdout.write(wrapped);
    process.exit(0);
  }

  case "audit-and-sensors": {
    // apply_patch → audit-logger THEN sensor-fire per touched file (mirrors
    // the Claude settings.json Write|Edit registration order). Advisory.
    if ((codex.tool_name ?? "") === "apply_patch") {
      const command = (codex.tool_input?.command as string) ?? "";
      for (const f of patchedFiles(command)) {
        const fwd = JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: f.tool,
          tool_input: { file_path: f.path },
        });
        runCore("aidlc-audit-logger.ts", fwd);
        runCore("aidlc-sensor-fire.ts", fwd);
      }
    }
    persistResponse("", 0);
    process.exit(0);
  }

  case "state-sync": {
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
        runCore("aidlc-sync-statusline.ts", fwd);
      }
    }
    persistResponse("", 0);
    process.exit(0);
  }

  case "runtime-compile": {
    // Codex already names the shell tool "Bash" with tool_input.command —
    // the core hook's exact contract. Verbatim pipe.
    runCore("aidlc-runtime-compile.ts", rawInput);
    persistResponse("", 0);
    process.exit(0);
  }

  case "validate-state": {
    // PreCompact: the core hook reads no stdin fields — state validation +
    // SESSION_COMPACTED + recovery breadcrumb are all self-contained.
    runCore("aidlc-validate-state.ts", rawInput);
    persistResponse("", 0);
    process.exit(0);
  }

  case "post-compact": {
    // Codex-only event (S9c): re-inject the mission AFTER compaction. The
    // core session-start hook with source=compact emits NO audit row (the
    // PreCompact hook owns SESSION_COMPACTED) but still renders the
    // workflow-context block — exactly the deterministic mission reload.
    const r = runCore(
      "aidlc-session-start.ts",
      JSON.stringify({ hook_event_name: "SessionStart", source: "compact" }),
    );
    const wrapped = wrapContext(r.stdout, "PostCompact");
    persistResponse(wrapped, 0);
    if (wrapped) process.stdout.write(wrapped);
    process.exit(0);
  }

  case "log-subagent": {
    // SubagentStop already carries agent_type (real role name on Codex
    // ≥ 0.139.0 — doctor pins the minimum) + agent_id. Verbatim pipe.
    runCore("aidlc-log-subagent.ts", rawInput);
    persistResponse("", 0);
    process.exit(0);
  }

  case "stop": {
    // Contract identical on Codex (stop_hook_active included): pass stdin
    // verbatim, forward {"decision":"block","reason"} stdout + exit code.
    const r = runCore("aidlc-stop.ts", rawInput);
    persistResponse(r.stdout, r.code);
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.code);
  }

  case "mint": {
    // UserPromptSubmit: a real human acted this turn — record a HUMAN_TURN event
    // in the active intent's audit shard (human-presence gate). Fail-open: a mint
    // failure must never block the turn. Advisory, no stdout.
    try {
      appendAuditEntry("HUMAN_TURN", {}, projectDir);
    } catch {
      // best-effort presence record — advisory
    }
    persistResponse("", 0);
    process.exit(0);
  }

  default:
    persistResponse("", 0);
    process.exit(0);
}
