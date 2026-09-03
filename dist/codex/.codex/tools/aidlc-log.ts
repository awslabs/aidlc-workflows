// aidlc-log.ts — Interaction audit helper
//
// Records DECISION_RECORDED (before AskUserQuestion), QUESTION_ANSWERED
// (after ordinary answers), SUMMARY_CONFIRMATION_RECORDED (the reserved,
// human-backed pre-generation receipt), and REVIEW_REQUESTED / REVIEW_COMPLETED
// (the §12a reviewer step). Orchestrator-callable; state tool doesn't own these
// because they fire per-question / per-review, not per state transition.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendAuditEntry, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  assertNoSymlinkInChainOrThrow,
  auditBlockField,
  checkSummaryConfirmationEvidence,
  claimAttemptFields,
  clearSummaryAuthorization,
  isPerUnitStage,
  SUMMARY_AUTHORIZATION_FIELD,
  SUMMARY_EVIDENCE_EVENTS,
  type SummaryAuthorization,
  summaryAttemptFloors,
  summaryAttemptIdentity,
  summaryAuthorizationId,
  removeRecordFileNoFollow,
  SUMMARY_AUTHORIZATION_DIR,
  summaryAuthorizationRelativePath,
  summaryAuthorizationTargetOrThrow,
  writeRecordFileNoFollow,
  writeSummaryAuthorization,
  emitError,
  errorMessage,
  evaluateGuardRefusal,
  eventMatchesClaimAttempt,
  formatReceivedReply,
  freshReviewReceipts,
  filterProducesByKind,
  getField,
  guardAttemptState,
  guardRefusalOutput,
  humanAuthorityState,
  holdsAuditLock,
  humanActedSinceLastAnswer,
  humanPresenceGuardDisabled,
  isAutonomousConstructionDecision,
  legacyReviewAppendixEchoFields,
  isAutonomousSwarmStage,
  loadStageGraphAll,
  isNonAnswer,
  isoTimestamp,
  latestPipelineLinkArtifactMtime,
  parseCheckboxes,
  parseReviewSection,
  pipelineAttemptStartedAt,
  pipelineLinkEvidence,
  pipelineLinks,
  pendingReviewRequestStatus,
  readAllAuditShards,
  recordAcceptedChanges,
  governedChangeControl,
  readAuditShardEvents,
  readRegularFileNoFollowOrThrow,
  readStateFile,
  readUnitSourceManifest,
  recordDir,
  relativeRecordDir,
  recoveryGuidance,
  requestChangesResetIsExecutable,
  reviewAppendedAfterRequest,
  reviewArtifactSnapshot,
  reviewAttemptId,
  reviewDraftRelativePath,
  reviewRecordDigest,
  reviewRecordRelativePath,
  reviewRequestArtifactsCurrent,
  REVIEW_RECORD_MAX_BYTES,
  resolveBoltDag,
  reviewAttemptAccounting,
  reviewAttemptEventMatchesCurrentClaim,
  reviewAttemptWindow,
  serializeReviewRecord,
  resolveProjectDir,
  resolveWorkflowSelection,
  resolveReviewClass,
  selfAttributedDecisionMarker,
  SUMMARY_CONFIRMATION_CHECKPOINT,
  SUMMARY_CONFIRMATION_HASH_SCOPE,
  summaryConfirmationAnswer,
  summaryConfirmationContentHash,
  stateFilePath,
  teamUnitGateStatus,
  toPosix,
  unattendedHumanPresenceHint,
  unitSourceFingerprint,
  UNBINDABLE_FINGERPRINT,
  validateLiveUnitScope,
  validateReviewAppendix,
  withAuditLock,
  workspaceSourceState,
  writeUnitSourceSnapshot,
} from "./aidlc-lib.js";
import type {
  GuardAttemptState,
  GuardRefusal,
  TeamUnitGateResolution,
  ReviewClass,
  ReviewRecord,
  ReviewVerdict,
} from "./aidlc-lib.js";
import {
  codeGenerationPlanApprovalQuestionEvidence,
  type CodeGenerationTarget,
  PLAN_APPROVAL_CHECKPOINT,
  PlanApprovalSourceDriftError,
  recordPlanApprovalChallenge,
  recordPlanApprovalReceipt,
} from "./aidlc-testing-posture.js";

// Resolve the project dir AND assert that an active workflow exists before any
// audit emit. WHY: aidlc-log is orchestrator-called per-question and threads no
// --intent/--space, so it relies on default intent resolution. On a fresh shell
// (pre-creation) or a >1-intent workspace with no active-intent cursor, that
// resolution yields null and stateFilePath()/auditFilePath() collapse to the
// BARE space record root (aidlc/spaces/<space>/intents/). Emitting there would
// drop an audit shard DIRECTLY into the bare intents root and break the "no
// aidlc-state.md / no audit/ ever lives directly in the bare intents root"
// invariant (aidlc-lib.ts). Existence of the resolved state file is the same
// "is there an active workflow" signal every other emitter guards on — the
// hooks via `if (!existsSync(stateFilePath(...)))` no-op, emitError() via the
// same check. aidlc-log is the lone emitter that was missing it; mirror the
// clean-error idiom (orchestrator-called → a missing workflow is a misuse, not
// a routine no-op).
function resolveActiveProjectDir(explicit?: string): string {
  const pd = resolveProjectDir(explicit);
  if (!existsSync(stateFilePath(pd))) {
    error(
      'No active workflow is selected, so this interaction cannot be recorded. Start one by describing what to build (/aidlc "build the auth service"), or switch to an existing one with /aidlc intent <name>.'
    );
  }
  return pd;
}

// handleAnswer emits inside a withAuditLock section (classification and
// emission share one snapshot); appendAuditEntry acquires the OS lock itself,
// so route held-lock emits through the unlocked variant (the aidlc-state.ts
// idiom) to avoid self-deadlocking on the lock dir we already hold.
function emitAudit(
  pd: string,
  eventType: string,
  fields: Record<string, string>,
  intent?: string,
  space?: string,
): void {
  if (holdsAuditLock(pd, intent, space)) {
    appendAuditEntryUnlocked(eventType, fields, pd, intent, space);
    return;
  }
  appendAuditEntry(eventType, fields, pd, intent, space);
}

// --- Flag parsing ---

function parseFlags(
  args: string[]
): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (a === "--single" || a === "--retry-pending" || a === "--stage-level") {
        flags[a.slice(2)] = "true";
        continue;
      }
      if (i + 1 >= args.length) {
        error(`${a} expects a value, got end of arguments.`);
      }
      const val = args[i + 1];
      if (val.startsWith("--")) {
        error(`${a} expects a value, got another flag: "${val}". Did you forget the value?`);
      }
      flags[a.slice(2)] = val;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// Whether anything sits at the path, symlink included, without following it.
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function summaryQuestionEvidence(
  pd: string,
  flags: Record<string, string>,
  expectedAnswer: string,
): { relativePath: string; sha256: string } {
  const supplied = flags["questions-file"];
  if (!supplied) {
    error(
      "Summary confirmation requires --questions-file <path> so the receipt can bind to the reviewed answers.",
    );
  }
  const absolute = resolve(pd, supplied);
  const root = recordDir(pd);
  if (
    root === null ||
    (absolute !== root && !absolute.startsWith(`${root}${sep}`))
  ) {
    error(
      `Summary confirmation questions file must be inside the active intent record: ${supplied}`,
    );
  }
  if (!absolute.endsWith("-questions.md") || !existsSync(absolute)) {
    error(`Summary confirmation questions file does not exist: ${supplied}`);
  }

  const body = readFileSync(absolute, "utf-8");
  if (summaryConfirmationAnswer(body) !== expectedAnswer) {
    const rendered = expectedAnswer || "a blank value";
    error(
      `Summary confirmation section in ${supplied} must contain exactly one ` +
      `\`[Answer]:\` line with ${rendered} before this command runs.`,
    );
  }

  let sha256: string;
  try {
    sha256 = summaryConfirmationContentHash(body);
  } catch (e) {
    error(
      `Summary confirmation questions file ${supplied} is invalid: ${errorMessage(e)}.`,
    );
  }
  return {
    relativePath: toPosix(relative(pd, absolute)),
    sha256,
  };
}

function planApprovalTarget(flags: Record<string, string>): CodeGenerationTarget {
  const unit = flags.unit?.trim();
  const stageLevel = flags["stage-level"] === "true";
  if (unit && stageLevel) {
    error("Plan Approval accepts exactly one of --unit <unit> or --stage-level.");
  }
  if (unit) return { unit };
  if (stageLevel) return { unit: null };
  error("Plan Approval requires exactly one of --unit <unit> or --stage-level.");
}

function planApprovalFields(
  evidence: ReturnType<typeof codeGenerationPlanApprovalQuestionEvidence>,
): Record<string, string> {
  return {
    Checkpoint: PLAN_APPROVAL_CHECKPOINT,
    "Plan Target": evidence.authority.targetId,
    Intent: evidence.authority.intentId,
    "Directive Epoch": evidence.authority.directiveEpoch,
    "Run floor": evidence.authority.runFloor,
    "Approval Fingerprint": evidence.fingerprint,
    "Questions File": evidence.questionsRelativePath,
    "Questions SHA-256": evidence.questionsSha256,
    "Prompt SHA-256": evidence.promptSha256,
  };
}

