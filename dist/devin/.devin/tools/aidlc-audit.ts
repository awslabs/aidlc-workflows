import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  acquireAuditLock,
  assertNoSymlinkInChainOrThrow,
  auditFilePath,
  claimAttemptFields,
  cloneIdPath,
  errorMessage,
  hasUnsafeSingleLineCharacter,
  isoTimestamp,
  parseFieldArgs,
  redactProjectDirPrefix,
  relativeRecordDir,
  readRegularFileNoFollowOrThrow,
  releaseAuditLock,
  requireLiveClaimForTeamUnit,
  resolveProjectDir,
  validateBoltSlug,
  validateLiveUnitScope,
  worktreeClaimBoundaryMatches,
  worktreeAuditFilePath,
  worktreePath,
  writeBufferAtomic,
} from "./aidlc-lib.ts";

// --- Canonical event types (the parity tests derive the count from this set) ---
// See docs/reference/12-state-machine.md for the state transitions that emit each event.

const VALID_EVENT_TYPES = new Set([
  // Stage lifecycle
  "STAGE_STARTED",
  "STAGE_AWAITING_APPROVAL",
  "STAGE_REVISING",
  "STAGE_COMPLETED",
  "STAGE_JUMPED",
  "STAGE_SKIPPED",
  // Phase lifecycle
  "PHASE_STARTED",
  "PHASE_COMPLETED",
  "PHASE_VERIFIED",
  "PHASE_SKIPPED",
  // Workflow lifecycle
  "WORKFLOW_STARTED",
  "WORKFLOW_COMPLETED",
  "WORKFLOW_PARKED",
  "WORKFLOW_UNPARKED",
  // Session events (hook-owned)
  "SESSION_STARTED",
  "SESSION_RESUMED",
  "SESSION_COMPACTED",
  "SESSION_ENDED",
  // Human presence (hook-owned): one event per real human prompt turn. The
  // approval/interview gate requires a HUMAN_TURN appended AFTER the last gate
  // resolution (in ledger order) before it commits.
  "HUMAN_TURN",
  // Initialization events (fire IN ADDITION TO STAGE_COMPLETED)
  "WORKSPACE_SCAFFOLDED",
  "WORKSPACE_SCANNED",
  "WORKSPACE_INITIALISED",
  // User interaction
  "DECISION_RECORDED",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "QUESTION_ANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "PLAN_APPROVAL_RECORDED",
  // Reviewer step (§12a) — REVIEW_REQUESTED on dispatch, REVIEW_COMPLETED when
  // a verdict is read. Emitted by the tool actor `aidlc-log.ts review`. A
  // reviewer-bearing stage cannot complete without a terminal REVIEW_COMPLETED
  // in its audit tail (enforced by aidlc-state.ts in approve, advance, finalize,
  // and complete-workflow).
  "REVIEW_REQUESTED",
  "REVIEW_COMPLETED",
  // Ordered pipeline-link receipt. Emitted only by aidlc-log.ts link after a
  // declared link returns; completion guards require the full current-attempt
  // chain before a pipeline stage may enter or resolve approval.
  "PIPELINE_LINK_COMPLETED",
  // Unit-of-work lifecycle on INLINE per-unit Construction stages (for_each:
  // unit-of-work, mode: inline) — emitted by `aidlc-state.ts unit
  // start|pause|resume|complete`. UNIT_COMPLETED is the completion receipt the
  // engine's coverage walk prefers over bare artifact existence (artifacts are
  // evidence checked AT the receipt, never the transition itself); UNIT_PAUSED
  // carries Reason + Next Action so a resumed session lands on the exact
  // checkpoint. The autonomous swarm path keeps its own SWARM_UNIT_* ledger.
  "UNIT_STARTED",
  "UNIT_PAUSED",
  "UNIT_RESUMED",
  "UNIT_COMPLETED",
  // Artifact events (hook-emitted)
  "ARTIFACT_CREATED",
  "ARTIFACT_UPDATED",
  "ARTIFACT_REUSED",
  // Subagent (hook-emitted)
  "SUBAGENT_COMPLETED",
  // Reviewer read-scope enforcement (hook-emitted): a per-unit reviewer's
  // tool call was refused for reaching into sibling units' construction/ paths.
  "REVIEWER_SCOPE_BLOCKED",
  // Terminal-receipt write-freeze enforcement (hook-emitted): a declared
  // produces-artifact write was refused because it would invalidate a fresh
  // READY review receipt before the gate (stage-protocol-reviewer §12a terminal
  // ordering). No bracket characters in this comment: t47 slices the array
  // literal at the first closing bracket after the const name.
  "REVIEW_FREEZE_BLOCKED",
  // Plan-approval ordering enforcement (hook-emitted): a code-generation
  // developer-agent dispatch was refused because no unit had an approved
  // code-generation plan on disk (stage Steps 2-3 must precede Step 4).
  "PLAN_APPROVAL_BLOCKED",
  // DocumentKB (emitters wired by aidlc-knowledge.ts onboard/sync/associate).
  // The customer-document store is a SPACE-level object, so all three land in
  // the space-level audit shard even when the document is intent-scoped -- a
  // scope change must never split one document's history across two shards.
  "DOCUMENT_INDEXED",
  "DOCUMENT_UPDATED",
  "DOCUMENT_REMOVED",
  // Health/system
  "HEALTH_CHECKED",
  "SCOPE_DETECTED",
  "SCOPE_CHANGED",
  // User-driven plugin selection changes enabled graph/scope surfaces.
  "PLUGIN_SELECTION_CHANGED",
  "DEPTH_CHANGED",
  "TEST_STRATEGY_CHANGED",
  // Per-run review-class override changed (config-change --review). The
  // effective class each stage runs at is resolved at directive emission.
  "REVIEW_CLASS_CHANGED",
  // Adaptive composer: an in-flight plan re-shape (pending-stage suffix flips
  // via the recompose verb). Emitted by aidlc-utility.ts handleRecompose.
  "RECOMPOSED",
  // Jump events owned by STAGE_JUMPED — JUMP_COMPLETED was deleted as a
  // redundant alias.
  // Error/Recovery
  "ERROR_LOGGED",
  "RECOVERY_COMPLETED",
  // Construction Bolt execution
  "BOLT_STARTED",
  "BOLT_COMPLETED",
  "BOLT_FAILED",
  "AUTONOMY_MODE_SET",
  "UNIT_OWNERSHIP_SET",
  "UNIT_GATE_RHYTHM_SET",
  "UNIT_MERGED",
  // Worktree lifecycle:
  //   WORKTREE_* emitted by aidlc-worktree.ts
  //   STATE_*    emitted by aidlc-state.ts state-fork/state-merge
  //   AUDIT_*    emitted by audit-fork/audit-merge handlers below
  "WORKTREE_CREATED",
  "WORKTREE_MERGED",
  "WORKTREE_DISCARDED",
  "STATE_FORKED",
  "STATE_MERGED",
  "AUDIT_FORKED",
  "AUDIT_MERGED",
  // Practices (stage events + runtime events)
  "PRACTICES_DISCOVERED",
  "PRACTICES_AFFIRMED",
  "PRACTICES_OVERRIDE",
  "PRACTICES_SECTION_EMPTY",
  // Merge Dispatch (emitter wired via aidlc-bolt.ts dispatch-event)
  "MERGE_DISPATCH_INVOKED",
  "MERGE_DISPATCH_RETURNED",
  "MERGE_DISPATCH_FALLBACK",
  // Sensors (emitters wired by sensor dispatcher for SENSOR_*; doctor for
  // GUARDRAIL_LOADED)
  "SENSOR_FIRED",
  "SENSOR_PASSED",
  "SENSOR_FAILED",
  "SENSOR_BUDGET_OVERRIDE",
  "GUARDRAIL_LOADED",
  // Learning Loop (MEMORY_EMPTY emitter wired by aidlc-runtime.ts compile;
  // RULE_LEARNED + SENSOR_PROPOSED emitters wired by aidlc-learnings.ts persist)
  "MEMORY_EMPTY",
  "RULE_LEARNED",
  "SENSOR_PROPOSED",
  // Swarm lifecycle — all emit from the swarm referee aidlc-swarm.ts (the
  // per-Unit pair + batch tally from `finalize`; SWARM_STARTED + SWARM_DEGRADED
  // from `prepare`). See CHANGELOG + audit-format.md.
  "SWARM_STARTED",
  "SWARM_UNIT_CONVERGED",
  "SWARM_SOURCE_MERGED",
  "SWARM_UNIT_FAILED",
  "SWARM_BATON_RETURNED",
  "SWARM_COMPLETED",
  "SWARM_DEGRADED",
]);
// --- Event type to human-readable heading ---

