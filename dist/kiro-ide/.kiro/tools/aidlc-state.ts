import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  acceptedRiskDispositionField,
  rejectedFindingDispositionField,
  REVIEW_FINDING_DISPOSITIONS_FIELD,
} from "./aidlc-review-brief.ts";
import {
  activeIntent,
  activeIntentUuid,
  activeSpace,
  activeUnitCheckpoint,
  auditBlockField,
  auditShardName,
  appendSlug,
  appendUnderHeading,
  artifactFilename,
  BLOCKING_SENSOR_OVERRIDE_CHOICE,
  BLOCKING_SENSOR_OVERRIDE_DECISION,
  BLOCKING_SENSOR_OVERRIDE_OPTIONS,
  type CheckboxState,
  checkSummaryConfirmationEvidence,
  claimAttemptFields,
  codekbDir,
  codekbRepoName,
  codekbStoreIsCurrent,
  countCheckboxes,
  currentSwarmSourceMergeChain,
  currentSwarmAttemptObligations,
  effectiveUnitGateRhythm,
  emitError,
  errorMessage,
  eventMatchesClaimAttempt,
  extractMarkdownSection,
  filterProducesByKind,
  findStageBySlug,
  findAllEvents,
  firstInScopeStageOfPhase,
  formatReceivedReply,
  freshReviewReceipts,
  getField,
  harnessDir,
  hasUnsafeSingleLineCharacter,
  holdsAuditLock,
  humanActedSinceGate,
  humanPresenceGuardDisabled,
  unattendedHumanPresenceHint,
  intentRepos,
  isAutonomousConstructionDecision,
  isAutonomousMode,
  isAutonomousSwarmStage,
  isTeamUnitOwnership,
  isNonAnswer,
  isRegularFile,
  isoTimestamp,
  KNOWN_CODEKB_STAGES,
  latestMainWorkflowStageRunFloorForProject,
  loadScopeMapping,
  nextInScopeStage,
  PHASE_NUMBERS,
  PHASES,
  parseCheckboxes,
  parseMemoryEntries,
  parseRefsList,
  parseStateStageSuffixes,
  pipelineLinkEvidence,
  producesArtifactFile,
  readAllAuditShards,
  readApplicableTeamUnitScopeStamp,
  readAuditShardEvents,
  readStateFile,
  readUnitMergeTransaction,
  readUnitGateRhythm,
  readUnitScopeStamp,
  recordDir,
  recoveryGuidance,
  relativeCodekbDir,
  relativeMemoryPath,
  relativeRecordDir,
  removeField,
  removeSlug,
  replaceSection,
  selfAttributedDecisionMarker,
  resolveBoltDag,
  requireLiveClaimForTeamUnit,
  reviewArtifactFingerprint,
  reviewerGateGuardDisabled,
  resolveReviewClass,
  resolveWorkflowSelection,
  sourceClaimCovers,
  sourceBaselineAuditFields,
  sourceListingEntriesEqual,
  resolveProjectDir,
  resolveStage,
  setCheckbox,
  setField,
  setFieldStrict,
  setOrInsertField,
  setPhaseProgress,
  singleStageAttemptIsOpen,
  stagesInScope,
  swarmConvergedUnits,
  unitCompletedReceipts,
  unitGateStatus,
  unitMajorConstructionStageSlugs,
  unitParkedPath,
  type UnitGateScope,
  updateIntentStatus,
  usesStageLevelPerUnitArtifacts,
  validateLiveUnitScope,
  validateUnitName,
  validScopes,
  withAuditLock,
  worktreeDocsDir,
  worktreePath,
  worktreeStateFilePath,
  workspaceSourceState,
  writeStateFile,
  writeUnitScopeStamp,
  writeFileAtomic,
} from "./aidlc-lib.js";
import { memoryDirFor } from "./aidlc-graph.ts";
import { inspectRequiredArtifactInstances } from "./aidlc-artifact-resolution.ts";
import { compiledExecutable } from "./aidlc-runtime-paths.ts";
import {
  stageValidationAuditFields,
  VALIDATION_WARNING_FIELD,
} from "./aidlc-validity.ts";
import {
  stageUsageAuditFields,
  workflowUsageAuditFields,
} from "./aidlc-usage.ts";
import { deriveTeamUnitProgressModel } from "./aidlc-orchestrate.ts";

// All valid checkbox states (lib.ts adds [?] awaiting-approval and [R] revising)
const VALID_CHECKBOX_STATES: CheckboxState[] = [
  "pending",
  "in-progress",
  "awaiting-approval",
  "revising",
  "completed",
  "skipped",
];

function isCheckboxState(s: string): s is CheckboxState {
  return (VALID_CHECKBOX_STATES as readonly string[]).includes(s);
}

// Top-level dirs the artifact guard treats as "not source code" - the whole
// `aidlc/` workspace tree holds the per-intent records + planning artifacts +
// memory + codekb, the harness dirs hold the framework, .git is VCS. (On v2 the
// flat `aidlc-docs/` root is gone - every record lives under aidlc/spaces/...,
// so skipping `aidlc` skips all planning docs.) Used by workspaceHasSourceFile
// (the top-level dir skip) and isNonDocPath (the git first-segment skip).
// Declared at module top (not beside verifyStageArtifacts) because the command
// dispatch runs at top level: a const declared lower in the file would be in
// its temporal dead zone when an approve/advance dispatch calls the guard.
const HARNESS_DOC_DIRS = new Set([
  "aidlc",
  ".claude",
  ".kiro",
  ".codex",
  ".opencode",
  ".aidlc",
  ".cursor",
  ".git",
]);

// KNOWN_CODEKB_STAGES now lives in aidlc-lib.ts (imported above) beside the
// shared produces-artifact matchers, so the review-freeze hook and this tool
// agree on which stages use the codekb layout. Imports are hoisted, so the
// TDZ concern that once kept a local copy here does not apply.

// --- Audit emission helper ---
// Uses the throw-on-error appendAuditEntry (not handleAppend which writes JSON to stdout).
// Caller wraps in try/catch; a thrown exception is the signal that audit failed and
// the state write should not proceed.
//
// Lock-aware: when the caller is mid-transaction inside a withAuditLock (the
// C2b lost-update wrapping — every RMW handler below holds the lock across
// read→decide→emit→write), this process already owns the OS lock. Routing
// through appendAuditEntry (which calls the NON-reentrant acquireAuditLock)
// would self-deadlock and burn the 5s retry budget before throwing, so detect
// the held lock and use the unlocked append variant instead — exactly how
// handleFork/handleMerge emit (appendAuditEntryUnlocked) and how emitError
// branches in aidlc-lib.ts. Outside a held lock (no current caller, but kept
// safe for any future bare-emit site) it takes its own lock as before.
function emitAudit(
  projectDir: string,
  eventType: string,
  fields: Record<string, string>
): string {
  if (holdsAuditLock(projectDir)) {
    return appendAuditEntryUnlocked(eventType, fields, projectDir).timestamp;
  }
  return appendAuditEntry(eventType, fields, projectDir).timestamp;
}

// Per-stage token/cost rollup fields for STAGE_COMPLETED / WORKFLOW_COMPLETED.
// Wraps aidlc-usage's ledger-read helper (a ledger read only: NO transcript
// I/O) in a try/catch so any failure returns {} (no fields). Usage must NEVER
// block, delay, or break a completion event, so the caller computes this into a
// const ABOVE the withAuditLock(...) call and only merges the resulting strings
// into the emit `fields`. "Before emitAudit" is NOT far enough - emitAudit runs
// UNDER the held lock (see emitAudit above), so a ledger read there would still
// happen inside the lock; computing it before the lock opens keeps the
// completion path lock-clean. When no ledger exists (Kiro/Codex/opencode, or a
// Claude session that never folded) this returns {} and the completion event is
// unchanged.
function stageRollupFields(pd: string, stageSlug: string): Record<string, string> {
  try {
    return stageUsageAuditFields(pd, stageSlug);
  } catch {
    return {};
  }
}

function workflowRollupFields(pd: string): Record<string, string> {
  try {
    return workflowUsageAuditFields(pd);
  } catch {
    return {};
  }
}

function auditField(block: string, fieldName: string): string | null {
  const prefix = `**${fieldName}**:`;
  for (const line of block.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function hasStageAuditEvent(
  projectDir: string,
  eventType: string,
  stageSlug: string
): boolean {
  // Read across every per-clone audit shard (one in the common single-clone /
  // flat-legacy case; the glob-merge matters only when concurrent clones append
  // to the same intent). readAllAuditShards returns "" when no shard exists.
  const audit = readAllAuditShards(projectDir);
  if (audit.length === 0) return false;
  const workflowStarts = findAllEvents(audit, "WORKFLOW_STARTED");
  const since = workflowStarts.length > 0
    ? workflowStarts[workflowStarts.length - 1].timestamp
    : "";
  return findAllEvents(audit, eventType).some((ev) => {
    if (since && ev.timestamp < since) return false;
    // Rows committed by a `--single` stage-runner run carry a synthetic
    // `Workflow: single-stage:<slug>` id and belong to no main workflow —
    // they must never satisfy a main-workflow dedup check (a single run's
    // STAGE_COMPLETED would otherwise suppress the main workflow's own
    // emission for the same slug). Main-workflow rows carry no Workflow field.
    if (auditField(ev.block, "Workflow")?.startsWith("single-stage:")) {
      return false;
    }
    return auditField(ev.block, "Stage") === stageSlug;
  });
}

function hasTeamAttemptStageAuditEvent(
  projectDir: string,
  eventType: string,
  stageSlug: string,
): boolean {
  const rows = readAuditShardEvents(projectDir).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
  let floor = -1;
  for (let i = 0; i < rows.length; i++) {
    if (
      rows[i].event !== "WORKFLOW_STARTED" &&
      rows[i].event !== "STAGE_JUMPED"
    ) {
      continue;
    }
    floor = i;
    if (
      rows.some(
        (row) =>
          row.timestamp === rows[i].timestamp &&
          row.shard !== rows[i].shard,
      )
    ) {
      while (
        floor + 1 < rows.length &&
        rows[floor + 1].timestamp === rows[i].timestamp
      ) {
        floor++;
      }
    }
  }
  return rows.slice(floor + 1).some(
    (row) =>
      row.event === eventType &&
      auditBlockField(row.block, "Stage") === stageSlug &&
      !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
  );
}

interface OrderedAuditEvent {
  event: string;
  block: string;
  timestamp: string;
  position: number;
}

// Audit rows are sharded by clone, so readAllAuditShards() concatenation order
// is not chronological. Build one ordered main-workflow stream for attempt-
// scoped recovery checks.
function orderedMainWorkflowAudit(projectDir: string): OrderedAuditEvent[] {
  const audit = readAllAuditShards(projectDir);
  if (audit.length === 0) return [];
  const events = audit
    .replace(/\r\n/g, "\n")
    .split(/\n---\n/)
    .map((block, position): OrderedAuditEvent | null => {
      const event = auditField(block, "Event");
      if (!event) return null;
      if (auditField(block, "Workflow")?.startsWith("single-stage:")) return null;
      return {
        event,
        block,
        timestamp: auditField(block, "Timestamp") ?? "",
        position,
      };
    })
    .filter((event): event is OrderedAuditEvent => event !== null)
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      return a.position - b.position;
    });
  const workflowStart = events.findLastIndex(
    (event) => event.event === "WORKFLOW_STARTED",
  );
  return workflowStart === -1 ? events : events.slice(workflowStart);
}

// Return the audit rows emitted after this stage's skip in its CURRENT attempt.
// A later STAGE_STARTED for the same slug starts a fresh attempt and invalidates
// all prior skip dedup evidence. This lets a backward jump skip the stage again
// while still recovering an interrupted [S] transition without duplicate rows.
function currentRoutedSkipAuditTail(
  projectDir: string,
  stageSlug: string,
): OrderedAuditEvent[] | null {
  const events = orderedMainWorkflowAudit(projectDir);
  let latestBoundary = -1;
  let latestBoundaryWasSkip = false;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (auditField(event.block, "Stage") !== stageSlug) continue;
    if (event.event === "STAGE_STARTED") {
      latestBoundary = i;
      latestBoundaryWasSkip = false;
    } else if (event.event === "STAGE_SKIPPED") {
      latestBoundary = i;
      latestBoundaryWasSkip = true;
    }
  }
  return latestBoundaryWasSkip ? events.slice(latestBoundary + 1) : null;
}

function auditTailHasFields(
  events: OrderedAuditEvent[],
  eventType: string,
  fields: Record<string, string>,
): boolean {
  return events.some(
    (event) =>
      event.event === eventType &&
      Object.entries(fields).every(
        ([field, value]) => auditField(event.block, field) === value,
      ),
  );
}

// producesArtifactFile / producesArtifactUnit / freshReviewReceipts moved to
// aidlc-lib.ts: the review-freeze PreToolUse hook shares the SAME scan so its
// write-freeze window and this tool's completion precondition can never
// diverge (a divergence would block writes the engine accepts, or miss writes
// the engine refuses). Imported above.

// The gate-revision backstop predicate (the reconciliation half of the
// forwarding-reliability gap). TRUE when the human demonstrably revised the
// stage's artifact at an OPEN gate but no `reject` verb was ever recorded, so
// `approve` should backfill the missing GATE_REJECTED + STAGE_REVISING pair
// rather than silently under-record the revision (leaving Revision Count 0 and
// no audit pair for a revision the user actually saw happen).
//
// Chronological interleave of six event types across every shard (Timestamp,
// then buffer position as the tiebreak): the SAME sort idiom humanActedSinceGate
// uses (aidlc-lib.ts). readAllAuditShards concatenates per-clone shards in
// FILENAME order, which is NOT time order, so a raw-position scan could misrank
// an older event living in a lexically-later shard. findAllEvents is NOT usable
// here: it filters ONE event type per call, and this predicate needs one
// interleaved ordering across all six to reason about "after the gate opened".
//
// The four conjuncts, all required:
//   1. an anchor exists: the LAST ORGANIC (non-Recovered) STAGE_AWAITING_APPROVAL
//      for this slug, or, when the stage was (re)started after it / it never
//      happened, the LAST STAGE_STARTED for this slug (the current stage run's
//      boundary). Recovered=true gate rows are NEVER the anchor: report
//      synthesizes one right before approve when the conductor skipped
//      gate-start, so its timestamp postdates the human turns and revision
//      writes the predicate needs inside the window, AND
//   2. no GATE_REJECTED for this slug after that anchor (a recorded reject means
//      the verb already ran, nothing to backfill), AND
//   3. at least one HUMAN_TURN after the anchor (the human responded at the
//      gate), AND
//   4. at least one ARTIFACT_CREATED/ARTIFACT_UPDATED to a declared produces file
//      AFTER the FIRST post-anchor HUMAN_TURN.
//
// The HUMAN_TURN pivot in conjunct 4 is load-bearing: the reviewer appends its
// `## Review` section to the stage's review_artifact BEFORE the human responds at the
// gate (stage-protocol-reviewer.md §12a), firing an ARTIFACT_UPDATED on a produces file.
// Anchoring the artifact window at the first post-anchor human turn (not the gate
// open) excludes that legitimate pre-response append, so the reviewer's edit is
// never mistaken for a human-driven revision.
//
// When the anchor is the STAGE_STARTED fallback (no organic gate row for this
// run), one extra conjunct applies: a produces-file write must ALSO exist
// BETWEEN the anchor and the first post-anchor HUMAN_TURN. Without a recorded
// gate-open, "the artifact already existed when the human weighed in" is the
// evidence separating a gate revision from ordinary production: mid-stage
// coaching (human speaks BEFORE any write, conductor then produces) must not
// bump Revision Count. An SAA anchor needs no such guard - production precedes
// gate-open by construction there.
//
// Fail-open everywhere (empty ledger, no anchor, no post-anchor human turn ->
// false): the backstop only ever ADDS a reject it can prove happened; when the
// evidence is absent it does nothing and the normal approve proceeds. Codekb
// stages are covered via producesArtifactFile's codekb arm (their produces live
// under codekb/<repo>/ with no <slug> subdir; the audit-logger hook logs those
// writes). A non-empty intent repo set scopes that evidence to its own repos; an
// empty legacy set retains the any-repo fallback described at the matcher. They
// were previously excluded outright, which - combined with the hook not logging
// codekb paths at all - left a revised-then-approved reverse-engineering gate
// with Revision Count 0 and no GATE_REJECTED row.
function unrecordedRevisionSinceGateOpen(
  pd: string,
  stage: { slug: string; produces?: string[] }
): boolean {
  const audit = readAllAuditShards(pd);
  if (audit.length === 0) return false; // no ledger -> nothing to reconcile
  const recordedRepos = new Set(intentRepos(pd));
  const RELEVANT = new Set([
    "STAGE_AWAITING_APPROVAL",
    "STAGE_STARTED",
    "GATE_REJECTED",
    "HUMAN_TURN",
    "ARTIFACT_CREATED",
    "ARTIFACT_UPDATED",
  ]);
  const blocks = audit.replace(/\r\n/g, "\n").split(/\n---\n/);
  const events: {
    ts: string;
    pos: number;
    event: string;
    stage: string | null;
    file: string | null;
    recovered: boolean;
  }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const ev = auditField(blocks[i], "Event");
    if (!ev || !RELEVANT.has(ev)) continue;
    events.push({
      ts: auditField(blocks[i], "Timestamp") ?? "",
      pos: i,
      event: ev,
      stage: auditField(blocks[i], "Stage"),
      file: auditField(blocks[i], "File"),
      recovered: auditField(blocks[i], "Recovered") === "true",
    });
  }
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.pos - b.pos;
  });
  // 1. Anchor: the LAST ORGANIC gate-open for this slug, else the LAST
  // STAGE_STARTED for it, whichever is later. A Recovered=true gate row is
  // report's own approve-time backfill: it postdates the human turns and the
  // revision this predicate is looking for, so anchoring on it empties the
  // window and produces the false negative on the skip-everything flow (the
  // common shape of the bug). The stage-start fallback bounds the window to
  // the current run when the conductor never opened the gate at all.
  let anchor = -1;
  let anchorIsGateOpen = false;
  for (let i = 0; i < events.length; i++) {
    if (events[i].stage !== stage.slug) continue;
    if (events[i].event === "STAGE_AWAITING_APPROVAL" && !events[i].recovered) {
      anchor = i;
      anchorIsGateOpen = true;
    } else if (events[i].event === "STAGE_STARTED") {
      anchor = i;
      anchorIsGateOpen = false;
    }
  }
  if (anchor === -1) return false;
  // 2 + 3 in one pass after the anchor: any recorded reject for this slug means
  // the verb ran (return false); otherwise capture the FIRST human turn as the
  // artifact-window pivot. For the stage-start fallback anchor, also require a
  // produces write BEFORE that pivot (see the function comment): without a
  // recorded gate-open, an artifact that predates the human's response is the
  // evidence the human was reacting to produced work rather than coaching a
  // stage that had produced nothing yet.
  let firstHuman = -1;
  let wroteBeforeHuman = false;
  for (let i = anchor + 1; i < events.length; i++) {
    const e = events[i];
    if (e.event === "GATE_REJECTED" && e.stage === stage.slug) {
      return false;
    }
    if (firstHuman === -1) {
      if (e.event === "HUMAN_TURN") {
        firstHuman = i;
      } else if (
        (e.event === "ARTIFACT_CREATED" || e.event === "ARTIFACT_UPDATED") &&
        e.file !== null &&
        producesArtifactFile(stage, e.file, recordedRepos)
      ) {
        wroteBeforeHuman = true;
      }
    }
  }
  if (firstHuman === -1) return false;
  if (!anchorIsGateOpen && !wroteBeforeHuman) return false;
  // 4. A produces-file artifact write after the first post-anchor human turn.
  for (let i = firstHuman + 1; i < events.length; i++) {
    const e = events[i];
    if (
      (e.event === "ARTIFACT_CREATED" || e.event === "ARTIFACT_UPDATED") &&
      e.file !== null &&
      producesArtifactFile(stage, e.file, recordedRepos)
    ) {
      return true;
    }
  }
  return false;
}

// --- Slug + small helpers (used by fork/merge handlers below; declared
// before main() so they're initialised before dispatch fires) ---

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

function validateSlug(slug: string | undefined): string {
  if (!slug) errorWithSlug("(missing)", `Missing --slug <slug>`);
  if (!SLUG_RE.test(slug)) {
    errorWithSlug(slug, `Invalid --slug: "${slug}". Must be kebab-case (lowercase letter then [a-z0-9-]).`);
  }
  return slug;
}

function errorWithSlug(slug: string, msg: string): never {
  error(`[slug=${slug}] ${msg}`);
}

function sha256(buf: string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && i + 1 < args.length) {
      flags[a.slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

// --- CLI entry point ---

let projectDir: string | undefined;

// Active per-intent lock context for the in-transaction error path. handleFork/
// handleMerge resolve their intent and hold a PER-INTENT audit lock across the
// whole transaction (withAuditLock(pd, fn, resolvedIntent, space)). When an
// errorWithSlug fires mid-transaction it routes through error() -> emitError,
// whose holdsAuditLock probe must key the SAME per-intent bucket the caller
// holds — a bare holdsAuditLock(pd) keys the __workspace__ sentinel, returns
// false mid per-intent transaction, and takes emitError's 5s blocking-acquire
// branch writing ERROR_LOGGED to the wrong bucket. These mirror the resolved
// intent+space into error() so emitError keys lock==write. Set immediately
// before the lock, cleared after; on the happy path no error fires and they are
// harmless. All OTHER handlers lock the sentinel bucket and leave these unset
// (undefined), so error() keys the sentinel for them — correct.
let lockIntent: string | undefined;
let lockSpace: string | undefined;
let stateSessionOverride: string | undefined;

export function main(argv: string[]): void {
  const args = [...argv];

  // Extract --project-dir flag
  const pdIdx = args.indexOf("--project-dir");
  if (pdIdx !== -1 && pdIdx + 1 < args.length) {
    projectDir = args[pdIdx + 1];
    args.splice(pdIdx, 2);
  }
  stateSessionOverride =
    resolveWorkflowSelection(resolveProjectDir(projectDir)).sessionId ?? undefined;

  const subcommand = args[0];

  // Lifecycle transitions and generic state writes are engine-owned. The
  // orchestrator binds its child marker to its own PID; this process accepts it
  // only when it names the actual parent. A copied static token cannot bypass
  // report's stage pinning, evidence checks, and idempotency.
  const engineOwnedTransitions = new Set([
    "set",
    "checkbox",
    "advance",
    "finalize",
    "complete-workflow",
    "gate-start",
    "approve",
    "reject",
    "revise",
    "skip",
    "park",
    "refresh-unit-progress",
    "sync-unit-scope-stage",
    "fold-unit-merge",
  ]);
  if (
    subcommand &&
    engineOwnedTransitions.has(subcommand) &&
    process.env.AIDLC_STATE_TRANSITION_OWNER !== `orchestrate:${process.ppid}` &&
    !(
      subcommand === "fold-unit-merge" &&
      process.env.AIDLC_STATE_TRANSITION_OWNER === `unit-merge:${process.ppid}`
    ) &&
    process.env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS !== "1"
  ) {
    error(
      `Stage status cannot be changed with aidlc-state.ts ${subcommand} because that bypasses ` +
        "the workflow's completion and approval checks. Use aidlc-orchestrate.ts report " +
        "--stage <slug> --result " +
        "<awaiting-approval|approved|rejected|revised|completed|skipped>; use " +
        "aidlc-orchestrate.ts park to pause, and next/jump to move through the workflow.",
    );
  }

  try {
    switch (subcommand) {
      case "get":
        handleGet(args.slice(1));
        break;
      case "set":
        handleSet(args.slice(1));
        break;
      case "set-skeleton-stance":
        handleSetSkeletonStance(args.slice(1));
        break;
      case "set-construction-iteration":
        handleSetConstructionIteration(args.slice(1));
        break;
      case "set-unit-ownership":
        handleSetUnitOwnership(args.slice(1));
        break;
      case "set-unit-gate-rhythm":
        handleSetUnitGateRhythm(args.slice(1));
        break;
      case "refresh-unit-progress":
        handleRefreshUnitProgress(args.slice(1));
        break;
      case "sync-unit-scope-stage":
        handleSyncUnitScopeStage(args.slice(1));
        break;
      case "fold-unit-merge":
        handleFoldUnitMerge(args.slice(1));
        break;
      case "checkbox":
        handleCheckbox(args.slice(1));
        break;
      case "count":
        handleCount(args.slice(1));
        break;
      case "advance":
        handleAdvance(args.slice(1));
        break;
      case "finalize":
        handleFinalize(args.slice(1));
        break;
      case "complete-workflow":
        handleCompleteWorkflow(args.slice(1));
        break;
      case "gate-start":
        handleGateStart(args.slice(1));
        break;
      case "approve":
        handleApprove(args.slice(1));
        break;
      case "reject":
        handleReject(args.slice(1));
        break;
      case "revise":
        handleRevise(args.slice(1));
        break;
      case "skip":
        handleSkip(args.slice(1));
        break;
      case "resume":
        handleResume(args.slice(1));
        break;
      case "acknowledge-compaction":
        handleAcknowledgeCompaction(args.slice(1));
        break;
      case "reuse-artifact":
        handleReuseArtifact(args.slice(1));
        break;
      case "lookup":
        handleLookup(args.slice(1));
        break;
      case "practices-event":
        handlePracticesEvent(args.slice(1));
        break;
      case "practices-promote":
        handlePracticesPromote(args.slice(1));
        break;
      case "fork":
        handleFork(args.slice(1));
        break;
      case "merge":
        handleMerge(args.slice(1));
        break;
      case "unit":
        handleUnit(args.slice(1));
        break;
      case "park":
        handlePark(args.slice(1));
        break;
      case "unpark":
        handleUnpark(args.slice(1));
        break;
      default:
        error(
          `Unknown subcommand: ${subcommand}. Valid: get, set, set-skeleton-stance, set-construction-iteration, set-unit-ownership, set-unit-gate-rhythm, refresh-unit-progress, sync-unit-scope-stage, fold-unit-merge, checkbox, count, advance, finalize, complete-workflow, gate-start, approve, reject, revise, skip, resume, acknowledge-compaction, reuse-artifact, lookup, practices-event, practices-promote, fork, merge, unit, park, unpark`
        );
    }
  } catch (e) {
    error(errorMessage(e));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}

// --- Subcommand handlers ---

function handleGet(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts get <field>");
  const field = args.join(" ");
  const pd = resolveProjectDir(projectDir);
  const content = readStateFile(pd);
  const value = getField(content, field);
  if (value === null) {
    error(`Field not found: ${field}`);
  }
  console.log(value);
}

function handleSet(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts set <field=value> ...");
  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: hold the audit lock across read→decide→write so
  // two concurrent `set`s of different fields can't clobber each other (A reads
  // V1, B reads V1, A writes V2, B writes V1.5 → A's field lost). The +1/-1
  // increment forms are especially exposed — they read-modify a counter.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  for (const pair of args) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) error(`Invalid field=value pair: ${pair}`);
    const field = pair.slice(0, eqIdx);
    let value = pair.slice(eqIdx + 1);

    // Special values
    if (value === "NOW") {
      value = isoTimestamp();
    } else if (value === "+1") {
      const current = getField(content, field);
      const num = current ? parseInt(current, 10) : 0;
      value = String(num + 1);
    } else if (value === "-1") {
      const current = getField(content, field);
      const num = current ? parseInt(current, 10) : 0;
      value = String(Math.max(0, num - 1));
    }

    content = setField(content, field, value);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ updated: true, fields: args.length }));
  });
}

