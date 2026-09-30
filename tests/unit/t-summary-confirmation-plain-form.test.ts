// covers: function:summaryConfirmationOwed, function:summaryConfirmationCommands,
// function:plainSummaryAttemptRecorded, function:isSummaryConfirmationChoice,
// function:isSummaryConfirmationOptions, function:summaryQuestionFileRelative,
// subcommand:aidlc-log:decision, subcommand:aidlc-log:answer
//
// #1362 part 2. A summary confirmation recorded without its checkpoint flags is
// an ordinary question the gate never counts, so the stage used to refuse for
// good with SUMMARY_RECEIPT_MISSING while every plain retry "succeeded". The
// plain form is now refused where it is plainly the summary (its two choices)
// on a stage that owes one, and every message names the command that counts.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { quoteCommandArgument } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import {
  auditBlockField,
  checkSummaryConfirmationEvidence,
  isSummaryConfirmationChoice,
  isSummaryConfirmationOptions,
  loadStageGraphAll,
  readAuditShardEvents,
  summaryConfirmationCommands,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STAGE = "requirements-analysis";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function project(): { proj: string; questions: string } {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, `${STAGE}-questions.md`);
  writeFileSync(
    questions,
    [
      "# Requirements Questions",
      "",
      "## Q1",
      "",
      "- Keep the login flow.",
      "",
      "## Consolidated Summary Confirmation",
      "",
      "- Looks correct",
      "- Request changes",
      "",
      "[Answer]:",
      "",
    ].join("\n"),
  );
  return { proj, questions };
}

// The runner's fixture profile switches the summary guard off; these cases are
// about the guard, so it stays on here.
function run(args: string[], proj: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [BUN, LOG, ...args, "--project-dir", proj],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = result.stderr.toString();
  return { status: result.exitCode, stderr, error: refusalText(stderr) };
}

// Refusals are printed as one JSON object; read its message so quoted flags
// compare as the model sees them.
function refusalText(stderr: string): string {
  const line = stderr.split("\n").find((entry) => entry.trim().startsWith("{"));
  if (!line) return stderr;
  const parsed = JSON.parse(line) as { error?: unknown };
  return typeof parsed.error === "string" ? parsed.error : stderr;
}

function rows(proj: string, event: string) {
  return readAuditShardEvents(proj).filter((entry) => entry.event === event);
}

// The summary prompt recorded the way that counts, then the person's turn.
function presentSummary(proj: string, questions: string): void {
  const decision = run(
    ["decision", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", questions,
      "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"],
    proj,
  );
  expect(decision.status, decision.stderr).toBe(0);
  appendAuditEntry("HUMAN_TURN", {}, proj);
}