const EVENT_HEADINGS: Record<string, string> = {
  STAGE_STARTED: "Stage Start",
  STAGE_AWAITING_APPROVAL: "Stage Awaiting Approval",
  STAGE_REVISING: "Stage Revising",
  STAGE_COMPLETED: "Stage Completion",
  STAGE_JUMPED: "Stage Jump",
  STAGE_SKIPPED: "Stage Skip",
  PHASE_STARTED: "Phase Start",
  PHASE_COMPLETED: "Phase Completion",
  PHASE_VERIFIED: "Phase Verification",
  PHASE_SKIPPED: "Phase Skip",
  WORKFLOW_STARTED: "Workflow Start",
  WORKFLOW_COMPLETED: "Workflow Completion",
  WORKFLOW_PARKED: "Workflow Parked",
  WORKFLOW_UNPARKED: "Workflow Unparked",
  SESSION_STARTED: "Session Start",
  SESSION_RESUMED: "Session Resume",
  SESSION_COMPACTED: "Session Compacted",
  SESSION_ENDED: "Session End",
  HUMAN_TURN: "Human Turn",
  WORKSPACE_SCAFFOLDED: "Workspace Scaffolded",
  WORKSPACE_SCANNED: "Workspace Scanned",
  WORKSPACE_INITIALISED: "Workspace Initialised",
  DECISION_RECORDED: "Decision Recorded",
  GATE_APPROVED: "Gate Approved",
  GATE_REJECTED: "Gate Rejected",
  QUESTION_ANSWERED: "Question Answered",
  SUMMARY_CONFIRMATION_RECORDED: "Summary Confirmation Recorded",
  PLAN_APPROVAL_RECORDED: "Plan Approval Recorded",
  REVIEW_REQUESTED: "Review Requested",
  REVIEW_COMPLETED: "Review Completed",
  PIPELINE_LINK_COMPLETED: "Pipeline Link Completed",
  UNIT_STARTED: "Unit Started",
  UNIT_PAUSED: "Unit Paused",
  UNIT_RESUMED: "Unit Resumed",
  UNIT_COMPLETED: "Unit Completed",
  ARTIFACT_CREATED: "Artifact Created",
  ARTIFACT_UPDATED: "Artifact Updated",
  ARTIFACT_REUSED: "Artifact Reused",
  SUBAGENT_COMPLETED: "Subagent Completed",
  REVIEWER_SCOPE_BLOCKED: "Reviewer Scope Blocked",
  REVIEW_FREEZE_BLOCKED: "Review Freeze Blocked",
  PLAN_APPROVAL_BLOCKED: "Plan Approval Blocked",
  DOCUMENT_INDEXED: "Document Indexed",
  DOCUMENT_UPDATED: "Document Updated",
  DOCUMENT_REMOVED: "Document Removed",
  HEALTH_CHECKED: "Health Check",
  SCOPE_DETECTED: "Scope Detection",
  SCOPE_CHANGED: "Scope Change",
  PLUGIN_SELECTION_CHANGED: "Plugin Selection Change",
  DEPTH_CHANGED: "Depth Change",
  TEST_STRATEGY_CHANGED: "Test Strategy Change",
  REVIEW_CLASS_CHANGED: "Review Class Change",
  RECOMPOSED: "Plan Recomposed",
  ERROR_LOGGED: "Error Logged",
  RECOVERY_COMPLETED: "Recovery Completed",
  BOLT_STARTED: "Bolt Started",
  BOLT_COMPLETED: "Bolt Completed",
  BOLT_FAILED: "Bolt Failed",
  AUTONOMY_MODE_SET: "Autonomy Mode Set",
  UNIT_OWNERSHIP_SET: "Unit Ownership Set",
  UNIT_GATE_RHYTHM_SET: "Unit Gate Rhythm Set",
  UNIT_MERGED: "Unit Merged",
  WORKTREE_CREATED: "Worktree Created",
  WORKTREE_MERGED: "Worktree Merged",
  WORKTREE_DISCARDED: "Worktree Discarded",
  STATE_FORKED: "State Forked",
  STATE_MERGED: "State Merged",
  AUDIT_FORKED: "Audit Forked",
  AUDIT_MERGED: "Audit Merged",
  PRACTICES_DISCOVERED: "Practices Discovered",
  PRACTICES_AFFIRMED: "Practices Affirmed",
  PRACTICES_OVERRIDE: "Practices Override",
  PRACTICES_SECTION_EMPTY: "Practices Section Empty",
  MERGE_DISPATCH_INVOKED: "Merge Dispatch Invoked",
  MERGE_DISPATCH_RETURNED: "Merge Dispatch Returned",
  MERGE_DISPATCH_FALLBACK: "Merge Dispatch Fallback",
  SENSOR_FIRED: "Sensor Fired",
  SENSOR_PASSED: "Sensor Passed",
  SENSOR_FAILED: "Sensor Failed",
  SENSOR_BUDGET_OVERRIDE: "Sensor Budget Override",
  GUARDRAIL_LOADED: "Guardrail Loaded",
  MEMORY_EMPTY: "Memory Empty",
  RULE_LEARNED: "Rule Learned",
  SENSOR_PROPOSED: "Sensor Proposed",
  SWARM_STARTED: "Swarm Started",
  SWARM_UNIT_CONVERGED: "Swarm Unit Converged",
  SWARM_SOURCE_MERGED: "Swarm Source Merged",
  SWARM_UNIT_FAILED: "Swarm Unit Failed",
  SWARM_BATON_RETURNED: "Swarm Baton Returned",
  SWARM_COMPLETED: "Swarm Completed",
  SWARM_DEGRADED: "Swarm Degraded",
};

// --- Helpers ---

function jsonSuccess(data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function jsonError(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

const CLI_RESERVED_EVENT_TYPES = new Set([
  "HUMAN_TURN",
  "SUMMARY_CONFIRMATION_RECORDED",
  "PLAN_APPROVAL_RECORDED",
  "ARTIFACT_CREATED",
  "ARTIFACT_UPDATED",
  "ARTIFACT_REUSED",
  "REVIEW_REQUESTED",
  "REVIEW_COMPLETED",
  "PIPELINE_LINK_COMPLETED",
]);

function refuseReservedCliEvent(eventType: string): void {
  if (CLI_RESERVED_EVENT_TYPES.has(eventType)) {
    jsonError(
      `${eventType} is reserved for its owning hook/tool and cannot be appended through the public audit CLI.`,
    );
  }
}

function refuseReservedCliBatch(entriesJson: string): void {
  try {
    const entries = JSON.parse(entriesJson) as unknown;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "eventType" in entry &&
        typeof entry.eventType === "string"
      ) {
        refuseReservedCliEvent(entry.eventType);
      }
    }
  } catch {
    // The normal append-batch parser owns malformed-JSON diagnostics.
  }
}

// --- Subcommand: append ---

export interface AuditEntryInput {
  eventType: string;
  fields: Record<string, string>;
}

