import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  activeIntent,
  appendSlug,
  appendUnderHeading,
  auditBlockField,
  type CheckboxState,
  codekbDir,
  countCheckboxes,
  emitError,
  errorMessage,
  extractMarkdownSection,
  filterProducesByKind,
  findStageBySlug,
  findAllEvents,
  firstInScopeStageOfPhase,
  getField,
  holdsAuditLock,
  humanActedSinceGate,
  humanPresenceGuardDisabled,
  intentRepos,
  isAutonomousMode,
  isoTimestamp,
  loadScopeMapping,
  nextInScopeStage,
  PHASE_NUMBERS,
  PHASES,
  parseCheckboxes,
  parseRefsList,
  parseStateStageSuffixes,
  readAllAuditShards,
  readStateFile,
  recordDir,
  relativeMemoryPath,
  relativeRecordDir,
  removeField,
  removeSlug,
  replaceSection,
  resolveBoltDag,
  resolveProjectDir,
  resolveStage,
  setCheckbox,
  setField,
  setFieldStrict,
  setOrInsertField,
  setPhaseProgress,
  stagesInScope,
  swarmConvergedUnits,
  updateIntentStatus,
  validScopes,
  withAuditLock,
  worktreeDocsDir,
  worktreePath,
  worktreeStateFilePath,
  writeStateFile,
} from "./aidlc-lib.js";
import { memoryDirFor } from "./aidlc-graph.ts";

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
  ".git",
]);

// The codekb stages - their produces live in the space-level codekb dir, keyed
// by repo, NOT under a per-intent record dir. Mirrors KNOWN_CODEKB_STAGES in
// aidlc-orchestrate.ts (kept local because that set is not exported and the
// guard has no engine context at approve/advance time). reverse-engineering is
// the sole member; a future codekb stage joins both sets. Declared at module
// top (not beside verifyStageArtifacts) for the same TDZ reason as
// HARNESS_DOC_DIRS: the command dispatch runs at top level, so a const declared
// lower in the file would be in its temporal dead zone when the guard runs.
const KNOWN_CODEKB_STAGES: ReadonlySet<string> = new Set(["reverse-engineering"]);

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

// True when a written File path (from an ARTIFACT_CREATED/ARTIFACT_UPDATED audit
// row) is one of the stage's declared produces[] artifacts. Matches on the path
// SUFFIX `/<slug>/<name>.md` rather than resolving one absolute dir, so it
// covers BOTH the standard <record>/<phase>/<slug>/ layout AND the per-unit
// construction/<unit>/<slug>/ layout without needing to know the {unit}
// segment. Codekb stages get their own arm: their produces live DIRECTLY under
// a per-repo dir beneath the space codekb root (codekb/<repo>/<name>.md) with
// no <slug> segment anywhere, so the suffix idiom matches the codekb marker +
// one repo segment instead - the matcher analog of the placement split
// producesDirsForStage handles for the artifact guard. When the active intent
// records repos, that segment must belong to the recorded set so a write to one
// repo's durable codekb cannot revise an unrelated intent. The audit File field
// is stored forward-slash-normalised (aidlc-audit-logger.ts), so the
// forward-slash matching is harness-neutral; we still normalise defensively in
// case a caller passes a raw OS path.
function producesArtifactFile(
  stage: { slug: string; produces?: string[] },
  file: string,
  recordedRepos: ReadonlySet<string>
): boolean {
  const produces = stage.produces ?? [];
  if (produces.length === 0) return false;
  const norm = file.replace(/\\/g, "/");
  if (KNOWN_CODEKB_STAGES.has(stage.slug)) {
    return produces.some((name) => {
      const idx = norm.lastIndexOf(`/${name}.md`);
      if (idx === -1 || idx + `/${name}.md`.length !== norm.length) return false;
      // Exactly one <repo> segment between /codekb/ and /<name>.md.
      const head = norm.slice(0, idx);
      const repoSlash = head.lastIndexOf("/");
      if (repoSlash === -1 || !head.slice(0, repoSlash).endsWith("/codekb")) return false;
      const repo = head.slice(repoSlash + 1);
      if (repo.length === 0) return false;
      // An empty registry is the legacy projectDir-is-the-repo case. Keep the
      // historical any-repo match: codekbRepoName's basename is a write-path
      // default, not ownership evidence for durable files that may predate repo
      // recording or have been written with an explicit repo target.
      return recordedRepos.size === 0 || recordedRepos.has(repo);
    });
  }
  return produces.some((name) => norm.endsWith(`/${stage.slug}/${name}.md`));
}

