// covers: function:evaluateGuardRefusal, function:guardAttemptState, subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:review, audit:REVIEW_REQUESTED, audit:REVIEW_COMPLETED
//
// A stage reported done before its review was asked for is refused, and the
// first way on is the agent's own: ask for the review. That way on said only
// "Request the next permitted review for the current attempt.", so an agent
// with no reviewer protocol in the chat could not tell how. Seen live on Kiro
// IDE (Workflows off): the agent guessed a report result, then ran the reviewer
// with no request, nothing the engine reads changed, and the repeat refusal put
// "Request Changes" to a person who had done nothing wrong. The way on now names
// the exact request command and the two steps after it, as the verdict's way on
// already does, and the same goes for a pass that has to be asked for again.
//
// Mechanism: pure + cli. The remedy wording is checked on evaluateGuardRefusal;
// the walk drives the real aidlc-orchestrate.ts and aidlc-log.ts against a
// seeded Inception record.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import { evaluateGuardRefusal, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const SLUG = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const REQUEST = "bun .claude/tools/aidlc-log.ts review --stage functional-design --reviewer aidlc-architecture-reviewer-agent --iteration 1 --project-dir /p";

const STATE = [
  "# AI-DLC State Tracking",
  "",
  "## Stage Progress",
  "- [-] functional-design \u2014 EXECUTE",
  "",
].join("\n");

type Remedy = { op: string; action: string; executableNow: boolean; interaction?: string };

function refusalFor(attempt: Record<string, unknown>): { remedies: Remedy[] } {
  return evaluateGuardRefusal({
    code: "REVIEW_EVIDENCE_MISSING",
    blockedAction: "present-approval-gate",
    stage: "functional-design",
    stateContent: STATE,
    invariant: "Reviewer-bearing stages have current terminal review evidence.",
    userMessage: "blocked",
    attempt: {
      recovery: "available",
      summaryCoverage: "current",
      reviewCoverage: "missing",
      sourceCoverage: "current",
      ...attempt,
    },
    humanAuthority: { freshTurn: false, unattended: false },
  } as Parameters<typeof evaluateGuardRefusal>[0]) as unknown as { remedies: Remedy[] };
}

// The steps after the request, as the action says them to the agent.
function expectRequestSteps(action: string, command: string): void {
  expect(action).toContain(`run \`${command}\``);
  // The reviewer runs as its own agent (seen live: "have the reviewer review it"
  // was read as the conductor writing the review in the reviewer's name).
  expect(action).toContain("dispatch the reviewer named in it as a subagent and have it write the `reviewFile`");
  expect(action).toContain("never write it yourself and never stand in for it");
  expect(action).toContain("stage-protocol-reviewer.md");
  expect(action).toContain("`reviewFile`");
  expect(action).toContain("`recordVerdict`");
}

describe("the review request the agent is handed names its command", () => {
  test("a review never asked for: the way on says the exact request and what follows", () => {
    const remedy = refusalFor({ requestReview: REQUEST }).remedies.find((entry) => entry.op === "request-review");
    expect(remedy, "request-review offered").toBeDefined();
    expect(remedy?.action.startsWith("Request the next permitted review for the current attempt")).toBe(true);
    expectRequestSteps(remedy?.action ?? "", REQUEST);
    // Still the agent's own work: no operation, nothing for the person to pick.
    expect(remedy?.interaction).toBe("external-work");
    expect(remedy?.executableNow).toBe(true);
  });

  test("a pass that has to be asked for again: the way on says that pass's exact request", () => {
    const again = REQUEST.replace("--iteration 1", "--iteration 2");
    const remedy = refusalFor({ nextReview: { iteration: 2, request: again } }).remedies
      .find((entry) => entry.op === "request-review");
    expect(remedy?.action.startsWith("Request review iteration 2 against the current artifact and source bytes")).toBe(true);
    expectRequestSteps(remedy?.action ?? "", again);
    expect(remedy?.interaction).toBe("external-work");
  });

  test("with no command known the sentence stays as it was", () => {
    const missing = refusalFor({}).remedies.find((entry) => entry.op === "request-review");
    expect(missing?.action).toBe("Request the next permitted review for the current attempt.");
    const next = refusalFor({ nextReview: { iteration: 2 } }).remedies.find((entry) => entry.op === "request-review");
    expect(next?.action).toBe("Request review iteration 2 against the current artifact and source bytes.");
  });
});

