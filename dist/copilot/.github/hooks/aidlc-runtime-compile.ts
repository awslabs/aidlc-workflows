// PostToolUse hook (Bash matcher): Dispatch `aidlc-runtime.ts compile`
// after every transition-class audit emit.
//
// Fires after every Bash tool call from the agent. Filters cheaply on
// the command — only direct transition tools plus `aidlc-orchestrate.ts report`
// get past the early exit. On match, tail-reads the LAST 3
// audit blocks (one approve writes up to 3 audit rows in a single Bash
// call), regex-matches `**Event**: (GATE_APPROVED|STAGE_STARTED|
// AUDIT_MERGED|WORKFLOW_COMPLETED)` against any of them, and dispatches
// `aidlc-runtime.ts compile` on match.
//
// WORKFLOW_COMPLETED is in the transition set so the final-stage approve
// fires the compile (handleCompleteWorkflow at aidlc-state.ts:572-590
// emits 5 audit rows ending with WORKFLOW_COMPLETED — without it in the
// regex, the last 3 blocks would be PHASE_COMPLETED + PHASE_VERIFIED +
// WORKFLOW_COMPLETED, none in the original transition set, and the
// runtime-graph would never record the final stage as approved).
//
// Recursion guard: `aidlc-runtime.ts` is excluded from the command-regex
// matcher set, AND MEMORY_EMPTY is not in the event-class regex. The
// compile's own audit emits cannot re-trigger the compile.

import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeIntent,
  activeSpace,
  auditShards,
  classifyRuntimeCompileCommand,
  type ClaudeCodeHookInput,
  errorMessage,
  hookDebug,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  readAllAuditShards,
  recordHookDrop,
  resolveProjectDirFromHook,
  runtimeGraphPath,
  harnessDir,
} from "../tools/aidlc-lib.ts";

export async function run(input: string): Promise<number> {
const projectDir = resolveProjectDirFromHook(import.meta.url);
hookDebug(projectDir, "runtime-compile", "invoked");

// 1. TTY guard — exit cleanly when invoked outside a piped stdin context
//    (interactive shell, test harness running under `bash -x`).
if (process.stdin.isTTY) return 0;

// 2. Stdin parse — read JSON payload from Claude Code; exit on malformed.
let parsed: ClaudeCodeHookInput;
try {
  const raw: unknown = JSON.parse(input);
  if (!isClaudeCodeHookInput(raw)) return 0;
  parsed = raw;
} catch {
  return 0;
}
const command: string = parsed.tool_input?.command ?? "";

// 3. Command filter - only dispatch on the audit-emit-side seam for both
//    legacy tool-file commands and the new `aidlc ...` grammar.
//    aidlc-runtime.ts / aidlc runtime is rejected explicitly (recursion guard
//    at the command level - a positive-only allowlist would let composites like
//    `bun aidlc-runtime.ts compile && bun aidlc-state.ts approve` through and
//    loop). aidlc-log.ts emits only chatty in-stage events
//    (DECISION_RECORDED / QUESTION_ANSWERED / ERROR_LOGGED), none
//    transition-class. aidlc-worktree.ts emits only WORKTREE_* events.
//    `aidlc-orchestrate.ts report` is included because the conductor calls it
//    as the public transition surface; the state-tool emit happens in its
//    subprocess, which PostToolUse cannot see as a separate Bash command. The
//    new report allowlist keeps that same public-transition surface.
// IDE audit-tail mode: Kiro IDE does not surface the shell command, so the
// command-based filter cannot run. The adapter sets source="ide-audit-sync" to
// signal "skip the command filter and gate purely on the audit tail" (steps
// 6-7). The audit-tail transition check is the real gate; the command filter is
// only a cheap pre-filter that needs a command string to work.
const ideAuditMode = (parsed.tool_input?.source ?? "") === "ide-audit-sync";
hookDebug(projectDir, "runtime-compile", "command-gate", { ideAuditMode, command: command.slice(0, 120) });
if (!ideAuditMode) {
  const commandDecision = classifyRuntimeCompileCommand(command);
  if (commandDecision === "reject") return 0;
  if (commandDecision === "pass") {
    hookDebug(projectDir, "runtime-compile", "exit: command not a transition tool");
    return 0;
  }
}

// 4. Audit read — across EVERY per-clone shard of the ACTIVE intent, NOT this
//    hook process's own PID/clone shard. The state tool that wrote the
//    transition runs in a SEPARATE process; on the new layout a bare
//    auditFilePath(projectDir) would resolve a per-process/PID shard the hook
//    never wrote, so the transition would be invisible and the runtime-graph
//    would never refresh after a transition (the major). Resolve the active
//    intent (cursor / lone-intent → null = flat-legacy) and glob-merge its
//    shards. Exit cleanly before init (no audit yet → "").
const space = activeSpace(projectDir);
const intent = activeIntent(projectDir, space) ?? undefined;
const audit = readAllAuditShards(projectDir, intent, space).replace(/\r\n/g, "\n");
if (audit.length === 0) {
  hookDebug(projectDir, "runtime-compile", "exit: audit empty");
  return 0;
}

// 5. Heartbeat — doctor reads this file's mtime to detect silent-hook failure.
//    Kept at the bare (workspace-level) health dir to match where --doctor reads
//    it (aidlc-utility.ts) and where recordHookDrop writes drops — the heartbeat
//    is a per-hook liveness probe, not per-intent state.
const healthDir = hooksHealthDir(projectDir);
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "runtime-compile.last"), isoTimestamp(), "utf-8");