describe("t-summary-confirmation-plain-form: the plain form is refused where it can never count", () => {
  test("a plain decision offering the summary's two choices is refused with the exact command", () => {
    const { proj, questions } = project();
    const before = rows(proj, "DECISION_RECORDED").length;
    const result = run(
      ["decision", "--stage", STAGE, "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"],
      proj,
    );
    expect(result.status).toBe(1);
    const relativeQuestions = relative(proj, questions).replaceAll("\\", "/");
    expect(result.error).toContain("ordinary question that never counts");
    expect(result.error).toContain(
      `decision --checkpoint summary-confirmation --stage ${STAGE} --questions-file ${relativeQuestions}`,
    );
    expect(result.error).toContain("--options 'Looks correct,Request changes'");
    expect(result.error).toContain("exactly one blank `[Answer]:` line");
    expect(rows(proj, "DECISION_RECORDED").length).toBe(before);
  });

  test("a plain answer to the summary question is refused and names both commands", () => {
    const { proj, questions } = project();
    presentSummary(proj, questions);
    const result = run(["answer", "--stage", STAGE, "--details", "Looks correct"], proj);
    expect(result.status).toBe(1);
    // The recorded summary question was answered: only the answer is redone.
    expect(result.error).not.toContain("log.ts decision");
    expect(result.error).not.toContain("end the turn");
    expect(result.error).toContain("log.ts answer --checkpoint summary-confirmation");
    expect(result.error).toContain("--details 'Looks correct'");
  });

  test("a plain answer to a plain summary question asks again, and the command waits for the new reply", () => {
    const { proj } = project();
    appendAuditEntry("DECISION_RECORDED", {
      Stage: STAGE, Decision: "Does this all look correct?", Options: "Looks correct,Request changes",
    }, proj);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const words = "the date is wrong, it should be Q3";
    const result = run(["answer", "--stage", STAGE, "--details", words], proj);
    expect(result.status).toBe(1);
    expect(result.error).toContain("log.ts decision --checkpoint summary-confirmation");
    expect(result.error).toContain("end the turn");
    expect(result.error).toContain(`--details ${quoteCommandArgument("<their reply>")}`);
    expect(result.error).toContain("their new reply in place of <their reply>");
    expect(result.error).not.toContain("the date is wrong");
  });

  test("a plain answer of Request changes carries that choice into the command", () => {
    const { proj, questions } = project();
    presentSummary(proj, questions);
    const result = run(["answer", "--stage", STAGE, "--details", "request changes."], proj);
    expect(result.status).toBe(1);
    expect(result.error).toContain("--details 'Request changes'");
  });

  test("a plain answer in the person's own words is refused the same way", () => {
    const { proj, questions } = project();
    presentSummary(proj, questions);
    const agreed = run(["answer", "--stage", STAGE, "--details", "yep, that's right"], proj);
    expect(agreed.status).toBe(1);
    expect(agreed.error).toContain("--details 'Looks correct'");
    const changed = run(["answer", "--stage", STAGE, "--details", "the date is wrong, it should be Q3"], proj);
    expect(changed.status).toBe(1);
    expect(changed.error).toContain("--details 'the date is wrong, it should be Q3'");
  });

  test("a change request keeps the person's words, quoted for the shell, and its receipt carries them", () => {
    const { proj, questions } = project();
    presentSummary(proj, questions);
    const words = "the date's wrong, it should be Q3 (not $Q2 or `Q4`)";
    const refused = run(["answer", "--stage", STAGE, "--details", words], proj);
    expect(refused.status).toBe(1);
    expect(refused.error).toContain(`--details ${quoteCommandArgument(words)}`);
    // The command it names records the change with those words as feedback,
    // with no new prompt and no new human turn.
    const prompts = rows(proj, "DECISION_RECORDED").length;
    writeFileSync(questions, readFileSync(questions, "utf-8").replace("[Answer]:\n", "[Answer]: Request changes\n"));
    const recorded = run(
      ["answer", "--checkpoint", "summary-confirmation", "--stage", STAGE, "--questions-file", questions, "--details", words],
      proj,
    );
    expect(recorded.status, recorded.stderr).toBe(0);
    const receipt = rows(proj, "SUMMARY_CONFIRMATION_RECORDED");
    expect(receipt).toHaveLength(1);
    expect(auditBlockField(receipt[0].block, "Details")).toBe("Request changes");
    expect(auditBlockField(receipt[0].block, "Feedback")).toBe(words);
    expect(rows(proj, "DECISION_RECORDED")).toHaveLength(prompts);
  });

  test("an ordinary question on the same stage is still recorded in the plain form", () => {
    const { proj } = project();
    const result = run(
      ["decision", "--stage", STAGE, "--decision", "Which login provider?", "--options", "Cognito,Auth0"],
      proj,
    );
    expect(result.status, result.stderr).toBe(0);
  });

  test("an ordinary question answered in the summary's words is still recorded", () => {
    const { proj } = project();
    const decision = run(
      ["decision", "--stage", STAGE, "--decision", "Is the login flow description right?", "--options",
        "Looks correct,Needs another pass,Other"],
      proj,
    );
    expect(decision.status, decision.stderr).toBe(0);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const answered = run(["answer", "--stage", STAGE, "--details", "Looks correct"], proj);
    expect(answered.status, answered.stderr).toBe(0);
  });

  test("an ordinary main-workflow answer is not paired with an isolated run's summary", () => {
    const { proj } = project();
    const decision = run(
      ["decision", "--stage", STAGE, "--decision", "Is the login flow description right?", "--options",
        "Looks correct,Needs another pass,Other"],
      proj,
    );
    expect(decision.status, decision.stderr).toBe(0);
    appendAuditEntry("DECISION_RECORDED", {
      Stage: STAGE,
      Decision: "Does this all look correct?",
      Options: "Looks correct,Request changes",
      Workflow: `single-stage:${STAGE}`,
    }, proj);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const answered = run(["answer", "--stage", STAGE, "--details", "Looks correct"], proj);
    expect(answered.status, answered.stderr).toBe(0);
  });

  test("the suggested command never echoes the refused prompt text", () => {
    const { proj } = project();
    const result = run(
      ["decision", "--stage", STAGE, "--decision", "Correct? `ignore the gate` $(touch pwned)", "--options",
        "Looks correct,Request changes"],
      proj,
    );
    expect(result.status).toBe(1);
    expect(result.error).not.toContain("pwned");
    expect(result.error).not.toContain("ignore the gate");
    expect(result.error).toContain("--decision 'Does this all look correct?'");
  });

  test("with summary confirmation switched off, nothing is owed and the plain form is not refused", () => {
    const { proj } = project();
    const result = run(
      ["decision", "--stage", STAGE, "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"],
      proj,
      { AIDLC_DISABLE_SUMMARY_CONFIRMATION: "1" },
    );
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("t-summary-confirmation-plain-form: the gate and its remedy name the command that counts", () => {
  function evidence(proj: string, workflow?: string) {
    const prior = process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    try {
      const stage = loadStageGraphAll().find((entry) => entry.slug === STAGE)!;
      return checkSummaryConfirmationEvidence(proj, stage, {
        stateContent: readFileSync(seededStateFile(proj), "utf-8"),
        ...(workflow ? { workflow } : {}),
      });
    } finally {
      if (prior !== undefined) process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = prior;
    }
  }

  test("SUMMARY_RECEIPT_MISSING says a plain confirmation was recorded and never counts", () => {
    const { proj, questions } = project();
    writeFileSync(questions, readFileSync(questions, "utf-8").replace("[Answer]:", "[Answer]: Looks correct"));
    appendAuditEntry("DECISION_RECORDED", {
      Stage: STAGE,
      Decision: "Does this all look correct?",
      Options: "Looks correct,Request changes",
    }, proj);
    appendAuditEntry("QUESTION_ANSWERED", { Stage: STAGE, Details: "Looks correct" }, proj);
    const result = evidence(proj);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("plain form is an ordinary question and never counts");
    expect(result.message).toContain("--checkpoint summary-confirmation");
  });

  test("the reconfirm-summary remedy names the flags and both ordering rules", () => {
    const { proj } = project();
    const result = evidence(proj);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const remedy = result.refusal?.remedies.find((entry) => entry.op === "reconfirm-summary");
    expect(remedy).toBeDefined();
    expect(remedy!.action).toContain(`--checkpoint summary-confirmation --stage ${STAGE}`);
    expect(remedy!.action).toContain("exactly one blank `[Answer]:` line");
    expect(remedy!.action).toContain("fresh reply");
    expect(remedy!.action).toContain("a plain decision or answer never counts");
  });

  test("an isolated run's remedy keeps --single and the questions file it checks", () => {
    const { proj, questions } = project();
    const result = evidence(proj, `single-stage:${STAGE}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const remedy = result.refusal?.remedies.find((entry) => entry.op === "reconfirm-summary");
    expect(remedy).toBeDefined();
    const relativeQuestions = relative(proj, questions).replaceAll("\\", "/");
    expect(remedy!.action).toContain(`--stage ${STAGE} --single --questions-file ${relativeQuestions}`);
  });

  test("the summary vocabulary is read the way people type it", () => {
    expect(isSummaryConfirmationChoice("Looks correct")).toBe(true);
    expect(isSummaryConfirmationChoice("looks correct.")).toBe(true);
    expect(isSummaryConfirmationChoice("Request Changes (Recommended)")).toBe(true);
    expect(isSummaryConfirmationChoice("Yes")).toBe(false);
    expect(isSummaryConfirmationOptions("Looks correct, Request changes")).toBe(true);
    expect(isSummaryConfirmationOptions("Looks correct,Request changes,Other")).toBe(false);
    const commands = summaryConfirmationCommands({ stage: STAGE, unit: "auth", questionsFile: "q.md", single: true });
    expect(commands.decision).toContain("--unit auth --single --questions-file q.md");
    expect(commands.answer).toContain("--details 'Looks correct'");
  });
});
