/**
 * Integrated Construction checkpoints. This module owns evidence and decisions;
 * the engine owns when to present a checkpoint and which Unit is the skeleton.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
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
  verification_command: string | null;
  command_authorized: boolean;
}

const PROOF_DIR = ".aidlc-construction-checkpoints";
const CHECK_TIMEOUT_MS = 120_000;
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
  const verification = onlyLatest(rows.filter((row) =>
    row.event === "CHECKPOINT_VERIFICATION_RECORDED" &&
    auditBlockField(row.block, "Unit") === unit &&
    auditBlockField(row.block, "Kind") === kind &&
    eventMatchesClaimAttempt(projectDir, row.block, unit),
  ));
  const ready = errors.length === 0;
  const verified = ready && proof !== null &&
    proof.kind === kind && proof.unit === unit &&
    shared.verificationCommand !== null && proof.command_sha256 === shared.verificationCommand.sha256 &&
    proof.fingerprint === fingerprint && proof.verified === true &&
    proof.evidence_unchanged === true && proof.exit_code === 0 &&
    proof.signal === null && proof.error === null &&
    typeof proof.finished_at === "string" && verification !== null &&
    auditBlockField(verification.block, "Run floor") === floors[stages.at(-1)!] &&
    auditBlockField(verification.block, "Verification Id") === proof.id &&
    auditBlockField(verification.block, "Fingerprint") === fingerprint &&
    auditBlockField(verification.block, "Command SHA-256") === shared.verificationCommand.sha256 &&
    auditBlockField(verification.block, "Verified") === "true";
  const gate = onlyLatest(rows.filter((row) => {
    if (row.event === "WORKFLOW_STARTED" || row.event === "STAGE_JUMPED") return true;
    if (row.event !== "GATE_APPROVED" && row.event !== "GATE_REJECTED") return false;
    const rowUnit = auditBlockField(row.block, "Unit");
    if (rowUnit !== null && rowUnit !== unit) return false;
    if (!stages.some((stage) => stagesInRow(row).includes(stage))) return false;
    return row.event === "GATE_REJECTED" ||
      auditBlockField(row.block, "Checkpoint") === checkpointName(kind);
  }));
  const approved = verified && gate?.event === "GATE_APPROVED" &&
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
  return {
    root, rows, state, verificationCommand: shared.verificationCommand,
    result: {
      kind, unit, stages, fingerprint, verified, approved,
      human_required: humanRequired, enabled, ready, errors,
      verification_command: shared.verificationCommand?.label ?? null,
      command_authorized: shared.verificationCommand !== null,
      run_floor: floors[stages.at(-1)!] ?? "unstarted#0",
      run_floors: floors, proof_path: `${root}/${proofPath}`, verification: proof,
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
    // Starting a new check revokes an earlier pass, including after a crash.
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
      throw new Error(`Verify the current Construction checkpoint before approval: a matching CHECKPOINT_VERIFICATION_RECORDED receipt and passing proof are required. Run aidlc-bolt.ts checkpoint --unit "${unit}" --kind ${kind} --action verify.`);
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
      rechecked.result.verification?.id !== current.result.verification?.id ||
      rechecked.result.human_required !== current.result.human_required) {
      throw new Error("Construction checkpoint evidence changed before approval.");
    }
    appendAuditEntryUnlocked("GATE_APPROVED", {
      ...gateFields(projectDir, rechecked.result),
      "Verification Id": rechecked.result.verification!.id,
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
