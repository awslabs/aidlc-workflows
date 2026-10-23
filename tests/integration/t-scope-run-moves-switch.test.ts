// covers: scope:poc, scope:express, audit:CEREMONY_SET, audit:SCOPE_CHANGED, audit:WORKFLOW_PARKED, audit:WORKFLOW_UNPARKED
//
// Person moves in a scope run, with no model (tests/harness/scope-run.ts): a
// setting switched mid-run, a scope switched mid-run, summary confirmation
// turned on while a gate waits, and a stop for the day at an open gate then a
// resume in a new chat. Each rule has its owner (t338 and t27 for the switches,
// t-summary-open-gate-switch for the waiting gate, t17 and t114 for park and
// resume); these runs check the wiring across a whole scope.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  type AgentStandIn,
  activeRecord,
  auditEvents,
  type Directive,
  expectedStages,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  recoveryAsk,
  ScopeRunRefused,
  scopeRunProblems,
  type ScopeRun,
} from "../harness/scope-run.ts";

const runs: ScopeRun[] = [];
afterAll(() => {
  for (const run of runs) cleanupTestProject(run.proj);
});

const stateLine = (state: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(state)?.[1]?.trim() ?? null;

/** After Requirements Analysis is approved, the person types `line`; the agent runs the step it names, then the person carries on. */
function typeAfterRequirements(line: string): (stage: string, agent: AgentStandIn) => Directive | undefined {
  let typed = false;
  return (stage, agent) => {
    if (stage !== "requirements-analysis" || typed) return undefined;
    typed = true;
    const answer = agent.personTypes(line);
    expect(answer.kind).toBe("print");
    if (agent.actOnPrint(answer)) return agent.personTypes("/aidlc");
    return undefined;
  };
}

describe("a switch part way through a run", () => {
  test("learnings off after Requirements Analysis: later stages ask no learnings question, and the run reaches done", () => {
    const run = runScope("poc", { afterApproval: typeAfterRequirements("/aidlc --learnings off") });
    runs.push(run);
    expect(run.declared.learnings).toBe(true);
    expect(scopeRunProblems(run, { skip: ["learnings"] })).toEqual([]);
    const events = auditEvents(run.proj);
    const set = events.filter((e) => e.event === "CEREMONY_SET" && field(e.block, "Key") === "learnings");
    expect(set.map((e) => [field(e.block, "Old"), field(e.block, "New")])).toContainEqual(["on", "off"]);
    expect(stateLine(readFileSync(activeRecord(run.proj).state, "utf-8"), "Learnings")).toMatch(/^off \(/);
    const after = run.agent.directives.slice(run.agent.directives.findIndex((d) => d.stage === "code-generation"));
    for (const d of after.filter((d) => d.kind === "run-stage" && d.ceremony)) {
      expect((d.ceremony as Record<string, string>).learnings).toBe("off");
      expect((d.protocol_modules as string[] | undefined) ?? []).not.toContain("learnings");
    }
  }, SCOPE_RUN_TIMEOUT_MS);

  test("scope poc to express after Requirements Analysis: the rest of the run follows express to done", () => {
    const run = runScope("poc", { afterApproval: typeAfterRequirements("/aidlc --scope express") });
    runs.push(run);
    expect(scopeRunProblems(run, {
      stages: expectedStages("express", false),
      ranBefore: ["intent-capture"],
      skip: ["switches"],
    })).toEqual([]);
    const events = auditEvents(run.proj);
    const changed = events.filter((e) => e.event === "SCOPE_CHANGED");
    expect(changed.map((e) => [field(e.block, "Old Scope"), field(e.block, "New Scope")])).toEqual([["poc", "express"]]);
    expect(stateLine(readFileSync(activeRecord(run.proj).state, "utf-8"), "Scope")).toBe("express");
  }, SCOPE_RUN_TIMEOUT_MS);
});

const RA = "requirements-analysis";

interface OpenGateSwitch {
  run: ScopeRun;
  /** The audit rows from the person's change on. */
  rows: ReturnType<typeof auditEvents>;
  /** The questions asked from the person's change on. */
  asked: ScopeRun["agent"]["asked"];
  /** The stages that ran after Requirements Analysis, in order. */
  later: string[];
  /** Each refusal met from the person's change on, with the step taken after it. */
  refused: ScopeRun["agent"]["refusalsMet"];
}

/**
 * `from` runs a stage (Requirements Analysis unless `options.stage` names
 * another) with summary confirmation off, and the person stops for the day at
 * its open gate. In a new chat they type `line`, which turns it on; then they
 * resume. `atGate` acts at the gate shown again, before the person answers it.
 * The run stops when the stage after `options.after` (default 2) later stages
 * starts. `options.flags` are typed with the first request.
 */
function switchAtOpenGate(
  from: string,
  line: string,
  atGate?: (agent: AgentStandIn) => void,
  options: { stage?: string; flags?: string[]; after?: number } = {},
): OpenGateSwitch {
  const gate = options.stage ?? RA;
  const after = options.after ?? 2;
  let resumed = false;
  let acted = atGate === undefined;
  const later: string[] = [];
  const run = runScope(from, {
    flags: options.flags ?? [],
    answers: { stopAt: (stage) => stage === gate },
    pauseAtStop: true,
    until: (d) => {
      if (!resumed) return false;
      if (!acted && d.kind === "run-stage" && d.stage === gate) return true;
      if (d.kind === "run-stage" && d.stage !== gate && !later.includes(String(d.stage))) later.push(String(d.stage));
      return later.length > after;
    },
  });
  runs.push(run);
  const from0 = auditEvents(run.proj).length;
  const askedFrom = run.agent.asked.length;
  run.agent.host.newSession();
  const answer = run.agent.personTypes(line);
  expect(answer.kind).toBe("print");
  run.agent.actOnPrint(answer);
  run.agent.host.stop();
  resumed = true;
  let d = run.agent.resume();
  if (!acted) {
    expect(d.stage).toBe(gate);
    atGate!(run.agent);
    acted = true;
    d = run.agent.drive(run.agent.next());
  }
  expect(later.length, JSON.stringify(d)).toBeGreaterThan(after);
  const asked = run.agent.asked.slice(askedFrom);
  return { run, rows: auditEvents(run.proj).slice(from0), asked, later, refused: run.agent.refusalsMet };
}

const approvals = (rows: OpenGateSwitch["rows"], stage: string) =>
  rows.filter((e) => e.event === "GATE_APPROVED" && field(e.block, "Stage") === stage);
const summaries = (asked: OpenGateSwitch["asked"], stage: string) =>
  asked.filter((q) => q.what === "summary confirmation" && q.stage === stage);

describe("a gate open when summary confirmation turns on", () => {
  test("bugfix to enterprise at the Requirements Analysis gate, then a resume: the Approve goes through, and User Stories asks its summary", () => {
    const { rows, asked, later, refused } = switchAtOpenGate("bugfix", "/aidlc --scope enterprise");
    expect(refused).toEqual([]);
    expect(asked.filter((q) => q.what === "guard recovery")).toEqual([]);
    const set = rows.filter((e) => e.event === "CEREMONY_SET" && field(e.block, "Key") === "summary_confirmation");
    expect(set.map((e) => [field(e.block, "Old"), field(e.block, "New")])).toEqual([["off", "on"]]);
    expect(approvals(rows, RA)).toHaveLength(1);
    expect(summaries(asked, RA)).toEqual([]);
    expect(later[0]).toBe("user-stories");
    expect(summaries(asked, "user-stories")).toHaveLength(1);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("classic with summary confirmation turned on by the person at the open gate (Guard Policy off): the same", () => {
    const { rows, asked, later, refused } = switchAtOpenGate("classic", "/aidlc --summary-confirmation on");
    expect(refused).toEqual([]);
    expect(asked.filter((q) => q.what === "guard recovery")).toEqual([]);
    expect(approvals(rows, RA)).toHaveLength(1);
    expect(summaries(asked, RA)).toEqual([]);
    expect(summaries(asked, later[0])).toHaveLength(1);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("bugfix to enterprise, then an edit at the open gate: the summary is asked once, and the stage's gate comes back and is approved", () => {
    const { rows, asked, later, refused } = switchAtOpenGate("bugfix", "/aidlc --scope enterprise", (agent) => {
      const dir = join(activeRecord(agent.host.proj).dir, "inception", RA);
      const rel = (name: string) => join(dir, name).slice(agent.host.proj.length + 1).replaceAll("\\", "/");
      const requirements = `${readFileSync(join(dir, "requirements.md"), "utf-8")}\n- The login works offline.\n`;
      agent.person.say("the requirements should also say the login works offline");
      agent.host.write(rel("requirements.md"), requirements);
      // The edit came after the stage's review: under strict its Approve
      // first takes the one recovery review, as it does with no switch.
      const stale = approve(agent);
      expect(stale).toContain("ARTIFACT_REVIEW_STALE");
      agent.followRefusal(stale);
      // Then the edit is the stage's revision, made after the switch: its
      // summary is owed, and the person confirms it once.
      const owed = approve(agent);
      const said = (JSON.parse(owed) as { message?: string }).message ?? owed;
      expect(said).toContain("SUMMARY_ANSWER_INVALID");
      expect(recoveryAsk(said)?.remedies).toMatchObject([{ op: "reconfirm-summary" }, { op: "redo-jump" }]);
      agent.askPerson("guard recovery", RA, "Requirements Analysis can't go ahead as things stand", ["reconfirm-summary", "redo-jump"], "reconfirm-summary");
      agent.must("log", "answer", "--stage", RA, "--checkpoint", "guard-recovery", "--details", "reconfirm-summary");
      const questions = rel(`${RA}-questions.md`);
      const answered = readFileSync(join(agent.host.proj, questions), "utf-8");
      const summary = (answer: string) => `${answered}\n## Consolidated Summary Confirmation\n\nDoes this all look correct?\n\n- Looks correct\n- Request changes\n\n[Answer]: ${answer}\n`;
      agent.host.write(questions, summary(""));
      agent.must("log", "decision", "--stage", RA, "--checkpoint", "summary-confirmation", "--questions-file", questions,
        "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes");
      agent.askPerson("summary confirmation", RA, "Does this all look correct?", ["Looks correct", "Request changes"], "Looks correct");
      agent.host.write(questions, summary("Looks correct"));
      agent.must("log", "answer", "--stage", RA, "--checkpoint", "summary-confirmation", "--questions-file", questions,
        "--details", "Looks correct");
      // The agent re-saves the stage's outputs from it, as the remedy says: the document and its record.
      agent.host.write(rel("requirements.md"), requirements);
      agent.host.write(rel("traceability.json"), readFileSync(join(dir, "traceability.json"), "utf-8"));
    });
    // The edit was taken as the stage's revision once, and approved once after it.
    const backfilled = rows.filter((e) => e.event === "GATE_REJECTED" && field(e.block, "Stage") === RA);
    expect(backfilled.map((e) => field(e.block, "Recovered"))).toEqual(["true"]);
    expect(summaries(asked, RA)).toHaveLength(1);
    expect(approvals(rows, RA)).toHaveLength(1);
    expect(refused.map((r) => r.took)).toEqual(["remedy start-recovery-review"]);
    expect(later[0]).toBe("user-stories");
  }, SCOPE_RUN_TIMEOUT_MS);
});

/** The person approves the open gate; what the engine said when it did not record it, else "". */
function approve(agent: AgentStandIn): string {
  agent.askPerson("approval", RA, `${RA} is ready for your review. How would you like to proceed?`,
    ["Approve", "Request Changes"], "Approve");
  try {
    agent.report(RA, "--result", "approved", "--user-input", "Approve");
    return "";
  } catch (error) {
    if (!(error instanceof ScopeRunRefused)) throw error;
    return error.refusal;
  }
}

describe("a per-Unit stage run at stage level, its gate open when summary confirmation turns on", () => {
  // A tailored bugfix plan that adds Functional Design runs it with no Units
  // Generation, so once, at stage level; summary confirmation is off from bugfix.
  const FD = "functional-design";
  for (const [what, line] of [
    ["the person's own summary confirmation on", "/aidlc --summary-confirmation on"],
    ["a switch to refactor", "/aidlc --scope refactor"],
  ] as const) {
    test(`a tailored plan's Functional Design gate, then ${what}: the Approve goes through`, () => {
      const { rows, asked, refused } = switchAtOpenGate("bugfix", line, undefined, { stage: FD, flags: ["--add", FD], after: 0 });
      expect(refused).toEqual([]);
      expect(asked.filter((q) => q.what === "guard recovery")).toEqual([]);
      expect(approvals(rows, FD)).toHaveLength(1);
      expect(summaries(asked, FD)).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);
  }
});

describe("stop for the day and resume", () => {
  test("stopping at the open Build and Test gate, then resuming in a new chat: the same gate waits for the person, once", () => {
    const run = runScope("poc", { answers: { stopAt: (stage) => stage === "build-and-test" } });
    runs.push(run);
    expect(scopeRunProblems(run)).toEqual([]);
    expect(run.agent.parks.map((d) => d.kind)).toEqual(["parked"]);
    const events = auditEvents(run.proj);
    const index = (pred: (e: (typeof events)[number]) => boolean) => events.findIndex(pred);
    const parked = index((e) => e.event === "WORKFLOW_PARKED");
    const unparked = index((e) => e.event === "WORKFLOW_UNPARKED");
    const approvals = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.event === "GATE_APPROVED" && field(e.block, "Stage") === "build-and-test");
    expect(parked).toBeGreaterThan(-1);
    expect(unparked).toBeGreaterThan(parked);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].i).toBeGreaterThan(unparked);
    // The person resumed from a new chat: the turns after the park are its session's.
    const after = events.slice(parked).filter((e) => e.event === "HUMAN_TURN").map((e) => field(e.block, "Session"));
    expect(after.length).toBeGreaterThan(0);
    expect(new Set(after)).toEqual(new Set(["scope-run-session-2"]));
  }, SCOPE_RUN_TIMEOUT_MS);
});
