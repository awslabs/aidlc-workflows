/**
 * Integrated Construction checkpoints. This module owns evidence and decisions;
 * the engine owns when to present a checkpoint and which Unit is the skeleton.
 */
import { EXTENDED_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { installRoot, policyPathWithin } from "./aidlc-install-paths.ts";
import {
  activeIntentUuid,
  attemptEventDefinitelyBefore,
  auditBlockField,
  authorizedVerificationCommand,
  VERIFICATION_COMMAND_RECOVERY,
  type VerificationCommand,
  claimAttemptFields,
  completionCarriesVerifiedReview,
  eventMatchesClaimAttempt,
  filterProducesByKind,
  findStageBySlug,
  freshReviewReceipts,
  getField,
  hasUnsafeSingleLineCharacter,
  consumeProtectedQuestion,
  withdrawProtectedQuestions,
  requireProtectedResponse,
  protectedTargetDigest,
  mintProtectedQuestion,
  planApprovalRuntimeDir,
  ensurePlanApprovalRuntimeDir,
  assertNoSymlinkInChainOrThrow,
  readAtomicReplacedFileNoFollowOrThrow,
  readProtectedResponse,
  readProtectedQuestion,
  writeFileAtomic,
  isAutonomousMode,
  constructionCheckpointsApply,
  isNonAnswer,
  latestMainWorkflowStageRunFloorForProject,
  maximalAttemptEvents,
  readAuditShardEvents,
  readRegularFileNoFollowOrThrow,
  readStateFile,
  readUnitSourceManifest,
  recordDir,
  recordFileTargetOrThrow,
  resolveBoltDag,
  resolveReviewClass,
  resolveWorkflowSelection,
  reviewArtifactFingerprint,
  reviewAttemptWindow,
  reviewRequestBindingFromBlock,
  selfAttributedDecisionMarker,
  setField,
  sortAttemptEvents,
  unitLifecycleSnapshot,
  unitMajorConstructionStageSlugs,
  unitSourceFingerprint,
  validateUnitName,
  withAuditLock,
  workspaceSourceState,
  writeRecordFileNoFollow,
  type AuditShardEvent,
  type BoltDagResolution,
  type FreshReviewReceipts,
  type UnitLifecycleSnapshot,
  type WorkspaceSourceListing,
  type WorkspaceSourceState,
} from "./aidlc-lib.ts";

export type ConstructionCheckpointKind = "unit" | "skeleton";

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
  verification_id: string | null;
  verification_command_sha256: string | null;
  verification_command: string | null;
  command_authorized: boolean;
  recovery_available: boolean;
  recovery_declined: boolean;
  recovery_prompt: string | null;
  recovery_evidence: {
    source: "untrusted-repository-history";
    command: string;
    command_sha256: string;
    verification_id: string;
  } | null;
}

const PROOF_DIR = ".aidlc-construction-checkpoints";
const CHECK_TIMEOUT_MS = EXTENDED_SUBPROCESS_TIMEOUT_MS;
const CHECK_OUTPUT_BYTES = 1024 * 1024;
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

