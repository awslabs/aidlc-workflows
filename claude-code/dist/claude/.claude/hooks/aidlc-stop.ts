// Stop hook: enforce the forwarding loop on turn-end.
//
// This is the framework's FIRST flow-altering hook. The other framework
// hooks are advisory — they observe (audit, sensors, statusline, state
// validation) and always exit 0. The sensor-fire hook in particular carries
// an explicit advisory contract: it NEVER returns {decision: block} (its own
// contract, asserted by t95 Case 7 — not a framework ban). This hook is a
// DIFFERENT, sanctioned contract: it may emit {"decision":"block", ...} to
// keep the interactive forwarding loop running until the engine says `done`.
//
// Why it exists. The forwarding loop is the conductor (LLM) calling the engine
// for the next move, acting on it, and reporting. On the gated/interactive
// path the conductor holds the loop because only it can ask the human a
// question. If the conductor forgets to consult the engine — after a long
// conversation, or by improvising — the workflow drifts. So the loop cannot
// rest on the conductor's good behaviour: when the conductor tries to end its
// turn, this hook runs the engine (`aidlc-orchestrate next`) and, if a
// directive is still PENDING, blocks the stop and injects the directive back
// via `reason`. The conductor cannot quit until the engine answers `done`.
// Enforced by the harness, not by the LLM remembering.
//
// The reason is an ON-TASK CONTINUATION — it names the work the conductor
// still owes (run the loop, act on the directive, report), never an
// override-shaped instruction. That phrasing is the security property:
// override-shaped directives are refused by the conductor's own safety
// training, so a buggy or compromised engine can only ever CONTINUE sanctioned
// work, never hijack the session.
//
// Two bounds keep a stuck loop from trapping the session (a stuck block is the
// ONE way to trap a session, so this is the safety-critical part):
//   1. `stop_hook_active` — Claude Code sets this true when the current stop is
//      itself the product of a prior Stop-hook block. We read it as a signal
//      that we are already inside a blocked sequence.
//   2. A NO-PROGRESS counter — consecutive blocks with no intervening workflow
//      advance (no `report` ran, so the position signature is unchanged). It is
//      persisted across the rapid-fire blocks in a transient file under
//      aidlc-docs/.aidlc-stop-hook/. Under an 8-block ceiling exposed as
//      CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (default 8), once the count reaches the
//      cap we LET GO (allow the stop). When the workflow advances, the signature
//      changes and the counter resets to 0, so a healthy loop is never throttled.
//
// The human-stop carve-out is FREE: Stop hooks do not fire on user interrupt
// (Esc), so an Esc can never be trapped — no code needed here.
//
// No-op outside AIDLC. The frontmatter Stop matcher scopes this to the `aidlc`
// skill, but we defend here too: with no active workflow (no aidlc-state.md
// under the project dir) we exit 0 immediately. A non-AIDLC session is NEVER
// blocked. Any unexpected error also falls through to allow the stop — failing
// open is the only safe failure mode for a hook that can otherwise trap a turn.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  errorMessage,
  isoTimestamp,
  recordHookDrop,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";

const HOOK_NAME = "stop";

// The block-cap ceiling: the maximum number of consecutive no-progress blocks
// before the hook releases the session. Exposed as an env var so a fork can
// tune it; defaults to 8 (the value SPIKE 1 validated against the installed
// CLI). A non-numeric / non-positive override falls back to the default rather
// than disabling the guard — the guard must never be silently turned off.
function blockCap(): number {
  const raw = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP;
  if (!raw) return DEFAULT_BLOCK_CAP;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BLOCK_CAP;
}
const DEFAULT_BLOCK_CAP = 8;

// Upper bound on the `aidlc-orchestrate next` consultation. A `next` that never
// returns must not hang the hook for the whole turn (a session trap the
// block-count guard cannot see — it only counts blocks that complete). The
// read-only engine answers in well under a second normally; 10s is generous
// headroom. On timeout the spawn returns non-zero and runEngineNextKind fails
// OPEN (allows the stop).
const ENGINE_TIMEOUT_MS = 10_000;