// 6. Tail-read last 3 audit blocks. Three is the upper bound: a normal
//    approve writes GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED in
//    one Bash call. Terminal-WORKFLOW approve writes 5 rows; the last 3
//    are PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED. In the common
//    single-clone case the merged buffer is one shard, so the last 3 blocks are
//    the just-written transition rows.
const blocks = audit.split(/\n---\n/);
const last3 = blocks.slice(-3);

// 7. Event-class filter — recursion guard + scope filter combined.
//    A single Bash call can append multiple transition rows in one go
//    (approve emits GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED).
//    Any of the last 3 blocks may carry the transition.
//    STAGE_AWAITING_APPROVAL is in the set so the compile refreshes the
//    runtime-graph at gate-start — without it, the gate ritual reads a
//    stale memory_entries count snapshotted at STAGE_STARTED time
//    (before the orchestrator wrote any §13 entries).
const transitionRegex = /^\*\*Event\*\*:\s*(GATE_APPROVED|STAGE_STARTED|STAGE_AWAITING_APPROVAL|AUDIT_MERGED|WORKFLOW_COMPLETED)\s*$/m;
const hasTransition = last3.some((b) => transitionRegex.test(b));
hookDebug(projectDir, "runtime-compile", "transition-gate", { hasTransition, last3count: last3.length });
if (!hasTransition) {
  hookDebug(projectDir, "runtime-compile", "exit: no transition in audit tail");
  return 0;
}

// 7b. Idempotency guard (IDE audit-tail mode only). On the CLI the command
//     filter (step 3) already bounds compiles to the one Bash call that emitted
//     the transition. In ide-audit-sync mode that filter is skipped, so the
//     transition sits in the tail across EVERY subsequent shell command — and
//     after WORKFLOW_COMPLETED the tail never changes again, which would make
//     every future shell command pay a blocking recompile forever. Bound it by
//     mtime: if runtime-graph.json is already at least as new as the newest
//     audit shard, the tail hasn't changed since the last compile — skip. A real
//     new transition bumps a shard's mtime past the graph and re-enables the
//     compile. Cheap stat calls; no new marker file.
if (ideAuditMode) {
  try {
    const graphMtime = statSync(runtimeGraphPath(projectDir, intent, space)).mtimeMs;
    let newestShard = 0;
    for (const shard of auditShards(projectDir, intent, space)) {
      try {
        const m = statSync(shard).mtimeMs;
        if (m > newestShard) newestShard = m;
      } catch {
        // shard vanished mid-read — ignore
      }
    }
    if (graphMtime >= newestShard) {
      hookDebug(projectDir, "runtime-compile", "skip: graph newer than audit (idempotent)", {
        graphMtime,
        newestShard,
      });
      return 0;
    }
  } catch {
    // runtime-graph.json absent (never compiled) → fall through and compile.
  }
}

// 8. Dispatch — sync subprocess. Hook waits for completion. On non-zero
//    exit, record the drop for `--doctor` to surface; never block the
//    parent Bash call (mirrors aidlc-audit-logger.ts:95-101).
const runtimeTs = join(projectDir, harnessDir(), "tools", "aidlc-runtime.ts");
try {
  const args = ["run", runtimeTs, "compile"];
  const result = spawnSync("bun", args, {
    cwd: projectDir,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    recordHookDrop(
      projectDir,
      "runtime-compile",
      `exit ${result.status}: ${result.stderr?.toString() ?? ""}`
    );
  }
} catch (e) {
  recordHookDrop(projectDir, "runtime-compile", errorMessage(e));
}
return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