function run(tool: string, args: string[]): { rc: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SKIP_REVIEWER_GATE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  Object.assign(env, {
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
  });
  const r = spawnSync(BUN, [tool, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function lastJson(out: string): Record<string, unknown> {
  const line = out.split("\n").filter((entry) => entry.startsWith("{")).at(-1);
  expect(line, out).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

// `report` as the agent runs it.
const report = (proj: string, args: string[]) => lastJson(run(ORCHESTRATE, ["report", ...args, "--project-dir", proj]).out);

// The command inside the way on's backticks, run as the agent would run it.
function runNamedRequest(action: string): { rc: number; out: string; args: string[] } {
  const command = /run `([^`]+)`/.exec(action)?.[1];
  expect(command, action).toBeDefined();
  const args = (command as string).split(" ");
  const at = args.findIndex((arg) => arg.endsWith("aidlc-log.ts"));
  expect(at, command).toBeGreaterThan(-1);
  return { ...run(LOG, args.slice(at + 1)), args: args.slice(at + 1) };
}

function writeOutputs(proj: string, body = "- A title cannot be blank.\n"): void {
  const dir = join(seededRecordDir(proj), "inception", SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), `# requirements.md\n\n${body}`);
  const questions = join(dir, "requirements-analysis-questions.md");
  if (!existsSync(questions)) writeFileSync(questions, "# requirements-analysis-questions.md\n");
}

function writeReview(proj: string, reviewFile: string, iteration: number): void {
  writeFileSync(
    join(proj, reviewFile),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** ${iteration}\n\n` +
      "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n" +
      "### Summary\n\nReady.\n",
  );
}

function requestReviewOf(directive: Record<string, unknown>): Remedy {
  expect(directive.kind, JSON.stringify(directive)).toBe("ask");
  expect(directive.ask_type).toBe("guard-recovery");
  expect(directive.agent_work, JSON.stringify(directive)).toBe(true);
  const remedy = (directive.remedies as Remedy[]).find((entry) => entry.op === "request-review");
  expect(remedy, JSON.stringify(directive)).toBeDefined();
  return remedy as Remedy;
}

describe("the agent that reports before the review takes the named way on and reaches the gate", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-mid-inception.md");
  });
  afterEach(() => cleanupTestProject(proj));

  test("report first: the named request, the review at its file, the named verdict, then the gate", () => {
    writeOutputs(proj);
    const remedy = requestReviewOf(report(proj, ["--stage", SLUG, "--result", "complete"]));
    expect(remedy.action).toContain(
      `review --stage ${SLUG} --reviewer ${REVIEWER} --iteration 1 --project-dir ${proj}`,
    );
    expectRequestSteps(remedy.action, (/run `([^`]+)`/.exec(remedy.action) ?? [])[1] ?? "");

    const asked = runNamedRequest(remedy.action);
    expect(asked.rc, asked.out).toBe(0);
    const request = lastJson(asked.out) as { reviewFile: string; recordVerdict: string };
    expect(request.recordVerdict).toContain(`--iteration 1 --verdict`);
    writeReview(proj, request.reviewFile, 1);
    const verdict = run(LOG, [...asked.args, "--verdict", "READY"]);
    expect(verdict.rc, verdict.out).toBe(0);
    expect(readAuditShardEvents(proj).filter((row) => row.event === "REVIEW_COMPLETED")).toHaveLength(1);

    const gate = report(proj, ["--stage", SLUG, "--result", "complete"]);
    expect(gate.ask_type, JSON.stringify(gate)).not.toBe("guard-recovery");
    expect(JSON.stringify(gate)).not.toContain("REVIEW_EVIDENCE_MISSING");
  });

  test("a request whose document changed before its verdict: the same pass, asked for again by its named command", () => {
    writeOutputs(proj);
    const first = run(LOG, ["review", "--stage", SLUG, "--reviewer", REVIEWER, "--iteration", "1", "--project-dir", proj]);
    expect(first.rc, first.out).toBe(0);
    writeOutputs(proj, "- A title cannot be blank.\n- A title is at most 80 characters.\n");

    const remedy = requestReviewOf(report(proj, ["--stage", SLUG, "--result", "complete"]));
    expect(remedy.action.startsWith("Request review iteration 1 against the current artifact and source bytes")).toBe(true);
    expect(remedy.action).toContain(
      `review --stage ${SLUG} --reviewer ${REVIEWER} --iteration 1 --project-dir ${proj}`,
    );
    const again = runNamedRequest(remedy.action);
    expect(again.rc, again.out).toBe(0);
    expect(readAuditShardEvents(proj).filter((row) => row.event === "REVIEW_REQUESTED")).toHaveLength(2);
  });
});