// Authority-bearing events: rows the engine's guards read as authorization
// evidence — completed-stage receipts (validity routing), human presence
// (humanActedSinceGate), gate resolutions, interview
// answers (one-answer-per-human-turn), reviewer receipts
// (verifyReviewerPrecondition), swarm attempt/convergence (the finalize and
// artifact-guard boundaries), and the autonomy grant. Each has exactly one owning emitter that
// reaches appendAuditEntry through the library import (hooks, aidlc-state,
// aidlc-log, aidlc-swarm, aidlc-bolt). The public CLI refuses them so a
// conductor cannot mint authority it does not have; everything else stays
// CLI-appendable as the diagnostic escape hatch. Test fixtures that simulate
// the owning emitters set AIDLC_ALLOW_DIRECT_AUDIT_EVENTS=1 (the same escape
// idiom as AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS in aidlc-state.ts).
export const CLI_PROTECTED_EVENT_TYPES = new Set([
  "STAGE_COMPLETED",
  "HUMAN_TURN",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "QUESTION_ANSWERED",
  "PLAN_APPROVAL_RECORDED",
  "REVIEW_REQUESTED",
  "REVIEW_COMPLETED",
  "PIPELINE_LINK_COMPLETED",
  "ARTIFACT_REUSED",
  "SWARM_STARTED",
  "SWARM_UNIT_CONVERGED",
  "SWARM_SOURCE_MERGED",
  "AUTONOMY_MODE_SET",
  "UNIT_OWNERSHIP_SET",
  "UNIT_GATE_RHYTHM_SET",
  // Unit lifecycle receipts: routing trusts UNIT_COMPLETED as the completion
  // signal (unitSettled) and UNIT_PAUSED as the hard-stop checkpoint, and the
  // owning verb verifies artifacts before committing — a CLI-forged receipt
  // would skip that verification. Owned by `aidlc-state.ts unit`.
  "UNIT_STARTED",
  "UNIT_PAUSED",
  "UNIT_RESUMED",
  "UNIT_COMPLETED",
  "UNIT_MERGED",
  // DocumentKB provenance: the knowledge tool emits these through the library
  // inside its catalog transaction. A CLI-forged DOCUMENT_INDEXED whose
  // Digest+Source match a real row would make the tool's idempotent
  // audit-repair pass treat provenance as already recorded and SUPPRESS the
  // genuine row, so the CLI must not mint them.
  "DOCUMENT_INDEXED",
  "DOCUMENT_UPDATED",
  "DOCUMENT_REMOVED",
]);
// Events a WORKTREE DELTA may never carry into the main intent shard. This is
// deliberately an explicit enumeration, not prefix families: a Bolt/swarm
// worktree legitimately emits STAGE_*, SENSOR_*, REVIEW_REQUESTED/COMPLETED
// (the per-unit reviewer receipts the SKILL instructs recording with
// --project-dir <worktree>) and ARTIFACT_* rows as its work product, and the
// referee's defence against a lying conductor is artifact re-verification at
// finalize, not delta filtering. A prefix blacklist over those families
// refused exactly the delta the swarm contract requires and made
// `bolt complete --merge` deterministically unrecoverable (the delta bytes
// never change), which broke t49/t134. What IS blocked:
//   - human authority: the presence/gate events humanActedSinceGate and the
//     gate flow trust; a merged forgery would satisfy a gate no human saw.
//   - unit lifecycle receipts: routing trusts UNIT_COMPLETED (unitSettled)
//     and the owning verb verifies artifacts before committing.
//   - referee bookkeeping: fork/merge/swarm/bolt/worktree lifecycle rows are
//     emitted main-side by the referee; a delta copy would double-count.
//   - DOCUMENT_* (prefix, future-proof): DocumentKB rows live in the
//     space-level shard by design; one in an intent delta is a forgery.
const MERGE_PROTECTED_EVENT_TYPES = new Set([
  // Human authority (GATE_RESOLUTION_EVENTS + presence + autonomy).
  "HUMAN_TURN",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "QUESTION_ANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "PLAN_APPROVAL_RECORDED",
  "AUTONOMY_MODE_SET",
  "UNIT_OWNERSHIP_SET",
  "UNIT_GATE_RHYTHM_SET",
  // Routing-trusted unit lifecycle receipts.
  "UNIT_STARTED",
  "UNIT_PAUSED",
  "UNIT_RESUMED",
  "UNIT_COMPLETED",
  // Referee/conductor bookkeeping, emitted against main only.
  "AUDIT_FORKED",
  "AUDIT_MERGED",
  "STATE_FORKED",
  "STATE_MERGED",
  "SWARM_STARTED",
  "SWARM_COMPLETED",
  "SWARM_DEGRADED",
  "SWARM_BATON_RETURNED",
  "SWARM_UNIT_CONVERGED",
  "SWARM_SOURCE_MERGED",
  "SWARM_UNIT_FAILED",
  "BOLT_STARTED",
  "BOLT_COMPLETED",
  "BOLT_FAILED",
  "WORKTREE_CREATED",
  "WORKTREE_DISCARDED",
  "WORKTREE_MERGED",
]);
function mergeEventIsProtected(eventType: string): boolean {
  if (MERGE_PROTECTED_EVENT_TYPES.has(eventType)) return true;
  return eventType.startsWith("DOCUMENT_");
}

function directAuditEventsAllowed(): boolean {
  return process.env.AIDLC_ALLOW_DIRECT_AUDIT_EVENTS === "1";
}

function refuseProtectedEvent(eventType: string): never {
  jsonError(
    `Direct emission of ${eventType} is blocked: it is an authority-bearing receipt owned by its ` +
      "emitting tool or hook (gate resolutions and approvals come from aidlc-orchestrate.ts report, " +
      "interview answers and reviews from aidlc-log.ts, human presence from the prompt-submit hook). " +
      "The audit CLI appends diagnostic events only."
  );
}

// Field keys that can spoof event queries. A caller-supplied `Event` field
// lands as a SECOND `**Event**:` line, and the multiline regex in
// findAllEvents matches ANY line of a block — so a smuggled `--field
// Event=HUMAN_TURN` on a harmless event type would register as a forged event
// in every query. `Timestamp` is deliberately NOT reserved: the public `append`
// CLI accepts it, and it cannot spoof — the emitter's own `**Timestamp**:` line
// is written first and every parser takes the first match. renderAuditBlock
// drops it instead, so it can never render a second line.
const RESERVED_FIELD_KEYS = new Set(["Event"]);

// Keys renderAuditBlock writes itself, and therefore never re-renders from
// `fields`. `Event` is already refused by RESERVED_FIELD_KEYS before render
// (belt-and-braces); `Timestamp` is accepted there on purpose, so this set is
// the only thing keeping a caller-supplied value from emitting a SECOND
// `**Timestamp**:` line — which would break any whole-file reader that zips
// `**Timestamp**` occurrences against `**Event**` occurrences.
const EMITTER_OWNED_FIELD_KEYS = new Set(["Timestamp", "Event"]);
const AUDIT_FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9 ._()/-]*$/;

function validateAuditEntry(entry: AuditEntryInput): void {
  if (!VALID_EVENT_TYPES.has(entry.eventType)) {
    throw new Error(
      `Invalid event type: ${entry.eventType}. Must be one of: ${[...VALID_EVENT_TYPES].join(", ")}`
    );
  }
  for (const key of Object.keys(entry.fields)) {
    if (RESERVED_FIELD_KEYS.has(key)) {
      throw new Error(
        `Reserved field key: ${key}. The emitter writes **${key}**: itself; a caller-supplied ` +
          "value would forge a second matching line and spoof multiline event queries."
      );
    }
    if (!AUDIT_FIELD_KEY_PATTERN.test(key)) {
      throw new Error(
        `Invalid audit field key: ${JSON.stringify(key)}. Field keys must match ` +
          `${AUDIT_FIELD_KEY_PATTERN} so they remain one Markdown label on one physical line.`
      );
    }
  }
}

function renderAuditBlock(
  entry: AuditEntryInput,
  timestamp: string,
  projectDir: string,
): string {
  const heading = EVENT_HEADINGS[entry.eventType] || entry.eventType;
  let block = `\n## ${heading}\n`;
  block += `**Timestamp**: ${timestamp}\n`;
  block += `**Event**: ${entry.eventType}\n`;
  for (const [key, value] of Object.entries(entry.fields)) {
    // The emitter already wrote these above; re-rendering one would put a
    // second identically-marked line in the block (issue #715).
    if (EMITTER_OWNED_FIELD_KEYS.has(key)) continue;
    // Escape every JavaScript line terminator in values so a malicious or
    // malformed input cannot forge a second audit field or event line.
    const safeValue = redactProjectDirPrefix(
      String(value),
      projectDir,
    ).replace(/\r\n?|\n|\u2028|\u2029/g, "\\n");
    block += `**${key}**: ${safeValue}\n`;
  }
  return `${block}\n---\n`;
}

// One best-effort metrics tap shared by every structured audit append path.
// Lazy loading keeps metrics fully opt-in and lets audit-only fixtures omit the
// module. Each call catches independently so one lost metric cannot block an
// audit write or suppress later events in a batch.
function tapAuditMetric(
  eventType: string,
  fields: Record<string, string>,
  projectDir: string,
): void {
  if (!process.env.AIDLC_METRICS_ENDPOINT) return;
  try {
    const metrics = require("./aidlc-metrics.ts") as {
      emitMetricForAuditEvent: (
        eventType: string,
        fields: Record<string, string>,
        projectDir: string,
      ) => void;
    };
    metrics.emitMetricForAuditEvent(eventType, fields, projectDir);
  } catch {
    // Metrics module missing or emit failed - never propagate.
  }
}

