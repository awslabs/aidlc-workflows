// covers: function:evaluateGuardRefusal, function:checkSummaryConfirmationEvidence,
// function:guardRefusalStreakView, subcommand:aidlc-log:review, hook:aidlc-write-audit-log,
// audit:CHANGE_ACCEPTED
//
// After the person confirms the summary again, an output the agent has not
// saved again since (Requirements Analysis' traceability.json record beside
// requirements.md) is the agent's own step to save, not a question for the
// person. Under Guard Policy strict the review request still refuses with the
// sentence naming the file; the first refusal hands the agent that save, and
// saving it lets the review start. The same refusal again asks the person with
// today's two choices. Several outputs left behind are named in one refusal.
// An output on disk with no recorded write (a shell write)
// is the agent's step too, under strict and off. Relaxed records the change and
// carries on, as before. With a review covering the outputs or one in flight,
// the choices stay as they are. Every write goes through the shipped
// write-audit hook and every person's turn through the shipped human-turn hook.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  auditBlockField,
  evaluateGuardRefusal,
  guardRecoveryAskFromRefusalText,
  readAuditShardEvents,
  setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  recordArtifactWriteViaHook,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const ENGINE = join(AIDLC_SRC, "tools", "aidlc.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const SESSION = "01995000-7a11-7000-8000-000000000961";
// The production guards, so the summary and presence checks run as they do for a person.
const ENV: NodeJS.ProcessEnv = {
  ...testGuardEnvironment(process.env, "production"),
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};
const SAVE_AGAIN = "Save the document again, so its write descends from the current confirmation, then continue.";
const ASKED_AGAIN = "Requirements Analysis still can't go ahead as things stand: which way would you like to go on?";

const dirs: string[] = [];
afterAll(() => {
  while (dirs.length > 0) cleanupTestProject(dirs.pop()!);
});

type Policy = "strict" | "relaxed" | "off";

interface Work {
  proj: string;
  questions: string;
  requirements: string;
  record: string;
}

function work(policy: Policy): Work {
  const proj = createTestProject();
  dirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const statePath = seededStateFile(proj);
  writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), `${policy} (set by you)`));
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  return {
    proj,
    questions: join(dir, `${STAGE}-questions.md`),
    requirements: join(dir, "requirements.md"),
    record: join(dir, "traceability.json"),
  };
}

