// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:assign
//
// A Unit the lead built at their own project before choosing teams is still
// theirs to approve there. A live run on Claude Code: the lead built the
// orders API alone, its checkpoint open, then handed the report Unit to a team;
// their "I approve it" was refused ("requires solo Units"), the board called the
// orders API done, and the agent's way round, main's claim, scoped the lead's
// own project to that Unit and asked to publish it "you approved it" with no
// approval on record.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript } from "../harness/scope-run.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeHost,
  GIT_ENV,
  git,
  HOME_RECORD,
  homeState,
  makeHome,
  run,
  STATE,
  takeIn,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(20 * 60_000);
afterAll(cleanupTeamBuild);

const DEPENDENCIES = "# Unit dependencies\n\n```yaml\nunits:\n  - name: orders-api\n    kind: service\n    repos: [api]\n    depends_on: []\n  - name: report\n    kind: service\n    repos: [data]\n    depends_on: []\n```\n";

// The lead's project, built alone up to the orders API's open checkpoint.
function builtToCheckpoint() {
  const hosts = { api: codeHost("api"), data: codeHost("data") };
  const state = homeState().replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) (\S+) EXECUTE$/gm, "- [ ] $1 $2 SKIP");
  const home = makeHome({ repos: hosts, dependencies: DEPENDENCIES, state });
  cpSync(join(REPO_ROOT, "dist", "claude"), home.dir, { recursive: true, force: false, errorOnExist: false });
  const host = hostFor("claude", home.dir, GIT_ENV);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["orders-api", "report"],
    codeRepo: (unit) => [{ repo: unit === "orders-api" ? "api" : "data" }],
    // The checkpoint, and the home's board once nothing is left to build here.
    until: (d: Directive) => d.construction_checkpoint !== undefined || (d.kind === "print" && String(d.narration ?? "").startsWith("Units of")),
  });
  host.sessionStart("startup");
  person.say("/aidlc");
  const gate = agent.drive(agent.next());
  expect((gate.construction_checkpoint as { unit?: string } | undefined)?.unit, JSON.stringify(gate)).toBe("orders-api");
  return { hosts, home, host, person, agent };
}

// Teams chosen at the lead's project, with the plan as the teams have it:
// committed and pushed.
function teamsChosen(dir: string): void {
  const team = run(STATE, ["set-unit-ownership", "team"], dir);
  expect(team.status, team.out).toBe(0);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "teams chosen"]);
  git(dir, ["push", "-q", "origin", "main"]);
}

function stateOf(dir: string): string {
  const intents = join(dir, "aidlc", "spaces", "default", "intents");
  const record = readdirSync(intents).find((name) => existsSync(join(intents, name, "aidlc-state.md")))!;
  return readFileSync(join(intents, record, "aidlc-state.md"), "utf-8");
}

function auditOf(dir: string): string {
  const intents = join(dir, "aidlc", "spaces", "default", "intents");
  const record = readdirSync(intents).find((name) => existsSync(join(intents, name, "aidlc-state.md")))!;
  const audit = join(intents, record, "audit");
  return readdirSync(audit).filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(audit, name), "utf-8")).join("\n");
}

describe("a Unit built at the lead's project stays the lead's to approve there", () => {
  test("after the report Unit goes to a team, the orders API's open gate is still put to the lead and their approval records", () => {
    const { hosts, home, host, person, agent } = builtToCheckpoint();
    person.say("Let's have teams build the rest; the data team takes the report Unit");
    teamsChosen(home.dir);
    // A data teammate takes the report Unit from the data space.
    const dana = cloneOf(home.remote, "dana");
    cloneCode(hosts.data, dana, "data", "dana");
    const took = takeIn("data", ["report", "--home", HOME_RECORD], dana);
    expect(took.status, took.out).toBe(0);
    let step = agent.next();
    if (step.ask_type === "team-handover") {
      const later = (step.choices as Array<{ label: string; command: string }>).find((c) => c.label === "Not now")!;
      person.pick(String(step.question), ["Share them with the teams", "Not now"], "Not now");
      expect(host.bash(later.command).status).toBe(0);
      step = agent.next();
    }
    // The orders API is not done: its gate is open, and it is the lead's.
    expect(JSON.stringify(step)).not.toContain("here: done");
    expect(step.unit, JSON.stringify(step)).toBe("orders-api");
    // Asked once for the whole Unit, as its checkpoint was.
    expect(step, JSON.stringify(step).slice(0, 400)).toMatchObject({ stage: "code-generation", gate: true, unit_gate: "unit-end" });
    const board = agent.drive(step);
    expect(String(board.narration), JSON.stringify(board).slice(0, 600)).toContain("orders-api, here: done");
    const approvals = auditOf(home.dir).split("\n## ").filter((block) =>
      block.includes("**Event**: GATE_APPROVED") && block.includes("**Unit**: orders-api") && block.includes("**Gate Scope**: unit-end"));
    expect(approvals.length, auditOf(home.dir).slice(-3000)).toBe(1);
  });

  test("main's claim never scopes the lead's project to one of its Units", () => {
    const { home, person } = builtToCheckpoint();
    person.say("Let's have teams build the rest; the data team takes the report Unit");
    teamsChosen(home.dir);
    const claim = run(UNIT, ["claim", "orders-api", "--team", "shop"], home.dir);
    expect(claim.status, claim.out).not.toBe(0);
    expect(existsSync(join(home.dir, "aidlc", ".aidlc-unit-scope.json"))).toBe(false);
    expect(stateOf(home.dir)).not.toContain("Claimed");
  });
});
