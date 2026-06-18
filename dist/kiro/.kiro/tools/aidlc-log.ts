// aidlc-log.ts — Interaction audit helper
//
// Records DECISION_RECORDED (before AskUserQuestion) and QUESTION_ANSWERED
// (after the user answers). Orchestrator-callable; state tool doesn't own
// these because they fire per-question, not per state transition.
//
// Both commands accept an optional --test-run flag that adds Test-Run=true
// to the emitted fields. Under test-run, this replaces the old auto-events
// (QUESTION_AUTO_ANSWERED, OPTION_AUTO_SELECTED, ACTION_AUTO_CONFIRMED).

import { existsSync } from "node:fs";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  emitError,
  errorMessage,
  resolveProjectDir,
  stateFilePath,
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
// same check, handleEnableTestRun() via a die(). aidlc-log is the lone emitter
// that was missing it; mirror the clean-error idiom (orchestrator-called → a
// missing workflow is a misuse, not a routine no-op).
function resolveActiveProjectDir(explicit?: string): string {
  const pd = resolveProjectDir(explicit);
  if (!existsSync(stateFilePath(pd))) {
    error(
      'No active workflow — refusing to log an interaction event with no resolvable intent. Start a workflow first by describing what to build (/aidlc "build the auth service"), or switch to an intent (/aidlc intent <name>) if several exist.'
    );
  }
  return pd;
}

function emitAudit(
  pd: string,
  eventType: string,
  fields: Record<string, string>
): void {
  appendAuditEntry(eventType, fields, pd);
}

// --- Flag parsing ---

function parseFlags(
  args: string[]
): { positional: string[]; flags: Record<string, string>; testRun: boolean } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let testRun = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--test-run") {
      testRun = true;
    } else if (a.startsWith("--")) {
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
  return { positional, flags, testRun };
}

// --- Subcommand: decision ---
// Usage: aidlc-log decision --stage <slug> --decision <text> [--options <csv>] [--rationale <text>] [--test-run]
//
// Fires BEFORE AskUserQuestion, recording what options will be shown.
function handleDecision(args: string[]): void {
  const { flags, testRun } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.decision) error("Missing --decision <text>");

  const pd = resolveActiveProjectDir(projectDir);
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Decision: flags.decision,
  };
  if (flags.options) fields.Options = flags.options;
  if (flags.rationale) fields.Rationale = flags.rationale;
  if (testRun) fields["Test-Run"] = "true";

  try {
    emitAudit(pd, "DECISION_RECORDED", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(
    JSON.stringify({ emitted: "DECISION_RECORDED", stage: flags.stage, test_run: testRun })
  );
}

// --- Subcommand: answer ---
// Usage: aidlc-log answer --stage <slug> --details <text> [--test-run]
//
// Fires AFTER the user answers a question (or AUTO fires under test-run).
function handleAnswer(args: string[]): void {
  const { flags, testRun } = parseFlags(args);
  if (!flags.stage) error("Missing --stage <slug>");
  if (!flags.details) error("Missing --details <text>");

  const pd = resolveActiveProjectDir(projectDir);
  const fields: Record<string, string> = {
    Stage: flags.stage,
    Details: flags.details,
  };
  if (testRun) fields["Test-Run"] = "true";

  try {
    emitAudit(pd, "QUESTION_ANSWERED", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(
    JSON.stringify({ emitted: "QUESTION_ANSWERED", stage: flags.stage, test_run: testRun })
  );
}

// --- CLI entry point ---

let projectDir: string | undefined;

function main(): void {
  const rawArgs = process.argv.slice(2);

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
      default:
        error(`Unknown subcommand: ${subcommand}. Valid: decision, answer`);
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
  main();
}
