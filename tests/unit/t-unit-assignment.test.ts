// covers: subcommand:aidlc-unit:assign, subcommand:aidlc-state:set-unit-ownership, audit:UNITS_ASSIGNED, function:homeLocation, function:unitsAssignedSinceTeams
//
// Who builds which Unit (#2410, item 3). Choosing teams records where the home
// is (the workspace's own origin, read only); the home then asks once who
// builds which Unit, and the lead answers in their own words. Each Unit they
// name for a team becomes a claim held for that team, with no scope stamp, so
// the lead's checkout stays the home's; a Unit left out stays open; a Unit held
// by one team is never given to another. The home walks only the Units no team
// holds. One-Unit work is never asked.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  homeState,
  makeHome,
  next,
  run,
  STATE,
  stateOf,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

function chooseTeams(dir: string): void {
  const result = run(STATE, ["set-unit-ownership", "team"], dir);
  expect(result.status, result.out).toBe(0);
}

describe("choosing teams records where the home is", () => {
  test("the workspace's own origin, read and never changed", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(field(stateOf(home.dir), "Home Location")).toBe(home.remote);
    const set = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_OWNERSHIP_SET");
    expect(set.at(-1)?.block).toContain(`**Home Location**: ${home.remote}`);
  });
});

describe("who builds which Unit is asked once, at the home", () => {
  test("the first Construction step after choosing teams is the question", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("unit-assignment");
    expect(ask.response_route).toBe("command");
    expect(ask.question).toBe(
      "Who builds which Unit? refunds (likely checkout-api, billing), checkout-ui (likely checkout-web), " +
        "reporting (likely billing; waits on refunds). Name a team for each, or leave a Unit open for any team to " +
        "take later.",
    );
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Name the teams", "Leave them all open"]);
    expect(choices[0].command).toBeUndefined();
    expect(String(choices[1].command)).toEndWith("aidlc-unit.ts assign --open");
    expect(String(ask.assign_command)).toContain("assign <unit>=<team>");
    expect(String(ask.question_note)).toContain("run assign_command with one <unit>=<team>");
  });

  test("the lead's words become one claim per named Unit, held for that team, and the checkout stays the home's", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    next(home.dir);
    const words = "refunds goes to payments, checkout-ui to web, leave reporting open";
    const assigned = run(UNIT, ["assign", "refunds=payments", "checkout-ui=web", "--person-words", words], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    expect(assigned.json?.notice).toBe(
      "Refunds: payments. Checkout-ui: web. Open for any team: reporting. Each team approves its Unit after every " +
        "stage; to approve once at the end of each Unit, say so before the first Unit is built.",
    );
    const id8 = fixtureIntentId8(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", owner: "payments", assigned: true });
    expect(claimPayload(home.remote, id8, "checkout-ui")).toMatchObject({ status: "claimed", owner: "web", assigned: true });
    expect(claimPayload(home.remote, id8, "reporting")).toBeNull();
    expect(existsSync(join(home.dir, "aidlc", ".aidlc-unit-scope.json"))).toBe(false);
    const rows = readAuditShardEvents(home.dir).filter((row) => row.event === "UNITS_ASSIGNED");
    expect(rows).toHaveLength(1);
    expect(rows[0].block).toContain("**Assigned**: refunds=payments, checkout-ui=web");
    expect(rows[0].block).toContain("**Open**: reporting");
    expect(rows[0].block).toContain(`**Person Words**: ${words}`);
    // Asked once: the next step is not the question again.
    const after = next(home.dir);
    expect(after.ask_type, JSON.stringify(after)).not.toBe("unit-assignment");
  });

  test("a Unit held for one team is never given to another", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    const again = run(UNIT, ["assign", "refunds=web"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain("refunds is held by payments, so it stays with them.");
    // Held, so never listed as open, and the Units nobody holds still are.
    expect(again.json?.open).toEqual(["checkout-ui", "reporting"]);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "payments" });
  });

  test("one Unit named for two teams in the same words is said, not guessed", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const both = run(UNIT, ["assign", "refunds=payments", "refunds=web"], home.dir);
    expect(both.status).not.toBe(0);
    expect(both.out).toContain("refunds can go to one team; you named payments and web.");
  });

  test("leave them all open: no claim, and the answer is recorded", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const open = run(UNIT, ["assign", "--open"], home.dir);
    expect(open.status, open.out).toBe(0);
    expect(open.json?.open).toEqual(["refunds", "checkout-ui", "reporting"]);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toBeNull();
    expect(next(home.dir).ask_type).not.toBe("unit-assignment");
  });
});

describe("the home walks only the Units no team holds", () => {
  test("with refunds and checkout-ui held, reporting waits on refunds, so the home shows the board", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("notice");
  });

  test("an open Unit with nothing to wait on is the home's to build", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "reporting=data"], home.dir).status).toBe(0);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("checkout-ui");
  });
});

describe("work that is never asked", () => {
  test("one-Unit work", () => {
    const home = makeHome({
      dependencies: "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n```\n",
    });
    chooseTeams(home.dir);
    const step = next(home.dir);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("unit-assignment");
  });

  test("team work without a recorded home keeps the flow it started on", () => {
    const home = makeHome({ state: homeState(["- **Unit Ownership**: team"]) });
    const step = next(home.dir);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("unit-assignment");
  });
});