// Core append logic — throws on error instead of exiting. Safe for library callers.
// CLI caller (main) wraps this in try/catch and translates to jsonError.
export function appendAuditEntry(
  eventType: string,
  fields: Record<string, string>,
  projectDir: string,
  intent?: string,
  space?: string
): { appended: true; event: string; timestamp: string } {
  validateAuditEntry({ eventType, fields });

  // Lock + audit shard both pin to the same (intent, space) record so a fork/
  // merge pair targets ONE intent end-to-end; omitted -> default-resolution.
  if (!acquireAuditLock(projectDir, 50, 100, intent, space)) {
    throw new Error("Failed to acquire audit lock after retries");
  }

  try {
    return appendAuditEntryUnlocked(eventType, fields, projectDir, intent, space);
  } finally {
    releaseAuditLock(projectDir, intent, space);
  }
}

// Lock-already-held variant for callers that need to hold the audit lock
// across multiple operations (e.g., aidlc-state.ts fork/merge, which read
// state, decide on a write, emit audit, and write state — all inside one
// critical section). The caller MUST have acquired the audit lock via
// acquireAuditLock(projectDir) and MUST release it (via releaseAuditLock or
// equivalent) regardless of how this function returns. Validates the event
// type the same way as the locked variant; everything else is identical.
export function appendAuditEntryUnlocked(
  eventType: string,
  fields: Record<string, string>,
  projectDir: string,
  intent?: string,
  space?: string
): { appended: true; event: string; timestamp: string } {
  const entry = { eventType, fields };
  validateAuditEntry(entry);
  const ts = isoTimestamp();
  appendAuditBlockAtPath(
    projectDir,
    auditFilePath(projectDir, intent, space),
    renderAuditBlock(entry, ts, projectDir),
  );

  tapAuditMetric(eventType, fields, projectDir);

  return { appended: true, event: eventType, timestamp: ts };
}

// Append to an EXPLICIT shard path, bypassing (intent, space) resolution.
//
// Every other append derives its shard from `auditFilePath`, and that resolution
// has a sharp edge: `intent === undefined` does NOT mean "no intent" -- it means
// "resolve one from the cursor" (auditFilePath -> recordDir -> activeIntent,
// which falls back to the active-intent pointer, then to a lone intent). The
// space-level shard is only reached when a space has NO intents at all, so a
// caller cannot ASK for it.
//
// DocumentKB needs to: a document outlives any intent, and its scope can change
// later, so filing its provenance under whichever intent happened to be active
// would split one document's history across shards. It composes the space shard
// itself and passes it here.
//
// Deliberately does NOT lock -- the caller holds the lock across a wider
// transaction, and the locking variant would deadlock on itself. Validation,
// rendering, and the metric tap are identical to every other append, so a row
// written this way is indistinguishable from one written the usual way.
function writeAll(fd: number, content: string): void {
  const bytes = Buffer.from(content, "utf-8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("Audit append made no write progress");
    offset += written;
  }
}

interface AuditFileIdentity { dev: number; ino: number }
interface AuditAppendExpectation extends AuditFileIdentity {
  prefixLength: number;
  prefixHash: string;
}

function appendAuditBlockAtPath(
  projectDir: string,
  shardPath: string,
  block: string,
  expectedIdentity?: AuditAppendExpectation,
): void {
  const dir = dirname(shardPath);
  const projectAbs = resolve(projectDir);
  const projectReal = realpathSync(projectAbs);
  const rel = relative(projectAbs, resolve(shardPath));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing audit shard outside project: ${shardPath}`);
  }
  assertNoSymlinkInChainOrThrow(projectReal, rel);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  assertNoSymlinkInChainOrThrow(projectReal, rel);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(
      shardPath,
      fsConstants.O_RDWR |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        noFollow |
        fsConstants.O_NONBLOCK,
      0o666,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`Refusing non-regular audit shard: ${shardPath}`);
    // No nlink refusal on the ORDINARY append path: rsync --link-dest and
    // cp -al backup snapshots leave a live shard at nlink 2, and refusing it
    // here bricked every later gate/hook append framework-wide. A hardlink
    // aliases the same inode inside an already containment- and
    // symlink-chain-checked path, so it grants no redirect. The explicit
    // fork/merge path stays strict: readAuditSnapshot refuses a
    // multiply-linked main shard, and verifyExpectedPrefix below re-checks
    // during a merge append.
    if (expectedIdentity &&
        (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino)) {
      throw new Error(`Audit shard changed after validation: ${shardPath}`);
    }
    const verifyExpectedPrefix = (): void => {
      if (!expectedIdentity) return;
      const current = fstatSync(fd as number);
      if (current.nlink !== 1) throw new Error(`Audit shard became multiply linked: ${shardPath}`);
      const prefix = Buffer.alloc(expectedIdentity.prefixLength);
      let offset = 0;
      while (offset < prefix.length) {
        const count = readSync(fd as number, prefix, offset, prefix.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const hash = createHash("sha256").update(prefix.subarray(0, offset)).digest("hex");
      if (offset !== expectedIdentity.prefixLength || hash !== expectedIdentity.prefixHash) {
        throw new Error(`Audit shard prefix changed after validation: ${shardPath}`);
      }
    };

    // O_NOFOLLOW is not available on every platform and protects only the leaf.
    // Re-resolve after opening, require containment, and prove the pathname still
    // names the descriptor's inode before writing through the pinned descriptor.
    const verifyPathStillNamesDescriptor = (): void => {
      assertNoSymlinkInChainOrThrow(projectReal, rel);
      if (lstatSync(shardPath).isSymbolicLink()) {
        throw new Error(`Refusing symlinked audit shard: ${shardPath}`);
      }
      const currentReal = realpathSync(shardPath);
      if (currentReal !== projectReal && !currentReal.startsWith(`${projectReal}${sep}`)) {
        throw new Error(`Refusing audit shard outside project: ${shardPath}`);
      }
      const current = statSync(currentReal);
      if (current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error(`Audit shard changed while opening: ${shardPath}`);
      }
    };
    verifyPathStillNamesDescriptor();
    verifyExpectedPrefix();
    if (opened.size === 0) writeAll(fd, "# AI-DLC Audit Log\n");
    writeAll(fd, block);
    // If an attacker renamed the leaf/parent during the descriptor write, fail
    // the enclosing audit-first transaction instead of reporting a ledger row
    // that is no longer discoverable at the canonical path.
    verifyPathStillNamesDescriptor();
    verifyExpectedPrefix();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readAuditSnapshot(projectDir: string, shardPath: string): {
  bytes: Buffer;
  identity: AuditFileIdentity;
} {
  const projectReal = realpathSync(projectDir);
  const rel = relative(resolve(projectDir), resolve(shardPath));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing audit shard outside project: ${shardPath}`);
  }
  assertNoSymlinkInChainOrThrow(projectReal, rel);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(shardPath, fsConstants.O_RDONLY | noFollow | fsConstants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error(`Refusing non-regular or multiply-linked audit shard: ${shardPath}`);
    }
    const verify = (): void => {
      assertNoSymlinkInChainOrThrow(projectReal, rel);
      if (lstatSync(shardPath).isSymbolicLink()) {
        throw new Error(`Refusing symlinked audit shard: ${shardPath}`);
      }
      const real = realpathSync(shardPath);
      if (real !== projectReal && !real.startsWith(`${projectReal}${sep}`)) {
        throw new Error(`Refusing audit shard outside project: ${shardPath}`);
      }
      const current = statSync(real);
      if (current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error(`Audit shard changed while reading: ${shardPath}`);
      }
    };
    verify();
    const bytes = readFileSync(fd);
    verify();
    const after = fstatSync(fd);
    if (after.nlink !== 1 || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        bytes.length !== opened.size) {
      throw new Error(`Audit shard changed while reading: ${shardPath}`);
    }
    return { bytes, identity: { dev: opened.dev, ino: opened.ino } };
  } finally {
    closeSync(fd);
  }
}

export function appendAuditEntryAtPathUnlocked(
  eventType: string,
  fields: Record<string, string>,
  projectDir: string,
  shardPath: string,
): { appended: true; event: string; timestamp: string } {
  const entry = { eventType, fields };
  validateAuditEntry(entry);
  const ts = isoTimestamp();
  appendAuditBlockAtPath(
    projectDir,
    shardPath,
    renderAuditBlock(entry, ts, projectDir),
  );
  tapAuditMetric(eventType, fields, projectDir);
  return { appended: true, event: eventType, timestamp: ts };
}