// set-skeleton-stance <on|off|scope-dependent> — record the conductor's
// classified walking-skeleton stance (the classify round-trip). The
// `Skeleton Stance` field is runtime metadata (like Revision Count): it is NOT
// in the base state template, so we use setOrInsertField to update-if-present /
// insert-under-`## Runtime State`-if-absent (mirrors aidlc-bolt.ts's Merge-Held
// pattern for a runtime-only field). No audit row — the stance is metadata the
// next `aidlc-orchestrate next` reads to resolve the deferred Construction
// Bolt-1 gate, not a state-machine transition; it rides no event, exactly like
// `set` itself. The orchestration engine shells out to THIS subcommand rather
// than writing state itself (the engine writes nothing).
function handleSetSkeletonStance(args: string[]): void {
  // Declared inside the handler: `main()` is invoked at module load before a
  // module-level const further down would initialise (TDZ), so the value set
  // lives here, where it is reached only when the subcommand runs.
  const skeletonStanceValues = ["on", "off", "scope-dependent"];
  if (args.length < 1) {
    error(
      `Usage: aidlc-state.ts set-skeleton-stance <${skeletonStanceValues.join("|")}>`,
    );
  }
  const stance = args[0];
  if (!skeletonStanceValues.includes(stance)) {
    error(
      `Invalid skeleton stance "${stance}". Valid: ${skeletonStanceValues.join(", ")}.`,
    );
  }
  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: read→write under one lock (a concurrent `set` of an
  // unrelated field must not lose this stance write, nor vice versa).
  withAuditLock(pd, () => {
  const content = readStateFile(pd);
  const updated = setOrInsertField(
    content,
    "## Runtime State",
    "Skeleton Stance",
    stance,
  );
  writeStateFile(pd, updated);
  console.log(JSON.stringify({ updated: true, skeleton_stance: stance }));
  });
}

// set-construction-iteration <unit-major|stage-major>: record how the per-unit
// construction stages (design + code-generation) iterate over units.
// `Construction Iteration` is runtime metadata
// (like Skeleton Stance): it is NOT in the base state template, so we use
// setOrInsertField to update-if-present / insert-under-`## Runtime State`-if-absent.
// No audit row: the field is metadata the next `aidlc-orchestrate next` reads to
// pick the (stage, unit) walk order, not a state-machine transition; it rides no
// event, exactly like `set` and `set-skeleton-stance`. The classify round-trip is
// initiated by the delivery-planning stage prose (or set directly by a human); the
// engine writes nothing itself.
function handleSetConstructionIteration(args: string[]): void {
  // Declared inside the handler for the same TDZ reason as skeleton stance:
  // main() runs at module load before a module-level const would initialise.
  const constructionIterationValues = ["unit-major", "stage-major"];
  if (args.length < 1) {
    error(
      `Usage: aidlc-state.ts set-construction-iteration <${constructionIterationValues.join("|")}>`,
    );
  }
  const value = args[0];
  if (!constructionIterationValues.includes(value)) {
    error(
      `Invalid construction iteration "${value}". Valid: ${constructionIterationValues.join(", ")}.`,
    );
  }
  const pd = resolveProjectDir(projectDir);
  // Lost-update safety: read-then-write under one lock, as for the stance write.
  withAuditLock(pd, () => {
  const content = readStateFile(pd);
  if (value !== "unit-major" && isTeamUnitOwnership(content)) {
    error(
      "Construction Iteration cannot leave unit-major while Unit Ownership is team. " +
        "Set unit ownership to solo first.",
    );
  }
  const updated = setOrInsertField(
    content,
    "## Runtime State",
    "Construction Iteration",
    value,
  );
  writeStateFile(pd, updated);
  console.log(JSON.stringify({ updated: true, construction_iteration: value }));
  });
}

function unitProgressSectionRange(
  content: string,
): { start: number; end: number } | null {
  const match = /^## Unit Progress\r?$/m.exec(content);
  if (!match) return null;
  const afterHeading = match.index + match[0].length;
  const next = /^## /m.exec(content.slice(afterHeading));
  return {
    start: match.index,
    end: next ? afterHeading + next.index : content.length,
  };
}

function removeUnitProgressSection(content: string): string {
  const range = unitProgressSectionRange(content);
  if (!range) return content;
  return `${content.slice(0, range.start)}${content.slice(range.end)}`;
}

function upsertUnitProgressSection(content: string, section: string): string {
  const normalized = `${section.trimEnd()}\n\n`;
  const range = unitProgressSectionRange(content);
  if (range) {
    return `${content.slice(0, range.start)}${normalized}${content.slice(range.end)}`;
  }
  const currentStatus = /^## Current Status$/m;
  if (currentStatus.test(content)) {
    return content.replace(currentStatus, `${normalized}## Current Status`);
  }
  return `${content.trimEnd()}\n\n${normalized}`;
}

function currentUnitProgressSection(content: string): string {
  const range = unitProgressSectionRange(content);
  if (!range) refuseUnitProgress("State has no Unit Progress section.");
  return content.slice(range.start, range.end).trimEnd();
}

function hasCurrentTeamUnitActivity(pd: string, content: string): boolean {
  if (!isTeamUnitOwnership(content)) return false;
  const rows = readAuditShardEvents(pd).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
  let floor = -1;
  for (let i = 0; i < rows.length; i++) {
    if (
      rows[i].event === "WORKFLOW_STARTED" ||
      rows[i].event === "STAGE_JUMPED"
    ) {
      floor = i;
      if (
        rows.some(
          (row) =>
            row.timestamp === rows[i].timestamp &&
            row.shard !== rows[i].shard,
        )
      ) {
        while (
          floor + 1 < rows.length &&
          rows[floor + 1].timestamp === rows[i].timestamp
        ) {
          floor++;
        }
      }
    }
  }
  let latestOwnership = -1;
  for (let i = floor + 1; i < rows.length; i++) {
    if (rows[i].event === "UNIT_OWNERSHIP_SET") latestOwnership = i;
  }
  let teamMode =
    latestOwnership === -1 ||
    auditBlockField(rows[latestOwnership].block, "Mode") === "team";
  const activityEvents = new Set(
    "UNIT_STARTED,UNIT_PAUSED,UNIT_RESUMED,UNIT_COMPLETED,STAGE_AWAITING_APPROVAL,STAGE_REVISING,GATE_APPROVED,GATE_REJECTED".split(
      ",",
    ),
  );
  for (let i = Math.max(floor, latestOwnership) + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.event === "UNIT_OWNERSHIP_SET") {
      teamMode = auditBlockField(row.block, "Mode") === "team";
      continue;
    }
    if (
      teamMode &&
      activityEvents.has(row.event) &&
      auditBlockField(row.block, "Unit") !== null
    ) {
      return true;
    }
  }
  return false;
}

function handleSetUnitOwnership(args: string[]): void {
  const values = ["team", "solo"];
  if (args.length < 1) {
    error(`Usage: aidlc-state.ts set-unit-ownership <${values.join("|")}>`);
  }
  const value = args[0];
  if (!values.includes(value)) {
    error(`Invalid unit ownership "${value}". Valid: ${values.join(", ")}.`);
  }
  const pd = resolveProjectDir(projectDir);
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    const current = getField(content, "Unit Ownership")?.trim() || "solo";
    if (value !== current && hasCurrentTeamUnitActivity(pd, content)) {
      error(
        `Unit ownership is frozen after team Unit activity in the current workflow attempt (current: ${current}).`,
      );
    }
    if (
      value === "team" &&
      getField(content, "Construction Iteration")?.trim() !== "unit-major"
    ) {
      error(
        'Unit ownership "team" requires Construction Iteration: unit-major. ' +
          "Run aidlc-state.ts set-construction-iteration unit-major first.",
      );
    }
    if (value === "team") {
      const repos = intentRepos(pd);
      if (repos.length > 0) {
        error(
          `Unit ownership "team" is not supported for intents with recorded workspace repos ` +
            `(${repos.join(", ")}). Team-owned Unit claims require the workspace root itself ` +
            "to be the source Git repository.",
        );
      }
      const resolution = resolveBoltDag(pd);
      if (resolution.state === "none") {
        error(
          'Unit ownership "team" requires a non-empty authoritative unit DAG.',
        );
      }
      if (resolution.state === "malformed") {
        error(
          `Unit ownership "team" requires a valid authoritative unit DAG: ${resolution.reason}: ${resolution.detail}`,
        );
      }
      if (resolution.units.length === 0) {
        error(
          'Unit ownership "team" requires a non-empty authoritative unit DAG.',
        );
      }
    }
    content = setOrInsertField(
      content,
      "## Runtime State",
      "Unit Ownership",
      value,
    );
    if (value === "solo") content = removeUnitProgressSection(content);
    emitAudit(pd, "UNIT_OWNERSHIP_SET", { Mode: value });
    writeStateFile(pd, content);
    console.log(JSON.stringify({ updated: true, unit_ownership: value }));
  });
}

function handleSetUnitGateRhythm(args: string[]): void {
  const values = ["per-stage", "unit-end"];
  if (args.length < 1) {
    error(`Usage: aidlc-state.ts set-unit-gate-rhythm <${values.join("|")}>`);
  }
  const value = args[0];
  if (!values.includes(value)) {
    error(`Invalid unit gate rhythm "${value}". Valid: ${values.join(", ")}.`);
  }
  const pd = resolveProjectDir(projectDir);
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    if (!isTeamUnitOwnership(content)) {
      error(
        "Unit gate rhythm requires Unit Ownership: team. " +
          "Run aidlc-state.ts set-unit-ownership team first.",
      );
    }
    const current = readUnitGateRhythm(content);
    if (value !== current && hasCurrentTeamUnitActivity(pd, content)) {
      error(
        `Unit gate rhythm is frozen after team Unit activity in the current workflow attempt (current: ${current}).`,
      );
    }
    content = setOrInsertField(
      content,
      "## Runtime State",
      "Unit Gate Rhythm",
      value,
    );
    emitAudit(pd, "UNIT_GATE_RHYTHM_SET", { Rhythm: value });
    writeStateFile(pd, content);
    console.log(JSON.stringify({ updated: true, unit_gate_rhythm: value }));
  });
}

interface UnitProgressRefreshPayload {
  section: string;
  stage_states: Record<string, CheckboxState>;
}

function refuseUnitProgress(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

function parseUnitProgressTable(section: string): {
  preface: string[];
  header: string[];
  separator: string[];
  rows: Map<string, string[]>;
  order: string[];
} {
  const lines = section.split(/\r?\n/);
  const firstTableLine = lines.findIndex((line) => line.startsWith("|"));
  if (firstTableLine < 0) refuseUnitProgress("Invalid Unit Progress table.");
  const table = lines.slice(firstTableLine).map((line) =>
    line.split("|").slice(1, -1).map((cell) => cell.trim())
  );
  if (
    table.length < 2 ||
    table[0][0]?.toLowerCase() !== "unit" ||
    table[1].length !== table[0].length
  ) {
    refuseUnitProgress("Invalid Unit Progress table header.");
  }
  const header = table[0];
  const separator = table[1];
  const rows = new Map<string, string[]>();
  const order: string[] = [];
  for (const cells of table.slice(2)) {
    if (
      cells.length !== header.length ||
      cells.every((cell) => /^-+$/.test(cell))
    ) {
      continue;
    }
    rows.set(cells[0], cells);
    order.push(cells[0]);
  }
  return {
    preface: lines.slice(0, firstTableLine),
    header,
    separator,
    rows,
    order,
  };
}

function foldUnitProgressSection(
  currentSection: string,
  authoritativeSection: string,
  unit: string,
): string {
  const current = parseUnitProgressTable(currentSection);
  const authoritative = parseUnitProgressTable(authoritativeSection);
  const target = authoritative.rows.get(unit);
  if (!target) {
    refuseUnitProgress(`Authoritative Unit Progress has no row for "${unit}".`);
  }
  const currentIndex = new Map(
    current.header.map((name, index) => [name, index]),
  );
  const rows = authoritative.order.map((rowUnit) => {
    if (rowUnit === unit) return `| ${target.join(" | ")} |`;
    const before = current.rows.get(rowUnit);
    const derived = authoritative.rows.get(rowUnit);
    if (!before || !derived) {
      refuseUnitProgress(
        `Cannot preserve non-target Unit Progress row "${rowUnit}".`,
      );
    }
    const preserved = authoritative.header.map((name, index) => {
      const oldIndex = currentIndex.get(name);
      return oldIndex === undefined ? derived[index] : before[oldIndex];
    });
    return `| ${preserved.join(" | ")} |`;
  });
  return [
    ...authoritative.preface,
    `| ${authoritative.header.join(" | ")} |`,
    `| ${authoritative.separator.join(" | ")} |`,
    ...rows,
  ].join("\n");
}

function handleRefreshUnitProgress(
  args: string[],
  quiet = false,
  foldUnit?: string,
  foldOwner?: string,
  afterWrite?: () => void,
): void {
  const payloadRaw = getFlagValue(args, "--payload");
  if (!payloadRaw) {
    refuseUnitProgress(
      "Usage: aidlc-state.ts refresh-unit-progress --payload <base64url-json>",
    );
  }
  let payload: UnitProgressRefreshPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadRaw, "base64url").toString("utf-8"),
    ) as UnitProgressRefreshPayload;
  } catch (e) {
    refuseUnitProgress(`Invalid unit progress payload: ${errorMessage(e)}`);
  }
  if (
    typeof payload.section !== "string" ||
    !payload.section.startsWith("## Unit Progress\n") ||
    payload.stage_states === null ||
    typeof payload.stage_states !== "object"
  ) {
    refuseUnitProgress("Invalid unit progress payload shape.");
  }
  const sectionTail = payload.section.split("\n").slice(1).join("\n");
  if (
    /^#{1,6}\s/m.test(sectionTail) ||
    /^- \*\*[^*]+\*\*:/m.test(sectionTail)
  ) {
    refuseUnitProgress(
      "Invalid unit progress payload: embedded headings and state field lines are forbidden.",
    );
  }
  const pd = resolveProjectDir(projectDir);
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    const before = content;
    if (!isTeamUnitOwnership(content)) {
      refuseUnitProgress(
        "Refusing Unit Progress refresh: Unit Ownership is not team.",
      );
    }
    if (getField(content, "Construction Iteration")?.trim() !== "unit-major") {
      refuseUnitProgress(
        "Refusing Unit Progress refresh: Construction Iteration must be unit-major.",
      );
    }
    let authoritative: ReturnType<typeof deriveTeamUnitProgressModel>;
    try {
      authoritative = deriveTeamUnitProgressModel(
        pd,
        content,
        undefined,
        foldUnit ? new Set([foldUnit]) : undefined,
        foldUnit && foldOwner
          ? { ownerOverrides: new Map([[foldUnit, foldOwner]]) }
          : undefined,
      );
    } catch (e) {
      refuseUnitProgress(
        `Refusing Unit Progress refresh: ${errorMessage(e)}`,
      );
    }
    const suppliedStates = Object.entries(payload.stage_states).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const authoritativeStates = Object.entries(authoritative.stageStates).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    if (
      payload.section !== authoritative.section ||
      JSON.stringify(suppliedStates) !== JSON.stringify(authoritativeStates)
    ) {
      refuseUnitProgress(
        "Refusing Unit Progress refresh: payload does not match authoritative DAG/artifact/receipt/gate evidence.",
      );
    }
    const section = foldUnit
      ? foldUnitProgressSection(
        currentUnitProgressSection(content),
        authoritative.section,
        foldUnit,
      )
      : authoritative.section;
    content = upsertUnitProgressSection(content, section);
    const stageEntries = Object.entries(authoritative.stageStates);
    const completedNow: string[] = [];
    for (const [slug, state] of stageEntries) {
      if (!isCheckboxState(state)) {
        refuseUnitProgress(
          `Invalid derived checkbox state for "${slug}": ${state}`,
        );
      }
      const stage = findStageBySlug(slug);
      if (
        stage?.phase !== "construction" ||
        stage.for_each !== "unit-of-work"
      ) {
        refuseUnitProgress(`Invalid Unit Progress stage: ${slug}`);
      }
      content = setCheckbox(content, slug, state);
      if (
        state === "completed" &&
        (
          getSlugState(before, slug) !== "completed" ||
          !hasStageAuditEvent(pd, "STAGE_COMPLETED", slug)
        )
      ) {
        completedNow.push(slug);
      }
    }

    const allBlockStagesComplete =
      stageEntries.length > 0 &&
      stageEntries.every(([, state]) => state === "completed");
    const blockSlugs = stageEntries.map(([slug]) => slug);
    const currentSlug = getField(content, "Current Stage") ?? "";
    let started: string | null = null;
    let phaseBoundary = false;
    let workflowCompleted = false;
    let completedFinalStage: NonNullable<ReturnType<typeof findStageBySlug>> | null =
      null;
    if (allBlockStagesComplete && blockSlugs.includes(currentSlug)) {
      const finalSlug = blockSlugs[blockSlugs.length - 1];
      const workflowScope = getField(content, "Scope") ?? "";
      const finalStage = findStageBySlug(finalSlug);
      const next = nextInScopeStage(finalSlug, workflowScope, content);
      if (finalStage && next) {
        const nextAfter = nextInScopeStage(next.slug, workflowScope, content);
        const timestamp = isoTimestamp();
        phaseBoundary = finalStage.phase !== next.phase;
        content = setCheckbox(content, next.slug, "in-progress");
        content = setField(content, "Current Stage", next.slug);
        content = setField(content, "Lifecycle Phase", next.phase.toUpperCase());
        content = setField(content, "Next Stage", nextAfter?.slug ?? "none");
        content = setField(content, "In Progress", next.slug);
        content = setField(content, "Active Agent", next.lead_agent);
        content = setField(content, "Status", "Running");
        content = setField(content, "Last Updated", timestamp);
        content = setField(content, "Last Completed Stage", finalSlug);
        content = setField(content, "Next Action", `Execute ${next.name}`);
        if (phaseBoundary) {
          content = setPhaseProgress(content, finalStage.phase, "Verified");
          content = setPhaseProgress(content, next.phase, "Active");
        }
        started = next.slug;
      } else if (
        finalStage &&
        getField(before, "Status") !== "Completed"
      ) {
        const timestamp = isoTimestamp();
        content = setField(content, "Current Stage", finalSlug);
        content = setField(content, "Status", "Completed");
        content = setField(content, "Last Updated", timestamp);
        content = setField(content, "Last Completed Stage", finalSlug);
        content = setField(content, "In Progress", "none");
        content = setField(content, "Next Stage", "none");
        content = setField(content, "Next Action", "Workflow complete");
        content = setPhaseProgress(content, finalStage.phase, "Verified");
        workflowCompleted = true;
        completedFinalStage = finalStage;
      }
    }
    content = setField(
      content,
      "Completed",
      String(countCheckboxes(content, "completed")),
    );
    try {
      for (const slug of completedNow) {
        const stage = findStageBySlug(slug);
        if (!hasTeamAttemptStageAuditEvent(pd, "STAGE_STARTED", slug)) {
          emitAudit(pd, "STAGE_STARTED", {
            Stage: slug,
            Agent: stage?.lead_agent ?? "",
          });
        }
        emitAudit(pd, "STAGE_COMPLETED", {
          Stage: slug,
          Details: `Stage ${stage?.name ?? slug} completed from team Unit Progress`,
        });
      }
      if (started) {
        const next = findStageBySlug(started);
        if (phaseBoundary) {
          emitAudit(pd, "PHASE_COMPLETED", {
            "From phase": "construction",
            "To phase": next?.phase ?? "",
            "Stages completed": String(countCheckboxes(content, "completed")),
          });
          emitAudit(pd, "PHASE_VERIFIED", {
            "Phase boundary": `construction → ${next?.phase ?? ""}`,
          });
          emitAudit(pd, "PHASE_STARTED", {
            Phase: next?.phase ?? "",
            Scope: getField(content, "Scope") ?? "",
          });
        }
        emitAudit(pd, "STAGE_STARTED", {
          Stage: started,
          Agent: next?.lead_agent ?? "",
        });
      }
      if (workflowCompleted && completedFinalStage) {
        const scope = getField(content, "Scope") ?? "";
        emitAudit(pd, "PHASE_COMPLETED", {
          "From phase": completedFinalStage.phase,
          "To phase": "(end)",
          "Stages completed": String(countCheckboxes(content, "completed")),
        });
        emitAudit(pd, "PHASE_VERIFIED", {
          "Phase boundary": `${completedFinalStage.phase} → end`,
        });
        emitAudit(pd, "WORKFLOW_COMPLETED", {
          Scope: scope,
          Details:
            `Scope: ${scope}, ${countCheckboxes(content, "completed")} stages completed`,
          ...workflowRollupFields(pd),
        });
      }
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
    writeStateFile(pd, content);
    if (workflowCompleted) {
      const completedIntentDir = activeIntent(pd);
      if (completedIntentDir) {
        updateIntentStatus(pd, completedIntentDir, "complete");
      }
    }
    afterWrite?.();
    if (!quiet) {
      console.log(JSON.stringify({
        refreshed: true,
        completed: completedNow,
        started,
        workflow_completed: workflowCompleted,
      }));
    }
  });
}

function handleFoldUnitMerge(args: string[]): void {
  const unit = getFlagValue(args, "--unit");
  const pinnedOid = getFlagValue(args, "--pinned-oid");
  const generationRaw = getFlagValue(args, "--generation");
  if (!unit || !pinnedOid || !generationRaw) {
    error(
      "Usage: aidlc-state.ts fold-unit-merge --unit <unit> --pinned-oid <oid> --generation <n>",
    );
  }
  const generation = Number(generationRaw);
  if (!Number.isInteger(generation) || generation < 1) {
    error("--generation must be a positive integer.");
  }
  const pd = resolveProjectDir(projectDir);
  const existing = readUnitMergeTransaction(pd, unit);
  if (
    !existing ||
    existing.pinned_oid !== pinnedOid ||
    existing.generation !== generation ||
    !existing.git_commit_oid ||
    !["git-landed", "state-folded", "complete"].includes(existing.status)
  ) {
    error(`No git-landed Unit merge transaction matches "${unit}" at ${pinnedOid}.`);
  }
  const transaction = existing;
  const mergeCommitOid = transaction.git_commit_oid!;
  const space = activeSpace(pd);
  const intentUuid = activeIntentUuid(pd, space);
  if (
    !intentUuid ||
    transaction.space !== space ||
    transaction.intent_uuid !== intentUuid
  ) {
    error(`Unit "${unit}" merge transaction belongs to another active space or intent.`);
  }
  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", mergeCommitOid, "HEAD"],
    { cwd: pd, encoding: "utf-8" },
  );
  if (ancestor.status !== 0) {
    error(
      `Unit "${unit}" merge commit ${mergeCommitOid} is not present on main.`,
    );
  }
  const parents = spawnSync(
    "git",
    ["show", "-s", "--format=%P", mergeCommitOid],
    { cwd: pd, encoding: "utf-8" },
  );
  if (
    parents.status !== 0 ||
    parents.stdout.trim().split(/\s+/)[1] !== pinnedOid
  ) {
    error(`Unit "${unit}" has no controlled merge commit for pinned OID ${pinnedOid}.`);
  }
  const mainShard = auditShardName(pd);
  const mainRows = readAuditShardEvents(pd)
    .filter((row) => basename(row.shard) === mainShard)
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });
  const gate = mainRows
    .filter(
      (row) =>
        (row.event === "GATE_APPROVED" || row.event === "GATE_REJECTED") &&
        auditBlockField(row.block, "Stage") === "unit-merge" &&
        auditBlockField(row.block, "Unit") === unit &&
        auditBlockField(row.block, "Pinned OID") === pinnedOid &&
        auditBlockField(row.block, "Attempt Generation") ===
          String(generation) &&
        auditBlockField(row.block, "Gate Scope") === "unit-merge",
    )
    .at(-1);
  if (gate?.event !== "GATE_APPROVED") {
    error(`Unit "${unit}" has no current approved merge-gate receipt.`);
  }
  const gateStrategy = auditBlockField(gate.block, "Strategy");
  const gateTarget = auditBlockField(gate.block, "Target branch");
  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd: pd,
    encoding: "utf-8",
  });
  if (
    gateStrategy !== "merge" ||
    !gateTarget ||
    branch.status !== 0 ||
    branch.stdout.trim() !== gateTarget ||
    transaction.target_branch !== gateTarget
  ) {
    error(`Unit "${unit}" merge-gate strategy or target does not match main.`);
  }
  const authorization = transaction.state_fold_authorized;
  if (!authorization) {
    error(
      `Unit "${unit}" state fold has no land-bound claim authorization.`,
    );
  }
  if (authorization.owner !== transaction.owner) {
    error(
      `Unit "${unit}" merge journal owner does not match the pinned claim owner.`,
    );
  }
  const liveAuthorized =
    authorization.mode === "live-claim" &&
    authorization.observed_oid === pinnedOid &&
    eventMatchesClaimAttempt(
      pd,
      `**Unit**: ${unit}\n**Attempt Generation**: ${generation}\n`,
      unit,
    );
  const releasedAuthorized =
    authorization.mode === "released-after-git" &&
    transaction.released_after_git !== undefined &&
    authorization.observed_oid ===
      transaction.released_after_git.tombstone_oid &&
    transaction.released_after_git.tombstone_generation === generation + 1 &&
    mainRows.some(
      (row) =>
        row.event === "RECOVERY_COMPLETED" &&
        auditBlockField(row.block, "Recovery") ===
          "unit-merge-released-attempt" &&
        auditBlockField(row.block, "Unit") === unit &&
        auditBlockField(row.block, "Pinned OID") === pinnedOid &&
        auditBlockField(row.block, "Attempt Generation") ===
          String(generation) &&
        auditBlockField(row.block, "Tombstone OID") ===
          transaction.released_after_git?.tombstone_oid &&
        auditBlockField(row.block, "Tombstone Generation") ===
          String(
            transaction.released_after_git?.tombstone_generation,
          ) &&
        auditBlockField(row.block, "User Input") ===
          transaction.released_after_git?.user_input,
    );
  if (!liveAuthorized && !releasedAuthorized) {
    error(`Unit "${unit}" merge attempt generation is no longer current.`);
  }

  const liveState = readStateFile(pd);
  if (!isTeamUnitOwnership(liveState)) {
    error("Unit merge folding requires Unit Ownership: team.");
  }
  const model = deriveTeamUnitProgressModel(
    pd,
    liveState,
    undefined,
    new Set([unit]),
    {
      ownerOverrides: new Map([[unit, authorization.owner]]),
    },
  );
  const payload = Buffer.from(
    JSON.stringify({
      section: model.section,
      stage_states: model.stageStates,
    }),
    "utf-8",
  ).toString("base64url");
  handleRefreshUnitProgress(
    ["--payload", payload],
    true,
    unit,
    authorization.owner,
    () => {
      const alreadyMerged = readAuditShardEvents(pd).some(
        (row) =>
          row.event === "UNIT_MERGED" &&
          auditBlockField(row.block, "Unit") === unit &&
          auditBlockField(row.block, "Pinned OID") === pinnedOid &&
          auditBlockField(row.block, "Attempt Generation") ===
            String(generation),
      );
      if (!alreadyMerged) {
        appendAuditEntryUnlocked(
          "UNIT_MERGED",
          {
            Unit: unit,
            Owner: authorization.owner,
            "Pinned OID": pinnedOid,
            "Merge commit OID": mergeCommitOid,
            "Attempt Generation": String(generation),
          },
          pd,
        );
      }
    },
  );
  console.log(JSON.stringify({
    folded: true,
    unit,
    pinned_oid: pinnedOid,
    generation,
  }));
}

function handleSyncUnitScopeStage(args: string[]): void {
  const slug = args[0];
  const unit = getFlagValue(args.slice(1), "--unit");
  if (!slug || !unit) {
    error("Usage: aidlc-state.ts sync-unit-scope-stage <stage> --unit <unit>");
  }
  const pd = resolveProjectDir(projectDir);
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    const stamp = validateLiveUnitScope(pd, unit);
    if (!stamp) error("Scoped Unit stage sync requires a live Unit claim.");
    const stage = findStageBySlug(slug);
    if (
      stage?.phase !== "construction" ||
      stage.for_each !== "unit-of-work"
    ) {
      error(`Stage "${slug}" is not a per-unit Construction stage.`);
    }
    content = setField(content, "Current Stage", slug);
    content = setField(content, "Lifecycle Phase", "CONSTRUCTION");
    content = setField(content, "In Progress", slug);
    content = setField(content, "Active Agent", stage.lead_agent);
    if (getSlugState(content, slug) !== "completed") {
      content = setCheckbox(content, slug, "in-progress");
    }
    content = setField(content, "Last Updated", isoTimestamp());
    writeStateFile(pd, content);
    console.log(JSON.stringify({
      synced: true,
      stage: slug,
      unit,
      generation: stamp.generation,
    }));
  });
}

// park - persist a `Parked` runtime field so the next `aidlc-orchestrate next`
// emits a terminal `parked` directive and the Stop hook lets the turn end
// (issue #367: a clean multi-session exit, so the agent never rubber-stamps
// stages to reach `done`). `Parked` and `Parked At Stage` are runtime-only
// fields (like Skeleton Stance) inserted under `## Runtime State`. Refuses a
// completed workflow (nothing to park). Emits WORKFLOW_PARKED - a recorded
// state event, audit-first under the lock.
//
// AUTONOMY GUARD (issue #365, salvaged from the suspend branch): an unattended
// autonomous Construction run must never park, so the tool refuses `park`
// outright under `Construction Autonomy Mode: autonomous`. This is
// defence-in-depth beside the Stop hook's identical guard: the hook protects
// the unattended turn-end path, this tool refusal protects a direct/scripted
// `aidlc-state.ts park` invocation in an autonomous run. (#365's suspend
// mechanism had no first-class tool verb a swarm could call, so it could guard
// hook-side only; park's `aidlc-state.ts park` is directly invocable, so the
// tool refusal closes a path #365 did not have.)
function handlePark(_args: string[]): void {
  const pd = resolveProjectDir(projectDir);
  const initialContent = readStateFile(pd);
  if (
    getField(initialContent, "Construction Autonomy Mode")?.trim() ===
      "autonomous"
  ) {
    error(
      "Refusing to park: Construction Autonomy Mode is autonomous. An unattended " +
        "autonomous run has no human to resume it and must keep moving - do not park it.",
    );
  }
  const scopeStamp = validateLiveUnitScope(pd);
  if (scopeStamp) {
    writeFileSync(
      unitParkedPath(pd),
      `${JSON.stringify({
        unit: scopeStamp.unit,
        generation: scopeStamp.generation,
        parked_at: isoTimestamp(),
      })}\n`,
      "utf-8",
    );
    process.stderr.write(
      `[aidlc] warning: parked Unit "${scopeStamp.unit}" locally from its checkout stamp; ` +
        "claim liveness was not required and will be rechecked at the next claim-sensitive boundary.\n",
    );
    console.log(JSON.stringify({
      parked: true,
      unit: scopeStamp.unit,
      checkout_local: true,
    }));
    return;
  }
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    const status = getField(content, "Status");
    if (status === "Completed") {
      error("Workflow is already Completed - nothing to park.");
    }
    const currentSlug = getField(content, "Current Stage") ?? "";
    if (currentSlug.length === 0) {
      error("State file has no Current Stage - cannot park.");
    }
    const timestamp = isoTimestamp();
    emitAudit(pd, "WORKFLOW_PARKED", {
      Stage: currentSlug,
    });
    content = setOrInsertField(content, "## Runtime State", "Parked", timestamp);
    content = setOrInsertField(content, "## Runtime State", "Parked At Stage", currentSlug);
    content = setField(content, "Last Updated", timestamp);
    writeStateFile(pd, content);
    console.log(JSON.stringify({ parked: true, stage: currentSlug, timestamp }));
  });
}

// unpark - clear the `Parked` / `Parked At Stage` fields on explicit re-entry
// (the resume flow calls this), so subsequent plain `next` calls no longer
// emit `parked`. Idempotent: clearing absent fields is a no-op.
function handleUnpark(_args: string[]): void {
  const pd = resolveProjectDir(projectDir);
  const scopeStamp = readApplicableTeamUnitScopeStamp(pd);
  if (scopeStamp) {
    const wasParked = existsSync(unitParkedPath(pd));
    try {
      unlinkSync(unitParkedPath(pd));
    } catch {
      // Idempotent.
    }
    console.log(JSON.stringify({
      unparked: true,
      was_parked: wasParked,
      checkout_local: true,
    }));
    return;
  }
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    const wasParked = (getField(content, "Parked") ?? "").trim().length > 0;
    // Remove both runtime markers (no-op if absent - unpark is idempotent).
    content = removeField(content, "Parked");
    content = removeField(content, "Parked At Stage");
    if (wasParked) {
      const ts = isoTimestamp();
      emitAudit(pd, "WORKFLOW_UNPARKED", {});
      content = setField(content, "Last Updated", ts);
    }
    writeStateFile(pd, content);
    console.log(JSON.stringify({ unparked: true, was_parked: wasParked }));
  });
}

