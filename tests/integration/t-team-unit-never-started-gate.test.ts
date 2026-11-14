// covers: function:verifyTeamUnitGateEvidence, function:unitReceiptsRequired, subcommand:aidlc-state:unit, audit:UNIT_COMPLETED
//
// A team Unit's step the agent never started is put to the person for approval,
// not for bookkeeping. A live run on Claude Code: the lead's agent built the
// lead's own Unit without `unit start`, the walk took each step as done from its
// documents, and each gate first asked "Mark this Unit finished", four times in
// the run. The start-receipt guard makes the agent start a step whose first
// record comes before its documents; Code Generation's first record is its
// review, after the build, so its gate reads the step the way the walk does.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript } from "../harness/scope-run.ts";
import { cleanupTeamBuild, codeHost, GIT_ENV, homeState, makeHome, run, STATE, UNIT } from "../harness/team-build.ts";

setDefaultTimeout(20 * 60_000);
afterAll(cleanupTeamBuild);

const DEPENDENCIES = "# Unit dependencies\n\n```yaml\nunits:\n  - name: orders-api\n    kind: service\n    repos: [api]\n    depends_on: []\n  - name: report\n    kind: service\n    repos: [data]\n    depends_on: []\n```\n";

// The lead's agent, which never records a Unit's start or completion itself but
// runs a start a refusal names.
class SkipsUnitStart extends AgentStandIn {
  followed: string[] = [];
  override must(...args: string[]): Record<string, unknown> {
    if (args[0] === "state" && args[1] === "unit" && (args[2] === "start" || args[2] === "complete")) return {};
    try {
      return super.must(...args);
    } catch (e) {
      // The agent runs the start a refusal names, then the same command again.
      const said = e instanceof Error ? e.message : String(e);
      const named = /unit start --stage (\S+) --unit ([A-Za-z0-9._-]+)/.exec(said);
      if (!named || !said.includes("has not been started")) throw e;
      this.followed.push(`${args.slice(0, 2).join(" ")} -> start ${named[1]}/${named[2]}`);
      super.must("state", "unit", "start", "--stage", named[1], "--unit", named[2]);
      return super.must(...args);
    }
  }
}

const isBoard = (d: Directive) => d.kind === "print" && String(d.narration ?? "").startsWith("Units of");
const isRecovery = (d: Directive) => d.ask_type === "guard-recovery";

// The lead's project with the orders API built here and the report open for a
// team, approved in the given rhythm.
function leadsOwnUnit(rhythm: "per-stage" | "unit-end") {
  const hosts = { api: codeHost("api"), data: codeHost("data") };
  const state = homeState()
    .replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) (\S+) EXECUTE$/gm, "- [ ] $1 $2 SKIP")
    .replace("- **Construction Checkpoints**: enabled", "- **Construction Checkpoints**: disabled");
  const home = makeHome({ repos: hosts, dependencies: DEPENDENCIES, state });
  cpSync(join(REPO_ROOT, "dist", "claude"), home.dir, { recursive: true, force: false, errorOnExist: false });
  for (const args of [["set-unit-ownership", "team"], ["set-unit-gate-rhythm", rhythm]]) {
    const set = run(STATE, args, home.dir);
    expect(set.status, set.out).toBe(0);
  }
  const assigned = run(UNIT, ["assign", "--here", "orders-api"], home.dir);
  expect(assigned.status, assigned.out).toBe(0);
  const host = hostFor("claude", home.dir, GIT_ENV);
  const person = new PersonScript(host);
  const agent = new SkipsUnitStart(host, person, {
    units: ["orders-api", "report"],
    codeRepo: (unit) => [{ repo: unit === "orders-api" ? "api" : "data" }],
    until: (d: Directive) => isBoard(d) || isRecovery(d),
  });
  host.sessionStart("startup");
  person.say("/aidlc");
  let step = agent.next();
  if (step.ask_type === "team-handover") {
    const later = (step.choices as Array<{ label: string; command: string }>).find((c) => c.label === "Not now")!;
    person.pick(String(step.question), ["Share them with the teams", "Not now"], "Not now");
    expect(host.bash(later.command).status).toBe(0);
    step = agent.next();
  }
  return { home, agent, end: agent.drive(step) };
}

describe("a team Unit's step the agent never started", () => {
  for (const rhythm of ["per-stage", "unit-end"] as const) {
    test(`${rhythm}: each gate is put to the person once, with no bookkeeping question`, () => {
      const { agent, end } = leadsOwnUnit(rhythm);
      expect(isRecovery(end), JSON.stringify(end).slice(0, 800)).toBe(false);
      expect(String(end.narration), JSON.stringify(end).slice(0, 600)).toContain("orders-api, here: done");
      const approvals = agent.asked.filter((a) => a.what === "approval" && a.unit === "orders-api").map((a) => a.stage);
      expect(approvals).toEqual(rhythm === "per-stage" ? ["functional-design", "code-generation"] : ["code-generation"]);
      expect(agent.asked.some((a) => a.what === "guard recovery")).toBe(false);
      expect((agent as SkipsUnitStart).followed).toEqual(["log decision -> start functional-design/orders-api"]);
    });
  }
});