// --- Subcommand: decision ---
// Usage: aidlc-log decision --stage <slug> --decision <text> [--options <csv>]
//   [--rationale <text>] [--checkpoint summary-confirmation
//   --questions-file <path> [--unit <unit>] [--single]]
//
// Fires BEFORE AskUserQuestion, recording what options will be shown.
function handleDecision(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.decision) error("Missing --decision <text>");
  if (
    flags.checkpoint !== undefined &&
    flags.checkpoint !== "summary-confirmation" &&
    flags.checkpoint !== "plan-approval"
  ) {
    error(
      `Unknown --checkpoint "${flags.checkpoint}". Accepted: summary-confirmation, plan-approval`,
    );
  }

  const pd = resolveActiveProjectDir(projectDir);
  if (flags.unit) validateLiveUnitScope(pd, flags.unit);
  const summaryEvidence =
    flags.checkpoint === "summary-confirmation"
      ? summaryQuestionEvidence(pd, flags, "")
      : null;
  // The plan-approval checkpoint is a governed Change Control read: resolve the
  // setting first (a memory edit that moved it is recorded here), then judge
  // the source the plan was written against.
  if (flags.checkpoint === "plan-approval") governedChangeControl(pd);
  const planEvidence =
    flags.checkpoint === "plan-approval"
      ? codeGenerationPlanApprovalQuestionEvidence(
          pd,
          planApprovalTarget(flags),
          flags["questions-file"] ?? "",
          "",
        )
      : null;
  // Record the acceptance before the decision row and the challenge: the
  // re-baseline already happened in the questions file, so the ledger must
  // carry the change even if a later step in this command refuses.
  const changeNotices = planEvidence
    ? recordAcceptedChanges(pd, planEvidence.acceptedChanges)
    : [];
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Decision: flags.decision,
  };
  if (flags.options) {
    fields.Options =
      planEvidence &&
          (
            flags["hash-option-labels"] === "true" ||
            flags["legacy-directive-options"] === "true"
          )
        ? "[protected exact choices]"
        : flags.options;
  }
  if (flags.rationale) fields.Rationale = flags.rationale;
  if (flags.checkpoint === "summary-confirmation") {
    fields.Checkpoint = SUMMARY_CONFIRMATION_CHECKPOINT;
    fields["Questions File"] = summaryEvidence!.relativePath;
  }
  if (planEvidence) Object.assign(fields, planApprovalFields(planEvidence));
  if (planEvidence) {
    const session = flags.session?.trim();
    if (!session) {
      error(
        "Plan Approval requires --session <id> from the invoking SessionStart context.",
      );
    }
    fields.Session = session;
  }
  if (flags.unit) {
    fields.Unit = flags.unit;
    Object.assign(fields, claimAttemptFields(pd, flags.unit));
  }
  if (flags.single === "true") fields.Workflow = `single-stage:${flags.stage}`;

  try {
    emitAudit(pd, "DECISION_RECORDED", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }
  if (planEvidence) {
    try {
      const options = (flags.options ?? "")
        .split(",")
        .map((option) => option.trim())
        .filter(Boolean);
      if (options.length !== 2) {
        error("Plan Approval decision requires exactly two offered options");
      }
      recordPlanApprovalChallenge(
        pd,
        planEvidence,
        fields.Session,
        [options[0], options[1]],
        flags["exact-option-labels"] === "true",
        flags["hash-option-labels"] === "true",
        flags["legacy-directive-options"] === "true",
      );
    } catch (e) {
      error(`Plan Approval challenge creation failed: ${errorMessage(e)}`);
    }
  }

  console.log(
    JSON.stringify({
      emitted: "DECISION_RECORDED",
      stage: flags.stage,
      ...(changeNotices.length > 0 ? { change_notices: changeNotices } : {}),
    })
  );
}

// --- Subcommand: answer ---
// Usage: aidlc-log answer --stage <slug> --details <text>
//   [--checkpoint summary-confirmation --questions-file <path>
//   [--unit <unit>] [--single]]
//
// Fires AFTER the user answers a question.

// An answer at an open approval gate belongs to a non-gate question only when
// the audit stream proves that question was asked: a DECISION_RECORDED for this
// stage after the current STAGE_AWAITING_APPROVAL, with no later
// QUESTION_ANSWERED. This structural signal handles arbitrary user wording and
// avoids guessing from gate-option words that may also begin substantive
// answers. Caller holds the audit lock, so this snapshot cannot race an emit.
function hasPendingDecisionAtGate(pd: string, stage: string): boolean {
  const audit = readAllAuditShards(pd);
  if (audit.length === 0) return false;

  const relevant = new Set([
    "STAGE_AWAITING_APPROVAL",
    "DECISION_RECORDED",
    "QUESTION_ANSWERED",
    "SUMMARY_CONFIRMATION_RECORDED",
  ]);
  const events = audit
    .replace(/\r\n/g, "\n")
    .split(/\n---\n/)
    .map((block, position) => ({
      event: auditBlockField(block, "Event") ?? "",
      stage: auditBlockField(block, "Stage"),
      timestamp: auditBlockField(block, "Timestamp") ?? "",
      position,
    }))
    .filter((event) => relevant.has(event.event))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? -1 : 1;
      }
      return a.position - b.position;
    });

  const gateOpen = events.findLastIndex(
    (event) =>
      event.event === "STAGE_AWAITING_APPROVAL" && event.stage === stage,
  );
  if (gateOpen === -1) return false;

  let pending = false;
  for (const event of events.slice(gateOpen + 1)) {
    if (event.stage !== stage) continue;
    if (event.event === "DECISION_RECORDED") {
      pending = true;
    } else if (
      event.event === "QUESTION_ANSWERED" ||
      event.event === "SUMMARY_CONFIRMATION_RECORDED"
    ) {
      pending = false;
    }
  }
  return pending;
}

function pendingSummaryDecision(
  pd: string,
  stage: string,
  unit: string | undefined,
  workflow: string | undefined,
  questionsFile: string,
): { pending: boolean; humanAfterDecision: boolean; ambiguity?: string } {
  const entries = readAuditShardEvents(pd).filter((entry) => {
    if (entry.event === "HUMAN_TURN") return true;
    if (entry.event === "STAGE_COMPLETED") {
      return (
        auditBlockField(entry.block, "Stage") === stage &&
        (auditBlockField(entry.block, "Workflow") ?? undefined) === workflow
      );
    }
    if (
      entry.event !== "DECISION_RECORDED" &&
      entry.event !== "SUMMARY_CONFIRMATION_RECORDED"
    ) {
      return false;
    }
    const matching =
      auditBlockField(entry.block, "Stage") === stage &&
      auditBlockField(entry.block, "Checkpoint") ===
        SUMMARY_CONFIRMATION_CHECKPOINT &&
      (auditBlockField(entry.block, "Unit") ?? undefined) === unit &&
      (auditBlockField(entry.block, "Workflow") ?? undefined) === workflow &&
      auditBlockField(entry.block, "Questions File") === questionsFile;
    return matching && (
      unit === undefined ||
      eventMatchesClaimAttempt(pd, entry.block, unit)
    );
  });
  if (entries.length === 0) {
    return { pending: false, humanAfterDecision: false };
  }

  type Entry = (typeof entries)[number];
  const follows = (candidate: Entry, boundary: Entry): true | false | null => {
    if (candidate.shard === boundary.shard) {
      return candidate.pos > boundary.pos;
    }
    if (candidate.timestamp !== boundary.timestamp) {
      return candidate.timestamp > boundary.timestamp;
    }
    return null;
  };
  const latestFrontier = (candidates: Entry[]): Entry[] => {
    const byShard = new Map<string, Entry>();
    for (const entry of candidates) {
      const previous = byShard.get(entry.shard);
      if (!previous || entry.pos > previous.pos) byShard.set(entry.shard, entry);
    }
    const latestTimestamp = [...byShard.values()].reduce(
      (latest, entry) =>
        entry.timestamp > latest ? entry.timestamp : latest,
      "",
    );
    return [...byShard.values()].filter(
      (entry) => entry.timestamp === latestTimestamp,
    );
  };
  const floors = latestFrontier(
    entries.filter((entry) => entry.event === "STAGE_COMPLETED"),
  );
  const afterFloor = (entry: Entry): true | false | null => {
    if (floors.length === 0) return true;
    const relations = floors.map((floor) => follows(entry, floor));
    if (relations.every((relation) => relation === true)) return true;
    if (relations.some((relation) => relation === false)) return false;
    return null;
  };
  const actions = entries.filter((entry) =>
    entry.event === "DECISION_RECORDED" ||
    entry.event === "SUMMARY_CONFIRMATION_RECORDED"
  );
  const orderedActions = actions.filter((entry) => afterFloor(entry) === true);
  const latestActions = latestFrontier(orderedActions);
  const latestActionTimestamp = latestActions[0]?.timestamp;
  const unorderedActions = actions.filter((entry) => afterFloor(entry) === null);
  if (
    unorderedActions.some((entry) =>
      latestActionTimestamp === undefined ||
      entry.timestamp >= latestActionTimestamp
    )
  ) {
    return {
      pending: false,
      humanAfterDecision: false,
      ambiguity: floors[0]?.timestamp ?? unorderedActions[0].timestamp,
    };
  }
  if (latestActions.length === 0 || latestActionTimestamp === undefined) {
    return { pending: false, humanAfterDecision: false };
  }

  const latestKinds = new Set(
    latestActions.map((entry) => entry.event),
  );
  if (latestKinds.size > 1) {
    return {
      pending: false,
      humanAfterDecision: false,
      ambiguity: latestActionTimestamp,
    };
  }
  if (!latestKinds.has("DECISION_RECORDED")) {
    return { pending: false, humanAfterDecision: false };
  }

  const humans = entries.filter((entry) => entry.event === "HUMAN_TURN");
  const humanRelations = humans.map((human) =>
    latestActions.map((decision) => follows(human, decision))
  );
  if (
    humanRelations.some((relations) =>
      relations.every((relation) => relation === true)
    )
  ) {
    return { pending: true, humanAfterDecision: true };
  }
  if (
    humanRelations.some((relations) =>
      !relations.some((relation) => relation === false) &&
      relations.some((relation) => relation === null)
    )
  ) {
    return {
      pending: false,
      humanAfterDecision: false,
      ambiguity: latestActionTimestamp,
    };
  }
  return { pending: true, humanAfterDecision: false };
}

