// covers: scope:classic, audit:GATE_REJECTED, audit:REVIEW_COMPLETED, function:validateReviewAppendix
//
// A person move in a scope run, with no model (tests/harness/scope-run.ts): at
// the classic scope's Requirements Analysis gate the person picks Request
// Changes and says what to change. The agent revises and has the reviewer look
// again. The engine's count of review rounds starts again at 1 after a
// rejection, but nothing the reviewer is given says so, and it writes the round
// it believes, `**Iteration:** 2`. The review file is the request's own, so the
// finished review records on its first dispatch with the request's round: no
// retry, no second reviewer run, and the brief the gate prints never says the
// review did not finish. The person approves and the run reaches done.
//
// The agent is not left to count either. It revises in the same turn and has
// the reviewer look again before it reports revised, with no `next`, so the
// rejection's reply is the step it has: it names the re-review request at the
// pass the review log expects (1, where the agent's own count says 2), and
// that request is taken the first time, with no refusal logged.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  AgentStandIn,
  auditEvents,
  createScopeProject,
  type Directive,
  field,
  PersonScript,
  SCOPE_RUN_TIMEOUT_MS,
} from "../harness/scope-run.ts";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const SKIPPED = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
];
const RA = "requirements-analysis";

/** The person is at the Requirements Analysis gate, before they answer it. */
class AtGate extends Error {}

/** A finished review, in the reviewer template's shape, carrying the round the reviewer wrote. */
function reviewText(reviewer: string, iteration: number): string {
  return `## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Date:** 2026-01-01T00:00:00Z\n` +
    `**Iteration:** ${iteration}\n**Verdict Dictated:** no\n\n### Findings\n\n**Prior findings**\n\n` +
    "| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n" +
    "| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n";
}

/** A classic scope run stopped at the Requirements Analysis gate, before the person answers it. */
function atRequirementsGate() {
  const { proj, host } = createScopeProject("empty");
  projects.push(proj);
  const person = new PersonScript(host);
  let atGate = false;
  const agent = new AgentStandIn(host, person, {
    atGate: (stage) => {
      if (stage === RA && !atGate) {
        atGate = true;
        throw new AtGate();
      }
    },
  });
  const first = agent.begin("build the classic work", ["--scope", "classic", "--skip", SKIPPED.join(",")]);
  try {
    agent.drive(first);
  } catch (error) {
    if (!(error instanceof AtGate)) throw error;
  }
  expect(atGate).toBe(true);
  return { proj, host, person, agent };
}

