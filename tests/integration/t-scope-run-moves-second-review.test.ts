// covers: scope:classic, audit:REVIEW_REQUESTED
//
// A person move in a scope run, with no model (tests/harness/scope-run.ts): at
// the second Unit's checkpoint the person asks for another review, which the
// stage's one review pass refuses. The way out the refusal offers is a step the
// engine accepts in that state, and the run reaches done. The remedy wording is
// owned by t331; this run checks it against the real engine and hooks.

import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  AgentStandIn,
  commandWords,
  createScopeProject,
  type Directive,
  PersonScript,
  SCOPE_RUN_TIMEOUT_MS,
} from "../harness/scope-run.ts";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const SKIPPED = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
];

/** The person's ask at extra's checkpoint, taken before they answer it. */
class SecondReviewAsked extends Error {}

interface Remedy {
  op: string;
  action: string;
  executableNow: boolean;
}

/** The guard-recovery ask a refusal carries, wherever in its output it sits. */
function refusalRemedies(output: string): Remedy[] {
  for (const line of output.split(/\r?\n/).reverse()) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(start)) as { remedies?: Remedy[]; error?: string };
      if (Array.isArray(parsed.remedies)) return parsed.remedies;
      // The tool prints its refusal as {"error": "<sentence>\n<the ask>"}.
      if (typeof parsed.error === "string") {
        const inner = refusalRemedies(parsed.error);
        if (inner.length > 0) return inner;
      }
    } catch {
      // Not the ask; keep looking.
    }
  }
  return [];
}

describe("a second review the review cap refuses at a Unit's checkpoint", () => {
  for (const policy of ["strict", "relaxed"] as const) {
    test(`Guard Policy ${policy}: the gate the refusal offers is a step the engine takes, and the run reaches done`, () => {
      const { proj, host } = createScopeProject("empty");
      projects.push(proj);
      const person = new PersonScript(host);
      let asked = false;
      const agent = new AgentStandIn(host, person, {
        units: ["core", "extra"],
        answers: {
          checkpoint: (unit, kind) => {
            if (unit === "extra" && kind === "unit" && !asked) {
              asked = true;
              throw new SecondReviewAsked();
            }
            return "Approve";
          },
        },
      });
      const first = agent.begin("build the classic work", [
        "--scope", "classic", "--skip", SKIPPED.join(","),
        "--guard-policy", policy, "--review", "advisory", "--plan-approval", "on",
      ]);
      let reachedCheckpoint = false;
      try {
        agent.drive(first);
      } catch (error) {
        if (!(error instanceof SecondReviewAsked)) throw error;
        reachedCheckpoint = true;
      }
      expect(reachedCheckpoint).toBe(true);

      // The agent asks for another review on its own; the stage allows one
      // pass. (A review the person asks for runs past it: t342.)
      const reviewer = agent.directives.find((d) => d.stage === "code-generation" && typeof d.reviewer === "string")
        ?.reviewer as string;
      expect(reviewer).toBeTruthy();
      const refused = host.engine("log", "review", "--stage", "code-generation", "--reviewer", reviewer,
        "--iteration", "2", "--unit", "extra");
      expect(refused.status).not.toBe(0);
      const remedies = refusalRemedies(refused.stdout + "\n" + refused.stderr);
      const gate = remedies.find((remedy) => remedy.op === "present-approval-gate");
      expect(gate, refused.stdout + refused.stderr).toBeDefined();
      expect(gate!.executableNow).toBe(true);

      // The person picks it, and the agent runs the step it names.
      person.pick("How would you like to go on?", remedies.map((remedy) => remedy.op), "present-approval-gate");
      const named = /`(bun \.claude\/tools\/[^`]+)`/.exec(gate!.action)?.[1];
      expect(named, gate!.action).toBeDefined();
      const words = commandWords(named!);
      expect(words).toContain("next");
      expect(words).not.toContain("report");
      const ran = host.bash(named!);
      expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      const shown = JSON.parse(ran.stdout) as Directive;
      expect(shown.kind, ran.stdout).toBe("run-stage");
      expect((shown.construction_checkpoint as { unit?: string } | undefined)?.unit).toBe("extra");
      expect(host.refusals).toEqual([]);

      // The person approves the checkpoint they are shown again.
      const final = agent.drive(shown);
      expect(final.kind).toBe("done");
    }, SCOPE_RUN_TIMEOUT_MS);
  }
});
