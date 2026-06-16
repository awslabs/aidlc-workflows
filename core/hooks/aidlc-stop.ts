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
// Three human-wait carve-outs keep the hook from punishing a turn that ended
// *because* it is waiting on the human:
//   1. The Esc interrupt is FREE: Stop hooks do not fire on user interrupt, so
//      an Esc can never be trapped — no code needed for that case.
//   2. The interactive GATE is not free: the Stop hook DOES fire when the
//      conductor ends its turn to await an `AskUserQuestion` answer. At an
//      approval gate ([?] awaiting-approval) or in the Request-Changes loop
//      ([R] revising) the engine still returns a pending run-stage (the stage is
//      in-flight, aidlc-orchestrate.ts:1161-1176), so without a carve-out the
//      hook would block and spam the forwarding-loop nudge until the cap bleeds
//      out. So when the current stage's checkbox is positively [?]/[R] we ALLOW
//      the stop (isHumanWaitStop below). Positive-confirmation only and
//      fail-open: stateless cases fall through to the cap-bounded block.
//   3. A mid-stage CLARIFYING QUESTION parks the stage at [-] in-progress — the
//      same state as a lazy quit, so [-] alone can't be carved out. But the
//      conductor must write a `<slug>-questions.md` with blank [Answer]: tags
//      before asking (stage-protocol.md §3); an unanswered tag is a positive
//      signal that a question is pending, so we ALLOW the stop then too
//      (isPendingQuestionStop below). Strictly gated: it never fires under
//      autonomous Construction (the loop must keep running there), and any miss
//      — no file, all answered, autonomous, or a read error — falls through to
//      the cap-bounded block, so a genuine mid-stage quit is still nudged.
//
// No-op outside AIDLC. The frontmatter Stop matcher scopes this to the `aidlc`
// skill, but we defend here too: with no active workflow (no aidlc-state.md
// under the project dir) we exit 0 immediately. A non-AIDLC session is NEVER
// blocked. Any unexpected error also falls through to allow the stop — failing
// open is the only safe failure mode for a hook that can otherwise trap a turn.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditFilePath,
  errorMessage,
  getField,
  hooksHealthDir,
  isoTimestamp,
  parseCheckboxes,
  recordHookDrop,
  resolveProjectDirFromHook,
  stageDir,
  stateFilePath,
  stopHookDir,
  harnessDir,
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
  const healthDir = hooksHealthDir(projectDir);
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
  return join(stopHookDir(projectDir), "block-count.json");
}

// The Current Stage slug from the state file. Factored from the regex the
// signature and continuation both used inline (was duplicated at two sites);
// returns "" when the field is absent. Matches `**Current Stage**:`, with or
// without the bold markers / backticks, exactly as before.
function currentStageSlug(stateContent: string): string {
  const stageMatch = stateContent.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
  return (stageMatch?.[1] ?? "").trim();
}

// The current workflow position signature. Cheap, deterministic, and changes
// exactly when a report advances the workflow. We read the state file's
// Current Stage line and the audit length without importing the heavier state
// parser — a substring + line-count is enough and cannot throw on odd content.
function progressSignature(stateContent: string): string {
  const stage = currentStageSlug(stateContent);
  let auditLen = 0;
  try {
    const auditPath = auditFilePath(projectDir);
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
    const dir = stopHookDir(projectDir);
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
    const dir = stopHookDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(guardFilePath(), JSON.stringify({ signature: "", count: 0 }), "utf-8");
  } catch {
    // Non-fatal — a stale streak only ever makes us release SOONER, never trap.
  }
}

