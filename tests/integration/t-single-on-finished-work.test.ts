// covers: function:isolatedRunIsOpen, function:selectedRecordIsFinished, function:hookStandsOutside, function:emitSingleRunStage, function:handleSingleReport, hook:aidlc-record-human-turn, hook:aidlc-write-audit-log, scope:express
//
// A stage the person runs on its own (`--single`) after their work finished is
// live work: their replies answer its questions and it completes, as the same
// run does while the work is still running. Seen on Windows Server with Claude
// Code in a team clone: after express finished, the agent suggested `/aidlc
// --stage deployment-pipeline --single`; every reply to its questions was
// refused as "no new human reply", across two chats and a restart. Driven with
// no model through the real engine and hooks (tests/harness/scope-run.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  activeRecord,
  auditEvents,
  cleanupScopeProjects,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  type ScopeRun,
} from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

const STAGE = "deployment-pipeline";
const REVIEW = "## Review\n\n**Verdict:** READY\n**Reviewer:** REVIEWER\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n" +
  "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n" +
  "| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n";

const questionsText = (answer: string, summary?: string): string =>
  `# ${STAGE} questions\n\n## Question 1\n\nWhich option fits?\n\nA. The first option\nB. The second option\nX. Other (please specify)\n\n[Answer]: ${answer}\n` +
  (summary === undefined
    ? ""
    : `\n## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n- Looks correct\n- Request changes\n\n[Answer]: ${summary}\n`);

interface Isolated {
  answers: Array<{ status: number; out: string }>;
  done: Record<string, unknown> | null;
  rows: string[];
}

/** The isolated run as the skill's single-runner branch does it, and the person's three replies. */
function isolatedRun(run: ScopeRun): Isolated {
  const { host, person, agent } = run;
  person.say(`/aidlc --stage ${STAGE} --single`);
  const d = agent.next("--stage", STAGE, "--single");
  expect(d.kind).toBe("run-stage");
  expect(d.single).toBe(true);
  const produces = (d.produces as string[] | undefined) ?? [];
  const questions = produces.find((p) => p.endsWith(`${STAGE}-questions.md`));
  if (!questions) throw new Error(`${STAGE} names no questions file: ${JSON.stringify(produces)}`);
  const answers: Isolated["answers"] = [];
  const answer = (...args: string[]) => {
    const res = host.engine("log", "answer", "--stage", STAGE, ...args);
    answers.push({ status: res.status, out: `${res.stdout}${res.stderr}`.trim() });
  };
  host.write(questions, questionsText(""));
  agent.must("log", "decision", "--stage", STAGE, "--decision", "How would you like to answer the questions?",
    "--options", "Guide me,I'll edit the file,Chat", "--question-kind", "answer-mode");
  expect(host.stop().blocked).toBe(false);
  person.say("guide me");
  answer("--details", "Guide me");
  agent.must("log", "decision", "--stage", STAGE, "--decision", "Question 1", "--options", "A,B,X");
  person.say("A");
  host.write(questions, questionsText("A"));
  answer("--details", "A");
  host.write(questions, questionsText("A", ""));
  agent.must("log", "decision", "--stage", STAGE, "--single", "--checkpoint", "summary-confirmation",
    "--questions-file", questions, "--decision", "Does this all look correct before I generate the artifact?",
    "--options", "Looks correct,Request changes");
  person.say("looks correct");
  host.write(questions, questionsText("A", "Looks correct"));
  answer("--single", "--checkpoint", "summary-confirmation", "--questions-file", questions, "--details", "Looks correct");
  for (const p of produces) {
    if (p !== questions) host.write(p, `# ${p}\n\n## Overview\n\nWritten by the isolated run.\n`);
  }
  if (typeof d.reviewer === "string") {
    const reviewer = d.reviewer;
    const request = agent.must("log", "review", "--single", "--stage", STAGE, "--reviewer", reviewer, "--iteration", "1");
    host.task(reviewer, `Review ${STAGE}`, () => host.write(String(request.reviewFile), REVIEW.replace("REVIEWER", reviewer)));
    agent.must("log", "review", "--single", "--stage", STAGE, "--reviewer", reviewer, "--iteration", "1", "--verdict", "READY");
  }
  const report = host.engine("orchestrate", "report", "--single", "--stage", STAGE, "--result", "completed");
  let done: Record<string, unknown> | null = null;
  try {
    done = JSON.parse(report.stdout) as Record<string, unknown>;
  } catch {
    done = null;
  }
  expect(host.stop().blocked).toBe(false);
  const events = auditEvents(run.proj);
  const start = events.findIndex((e) => e.event === "STAGE_STARTED" && field(e.block, "Workflow") === `single-stage:${STAGE}`);
  return { answers, done, rows: events.slice(start).map((e) => e.event) };
}

// An artifact the running run writes for the first time, the finished run writes again: one count.
const tally = (rows: string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row === "ARTIFACT_CREATED" ? "ARTIFACT_UPDATED" : row;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

describe("a stage run on its own after the work finished", () => {
  test("records the person's replies and completes, as the same run does while the work runs", () => {
    const running = runScope("express", { until: (d) => d.kind === "run-stage" && d.stage === "build-and-test" });
    const whileRunning = isolatedRun(running);

    const finished = runScope("express");
    expect(finished.final.kind).toBe("done");
    const stateBefore = readFileSync(activeRecord(finished.proj).state, "utf-8");
    expect(stateBefore).toMatch(/^- \*\*Status\*\*: Completed$/m);
    const afterDone = isolatedRun(finished);

    for (const answered of afterDone.answers) expect(answered.status, answered.out).toBe(0);
    expect(afterDone.answers.filter((a) => a.out.includes("no new human reply"))).toEqual([]);
    expect(afterDone.done?.kind, JSON.stringify(afterDone.done)).toBe("done");
    expect(afterDone.rows.filter((row) => row === "HUMAN_TURN")).toHaveLength(3);
    expect(afterDone.rows).not.toContain("ERROR_LOGGED");
    expect(tally(afterDone.rows)).toEqual(tally(whileRunning.rows));
    // The finished work stays finished: the isolated run never touches its state.
    expect(readFileSync(activeRecord(finished.proj).state, "utf-8")).toBe(stateBefore);
  }, SCOPE_RUN_TIMEOUT_MS);
});