function handleAnswer(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.details) error("Missing --details <text>");

  if (
    flags.checkpoint !== undefined &&
    flags.checkpoint !== "summary-confirmation" &&
    flags.checkpoint !== "plan-approval"
  ) {
    error(
      `Unknown --checkpoint "${flags.checkpoint}". Accepted: summary-confirmation, plan-approval`,
    );
  }
  const summaryCheckpoint = flags.checkpoint === "summary-confirmation";
  const planCheckpoint = flags.checkpoint === "plan-approval";
  if (
    summaryCheckpoint &&
    flags.details !== "Looks correct" &&
    flags.details !== "Request changes"
  ) {
    error(
      `Cannot record the summary choice because reply ${formatReceivedReply(flags.details)} ` +
        'did not match an offered option. Present "Looks correct" and ' +
        '"Request changes". Re-present those choices and wait for the human to choose one.',
    );
  }
  if (
    planCheckpoint &&
    flags.details !== "Approve Plan" &&
    flags.details !== "Request Changes"
  ) {
    error(
      `Refusing to record Plan Approval: received reply ${formatReceivedReply(flags.details)}. ` +
        'Valid choices are "Approve Plan" or "Request Changes".',
    );
  }

  // A cancelled/dismissed/auto-resolved question widget is not an answer.
  // Some harnesses return a completed-looking object for a dismissed question.
  if (isNonAnswer(flags.details)) {
    error(
      `Cannot record reply ${formatReceivedReply(flags.details)} because it represents a ` +
        `dismissed question, not a human answer. Re-present the question and wait for a real ` +
        `response before trying again.`,
    );
  }

  const pd = resolveActiveProjectDir(projectDir);
  if (flags.unit) validateLiveUnitScope(pd, flags.unit);
  const summaryEvidence = summaryCheckpoint
    ? summaryQuestionEvidence(pd, flags, flags.details)
    : null;
  let planEvidence: ReturnType<
    typeof codeGenerationPlanApprovalQuestionEvidence
  > | null = null;
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Details: flags.details,
  };
  if (summaryCheckpoint) {
    fields.Checkpoint = SUMMARY_CONFIRMATION_CHECKPOINT;
    fields["Questions File"] = summaryEvidence!.relativePath;
    fields["Questions SHA-256"] = summaryEvidence!.sha256;
    fields["Hash Scope"] = SUMMARY_CONFIRMATION_HASH_SCOPE;
  }
  if (flags.unit) {
    fields.Unit = flags.unit;
    Object.assign(fields, claimAttemptFields(pd, flags.unit));
  }
  if (flags.single === "true") fields.Workflow = `single-stage:${flags.stage}`;

  // Classification and emission run under ONE audit lock: a concurrent
  // gate-start (itself locked) cannot flip the stage to [?] between the
  // checkbox read below and the QUESTION_ANSWERED append, which would
  // re-create the answer-consumes-the-turn deadlock this branch prevents.
  // appendAuditEntry / emitError re-acquire reentrantly (per-pd depth).
  withAuditLock(pd, () => {
    if (planCheckpoint) {
      governedChangeControl(pd);
      planEvidence = codeGenerationPlanApprovalQuestionEvidence(
        pd,
        planApprovalTarget(flags),
        flags["questions-file"] ?? "",
        flags.details as "Approve Plan" | "Request Changes",
      );
      Object.assign(fields, planApprovalFields(planEvidence));
      const session = flags.session?.trim();
      if (!session) {
        error(
          "Plan Approval requires --session <id> from the invoking SessionStart context.",
        );
      }
      fields.Session = session;
    }
    // Human-presence gate (ledger-event design): the interview answer is
    // a human-judgement event, so require a HUMAN_TURN appended AFTER the last
    // QUESTION_ANSWERED (ledger order) before recording another. The prior
    // QUESTION_ANSWERED is the "since" boundary (its own consume-once: one human turn
    // logs one answer), so no separate marker/consume step is needed. Autonomy
    // carve-out FIRST (Construction swarm/Bolt answers are not human), then the scoped
    // test off-switch. Fail-open when no ledger exists (presence not tracked yet).
    const content = existsSync(stateFilePath(pd))
      ? readFileSync(stateFilePath(pd), "utf-8")
      : null;
    const stageNode = loadStageGraphAll().find((stage) => stage.slug === flags.stage);
    const autonomousDecision = isAutonomousConstructionDecision(content, stageNode?.phase);
    const workflow =
      flags.single === "true" ? `single-stage:${flags.stage}` : undefined;

    // Authorship floor (issue 742): the same interview answer the conductor
    // wrote for itself. isNonAnswer above rejects a DISMISSED widget; this
    // rejects a self-attributed one ("A. Nothing to add - CONDUCTOR DEFAULT,
    // session unattended"), which the presence check below cannot catch because
    // a human is in the session, just not at this question. Autonomous
    // Construction is exempt for ordinary answers. Summary confirmation remains
    // a human-backed checkpoint below: its fresh-turn requirement is not waived
    // by Construction autonomy even though its text is one of two exact strings.
    const answerAuthorship =
      autonomousDecision || humanPresenceGuardDisabled()
        ? null
        : selfAttributedDecisionMarker(flags.details, "answer");
    if (answerAuthorship) {
      error(
        `Cannot record this answer for "${flags.stage}" because --details says it was ` +
          `chosen by the assistant (${answerAuthorship.category}: "${answerAuthorship.phrase}"). ` +
          `This question must be answered by the human. Re-present it and wait for their reply.`,
      );
    }

    if (summaryCheckpoint) {
      const pending = pendingSummaryDecision(
        pd,
        flags.stage,
        flags.unit,
        workflow,
        summaryEvidence!.relativePath,
      );
      if (pending.ambiguity !== undefined) {
        error(
          "Refusing to record summary confirmation: matching prompt, response, " +
          `or run-boundary events share audit Timestamp "${pending.ambiguity}" ` +
          "across different shards, so a human response after this prompt cannot " +
          "be proven. Present a fresh summary prompt after that second, end the " +
          "turn, and record the human's new response.",
        );
      }
      if (!pending.pending) {
        error(
          "Cannot record the summary choice because no matching unanswered summary question " +
          "exists for this stage and work item. Record the question before presenting it, then " +
          "wait for the human's choice.",
        );
      }
      if (
        !humanPresenceGuardDisabled() &&
        (!pending.humanAfterDecision || !humanActedSinceLastAnswer(pd))
      ) {
        error(
          "Cannot record the summary choice because no human reply has arrived after this "
            + "question, or that turn was already used by another decision. End the turn, "
            + `wait for the human's choice, then try again.${unattendedHumanPresenceHint()}`,
        );
      }
      // The confirmation authorizes the outputs generated from it. Mint the
      // authorization id from the attempt, the scope, and the confirmed content
      // (identical confirmations mint the same id; changed answers a new one),
      // record it on the receipt, and make it the active authorization for the
      // scope so every later write of a stage output is stamped with it. A
      // "Request changes" reply withdraws the active authorization instead.
      const unitMajor =
        stageNode !== undefined &&
        isPerUnitStage(stageNode) &&
        getField(content ?? "", "Construction Iteration")?.trim() === "unit-major";
      const floors = summaryAttemptFloors(
        readAuditShardEvents(pd).filter((entry) => SUMMARY_EVIDENCE_EVENTS.has(entry.event)),
        flags.stage,
        workflow,
        unitMajor,
      );
      const authorization: SummaryAuthorization = {
        version: 1,
        id: "",
        stage: flags.stage,
        unit: flags.unit ?? null,
        workflow: workflow ?? null,
        attempt: summaryAttemptIdentity(floors),
        questions_file: summaryEvidence!.relativePath,
        questions_sha256: summaryEvidence!.sha256,
        choice: flags.details,
        recorded_at: isoTimestamp(),
      };
      authorization.id = summaryAuthorizationId({
        attempt: authorization.attempt,
        stage: authorization.stage,
        unit: authorization.unit,
        workflow: authorization.workflow,
        questionsFile: authorization.questions_file,
        questionsSha256: authorization.questions_sha256,
        choice: authorization.choice,
      });
      const positive = flags.details === "Looks correct";
      if (positive) fields[SUMMARY_AUTHORIZATION_FIELD] = authorization.id;
      // Registry first, receipt second, both under the audit lock. A registry
      // that cannot be written (a redirected `.aidlc-summary-authorization`, a
      // file where the stage directory belongs, a full disk) refuses the answer
      // BEFORE any receipt exists, so the pending question and the human's turn
      // are still there for a retry once the cause is fixed. If the receipt
      // then fails to append, the registry is restored to what it was, so no
      // authorization exists without the receipt that minted it.
      let previousRegistry: Buffer | null = null;
      try {
        const target = summaryAuthorizationTargetOrThrow(pd, authorization.stage, authorization.unit);
        previousRegistry = lstatExists(target)
          ? readRegularFileNoFollowOrThrow(target, "summary authorization", 64 * 1024)
          : null;
        if (positive) {
          writeSummaryAuthorization(pd, authorization);
        } else {
          clearSummaryAuthorization(pd, authorization.stage, authorization.unit);
        }
      } catch (e) {
        error(
          `Cannot record the summary choice: its authorization record could not be ` +
            `saved (${errorMessage(e)}). Nothing was recorded; the pending question is ` +
            "still answerable. Repair the record directory and run this command again.",
        );
      }
      try {
        emitAudit(pd, "SUMMARY_CONFIRMATION_RECORDED", fields);
      } catch (e) {
        // Restore the registry to its exact prior bytes (or absence) so no
        // authorization exists without the receipt that minted it. A restore
        // that itself fails is part of the report: the registry is then in a
        // state the human must know about before retrying.
        let rollback = "";
        try {
          const registryRelative = summaryAuthorizationRelativePath(
            authorization.stage,
            authorization.unit,
          );
          if (previousRegistry === null) {
            removeRecordFileNoFollow(recordDir(pd) as string, registryRelative);
          } else {
            writeRecordFileNoFollow(recordDir(pd) as string, registryRelative, previousRegistry);
          }
        } catch (restoreError) {
          rollback =
            ` The authorization record could not be restored either (${errorMessage(restoreError)}); ` +
            `remove ${SUMMARY_AUTHORIZATION_DIR}/${authorization.stage}/${authorization.unit ?? "stage-level"}.json ` +
            "under the intent record before retrying.";
        }
        error(`Audit emission failed: ${errorMessage(e)}.${rollback}`);
      }
      console.log(
        JSON.stringify({
          emitted: "SUMMARY_CONFIRMATION_RECORDED",
          checkpoint: "summary-confirmation",
          stage: flags.stage,
          ...(positive ? { summary_authorization_id: authorization.id } : {}),
        }),
      );
      return;
    }

    if (planCheckpoint) {
      // Drift the evidence accepted is recorded before the receipt so the
      // ledger carries it even if certification refuses a later race.
      const changeNotices = recordAcceptedChanges(pd, planEvidence!.acceptedChanges);
      try {
        const recorded = recordPlanApprovalReceipt(
          pd,
          planEvidence!,
          fields.Session,
          flags.details as "Approve Plan" | "Request Changes",
        );
        changeNotices.push(...recorded.changeNotices);
      } catch (e) {
        if (e instanceof PlanApprovalSourceDriftError) {
          console.error(JSON.stringify({ remedy: e.remedy }));
          error(e.message);
        }
        error(`Refusing to record Plan Approval: ${errorMessage(e)}`);
      }
      try {
        if (flags.details === "Approve Plan") {
          emitAudit(pd, "PLAN_APPROVAL_RECORDED", fields);
        } else {
          emitAudit(pd, "QUESTION_ANSWERED", fields);
        }
      } catch (e) {
        error(`Audit emission failed: ${errorMessage(e)}`);
      }
      console.log(
        JSON.stringify({
          emitted:
            flags.details === "Approve Plan"
              ? "PLAN_APPROVAL_RECORDED"
              : "QUESTION_ANSWERED",
          checkpoint: "plan-approval",
          stage: flags.stage,
          ...(changeNotices.length > 0 ? { change_notices: changeNotices } : {}),
        }),
      );
      return;
    }

    // Approval choices are lifecycle transitions, not interview answers. A
    // conductor may nevertheless route an approval through `answer` before
    // `report`; emitting QUESTION_ANSWERED here would consume the same
    // HUMAN_TURN that approval needs. When the target stage is at [?] and no
    // unresolved non-gate decision was recorded after the gate opened,
    // acknowledge without emitting so the report command can commit the gate.
    // The human-presence requirement is NOT waived: a redundant answer with no
    // fresh HUMAN_TURN refuses, so a fabricated `answer && report rejected`
    // chain (reject carries no presence guard of its own) breaks at the answer.
    const targetAtApprovalGate =
      content !== null &&
      parseCheckboxes(content).some(
        (checkbox) =>
          checkbox.slug === flags.stage &&
          checkbox.state === "awaiting-approval",
      );
    const pendingDecision =
      targetAtApprovalGate && hasPendingDecisionAtGate(pd, flags.stage);
    if (targetAtApprovalGate && !pendingDecision) {
      if (
        !autonomousDecision &&
        !humanPresenceGuardDisabled() &&
        !humanActedSinceLastAnswer(pd)
      ) {
        error(
          "Cannot record this approval choice because no new human reply has arrived. "
            + "After the human types their choice, use aidlc-orchestrate.ts report --result "
            + "approved or rejected; do not use aidlc-log.ts answer for an approval."
            + unattendedHumanPresenceHint(),
        );
      }
      console.log(
        JSON.stringify({
          skipped: "QUESTION_ANSWERED",
          stage: flags.stage,
          reason: "approval-gate-report-owned",
        }),
      );
      return;
    }

    if (autonomousDecision) {
      // autonomous Construction: no human presence required
    } else if (humanPresenceGuardDisabled()) {
      // scoped test off-switch
    } else if (!humanActedSinceLastAnswer(pd)) {
      error(
        "Cannot record this answer because no new human reply has arrived for the question. "
          + "Wait for the human to type an answer, then try again."
          + unattendedHumanPresenceHint(),
      );
    }

    try {
      emitAudit(pd, "QUESTION_ANSWERED", fields);
    } catch (e) {
      error(`Audit emission failed: ${errorMessage(e)}`);
    }

    console.log(
      JSON.stringify({ emitted: "QUESTION_ANSWERED", stage: flags.stage })
    );
  });
}

