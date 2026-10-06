/**
 * Integrated Construction checkpoints. This module owns evidence and decisions;
 * the engine owns when to present a checkpoint and which Unit is the skeleton.
 */
import { EXTENDED_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  activeIntentUuid,
  attemptEventDefinitelyBefore,
  constructionSkeletonOn,
  auditBlockField,
  authorizedVerificationCommand,
  VERIFICATION_COMMAND_RECOVERY,
  type VerificationCommand,
  claimAttemptFields,
  completionCarriesVerifiedReview,
  reviewRecordNotHere,
  effectivePlanAction,
  eventMatchesClaimAttempt,
  filterProducesByKind,
  findStageBySlug,
  freshReviewReceipts,
  getField,
  governedGuardPolicy,
  guardPolicyAcceptsChanges,
  hasUnsafeSingleLineCharacter,
  consumeProtectedQuestion,
  withdrawProtectedQuestions,
  changeRequestWords,
  readProtectedResponse,
  requireProtectedResponse,
  protectedTargetDigest,
  mintProtectedQuestion,
  isAutonomousMode,
  constructionCheckpointsApply,
  isNonAnswer,
  latestMainWorkflowStageRunFloorForProject,
  loadStageGraph,
  maximalAttemptEvents,
  parseCheckboxes,
  readAuditShardEvents,
  readRegularFileNoFollowOrThrow,
  readStateFile,
  readUnitSourceManifest,
  recordAcceptedChanges,
  recordDir,
  recordFileTargetOrThrow,
  renderChangedPaths,
  renderReviewRequestCommand,
  resolveBoltDag,
  resolveReviewClass,
  resolveWorkflowSelection,
  restrictSourceListing,
  reviewArtifactFingerprint,
  reviewAttemptWindow,
  reviewRequestBindingFromBlock,
  selfAttributedDecisionMarker,
  setField,
  sortAttemptEvents,
  sourceListingChangedPaths,
  unitLifecycleSnapshot,
  unitMajorConstructionStageSlugs,
  unitSkippedUnits,
  unitSourceFingerprint,
  validateUnitName,
  withAuditLock,
  workspaceSourceState,
  writeRecordFileNoFollow,
  type AcceptedChange,
  type AuditShardEvent,
  type BoltDagResolution,
  type FreshReviewReceipts,
  type SourceClaimModel,
  type UnitLifecycleSnapshot,
  type WorkspaceSourceListing,
  type WorkspaceSourceState,
} from "./aidlc-lib.ts";


export type ConstructionCheckpointKind = "unit" | "skeleton";

// The walking skeleton's first Unit stops at the skeleton checkpoint; every
// other Unit, and every Unit without the skeleton, at its own Unit checkpoint.
export function constructionCheckpointKind(
  stateContent: string,
  unit: string,
  allUnits: readonly string[],
): ConstructionCheckpointKind {
  return constructionSkeletonOn(stateContent) && unit === allUnits[0] ? "skeleton" : "unit";
}

export interface ConstructionCheckpointProof {
  version: 4;
  id: string;
  kind: ConstructionCheckpointKind;
  unit: string;
  fingerprint: string;
  command_sha256: string;
  command_label: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_sha256: string;
  stderr_sha256: string;
  stdout_tail: string;
  stderr_tail: string;
  error: string | null;
  evidence_unchanged: boolean;
  verified: boolean;
}

export interface ConstructionCheckpoint {
  kind: ConstructionCheckpointKind;
  unit: string;
  stages: string[];
  fingerprint: string;
  verified: boolean;
  approved: boolean;
  human_required: boolean;
  enabled: boolean;
  ready: boolean;
  errors: string[];
  run_floor: string;
  run_floors: Record<string, string>;
  proof_path: string;
  verification: ConstructionCheckpointProof | null;
  verification_command: string | null;
  command_authorized: boolean;
  /** Only the Unit's reviewed code or documents changed since its review: the
   *  one review request that re-checks them, run before verifying again. */
  rereview: { stage: string; reviewer: string; iteration: number; command: string } | null;
  /** The current review is that re-check, of the Unit's code or documents.
   *  `approved_before` says the person had approved this Unit before then. */
  rechecked: { verdict: string; approved_before: boolean; changed: "code" | "documents" } | null;
  /** From verify: the one line for each change to this Unit's reviewed work
   *  its Guard Policy accepted, said before the person is asked. */
  change_notices?: string[];
}

const PROOF_DIR = ".aidlc-construction-checkpoints";
const CHECK_TIMEOUT_MS = EXTENDED_SUBPROCESS_TIMEOUT_MS;
const CHECK_OUTPUT_TAIL_BYTES = 2048;
const EMPTY_OUTPUT_SHA256 = createHash("sha256").update("").digest("hex");