// Validate a related event set before touching disk, then append every block
// under one lock with one write. This is the audit-only transaction primitive
// for lifecycle pairs such as a synthetic single-stage STARTED/COMPLETED pair:
// a malformed later entry cannot leave an earlier entry committed, and no
// concurrent emitter can interleave between the blocks.
export function appendAuditEntries(
  entries: AuditEntryInput[],
  projectDir: string,
  intent?: string,
  space?: string,
): { appended: true; events: string[]; timestamps: string[] } {
  if (entries.length === 0) {
    throw new Error("appendAuditEntries requires at least one entry");
  }
  for (const entry of entries) validateAuditEntry(entry);

  if (!acquireAuditLock(projectDir, 50, 100, intent, space)) {
    throw new Error("Failed to acquire audit lock after retries");
  }
  try {
    const timestamps = entries.map(() => isoTimestamp());
    const payload = entries
      .map((entry, index) =>
        renderAuditBlock(entry, timestamps[index], projectDir)
      )
      .join("");
    appendAuditBlockAtPath(projectDir, auditFilePath(projectDir, intent, space), payload);
    for (const entry of entries) {
      tapAuditMetric(entry.eventType, entry.fields, projectDir);
    }
    return {
      appended: true,
      events: entries.map((entry) => entry.eventType),
      timestamps,
    };
  } finally {
    releaseAuditLock(projectDir, intent, space);
  }
}

// Legacy CLI-style wrapper. Kept for backward compatibility with aidlc-state/aidlc-jump/
// aidlc-log/aidlc-bolt — they import this and catch exceptions. The
// main() caller below uses this same function but its catch block translates errors
// via jsonError (which exits).
export function handleAppend(
  eventType: string,
  fields: Record<string, string>,
  projectDir: string
): void {
  if (CLI_PROTECTED_EVENT_TYPES.has(eventType) && !directAuditEventsAllowed()) {
    refuseProtectedEvent(eventType);
  }
  const result = appendAuditEntry(eventType, fields, projectDir);
  jsonSuccess(result);
}

function handleAppendBatch(rawEntries: string, projectDir: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEntries);
  } catch {
    throw new Error("append-batch entries must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("append-batch entries must be a non-empty JSON array");
  }
  const entries: AuditEntryInput[] = parsed.map((raw, index) => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as { eventType?: unknown }).eventType !== "string" ||
      typeof (raw as { fields?: unknown }).fields !== "object" ||
      (raw as { fields?: unknown }).fields === null ||
      Array.isArray((raw as { fields?: unknown }).fields)
    ) {
      throw new Error(
        `append-batch entry ${index} must contain string eventType and object fields`
      );
    }
    const fields = (raw as { fields: Record<string, unknown> }).fields;
    if (Object.values(fields).some((value) => typeof value !== "string")) {
      throw new Error(`append-batch entry ${index} field values must be strings`);
    }
    return {
      eventType: (raw as { eventType: string }).eventType,
      fields: fields as Record<string, string>,
    };
  });
  // Same ownership floor as `append`: a batch must not smuggle an
  // authority-bearing receipt among diagnostic rows. The engine's own batch
  // callers must not smuggle a protected receipt among diagnostic rows. The
  // synthetic single-stage owner uses appendAuditEntries directly instead of
  // crossing this public CLI boundary.
  for (const entry of entries) {
    if (CLI_PROTECTED_EVENT_TYPES.has(entry.eventType) && !directAuditEventsAllowed()) {
      refuseProtectedEvent(entry.eventType);
    }
  }
  jsonSuccess(appendAuditEntries(entries, projectDir));
}

// --- Subcommand: append-raw ---

function handleAppendRaw(
  heading: string,
  body: string,
  projectDir: string
): void {
  if (hasUnsafeSingleLineCharacter(heading)) {
    jsonError("append-raw heading must be printable text on one physical line");
  }
  // A raw body is written verbatim, and every event query (findAllEvents,
  // auditBlockField) matches `**Event**:` lines anywhere in a block — so a raw
  // body carrying an `**Event**: <taxonomy event>` line IS that event to every
  // reader, timestamp and all. Refuse taxonomy names outright (canonical events
  // go through `append`, which validates ownership); non-taxonomy Event lines
  // (custom diagnostics) stay allowed — no query resolves them to authority.
  const expandedBody = redactProjectDirPrefix(
    body.replace(/\\n/g, "\n"),
    projectDir,
  );
  const safeHeading = redactProjectDirPrefix(heading, projectDir);
  for (const raw of expandedBody.split(/\r\n?|\n|\u2028|\u2029/)) {
    const line = raw.startsWith("- ") ? raw.slice(2) : raw;
    if (!line.startsWith("**Event**:")) continue;
    const value = line.slice("**Event**:".length).trim();
    if (VALID_EVENT_TYPES.has(value)) {
      jsonError(
        `append-raw refuses a body carrying **Event**: ${value} — that line would register as a ` +
          "canonical audit event to every reader. Emit taxonomy events through their owning tool " +
          "(or `append` for diagnostic types); append-raw is for free-form notes only."
      );
    }
  }

  const ts = isoTimestamp();

  if (!acquireAuditLock(projectDir)) {
    jsonError("Failed to acquire audit lock after retries");
  }

  try {
    // Interpret literal \n sequences in the body as actual newlines
    let block = `\n## ${safeHeading}\n`;
    block += `**Timestamp**: ${ts}\n`;
    block += `${expandedBody}\n`;
    block += `\n---\n`;

    appendAuditBlockAtPath(projectDir, auditFilePath(projectDir), block);
  } finally {
    releaseAuditLock(projectDir);
  }

  jsonSuccess({ appended: true, heading, timestamp: ts });
}

// --- Subcommand: audit-fork ---
//
// audit-fork --slug <slug> [--project-dir <path>]
//
// Forks the main audit log into a Bolt's worktree on Bolt start. Byte-copies
// main audit so the worktree is self-contained at fork instant. Records the
// pre-emit byte-offset (Fork Boundary) and SHA-256 (Source Audit Hash) on
// AUDIT_FORKED so audit-merge can recover both at gate-approval time.
//
// Audit-of-intent semantics: a fresh or dead-partial redo emits AUDIT_FORKED to
// main BEFORE the mkdir + copy. A complete current fork returns as a no-op. If
// the disk operation fails after emit, additionally emit ERROR_LOGGED with
// [slug=<slug>] [fork-emitted:<ts>] so doctor can reconcile drift at
// observation time. Mirrors aidlc-worktree.ts pattern.
//
// Why this exists as a tool subcommand: same load-bearing rationale as
// aidlc-state.ts practices-promote — stage prose that names a write target
// gets the LLM (under `claude -p`) to hallucinate a permission policy and
// halt the workflow. Routing through a subcommand removes the LLM from the
// path entirely.

// The intent/space SELECTOR for a Bolt audit fork/merge pair: --intent <record>
// / --space <name> pin BOTH ends to one intent's audit shard + worktree mirror
// (vision §5). Omitted -> default-resolution (the active cursor), which is what
// the orchestrator threads today. Returns undefined when a flag is absent so the
// helpers default-resolve.
function parseSelectorFlags(args: string[]): { intent?: string; space?: string } {
  let intent: string | undefined;
  let space: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--intent" && i + 1 < args.length) {
      intent = args[i + 1];
      i++;
    } else if (args[i] === "--space" && i + 1 < args.length) {
      space = args[i + 1];
      i++;
    }
  }
  return { intent, space };
}

function parseSlugFlag(args: string[], subcommand: string): string {
  let slug: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--slug" && i + 1 < args.length) {
      slug = args[i + 1];
      i++;
    }
  }
  if (!slug) {
    jsonError(`Usage: aidlc-audit ${subcommand} --slug <slug> [--project-dir <path>]`);
  }
  const err = validateBoltSlug(slug);
  if (err) {
    jsonError(err);
  }
  return slug;
}

function validateMergeDelta(delta: string): void {
  if (delta !== "" && !delta.endsWith("\n---\n")) {
    throw new Error("worktree audit delta ends with an incomplete block");
  }
  for (const block of delta.split(/\n---\n/).filter((part) => part.trim() !== "")) {
    const eventMatches = [...block.matchAll(/^(?:-\s*)?\*\*Event\*\*:\s*(.+)$/gm)];
    const timestampMatches = [...block.matchAll(/^(?:-\s*)?\*\*Timestamp\*\*:\s*(.+)$/gm)];
    if (eventMatches.length === 0) {
      const timestamps = block.match(/^(?:-\s*)?\*\*Timestamp\*\*:/gm) ?? [];
      if (timestamps.length !== 1) throw new Error("worktree audit delta has malformed note block");
      continue; // complete append-raw diagnostic note
    }
    if (eventMatches.length !== 1) throw new Error("worktree audit delta has duplicate Event fields");
    if (timestampMatches.length !== 1) {
      throw new Error("worktree audit delta must contain exactly one Timestamp field");
    }
    const eventType = eventMatches[0][1].trim();
    if (!VALID_EVENT_TYPES.has(eventType)) {
      throw new Error(`worktree audit delta contains unknown event ${eventType}`);
    }
    if (mergeEventIsProtected(eventType)) {
      throw new Error(`worktree audit delta contains protected authority event ${eventType}`);
    }
    const fields: Record<string, string> = {};
    for (const match of block.matchAll(/^(?:-\s*)?\*\*([^*]+)\*\*:\s*(.*)$/gm)) {
      const key = match[1].trim();
      if (key !== "Event" && key !== "Timestamp") fields[key] = match[2];
    }
    validateAuditEntry({ eventType, fields });
  }
}