// Resolve the unit targeted by a declared produces[] write. `undefined` means
// the file does not belong to this stage, `null` means a matching stage-level
// artifact, and a string names the per-unit Construction target.
function producesArtifactUnit(
  stage: {
    slug: string;
    for_each?: string;
    produces?: string[];
    optional_produces?: string[];
  },
  file: string,
  recordedRepos: ReadonlySet<string>,
): string | null | undefined {
  const reviewedArtifacts = [
    ...(stage.produces ?? []),
    ...(stage.optional_produces ?? []),
  ];
  if (
    !producesArtifactFile(
      { slug: stage.slug, produces: reviewedArtifacts },
      file,
      recordedRepos,
    )
  ) {
    return undefined;
  }
  if (stage.for_each !== "unit-of-work") return null;

  const norm = file.replace(/\\/g, "/");
  for (const name of reviewedArtifacts) {
    const suffix = `/${stage.slug}/${name}.md`;
    if (!norm.endsWith(suffix)) continue;
    const parent = norm.slice(0, -suffix.length);
    const marker = "/construction/";
    const markerIdx = parent.lastIndexOf(marker);
    if (markerIdx === -1) return null;
    const unit = parent.slice(markerIdx + marker.length);
    return unit.length > 0 && !unit.includes("/") ? unit : null;
  }
  return null;
}

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
// `## Review` section to the primary artifact BEFORE the human responds at the
// gate (stage-protocol.md §12a), firing an ARTIFACT_UPDATED on a produces file.
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