export function checkpointPolicyEnabled(stateContent: string): boolean {
  return constructionCheckpointsApply(stateContent);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function checkpointName(kind: ConstructionCheckpointKind): string {
  return kind === "skeleton" ? "walking-skeleton" : "construction-unit";
}

function proofRelativePath(unit: string, kind: ConstructionCheckpointKind): string {
  return `${PROOF_DIR}/${unit}/${kind}.json`;
}

function onlyLatest(rows: readonly AuditShardEvent[]): AuditShardEvent | null {
  const frontier = maximalAttemptEvents(rows);
  return frontier.length === 1 ? frontier[0] : null;
}

function stagesInRow(row: AuditShardEvent): string[] {
  return (
    auditBlockField(row.block, "Gate Stages") ??
    auditBlockField(row.block, "Stages") ??
    auditBlockField(row.block, "Stage") ??
    ""
  ).split(",").map((stage) => stage.trim());
}

function readRows(projectDir: string): AuditShardEvent[] {
  const unreadable: string[] = [];
  const rows = readAuditShardEvents(projectDir, undefined, undefined, unreadable);
  if (unreadable.length) throw new Error("Construction checkpoint audit evidence is unreadable.");
  return rows;
}

/** Read-only evidence owned by one routing pass, never shared across mutations. */
export interface ConstructionEvidence {
  state: string;
  root: string;
  intent: string;
  dag: BoltDagResolution;
  rows: AuditShardEvent[];
  allRows: AuditShardEvent[];
  verificationCommand: VerificationCommand | null;
  source: WorkspaceSourceState | null;
  listing: WorkspaceSourceListing | null;
  scope: string;
  stages: string[];
  workflow: AuditShardEvent | null;
  grant: AuditShardEvent | null;
  evidenceState: string;
  lifecycle: Map<string, UnitLifecycleSnapshot>;
  receipts: Map<string, FreshReviewReceipts>;
  approvedUnits?: Set<string>;
}

export function loadConstructionEvidence(projectDir: string, stateContent?: string): ConstructionEvidence {
  const root = recordDir(projectDir);
  const intent = activeIntentUuid(projectDir);
  if (!root || !intent) throw new Error("Construction checkpoint requires an active intent record.");
  const state = stateContent ?? readStateFile(projectDir);
  const allRows = readRows(projectDir);
  const rows = sortAttemptEvents(allRows.filter(
    (row) => !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
  ));
  const scope = getField(state, "Scope") ?? "";
  const source = workspaceSourceState(projectDir);
  // A skeleton has unit-major evidence windows even under a stage-major cursor.
  const evidenceState = setField(state, "Construction Iteration", "unit-major");
  return {
    state, root, intent, allRows, rows, scope, source, listing: source?.listing ?? null,
    dag: resolveBoltDag(projectDir),
    verificationCommand: authorizedVerificationCommand(projectDir, state, rows),
    stages: checkpointStageSlugs(projectDir, scope, state, evidenceState, rows),
    workflow: onlyLatest(rows.filter((row) => row.event === "WORKFLOW_STARTED")),
    grant: onlyLatest(rows.filter((row) => row.event === "AUTONOMY_MODE_SET" || row.event === "WORKFLOW_STARTED")),
    evidenceState,
    lifecycle: new Map(), receipts: new Map(),
  };
}

// A Unit checkpoint's stage identity (its recorded Stages, per-stage floors,
// and fingerprint rows). The walk drops a stage once it is [S], but a stage
// that went [S] because its last owing Unit skipped it (every Unit skipped or
// kind-vacuous, each skip a current UNIT_SKIPPED receipt) stays in the list.
// Every Unit adds the same row for it before and after that final skip (none
// when the Unit skipped it, not-applicable when its kind prunes it), so a
// checkpoint approved before the final skip stays approved after it. A stage
// skipped any other way (composition, a jump, a stage-wide skip) has no current
// UNIT_SKIPPED receipt and is left out exactly as before.
function checkpointStageSlugs(
  projectDir: string,
  scope: string,
  state: string,
  evidenceState: string,
  rows: readonly AuditShardEvent[],
): string[] {
  const active = new Set(unitMajorConstructionStageSlugs(scope, state, true));
  const checkboxes = new Map(parseCheckboxes(state).map((entry) => [entry.slug, entry.state]));
  return loadStageGraph()
    .filter((stage) =>
      active.has(stage.slug) || (
        stage.phase === "construction" &&
        stage.for_each === "unit-of-work" &&
        checkboxes.get(stage.slug) === "skipped" &&
        effectivePlanAction(stage.slug, scope, state) === "EXECUTE" &&
        unitSkippedUnits(projectDir, stage.slug, rows, evidenceState).size > 0
      )
    )
    .map((stage) => stage.slug);
}

function readProof(root: string, path: string): ConstructionCheckpointProof | null {
  try {
    const bytes = readRegularFileNoFollowOrThrow(
      recordFileTargetOrThrow(root, path),
      "Construction checkpoint proof",
    );
    const proof = JSON.parse(bytes.toString("utf-8")) as ConstructionCheckpointProof;
    if (
      proof === null || typeof proof !== "object" ||
      proof.version !== 4 || typeof proof.id !== "string" ||
      typeof proof.fingerprint !== "string" ||
      typeof proof.command_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.command_sha256) ||
      typeof proof.command_label !== "string" || !proof.command_label.trim() ||
      proof.command_label.length > 1024 || hasUnsafeSingleLineCharacter(proof.command_label) ||
      /[\x80-\x9f\p{Cf}\p{Zl}\p{Zp}\u00a0]/u.test(proof.command_label) ||
      typeof proof.started_at !== "string" ||
      !Number.isSafeInteger(proof.stdout_bytes) || proof.stdout_bytes < 0 ||
      !Number.isSafeInteger(proof.stderr_bytes) || proof.stderr_bytes < 0 ||
      typeof proof.stdout_tail !== "string" || proof.stdout_tail.length > CHECK_OUTPUT_TAIL_BYTES ||
      typeof proof.stderr_tail !== "string" || proof.stderr_tail.length > CHECK_OUTPUT_TAIL_BYTES ||
      typeof proof.stdout_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.stdout_sha256) ||
      typeof proof.stderr_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.stderr_sha256)
    ) return null;
    return proof;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

interface Snapshot {
  result: ConstructionCheckpoint;
  root: string;
  rows: AuditShardEvent[];
  state: string;
  verificationCommand: VerificationCommand | null;
  accepted: AcceptedChange[];
  /** Each stage's evidence as an approval of the Unit records it. */
  approvedEvidence: string;
}

/** One stage's evidence as an approval of the Unit saw it. */
interface ApprovedStageEvidence {
  artifact: string;
  source: string | null;
  /** The Unit's own claimed paths and their entries, kept when there are few. */
  files: WorkspaceSourceListing | null;
  /** The stage's run floor the approval recorded. */
  floor: string | null;
}

const APPROVED_FILES_CAP = 50;

// "Approved Evidence" on a GATE_APPROVED row: one JSON line from stage slug to
// [artifact fingerprint, source fingerprint or null] plus, for a stage with
// source and at most APPROVED_FILES_CAP claimed paths, an object of those path
// keys and their listing entries. Null when the row has none or it is unreadable.
function readApprovedEvidence(block: string, field = "Approved Evidence"): Map<string, ApprovedStageEvidence> | null {
  const value = auditBlockField(block, field);
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    const floors = JSON.parse(auditBlockField(block, "Run floors") ?? "{}") as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const floorOf = (slug: string): string | null => {
      const floor = floors !== null && typeof floors === "object" ? (floors as Record<string, unknown>)[slug] : null;
      return typeof floor === "string" ? floor : null;
    };
    const recorded = new Map<string, ApprovedStageEvidence>();
    for (const [slug, entry] of Object.entries(parsed)) {
      if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3) || typeof entry[0] !== "string" ||
        (entry[1] !== null && typeof entry[1] !== "string")) return null;
      let files: WorkspaceSourceListing | null = null;
      if (entry.length === 3) {
        if (entry[2] === null || typeof entry[2] !== "object" || Array.isArray(entry[2])) return null;
        files = new Map();
        for (const [key, oid] of Object.entries(entry[2] as Record<string, unknown>)) {
          if (typeof oid !== "string") return null;
          files.set(key, oid);
        }
      }
      recorded.set(slug, { artifact: entry[0], source: entry[1], files, floor: floorOf(slug) });
    }
    return recorded;
  } catch {
    return null;
  }
}

