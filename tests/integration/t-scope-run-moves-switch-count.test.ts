// covers: subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:status, subcommand:aidlc-orchestrate:next, audit:SCOPE_CHANGED
//
// One count for the plan after a switch, in scope runs with no model
// (tests/harness/scope-run.ts). The person switches plans once Requirements
// Analysis is approved, to a plan that runs a stage before where the work
// stands (refactor's Functional Design, poc's Intent Capture): it never runs
// unless they go back to it, so the switch line leaves it out. The audit row,
// the next stage's "(stage n of m)", the progress line after its approval and
// status's Completion say the line's count too.

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
