// covers: function:isolatedRunWithoutWork, function:runRecordDir, function:renderSummaryConfirmationBrief, function:summaryQuestionFiles, function:readSummaryAuthorization, function:writeSummaryAuthorization, function:readReviewRecord, subcommand:aidlc-log:decision, subcommand:aidlc-log:answer, subcommand:aidlc-log:answers, subcommand:aidlc-log:review, hook:aidlc-record-human-turn, hook:aidlc-log-subagent, function:handleSingleReport
//
// A stage the person runs on its own (`/aidlc --stage <slug> --single`, or the
// stage's own command such as /aidlc-requirements-analysis) in a project with
// no work keeps its record in the space's own record, where its start already
// is: the person's answers to its questions, the summary they confirmed and
// its review are recorded there, as the same run records them inside work,
// and the run finishes. Before, every one of them was refused ("No active
// workflow is selected ... Start one by describing what to build"), and a
// stage with the summary confirmation on could never finish. Driven with no
// model through the real engine and hooks (tests/harness/scope-run.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type AuditShardEvent,
  codekbScopeFingerprint,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AgentStandIn,
  cleanupScopeProjects,
  createScopeProject,
  type Directive,
  field,
  PersonScript,
  SCOPE_RUN_TIMEOUT_MS,
  type ScopeHost,
  sourceStages,
} from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

const NO_WORK_RECORD = ["aidlc", "spaces", "default", "intents"];

const questionsText = (stage: string, answer: string, summary?: string): string =>
  `# ${stage} questions\n\n## Question 1\n\nWhich option fits?\n\nA. The first option\nB. The second option\nX. Other (please specify)\n\n[Answer]: ${answer}\n` +
  (summary === undefined
    ? ""
    : `\n## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n- Looks correct\n- Request changes\n\n[Answer]: ${summary}\n`);

const reviewText = (reviewer: string): string =>
  `## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
  "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n" +
  "| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n";

const RE_STORE = [
  "business-overview", "architecture", "code-structure", "api-documentation", "component-inventory",
  "technology-stack", "dependencies", "code-quality-assessment", "reverse-engineering-timestamp",
];

/** A code knowledge base for the project's source that matches the code (CURRENT), as a first scan leaves it. */
function writeCurrentStore(proj: string): string {
  const repo = basename(proj);
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "app.ts"), "export const current = true;\n");
  const fingerprint = codekbScopeFingerprint(proj, ["src"], ["aidlc"]);
  if (!fingerprint) throw new Error("could not mint the code knowledge base fingerprint");
  const dir = join(proj, "aidlc", "spaces", "default", "codekb", repo);
  mkdirSync(dir, { recursive: true });
  for (const name of RE_STORE) writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
  writeFileSync(
    join(dir, "reverse-engineering-timestamp.md"),
    "# Reverse Engineering Timestamp\n\n## Scope of Analysis\n\n```yaml\nscope_version: 1\nkind: partial\nintent: fixture\n" +
      `fingerprint: ${fingerprint}\nanalyzed:\n  paths:\n    - src\n  components: []\nshallow:\n  paths: []\n` + "```\n",
  );
  return `aidlc/spaces/default/codekb/${repo}/`;
}

interface Isolated {
  /** Every engine command the run took that was refused, with what it said. */
  refused: string[];
  done: Record<string, unknown> | null;
  /** The record's rows from the isolated start on: the event, marked `*` when it names the isolated run. */
  rows: string[];
  events: AuditShardEvent[];
}

interface Run {
  proj: string;
  host: ScopeHost;
  person: PersonScript;
  agent: AgentStandIn;
}

/** A project with no work, or with work running at its first stage. */
function project(work: "none" | "running", shape: "code" | "empty" = "code", scope = "enterprise"): Run {
  const { proj, host } = createScopeProject(shape);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person);
  if (work === "running") agent.begin("build a todo app", ["--scope", scope]);
  else host.sessionStart("startup");
  return { proj, host, person, agent };
}

