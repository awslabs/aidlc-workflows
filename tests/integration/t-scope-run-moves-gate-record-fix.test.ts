// covers: scope:bugfix, hook:aidlc-plan-approval-guard, audit:CHANGE_ACCEPTED
//
// A move in a scope run, with no model (tests/harness/scope-run.ts): at the
// open Code Generation gate the agent fixes its own traceability record after
// the review, then shows the gate again with the gate's own report, the way
// `next` names it. The plan-approval guard holds every Code Generation
// completion while the plan waits; the gate is past that, so the report goes
// through, the gate comes back once, and the person's Approve goes through.
// The host blocks a guard refusal as Claude Code does, and the stand-in follows
// each refusal's named step, so a refusal and `next` naming each other is a
// deadlock here.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentStandIn,
  auditEvents,
  cleanupScopeProjects,
  runScope,
  type ScopeRun,
  scopeRunProblems,
  SCOPE_RUN_TIMEOUT_MS,
} from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

/** The agent's fix to its reviewed traceability record, as the nightly's agent made it. */
function fixTraceability(agent: AgentStandIn): void {
  const step = [...agent.worked].reverse().find((d) => d.stage === "code-generation");
  const trace = ((step?.produces as string[] | undefined) ?? []).find((p) => p.endsWith("traceability.json"));
  if (!trace) agent.fail("Code Generation wrote no traceability.json");
  const record = JSON.parse(readFileSync(join(agent.host.proj, trace), "utf-8")) as Record<string, unknown>;
  agent.host.write(trace, `${JSON.stringify({ ...record, unit: null }, null, 2)}\n`);
}

/** How the agent shows the gate again after its fix. */
const ROUTES = {
  /** It runs the gate's own report again itself. */
  report: (agent: AgentStandIn) => {
    agent.report("code-generation", "--result", "awaiting-approval");
  },
  /** It asks `next` and runs the report the print names. */
  next: (agent: AgentStandIn) => {
    const owed = agent.next();
    if (owed.kind !== "print" || !/report --stage code-generation --result awaiting-approval/.test(String(owed.message))) {
      agent.fail("after the fix, next did not name the gate's own report", owed);
    }
    agent.actOnPrint(owed);
  },
};

/** After the report, `next` shows the gate itself, never the print naming the report again. */
function gateComesBack(agent: AgentStandIn): void {
  const shown = agent.next();
  if (shown.kind !== "run-stage" || shown.gate_only !== true) agent.fail("after the gate's own report, next did not show the gate", shown);
}

function runWithFix(policy: "off" | "relaxed" | "strict", route: keyof typeof ROUTES): ScopeRun {
  let fixed = false;
  return runScope("bugfix", {
    flags: policy === "off" ? [] : ["--guard-policy", policy],
    fullHost: true,
    followRefusals: true,
    atGate: (stage, _unit, agent) => {
      if (stage !== "code-generation" || fixed) return;
      fixed = true;
      fixTraceability(agent);
      ROUTES[route](agent);
      if (policy !== "strict") gateComesBack(agent);
    },
  });
}

describe("the agent fixes its reviewed record at the open Code Generation gate", () => {
  for (const policy of ["off", "relaxed"] as const) {
    for (const route of Object.keys(ROUTES) as Array<keyof typeof ROUTES>) {
      test(`Guard Policy ${policy}, by ${route === "report" ? "the report again" : "next"}: no refusal, the gate comes back once, and Approve goes through`, () => {
        const run = runWithFix(policy, route);
        expect(scopeRunProblems(run, { skip: ["switches"] })).toEqual([]);
        expect(run.agent.refusalsMet.map((r) => r.said.split("\n")[0])).toEqual([]);
        expect(run.agent.asked.filter((a) => a.what === "approval" && a.stage === "code-generation")).toHaveLength(1);
        expect(auditEvents(run.proj).filter((e) => e.event === "CHANGE_ACCEPTED")).toHaveLength(1);
      }, SCOPE_RUN_TIMEOUT_MS);
    }
  }

  // Under strict the old review no longer covers the changed record: the
  // gate's report hands the one recovery review, the agent's own work, and the
  // gate comes back after it.
  test("Guard Policy strict, by the report again: no guard refusal, one recovery review, and Approve goes through", () => {
    const run = runWithFix("strict", "report");
    expect(scopeRunProblems(run, { skip: ["switches"] })).toEqual([]);
    expect(run.agent.refusalsMet.map((r) => r.took)).toEqual(["remedy start-recovery-review"]);
    expect(run.agent.asked.filter((a) => a.what === "approval" && a.stage === "code-generation")).toHaveLength(1);
    expect(auditEvents(run.proj).filter((e) => e.event === "CHANGE_ACCEPTED")).toHaveLength(0);
  }, SCOPE_RUN_TIMEOUT_MS);
});
