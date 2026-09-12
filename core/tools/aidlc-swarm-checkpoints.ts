/** Human review of a completed native swarm batch, independent of its driver. */
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { appendAuditEntries, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  activeIntentUuid,
  approvedConstructionUnits,
  attemptEventDefinitelyBefore,
  auditBlockField,
  claimAttemptFields,
  currentSwarmSourceMergeChain,
  eventMatchesClaimAttempt,
  findStageBySlug,
  getField,
  gitCommitSourceListing,
  hasUnsafeSingleLineCharacter,
  humanActedSinceGate,
  intentRepos,
  isAutonomousMode,
  isNonAnswer,
  latestMainWorkflowStageRunFloorForProject,
  maximalAttemptEvents,
  readAuditShardEvents,
  readRegularFileNoFollowOrThrow,
  readStateFile,
  readUnitSourceManifest,
  recordDir,
  recordFileTargetOrThrow,
  repoDir,
  resolveBoltDag,
  resolveWorkflowSelection,
  reviewArtifactFingerprint,
  selfAttributedDecisionMarker,
  sortAttemptEvents,
  unitSourceFingerprint,
  validateUnitName,
  withAuditLock,
  workspaceSourceListing,
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

function snapshot(pd: string, batch: number, requested: string[], stateContent?: string) {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new Error("Swarm batch must be a positive integer.");
  if (!Array.isArray(requested) || requested.length === 0 ||
    requested.some((unit) => typeof unit !== "string" || validateUnitName(unit) !== null) ||
    new Set(requested).size !== requested.length) {
    throw new Error("Swarm checkpoint requires a nonempty, duplicate-free unit set.");
  }
  const state = stateContent ?? readStateFile(pd);
  const dag = resolveBoltDag(pd);
  if (dag.state !== "ok" || !dag.batches[batch - 1]) throw new Error("Swarm batch is not in the authoritative Unit DAG.");
  const inlineApproved = approvedConstructionUnits(pd, state);
  const units = dag.batches[batch - 1].filter((unit) => !inlineApproved.has(unit));
  if (!units.length || units.length !== requested.length || !units.every((unit) => requested.includes(unit))) {
    throw new Error("Swarm checkpoint must name exactly the DAG batch minus approved inline Construction units.");
  }
  const root = recordDir(pd);
  const intent = activeIntentUuid(pd);
  if (!root || !intent) throw new Error("Swarm checkpoint requires an active intent record.");
  const errors: string[] = [];
  const enabled = getField(state, "Construction Checkpoints") === "enabled" &&
    getField(state, "Construction Iteration") === "stage-major" &&
    getField(state, "Construction Execution") === "swarm";
  if (!enabled) {
    errors.push("Swarm checkpoints require enabled Construction Checkpoints, stage-major iteration, and swarm execution.");
  }
  const unreadable: string[] = [];
  const rows = sortAttemptEvents(readAuditShardEvents(pd, undefined, undefined, unreadable).filter(
    (row) => !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
  ));
  if (unreadable.length) throw new Error("Swarm checkpoint audit evidence is unreadable.");
  const workflow = latest(rows.filter((row) => row.event === "WORKFLOW_STARTED"));
  if (!workflow) errors.push("A current, unambiguous WORKFLOW_STARTED record is required.");
  const floor = latestMainWorkflowStageRunFloorForProject(pd, STAGE, false, undefined, rows);
  if (floor === "unstarted#0" || floor.startsWith("AMBIGUOUS:")) errors.push("Code Generation attempt is missing or ambiguous.");
  const grant = latest(rows.filter((row) => ["WORKFLOW_STARTED", "AUTONOMY_MODE_SET"].includes(row.event)));
  const humanRequired = !(isAutonomousMode(state) && grant?.event === "AUTONOMY_MODE_SET" &&
    auditBlockField(grant.block, "Mode") === "autonomous");
  const chain = currentSwarmSourceMergeChain(pd, STAGE);
  if (chain.state !== "ready") errors.push(`Native swarm source-merge chain is unavailable${chain.state === "invalid" ? `: ${chain.reason}` : "."}`);
  const listing = workspaceSourceListing(pd);
  if (listing === null) errors.push("Current claimed source cannot be fingerprinted.");
  const definition = findStageBySlug(STAGE);
  if (!definition) throw new Error("Code Generation stage definition is unavailable.");
  const repos = intentRepos(pd);
  const floors: Record<string, string> = {};
  const evidence = units.map((unit) => {
    const unitFloor = latestMainWorkflowStageRunFloorForProject(pd, STAGE, false, unit, rows);
    floors[unit] = unitFloor;
    if (unitFloor.startsWith("AMBIGUOUS:")) errors.push(`${unit}: current Code Generation attempt is ambiguous.`);
    const native = latest(rows.filter((row) => row.event === "SWARM_UNIT_CONVERGED" &&
      auditBlockField(row.block, "Stage") === STAGE && auditBlockField(row.block, "Unit name") === unit));
    const merged = latest(rows.filter((row) => row.event === "SWARM_SOURCE_MERGED" &&
      auditBlockField(row.block, "Stage") === STAGE && auditBlockField(row.block, "Unit name") === unit &&
      auditBlockField(row.block, "Run floor") === floor));
    const rejection = latest(rows.filter((row) => row.event === "GATE_REJECTED" &&
      (auditBlockField(row.block, "Gate Stages") ?? auditBlockField(row.block, "Stage") ?? "")
        .split(",").map((stage) => stage.trim()).includes(STAGE) &&
      (auditBlockField(row.block, "Unit") === null || auditBlockField(row.block, "Unit") === unit)));
    const commit = native && auditBlockField(native.block, "Source Commit");
    const nativeSource = native && auditBlockField(native.block, "Source Fingerprint");
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
    const artifact = reviewArtifactFingerprint(pd, definition, unit, {
      boltDag: dag, stateContent: state, requireRequiredArtifacts: true,
    });
    if (artifact === null) errors.push(`${unit}: required Code Generation outputs are missing or unbindable.`);
    // Native finalize already verified this review. Reuse its content bindings;
    // do not run another checker or manufacture another review receipt.
    const review = latest(rows.filter((row) => row.event === "REVIEW_COMPLETED" &&
      auditBlockField(row.block, "Stage") === STAGE && auditBlockField(row.block, "Unit") === unit));
    if (!review || !native || !attemptEventDefinitelyBefore(review, native) ||
      !eventMatchesClaimAttempt(pd, review.block, unit) ||
      auditBlockField(review.block, "Artifact Fingerprint") !== artifact ||
      auditBlockField(review.block, "Source Fingerprint") !== nativeSource ||
      auditBlockField(review.block, "Source Freshness Bypass") !== null ||
      auditBlockField(review.block, "Unit Source Binding Bypass") !== null) {
      errors.push(`${unit}: required outputs no longer match the review verified by native convergence.`);
    }
    let source: string | null = null;
    try {
      const path = recordFileTargetOrThrow(root, `construction/${unit}/${STAGE}/source-manifest.json`);
      const bytes = readRegularFileNoFollowOrThrow(path, "Swarm Unit source manifest");
      const manifest = readUnitSourceManifest(pd, STAGE, unit);
      if (!manifest.ok || manifest.rawBytesSha256 !== createHash("sha256").update(bytes).digest("hex")) {
        throw new Error(manifest.ok ? "source manifest changed while reading" : manifest.reason);
      }
      const repo = merged && auditBlockField(merged.block, "Repo");
      if ((repos.length > 0 && (!repo || !repos.includes(repo))) ||
        (repos.length === 0 && repo !== null && repo !== "-")) {
        throw new Error("source merge does not identify the claimed repository");
      }
      const committed = commit && gitCommitSourceListing(
        repos.length ? repoDir(pd, repo!) : pd, commit, repos.length === 0,
      );
      if (!committed) throw new Error("immutable reviewed Source Commit is unavailable");
      const localKey = (key: string): string => {
        const prefix = repos.length ? `${repo}\0` : "\0";
        if (!key.startsWith(prefix)) throw new Error("a Unit's claims must belong to its source merge repository");
        return key.slice(prefix.length - 1);
      };
      const localClaims = {
        claims: new Set([...manifest.claims].map(localKey)),
        prefixes: manifest.prefixes.map(localKey),
      };
      if (!review || unitSourceFingerprint(committed, localClaims, manifest.rawBytesSha256) !==
        auditBlockField(review.block, "Unit Source Fingerprint")) {
        throw new Error("source manifest or claimed source does not match the native reviewed binding");
      }
      const projected = repos.length
        ? new Map([...committed].map(([key, value]) => [`${repo}${key}`, value]))
        : committed;
      if (!listing) throw new Error("claimed source cannot be fingerprinted");
      source = unitSourceFingerprint(listing, manifest, manifest.rawBytesSha256);
      if (source !== unitSourceFingerprint(projected, manifest, manifest.rawBytesSha256)) {
        throw new Error("claimed source differs from the verified native Source Commit");
      }
    } catch (error) {
      errors.push(`${unit}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      unit, kind: dag.unitKinds?.get(unit) ?? null, floor: unitFloor,
      claim: claimAttemptFields(pd, unit), artifact, source,
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
  const ready = errors.length === 0;
  const approved = ready && gate?.event === "GATE_APPROVED" &&
    auditBlockField(gate.block, "Stage") === STAGE &&
    auditBlockField(gate.block, "Intent") === intent &&
    auditBlockField(gate.block, "Units") === units.join(", ") &&
    auditBlockField(gate.block, "Fingerprint") === fingerprint &&
    auditBlockField(gate.block, "Run floor") === floor &&
    (auditBlockField(gate.block, "User Input") === "Approve" ||
      auditBlockField(gate.block, "Autonomous") === "true");
  const result: SwarmCheckpoint = { batch, units, fingerprint, ready, approved, human_required: humanRequired, errors };
  return { result, root, intent, rows, floor, floors, enabled };
}

export function resolveSwarmCheckpoint(
  pd: string, batch: number, units: string[], stateContent?: string,
): SwarmCheckpoint {
  return locked(pd, () => snapshot(pd, batch, units, stateContent).result);
}

function human(pd: string, rows: readonly AuditShardEvent[]): void {
  if (!rows.some((row) => row.event === "HUMAN_TURN") || !humanActedSinceGate(pd)) {
    throw new Error("Swarm checkpoint requires a fresh human turn.");
  }
}

function fields(current: ReturnType<typeof snapshot>): Record<string, string> {
  return {
    Checkpoint: CHECKPOINT, Stage: STAGE, "Gate Stages": STAGE,
    "Batch number": String(current.result.batch), Units: current.result.units.join(", "),
    Fingerprint: current.result.fingerprint, Intent: current.intent,
    "Run floor": current.floor, "Run floors": JSON.stringify(current.floors),
  };
}

function recheck(
  pd: string, batch: number, units: string[], before: ReturnType<typeof snapshot>, root: string, approving = true,
) {
  const after = snapshot(pd, batch, units);
  if ((approving && !after.result.ready) || !after.enabled ||
    before.root !== root || after.root !== root || recordDir(pd) !== root ||
    before.result.fingerprint !== after.result.fingerprint ||
    before.result.human_required !== after.result.human_required) {
    throw new Error("Swarm checkpoint evidence changed before the decision.");
  }
  return after;
}

export function approveSwarmCheckpoint(
  pd: string, batch: number, units: string[], userInput?: string,
): SwarmCheckpoint {
  return locked(pd, (selection) => {
    const current = snapshot(pd, batch, units);
    if (!current.result.ready) throw new Error(`Swarm checkpoint is not ready: ${current.result.errors.join(" ")}`);
    if (current.result.approved && (userInput === undefined || userInput === "Approve")) {
      return current.result;
    }
    if (current.result.human_required || userInput !== undefined) {
      if (userInput !== "Approve") throw new Error('Swarm checkpoint requires the exact "Approve" choice.');
      human(pd, current.rows);
    }
    const after = recheck(pd, batch, units, current, selection.root);
    appendAuditEntryUnlocked("GATE_APPROVED", {
      ...fields(after),
      ...(userInput === "Approve" ? { "User Input": userInput } : { Autonomous: "true" }),
    }, pd, selection.intent, selection.space);
    return snapshot(pd, batch, units).result;
  });
}

export function rejectSwarmCheckpoint(
  pd: string, batch: number, units: string[], userInput: string, reason: string,
): SwarmCheckpoint {
  if (userInput !== "Request Changes") throw new Error('Swarm checkpoint requires the exact "Request Changes" choice.');
  if (isNonAnswer(reason) || reason.length > 8192 || hasUnsafeSingleLineCharacter(reason) ||
    selfAttributedDecisionMarker(reason, "rejection")) {
    throw new Error("Swarm rejection requires a nonblank human reason on one line.");
  }
  return locked(pd, (selection) => {
    const current = snapshot(pd, batch, units);
    if (!current.enabled) throw new Error("Swarm checkpoints are not enabled for this execution policy.");
    human(pd, current.rows);
    const after = recheck(pd, batch, units, current, selection.root, false);
    appendAuditEntries(after.result.units.map((unit) => ({
      eventType: "GATE_REJECTED",
      fields: {
        ...fields(after), Unit: unit, ...claimAttemptFields(pd, unit),
        "User Input": userInput, Reason: reason, Feedback: reason,
      },
    })), pd, selection.intent, selection.space);
    return snapshot(pd, batch, units).result;
  });
}