// The one change an approved Unit's work made to a stage no review re-checks.
// Its files are named only from a kept listing that is the approved one: the
// listing reproduces the approved source fingerprint under the Unit's manifest.
function approvedWorkChange(
  slug: string,
  unit: string,
  recorded: ApprovedStageEvidence,
  artifact: string,
  source: string | null,
  claimed: { model: SourceClaimModel; sha256: string } | null,
  listing: WorkspaceSourceListing | null,
  asked = false,
): AcceptedChange {
  const artifactMoved = recorded.artifact !== artifact;
  const sourceMoved = recorded.source !== source;
  const paths = !artifactMoved && sourceMoved && recorded.files !== null && claimed !== null && listing !== null &&
    unitSourceFingerprint(recorded.files, claimed.model, claimed.sha256) === recorded.source
    ? sourceListingChangedPaths(recorded.files, restrictSourceListing(listing, claimed.model))
    : [];
  const pair = (artifactValue: string, sourceValue: string | null): string =>
    [artifactMoved ? artifactValue : null, sourceMoved ? sourceValue : null]
      .filter((value): value is string => value !== null).join(",");
  return {
    checkpoint: "construction-unit", stage: slug, unit,
    changed: paths.length > 0 ? paths : null,
    recorded: pair(recorded.artifact, recorded.source),
    current: pair(artifact, source),
    notice: asked
      ? paths.length > 0
        ? `${renderChangedPaths(paths)} changed after you were asked about Unit ${unit}; carrying on.`
        : `Unit ${unit}'s files changed after you were asked about it; carrying on.`
      : paths.length > 0
        ? `${renderChangedPaths(paths)} changed after you approved Unit ${unit}; carrying on.`
        : `Unit ${unit}'s files changed after you approved it; carrying on.`,
  };
}

function locked<T>(
  projectDir: string,
  fn: () => T extends Promise<unknown> ? never : T,
): T extends Promise<unknown> ? never : T {
  const { space, intent } = resolveWorkflowSelection(projectDir);
  if (!intent) throw new Error("Construction checkpoint requires an active intent.");
  const root = recordDir(projectDir, intent, space);
  return withAuditLock<T>(projectDir, () => {
    if (recordDir(projectDir) !== root) throw new Error("Active intent changed before Construction checkpoint.");
    return fn();
  }, intent, space);
}