const projectDir = resolveProjectDirFromHook(import.meta.url);

// Write a health heartbeat (mirrors the other hooks' .aidlc-hooks-health beat).
try {
  const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
  mkdirSync(healthDir, { recursive: true });
  writeFileSync(join(healthDir, "stop.last"), isoTimestamp(), "utf-8");
} catch {
  // Heartbeat failure is non-fatal — never let it affect the stop decision.
}

// Allow the stop: emit nothing, exit 0. This is the precedent non-blocking
// pattern shared by every other framework hook. The conductor's turn ends.
function allowStop(): never {
  process.exit(0);
}

// Block the stop and inject the pending work back into the session. The reason
// is an on-task continuation (the work still owed), NOT an override-shaped
// instruction — that phrasing is the security property (see header).
function blockStop(reason: string): never {
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

// --- Recursion guard: a durable no-progress counter ---------------------------
//
// We persist a tiny JSON record keyed on the workflow's PROGRESS SIGNATURE: the
// Current Stage slug plus the audit-tail length (line count of audit.md). A
// `report` that advances the workflow pivots the stage and/or appends audit
// rows, so the signature changes — that is how we detect "progress was made
// since the last block". When the signature is unchanged across two blocks, no
// report ran in between (no progress) and we increment the counter; when it
// changes, the loop is healthy and we reset to 0.
//
// The file lives under the gitignored aidlc-docs/.aidlc-stop-hook/ alongside
// the other transient framework state. It is keyed off the project dir, so it
// is per-workflow and survives across the rapid-fire blocks within one stuck
// turn (the blocks happen in the same project; each re-invocation re-reads it).

interface GuardRecord {
  signature: string;
  count: number; // consecutive no-progress blocks observed at this signature
}

function guardFilePath(): string {
  return join(projectDir, "aidlc-docs", ".aidlc-stop-hook", "block-count.json");
}

// The current workflow position signature. Cheap, deterministic, and changes
// exactly when a report advances the workflow. We read the state file's
// Current Stage line and the audit length without importing the heavier state
// parser — a substring + line-count is enough and cannot throw on odd content.
function progressSignature(stateContent: string): string {
  const stageMatch = stateContent.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
  const stage = (stageMatch?.[1] ?? "").trim();
  let auditLen = 0;
  try {
    const auditPath = join(projectDir, "aidlc-docs", "audit.md");
    if (existsSync(auditPath)) {
      auditLen = readFileSync(auditPath, "utf-8").split("\n").length;
    }
  } catch {
    // Unreadable audit — treat as length 0; the stage component still varies.
  }
  return `${stage}::${auditLen}`;
}

function readGuard(): GuardRecord | null {
  try {
    const path = guardFilePath();
    if (!existsSync(path)) return null;
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (
      raw !== null &&
      typeof raw === "object" &&
      "signature" in raw &&
      typeof (raw as { signature: unknown }).signature === "string" &&
      "count" in raw &&
      typeof (raw as { count: unknown }).count === "number"
    ) {
      return raw as GuardRecord;
    }
  } catch {
    // Corrupt / unreadable guard file — treat as no prior record (count 0).
  }
  return null;
}

function writeGuard(record: GuardRecord): void {
  try {
    const dir = join(projectDir, "aidlc-docs", ".aidlc-stop-hook");
    mkdirSync(dir, { recursive: true });
    writeFileSync(guardFilePath(), JSON.stringify(record), "utf-8");
  } catch {
    // If we cannot persist the counter we still proceed; the stop_hook_active
    // flag remains a second, native bound (see decideBlock). Worst case the
    // counter under-counts — never over-blocks — because an unwritable record
    // reads back as count 0, and the stop_hook_active escape hatch still fires.
  }
}

// Decide whether to block, accounting for the recursion bounds. Returns true to
// block (work is pending and we are within the no-progress budget), false to
// RELEASE (let go — the ceiling is hit, so a stuck loop cannot trap the turn).
//
// PROGRESS is authoritative. The workflow position signature (Current Stage +
// audit-tail length) changes exactly when a `report` advances the workflow, so:
//   - signature CHANGED since the prior block  → progress was made; RESET the
//     streak to 1. A healthy loop that keeps advancing is never throttled, even
//     if the conductor forgets to consult the engine on every single turn.
//   - signature UNCHANGED from the prior block → no progress (no report ran);
//     INCREMENT the streak. This is the genuinely-stuck case the cap bounds.
// stop_hook_active is a secondary signal used ONLY to seed the streak when
// there is no prior record yet but Claude Code already reports this stop as the
// product of a prior block (so a sequence we are joining mid-flight starts at 2,
// not 1). It NEVER overrides an observed signature change — progress always
// wins, so the counter can only climb on real no-progress and can therefore
// only ever make us release SOONER under a true hang, never trap a live loop.
// Once the streak reaches the cap we RELEASE: a stuck loop must always let go.
function decideBlock(stateContent: string, stopHookActive: boolean): boolean {
  const cap = blockCap();
  const signature = progressSignature(stateContent);
  const prior = readGuard();

  const sameSignature = prior !== null && prior.signature === signature;

  let nextCount: number;
  if (sameSignature) {
    // No progress since the prior block at this signature — extend the streak.
    nextCount = prior.count + 1;
  } else if (prior === null && stopHookActive) {
    // No prior record, but Claude Code flags this as a post-block stop: we are
    // joining a sequence already in flight. Seed at 2 (this is at least the
    // second block) rather than under-counting from 1.
    nextCount = 2;
  } else {
    // Either a fresh first block, or the signature changed (progress was made):
    // start a new streak.
    nextCount = 1;
  }

  // Persist the updated counter for the NEXT invocation in this sequence.
  writeGuard({ signature, count: nextCount });

  // RELEASE when the no-progress streak has reached the cap. This is the
  // hardest acceptance criterion: a stuck loop must always let go.
  if (nextCount >= cap) {
    return false; // let go
  }

  return true; // within budget — block and re-feed the pending work
}

// Reset the guard once the loop reaches `done` (or any allow path with state),
// so the next stuck sequence starts its count from scratch rather than
// inheriting a stale streak from an earlier, since-resolved hang.
function resetGuard(): void {
  try {
    const dir = join(projectDir, "aidlc-docs", ".aidlc-stop-hook");
    mkdirSync(dir, { recursive: true });
    writeFileSync(guardFilePath(), JSON.stringify({ signature: "", count: 0 }), "utf-8");
  } catch {
    // Non-fatal — a stale streak only ever makes us release SOONER, never trap.
  }
}

// --- Compose the engine -------------------------------------------------------
//
// Run `aidlc-orchestrate.ts next` and return its parsed directive kind, or null
// if the engine could not be consulted (spawn failure, non-zero exit, or
// unparseable stdout). A null kind fails OPEN — the caller allows the stop —
// because we will not trap a turn on the engine's behalf when we cannot read a
// directive. We pass --project-dir explicitly so the engine resolves the same
// workspace regardless of the spawned process's cwd.
function runEngineNextKind(): string | null {
  const enginePath = join(projectDir, ".claude", "tools", "aidlc-orchestrate.ts");
  if (!existsSync(enginePath)) return null;
  // The spawn MUST be time-bounded. Without a timeout a hung `next` (an engine
  // that never returns) would hang this hook for the whole turn — a session
  // trap by a path the block-count guard cannot see. On timeout spawnSync
  // returns with a non-zero/absent exitCode (and sets `proc.error`), which the
  // null-return below treats as "engine could not be consulted" → fail OPEN
  // (allow the stop). Mirrors aidlc-sensor-fire.ts's bounded spawn.
  const proc = Bun.spawnSync({
    cmd: ["bun", enginePath, "next", "--project-dir", projectDir],
    stdout: "pipe",
    stderr: "pipe",
    timeout: ENGINE_TIMEOUT_MS,
  });
  if (proc.exitCode !== 0) return null;
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  if (stdout.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "kind" in parsed &&
      typeof (parsed as { kind: unknown }).kind === "string"
    ) {
      return (parsed as { kind: string }).kind;
    }
  } catch {
    // Unparseable directive — fail open.
  }
  return null;
}