// unit <start|pause|resume|complete> --stage <slug> --unit <name>
//        [--reason <text>] [--next-action <text>] [--wave]
//
// Unit-of-work lifecycle receipts for INLINE per-unit Construction stages
// (for_each: unit-of-work, mode: inline). The engine's coverage walk
// (aidlc-orchestrate.ts unitCovered) treats UNIT_COMPLETED as the completion
// signal and artifact existence as the evidence checked HERE, at emit time —
// so a paused or partially-written unit can never be mistaken for a finished
// one just because its files exist. UNIT_PAUSED requires --reason and
// --next-action so a resumed session (or another machine) lands on the exact
// checkpoint; the runtime `Active Unit` / `Unit State` fields mirror the
// latest receipt for cheap status reads. The autonomous swarm keeps its own
// SWARM_UNIT_* ledger (aidlc-swarm.ts) — this verb is the interactive twin.
//
// Single-active-unit invariant: `start` refuses while another unit of the
// same stage is non-terminal (started/resumed/paused without a later
// UNIT_COMPLETED), so resume/restart races cannot create two active units.
// `resume` refuses unless the named unit is the currently-paused one.
function handleUnit(args: string[]): void {
  const action = args[0];
  const VALID_UNIT_ACTIONS = new Set(["start", "pause", "resume", "complete"]);
  if (!action || !VALID_UNIT_ACTIONS.has(action)) {
    error(
      `Usage: aidlc-state.ts unit <start|pause|resume|complete> --stage <slug> --unit <name> [--reason <text>] [--next-action <text>] [--wave]`,
    );
  }
  const rest = args.slice(1);
  const slug = getFlagValue(rest, "--stage");
  const unit = getFlagValue(rest, "--unit");
  const rawReason = getFlagValue(rest, "--reason");
  const rawNextAction = getFlagValue(rest, "--next-action");
  const waveMode = rest.includes("--wave");
  const reason = rawReason?.trim();
  const nextAction = rawNextAction?.trim();
  if (!slug) error("Missing --stage <slug>");
  if (!unit) error("Missing --unit <name>");
  const unitNameError = validateUnitName(unit);
  if (unitNameError) error(unitNameError);
  validateStateLineValue("--reason", rawReason);
  validateStateLineValue("--next-action", rawNextAction);
  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  if (stage.for_each !== "unit-of-work") {
    error(`Stage "${slug}" is not per-unit (for_each: unit-of-work); unit receipts do not apply.`);
  }
  if (action === "pause") {
    if (!reason) error("unit pause requires --reason <text> (why the unit stopped).");
    if (!nextAction) error("unit pause requires --next-action <text> (the exact next step on resume).");
  }
  if (waveMode && action !== "complete") {
    error("unit --wave is supported only with the complete action.");
  }

  const pd = resolveProjectDir(projectDir);
  validateLiveUnitScope(pd, unit);
  // One lock across read→validate→emit→write (the C2b idiom): the checkpoint
  // read and the receipt append must see one ledger snapshot, or two racing
  // `unit start` calls could both pass the single-active-unit check.
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    const scope = getField(content, "Scope");
    if (usesStageLevelPerUnitArtifacts(scope, content)) {
      error(
        `Refusing unit ${action} for "${unit}": the effective workflow plan skips ` +
          "Units Generation, so this stage runs once at stage level.",
      );
    }

    // Only an engine-eligible autonomous swarm owns SWARM_UNIT_* bookkeeping.
    // The autonomy grant persists across backward jumps, where inline per-unit
    // stages still need this interactive lifecycle ledger.
    if (autonomousSwarmOwnsStage(stage, content)) {
      error(
        `Refusing unit ${action}: Construction Autonomy Mode is autonomous. The swarm referee ` +
          "owns per-unit bookkeeping (SWARM_UNIT_* receipts); interactive unit receipts apply " +
          "only when the engine routes the stage inline.",
      );
    }

    const resolution = resolveBoltDag(pd);
    if (resolution.state === "malformed") {
      error(
        `Refusing unit ${action}: the authoritative unit DAG is ${resolution.reason} ` +
          `(${resolution.detail}). Fix unit-of-work-dependency.md first.`,
      );
    }
    if (resolution.state !== "ok" || !resolution.units.includes(unit)) {
      error(
        `Refusing unit ${action} for "${unit}": it is not in the authoritative unit DAG.`,
      );
    }

    const checkpoint = activeUnitCheckpoint(pd, slug);

    if (waveMode) {
      if (checkpoint) {
        error(
          `Refusing wave completion for unit "${unit}" of "${slug}": serial unit ` +
            `"${checkpoint.unit}" is ${checkpoint.state}. Complete or resume that checkpoint first.`,
        );
      }
      requireEngineRoutedWaveUnit(pd, slug, unit);
    } else if (action === "start") {
      if (checkpoint && checkpoint.unit !== unit) {
        error(
          `Refusing to start unit "${unit}" for "${slug}": unit "${checkpoint.unit}" is ${checkpoint.state}` +
            `${checkpoint.reason ? ` (reason: ${checkpoint.reason})` : ""}. ` +
            `${checkpoint.state === "paused" ? `Resume it (aidlc-state.ts unit resume --stage ${slug} --unit ${checkpoint.unit}) or complete it first.` : "Complete it first."} ` +
            "One active unit at a time.",
        );
      }
      if (checkpoint && checkpoint.unit === unit) {
        // Idempotent re-entry on the same unit: a crashed conductor may re-run
        // start after resume; acknowledge without a duplicate receipt.
        console.log(JSON.stringify({ unit, stage: slug, state: checkpoint.state, already_active: true }));
        return;
      }
      requireEngineRoutedUnit(pd, slug, unit);
    } else if (action === "pause" || action === "complete") {
      if (!checkpoint || checkpoint.unit !== unit) {
        error(
          `Refusing to ${action} unit "${unit}" for "${slug}": it is not the active unit` +
            `${checkpoint ? ` (active: "${checkpoint.unit}", ${checkpoint.state})` : " (no unit is active — start it first)"}.`,
        );
      }
      if (action === "complete" && checkpoint.state === "paused") {
        error(
          `Refusing to complete unit "${unit}" for "${slug}": it is paused` +
            `${checkpoint.reason ? ` (reason: ${checkpoint.reason})` : ""}. Resume it first ` +
            `(aidlc-state.ts unit resume --stage ${slug} --unit ${unit}); a paused unit's work is not done.`,
        );
      }
    } else if (action === "resume") {
      if (!checkpoint || checkpoint.unit !== unit || checkpoint.state !== "paused") {
        error(
          `Refusing to resume unit "${unit}" for "${slug}": it is not the paused unit` +
            `${checkpoint ? ` (active: "${checkpoint.unit}", ${checkpoint.state})` : " (no unit is active)"}.`,
        );
      }
    }

    // UNIT_COMPLETED is receipt-plus-evidence: the receipt commits only when
    // every applicable required artifact for THIS unit exists on disk. This is
    // the claim-1 inversion — the artifact walk moved from "is the transition"
    // to "is checked by the transition".
    if (action === "complete" && !artifactGuardDisabled()) {
      const missing = missingUnitArtifacts(pd, stage, unit);
      if (missing.length > 0) {
        error(
          `Refusing to complete unit "${unit}" for "${slug}": required artifacts are missing on disk ` +
            `(${missing.join(", ")}). Write the unit's artifacts before completing it.`,
        );
      }
    }

    const memoryEntries =
      action === "complete" && waveMode
        ? fanInWaveUnitMemory(pd, slug, unit)
        : 0;
    const waveFingerprint =
      action === "complete" && waveMode
        ? reviewArtifactFingerprint(pd, stage, unit, {
            requireRequiredArtifacts: true,
          })
        : null;
    if (action === "complete" && waveMode && waveFingerprint === null) {
      error(
        `Refusing wave completion for unit "${unit}" of "${slug}": the final artifact fingerprint could not be computed.`,
      );
    }

    let eventType: string;
    if (action === "start") eventType = "UNIT_STARTED";
    else if (action === "pause") eventType = "UNIT_PAUSED";
    else if (action === "resume") eventType = "UNIT_RESUMED";
    else eventType = "UNIT_COMPLETED";
    const fields: Record<string, string> = {
      Stage: slug,
      Unit: unit,
      "Run floor": latestMainWorkflowStageRunFloorForProject(
        pd,
        slug,
        getField(content, "Construction Iteration")?.trim() === "unit-major",
        isTeamUnitOwnership(content) ? unit : undefined,
      ),
      ...claimAttemptFields(pd, unit),
      ...(waveMode
        ? {
            Mode: "wave",
            "Wave memory entries": String(memoryEntries),
            "Artifact Fingerprint": waveFingerprint ?? "",
          }
        : {}),
    };
    if (reason) fields.Reason = reason;
    if (nextAction) fields["Next Action"] = nextAction;

    try {
      emitAudit(pd, eventType, fields);
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }

    // Mirror the latest checkpoint into runtime state for cheap status reads
    // (audit stays the source of truth — these fields are a cache, exactly like
    // Parked / Parked At Stage).
    const timestamp = isoTimestamp();
    if (action === "complete") {
      content = removeField(content, "Active Unit");
      content = removeField(content, "Unit State");
      content = removeField(content, "Unit Pause Reason");
      content = removeField(content, "Unit Next Action");
    } else {
      content = setOrInsertField(content, "## Runtime State", "Active Unit", unit);
      content = setOrInsertField(
        content,
        "## Runtime State",
        "Unit State",
        action === "pause" ? "paused" : "in-progress",
      );
      if (action === "pause") {
        content = setOrInsertField(content, "## Runtime State", "Unit Pause Reason", reason ?? "");
        content = setOrInsertField(content, "## Runtime State", "Unit Next Action", nextAction ?? "");
      } else {
        content = removeField(content, "Unit Pause Reason");
        content = removeField(content, "Unit Next Action");
      }
    }
    content = setField(content, "Last Updated", timestamp);
    writeStateFile(pd, content);
    console.log(JSON.stringify({
      emitted: eventType,
      stage: slug,
      unit,
      timestamp,
      ...(waveMode ? { wave: true, memory_entries: memoryEntries } : {}),
    }));
  });
}

function validateStateLineValue(label: string, value: string | undefined): void {
  if (value !== undefined && hasUnsafeSingleLineCharacter(value)) {
    error(`${label} must be printable text on one physical line.`);
  }
}

function requireEngineRoutedUnit(pd: string, stage: string, unit: string): void {
  const executable = compiledExecutable();
  let subargs = ["next", "--project-dir", pd];
  let directive: unknown = null;
  for (let attempts = 0; attempts < 1_000; attempts++) {
    const command = executable
      ? [executable, ...subargs]
      : [
          process.execPath,
          fileURLToPath(new URL("./aidlc-orchestrate.ts", import.meta.url)),
          ...subargs,
        ];
    const result = spawnSync(command[0], command.slice(1), {
      cwd: pd,
      encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_PROJECT_DIR: pd,
          AIDLC_ROUTE_CHECK: "1",
          ...(stateSessionOverride
            ? { AIDLC_SESSION_OVERRIDE: stateSessionOverride }
            : {}),
      },
      timeout: 30_000,
    });
    if (result.status !== 0) {
      error(
        `Refusing to start unit "${unit}" for "${stage}": the orchestration engine could not resolve ` +
          `the current routed unit (${(result.stderr ?? "").trim() || "no diagnostic"}).`,
      );
    }
    try {
      directive = JSON.parse((result.stdout ?? "").trim());
    } catch {
      error(
        `Refusing to start unit "${unit}" for "${stage}": the orchestration engine returned an ` +
          "unparseable directive.",
      );
    }
    const transport =
      directive !== null && typeof directive === "object"
        ? directive as { kind?: unknown; continue_token?: unknown }
        : {};
    if (transport.kind !== "load-steering") break;
    if (
      typeof transport.continue_token !== "string" ||
      transport.continue_token.length === 0
    ) {
      error(
        `Refusing to start unit "${unit}" for "${stage}": the engine's steering directive ` +
          "did not include a continuation token.",
      );
    }
    subargs = ["continue", transport.continue_token, "--project-dir", pd];
  }
  const routed =
    directive !== null && typeof directive === "object"
      ? directive as { kind?: unknown; stage?: unknown; unit?: unknown }
      : {};
  if (
    routed.kind !== "run-stage" ||
    routed.stage !== stage ||
    routed.unit !== unit
  ) {
    const expected =
      routed.kind === "run-stage" &&
      typeof routed.stage === "string" &&
      typeof routed.unit === "string"
        ? `"${routed.stage}"/"${routed.unit}"`
        : `a ${String(routed.kind ?? "non-run-stage")} directive`;
    error(
      `Refusing to start unit "${unit}" for "${stage}": the engine currently routes ${expected}. ` +
        "Run the exact directive.stage/directive.unit pair returned by aidlc-orchestrate.ts next.",
    );
  }
}

function requireEngineRoutedWaveUnit(
  pd: string,
  stage: string,
  unit: string,
): void {
  const executable = compiledExecutable();
  let subargs = ["next", "--project-dir", pd];
  let directive: unknown = null;
  for (let attempts = 0; attempts < 1_000; attempts++) {
    const command = executable
      ? [executable, ...subargs]
      : [
          process.execPath,
          fileURLToPath(new URL("./aidlc-orchestrate.ts", import.meta.url)),
          ...subargs,
        ];
    const result = spawnSync(command[0], command.slice(1), {
      cwd: pd,
      encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_PROJECT_DIR: pd,
          AIDLC_ROUTE_CHECK: "1",
          ...(stateSessionOverride
            ? { AIDLC_SESSION_OVERRIDE: stateSessionOverride }
            : {}),
      },
      timeout: 30_000,
    });
    if (result.status !== 0) {
      error(
        `Refusing wave completion for unit "${unit}" of "${stage}": the orchestration ` +
          `engine could not resolve the current wave (${(result.stderr ?? "").trim() || "no diagnostic"}).`,
      );
    }
    try {
      directive = JSON.parse((result.stdout ?? "").trim());
    } catch {
      error(
        `Refusing wave completion for unit "${unit}" of "${stage}": the orchestration ` +
          "engine returned an unparseable directive.",
      );
    }
    const transport =
      directive !== null && typeof directive === "object"
        ? directive as { kind?: unknown; continue_token?: unknown }
        : {};
    if (transport.kind !== "load-steering") break;
    if (
      typeof transport.continue_token !== "string" ||
      transport.continue_token.length === 0
    ) {
      error(
        `Refusing wave completion for unit "${unit}" of "${stage}": the engine's ` +
          "steering directive did not include a continuation token.",
      );
    }
    subargs = ["continue", transport.continue_token, "--project-dir", pd];
  }

  const routed =
    directive !== null && typeof directive === "object"
      ? directive as {
          kind?: unknown;
          stage?: unknown;
          wave?: {
            entries?: Array<{
              unit?: unknown;
              build_required?: unknown;
              completion_required?: unknown;
              review_state?: unknown;
            }>;
          };
        }
      : {};
  const entry = routed.wave?.entries?.find((candidate) => candidate.unit === unit);
  const reviewSettled =
    entry?.review_state === "READY" ||
    entry?.review_state === "NOT-READY" ||
    entry?.review_state === "not-required";
  if (
    routed.kind !== "run-stage" ||
    routed.stage !== stage ||
    !entry ||
    entry.build_required !== false ||
    entry.completion_required !== true ||
    !reviewSettled
  ) {
    error(
      `Refusing wave completion for unit "${unit}" of "${stage}": the engine does ` +
        "not currently expose that entry as build-complete, review-settled, and awaiting its completion receipt.",
    );
  }
}

function fanInWaveUnitMemory(pd: string, stage: string, unit: string): number {
  const headings = [
    "Interpretations",
    "Deviations",
    "Tradeoffs",
    "Open questions",
  ] as const;
  const rec = recordDir(pd);
  if (rec === null) {
    error(
      `Refusing wave completion for unit "${unit}" of "${stage}": no active intent record directory exists.`,
    );
  }
  const unitPath = join(rec, "construction", unit, stage, "memory.md");
  const parentPath = join(rec, "construction", stage, "memory.md");
  const unitContent = existsSync(unitPath) ? readFileSync(unitPath, "utf-8") : "";
  const entries = parseMemoryEntries(unitContent);

  let parentContent = existsSync(parentPath)
    ? readFileSync(parentPath, "utf-8")
    : `${headings.map((heading) => `## ${heading}\n`).join("\n")}\n`;
  for (const heading of headings) {
    if (!new RegExp(`^## ${heading}$`, "m").test(parentContent)) {
      parentContent = `${parentContent.trimEnd()}\n\n## ${heading}\n`;
    }
  }

  let added = 0;
  for (const entry of entries) {
    const digest = createHash("sha256")
      .update(`${stage}\0${unit}\0${entry.heading}\0${entry.raw}`, "utf-8")
      .digest("hex");
    const marker = `<!-- aidlc-wave-memory:${unit}:${digest} -->`;
    if (parentContent.includes(marker)) continue;
    parentContent = appendUnderHeading(
      parentContent,
      `## ${entry.heading}`,
      `\n${entry.raw}\n${marker}\n`,
    );
    added++;
  }

  mkdirSync(dirname(parentPath), { recursive: true });
  if (!existsSync(parentPath) || added > 0) {
    writeFileAtomic(parentPath, parentContent.endsWith("\n") ? parentContent : `${parentContent}\n`);
  }
  return added;
}

// The unit's missing REQUIRED artifacts (kind-filtered like the engine's
// unitCovered): resolved under <record>/construction/<unit>/<slug>/<name>.md.
// Returns [] when everything applicable exists. Kind filtering reads the
// bolt_dag the same way the engine does; with no readable dag the FULL
// required list applies (fail strict, like unitCovered's kinds=null path).
function missingUnitArtifacts(
  pd: string,
  stage: { slug: string; produces?: string[]; produces_kinds?: Record<string, string[]> },
  unit: string,
): string[] {
  const rec = recordDir(pd);
  if (rec === null) return stage.produces ?? ["<no record dir>"];
  let required = stage.produces ?? [];
  if (stage.produces_kinds !== undefined) {
    const resolution = resolveBoltDag(pd);
    if (resolution.state === "ok" && resolution.unitKinds !== null) {
      required = filterProducesByKind(
        stage.produces_kinds,
        required,
        resolution.unitKinds.get(unit) ?? null,
      );
    }
  }
  const missing: string[] = [];
  for (const name of required) {
    const p = join(rec, "construction", unit, stage.slug, artifactFilename(name));
    if (!isRegularFile(p)) missing.push(name);
  }
  return missing;
}

function handleCheckbox(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts checkbox <slug=state> ...");
  const pd = resolveProjectDir(projectDir);

  // Parse + validate args BEFORE taking the lock — pure input checks that
  // touch no shared state, so they fail fast without holding the lock.
  const changes: Array<{ slug: string; state: CheckboxState }> = [];
  for (const pair of args) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) error(`Invalid slug=state pair: ${pair}`);
    const slug = pair.slice(0, eqIdx);
    const stateStr = pair.slice(eqIdx + 1);
    if (!isCheckboxState(stateStr)) {
      error(`Invalid state: ${stateStr}. Valid: ${VALID_CHECKBOX_STATES.join(", ")}`);
    }
    changes.push({ slug, state: stateStr });
  }

  // C2b lost-update safety: read→apply→count→write under one lock so the
  // Completed counter resync sees a consistent snapshot (a concurrent checkbox
  // flip between our read and write would otherwise desync the count).
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  for (const { slug, state } of changes) {
    content = setCheckbox(content, slug, state);
  }

  // Sync Completed counter to actual [x] count
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  writeStateFile(pd, content);
  console.log(JSON.stringify({ updated: true, checkboxes: changes.length, completed_count: completedCount }));
  });
}

function handleCount(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts count <state>");
  const stateStr = args[0];
  if (!isCheckboxState(stateStr)) {
    error(`Invalid state: ${stateStr}. Valid: ${VALID_CHECKBOX_STATES.join(", ")}`);
  }
  const pd = resolveProjectDir(projectDir);
  const content = readStateFile(pd);
  console.log(countCheckboxes(content, stateStr));
}

// --- Stage-completion artifact guard (issue #366) ---------------------------
//
// The state machine's transitions were purely ceremonial: approve/advance
// marked a stage [x] without verifying ANY work landed on disk, so an agent
// could rubber-stamp all 33 stages (gate-start->approve, or pure advance) with
// zero artifacts. This guard makes a forward stage-completion CONTINGENT on
// evidence of work - the same principle the swarm referee already applies at
// the merge gate (aidlc-swarm.ts finalize is authoritative, so a red unit
// cannot merge even if the conductor lies).
//
// It lives in aidlc-state.ts because that is the ONE seam every transition
// passes through: the issue's repro calls `aidlc-state.ts approve/advance`
// directly, so a guard only in orchestrate's `report` dispatcher is bypassable.
//
// V2 PATH RE-AUTHOR (workspace refactor #429): the flat `aidlc-docs/<phase>/<slug>/`
// layout is gone - a stage's produces[] artifacts now live under the ACTIVE
// intent's per-intent record dir (`aidlc/spaces/<space>/intents/<slug>-<id8>/
// <phase>/<stage>/`), per-unit Construction artifacts under that record's
// `construction/<unit>/<stage>/`, and codekb stages (reverse-engineering) under
// the space-level `aidlc/spaces/<space>/codekb/<repo>/`. This guard resolves
// against those live seams (recordDir / codekbDir), mirroring
// resolveArtifactPath in aidlc-orchestrate.ts so the two cannot drift on shape.
//
// Two layers:
//   1. produces-existence - a stage that declares produces[] must have at least
//      one of them on disk. Empty-produces stages (init phase) are exempt.
//   2. workspace_requires - a code-producing stage (frontmatter flag) must also
//      have a real file OUTSIDE the aidlc/ workspace tree and the harness dir.
//      Catches the code-generation case where only the two markdown produces[]
//      docs were written but no actual source code (issue #366 Update 2).
//
// Bypass: AIDLC_SKIP_ARTIFACT_GUARD=1 (env, set by the test runner for synthetic
// tiers that drive transitions against bare fixtures).
// (KNOWN_CODEKB_STAGES is declared at module top alongside HARNESS_DOC_DIRS to
// dodge the TDZ - the dispatch that calls this guard runs at module load.)

function artifactGuardDisabled(): boolean {
  return process.env.AIDLC_SKIP_ARTIFACT_GUARD === "1";
}

// Mirrors both aidlc-orchestrate.ts isAutonomousSwarmCandidate and the
// unit-major suppression at eligibleAutonomousSwarmBatches. Under unit-major
// the WALK owns per-unit work inline and needs the interactive lifecycle
// ledger, so its `unit start` must not be refused as swarm-owned. A missing
// scope fails closed for a subagent stage: without it, this tool cannot prove
// that the stage is the non-swarm skeleton gate.
function autonomousSwarmOwnsStage(
  stage: { slug: string; phase: string; for_each?: string; mode?: string },
  stateContent: string,
): boolean {
  if (stage.phase !== "construction") return false;
  if (stage.for_each !== "unit-of-work" || stage.mode !== "subagent") return false;
  if (!isAutonomousMode(stateContent)) return false;
  if (getField(stateContent, "Construction Iteration")?.trim() === "unit-major") {
    return false;
  }
  const scope = getField(stateContent, "Scope");
  if (!scope) return true;
  if (usesStageLevelPerUnitArtifacts(scope, stateContent)) return false;
  const first = firstInScopeStageOfPhase("construction", scope);
  return first === null || first.slug !== stage.slug;
}

// Settled-autonomous-swarm exemption, mirroring isSettledAutonomousSwarm in
// aidlc-orchestrate.ts (the report path's disk-backed-guard exemption). Finalize
// copies reviewed per-unit record artifacts into main, but the current-attempt
// convergence plus source-merge ledger remains the authoritative complete-set
// signal and avoids reconstructing a cross-Unit verdict from file presence. The
// exemption is granted only when EVERY unit of a valid DAG has a convergence
// row from the CURRENT stage attempt (rows before the latest main-workflow
// STAGE_STARTED for this slug are a prior run's). Anything ambiguous - not the
// swarm build stage, autonomy not granted, DAG absent/malformed, any
// unconverged unit - fails closed and leaves the guard exactly as strict as
// before. Duplicated rather than imported: state.ts is the dependency floor
// (orchestrate imports nothing from it and it must not import orchestrate).
function isSettledSwarmForArtifactGuard(
  pd: string,
  stage: { slug: string; phase: string; for_each?: string; mode?: string },
  stateContent: string,
  action: ReviewerPreconditionAction = "complete",
): boolean {
  if (getField(stateContent, "Construction Iteration")?.trim() === "unit-major") {
    return false;
  }
  if (!isAutonomousSwarmStage(pd, stateContent, stage)) return false;
  const units = currentAttemptSwarmUnits(pd, stage.slug, action);
  if (units === null || units.length === 0) return false;
  // Shared attempt-scoped read (aidlc-lib.ts): a row counts only when its
  // Stage names this slug AND its Run floor equals the current attempt's
  // floor, so stale-attempt and cross-stage rows never satisfy the guard.
  const converged = swarmConvergedUnits(pd, stage.slug);
  return units.every((unit) => converged.has(unit));
}

function settledSwarmForArtifactGuardOrError(
  pd: string,
  stage: { slug: string; phase: string; for_each?: string; mode?: string },
  stateContent: string,
  action: ReviewerPreconditionAction,
): boolean {
  try {
    return isSettledSwarmForArtifactGuard(pd, stage, stateContent, action);
  } catch (e) {
    error(
      `${reviewerPreconditionPrefix(stage.slug, action)}: the settled-swarm probe failed unexpectedly ` +
        `(${errorMessage(e)}). Restore readable state, audit, and Unit DAG evidence before retrying.`,
    );
  }
}