function snapshot(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  stateContent?: string,
  sharedEvidence?: ConstructionEvidence,
): Snapshot {
  const unitError = validateUnitName(unit);
  if (unitError) throw new Error(unitError);
  if (kind !== "unit" && kind !== "skeleton") throw new Error("Unknown Construction checkpoint kind.");
  const state = stateContent ?? readStateFile(projectDir);
  const shared = sharedEvidence?.state === state && sharedEvidence.root === recordDir(projectDir)
    ? sharedEvidence : loadConstructionEvidence(projectDir, state);
  const { dag, root, intent, rows, scope, stages, workflow, grant, evidenceState, listing } = shared;
  if (dag.state !== "ok" || !dag.units.includes(unit)) {
    throw new Error(`Unit "${unit}" is not in the authoritative unit DAG.`);
  }
  const errors: string[] = [];
  const enabled = checkpointPolicyEnabled(state);
  if (!enabled) errors.push("Construction Checkpoints: enabled requires solo Units with an in-scope source-producing stage.");
  if (stages.length === 0) errors.push("No applicable per-unit Construction stages.");
  if (!workflow) errors.push("A current, unambiguous WORKFLOW_STARTED record is required.");
  const autonomous = isAutonomousMode(state) &&
    grant?.event === "AUTONOMY_MODE_SET" &&
    auditBlockField(grant.block, "Mode") === "autonomous";
  const humanRequired = kind === "skeleton" || !autonomous;
  const floors: Record<string, string> = {};
  const evidence: unknown[] = [];
  // Said after the stages, in this place: under relaxed and off a review that
  // kept its source binding stands for source that cannot be read here.
  const unreadableAt = errors.length;
  let sourceStages = 0;
  let sourceKeptUnread = 0;
  let rereview: ConstructionCheckpoint["rereview"] = null;
  let recheckVerdict: string | null = null;
  let recheckChanged: "code" | "documents" = "code";
  const accepted: AcceptedChange[] = [];
  // Whether this work's Guard Policy records a change to a Unit's reviewed
  // work with one line instead of stopping on it, read as the receipt scan
  // reads it.
  let accepting: boolean | null = null;
  const acceptsChanges = (): boolean => (accepting ??= guardPolicyAcceptsChanges(projectDir, state));
  const gate = onlyLatest(rows.filter((row) => {
    if (row.event === "WORKFLOW_STARTED" || row.event === "STAGE_JUMPED") return true;
    if (row.event !== "GATE_APPROVED" && row.event !== "GATE_REJECTED") return false;
    const rowUnit = auditBlockField(row.block, "Unit");
    if (rowUnit !== null && rowUnit !== unit) return false;
    if (!stages.some((stage) => stagesInRow(row).includes(stage))) return false;
    return row.event === "GATE_REJECTED" ||
      auditBlockField(row.block, "Checkpoint") === checkpointName(kind);
  }));
  // What this Unit's latest approval saw, read for a stage no review re-checks;
  // or, when the person was asked about the Unit since, what they were shown.
  const asked = onlyLatest(rows.filter((row) =>
    row.event === "DECISION_RECORDED" && auditBlockField(row.block, "Checkpoint") === "Construction Unit Approval" &&
    auditBlockField(row.block, "Unit") === unit && auditBlockField(row.block, "Kind") === kind &&
    (gate === null || attemptEventDefinitelyBefore(gate, row))));
  const askedEvidence = asked ? readApprovedEvidence(asked.block, "Asked Evidence") : null;
  const recordedEvidence = askedEvidence ?? (gate?.event === "GATE_APPROVED" && auditBlockField(gate.block, "Unit") === unit
    ? readApprovedEvidence(gate.block) : null);
  const approvedEvidence: Record<string, [string | null, string | null] | [string | null, string, Record<string, string>]> = {};

  for (const slug of stages) {
    const stage = findStageBySlug(slug);
    if (!stage) throw new Error(`Unknown per-unit Construction stage "${slug}".`);
    const floor = latestMainWorkflowStageRunFloorForProject(projectDir, slug, true, unit, rows);
    floors[slug] = floor;
    const required = filterProducesByKind(stage.produces_kinds, stage.produces ?? [], dag.unitKinds?.get(unit) ?? null);
    if (required.length === 0) {
      evidence.push({ slug, floor, applicable: false });
      continue;
    }
    let lifecycle = shared.lifecycle.get(slug);
    if (!lifecycle) {
      lifecycle = unitLifecycleSnapshot(projectDir, slug, rows, evidenceState, {
        artifactFingerprint: (definition, name) => reviewArtifactFingerprint(projectDir, definition, name, {
          boltDag: dag, stateContent: state, requireRequiredArtifacts: true,
        }),
        keepChangedWaveCompletions: true,
      });
      shared.lifecycle.set(slug, lifecycle);
    }
    // A stage this Unit skipped (UNIT_SKIPPED in its current attempt) owes no
    // outputs, completion, or review. It adds no evidence row either, so the
    // Unit's fingerprint does not change when every Unit has skipped the stage
    // and the stage itself is marked skipped.
    if (lifecycle.skipped.has(unit)) continue;
    let artifact = reviewArtifactFingerprint(projectDir, stage, unit, {
      boltDag: dag, stateContent: state, requireRequiredArtifacts: true,
    });
    if (artifact === null) errors.push(`${slug}: required outputs are missing or unbindable.`);
    const completion = onlyLatest(rows.filter((row) =>
      ["UNIT_STARTED", "UNIT_RESUMED", "UNIT_PAUSED", "UNIT_COMPLETED"].includes(row.event) &&
      auditBlockField(row.block, "Stage") === slug &&
      auditBlockField(row.block, "Unit") === unit &&
      eventMatchesClaimAttempt(projectDir, row.block, unit),
    ));
    // A stage the Unit completed in this attempt counts, whatever its outputs
    // became since: its review re-checks a change, the Guard Policy accepts it,
    // or, with reviews off, the checkpoint holds it and the person is asked.
    if (
      !lifecycle.receipts.has(unit) || completion?.event !== "UNIT_COMPLETED" ||
      auditBlockField(completion.block, "Run floor") !== floor
    ) errors.push(`${slug}: current Unit completion evidence is missing or stale.`);

    let source: string | null = null;
    let claimed: { model: SourceClaimModel; sha256: string } | null = null;
    if (stage.workspace_requires) {
      sourceStages++;
      // The manifest reader validates the claim model; independently refuse
      // links and a manifest changing between that read and its byte binding.
      try {
        const path = recordFileTargetOrThrow(root, `construction/${unit}/${slug}/source-manifest.json`);
        const bytes = readRegularFileNoFollowOrThrow(path, "Unit source manifest");
        const manifest = readUnitSourceManifest(projectDir, slug, unit);
        if (
          !manifest.ok ||
          manifest.rawBytesSha256 !== createHash("sha256").update(bytes).digest("hex")
        ) {
          errors.push(`${slug}: ${manifest.ok ? "source manifest changed while reading" : manifest.reason}`);
        } else if (listing !== null) {
          source = unitSourceFingerprint(listing, manifest, manifest.rawBytesSha256);
          claimed = { model: { claims: manifest.claims, prefixes: manifest.prefixes }, sha256: manifest.rawBytesSha256 };
        }
      } catch {
        errors.push(`${slug}: source manifest is missing or unbindable.`);
      }
    }
    const ownSource = source;
    let keptFiles: WorkspaceSourceListing | null = null;
    const reviewClass = stage.reviewer
      ? resolveReviewClass(stage.review_class ?? "adversarial", scope, state)
      : "none";
    let review: AuditShardEvent | null = null;
    if (reviewClass !== "none") {
      let receipts = shared.receipts.get(slug);
      if (!receipts) {
        receipts = freshReviewReceipts(projectDir, evidenceState, stage, {
          boltDag: dag, reviewClass,
          attemptWindow: reviewAttemptWindow(projectDir, evidenceState, stage, shared.allRows),
          sourceState: shared.source,
        });
        shared.receipts.set(slug, receipts);
      }
      accepted.push(...receipts.acceptedChanges.filter((change) => change.unit === unit));
      review = onlyLatest(rows.filter((row) =>
        row.event === "REVIEW_COMPLETED" &&
        auditBlockField(row.block, "Stage") === slug &&
        auditBlockField(row.block, "Unit") === unit &&
        auditBlockField(row.block, "Reviewer") === stage.reviewer &&
        eventMatchesClaimAttempt(projectDir, row.block, unit),
      ));
      const precedingRows = review ? rows.filter((row) => attemptEventDefinitelyBefore(row, review!)) : [];
      const reviewFloor = latestMainWorkflowStageRunFloorForProject(
        projectDir, slug, true, unit, precedingRows,
      );
      const request = onlyLatest(precedingRows.filter((row) =>
        row.event === "REVIEW_REQUESTED" &&
        auditBlockField(row.block, "Stage") === slug &&
        auditBlockField(row.block, "Unit") === unit &&
        auditBlockField(row.block, "Reviewer") === stage.reviewer &&
        auditBlockField(row.block, "Iteration") === auditBlockField(review!.block, "Iteration") &&
        eventMatchesClaimAttempt(projectDir, row.block, unit),
      ));
      const binding = request ? reviewRequestBindingFromBlock(request.block) : null;
      // Another Unit's own reviewed build of a path this Unit claims, or any
      // change to its code or documents the Guard Policy accepts, is not a
      // change to this Unit's approved work: its review's binding still holds.
      // So is source the Guard Policy keeps without a compare: the reviewed
      // listing not on this machine, the Unit's list of files changed after
      // its review, or source that cannot be read here.
      const reviewedSource = review ? auditBlockField(review.block, "Unit Source Fingerprint") : null;
      const sourceKept = receipts.unitSourceKept.has(unit) && acceptsChanges();
      if (
        stage.workspace_requires && reviewedSource !== null && reviewedSource !== source && (
          sourceKept || (source !== null && (
            receipts.unitSourceAttributed.has(unit) ||
            (receipts.unitSourceMoved.has(unit) && acceptsChanges())
          ))
        )
      ) {
        if (source === null && listing === null) sourceKeptUnread++;
        source = reviewedSource;
      }
      const reviewedArtifact = review ? auditBlockField(review.block, "Artifact Fingerprint") : null;
      if (
        artifact !== null && reviewedArtifact !== null && reviewedArtifact !== artifact &&
        receipts.unitVerdicts.has(unit) && acceptsChanges()
      ) artifact = reviewedArtifact;
      if (
        !review || !receipts.unitVerdicts.has(unit) ||
        !binding || (
          !completionCarriesVerifiedReview(projectDir, binding, review.block) &&
          // A written review not on this machine keeps its recorded verdict.
          !(acceptsChanges() && reviewRecordNotHere(projectDir, binding, review.block))
        ) ||
        receipts.unitPending.has(unit) || receipts.openBoltUnits.has(unit) ||
        reviewFloor !== floor ||
        auditBlockField(review.block, "Artifact Fingerprint") !== artifact ||
        auditBlockField(review.block, "Iteration") !== String(receipts.unitIterations.get(unit)) ||
        (stage.workspace_requires && (
          source === null ||
          auditBlockField(review.block, "Unit Source Fingerprint") !== source ||
          auditBlockField(review.block, "Source Freshness Bypass") !== null ||
          auditBlockField(review.block, "Unit Source Binding Bypass") !== null
        ))
      ) {
        errors.push(`${slug}: current artifact/source-bound terminal review evidence is required.`);
        // Only the reviewed code or documents moved (no review is waiting):
        // the one recovery review re-checks them. So does readable code the
        // review no longer binds (its list of files changed, or the listing it
        // saw is not on this machine).
        const moved = receipts.unitSourceMoved.get(unit) ??
          (review && (
            auditBlockField(review.block, "Artifact Fingerprint") !== artifact ||
            (receipts.unitStale.has(unit) && listing !== null)
          ) ? receipts.unitStaleProgress.get(unit) : undefined);
        if (review && moved && !moved.recoverySpent && !receipts.unitPending.has(unit)) {
          const reviewer = stage.reviewer!;
          const iteration = moved.nextIteration;
          rereview = {
            stage: slug, reviewer, iteration,
            command: renderReviewRequestCommand({ projectDir, stage: slug, reviewer, unit, iteration }),
          };
        }
      } else if (request && auditBlockField(request.block, "Recovery") === "stale-receipt") {
        // A re-check of code alone asked about the documents the review before
        // it saw; a re-check of documents asked about new ones.
        const prior = onlyLatest(precedingRows.filter((row) =>
          row.event === "REVIEW_COMPLETED" && attemptEventDefinitelyBefore(row, request) &&
          auditBlockField(row.block, "Stage") === slug &&
          auditBlockField(row.block, "Unit") === unit &&
          auditBlockField(row.block, "Reviewer") === stage.reviewer,
        ));
        if (prior) {
          recheckVerdict = auditBlockField(review!.block, "Verdict");
          if (auditBlockField(prior.block, "Artifact Fingerprint") !== auditBlockField(request.block, "Artifact Fingerprint")) {
            recheckChanged = "documents";
          }
        }
      }
    } else {
      // No review re-checks this stage: a later change to the work the person
      // approved, which its Guard Policy accepts, keeps the approved values in
      // the fingerprint and is said once.
      const recorded = recordedEvidence?.get(slug);
      if (
        recorded && recorded.floor === floor && artifact !== null &&
        (source !== null) === Boolean(stage.workspace_requires) &&
        (recorded.source !== null) === (source !== null) &&
        (recorded.artifact !== artifact || recorded.source !== source) &&
        acceptsChanges()
      ) {
        accepted.push(approvedWorkChange(slug, unit, recorded, artifact, source, claimed, listing, askedEvidence !== null));
        artifact = recorded.artifact;
        source = recorded.source;
        keptFiles = recorded.files;
      }
    }
    const files = source === null ? null
      : source === ownSource && claimed && listing ? restrictSourceListing(listing, claimed.model) : keptFiles;
    approvedEvidence[slug] = files !== null && source !== null && files.size <= APPROVED_FILES_CAP
      ? [artifact, source, Object.fromEntries(files)]
      : [artifact, source];
    evidence.push({
      slug, floor, artifact, source, review_class: reviewClass,
      // Receipt presence/currentness is checked above. Re-recording the same
      // evidence is not a change to the approved work.
      reviewer: reviewClass === "none" ? null : stage.reviewer ?? null,
      review_verdict: review ? auditBlockField(review.block, "Verdict") : null,
    });
  }
  if (listing === null && (sourceStages === 0 || sourceKeptUnread < sourceStages)) {
    errors.splice(unreadableAt, 0, "The Unit's source boundary cannot be fingerprinted.");
  }
  if (sourceStages === 0) errors.push("No applicable stage supplies the Unit's source manifest.");
  if (errors.length !== 1) rereview = null;
  const fingerprint = digest({
    version: 1, intent, record: relative(projectDir, root), kind, unit,
    unit_kind: dag.unitKinds?.get(unit) ?? null,
    workflow: workflow ? digest(workflow.block) : null,
    claim: claimAttemptFields(projectDir, unit),
    stages: evidence,
  });
  const proofPath = proofRelativePath(unit, kind);
  const proof = readProof(root, proofPath);
  const verification = onlyLatest(rows.filter((row) =>
    row.event === "CHECKPOINT_VERIFICATION_RECORDED" &&
    auditBlockField(row.block, "Unit") === unit &&
    auditBlockField(row.block, "Kind") === kind &&
    eventMatchesClaimAttempt(projectDir, row.block, unit),
  ));
  const ready = errors.length === 0;
  const verifiedWith = (commandSha256: string | undefined): boolean => ready && proof !== null &&
    commandSha256 !== undefined &&
    proof.kind === kind && proof.unit === unit &&
    proof.command_sha256 === commandSha256 &&
    proof.fingerprint === fingerprint && proof.verified === true &&
    proof.evidence_unchanged === true && proof.exit_code === 0 &&
    proof.signal === null && proof.error === null &&
    typeof proof.finished_at === "string" && verification !== null &&
    auditBlockField(verification.block, "Run floor") === floors[stages.at(-1)!] &&
    auditBlockField(verification.block, "Verification Id") === proof.id &&
    auditBlockField(verification.block, "Fingerprint") === fingerprint &&
    auditBlockField(verification.block, "Command SHA-256") === commandSha256 &&
    auditBlockField(verification.block, "Verified") === "true";
  const verifiedNow = verifiedWith(shared.verificationCommand?.sha256);
  const gateApproved = gate?.event === "GATE_APPROVED" &&
    auditBlockField(gate.block, "Unit") === unit &&
    auditBlockField(gate.block, "Stage") === stages.at(-1) &&
    auditBlockField(gate.block, "Stages") === stages.join(", ") &&
    auditBlockField(gate.block, "Gate Scope") === "unit-end" &&
    auditBlockField(gate.block, "Fingerprint") === fingerprint &&
    auditBlockField(gate.block, "Verification Command SHA-256") === proof?.command_sha256 &&
    auditBlockField(gate.block, "Run floor") === floors[stages.at(-1)!] &&
    eventMatchesClaimAttempt(projectDir, gate.block, unit) &&
    (auditBlockField(gate.block, "User Input") === "Approve" ||
      (kind !== "skeleton" && auditBlockField(gate.block, "Autonomous") === "true"));
  // A Unit approved under an earlier verification command keeps its approval
  // when the person approves a new command: the new one checks the Units
  // still to be approved.
  const verified = verifiedNow || (gateApproved && verifiedWith(proof?.command_sha256));
  const approved = verified && gateApproved;
  const approvedBefore = gate?.event === "GATE_APPROVED" && auditBlockField(gate.block, "Unit") === unit &&
    auditBlockField(gate.block, "Run floor") === floors[stages.at(-1)!];
  // A re-check of documents during the Unit's build is its usual checkpoint.
  const rechecked = recheckVerdict === null || approved || (recheckChanged === "documents" && !approvedBefore)
    ? null
    : { verdict: recheckVerdict, approved_before: approvedBefore, changed: recheckChanged };
  return {
    root, rows, state, verificationCommand: shared.verificationCommand, accepted,
    approvedEvidence: JSON.stringify(approvedEvidence),
    result: {
      kind, unit, stages, fingerprint, verified, approved,
      human_required: humanRequired, enabled, ready, errors,
      verification_command: shared.verificationCommand?.label ?? null,
      command_authorized: shared.verificationCommand !== null,
      run_floor: floors[stages.at(-1)!] ?? "unstarted#0",
      run_floors: floors, proof_path: `${root}/${proofPath}`, verification: proof,
      rereview, rechecked,
    },
  };
}