export function main(argv: string[]): void {
  const args = [...argv];

  // Extract --project-dir flag
  const pdIdx = args.indexOf("--project-dir");
  if (pdIdx !== -1 && pdIdx + 1 < args.length) {
    projectDir = args[pdIdx + 1];
    args.splice(pdIdx, 2);
  }

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
  ]);
  if (
    subcommand &&
    engineOwnedTransitions.has(subcommand) &&
    process.env.AIDLC_STATE_TRANSITION_OWNER !== `orchestrate:${process.ppid}` &&
    process.env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS !== "1"
  ) {
    error(
      `Direct aidlc-state.ts ${subcommand} is blocked: workflow lifecycle transitions are engine-owned. ` +
        "Use aidlc-orchestrate.ts report --stage <slug> --result " +
        "<awaiting-approval|approved|rejected|revised|completed|skipped>; use " +
        "aidlc-orchestrate.ts park to park, and next/jump for routing changes.",
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
      case "park":
        handlePark(args.slice(1));
        break;
      case "unpark":
        handleUnpark(args.slice(1));
        break;
      default:
        error(
          `Unknown subcommand: ${subcommand}. Valid: get, set, set-skeleton-stance, set-construction-iteration, checkbox, count, advance, finalize, complete-workflow, gate-start, approve, reject, revise, skip, resume, acknowledge-compaction, reuse-artifact, lookup, practices-event, practices-promote, fork, merge, park, unpark`
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

// set-construction-iteration <unit-major|stage-major>: record how construction
// design stages iterate over units. `Construction Iteration` is runtime metadata
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
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    if (getField(content, "Construction Autonomy Mode")?.trim() === "autonomous") {
      error(
        "Refusing to park: Construction Autonomy Mode is autonomous. An unattended " +
          "autonomous run has no human to resume it and must keep moving - do not park it.",
      );
    }
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
      Timestamp: timestamp,
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
  withAuditLock(pd, () => {
    let content = readStateFile(pd);
    const wasParked = (getField(content, "Parked") ?? "").trim().length > 0;
    // Remove both runtime markers (no-op if absent - unpark is idempotent).
    content = removeField(content, "Parked");
    content = removeField(content, "Parked At Stage");
    if (wasParked) {
      const ts = isoTimestamp();
      emitAudit(pd, "WORKFLOW_UNPARKED", { Timestamp: ts });
      content = setField(content, "Last Updated", ts);
    }
    writeStateFile(pd, content);
    console.log(JSON.stringify({ unparked: true, was_parked: wasParked }));
  });
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
// could rubber-stamp all 32 stages (gate-start->approve, or pure advance) with
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

// Settled-autonomous-swarm exemption, mirroring isSettledAutonomousSwarm in
// aidlc-orchestrate.ts (the report path's disk-backed-guard exemption). A
// swarm's per-unit artifacts live in Bolt worktrees, not the main checkout, so
// the produces-existence walk below cannot see them; the audit ledger can. The
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
): boolean {
  if (stage.phase !== "construction") return false;
  if (stage.for_each !== "unit-of-work" || stage.mode !== "subagent") return false;
  if (!isAutonomousMode(stateContent)) return false;
  const scope = getField(stateContent, "Scope");
  if (!scope) return false;
  const first = firstInScopeStageOfPhase("construction", scope);
  if (first !== null && first.slug === stage.slug) return false; // skeleton gate
  const resolution = resolveBoltDag(pd);
  if (resolution.state !== "ok" || resolution.units.length === 0) return false;
  // Shared attempt-scoped read (aidlc-lib.ts): a row counts only when its
  // Stage names this slug AND its Run floor equals the current attempt's
  // floor, so stale-attempt and cross-stage rows never satisfy the guard.
  const converged = swarmConvergedUnits(pd, stage.slug);
  return resolution.units.every((unit) => converged.has(unit));
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
//   - codekb (reverse-engineering): the produces live DIRECTLY under each repo
//     dir beneath the space-level codekb root (no <slug> subdir - see the codekb
//     arm of resolveArtifactPath). We glob every repo dir under the codekb root.
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
    // codekbDir(pd, "<repo>") is `<pd>/aidlc/spaces/<space>/codekb/<repo>`; its
    // parent is the codekb root we glob. Built off the seam so the path is not
    // re-hardcoded here.
    const codekbRoot = join(codekbDir(pd, "_"), "..");
    if (!existsSync(codekbRoot)) return [];
    const dirs: string[] = [];
    for (const repo of readdirSync(codekbRoot)) {
      const d = join(codekbRoot, repo);
      try {
        if (statSync(d).isDirectory()) dirs.push(d);
      } catch {
        /* unreadable entry - skip */
      }
    }
    return dirs;
  }
  const rec = recordDir(pd);
  if (rec === null) return [];
  const perUnit = stage.for_each === "unit-of-work";
  if (perUnit) {
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
  for (const dir of producesDirsForStage(pd, stage)) {
    for (const name of produces) {
      if (existsSync(join(dir, `${name}.md`))) return true;
    }
  }
  return false;
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
  stage: { slug: string; name: string; phase: string; for_each?: string; mode?: string; produces?: string[]; produces_kinds?: Record<string, string[]>; workspace_requires?: boolean }
): void {
  if (artifactGuardDisabled()) return;

  // A settled autonomous swarm proved its work through the referee's per-unit
  // convergence ledger; its artifacts live in Bolt worktrees this walk cannot
  // see. Same exemption the engine's report-side evidence gate applies.
  let settledSwarm = false;
  try {
    settledSwarm = isSettledSwarmForArtifactGuard(pd, stage, readStateFile(pd));
  } catch {
    // No readable state file: not a swarm settle; stay strict.
  }
  if (settledSwarm) return;

  if (!producesArtifactsExist(pd, stage)) {
    error(
      `Refusing to complete "${stage.slug}": none of its declared artifacts exist ` +
        `under the intent's record directory. The stage protocol requires ${stage.name} ` +
        `to produce output before the gate. Produce the artifacts before completing. ` +
        `(declared: ${(stage.produces ?? []).join(", ") || "none"})`
    );
  }

  if (stage.workspace_requires && !workspaceHasWork(pd)) {
    error(
      `Refusing to complete "${stage.slug}": it is a code-producing stage ` +
        `(workspace_requires) but no source work is evident outside the aidlc/ ` +
        `workspace tree. In a git workspace this means no uncommitted change and no ` +
        `code in the last commit; otherwise no source file exists. Planning docs alone ` +
        `do not satisfy ${stage.name} - write the code to the workspace.`
    );
  }
}

// --- Reviewer precondition (§12a / RFC Track 1) -----------------------------
//
// A stage that declares a `reviewer` cannot be approved until the reviewer step
// actually ran — proven by a terminal REVIEW_COMPLETED row (written by the tool
// actor `aidlc-log.ts review --verdict`). Hard on the review HAVING HAPPENED,
// soft on the verdict (a NOT-READY-after-cap still lets the human approve).
//
// This lives beside the artifact guard in all four completing handlers, not in
// orchestrate's report: direct recovery calls must not bypass it (issue #366).
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
// reviewer fires once PER UNIT, so EVERY unit must carry its own terminal review.
//
function verifyReviewerPrecondition(
  pd: string,
  content: string,
  stage: {
    slug: string;
    name: string;
    phase: string;
    for_each?: string;
    reviewer?: string;
    produces?: string[];
    optional_produces?: string[];
    produces_kinds?: Record<string, string[]>;
  }
): void {
  if (!stage.reviewer) return; // stage declares no reviewer — nothing to enforce

  const reviewer = stage.reviewer;
  const audit = readAllAuditShards(pd);
  if (audit.length === 0) {
    reviewerPreconditionError(stage.slug, reviewer);
  }

  // Build ONE position-tiebroken event stream (the same interleave idiom
  // unrecordedRevisionSinceGateOpen uses) — a timestamp-only floor is unsafe
  // because isoTimestamp() is second-precision, so a review and the reject that
  // should invalidate it can share a timestamp and a `<` compare would keep the
  // stale review. Ordering by (timestamp, buffer position) breaks that tie.
  const RELEVANT = new Set([
    "WORKFLOW_STARTED",
    "STAGE_STARTED",
    "STAGE_JUMPED",
    "GATE_REJECTED",
    "ARTIFACT_CREATED",
    "ARTIFACT_UPDATED",
    "REVIEW_COMPLETED",
  ]);
  const blocks = audit.replace(/\r\n/g, "\n").split(/\n---\n/);
  const events: { pos: number; ts: string; event: string; block: string }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const ev = auditBlockField(blocks[i], "Event");
    if (!ev || !RELEVANT.has(ev)) continue;
    events.push({ pos: i, ts: auditBlockField(blocks[i], "Timestamp") ?? "", event: ev, block: blocks[i] });
  }
  events.sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.pos - b.pos));

  const perUnit = stage.for_each === "unit-of-work";
  const unitMajor =
    perUnit && getField(content, "Construction Iteration")?.trim() === "unit-major";

  // Unit-major may author a later stage's per-unit artifacts before that
  // stage's STAGE_STARTED row exists. Its attempt floor therefore uses the
  // current workflow, jumps, and gate rejections but ignores STAGE_STARTED.
  // Stage-major and non-per-unit flows additionally floor at STAGE_STARTED.
  //
  // WORKFLOW_STARTED and STAGE_JUMPED floor deliberately stage-AGNOSTIC: any
  // jump invalidates every stage's reviews, including stages the jump never
  // re-opens. That over-invalidation is harmless (a stage that stays [x] never
  // re-completes, so its stale floor is never consulted) and it is what closes
  // the redo-jump hole: a backward jump re-opens stages WITHOUT emitting their
  // GATE_REJECTED or (until re-entry) STAGE_STARTED, so a stage-scoped floor
  // would accept the prior attempt's reviews. Fail-closed over precise.
  let floorIdx = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.event === "WORKFLOW_STARTED" || e.event === "STAGE_JUMPED") {
      floorIdx = i;
      continue;
    }
    if (auditBlockField(e.block, "Stage") !== stage.slug) continue;
    if (e.event === "STAGE_STARTED" && !unitMajor) {
      if (auditBlockField(e.block, "Workflow")?.startsWith("single-stage:")) continue;
      floorIdx = i;
    } else if (e.event === "GATE_REJECTED") {
      floorIdx = i;
    }
  }

  // Collect fresh matching terminal reviews after the attempt floor. A later
  // declared-artifact write clears the matching receipt. For per-unit stages,
  // the path's construction/<unit>/ segment scopes invalidation to that unit;
  // an ambiguous matching path fails closed by clearing every unit receipt.
  const recordedRepos = new Set(intentRepos(pd));
  const reviewedUnits = new Set<string>();
  let sawStageReview = false;
  for (let i = floorIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.event === "ARTIFACT_CREATED" || e.event === "ARTIFACT_UPDATED") {
      const file = auditBlockField(e.block, "File");
      if (!file) continue;
      const targetUnit = producesArtifactUnit(stage, file, recordedRepos);
      if (targetUnit === undefined) continue;
      if (!perUnit) {
        sawStageReview = false;
      } else if (targetUnit === null) {
        reviewedUnits.clear();
      } else {
        reviewedUnits.delete(targetUnit);
      }
      continue;
    }
    if (e.event !== "REVIEW_COMPLETED") continue;
    if (auditBlockField(e.block, "Workflow")?.startsWith("single-stage:")) continue;
    if (auditBlockField(e.block, "Stage") !== stage.slug) continue;
    if (auditBlockField(e.block, "Reviewer") !== reviewer) continue;
    const verdict = auditBlockField(e.block, "Verdict");
    if (verdict !== "READY" && verdict !== "NOT-READY") continue;
    sawStageReview = true;
    const unit = auditBlockField(e.block, "Unit");
    if (unit) reviewedUnits.add(unit);
  }

  if (!perUnit) {
    if (!sawStageReview) reviewerPreconditionError(stage.slug, reviewer);
    return;
  }

  const resolution = resolveBoltDag(pd);
  if (resolution.state === "malformed") {
    error(
      `Refusing to complete "${stage.slug}": its per-unit review set cannot be ` +
        `resolved because unit-of-work-dependency.md is ${resolution.reason} ` +
        `(${resolution.detail}). Fix the fenced units block before completing.`,
    );
  }
  if (resolution.state === "none" || resolution.units.length === 0) {
    if (!sawStageReview) reviewerPreconditionError(stage.slug, reviewer);
    return;
  }

  // A kind-pruned unit with no applicable produces[] never receives a stage
  // directive, so it cannot owe a review. If every unit is vacuous, no
  // stage-level fallback review is required.
  const produces = stage.produces ?? [];
  const reviewUnits = resolution.units.filter(
    (unit) =>
      filterProducesByKind(
        stage.produces_kinds,
        produces,
        resolution.unitKinds?.get(unit) ?? null,
      ).length > 0,
  );
  if (reviewUnits.length === 0) return;

  const missing = reviewUnits.filter((u) => !reviewedUnits.has(u));
  if (missing.length > 0) {
    error(
      `Refusing to complete "${stage.slug}": it declares a reviewer (${reviewer}) but ` +
        `${missing.length} of ${reviewUnits.length} applicable units have no fresh recorded ` +
        `review (${missing.join(", ")}). The reviewer fires once per unit; record ` +
        `each with \`aidlc-log.ts review --stage ${stage.slug} --unit <unit> --reviewer ` +
        `${reviewer} --verdict <READY|NOT-READY>\` before approving.`
    );
  }
}