function currentAttemptSwarmUnits(
  pd: string,
  stageSlug: string,
  action: ReviewerPreconditionAction,
): string[] | null {
  const obligations = currentSwarmAttemptObligations(pd, stageSlug);
  if (obligations.state === "invalid") {
    error(
      `${reviewerPreconditionPrefix(stageSlug, action)}: current swarm Unit obligations are invalid ` +
        `(${obligations.reason}). Restore unit-of-work-dependency.md or restart the stage attempt.`,
    );
  }
  const resolution = resolveBoltDag(pd);
  if (obligations.state === "none") {
    return resolution.state === "ok" ? resolution.units : null;
  }
  if (resolution.state !== "ok") {
    error(
      `${reviewerPreconditionPrefix(stageSlug, action)}: the current Unit DAG cannot be compared with ` +
        `the attempt-bound Unit obligations. Restore unit-of-work-dependency.md or restart the stage attempt.`,
    );
  }
  const live = new Set(resolution.units);
  const missing = [...obligations.units].filter((unit) => !live.has(unit)).sort();
  const added = resolution.units
    .filter((unit) => !obligations.units.has(unit))
    .sort();
  if (missing.length > 0 || added.length > 0) {
    const detail = [
      missing.length > 0 ? `missing attempt Units: ${missing.join(", ")}` : "",
      added.length > 0 ? `added Units: ${added.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    error(
      `${reviewerPreconditionPrefix(stageSlug, action)}: the Unit DAG changed during the current swarm attempt ` +
        `(${detail}). Restore unit-of-work-dependency.md to the attempt-bound Unit set or restart the stage attempt.`,
    );
  }
  return [...obligations.units];
}

function verifySettledSwarmSourceBinding(
  pd: string,
  stage: { slug: string; workspace_requires?: boolean },
  action: ReviewerPreconditionAction,
): void {
  if (
    stage.workspace_requires !== true ||
    process.env.AIDLC_SKIP_SOURCE_FRESHNESS === "1"
  ) {
    return;
  }
  const units = currentAttemptSwarmUnits(pd, stage.slug, action);
  if (units === null) {
    error(
      `${reviewerPreconditionPrefix(stage.slug, action)}: its settled swarm Unit obligations cannot be resolved for the current attempt.`,
    );
  }
  const chain = currentSwarmSourceMergeChain(pd, stage.slug);
  if (chain.state === "none") {
    error(
      `Refusing to complete "${stage.slug}": every Bolt converged, but no current-attempt post-merge main-checkout source binding exists. Merge each reviewed source commit before approval.`,
    );
  }
  if (chain.state === "invalid") {
    error(
      `Refusing to complete "${stage.slug}": its post-merge main-checkout source binding chain is invalid (${chain.reason}). Re-run the affected source merge or restart the Bolt attempt.`,
    );
  }
  const missing = units.filter((unit) => !chain.units.has(unit));
  if (missing.length > 0) {
    error(
      `Refusing to complete "${stage.slug}": ${missing.length} converged unit(s) have no current-attempt post-merge source binding (${missing.join(", ")}). Merge every reviewed source commit before approval.`,
    );
  }
  const current = workspaceSourceState(pd);
  if (current === null || current.fingerprint !== chain.fingerprint) {
    error(
      `Refusing to complete "${stage.slug}": the main checkout source no longer matches the final reviewed swarm merge (source-fingerprint mismatch). Revert the unreviewed edit or restart and re-review the affected Bolt.`,
    );
  }
}

function priorAcceptedSourceFields(
  pd: string,
  stage: { slug: string; workspace_requires?: boolean },
): Record<string, string> {
  if (stage.workspace_requires !== true) return {};
  const chain = currentSwarmSourceMergeChain(pd, stage.slug);
  return chain.state === "ready"
    ? { "Prior Accepted Source Fingerprint": chain.fingerprint }
    : {};
}

// Deterministic off-switch for the approve-time gate-revision backstop (mirrors
// artifactGuardDisabled above). The suite sets this globally so no existing
// approve/reject test changes behaviour; the dedicated backstop test clears it
// to exercise the real reconciliation.
function revisionBackstopDisabled(): boolean {
  return process.env.AIDLC_SKIP_REVISION_BACKSTOP === "1";
}

// Resolve the directories a stage's produces[] artifacts would live under,
// mirroring aidlc-orchestrate.ts's resolveArtifactPath against the v2 per-intent
// seams. Three placement classes:
//   - codekb (reverse-engineering): the produces live DIRECTLY under each
//     registered repo dir beneath the space-level codekb root (no <slug> subdir
//     - see the codekb arm of resolveArtifactPath).
//   - per-unit Construction (for_each: unit-of-work): the {unit} segment is
//     unknown at approve/advance time, so we glob every
//     <record>/construction/<unit>/<slug>/ instead of resolving one.
//   - everything else: <record>/<phase>/<slug>/.
// Returns [] when no active intent record resolves (recordDir null) - a stage
// that declares produces then vacuously fails the existence check, which is the
// correct refusal (there is no record to have written them to).
function producesDirsForStage(
  pd: string,
  stage: { slug: string; phase: string; for_each?: string }
): string[] {
  if (KNOWN_CODEKB_STAGES.has(stage.slug)) {
    const repos = intentRepos(pd);
    const resolved = repos.length > 0 ? repos : [codekbRepoName(pd)];
    return resolved.map((repo) => codekbDir(pd, repo));
  }
  const rec = recordDir(pd);
  if (rec === null) return [];
  const perUnit = stage.for_each === "unit-of-work";
  if (perUnit) {
    const stateContent = readStateFile(pd);
    const scope = getField(stateContent, "Scope");
    if (usesStageLevelPerUnitArtifacts(scope, stateContent)) {
      return [join(rec, "construction", stage.slug)];
    }
    const ctorRoot = join(rec, "construction");
    if (!existsSync(ctorRoot)) return [];
    const dirs: string[] = [];
    for (const unit of readdirSync(ctorRoot)) {
      const d = join(ctorRoot, unit, stage.slug);
      if (existsSync(d)) dirs.push(d);
    }
    return dirs;
  }
  return [join(rec, stage.phase, stage.slug)];
}

// True when at least one declared produces[] artifact exists on disk under the
// stage's resolved directory. A stage with empty produces[] vacuously passes.
//
// Unit-kind all-vacuous exemption: a per-unit stage carrying a produces_kinds
// map can legitimately owe ZERO artifacts across ALL units (e.g. a workflow of
// only packaging units on functional-design). No unit ever wrote a per-unit
// dir, so the ANY-exists glob below is empty and would refuse the approval the
// engine just presented. When a bolt_dag with unit kinds exists AND every unit
// in the dag filters to an empty required set, return true (the stage does not
// apply to any unit). Any unit owing any artifact leaves the ANY-exists check
// exactly as strict as today.
function producesArtifactsExist(
  pd: string,
  stage: { slug: string; phase: string; for_each?: string; produces?: string[]; produces_kinds?: Record<string, string[]> }
): boolean {
  const produces = stage.produces ?? [];
  if (produces.length === 0) return true; // nothing declared -> nothing to verify
  if (stage.for_each === "unit-of-work" && stage.produces_kinds !== undefined) {
    const stateContent = readStateFile(pd);
    const scope = getField(stateContent, "Scope");
    if (!usesStageLevelPerUnitArtifacts(scope, stateContent)) {
      const resolution = resolveBoltDag(pd);
      if (resolution.state === "ok" && resolution.unitKinds !== null) {
        const allVacuous = resolution.units.every(
          (u) =>
            filterProducesByKind(
              stage.produces_kinds,
              produces,
              resolution.unitKinds?.get(u) ?? null,
            ).length === 0,
        );
        if (allVacuous) return true;
      }
    }
  }
  const dirs = producesDirsForStage(pd, stage);
  if (KNOWN_CODEKB_STAGES.has(stage.slug)) {
    return dirs.length > 0 && dirs.every((dir) =>
      produces.every((name) =>
        isRegularFile(join(dir, artifactFilename(name)))
      )
    );
  }
  for (const dir of dirs) {
    for (const name of produces) {
      if (isRegularFile(join(dir, artifactFilename(name)))) return true;
    }
  }
  return false;
}

interface SensorFireVerdict {
  fire_id: string;
  sensor_id: string;
  stage: string;
  output_path: string;
  result: "passed" | "failed" | "budget-override";
  detail_path: string | null;
  note?: string;
}

interface BlockingSensorIssue {
  sensorId: string;
  outputPath: string;
  detailPath: string | null;
  reason: string;
}

interface GateSensorEvaluation {
  issues: BlockingSensorIssue[];
  fingerprints: Map<string, string>;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Resolve every existing declared deliverable, reusing the same stage directory
// placement as producesArtifactsExist. --artifacts may name resolved paths or
// filenames; it supplements the graph walk for optional/custom emitters but
// cannot introduce an undeclared deliverable or escape a canonical produce dir.
function existingDeclaredArtifactPaths(
  pd: string,
  stage: {
    slug: string;
    phase: string;
    for_each?: string;
    produces?: string[];
    optional_produces?: string[];
  },
  artifacts?: string,
): string[] {
  const names = [
    ...(stage.produces ?? []),
    ...(stage.optional_produces ?? []),
  ];
  const declaredFilenames = new Set(names.map(artifactFilename));
  const dirs = producesDirsForStage(pd, stage);
  const projectRoot = realpathSync(pd);
  const roots = dirs.flatMap((dir) => {
    if (!existsSync(dir)) return [];
    let canonical: string;
    try {
      canonical = realpathSync(dir);
      if (!statSync(canonical).isDirectory()) return [];
    } catch {
      return [];
    }
    if (!pathIsWithin(projectRoot, canonical)) {
      error(
        `Refusing gate sensor dispatch for "${stage.slug}": resolved produce directory ` +
          `"${dir}" escapes the project root after canonicalization.`,
      );
    }
    return [canonical];
  });
  const found = new Set<string>();
  const addIfDeclaredFile = (candidate: string): void => {
    if (!declaredFilenames.has(basename(candidate)) || !existsSync(candidate)) {
      return;
    }
    let canonical: string;
    try {
      canonical = realpathSync(candidate);
      if (!statSync(canonical).isFile()) return;
    } catch {
      return;
    }
    if (!roots.some((root) => pathIsWithin(root, canonical))) {
      error(
        `Refusing gate sensor artifact "${candidate}" for "${stage.slug}": ` +
          "the canonical path is outside the stage's resolved produce directories.",
      );
    }
    found.add(canonical);
  };

  for (const dir of dirs) {
    for (const filename of declaredFilenames) {
      addIfDeclaredFile(join(dir, filename));
    }
  }

  for (const token of (artifacts ?? "").split(",")) {
    const value = token.trim();
    if (!value) continue;
    const variants = declaredFilenames.has(basename(value))
      ? [value]
      : [value, artifactFilename(value)];
    for (const variant of variants) {
      if (
        isAbsolute(variant) ||
        variant.includes("/") ||
        variant.includes("\\")
      ) {
        addIfDeclaredFile(
          isAbsolute(variant) ? variant : resolvePath(pd, variant),
        );
      }
      for (const dir of dirs) addIfDeclaredFile(join(dir, variant));
    }
  }

  return [...found];
}

function parseSensorFireVerdict(stdout: string): SensorFireVerdict | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]) as Partial<SensorFireVerdict>;
      if (
        typeof value.fire_id === "string" &&
        typeof value.sensor_id === "string" &&
        typeof value.stage === "string" &&
        typeof value.output_path === "string" &&
        (value.result === "passed" ||
          value.result === "failed" ||
          value.result === "budget-override") &&
        (value.detail_path === null || typeof value.detail_path === "string") &&
        (value.note === undefined || typeof value.note === "string")
      ) {
        return value as SensorFireVerdict;
      }
    } catch {
      // Keep scanning in case a wrapper wrote a banner before the JSON verdict.
    }
  }
  return null;
}

function gateSensorDispatchTimeoutMs(): number | undefined {
  const raw = process.env.AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function diagnosticSnippet(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function gateSensorMatchesOutput(
  sensor: NonNullable<
    NonNullable<ReturnType<typeof findStageBySlug>>["sensors_applicable"]
  >[number],
  outputPath: string,
): boolean {
  return sensor.matches === undefined ||
    new Bun.Glob(sensor.matches).match(outputPath.replace(/\\/g, "/"));
}

function artifactFingerprint(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function fireGateSensors(
  pd: string,
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
  artifacts?: string,
): GateSensorEvaluation {
  const paths = existingDeclaredArtifactPaths(pd, stage, artifacts);
  const issues: BlockingSensorIssue[] = [];
  const fingerprints = new Map<string, string>();
  if (paths.length === 0) return { issues, fingerprints };

  const sensors = (stage.sensors_applicable ?? []).filter((sensor) =>
    sensor.fire_on === "gate"
  );
  for (const sensor of sensors) {
    if (sensor.default_severity !== "blocking") continue;
    for (const outputPath of paths) {
      if (!gateSensorMatchesOutput(sensor, outputPath) || fingerprints.has(outputPath)) {
        continue;
      }
      const fingerprint = artifactFingerprint(outputPath);
      if (fingerprint === null) {
        issues.push({
          sensorId: sensor.id,
          outputPath,
          detailPath: null,
          reason: "artifact became unreadable before sensor dispatch",
        });
        continue;
      }
      fingerprints.set(outputPath, fingerprint);
    }
  }

  const executable = compiledExecutable();
  const sensorTool = fileURLToPath(new URL("./aidlc-sensor.ts", import.meta.url));
  for (const sensor of sensors) {
    for (const outputPath of paths) {
      if (!gateSensorMatchesOutput(sensor, outputPath)) continue;
      const expectedFingerprint = fingerprints.get(outputPath);
      if (
        sensor.default_severity === "blocking" &&
        (
          expectedFingerprint === undefined ||
          artifactFingerprint(outputPath) !== expectedFingerprint
        )
      ) {
        issues.push({
          sensorId: sensor.id,
          outputPath,
          detailPath: null,
          reason: "artifact changed before sensor dispatch",
        });
        continue;
      }
      const args = [
        "fire",
        sensor.id,
        "--stage",
        stage.slug,
        "--output-path",
        outputPath,
      ];
      const command = executable
        ? [executable, "sensor", ...args]
        : [process.execPath, sensorTool, ...args];
      const result = spawnSync(command[0], command.slice(1), {
        cwd: pd,
        encoding: "utf-8",
        timeout: gateSensorDispatchTimeoutMs(),
        env: {
          ...process.env,
          AIDLC_PROJECT_DIR: pd,
          CLAUDE_PROJECT_DIR: pd,
        },
      });
      if (sensor.default_severity !== "blocking") continue;
      if (artifactFingerprint(outputPath) !== expectedFingerprint) {
        issues.push({
          sensorId: sensor.id,
          outputPath,
          detailPath: null,
          reason: "artifact changed during sensor evaluation",
        });
        continue;
      }
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code ?? "unknown";
        issues.push({
          sensorId: sensor.id,
          outputPath,
          detailPath: null,
          reason:
            code === "ETIMEDOUT"
              ? "dispatcher timeout"
              : `dispatcher spawn failed (${code})`,
        });
        continue;
      }
      if (result.status !== 0) {
        const stderr = diagnosticSnippet(result.stderr);
        issues.push({
          sensorId: sensor.id,
          outputPath,
          detailPath: null,
          reason:
            result.status === null
              ? `dispatcher terminated by ${result.signal ?? "unknown signal"}`
              : `dispatcher exited ${result.status}${stderr ? `: ${stderr}` : ""}`,
        });
        continue;
      }
      const verdict = parseSensorFireVerdict(result.stdout ?? "");
      if (verdict === null) {
        issues.push({
          sensorId: sensor.id,
          outputPath,
          detailPath: null,
          reason: "dispatcher returned no valid verdict",
        });
        continue;
      }
      let verdictOutputPath: string | null = null;
      try {
        verdictOutputPath = realpathSync(
          isAbsolute(verdict.output_path)
            ? verdict.output_path
            : resolvePath(pd, verdict.output_path),
        );
      } catch {
        // The exact output file is already known to exist; an unresolvable
        // verdict path is invalid evaluation evidence.
      }
      if (
        verdict.sensor_id !== sensor.id ||
        verdict.stage !== stage.slug ||
        verdictOutputPath !== outputPath
      ) {
        issues.push({
          sensorId: sensor.id,
          outputPath,
          detailPath: null,
          reason: "dispatcher verdict identity did not match the requested fire",
        });
        continue;
      }
      if (verdict.result === "failed" && verdict.detail_path !== null) {
        issues.push({
          sensorId: sensor.id,
          outputPath: verdict.output_path,
          detailPath: verdict.detail_path,
          reason: "reported findings",
        });
        continue;
      }
      if (verdict.result === "passed" && verdict.note === undefined) continue;
      issues.push({
        sensorId: sensor.id,
        outputPath: verdict.output_path,
        detailPath: verdict.detail_path,
        reason:
          verdict.result === "passed"
            ? verdict.note ?? "invalid passed verdict"
            : verdict.result === "budget-override"
              ? "sensor execution exceeded its budget"
              : "failed verdict omitted its detail path",
      });
    }
  }
  return { issues, fingerprints };
}

function verifyGateSensorArtifactsUnchanged(
  slug: string,
  evaluation: GateSensorEvaluation,
): void {
  for (const [outputPath, fingerprint] of evaluation.fingerprints) {
    if (artifactFingerprint(outputPath) === fingerprint) continue;
    error(
      `Refusing to open the gate for "${slug}": blocking sensor artifact ` +
        `"${outputPath}" changed after evaluation. Retry so every blocking sensor ` +
        "checks the bytes that enter the gate.",
    );
  }
}

function auditEventIsAfter(
  later: ReturnType<typeof readAuditShardEvents>[number],
  earlier: ReturnType<typeof readAuditShardEvents>[number],
): boolean {
  if (later.shard === earlier.shard) return later.pos > earlier.pos;
  return later.timestamp > earlier.timestamp;
}

function hasBlockingSensorOverrideAuthorization(
  pd: string,
  slug: string,
): boolean {
  const rows = readAuditShardEvents(pd);
  const stageRows = rows.filter((row) => {
    const workflow = auditField(row.block, "Workflow");
    return auditField(row.block, "Stage") === slug &&
      !workflow?.startsWith("single-stage:");
  });
  const boundaries = stageRows.filter((row) =>
    row.event === "STAGE_STARTED" ||
    row.event === "STAGE_AWAITING_APPROVAL" ||
    row.event === "GATE_REJECTED"
  );
  const interactions = stageRows.filter((row) =>
    row.event === "DECISION_RECORDED" ||
    row.event === "QUESTION_ANSWERED"
  );
  const answers = interactions.filter((row) =>
    row.event === "QUESTION_ANSWERED" &&
    auditField(row.block, "Details") === BLOCKING_SENSOR_OVERRIDE_CHOICE
  );

  for (const answer of answers) {
    if (!boundaries.every((boundary) => auditEventIsAfter(answer, boundary))) {
      continue;
    }
    if (
      !interactions.every((row) =>
        row === answer || auditEventIsAfter(answer, row)
      )
    ) {
      continue;
    }
    const decision = interactions.findLast((row) => {
      if (
        row.event !== "DECISION_RECORDED" ||
        row.shard !== answer.shard ||
        row.pos >= answer.pos ||
        auditField(row.block, "Decision") !== BLOCKING_SENSOR_OVERRIDE_DECISION
      ) {
        return false;
      }
      const options = (auditField(row.block, "Options") ?? "")
        .split(",")
        .map((option) => option.trim());
      return BLOCKING_SENSOR_OVERRIDE_OPTIONS.every((option) =>
        options.includes(option)
      );
    });
    if (!decision) continue;
    const humanTurn = rows.some((row) =>
      row.event === "HUMAN_TURN" &&
      row.shard === answer.shard &&
      row.pos > decision.pos &&
      row.pos < answer.pos
    );
    if (humanTurn) return true;
  }
  return false;
}

function enforceBlockingGateSensors(
  pd: string,
  stateContent: string,
  slug: string,
  reportResult: "awaiting-approval" | "revised",
  issues: BlockingSensorIssue[],
  overrideRequested: boolean,
  overrideInput?: string,
): void {
  if (issues.length === 0) return;
  const sensorIds = [...new Set(issues.map((issue) => issue.sensorId))];
  const detailPaths = issues.flatMap((issue) =>
    issue.detailPath === null ? [] : [issue.detailPath]
  );
  const reasons = issues.map(
    (issue) => `${issue.sensorId}@${issue.outputPath}: ${issue.reason}`,
  );
  if (overrideRequested) {
    if (isAutonomousMode(stateContent)) {
      error(
        `Refusing blocking sensor override for "${slug}": Construction Autonomy Mode ` +
          "is autonomous. Unattended runs must halt on blocking sensor findings or " +
          "unavailable evaluations.",
      );
    }
    if (overrideInput?.trim() !== BLOCKING_SENSOR_OVERRIDE_CHOICE) {
      error(
        `Refusing blocking sensor override for "${slug}": --user-input must be the ` +
          `exact offered choice "${BLOCKING_SENSOR_OVERRIDE_CHOICE}".`,
      );
    }
    if (!hasBlockingSensorOverrideAuthorization(pd, slug)) {
      error(
        `Refusing blocking sensor override for "${slug}": no fresh authorization receipt ` +
          `proves that "${BLOCKING_SENSOR_OVERRIDE_CHOICE}" was offered and selected after ` +
          "a HUMAN_TURN. Record the decision and exact answer through aidlc-log.ts, then retry.",
      );
    }
    return;
  }
  error(
    `Blocking gate sensor evaluation did not pass for "${slug}". Sensors: ` +
      `${sensorIds.join(", ")}. Detail paths: ${detailPaths.join(", ") || "none"}. ` +
      `Reasons: ${reasons.join("; ")}. Fix the findings and retry, or first run ` +
      `bun ${harnessDir()}/tools/aidlc-log.ts decision --stage ${slug} ` +
      `--decision "${BLOCKING_SENSOR_OVERRIDE_DECISION}" --options ` +
      `"${BLOCKING_SENSOR_OVERRIDE_OPTIONS.join(",")}", present those choices, and ` +
      `after the human selects "${BLOCKING_SENSOR_OVERRIDE_CHOICE}" record it with ` +
      `aidlc-log.ts answer. Then retry: bun ${harnessDir()}/tools/aidlc-orchestrate.ts ` +
      `report --stage ${slug} --result ${reportResult} --override-blocking-sensors ` +
      `--user-input "${BLOCKING_SENSOR_OVERRIDE_CHOICE}". Autonomous mode cannot override.`,
  );
}

function addBlockingSensorOverrideFields(
  fields: Record<string, string>,
  issues: BlockingSensorIssue[],
  overrideRequested: boolean,
): void {
  if (issues.length === 0 || !overrideRequested) return;
  fields["Blocking Sensor Override"] = "true";
  fields["Blocking Sensor IDs"] = [
    ...new Set(issues.map((issue) => issue.sensorId)),
  ].join(",");
  const detailPaths = issues.flatMap((issue) =>
    issue.detailPath === null ? [] : [issue.detailPath]
  );
  if (detailPaths.length > 0) {
    fields["Blocking Sensor Detail Paths"] = detailPaths.join(",");
  }
  fields["Blocking Sensor Reasons"] = issues
    .map((issue) => `${issue.sensorId}: ${issue.reason}`)
    .join("; ");
}

function verifyGateOpeningGuards(
  pd: string,
  content: string,
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
): void {
  verifyStageArtifacts(pd, stage, "present-approval-gate");
  verifySummaryConfirmationPrecondition(pd, content, stage);
  verifyPipelineLinkPrecondition(pd, stage);
  if (!reviewerGateGuardDisabled()) {
    verifyReviewerPrecondition(pd, content, stage, "present-approval-gate");
  }
}

// True when any non-doc file exists in the workspace - a file outside the
// aidlc/ workspace tree and the harness dirs. Bounded shallow walk (one level
// into each top-level dir is enough to detect src/<file>); avoids a full
// recursive scan.
function workspaceHasSourceFile(pd: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(pd);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (HARNESS_DOC_DIRS.has(entry)) continue;
    const p = join(pd, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile()) return true; // a file at workspace root counts
    if (st.isDirectory()) {
      // Any file anywhere beneath a non-harness top-level dir (e.g. src/).
      try {
        if (dirHasFile(p)) return true;
      } catch {
        /* unreadable dir - skip */
      }
    }
  }
  return false;
}

// Recursive existence probe: does this directory contain any file? Short-
// circuits on the first file found.
function dirHasFile(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isFile()) return true;
    if (st.isDirectory() && dirHasFile(p)) return true;
  }
  return false;
}

// A git-reported path (status --porcelain or diff --name-only output) counts as
// "source work" when its FIRST segment is not a harness/doc dir - i.e. it is a
// real workspace file (src/..., a root file), not an aidlc/ planning doc or
// framework file. Mirrors HARNESS_DOC_DIRS, the same set the FS walk skips.
function isNonDocPath(p: string): boolean {
  const rel = p.trim().replace(/^"|"$/g, ""); // git -z not used; strip any quoting
  if (rel.length === 0) return false;
  const firstSeg = rel.split("/")[0];
  return !HARNESS_DOC_DIRS.has(firstSeg);
}

// Run git in the workspace, fail-safe: returns null on any spawn/exec problem so
// callers fall back to the filesystem check rather than trapping.
function git(pd: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", args, {
      cwd: pd,
      encoding: "utf-8",
      timeout: 30_000,
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout;
  } catch {
    return null;
  }
}

// True when `pd` is inside a git work tree. (`--is-inside-work-tree` prints
// "true"/"false"; a non-repo exits non-zero -> git() returns null -> false.)
function isGitRepo(pd: string): boolean {
  return git(pd, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

// Git-aware "did this workspace get real source work?" signal (issue #366
// Update 3). Distinguishes "code produced this session" from a brownfield repo's
// pre-existing src/ - which the bare filesystem check cannot. True when EITHER:
//   1. the working tree has an uncommitted/untracked non-doc change
//      (`git status --porcelain`), OR
//   2. the last commit touched a non-doc path (`git diff --name-only HEAD~1 HEAD`)
//      - so commit-then-approve (clean tree) still passes, closing Update 3's
//      clean-working-tree false-block.
// Returns null (NOT false) on any git error or a HEAD~1 miss (a single-commit or
// 0-commit repo has no parent to diff), so the caller falls back to the
// filesystem check rather than wrongly refusing a greenfield first commit. A
// resolved HEAD~1 whose last commit is doc-only returns false (a real
// "no recent code", e.g. a brownfield clean tree), so the guard still refuses.
function gitHasSourceWork(pd: string): boolean | null {
  const porcelain = git(pd, ["status", "--porcelain"]);
  if (porcelain === null) return null;
  // `XY <path>` per line; renames are `orig -> new` (take the new path).
  for (const line of porcelain.split("\n")) {
    if (line.trim().length === 0) continue;
    const pathPart = line.slice(3);
    const candidate = pathPart.includes(" -> ")
      ? pathPart.split(" -> ")[1]
      : pathPart;
    if (isNonDocPath(candidate)) return true;
  }
  // Clean (or doc-only) working tree - check whether the LAST commit added code,
  // covering the commit-then-approve pattern. HEAD~1 is absent on the very first
  // commit; that diff errors -> git() returns null.
  const lastCommit = git(pd, ["diff", "--name-only", "HEAD~1", "HEAD"]);
  if (lastCommit !== null) {
    for (const line of lastCommit.split("\n")) {
      if (isNonDocPath(line)) return true;
    }
    // HEAD~1 resolved and the last commit was doc-only: a definitive "no recent
    // code" (e.g. a brownfield repo whose src/ predates this session), so return
    // false to refuse - the FS fallback would wrongly pass on the pre-existing
    // src/.
    return false;
  }
  // HEAD~1 did NOT resolve (a single-commit repo has no parent): we could not
  // inspect the last commit at all, so this is the documented "0-commit / HEAD~1
  // miss" case - return null (NOT false) so the caller falls back to the
  // filesystem probe rather than false-refusing a greenfield first-commit whose
  // sole commit holds the source.
  return null;
}

// The workspace_requires signal: git-aware when the workspace is a git repo
// (precise - tells session-produced code from a brownfield baseline), else the
// filesystem-existence fallback (shell-free, reliable in non-git workspaces and
// the test fixtures). Fail-open: a git error falls back to the FS check.
function workspaceHasWork(pd: string): boolean {
  if (isGitRepo(pd)) {
    const gitVerdict = gitHasSourceWork(pd);
    if (gitVerdict !== null) return gitVerdict;
  }
  return workspaceHasSourceFile(pd);
}

// The guard itself. Called from approve/advance/finalize/complete-workflow
// BEFORE any state mutation, so a refusal (error() -> process.exit) leaves state
// untouched. `stage` is the StageEntry being completed. No-op when bypass active.
function verifyStageArtifacts(
  pd: string,
  stage: { slug: string; name: string; phase: string; for_each?: string; mode?: string; produces?: string[]; produces_kinds?: Record<string, string[]>; workspace_requires?: boolean },
  action: ReviewerPreconditionAction = "complete",
): void {
  if (artifactGuardDisabled()) return;

  // A settled autonomous swarm proved its work through the referee's per-unit
  // convergence and source-merge ledger. Reviewed records now land in main, but
  // file presence alone cannot replace that complete-set authority.
  let settledSwarm = false;
  let stateContent: string | null = null;
  try {
    stateContent = readStateFile(pd);
  } catch {
    // No readable state file: not a swarm settle; stay strict.
  }
  if (stateContent !== null) {
    settledSwarm = settledSwarmForArtifactGuardOrError(
      pd,
      stage,
      stateContent,
      action,
    );
  }
  if (settledSwarm) return;

  if (!producesArtifactsExist(pd, stage)) {
    error(
      `${reviewerPreconditionPrefix(stage.slug, action)}: none of its declared artifacts exist ` +
        `under the intent's record directory. The stage protocol requires ${stage.name} ` +
        `to produce output before the gate. Produce the artifacts before completing. ` +
        `(declared: ${(stage.produces ?? []).join(", ") || "none"})`
    );
  }

  if (stage.workspace_requires && !workspaceHasWork(pd)) {
    error(
      `${reviewerPreconditionPrefix(stage.slug, action)}: it is a code-producing stage ` +
        `(workspace_requires) but no source work is evident outside the aidlc/ ` +
        `workspace tree. In a git workspace this means no uncommitted change and no ` +
        `code in the last commit; otherwise no source file exists. Planning docs alone ` +
        `do not satisfy ${stage.name} - write the code to the workspace.`
    );
  }
}

function verifySummaryConfirmationPrecondition(
  pd: string,
  content: string,
  stage: {
    slug: string;
    name: string;
    phase: string;
    outputs?: string;
    produces?: string[];
    optional_produces?: string[];
    produces_kinds?: Record<string, string[]>;
    for_each?: string;
    summary_confirmation?: "required" | "if-present";
  },
): void {
  const evidence = checkSummaryConfirmationEvidence(pd, stage, {
    stateContent: content,
  });
  if (!evidence.ok) error(evidence.message);
}

// --- Reviewer precondition (§12a / RFC Track 1) -----------------------------
//
// A stage that declares a `reviewer` cannot open its approval gate or complete
// until the reviewer step actually ran — proven by a terminal REVIEW_COMPLETED
// row (written by the tool actor `aidlc-log.ts review --verdict`). Hard on the
// review HAVING HAPPENED, soft on the verdict (a NOT-READY-after-cap still lets
// the human approve).
//
// This lives beside the artifact guard in both gate-opening handlers and all
// four completing handlers, not in orchestrate's report: direct recovery calls
// must not bypass it (issues #366 and #551).
//
// The audit read is FLOORED (mirrors swarmConvergedUnits / hasStageAuditEvent):
// only REVIEW_COMPLETED rows recorded AFTER the stage's latest STAGE_STARTED,
// any later GATE_REJECTED, and the latest relevant produces[] write count.
// Per-unit artifact writes invalidate only that unit's receipt. Without these
// floors a stale review from a prior stage-run, before a reject/revise, or
// before an artifact edit would clear the gate for work nobody re-reviewed.
//
// The row must match BOTH Stage AND Reviewer (a row naming the wrong reviewer —
// a typo, or the conductor self-certifying — must not satisfy it). On per-unit
// stages (for_each: unit-of-work) one review per stage is not enough: the
// Review accounting is per Unit, so EVERY unit must carry its own terminal review.
//
type ReviewerPreconditionAction = "complete" | "present-approval-gate";

function reviewerPreconditionPrefix(
  slug: string,
  action: ReviewerPreconditionAction,
): string {
  return action === "present-approval-gate"
    ? `Cannot present "${slug}" for approval`
    : `Cannot complete "${slug}"`;
}