export function resolveConstructionCheckpoint(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  stateContent?: string,
  evidence?: ConstructionEvidence,
): ConstructionCheckpoint {
  return snapshot(projectDir, unit, kind, stateContent, evidence).result;
}

/**
 * The changes to approved Units' work that their Guard Policy accepted, for
 * every approved Unit but `except`. Such a Unit stays approved, so nothing
 * verifies it again: the next checkpoint's verify and the Construction stage's
 * own check record these, and recordAcceptedChanges says each once.
 */
export function approvedUnitChanges(
  projectDir: string,
  stateContent: string,
  except?: string,
): { changeControlRead: boolean; acceptedChanges: AcceptedChange[] } {
  const acceptedChanges: AcceptedChange[] = [];
  if (!checkpointPolicyEnabled(stateContent)) return { changeControlRead: false, acceptedChanges };
  let evidence: ConstructionEvidence;
  try {
    evidence = loadConstructionEvidence(projectDir, stateContent);
  } catch {
    return { changeControlRead: false, acceptedChanges };
  }
  if (evidence.dag.state !== "ok") return { changeControlRead: false, acceptedChanges };
  const order = evidence.dag.batches.flat();
  for (const unit of evidence.dag.units) {
    if (unit === except) continue;
    try {
      const current = snapshot(projectDir, unit, constructionCheckpointKind(stateContent, unit, order), stateContent, evidence);
      if (current.result.approved) acceptedChanges.push(...current.accepted);
    } catch {
      // Missing, stale or malformed evidence is unfinished work.
    }
  }
  return { changeControlRead: acceptedChanges.length > 0, acceptedChanges };
}