function tool(path: string, args: string[], proj: string) {
  const result = spawnSync(BUN, [path, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...ENV, CLAUDE_PROJECT_DIR: proj },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// The person's message, as the human-turn hook records it.
function personSays(proj: string, prompt: string): void {
  const said = spawnSync(BUN, [ENGINE, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...ENV, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(said.status, said.stderr).toBe(0);
}

function questionsBody(answer: string, requirement: string): string {
  return [
    "# Requirements Questions", "", "## Q1", "", `- ${requirement}`, "",
    "## Consolidated Summary Confirmation", "", "- Looks correct", "- Request changes", "",
    `[Answer]: ${answer}`, "",
  ].join("\n");
}

/** The summary is shown, the person answers Looks correct, and the receipt is recorded. */
function confirm(w: Work, requirement: string): string {
  writeFileSync(w.questions, questionsBody("", requirement));
  const shown = tool(LOG, [
    "decision", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", w.questions,
    "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes",
  ], w.proj);
  expect(shown.status, shown.stderr).toBe(0);
  personSays(w.proj, "Looks correct");
  writeFileSync(w.questions, questionsBody("Looks correct", requirement));
  const answered = tool(LOG, [
    "answer", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", w.questions,
    "--details", "Looks correct",
  ], w.proj);
  expect(answered.status, answered.stderr).toBe(0);
  const id = (JSON.parse(answered.stdout) as { summary_authorization_id?: string }).summary_authorization_id;
  expect(id).toBeTruthy();
  return id as string;
}

function save(w: Work, file: string, content: string): void {
  writeFileSync(file, content);
  recordArtifactWriteViaHook(w.proj, file, "Write", ENV);
}

const requirementsBody = (line: string) => `# Requirements\n\n- FR1 ${line}\n`;
const recordBody = () => `${JSON.stringify({ stage: STAGE, ids: [{ id: "FR1", kind: "functional" }] }, null, 2)}\n`;

/**
 * Both outputs saved from the first confirmation; the person then confirms
 * changed answers; the agent re-saves requirements.md and not the record.
 */
function recordLeftBehind(policy: Policy): Work {
  const w = work(policy);
  const first = confirm(w, "Keep the login flow.");
  save(w, w.requirements, requirementsBody("Keep the login flow."));
  save(w, w.record, recordBody());
  const second = confirm(w, "Keep the login flow, and it works offline.");
  expect(second).not.toBe(first);
  save(w, w.requirements, requirementsBody("Keep the login flow, and it works offline."));
  return w;
}

function requestReview(w: Work) {
  return tool(LOG, ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"], w.proj);
}

/** The refusal's words and the recovery ask the tool printed with them. */
function refused(result: { status: number; stderr: string }) {
  expect(result.status, result.stderr).not.toBe(0);
  const error = String((JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}") as { error?: string }).error ?? "");
  const ask = guardRecoveryAskFromRefusalText(error);
  expect(ask, error).not.toBeNull();
  return { error, ask: ask! };
}

const opsOf = (ask: { remedies: Array<{ op: string }> }) => ask.remedies.map((remedy) => remedy.op);
const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const recordPath = (w: Work) => relative(w.proj, w.record).replaceAll("\\", "/");

describe("t-summary-resave-is-agent-step: an output not saved again since the new confirmation is the agent's to save", () => {
  test("strict: the first refusal names the record and hands the agent its save, with no question for the person", () => {
    const w = recordLeftBehind("strict");
    const { error, ask } = refused(requestReview(w));
    expect(error).toContain("traceability.json was last saved under a different summary confirmation");
    expect(error).toContain(SAVE_AGAIN);
    expect(ask.reason_codes).toEqual(["SUMMARY_ARTIFACT_UNAUTHORIZED"]);
    expect(ask.agent_work).toBe(true);
    expect(opsOf(ask)).toEqual(["produce-stage-output"]);
    expect(ask.remedies[0]).toMatchObject({ requiresHuman: false, interaction: "external-work" });
    expect(String(ask.remedies[0].action)).toContain(SAVE_AGAIN);
    expect(rows(w.proj, "REVIEW_REQUESTED")).toHaveLength(0);
  });

  test("strict: saving the record again lets the review start", () => {
    const w = recordLeftBehind("strict");
    refused(requestReview(w));
    save(w, w.record, recordBody());
    const started = requestReview(w);
    expect(started.status, started.stderr).toBe(0);
    expect(rows(w.proj, "REVIEW_REQUESTED")).toHaveLength(1);
  });

  test("strict: two outputs left behind are named in one refusal, so one round of saves lets the review start", () => {
    const w = work("strict");
    confirm(w, "Keep the login flow.");
    save(w, w.requirements, requirementsBody("Keep the login flow."));
    save(w, w.record, recordBody());
    confirm(w, "Keep the login flow, and it works offline.");
    const { error, ask } = refused(requestReview(w));
    expect(error).toContain("requirements.md and ");
    expect(error).toContain("traceability.json were last saved under a different summary confirmation");
    expect(error).toContain("Save each of them again, so each write descends from the current confirmation");
    expect(ask.agent_work).toBe(true);
    expect(opsOf(ask)).toEqual(["produce-stage-output"]);
    save(w, w.requirements, requirementsBody("Keep the login flow, and it works offline."));
    save(w, w.record, recordBody());
    const started = requestReview(w);
    expect(started.status, started.stderr).toBe(0);
    expect(rows(w.proj, "REVIEW_REQUESTED")).toHaveLength(1);
  });

  test("strict: the same refusal again, with nothing saved, asks the person with today's two choices", () => {
    const w = recordLeftBehind("strict");
    refused(requestReview(w));
    const { ask } = refused(requestReview(w));
    expect(ask.agent_work).toBeUndefined();
    expect(ask.question).toBe(ASKED_AGAIN);
    expect(ask.remedies.map((remedy) => [remedy.op, remedy.label])).toEqual([
      ["reconfirm-summary", "Confirm the summary again"],
      ["request-changes", "Request Changes"],
    ]);
  });

  for (const policy of ["strict", "off"] as const) {
    test(`${policy}: an output on disk with no recorded write is the agent's to save too`, () => {
      const w = work(policy);
      confirm(w, "Keep the login flow.");
      save(w, w.requirements, requirementsBody("Keep the login flow."));
      // A shell write: the file is there, and no write row says who saved it.
      writeFileSync(w.record, recordBody());
      const { error, ask } = refused(requestReview(w));
      expect(error).toContain("traceability.json has no recorded write");
      expect(ask.agent_work).toBe(true);
      expect(opsOf(ask)).toEqual(["produce-stage-output"]);
      save(w, w.record, recordBody());
      const started = requestReview(w);
      expect(started.status, started.stderr).toBe(0);
    });
  }

  test("relaxed: the change is recorded once, said in one line, and the review starts", () => {
    const w = recordLeftBehind("relaxed");
    const started = requestReview(w);
    expect(started.status, started.stderr).toBe(0);
    expect(rows(w.proj, "REVIEW_REQUESTED")).toHaveLength(1);
    const accepted = rows(w.proj, "CHANGE_ACCEPTED");
    expect(accepted.map((row) => [auditBlockField(row.block, "Checkpoint"), auditBlockField(row.block, "Changed")]))
      .toEqual([["summary-confirmation", recordPath(w)]]);
    expect(`${started.stdout}${started.stderr}`)
      .toContain(`${recordPath(w)} was saved before you confirmed the current summary; carrying on.`);
  });

  test("strict: with the review in flight when the answers change, the choices stay as they are", () => {
    const w = work("strict");
    confirm(w, "Keep the login flow.");
    save(w, w.requirements, requirementsBody("Keep the login flow."));
    save(w, w.record, recordBody());
    const requested = requestReview(w);
    expect(requested.status, requested.stderr).toBe(0);
    confirm(w, "Keep the login flow, and it works offline.");
    const verdict = tool(LOG, ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", "--verdict", "READY"], w.proj);
    const { ask } = refused(verdict);
    expect(ask.reason_codes).toContain("SUMMARY_ARTIFACT_UNAUTHORIZED");
    expect(opsOf(ask)).not.toContain("produce-stage-output");
  });

  // No tool path reaches this refusal while a review still covers the outputs:
  // changed answers change the reviewed questions, so the review no longer
  // covers them. The evaluator is asked directly for that attempt, and for one
  // with a review in flight.
  test("the evaluator: a review covering the outputs, or one in flight, keeps today's choices", () => {
    const base = {
      code: "SUMMARY_ARTIFACT_UNAUTHORIZED",
      blockedAction: "review-request",
      stage: STAGE,
      stateContent: `# AI-DLC State\n- **Scope**: feature\n- [-] ${STAGE} \u2014 EXECUTE\n`,
      invariant: "Generated outputs descend from a current human-backed summary confirmation.",
      userMessage: `this stage's output document traceability.json was last saved before the confirmed answers. ${SAVE_AGAIN}`,
      humanAuthority: { freshTurn: false, unattended: false },
    };
    const covered = evaluateGuardRefusal({
      ...base,
      attempt: { recovery: "available", summaryCoverage: "stale", reviewCoverage: "current", sourceCoverage: "current" },
    });
    expect(covered.remedies.map((remedy) => remedy.op)).not.toContain("produce-stage-output");
    const inFlight = evaluateGuardRefusal({
      ...base,
      attempt: {
        recovery: "available",
        summaryCoverage: "stale",
        reviewCoverage: "missing",
        sourceCoverage: "current",
        pendingReview: { iteration: 1, retryable: false },
      },
    });
    expect(inFlight.remedies.map((remedy) => remedy.op)).not.toContain("produce-stage-output");
  });

  test("the evaluator: with nothing reviewed and nothing in flight, the save is the agent's, in the refusal's words", () => {
    const userMessage = `this stage's output document traceability.json was last saved before the confirmed answers. ${SAVE_AGAIN}`;
    const open = evaluateGuardRefusal({
      code: "SUMMARY_ARTIFACT_UNAUTHORIZED",
      blockedAction: "review-request",
      stage: STAGE,
      stateContent: `# AI-DLC State\n- **Scope**: feature\n- [-] ${STAGE} \u2014 EXECUTE\n`,
      invariant: "Generated outputs descend from a current human-backed summary confirmation.",
      userMessage,
      humanAuthority: { freshTurn: false, unattended: false },
      attempt: { recovery: "available", summaryCoverage: "stale", reviewCoverage: "missing", sourceCoverage: "current" },
    });
    expect(open.remedies[0]).toMatchObject({
      op: "produce-stage-output", action: userMessage, requiresHuman: false, interaction: "external-work",
    });
  });
});