function verifyReviewerPrecondition(
  pd: string,
  content: string,
  stage: {
    slug: string;
    name: string;
    phase: string;
    for_each?: string;
    mode?: string;
    reviewer?: string;
    reviewer_max_iterations?: number;
    review_class?: "adversarial" | "advisory";
    workspace_requires?: boolean;
    produces?: string[];
    optional_produces?: string[];
    produces_kinds?: Record<string, string[]>;
  },
  action: ReviewerPreconditionAction = "complete",
  requireReceiptExistence = true,
): void {
  if (!stage.reviewer) return; // stage declares no reviewer — nothing to enforce

  // Interactive directives omit the reviewer when the effective class resolves
  // to `none`; their completion path must use that same resolution or it asks
  // for a receipt the conductor was explicitly told not to create. Autonomous
  // swarm stages are the exception: their declared reviewer is the only
  // pre-merge verification inside each Bolt, so caps/overrides do not silence
  // the receipt requirement there.
  const autonomousSwarm = isAutonomousSwarmStage(pd, content, stage);
  const reviewClass = autonomousSwarm
    ? stage.review_class ?? "adversarial"
    : resolveReviewClass(
        stage.review_class ?? "adversarial",
        getField(content, "Scope") ?? "",
        content,
      );
  if (reviewClass === "none") {
    return;
  }

  const reviewer = stage.reviewer;

  // The fresh-receipt scan lives in aidlc-lib.ts (freshReviewReceipts) so the
  // review-freeze PreToolUse hook and this precondition read the SAME window:
  // event interleave (timestamp, buffer-position tiebreak), the stage-agnostic
  // WORKFLOW_STARTED/STAGE_JUMPED floor, the unit-major STAGE_STARTED skip,
  // and per-unit write invalidation are all documented there.
  const receipts = freshReviewReceipts(pd, content, stage, { reviewClass });
  const perUnit =
    stage.for_each === "unit-of-work" &&
    !usesStageLevelPerUnitArtifacts(getField(content, "Scope"), content);
  const pendingRecoveryUnits = Array.from(receipts.unitPending)
    .filter(([, pending]) => pending.recovery)
    .map(([unit]) => unit);
  if (receipts.stagePending?.recovery || pendingRecoveryUnits.length > 0) {
    const scope =
      pendingRecoveryUnits.length > 0
        ? ` for Unit${pendingRecoveryUnits.length === 1 ? "" : "s"} ${pendingRecoveryUnits.join(", ")}`
        : "";
    error(
      `${reviewerPreconditionPrefix(stage.slug, action)}: the recovery review${scope} ` +
        "is still in progress. Finish that review and record its result before " +
        "presenting the gate or completing the stage.",
    );
  }

  // Source-state equality composes with v2's bounded stale-receipt recovery.
  // The workspace-global newest-receipt reconciliation remains the outer
  // boundary; freshReviewReceipts additionally validates each modern unit
  // binding and applies newest-fresh-claimant shielding per path.
  const sourceFreshnessOff =
    process.env.AIDLC_SKIP_SOURCE_FRESHNESS === "1";
  const settledSwarm =
    perUnit &&
    settledSwarmForArtifactGuardOrError(
      pd,
      stage,
      content,
      action,
    );
  // A tightly bounded reconciliation handles the one intentional exception to
  // the global outer boundary: after an unclaimed addition is reverted, the
  // current baseline delta can be fully covered by fresh modern unit bindings
  // even though the newest workspace-global receipt saw the transient file.
  // Any legacy/missing/stale unit evidence or remaining unclaimed baseline delta
  // keeps the normal global-first refusal.
  let baselineChanged: Set<string> | null = null;
  let baselineUnclaimed: string[] | null = null;
  if (
    stage.workspace_requires === true &&
    receipts.sourceBaseline.state === "ready" &&
    receipts.currentSourceListing !== null
  ) {
    baselineChanged = new Set<string>();
    const baseline = receipts.sourceBaseline.listing;
    for (const [pathKey, oid] of baseline) {
      if (
        !sourceListingEntriesEqual(
          receipts.currentSourceListing.get(pathKey),
          oid,
        )
      ) {
        baselineChanged.add(pathKey);
      }
    }
    for (const pathKey of receipts.currentSourceListing.keys()) {
      if (!baseline.has(pathKey)) baselineChanged.add(pathKey);
    }
    const claimModels = [...receipts.freshUnitClaims.values()];
    baselineUnclaimed = [...baselineChanged]
      .filter((pathKey) => !claimModels.some((claims) => sourceClaimCovers(pathKey, claims)))
      .sort();
  }
  const resolutionForReconciliation = perUnit ? resolveBoltDag(pd) : null;
  const applicableReconciliationUnits =
    resolutionForReconciliation?.state === "ok"
      ? resolutionForReconciliation.units.filter(
          (unit) =>
            filterProducesByKind(
              stage.produces_kinds,
              stage.produces ?? [],
              resolutionForReconciliation.unitKinds?.get(unit) ?? null,
            ).length > 0,
        )
      : [];
  const baselineReversionReconciled =
    receipts.sourceStale &&
    perUnit &&
    applicableReconciliationUnits.length > 0 &&
    applicableReconciliationUnits.every(
      (unit) =>
        receipts.unitVerdicts.has(unit) &&
        receipts.freshUnitClaims.has(unit) &&
        !receipts.unitStale.has(unit),
    ) &&
    baselineUnclaimed?.length === 0;
  const staleSource =
    stage.workspace_requires === true &&
    !sourceFreshnessOff &&
    !settledSwarm &&
    receipts.sourceStale &&
    !baselineReversionReconciled;
  if (staleSource) {
    staleSourcePreconditionError(
      pd,
      content,
      stage.slug,
      reviewer,
      receipts.sourceStaleProgress?.recoverySpent === true,
    );
  }

  if (settledSwarm) {
    verifySettledSwarmSourceBinding(pd, stage, action);
    return;
  }

  // Already-[x] recovery skips only existence/cardinality and therefore every
  // attribution check that depends on a complete fresh-unit claim union. The
  // modern global binding was still compared above, preserving crash recovery.
  if (!requireReceiptExistence) return;

  const sawStageReview = receipts.stageVerdict !== null;
  const reviewedUnits = new Set(receipts.unitVerdicts.keys());

  if (!perUnit) {
    if (!sawStageReview) {
      if (receipts.stageStale) {
        staleReviewPreconditionError(
          pd,
          content,
          stage.slug,
          reviewer,
          receipts.stageStaleProgress?.recoverySpent === true,
          action,
        );
      }
      reviewerPreconditionError(stage.slug, reviewer, action);
    }
    return;
  }

  const resolution = resolveBoltDag(pd);
  if (resolution.state === "malformed") {
    error(
      `${reviewerPreconditionPrefix(stage.slug, action)}: its per-unit review set cannot be ` +
        `resolved because unit-of-work-dependency.md is ${resolution.reason} ` +
        `(${resolution.detail}). Fix the fenced units block before ` +
        `${action === "complete" ? "completing" : "presenting the approval gate"}.`,
    );
  }
  let reviewUnits: string[];
  const noDagObserved = resolution.state === "none";
  if (noDagObserved) {
    if (receipts.mergedBoltUnits.size === 0) {
      if (!sawStageReview) {
        reviewerPreconditionError(stage.slug, reviewer, action);
      }
      return;
    }
    if (sawStageReview) return;
    reviewUnits = [...receipts.mergedBoltUnits].sort();
  } else if (resolution.units.length === 0) {
    if (!sawStageReview) {
      reviewerPreconditionError(stage.slug, reviewer, action);
    }
    return;
  } else {
    // A kind-pruned unit with no applicable produces[] never receives a stage
    // directive, so it cannot owe a review. If every unit is vacuous, no
    // stage-level fallback review is required.
    const produces = stage.produces ?? [];
    reviewUnits = resolution.units.filter(
      (unit) =>
        filterProducesByKind(
          stage.produces_kinds,
          produces,
          resolution.unitKinds?.get(unit) ?? null,
        ).length > 0,
    );
  }
  if (reviewUnits.length === 0) return;

  const missing = reviewUnits.filter((u) => !reviewedUnits.has(u));
  if (missing.length > 0) {
    if (noDagObserved) {
      const requestCommands = missing.flatMap((unit) => {
        if (
          receipts.unitStaleProgress.get(unit)?.recoverySpent === true
        ) {
          return [];
        }
        const pending = receipts.unitPending.get(unit);
        const iteration =
          pending?.iteration ??
          receipts.unitStaleProgress.get(unit)?.nextIteration ??
          (receipts.unitIterations.get(unit) ?? 0) + 1;
        const retry =
          pending?.state === "retry-required" ? " --retry-pending" : "";
        return [
          `\`aidlc-log.ts review --stage ${stage.slug} --unit ${unit} ` +
            `--reviewer ${reviewer} --iteration ${iteration}${retry}\``,
        ];
      });
      const recoverySpent = missing.filter(
        (unit) =>
          receipts.unitStaleProgress.get(unit)?.recoverySpent === true,
      );
      const guidance =
        requestCommands.length > 0
          ? `Run ${requestCommands.join(", then ")} to request the missing ` +
            "per-unit review, then record each verdict with the same command " +
            "plus `--verdict <READY|NOT-READY>`."
          : "";
      const exhausted =
        recoverySpent.length > 0
          ? ` Recovery was already spent for ${recoverySpent.join(", ")}. ` +
            recoveryGuidance(pd, content, stage.slug) +
            " Only a human Request Changes decision resets that review attempt."
          : "";
      error(
        `${reviewerPreconditionPrefix(stage.slug, action)}: merged Bolt ` +
          `unit${missing.length === 1 ? "" : "s"} ${missing.join(", ")} ` +
          `${missing.length === 1 ? "has" : "have"} no fresh recorded review. ` +
          guidance +
          exhausted,
      );
    }
    const stale = missing.filter((unit) => receipts.unitStale.has(unit));
    const neverReviewed = missing.filter((unit) => !receipts.unitStale.has(unit));
    const recoveryAvailable = stale.filter(
      (unit) => receipts.unitStaleProgress.get(unit)?.recoverySpent !== true,
    );
    const recoverySpent = stale.filter(
      (unit) => receipts.unitStaleProgress.get(unit)?.recoverySpent === true,
    );
    const guidance: string[] = [];
    if (recoveryAvailable.length > 0) {
      guidance.push(
        `For invalidated units with recovery available (${recoveryAvailable.join(", ")}), ` +
          `run \`aidlc-log.ts review --stage ${stage.slug} --unit <unit> --reviewer ` +
          `${reviewer} --iteration <next ordinal>\`, then record the verdict with ` +
          `the same command plus \`--verdict <READY|NOT-READY>\` and stop editing ` +
          `this stage's output documents, that unit's source-manifest.json, and `
          + `that unit's claimed source paths.`,
      );
    }
    if (recoverySpent.length > 0) {
      guidance.push(
        autonomousSwarm
          ? `For autonomous units whose recovery was already spent (${recoverySpent.join(", ")}), ` +
            `do not put them in --claimed or finalize/merge them. Halt and ask the ` +
            `human whether to restart each Bolt; on approval abort/discard the old ` +
            `Bolt and rerun the current swarm prepare step so the fresh Bolt ` +
            `attempt restores one review allowance.`
          : `For units whose recovery was already spent (${recoverySpent.join(", ")}), ` +
            `the one recovery review was already used and their output changed ` +
            `again. ${recoveryGuidance(pd, content, stage.slug)} Only a human ` +
            `Request Changes decision resets the review attempt; do not record ` +
            `that rejection on the human's behalf.`,
      );
    }
    if (neverReviewed.length > 0) {
      guidance.push(
        `For never-reviewed units (${neverReviewed.join(", ")}), run the normal ` +
          `\`aidlc-log.ts review --stage ${stage.slug} --unit <unit> --reviewer ` +
          `${reviewer} --iteration <next ordinal>\` request and record its verdict.`,
      );
    }
    error(
      `${reviewerPreconditionPrefix(stage.slug, action)} because ${missing.length} of ` +
        `${reviewUnits.length} applicable units do not have a current review from ${reviewer} ` +
        `(${missing.join(", ")}). Changed after review: ` +
        `${stale.length > 0 ? stale.join(", ") : "none"}. Not yet reviewed: ` +
        `${neverReviewed.length > 0 ? neverReviewed.join(", ") : "none"}. ` +
        guidance.join(" ")
    );
  }

  const attributionApplies =
    stage.workspace_requires === true && !sourceFreshnessOff && !settledSwarm;
  if (!attributionApplies) return;

  if (
    receipts.sourceBaseline.state === "unbindable" ||
    receipts.sourceBaseline.state === "invalid"
  ) {
    error(
      `Refusing to complete "${stage.slug}": the stage's source baseline snapshot is missing, ` +
        `inconsistent with other modern source-binding evidence, or does not match its recorded hash, ` +
        `so unclaimed source changes cannot be verified. Re-enter the stage ` +
        `(a stage jump records a fresh baseline) or set AIDLC_SKIP_SOURCE_FRESHNESS=1 to bypass ` +
        `deterministically.`,
    );
  }
  if (
    receipts.sourceBaseline.state === "ready" &&
    receipts.currentSourceListing !== null
  ) {
    const unclaimed = baselineUnclaimed ?? [];
    if (unclaimed.length > 0) {
      const rendered = unclaimed.slice(0, 10).map((key) => {
        const separator = key.indexOf("\0");
        const repo = key.slice(0, separator);
        const path = key.slice(separator + 1);
        return repo ? `${repo}/${path}` : path;
      });
      const more = unclaimed.length > 10 ? ` … and ${unclaimed.length - 10} more` : "";
      error(
        `Refusing to complete "${stage.slug}": ${unclaimed.length} application-source path(s) changed during this stage run ` +
          `that no reviewed unit's source manifest claims (${rendered.join(", ")}${more}). Add each path to the owning ` +
          `unit's source-manifest.json and record that unit's one bounded stale-receipt recovery review ` +
          `(aidlc-log.ts review --stage ${stage.slug} --unit <unit> --reviewer ${reviewer} --iteration <next ordinal>, ` +
          `then --verdict <READY|NOT-READY>), or revert the change. Unclaimed source changes fail closed (RFC #662).`,
      );
    }
  }
}

function staleSourcePreconditionError(
  pd: string,
  content: string,
  slug: string,
  reviewer: string,
  recoverySpent: boolean,
): never {
  if (recoverySpent) {
    error(
      `Refusing to complete "${slug}": the workspace source changed again after ` +
        `the one recovery review by ${reviewer} (source-fingerprint mismatch). ` +
        `${recoveryGuidance(pd, content, slug)} ` +
        "Only a human Request Changes decision resets the review attempt; do not " +
        "record that rejection on the human's behalf.",
    );
  }
  error(
    `Cannot complete "${slug}" because the project source changed after ${reviewer} ` +
      `reviewed it. Ask ${reviewer} to review the current source once more and record ` +
      `the verdict, or revert the source change, then try again.`,
  );
}

function verifyPipelineLinkPrecondition(
  pd: string,
  stage: {
    slug: string;
    name: string;
    mode?: string;
    lead_agent: string;
    support_agents: string[];
  },
): void {
  if (
    stage.mode !== "pipeline" ||
    process.env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE === "1"
  ) {
    return;
  }
  const evidence = pipelineLinkEvidence(pd, stage);
  if (evidence.missing.length === 0) return;
  const missing = evidence.missing.map(({ link, repo }) =>
    repo ? `${repo}:${link}` : link
  );
  error(
    `Cannot complete "${stage.slug}" because these pipeline handoffs have not been ` +
      `recorded for the current run: ${missing.join(", ")}. Run aidlc-log.ts link after ` +
      `each agent returns` +
      `${evidence.repos.length > 0 ? " with --repo <repo>" : ""}, or set ` +
      `AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1 only to recover a legitimately-run in-flight pipeline.`,
  );
}

function staleReviewPreconditionError(
  pd: string,
  content: string,
  slug: string,
  reviewer: string,
  recoverySpent: boolean,
  action: ReviewerPreconditionAction = "complete",
): never {
  if (recoverySpent) {
    error(
      `${reviewerPreconditionPrefix(slug, action)}: this stage's output document ` +
        `changed again after the one recovery review by ${reviewer}. ` +
        recoveryGuidance(pd, content, slug) +
        " Only a human Request Changes decision resets the review attempt; do not " +
        "record that rejection on the human's behalf."
    );
  }
  error(
    `${reviewerPreconditionPrefix(slug, action)} because an output document changed after ` +
      `${reviewer} reviewed it. Run ` +
      `one recovery review pass with \`aidlc-log.ts review --stage ${slug} ` +
      `--reviewer ${reviewer} --iteration <next ordinal>\`, then record the verdict ` +
      `with the same command plus \`--verdict <READY|NOT-READY>\`. After that ` +
      `review, stop editing this stage's output documents. If the recovery pass was already ` +
      `spent, present the situation to the human at the approval gate; a human ` +
      `Request Changes decision resets the review attempt. Do not record a rejection ` +
      `on the human's behalf.`
  );
}

function reviewerPreconditionError(
  slug: string,
  reviewer: string,
  action: ReviewerPreconditionAction = "complete",
): never {
  if (action === "present-approval-gate") {
    error(
      `Cannot present "${slug}" for approval because ${reviewer} has not reviewed the ` +
        `current output. Apply any fixes first, then request the review with ` +
        `\`aidlc-log.ts review --stage ${slug} --reviewer ${reviewer} --iteration ` +
        `<next ordinal>\` and record its verdict with the same command plus ` +
        `\`--verdict <READY|NOT-READY>\`. After recording the verdict, do not edit ` +
        `this stage's output documents; include suggestions from a READY review in the ` +
        `approval summary instead.`,
    );
  }
  error(
    `Cannot complete "${slug}" because ${reviewer} has not reviewed the current output. ` +
      `Apply any fixes first, then request the review with \`aidlc-log.ts review --stage ` +
      `${slug} --reviewer ${reviewer} --iteration <next ordinal>\` and record its verdict ` +
      `with the same command plus \`--verdict <READY|NOT-READY>\`. After recording the ` +
      `verdict, do not edit this stage's output documents; include suggestions from a ` +
      `READY review in the approval summary instead.`
  );
}

function reviewRecoverySpentInCurrentAttempt(
  pd: string,
  content: string,
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
): boolean {
  if (!stage.reviewer) return false;
  const autonomousSwarm = isAutonomousSwarmStage(pd, content, stage);
  const reviewClass = autonomousSwarm
    ? stage.review_class ?? "adversarial"
    : resolveReviewClass(
        stage.review_class ?? "adversarial",
        getField(content, "Scope") ?? "",
        content,
      );
  if (reviewClass === "none") return false;
  const receipts = freshReviewReceipts(pd, content, stage, { reviewClass });
  if (receipts.sourceRecoverySpent) return true;
  if (receipts.sourceStaleProgress?.recoverySpent === true) return true;
  if (receipts.stageStaleProgress?.recoverySpent === true) return true;
  for (const progress of receipts.unitStaleProgress.values()) {
    if (progress.recoverySpent) return true;
  }
  return false;
}

function handleAdvance(
  args: string[],
  inheritedValidationWarning?: string,
): void {
  // Keep only the positional <completed-slug> [<next-slug>]; any flags are
  // filtered out so they are not misread as the next slug.
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length < 1)
    error("Usage: aidlc-state.ts advance <completed-slug> [<next-slug>]");
  const completedSlug = positional[0];

  const pd = resolveProjectDir(projectDir);
  // Per-stage token/cost rollup - computed BEFORE withAuditLock opens (a ledger
  // read, never transcript I/O, and try/caught so it never blocks a completion).
  // "Before emitAudit" is not far enough: emitAudit runs UNDER the held lock, so
  // the read must happen above the lock. Merged into STAGE_COMPLETED's fields
  // inside the arrow below. {} when no ledger exists (non-Claude harness, or a
  // Claude session that never folded) - the event is then unchanged.
  const usageFields = stageRollupFields(pd, completedSlug);
  // C2b lost-update safety: the whole read→decide→emit-audit→write critical
  // section runs under one audit lock so the next-stage derivation, the 5 audit
  // rows, and the state write all commit atomically against a single snapshot
  // (decide-inside-lock). emitAudit detects the held lock and uses the unlocked
  // append variant, so audit + state land together (audit-first). The replay
  // guard's early `return` exits the arrow cleanly; the lock releases in
  // withAuditLock's finally.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  // Look up stage data
  const completedStage = findStageBySlug(completedSlug);
  if (!completedStage) error(`Unknown stage: ${completedSlug}`);

  // Scope is authoritative for deriving next stage — refuse silent "feature"
  // fallback when the state file is missing or corrupted. Adversarial finding.
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to advance — fix the state file first.`
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

  // Slug validation — `advance <slug>` is a post-gate-approval transition.
  // The caller must have just finished <completedSlug>. Silently accepting
  // any slug (even ones unrelated to the current state) would mutate
  // unrelated stages and emit bogus events.
  //
  // Accept two shapes cleanly:
  //   1. completedSlug matches `Current Stage` (normal post-approve flow);
  //   2. completedSlug is already `[x]` (idempotent replay / approve-first).
  // Anything else errors.
  const completedCbBefore = parseCheckboxes(content).find(
    (c) => c.slug === completedSlug
  );
  const currentStageField = getField(content, "Current Stage");
  const matchesCurrent = completedSlug === currentStageField;
  const alreadyMarkedCompleted = completedCbBefore?.state === "completed";
  const stageCompletedAlreadyAudited =
    alreadyMarkedCompleted && hasStageAuditEvent(pd, "STAGE_COMPLETED", completedSlug);
  if (!matchesCurrent && !alreadyMarkedCompleted) {
    error(
      `Cannot advance "${completedSlug}": Current Stage is "${currentStageField}" and "${completedSlug}" is ${
        completedCbBefore?.state ?? "unknown"
      }. Pass the slug that's actually active, or use 'skip' / 'complete-workflow'.`
    );
  }

  // If next-slug was not provided, derive it from the scope AND state file.
  // The state file's EXECUTE/SKIP suffix (set by handleInit with Greenfield
  // overrides) and per-stage checkbox state take precedence over the
  // scope-mapping.json defaults.
  let nextSlug: string;
  if (positional.length >= 2) {
    nextSlug = positional[1];
    // Validate the caller-supplied next slug is in scope AND not already
    // SKIP-stamped in the state file. Symmetric with single-arg form.
    const stateOverrides = parseStateStageSuffixes(content);
    const nextAction =
      stateOverrides.get(nextSlug) ??
      loadScopeMapping()[scope]?.stages[nextSlug];
    if (nextAction === "SKIP") {
      error(
        `Cannot advance to "${nextSlug}": stage is SKIP for scope "${scope}" (or state file). Pick the next EXECUTE stage or use 'skip'.`
      );
    }
  } else {
    const next = nextInScopeStage(completedSlug, scope, content);
    if (!next) {
      error(
        `No next in-scope stage after "${completedSlug}" for scope "${scope}". ` +
          `Use 'complete-workflow' if this was the final stage.`
      );
    }
    nextSlug = next.slug;
  }
  const nextStage = findStageBySlug(nextSlug);
  if (!nextStage) error(`Unknown stage: ${nextSlug}`);

  // Idempotency guard — if completedSlug is already [x] AND nextSlug has
  // already left pending with Current Stage pointing at it, this is a replay.
  // Skip the whole emission block and exit cleanly, rather than doubling
  // STAGE_STARTED / PHASE_COMPLETED / PHASE_VERIFIED / PHASE_STARTED.
  // Adversarial finding: the previous alreadyMarkedCompleted guard only
  // suppressed STAGE_COMPLETED; phase events still doubled.
  // The next stage counts as already-started in ANY of its post-start gate
  // states — in-progress, awaiting-approval, revising. Matching only
  // in-progress let a stale replay demote a gate-held `[?]`/`[R]` next stage
  // back to `[-]` and re-emit STAGE_STARTED.
  const nextCbBefore = parseCheckboxes(content).find(
    (c) => c.slug === nextSlug
  );
  const nextAlreadyStarted =
    nextCbBefore?.state === "in-progress" ||
    nextCbBefore?.state === "awaiting-approval" ||
    nextCbBefore?.state === "revising";
  const isReplay =
    alreadyMarkedCompleted &&
    stageCompletedAlreadyAudited &&
    nextAlreadyStarted &&
    currentStageField === nextSlug;
  if (isReplay) {
    console.log(
      JSON.stringify({
        completed: completedSlug,
        started: nextSlug,
        replay: true,
        timestamp: isoTimestamp(),
      })
    );
    return;
  }

  // A true replay above is already fully applied and remains idempotent. A
  // crash-window partial approval does not satisfy all replay predicates, so it
  // still reaches the source comparison. Already-[x] recovery may lack review
  // receipts, but any modern source binding still has to match.
  verifyReviewerPrecondition(
    pd,
    content,
    completedStage,
    "complete",
    !alreadyMarkedCompleted,
  );

  // Artifact guard (issue #366). Only enforce when THIS advance is the
  if (!alreadyMarkedCompleted) {
    verifyStageArtifacts(pd, completedStage);
    verifySummaryConfirmationPrecondition(pd, content, completedStage);
    verifyPipelineLinkPrecondition(pd, completedStage);
  }

  // Detect phase boundary (for PHASE_COMPLETED/VERIFIED/STARTED emissions)
  const crossesPhaseBoundary = completedStage.phase !== nextStage.phase;

  // 1. Mark completed-slug → [x] (idempotent)
  content = setCheckbox(content, completedSlug, "completed");

  // 2. Mark next-slug → [-]
  content = setCheckbox(content, nextSlug, "in-progress");

  // 3. Update fields
  const nextAfterNext = nextInScopeStage(nextSlug, scope, content);
  const timestamp = isoTimestamp();

  content = setField(content, "Current Stage", nextStage.slug);
  content = setField(content, "Lifecycle Phase", nextStage.phase.toUpperCase());
  content = setField(content, "Next Stage", nextAfterNext ? nextAfterNext.slug : "none");
  content = setField(content, "In Progress", nextStage.slug);
  content = setField(content, "Active Agent", nextStage.lead_agent);
  content = setField(content, "Status", "Running");
  content = setField(content, "Last Updated", timestamp);
  content = setField(content, "Last Completed Stage", completedSlug);
  content = setField(content, "Next Action", `Execute ${nextStage.name}`);

  // Sync Completed counter to actual [x] count
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  // Phase Progress rows mirror the boundary events emitted below: the
  // completed phase's row flips to Verified and the entered phase's to Active,
  // in the same state write. Display-only (routing reads Lifecycle Phase and
  // the checkboxes), but without the flip the section holds its initial values
  // forever and contradicts the checkboxes underneath it.
  if (crossesPhaseBoundary) {
    content = setPhaseProgress(content, completedStage.phase, "Verified");
    content = setPhaseProgress(content, nextStage.phase, "Active");
  }

  const validationFields =
    !alreadyMarkedCompleted || !stageCompletedAlreadyAudited
      ? stageValidationAuditFields(pd, completedStage, content)
      : {};
  const validationWarning =
    inheritedValidationWarning ?? validationFields[VALIDATION_WARNING_FIELD];

  // 4. Atomic audit emission — audit-first, then state write.
  // If audit fails, throw before touching state (writeStateFile below is skipped).
  try {
    // Emit STAGE_COMPLETED only if approve didn't already emit it.
    if (!alreadyMarkedCompleted || !stageCompletedAlreadyAudited) {
      emitAudit(pd, "STAGE_COMPLETED", {
        Stage: completedSlug,
        ...validationFields,
        Details: `Stage ${completedStage.name} completed`,
        ...usageFields,
      });
    }
    if (crossesPhaseBoundary) {
      emitAudit(pd, "PHASE_COMPLETED", {
        "From phase": completedStage.phase,
        "To phase": nextStage.phase,
        "Stages completed": String(completedCount),
      });
      emitAudit(pd, "PHASE_VERIFIED", {
        "Phase boundary": `${completedStage.phase} → ${nextStage.phase}`,
      });
      emitAudit(pd, "PHASE_STARTED", {
        Phase: nextStage.phase,
        Scope: scope,
      });
    }
    emitAudit(pd, "STAGE_STARTED", {
      Stage: nextSlug,
      Agent: nextStage.lead_agent,
      ...(nextStage.workspace_requires
        ? sourceBaselineAuditFields(pd, nextSlug)
        : {}),
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);

  console.log(
    JSON.stringify({
      completed: completedSlug,
      started: nextSlug,
      phase: nextStage.phase.toUpperCase(),
      phase_boundary: crossesPhaseBoundary,
      completed_count: completedCount,
      next_after: nextAfterNext ? nextAfterNext.slug : null,
      already_completed: alreadyMarkedCompleted,
      memory_path: relativeMemoryPath(nextStage.phase, nextStage.slug, relativeRecordDir(pd)),
      timestamp,
      ...(validationWarning ? { warnings: [validationWarning] } : {}),
    })
  );
  });
}

function handleFinalize(args: string[]): void {
  // Keep <completed-slug> positional; any flags are filtered out.
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length < 1)
    error("Usage: aidlc-state.ts finalize <completed-slug>");
  const completedSlug = positional[0];

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: read→decide→write under one lock (no audit here).
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const completedStage = findStageBySlug(completedSlug);
  if (!completedStage) error(`Unknown stage: ${completedSlug}`);

  // Artifact guard (issue #366). finalize also marks a stage [x], so it is a
  // completing transition that must not rubber-stamp. Guard only when the slug
  // is not already [x] (an idempotent re-finalize already passed the guard),
  // and before any mutation so a refusal leaves state untouched.
  const alreadyMarkedCompleted =
    parseCheckboxes(content).find((c) => c.slug === completedSlug)?.state ===
    "completed";
  verifyReviewerPrecondition(
    pd,
    content,
    completedStage,
    "complete",
    !alreadyMarkedCompleted,
  );
  if (!alreadyMarkedCompleted) {
    verifyStageArtifacts(pd, completedStage);
    verifySummaryConfirmationPrecondition(pd, content, completedStage);
    verifyPipelineLinkPrecondition(pd, completedStage);
  }

  // 1. Mark completed
  content = setCheckbox(content, completedSlug, "completed");

  // 2. Sync Completed counter to actual [x] count
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  // 3. Look up next in-scope stage. Refuse silent fallback on missing/invalid
  // Scope — matches handleAdvance's stance. Adversarial: pre-Phase-11 code
  // silently used "feature" when Scope was absent, hiding state-file corruption.
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to finalize — fix the state file first.`
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }
  // Thread the live state content into BOTH walks so per-stage EXECUTE/SKIP
  // suffix overrides (a recomposed plan) and prior [x]/[S] checkboxes are
  // honoured - the same threading the advance path does (:869/:935). Without
  // it these two calls project the next move from the STATIC scope grid and
  // route around any recompose flip.
  const nextStage = nextInScopeStage(completedSlug, scope, content);
  const nextAfterNext = nextStage ? nextInScopeStage(nextStage.slug, scope, content) : null;
  const timestamp = isoTimestamp();

  // 4. Update state fields (but do NOT mark next stage [-] or set In Progress)
  if (nextStage) {
    content = setField(content, "Current Stage", nextStage.slug);
    content = setField(content, "Next Stage", nextAfterNext ? nextAfterNext.slug : "none");
    content = setField(content, "Lifecycle Phase", nextStage.phase.toUpperCase());
    content = setField(content, "Active Agent", nextStage.lead_agent);
    // Phase Progress boundary flip - mirrors handleAdvance's. finalize moves
    // the cursor without emitting phase events, but the display rows must
    // still track the phase the cursor now sits in.
    if (completedStage.phase !== nextStage.phase) {
      content = setPhaseProgress(content, completedStage.phase, "Verified");
      content = setPhaseProgress(content, nextStage.phase, "Active");
    }
  } else {
    content = setField(content, "Current Stage", "none");
    content = setField(content, "Next Stage", "none");
    content = setField(content, "Status", "Completed");
    content = setField(content, "In Progress", "none");
    // No next stage: the workflow is done - the final phase is Verified.
    content = setPhaseProgress(content, completedStage.phase, "Verified");
  }
  content = setField(content, "Last Completed Stage", completedSlug);
  content = setField(content, "Last Updated", timestamp);
  content = setField(content, "Next Action", nextStage ? `Resume from ${nextStage.name}` : "Workflow complete");

  writeStateFile(pd, content);
  console.log(
    JSON.stringify({
      completed: completedSlug,
      completed_count: completedCount,
      next_stage: nextStage?.slug || "none",
      phase: nextStage?.phase.toUpperCase() || completedStage.phase.toUpperCase(),
      timestamp,
    })
  );
  });
}

function handleCompleteWorkflow(
  args: string[],
  inheritedValidationWarning?: string,
): void {
  // Keep <completed-slug> positional and distinct from the --reason value.
  // --reason takes a value, so its argument is excluded from positionals too.
  const reasonIdx = args.indexOf("--reason");
  const reasonValueIdx = reasonIdx !== -1 ? reasonIdx + 1 : -1;
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && i !== reasonValueIdx,
  );
  if (positional.length < 1)
    error("Usage: aidlc-state.ts complete-workflow <completed-slug> [--reason <text>]");
  const completedSlug = positional[0];

  // Optional --reason flag for recording why the workflow completed early
  let reason: string | undefined;
  if (reasonIdx !== -1 && reasonIdx + 1 < args.length) {
    reason = args[reasonIdx + 1];
  }

  const pd = resolveProjectDir(projectDir);
  const stageUsageFields = stageRollupFields(pd, completedSlug);
  const workflowUsageFields = workflowRollupFields(pd);
  // C2b lost-update safety: read→decide→emit-audit (4 rows)→write under one
  // lock so the 4 audit rows and the completion state commit atomically against
  // a single snapshot (audit-first / decide-inside-lock). emitAudit uses the
  // unlocked variant because the lock is held.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const completedStage = findStageBySlug(completedSlug);
  if (!completedStage) error(`Unknown stage: ${completedSlug}`);

  // If the slug is already [x], approve already emitted STAGE_COMPLETED —
  // skip re-emission to avoid duplicates. Matches handleAdvance's
  // alreadyMarkedCompleted guard.
  const alreadyMarkedCompleted =
    parseCheckboxes(content).find((c) => c.slug === completedSlug)?.state ===
    "completed";
  const stageCompletedAlreadyAudited =
    alreadyMarkedCompleted && hasStageAuditEvent(pd, "STAGE_COMPLETED", completedSlug);

  // Artifact guard (issue #366). complete-workflow marks the FINAL stage [x], so
  // it is a completing transition too. Guard only when the slug is not already
  // [x]: approve delegates here AFTER marking the slug [x] and running the guard
  // itself, so this skips the double-check on that path while still refusing a
  // direct `complete-workflow <active-slug>` that never produced artifacts. Runs
  // before any mutation so a refusal leaves state untouched.
  verifyReviewerPrecondition(
    pd,
    content,
    completedStage,
    "complete",
    !alreadyMarkedCompleted,
  );
  if (!alreadyMarkedCompleted) {
    verifyStageArtifacts(pd, completedStage);
    verifySummaryConfirmationPrecondition(pd, content, completedStage);
    verifyPipelineLinkPrecondition(pd, completedStage);
  }

  // 1. Mark completed
  content = setCheckbox(content, completedSlug, "completed");

  // 2. Sync Completed counter
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  // 3. Update all fields atomically for workflow completion
  const timestamp = isoTimestamp();
  content = setField(content, "Status", "Completed");
  content = setField(content, "Last Updated", timestamp);
  content = setField(content, "Last Completed Stage", completedSlug);
  content = setField(content, "In Progress", "none");
  content = setField(content, "Next Stage", "none");
  content = setField(content, "Next Action", "Workflow complete");
  // Phase Progress: workflow completion is the final phase's boundary - its
  // row flips to Verified alongside the PHASE_COMPLETED/PHASE_VERIFIED pair
  // emitted below (the advance-side flip only fires on stage->stage
  // boundaries, so the last phase would otherwise stay Active forever).
  content = setPhaseProgress(content, completedStage.phase, "Verified");

  // 4. Atomic audit emissions. Refuse silent fallback — matches handleAdvance.
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to complete workflow — fix the state file first.`
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }
  const validationFields =
    !alreadyMarkedCompleted || !stageCompletedAlreadyAudited
      ? stageValidationAuditFields(pd, completedStage, content)
      : {};
  const validationWarning =
    inheritedValidationWarning ?? validationFields[VALIDATION_WARNING_FIELD];
  try {
    if (!alreadyMarkedCompleted || !stageCompletedAlreadyAudited) {
      emitAudit(pd, "STAGE_COMPLETED", {
        Stage: completedSlug,
        ...validationFields,
        Details: `Final stage ${completedStage.name} completed`,
        ...stageUsageFields,
      });
    }
    emitAudit(pd, "PHASE_COMPLETED", {
      "From phase": completedStage.phase,
      "To phase": "(end)",
      "Stages completed": String(completedCount),
    });
    emitAudit(pd, "PHASE_VERIFIED", {
      "Phase boundary": `${completedStage.phase} → end`,
    });
    const workflowFields: Record<string, string> = {
      Scope: scope,
      Details: `Scope: ${scope}, ${completedCount} stages completed`,
      ...workflowUsageFields,
    };
    if (reason) workflowFields.Reason = reason;
    emitAudit(pd, "WORKFLOW_COMPLETED", workflowFields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  // Intent status lifecycle: terminal completion flips the active intent's
  // registry row to "complete". This is the determinism (field write) gated by
  // the human-confirmed completion that drove complete-workflow here — never an
  // automatic inference from state, so a crashed run never self-completes. Runs
  // under the workspace lock already held (every intents.json mutation takes the
  // sentinel bucket). No-op for the legacy flat record (no registry row).
  const completedSelection = resolveWorkflowSelection(pd);
  const completedIntentDir = completedSelection.intent;
  if (completedIntentDir) {
    updateIntentStatus(
      pd,
      completedIntentDir,
      "complete",
      completedSelection.space,
    );
  }
  console.log(
    JSON.stringify({
      completed: completedSlug,
      completed_count: completedCount,
      status: "Completed",
      reason: reason || null,
      timestamp,
      ...(validationWarning ? { warnings: [validationWarning] } : {}),
    })
  );
  });
}

