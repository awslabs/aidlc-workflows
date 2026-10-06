// covers: scope:poc, scope:express, audit:CEREMONY_SET, audit:SCOPE_CHANGED, audit:WORKFLOW_PARKED, audit:WORKFLOW_UNPARKED
//
// Person moves in a scope run, with no model (tests/harness/scope-run.ts): a
// setting switched mid-run, a scope switched mid-run, and a stop for the day at
// an open gate then a resume in a new chat. Each rule has its owner (t338 and
// t27 for the switches, t17 and t114 for park and resume); these runs check the
// wiring across a whole scope, to done.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