// --- Human-wait carve-out -----------------------------------------------------
//
// The block path punishes a conductor that quit mid-loop. But a conductor parked
// at an approval gate or in the Request-Changes loop has ALSO ended its turn with
// the engine still returning a pending directive — and from the engine's vantage
// it looks identical, because a stage in `awaiting-approval` ([?]) or `revising`
// ([R]) is still "in-flight", so `next` re-emits a run-stage for it
// (aidlc-orchestrate.ts:1161-1176). Yet these states exist BECAUSE the human was
// engaged: [?] only because a gate is open awaiting approve/reject, [R] only
// because changes were just requested. Blocking there spams the forwarding-loop
// nudge until the cap bleeds out — confusing and unprofessional at an
// interactive gate.
//
// So when the CURRENT stage's checkbox is positively in one of those states,
// allow the stop. This is the only safe widening of an allow: it can only ever
// make the hook release MORE readily, never block more.
//
// One honest caveat on [R]: the row stays `revising` across the WHOLE rework
// window (it flips back to [?] only when the conductor calls `revise`; see
// stage-protocol.md:164). So [R] covers both the human-wait prompt ("what would
// you like changed?") AND the autonomous rework edits that follow. Allowing the
// stop on [R] means a conductor that quits mid-rework is not nudged — the same
// [-]-style ambiguity we accept for in-progress, here scoped to a window the
// human just opened. It is still only ever an allow (never blocks more), and the
// dominant [R] experience is the human-wait prompt this carve-out targets.
//
// POSITIVE-CONFIRMATION ONLY. We allow ONLY when a checkbox row for the current
// slug exists AND its state is [?]/[R]. No rows, slug not found, or any other
// state → return false and fall through. [-] in-progress is NOT carved out HERE:
// it is also the normal "stage work still owed" state, indistinguishable from a
// lazy mid-stage quit by checkbox alone, so a blanket [-] carve-out would gut
// the hook. (A mid-stage [-] stage with a genuinely pending question is handled
// separately and conservatively by isPendingQuestionStop below, which keys off
// the conductor's questions file rather than checkbox state.) Any parse error
// falls through too: fail-open is the only safe failure mode for a hook that can
// otherwise trap a turn.
function isHumanWaitStop(stateContent: string): boolean {
  try {
    const slug = currentStageSlug(stateContent);
    if (slug.length === 0) return false;
    const row = parseCheckboxes(stateContent).find((c) => c.slug === slug);
    return row?.state === "awaiting-approval" || row?.state === "revising";
  } catch {
    // Unparseable / odd content — fall through to decideBlock (never trap).
    return false;
  }
}

// --- Tier-2: pending mid-stage question carve-out -----------------------------
//
// A clarifying question asked mid-stage leaves the stage at [-] in-progress —
// the SAME checkbox state as a conductor that lazily quit, so [-] alone cannot
// be carved out (tier 1 deliberately left it to the cap). But there IS a
// conductor-emitted artifact that disambiguates: stage-protocol.md §3 mandates a
// `<slug>-questions.md` is created (Step 1) with blank `[Answer]:` tags before
// the conductor asks, and every tag is filled before the stage proceeds (Step
// 4). So a questions file with an UNANSWERED tag means a question is genuinely
// pending — the conductor is parked on the human, exactly like a gate.
//
// Two strict gates make this safe (it can still only ever ALLOW, never block
// more):
//   1. POSITIVE-CONFIRMATION — allow only when a `<slug>-questions.md` under the
//      current stage's dir (aidlc-docs/<phase>/<slug>/, mirroring memoryPathFor)
//      has at least one `[Answer]:` tag that is empty or underscores-only. No
//      file, all answered, or any read error → false (fall through to the cap).
//   2. AUTONOMY GUARD — never fires under autonomous Construction
//      (`Construction Autonomy Mode: autonomous`). There the loop MUST keep
//      running unattended (gates are skipped; a failure halt-and-asks via its
//      own path), so a stray open question must not release the stop and strand
//      the run waiting on a human who was told they weren't needed.
// Fail-open throughout: any error returns false and the cap-bounded block stands.