function exactAuditField(block: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...block.matchAll(
    new RegExp(`^(?:-\\s*)?\\*\\*${escaped}\\*\\*:\\s*(.*)$`, "gm"),
  )];
  return matches.length === 1 ? matches[0][1].trim() : null;
}

interface CompleteAuditBlock {
  block: string;
  start: number;
  end: number;
}

interface AuditForkRecord extends CompleteAuditBlock {
  boundary: number;
  sourceHash: string;
  timestamp: string;
}

function completeAuditBlocks(content: string): CompleteAuditBlock[] {
  const separator = "\n---\n";
  const blocks: CompleteAuditBlock[] = [];
  let start = 0;
  while (start < content.length) {
    const separatorStart = content.indexOf(separator, start);
    if (separatorStart < 0) break;
    const end = separatorStart + separator.length;
    blocks.push({ block: content.slice(start, separatorStart), start, end });
    start = end;
  }
  return blocks;
}

function parseAuditForkBlock(block: CompleteAuditBlock, slug: string): AuditForkRecord | null {
  if (
    exactAuditField(block.block, "Event") !== "AUDIT_FORKED" ||
    exactAuditField(block.block, "Bolt slug") !== slug
  ) {
    return null;
  }
  const boundaryField = exactAuditField(block.block, "Fork Boundary");
  const sourceHash = exactAuditField(block.block, "Source Audit Hash");
  const timestamp = exactAuditField(block.block, "Timestamp");
  if (
    !boundaryField ||
    !/^\d+$/.test(boundaryField) ||
    !sourceHash ||
    !/^[0-9a-f]{64}$/.test(sourceHash) ||
    !timestamp
  ) {
    return null;
  }
  const boundary = Number(boundaryField);
  if (!Number.isSafeInteger(boundary) || boundary < 0) return null;
  return { ...block, boundary, sourceHash, timestamp };
}

function latestAuditFork(content: string, slug: string): AuditForkRecord | null {
  const blocks = completeAuditBlocks(content);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const fork = parseAuditForkBlock(blocks[i], slug);
    if (fork) return fork;
  }
  return null;
}

function forksCorrelate(left: AuditForkRecord, right: AuditForkRecord): boolean {
  return (
    left.boundary === right.boundary &&
    left.sourceHash === right.sourceHash &&
    left.timestamp === right.timestamp
  );
}

function matchingAuditMerge(
  content: string,
  slug: string,
  fork: AuditForkRecord,
): CompleteAuditBlock | null {
  for (const block of completeAuditBlocks(content)) {
    if (block.start < fork.end) continue;
    if (
      exactAuditField(block.block, "Event") !== "AUDIT_MERGED" ||
      exactAuditField(block.block, "Bolt slug") !== slug
    ) {
      continue;
    }
    const forkTimestamp = exactAuditField(block.block, "Fork Timestamp");
    if (forkTimestamp !== null) {
      if (forkTimestamp === fork.timestamp) return block;
      continue;
    }
    // Backward compatibility for receipts written before Fork Timestamp was
    // added: the boundary + source hash pair uniquely identifies the fork.
    if (
      exactAuditField(block.block, "Fork Boundary") === String(fork.boundary) &&
      exactAuditField(block.block, "Source Audit Hash") === fork.sourceHash
    ) {
      return block;
    }
  }
  return null;
}

function containsDeltaAtBlockBoundary(content: string, delta: string, after: number): boolean {
  if (delta === "") return false;
  let position = content.indexOf(delta, after);
  while (position >= 0) {
    if (position === after || content.slice(Math.max(0, position - 5), position) === "\n---\n") {
      return true;
    }
    position = content.indexOf(delta, position + 1);
  }
  return false;
}

