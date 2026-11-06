// covers: function:jumpIsPersonsMove, function:turnKeptSinceFinished, function:standingPersonTurn, hook:aidlc-plan-approval-guard, hook:aidlc-record-human-turn, scope:bugfix, function:reconstructTimeline, function:changeAsked, function:keptSinceFinished, function:backInFlight, subcommand:aidlc-utility:doctor
//
// #3608, driven with no model through the real engine and hooks
// (tests/harness/scope-run.ts): a bugfix with the stages after Code Generation
// skipped runs to done, so the work finishes at Code Generation. The person
// then asks in their own words to redo it. The jump `next --stage` names goes
// through the plan-approval guard, the code plan is asked about once, and the
// redone build runs to its gate and back to done, with no refusal on the way;
// a file the person asks for after the finish is written. On work built Unit
// by Unit a Unit's redo after the finish runs for that Unit only, doctor reads
// it as a run, and a Unit's change keeps the person's words. While a redo runs
// the work list says the work is in flight.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeRecord,
  auditEvents,
  cleanupScopeProjects,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  ScopeRunRefused,
} from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

// The work's row on the work list (intents.json), which `intent list` and the
// running-work readers show: in flight while a redo runs, complete again at done.
function listed(proj: string): string | undefined {
  const { space, intent } = activeRecord(proj);
  const rows = JSON.parse(readFileSync(join(proj, "aidlc", "spaces", space, "intents", "intents.json"), "utf-8")) as
    Array<{ dirName: string; status: string }>;
  return rows.find((row) => row.dirName === intent)?.status;
}

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
    expect(listed(proj)).toBe("complete");
    const ran = host.bash(jump as string);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(listed(proj), "the redo runs, but the work list says the work is complete").toBe("in-flight");
    const final = agent.drive(agent.next());
    expect(final.kind).toBe("done");
    expect(listed(proj)).toBe("complete");
    expect(host.refusals).toEqual([]);
    expect(agent.asked.slice(asked).filter((q) => q.what === "plan approval")).toHaveLength(1);
    const rows = auditEvents(proj);
    expect(rows.slice(redoFrom).filter((row) => row.event === "STAGE_JUMPED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "PLAN_APPROVAL_BLOCKED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "WORKFLOW_COMPLETED").length).toBe(finishedRows + 1);
  }, SCOPE_RUN_TIMEOUT_MS);

  test.each(["strict", "relaxed", "off"] as const)("Guard Policy %s, Units built one at a time: a Unit's redo after the finish runs for that Unit only, its plan asked once", (policy) => {
    const run = runScope("classic", { units: ["core", "extra"], flags: [...CLASSIC_SKIP, "--guard-policy", policy] });
    const { host, person, agent, proj } = run;
    expect(run.final.kind).toBe("done");
    const finishedRows = auditEvents(proj).filter((row) => row.event === "WORKFLOW_COMPLETED").length;
    host.fullHost = true;
    const print = agent.next("--stage", "code-generation", "--unit", "core");
    const reopen = /`(bun \.claude\/tools\/aidlc-jump\.ts reopen [^`]+)`/.exec(String(print.message ?? ""))?.[1];
    expect(reopen, JSON.stringify(print)).toBeDefined();
    // The agent's own reopen waits for the person, and says so.
    let refused = "";
    try {
      host.bash(reopen as string);
    } catch (error) {
      refused = error instanceof ScopeRunRefused ? error.refusal : String(error);
    }
    expect(refused).toContain("runs once the person asks for it");
    const refusals = host.refusals.length;
    const asked = agent.asked.length;
    person.say("Redo code generation for the core unit.");
    const ran = host.bash(reopen as string);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    // While core redoes its step, the work list says it is in flight, and
    // doctor reads a reopened run, not a lost state write whose fix would end
    // the redo.
    expect(listed(proj), "the redo runs, but the work list says the work is complete").toBe("in-flight");
    const doctor = host.bash("bun .claude/tools/aidlc-utility.ts doctor");
    expect(doctor.stdout, "doctor read the reopen as drift").not.toContain("State/audit drift");
    expect(doctor.stdout).not.toContain("set Status=Completed");
    const final = agent.drive(agent.next());
    expect(final.kind).toBe("done");
    expect(host.refusals.slice(refusals)).toEqual([]);
    expect(listed(proj)).toBe("complete");
    const plans = agent.asked.slice(asked).filter((q) => q.what === "plan approval");
    expect(plans.map((q) => q.unit)).toEqual(["core"]);
    expect(auditEvents(proj).filter((row) => row.event === "WORKFLOW_COMPLETED").length).toBe(finishedRows + 1);
  }, SCOPE_RUN_TIMEOUT_MS);

  // A change the person asks for one Unit after the finish is kept in their
  // own words, every message of theirs since the finish in this chat, with the
  // messages they came in, as a change at a gate is.
  test.each(["strict", "relaxed", "off"] as const)("Guard Policy %s, Units built one at a time: a Unit's change after the finish keeps the person's words", (policy) => {
    const run = runScope("classic", { units: ["core", "extra"], flags: [...CLASSIC_SKIP, "--guard-policy", policy] });
    const { host, person, agent, proj } = run;
    expect(run.final.kind).toBe("done");
    host.fullHost = true;
    const words = "Change the slug code so it keeps its dashes.";
    person.say(words);
    // The agent asks which Unit; the person's answer is the second message, a
    // moment later (the message record keeps whole seconds).
    Bun.sleepSync(1100);
    person.say("core");
    const print = agent.next("--stage", "code-generation", "--unit", "core", "--change");
    const reopen = /`(bun \.claude\/tools\/aidlc-jump\.ts reopen [^`]+--via change[^`]*)`/.exec(String(print.message ?? ""))?.[1];
    expect(reopen, JSON.stringify(print)).toBeDefined();
    const ran = host.bash(reopen as string);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    const change = auditEvents(proj).filter((row) => row.event === "GATE_REJECTED").at(-1);
    // The record keeps a newline in a field as \n, as a gate's Request Changes row does.
    expect(field(change?.block ?? "", "Feedback")).toBe(`${words}\\ncore`);
    expect(field(change?.block ?? "", "Message Id")).not.toBeNull();
    expect((field(change?.block ?? "", "Message Ids") ?? "").split(",")).toHaveLength(2);
    expect(host.refusals).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("Units built one at a time: a redo of every Unit after the finish asks each Unit's plan once", () => {
    const run = runScope("classic", { units: ["core", "extra"], flags: CLASSIC_SKIP });
    const { host, person, agent, proj } = run;
    expect(run.final.kind).toBe("done");
    host.fullHost = true;
    const asked = agent.asked.length;
    person.say("Redo code generation for every unit.");
    const print = agent.next("--stage", "code-generation", "--every-unit");
    const jump = /`(bun \.claude\/tools\/aidlc-jump\.ts (?:reopen|execute) [^`]+)`/.exec(String(print.message ?? ""))?.[1];
    expect(jump, JSON.stringify(print)).toBeDefined();
    const ran = host.bash(jump as string);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(agent.drive(agent.next()).kind).toBe("done");
    expect(host.refusals).toEqual([]);
    const plans = agent.asked.slice(asked).filter((q) => q.what === "plan approval").map((q) => q.unit).sort();
    expect(plans).toEqual(["core", "extra"]);
    expect(auditEvents(proj).filter((row) => row.event === "PLAN_APPROVAL_BLOCKED")).toHaveLength(0);
  }, SCOPE_RUN_TIMEOUT_MS);
});