// --- Subcommand: link ---
// Usage:
//   aidlc-log link --stage <slug> --link <agent> [--repo <repo>]
//     [--artifact <path>] [--single]
//       → PIPELINE_LINK_COMPLETED
//
// The receipt is emitted only after a declared pipeline link returns. Ordering,
// duplicate prevention, and attempt freshness are checked under the audit lock
// so two concurrent conductors cannot advance the same chain.
function handleLink(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.link) error("Missing --link <agent>");
  if (flags.intent || flags.space) {
    error(
      "The link command does not accept --intent/--space selectors. Switch to the target workspace first.",
    );
  }

  const pd = resolveActiveProjectDir(projectDir);
  const selection = resolveWorkflowSelection(pd);
  const space = selection.space;
  const intent = selection.intent;
  if (!intent) {
    error("Cannot resolve the active intent for pipeline link logging.");
  }
  const singleRun = flags.single === "true";

  try {
    withAuditLock(pd, () => {
      const node = loadStageGraphAll().find((stage) => stage.slug === flags.stage);
      if (node?.mode !== "pipeline") {
        throw new Error(
          `Cannot record pipeline link: stage "${flags.stage}" is not mode: pipeline.`,
        );
      }
      const links = pipelineLinks(node);
      const index = links.indexOf(flags.link);
      if (index === -1) {
        throw new Error(
          `Cannot record pipeline link for "${flags.stage}": "${flags.link}" is not in its declared lead/support chain (${links.join(", ")}).`,
        );
      }

      const evidence = pipelineLinkEvidence(pd, node, { singleRun });
      if (evidence.repos.length > 0) {
        if (!flags.repo) {
          throw new Error(
            `Cannot record pipeline link for "${flags.stage}": this intent records repository identity; pass --repo <repo>.`,
          );
        }
        if (!evidence.repos.includes(flags.repo)) {
          throw new Error(
            `Cannot record pipeline link for "${flags.stage}": repo "${flags.repo}" is not registered for this intent (${evidence.repos.join(", ")}).`,
          );
        }
      } else if (flags.repo) {
        throw new Error(
          `Cannot record pipeline link for "${flags.stage}": this intent has no registered repo identity; omit --repo.`,
        );
      }

      const repo = flags.repo ?? null;
      if (evidence.receipts.some((receipt) =>
        receipt.link === flags.link && receipt.repo === repo
      )) {
        throw new Error(
          `Cannot record pipeline link for "${flags.stage}": link "${flags.link}"` +
            `${repo ? ` for repo "${repo}"` : ""} already completed this attempt.`,
        );
      }
      if (index > 0) {
        const previous = links[index - 1];
        const previousCompleted = evidence.receipts.some((receipt) =>
          receipt.link === previous && receipt.repo === repo
        );
        if (!previousCompleted) {
          throw new Error(
            `Cannot record pipeline link for "${flags.stage}": "${flags.link}" is out of order; ` +
              `position ${index + 1}/${links.length} requires current-attempt receipt for "${previous}"` +
              `${repo ? ` in repo "${repo}"` : ""}.`,
          );
        }
      }

      const fields: Record<string, string> = {
        Stage: flags.stage,
        Link: flags.link,
        Position: `${index + 1}/${links.length}`,
      };
      if (
        flags.stage === "reverse-engineering" &&
        flags.link === node.lead_agent
      ) {
        if (!flags.artifact) {
          throw new Error(
            'Cannot record reverse-engineering developer link: pass --artifact "<record>/inception/reverse-engineering/developer-scan[-<repo>].md".',
          );
        }
        const root = recordDir(pd);
        if (root === null) {
          throw new Error(
            "Cannot record reverse-engineering developer link: active intent record is unavailable.",
          );
        }
        const expected = join(
          root,
          "inception",
          "reverse-engineering",
          repo ? `developer-scan-${repo}.md` : "developer-scan.md",
        );
        const artifact = resolve(pd, flags.artifact);
        if (artifact !== expected) {
          throw new Error(
            `Cannot record reverse-engineering developer link: --artifact must resolve to ${toPosix(relative(pd, expected))}.`,
          );
        }
        if (!existsSync(artifact)) {
          throw new Error(
            `Cannot record reverse-engineering developer link: handoff file does not exist: ${flags.artifact}.`,
          );
        }
        let artifactBytes: Buffer;
        let artifactMtimeMs: number;
        try {
          const guardedArtifact = assertNoSymlinkInChainOrThrow(
            realpathSync(pd),
            relative(pd, artifact),
          );
          const snapshot = readRegularFileNoFollowOrThrow(
            guardedArtifact,
            "reverse-engineering developer handoff",
            undefined,
            guardedArtifact,
            true,
          );
          artifactBytes = snapshot.bytes;
          artifactMtimeMs = snapshot.mtimeMs;
        } catch (error) {
          throw new Error(
            `Cannot record reverse-engineering developer link: handoff file must be a regular file with no symlink path components (${errorMessage(error)}).`,
          );
        }
        const attemptStartedAt = pipelineAttemptStartedAt(
          pd,
          flags.stage,
          { singleRun },
        );
        if (
          attemptStartedAt === "" ||
          artifactMtimeMs < Date.parse(attemptStartedAt)
        ) {
          throw new Error(
            `Cannot record reverse-engineering developer link: ${toPosix(relative(pd, artifact))} was not written in the current stage attempt.`,
          );
        }
        const previousMtime = latestPipelineLinkArtifactMtime(
          pd,
          flags.stage,
          flags.link,
          repo,
          { singleRun },
        );
        if (
          previousMtime !== null &&
          artifactMtimeMs <= previousMtime
        ) {
          throw new Error(
            `Cannot record reverse-engineering developer link: ${toPosix(relative(pd, artifact))} was not rewritten after its prior pipeline receipt.`,
          );
        }
        const digest = createHash("sha256")
          .update(artifactBytes)
          .digest("hex");
        fields["Artifact Path"] = toPosix(relative(pd, artifact));
        fields["Artifact SHA256"] = `sha256:${digest}`;
        fields["Artifact Mtime Ms"] = String(artifactMtimeMs);
      }
      if (repo) fields.Repo = repo;
      if (singleRun) fields.Workflow = `single-stage:${flags.stage}`;
      emitAudit(pd, "PIPELINE_LINK_COMPLETED", fields, intent, space);
    }, intent, space);
  } catch (e) {
    error(errorMessage(e));
  }

  console.log(JSON.stringify({
    emitted: "PIPELINE_LINK_COMPLETED",
    stage: flags.stage,
    link: flags.link,
    ...(flags.repo ? { repo: flags.repo } : {}),
    ...(singleRun ? { single: true } : {}),
  }));
}

// --- Subcommand: review ---
// Usage:
//   aidlc-log review --stage <slug> --reviewer <agent> [--unit <u>] --iteration <n>
//       → REVIEW_REQUESTED (fires when the conductor dispatches the reviewer)
//   aidlc-log review --stage <slug> --reviewer <agent> [--unit <u>] --iteration <n> --verdict <READY|NOT-READY>
//       → REVIEW_COMPLETED (fires when the conductor reads the reviewer's verdict)
//
// The §12a reviewer step is otherwise prose-driven; these tool-actor rows make
// it observable and let the engine enforce that a reviewer-bearing stage cannot
// be approved without a terminal REVIEW_COMPLETED (see verifyReviewerPrecondition
// in aidlc-state.ts). On a per-unit Construction stage the reviewer fires once
// PER UNIT, so pass --unit; the approve guard requires one review per unit.
const VALID_VERDICTS = new Set(["READY", "NOT-READY"]);

function reviewBudgetMessage(stage: string, ordinal: number, budget: number): string {
  return (
    `Cannot request review pass ${ordinal} for "${stage}" because this stage allows ` +
    `${budget} review pass${budget === 1 ? "" : "es"}. ` +
    (budget === 1
      ? "Do not ask the reviewer again; include the findings in the approval summary for the human."
      : "Present the unresolved findings at the approval gate for the human instead of starting another review.")
  );
}

