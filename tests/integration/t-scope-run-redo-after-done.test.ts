// covers: function:jumpIsPersonsMove, function:turnKeptSinceFinished, function:standingPersonTurn, hook:aidlc-plan-approval-guard, hook:aidlc-record-human-turn, scope:bugfix
//
// #3608, driven with no model through the real engine and hooks
// (tests/harness/scope-run.ts): a bugfix with the stages after Code Generation
// skipped runs to done, so the work finishes at Code Generation. The person
// then asks in their own words to redo it. The jump `next --stage` names goes
// through the plan-approval guard, the code plan is asked about once, and the
// redone build runs to its gate and back to done, with no refusal on the way;
// a file the person asks for after the finish is written. Work built Unit by
// Unit keeps a Unit's reopen waiting there: that reopen leaves the work
// finished, so letting it through would record a reopen that runs nothing.

import { afterAll, describe, expect, test } from "bun:test";
import {
  auditEvents,
  cleanupScopeProjects,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
} from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

const SKIP = ["--skip", "build-and-test,deployment-pipeline,deployment-execution"];
// Classic with two Units: the design stages that add no wiring skipped, and Build and Test, so it finishes at Code Generation.
const CLASSIC_SKIP = [
  "--skip", ["practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design", "delivery-planning",
    "nfr-requirements", "nfr-design", "infrastructure-design", "build-and-test"].join(","),
];

describe("a redo of Code Generation after a bugfix finished there", () => {
  test.each(["strict", "off"] as const)("Guard Policy %s: the person's redo runs, its plan is asked once, and the work is done again", (policy) => {
    const run = runScope("bugfix", { flags: [...SKIP, "--guard-policy", policy] });
    const { host, person, agent, proj } = run;
    expect(run.final.kind).toBe("done");
    const finishedRows = auditEvents(proj).filter((row) => row.event === "WORKFLOW_COMPLETED").length;
    host.fullHost = true;
    // A change asked for after the finish goes in as past Code Generation.
    person.say("Add a short note file under src, please.");
    host.write("src/after-done-note.ts", "// A note the person asked for after the work finished.\n");
    expect(agent.next().kind).toBe("done");
    const asked = agent.asked.length;
    const redoFrom = auditEvents(proj).length;
    person.say("Can you redo Code Generation? I'd like the code built again.");
    const print = agent.next("--stage", "code-generation");
    const jump = /`(bun \.claude\/tools\/aidlc-jump\.ts execute [^`]+)`/.exec(String(print.message ?? ""))?.[1];
    expect(jump, JSON.stringify(print)).toContain("--direction redo");
    const ran = host.bash(jump as string);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    const final = agent.drive(agent.next());
    expect(final.kind).toBe("done");
    expect(host.refusals).toEqual([]);
    expect(agent.asked.slice(asked).filter((q) => q.what === "plan approval")).toHaveLength(1);
    const rows = auditEvents(proj);
    expect(rows.slice(redoFrom).filter((row) => row.event === "STAGE_JUMPED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "PLAN_APPROVAL_BLOCKED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "WORKFLOW_COMPLETED").length).toBe(finishedRows + 1);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("Units built one at a time: a Unit's reopen after the finish still waits, and no reopen is recorded", () => {
    const run = runScope("classic", { units: ["core", "extra"], flags: CLASSIC_SKIP });
    const { host, person, agent, proj } = run;
    expect(run.final.kind).toBe("done");
    host.fullHost = true;
    person.say("Redo code generation for the core unit.");
    const print = agent.next("--stage", "code-generation", "--unit", "core");
    const reopen = /`(bun \.claude\/tools\/aidlc-jump\.ts reopen [^`]+)`/.exec(String(print.message ?? ""))?.[1];
    expect(reopen, JSON.stringify(print)).toBeDefined();
    const rejected = auditEvents(proj).filter((row) => row.event === "GATE_REJECTED").length;
    expect(() => host.bash(reopen as string)).toThrow(/the guard refused/);
    expect(auditEvents(proj).filter((row) => row.event === "GATE_REJECTED").length).toBe(rejected);
    expect(agent.next().kind).toBe("done");
  }, SCOPE_RUN_TIMEOUT_MS);
});