// --- New gate/approve/reject/skip/revise/resume/reuse-artifact commands (state-machine refactor #50) ---

// Helper: get the current state of a specific slug
function getSlugState(content: string, slug: string): CheckboxState | null {
  const checkboxes = parseCheckboxes(content);
  const match = checkboxes.find((c) => c.slug === slug);
  return match ? match.state : null;
}

function validateSlugInState(
  content: string,
  slug: string,
  expected: CheckboxState | CheckboxState[]
): void {
  const actual = getSlugState(content, slug);
  if (actual === null) error(`Stage not found in state file: ${slug}`);
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(actual)) {
    error(
      `Stage ${slug} is in state '${actual}' but command requires one of: ${allowed.join(", ")}`
    );
  }
}

interface TeamGateContext {
  unit: string;
  scope: UnitGateScope;
  stages: NonNullable<ReturnType<typeof findStageBySlug>>[];
}

function teamGateContext(
  content: string,
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
  args: string[],
): TeamGateContext | null {
  const unit = getFlagValue(args, "--unit")?.trim();
  if (!isTeamUnitOwnership(content)) {
    if (unit) {
      error("--unit gate decisions require Unit Ownership: team.");
    }
    return null;
  }
  if (stage.phase !== "construction" || stage.for_each !== "unit-of-work") {
    if (unit) {
      error(
        `Stage "${stage.slug}" is not a per-unit Construction stage; team unit gates do not apply.`,
      );
    }
    return null;
  }
  if (!unit) {
    error(
      `Unit Ownership: team requires --unit <name> for gate decisions on "${stage.slug}".`,
    );
  }
  const unitError = validateUnitName(unit);
  if (unitError) error(unitError);
  const pd = resolveProjectDir(projectDir);
  validateLiveUnitScope(pd, unit);
  const resolution = resolveBoltDag(pd);
  if (resolution.state !== "ok" || !resolution.units.includes(unit)) {
    error(`Unit "${unit}" is not in the authoritative unit DAG.`);
  }
  const rhythm = effectiveUnitGateRhythm(pd, content);
  if (rhythm === "per-stage") {
    return { unit, scope: "per-stage", stages: [stage] };
  }
  const workflowScope = getField(content, "Scope") ?? "";
  const stages = unitMajorConstructionStageSlugs(
    workflowScope,
    content,
    true,
  )
    .map((slug) => findStageBySlug(slug))
    .filter(
      (entry): entry is NonNullable<ReturnType<typeof findStageBySlug>> =>
        !!entry,
    );
  const final = stages[stages.length - 1];
  if (!final || final.slug !== stage.slug) {
    error(
      `Unit-end gate for "${unit}" must be reported against the final per-unit stage ` +
        `"${final?.slug ?? "unknown"}", not "${stage.slug}".`,
    );
  }
  return { unit, scope: "unit-end", stages };
}

function applicableUnitProduces(
  pd: string,
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
  unit: string,
): string[] {
  let required = stage.produces ?? [];
  if (stage.produces_kinds !== undefined) {
    const resolution = resolveBoltDag(pd);
    if (resolution.state === "ok" && resolution.unitKinds !== null) {
      required = filterProducesByKind(
        stage.produces_kinds,
        required,
        resolution.unitKinds.get(unit) ?? null,
      );
    }
  }
  return required;
}

function verifyReviewerPreconditionForUnit(
  pd: string,
  content: string,
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
  unit: string,
): void {
  if (!stage.reviewer) return;
  const reviewClass = resolveReviewClass(
    stage.review_class ?? "adversarial",
    getField(content, "Scope") ?? "",
    content,
  );
  if (reviewClass === "none") return;
  const receipts = freshReviewReceipts(pd, content, stage, { reviewClass });
  if (!receipts.unitVerdicts.has(unit)) {
    error(
      `Refusing gate for unit "${unit}" of "${stage.slug}": no fresh ` +
        `REVIEW_COMPLETED receipt from ${stage.reviewer} is recorded for this unit.`,
    );
  }
}

function verifyTeamUnitGateEvidence(
  pd: string,
  content: string,
  context: TeamGateContext,
): void {
  for (const stage of context.stages) {
    if (applicableUnitProduces(pd, stage, context.unit).length === 0) continue;
    const missing = missingUnitArtifacts(pd, stage, context.unit);
    if (missing.length > 0) {
      error(
        `Refusing gate for unit "${context.unit}" of "${stage.slug}": required ` +
          `artifacts are missing (${missing.join(", ")}).`,
      );
    }
    if (!unitCompletedReceipts(pd, stage.slug).has(context.unit)) {
      error(
        `Refusing gate for unit "${context.unit}" of "${stage.slug}": no current ` +
          "UNIT_COMPLETED receipt is recorded.",
      );
    }
    const summary = checkSummaryConfirmationEvidence(pd, stage, {
      stateContent: content,
      unit: context.unit,
    });
    if (!summary.ok) error(summary.message);
    verifyReviewerPreconditionForUnit(pd, content, stage, context.unit);
    if (stage.workspace_requires) verifyStageArtifacts(pd, stage);
  }
}

function teamGateFields(
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
  context: TeamGateContext,
): Record<string, string> {
  return {
    Stage: stage.slug,
    Unit: context.unit,
    "Gate Scope": context.scope,
    "Gate Stages": context.stages.map((entry) => entry.slug).join(","),
    ...claimAttemptFields(resolveProjectDir(projectDir), context.unit),
  };
}

// gate-start <slug> — fire gate-bound sensors, then open either the global
// stage gate or the claim-scoped team Unit gate.
// On an existing gate, re-run every opening guard without writing another
// transition. A consumed blocking-sensor override emits a Revalidated row so
// its human authorization cannot be reused; ordinary revalidation stays quiet.
// --recovered marks a BACKFILLED gate row (the engine opening a gate the
// conductor skipped, e.g. report's explicit-stage recovery) with
// Recovered=true so audit consumers can tell backfills from organic opens.
function handleGateStart(args: string[]): void {
  if (args.length < 1) {
    error(
      "Usage: aidlc-state.ts gate-start <slug> [--artifacts <csv>] " +
        "[--recovered] [--override-blocking-sensors] [--user-input <choice>]",
    );
  }
  const slug = args[0];
  let artifacts: string | undefined;
  const artifactsIdx = args.indexOf("--artifacts");
  if (artifactsIdx !== -1 && artifactsIdx + 1 < args.length) {
    artifacts = args[artifactsIdx + 1];
  }
  const recovered = args.includes("--recovered");
  const overrideBlockingSensors = args.includes("--override-blocking-sensors");
  const overrideInput = getFlagValue(args.slice(1), "--user-input");

  const pd = resolveProjectDir(projectDir);
  // Sensor dispatch MUST stay outside the state transaction: aidlc-sensor.ts
  // takes the same audit lock around its FIRED and terminal rows.
  const preflightContent = readStateFile(pd);
  const preflightStage = findStageBySlug(slug);
  if (!preflightStage) error(`Unknown stage: ${slug}`);
  const preflightTeamGate = teamGateContext(
    preflightContent,
    preflightStage,
    args.slice(1),
  );
  if (preflightTeamGate) {
    verifyTeamUnitGateEvidence(pd, preflightContent, preflightTeamGate);
    for (const gateStage of preflightTeamGate.stages) {
      verifyPipelineLinkPrecondition(pd, gateStage);
    }
  } else {
    validateSlugInState(
      preflightContent,
      slug,
      ["in-progress", "awaiting-approval"],
    );
    verifyGateOpeningGuards(
      pd,
      preflightContent,
      preflightStage,
    );
  }
  const gateSensorEvaluation = fireGateSensors(
    pd,
    preflightStage,
    artifacts,
  );
  enforceBlockingGateSensors(
    pd,
    preflightContent,
    slug,
    "awaiting-approval",
    gateSensorEvaluation.issues,
    overrideBlockingSensors,
    overrideInput,
  );

  // C2b lost-update safety: validate→transition→emit-audit→write under one
  // lock (the state-precondition check and the write see one snapshot).
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  const teamGate = teamGateContext(content, stage, args.slice(1));
  if (teamGate) {
    verifyTeamUnitGateEvidence(pd, content, teamGate);
    for (const gateStage of teamGate.stages) {
      verifyPipelineLinkPrecondition(pd, gateStage);
    }
    verifyGateSensorArtifactsUnchanged(slug, gateSensorEvaluation);
    const status = unitGateStatus(
      pd,
      stage.slug,
      teamGate.unit,
      teamGate.scope,
    );
    if (status === "approved") {
      error(
        `Gate for unit "${teamGate.unit}" of "${stage.slug}" is already approved.`,
      );
    }
    if (status === "awaiting-approval") {
      console.log(
        JSON.stringify({
          slug,
          unit: teamGate.unit,
          gate_scope: teamGate.scope,
          new_state: "awaiting-approval",
          already_awaiting_approval: true,
          revalidated: true,
        }),
      );
      return;
    }
    const timestamp = isoTimestamp();
    content = setField(content, "Last Updated", timestamp);
    try {
      emitAudit(pd, "STAGE_AWAITING_APPROVAL", {
        ...teamGateFields(stage, teamGate),
        ...(artifacts ? { Artifacts: artifacts } : {}),
        ...(recovered ? { Recovered: "true" } : {}),
      });
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
    writeStateFile(pd, content);
    console.log(JSON.stringify({
      slug,
      unit: teamGate.unit,
      gate_scope: teamGate.scope,
      new_state: "awaiting-approval",
      timestamp,
    }));
    return;
  }
  validateSlugInState(content, slug, ["in-progress", "awaiting-approval"]);
  const alreadyAwaiting = getSlugState(content, slug) === "awaiting-approval";
  verifyGateOpeningGuards(pd, content, stage);
  verifyGateSensorArtifactsUnchanged(slug, gateSensorEvaluation);
  if (alreadyAwaiting) {
    if (
      gateSensorEvaluation.issues.length > 0 &&
      overrideBlockingSensors
    ) {
      try {
        const fields: Record<string, string> = {
          Stage: slug,
          Revalidated: "true",
        };
        addBlockingSensorOverrideFields(
          fields,
          gateSensorEvaluation.issues,
          true,
        );
        emitAudit(pd, "STAGE_AWAITING_APPROVAL", fields);
      } catch (e) {
        error(`Audit emission failed: ${errorMessage(e)}`);
      }
    }
    console.log(
      JSON.stringify({
        slug,
        new_state: "awaiting-approval",
        already_awaiting_approval: true,
        revalidated: true,
      }),
    );
    return;
  }

  content = setCheckbox(content, slug, "awaiting-approval");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    const fields: Record<string, string> = { Stage: slug };
    if (artifacts) fields.Artifacts = artifacts;
    if (recovered) fields.Recovered = "true";
    addBlockingSensorOverrideFields(
      fields,
      gateSensorEvaluation.issues,
      overrideBlockingSensors,
    );
    emitAudit(pd, "STAGE_AWAITING_APPROVAL", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ slug, new_state: "awaiting-approval", timestamp }));
  });
}

// approve <slug> [--user-input <exact-choice>]
// Transition: [?] → [x] AND auto-advance to the next in-scope stage (or
// complete the workflow if this was the final stage). Human judgment ends
// at the gate response; everything after is deterministic bookkeeping, so
// approve owns it end-to-end. Emits GATE_APPROVED + STAGE_COMPLETED, then
// delegates to handleAdvance or handleCompleteWorkflow for the remaining
// transitions. Eliminates the t59-class bug where the orchestrator approved
// but forgot to call advance, leaving Current Stage pointing at a [x] slug.
function verifyApprovalDecision(
  pd: string,
  content: string,
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
  userInput?: string,
  forceHuman = false,
): { approvalInput: string | undefined; autonomousDecision: boolean } {
  const autonomousDecision =
    !forceHuman && isAutonomousConstructionDecision(content, stage.phase);
  const approvalInput = userInput?.trim();
  const approvalAuthorship =
    autonomousDecision || humanPresenceGuardDisabled()
      ? null
      : selfAttributedDecisionMarker(approvalInput, "approval");
  if (approvalAuthorship) {
    error(
      `Cannot approve "${stage.slug}" because --user-input says the choice came from the ` +
        `assistant (${approvalAuthorship.category}: "${approvalAuthorship.phrase}"). ` +
        "This check looks for explicit assistant provenance; it does not prove who wrote " +
        "the reply. Approval is the human's decision: end the turn and let them answer, " +
        "and if something is blocking completion, explain that blocker at the gate in " +
        "project terms instead of recording their decision.",
    );
  }
  if (!autonomousDecision && !humanPresenceGuardDisabled()) {
    const rawRevisionCount = getField(content, "Revision Count");
    const parsedRevisionCount = rawRevisionCount
      ? parseInt(rawRevisionCount, 10)
      : 0;
    const revisionCount = Number.isFinite(parsedRevisionCount)
      ? parsedRevisionCount
      : 0;
    const matchesOfferedApproval =
      approvalInput === "Approve" ||
      (approvalInput === "Accept as-is" && revisionCount >= 3);
    if (!matchesOfferedApproval) {
      const cancellation = isNonAnswer(approvalInput)
        ? " The reply is cancellation boilerplate, not consent."
        : "";
      error(
        `Cannot approve "${stage.slug}" because the reply ` +
          `${formatReceivedReply(approvalInput)} did not match one of the offered ` +
          `choices.${cancellation} Present the original question with every choice again ` +
          "and wait for the human to pick one.",
      );
    }
  }
  if (
    !autonomousDecision &&
    !humanPresenceGuardDisabled() &&
    !humanActedSinceGate(pd)
  ) {
    error(
      `Cannot approve "${stage.slug}" because no new human reply has been received for ` +
        "this approval question. Wait for the human to type their choice, then retry the " +
        `approval.${unattendedHumanPresenceHint()}`,
    );
  }
  return { approvalInput, autonomousDecision };
}

function handleApprove(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts approve <slug> [--user-input <text>]");
  const slug = args[0];
  const { userInput } = parseApproveFlags(args.slice(1));

  const pd = resolveProjectDir(projectDir);
  const preflightContent = readStateFile(pd);
  const preflightStage = findStageBySlug(slug);
  if (!preflightStage) error(`Unknown stage: ${slug}`);
  const preflightTeamGate = teamGateContext(
    preflightContent,
    preflightStage,
    args.slice(1),
  );
  if (!preflightTeamGate) {
    validateSlugInState(preflightContent, slug, "awaiting-approval");
  }
  const preflightDecision = verifyApprovalDecision(
    pd,
    preflightContent,
    preflightStage,
    userInput,
    preflightTeamGate !== null,
  );
  if (preflightTeamGate) {
    verifyTeamUnitGateEvidence(pd, preflightContent, preflightTeamGate);
  } else {
    verifyStageArtifacts(pd, preflightStage);
    verifySummaryConfirmationPrecondition(
      pd,
      preflightContent,
      preflightStage,
    );
  }
  const preflightBackstop =
    preflightTeamGate === null &&
    !revisionBackstopDisabled() &&
    !preflightDecision.autonomousDecision &&
    unrecordedRevisionSinceGateOpen(pd, preflightStage);
  const backstopSensorEvaluation = preflightBackstop
    ? fireGateSensors(pd, preflightStage)
    : { issues: [], fingerprints: new Map<string, string>() };

  // Per-stage token/cost rollup - computed BEFORE the lock opens (ledger read
  // only, try/caught). Approve is the STAGE_COMPLETED that fires in the normal
  // gate flow (the nested advance/complete-workflow suppress their own once this
  // one is audited), so the usage rollup attaches here. {} when no ledger exists.
  const usageFields = stageRollupFields(pd, slug);
  // C2b lost-update safety: the ENTIRE approve transaction — including the
  // nested handleAdvance / handleCompleteWorkflow calls below — runs under one
  // outer lock. withAuditLock is REENTRANT (per-pd depth counter): the nested
  // handlers' own withAuditLock calls bump depth 1→2→1 and run inline without
  // re-acquiring the OS lock, so approve+advance commit as one atomic unit and
  // no concurrent writer can interleave between approve's write and the
  // advance's re-read. The original ordering is preserved: approve writes its
  // own state (slug → [x]) BEFORE delegating, so the nested re-read sees it.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  const teamGate = teamGateContext(content, stage, args.slice(1));
  if (!teamGate) {
    validateSlugInState(content, slug, "awaiting-approval");
  }
  const { approvalInput, autonomousDecision } = verifyApprovalDecision(
    pd,
    content,
    stage,
    userInput,
    teamGate !== null,
  );

  if (teamGate) {
    verifyTeamUnitGateEvidence(pd, content, teamGate);
    const reviewFindingDispositions = acceptedRiskDispositionField(
      pd,
      teamGate.stages,
      teamGate.unit,
    );
    const status = unitGateStatus(
      pd,
      stage.slug,
      teamGate.unit,
      teamGate.scope,
    );
    if (status !== "awaiting-approval") {
      error(
        `Gate for unit "${teamGate.unit}" of "${stage.slug}" is ${status}; ` +
          "open or revise the gate before approving it.",
      );
    }
    if (
      !humanPresenceGuardDisabled() &&
      !humanActedSinceGate(pd)
    ) {
      error(
        `Refusing to approve unit "${teamGate.unit}" for "${slug}": a real human ` +
          "has not acted at this gate since it opened.",
      );
    }
    const timestamp = isoTimestamp();
    content = setField(content, "Last Updated", timestamp);
    try {
      emitAudit(pd, "GATE_APPROVED", {
        ...teamGateFields(stage, teamGate),
        ...(approvalInput ? { "User Input": approvalInput } : {}),
        ...(reviewFindingDispositions
          ? {
              [REVIEW_FINDING_DISPOSITIONS_FIELD]:
                reviewFindingDispositions,
            }
          : {}),
      });
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
    writeStateFile(pd, content);
    console.log(JSON.stringify({
      slug,
      unit: teamGate.unit,
      gate_scope: teamGate.scope,
      approved: true,
      timestamp,
    }));
    return;
  }

  // Artifact guard (issue #366): a stage cannot be approved without evidence of
  // work on disk. Runs BEFORE any mutation so a refusal (error() -> exit) leaves
  // state untouched. The nested handleAdvance / handleCompleteWorkflow below see
  // the slug as already [x] and skip their own guard, so this is the single
  // enforcement point on the approve path. Bypass via AIDLC_SKIP_ARTIFACT_GUARD.
  // Covers per-unit Construction stages (globs the record's
  // construction/<unit>/<slug>/) and code-producing stages (workspace_requires).
  verifyStageArtifacts(pd, stage);
  verifySummaryConfirmationPrecondition(pd, content, stage);

  // Gate-revision backstop: reconcile a revision the conductor performed at an
  // open gate but never recorded (it skipped the `reject` verb). When the ledger
  // proves the human revised this stage's artifact at the open gate with no
  // recorded reject (unrecordedRevisionSinceGateOpen), backfill the missing
  // GATE_REJECTED + STAGE_REVISING pair (tagged Recovered) and persist [R].
  // A reviewer-bearing stage must then obtain a fresh post-rejection receipt
  // before this command may emit the recovered gate re-entry. When that guard
  // refuses, the durable [R] state routes the conductor through normal `revise`
  // after review instead of leaving an invalid [?] gate open.
  // Skipped under the off-switch and in autonomous Construction (no human at the
  // gate, so no human-driven revision to reconcile).
  const backstopNow =
    !revisionBackstopDisabled() &&
    !autonomousDecision &&
    unrecordedRevisionSinceGateOpen(pd, stage);
  if (backstopNow && !preflightBackstop) {
    error(
      `Refusing to approve "${slug}": revision evidence changed during the gate ` +
        "preflight. Retry the approval so revised bytes can be checked before re-entry.",
    );
  }
  if (backstopNow) {
    const priorCount = getField(content, "Revision Count");
    const priorParsed = priorCount ? parseInt(priorCount, 10) : 0;
    const revCount = (Number.isFinite(priorParsed) ? priorParsed : 0) + 1;
    content = setField(content, "Revision Count", String(revCount));
    content = setCheckbox(content, slug, "revising");
    content = setField(content, "Last Updated", isoTimestamp());
    // Audit-first: a failed emission aborts before any state write (matches the
    // GATE_APPROVED/STAGE_COMPLETED try/catch below).
    try {
      emitAudit(pd, "GATE_REJECTED", {
        Stage: slug,
        Recovered: "true",
        Details:
          "Backfilled by the revision backstop: the artifact was revised at " +
          "an open gate with no reject recorded",
        ...priorAcceptedSourceFields(pd, stage),
      });
      emitAudit(pd, "STAGE_REVISING", {
        Stage: slug,
        "Revision count": String(revCount),
        Recovered: "true",
      });
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
    writeStateFile(pd, content);
    verifyGateSensorArtifactsUnchanged(slug, backstopSensorEvaluation);
    verifySummaryConfirmationPrecondition(pd, content, stage);
    verifyPipelineLinkPrecondition(pd, stage);
    if (!reviewerGateGuardDisabled()) {
      verifyReviewerPrecondition(pd, content, stage, "present-approval-gate");
    }
    enforceBlockingGateSensors(
      pd,
      content,
      slug,
      "revised",
      backstopSensorEvaluation.issues,
      false,
    );
    try {
      emitAudit(pd, "STAGE_AWAITING_APPROVAL", {
        Stage: slug,
        Recovered: "true",
        Details: "Re-entering gate after backfilled revision",
      });
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
    content = setCheckbox(content, slug, "awaiting-approval");
    content = setField(content, "Last Updated", isoTimestamp());
    writeStateFile(pd, content);
  }

  verifySummaryConfirmationPrecondition(pd, content, stage);
  verifyPipelineLinkPrecondition(pd, stage);
  verifyReviewerPrecondition(pd, content, stage);
  const reviewFindingDispositions = acceptedRiskDispositionField(pd, stage);

  // Scope is required for next-stage derivation. Validate it before persisting
  // approval: a post-write routing failure would otherwise leave `[x]` as a
  // durable but incomplete approval and make crash recovery security-sensitive.
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to advance after approve — fix the state file first.`,
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`,
    );
  }

  const timestamp = isoTimestamp();

  content = setCheckbox(content, slug, "completed");
  content = setField(content, "Last Updated", timestamp);
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));
  content = setField(content, "Last Completed Stage", slug);

  // Capture before the first audit append. The lifecycle-facing helper is
  // fail-open: failures produce a receipt-less completion plus a persistent
  // warning instead of stranding GATE_APPROVED without STAGE_COMPLETED.
  const validationFields = stageValidationAuditFields(pd, stage, content);
  const validationWarning = validationFields[VALIDATION_WARNING_FIELD];

  // Atomic audit emissions (audit-first). GATE_APPROVED records the human
  // decision; STAGE_COMPLETED records the state transition the approval
  // implies. Both emit here so the audit trail is correct even if the
  // downstream advance/complete-workflow fails.
  try {
    const gateFields: Record<string, string> = { Stage: slug };
    if (approvalInput) gateFields["User Input"] = approvalInput;
    if (reviewFindingDispositions) {
      gateFields[REVIEW_FINDING_DISPOSITIONS_FIELD] =
        reviewFindingDispositions;
    }
    emitAudit(pd, "GATE_APPROVED", gateFields);

    emitAudit(pd, "STAGE_COMPLETED", {
      Stage: slug,
      ...validationFields,
      Details: `Stage ${stage.name} approved by gate`,
      ...usageFields,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);

  // No explicit consume step (ledger-event design): the GATE_APPROVED
  // emitted by this commit IS the freshness boundary for the next gate. A second
  // gate auto-cascaded in the same human turn finds the last gate resolution
  // (this GATE_APPROVED) AFTER the only HUMAN_TURN, so humanActedSinceGate refuses
  // it — one commit per human turn, from ledger order, with no marker to flip.
  const next = nextInScopeStage(slug, scope, content);
  if (next) {
    // Delegate to handleAdvance. The slug is now [x], so handleAdvance takes
    // the alreadyMarkedCompleted path and skips re-emitting STAGE_COMPLETED.
    // Reentrant call — runs under the depth-2 lock without re-acquire.
    handleAdvance([slug], validationWarning);
  } else {
    // Final stage — complete the workflow. handleCompleteWorkflow re-sets
    // the checkbox to [x] (idempotent) and emits PHASE_COMPLETED +
    // PHASE_VERIFIED + WORKFLOW_COMPLETED. Reentrant call — see above.
    handleCompleteWorkflow([slug], validationWarning);
  }
  });
}

// Look up a flag's value while guarding against value-starting-with-"--"
// ambiguity. If the user forgets to provide a value (e.g. `--user-input
// --reason`), indexOf+slice would consume the next flag as the value —
// silently wrong. This helper errors cleanly when the value starts with "--".
// Returns undefined if the flag is absent.
function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  if (idx + 1 >= args.length) {
    error(`${flag} expects a value, got end of arguments.`);
  }
  const val = args[idx + 1];
  if (val.startsWith("--")) {
    error(`${flag} expects a value, got another flag: "${val}". Did you forget the value?`);
  }
  return val;
}

function getFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    if (i + 1 >= args.length) {
      error(`${flag} expects a value, got end of arguments.`);
    }
    const value = args[i + 1];
    if (value.startsWith("--")) {
      error(
        `${flag} expects a value, got another flag: "${value}". Did you forget the value?`,
      );
    }
    values.push(value);
    i++;
  }
  return values;
}

// Flag parser for approve — handles --user-input (value).
function parseApproveFlags(args: string[]): { userInput?: string } {
  return {
    userInput: getFlagValue(args, "--user-input"),
  };
}

