// covers: scope:classic, function:unitsBlockRepair, audit:REVIEW_REQUESTED
//
// A units block the engine cannot read, in a scope run with no model
// (tests/harness/scope-run.ts). Units Generation's unit-of-work-dependency.md
// is written without its fenced units block, or with one that does not parse,
// or it breaks by hand after the stage was approved. Seen live on Kiro IDE: the
// block was missing, the person approved the stage over it, and Construction
// began with an error that told the person to fix that file. Here the engine
// names the repair to the agent before the review or the gate (or at
// Construction's start, for a later break), the agent writes the block from its
// Units, the person approves Units Generation once, and the run reaches done
// with no error in front of the person.

import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  AgentStandIn,
  activeRecord,
  createScopeProject,
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

const BROKEN = {
  missing: "# Unit Dependencies\n\n## Dependency DAG\n\n- core depends on nothing\n- extra depends on core\n",
  malformed: "# Unit Dependencies\n\n```yaml\nunits:\n  - name: core\n    depends_on: []\n" +
    "  - name: extra\n    depends_on: [missing]\n```\n",
};

function run(label: string, flags: string[], options: {
  write?: string;
  afterApproval?: string;
}) {
  const { proj, host } = createScopeProject("empty");
  projects.push(proj);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["core", "extra"],
    artifactText: (path) =>
      options.write !== undefined && path.endsWith("/unit-of-work-dependency.md") ? options.write : undefined,
    afterApproval: (stage) => {
      if (stage === "units-generation" && options.afterApproval !== undefined) {
        // A hand edit after the approval breaks the block.
        const rel = `${activeRecord(proj).dir.slice(proj.length + 1)}/inception/units-generation/unit-of-work-dependency.md`;
        host.write(rel, options.afterApproval);
      }
      return undefined;
    },
  });
  const first = agent.begin(`build the classic work (${label})`, [
    "--scope", "classic", "--skip", SKIPPED.join(","), "--plan-approval", "on", ...flags,
  ]);
  const final = agent.drive(first);
  return { final, agent, host };
}

describe("a units block the engine cannot read never reaches the person", () => {
  for (const [label, body] of Object.entries(BROKEN)) {
    test(`block ${label}, reviews on: the review request names the repair, and the gate shows a block that reads`, () => {
      const { final, agent, host } = run(label, ["--review", "advisory"], { write: body });
      expect(final.kind).toBe("done");
      expect(agent.unitsBlockRepairs.map((repair) => repair.where)).toEqual(["review"]);
      const approvals = agent.asked.filter((q) => q.what === "approval" && q.stage === "units-generation");
      expect(approvals).toHaveLength(1);
      // The repair came before the person was asked to approve Units Generation.
      const approvalAt = agent.asked.findIndex((q) => q.what === "approval" && q.stage === "units-generation");
      expect(agent.unitsBlockRepairs[0].asked).toBeLessThanOrEqual(approvalAt);
      expect(agent.directives.filter((d) => d.kind === "error")).toEqual([]);
      expect(host.refusals).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);

    test(`block ${label}, reviews off: opening the gate names the repair, and the person approves once`, () => {
      const { final, agent } = run(label, ["--review", "none"], { write: body });
      expect(final.kind).toBe("done");
      expect(agent.unitsBlockRepairs.map((repair) => repair.where)).toEqual(["gate"]);
      const approvals = agent.asked.filter((q) => q.what === "approval" && q.stage === "units-generation");
      expect(approvals).toHaveLength(1);
      expect(agent.directives.filter((d) => d.kind === "error")).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);
  }

  test("a block broken by hand after approval: Construction's next names the repair to the agent", () => {
    const { final, agent } = run("hand edit", ["--review", "advisory"], { afterApproval: BROKEN.missing });
    expect(final.kind).toBe("done");
    expect(agent.unitsBlockRepairs.map((repair) => repair.where)).toEqual(["next"]);
    expect(agent.directives.filter((d) => d.kind === "error")).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);
});