export function reviewRecoverySpentMessage(
  stage: string,
  guidance: string | null,
  autonomousBolt?: {
    unit: string;
    slug: string | null;
    batch: string | null;
  },
  requestChangesResetValid = true,
): string {
  const prefix =
    `Cannot start another review for "${stage}": the one recovery review was ` +
    "already used, and this stage's output document changed again afterward. ";
  if (autonomousBolt) {
    const slug = autonomousBolt.slug ?? autonomousBolt.unit;
    const batch = autonomousBolt.batch
      ? ` batch ${autonomousBolt.batch}`
      : " the current batch";
    return (
      prefix +
      `Do not put autonomous Unit "${autonomousBolt.unit}" in --claimed and do ` +
      "not run finalize or merge it. Halt and ask the human whether to restart " +
      `the Bolt attempt. On an approved retry, return to the main workspace, run ` +
      `\`aidlc-bolt.ts abort --name "${autonomousBolt.unit}" --slug "${slug}" ` +
      `--reason "stale review recovery exhausted" --discard\`, then rerun the ` +
      `current \`aidlc-swarm.ts prepare\` step for Unit "${autonomousBolt.unit}" in` +
      `${batch} with the original base/repo arguments. The fresh Bolt attempt ` +
      "restores one review allowance without claiming convergence. Do not " +
      "record a Request Changes decision on the human's behalf."
    );
  }
  return (
    prefix +
    (guidance ?? "") +
    (requestChangesResetValid
      ? " Only a human Request Changes decision resets the review attempt; do not " +
        "record that rejection on the human's behalf."
      : "")
  );
}

function reviewRecoveryGuidance(
  projectDir: string,
  stateContent: string,
  stage: string,
  unit?: string,
  teamGate?: TeamUnitGateResolution,
): string {
  try {
    return recoveryGuidance(projectDir, stateContent, stage, {
      ...(unit ? { unit } : {}),
      ...(teamGate ? { teamGate } : {}),
    });
  } catch {
    return (
      `Restart this stage cleanly with /aidlc --stage ${stage}, then confirm ` +
      "its summary and review the finished output again."
    );
  }
}

function reviewSummaryEvidenceMessage(stage: string, message: string): string {
  const cause = message.replace(
    /^Refusing to (?:complete|continue) "[^"]+"(?: for unit "[^"]+")?:\s*/,
    "",
  );
  return `Cannot start review for "${stage}": ${cause}`;
}

function reviewRecoveryAlreadyRequestedMessage(
  stage: string,
  iteration: number,
  guidance: string,
  requestChangesResetValid: boolean,
): string {
  return (
    `Cannot request another recovery review for "${stage}" because one already exists ` +
    `in this review attempt. If the reviewer has not returned, retry iteration ${iteration} ` +
    `with --retry-pending. If its verdict was recorded, ${guidance}` +
    (requestChangesResetValid
      ? " Only a human Request Changes decision resets the review attempt; do not record " +
        "that rejection on the human's behalf."
      : "")
  );
}

class ReviewRefusal extends Error {}

function refuseReview(message: string): never {
  throw new ReviewRefusal(message);
}

function refuseReviewGuard(
  projectDir: string,
  refusal: GuardRefusal,
  attempt: GuardAttemptState,
  resources: string[] = [],
): never {
  refuseReview(guardRefusalOutput(projectDir, refusal, attempt, resources));
}