// Any directory entry, including an invalid proof or a dangling link, counts:
// only a genuinely absent proof may fall back to the committed receipt.
function recordEntryPresent(root: string, path: string): boolean {
  try {
    lstatSync(join(root, path));
    return true;
  } catch (error) {
    // An unreadable path is not evidence of absence.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * A start names the attempts it observed before running. Cross-clone clocks
 * cannot establish that relationship. Legacy rows have only append order in
 * their own shard; concurrent or incomplete attempts fail closed.
 */
function verificationAttempt(rows: readonly AuditShardEvent[]): {
  receipt: AuditShardEvent | null;
  frontier: string[];
} {
  const byId = new Map<string, AuditShardEvent[]>();
  const rowId = (row: AuditShardEvent) =>
    auditBlockField(row.block, "Verification Id") || `malformed:${digest(row.block)}`;
  const invalid = new Set<string>();
  const superseded = new Set<string>();
  const predecessors = new Map<string, Set<string>>();
  const supersede = (id: string, previous: string) => {
    superseded.add(previous);
    const parents = predecessors.get(id) ?? new Set<string>();
    parents.add(previous);
    predecessors.set(id, parents);
  };
  for (const row of rows) {
    const id = rowId(row);
    // Preserve malformed history as a failed attempt that a new explicit check
    // can supersede. Its content identity travels unchanged across clones.
    if (!auditBlockField(row.block, "Verification Id")) invalid.add(id);
    byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  const starts = new Set(rows.filter((row) => row.event === "CHECKPOINT_VERIFICATION_STARTED")
    .map(rowId));
  for (const row of rows) {
    const id = rowId(row);
    const parents = row.event === "CHECKPOINT_VERIFICATION_STARTED"
      ? auditBlockField(row.block, "Supersedes Verification Ids") : null;
    if (parents !== null) {
      try {
        const ids: unknown = JSON.parse(parents);
        if (!Array.isArray(ids) || ids.some((parent) =>
          typeof parent !== "string" || parent === id || !byId.has(parent))) {
          invalid.add(id);
        } else {
          for (const parent of ids) supersede(id, parent);
        }
      } catch {
        invalid.add(id);
      }
    } else if (row.event === "CHECKPOINT_VERIFICATION_STARTED" || !starts.has(id)) {
      for (const earlier of rows) {
        const previous = rowId(earlier);
        if (previous !== id && earlier.shard === row.shard && earlier.pos < row.pos) supersede(id, previous);
      }
    }
  }
  const frontier = [...byId.keys()].filter((id) => !superseded.has(id)).sort();
  const recoveryFrontier = frontier.length ? frontier : [...byId.keys()].sort();
  if (frontier.length !== 1 || invalid.has(frontier[0])) return { receipt: null, frontier: recoveryFrontier };
  // A corrupt cycle must not disappear from the frontier and expose an old
  // success. A new explicit check can supersede all observed attempts.
  const observed = new Set<string>();
  const pending = [...frontier];
  while (pending.length) {
    const id = pending.pop()!;
    if (observed.has(id)) continue;
    observed.add(id);
    pending.push(...(predecessors.get(id) ?? []));
  }
  if (observed.size !== byId.size) return { receipt: null, frontier: [...byId.keys()].sort() };
  const attempt = byId.get(frontier[0])!;
  const begin = attempt.filter((row) => row.event === "CHECKPOINT_VERIFICATION_STARTED");
  const results = attempt.filter((row) => row.event === "CHECKPOINT_VERIFICATION_RECORDED");
  if (results.length !== 1 || begin.length > 1) return { receipt: null, frontier };
  const receipt = results[0];
  if (begin.length && (
    begin[0].shard !== receipt.shard || begin[0].pos >= receipt.pos ||
    ["Fingerprint", "Command SHA-256", "Run floor"].some((field) =>
      auditBlockField(begin[0].block, field) !== auditBlockField(receipt.block, field))
  )) return { receipt: null, frontier };
  return { receipt, frontier };
}

function checkpointAttempts(projectDir: string, rows: readonly AuditShardEvent[], unit: string, kind: ConstructionCheckpointKind) {
  return rows.filter((row) =>
    (row.event === "CHECKPOINT_VERIFICATION_STARTED" || row.event === "CHECKPOINT_VERIFICATION_RECORDED") &&
    auditBlockField(row.block, "Unit") === unit && auditBlockField(row.block, "Kind") === kind &&
    eventMatchesClaimAttempt(projectDir, row.block, unit));
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
  return {
    state, root, intent, allRows, rows, scope, source, listing: source?.listing ?? null,
    dag: resolveBoltDag(projectDir),
    verificationCommand: authorizedVerificationCommand(projectDir, state, rows),
    stages: unitMajorConstructionStageSlugs(scope, state, true),
    workflow: onlyLatest(rows.filter((row) => row.event === "WORKFLOW_STARTED")),
    grant: onlyLatest(rows.filter((row) => row.event === "AUTONOMY_MODE_SET" || row.event === "WORKFLOW_STARTED")),
    // A skeleton has unit-major evidence windows even under a stage-major cursor.
    evidenceState: setField(state, "Construction Iteration", "unit-major"),
    lifecycle: new Map(), receipts: new Map(),
  };
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
  recoveryTarget: Record<string, unknown> | null;
  result: ConstructionCheckpoint;
  root: string;
  rows: AuditShardEvent[];
  state: string;
  verificationCommand: VerificationCommand | null;
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
  if (listing === null) errors.push("The Unit's source boundary cannot be fingerprinted.");
  let sourceStages = 0;

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
    const artifact = reviewArtifactFingerprint(projectDir, stage, unit, {
      boltDag: dag, stateContent: state, requireRequiredArtifacts: true,
    });
    if (artifact === null) errors.push(`${slug}: required outputs are missing or unbindable.`);
    const completion = onlyLatest(rows.filter((row) =>
      ["UNIT_STARTED", "UNIT_RESUMED", "UNIT_PAUSED", "UNIT_COMPLETED"].includes(row.event) &&
      auditBlockField(row.block, "Stage") === slug &&
      auditBlockField(row.block, "Unit") === unit &&
      eventMatchesClaimAttempt(projectDir, row.block, unit),
    ));
    let lifecycle = shared.lifecycle.get(slug);
    if (!lifecycle) {
      lifecycle = unitLifecycleSnapshot(projectDir, slug, rows, evidenceState, {
        artifactFingerprint: (definition, name) => reviewArtifactFingerprint(projectDir, definition, name, {
          boltDag: dag, stateContent: state, requireRequiredArtifacts: true,
        }),
      });
      shared.lifecycle.set(slug, lifecycle);
    }
    const completionFingerprint = completion && auditBlockField(completion.block, "Artifact Fingerprint");
    if (
      !lifecycle.receipts.has(unit) ||
      completion?.event !== "UNIT_COMPLETED" ||
      auditBlockField(completion.block, "Run floor") !== floor ||
      (completionFingerprint !== null && completionFingerprint !== artifact)
    ) errors.push(`${slug}: current Unit completion evidence is missing or stale.`);

    let source: string | null = null;
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
        }
      } catch {
        errors.push(`${slug}: source manifest is missing or unbindable.`);
      }
    }
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
      if (
        !review || !receipts.unitVerdicts.has(unit) ||
        !binding || !completionCarriesVerifiedReview(projectDir, binding, review.block) ||
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
      ) errors.push(`${slug}: current artifact/source-bound terminal review evidence is required.`);
    }
    evidence.push({
      slug, floor, artifact, source, review_class: reviewClass,
      // Receipt presence/currentness is checked above. Re-recording the same
      // evidence is not a change to the approved work.
      reviewer: reviewClass === "none" ? null : stage.reviewer ?? null,
      review_verdict: review ? auditBlockField(review.block, "Verdict") : null,
    });
  }
  if (sourceStages === 0) errors.push("No applicable stage supplies the Unit's source manifest.");
  const fingerprint = digest({
    version: 1, intent, record: relative(projectDir, root), kind, unit,
    unit_kind: dag.unitKinds?.get(unit) ?? null,
    workflow: workflow ? digest(workflow.block) : null,
    claim: claimAttemptFields(projectDir, unit),
    stages: evidence,
  });
  const proofPath = proofRelativePath(unit, kind);
  const proof = readProof(root, proofPath);
  const verification = verificationAttempt(checkpointAttempts(projectDir, rows, unit, kind)).receipt;
  const ready = errors.length === 0;
  const gate = onlyLatest(rows.filter((row) => {
    if (row.event === "WORKFLOW_STARTED" || row.event === "STAGE_JUMPED") return true;
    if (row.event !== "GATE_APPROVED" && row.event !== "GATE_REJECTED") return false;
    const rowUnit = auditBlockField(row.block, "Unit");
    if (rowUnit !== null && rowUnit !== unit) return false;
    if (!stages.some((stage) => stagesInRow(row).includes(stage))) return false;
    return row.event === "GATE_REJECTED" ||
      auditBlockField(row.block, "Checkpoint") === checkpointName(kind);
  }));
  const receiptId = verification ? auditBlockField(verification.block, "Verification Id") : null;
  const receiptPasses = ready && receiptId !== null && shared.verificationCommand !== null &&
    verification !== null &&
    auditBlockField(verification.block, "Run floor") === floors[stages.at(-1)!] &&
    auditBlockField(verification.block, "Fingerprint") === fingerprint &&
    auditBlockField(verification.block, "Command SHA-256") === shared.verificationCommand.sha256 &&
    auditBlockField(verification.block, "Exit Code") === "0" &&
    auditBlockField(verification.block, "Verified") === "true";
  // Approval binds the unchanged work and command, so an equivalent successful
  // rerun preserves it on every clone. The new attempt still needs verification.
  const gateMatches = gate?.event === "GATE_APPROVED" &&
    auditBlockField(gate.block, "Unit") === unit &&
    auditBlockField(gate.block, "Stage") === stages.at(-1) &&
    auditBlockField(gate.block, "Stages") === stages.join(", ") &&
    auditBlockField(gate.block, "Gate Scope") === "unit-end" &&
    auditBlockField(gate.block, "Fingerprint") === fingerprint &&
    auditBlockField(gate.block, "Verification Command SHA-256") === shared.verificationCommand?.sha256 &&
    auditBlockField(gate.block, "Run floor") === floors[stages.at(-1)!] &&
    eventMatchesClaimAttempt(projectDir, gate.block, unit) &&
    (auditBlockField(gate.block, "User Input") === "Approve" ||
      (kind !== "skeleton" && auditBlockField(gate.block, "Autonomous") === "true"));
  const recoverable = receiptPasses && gateMatches && proof === null && !recordEntryPresent(root, proofPath);
  const recoveryTarget = recoverable ? {
    intent, record: relative(projectDir, root), kind, unit, fingerprint,
    runFloor: floors[stages.at(-1)!], verificationId: receiptId,
    commandSha256: shared.verificationCommand!.sha256,
    approvedVerificationId: auditBlockField(gate!.block, "Verification Id"),
  } : null;
  const recoveryChoice = recoveryTarget === null ? null
    : checkpointRecoveryChoice(projectDir, protectedTargetDigest(recoveryTarget));
  const recovered = recoveryChoice === "Approve";
  const verifiedId = proof?.id ?? (recovered ? receiptId : null);
  const verifiedSha = proof?.command_sha256 ?? (recovered ? shared.verificationCommand!.sha256 : null);
  const verified = receiptPasses && verifiedId === receiptId && verifiedSha === shared.verificationCommand!.sha256 &&
    (recovered || (proof !== null &&
      proof.kind === kind && proof.unit === unit &&
      proof.fingerprint === fingerprint && proof.verified === true &&
      proof.evidence_unchanged === true && proof.exit_code === 0 &&
      proof.signal === null && proof.error === null &&
      typeof proof.finished_at === "string"
    ));
  const approved = verified && gateMatches;
  return {
    root, rows, state, verificationCommand: shared.verificationCommand, recoveryTarget,
    result: {
      kind, unit, stages, fingerprint, verified, approved,
      human_required: humanRequired, enabled, ready, errors,
      verification_command: shared.verificationCommand?.label ?? null,
      command_authorized: shared.verificationCommand !== null,
      run_floor: floors[stages.at(-1)!] ?? "unstarted#0",
      run_floors: floors, proof_path: `${root}/${proofPath}`, verification: proof,
      verification_id: verifiedId, verification_command_sha256: verifiedSha,
      recovery_available: recoverable && recoveryChoice === null,
      recovery_declined: recoveryChoice === "Request Changes",
      recovery_prompt: recoverable && !recovered
        ? `Trust the unauthenticated repository history of verification and approval for ${kind} checkpoint "${unit}", without running that command on this clone? This clone cannot prove that the earlier check ran. Approve accepts this history locally; Request Changes keeps it unverified and requests local verification after execution permission is confirmed.`
        : null,
      recovery_evidence: recoverable && !recovered ? {
        source: "untrusted-repository-history",
        command: shared.verificationCommand!.label,
        command_sha256: shared.verificationCommand!.sha256,
        verification_id: receiptId!,
      } : null,
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

function requireReady(result: ConstructionCheckpoint): void {
  if (!result.ready) throw new Error(`Construction checkpoint is not ready: ${result.errors.join(" ")}`);
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
  const before = locked(projectDir, () => {
    withdrawProtectedQuestions(projectDir, "*");
    const current = snapshot(projectDir, unit, kind);
    requireReady(current.result);
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
    // Commit revocation first. An append failure leaves the prior proof intact;
    // a later proof-write failure is already a durable, unfinished attempt.
    appendAuditEntryUnlocked("CHECKPOINT_VERIFICATION_STARTED", {
      Unit: unit,
      Kind: kind,
      Stage: current.result.stages.at(-1)!,
      "Verification Id": proof.id,
      Fingerprint: proof.fingerprint,
      "Command SHA-256": proof.command_sha256,
      "Run floor": current.result.run_floor,
      "Supersedes Verification Ids": JSON.stringify(
        verificationAttempt(checkpointAttempts(projectDir, current.rows, unit, kind)).frontier),
      ...claimAttemptFields(projectDir, unit),
    }, projectDir);
    writeRecordFileNoFollow(current.root, proofRelativePath(unit, kind), `${JSON.stringify(proof, null, 2)}\n`);
    const selection = resolveWorkflowSelection(projectDir);
    return { ...current, proof, command: authorization.command, intent: selection.intent!, space: selection.space };
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
  const check = spawnSync(command, args, {
    cwd: projectDir, timeout: CHECK_TIMEOUT_MS,
    maxBuffer: CHECK_OUTPUT_BYTES, killSignal: "SIGKILL", windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
  const proof: ConstructionCheckpointProof = {
    ...before.proof,
    finished_at: new Date().toISOString(), exit_code: check.status,
    signal: check.signal,
    stdout_bytes: check.stdout?.length ?? 0, stderr_bytes: check.stderr?.length ?? 0,
    stdout_sha256: createHash("sha256").update(check.stdout ?? "").digest("hex"),
    stderr_sha256: createHash("sha256").update(check.stderr ?? "").digest("hex"),
    stdout_tail: outputTail(check.stdout), stderr_tail: outputTail(check.stderr),
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
    proof.verified = proof.exit_code === 0 && proof.signal === null &&
      proof.error === null && proof.evidence_unchanged;
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
    return resolveConstructionCheckpoint(projectDir, unit, kind);
  }, before.intent, before.space);
}

function gateFields(projectDir: string, checkpoint: ConstructionCheckpoint): Record<string, string> {
  return {
    Unit: checkpoint.unit,
    Stage: checkpoint.stages.at(-1)!,
    Stages: checkpoint.stages.join(", "),
    "Gate Stages": checkpoint.stages.join(", "),
    "Gate Scope": "unit-end",
    Checkpoint: checkpointName(checkpoint.kind),
    Fingerprint: checkpoint.fingerprint,
    "Run floor": checkpoint.run_floor,
    "Run floors": JSON.stringify(checkpoint.run_floors),
    ...(checkpoint.verification_command_sha256
      ? { "Verification Command SHA-256": checkpoint.verification_command_sha256 }
      : {}),
    ...claimAttemptFields(projectDir, checkpoint.unit),
  };
}

interface CheckpointRecovery {
  version: 2;
  project: string;
  targetDigest: string;
  session: string;
  responseSha256: string;
  choice: "Approve" | "Request Changes";
  mac: string;
}

/** The signing key must never be supplied by a checkout, including a symlink. */
function checkpointRecoveryKey(projectDir: string, create: boolean): Buffer | null {
  const root = installRoot();
  const path = join(root, "checkpoint-recovery-key");
  if (policyPathWithin(path, projectDir)) {
    throw new Error("Construction recovery requires AIDLC_INSTALL_ROOT outside the project.");
  }
  for (let parent = root; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) {
      throw new Error("Construction recovery requires AIDLC_INSTALL_ROOT outside Git working trees.");
    }
    if (dirname(parent) === parent) break;
  }
  const read = (): Buffer | null => {
    assertNoSymlinkInChainOrThrow(root, "checkpoint-recovery-key");
    try {
      const key = readRegularFileNoFollowOrThrow(path, "Construction recovery key", 32);
      if (key.length !== 32) throw new Error("Construction recovery key is invalid.");
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  if (!existsSync(root) && !create) return null;
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const existing = read();
  if (existing || !create) return existing;
  try {
    writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return read();
}

function recoveryMac(value: Record<string, unknown>, key: Buffer): string {
  return createHmac("sha256", key).update(protectedTargetDigest(value)).digest("hex");
}

function recoveryMacMatches(value: Record<string, unknown>, mac: unknown, key: Buffer | null): boolean {
  return key !== null && typeof mac === "string" && /^[a-f0-9]{64}$/.test(mac) &&
    timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(recoveryMac(value, key), "hex"));
}

/** Human choices survive interruption, but unsigned/preseeded files confer no trust. */
function checkpointRecoveryChoice(projectDir: string, targetDigest: string): CheckpointRecovery["choice"] | null {
  if (!/^[a-f0-9]{64}$/.test(targetDigest)) return null;
  const dir = planApprovalRuntimeDir(projectDir);
  try {
    assertNoSymlinkInChainOrThrow(projectDir, relative(projectDir, dir));
    const value = JSON.parse(readAtomicReplacedFileNoFollowOrThrow(
      join(dir, `checkpoint-recovery-${targetDigest}.json`), "Construction checkpoint recovery",
    ).toString("utf-8")) as CheckpointRecovery;
    const { mac, ...payload } = value;
    return value?.version === 2 && value.project === realpathSync(projectDir) &&
      value.targetDigest === targetDigest && typeof value.session === "string" && value.session.length > 0 &&
      typeof value.responseSha256 === "string" && /^[a-f0-9]{64}$/.test(value.responseSha256) &&
      (value.choice === "Approve" || value.choice === "Request Changes") &&
      recoveryMacMatches(payload, mac, checkpointRecoveryKey(projectDir, false)) ? value.choice : null;
  } catch {
    return null;
  }
}

function recoveryQuestionPayload(projectDir: string, session: string) {
  const question = readProtectedQuestion(projectDir, session);
  return { purpose: "checkpoint-recovery-question", project: realpathSync(projectDir), question };
}

function recoveryQuestionPath(projectDir: string, session: string): string {
  return join(planApprovalRuntimeDir(projectDir), `checkpoint-recovery-question-${protectedTargetDigest({ session })}.json`);
}

function requireRecoveryResponse(projectDir: string, targetDigest: string, session: string, choice: string): void {
  requireProtectedResponse(projectDir, session, { kind: "checkpoint-recovery", targetDigest, choice });
  let authentic = false;
  try {
    assertNoSymlinkInChainOrThrow(projectDir, relative(projectDir, recoveryQuestionPath(projectDir, session)));
    const mac: unknown = JSON.parse(readAtomicReplacedFileNoFollowOrThrow(
      recoveryQuestionPath(projectDir, session), "Construction recovery question",
    ).toString("utf-8"));
    authentic = recoveryMacMatches(recoveryQuestionPayload(projectDir, session), mac, checkpointRecoveryKey(projectDir, false));
  } catch {
    // A repository-prepared protected mailbox is not a locally offered question.
  }
  if (!authentic) throw new Error("Construction recovery requires a locally authenticated question. Run --action ask-recovery again.");
}

function recordCheckpointRecovery(
  projectDir: string, targetDigest: string, session: string, choice: CheckpointRecovery["choice"],
): void {
  requireRecoveryResponse(projectDir, targetDigest, session, choice);
  const response = readProtectedResponse(projectDir, session)!;
  const payload = {
    version: 2 as const, project: realpathSync(projectDir), targetDigest, session,
    responseSha256: response.responseSha256, choice,
  };
  const value: CheckpointRecovery = { ...payload, mac: recoveryMac(payload, checkpointRecoveryKey(projectDir, false)!) };
  const dir = ensurePlanApprovalRuntimeDir(projectDir);
  writeFileAtomic(join(dir, `checkpoint-recovery-${targetDigest}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function recoveryAuditFields(current: Snapshot, session: string): Record<string, string> {
  return {
    Checkpoint: "Construction Verification Recovery", Unit: current.result.unit, Kind: current.result.kind,
    Stage: current.result.stages.at(-1)!, Fingerprint: current.result.fingerprint,
    "Verification Id": String(current.recoveryTarget!.verificationId),
    "Command SHA-256": current.verificationCommand!.sha256,
    "Run floor": current.result.run_floor,
    "Target Digest": protectedTargetDigest(current.recoveryTarget!), Session: session,
  };
}

function approvalTarget(current: Snapshot) {
  return {
    kind: "unit" as const, unit: current.result.unit, checkpointKind: current.result.kind,
    fingerprint: current.result.fingerprint, verificationId: current.result.verification_id ?? "",
    commandSha256: current.verificationCommand?.sha256 ?? "",
  };
}

export function askConstructionCheckpointRecovery(
  projectDir: string, unit: string, kind: ConstructionCheckpointKind, session: string,
): ConstructionCheckpoint {
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    if (!current.recoveryTarget || current.result.verified) {
      throw new Error("No previously approved Construction verification can be recovered. Verify the checkpoint locally.");
    }
    const key = checkpointRecoveryKey(projectDir, true)!;
    withdrawProtectedQuestions(projectDir, session);
    appendAuditEntryUnlocked("DECISION_RECORDED", {
      ...recoveryAuditFields(current, session),
      Decision: current.result.recovery_prompt!, Options: "Approve,Request Changes",
    }, projectDir);
    mintProtectedQuestion(projectDir, {
      kind: "checkpoint-recovery", session, target: current.recoveryTarget,
      promptDigest: createHash("sha256").update(current.result.recovery_prompt!).digest("hex"),
    });
    writeFileAtomic(recoveryQuestionPath(projectDir, session),
      `${JSON.stringify(recoveryMac(recoveryQuestionPayload(projectDir, session), key))}\n`);
    return current.result;
  });
}

export function recoverConstructionCheckpoint(
  projectDir: string, unit: string, kind: ConstructionCheckpointKind, userInput: string, session: string,
): ConstructionCheckpoint {
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    if (!current.recoveryTarget || current.result.verified) {
      throw new Error("No previously approved Construction verification can be recovered. Verify the checkpoint locally.");
    }
    if (userInput !== "Approve" && userInput !== "Request Changes") {
      throw new Error("Construction verification recovery requires the human's Approve or Request Changes choice.");
    }
    const targetDigest = protectedTargetDigest(current.recoveryTarget);
    requireRecoveryResponse(projectDir, targetDigest, session, userInput);
    const rechecked = snapshot(projectDir, unit, kind);
    if (!rechecked.recoveryTarget || protectedTargetDigest(rechecked.recoveryTarget) !== targetDigest) {
      throw new Error("Construction checkpoint evidence changed before recovery.");
    }
    appendAuditEntryUnlocked("QUESTION_ANSWERED", {
      ...recoveryAuditFields(current, session), Details: userInput,
    }, projectDir);
    recordCheckpointRecovery(projectDir, targetDigest, session, userInput);
    consumeProtectedQuestion(projectDir, session);
    return resolveConstructionCheckpoint(projectDir, unit, kind);
  });
}

export function askConstructionCheckpoint(
  projectDir: string, unit: string, kind: ConstructionCheckpointKind, session: string,
): ConstructionCheckpoint {
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    if (!current.result.enabled || current.result.stages.length === 0) {
      throw new Error("Construction checkpoints are not enabled or have no applicable stages.");
    }
    if (current.result.recovery_available) {
      throw new Error(`This clone has no local verification. Ask the human whether to trust the prior approved check with aidlc-bolt.ts checkpoint --unit "${unit}" --kind ${kind} --action ask-recovery --session "${session}", then use --action recover with the actual response; or verify the checkpoint locally.`);
    }
    if (!current.result.ready || !current.result.verified) {
      throw new Error(`Verify the current Construction checkpoint first, before asking for approval. Run aidlc-bolt.ts checkpoint --unit "${unit}" --kind ${kind} --action verify and require verified: true.`);
    }
    withdrawProtectedQuestions(projectDir, session);
    appendAuditEntryUnlocked("DECISION_RECORDED", {
      Checkpoint: "Construction Unit Approval", Unit: unit, Kind: kind,
      Stage: current.result.stages.at(-1)!, Fingerprint: current.result.fingerprint,
      Session: session, Options: "Approve,Request Changes",
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
  userInput?: string,
  session = "",
): ConstructionCheckpoint {
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    requireReady(current.result);
    if (!current.result.verified) {
      throw new Error(`Verify the current Construction checkpoint before approval: a matching CHECKPOINT_VERIFICATION_RECORDED receipt and passing proof are required. If recovery_available is true, ask the human with --action ask-recovery before --action recover; committed receipts alone never authorize recovery. Otherwise a check from another clone must be verified again here. Run aidlc-bolt.ts checkpoint --unit "${unit}" --kind ${kind} --action verify.`);
    }
    const humanRequired = current.result.human_required || userInput !== undefined;
    if (humanRequired) {
      if (userInput !== "Approve") throw new Error('Construction checkpoint requires the exact "Approve" choice.');
      requireProtectedResponse(projectDir, session, {
        kind: "checkpoint-approval", targetDigest: protectedTargetDigest(approvalTarget(current)), choice: userInput,
      });
    } else if (current.result.approved) {
      return current.result;
    }
    const rechecked = snapshot(projectDir, unit, kind);
    if (!rechecked.result.verified ||
      rechecked.root !== current.root ||
      rechecked.result.fingerprint !== current.result.fingerprint ||
      rechecked.result.verification_id !== current.result.verification_id ||
      rechecked.result.human_required !== current.result.human_required) {
      throw new Error("Construction checkpoint evidence changed before approval.");
    }
    appendAuditEntryUnlocked("GATE_APPROVED", {
      ...gateFields(projectDir, rechecked.result),
      "Verification Id": rechecked.result.verification_id!,
      ...(humanRequired ? { Session: session } : {}),
      ...(userInput === "Approve" ? { "User Input": userInput } : { Autonomous: "true" }),
    }, projectDir);
    if (humanRequired) consumeProtectedQuestion(projectDir, session);
    return resolveConstructionCheckpoint(projectDir, unit, kind);
  });
}

export function rejectConstructionCheckpoint(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  userInput: string,
  reason: string,
  session = "",
): ConstructionCheckpoint {
  if (userInput !== "Request Changes") throw new Error('Construction checkpoint requires the exact "Request Changes" choice.');
  if (isNonAnswer(reason) || reason.length > 8192 || hasUnsafeSingleLineCharacter(reason) ||
    selfAttributedDecisionMarker(reason, "rejection")) {
    throw new Error("Request Changes requires a nonblank human reason on one line.");
  }
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    if (!current.result.enabled || current.result.stages.length === 0) {
      throw new Error("Construction checkpoints are not enabled or have no applicable stages.");
    }
    requireProtectedResponse(projectDir, session, {
      kind: "checkpoint-approval", targetDigest: protectedTargetDigest(approvalTarget(current)), choice: userInput,
    });
    const rechecked = snapshot(projectDir, unit, kind);
    if (current.root !== rechecked.root || current.result.fingerprint !== rechecked.result.fingerprint) {
      throw new Error("Construction checkpoint evidence changed before rejection.");
    }
    appendAuditEntryUnlocked("GATE_REJECTED", {
      ...gateFields(projectDir, rechecked.result),
      Session: session,
      "User Input": userInput, Feedback: reason, Reason: reason,
    }, projectDir);
    consumeProtectedQuestion(projectDir, session);
    return resolveConstructionCheckpoint(projectDir, unit, kind);
  });
}