// Build the on-task continuation injected when blocking. It names the pending
// work the conductor still owes — run the forwarding loop, act on the directive
// the engine emits, then report — and the directive kind / stage for context.
// Deliberately phrased as continuation of sanctioned work, never as an
// instruction to do something new or out-of-band (the security property).
function continuationReason(kind: string, stage: string): string {
  const where = stage.length > 0 ? ` for "${stage}"` : "";
  return (
    `The AIDLC workflow has a pending step (a ${kind} directive${where}). ` +
    "You haven't finished the forwarding loop yet. Run " +
    "`bun .claude/tools/aidlc-orchestrate.ts next`, act on the directive it " +
    "emits, then run `aidlc-orchestrate report --result <outcome>` to commit " +
    "the transition. Repeat until the engine answers `done`."
  );
}

// --- Main ---------------------------------------------------------------------

// Mirror the SubagentStop hook's stdin idiom: a TTY means no Claude Code JSON
// is coming (test/debug contexts) — allow the stop rather than block on a
// terminal read.
if (process.stdin.isTTY) allowStop();

const input = await Bun.stdin.text();

// No-op outside AIDLC: if there is no workflow state file under the project dir,
// there is nothing to enforce — allow the stop. Defends the frontmatter scoping.
const statePath = stateFilePath(projectDir);
if (!existsSync(statePath)) allowStop();