function handleAuditFork(args: string[], projectDir: string): void {
  const slug = parseSlugFlag(args, "audit-fork");
  // Pin the main-side audit shard AND the worktree mirror to ONE intent so
  // audit-fork/merge operate on the same record (the SAME selector the state
  // fork used). recordPrefix is the worktree mirror's relative record dir
  // (null -> flat-legacy mirror, today's behaviour).
  const { intent, space } = parseSelectorFlags(args);
  const wtPath = worktreePath(projectDir, slug);
  const priorForkVerification = existsSync(wtPath)
    ? worktreeClaimBoundaryMatches(projectDir, wtPath, slug)
    : null;
  let scopeStamp: ReturnType<typeof requireLiveClaimForTeamUnit>;
  if (priorForkVerification) {
    validateLiveUnitScope(projectDir, slug);
    scopeStamp = priorForkVerification;
  } else {
    scopeStamp = requireLiveClaimForTeamUnit(projectDir, slug, {
      intent,
      space,
      walkingSkeletonMain: args.includes("--walking-skeleton-main"),
    });
  }
  const recordPrefix = relativeRecordDir(projectDir, intent, space);

  const mainAuditPath = auditFilePath(projectDir, intent, space);

  // Pre-emit guards (fail clean before any audit side-effect).
  if (!existsSync(mainAuditPath)) {
    jsonError(`main audit not found at ${mainAuditPath}; start a workflow first (describe what to build, e.g. /aidlc "build the auth service")`);
  }
  if (!existsSync(wtPath)) {
    jsonError(
      `worktree directory not found at ${wtPath}; run aidlc-worktree create first`
    );
  }

  if (!acquireAuditLock(projectDir, 50, 100, intent, space)) {
    jsonError("Failed to acquire audit lock after retries");
  }
  let boundary = 0;
  let sourceHash = "";
  let auditTs = "";
  let alreadyCurrent = false;
  let wtAuditPath = "";
  try {
    const projectReal = realpathSync(projectDir);
    const wtRel = relative(resolve(projectDir), resolve(wtPath));
    if (wtRel === "" || wtRel === ".." || wtRel.startsWith(`..${sep}`) || isAbsolute(wtRel)) {
      throw new Error(`worktree path is outside project: ${wtPath}`);
    }
    assertNoSymlinkInChainOrThrow(projectReal, wtRel);
    const wtReal = realpathSync(wtPath);
    const verifyWorktreeIdentity = (): void => {
      assertNoSymlinkInChainOrThrow(projectReal, wtRel);
      if (realpathSync(wtPath) !== wtReal) {
        throw new Error(`worktree path changed during audit-fork: ${wtPath}`);
      }
    };
    if (scopeStamp) {
      const wtClone = cloneIdPath(wtPath);
      verifyWorktreeIdentity();
      assertNoSymlinkInChainOrThrow(wtReal, relative(wtPath, wtClone));
      if (!existsSync(wtClone)) {
        mkdirSync(dirname(wtClone), { recursive: true });
        verifyWorktreeIdentity();
        assertNoSymlinkInChainOrThrow(wtReal, relative(wtPath, wtClone));
        const noFollow =
          typeof fsConstants.O_NOFOLLOW === "number"
            ? fsConstants.O_NOFOLLOW
            : 0;
        const bytes = Buffer.from(
          `${randomUUID().replace(/-/g, "").slice(0, 12)}\n`,
        );
        let cloneFd: number | undefined;
        try {
          cloneFd = openSync(
            wtClone,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              noFollow,
            0o600,
          );
          const identity = fstatSync(cloneFd);
          if (!identity.isFile()) {
            throw new Error("worktree clone id target is not a regular file");
          }
          writeSync(cloneFd, bytes, 0, bytes.length);
        } finally {
          if (cloneFd !== undefined) closeSync(cloneFd);
        }
        verifyWorktreeIdentity();
        assertNoSymlinkInChainOrThrow(wtReal, relative(wtPath, wtClone));
        const cloneReal = realpathSync(wtClone);
        const cloneRel = relative(wtReal, cloneReal);
        if (
          cloneRel === "" ||
          cloneRel === ".." ||
          cloneRel.startsWith(`..${sep}`) ||
          isAbsolute(cloneRel) ||
          !lstatSync(wtClone).isFile()
        ) {
          throw new Error("worktree clone id escaped the verified worktree");
        }
      }
    }
    // Fork and merge both select the worktree's clone ID exactly when the
    // state fork copied a claim stamp into that worktree.
    wtAuditPath = worktreeAuditFilePath(
      wtPath,
      recordPrefix,
      scopeStamp ? wtPath : projectDir,
    );

    const before = readAuditSnapshot(projectDir, mainAuditPath);
    if (existsSync(wtAuditPath)) {
      const existing = readAuditSnapshot(projectDir, wtAuditPath);
      const existingContent = existing.bytes.toString("utf-8");
      const existingFork = latestAuditFork(existingContent, slug);
      if (existingFork) {
        if (existingContent.slice(existingFork.end) !== "") {
          throw new Error(
            `worktree audit already exists at ${wtAuditPath} with unmerged work after ` +
              `AUDIT_FORKED; merge the delta with audit-merge, or discard the worktree`,
          );
        }
        const mainContent = before.bytes.toString("utf-8");
        const mainFork = latestAuditFork(mainContent, slug);
        if (!mainFork || !forksCorrelate(existingFork, mainFork)) {
          throw new Error(
            `worktree audit already exists at ${wtAuditPath}, but its AUDIT_FORKED row ` +
              `does not match the authoritative main row; discard the worktree before re-forking`,
          );
        }
        const expected = scopeStamp
          ? before.bytes.subarray(mainFork.start, mainFork.end)
          : before.bytes.subarray(0, mainFork.end);
        if (!existing.bytes.equals(expected)) {
          throw new Error(
            `worktree audit already exists at ${wtAuditPath}, but its fork prefix differs ` +
              `from main; discard the worktree before re-forking`,
          );
        }
        boundary = existingFork.boundary;
        sourceHash = existingFork.sourceHash;
        auditTs = existingFork.timestamp;
        alreadyCurrent = true;
      }
    }
    if (!alreadyCurrent) {
      boundary = before.bytes.length;
      sourceHash = createHash("sha256").update(before.bytes).digest("hex");
      const forkEntry = {
        eventType: "AUDIT_FORKED",
        fields: {
          "Bolt slug": slug,
          "Source Audit Hash": sourceHash,
          "Fork Boundary": String(boundary),
          ...claimAttemptFields(projectDir, slug),
        },
      };
      validateAuditEntry(forkEntry);
      auditTs = isoTimestamp();
      appendAuditBlockAtPath(
        projectDir,
        mainAuditPath,
        renderAuditBlock(forkEntry, auditTs, projectDir),
        {
          ...before.identity,
          prefixLength: boundary,
          prefixHash: sourceHash,
        },
      );
      tapAuditMetric("AUDIT_FORKED", forkEntry.fields, projectDir);

      // Worktree-local tools must append to the fork shard that audit-merge
      // consumes. Swarm worktrees share the parent clone token; claimed Unit
      // worktrees keep the fresh token minted above.
      const wtCloneIdPath = cloneIdPath(wtPath);
      const cloneBytes = scopeStamp
        ? readRegularFileNoFollowOrThrow(wtCloneIdPath, "worktree clone id")
        : readRegularFileNoFollowOrThrow(cloneIdPath(projectDir), "clone id");
      verifyWorktreeIdentity();
      assertNoSymlinkInChainOrThrow(wtReal, relative(wtPath, wtCloneIdPath));
      mkdirSync(dirname(wtCloneIdPath), { recursive: true });
      verifyWorktreeIdentity();
      assertNoSymlinkInChainOrThrow(wtReal, relative(wtPath, wtCloneIdPath));
      writeBufferAtomic(wtCloneIdPath, cloneBytes);
      verifyWorktreeIdentity();
      const mainAfterForkSnapshot = readAuditSnapshot(projectDir, mainAuditPath);
      if (mainAfterForkSnapshot.identity.dev !== before.identity.dev ||
          mainAfterForkSnapshot.identity.ino !== before.identity.ino) {
        throw new Error("main audit changed identity during audit-fork");
      }
      const mainAfterFork = mainAfterForkSnapshot.bytes;
      const worktreeForkBytes = scopeStamp
        ? (() => {
            const mainFork = latestAuditFork(mainAfterFork.toString("utf-8"), slug);
            if (!mainFork) throw new Error("main audit is missing the emitted AUDIT_FORKED row");
            return mainAfterFork.subarray(mainFork.start, mainFork.end);
          })()
        : mainAfterFork;
      verifyWorktreeIdentity();
      assertNoSymlinkInChainOrThrow(wtReal, relative(wtPath, wtAuditPath));
      mkdirSync(dirname(wtAuditPath), { recursive: true });
      verifyWorktreeIdentity();
      assertNoSymlinkInChainOrThrow(wtReal, relative(wtPath, wtAuditPath));
      writeBufferAtomic(wtAuditPath, worktreeForkBytes);
      verifyWorktreeIdentity();
    }
  } catch (e) {
    const message = e instanceof Error ? errorMessage(e) : String(e);
    try {
      if (auditTs !== "") {
        appendAuditEntryUnlocked(
          "ERROR_LOGGED",
          {
            Tool: "aidlc-audit",
            Command: "audit-fork",
            Error: `[slug=${slug}] [fork-emitted:${auditTs}] ${message}`,
          },
          projectDir,
          intent,
          space,
        );
      }
    } finally {
      releaseAuditLock(projectDir, intent, space);
    }
    jsonError(message);
  }
  releaseAuditLock(projectDir, intent, space);

  jsonSuccess({
    emitted: "AUDIT_FORKED",
    slug,
    source_audit_hash: sourceHash,
    fork_boundary: boundary,
    worktree_audit: wtAuditPath,
    audit_timestamp: auditTs,
    ...(alreadyCurrent
      ? {
          already_current: true,
          message: "audit fork already exists and is current; no changes made",
        }
      : {}),
  });
}

// --- Subcommand: audit-merge ---
//
// audit-merge --slug <slug> [--project-dir <path>]
//
// Merges a Bolt's worktree audit deltas back into the main audit on gate
// approval. Recovers Fork Boundary + Source Audit Hash from the worktree's
// AUDIT_FORKED entry, sanity-checks the prefix-hash against main audit's
// current first-`boundary` bytes (refuses on mismatch — catches mid-Bolt
// tampering or main-audit truncation), then appends the post-fork delta and
// emits AUDIT_MERGED.
//
// Delta detection is parse-driven: locate the AUDIT_FORKED block in the
// worktree audit, take everything after that block's "\n---\n" separator.
// The Fork Boundary field is used solely as the prefix-hash anchor, NOT for
// delta math (the worktree audit's copy of AUDIT_FORKED extends beyond
// `boundary` by the entry's own size; trusting `boundary` for delta-start
// would duplicate AUDIT_FORKED on merge-back).
//
// Lock budget: extended from acquireAuditLock's 5s default to 20s
// (200 retries × 100ms) to absorb N=4-8 Bolt-merge contention in workshop
// scenarios.
//
// One lock guards prefix validation, retry detection, and the combined
// delta+AUDIT_MERGED append. The retry pre-check runs immediately before that
// append; post-write verification order stays unchanged.