// reject <slug> [--user-input <exact-choice>] [--feedback <text>]
//   [--reject-finding <review-artifact>#R-NN=<human reason>]...
// — transition
// [?] or [-] → [R], emit GATE_REJECTED + STAGE_REVISING, and increment Revision
// Count. The direct Active → Revising path deliberately does not fabricate a
// recovered approval gate: a persisted rejection is valid when gate-start was
// skipped, while STAGE_AWAITING_APPROVAL describes only a gate that passed its
// opening guards.
function handleReject(args: string[]): void {
  if (args.length < 1) {
    error(
      'Usage: aidlc-state.ts reject <slug> [--user-input "Request Changes"] ' +
        "[--feedback <text>] " +
        "[--reject-finding <review-artifact>#R-NN=<human reason>]...",
    );
  }
  const slug = args[0];
  const decision = getFlagValue(args.slice(1), "--user-input")?.trim();
  const feedback =
    (getFlagValue(args.slice(1), "--feedback") ??
      getFlagValue(args.slice(1), "--reason"))?.trim();
  const rejectedFindings = getFlagValues(
    args.slice(1),
    "--reject-finding",
  );

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: validate→increment Revision Count→emit-audit→write
  // under one lock. The Revision Count read-modify-write is the exposed bit —
  // two concurrent rejects must not both read N and both write N+1 (one
  // increment lost). emit-then-write stays idempotent on retry: the lock
  // serialises, and re-running the same input recomputes from the locked
  // snapshot rather than double-incrementing a stale value.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  const teamGate = teamGateContext(content, stage, args.slice(1));
  if (!teamGate) {
    validateSlugInState(content, slug, ["awaiting-approval", "in-progress"]);
  }
  const autonomousDecision =
    !teamGate && isAutonomousConstructionDecision(content, stage.phase);
  if (
    !autonomousDecision &&
    !humanPresenceGuardDisabled() &&
    decision !== "Request Changes"
  ) {
    const cancellation = isNonAnswer(decision)
      ? " The reply is cancellation boilerplate, not a decision."
      : "";
    error(
      `Refusing to reject "${slug}": received reply ${formatReceivedReply(decision)} did not ` +
        `match an offered choice at the held gate.${cancellation} ` +
        "Re-present the original held gate with every offered choice and wait for the human " +
        "to choose one.",
    );
  }
  if (!feedback) {
    error(
      `Refusing to reject "${slug}": Request Changes requires nonblank revision feedback in ` +
        "--feedback (or --reason through aidlc-orchestrate.ts report).",
    );
  }
  if (isNonAnswer(feedback)) {
    error(
      `Refusing to reject "${slug}": revision feedback ${formatReceivedReply(feedback)} is ` +
        "cancellation boilerplate. Re-present the original held gate with every offered choice " +
        "and wait for the human to choose one.",
    );
  }

  const autonomousMode = isAutonomousMode(content);
  const recoveryResetNeedsHuman =
    !teamGate &&
    autonomousMode &&
    reviewRecoverySpentInCurrentAttempt(pd, content, stage);
  if (
    (!autonomousDecision || recoveryResetNeedsHuman) &&
    !humanPresenceGuardDisabled() &&
    !humanActedSinceGate(pd)
  ) {
    if (recoveryResetNeedsHuman) {
      error(
        `Cannot request changes for "${slug}" because its recovery review has already ` +
          `been used and only a new human choice can start another review attempt. Present ` +
          `the situation at the approval question and wait for a typed Request Changes choice.${unattendedHumanPresenceHint()}`,
      );
    }
    error(
      `Cannot request changes for "${slug}" because no new human reply has been received ` +
        `for this approval question. Wait for the human to type Request Changes and their ` +
        `feedback, then retry.${unattendedHumanPresenceHint()}`,
    );
  }

  // Authorship floor (issue 742). The presence check above proves a human is in
  // the session, not that this rejection is theirs — so a conductor blocked by
  // the review-budget/receipt ordering can satisfy it while writing its own
  // change request, because GATE_REJECTED is the only event that restores an
  // advisory review budget. That reopen is the single most attractive forgery in
  // the protocol and the one seen in the field, so refuse the self-attributed
  // rejection here rather than laundering it into the trail as the human's.
  // Autonomous Construction is exempt (the conductor owns the decision there).
  const rejectionAuthorship =
    autonomousDecision || humanPresenceGuardDisabled()
      ? null
      : selfAttributedDecisionMarker(feedback, "rejection");
  if (rejectionAuthorship) {
    error(
      `Cannot request changes for "${slug}" because --feedback says it was written by the ` +
        `assistant (${rejectionAuthorship.category}: "${rejectionAuthorship.phrase}"). ` +
        `Requesting changes is the human's decision. Explain why another review is needed at ` +
        `the approval question and wait for the human to choose.`,
    );
  }
  const reviewFindingDispositions = rejectedFindingDispositionField(
    pd,
    teamGate?.stages ?? stage,
    rejectedFindings,
    teamGate?.unit,
  );

  if (teamGate) {
    const priorStatus = unitGateStatus(
      pd,
      stage.slug,
      teamGate.unit,
      teamGate.scope,
    );
    if (
      priorStatus !== "awaiting-approval" &&
      priorStatus !== "pending"
    ) {
      error(
        `Gate for unit "${teamGate.unit}" of "${stage.slug}" is ${priorStatus}; ` +
          "only a pending or awaiting gate can be rejected.",
      );
    }
    const current = getField(content, "Revision Count");
    const parsed = current ? parseInt(current, 10) : 0;
    const revCount = (Number.isFinite(parsed) ? parsed : 0) + 1;
    content = setField(content, "Revision Count", String(revCount));
    const timestamp = isoTimestamp();
    content = setField(content, "Last Updated", timestamp);
    const fields = teamGateFields(stage, teamGate);
    try {
      emitAudit(pd, "GATE_REJECTED", {
        ...fields,
        Feedback: feedback,
        ...(reviewFindingDispositions
          ? {
              [REVIEW_FINDING_DISPOSITIONS_FIELD]:
                reviewFindingDispositions,
            }
          : {}),
      });
      emitAudit(pd, "STAGE_REVISING", {
        ...fields,
        "Revision count": String(revCount),
        Feedback: feedback,
      });
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
    writeStateFile(pd, content);
    console.log(JSON.stringify({
      slug,
      unit: teamGate.unit,
      gate_scope: teamGate.scope,
      new_state: "revising",
      revision_count: revCount,
      timestamp,
    }));
    return;
  }

  // Increment Revision Count. Guard against non-numeric values (missing field,
  // manual edits, legacy state files) by coercing non-integers to 0.
  const current = getField(content, "Revision Count");
  const parsed = current ? parseInt(current, 10) : 0;
  const revCount = (Number.isFinite(parsed) ? parsed : 0) + 1;
  content = setField(content, "Revision Count", String(revCount));

  content = setCheckbox(content, slug, "revising");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    const rejFields: Record<string, string> = {
      Stage: slug,
      Feedback: feedback,
      ...priorAcceptedSourceFields(pd, stage),
    };
    if (reviewFindingDispositions) {
      rejFields[REVIEW_FINDING_DISPOSITIONS_FIELD] =
        reviewFindingDispositions;
    }
    emitAudit(pd, "GATE_REJECTED", rejFields);
    emitAudit(pd, "STAGE_REVISING", {
      Stage: slug,
      "Revision count": String(revCount),
      Feedback: feedback,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ slug, new_state: "revising", revision_count: revCount, timestamp }));
  });
}

// revise <slug> — fire gate-bound sensors, then transition [R] → [?]
// (re-enter gate after revision work)
function handleRevise(args: string[]): void {
  if (args.length < 1) {
    error(
      "Usage: aidlc-state.ts revise <slug> [--override-blocking-sensors] " +
        "[--user-input <choice>]",
    );
  }
  const slug = args[0];
  const overrideBlockingSensors = args.includes("--override-blocking-sensors");
  const overrideInput = getFlagValue(args.slice(1), "--user-input");

  const pd = resolveProjectDir(projectDir);
  // Sensor dispatch MUST stay outside the state transaction: aidlc-sensor.ts
  // takes the same audit lock around its FIRED and terminal rows.
  const preflightContent = readStateFile(pd);
  const preflightStage = findStageBySlug(slug);
  if (!preflightStage) error(`Unknown stage: ${slug}`);
  validateSlugInState(preflightContent, slug, "revising");
  verifyGateOpeningGuards(
    pd,
    preflightContent,
    preflightStage,
  );
  const gateSensorEvaluation = fireGateSensors(pd, preflightStage);
  enforceBlockingGateSensors(
    pd,
    preflightContent,
    slug,
    "revised",
    gateSensorEvaluation.issues,
    overrideBlockingSensors,
    overrideInput,
  );

  // C2b lost-update safety: validate→transition→emit-audit→write under one lock.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  const teamGate = teamGateContext(content, stage, args.slice(1));
  if (teamGate) {
    const status = unitGateStatus(
      pd,
      stage.slug,
      teamGate.unit,
      teamGate.scope,
    );
    if (status !== "revising") {
      error(
        `Gate for unit "${teamGate.unit}" of "${stage.slug}" is ${status}; ` +
          "only a revising gate can re-enter approval.",
      );
    }
    verifyTeamUnitGateEvidence(pd, content, teamGate);
    const timestamp = isoTimestamp();
    content = setField(content, "Last Updated", timestamp);
    try {
      emitAudit(pd, "STAGE_AWAITING_APPROVAL", {
        ...teamGateFields(stage, teamGate),
        Details: "Re-entering unit gate after revision",
      });
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
    writeStateFile(pd, content);
    console.log(JSON.stringify({
      slug,
      unit: teamGate.unit,
      gate_scope: teamGate.scope,
      new_state: "awaiting-approval",
      timestamp,
    }));
    return;
  }
  validateSlugInState(content, slug, "revising");
  verifyGateOpeningGuards(pd, content, stage);
  verifyGateSensorArtifactsUnchanged(slug, gateSensorEvaluation);

  content = setCheckbox(content, slug, "awaiting-approval");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    const fields: Record<string, string> = {
      Stage: slug,
      Details: "Re-entering gate after revision",
    };
    addBlockingSensorOverrideFields(
      fields,
      gateSensorEvaluation.issues,
      overrideBlockingSensors,
    );
    emitAudit(pd, "STAGE_AWAITING_APPROVAL", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ slug, new_state: "awaiting-approval", timestamp }));
  });
}