function rowsFrom(proj: string, stage: string): { rows: string[]; events: AuditShardEvent[] } {
  const events = readAuditShardEvents(proj).sort((a, b) =>
    a.timestamp === b.timestamp ? a.shardIndex - b.shardIndex || a.pos - b.pos : a.timestamp < b.timestamp ? -1 : 1);
  const start = events.findIndex((e) => e.event === "STAGE_STARTED" && field(e.block, "Workflow") === `single-stage:${stage}`);
  const own = start < 0 ? [] : events.slice(start);
  return { rows: own.map((e) => (field(e.block, "Workflow") ? `${e.event}*` : e.event)), events: own };
}

/** The isolated run as the skill's single-runner branch does it, the person answering each question. */
function isolatedRun(run: Run, stage: string, scope = "enterprise", words: string[] = []): Isolated {
  const { proj, host, person, agent } = run;
  const refused: string[] = [];
  const engine = (...args: string[]): Record<string, unknown> => {
    const res = host.engine(...args);
    let out: Record<string, unknown> = {};
    try {
      out = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch {
      out = {};
    }
    if (res.status !== 0 || out.kind === "error") refused.push(`${args.slice(0, 2).join(" ")}: ${res.stdout}${res.stderr}`.trim());
    return out;
  };
  const store = stage === "reverse-engineering" ? writeCurrentStore(proj) : null;
  person.say(`/aidlc --scope ${scope} --stage ${stage} --single${words.length ? ` ${words.join(" ")}` : ""}`);
  const d: Directive = agent.next("--scope", scope, "--stage", stage, "--single", ...words);
  expect(d.kind, JSON.stringify(d)).toBe("run-stage");
  expect(d.single).toBe(true);
  const produces = ((d.produces as string[] | undefined) ?? []).map((p) => p.replace("{unit-name}", "core"));
  const source = sourceStages().find((s) => s.slug === stage);
  const listed = produces.find((p) => p.endsWith(`${stage}-questions.md`));
  const questions = listed ?? (source?.summaryConfirmation && produces[0] ? `${dirname(produces[0])}/${stage}-questions.md` : undefined);
  if (store !== null) {
    // Reverse Engineering's own question on a second scan of a current store.
    const question = `An up-to-date code knowledge base exists for ${basename(proj)}. Reuse it, or rescan?`;
    const options = ["Reuse existing knowledge base", "Full rescan", "Focused scan"];
    engine("log", "decision", "--stage", stage, "--decision", question, "--options", options.join(","));
    person.pick(question, options, options[0]);
    engine("log", "answer", "--stage", stage, "--details", options[0]);
    engine("state", "reuse-artifact", stage, "--decision", "keep", "--artifacts", store, "--single");
  } else if (questions) {
    host.write(questions, questionsText(stage, ""));
    engine("log", "decision", "--stage", stage, "--decision", "How would you like to answer the questions?",
      "--options", "Guide me,I'll edit the file,Chat");
    person.say("guide me");
    engine("log", "answer", "--stage", stage, "--details", "Guide me");
    engine("log", "decision", "--stage", stage, "--decision", "Question 1", "--options", "A,B,X");
    person.say("A");
    host.write(questions, questionsText(stage, "A"));
    engine("log", "answer", "--stage", stage, "--details", "A");
    if ((d.ceremony as Record<string, string> | undefined)?.summary_confirmation === "on" && source?.summaryConfirmation) {
      host.write(questions, questionsText(stage, "A", ""));
      // The brief the summary protocol shows before it asks.
      engine("review-brief", "summary", "--stage", stage, "--questions-file", questions);
      engine("log", "decision", "--stage", stage, "--single", "--checkpoint", "summary-confirmation",
        "--questions-file", questions, "--decision", "Does this all look correct before I generate the artifact?",
        "--options", "Looks correct,Request changes");
      person.say("looks correct");
      host.write(questions, questionsText(stage, "A", "Looks correct"));
      engine("log", "answer", "--stage", stage, "--single", "--checkpoint", "summary-confirmation",
        "--questions-file", questions, "--details", "Looks correct");
    }
  }
  if (store === null) {
    const write = () => {
      for (const p of produces) {
        if (p !== questions && !existsSync(join(proj, p))) host.write(p, `# ${basename(p)}\n\n## Overview\n\nWritten by the isolated run.\n`);
      }
    };
    if (d.mode === "subagent") host.task(String(d.lead_agent), `Run ${stage}`, write);
    else write();
    for (const agentName of (d.support_agents as string[] | undefined) ?? []) {
      if ((d.mode === "subagent" || d.mode === "mob") && produces[0]) {
        host.task(agentName, `Contribute to ${stage}`, () =>
          host.write(`${dirname(produces[0])}/contributions/${agentName}.md`,
            `**Collaborator:** ${agentName}\n\n## Contribution\n\n- Nothing to add.\n\n## Positions\n\nNone\n`));
      }
    }
  }
  if (typeof d.reviewer === "string") {
    const reviewer = d.reviewer;
    const request = engine("log", "review", "--single", "--stage", stage, "--reviewer", reviewer, "--iteration", "1");
    if (typeof request.reviewFile === "string") {
      host.task(reviewer, `Review ${stage}`, () => host.write(String(request.reviewFile), reviewText(reviewer)));
      engine("log", "review", "--single", "--stage", stage, "--reviewer", reviewer, "--iteration", "1", "--verdict", "READY");
    }
  }
  const done = engine("orchestrate", "report", "--single", "--stage", stage, "--result", "completed");
  return { refused, done: done.kind === undefined ? null : done, ...rowsFrom(proj, stage) };
}

// A file the run inside work writes for the first time, the run with no work may write again: one count.
const tally = (rows: string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row === "ARTIFACT_CREATED" ? "ARTIFACT_UPDATED" : row;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

function leavesNoWork(proj: string): void {
  expect(existsSync(join(proj, ...NO_WORK_RECORD, "aidlc-state.md"))).toBe(false);
  expect(existsSync(join(proj, ...NO_WORK_RECORD, "intents.json"))).toBe(false);
}

describe("a stage run on its own in a project with no work", () => {
  test("Reverse Engineering's own question is recorded beside the run's start, and the run finishes", () => {
    const noWork = project("none");
    const run = isolatedRun(noWork, "reverse-engineering");
    expect(run.refused).toEqual([]);
    expect(run.done?.kind, JSON.stringify(run.done)).toBe("done");
    expect(run.rows).toEqual([
      "STAGE_STARTED*", "DECISION_RECORDED", "HUMAN_TURN", "QUESTION_REPLIED", "QUESTION_ANSWERED",
      "ARTIFACT_REUSED*", "STAGE_COMPLETED*",
    ]);
    const answered = run.events.find((e) => e.event === "QUESTION_ANSWERED");
    expect(field(answered?.block ?? "", "Details")).toBe("Reuse existing knowledge base");
    leavesNoWork(noWork.proj);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("Requirements Analysis with the summary confirmation on records every answer, the summary and the review, as inside work", () => {
    const inside = isolatedRun(project("running", "code", "feature"), "requirements-analysis", "feature");
    const noWork = project("none", "code", "feature");
    const run = isolatedRun(noWork, "requirements-analysis", "feature");
    expect(run.refused).toEqual([]);
    expect(run.done?.kind, JSON.stringify(run.done)).toBe("done");
    expect(run.rows).toContain("SUMMARY_CONFIRMATION_RECORDED*");
    expect(run.rows).toContain("REVIEW_COMPLETED*");
    // The reviewer's own row, with the digest of the review it left.
    const subagent = run.events.find((e) => e.event === "SUBAGENT_COMPLETED");
    expect(field(subagent?.block ?? "", "Review File Digest")).not.toBeNull();
    expect(tally(run.rows)).toEqual(tally(inside.rows));
    leavesNoWork(noWork.proj);
  }, SCOPE_RUN_TIMEOUT_MS);

  // One stage of each other kind the isolated run allows: an ideation stage
  // with a review, a subagent stage, a mob stage, a per-Unit Construction
  // stage, and Requirements Analysis in a project with no code.
  for (const [stage, shape] of [
    ["intent-capture", "code"],
    ["practices-discovery", "code"],
    ["user-stories", "code"],
    ["functional-design", "code"],
    ["requirements-analysis", "empty"],
  ] as const) {
    test(`${stage}${shape === "empty" ? " in a project with no code" : ""} records and finishes as inside work`, () => {
      const inside = isolatedRun(project("running", shape), stage);
      const noWork = project("none", shape);
      const run = isolatedRun(noWork, stage);
      expect(run.refused).toEqual([]);
      expect(run.done?.kind, JSON.stringify(run.done)).toBe("done");
      expect(tally(run.rows)).toEqual(tally(inside.rows));
      leavesNoWork(noWork.proj);
    }, SCOPE_RUN_TIMEOUT_MS);
  }

  test("a question and an answer the agent writes to a file, for words a shell would read, are read from the run's record", () => {
    const noWork = project("none");
    const { host, person, agent } = noWork;
    person.say("/aidlc --scope enterprise --stage market-research --single");
    expect(agent.next("--scope", "enterprise", "--stage", "market-research", "--single").kind).toBe("run-stage");
    const question = "Which market first, the 'home' one or $ABROAD?";
    host.write([...NO_WORK_RECORD, ".aidlc-engine", "answer-text", "question.txt"].join("/"), `${question}\n`);
    const asked = host.engine("log", "decision", "--stage", "market-research", "--decision-file", ".aidlc-engine/answer-text/question.txt", "--options", "A,B,X");
    expect(asked.status, asked.stdout + asked.stderr).toBe(0);
    const decision = rowsFrom(noWork.proj, "market-research").events.find((e) => e.event === "DECISION_RECORDED");
    expect(field(decision?.block ?? "", "Decision")).toBe(question);
    const words = "B, because 'quotes' & $HOME";
    person.say(words);
    host.write([...NO_WORK_RECORD, ".aidlc-engine", "answer-text", "answer.txt"].join("/"), `${words}\n`);
    const answered = host.engine("log", "answer", "--stage", "market-research", "--details-file", ".aidlc-engine/answer-text/answer.txt");
    expect(answered.status, answered.stdout + answered.stderr).toBe(0);
    const row = rowsFrom(noWork.proj, "market-research").events.find((e) => e.event === "QUESTION_ANSWERED");
    expect(field(row?.block ?? "", "Details")).toBe(words);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("after the run finishes, the person's next message is kept as before any work, not as a turn in the run", () => {
    const noWork = project("none");
    const run = isolatedRun(noWork, "market-research");
    expect(run.done?.kind, JSON.stringify(run.done)).toBe("done");
    const before = rowsFrom(noWork.proj, "market-research").rows;
    noWork.person.say("thanks, that's all");
    expect(rowsFrom(noWork.proj, "market-research").rows).toEqual(before);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("a run left open answers nothing in the work the person starts next", () => {
    // The new work's first question, logged and answered with no new reply of
    // the person's: what the engine says is the same whether or not an
    // isolated run was left open before the work began.
    const firstAnswer = (abandoned: boolean): number => {
      const run = project("none");
      if (abandoned) {
        run.person.say("/aidlc --scope feature --stage market-research --single");
        run.agent.next("--scope", "feature", "--stage", "market-research", "--single");
        run.host.engine("log", "decision", "--stage", "market-research", "--decision", "Question 1", "--options", "A,B,X");
        run.person.say("B");
      }
      run.person.say('/aidlc --scope feature "build a due-date feature"');
      const d = run.agent.createFromPrint(run.agent.next("--scope", "feature", "build a due-date feature"));
      expect(d.kind, JSON.stringify(d)).toBe("run-stage");
      const stage = String(d.stage);
      run.host.engine("log", "decision", "--stage", stage, "--decision", "Question 1", "--options", "A,B,X");
      return run.host.engine("log", "answer", "--stage", stage, "--details", "B").status;
    };
    const control = firstAnswer(false);
    expect(control).not.toBe(0);
    expect(firstAnswer(true)).toBe(control);
  }, SCOPE_RUN_TIMEOUT_MS);
});
