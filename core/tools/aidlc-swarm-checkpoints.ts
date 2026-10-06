/** Human review of a completed native swarm batch, independent of its driver. */
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { appendAuditEntries, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { loadConstructionEvidence, type ConstructionEvidence } from "./aidlc-construction-checkpoints.ts";
import {
  activeIntentUuid,
  approvedConstructionUnits,
  attemptEventDefinitelyBefore,
  auditBlockField,
  authorizedVerificationCommand,
  claimAttemptFields,
  currentSwarmSourceMergeChain,
  eventMatchesClaimAttempt,
  findStageBySlug,
  getField,
  guardPolicyAcceptsChanges,
  hasUnsafeSingleLineCharacter,
  consumeProtectedQuestion,
  unitPlainName,
  withdrawProtectedQuestions,
  changeRequestWords,
  readProtectedResponse,
  requireProtectedResponse,
  protectedTargetDigest,
  mintProtectedQuestion,
  intentRepos,
  isAutonomousMode,
  isNonAnswer,
  latestMainWorkflowStageRunFloorForProject,
  maximalAttemptEvents,
  readAuditShardEvents,
  readCommittedUnitSourceManifest,
  readRegularFileNoFollowOrThrow,
  readStateFile,
  recordAcceptedChanges,
  recordDir,
  recordFileTargetOrThrow,
  repoDir,
  resolveBoltDag,
  resolveWorkflowSelection,
  renderChangedPaths,
  reviewArtifactFingerprint,
  selfAttributedDecisionMarker,
  sortAttemptEvents,
  sourceClaimCovers,
  sourceListingChangedPaths,
  unitSourceFingerprint,
  validateUnitName,
  withAuditLock,
  workspaceSourceListing,
  type AcceptedChange,
  type AuditShardEvent,
} from "./aidlc-lib.ts";

export interface SwarmCheckpoint {
  batch: number;
  units: string[];
  fingerprint: string;
  ready: boolean;
  approved: boolean;
  human_required: boolean;
  errors: string[];
  /** Under strict, the batch's files or outputs changed after it was checked:
   *  `ask` then offers Request Changes, so the person always has a way on. */
  changed_after_check: boolean;
  /** Lines for changes kept under a relaxed or off Guard Policy. */
  notices?: string[];
}

const STAGE = "code-generation";
const CHECKPOINT = "swarm-batch";
const hash = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

function latest(rows: readonly AuditShardEvent[]): AuditShardEvent | null {
  const frontier = maximalAttemptEvents(rows);
  return frontier.length === 1 ? frontier[0] : null;
}

function locked<T>(
  pd: string,
  fn: (selection: { root: string; intent: string; space: string }) => T extends Promise<unknown> ? never : T,
): T extends Promise<unknown> ? never : T {
  const { intent, space } = resolveWorkflowSelection(pd);
  if (!intent) throw new Error("Swarm checkpoint requires an active intent.");
  const root = recordDir(pd, intent, space);
  if (!root) throw new Error("Swarm checkpoint requires an active intent record.");
  return withAuditLock<T>(pd, () => {
    if (recordDir(pd) !== root) throw new Error("Active intent changed before swarm checkpoint.");
    return fn({ root, intent, space });
  }, intent, space);
}

function snapshot(pd: string, batch: number, requested: string[], stateContent?: string, sharedEvidence?: ConstructionEvidence) {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new Error("Swarm batch must be a positive integer.");
  if (!Array.isArray(requested) || requested.length === 0 ||
    requested.some((unit) => typeof unit !== "string" || validateUnitName(unit) !== null) ||
    new Set(requested).size !== requested.length) {
    throw new Error("Swarm checkpoint requires a nonempty, duplicate-free unit set.");
  }
  const state = stateContent ?? readStateFile(pd);
  const shared = sharedEvidence
    ? sharedEvidence.state === state && sharedEvidence.root === recordDir(pd)
      ? sharedEvidence : loadConstructionEvidence(pd, state)
    : undefined;
  const dag = shared?.dag ?? resolveBoltDag(pd);
  if (dag.state !== "ok" || !dag.batches[batch - 1]) throw new Error("Swarm batch is not in the authoritative Unit DAG.");
  const inlineApproved = approvedConstructionUnits(pd, state, shared);
  const units = dag.batches[batch - 1].filter((unit) => !inlineApproved.has(unit));
  if (!units.length || units.length !== requested.length || !units.every((unit) => requested.includes(unit))) {
    throw new Error("Swarm checkpoint must name exactly the DAG batch minus approved inline Construction units.");
  }
  const root = recordDir(pd);
  const intent = activeIntentUuid(pd);
  if (!root || !intent) throw new Error("Swarm checkpoint requires an active intent record.");
  const errors: string[] = [];
  // Changes found after the batch was checked: kept under relaxed or off, an
  // error under strict (where they are the only errors, `ask` still asks).
  const acceptsChanges = guardPolicyAcceptsChanges(pd, state);
  const accepted: AcceptedChange[] = [];
  const driftErrors = new Set<string>();
  const changedAfterCheck = (unit: string, error: string, change: Omit<AcceptedChange, "checkpoint" | "stage" | "unit">) => {
    if (acceptsChanges) {
      accepted.push({ checkpoint: "swarm-batch", stage: STAGE, unit, ...change });
      return;
    }
    driftErrors.add(error);
    errors.push(error);
  };
  const enabled = getField(state, "Construction Checkpoints") === "enabled" &&
    getField(state, "Construction Iteration") === "stage-major" &&
    getField(state, "Construction Execution") === "swarm";
  if (!enabled) {
    errors.push("Swarm checkpoints require enabled Construction Checkpoints, stage-major iteration, and swarm execution.");
  }
  const unreadable: string[] = [];
  const rows = shared?.rows ?? sortAttemptEvents(readAuditShardEvents(pd, undefined, undefined, unreadable).filter(
    (row) => !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
  ));
  if (unreadable.length) throw new Error("Swarm checkpoint audit evidence is unreadable.");
  const verificationCommand = shared ? shared.verificationCommand : authorizedVerificationCommand(pd, state, rows);
  const workflow = shared ? shared.workflow : latest(rows.filter((row) => row.event === "WORKFLOW_STARTED"));
  if (!workflow) errors.push("A current, unambiguous WORKFLOW_STARTED record is required.");
  const floor = latestMainWorkflowStageRunFloorForProject(pd, STAGE, false, undefined, rows);
  if (floor === "unstarted#0" || floor.startsWith("AMBIGUOUS:")) errors.push("Code Generation attempt is missing or ambiguous.");
  const grant = shared ? shared.grant : latest(rows.filter((row) => ["WORKFLOW_STARTED", "AUTONOMY_MODE_SET"].includes(row.event)));
  const humanRequired = !(isAutonomousMode(state) && grant?.event === "AUTONOMY_MODE_SET" &&
    auditBlockField(grant.block, "Mode") === "autonomous");
  const chain = currentSwarmSourceMergeChain(pd, STAGE, undefined, undefined, shared?.allRows);
  if (chain.state !== "ready") errors.push(`Native swarm source-merge chain is unavailable${chain.state === "invalid" ? `: ${chain.reason}` : "."}`);
  const listing = shared ? shared.listing : workspaceSourceListing(pd);
  if (listing === null) errors.push("Current claimed source cannot be fingerprinted.");
  const definition = findStageBySlug(STAGE);
  if (!definition) throw new Error("Code Generation stage definition is unavailable.");
  const repos = intentRepos(pd);
  const floors: Record<string, string> = {};
  const commandSha256s: Record<string, string> = {};
  // Units checked with an earlier approved command: an already approved batch
  // keeps its approval; any other batch needs the current command.
  const olderCommand = new Set<string>();
  const evidence = units.map((unit) => {
    const unitFloor = latestMainWorkflowStageRunFloorForProject(pd, STAGE, false, unit, rows);
    floors[unit] = unitFloor;
    if (unitFloor.startsWith("AMBIGUOUS:")) errors.push(`${unit}: current Code Generation attempt is ambiguous.`);
    const native = latest(rows.filter((row) => row.event === "SWARM_UNIT_CONVERGED" &&
      auditBlockField(row.block, "Stage") === STAGE && auditBlockField(row.block, "Unit name") === unit &&
      auditBlockField(row.block, "Run floor") === floor));
    const merged = latest(rows.filter((row) => row.event === "SWARM_SOURCE_MERGED" &&
      auditBlockField(row.block, "Stage") === STAGE && auditBlockField(row.block, "Unit name") === unit &&
      auditBlockField(row.block, "Run floor") === floor));
    const rejection = latest(rows.filter((row) => row.event === "GATE_REJECTED" &&
      (auditBlockField(row.block, "Gate Stages") ?? auditBlockField(row.block, "Stage") ?? "")
        .split(",").map((stage) => stage.trim()).includes(STAGE) &&
      (auditBlockField(row.block, "Unit") === null || auditBlockField(row.block, "Unit") === unit)));
    const commit = native && auditBlockField(native.block, "Source Commit");
    const nativeSource = native && auditBlockField(native.block, "Source Fingerprint");
    commandSha256s[unit] = native ? auditBlockField(native.block, "Command SHA-256") ?? "" : "";
    if (!native || !merged || !commit || !/^[0-9a-f]{40,64}$/.test(commit) ||
      !nativeSource || !/^[0-9a-f]{40,64}$/.test(nativeSource) ||
      auditBlockField(native.block, "Source Freshness Bypass") !== null ||
      auditBlockField(native.block, "Batch number") !== String(batch) ||
      auditBlockField(native.block, "Run floor") !== floor ||
      auditBlockField(merged.block, "Source Commit") !== commit ||
      auditBlockField(merged.block, "Batch number") !== String(batch) ||
      chain.state !== "ready" || !chain.units.has(unit) ||
      (rejection !== null && !attemptEventDefinitelyBefore(rejection, native))) {
      errors.push(`${unit}: current native convergence and its source merge are required.`);
    }
    if (!verificationCommand || !native || !/^[a-f0-9]{64}$/.test(commandSha256s[unit])) {
      errors.push(`${unit}: batch was not checked with the authorized Construction Verification Command.`);
    } else if (commandSha256s[unit] !== verificationCommand.sha256) {
      olderCommand.add(unit);
    }
    const artifact = reviewArtifactFingerprint(pd, definition, unit, {
      boltDag: dag, stateContent: state, requireRequiredArtifacts: true,
    });
    if (artifact === null) errors.push(`${unit}: required Code Generation outputs are missing or unbindable.`);
    // Native finalize already verified this review. Reuse its content bindings;
    // do not run another checker or manufacture another review receipt.
    const review = latest(rows.filter((row) => row.event === "REVIEW_COMPLETED" &&
      auditBlockField(row.block, "Stage") === STAGE && auditBlockField(row.block, "Unit") === unit));
    // What finalize kept after this review under relaxed or off: the review
    // stands for the kept content, and finalize already said so once. The
    // review row reaches this audit at merge, after finalize's row, so the
    // two are ordered by time (to the second, so the same second counts), not
    // by position.
    const keptRows = review ? rows.filter((row) => row.event === "CHANGE_ACCEPTED" &&
      auditBlockField(row.block, "Checkpoint") === "review-receipt" &&
      auditBlockField(row.block, "Stage") === STAGE && auditBlockField(row.block, "Unit") === unit &&
      review.timestamp <= row.timestamp) : [];
    const reviewedOrKept = (field: string): string | null => {
      const recorded = review ? auditBlockField(review.block, field) : null;
      const kept = latest(keptRows.filter((row) => auditBlockField(row.block, "Recorded") === recorded));
      return kept ? auditBlockField(kept.block, "Current") : recorded;
    };
    const reviewedArtifact = reviewedOrKept("Artifact Fingerprint");
    let boundArtifact = artifact;
    if (!review || !native || !attemptEventDefinitelyBefore(review, native) ||
      (rejection !== null && !attemptEventDefinitelyBefore(rejection, review)) ||
      !eventMatchesClaimAttempt(pd, review.block, unit) ||
      reviewedOrKept("Source Fingerprint") !== nativeSource ||
      auditBlockField(review.block, "Source Freshness Bypass") !== null ||
      auditBlockField(review.block, "Unit Source Binding Bypass") !== null) {
      errors.push(`${unit}: required outputs no longer match the review verified by native convergence.`);
    } else if (artifact !== null && reviewedArtifact !== artifact) {
      changedAfterCheck(unit, `${unit}: required outputs no longer match the review verified by native convergence.`, {
        changed: null, recorded: reviewedArtifact ?? "", current: artifact,
        notice: `The ${unitPlainName(unit)} Unit's Code Generation documents changed after its batch was checked. Kept them.`,
      });
      if (acceptsChanges) boundArtifact = reviewedArtifact;
    }
    let source: string | null = null;
    try {
      const path = recordFileTargetOrThrow(root, `construction/${unit}/${STAGE}/source-manifest.json`);
      const bytes = readRegularFileNoFollowOrThrow(path, "Swarm Unit source manifest");
      const repo = merged && auditBlockField(merged.block, "Repo");
      if ((repos.length > 0 && (!repo || !repos.includes(repo))) ||
        (repos.length === 0 && repo !== null && repo !== "-")) {
        throw new Error("source merge does not identify the claimed repository");
      }
      if (!commit) throw new Error("immutable reviewed Source Commit is unavailable");
      const manifest = readCommittedUnitSourceManifest(
        repos.length ? repoDir(pd, repo!) : pd, commit, repos.length === 0, STAGE, unit, bytes,
      );
      if (!manifest.ok) throw new Error(manifest.reason);
      const committed = manifest.listing;
      if (!review) throw new Error("source manifest or claimed source does not match the native reviewed binding");
      // A Unit finalize kept a change for lands as it was kept, not as reviewed.
      // A list of files changed after that is kept under relaxed or off.
      const bound = unitSourceFingerprint(committed, manifest, manifest.rawBytesSha256);
      const reviewedBinding = auditBlockField(review.block, "Unit Source Fingerprint");
      if (keptRows.length === 0 && bound !== reviewedBinding) {
        const error = "source manifest or claimed source does not match the native reviewed binding";
        if (!acceptsChanges) throw new Error(error);
        changedAfterCheck(unit, `${unit}: ${error}`, {
          changed: null, recorded: reviewedBinding ?? "", current: bound,
          notice: `The ${unitPlainName(unit)} Unit's list of files changed after its batch was checked. Kept them.`,
        });
      }
      const parentClaims = {
        claims: new Set([...manifest.claims].map((key) => repos.length ? `${repo}${key}` : key)),
        prefixes: manifest.prefixes.map((key) => repos.length ? `${repo}${key}` : key),
      };
      const projected = repos.length
        ? new Map([...committed].map(([key, value]) => [`${repo}${key}`, value]))
        : committed;
      if (!listing) throw new Error("claimed source cannot be fingerprinted");
      source = unitSourceFingerprint(listing, parentClaims, manifest.rawBytesSha256);
      const checked = unitSourceFingerprint(projected, parentClaims, manifest.rawBytesSha256);
      if (source !== checked) {
        const claimed = (from: ReadonlyMap<string, string>) =>
          new Map([...from].filter(([key]) => sourceClaimCovers(key, parentClaims)));
        const paths = sourceListingChangedPaths(claimed(projected), claimed(listing));
        changedAfterCheck(unit, `${unit}: claimed source differs from the verified native Source Commit`, {
          changed: paths, recorded: checked, current: source,
          notice: `Files from the ${unitPlainName(unit)} Unit changed after its batch was checked: ${renderChangedPaths(paths)}. Kept them.`,
        });
        // Kept: the batch stays bound to the source it was checked with.
        if (acceptsChanges) source = checked;
      }
    } catch (error) {
      errors.push(`${unit}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      unit, kind: dag.unitKinds?.get(unit) ?? null, floor: unitFloor,
      claim: claimAttemptFields(pd, unit), artifact: boundArtifact, source,
      // Native receipt/merge provenance establishes readiness above; the
      // approval binds the reviewed content rather than receipt timestamps.
      reviewer: review ? auditBlockField(review.block, "Reviewer") : null,
      review_verdict: review ? auditBlockField(review.block, "Verdict") : null,
    };
  });
  const fingerprint = hash({
    version: 1, intent, record: relative(pd, root), batch, units, floor,
    workflow: workflow ? hash(workflow.block) : null, evidence,
  });
  const gate = latest(rows.filter((row) =>
    (row.event === "GATE_APPROVED" || row.event === "GATE_REJECTED") &&
    auditBlockField(row.block, "Checkpoint") === CHECKPOINT &&
    auditBlockField(row.block, "Batch number") === String(batch),
  ));
  const gateApproved = (commandSha256: string | undefined) => gate?.event === "GATE_APPROVED" &&
    commandSha256 !== undefined &&
    auditBlockField(gate.block, "Stage") === STAGE &&
    auditBlockField(gate.block, "Intent") === intent &&
    auditBlockField(gate.block, "Units") === units.join(", ") &&
    auditBlockField(gate.block, "Fingerprint") === fingerprint &&
    auditBlockField(gate.block, "Run floor") === floor &&
    auditBlockField(gate.block, "Command SHA-256") === commandSha256 &&
    (auditBlockField(gate.block, "User Input") === "Approve" ||
      auditBlockField(gate.block, "Autonomous") === "true");
  const earlierCommands = new Set(units.filter((unit) => olderCommand.has(unit)).map((unit) => commandSha256s[unit]));
  const keptUnderEarlierCommand = olderCommand.size === units.length && earlierCommands.size === 1 &&
    gateApproved([...earlierCommands][0]);
  if (olderCommand.size > 0 && !keptUnderEarlierCommand) {
    for (const unit of units) {
      if (olderCommand.has(unit)) errors.push(`${unit}: batch was not checked with the authorized Construction Verification Command.`);
    }
  }
  const ready = errors.length === 0;
  const changedOnly = !ready && errors.every((error) => driftErrors.has(error));
  const approved = ready && (keptUnderEarlierCommand || gateApproved(verificationCommand?.sha256));
  const result: SwarmCheckpoint = {
    batch, units, fingerprint, ready, approved, human_required: humanRequired, errors, changed_after_check: changedOnly,
  };
  return { result, root, intent, rows, floor, floors, enabled, verificationCommand, commandSha256s, accepted };
}

export function resolveSwarmCheckpoint(
  pd: string, batch: number, units: string[], stateContent?: string,
  evidence?: ConstructionEvidence,
): SwarmCheckpoint {
  return locked(pd, () => snapshot(pd, batch, units, stateContent, evidence).result);
}

function approvalTarget(checkpoint: SwarmCheckpoint, commandSha256s: Record<string, string>) {
  return {
    kind: "batch" as const, batch: checkpoint.batch, units: checkpoint.units,
    fingerprint: checkpoint.fingerprint, commandSha256s,
  };
}

export function askSwarmCheckpoint(pd: string, batch: number, units: string[], session: string): SwarmCheckpoint {
  return locked(pd, (selection) => {
    const current = snapshot(pd, batch, units);
    if (!current.enabled) throw new Error("Swarm checkpoints are not enabled for this execution policy.");
    // A batch whose files changed after it was checked cannot be approved
    // under strict, but the person can still send it back for changes.
    if (!current.result.ready && !current.result.changed_after_check) {
      throw new Error(`Swarm checkpoint is not ready: ${current.result.errors.join(" ")}`);
    }
    const notices = recordAcceptedChanges(pd, current.accepted);
    withdrawProtectedQuestions(pd, session);
    appendAuditEntryUnlocked("DECISION_RECORDED", {
      Checkpoint: "Swarm Batch Approval", Stage: STAGE, "Batch number": String(batch),
      Units: current.result.units.join(", "), Fingerprint: current.result.fingerprint,
      Session: session, Options: current.result.ready ? "Approve,Request Changes" : "Request Changes",
    }, pd, selection.intent, selection.space);
    mintProtectedQuestion(pd, {
      kind: "checkpoint-approval", session, target: approvalTarget(current.result, current.commandSha256s),
    });
    return notices.length > 0 ? { ...current.result, notices } : current.result;
  });
}

function fields(current: ReturnType<typeof snapshot>): Record<string, string> {
  return {
    Checkpoint: CHECKPOINT, Stage: STAGE, "Gate Stages": STAGE,
    "Batch number": String(current.result.batch), Units: current.result.units.join(", "),
    Fingerprint: current.result.fingerprint, Intent: current.intent,
    "Run floor": current.floor, "Run floors": JSON.stringify(current.floors),
    ...(current.verificationCommand ? { "Command SHA-256": current.verificationCommand.sha256 } : {}),
  };
}

function recheck(
  pd: string, batch: number, units: string[], before: ReturnType<typeof snapshot>, root: string, approving = true,
) {
  const after = snapshot(pd, batch, units);
  if ((approving && !after.result.ready) || !after.enabled ||
    before.root !== root || after.root !== root || recordDir(pd) !== root ||
    before.result.fingerprint !== after.result.fingerprint ||
    before.verificationCommand?.sha256 !== after.verificationCommand?.sha256 ||
    before.result.human_required !== after.result.human_required) {
    throw new Error("Swarm checkpoint evidence changed before the decision.");
  }
  return after;
}

export function approveSwarmCheckpoint(
  pd: string, batch: number, units: string[], reply?: string, session = "",
): SwarmCheckpoint {
  // The conductor read the person's reply and reports their approval; the
  // receipt records it beside the person's own words from the human-turn hook.
  return locked(pd, (selection) => {
    const current = snapshot(pd, batch, units);
    if (!current.result.ready) throw new Error(`Swarm checkpoint is not ready: ${current.result.errors.join(" ")}`);
    const humanRequired = current.result.human_required || reply !== undefined;
    let words: string | undefined;
    if (humanRequired) {
      requireProtectedResponse(pd, session, {
        kind: "checkpoint-approval", targetDigest: protectedTargetDigest(approvalTarget(current.result, current.commandSha256s)), choice: "Approve",
      });
      words = readProtectedResponse(pd, session)?.words;
    } else if (current.result.approved) {
      return current.result;
    }
    const after = recheck(pd, batch, units, current, selection.root);
    const notices = recordAcceptedChanges(pd, after.accepted);
    appendAuditEntryUnlocked("GATE_APPROVED", {
      ...fields(after),
      ...(humanRequired ? { Session: session } : {}),
      ...(humanRequired ? { "User Input": "Approve" } : { Autonomous: "true" }),
      ...(words ? { "Person Reply": words } : {}),
    }, pd, selection.intent, selection.space);
    if (humanRequired) consumeProtectedQuestion(pd, session);
    const result = snapshot(pd, batch, units).result;
    return notices.length > 0 ? { ...result, notices } : result;
  });
}

export function rejectSwarmCheckpoint(
  pd: string, batch: number, units: string[], _reply: string, givenReason: string, session = "",
): SwarmCheckpoint {
  // The conductor read the person's reply as a change request. The reason is
  // the conductor's --reason when given, otherwise the person's own words.
  return locked(pd, (selection) => {
    const current = snapshot(pd, batch, units);
    if (!current.enabled) throw new Error("Swarm checkpoints are not enabled for this execution policy.");
    requireProtectedResponse(pd, session, {
      kind: "checkpoint-approval", targetDigest: protectedTargetDigest(approvalTarget(current.result, current.commandSha256s)), choice: "Request Changes",
    });
    const words = readProtectedResponse(pd, session)?.words;
    const reason = givenReason.trim() || changeRequestWords(words);
    const userInput = "Request Changes";
    if (isNonAnswer(reason) || reason.length > 8192 || hasUnsafeSingleLineCharacter(reason) ||
      selfAttributedDecisionMarker(reason, "rejection")) {
      throw new Error("Swarm Request Changes needs what the person asked to change, on one line, in --reason.");
    }
    const after = recheck(pd, batch, units, current, selection.root, false);
    appendAuditEntries(after.result.units.map((unit) => ({
      eventType: "GATE_REJECTED",
      fields: {
        ...fields(after), Unit: unit, ...claimAttemptFields(pd, unit),
        Session: session,
        "User Input": userInput, Reason: reason, Feedback: reason,
        ...(words ? { "Person Reply": words } : {}),
      },
    })), pd, selection.intent, selection.space);
    consumeProtectedQuestion(pd, session);
    return snapshot(pd, batch, units).result;
  });
}
