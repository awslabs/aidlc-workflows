// Stop hook: enforce the forwarding loop on turn-end.
//
// This is one of the framework's flow-altering hooks. The advisory hooks
// observe (audit, sensors, statusline, state
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
//      aidlc-docs/.aidlc-stop-hook/. Under a no-progress ceiling exposed as
//      CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, once the count reaches the cap we LET GO
//      (allow the stop). The default ceiling is run-mode aware: an unattended
//      autonomous Construction run keeps the long ceiling (8, the loop must run
//      to completion with no human to release it), while an INTERACTIVE run uses
//      a low ceiling (2, issue #365 itself recommends BLOCK_CAP=2 as the
//      workaround) so a human who just wants to pause/chat is released after one
//      nudge, not eight. When the workflow advances, the signature changes and
//      the counter resets to 0, so a healthy loop is never throttled.
//
// Four human-wait carve-outs keep the hook from punishing a turn that ended
// *because* it is waiting on the human (or is simply conversational):
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
//   4. A CONVERSATIONAL turn ends with the human's last prompt answered and NO
//      workflow-engine engagement (the conductor ran neither aidlc-orchestrate
//      nor aidlc-state since that prompt). Issue #365's broader reading: a human
//      who just wants to CHAT mid-workflow should not be nudged at all. We read
//      the harness transcript (Claude / Codex deliver `transcript_path` on the
//      Stop payload; Kiro delivers none, so this carve-out is inert there and
//      the run-mode-aware cap above is its safety net) and ALLOW the stop when
//      the most recent genuine human prompt was answered with zero engine calls
//      (isConversationalStop below). POSITIVE-CONFIRMATION only and fail-closed:
//      it never fires under autonomous Construction, and any engine call in the
//      responding turn, an unreadable transcript, no human prompt found, or any
//      parse miss falls through to the cap-bounded block. It only ever ALLOWS;
//      it can never block more.
//
// No-op outside AIDLC. The frontmatter Stop matcher scopes this to the `aidlc`
// skill, but we defend here too: with no active workflow (no aidlc-state.md
// under the project dir) we exit 0 immediately. A non-AIDLC session is NEVER
// blocked. Any unexpected error also falls through to allow the stop — failing
// open is the only safe failure mode for a hook that can otherwise trap a turn.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditFilePath,
  composeMarkerPath,
  COMPOSE_MARKER_TTL_MS,
  docsRoot,
  errorMessage,
  getField,
  isEngineToolCall,
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
// tune it. An explicit CLAUDE_CODE_STOP_HOOK_BLOCK_CAP always wins. With no
// override the default is RUN-MODE aware:
//   - autonomous Construction -> 8 (the long ceiling SPIKE 1 validated). An
//     unattended run has no human to release it, so the loop must run far before
//     letting go; only a genuine hang should ever hit the cap there.
//   - interactive (everything else) -> 2. Issue #365 itself recommends
//     CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=2 as the workaround: a human who pauses or
//     just chats mid-workflow is released after a single nudge, not eight. A
//     healthy loop is still never throttled because real progress (a `report`)
//     changes the signature and resets the counter to 0 well before 2.
// A non-numeric / non-positive override falls back to the mode default rather
// than disabling the guard — the guard must never be silently turned off.
function blockCap(stateContent: string): number {
  const raw = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP;
  const fallback = defaultBlockCap(stateContent);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The mode-aware default cap (used when no env override is set).
function defaultBlockCap(stateContent: string): number {
  return getField(stateContent, "Construction Autonomy Mode")?.trim() === "autonomous"
    ? AUTONOMOUS_BLOCK_CAP
    : INTERACTIVE_BLOCK_CAP;
}
const AUTONOMOUS_BLOCK_CAP = 8;
const INTERACTIVE_BLOCK_CAP = 2;

// Upper bound on the `aidlc-orchestrate next` consultation. A `next` that never
// returns must not hang the hook for the whole turn (a session trap the
// block-count guard cannot see — it only counts blocks that complete). The
// read-only engine answers in well under a second normally; 10s is generous
// headroom. On timeout the spawn returns non-zero and runEngineNextDirective fails
// OPEN (allows the stop).
const ENGINE_TIMEOUT_MS = 10_000;

// Allow the stop: emit nothing, exit 0. This is the precedent non-blocking
// pattern shared by every other framework hook. The conductor's turn ends.
function allowStop(): number {
  return 0;
}

// Block the stop and inject the pending work back into the session. The reason
// is an on-task continuation (the work still owed), NOT an override-shaped
// instruction — that phrasing is the security property (see header).
function blockStop(reason: string): number {
  console.log(JSON.stringify({ decision: "block", reason }));
  return 0;
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

function guardFilePath(projectDir: string): string {
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
function progressSignature(projectDir: string, stateContent: string): string {
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

function readGuard(projectDir: string): GuardRecord | null {
  try {
    const path = guardFilePath(projectDir);
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

function writeGuard(projectDir: string, record: GuardRecord): void {
  try {
    const dir = stopHookDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(guardFilePath(projectDir), JSON.stringify(record), "utf-8");
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
function decideBlock(projectDir: string, stateContent: string, stopHookActive: boolean): boolean {
  const cap = blockCap(stateContent);
  const signature = progressSignature(projectDir, stateContent);
  const prior = readGuard(projectDir);

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
  writeGuard(projectDir, { signature, count: nextCount });

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
function resetGuard(projectDir: string): void {
  try {
    const dir = stopHookDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(guardFilePath(projectDir), JSON.stringify({ signature: "", count: 0 }), "utf-8");
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
//      current stage's canonical dir, or the exact active-unit dir carried by a
//      Construction directive, has at least one `[Answer]:` tag that is empty or
//      underscores-only. No file, all answered, or any read error → false (fall
//      through to the cap).
//   2. AUTONOMY GUARD — never fires under autonomous Construction
//      (`Construction Autonomy Mode: autonomous`). There the loop MUST keep
//      running unattended (gates are skipped; a failure halt-and-asks via its
//      own path), so a stray open question must not release the stop and strand
//      the run waiting on a human who was told they weren't needed.
// Fail-open throughout: any error returns false and the cap-bounded block stands.

// True when the `<slug>-questions.md` under the active stage dir has an
// unanswered tag.
// An `[Answer]:` line is "unanswered" when, after the colon, only whitespace or
// underscores remain (stage-protocol.md:333 — "blank or contains only
// underscores"). Standard stages use `<record>/<phase>/<slug>/`; a per-unit
// Construction directive carries its exact unit and uses
// `<record>/construction/<unit>/<slug>/`. We never recursively accept a question
// from a different unit: an old unanswered file must not disable enforcement for
// the unit currently named by the engine.
function hasPendingQuestion(
  projectDir: string,
  slug: string,
  phase: string,
  unit?: string,
): boolean {
  if (slug.length === 0 || phase.length === 0) return false;
  const normalizedPhase = phase.toLowerCase();
  const stageDirPath =
    normalizedPhase === "construction" && unit
      ? join(docsRoot(projectDir), normalizedPhase, unit, slug)
      : stageDir(projectDir, normalizedPhase, slug);
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
function isPendingQuestionStop(
  projectDir: string,
  stateContent: string,
  unit?: string,
): boolean {
  try {
    if (getField(stateContent, "Construction Autonomy Mode")?.trim() === "autonomous") {
      return false; // autonomy guard — keep the loop alive
    }
    const slug = currentStageSlug(stateContent);
    if (slug.length === 0) return false;
    const row = parseCheckboxes(stateContent).find((c) => c.slug === slug);
    if (row?.state !== "in-progress") return false; // positive [-] only
    const phase = getField(stateContent, "Lifecycle Phase") ?? "";
    return hasPendingQuestion(projectDir, slug, phase, unit);
  } catch {
    // Unparseable / odd content — fall through to decideBlock (never trap).
    return false;
  }
}

// --- Tier-2b: pending in-flight compose proposal carve-out --------------------
//
// The adaptive composer's IN-FLIGHT approve/edit/reject gate is a turn-stop
// like a stage gate, but it has no [?]/[R] checkbox signal: the current stage
// stays [ ]/[-], so this hook's bare-`next` probe sees the pending run-stage
// and would block the turn - shoving the conductor back into stage execution
// mid-compose and abandoning the gate (the mid-workflow trap class, reopened
// for compose). POSITIVE-CONFIRMATION: the conductor writes the marker file
// `aidlc/.aidlc-compose-pending` before presenting the gate (the engine's
// compose dispatch print instructs it) and deletes it on approve/reject, the
// same disk-signal discipline as tier-2's <slug>-questions.md. AUTONOMY GUARD:
// never fires under autonomous Construction (an unattended run has no human to
// answer the gate; a stray marker must not strand it). Fail-open: any read
// error falls through to the cap-bounded block. Front/report composes are
// unaffected (cold start has no state file; the hook allows before this).
//
// STALENESS BOUND. The conductor owns the write/delete, but a session that
// crashes or is killed between "write the marker" and "gate resolves" leaves the
// marker on disk forever - a permanently open carve-out that silently disables
// the forwarding-loop enforcement for the whole workspace until someone
// hand-deletes a hidden file they have never heard of. So the carve-out honours
// the marker ONLY while it is FRESH: younger than COMPOSE_MARKER_TTL_MS by its
// mtime. The window is generous (24h) so a human who steps away from an open
// gate for a long pause is still covered; anything older is an orphan, not a
// live gate. A stale marker is IGNORED (fall through to the cap-bounded block)
// AND best-effort deleted here (the janitor), so the next turn starts clean.
// The delete is wrapped so a failure to unlink never changes the stop decision.
// The path spelling and the TTL are shared with the doctor probe via aidlc-lib.
function isPendingComposeStop(projectDir: string, stateContent: string): boolean {
  try {
    if (getField(stateContent, "Construction Autonomy Mode")?.trim() === "autonomous") {
      return false; // autonomy guard - keep the loop alive
    }
    const marker = composeMarkerPath(projectDir);
    if (!existsSync(marker)) return false;
    const ageMs = Date.now() - statSync(marker).mtimeMs;
    if (ageMs <= COMPOSE_MARKER_TTL_MS) return true; // fresh - honour the carve-out
    // Orphaned marker: do not honour it, and best-effort clean it up so it
    // cannot disable the enforcement loop indefinitely.
    try {
      unlinkSync(marker);
    } catch {
      // Unlink failure is non-fatal - the staleness check above already refused
      // to honour the marker, so the loop stays enforced regardless.
    }
    recordHookDrop(
      projectDir,
      HOOK_NAME,
      "ignoring an orphaned compose marker (aidlc/.aidlc-compose-pending older than the freshness window); cleaned it up and falling through to the cap-bounded block",
    );
    return false;
  } catch {
    return false;
  }
}

// --- Tier-3: conversational-turn carve-out (issue #365 broader reading) -------
//
// Issue #365's literal fix is `park` (the conductor explicitly pauses the run).
// But the reported pain is broader: during an ACTIVE workflow a human who just
// wants to CHAT (ask a question, discuss a decision, course-correct) should
// not be nudged back into the forwarding loop at all. Park does not cover that
// (it is not automatic). This carve-out does: when the turn that is ending was
// CONVERSATIONAL (the most recent genuine human prompt was answered with NO
// workflow-engine engagement, i.e. the conductor ran neither aidlc-orchestrate
// nor aidlc-state since that prompt) we ALLOW the stop.
//
// The signal is the harness transcript. Claude and Codex both deliver a
// `transcript_path` on the Stop payload (Claude JSONL; Codex date-sharded
// rollout JSONL); Kiro delivers none, so on Kiro this carve-out is simply inert
// and the run-mode-aware low interactive cap (blockCap) is the safety net that
// releases a chatting human after one nudge instead of eight.
//
// Two strict gates make this safe (it can still only ever ALLOW, never block
// more), mirroring isPendingQuestionStop:
//   1. POSITIVE-CONFIRMATION: allow only on a transcript we could read that
//      shows a genuine human prompt answered with zero engine calls. A missing
//      path, unreadable file, no human prompt found, or ANY engine call in the
//      responding turn returns false (fall through to the cap-bounded block).
//   2. AUTONOMY GUARD: never fires under autonomous Construction. There the
//      loop must keep running unattended; there is no human chatting to release.
// Fail-closed throughout: any error returns false and the cap-bounded block stands.

// True when a user-role transcript entry's text is actually the hook's OWN
// injected continuation (a re-prompt after a block), not the human talking.
// Two shapes: Claude Code wraps the block reason as "Stop hook feedback: ..."
// (isMeta:true), but other harnesses (Codex) may re-inject the RAW reason text
// with no wrapper. continuationReason() (below) always opens with "The AIDLC
// workflow has a pending step" and names "the forwarding loop", so match either
// signature. Excluding these is what keeps an engine-engaged turn whose last
// user entry is the hook's nudge from being misread as a fresh human prompt.
function isInjectedHookFeedback(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("Stop hook feedback:") ||
    (t.startsWith("The AIDLC workflow has a pending step") &&
      /forwarding loop/.test(t))
  );
}

// Read the transcript and classify the ending turn as conversational. Supports
// both delivered formats; returns true ONLY with positive evidence. `format`
// distinguishes Claude's message-shaped JSONL from Codex's {type,payload}
// rollout. Fail-closed on every miss.
function transcriptIsConversational(transcriptPath: string, format: "claude" | "codex"): boolean {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return false; // unreadable transcript: fall through to the cap
  }
  const lines = raw.split("\n");
  // Parse to a flat sequence of {role, engineCall} events in file order.
  type Turn = { role: "user" | "assistant"; engineCall: boolean; humanPrompt: boolean };
  const turns: Turn[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // skip non-JSON / partial lines
    }
    if (o === null || typeof o !== "object") continue;
    const entry = o as Record<string, unknown>;
    if (format === "claude") {
      // Claude JSONL: {type:"user"|"assistant", message:{role, content}}.
      const type = entry.type;
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const role = message.role;
      const content = message.content;
      if (type === "user" && role === "user") {
        // SKIP synthetic / non-human user turns. Claude Code records several
        // things as `type:"user"` that are NOT the human talking:
        //   - `isMeta: true` entries: the Stop hook's OWN injected block-feedback
        //     ("Stop hook feedback: ...") and command-message wrappers. Counting
        //     these as a human prompt would let the hook's own nudge masquerade
        //     as the human, so an engine-engaged turn could be misread as chat.
        //   - tool_result arrays: a tool's output, not a prompt.
        // Both must be excluded so "the most recent genuine human prompt" is the
        // human, not the harness.
        if (entry.isMeta === true) continue;
        const isToolResult =
          Array.isArray(content) &&
          content.some((x) => (x as Record<string, unknown>)?.type === "tool_result");
        if (isToolResult) continue; // a tool_result is not a human prompt
        // Defence-in-depth: the hook's continuation text is injected as a user
        // turn; exclude it by content even if a future build drops `isMeta`.
        const asText =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((x) => {
                    const b = x as Record<string, unknown>;
                    return b?.type === "text" ? String(b.text ?? "") : "";
                  })
                  .join("")
              : "";
        if (isInjectedHookFeedback(asText)) continue;
        // A genuine human prompt: string content, or an array with a text block.
        const isHuman =
          typeof content === "string" ||
          (Array.isArray(content) &&
            content.some((x) => (x as Record<string, unknown>)?.type === "text"));
        if (isHuman) turns.push({ role: "user", engineCall: false, humanPrompt: true });
      } else if (type === "assistant" && role === "assistant" && Array.isArray(content)) {
        let engineCall = false;
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b?.type === "tool_use" && isEngineToolCall(String(b.name ?? ""), b.input)) {
            engineCall = true;
            break;
          }
        }
        turns.push({ role: "assistant", engineCall, humanPrompt: false });
      }
    } else {
      // Codex rollout JSONL: {type:"response_item", payload:{type, role, content,
      // name, ...}}. function_call entries carry the tool name/arguments.
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (entry.type !== "response_item" || !payload) continue;
      const ptype = payload.type;
      if (ptype === "message" && payload.role === "user") {
        // input_text blocks are the human prompt; tool output rides function_call_output.
        const content = payload.content;
        // Exclude the hook's own injected continuation (delivered as a user
        // message on a re-prompt) so it is not mistaken for the human, mirroring
        // the Claude reader's `Stop hook feedback:` guard.
        const asText =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((x) => {
                    const b = x as Record<string, unknown>;
                    return b?.type === "input_text" || b?.type === "text" ? String(b.text ?? "") : "";
                  })
                  .join("")
              : "";
        if (isInjectedHookFeedback(asText)) continue;
        const isHuman =
          typeof content === "string" ||
          (Array.isArray(content) &&
            content.some((x) => {
              const t = (x as Record<string, unknown>)?.type;
              return t === "input_text" || t === "text";
            }));
        if (isHuman) turns.push({ role: "user", engineCall: false, humanPrompt: true });
      } else if (ptype === "message" && payload.role === "assistant") {
        turns.push({ role: "assistant", engineCall: false, humanPrompt: false });
      } else if (ptype === "function_call" || ptype === "local_shell_call") {
        const name = String(payload.name ?? (ptype === "local_shell_call" ? "Shell" : ""));
        const args = payload.arguments ?? payload.action ?? {};
        // function_call arguments are a JSON string on Codex; parse leniently.
        let parsedArgs: Record<string, unknown> = {};
        if (typeof args === "string") {
          try {
            const j = JSON.parse(args);
            parsedArgs = j !== null && typeof j === "object" ? (j as Record<string, unknown>) : { command: args };
          } catch {
            parsedArgs = { command: args };
          }
        } else if (args !== null && typeof args === "object") {
          parsedArgs = args as Record<string, unknown>;
        }
        // Normalise the command field so isEngineToolCall sees the full command
        // text (Codex may key it `command`, or carry it as the raw arguments
        // string). Routing it ALL through isEngineToolCall keeps the read-only
        // exemption (--status etc.) consistent across both transcript formats,
        // rather than a loose regex that would re-flag a read-only query.
        if (typeof parsedArgs.command !== "string") {
          parsedArgs = { ...parsedArgs, command: typeof args === "string" ? args : JSON.stringify(args) };
        }
        const engineCall = isEngineToolCall(
          /^(bash|shell|execute_bash|local_shell_call)$/i.test(name) ? "Bash" : name,
          parsedArgs,
        );
        turns.push({ role: "assistant", engineCall, humanPrompt: false });
      }
    }
  }

  // Find the most recent genuine human prompt.
  let lastHumanIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].humanPrompt) {
      lastHumanIdx = i;
      break;
    }
  }
  if (lastHumanIdx === -1) return false; // no human prompt found: cannot confirm chat

  // Any engine call AFTER that prompt means the conductor engaged the workflow;
  // a mid-loop bail must still be nudged. Zero engine calls -> conversational.
  for (let i = lastHumanIdx + 1; i < turns.length; i++) {
    if (turns[i].engineCall) return false;
  }
  return true;
}

// The tier-3 carve-out decision: not autonomous, a transcript was delivered, and
// it shows a conversational ending turn. `transcriptPath`/`format` come from the
// Stop payload (Claude / Codex); both are absent on Kiro, where this returns
// false and the low interactive cap handles the chat case instead.
function isConversationalStop(
  stateContent: string,
  transcriptPath: string | null,
  format: "claude" | "codex",
): boolean {
  try {
    if (getField(stateContent, "Construction Autonomy Mode")?.trim() === "autonomous") {
      return false; // autonomy guard: keep the loop alive
    }
    if (transcriptPath === null || transcriptPath.length === 0) return false;
    return transcriptIsConversational(transcriptPath, format);
  } catch {
    // Unparseable / odd content: fall through to decideBlock (never trap).
    return false;
  }
}

// --- Compose the engine -------------------------------------------------------
//
interface EngineDirective {
  kind: string;
  unit?: string;
}

// Run `aidlc-orchestrate.ts next` and return the parsed directive fields the
// hook needs, or null
// if the engine could not be consulted (spawn failure, non-zero exit, or
// unparseable stdout). A null directive fails OPEN — the caller allows the stop —
// because we will not trap a turn on the engine's behalf when we cannot read a
// directive. We pass --project-dir explicitly so the engine resolves the same
// workspace regardless of the spawned process's cwd.
function runEngineNextDirective(projectDir: string): EngineDirective | null {
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
      const kind = (parsed as { kind: string }).kind;
      const unit =
        "unit" in parsed && typeof (parsed as { unit?: unknown }).unit === "string"
          ? (parsed as { unit: string }).unit.trim()
          : "";
      return unit.length > 0 ? { kind, unit } : { kind };
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
    "the transition. Repeat until the engine answers `done`. " +
    "If instead you mean to pause this workflow for now (and resume in a later " +
    `session), run \`bun ${harnessDir()}/tools/aidlc-orchestrate.ts park\` to park it ` +
    "cleanly at this inter-stage boundary - never mark stages complete just to end the turn."
  );
}

// --- Main ---------------------------------------------------------------------

export async function run(input: string): Promise<number> {
const projectDir = resolveProjectDirFromHook(import.meta.url);

// Write a health heartbeat (mirrors the other hooks' .aidlc-hooks-health beat).
try {
  const healthDir = hooksHealthDir(projectDir);
  mkdirSync(healthDir, { recursive: true });
  writeFileSync(join(healthDir, "stop.last"), isoTimestamp(), "utf-8");
} catch {
  // Heartbeat failure is non-fatal — never let it affect the stop decision.
}

// Mirror the SubagentStop hook's stdin idiom: a TTY means no Claude Code JSON
// is coming (test/debug contexts) — allow the stop rather than block on a
// terminal read.
if (process.stdin.isTTY) return allowStop();

// No-op outside AIDLC: if there is no workflow state file under the project dir,
// there is nothing to enforce — allow the stop. Defends the frontmatter scoping.
const statePath = stateFilePath(projectDir);
if (!existsSync(statePath)) return allowStop();

let stateContent: string;
try {
  stateContent = readFileSync(statePath, "utf-8");
} catch (e) {
  // Unreadable state — fail open (never trap) and record the drop.
  recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
  return allowStop();
}

// Parse the Stop-hook input. Garbage / empty stdin must NOT crash and must NOT
// trap the turn (fail open). We read `stop_hook_active` (the recursion bound)
// and `transcript_path` (the conversational carve-out, tier 3). Claude and Codex
// both deliver `transcript_path`; Kiro delivers neither, so transcriptPath stays
// null there and the conversational carve-out is inert (the low interactive cap
// handles chat instead).
let stopHookActive = false;
let transcriptPath: string | null = null;
// Transcript format: Codex's rollout JSONL lives under a `.../sessions/<date>/
// rollout-*.jsonl` path and uses a {type,payload} shape; Claude's is message-
// shaped JSONL. Default to Claude; switch to Codex when the path looks like a
// Codex rollout. (Both readers fail-closed, so a misclassification can only ever
// return false and fall through to the cap, never a false allow.)
let transcriptFormat: "claude" | "codex" = "claude";
try {
  const raw: unknown = JSON.parse(input);
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("stop_hook_active" in obj) stopHookActive = obj.stop_hook_active === true;
    if (typeof obj.transcript_path === "string" && obj.transcript_path.length > 0) {
      transcriptPath = obj.transcript_path;
      if (/[/\\]rollout-[^/\\]*\.jsonl$/.test(transcriptPath)) transcriptFormat = "codex";
    }
  }
} catch {
  // Malformed JSON (or empty): proceed with stopHookActive=false and no
  // transcript. The engine read below still governs whether work is pending; the
  // counter still bounds any block. We never crash on bad input.
}

// Consult the engine for the next move. A null directive (engine unavailable /
// unparseable) fails open — allow the stop.
const directive = runEngineNextDirective(projectDir);
if (directive === null) {
  recordHookDrop(projectDir, HOOK_NAME, "engine next returned no parseable directive; allowing stop");
  return allowStop();
}
const kind = directive.kind;

// `done` → the workflow is complete; allow the turn to end and clear the guard
// so a future stuck sequence starts fresh.
if (kind === "done") {
  resetGuard(projectDir);
  return allowStop();
}

// `parked` -> the workflow was intentionally parked mid-flow (issue #367); a
// human resumes it later with /aidlc --resume. This is the SUPPORTED
// multi-session exit: allow the turn to end and clear the guard exactly like
// `done`, so the conductor parks at a clean inter-stage boundary instead of
// rubber-stamping the remaining stages to force a `done`. Terminal allow only
// (never a new block), so it can never trap a session.
//
// AUTONOMY GUARD (salvaged from the #365 suspend branch): an unattended
// autonomous Construction run (`Construction Autonomy Mode: autonomous`) MUST
// keep moving and never self-park. There is no human to resume it later, so a
// park would strand the swarm/Bolt run waiting on someone who was told they
// weren't needed. When autonomous, decline the parked allow and fall through to
// the cap-bounded block below (the loop stays alive; a genuine hang still
// releases via the no-progress cap). This mirrors isPendingQuestionStop's
// identical guard (:391) for consistency across every carve-out in this hook.
if (kind === "parked") {
  if (getField(stateContent, "Construction Autonomy Mode")?.trim() === "autonomous") {
    recordHookDrop(
      projectDir,
      HOOK_NAME,
      "parked directive seen under autonomous Construction; declining the parked allow (an unattended run must not self-park), falling through to the cap-bounded block",
    );
  } else {
    resetGuard(projectDir);
    return allowStop();
  }
}

// `ask` → the engine is explicitly waiting for human input (resume re-entry or
// freeform scope confirmation; aidlc-orchestrate.ts:1040,1105). Allow the turn
// to end so the user can respond, rather than re-feeding the loop.
if (kind === "ask") {
  return allowStop();
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
  return allowStop();
}

// Pending-question carve-out (tier 2): the current [-] stage has an unanswered
// question in its `<slug>-questions.md`, and we are NOT in autonomous
// Construction — so the conductor is parked on the human's answer to a
// mid-stage clarifying question. Allow the stop instead of nudging. Strictly
// gated and fail-open (see isPendingQuestionStop): any other state, no open
// question, an autonomous run, or a read error falls through to the cap-bounded
// block below, so a genuine mid-stage quit (and every autonomous run) is
// unaffected.
if (isPendingQuestionStop(projectDir, stateContent, directive.unit)) {
  recordHookDrop(
    projectDir,
    HOOK_NAME,
    `current stage ${currentStageSlug(stateContent)} has an unanswered question; allowing the stop (pending-question carve-out)`,
  );
  return allowStop();
}

// Pending-compose carve-out (tier 2b): an in-flight compose proposal is
// awaiting the human's approve/edit/reject (the conductor's marker file is on
// disk) and we are NOT in autonomous Construction - the conductor is parked on
// the human exactly like a stage gate, so allow the turn to end instead of
// nudging it back into stage execution mid-compose. Positive-confirmation only
// (the marker), autonomy-guarded, fail-open (see isPendingComposeStop).
if (isPendingComposeStop(projectDir, stateContent)) {
  recordHookDrop(
    projectDir,
    HOOK_NAME,
    "an in-flight compose proposal is pending human approval (aidlc/.aidlc-compose-pending present); allowing the stop (pending-compose carve-out)",
  );
  return allowStop();
}

// Conversational carve-out (tier 3, issue #365 broader reading): the ending turn
// answered the human's most recent prompt with NO workflow-engine engagement, so
// the human was just chatting mid-workflow, allow the stop instead of nudging
// them back into the loop. Reads the harness transcript (Claude / Codex deliver
// `transcript_path`; Kiro delivers none, so this is inert there and the low
// interactive cap below releases a chatting human after one nudge). Strictly
// gated and fail-closed (see isConversationalStop): no transcript, no human
// prompt, ANY engine call in the responding turn, an autonomous run, or any read
// error falls through to the cap-bounded block below, so a conductor that
// engaged the workflow and then quit mid-loop (and every autonomous run) is
// still nudged.
if (isConversationalStop(stateContent, transcriptPath, transcriptFormat)) {
  recordHookDrop(
    projectDir,
    HOOK_NAME,
    "the ending turn was conversational (human's last prompt answered with no workflow-engine call); allowing the stop (conversational carve-out)",
  );
  return allowStop();
}

// A directive is PENDING (run-stage / dispatch-subagent / invoke-swarm /
// present-gate / ask / print / error). Decide whether to block, honouring the
// recursion bounds. When the bounds say release, LET GO — a stuck loop must
// never trap the session.
const shouldBlock = decideBlock(projectDir, stateContent, stopHookActive);
if (!shouldBlock) {
  recordHookDrop(
    projectDir,
    HOOK_NAME,
    `recursion guard released the stop (no-progress block cap ${blockCap(stateContent)} reached; stop_hook_active=${stopHookActive})`,
  );
  return allowStop();
}

// Within budget — block the stop and re-feed the pending work.
return blockStop(continuationReason(kind, currentStageSlug(stateContent)));
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
