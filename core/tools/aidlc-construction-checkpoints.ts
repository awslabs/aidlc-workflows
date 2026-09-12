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
  claimAttemptFields,
  completionCarriesVerifiedReview,
  eventMatchesClaimAttempt,
  filterProducesByKind,
  findStageBySlug,
  freshReviewReceipts,
  getField,
  hasUnsafeSingleLineCharacter,
  humanActedSinceGate,
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
  reviewRequestBindingFromBlock,
  selfAttributedDecisionMarker,
  setField,
  sortAttemptEvents,
  unitLifecycleSnapshot,
  unitMajorConstructionStageSlugs,
  unitSourceFingerprint,
  validateUnitName,
  withAuditLock,
  workspaceSourceListing,
  writeRecordFileNoFollow,
  type AuditShardEvent,
} from "./aidlc-lib.ts";

export type ConstructionCheckpointKind = "unit" | "skeleton";

export interface ConstructionCheckpointProof {
  version: 1;
  id: string;
  kind: ConstructionCheckpointKind;
  unit: string;
  fingerprint: string;
  command: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
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
}

const PROOF_DIR = ".aidlc-construction-checkpoints";
const CHECK_TIMEOUT_MS = 120_000;
const CHECK_OUTPUT_BYTES = 1024 * 1024;

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
  return sortAttemptEvents(rows.filter(
    (row) => !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
  ));
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
      proof.version !== 1 || typeof proof.id !== "string" ||
      typeof proof.fingerprint !== "string" ||
      typeof proof.command !== "string" || !proof.command.trim() ||
      typeof proof.started_at !== "string" ||
      typeof proof.stdout !== "string" || typeof proof.stderr !== "string"
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
): Snapshot {
  const unitError = validateUnitName(unit);
  if (unitError) throw new Error(unitError);
  if (kind !== "unit" && kind !== "skeleton") throw new Error("Unknown Construction checkpoint kind.");
  const dag = resolveBoltDag(projectDir);
  if (dag.state !== "ok" || !dag.units.includes(unit)) {
    throw new Error(`Unit "${unit}" is not in the authoritative unit DAG.`);
  }
  const root = recordDir(projectDir);
  const intent = activeIntentUuid(projectDir);
  if (!root || !intent) throw new Error("Construction checkpoint requires an active intent record.");
  const state = stateContent ?? readStateFile(projectDir);
  const rows = readRows(projectDir);
  const scope = getField(state, "Scope") ?? "";
  const stages = unitMajorConstructionStageSlugs(scope, state, true);
  const errors: string[] = [];
  const enabled = checkpointPolicyEnabled(state);
  if (!enabled) errors.push("Construction Checkpoints: enabled requires solo Units with an in-scope source-producing stage.");
  if (stages.length === 0) errors.push("No applicable per-unit Construction stages.");
  const workflow = onlyLatest(rows.filter((row) => row.event === "WORKFLOW_STARTED"));
  if (!workflow) errors.push("A current, unambiguous WORKFLOW_STARTED record is required.");
  const grant = onlyLatest(rows.filter((row) =>
    row.event === "AUTONOMY_MODE_SET" || row.event === "WORKFLOW_STARTED",
  ));
  const autonomous = isAutonomousMode(state) &&
    grant?.event === "AUTONOMY_MODE_SET" &&
    auditBlockField(grant.block, "Mode") === "autonomous";
  const humanRequired = kind === "skeleton" || !autonomous;
  // Skeleton bootstrapping completes the whole first Unit even when the
  // surrounding cursor stays stage-major. Its evidence window has the same
  // start-insensitive semantics as a unit-major block; never mutate state.
  const evidenceState = setField(state, "Construction Iteration", "unit-major");
  const floors: Record<string, string> = {};
  const evidence: unknown[] = [];
  const listing = workspaceSourceListing(projectDir);
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
    const lifecycle = unitLifecycleSnapshot(projectDir, slug, rows, evidenceState);
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
      const receipts = freshReviewReceipts(projectDir, evidenceState, stage, { boltDag: dag, reviewClass });
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
  const ready = errors.length === 0;
  const verified = ready && proof !== null &&
    proof.kind === kind && proof.unit === unit &&
    proof.fingerprint === fingerprint && proof.verified === true &&
    proof.evidence_unchanged === true && proof.exit_code === 0 &&
    proof.signal === null && proof.error === null &&
    typeof proof.finished_at === "string";
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
    auditBlockField(gate.block, "Verification Command SHA-256") === digest(proof?.command) &&
    auditBlockField(gate.block, "Run floor") === floors[stages.at(-1)!] &&
    eventMatchesClaimAttempt(projectDir, gate.block, unit) &&
    (auditBlockField(gate.block, "User Input") === "Approve" ||
      (kind !== "skeleton" && auditBlockField(gate.block, "Autonomous") === "true"));
  return {
    root, rows, state,
    result: {
      kind, unit, stages, fingerprint, verified, approved,
      human_required: humanRequired, enabled, ready, errors,
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
): ConstructionCheckpoint {
  return snapshot(projectDir, unit, kind, stateContent).result;
}

function requireReady(result: ConstructionCheckpoint): void {
  if (!result.ready) throw new Error(`Construction checkpoint is not ready: ${result.errors.join(" ")}`);
}

export function verifyConstructionCheckpoint(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  checkCmd: string,
): ConstructionCheckpoint {
  if (!checkCmd.trim() || checkCmd.length > 8192 || checkCmd.includes("\0")) {
    throw new Error("An explicit nonblank project check command (at most 8192 characters) is required.");
  }
  const before = locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    requireReady(current.result);
    const proof: ConstructionCheckpointProof = {
      version: 1, id: randomUUID(), kind, unit, fingerprint: current.result.fingerprint,
      command: checkCmd, started_at: new Date().toISOString(), finished_at: null,
      exit_code: null, signal: null, stdout: "", stderr: "", error: null,
      evidence_unchanged: false, verified: false,
    };
    // Starting a new check revokes an earlier pass, including after a crash.
    writeRecordFileNoFollow(current.root, proofRelativePath(unit, kind), `${JSON.stringify(proof, null, 2)}\n`);
    const selection = resolveWorkflowSelection(projectDir);
    return { ...current, proof, intent: selection.intent!, space: selection.space };
  });
  // Match swarm checkConverged: preserve Bash project checks where available.
  const command = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", checkCmd] : ["-c", checkCmd];
  const check = spawnSync(command, args, {
    cwd: projectDir, encoding: "utf-8", timeout: CHECK_TIMEOUT_MS,
    maxBuffer: CHECK_OUTPUT_BYTES, killSignal: "SIGKILL", windowsHide: true,
  });
  const proof: ConstructionCheckpointProof = {
    ...before.proof,
    finished_at: new Date().toISOString(), exit_code: check.status,
    signal: check.signal, stdout: check.stdout ?? "", stderr: check.stderr ?? "",
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
      after.result.ready && after.result.fingerprint === before.result.fingerprint;
    proof.verified = proof.exit_code === 0 && proof.signal === null &&
      proof.error === null && proof.evidence_unchanged;
    writeRecordFileNoFollow(before.root, proofRelativePath(unit, kind), `${JSON.stringify(proof, null, 2)}\n`);
    if (after.root !== before.root) throw new Error("Active intent changed during Construction verification.");
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
    ...claimAttemptFields(projectDir, checkpoint.unit),
  };
}

