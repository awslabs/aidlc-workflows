// A scope change typed part way through Construction, driven with no model
// (tests/harness/scope-run.ts). The seed is classic with Units alpha and beta
// built one at a time: alpha is approved at its checkpoint, and beta's NFR
// Design question (or its checkpoint question) is open when the person types
// `/aidlc --scope <scope>`.
// switchAndFinish makes the change, carries the run on to done, and checks
// what every such run must show: the switch went through with no refusal,
// alpha's work is never started or asked about again, and both Units'
// Functional Design is still on disk.

import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeRecord,
  type AgentStandIn,
  auditEvents,
  type Directive,
  field,
  type PersonAnswers,
  runScope,
  type ScopeRun,
  ScopeRunStuck,
  type ScopeRunOptions,
} from "./scope-run.ts";

/** Thrown where the person speaks instead of answering: carries the run. */
class Pause extends ScopeRunStuck {}

/** Where the person is when they type the new scope: beta's NFR Design question, or beta's checkpoint question. */
export type SwitchPoint = "beta-nfr-design" | "beta-checkpoint";

/** Classic with Units alpha and beta, stopped where the person speaks (alpha approved at its checkpoint). */
export function betaInProgress(flags: string[], answers: Partial<PersonAnswers> = {}, at: SwitchPoint = "beta-nfr-design"): ScopeRun {
  let armed = false;
  let paused = false;
  const options: ScopeRunOptions = {
    units: ["alpha", "beta"],
    flags,
    afterReview: (stage, unit) => {
      if (stage === "nfr-requirements" && unit === "beta") armed = true;
    },
    answers: {
      ...answers,
      questionMode: (stage) => {
        if (at === "beta-nfr-design" && armed && !paused && stage === "nfr-design") {
          paused = true;
          throw new Pause("beta's NFR Design question is open");
        }
        return "Guide me";
      },
      checkpoint: (unit) => {
        if (at === "beta-checkpoint" && unit === "beta" && !paused) {
          paused = true;
          throw new Pause("beta's checkpoint question is open");
        }
        return "Approve";
      },
    },
  };
  try {
    runScope("classic", options);
  } catch (error) {
    if (error instanceof Pause && error.run) return error.run;
    throw error;
  }
  throw new Error("the run reached done without stopping at beta's NFR Design question");
}

/**
 * The person types `/aidlc --scope <scope>`; the agent runs the printed change
 * and says its output. Then the person carries on with `/aidlc`, or, with
 * beta's checkpoint question open, answers it "approve" and the agent records
 * that approval once.
 */
function switchTo(agent: AgentStandIn, scope: string, at: SwitchPoint): { said: string; next: Directive } {
  const typed = agent.personTypes(`/aidlc --scope ${scope}`);
  const command = /`(bun \.claude\/tools\/[^`]+)`/.exec(String(typed.message ?? ""))?.[1];
  expect(command, JSON.stringify(typed)).toBeDefined();
  const ran = agent.host.bash(command!);
  const said = `${ran.stdout}${ran.stderr}`;
  expect(ran.status, said).toBe(0);
  agent.host.stop();
  if (at === "beta-nfr-design") return { said, next: agent.personTypes("/aidlc") };
  agent.person.say("approve");
  agent.must("bolt", "checkpoint", "--action", "approve", "--unit", "beta", "--kind", "unit",
    "--session", agent.host.session, "--user-input", "Approve");
  return { said, next: agent.next() };
}

export interface SwitchedRun {
  run: ScopeRun;
  /** What the scope change printed. */
  said: string;
  /** The audit rows, questions and stage work from the switch on. */
  rows: ReturnType<typeof auditEvents>;
  asked: ScopeRun["agent"]["asked"];
  worked: Directive[];
  /** What the engine printed for each command the agent ran from the switch on. */
  printed: string[];
}

export function switchAndFinish(
  scope: string,
  flags: string[],
  answers: Partial<PersonAnswers> = {},
  at: SwitchPoint = "beta-nfr-design",
): SwitchedRun {
  const run = betaInProgress(flags, answers, at);
  const from = auditEvents(run.proj).length;
  const askedFrom = run.agent.asked.length;
  const workedFrom = run.agent.worked.length;
  const printed: string[] = [];
  const host = run.agent.host as unknown as { bash: (line: string) => { stdout: string } };
  const bash = host.bash.bind(host);
  host.bash = (line) => {
    const ran = bash(line);
    printed.push(ran.stdout);
    return ran;
  };
  const { said, next } = switchTo(run.agent, scope, at);
  const final = run.agent.drive(next);
  expect(final.kind).toBe("done");
  expect(final.workflow_continues === true).toBe(false);
  expect(run.agent.refusalsMet).toEqual([]);
  const state = readFileSync(activeRecord(run.proj).state, "utf-8");
  expect(state).toContain(`- **Scope**: ${scope}`);
  expect(state).toContain("- **Status**: Completed");
  const rows = auditEvents(run.proj).slice(from);
  const asked = run.agent.asked.slice(askedFrom);
  // alpha's approved work is never started again, nor asked about again.
  const restarted = rows.filter((e) =>
    (e.event === "UNIT_STARTED" || e.event === "STAGE_JUMPED") && field(e.block, "Unit") === "alpha");
  expect(restarted.map((e) => `${e.event} ${field(e.block, "Stage")}`)).toEqual([]);
  expect(asked.filter((q) => q.unit === "alpha")).toEqual([]);
  expect(asked.filter((q) => q.what === "guard recovery")).toEqual([]);
  // Both Units' Functional Design is still on disk.
  const { space, intent } = activeRecord(run.proj);
  for (const unit of ["alpha", "beta"]) {
    expect(existsSync(join(run.proj, "aidlc", "spaces", space, "intents", intent, "construction", unit, "functional-design"))).toBe(true);
  }
  return { run, said, rows, asked, worked: run.agent.worked.slice(workedFrom), printed };
}