function requireReady(result: ConstructionCheckpoint): void {
  if (!result.ready) {
    const rereview = result.rereview
      ? ` What ${result.rereview.stage} reviewed changed since its review: request the re-check with \`${result.rereview.command}\`, record the verdict, then verify.`
      : "";
    throw new Error(`Construction checkpoint is not ready: ${result.errors.join(" ")}${rereview}`);
  }
}

// The check writes its output to files, so a verbose suite is never cut short
// by a memory cap; the proof keeps each stream's size, digest and tail.
function capturedOutput(path: string): { bytes: number; sha256: string; tail: Buffer } {
  const hash = createHash("sha256");
  const keep = CHECK_OUTPUT_TAIL_BYTES + 4;
  let tail = Buffer.alloc(0);
  let bytes = 0;
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
      const part = chunk.subarray(0, read);
      hash.update(part);
      bytes += read;
      tail = Buffer.concat([tail, part]);
      if (tail.length > keep) tail = tail.subarray(tail.length - keep);
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: hash.digest("hex"), tail };
}

function outputTail(output: Buffer | null): string {
  if (output === null) return "";
  let start = Math.max(0, output.length - CHECK_OUTPUT_TAIL_BYTES);
  if (start > 0) {
    // A byte-bounded tail may start inside a UTF-8 code point.
    while (start < output.length && (output[start]! & 0xc0) === 0x80) start++;
  }
  // Keep newlines and tabs; every other C0/C1 control byte becomes U+FFFD.
  return output.subarray(start).toString("utf-8").replace(
    /\p{Cc}/gu,
    (char) => (char === "\n" || char === "\t" ? char : "\ufffd"),
  );
}

export function verifyConstructionCheckpoint(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
): ConstructionCheckpoint {
  // A check that formats or regenerates the Unit's files changes what it
  // checked, so it runs once more against the files as they are now.
  const first = verifyOnce(projectDir, unit, kind, false);
  if (!first.rerun) return first.result;
  // The line about an accepted change is said once, on whichever run made it.
  const second = verifyOnce(projectDir, unit, kind, true).result;
  const notices = [...(first.result.change_notices ?? []), ...(second.change_notices ?? [])];
  return notices.length > 0 ? { ...second, change_notices: notices } : second;
}

const CHECK_KEPT_CHANGING =
  "The check changed this Unit's files each time it ran, so no one version of them passed. " +
  "Use a check that leaves the files as they are, then verify again.";

