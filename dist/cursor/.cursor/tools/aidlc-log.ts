// aidlc-log.ts — Interaction audit helper
//
// Records DECISION_RECORDED (before AskUserQuestion), QUESTION_ANSWERED
// (after the user answers), and REVIEW_REQUESTED / REVIEW_COMPLETED (the §12a
// reviewer step). Orchestrator-callable; state tool doesn't own these because
// they fire per-question / per-review, not per state transition.

import { existsSync, readFileSync } from "node:fs";
import { appendAuditEntry, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  auditBlockField,
  emitError,
  errorMessage,
  holdsAuditLock,
  humanActedSinceLastAnswer,
  humanPresenceGuardDisabled,
  isAutonomousMode,
  parseCheckboxes,
  readAllAuditShards,
  resolveProjectDir,
  stateFilePath,
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
  fields: Record<string, string>
): void {
  if (holdsAuditLock(pd)) {
    appendAuditEntryUnlocked(eventType, fields, pd);
    return;
  }
  appendAuditEntry(eventType, fields, pd);
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
      if (a === "--single") {
        flags.single = "true";
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

// --- Subcommand: decision ---
// Usage: aidlc-log decision --stage <slug> --decision <text> [--options <csv>] [--rationale <text>]
//
// Fires BEFORE AskUserQuestion, recording what options will be shown.
function handleDecision(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.decision) error("Missing --decision <text>");

  const pd = resolveActiveProjectDir(projectDir);
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Decision: flags.decision,
  };
  if (flags.options) fields.Options = flags.options;
  if (flags.rationale) fields.Rationale = flags.rationale;

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
    } else if (event.event === "QUESTION_ANSWERED") {
      pending = false;
    }
  }
  return pending;
}

function handleAnswer(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.details) error("Missing --details <text>");

  const pd = resolveActiveProjectDir(projectDir);
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Details: flags.details,
  };

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

function handleReview(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.reviewer) error("Missing --reviewer <agent>");

  const pd = resolveActiveProjectDir(projectDir);
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Reviewer: flags.reviewer,
  };
  if (flags.unit) fields.Unit = flags.unit;
  if (flags.iteration) fields.Iteration = flags.iteration;
  if (flags.single === "true") fields.Workflow = `single-stage:${flags.stage}`;

  let eventType: "REVIEW_REQUESTED" | "REVIEW_COMPLETED";
  if (flags.verdict !== undefined) {
    const verdict = flags.verdict.toUpperCase();
    if (!VALID_VERDICTS.has(verdict)) {
      error(
        `Unknown --verdict "${flags.verdict}". Accepted: ${[...VALID_VERDICTS].join(", ")}.`
      );
    }
    fields.Verdict = verdict;
    eventType = "REVIEW_COMPLETED";
  } else {
    eventType = "REVIEW_REQUESTED";
  }

  try {
    emitAudit(pd, eventType, fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(JSON.stringify({ emitted: eventType, stage: flags.stage }));
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