// skip <slug> [--reason <text>] [--route]
//
// The historical un-routed form remains a narrow state primitive for internal
// repair and tests: it flips [ ]/[-]/[R] to [S] and emits STAGE_SKIPPED.
// `--route` is the engine-owned stage outcome. In one locked transaction it
// preserves [S], emits STAGE_SKIPPED exactly once, then starts the next
// in-scope stage (including phase-boundary events) or completes the workflow.
// An [S] slug with an unmoved Current Stage is accepted only on this internal
// routed path so an interrupted historical transition can finish without
// duplicating STAGE_SKIPPED.
function handleSkip(args: string[]): void {
  if (args.length < 1) {
    error("Usage: aidlc-state.ts skip <slug> [--reason <text>] [--route]");
  }
  const slug = args[0];
  const reason = getFlagValue(args.slice(1), "--reason")?.trim();
  const route = args.includes("--route");

  const pd = resolveProjectDir(projectDir);
  const workflowUsageFields = workflowRollupFields(pd);
  // C2b lost-update safety: validate→transition→emit-audit→write under one lock.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  if (!route) {
    validateSlugInState(content, slug, ["pending", "in-progress", "revising"]);

    content = setCheckbox(content, slug, "skipped");
    const timestamp = isoTimestamp();
    content = setField(content, "Last Updated", timestamp);

    try {
      const fields: Record<string, string> = { Stage: slug };
      if (reason) fields.Reason = reason;
      emitAudit(pd, "STAGE_SKIPPED", fields);
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }

    writeStateFile(pd, content);
    console.log(JSON.stringify({ slug, new_state: "skipped", timestamp }));
    return;
  }

  if (!reason) {
    error("aidlc-state.ts skip --route requires a nonblank --reason <text>.");
  }
  validateSlugInState(content, slug, [
    "in-progress",
    "revising",
    "skipped",
  ]);
  const currentStage = getField(content, "Current Stage");
  if (currentStage !== slug) {
    error(
      `Cannot route skipped stage "${slug}": Current Stage is "${currentStage ?? ""}".`,
    );
  }
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      "State file has no Scope field. Refusing to route skip - fix the state file first.",
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`,
    );
  }

  const wasSkipped = getSlugState(content, slug) === "skipped";
  const skipAuditTail = wasSkipped
    ? currentRoutedSkipAuditTail(pd, slug)
    : null;
  const skipAlreadyAudited = skipAuditTail !== null;
  content = setCheckbox(content, slug, "skipped");
  const timestamp = isoTimestamp();
  const nextStage = nextInScopeStage(slug, scope, content);
  const crossesPhaseBoundary =
    nextStage !== null && stage.phase !== nextStage.phase;
  const boundaryTarget = nextStage?.phase ?? "(end)";
  const boundary = `${stage.phase} → ${nextStage?.phase ?? "end"}`;
  const phaseCompletedAlreadyAudited = skipAuditTail !== null && auditTailHasFields(
    skipAuditTail,
    "PHASE_COMPLETED",
    {
      "From phase": stage.phase,
      "To phase": boundaryTarget,
    },
  );
  const phaseVerifiedAlreadyAudited = skipAuditTail !== null && auditTailHasFields(
    skipAuditTail,
    "PHASE_VERIFIED",
    { "Phase boundary": boundary },
  );
  const phaseStartedAlreadyAudited = nextStage
    ? skipAuditTail !== null && auditTailHasFields(skipAuditTail, "PHASE_STARTED", {
        Phase: nextStage.phase,
        Scope: scope,
      })
    : false;
  const stageStartedAlreadyAudited = nextStage
    ? skipAuditTail !== null && auditTailHasFields(skipAuditTail, "STAGE_STARTED", {
        Stage: nextStage.slug,
      })
    : false;
  const workflowCompletedAlreadyAudited = nextStage === null
    ? skipAuditTail !== null && auditTailHasFields(skipAuditTail, "WORKFLOW_COMPLETED", {
        Scope: scope,
        Details: `Scope: ${scope}, final stage ${slug} skipped`,
      })
    : false;

  if (nextStage) {
    content = setCheckbox(content, nextStage.slug, "in-progress");
    const nextAfterNext = nextInScopeStage(nextStage.slug, scope, content);
    content = setField(content, "Current Stage", nextStage.slug);
    content = setField(content, "Lifecycle Phase", nextStage.phase.toUpperCase());
    content = setField(
      content,
      "Next Stage",
      nextAfterNext ? nextAfterNext.slug : "none",
    );
    content = setField(content, "In Progress", nextStage.slug);
    content = setField(content, "Active Agent", nextStage.lead_agent);
    content = setField(content, "Status", "Running");
    content = setField(content, "Next Action", `Execute ${nextStage.name}`);
    if (crossesPhaseBoundary) {
      content = setPhaseProgress(content, stage.phase, "Verified");
      content = setPhaseProgress(content, nextStage.phase, "Active");
    }
  } else {
    content = setField(content, "Status", "Completed");
    content = setField(content, "In Progress", "none");
    content = setField(content, "Next Stage", "none");
    content = setField(content, "Next Action", "Workflow complete");
    content = setPhaseProgress(content, stage.phase, "Verified");
  }
  content = setField(
    content,
    "Completed",
    String(countCheckboxes(content, "completed")),
  );
  content = setField(content, "Last Updated", timestamp);

  try {
    if (!skipAlreadyAudited) {
      emitAudit(pd, "STAGE_SKIPPED", {
        Stage: slug,
        Reason: reason,
        "Skip Kind": "conditional-runtime",
      });
    }
    if (nextStage) {
      if (crossesPhaseBoundary) {
        if (!phaseCompletedAlreadyAudited) {
          emitAudit(pd, "PHASE_COMPLETED", {
            "From phase": stage.phase,
            "To phase": nextStage.phase,
            "Stages completed": String(countCheckboxes(content, "completed")),
          });
        }
        if (!phaseVerifiedAlreadyAudited) {
          emitAudit(pd, "PHASE_VERIFIED", {
            "Phase boundary": boundary,
          });
        }
        if (!phaseStartedAlreadyAudited) {
          emitAudit(pd, "PHASE_STARTED", {
            Phase: nextStage.phase,
            Scope: scope,
          });
        }
      }
      if (!stageStartedAlreadyAudited) {
        emitAudit(pd, "STAGE_STARTED", {
          Stage: nextStage.slug,
          Agent: nextStage.lead_agent,
          ...(nextStage.workspace_requires
            ? sourceBaselineAuditFields(pd, nextStage.slug)
            : {}),
        });
      }
    } else {
      if (!phaseCompletedAlreadyAudited) {
        emitAudit(pd, "PHASE_COMPLETED", {
          "From phase": stage.phase,
          "To phase": "(end)",
          "Stages completed": String(countCheckboxes(content, "completed")),
        });
      }
      if (!phaseVerifiedAlreadyAudited) {
        emitAudit(pd, "PHASE_VERIFIED", {
          "Phase boundary": boundary,
        });
      }
      if (!workflowCompletedAlreadyAudited) {
        emitAudit(pd, "WORKFLOW_COMPLETED", {
          Scope: scope,
          Details: `Scope: ${scope}, final stage ${slug} skipped`,
          Reason: reason,
          ...workflowUsageFields,
        });
      }
    }
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  if (!nextStage) {
    const completedSelection = resolveWorkflowSelection(pd);
    const completedIntentDir = completedSelection.intent;
    if (completedIntentDir) {
      updateIntentStatus(
        pd,
        completedIntentDir,
        "complete",
        completedSelection.space,
      );
    }
  }
  console.log(JSON.stringify({
    slug,
    new_state: "skipped",
    started: nextStage?.slug ?? null,
    workflow_completed: nextStage === null,
    recovered: wasSkipped || skipAlreadyAudited,
    timestamp,
  }));
  });
}

// resume — read-only re-entry marker used by the orchestrator's resume path.
// Returns structured JSON the orchestrator can branch on, including compaction
// detection (was the most recent audit event SESSION_COMPACTED without any
// subsequent stage activity?). Session-level SESSION_RESUMED emission is the
// SessionStart hook's job, NOT this tool — this is a pure reader.
function handleResume(_args: string[]): void {
  const pd = resolveProjectDir(projectDir);
  const content = readStateFile(pd);
  const currentStage = getField(content, "Current Stage") || "unknown";
  const status = getField(content, "Status") || "unknown";
  const phase = getField(content, "Lifecycle Phase") || "unknown";
  const scope = getField(content, "Scope") || "unknown";
  const activeAgent = getField(content, "Active Agent") || "unknown";
  const nextStage = getField(content, "Next Stage") || "none";

  // Stage-level gate awareness — tells the orchestrator whether the user is
  // the blocker on this stage (awaiting approval / revising).
  const checkboxes = parseCheckboxes(content);
  const currentCb = checkboxes.find((c) => c.slug === currentStage);
  const gateState = currentCb?.state ?? "unknown";

  // Compaction detection — scan the tail of audit.md for a SESSION_COMPACTED
  // event that has no subsequent stage activity. The orchestrator uses this
  // to surface the compaction-awareness prompt without a fragile shell pipeline.
  let compactionPending = false;
  try {
    // Merge across per-clone audit shards (single shard in the common case).
    const raw = readAllAuditShards(pd);
    if (raw.length > 0) {
      // Read last ~400 lines (enough to cover ~30 events' worth of blocks)
      const tailLines = raw.split("\n").slice(-400);
      const tail = tailLines.join("\n");
      // Find the index of the last SESSION_COMPACTED event
      const lastCompactIdx = tail.lastIndexOf("**Event**: SESSION_COMPACTED");
      if (lastCompactIdx !== -1) {
        const after = tail.slice(lastCompactIdx);
        // Any stage activity OR explicit recovery after the compaction?
        // STAGE_STARTED / STAGE_COMPLETED / GATE_APPROVED / SESSION_RESUMED
        // are normal progress; RECOVERY_COMPLETED is the explicit "user saw
        // the compaction prompt and chose how to proceed" signal.
        const hasActivity =
          /\*\*Event\*\*: (STAGE_STARTED|STAGE_COMPLETED|GATE_APPROVED|SESSION_RESUMED|RECOVERY_COMPLETED)/.test(
            after
          );
        compactionPending = !hasActivity;
      }
    }
  } catch {
    // Audit read failures are non-fatal — default to false, orchestrator
    // will use the standard resume flow.
  }

  // Unit-level checkpoint (issue 681 claim 2): a resumed session must land on
  // the exact unit stopping point, not just the stage. Read from the runtime
  // mirror fields the `unit` verb maintains; absent on stage-level workflows.
  const activeUnit = getField(content, "Active Unit");
  const unitState = getField(content, "Unit State");

  console.log(
    JSON.stringify({
      resumed: true,
      current_stage: currentStage,
      phase,
      status,
      scope,
      active_agent: activeAgent,
      next_stage: nextStage,
      gate_state: gateState,
      compaction_pending: compactionPending,
      ...(activeUnit
        ? {
            active_unit: activeUnit,
            unit_state: unitState ?? "in-progress",
            unit_pause_reason: getField(content, "Unit Pause Reason") ?? undefined,
            unit_next_action: getField(content, "Unit Next Action") ?? undefined,
          }
        : {}),
    })
  );
}

// acknowledge-compaction --choice <continue|review|restart>
//
// Called by the orchestrator's compaction-awareness flow AFTER the user picks
// Continue / Review / Restart in response to a pending SESSION_COMPACTED event.
// Emits RECOVERY_COMPLETED to record that the user was presented with the
// prompt and made a choice — closing the "compaction detected but not yet
// handled" window. Refuses if `handleResume` would report compaction_pending=false,
// so the event is only emitted when the flow is genuinely recovering.
function handleAcknowledgeCompaction(args: string[]): void {
  const pd = resolveProjectDir(projectDir);
  let choice = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--choice" && i + 1 < args.length) {
      choice = args[i + 1];
      i++;
    }
  }
  if (!choice) {
    error(
      "Usage: aidlc-state.ts acknowledge-compaction --choice <continue|review|restart>"
    );
  }
  if (!["continue", "review", "restart"].includes(choice)) {
    error(`Invalid --choice: ${choice}. Valid: continue, review, restart`);
  }

  const content = readStateFile(pd);
  const currentStage = getField(content, "Current Stage") || "unknown";

  // Only emit if compaction is pending. This prevents spurious
  // RECOVERY_COMPLETED events when the orchestrator calls acknowledge unnecessarily.
  let compactionPending = false;
  try {
    const raw = readAllAuditShards(pd);
    if (raw.length > 0) {
      const tail = raw.split("\n").slice(-400).join("\n");
      const lastCompactIdx = tail.lastIndexOf("**Event**: SESSION_COMPACTED");
      if (lastCompactIdx !== -1) {
        const after = tail.slice(lastCompactIdx);
        compactionPending =
          !/\*\*Event\*\*: (STAGE_STARTED|STAGE_COMPLETED|GATE_APPROVED|SESSION_RESUMED|RECOVERY_COMPLETED)/.test(
            after
          );
      }
    }
  } catch {
    // Audit unreadable — nothing to recover.
  }

  if (!compactionPending) {
    error(
      "No pending compaction to acknowledge (latest SESSION_COMPACTED already followed by stage activity or recovery)."
    );
  }

  emitAudit(pd, "RECOVERY_COMPLETED", {
    Choice: choice,
    "Current Stage": currentStage,
  });

  console.log(
    JSON.stringify({ acknowledged: true, choice, current_stage: currentStage })
  );
}

// practices-event --type <discovered|override|empty> [--field "K: V"]...
// Emits a PRACTICES_* audit event from tool code (not stage prose).
// Required by the audit-first invariant: every audit event must originate
// in .ts code so t48's emitter-pairing check passes. Called by the
// practices-discovery stage for discovery and advisory fallback events.
// PRACTICES_AFFIRMED is reserved for practices-promote, which atomically pairs
// it with the state timestamp after both memory targets are written.
function handlePracticesEvent(args: string[]): void {
  const pd = resolveProjectDir(projectDir);
  let eventTypeArg = "";
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && i + 1 < args.length) {
      eventTypeArg = args[i + 1];
      i++;
    } else if (args[i] === "--field" && i + 1 < args.length) {
      const kv = args[i + 1];
      const idx = kv.indexOf(":");
      if (idx > 0) {
        const key = kv.slice(0, idx).trim();
        const value = kv.slice(idx + 1).trim();
        fields[key] = value;
      }
      i++;
    }
  }
  if (!eventTypeArg) {
    error(
      'Usage: aidlc-state.ts practices-event --type <discovered|override|empty> [--field "Key: Value"]...'
    );
  }
  // Explicit literal-string emitAudit calls per --type so t48's
  // emitter-pairing check (which scans for `emitAudit(... "EVENT_NAME")`
  // literals) finds each event at a real call site.
  //
  // --type empty handles the orchestrator's layer-3 fallback path (when
  // extractMarkdownSection returns "" and the orchestrator falls back to
  // scope-hardcoded defaults). Advisory-only — does not block execution.
  // The `override` case is reused by the orchestrator with --field "Reason:
  // bolt-plan-marker-conflict" + --field "Practices Stance: ..." +
  // --field "Bolt-Plan Marker: ..." + --field "Bolt slug: ..." for the
  // orchestrator-overrides-bolt-plan-marker semantic. The write-failure path
  // uses --field "Reason: write-failure-..." — same event, distinct Reason
  // field (discriminator-field disambiguation, no
  // audit-count bump).
  let emittedEvent: string;
  switch (eventTypeArg) {
    case "discovered":
      emitAudit(pd, "PRACTICES_DISCOVERED", fields);
      emittedEvent = "PRACTICES_DISCOVERED";
      break;
    case "affirmed":
      error(
        "PRACTICES_AFFIRMED is reserved for practices-promote so the audit receipt cannot be minted without successful memory promotion."
      );
      return;
    case "override":
      emitAudit(pd, "PRACTICES_OVERRIDE", fields);
      emittedEvent = "PRACTICES_OVERRIDE";
      break;
    case "empty":
      emitAudit(pd, "PRACTICES_SECTION_EMPTY", fields);
      emittedEvent = "PRACTICES_SECTION_EMPTY";
      break;
    default:
      error(
        `Invalid --type: ${eventTypeArg}. Must be discovered, override, or empty.`
      );
      return;
  }
  console.log(
    JSON.stringify({ emitted: emittedEvent, fields_count: Object.keys(fields).length })
  );
}

// practices-promote --team-practices <path> --discovered-rules <path>
//                   [--affirming-user <name>] [--target-dir <path>]
//
// Cross-row promotion of affirmed practices into the team-authored method
// files. Reads two draft files from the active intent's practices-discovery
// and applies them deterministically to the relocated method files the
// resolver reads (aidlc/spaces/<space>/memory/, neutral names):
//
//   memory/team.md ........... replaceSection × 5 (Way of Working,
//                              Walking Skeleton, Testing Posture,
//                              Deployment, Code Style)
//   memory/project.md ........ appendUnderHeading × 2 (Mandated,
//                              Forbidden), each rule stamped
//                              with `(affirmed YYYY-MM-DD)`
//
// Atomicity:
//   1. Validate every declared support contribution (fail before any write).
//   2. Read both drafts (fail closed before any write).
//   3. Read both targets (fail closed if either missing).
//   4. Build new contents in memory.
//   5. Write project.md first (smaller, more constrained).
//   6. Write team.md second.
//   7. On success → emit PRACTICES_AFFIRMED.
//   8. On any failure → emit PRACTICES_OVERRIDE with the failure reason
//      and rethrow so the caller halts the gate.
//
// Why this exists: when stage prose tells the LLM to write to the method
// files directly, the LLM (running non-interactively under `claude -p`)
// hallucinates a sensitive-file permission policy that does not actually
// exist. The orchestrator then halts at "awaiting-approval" and emits
// PRACTICES_OVERRIDE without ever attempting the write — the workflow
// bricks. Routing the writes through a tool subcommand removes the LLM's
// judgment from the path: the path is never the LLM's write target, so the
// hallucinated policy never fires.
function handlePracticesPromote(args: string[]): void {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && i + 1 < args.length) {
      flags[a.slice(2)] = args[i + 1];
      i++;
    }
  }
  if (!flags["team-practices"] || !flags["discovered-rules"]) {
    error(
      'Usage: aidlc-state.ts practices-promote --team-practices <path> --discovered-rules <path> [--affirming-user <name>] [--target-dir <path>]'
    );
  }

  const pd = resolveProjectDir(projectDir);
  // The affirmed practices land in the relocated method files the resolver
  // reads — team.md / project.md under aidlc/spaces/<space>/memory/ (neutral
  // names, no `aidlc-` prefix). memoryDirFor() derives the path from the SAME
  // MEMORY_SEGMENTS loadRules() reads from, so this writer and the reader can
  // never drift (P5 relocated the reader; P6 closes the seam here). --target-dir
  // lets tests point the writes at a fixture memory dir; it defaults to the
  // project's resolved memory dir.
  const targetRoot = flags["target-dir"] ?? memoryDirFor(pd);
  const teamMdPath = join(targetRoot, "team.md");
  const guardrailsPath = join(targetRoot, "project.md");

  const today = isoTimestamp().slice(0, 10);
  const sectionsWritten: string[] = [];
  const rulesAppended = { mandated: 0, forbidden: 0 };

  const fail = (reason: string): never => {
    try {
      emitAudit(pd, "PRACTICES_OVERRIDE", {
        Reason: reason,
      });
    } catch {
      // If audit emission itself fails, surface the original reason.
    }
    error(`practices-promote failed: ${reason}`);
    throw new Error(reason); // unreachable; error() exits, but TS needs this
  };

  // Step 1: Revalidate the hub-and-spoke evidence immediately before the
  // cross-row memory write. The gate-open report checks the same contract
  // before asking the human, but files can be deleted or malformed while the
  // gate is open. Promotion is the irreversible seam, so it fails closed too.
  const teamPracticesPath = flags["team-practices"];
  const discoveredRulesPath = flags["discovered-rules"];
  const practicesStage = findStageBySlug("practices-discovery");
  if (!practicesStage) {
    fail("practices-discovery is absent from the compiled stage graph");
  }
  const draftDir = dirname(teamPracticesPath);
  if (dirname(discoveredRulesPath) !== draftDir) {
    fail("team-practices and discovered-rules drafts must share one stage directory");
  }
  const missingContributions: string[] = [];
  for (const agent of practicesStage!.support_agents ?? []) {
    const contribution = join(draftDir, "contributions", `${agent}.md`);
    let firstLine = "";
    try {
      firstLine = readFileSync(contribution, "utf-8").split("\n", 1)[0].trim();
    } catch {
      missingContributions.push(`${agent} (no contribution file)`);
      continue;
    }
    if (firstLine !== `**Collaborator:** ${agent}`) {
      missingContributions.push(`${agent} (missing identity-marker first line)`);
    }
  }
  if (missingContributions.length > 0) {
    fail(
      "ensemble evidence is incomplete: " + missingContributions.join("; "),
    );
  }

  // Step 2: Read both drafts.
  if (!existsSync(teamPracticesPath))
    fail(`team-practices draft not found: ${teamPracticesPath}`);
  if (!existsSync(discoveredRulesPath))
    fail(`discovered-rules draft not found: ${discoveredRulesPath}`);

  let teamPracticesDraft: string;
  let discoveredRulesDraft: string;
  try {
    teamPracticesDraft = readFileSync(teamPracticesPath, "utf-8");
    discoveredRulesDraft = readFileSync(discoveredRulesPath, "utf-8");
  } catch (e) {
    fail(`could not read drafts: ${errorMessage(e)}`);
    return;
  }

  // Step 3: Read both target files. Fail closed if either is missing.
  if (!existsSync(teamMdPath)) fail(`team.md not found at ${teamMdPath}`);
  if (!existsSync(guardrailsPath))
    fail(`project.md not found at ${guardrailsPath}`);

  let teamMd: string;
  let guardrailsMd: string;
  try {
    teamMd = readFileSync(teamMdPath, "utf-8");
    guardrailsMd = readFileSync(guardrailsPath, "utf-8");
  } catch (e) {
    fail(`could not read targets: ${errorMessage(e)}`);
    return;
  }

  // Step 4a: Build new team.md by section-replacing each of the five
  // sections. team.md uses Title Case headings; the draft mirrors that
  // shape.
  const TEAM_SECTIONS = [
    "## Way of Working",
    "## Walking Skeleton",
    "## Testing Posture",
    "## Deployment",
    "## Code Style",
  ];
  let newTeamMd = teamMd;
  for (const heading of TEAM_SECTIONS) {
    const draftSection = extractMarkdownSection(teamPracticesDraft, heading);
    if (draftSection === "") {
      // Section absent from draft → leave the live file's section alone.
      // Useful for partial re-runs that only change one practice area.
      continue;
    }
    try {
      newTeamMd = replaceSection(newTeamMd, heading, draftSection);
      sectionsWritten.push(heading.slice(3));
    } catch (e) {
      fail(
        `replaceSection failed on team.md for "${heading}": ${errorMessage(e)}`
      );
      return;
    }
  }

  // Step 4b: Build new project-guardrails.md by appending each rule under the
  // matching heading with a date stamp. Rules are one-per-line in the draft;
  // empty/blank lines and comment lines are skipped.
  const parseRules = (sectionContent: string): string[] => {
    return sectionContent
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("<!--") && !l.startsWith("#"));
  };
  const mandatedDraft = extractMarkdownSection(
    discoveredRulesDraft,
    "## Mandated"
  );
  const forbiddenDraft = extractMarkdownSection(
    discoveredRulesDraft,
    "## Forbidden"
  );
  const mandatedRules = parseRules(mandatedDraft);
  const forbiddenRules = parseRules(forbiddenDraft);

  let newGuardrailsMd = guardrailsMd;
  const existingGuardrailLines = new Set(
    newGuardrailsMd.split("\n").map((line) => line.trim()),
  );
  for (const rule of mandatedRules) {
    const stampedLine = `${rule} (affirmed ${today})`;
    if (existingGuardrailLines.has(stampedLine)) continue;
    try {
      newGuardrailsMd = appendUnderHeading(
        newGuardrailsMd,
        "## Mandated",
        `${stampedLine}\n`
      );
      existingGuardrailLines.add(stampedLine);
      rulesAppended.mandated++;
    } catch (e) {
      fail(`appendUnderHeading failed on Mandated: ${errorMessage(e)}`);
      return;
    }
  }
  for (const rule of forbiddenRules) {
    const stampedLine = `${rule} (affirmed ${today})`;
    if (existingGuardrailLines.has(stampedLine)) continue;
    try {
      newGuardrailsMd = appendUnderHeading(
        newGuardrailsMd,
        "## Forbidden",
        `${stampedLine}\n`
      );
      existingGuardrailLines.add(stampedLine);
      rulesAppended.forbidden++;
    } catch (e) {
      fail(`appendUnderHeading failed on Forbidden: ${errorMessage(e)}`);
      return;
    }
  }

  // Step 5 & 6: Write project.md first, then team.md.
  // If the project write fails, team.md is untouched. If the team write
  // fails after project succeeded, we surface that as PRACTICES_OVERRIDE and
  // the user re-enters the gate. Exact dated project rules are deduplicated
  // above, so a retry cannot accumulate copies after this partial-write path.
  try {
    writeFileSync(guardrailsPath, newGuardrailsMd, "utf-8");
  } catch (e) {
    fail(`writing project.md failed: ${errorMessage(e)}`);
    return;
  }
  try {
    writeFileSync(teamMdPath, newTeamMd, "utf-8");
  } catch (e) {
    fail(
      `writing team.md failed AFTER project.md was written: ${errorMessage(e)}`
    );
    return;
  }

  // Step 7: Emit PRACTICES_AFFIRMED and record the matching state timestamp in
  // one audit-locked transaction. The promotion tool owns both facts; leaving a
  // follow-up generic `set` to stage prose would let the timestamp be omitted or
  // forged independently of a successful promotion.
  let affirmedAt = "";
  try {
    withAuditLock(pd, () => {
      let state = readStateFile(pd);
      affirmedAt = emitAudit(pd, "PRACTICES_AFFIRMED", {
        "Affirming User": flags["affirming-user"] ?? "unknown",
        "Sections Written": sectionsWritten.join(", "),
        "Mandated Rules Appended": String(rulesAppended.mandated),
        "Forbidden Rules Appended": String(rulesAppended.forbidden),
      });
      // setOrInsertField, not setField: on a state file missing the row (a
      // hand-edited or pre-field file) setField silently no-ops, and the
      // approve gate that requires this timestamp would then refuse forever
      // while its remediation ("run practices-promote") keeps no-opping.
      state = setOrInsertField(
        state,
        "## Project Information",
        "Practices Affirmed Timestamp",
        affirmedAt,
      );
      state = setField(state, "Last Updated", affirmedAt);
      writeStateFile(pd, state);
    });
  } catch (e) {
    fail(
      `audit/state commit failed AFTER both files were written: ${errorMessage(e)}`
    );
    return;
  }

  console.log(
    JSON.stringify({
      emitted: "PRACTICES_AFFIRMED",
      sections_written: sectionsWritten,
      mandated_appended: rulesAppended.mandated,
      forbidden_appended: rulesAppended.forbidden,
      affirmed_at: affirmedAt,
      team_md: teamMdPath,
      project_guardrails: guardrailsPath,
    })
  );
}

// reuse-artifact <slug> --decision <keep|modify|redo> --artifacts <csv>
//   [--repo <repo>] [--single]
function handleReuseArtifact(args: string[]): void {
  if (args.length < 1)
    error("Usage: aidlc-state.ts reuse-artifact <slug> --decision <keep|modify|redo> --artifacts <csv> [--repo <repo>] [--single]");
  const slug = args[0];
  const rest = args.slice(1);
  const decision = getFlagValue(rest, "--decision");
  const artifacts = getFlagValue(rest, "--artifacts");
  const repo = getFlagValue(rest, "--repo");
  const singleRun = rest.includes("--single");
  if (!decision) error("Missing --decision <keep|modify|redo>");
  if (!artifacts) error("Missing --artifacts <csv>");

  if (!["keep", "modify", "redo"].includes(decision)) {
    error(`Invalid decision: ${decision}. Must be keep, modify, or redo.`);
  }

  // Validate stage exists in graph (adversarial finding C: reuse-artifact
  // was accepting any slug). This prevents orphan ARTIFACT_REUSED emissions
  // against non-existent stages.
  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);

  const pd = resolveProjectDir(projectDir);
  if (singleRun) {
    if (!singleStageAttemptIsOpen(pd, slug)) {
      error(
        `Cannot record isolated reuse for "${slug}": run next --stage ${slug} --single first.`,
      );
    }
    if (
      slug === "reverse-engineering" &&
      decision === "keep"
    ) {
      const repos = intentRepos(pd);
      if (repos.length > 0) {
        if (!repo) {
          error(
            `Cannot record isolated reverse-engineering reuse: this intent records repository identity; pass --repo <repo>.`,
          );
        }
        if (!repos.includes(repo)) {
          error(
            `Cannot record isolated reverse-engineering reuse: repo "${repo}" is not registered for this intent (${repos.join(", ")}).`,
          );
        }
      } else if (repo) {
        error(
          "Cannot record isolated reverse-engineering reuse: this intent has no registered repo identity; omit --repo.",
        );
      }
      const resolvedRepo = repo ?? codekbRepoName(pd);
      const expected = `${relativeCodekbDir(pd, resolvedRepo)}/`;
      if (artifacts.trim().replaceAll("\\", "/") !== expected) {
        error(
          `Cannot record isolated reverse-engineering reuse: --artifacts must be the exact current store ${expected}.`,
        );
      }
      if (!codekbStoreIsCurrent(pd, resolvedRepo)) {
        error(
          `Cannot record isolated reverse-engineering reuse for "${resolvedRepo}": the CodeKB store is not CURRENT. Rescan it instead.`,
        );
      }
      const artifactInspection = inspectRequiredArtifactInstances(
        pd,
        stage,
        { codekbRepos: [resolvedRepo] },
      );
      if (!artifactInspection.ok) {
        error(
          `Cannot record isolated reverse-engineering reuse for "${resolvedRepo}": ` +
            `the required CodeKB artifact set is incomplete or invalid (${artifactInspection.failures.map((failure) => failure.path).join(", ")}). Rescan it instead.`,
        );
      }
    }
  }

  try {
    const fields: Record<string, string> = {
      Stage: slug,
      Decision: decision,
      Artifacts: artifacts,
    };
    if (repo) fields.Repo = repo;
    if (singleRun) fields.Workflow = `single-stage:${slug}`;
    emitAudit(pd, "ARTIFACT_REUSED", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(JSON.stringify({
    slug,
    decision,
    artifacts,
    ...(repo ? { repo } : {}),
    ...(singleRun ? { single: true } : {}),
    emitted: "ARTIFACT_REUSED",
  }));
}

function handleLookup(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts lookup <subcommand> [args...]");
  const sub = args[0];
  const subArgs = args.slice(1);

  switch (sub) {
    case "phase-of": {
      if (subArgs.length < 1) error("Usage: lookup phase-of <slug>");
      const stage = resolveStage(subArgs[0]);
      if (!stage) error(`Unknown stage: ${subArgs[0]}`);
      console.log(stage.phase);
      break;
    }
    case "next-stage": {
      if (subArgs.length < 2) error("Usage: lookup next-stage <slug> <scope>");
      // Thread the live state file (when one exists) so the projection honours
      // per-stage suffix overrides (a recomposed plan) and [x]/[S] checkboxes,
      // matching the advance/finalize walks. A stateless workspace still
      // answers from the static grid (read-only either way).
      let stateForWalk: string | undefined;
      try {
        const pd = resolveProjectDir(projectDir);
        stateForWalk = readStateFile(pd);
      } catch {
        stateForWalk = undefined;
      }
      const next = nextInScopeStage(subArgs[0], subArgs[1], stateForWalk);
      console.log(next ? next.slug : "none");
      break;
    }
    case "agent-for": {
      if (subArgs.length < 1) error("Usage: lookup agent-for <slug>");
      const stage = resolveStage(subArgs[0]);
      if (!stage) error(`Unknown stage: ${subArgs[0]}`);
      console.log(stage.lead_agent);
      break;
    }
    case "number-of": {
      if (subArgs.length < 1) error("Usage: lookup number-of <slug>");
      const stage = resolveStage(subArgs[0]);
      if (!stage) error(`Unknown stage: ${subArgs[0]}`);
      console.log(stage.number);
      break;
    }
    case "stages-in-scope": {
      if (subArgs.length < 1) error("Usage: lookup stages-in-scope <scope>");
      const stages = stagesInScope(subArgs[0]);
      if (stages.length === 0) error(`Unknown scope: ${subArgs[0]}`);
      console.log(JSON.stringify(stages));
      break;
    }
    case "first-in-phase": {
      if (subArgs.length < 2) error("Usage: lookup first-in-phase <phase> <scope>");
      const stage = firstInScopeStageOfPhase(subArgs[0], subArgs[1]);
      console.log(stage ? stage.slug : "none");
      break;
    }
    case "validate-stage": {
      if (subArgs.length < 1) error("Usage: lookup validate-stage <slug-or-number>");
      const stage = resolveStage(subArgs[0]);
      if (!stage) {
        console.log(JSON.stringify({ valid: false, input: subArgs[0] }));
      } else {
        console.log(
          JSON.stringify({
            valid: true,
            slug: stage.slug,
            number: stage.number,
            name: stage.name,
            phase: stage.phase,
            lead_agent: stage.lead_agent,
          })
        );
      }
      break;
    }
    case "validate-phase": {
      if (subArgs.length < 1) error("Usage: lookup validate-phase <phase-or-number>");
      const input = subArgs[0].toLowerCase();
      const phase =
        PHASE_NUMBERS[input] ||
        ((PHASES as readonly string[]).includes(input) ? input : null);
      if (!phase) {
        console.log(JSON.stringify({ valid: false, input: subArgs[0] }));
      } else {
        const phaseNumber = Object.entries(PHASE_NUMBERS).find(([_, v]) => v === phase)?.[0];
        console.log(
          JSON.stringify({
            valid: true,
            canonical: phase,
            number: phaseNumber,
            display: phase.toUpperCase(),
          })
        );
      }
      break;
    }
    default:
      error(
        `Unknown lookup subcommand: ${sub}. Valid: phase-of, next-stage, agent-for, number-of, stages-in-scope, first-in-phase, validate-stage, validate-phase`
      );
  }
}

// --- State fork/merge ---
//
// Per-Bolt state isolation for Construction worktrees. fork copies main state
// to <worktreePath>/aidlc-docs/aidlc-state.md on Bolt start; merge copies it
// back on gate approval. Strict audit-first per docs/reference/12-state-machine.md
// — the audit-of-intent exception at line 322 is bounded to the three
// WORKTREE_* events because git worktree add has no idempotent re-run path
// under kill-9; state fork/merge are idempotent (re-reading and re-writing a
// file is repeatable), so strict audit-first applies.
//
// Conflict resolution by alphabetical-slug is defence-in-depth, not load-bearing:
// the v7 schema has workflow-level singletons, not per-(Bolt, stage) cells.
// Realistic per-Bolt contention is rare; main wins on workflow-level fields,
// alphabetical-slug only fires as a tiebreak on the artificial case of two
// worktrees flipping the same Construction Stage Progress cell to different
// values.
//
// (SLUG_RE, validateSlug, errorWithSlug, sha256, parseFlags are declared
// near the top of the file so main() can reach them — handlers live below.)

// fork --slug <slug> [--target-dir <path>]
//
// Forks main's aidlc-state.md to <worktreePath>/aidlc-docs/aidlc-state.md.
// Adds slug to main's Bolt Refs list. Decorative Worktree Path on the
// worktree-side state file (recoverable from cwd; debugging breadcrumb only).
function handleFork(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  const pd = resolveProjectDir(projectDir);

  // The space+intent selector pins this fork to ONE intent end-to-end (vision
  // §5): --intent <record> / --space <name> override the active cursor;
  // omitted -> default-resolution (the active cursor / lone intent). The SAME
  // selector threads main-side state/audit/lock AND the worktree mirror, and
  // MUST match what merge resolves so they touch one record.
  const selection = resolveWorkflowSelection(pd, {
    intent: flags.intent,
    space: flags.space,
  });
  const intent = selection.intent ?? undefined;
  const space = selection.space;
  requireLiveClaimForTeamUnit(pd, slug, {
    intent,
    space,
    walkingSkeletonMain: args.includes("--walking-skeleton-main"),
  });
  // recordPrefix is the worktree mirror's relative record dir (null -> the flat
  // legacy mirror, today's behaviour); wtRecord is the resolved record-dir NAME
  // the worktree state file lives under (null -> flat). Resolved on the MAIN
  // side so fork and merge pin to the same intent regardless of the worktree's
  // own cursor.
  const recordPrefix = relativeRecordDir(pd, intent, space);
  // Resolve the intent ONCE, here, BEFORE acquiring the lock. activeIntent maps
  // an omitted (--intent unset) selector to the active cursor / lone record, so
  // `resolvedIntent` is the SAME value the per-intent path helpers (readStateFile
  // / writeStateFile / auditFilePath) resolve internally. Threading the RAW
  // flags.intent to the lock instead would key the __workspace__ sentinel on the
  // omitted path while the writes target the resolved per-intent shard — LOCK !=
  // WRITE, the exact lost-update race the lock exists to prevent (a concurrent
  // explicit-intent op on the same shard would hold a DIFFERENT lock). So we use
  // `resolvedIntent` for the wrapping lock AND every main-side read/write/audit
  // below. `wtRecord` is the same value (kept as a distinct name for the
  // worktree-mirror write, whose null->flat semantics read clearer there).
  const resolvedIntent = selection.intent ?? undefined;
  const wtRecord = resolvedIntent;
  // Publish the resolved lock context so any errorWithSlug fired inside the
  // per-intent withAuditLock below routes ERROR_LOGGED to the bucket we hold
  // (see error()/emitError). Cleared after the transaction.
  lockIntent = resolvedIntent;
  lockSpace = space;

  // target-dir lets tests point fork at a fixture worktree-parent. Defaults
  // to the project's .aidlc/worktrees/bolt-<slug>/ via worktreePath().
  const wtPath = flags["target-dir"] ?? worktreePath(pd, slug);

  if (!existsSync(wtPath)) {
    errorWithSlug(slug, `worktree directory does not exist: ${wtPath}. Run aidlc-worktree create first.`);
  }

  // mkdir BEFORE acquiring the lock. A read-only-fs mkdir failure must not
  // leave a phantom STATE_FORKED row, and acquiring the lock for a doomed
  // operation just delays the failure.
  const wtDocsDir = worktreeDocsDir(wtPath, recordPrefix);
  try {
    mkdirSync(wtDocsDir, { recursive: true });
  } catch (e) {
    errorWithSlug(slug, `failed to create ${wtDocsDir}: ${errorMessage(e)}`);
  }

  // Hold the audit lock across the whole transaction so:
  //   - the dedup-check / emit / write are atomic against concurrent forks
  //     (no two forks for the same slug can both pass the dedup check);
  //   - the audit row only emits when we know the write will land cleanly
  //     (no phantom STATE_FORKED on duplicate-slug or stale-state failures);
  //   - process.exit() inside the body still releases the lock dir via
  //     withAuditLock's exit-handler safety net (Bun's process.exit skips
  //     `finally`, which would otherwise poison the project for ~5s).
  let srcSha: string;
  try {
    // Lock the SAME per-intent bucket the inner state/audit writes target
    // (resolvedIntent+space threaded), NOT the __workspace__ sentinel — without
    // this the transaction serializes every intent's fork on one workspace lock
    // (the P3 shared-lock cliff) and intent-create/migration would block unrelated
    // forks. resolvedIntent (not raw flags.intent) makes LOCK == WRITE even when
    // --intent is omitted (both resolve to the active record).
    srcSha = withAuditLock(pd, () => {
    let mainContent: string;
    try {
      mainContent = readStateFile(pd, resolvedIntent, space);
    } catch (e) {
      errorWithSlug(slug, `failed to read main state: ${errorMessage(e)}`);
      return ""; // unreachable
    }
    const sha = sha256(mainContent);

    // Dedup BEFORE emit: if the slug is already in Bolt Refs, fail without
    // emitting a phantom audit row. Recovery from a stale ref entry is the
    // caller's responsibility (see SKILL.md Step 0.6 recovery seam — discard
    // + re-fork is supported because the next fork sees the slug already
    // present and exits without poisoning audit).
    const currentRefs = getField(mainContent, "Bolt Refs") ?? "";
    if (parseRefsList(currentRefs).includes(slug)) {
      errorWithSlug(slug, `slug already in Bolt Refs (current: ${currentRefs.trim()}). If a prior fork failed mid-operation, run 'aidlc-worktree discard --slug ${slug}' and 'aidlc-state.ts merge --slug ${slug}' (which will exit "already merged" cleanly) or remove the stale entry from main state, then retry.`);
    }

    // Append slug to main's Bolt Refs first (the side effect that "registers"
    // the fork). If this fails, no audit, no worktree state — clean recovery.
    let mainNow = mainContent;
    try {
      mainNow = setFieldStrict(mainNow, "Bolt Refs", appendSlug(currentRefs, slug));
    } catch (e) {
      errorWithSlug(slug, `failed to compute updated Bolt Refs: ${errorMessage(e)}`);
    }

    // Audit-first within the locked critical section. Use the unlocked
    // variant since we already hold the lock.
    try {
      appendAuditEntryUnlocked("STATE_FORKED", {
        "Bolt slug": slug,
        "Worktree path": relative(pd, wtPath).replaceAll("\\", "/"),
        "Source state hash": sha,
        "Target state hash": sha, // fork = byte-identical copy
        ...claimAttemptFields(pd, slug),
      }, pd, resolvedIntent, space);
    } catch (e) {
      errorWithSlug(slug, `audit emission failed: ${errorMessage(e)}`);
    }

    // Write main state with updated Bolt Refs.
    try {
      writeStateFile(pd, mainNow, resolvedIntent, space);
    } catch (e) {
      errorWithSlug(slug, `failed to write main state with updated Bolt Refs: ${errorMessage(e)}`);
    }

    // Write worktree state with the decorative Worktree Path breadcrumb.
    // Done last so a write failure here leaves a recoverable surface: main's
    // Bolt Refs has the slug, audit has the row, but the worktree's state
    // file is missing — doctor reconciles by checking
    // `<worktreePath>/aidlc-docs/aidlc-state.md` existence against Bolt Refs.
    let wtContent = mainContent;
    try {
      wtContent = setFieldStrict(wtContent, "Worktree Path", relative(pd, wtPath).replaceAll("\\", "/"));
    } catch (e) {
      errorWithSlug(slug, `failed to set Worktree Path on worktree state: ${errorMessage(e)}`);
    }
    try {
      // The worktree mirror lives under the SAME record (wtRecord/space) the
      // main side resolved — NOT the worktree's own cursor — so fork and merge
      // read/write one file. wtRecord===undefined -> the flat legacy mirror.
      writeStateFile(wtPath, wtContent, wtRecord, space);
      const scopeStamp = readUnitScopeStamp(pd);
      if (scopeStamp) writeUnitScopeStamp(wtPath, scopeStamp);
    } catch (e) {
      errorWithSlug(slug, `failed to write worktree state at ${wtPath}: ${errorMessage(e)}`);
    }

    return sha;
    }, resolvedIntent, space);
  } catch (e) {
    // Slug-tag any error from the locked block (most commonly: lock-acquire
    // timeout when a peer tool holds the lock across the retry budget).
    errorWithSlug(slug, errorMessage(e));
    return; // unreachable
  }
  // Transaction done — clear the lock context so any subsequent sentinel-locked
  // emit in this process keys the sentinel, not a stale per-intent bucket.
  lockIntent = undefined;
  lockSpace = undefined;

  process.stdout.write(
    `${JSON.stringify({
      status: "forked",
      slug,
      worktree_path: wtPath,
      source_state_hash: srcSha,
    })}\n`
  );
}

// merge --slug <slug> [--target-dir <path>]
//
// Merges <worktreePath>/aidlc-docs/aidlc-state.md back to main. Workflow-level
// singletons are kept from main (untouched); Construction Stage Progress cells
// merge from the worktree; alphabetical-slug tiebreak as defence-in-depth.
// Idempotent: re-running for an already-merged slug exits non-zero with a
// clear "already merged" error and emits no second STATE_MERGED row.
function handleMerge(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  const pd = resolveProjectDir(projectDir);

  // Same selector the fork used -> the SAME intent record on both ends (vision
  // §5). recordPrefix pins the worktree mirror; wtRecord is its record-dir NAME.
  const selection = resolveWorkflowSelection(pd, {
    intent: flags.intent,
    space: flags.space,
  });
  const intent = selection.intent ?? undefined;
  const space = selection.space;
  requireLiveClaimForTeamUnit(pd, slug, {
    intent,
    space,
    walkingSkeletonMain: args.includes("--walking-skeleton-main"),
  });
  const recordPrefix = relativeRecordDir(pd, intent, space);
  // Resolve the intent ONCE before locking (same rationale as handleFork):
  // activeIntent maps an omitted selector to the active record, so resolvedIntent
  // == the value the per-intent path helpers resolve internally. Threading it to
  // the wrapping lock AND every main-side read/write/audit makes LOCK == WRITE
  // even when --intent is omitted; raw flags.intent would key the sentinel while
  // the writes hit the per-intent shard (lost-update race). wtRecord is the same
  // value, named for the worktree-mirror read where null->flat reads clearer.
  const resolvedIntent = selection.intent ?? undefined;
  const wtRecord = resolvedIntent;
  // Publish the lock context for the in-transaction error path (see error()).
  lockIntent = resolvedIntent;
  lockSpace = space;

  const wtPath = flags["target-dir"] ?? worktreePath(pd, slug);
  if (!existsSync(wtPath)) {
    errorWithSlug(slug, `worktree directory does not exist: ${wtPath}.`);
  }
  const wtStatePath = worktreeStateFilePath(wtPath, recordPrefix);
  if (!existsSync(wtStatePath)) {
    errorWithSlug(slug, `worktree state file does not exist: ${wtStatePath}. Was fork run?`);
  }

  // Read worktree state outside the lock — its file isn't shared with peers
  // (each Bolt owns its own worktree state file), so it doesn't need the
  // audit lock for consistency. Read the SAME record the fork wrote.
  const wtContent = readStateFile(wtPath, wtRecord, space);
  const wtSha = sha256(wtContent);
  const wtCheckboxes = parseCheckboxes(wtContent);

  // Hold the audit lock across the entire decide-emit-write transaction so
  // conflict-resolution decisions, the audit Target state hash, and the
  // actual main state write are all consistent with the SAME view of main.
  // Without this, a third concurrent merge landing between our snapshot and
  // our write would cause: (a) the audit Target hash to disagree with the
  // actual post-write SHA, (b) stale Bolt Refs being used to compute the
  // alphabetical tiebreak, and (c) one merge clobbering another's writes.
  let result: { postMergeSha: string; conflictResolutionField: string };
  try {
    // Lock the per-intent bucket (resolvedIntent+space threaded) the inner
    // writes target — same fix as handleFork: the __workspace__ sentinel would
    // serialize all intents' merges and let intent-create block an unrelated
    // merge (P3 shared-lock cliff). resolvedIntent (not raw flags.intent) makes
    // LOCK == WRITE on the omitted-intent path.
    result = withAuditLock(pd, () => {
    const mainContent = readStateFile(pd, resolvedIntent, space);

    // Idempotency: if slug is not in main's Bolt Refs, this is a re-run after
    // a prior successful merge (or a never-forked slug). Either way, no work
    // to do; emit no second audit row.
    const currentRefs = getField(mainContent, "Bolt Refs") ?? "";
    const refsList = parseRefsList(currentRefs);
    if (!refsList.includes(slug)) {
      errorWithSlug(slug, `already merged: not in Bolt Refs (current: ${currentRefs.trim()})`);
    }

    // Per-field merge rule, computed against the LOCKED snapshot:
    //  - Workflow-level singletons (Project, Project Type, Scope, Start Date,
    //    State Version, Active Agent, Practices Affirmed Timestamp): main
    //    wins. These come straight from `mainContent` untouched.
    //  - Construction Stage Progress checkboxes: take the worktree's value
    //    when the worktree advanced past main's, IF this slug is the
    //    alphabetically-lowest active ref. Workflow-level fields stay from
    //    main automatically because we start from mainContent and only
    //    overwrite the per-stage cells.
    //  - Tiebreak (alphabetical-slug, defence-in-depth): if multiple slugs
    //    in Bolt Refs would compete for the same cell, the lower
    //    alphabetical slug wins.
    let merged = mainContent;
    const conflictResolution: string[] = [];
    const mainCheckboxes = parseCheckboxes(mainContent);
    const mainStateMap = new Map(mainCheckboxes.map((c) => [c.slug, c.state]));
    const candidateSlugs = [...refsList].sort();
    const winningSlug = candidateSlugs[0];

    for (const wtCb of wtCheckboxes) {
      const mainCbState = mainStateMap.get(wtCb.slug);
      if (!mainCbState) continue;
      if (mainCbState === wtCb.state) continue;

      if (winningSlug === slug) {
        merged = setCheckbox(merged, wtCb.slug, wtCb.state);
        if (refsList.length > 1) {
          conflictResolution.push(`${wtCb.slug}:slug-precedence:${slug}`);
        }
      } else {
        conflictResolution.push(`${wtCb.slug}:deferred-to:${winningSlug}`);
      }
    }

    // Remove slug from Bolt Refs.
    merged = setFieldStrict(merged, "Bolt Refs", removeSlug(currentRefs, slug));

    const conflictResolutionField =
      conflictResolution.length === 0 ? "clean" : conflictResolution.join("; ");
    // Target hash matches the actual post-write content — computed inside the
    // lock against the final `merged` value so doctor can verify by
    // re-hashing the file at observation time.
    const postMergeSha = sha256(merged);

    // Strict audit-first within the locked critical section.
    try {
      appendAuditEntryUnlocked("STATE_MERGED", {
        "Bolt slug": slug,
        "Worktree path": relative(pd, wtPath).replaceAll("\\", "/"),
        "Source state hash": wtSha,
        "Target state hash": postMergeSha,
        "Conflict resolution": conflictResolutionField,
      }, pd, resolvedIntent, space);
    } catch (e) {
      errorWithSlug(slug, `audit emission failed: ${errorMessage(e)}`);
    }

    writeStateFile(pd, merged, resolvedIntent, space);

    return { postMergeSha, conflictResolutionField };
    }, resolvedIntent, space);
  } catch (e) {
    // Slug-tag any error from the locked block (most commonly: lock-acquire
    // timeout when a peer tool holds the lock across the retry budget).
    errorWithSlug(slug, errorMessage(e));
    return; // unreachable
  }
  // Transaction done — clear the lock context (see handleFork).
  lockIntent = undefined;
  lockSpace = undefined;

  process.stdout.write(
    `${JSON.stringify({
      status: "merged",
      slug,
      worktree_path: wtPath,
      source_state_hash: wtSha,
      target_state_hash: result.postMergeSha,
      conflict_resolution: result.conflictResolutionField,
    })}\n`
  );
}

// --- Utility ---

function error(msg: string): never {
  // Honor module-level projectDir (set from --project-dir in main) so test
  // fixtures and explicit overrides propagate to ERROR_LOGGED.
  const pd = resolveProjectDir(projectDir);
  const command = `aidlc-state ${process.argv.slice(2).join(" ")}`.trim();
  // Thread the active per-intent lock context (set by fork/merge before their
  // per-intent withAuditLock) so emitError's holdsAuditLock probe keys the SAME
  // bucket the caller holds — lock==write on the in-transaction error path.
  // Unset (undefined) for every sentinel-locked handler -> emitError keys the
  // sentinel, matching their lock.
  emitError(pd, "aidlc-state", command, msg, lockIntent, lockSpace);
}