function verifyOnce(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  secondRun: boolean,
): { result: ConstructionCheckpoint; rerun: boolean } {
  const before = locked(projectDir, () => {
    withdrawProtectedQuestions(projectDir, "*");
    const current = snapshot(projectDir, unit, kind);
    requireReady(current.result);
    // A change to this Unit's reviewed work that its Guard Policy accepts is
    // recorded and said once, before the person is asked to approve; so is one
    // to another approved Unit's work that no step has said yet.
    const changes = [...approvedUnitChanges(projectDir, current.state, unit).acceptedChanges, ...current.accepted];
    if (changes.length > 0) governedGuardPolicy(projectDir, current.state);
    const notices = recordAcceptedChanges(projectDir, changes);
    const authorization = current.verificationCommand;
    if (!authorization) {
      throw new Error("Construction verification requires the state's command and a matching current VERIFICATION_COMMAND_RECORDED receipt. " + VERIFICATION_COMMAND_RECOVERY);
    }
    const proof: ConstructionCheckpointProof = {
      version: 4, id: randomUUID(), kind, unit, fingerprint: current.result.fingerprint,
      command_sha256: authorization.sha256, command_label: authorization.label,
      started_at: new Date().toISOString(), finished_at: null,
      exit_code: null, signal: null, error: null,
      stdout_bytes: 0, stderr_bytes: 0,
      stdout_sha256: EMPTY_OUTPUT_SHA256, stderr_sha256: EMPTY_OUTPUT_SHA256,
      stdout_tail: "", stderr_tail: "",
      evidence_unchanged: false, verified: false,
    };
    // Starting a new check revokes an earlier pass, including after a crash.
    writeRecordFileNoFollow(current.root, proofRelativePath(unit, kind), `${JSON.stringify(proof, null, 2)}\n`);
    const selection = resolveWorkflowSelection(projectDir);
    return { ...current, proof, notices, command: authorization.command, intent: selection.intent!, space: selection.space };
  });
  // Match swarm checkConverged: preserve Bash project checks where available.
  const command = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  // cmd.exe parses the authorized shell text itself. /s strips only these
  // outer quotes; argv escaping would turn its inner quotes into literal \".
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `"${before.command}"`]
    : ["-c", before.command];
  const outputDir = mkdtempSync(join(tmpdir(), "aidlc-check-"));
  const outPath = join(outputDir, "stdout");
  const errPath = join(outputDir, "stderr");
  let check: ReturnType<typeof spawnSync>;
  let stdout: ReturnType<typeof capturedOutput>;
  let stderr: ReturnType<typeof capturedOutput>;
  try {
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    try {
      check = spawnSync(command, args, {
        cwd: projectDir, timeout: CHECK_TIMEOUT_MS,
        stdio: ["pipe", outFd, errFd], killSignal: "SIGKILL", windowsHide: true,
        windowsVerbatimArguments: process.platform === "win32",
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
    stdout = capturedOutput(outPath);
    stderr = capturedOutput(errPath);
  } finally {
    for (const path of [outPath, errPath]) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
    try { rmdirSync(outputDir); } catch { /* already gone */ }
  }
  const proof: ConstructionCheckpointProof = {
    ...before.proof,
    finished_at: new Date().toISOString(), exit_code: check.status,
    signal: check.signal,
    stdout_bytes: stdout.bytes, stderr_bytes: stderr.bytes,
    stdout_sha256: stdout.sha256, stderr_sha256: stderr.sha256,
    stdout_tail: outputTail(stdout.tail), stderr_tail: outputTail(stderr.tail),
    error: check.error?.message ?? null,
  };
  return withAuditLock(projectDir, () => {
    // Pin the proof to the intent where verification began even if a command
    // changes the active cursor. No proof is written into the new selection.
    const stillOurs = readProof(before.root, proofRelativePath(unit, kind))?.id === proof.id;
    if (!stillOurs) throw new Error("Construction checkpoint verification was superseded by another check.");
    let after: Snapshot;
    try {
      after = snapshot(projectDir, unit, kind);
    } catch (error) {
      proof.error = `Evidence became unavailable after check: ${String(error)}`;
      writeRecordFileNoFollow(before.root, proofRelativePath(unit, kind), `${JSON.stringify(proof, null, 2)}\n`);
      throw error;
    }
    proof.evidence_unchanged = after.root === before.root &&
      after.result.ready && after.result.fingerprint === before.result.fingerprint &&
      after.verificationCommand?.sha256 === proof.command_sha256;
    const passed = proof.exit_code === 0 && proof.signal === null && proof.error === null;
    // A check that ran to its end and changed the Unit's files, whether it
    // passed or failed (a fixer that exits non-zero once it fixed something),
    // runs once more; the second run decides.
    const changedByCheck = proof.signal === null && proof.error === null && !proof.evidence_unchanged &&
      after.root === before.root && after.result.ready && after.verificationCommand?.sha256 === proof.command_sha256;
    if (changedByCheck && secondRun) proof.error = CHECK_KEPT_CHANGING;
    proof.verified = passed && proof.error === null && proof.evidence_unchanged;
    writeRecordFileNoFollow(before.root, proofRelativePath(unit, kind), `${JSON.stringify(proof, null, 2)}\n`);
    if (after.root !== before.root) throw new Error("Active intent changed during Construction verification.");
    appendAuditEntryUnlocked("CHECKPOINT_VERIFICATION_RECORDED", {
      Unit: unit,
      Kind: kind,
      Stage: before.result.stages.at(-1)!,
      Stages: before.result.stages.join(", "),
      "Verification Id": proof.id,
      Fingerprint: proof.fingerprint,
      "Command SHA-256": proof.command_sha256,
      "Exit Code": String(proof.exit_code),
      Verified: String(proof.verified),
      "Run floor": before.result.run_floor,
      ...claimAttemptFields(projectDir, unit),
    }, projectDir);
    const result = resolveConstructionCheckpoint(projectDir, unit, kind);
    return {
      result: before.notices.length > 0 ? { ...result, change_notices: before.notices } : result,
      rerun: changedByCheck && !secondRun,
    };
  }, before.intent, before.space);
}

// The checkpoint gate row. "Stages" is the checkpoint's identity and names
// every stage in it, including one kept after it went [S] through per-unit
// skips. "Gate Stages" is what the row gates: readers of a rejection treat it
// as a new attempt for exactly those stages (gateRejectionMatchesAttempt in
// aidlc-lib.ts). A stage that is [S] for every Unit is left out, so Request
// Changes cannot reopen a stage that nothing will direct again, the same as a
// whole-stage skip. With no such stage the row is unchanged.
function gateFields(
  projectDir: string,
  checkpoint: ConstructionCheckpoint,
  state: string,
): Record<string, string> {
  const skipped = new Set(
    parseCheckboxes(state)
      .filter((entry) => entry.state === "skipped")
      .map((entry) => entry.slug),
  );
  return {
    Unit: checkpoint.unit,
    Stage: checkpoint.stages.at(-1)!,
    Stages: checkpoint.stages.join(", "),
    "Gate Stages": checkpoint.stages.filter((stage) => !skipped.has(stage)).join(", "),
    "Gate Scope": "unit-end",
    Checkpoint: checkpointName(checkpoint.kind),
    Fingerprint: checkpoint.fingerprint,
    "Run floor": checkpoint.run_floor,
    "Run floors": JSON.stringify(checkpoint.run_floors),
    ...(checkpoint.verification ? { "Verification Command SHA-256": checkpoint.verification.command_sha256 } : {}),
    ...claimAttemptFields(projectDir, checkpoint.unit),
  };
}

function approvalTarget(current: Snapshot) {
  return {
    kind: "unit" as const, unit: current.result.unit, checkpointKind: current.result.kind,
    fingerprint: current.result.fingerprint, verificationId: current.result.verification?.id ?? "",
    commandSha256: current.verificationCommand?.sha256 ?? "",
  };
}

export function askConstructionCheckpoint(
  projectDir: string, unit: string, kind: ConstructionCheckpointKind, session: string,
): ConstructionCheckpoint {
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    if (!current.result.enabled || current.result.stages.length === 0) {
      throw new Error("Construction checkpoints are not enabled or have no applicable stages.");
    }
    if (!current.result.ready || !current.result.verified) {
      throw new Error(`Verify the current Construction checkpoint first, before asking for approval. Run aidlc-bolt.ts checkpoint --unit "${unit}" --kind ${kind} --action verify and require verified: true.`);
    }
    withdrawProtectedQuestions(projectDir, session);
    appendAuditEntryUnlocked("DECISION_RECORDED", {
      Checkpoint: "Construction Unit Approval", Unit: unit, Kind: kind,
      Stage: current.result.stages.at(-1)!, Fingerprint: current.result.fingerprint,
      Session: session, Options: "Approve,Request Changes",
      // What the person is shown, so a change before their answer is said
      // once instead of asking again (relaxed and off).
      "Asked Evidence": current.approvedEvidence, "Run floors": JSON.stringify(current.result.run_floors),
    }, projectDir);
    mintProtectedQuestion(projectDir, {
      kind: "checkpoint-approval", session, target: approvalTarget(current),
    });
    return current.result;
  });
}