describe("a review after Request Changes", () => {
  test("after Request Changes, a review whose Iteration line carries the reviewer's own round records on its first dispatch, and the gate never says the review did not finish", () => {
    const { proj, host, person, agent } = atRequirementsGate();
    const directive = agent.directives.findLast((d) => d.stage === RA && typeof d.reviewer === "string") as Directive;
    const reviewer = String(directive.reviewer);
    const requirements = (directive.produces as string[]).find((path) => path.endsWith("requirements.md")) as string;

    // The person asks for a change at the gate, in their own words.
    person.say("Request Changes: add a response-time requirement");
    agent.report(RA, "--result", "rejected", "--user-input", "Request Changes");

    // The agent revises the requirements and has the reviewer look again. The
    // request takes the round the engine counts; the reviewer writes its own.
    host.write(requirements, `${readFileSync(join(proj, requirements), "utf-8")}\n- NFR9: every request answers within 200 ms\n`);
    const review = ["log", "review", "--stage", RA, "--reviewer", reviewer, "--iteration", "1"];
    const request = host.engine(...review);
    expect(request.status, request.stdout + request.stderr).toBe(0);
    const reviewFile = String((JSON.parse(request.stdout) as Directive).reviewFile);
    host.task(reviewer, "Re-review requirements-analysis after the revision (review iteration 2)", () =>
      host.write(reviewFile, reviewText(reviewer, 2)));
    const verdict = host.engine(...review, "--verdict", "READY");
    expect(verdict.status, verdict.stdout + verdict.stderr).toBe(0);

    // One request and one READY completion since the rejection, with the
    // request's round: the reviewer ran once and nothing was retried.
    const rows = auditEvents(proj).filter((row) => field(row.block, "Stage") === RA);
    const since = rows.slice(rows.findIndex((row) => row.event === "GATE_REJECTED") + 1);
    const requested = since.filter((row) => row.event === "REVIEW_REQUESTED");
    expect(requested).toHaveLength(1);
    expect(field(requested[0].block, "Retry")).toBeNull();
    const completed = since.filter((row) => row.event === "REVIEW_COMPLETED");
    expect(completed).toHaveLength(1);
    expect(field(completed[0].block, "Verdict")).toBe("READY");
    expect(field(completed[0].block, "Iteration")).toBe("1");
    expect(field(completed[0].block, "Review Finished")).toBeNull();

    // The step the verdict names: the gate shown again as revised, and the
    // review brief printed for the person.
    const step = String((JSON.parse(verdict.stdout) as { agent_note?: string }).agent_note);
    expect(step).toContain(`report --stage ${RA} --result revised`);
    agent.report(RA, "--result", "revised");
    const briefCommand = /`(bun [^`]*aidlc-review-brief\.ts review [^`]*)`/.exec(step)?.[1];
    expect(briefCommand, step).toBeDefined();
    const brief = host.bash(briefCommand!);
    expect(brief.status, brief.stdout + brief.stderr).toBe(0);
    expect(brief.stdout).not.toContain("did not finish");
    expect(brief.stdout).not.toContain("Request changes and rerun the reviewer");

    // The person approves the revised requirements, and the run goes on to done.
    const final = agent.drive(agent.next());
    expect(final.kind).toBe("done");
    expect(host.refusals).toEqual([]);
    expect(agent.refusalsMet).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("after Request Changes, the rejection's reply names the re-review request at the pass the review log expects, and that request is taken the first time", () => {
    const { proj, host, person, agent } = atRequirementsGate();
    const directive = agent.directives.findLast((d) => d.stage === RA && typeof d.reviewer === "string") as Directive;
    const requirements = (directive.produces as string[]).find((path) => path.endsWith("requirements.md")) as string;
    // Pass 1 was this stage's review before the gate, so an agent counting on
    // would ask for pass 2 next.
    const before = auditEvents(proj).filter((row) => row.event === "REVIEW_REQUESTED" && field(row.block, "Stage") === RA);
    expect(before.map((row) => field(row.block, "Iteration"))).toEqual(["1"]);

    // The person asks for a change; the agent revises in the same turn and
    // has the reviewer look again before it reports revised, with no `next`.
    person.say("Request Changes: add a response-time requirement");
    const rejected = agent.report(RA, "--result", "rejected", "--user-input", "Request Changes");
    const reply = String(rejected.message);
    const command = /`(bun [^`]*aidlc-log\.ts review [^`]*)`/.exec(reply)?.[1];
    expect(command, reply).toBeDefined();
    expect(command).toContain(`--stage ${RA}`);
    expect(command).toContain("--iteration 1");
    host.write(requirements, `${readFileSync(join(proj, requirements), "utf-8")}\n- NFR9: every request answers within 200 ms\n`);
    const request = host.bash(command!);
    expect(request.status, request.stdout + request.stderr).toBe(0);
    const reviewer = String(directive.reviewer);
    host.task(reviewer, "Re-review requirements-analysis after the revision", () =>
      host.write(String((JSON.parse(request.stdout) as Directive).reviewFile), reviewText(reviewer, 1)));
    const verdict = host.engine("log", "review", "--stage", RA, "--reviewer", reviewer, "--iteration", "1", "--verdict", "READY");
    expect(verdict.status, verdict.stdout + verdict.stderr).toBe(0);

    const rows = auditEvents(proj);
    const since = rows.slice(rows.findIndex((row) => row.event === "GATE_REJECTED" && field(row.block, "Stage") === RA) + 1);
    expect(since.length).toBeLessThan(rows.length);
    expect(since.filter((row) => row.event === "ERROR_LOGGED")).toEqual([]);
    const again = since.filter((row) => row.event === "REVIEW_REQUESTED" && field(row.block, "Stage") === RA);
    expect(again.map((row) => field(row.block, "Iteration"))).toEqual(["1"]);

    agent.report(RA, "--result", "revised");
    const final = agent.drive(agent.next());
    expect(final.kind).toBe("done");
    expect(host.refusals).toEqual([]);
    expect(agent.refusalsMet).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);
});
