// covers: subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:status, subcommand:aidlc-orchestrate:next, audit:SCOPE_CHANGED
//
// One count for the plan after a switch, in scope runs with no model
// (tests/harness/scope-run.ts). The person switches plans once Requirements
// Analysis is approved, to a plan that runs a stage before where the work
// stands (refactor's Functional Design, poc's Intent Capture): it never runs
// unless they go back to it, so the switch line leaves it out. The audit row,
// the next stage's "(stage n of m)", the progress line after its approval and
// status's Completion say the line's count too. A stage the work goes back
// to is counted: User Stories added while the work is paused just after
// Requirements Analysis.

import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  type AgentStandIn,
  auditEvents,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  type ScopeRun,
} from "../harness/scope-run.ts";

const runs: ScopeRun[] = [];
afterAll(() => {
  for (const run of runs) cleanupTestProject(run.proj);
});

const SWITCHED = /Switched to [a-z-]+ \([^)]*\): (\d+) stages \((\d+) done\), (\d+) approval gates\./;

for (const [from, shape, to] of [["bugfix", "code", "refactor"], ["express", "empty", "poc"]] as const) {
  describe(`${from} ${shape === "code" ? "on existing code" : "on a new project"}, switched to ${to} after Requirements Analysis`, () => {
    test("the switch line, the row, the next stage, the progress line and status say one count", () => {
      let switched = false;
      // The approval report's own output, as the agent reads it.
      let approvedAfter = null as string | null;
      const run = runScope(from, {
        shape,
        afterApproval: (stage: string, agent: AgentStandIn) => {
          if (switched) {
            approvedAfter ??= agent.host.trace.findLast((l) => l.includes(`report --stage ${stage} --result approved`)) ?? "";
            return undefined;
          }
          if (stage !== "requirements-analysis") return undefined;
          switched = true;
          const answer = agent.personTypes(`/aidlc --scope ${to}`);
          expect(answer.kind).toBe("print");
          if (agent.actOnPrint(answer)) return agent.personTypes("/aidlc");
          return undefined;
        },
        until: () => approvedAfter !== null,
      });
      runs.push(run);

      const line = run.host.trace.map((l) => SWITCHED.exec(l)).find((m) => m !== null);
      expect(line, run.host.trace.join("\n")).toBeDefined();
      const [, stages, done, gates] = line!;

      const rows = auditEvents(run.proj).filter((e) => e.event === "SCOPE_CHANGED");
      expect(rows).toHaveLength(1);
      expect(field(rows[0].block, "Stages in Scope")).toBe(stages);
      expect(field(rows[0].block, "Approval Gates")).toBe(gates);

      const at = run.agent.directives.findIndex((d) => d.kind === "run-stage" && d.stage === "code-generation");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(String(run.agent.directives[at].narration)).toContain(`(stage ${Number(done) + 1} of ${stages})`);

      expect(approvedAfter).toContain(
        `Progress: ${Number(done) + 1} of ${stages} stages done.`,
      );
      const status = run.host.bash("bun .claude/tools/aidlc.ts --status");
      expect(status.stdout).toMatch(new RegExp(`Completion: +${Number(done) + 1}/${stages} stages`));
    }, SCOPE_RUN_TIMEOUT_MS);
  });
}

// A stage added just after the work passed it is one the work goes back to,
// so it stays in the count: poc on a new project, Requirements Analysis
// approved and the work paused; in a new chat the person adds User Stories,
// reads status, and picks the work back up.
describe("poc on a new project, User Stories added while the work is paused after Requirements Analysis", () => {
  test("status counts the stage the work goes back to, and that stage's start says the same count", () => {
    let added = false;
    let completion = "";
    let started = null as string | null;
    const run = runScope("poc", {
      shape: "empty",
      afterApproval: (stage: string, agent: AgentStandIn) => {
        if (stage !== "requirements-analysis" || added) return undefined;
        added = true;
        expect(agent.host.engine("orchestrate", "park", "--person-asked").status).toBe(0);
        agent.host.newSession();
        agent.host.typed("add the user stories stage too please");
        const add = agent.host.engine("recompose", "--add", "user-stories", "--reason", "the person asked to add User Stories");
        expect(add.status, add.stdout + add.stderr).toBe(0);
        completion = agent.host.bash("bun .claude/tools/aidlc.ts --status").stdout.match(/Completion: +\d+\/\d+ stages/)?.[0] ?? "";
        const resume = agent.personTypes("/aidlc --resume");
        return agent.actOnPrint(resume) ? agent.next("--resume") : resume;
      },
      until: (d) => {
        if (d.kind === "run-stage" && d.stage === "user-stories") started = String(d.narration ?? "");
        return started !== null;
      },
    });
    runs.push(run);
    // Intent Capture and Requirements Analysis done, of Intent Capture, User
    // Stories, Requirements Analysis, Code Generation and Build and Test.
    expect(completion).toMatch(/Completion: +2\/5 stages/);
    expect(started).toContain("(stage 3 of 5)");
  }, SCOPE_RUN_TIMEOUT_MS);
});
