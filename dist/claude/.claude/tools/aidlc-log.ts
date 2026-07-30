// aidlc-log.ts — Interaction audit helper
//
// Records DECISION_RECORDED (before AskUserQuestion), QUESTION_ANSWERED
// (after ordinary answers), SUMMARY_CONFIRMATION_RECORDED (the reserved,
// human-backed pre-generation receipt), and REVIEW_REQUESTED / REVIEW_COMPLETED
// (the §12a reviewer step). Orchestrator-callable; state tool doesn't own these
// because they fire per-question / per-review, not per state transition.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { appendAuditEntry, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  activeIntent,
  activeSpace,
  auditBlockField,
  emitError,
  errorMessage,
  extractMarkdownSection,
  getField,
  holdsAuditLock,
  humanActedSinceLastAnswer,
  humanPresenceGuardDisabled,
  isAutonomousMode,
  isAutonomousSwarmStage,
  loadStageGraphAll,
  isNonAnswer,
  parseCheckboxes,
  readAllAuditShards,
  readStateFile,
  recordDir,
  reviewArtifactFingerprint,
  resolveProjectDir,
  resolveReviewClass,
  SUMMARY_CONFIRMATION_CHECKPOINT,
  stateFilePath,
  toPosix,
  withAuditLock,
} from "./aidlc-lib.js";