function reviewerPreconditionError(slug: string, reviewer: string): never {
  error(
    `Refusing to complete "${slug}": it declares a reviewer (${reviewer}) but no ` +
      `fresh REVIEW_COMPLETED is recorded for it. Invoke the reviewer ` +
      `(stage-protocol §12a) and record the verdict with \`aidlc-log.ts review --stage ` +
      `${slug} --reviewer ${reviewer} --verdict <READY|NOT-READY>\` before completing.`
  );
}

function handleAdvance(args: string[]): void {
  // Keep only the positional <completed-slug> [<next-slug>]; any flags are
  // filtered out so they are not misread as the next slug.
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length < 1)
    error("Usage: aidlc-state.ts advance <completed-slug> [<next-slug>]");
  const completedSlug = positional[0];

  const pd = resolveProjectDir(projectDir);
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

  // Artifact guard (issue #366). Only enforce when THIS advance is the
  // transition that completes the stage - i.e. it was not already [x]. When
  // approve delegates here the slug is already [x] and approve ran the guard
  // itself, so skip to avoid a double check. A direct `advance <active-slug>`
  // (the gate-skipping attack path) is NOT alreadyMarkedCompleted, so it is
  // guarded. Runs before any mutation; error() exits leaving state untouched.
  if (!alreadyMarkedCompleted) {
    verifyStageArtifacts(pd, completedStage);
    verifyReviewerPrecondition(pd, content, completedStage);
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
  // the checkboxes), but without the flip the section holds its birth values
  // forever and contradicts the checkboxes underneath it.
  if (crossesPhaseBoundary) {
    content = setPhaseProgress(content, completedStage.phase, "Verified");
    content = setPhaseProgress(content, nextStage.phase, "Active");
  }

  // 4. Atomic audit emission — audit-first, then state write.
  // If audit fails, throw before touching state (writeStateFile below is skipped).
  try {
    // Emit STAGE_COMPLETED only if approve didn't already emit it.
    if (!alreadyMarkedCompleted || !stageCompletedAlreadyAudited) {
      emitAudit(pd, "STAGE_COMPLETED", {
        Stage: completedSlug,
        Details: `Stage ${completedStage.name} completed`,
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
  if (!alreadyMarkedCompleted) {
    verifyStageArtifacts(pd, completedStage);
    verifyReviewerPrecondition(pd, content, completedStage);
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

function handleCompleteWorkflow(args: string[]): void {
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
  if (!alreadyMarkedCompleted) {
    verifyStageArtifacts(pd, completedStage);
    verifyReviewerPrecondition(pd, content, completedStage);
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
  try {
    if (!alreadyMarkedCompleted || !stageCompletedAlreadyAudited) {
      emitAudit(pd, "STAGE_COMPLETED", {
        Stage: completedSlug,
        Details: `Final stage ${completedStage.name} completed`,
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
  const completedIntentDir = activeIntent(pd);
  if (completedIntentDir) updateIntentStatus(pd, completedIntentDir, "complete");
  console.log(
    JSON.stringify({
      completed: completedSlug,
      completed_count: completedCount,
      status: "Completed",
      reason: reason || null,
      timestamp,
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

// gate-start <slug> — transition [-] → [?], emit STAGE_AWAITING_APPROVAL.
// --recovered marks a BACKFILLED gate row (the engine opening a gate the
// conductor skipped, e.g. report's explicit-stage recovery) with
// Recovered=true so audit consumers can tell backfills from organic opens.
function handleGateStart(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts gate-start <slug> [--artifacts <csv>] [--recovered]");
  const slug = args[0];
  let artifacts: string | undefined;
  const artifactsIdx = args.indexOf("--artifacts");
  if (artifactsIdx !== -1 && artifactsIdx + 1 < args.length) {
    artifacts = args[artifactsIdx + 1];
  }
  const recovered = args.includes("--recovered");

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: validate→transition→emit-audit→write under one
  // lock (the state-precondition check and the write see one snapshot).
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  validateSlugInState(content, slug, "in-progress");
  verifyStageArtifacts(pd, stage);

  content = setCheckbox(content, slug, "awaiting-approval");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    const fields: Record<string, string> = { Stage: slug };
    if (artifacts) fields.Artifacts = artifacts;
    if (recovered) fields.Recovered = "true";
    emitAudit(pd, "STAGE_AWAITING_APPROVAL", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ slug, new_state: "awaiting-approval", timestamp }));
  });
}

// approve <slug> [--user-input <text>]
// Transition: [?] → [x] AND auto-advance to the next in-scope stage (or
// complete the workflow if this was the final stage). Human judgment ends
// at the gate response; everything after is deterministic bookkeeping, so
// approve owns it end-to-end. Emits GATE_APPROVED + STAGE_COMPLETED, then
// delegates to handleAdvance or handleCompleteWorkflow for the remaining
// transitions. Eliminates the t59-class bug where the orchestrator approved
// but forgot to call advance, leaving Current Stage pointing at a [x] slug.
function handleApprove(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts approve <slug> [--user-input <text>]");
  const slug = args[0];
  const { userInput } = parseApproveFlags(args.slice(1));

  const pd = resolveProjectDir(projectDir);
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
  validateSlugInState(content, slug, "awaiting-approval");
  const approvalInput = userInput?.trim();
  if (
    !isAutonomousMode(content) &&
    !humanPresenceGuardDisabled() &&
    !approvalInput
  ) {
    error(
      `Refusing to approve "${slug}": --user-input must contain the human's exact approval choice.`,
    );
  }

  // Artifact guard (issue #366): a stage cannot be approved without evidence of
  // work on disk. Runs BEFORE any mutation so a refusal (error() -> exit) leaves
  // state untouched. The nested handleAdvance / handleCompleteWorkflow below see
  // the slug as already [x] and skip their own guard, so this is the single
  // enforcement point on the approve path. Bypass via AIDLC_SKIP_ARTIFACT_GUARD.
  // Covers per-unit Construction stages (globs the record's
  // construction/<unit>/<slug>/) and code-producing stages (workspace_requires).
  verifyStageArtifacts(pd, stage);

  // Human-presence guard: a gate cannot be approved unless a real
  // human acted at THIS gate since the last gate resolution. Runs BEFORE any
  // mutation so a refusal (error() -> exit) leaves state untouched (same slot
  // as the artifact guard above). Carve-outs FIRST: autonomous Construction
  // (swarm / Bolt) and the suite-wide test bypass never require presence.
  if (isAutonomousMode(content)) {
    // skip the presence check — autonomous Construction has no human at the gate
  } else if (humanPresenceGuardDisabled()) {
    // skip — suite-wide deterministic off-switch (AIDLC_SKIP_HUMAN_PRESENCE_GUARD)
  } else if (!humanActedSinceGate(pd)) {
    // Ledger-event presence check: refuse unless a HUMAN_TURN event was appended
    // AFTER the last gate resolution (GATE_APPROVED / GATE_REJECTED /
    // QUESTION_ANSWERED) in ledger order - the boundary is the prior resolution,
    // NOT this gate's open event (one human turn drives both open and approve).
    // Cascade-safety + freshness fall out of order; no marker file / turn counter.
    error(
      `Refusing to approve "${slug}": a real human has not acted at this gate ` +
        `since it opened. The approval gate requires a typed human turn before it ` +
        `can commit. Acknowledge the gate as a human, then approve. (autonomous ` +
        `Construction is exempt)`
    );
  }

  // Gate-revision backstop: reconcile a revision the conductor performed at an
  // open gate but never recorded (it skipped the `reject` verb). When the ledger
  // proves the human revised this stage's artifact at the open gate with no
  // recorded reject (unrecordedRevisionSinceGateOpen), backfill the missing
  // GATE_REJECTED + STAGE_REVISING pair (tagged Recovered) and re-open the gate,
  // then fall through to the normal approve below. RECONCILIATION, never refusal:
  // a forced retroactive reject would consume the human-presence freshness
  // boundary (the HUMAN_TURN this gate's approval depends on) and refuse the
  // approval the human already gave, so we record the missing history and honour
  // the approval unless another completion precondition refuses it. The
  // intermediate [R] checkbox never hits disk; a reviewer refusal persists the
  // incremented revision count while leaving the gate at its existing [?].
  // Skipped under the off-switch and in autonomous Construction (no human at the
  // gate, so no human-driven revision to reconcile).
  let recoveredRevision = false;
  if (
    !revisionBackstopDisabled() &&
    !isAutonomousMode(content) &&
    unrecordedRevisionSinceGateOpen(pd, stage)
  ) {
    const priorCount = getField(content, "Revision Count");
    const priorParsed = priorCount ? parseInt(priorCount, 10) : 0;
    const revCount = (Number.isFinite(priorParsed) ? priorParsed : 0) + 1;
    content = setField(content, "Revision Count", String(revCount));
    // Audit-first: a failed emission aborts before any state write (matches the
    // GATE_APPROVED/STAGE_COMPLETED try/catch below).
    try {
      emitAudit(pd, "GATE_REJECTED", {
        Stage: slug,
        Recovered: "true",
        Details:
          "Backfilled by the revision backstop: the artifact was revised at " +
          "an open gate with no reject recorded",
      });
      emitAudit(pd, "STAGE_REVISING", {
        Stage: slug,
        "Revision count": String(revCount),
        Recovered: "true",
      });
      emitAudit(pd, "STAGE_AWAITING_APPROVAL", {
        Stage: slug,
        Recovered: "true",
        Details: "Re-entering gate after backfilled revision",
      });
      recoveredRevision = true;
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
  }

  // Run after the revision backstop: a recovered GATE_REJECTED invalidates the
  // receipt that preceded the unrecorded artifact revision. The backfilled audit
  // rows and revision count remain as the consistent reopened-gate state if
  // this check refuses.
  if (recoveredRevision) writeStateFile(pd, content);
  verifyReviewerPrecondition(pd, content, stage);

  const timestamp = isoTimestamp();

  content = setCheckbox(content, slug, "completed");
  content = setField(content, "Last Updated", timestamp);
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));
  content = setField(content, "Last Completed Stage", slug);

  // Atomic audit emissions (audit-first). GATE_APPROVED records the human
  // decision; STAGE_COMPLETED records the state transition the approval
  // implies. Both emit here so the audit trail is correct even if the
  // downstream advance/complete-workflow fails.
  try {
    const gateFields: Record<string, string> = { Stage: slug };
    if (approvalInput) gateFields["User Input"] = approvalInput;
    emitAudit(pd, "GATE_APPROVED", gateFields);

    emitAudit(pd, "STAGE_COMPLETED", {
      Stage: slug,
      Details: `Stage ${stage.name} approved by gate`,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);

  // Auto-advance or complete-workflow. Scope is required for next-stage
  // derivation; refuse silent fallback (matches handleAdvance/handleCompleteWorkflow).
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to advance after approve — fix the state file first.`
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

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
    handleAdvance([slug]);
  } else {
    // Final stage — complete the workflow. handleCompleteWorkflow re-sets
    // the checkbox to [x] (idempotent) and emits PHASE_COMPLETED +
    // PHASE_VERIFIED + WORKFLOW_COMPLETED. Reentrant call — see above.
    handleCompleteWorkflow([slug]);
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

// Flag parser for approve — handles --user-input (value).
function parseApproveFlags(args: string[]): { userInput?: string } {
  return {
    userInput: getFlagValue(args, "--user-input"),
  };
}

// reject <slug> [--feedback <text>] — transition [?] → [R], emit GATE_REJECTED + STAGE_REVISING, increment Revision Count.
// Also accepts [-]: gate-start is optional before the human prompt, so a
// rejection may arrive with no open gate. The reject self-heals by emitting
// the missing STAGE_AWAITING_APPROVAL (tagged Recovered=true) ahead of the
// rejection pair — mirroring report's approve-side gate backfill.
function handleReject(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts reject <slug> [--feedback <text>]");
  const slug = args[0];
  const feedback = getFlagValue(args.slice(1), "--feedback")?.trim();
  if (!feedback) {
    error(
      `Refusing to reject "${slug}": --feedback must contain the human's requested changes.`,
    );
  }

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
  validateSlugInState(content, slug, ["awaiting-approval", "in-progress"]);
  const gateWasMissing = getSlugState(content, slug) === "in-progress";

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
    if (gateWasMissing) {
      // Backfill the gate row the optional gate-start would have written, so
      // the audit trail keeps its STAGE_AWAITING_APPROVAL → GATE_REJECTED
      // order. The intermediate [?] never needs to hit disk — one state write
      // below lands the final [R].
      emitAudit(pd, "STAGE_AWAITING_APPROVAL", {
        Stage: slug,
        Recovered: "true",
      });
    }
    const rejFields: Record<string, string> = {
      Stage: slug,
      Feedback: feedback,
    };
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

// revise <slug> — transition [R] → [?] (re-enter gate after revision work)
function handleRevise(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts revise <slug>");
  const slug = args[0];

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: validate→transition→emit-audit→write under one lock.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  validateSlugInState(content, slug, "revising");
  verifyStageArtifacts(pd, stage);

  content = setCheckbox(content, slug, "awaiting-approval");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    emitAudit(pd, "STAGE_AWAITING_APPROVAL", {
      Stage: slug,
      Details: "Re-entering gate after revision",
    });
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
      emitAudit(pd, "STAGE_SKIPPED", { Stage: slug, Reason: reason });
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
        });
      }
    }
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  if (!nextStage) {
    const completedIntentDir = activeIntent(pd);
    if (completedIntentDir) {
      updateIntentStatus(pd, completedIntentDir, "complete");
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
        Timestamp: isoTimestamp(),
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
function handleReuseArtifact(args: string[]): void {
  if (args.length < 1)
    error("Usage: aidlc-state.ts reuse-artifact <slug> --decision <keep|modify|redo> --artifacts <csv>");
  const slug = args[0];
  const rest = args.slice(1);
  const decision = getFlagValue(rest, "--decision");
  const artifacts = getFlagValue(rest, "--artifacts");
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

  try {
    emitAudit(pd, "ARTIFACT_REUSED", {
      Stage: slug,
      Decision: decision,
      Artifacts: artifacts,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(JSON.stringify({ slug, decision, artifacts, emitted: "ARTIFACT_REUSED" }));
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
  const intent = flags.intent;
  const space = flags.space;
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
  const resolvedIntent = activeIntent(pd, space, intent) ?? undefined;
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
    // (the P3 shared-lock cliff) and intent-birth/migration would block unrelated
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
        "Worktree path": wtPath,
        "Source state hash": sha,
        "Target state hash": sha, // fork = byte-identical copy
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
      wtContent = setFieldStrict(wtContent, "Worktree Path", wtPath);
    } catch (e) {
      errorWithSlug(slug, `failed to set Worktree Path on worktree state: ${errorMessage(e)}`);
    }
    try {
      // The worktree mirror lives under the SAME record (wtRecord/space) the
      // main side resolved — NOT the worktree's own cursor — so fork and merge
      // read/write one file. wtRecord===undefined -> the flat legacy mirror.
      writeStateFile(wtPath, wtContent, wtRecord, space);
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
  const intent = flags.intent;
  const space = flags.space;
  const recordPrefix = relativeRecordDir(pd, intent, space);
  // Resolve the intent ONCE before locking (same rationale as handleFork):
  // activeIntent maps an omitted selector to the active record, so resolvedIntent
  // == the value the per-intent path helpers resolve internally. Threading it to
  // the wrapping lock AND every main-side read/write/audit makes LOCK == WRITE
  // even when --intent is omitted; raw flags.intent would key the sentinel while
  // the writes hit the per-intent shard (lost-update race). wtRecord is the same
  // value, named for the worktree-mirror read where null->flat reads clearer.
  const resolvedIntent = activeIntent(pd, space, intent) ?? undefined;
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
    // serialize all intents' merges and let intent-birth block an unrelated
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
        "Worktree path": wtPath,
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