export function approveConstructionCheckpoint(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  reply?: string,
  session = "",
): ConstructionCheckpoint {
  // The conductor read the person's reply and reports their approval. The
  // receipt records it beside the person's own words, kept by the human-turn
  // hook; nothing here second-guesses the conductor's reading.
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    requireReady(current.result);
    if (!current.result.verified) {
      throw new Error(`Verify the current Construction checkpoint before approval: a matching CHECKPOINT_VERIFICATION_RECORDED receipt and passing proof are required. Run aidlc-bolt.ts checkpoint --unit "${unit}" --kind ${kind} --action verify.`);
    }
    const humanRequired = current.result.human_required || reply !== undefined;
    let words: string | undefined;
    if (humanRequired) {
      requireProtectedResponse(projectDir, session, {
        kind: "checkpoint-approval", targetDigest: protectedTargetDigest(approvalTarget(current)), choice: "Approve",
      });
      words = readProtectedResponse(projectDir, session)?.words;
    } else if (current.result.approved) {
      return current.result;
    }
    const rechecked = snapshot(projectDir, unit, kind);
    if (!rechecked.result.verified ||
      rechecked.root !== current.root ||
      rechecked.result.fingerprint !== current.result.fingerprint ||
      rechecked.result.verification?.id !== current.result.verification?.id ||
      rechecked.result.human_required !== current.result.human_required) {
      throw new Error("Construction checkpoint evidence changed before approval.");
    }
    // A change made after the person was asked, which the Guard Policy
    // accepts, is said once here, with their approval.
    if (rechecked.accepted.length > 0) governedGuardPolicy(projectDir, rechecked.state);
    const notices = recordAcceptedChanges(projectDir, rechecked.accepted);
    appendAuditEntryUnlocked("GATE_APPROVED", {
      ...gateFields(projectDir, rechecked.result, rechecked.state),
      "Verification Id": rechecked.result.verification!.id,
      "Approved Evidence": rechecked.approvedEvidence,
      ...(humanRequired ? { Session: session } : {}),
      ...(humanRequired ? { "User Input": "Approve" } : { Autonomous: "true" }),
      ...(words ? { "Person Reply": words } : {}),
    }, projectDir);
    if (humanRequired) consumeProtectedQuestion(projectDir, session);
    const result = resolveConstructionCheckpoint(projectDir, unit, kind);
    return notices.length > 0 ? { ...result, change_notices: notices } : result;
  });
}

export function rejectConstructionCheckpoint(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  _reply: string,
  givenReason: string,
  session = "",
): ConstructionCheckpoint {
  // The conductor read the person's reply as a change request. What they said
  // to change is the reason: the conductor's --reason when given, otherwise the
  // person's own words, which the receipt keeps verbatim either way.
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    if (!current.result.enabled || current.result.stages.length === 0) {
      throw new Error("Construction checkpoints are not enabled or have no applicable stages.");
    }
    requireProtectedResponse(projectDir, session, {
      kind: "checkpoint-approval", targetDigest: protectedTargetDigest(approvalTarget(current)), choice: "Request Changes",
    });
    const words = readProtectedResponse(projectDir, session)?.words;
    const reason = givenReason.trim() || changeRequestWords(words);
    const userInput = "Request Changes";
    if (isNonAnswer(reason) || reason.length > 8192 || hasUnsafeSingleLineCharacter(reason) ||
      selfAttributedDecisionMarker(reason, "rejection")) {
      throw new Error("Request Changes needs what the person asked to change, on one line, in --reason.");
    }
    const rechecked = snapshot(projectDir, unit, kind);
    if (current.root !== rechecked.root || current.result.fingerprint !== rechecked.result.fingerprint) {
      throw new Error("Construction checkpoint evidence changed before rejection.");
    }
    appendAuditEntryUnlocked("GATE_REJECTED", {
      ...gateFields(projectDir, rechecked.result, rechecked.state),
      Session: session,
      "User Input": userInput, Feedback: reason, Reason: reason,
      ...(words ? { "Person Reply": words } : {}),
    }, projectDir);
    consumeProtectedQuestion(projectDir, session);
    return resolveConstructionCheckpoint(projectDir, unit, kind);
  });
}