// Resolve the project dir AND assert that an active workflow exists before any
// audit emit. WHY: aidlc-log is orchestrator-called per-question and threads no
// --intent/--space, so it relies on default intent resolution. On a fresh shell
// (pre-birth) or a >1-intent workspace with no active-intent cursor, that
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
      'No active workflow — refusing to log an interaction event with no resolvable intent. Start a workflow first by describing what to build (/aidlc "build the auth service"), or switch to an intent (/aidlc intent <name>) if several exist.'
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
      if (a === "--single" || a === "--retry-pending") {
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
  const section = extractMarkdownSection(
    body,
    `## ${SUMMARY_CONFIRMATION_CHECKPOINT}`,
  );
  const answers = [...section.matchAll(/^\[Answer\]:[ \t]*(.*)$/gm)];
  if (answers.length !== 1 || answers[0][1].trim() !== expectedAnswer) {
    const rendered = expectedAnswer || "a blank value";
    error(
      `Summary confirmation section in ${supplied} must contain exactly one ` +
      `\`[Answer]:\` line with ${rendered} before this command runs.`,
    );
  }

  return {
    relativePath: toPosix(relative(pd, absolute)),
    sha256: createHash("sha256").update(body).digest("hex"),
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
    flags.checkpoint !== "summary-confirmation"
  ) {
    error(
      `Unknown --checkpoint "${flags.checkpoint}". Accepted: summary-confirmation`,
    );
  }

  const pd = resolveActiveProjectDir(projectDir);
  const summaryEvidence =
    flags.checkpoint === "summary-confirmation"
      ? summaryQuestionEvidence(pd, flags, "")
      : null;
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Decision: flags.decision,
  };
  if (flags.options) fields.Options = flags.options;
  if (flags.rationale) fields.Rationale = flags.rationale;
  if (flags.checkpoint === "summary-confirmation") {
    fields.Checkpoint = SUMMARY_CONFIRMATION_CHECKPOINT;
    fields["Questions File"] = summaryEvidence!.relativePath;
  }
  if (flags.unit) fields.Unit = flags.unit;
  if (flags.single === "true") fields.Workflow = `single-stage:${flags.stage}`;

  try {
    emitAudit(pd, "DECISION_RECORDED", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(
    JSON.stringify({ emitted: "DECISION_RECORDED", stage: flags.stage })
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
): { pending: boolean; humanAfterDecision: boolean } {
  const audit = readAllAuditShards(pd);
  if (audit.length === 0) {
    return { pending: false, humanAfterDecision: false };
  }

  const entries = audit
    .replace(/\r\n/g, "\n")
    .split(/\n---\n/)
    .map((block, position) => ({
      block,
      position,
      event: auditBlockField(block, "Event") ?? "",
      timestamp: auditBlockField(block, "Timestamp") ?? "",
    }))
    .filter((entry) =>
      entry.event === "DECISION_RECORDED" ||
      entry.event === "SUMMARY_CONFIRMATION_RECORDED" ||
      entry.event === "STAGE_COMPLETED" ||
      entry.event === "HUMAN_TURN"
    )
    .sort((a, b) =>
      a.timestamp !== b.timestamp
        ? (a.timestamp < b.timestamp ? -1 : 1)
        : a.position - b.position
    );

  let decision = -1;
  let answer = -1;
  let human = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (
      entry.event === "STAGE_COMPLETED" &&
      auditBlockField(entry.block, "Stage") === stage &&
      auditBlockField(entry.block, "Workflow") === workflow
    ) {
      decision = -1;
      answer = -1;
      human = -1;
      continue;
    }
    if (entry.event === "HUMAN_TURN") {
      human = i;
      continue;
    }
    if (auditBlockField(entry.block, "Stage") !== stage) continue;
    if (
      auditBlockField(entry.block, "Checkpoint") !==
        SUMMARY_CONFIRMATION_CHECKPOINT
    ) {
      continue;
    }
    if ((auditBlockField(entry.block, "Unit") ?? undefined) !== unit) continue;
    if (
      (auditBlockField(entry.block, "Workflow") ?? undefined) !== workflow
    ) {
      continue;
    }
    if (auditBlockField(entry.block, "Questions File") !== questionsFile) {
      continue;
    }
    if (entry.event === "DECISION_RECORDED") decision = i;
    if (entry.event === "SUMMARY_CONFIRMATION_RECORDED") answer = i;
  }

  return {
    pending: decision > answer,
    humanAfterDecision: human > decision && decision >= 0,
  };
}

function handleAnswer(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.details) error("Missing --details <text>");

  // A cancelled/dismissed/auto-resolved question widget is not an answer.
  // Some harnesses return a completed-looking object for a dismissed question.
  if (isNonAnswer(flags.details)) {
    error(
      `Refusing to record "${flags.details.trim() || "(empty)"}" as an answer: it is cancellation ` +
        "boilerplate, not a human decision. If the user dismissed the question, re-present it and " +
        "wait for a real answer; do not log the dismissal.",
    );
  }

  if (
    flags.checkpoint !== undefined &&
    flags.checkpoint !== "summary-confirmation"
  ) {
    error(
      `Unknown --checkpoint "${flags.checkpoint}". Accepted: summary-confirmation`,
    );
  }
  const summaryCheckpoint = flags.checkpoint === "summary-confirmation";
  if (
    summaryCheckpoint &&
    flags.details !== "Looks correct" &&
    flags.details !== "Request changes"
  ) {
    error(
      'Summary confirmation --details must be exactly "Looks correct" or "Request changes".',
    );
  }

  const pd = resolveActiveProjectDir(projectDir);
  const summaryEvidence = summaryCheckpoint
    ? summaryQuestionEvidence(pd, flags, flags.details)
    : null;
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Details: flags.details,
  };
  if (summaryCheckpoint) {
    fields.Checkpoint = SUMMARY_CONFIRMATION_CHECKPOINT;
    fields["Questions File"] = summaryEvidence!.relativePath;
    fields["Questions SHA-256"] = summaryEvidence!.sha256;
  }
  if (flags.unit) fields.Unit = flags.unit;
  if (flags.single === "true") fields.Workflow = `single-stage:${flags.stage}`;

  // Classification and emission run under ONE audit lock: a concurrent
  // gate-start (itself locked) cannot flip the stage to [?] between the
  // checkbox read below and the QUESTION_ANSWERED append, which would
  // re-create the answer-consumes-the-turn deadlock this branch prevents.
  // appendAuditEntry / emitError re-acquire reentrantly (per-pd depth).
  withAuditLock(pd, () => {
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
    const workflow =
      flags.single === "true" ? `single-stage:${flags.stage}` : undefined;

    if (summaryCheckpoint) {
      const pending = pendingSummaryDecision(
        pd,
        flags.stage,
        flags.unit,
        workflow,
        summaryEvidence!.relativePath,
      );
      if (!pending.pending) {
        error(
          "Refusing to record summary confirmation: no matching unanswered " +
          "summary-confirmation decision is recorded for this stage, unit, and run. " +
          "Record the decision before presenting the summary prompt.",
        );
      }
      if (
        !humanPresenceGuardDisabled() &&
        !pending.humanAfterDecision
      ) {
        error(
          "Refusing to record summary confirmation: a real human has not responded " +
          "after this summary prompt. End the turn, wait for the human's choice, " +
          "then record it.",
        );
      }
      try {
        emitAudit(pd, "SUMMARY_CONFIRMATION_RECORDED", fields);
      } catch (e) {
        error(`Audit emission failed: ${errorMessage(e)}`);
      }
      console.log(
        JSON.stringify({
          emitted: "SUMMARY_CONFIRMATION_RECORDED",
          checkpoint: "summary-confirmation",
          stage: flags.stage,
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
        !isAutonomousMode(content) &&
        !humanPresenceGuardDisabled() &&
        !humanActedSinceLastAnswer(pd)
      ) {
        error(
          "Refusing to acknowledge this approval choice: a real human has not acted at this gate this turn. The gate is report-owned - after the human types their choice, call aidlc-orchestrate.ts report --result approved or rejected; do not log it as an answer."
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

    if (isAutonomousMode(content)) {
      // autonomous Construction: no human presence required
    } else if (humanPresenceGuardDisabled()) {
      // scoped test off-switch
    } else if (!humanActedSinceLastAnswer(pd)) {
      error(
        "Refusing to record this answer: a real human has not acted at this checkpoint this turn. Type your answer in the session (which records a human turn) before logging it."
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

type ReviewAttemptSummary = {
  requestCount: number;
  boltStarted: boolean;
  pendingIterations: Set<number>;
};

// Count requests in the current stage/unit attempt. The same chronological
// floors used by receipt freshness reset the budget on workflow start, jump,
// stage re-entry, or gate rejection. A matching BOLT_STARTED is a stronger
// per-unit floor because the forked audit inherits the main workflow's prior
// rows; it is also the proof that `--unit` belongs to an actual Bolt attempt.
function reviewAttemptSummary(
  audit: string,
  stateContent: string,
  stage: { slug: string; for_each?: string },
  reviewer: string,
  unit: string | undefined,
  workflow: string | undefined,
  trackBoltLifecycle: boolean,
): ReviewAttemptSummary {
  const relevant = new Set([
    "WORKFLOW_STARTED",
    "STAGE_STARTED",
    "STAGE_COMPLETED",
    "STAGE_JUMPED",
    "GATE_REJECTED",
    "BOLT_STARTED",
    "BOLT_COMPLETED",
    "BOLT_FAILED",
    "REVIEW_REQUESTED",
    "REVIEW_COMPLETED",
  ]);
  const blocks = audit.replace(/\r\n/g, "\n").split(/\n---\n/);
  const events: { pos: number; ts: string; event: string; block: string }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const event = auditBlockField(blocks[i], "Event");
    if (!event || !relevant.has(event)) continue;
    events.push({
      pos: i,
      ts: auditBlockField(blocks[i], "Timestamp") ?? "",
      event,
      block: blocks[i],
    });
  }
  events.sort((a, b) =>
    a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.pos - b.pos
  );

  const unitMajor =
    stage.for_each === "unit-of-work" &&
    getField(stateContent, "Construction Iteration")?.trim() === "unit-major";
  let floor = -1;
  let boltStarted = false;
  for (let i = 0; i < events.length; i++) {
    const entry = events[i];
    if (workflow !== undefined) {
      if (
        entry.event === "STAGE_COMPLETED" &&
        auditBlockField(entry.block, "Stage") === stage.slug &&
        auditBlockField(entry.block, "Workflow") === workflow
      ) {
        floor = i;
      }
      continue;
    }
    if (entry.event === "WORKFLOW_STARTED" || entry.event === "STAGE_JUMPED") {
      floor = i;
      boltStarted = false;
      continue;
    }
    if (
      entry.event === "BOLT_STARTED" &&
      trackBoltLifecycle &&
      unit !== undefined &&
      auditBlockField(entry.block, "Bolt slug") === unit
    ) {
      floor = i;
      boltStarted = true;
      continue;
    }
    if (
      trackBoltLifecycle &&
      (entry.event === "BOLT_COMPLETED" || entry.event === "BOLT_FAILED") &&
      unit !== undefined &&
      auditBlockField(entry.block, "Bolt slug") === unit
    ) {
      floor = i;
      boltStarted = false;
      continue;
    }
    if (auditBlockField(entry.block, "Stage") !== stage.slug) continue;
    if (entry.event === "GATE_REJECTED") {
      floor = i;
      boltStarted = false;
    } else if (
      entry.event === "STAGE_STARTED" &&
      !unitMajor &&
      !auditBlockField(entry.block, "Workflow")?.startsWith("single-stage:")
    ) {
      floor = i;
      boltStarted = false;
    }
  }

  let requestCount = 0;
  const pendingIterations = new Set<number>();
  for (let i = floor + 1; i < events.length; i++) {
    const entry = events[i];
    if (
      entry.event !== "REVIEW_REQUESTED" &&
      entry.event !== "REVIEW_COMPLETED"
    ) {
      continue;
    }
    if (auditBlockField(entry.block, "Stage") !== stage.slug) continue;
    if (auditBlockField(entry.block, "Reviewer") !== reviewer) continue;
    const eventUnit = auditBlockField(entry.block, "Unit") || undefined;
    if (eventUnit !== unit) continue;
    const eventWorkflow = auditBlockField(entry.block, "Workflow") || undefined;
    if (
      workflow !== undefined
        ? eventWorkflow !== workflow
        : eventWorkflow?.startsWith("single-stage:")
    ) {
      continue;
    }
    const rawIteration = auditBlockField(entry.block, "Iteration");
    if (!rawIteration || !/^[1-9][0-9]*$/.test(rawIteration)) continue;
    const iteration = Number(rawIteration);
    if (entry.event === "REVIEW_REQUESTED") {
      if (auditBlockField(entry.block, "Retry") !== "pending-request") {
        requestCount++;
      }
      pendingIterations.add(iteration);
    } else {
      pendingIterations.delete(iteration);
    }
  }
  return { requestCount, boltStarted, pendingIterations };
}

function reviewBudgetMessage(stage: string, ordinal: number, budget: number): string {
  return (
    `Refusing REVIEW_REQUESTED for "${stage}": review request ${ordinal} exceeds ` +
    `this stage's review budget (${budget}). ` +
    (budget === 1
      ? "This review runs as a single advisory pass - do not re-invoke the reviewer; " +
        "quote its findings at the approval gate for the human to triage."
      : "The review loop is exhausted - present the gate with the unresolved findings " +
        "for the human's decision instead of another review pass.")
  );
}

class ReviewRefusal extends Error {}

function refuseReview(message: string): never {
  throw new ReviewRefusal(message);
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
  const space = activeSpace(pd);
  const intent = activeIntent(pd, space);
  if (!intent) {
    error("Cannot resolve the active intent for review logging.");
  }
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Reviewer: flags.reviewer,
  };
  if (flags.unit) fields.Unit = flags.unit;
  if (flags.single === "true") fields.Workflow = `single-stage:${flags.stage}`;
  const retryPending = flags["retry-pending"] === "true";

  const loadContext = () => {
    const state = readStateFile(pd, intent, space);
    const node = loadStageGraphAll().find((stage) => stage.slug === flags.stage);
    if (!node?.reviewer) {
      refuseReview(`Cannot record review: stage "${flags.stage}" has no declared reviewer.`);
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
    const attempt = reviewAttemptSummary(
      readAllAuditShards(pd, intent, space),
      state,
      node,
      flags.reviewer,
      flags.unit,
      fields.Workflow,
      autonomousCandidate,
    );
    return { state, node, attempt, autonomousCandidate };
  };

  // REVIEW_REQUESTED owns its ordinal: require a positive integer, count prior
  // requests in the current attempt, and append under the same lock. This closes
  // duplicate/missing-label bypasses and makes concurrent requests serialize.
  if (flags.verdict === undefined) {
    if (!flags.iteration || !/^[1-9][0-9]*$/.test(flags.iteration)) {
      error("REVIEW_REQUESTED requires --iteration <positive integer>.");
    }
    const iteration = Number(flags.iteration);
    fields.Iteration = flags.iteration;
    let retried = false;
    try {
      withAuditLock(pd, () => {
        const { state, node, attempt, autonomousCandidate } = loadContext();
        if (retryPending) {
          if (!attempt.pendingIterations.has(iteration)) {
            refuseReview(
              `Refusing review retry for "${flags.stage}": no unmatched ` +
                `REVIEW_REQUESTED iteration ${iteration} exists in the current audit attempt.`,
            );
          }
          fields.Retry = "pending-request";
          emitAudit(pd, "REVIEW_REQUESTED", fields, intent, space);
          retried = true;
          return;
        }
        const expected = attempt.requestCount + 1;
        const declared = node.review_class ?? "adversarial";
        let budget: number | null = null;
        if (autonomousCandidate && attempt.boltStarted) {
          budget =
            declared === "advisory"
              ? 1
              : node.reviewer_max_iterations ?? 2;
        } else {
          try {
            const effective = resolveReviewClass(
              declared,
              getField(state, "Scope") ?? "",
              state,
            );
            if (effective === "none") budget = 0;
            else if (effective === "advisory") budget = 1;
            else budget = node.reviewer_max_iterations ?? 2;
          } catch {
            // Class resolution fails open; ordinal enforcement remains active.
          }
        }
        if (budget !== null && iteration > budget) {
          refuseReview(reviewBudgetMessage(flags.stage, iteration, budget));
        }
        if (budget !== null && expected > budget) {
          refuseReview(reviewBudgetMessage(flags.stage, expected, budget));
        }
        if (iteration !== expected) {
          refuseReview(
            `Refusing REVIEW_REQUESTED for "${flags.stage}": iteration ${iteration} ` +
              `is out of sequence; expected ${expected} from the current audit attempt.`,
          );
        }
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
    }));
    return;
  }

  if (retryPending) {
    error("--retry-pending cannot be combined with --verdict.");
  }
  if (!flags.iteration || !/^[1-9][0-9]*$/.test(flags.iteration)) {
    error("REVIEW_COMPLETED requires --iteration <positive integer>.");
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

  try {
    withAuditLock(pd, () => {
      const { node, attempt } = loadContext();
      if (!attempt.pendingIterations.has(iteration)) {
        refuseReview(
          `Refusing REVIEW_COMPLETED for "${flags.stage}": no unmatched ` +
            `REVIEW_REQUESTED iteration ${iteration} exists in the current audit attempt.`,
        );
      }
      const fingerprint = reviewArtifactFingerprint(pd, node, flags.unit);
      if (fingerprint === null) {
        refuseReview(
          `Cannot record review for "${flags.stage}": the declared artifact set could not be fingerprinted. Resolve the active intent and readable artifact paths, then record the verdict again.`,
        );
      }
      fields["Artifact Fingerprint"] = fingerprint;
      emitAudit(pd, "REVIEW_COMPLETED", fields, intent, space);
    }, intent, space);
  } catch (e) {
    if (e instanceof ReviewRefusal) error(e.message);
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(JSON.stringify({ emitted: "REVIEW_COMPLETED", stage: flags.stage }));
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
      case "review":
        handleReview(filteredArgs.slice(1));
        break;
      default:
        error(`Unknown subcommand: ${subcommand}. Valid: decision, answer, review`);
    }
  } catch (e) {
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