// True when the `<slug>-questions.md` under the stage dir has an unanswered tag.
// An `[Answer]:` line is "unanswered" when, after the colon, only whitespace or
// underscores remain (stage-protocol.md:333 — "blank or contains only
// underscores"). Scans the stage dir for any *-questions.md (the canonical name
// is `<slug>-questions.md`, but matching the suffix is robust to the per-unit
// Construction `{unit}` path segment the engine does not yet resolve).
function hasPendingQuestion(slug: string, phase: string): boolean {
  if (slug.length === 0 || phase.length === 0) return false;
  const stageDirPath = stageDir(projectDir, phase.toLowerCase(), slug);
  if (!existsSync(stageDirPath)) return false;
  let files: string[];
  try {
    files = readdirSync(stageDirPath).filter((f) => f.endsWith("-questions.md"));
  } catch {
    return false;
  }
  for (const f of files) {
    let body: string;
    try {
      body = readFileSync(join(stageDirPath, f), "utf-8");
    } catch {
      continue;
    }
    // An [Answer]: tag whose value (to end of line) is empty or underscores-only.
    if (/\[Answer\]:[ \t]*_*[ \t]*$/m.test(body)) return true;
  }
  return false;
}

// The tier-2 carve-out decision: the current stage is [-] in-progress, a
// question is pending, and we are NOT in autonomous Construction.
function isPendingQuestionStop(stateContent: string): boolean {
  try {
    if (getField(stateContent, "Construction Autonomy Mode")?.trim() === "autonomous") {
      return false; // autonomy guard — keep the loop alive
    }
    const slug = currentStageSlug(stateContent);
    if (slug.length === 0) return false;
    const row = parseCheckboxes(stateContent).find((c) => c.slug === slug);
    if (row?.state !== "in-progress") return false; // positive [-] only
    const phase = getField(stateContent, "Lifecycle Phase") ?? "";
    return hasPendingQuestion(slug, phase);
  } catch {
    // Unparseable / odd content — fall through to decideBlock (never trap).
    return false;
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
  const enginePath = join(projectDir, harnessDir(), "tools", "aidlc-orchestrate.ts");
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
    `\`bun ${harnessDir()}/tools/aidlc-orchestrate.ts next\`, act on the directive it ` +
    "emits, then run `aidlc-orchestrate report --stage <stage> --result <outcome>` to commit " +
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

// `ask` → the engine is explicitly waiting for human input (resume re-entry or
// freeform scope confirmation; aidlc-orchestrate.ts:1040,1105). Allow the turn
// to end so the user can respond, rather than re-feeding the loop.
if (kind === "ask") {
  allowStop();
}

// Human-wait carve-out: the engine returns a pending directive, but the current
// stage is positively at [?] awaiting-approval or [R] revising — the conductor
// is correctly parked on the human (an approval gate or the Request-Changes
// loop), with genuinely nothing to do without their input. Allow the stop
// instead of spamming the forwarding-loop nudge. Positive-confirmation only and
// fail-open (see isHumanWaitStop): any other state, no checkbox row, or a parse
// error falls through to the cap-bounded block below, unchanged. (This is the
// current-stage-scoped successor to the broad `[?]` substring match that landed
// in 679153d; scoping to the current slug and adding [R] is strictly safer.)
if (isHumanWaitStop(stateContent)) {
  recordHookDrop(
    projectDir,
    HOOK_NAME,
    `current stage ${currentStageSlug(stateContent)} is awaiting approval or being revised; allowing the stop (human-wait carve-out)`,
  );
  allowStop();
}

// Pending-question carve-out (tier 2): the current [-] stage has an unanswered
// question in its `<slug>-questions.md`, and we are NOT in autonomous
// Construction — so the conductor is parked on the human's answer to a
// mid-stage clarifying question. Allow the stop instead of nudging. Strictly
// gated and fail-open (see isPendingQuestionStop): any other state, no open
// question, an autonomous run, or a read error falls through to the cap-bounded
// block below, so a genuine mid-stage quit (and every autonomous run) is
// unaffected.
if (isPendingQuestionStop(stateContent)) {
  recordHookDrop(
    projectDir,
    HOOK_NAME,
    `current stage ${currentStageSlug(stateContent)} has an unanswered question; allowing the stop (pending-question carve-out)`,
  );
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
blockStop(continuationReason(kind, currentStageSlug(stateContent)));