function handleReview(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.reviewer) error("Missing --reviewer <agent>");
  if (flags.intent || flags.space) {
    error(
      "The review command does not accept --intent/--space selectors. Switch to the target workspace first.",
    );
  }

  const pd = resolveActiveProjectDir(projectDir);
  if (flags.unit) validateLiveUnitScope(pd, flags.unit);
  const selection = resolveWorkflowSelection(pd);
  const space = selection.space;
  const intent = selection.intent;
  if (!intent) {
    error("Cannot resolve the active intent for review logging.");
  }
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Reviewer: flags.reviewer,
  };
  if (flags.unit) {
    fields.Unit = flags.unit;
    Object.assign(fields, claimAttemptFields(pd, flags.unit));
  }
  if (flags.single === "true") fields.Workflow = `single-stage:${flags.stage}`;
  const retryPending = flags["retry-pending"] === "true";

  const loadContext = (
    scanReceipts: boolean,
    enforceAdmissibility = true,
  ) => {
    const state = readStateFile(pd, intent, space);
    const node = loadStageGraphAll().find((stage) => stage.slug === flags.stage);
    if (!node?.reviewer) {
      refuseReview(`Cannot record review: stage "${flags.stage}" has no declared reviewer.`);
    }
    if (!node.review_artifact) {
      refuseReview(
        `Cannot record review: stage "${flags.stage}" has no declared review_artifact.`,
      );
    }
    if (flags.reviewer !== node.reviewer) {
      refuseReview(
        `Cannot record review for "${flags.stage}": reviewer "${flags.reviewer}" ` +
          `does not match the declared reviewer "${node.reviewer}".`,
      );
    }
    if (flags.unit && node.for_each !== "unit-of-work") {
      refuseReview(`Stage "${flags.stage}" is not per-unit; remove --unit.`);
    }
    const autonomousCandidate =
      flags.unit !== undefined && isAutonomousSwarmStage(pd, state, node);
    const unitResolution =
      node.for_each === "unit-of-work" ? resolveBoltDag(pd, intent, space) : null;
    const attemptWindow = reviewAttemptWindow(pd, state, node);
    const attempt = reviewAttemptAccounting(
      attemptWindow,
      state,
      node,
      flags.reviewer,
      flags.unit,
      fields.Workflow,
      {
        eventFilter: (row) =>
          reviewAttemptEventMatchesCurrentClaim(
            pd,
            state,
            flags.unit,
            row,
          ),
      },
    );
    const mergedBoltUnits = attemptWindow.mergedBoltUnits;
    if (enforceAdmissibility && flags.unit) {
      const resolution = unitResolution ?? resolveBoltDag(pd, intent, space);
      if (resolution.state === "malformed") {
        refuseReview(
          `Cannot record review for "${flags.stage}" unit "${flags.unit}": the authoritative ` +
            `unit DAG is ${resolution.reason} (${resolution.detail}). Fix ` +
            "unit-of-work-dependency.md before recording a per-unit review.",
        );
      }
      if (
        resolution.state === "none" &&
        !attempt.boltStarted &&
        !attemptWindow.mergedBoltUnits.has(flags.unit)
      ) {
        refuseReview(
          `Cannot record review for "${flags.stage}" unit "${flags.unit}": no authoritative ` +
            "unit DAG exists and no matching active or merged Bolt attempt was found. Run " +
            `\`aidlc-bolt.ts start --name "${flags.unit}" --batch 1\` before retrying this ` +
            "per-unit review, or remove --unit and record a stage-level no-DAG review.",
        );
      }
      if (resolution.state === "ok" && !resolution.units.includes(flags.unit)) {
        refuseReview(
          `Cannot record review for "${flags.stage}" unit "${flags.unit}": it is not present ` +
            `in the authoritative unit DAG (${resolution.units.join(", ")}).`,
        );
      }
      if (
        resolution.state === "ok" &&
        filterProducesByKind(
          node.produces_kinds,
          node.produces ?? [],
          resolution.unitKinds?.get(flags.unit) ?? null,
        ).length === 0
      ) {
        refuseReview(
          `Cannot record review for "${flags.stage}": unit "${flags.unit}" has no applicable required outputs for its kind.`,
        );
      }
    }
    const declared = node.review_class ?? "adversarial";
    if (attempt.ambiguity !== null) {
      refuseReview(
        `Cannot record review for "${flags.stage}": ${attempt.ambiguity} makes the current review attempt chronology ambiguous. Record a fresh stage/jump boundary, then request the review again.`,
      );
    }
    let reviewClass: ReviewClass | null = null;
    let budget: number | null = null;
    if (autonomousCandidate && attempt.boltStarted) {
      reviewClass = declared;
      budget =
        reviewClass === "advisory"
          ? 1
          : node.reviewer_max_iterations ?? 2;
    } else {
      try {
        reviewClass = resolveReviewClass(
          declared,
          getField(state, "Scope") ?? "",
          state,
        );
        if (reviewClass === "none") budget = 0;
        else if (reviewClass === "advisory") budget = 1;
        else budget = node.reviewer_max_iterations ?? 2;
      } catch {
        // Class resolution fails open; ordinal enforcement remains active.
      }
    }
    // Receipt freshness is needed only while minting REVIEW_REQUESTED (to
    // classify bounded stale-receipt recovery). REVIEW_COMPLETED consumes only
    // node + attempt and then performs its one authoritative source-state walk
    // while stamping; scanning here would double-walk on every re-review.
    const receipts =
      !scanReceipts || reviewClass === null
        ? null
        : freshReviewReceipts(pd, state, node, {
            reviewClass,
            attemptWindow,
          });
    const requireRequiredArtifacts =
      process.env.AIDLC_SKIP_ARTIFACT_GUARD !== "1" &&
      !(
        unitResolution !== null &&
        unitResolution.state !== "ok" &&
        flags.unit === undefined &&
        mergedBoltUnits.size === 0
      );
    return {
      state,
      node,
      attempt,
      budget,
      receipts,
      autonomousCandidate,
      requireRequiredArtifacts,
      unitResolution,
      mergedBoltUnits,
    };
  };

  const stampRequestedSourceBinding = (
    node: ReturnType<typeof loadStageGraphAll>[number],
  ): void => {
    if (!node.workspace_requires) return;
    const sourceState = workspaceSourceState(pd, intent, space);
    fields["Source Fingerprint"] =
      sourceState?.fingerprint ?? UNBINDABLE_FINGERPRINT;
    const bindsUnitSource =
      flags.unit !== undefined &&
      node.for_each === "unit-of-work" &&
      flags.single !== "true";
    if (!bindsUnitSource) return;
    const manifest = readUnitSourceManifest(
      pd,
      flags.stage as string,
      flags.unit as string,
    );
    if (!manifest.ok) {
      const manifestPath = `${relativeRecordDir(pd, intent, space) ?? "aidlc"}/construction/${flags.unit}/${flags.stage}/source-manifest.json`;
      refuseReview(
        `Cannot record REVIEW_REQUESTED for "${flags.stage}": unit "${flags.unit}" has no valid source manifest at ` +
          `${manifestPath} (${manifest.reason}). Write the manifest listing every application-source path ` +
          "the reviewer will inspect, then dispatch the review.",
      );
    }
    fields["Unit Source Fingerprint"] =
      sourceState === null
        ? UNBINDABLE_FINGERPRINT
        : writeUnitSourceSnapshot(
            pd,
            flags.stage as string,
            flags.unit as string,
            sourceState.listing,
            manifest,
            manifest.rawBytesSha256,
          );
  };

  const mintReviewRequestId = (): string =>
    `review:${randomBytes(16).toString("hex")}`;
  // The reviewer writes its review into this slot; the verdict consumes it into
  // the record. Project-relative so the conductor can hand it to the reviewer.
  const reviewSlot = (
    floor: string,
    iteration: number,
  ): {
    draftRelative: string;
    draftRelativeToRecord: string;
    recordRelative: string;
  } => {
    const record = recordDir(pd);
    if (record === null) refuseReview("Cannot resolve the active intent record.");
    const attemptId = reviewAttemptId(floor);
    const draft = reviewDraftRelativePath(flags.stage as string, flags.unit, attemptId, iteration);
    return {
      draftRelative: toPosix(relative(pd, join(record, ...draft.split("/")))),
      draftRelativeToRecord: draft,
      recordRelative: reviewRecordRelativePath(flags.stage as string, flags.unit, attemptId, iteration),
    };
  };

  // REVIEW_REQUESTED owns its ordinal: require a positive integer, count prior
  // requests in the current attempt, and append under the same lock. This closes
  // duplicate/missing-label bypasses and makes concurrent requests serialize.
  if (flags.verdict === undefined) {
    if (!flags.iteration || !/^[1-9][0-9]*$/.test(flags.iteration)) {
      error("Starting a review requires --iteration <positive integer>.");
    }
    const iteration = Number(flags.iteration);
    fields.Iteration = flags.iteration;
    let retried = false;
    let upgraded = false;
    let recovery: "stale-receipt" | undefined;
    let requestId: string | null = null;
    let reviewFile: string | null = null;
    const requestChangeNotices: string[] = [];
    // Open the reviewer's slot for this request: any draft an earlier dispatch of
    // the same iteration left behind is not this dispatch's review.
    const openReviewDraftSlot = (floor: string): void => {
      const slot = reviewSlot(floor, iteration);
      // Never through a symlinked `.aidlc-reviews`: a redirected slot is not
      // this record's, so the request refuses instead of clearing a path
      // outside the intent record.
      try {
        removeRecordFileNoFollow(recordDir(pd) as string, slot.draftRelativeToRecord);
      } catch (e) {
        refuseReview(
          `Cannot start review for "${flags.stage}": the review slot ` +
            `${slot.draftRelativeToRecord} cannot be opened (${errorMessage(e)}).`,
        );
      }
      reviewFile = slot.draftRelative;
    };
    try {
      withAuditLock(pd, () => {
        const {
          state,
          node,
          attempt,
          budget,
          receipts,
          autonomousCandidate,
          requireRequiredArtifacts,
          unitResolution,
          mergedBoltUnits,
        } = loadContext(true, !retryPending);
        const pendingStatus = pendingReviewRequestStatus(
          pd,
          node,
          flags.unit,
          attempt,
          {
            requireRequiredArtifacts,
            boltDag: unitResolution ?? undefined,
            mergedBoltUnits,
            single: flags.single === "true",
          },
        );
        const teamGate = teamUnitGateStatus(
          pd,
          state,
          node.slug,
          flags.unit,
        );
        // The review request is a governed Change Control checkpoint: resolve the
        // setting, then record what the receipt scan and the summary check
        // accepted under relaxed. The human line rides on this command's JSON.
        governedChangeControl(pd, state);
        const summaryEvidence = checkSummaryConfirmationEvidence(pd, node, {
          stateContent: state,
          unit: flags.unit,
          workflow: fields.Workflow,
        });
        requestChangeNotices.push(
          ...recordAcceptedChanges(pd, [
            ...(receipts?.acceptedChanges ?? []),
            ...(summaryEvidence.ok ? summaryEvidence.acceptedChanges ?? [] : []),
          ]),
        );
        if (!summaryEvidence.ok) {
          const message = reviewSummaryEvidenceMessage(
            flags.stage,
            summaryEvidence.message,
          );
          const guardAttempt = guardAttemptState(pd, state, node, {
            ...(flags.unit ? { unit: flags.unit } : {}),
            ...(receipts ? { receipts } : {}),
            summaryCoverage: summaryEvidence.summaryCoverage,
            reviewBudget: budget,
            pendingStatus,
            accounting: attempt,
          }).attempt;
          const evaluated = evaluateGuardRefusal({
            code: summaryEvidence.refusal?.code ?? "SUMMARY_EVIDENCE_INVALID",
            blockedAction: "review-request",
            stage: flags.stage,
            ...(flags.unit ? { unit: flags.unit } : {}),
            stateContent: state,
            invariant:
              summaryEvidence.refusal?.invariant ??
              "A review starts only after current human-backed summary authorization.",
            userMessage: message,
            attempt: guardAttempt,
            humanAuthority: humanAuthorityState(pd),
            ...(teamGate ? { teamGate } : {}),
          });
          const refusal = summaryEvidence.refusal === undefined
            ? evaluated
            : {
                ...summaryEvidence.refusal,
                blockedAction: "review-request",
                state: evaluated.state,
                userMessage: message,
                remedies: evaluated.remedies,
              };
          refuseReviewGuard(pd, refusal, guardAttempt);
        }
        const expected = attempt.requestCount + 1;
        const sameSourceRecoveryScope =
          receipts?.newestSourceUnit === (flags.unit ?? null);
        const sourceScopeStale =
          sameSourceRecoveryScope && receipts?.sourceStale === true;
        const artifactScopeStale =
          receipts !== null &&
          (flags.unit
            ? receipts.unitStale.has(flags.unit)
            : receipts.stageStale);
        const scopeStale =
          process.env.AIDLC_SKIP_SOURCE_FRESHNESS !== "1" &&
          fields.Workflow === undefined &&
          receipts !== null &&
          (sourceScopeStale || artifactScopeStale);
        const sourceRecoverySpent =
          sourceScopeStale &&
          (receipts?.sourceRecoverySpent === true ||
            receipts?.sourceStaleProgress?.recoverySpent === true);
        const recoverySpent =
          attempt.recoverySpent || sourceRecoverySpent;
        const refuseAttemptGuard = (
          code: string,
          invariant: string,
          message: string,
        ): never => {
          const guardAttempt = guardAttemptState(pd, state, node, {
            ...(flags.unit ? { unit: flags.unit } : {}),
            ...(receipts ? { receipts } : {}),
            reviewBudget: budget,
            pendingStatus,
            accounting: attempt,
          }).attempt;
          const autonomousBolt =
            autonomousCandidate && attempt.boltStarted && flags.unit
              ? {
                  unit: flags.unit,
                  slug: attempt.boltSlug,
                  batch: attempt.boltBatch,
                }
              : undefined;
          const refusal = evaluateGuardRefusal({
            code,
            blockedAction: "review-request",
            stage: flags.stage,
            ...(flags.unit ? { unit: flags.unit } : {}),
            stateContent: state,
            invariant,
            userMessage: message,
            attempt: guardAttempt,
            humanAuthority: humanAuthorityState(pd),
            ...(teamGate ? { teamGate } : {}),
            ...(autonomousBolt ? { autonomousBolt } : {}),
          });
          refuseReviewGuard(pd, refusal, guardAttempt, [
            `source:${receipts?.newestSourceFingerprint ?? "none"}`,
            `artifact-stale:${artifactScopeStale}`,
          ]);
        };
        if (retryPending) {
          const pendingRequest = attempt.pendingRequests.get(iteration);
          if (!pendingRequest) {
            if (scopeStale) {
              if (recoverySpent) {
                const message = reviewRecoverySpentMessage(
                    flags.stage,
                    autonomousCandidate && attempt.boltStarted
                      ? null
                      : reviewRecoveryGuidance(
                          pd,
                          state,
                          flags.stage,
                          flags.unit,
                          teamGate,
                        ),
                    autonomousCandidate && attempt.boltStarted && flags.unit
                      ? {
                          unit: flags.unit,
                          slug: attempt.boltSlug,
                          batch: attempt.boltBatch,
                        }
                      : undefined,
                    requestChangesResetIsExecutable(
                      state,
                      flags.stage,
                      teamGate,
                    ),
                  );
                refuseAttemptGuard(
                  "REVIEW_RECOVERY_SPENT",
                  "The stale-receipt recovery slot is single-use within an attempt.",
                  message,
                );
              }
              const unitArg = flags.unit ? ` --unit "${flags.unit}"` : "";
              refuseReview(
                `Cannot retry the prior review for "${flags.stage}" because it completed ` +
                  "before the stage output or project source changed. Start the one recovery " +
                  `pass with \`aidlc-log.ts review --stage "${flags.stage}" ` +
                  `--reviewer "${flags.reviewer}"${unitArg} --iteration ${expected}\`.`,
              );
            }
            if (recoverySpent) {
              const message = reviewRecoveryAlreadyRequestedMessage(
                  flags.stage,
                  attempt.recoveryIteration ?? iteration,
                  reviewRecoveryGuidance(
                    pd,
                    state,
                    flags.stage,
                    flags.unit,
                    teamGate,
                  ),
                  requestChangesResetIsExecutable(
                    state,
                    flags.stage,
                    teamGate,
                  ),
                );
              refuseAttemptGuard(
                "REVIEW_RECOVERY_ALREADY_REQUESTED",
                "Only one stale-receipt recovery request exists in an attempt.",
                message,
              );
            }
            refuseReview(
              `Cannot retry review iteration ${iteration} for "${flags.stage}" because no ` +
                `pending request with that number exists. Start the expected review pass instead.`,
            );
          }
          const requestBinding = pendingRequest.binding;
          if (requestBinding === null) {
            refuseReview(
              `Refusing review retry for "${flags.stage}": the original ` +
                `REVIEW_REQUESTED iteration ${iteration} has no valid request ` +
                "binding, so its authority cannot be recovered by rebaselining.",
            );
          }
          if (pendingRequest.retried) {
            refuseReview(
              `Refusing review retry for "${flags.stage}": REVIEW_REQUESTED ` +
                `iteration ${iteration} already used its one pending-request retry. ` +
                "Do not dispatch it again; record the bounded incomplete-review " +
                "NOT-READY fallback or start the next permitted review iteration.",
            );
          }
          const snapshot = reviewArtifactSnapshot(pd, node, flags.unit, {
            requireRequiredArtifacts,
            boltDag: unitResolution ?? undefined,
            mergedBoltUnits,
          });
          if (snapshot === null) {
            refuseReview(
              `Cannot retry review for "${flags.stage}": the declared artifact set ` +
                "could not be captured as one stable snapshot. Restore regular " +
                "artifact files and retry.",
            );
          }
          if (
            !reviewRequestArtifactsCurrent(requestBinding, snapshot) &&
            !reviewAppendedAfterRequest(requestBinding, snapshot)
          ) {
            refuseReview(
              `Refusing review retry for "${flags.stage}": declared artifacts no ` +
                `longer match the bytes from REVIEW_REQUESTED iteration ${iteration}. ` +
                "A retry re-dispatches that exact request and cannot rebaseline changed " +
                "content. Restore the requested artifact bytes before retrying.",
            );
          }
          // A request written before review records, or before source binding on
          // a workspace-writing stage, is modernized by this one retry: it gains a
          // request id and the source fingerprints, keeps its artifact fingerprint,
          // and is marked so the ledger shows the upgrade.
          let legacyUpgrade =
            requestBinding.requestId === null ||
            (node.workspace_requires &&
              requestBinding.sourceFingerprint === null) ||
            (node.workspace_requires &&
              flags.unit !== undefined &&
              node.for_each === "unit-of-work" &&
              flags.single !== "true" &&
              requestBinding.unitSourceFingerprint === null);
          if (node.workspace_requires) {
            stampRequestedSourceBinding(node);
            const currentSource = fields["Source Fingerprint"];
            if (
              requestBinding.sourceFingerprint !== null &&
              currentSource !== requestBinding.sourceFingerprint
            ) {
              refuseReview(
                `Refusing review retry for "${flags.stage}": workspace source no ` +
                  `longer matches REVIEW_REQUESTED iteration ${iteration}. A retry ` +
                  "cannot rebaseline source changed while review was pending.",
              );
            }
            const currentUnitSource = fields["Unit Source Fingerprint"];
            if (
              requestBinding.unitSourceFingerprint !== null &&
              currentUnitSource !== requestBinding.unitSourceFingerprint
            ) {
              refuseReview(
                `Refusing review retry for "${flags.stage}": unit source or ` +
                  `source-manifest.json no longer matches REVIEW_REQUESTED ` +
                  `iteration ${iteration}. A retry cannot rebaseline changed unit source.`,
              );
            }
          }
          if (
            requestBinding.legacyAppendix?.priorAppendix === true &&
            requestBinding.legacyAppendix.challenge === null
          ) {
            legacyUpgrade = true;
          }
          requestId = requestBinding.requestId ?? mintReviewRequestId();
          fields.Retry = "pending-request";
          fields["Artifact Fingerprint"] = requestBinding.artifactFingerprint;
          fields["Request Id"] = requestId;
          if (requestBinding.legacyAppendix !== null) {
            // The retry pairs with the original request under the legacy matcher;
            // echo its appendix binding unchanged.
            Object.assign(
              fields,
              legacyReviewAppendixEchoFields(requestBinding.legacyAppendix),
            );
          }
          if (requestBinding.sourceFingerprint !== null) {
            fields["Source Fingerprint"] = requestBinding.sourceFingerprint;
          }
          if (requestBinding.unitSourceFingerprint !== null) {
            fields["Unit Source Fingerprint"] =
              requestBinding.unitSourceFingerprint;
          }
          if (requestBinding.recoveryCause !== null) {
            fields["Recovery Cause"] = requestBinding.recoveryCause;
          }
          if (legacyUpgrade) {
            fields.Upgrade = "legacy-request";
            upgraded = true;
          }
          openReviewDraftSlot(attempt.floor);
          emitAudit(pd, "REVIEW_REQUESTED", fields, intent, space);
          retried = true;
          return;
        }
        const recoveryEligible =
          budget !== null &&
          scopeStale &&
          attempt.pendingIterations.size === 0 &&
          !recoverySpent;
        if (scopeStale && recoverySpent) {
          const message = reviewRecoverySpentMessage(
              flags.stage,
              autonomousCandidate && attempt.boltStarted
                ? null
                : reviewRecoveryGuidance(
                    pd,
                    state,
                    flags.stage,
                    flags.unit,
                    teamGate,
                  ),
              autonomousCandidate && attempt.boltStarted && flags.unit
                ? {
                    unit: flags.unit,
                    slug: attempt.boltSlug,
                    batch: attempt.boltBatch,
                  }
                : undefined,
              requestChangesResetIsExecutable(
                state,
                flags.stage,
                teamGate,
              ),
            );
          refuseAttemptGuard(
            "REVIEW_RECOVERY_SPENT",
            "The stale-receipt recovery slot is single-use within an attempt.",
            message,
          );
        }
        if (recoverySpent) {
          const message = reviewRecoveryAlreadyRequestedMessage(
              flags.stage,
              attempt.recoveryIteration ?? iteration,
              reviewRecoveryGuidance(
                pd,
                state,
                flags.stage,
                flags.unit,
                teamGate,
              ),
              requestChangesResetIsExecutable(
                state,
                flags.stage,
                teamGate,
              ),
            );
          refuseAttemptGuard(
            "REVIEW_RECOVERY_ALREADY_REQUESTED",
            "Only one stale-receipt recovery request exists in an attempt.",
            message,
          );
        }
        if (!recoveryEligible && budget !== null && iteration > budget) {
          refuseAttemptGuard(
            "REVIEW_BUDGET_EXHAUSTED",
            "Review requests do not exceed the configured attempt budget.",
            reviewBudgetMessage(flags.stage, iteration, budget),
          );
        }
        if (!recoveryEligible && budget !== null && expected > budget) {
          refuseAttemptGuard(
            "REVIEW_BUDGET_EXHAUSTED",
            "Review requests do not exceed the configured attempt budget.",
            reviewBudgetMessage(flags.stage, expected, budget),
          );
        }
        if (attempt.pendingIterations.size > 0) {
          const pending = [...attempt.pendingIterations].sort((a, b) => a - b);
          refuseAttemptGuard(
            "REVIEW_VERDICT_PENDING",
            "A review request receives its verdict before another request starts.",
            `Cannot start another review for "${flags.stage}" because iteration ` +
              `${pending.join(", ")} is still waiting for a verdict. Record that verdict, or ` +
              "repeat the same iteration with --retry-pending if the reviewer did not run.",
          );
        }
        if (iteration !== expected) {
          refuseReview(
            `Cannot start review iteration ${iteration} for "${flags.stage}" because the next ` +
              `iteration is ${expected}. Retry with --iteration ${expected}.`,
          );
        }
        if (recoveryEligible) {
          fields.Recovery = "stale-receipt";
          fields["Recovery Cause"] =
            artifactScopeStale && sourceScopeStale
              ? "artifact+source"
              : artifactScopeStale
                ? "artifact"
                : "source";
          recovery = "stale-receipt";
        }
        const snapshot = reviewArtifactSnapshot(pd, node, flags.unit, {
          requireRequiredArtifacts,
          boltDag: unitResolution ?? undefined,
          mergedBoltUnits,
        });
        if (snapshot === null) {
          refuseReview(
            `Cannot start review for "${flags.stage}": a required output document ` +
              "is missing or unreadable. Create every required output document " +
              "for this stage, then retry the review.",
          );
        }
        fields["Artifact Fingerprint"] = snapshot.fingerprint;
        requestId = mintReviewRequestId();
        fields["Request Id"] = requestId;
        stampRequestedSourceBinding(node);
        openReviewDraftSlot(attempt.floor);
        emitAudit(pd, "REVIEW_REQUESTED", fields, intent, space);
      }, intent, space);
    } catch (e) {
      if (e instanceof ReviewRefusal) error(e.message);
      error(`Audit emission failed: ${errorMessage(e)}`);
    }
    console.log(JSON.stringify({
      emitted: "REVIEW_REQUESTED",
      stage: flags.stage,
      ...(retried ? { retry: "pending-request" } : {}),
      ...(upgraded ? { upgrade: "legacy-request" } : {}),
      ...(recovery ? { recovery } : {}),
      requestId,
      reviewFile,
      ...(requestChangeNotices.length > 0 ? { change_notices: requestChangeNotices } : {}),
    }));
    return;
  }

  if (retryPending) {
    error("--retry-pending cannot be combined with --verdict.");
  }
  if (!flags.iteration || !/^[1-9][0-9]*$/.test(flags.iteration)) {
    error("Recording a review verdict requires --iteration <positive integer>.");
  }
  const iteration = Number(flags.iteration);
  fields.Iteration = flags.iteration;
  const verdict = flags.verdict.toUpperCase();
  if (!VALID_VERDICTS.has(verdict)) {
    error(
      `Unknown --verdict "${flags.verdict}". Accepted: ${[...VALID_VERDICTS].join(", ")}.`
    );
  }
  fields.Verdict = verdict;
  const reviewFileFlag = flags["review-file"];
  let recordPath: string | null = null;

  try {
    withAuditLock(pd, () => {
      const {
        node,
        attempt,
        requireRequiredArtifacts,
        unitResolution,
        mergedBoltUnits,
      } = loadContext(false, false);
      const pendingRequest = attempt.pendingRequests.get(iteration);
      if (!pendingRequest) {
        refuseReview(
          `Cannot record a verdict for review iteration ${iteration} on "${flags.stage}" ` +
            `because no pending request with that number exists. Start or retry that review first.`,
        );
      }
      const requestBinding = pendingRequest.binding;
      if (requestBinding === null) {
        refuseReview(
          `Refusing REVIEW_COMPLETED for "${flags.stage}": the matching REVIEW_REQUESTED ` +
            `iteration ${iteration} has no valid request binding. Its authority ` +
          "cannot be recovered by retrying or rebaselining; start a fresh review attempt.",
        );
      }
      const snapshot = reviewArtifactSnapshot(pd, node, flags.unit, {
        requireRequiredArtifacts,
        boltDag: unitResolution ?? undefined,
        mergedBoltUnits,
      });
      if (snapshot === null) {
        refuseReview(
          `Cannot record review for "${flags.stage}": the declared artifact set ` +
            "changed during the snapshot or is no longer a set of regular files.",
        );
      }
      const bindsUnitSource =
        node.workspace_requires === true &&
        flags.unit !== undefined &&
        node.for_each === "unit-of-work" &&
        flags.single !== "true";
      const manifest = bindsUnitSource
        ? readUnitSourceManifest(pd, flags.stage, flags.unit as string)
        : null;
      if (manifest?.ok === false) {
        const manifestPath = `${relativeRecordDir(pd, intent, space) ?? "aidlc"}/construction/${flags.unit}/${flags.stage}/source-manifest.json`;
        refuseReview(
          `Cannot record review for "${flags.stage}": unit "${flags.unit}" has no valid source manifest at ` +
            `${manifestPath} (${manifest.reason}). Write the manifest listing every application-source path ` +
            "this unit created or modified, including shell- or generator-written files, then request and " +
            "record the review again.",
        );
      }

      const slot = reviewSlot(attempt.floor, iteration);
      const legacy = requestBinding.legacyAppendix;

      // Deprecated migration path: a reviewer that still appends `## Review` to
      // the artifact (see reviewAppendedAfterRequest). Read, never written to,
      // and it leaves no record.
      const appendedAfterRequest = reviewAppendedAfterRequest(requestBinding, snapshot);

      // The reviewer writes a review, never the artifact: the bytes the reviewer
      // was dispatched on must be the bytes on disk now. A legacy request is
      // compared against the body before any embedded appendix, which is what
      // it fingerprinted.
      if (
        !reviewRequestArtifactsCurrent(requestBinding, snapshot) &&
        !appendedAfterRequest
      ) {
        refuseReview(
          `Cannot record the verdict for "${flags.stage}" because ` +
            `its output documents changed after review iteration ${iteration} started. ` +
            "Restore the bytes the reviewer was dispatched on and re-run that exact " +
            "iteration; --retry-pending cannot rebaseline changed content.",
        );
      }

      // The review file is read the way the record will be read back: no
      // symlinked container or leaf, no hardlink, no oversize file. A slot
      // draft that is absent is an incomplete review; one that is anything but
      // a plain file is refused, never silently treated as missing.
      let body: Buffer | null = null;
      try {
        if (reviewFileFlag !== undefined) {
          // An explicit review file must live inside the active intent record,
          // where the reviewer's slot lives, reached through no symlink: a
          // path outside it is not the reviewer's output.
          const recordRoot = realpathSync(recordDir(pd) as string);
          const relativeToRecord = toPosix(relative(recordRoot, resolve(pd, reviewFileFlag)));
          if (
            relativeToRecord === "" ||
            relativeToRecord === ".." ||
            relativeToRecord.startsWith("../") ||
            isAbsolute(relativeToRecord)
          ) {
            throw new Error("the path is outside the active intent record");
          }
          body = readRegularFileNoFollowOrThrow(
            assertNoSymlinkInChainOrThrow(recordRoot, relativeToRecord),
            "review file",
            REVIEW_RECORD_MAX_BYTES,
          );
        } else {
          const target = assertNoSymlinkInChainOrThrow(
            realpathSync(recordDir(pd) as string),
            slot.draftRelativeToRecord,
          );
          if (lstatExists(target)) {
            body = readRegularFileNoFollowOrThrow(target, "review file", REVIEW_RECORD_MAX_BYTES);
          }
        }
      } catch (readError) {
        refuseReview(
          `Cannot record review for "${flags.stage}": the review file ` +
            `${reviewFileFlag ?? slot.draftRelative} is not a plain readable file ` +
            `(${errorMessage(readError)}).`,
        );
      }
      if (body !== null && snapshot.appendix.length > 0 && appendedAfterRequest) {
        refuseReview(
          `Cannot record the verdict for "${flags.stage}": a \`## Review\` section was ` +
            `appended to the reviewed artifact after review iteration ${iteration} started ` +
            "and a review file was also written. The review file is the review; remove the " +
            "appended section so the artifact carries the bytes the reviewer was dispatched on.",
        );
      }
      const incompleteFallback =
        body === null &&
        !appendedAfterRequest &&
        pendingRequest.retried &&
        verdict === "NOT-READY";
      const embeddedLegacy = body === null && !incompleteFallback && appendedAfterRequest;
      if (body === null && !incompleteFallback && !embeddedLegacy) {
        refuseReview(
          `Cannot record review for "${flags.stage}": no review was written for ` +
            `iteration ${iteration}. The reviewer writes its review to ` +
            `${slot.draftRelative} (or pass --review-file <path>); a retried ` +
            "incomplete attempt records --verdict NOT-READY without a review.",
        );
      }
      const reviewBytes = body ?? snapshot.appendix;
      if (!incompleteFallback) {
        const validity = validateReviewAppendix(reviewBytes, {
          verdict: verdict as ReviewVerdict,
          reviewer: flags.reviewer,
          iteration,
          reviewChallenge: embeddedLegacy ? legacy?.challenge ?? null : null,
          standalone: body !== null,
        });
        if (!validity.valid) {
          refuseReview(
            `Refusing REVIEW_COMPLETED for "${flags.stage}": ${validity.reason}.`,
          );
        }
      }

      fields["Request Fingerprint"] = requestBinding.artifactFingerprint;
      fields["Artifact Fingerprint"] = snapshot.fingerprint;
      if (requestBinding.requestId !== null) {
        fields["Request Id"] = requestBinding.requestId;
      }
      if (legacy !== null) {
        Object.assign(fields, legacyReviewAppendixEchoFields(legacy));
      }
      // Bind the terminal receipt to the workspace source state the reviewer
      // inspected. Only workspace-writing stages carry this binding. A newly
      // unbindable receipt records that explicitly so completion fails closed;
      // only genuinely legacy fieldless receipts keep migration behavior.
      let sourceFingerprint: string | null = null;
      let unitFingerprint: string | null = null;
      if (node.workspace_requires) {
        const sourceState = workspaceSourceState(pd, intent, space);
        sourceFingerprint = sourceState?.fingerprint ?? UNBINDABLE_FINGERPRINT;
        if (requestBinding.sourceFingerprint === null) {
          refuseReview(
            `Refusing REVIEW_COMPLETED for "${flags.stage}": the matching REVIEW_REQUESTED ` +
              `iteration ${iteration} has no source fingerprint. Modernize that exact ` +
              "request with --retry-pending before recording the verdict.",
          );
        }
        if (sourceFingerprint !== requestBinding.sourceFingerprint) {
          refuseReview(
            `Refusing REVIEW_COMPLETED for "${flags.stage}": workspace source changed after ` +
              `REVIEW_REQUESTED iteration ${iteration}. Restore the requested source state ` +
              "and re-dispatch the reviewer.",
          );
        }
        fields["Request Source Fingerprint"] = sourceFingerprint;
        fields["Source Fingerprint"] = sourceFingerprint;
        if (bindsUnitSource) {
          unitFingerprint =
            sourceState === null || manifest?.ok !== true
              ? UNBINDABLE_FINGERPRINT
              : unitSourceFingerprint(
                  sourceState.listing,
                  manifest,
                  manifest.rawBytesSha256,
                );
          if (requestBinding.unitSourceFingerprint === null) {
            refuseReview(
              `Refusing REVIEW_COMPLETED for "${flags.stage}": the matching REVIEW_REQUESTED ` +
                `iteration ${iteration} has no unit source fingerprint. Modernize that exact ` +
                "request with --retry-pending before recording the verdict.",
            );
          }
          if (unitFingerprint !== requestBinding.unitSourceFingerprint) {
            refuseReview(
              `Refusing REVIEW_COMPLETED for "${flags.stage}": unit source or source-manifest.json ` +
                `changed after REVIEW_REQUESTED iteration ${iteration}. Restore the requested ` +
                "unit source state and re-dispatch the reviewer.",
            );
          }
          fields["Unit Source Fingerprint"] = unitFingerprint;
          if (sourceState !== null && manifest?.ok === true) {
            writeUnitSourceSnapshot(
              pd,
              flags.stage,
              flags.unit as string,
              sourceState.listing,
              manifest,
              manifest.rawBytesSha256,
            );
          }
        }
      }

      // The record is the review. Written here and only here, in the same
      // transaction as the row that names it, so the row's digest is the only
      // authority over its bytes. A legacy embedded review leaves no record; its
      // section stays readable where the reviewer left it.
      if (body !== null) {
        const artifactKey = snapshot.reviewArtifact;
        let findings: ReturnType<typeof parseReviewSection>["findings"];
        try {
          findings = parseReviewSection(body.toString("utf-8"), artifactKey, flags.unit).findings;
        } catch (parseError) {
          refuseReview(
            `Refusing REVIEW_COMPLETED for "${flags.stage}": ${errorMessage(parseError)}.`,
          );
        }
        const record: ReviewRecord = {
          version: 1,
          stage: flags.stage,
          unit: flags.unit ?? null,
          workflow: fields.Workflow ?? null,
          attempt: reviewAttemptId(attempt.floor),
          iteration,
          reviewer: flags.reviewer,
          verdict: verdict as ReviewVerdict,
          request_id: requestBinding.requestId,
          request_challenge: legacy?.challenge ?? null,
          artifact_fingerprint: snapshot.fingerprint,
          source_fingerprint: sourceFingerprint,
          unit_source_fingerprint: unitFingerprint,
          findings: findings.map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            location: finding.location,
            finding: finding.finding,
            required_action: finding.requiredAction,
            status: finding.status,
          })),
          body: body.toString("utf-8"),
          recorded_at: isoTimestamp(),
        };
        const serialized = serializeReviewRecord(record);
        // The record is written through no symlinked component: a redirected
        // `.aidlc-reviews` refuses the completion instead of writing the
        // review outside the intent record.
        try {
          writeRecordFileNoFollow(recordDir(pd) as string, slot.recordRelative, serialized);
        } catch (e) {
          refuseReview(
            `Cannot record the verdict for "${flags.stage}": the review record ` +
              `${slot.recordRelative} cannot be written (${errorMessage(e)}).`,
          );
        }
        fields["Review Record"] = slot.recordRelative;
        fields["Review Record Digest"] = reviewRecordDigest(serialized);
        recordPath = slot.recordRelative;
      }
      emitAudit(pd, "REVIEW_COMPLETED", fields, intent, space);
      // The draft was the reviewer's input; the record now holds it. The
      // chain was verified when the draft was read, so this cannot redirect.
      if (body !== null && reviewFileFlag === undefined) {
        removeRecordFileNoFollow(recordDir(pd) as string, slot.draftRelativeToRecord);
      }
    }, intent, space);
  } catch (e) {
    if (e instanceof ReviewRefusal) error(e.message);
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(JSON.stringify({
    emitted: "REVIEW_COMPLETED",
    stage: flags.stage,
    ...(recordPath !== null ? { reviewRecord: recordPath } : {}),
  }));
}