function requireHuman(projectDir: string, rows: readonly AuditShardEvent[]): void {
  // This new mandatory boundary does not inherit the legacy empty-ledger or
  // environment bypass. Prompt text is not available on every harness.
  if (!rows.some((row) => row.event === "HUMAN_TURN") || !humanActedSinceGate(projectDir)) {
    throw new Error("Construction checkpoint requires a fresh human turn.");
  }
}

export function approveConstructionCheckpoint(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  userInput?: string,
): ConstructionCheckpoint {
  return locked(projectDir, () => {
    const current = snapshot(projectDir, unit, kind);
    requireReady(current.result);
    if (!current.result.verified) throw new Error("Verify the current Construction checkpoint before approval.");
    if (current.result.approved && (userInput === undefined || userInput === "Approve")) {
      return current.result;
    }
    if (current.result.human_required || userInput !== undefined) {
      if (userInput !== "Approve") throw new Error('Construction checkpoint requires the exact "Approve" choice.');
      requireHuman(projectDir, current.rows);
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
      "Verification Command SHA-256": digest(rechecked.result.verification!.command),
      ...(userInput === "Approve" ? { "User Input": userInput } : { Autonomous: "true" }),
    }, projectDir);
    return resolveConstructionCheckpoint(projectDir, unit, kind);
  });
}

export function rejectConstructionCheckpoint(
  projectDir: string,
  unit: string,
  kind: ConstructionCheckpointKind,
  userInput: string,
  reason: string,
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
    requireHuman(projectDir, current.rows);
    const rechecked = snapshot(projectDir, unit, kind);
    if (current.root !== rechecked.root || current.result.fingerprint !== rechecked.result.fingerprint) {
      throw new Error("Construction checkpoint evidence changed before rejection.");
    }
    appendAuditEntryUnlocked("GATE_REJECTED", {
      ...gateFields(projectDir, rechecked.result),
      "User Input": userInput, Feedback: reason, Reason: reason,
    }, projectDir);
    return resolveConstructionCheckpoint(projectDir, unit, kind);
  });
}