function handleAuditMerge(args: string[], projectDir: string): void {
  const slug = parseSlugFlag(args, "audit-merge");
  // Same selector the state/audit fork used -> the SAME intent record on both
  // ends (vision §5). recordPrefix pins the worktree audit mirror.
  const { intent, space } = parseSelectorFlags(args);
  const recordPrefix = relativeRecordDir(projectDir, intent, space);

  const mainAuditPath = auditFilePath(projectDir, intent, space);
  const wtPath = worktreePath(projectDir, slug);
  const scopeStamp = requireLiveClaimForTeamUnit(projectDir, slug, {
    intent,
    space,
    walkingSkeletonMain: true,
  });
  const wtAuditPath = worktreeAuditFilePath(
    wtPath,
    recordPrefix,
    scopeStamp ? wtPath : projectDir,
  );

  if (!existsSync(wtAuditPath)) {
    jsonError(`worktree audit not found at ${wtAuditPath}; nothing to merge`);
  }
  if (!existsSync(mainAuditPath)) {
    jsonError(`main audit not found at ${mainAuditPath}; start a workflow first (describe what to build, e.g. /aidlc "build the auth service")`);
  }

  const wtSnapshot = readAuditSnapshot(projectDir, wtAuditPath);
  const wtContent = wtSnapshot.bytes.toString("utf-8");

  const fork = latestAuditFork(wtContent, slug);
  if (!fork) {
    jsonError(`worktree audit missing AUDIT_FORKED entry for slug ${slug}`);
  }

  const boundary = fork.boundary;
  const sourceHash = fork.sourceHash;
  const forkTs = fork.timestamp;
  // forkTs anchors the audit-of-intent correlation tag for any post-emit
  // failure on this merge — doctor joins this back to the matching
  // AUDIT_FORKED row in main audit by exact-string timestamp match.

  const delta = wtContent.slice(fork.end);
  try {
    validateMergeDelta(delta);
  } catch (error) {
    jsonError(`refusing malformed or unauthorized worktree audit delta: ${errorMessage(error)}`);
  }

  // Acquire outer lock with extended budget for parallel-Bolt contention.
  // Defaults: 200 retries × 100ms = 20s, sized for N=4-8 contention. The
  // AIDLC_AUDIT_LOCK_RETRIES env var lets tests dial this down so the
  // lock-timeout failure path is testable without 20-second waits.
  const lockRetries = parseInt(
    process.env.AIDLC_AUDIT_LOCK_RETRIES ?? "200",
    10,
  );
  const lockRetryMs = parseInt(
    process.env.AIDLC_AUDIT_LOCK_RETRY_MS ?? "100",
    10,
  );
  if (!acquireAuditLock(projectDir, lockRetries, lockRetryMs, intent, space)) {
    jsonError(
      `Failed to acquire audit lock after ${lockRetries} × ${lockRetryMs}ms = ${(lockRetries * lockRetryMs / 1000).toFixed(1)}s retries; another merge in flight?`
    );
  }

  // Atomic critical section: retry pre-check + delta + AUDIT_MERGED run under a
  // single lock acquisition. The catch path uses the unlocked append variant
  // because we still hold that lock.
  //
  // Failure-mode worth flagging for doctor: appendAuditBlockAtPath can throw
  // during its verification after the combined bytes landed. The catch path
  // emits ERROR_LOGGED with [slug=<slug>] [fork-emitted:<forkTs>] correlation
  // tags; the next retry's pre-check then observes the receipt or exact delta
  // and does not append it again.
  let entriesMerged = 0;
  let result: { timestamp: string };
  let alreadyMerged = false;
  try {
    // Validate the main prefix only after acquiring the same lock that protects
    // the append. The prior pre-lock read allowed another writer to change the
    // ledger between validation and merge.
    const mainSnapshot = readAuditSnapshot(projectDir, mainAuditPath);
    const mainBuf = mainSnapshot.bytes;
    const wtCurrent = readAuditSnapshot(projectDir, wtAuditPath);
    if (wtCurrent.identity.dev !== wtSnapshot.identity.dev ||
        wtCurrent.identity.ino !== wtSnapshot.identity.ino ||
        !wtCurrent.bytes.equals(wtSnapshot.bytes)) {
      throw new Error("worktree audit changed while merge was preparing; retry the merge");
    }

    // The worktree copy is writable and cannot authoritatively choose how much
    // of main to validate. Recover the matching fork row from main and require
    // every correlation field to agree before trusting the boundary.
    const mainContent = mainBuf.toString("utf-8");
    const mainFork = latestAuditFork(mainContent, slug);
    if (!mainFork) throw new Error(`main audit is missing AUDIT_FORKED for slug ${slug}`);
    if (!forksCorrelate(fork, mainFork)) {
      throw new Error("worktree AUDIT_FORKED metadata does not match the authoritative main row");
    }
    if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > mainBuf.length) {
      throw new Error(`invalid Fork Boundary ${boundary} for ${mainBuf.length}-byte main audit`);
    }
    const prefixLen = boundary;
    const prefixHash = createHash("sha256")
      .update(mainBuf.subarray(0, prefixLen))
      .digest("hex");
    if (prefixHash !== sourceHash) {
      if (mainBuf.length < boundary) {
        throw new Error(
          `main audit prefix-hash does not match recorded Source Audit Hash ` +
            `(expected at least ${boundary} bytes, got ${mainBuf.length}); ` +
            `refusing to merge (main-audit truncation suspected)`,
        );
      }
      throw new Error(
        `main audit prefix-hash at byte ${boundary} does not match recorded Source Audit Hash; ` +
          `refusing to merge (mid-Bolt tampering suspected)`,
      );
    }
    const trimmed = delta.trim();
    if (trimmed !== "") entriesMerged = delta.split(/\n---\n/).filter((b) => b.trim()).length;
    const existingMerge = matchingAuditMerge(mainContent, slug, mainFork);
    const deltaAlreadyPresent = containsDeltaAtBlockBoundary(
      mainContent,
      delta,
      mainFork.end,
    );
    if (existingMerge || deltaAlreadyPresent) {
      alreadyMerged = true;
      result = {
        timestamp: existingMerge
          ? exactAuditField(existingMerge.block, "Timestamp") ?? forkTs
          : forkTs,
      };
    } else {
      const mergedEntry = {
        eventType: "AUDIT_MERGED",
        fields: {
          "Bolt slug": slug,
          "Entries Merged": String(entriesMerged),
          "Source Audit Hash": sourceHash,
          "Fork Boundary": String(boundary),
          "Fork Timestamp": forkTs,
        },
      };
      validateAuditEntry(mergedEntry);
      const mergedTimestamp = isoTimestamp();
      // Delta and receipt share one descriptor-pinned append, so no unsafe raw
      // append can bypass the normal shard protections or interleave between them.
      appendAuditBlockAtPath(
        projectDir,
        mainAuditPath,
        delta + renderAuditBlock(mergedEntry, mergedTimestamp, projectDir),
        {
          ...mainSnapshot.identity,
          prefixLength: boundary,
          prefixHash: sourceHash,
        },
      );
      tapAuditMetric("AUDIT_MERGED", mergedEntry.fields, projectDir);
      result = { timestamp: mergedTimestamp };
    }
  } catch (e) {
    const message = e instanceof Error ? errorMessage(e) : String(e);
    // We still hold the outer lock in the catch path. Use the unlocked
    // variant so we don't release-and-reacquire (which would race against
    // any concurrent merger waiting for our lock). Release in finally below.
    try {
      appendAuditEntryUnlocked(
        "ERROR_LOGGED",
        {
          Tool: "aidlc-audit",
          Command: "audit-merge",
          Error: `[slug=${slug}] [fork-emitted:${forkTs}] ${message}`,
        },
        projectDir,
        intent,
        space,
      );
    } finally {
      releaseAuditLock(projectDir, intent, space);
    }
    jsonError(message);
  }
  releaseAuditLock(projectDir, intent, space);

  jsonSuccess({
    emitted: "AUDIT_MERGED",
    slug,
    entries_merged: entriesMerged,
    source_audit_hash: sourceHash,
    fork_boundary: boundary,
    audit_timestamp: result.timestamp,
    ...(alreadyMerged
      ? {
          already_merged: true,
          message: "audit merge already applied; no changes made",
        }
      : {}),
  });
}

// --- CLI entry point ---

export function main(argv: string[]): void {
  const rawArgs = argv;

  // Extract --project-dir before general parsing
  let projectDirArg: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--project-dir" && i + 1 < rawArgs.length) {
      projectDirArg = rawArgs[i + 1];
      i++; // skip the value
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }

  const projectDir = resolveProjectDir(projectDirArg);
  const subcommand = filteredArgs[0];

  if (!subcommand) {
    jsonError("Usage: aidlc-audit <append|append-batch|append-raw|audit-fork|audit-merge> [args...]");
  }

  switch (subcommand) {
    case "append": {
      const eventType = filteredArgs[1];
      if (!eventType) {
        jsonError("Usage: aidlc-audit append <event-type> [--field key=value ...]");
      }
      refuseReservedCliEvent(eventType);
      const fields = parseFieldArgs(rawArgs);
      handleAppend(eventType, fields, projectDir);
      break;
    }

    case "append-batch": {
      const entries = filteredArgs[1];
      if (!entries) {
        jsonError("Usage: aidlc-audit append-batch <entries-json>");
      }
      refuseReservedCliBatch(entries);
      handleAppendBatch(entries, projectDir);
      break;
    }

    case "append-raw": {
      const heading = filteredArgs[1];
      const body = filteredArgs[2];
      if (!heading || !body) {
        jsonError(
          "Usage: aidlc-audit append-raw <heading> <body>"
        );
      }
      handleAppendRaw(heading, body, projectDir);
      break;
    }

    case "audit-fork":
      handleAuditFork(filteredArgs.slice(1), projectDir);
      break;

    case "audit-merge":
      handleAuditMerge(filteredArgs.slice(1), projectDir);
      break;

    default:
      jsonError(`Unknown subcommand: ${subcommand}. Expected: append, append-batch, append-raw, audit-fork, audit-merge`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