// --- CLI entry point ---

let projectDir: string | undefined;

export function main(argv: string[]): void {
  const rawArgs = argv;

  // Extract --project-dir
  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--project-dir" && i + 1 < rawArgs.length) {
      projectDir = rawArgs[i + 1];
      i++;
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }

  const subcommand = filteredArgs[0];

  try {
    switch (subcommand) {
      case "decision":
        handleDecision(filteredArgs.slice(1));
        break;
      case "answer":
        handleAnswer(filteredArgs.slice(1));
        break;
      case "link":
        handleLink(filteredArgs.slice(1));
        break;
      case "review":
        handleReview(filteredArgs.slice(1));
        break;
      default:
        error(`Unknown subcommand: ${subcommand}. Valid: decision, answer, link, review`);
    }
  } catch (e) {
    // A Plan Approval source-drift refusal is the human sentence; the
    // conductor's remedy (which command reopens approval) rides beside it.
    if (e instanceof PlanApprovalSourceDriftError) {
      console.error(JSON.stringify({ remedy: e.remedy }));
    }
    error(errorMessage(e));
  }
}

// --- Utility ---

function error(msg: string): never {
  const pd = resolveProjectDir(projectDir);
  const command = `aidlc-log ${process.argv.slice(2).join(" ")}`.trim();
  emitError(pd, "aidlc-log", command, msg);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
