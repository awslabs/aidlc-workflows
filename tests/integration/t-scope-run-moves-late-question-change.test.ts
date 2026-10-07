// covers: scope:classic, audit:GATE_REJECTED
//
// A person move in a scope run, with no model (tests/harness/scope-run.ts):
// Units are built one at a time with Unit checkpoints off, so once both are
// built one late question approves every per-Unit stage together. The person
// answers it with a change for one Unit's stage: "Request changes: in beta's
// NFR design, retry failed calls through a queue. alpha is fine as it is."
// - The agent reopens that stage for that Unit as the person's change
//   (`next --stage nfr-design --unit beta --change`): beta redoes NFR Design
//   and the stages after it, alpha is untouched and asked nothing, and the one
//   late question comes back once, with no second learnings question.
// - An agent that records it as Request Changes for the whole gate is never
//   stranded: the re-shown question asks no second learnings question, and
//   the engine names the report that shows it again.

import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  type AgentStandIn,
  auditEvents,
  type Directive,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  type ScopeRun,
  ScopeRunStuck,
} from "../harness/scope-run.ts";

const runs: ScopeRun[] = [];
afterAll(() => {
  for (const run of runs) cleanupTestProject(run.proj);
});

const UNITS = ["alpha", "beta"];
const SKIPPED = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "nfr-requirements", "infrastructure-design",
];
const WORDS = "Request changes: in beta's NFR design, retry failed calls through a queue. alpha is fine as it is.";

type Policy = "off" | "strict";

class PersonSpeaks extends ScopeRunStuck {}

/** Units built one at a time, checkpoints off, both built: the one late question is open. */
function toLateQuestion(policy: Policy): { run: ScopeRun; late: Directive } {
  let off = false;
  let stopped = false;
  let late: Directive | undefined;
  let run: ScopeRun | undefined;
  let standIn: AgentStandIn | undefined;
  try {
    runScope("classic", {
      units: UNITS,
      flags: ["--skip", SKIPPED.join(","), ...(policy === "strict" ? ["--guard-policy", "strict"] : [])],
      afterApproval: (stage, agent) => {
        standIn = agent;
        if (stage === "units-generation" && !off) {
          off = true;
          agent.person.say("build the Units one at a time, but do not stop after each Unit; I will approve them together at the end");
          const set = agent.host.bash("bun .claude/tools/aidlc-state.ts set-construction-checkpoints disabled");
          if (set.status !== 0) agent.fail(`checkpoints off was refused: ${set.stdout}${set.stderr}`);
        }
        return undefined;
      },
      answers: {
        approve: () => {
          const d = standIn?.directives.at(-1);
          if (!stopped && d?.approve_together) {
            stopped = true;
            late = d;
            throw new PersonSpeaks("the one late question is open");
          }
          return "Approve";
        },
      },
    });
  } catch (error) {
    if (!(error instanceof PersonSpeaks) || !error.run) throw error;
    run = error.run;
  }
  if (!run || !late) throw new Error("the run reached done without the one late question");
  runs.push(run);
  return { run, late };
}

type Marks = { worked: number; asked: number; rows: Set<string> };
const rowKey = (row: { shard: string; pos: number }) => `${row.shard}#${row.pos}`;
const marksOf = (agent: AgentStandIn): Marks => ({
  worked: agent.worked.length, asked: agent.asked.length, rows: new Set(auditEvents(agent.host.proj).map(rowKey)),
});
function after(agent: AgentStandIn, marks: Marks) {
  return {
    worked: agent.worked.slice(marks.worked).map((d) => `${String(d.stage)}/${typeof d.unit === "string" ? d.unit : "-"}`)
      .filter((w) => UNITS.some((unit) => w.endsWith(`/${unit}`))),
    asked: agent.asked.slice(marks.asked).map((q) => `${q.what} at ${q.stage}${q.unit ? ` for ${q.unit}` : ""}`),
    rows: auditEvents(agent.host.proj).filter((row) => !marks.rows.has(rowKey(row))),
  };
}

/** The person types their words at the late question. */
function personAsksForTheChange(agent: AgentStandIn, late: Directive): void {
  const prompt = String((late.approve_together as { prompt?: string }).prompt ?? "");
  agent.askPerson("approval", String(late.stage), prompt, ["Approve", "Request Changes"], WORDS);
}

describe("a change for one Unit's stage at the one late question", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: the change reopens beta's NFR Design only; alpha is asked nothing; the question comes back once`, () => {
      const { run, late } = toLateQuestion(policy);
      const { agent } = run;
      expect(late.stage).toBe("functional-design");
      const marks = marksOf(agent);
      personAsksForTheChange(agent, late);
      const print = agent.next("--stage", "nfr-design", "--unit", "beta", "--change");
      expect(print.kind, JSON.stringify(print)).toBe("print");
      const command = /`(bun \.claude\/tools\/[^`]+)`/.exec(String(print.message))?.[1];
      expect(command, String(print.message)).toContain("reopen --target nfr-design");
      expect(command).toContain("--units beta");
      const ran = agent.host.bash(command!);
      expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      const final = agent.drive(agent.next());
      expect(final.kind).toBe("done");
      const moved = after(agent, marks);
      expect(moved.worked).toEqual(["nfr-design/beta", "code-generation/beta"]);
      expect(moved.asked.filter((q) => q.endsWith(" for alpha"))).toEqual([]);
      // No second learnings question at the late question (Build and Test asks its own).
      expect(moved.asked.filter((q) => q.startsWith("learnings at functional-design"))).toEqual([]);
      // The person's words, not the engine's, are the change on record.
      const reopened = moved.rows.filter((row) => row.event === "GATE_REJECTED" && field(row.block, "Unit") === "beta");
      expect(reopened.map((row) => field(row.block, "Reopen"))).toEqual(["change"]);
      expect(field(reopened[0].block, "Feedback")).toContain("retry failed calls through a queue");
      expect(moved.rows.filter((row) => row.event === "GATE_REJECTED" && field(row.block, "Unit") === "alpha")).toEqual([]);
      // beta's plan, revised for the change: asked once under strict; under off
      // it may be built as revised with no second question.
      const plans = moved.asked.filter((q) => q.startsWith("plan approval"));
      if (policy === "strict") expect(plans).toHaveLength(1);
      else expect(plans.length).toBeLessThanOrEqual(1);
      // The one late question comes back once for the changed work.
      expect(moved.asked.filter((q) => q.startsWith("approval at functional-design"))).toHaveLength(2);
      expect(agent.refusalsMet).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);

    test(`Guard Policy ${policy}: recorded as Request Changes for the whole gate, the question comes back with no dead end and no second learnings question`, () => {
      const { run, late } = toLateQuestion(policy);
      const { agent } = run;
      const marks = marksOf(agent);
      personAsksForTheChange(agent, late);
      agent.report("functional-design", "--result", "rejected", "--user-input", "Request Changes");
      // The change is made in the listed stage it belongs to (its one review
      // pass is spent, so its findings go in the summary).
      agent.followRefusals = true;
      const revised = agent.host.engine("orchestrate", "report", "--stage", "functional-design", "--result", "revised");
      expect(revised.status, revised.stdout + revised.stderr).toBe(0);
      const final = agent.drive(agent.next());
      expect(final.kind).toBe("done");
      const moved = after(agent, marks);
      expect(moved.asked.filter((q) => q.startsWith("learnings at functional-design"))).toEqual([]);
      // Every refusal met on the way named the step that went on.
      for (const refusal of agent.refusalsMet) expect(refusal.took, refusal.said).not.toMatch(/^none/);
    }, SCOPE_RUN_TIMEOUT_MS);
  }
});