let stateContent: string;
try {
  stateContent = readFileSync(statePath, "utf-8");
} catch (e) {
  // Unreadable state — fail open (never trap) and record the drop.
  recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
  allowStop();
}

// Parse the Stop-hook input. Garbage / empty stdin must NOT crash and must NOT
// trap the turn — fail open. We only read stop_hook_active off it.
let stopHookActive = false;
try {
  const raw: unknown = JSON.parse(input);
  if (raw !== null && typeof raw === "object" && "stop_hook_active" in raw) {
    stopHookActive = (raw as { stop_hook_active: unknown }).stop_hook_active === true;
  }
} catch {
  // Malformed JSON (or empty) — proceed with stopHookActive=false. The engine
  // read below still governs whether work is pending; the counter still bounds
  // any block. We never crash on bad input.
}

// Consult the engine for the next move. A null kind (engine unavailable /
// unparseable) fails open — allow the stop.
const kind = runEngineNextKind();
if (kind === null) {
  recordHookDrop(projectDir, HOOK_NAME, "engine next returned no parseable directive; allowing stop");
  allowStop();
}

// `done` → the workflow is complete; allow the turn to end and clear the guard
// so a future stuck sequence starts fresh.
if (kind === "done") {
  resetGuard();
  allowStop();
}

// A directive is PENDING (run-stage / dispatch-subagent / invoke-swarm /
// present-gate / ask / print / error). Decide whether to block, honouring the
// recursion bounds. When the bounds say release, LET GO — a stuck loop must
// never trap the session.
const shouldBlock = decideBlock(stateContent, stopHookActive);
if (!shouldBlock) {
  recordHookDrop(
    projectDir,
    HOOK_NAME,
    `recursion guard released the stop (no-progress block cap ${blockCap()} reached; stop_hook_active=${stopHookActive})`,
  );
  allowStop();
}

// Within budget — block the stop and re-feed the pending work.
const stageMatch = stateContent.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
const stage = (stageMatch?.[1] ?? "").trim();
blockStop(continuationReason(kind, stage));
