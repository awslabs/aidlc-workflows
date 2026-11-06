// covers: subcommand:aidlc-orchestrate:team-board, function:unitBoardRows, function:teamHomeBoardText, function:unitProgressStanding, function:unitTakeLook, function:checkTeamResults
//
// The board at the lead's project says only what the record says (#2410, the
// board). A Unit no team holds reads where it stands in the Unit Progress the
// step derived: done once it is through its gate, waiting for the lead's
// approval while its gate is open (a Unit built before teams were chosen
// too), and waiting only on a Unit that is not done; a Unit named for a team
// that could not be held for them yet is theirs, never the lead's project's.
// A teammate's take offer never names a Unit done on its claim as being built.
// A look at the board (`team-board`) records nothing: a merge it sees that the
// record does not have yet says so, and the next step records it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, REPO_ROOT } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript, type StandInOptions } from "../harness/scope-run.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  codeHost,
  git,
  GIT_ENV,
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  refundsTaken,
  run,
  STATE,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

function teamBoard(dir: string): string {
  const looked = run(ORCH, ["team-board"], dir);
  expect(looked.status, looked.out).toBe(0);
  return looked.out;
}

// The lead's project with its two code repos; with teams chosen, checkout-ui
// is held for web, and refunds and reporting (which waits on refunds) are left
// to the lead's project.
function leadKeepsTwo(teamsFirst = true) {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
  const home = makeHome({ repos: hosts });
  if (teamsFirst) teamsChosen(home.dir);
  return { hosts, home };
}

function teamsChosen(dir: string): void {
  const teams = run(STATE, ["set-unit-ownership", "team"], dir);
  expect(teams.status, teams.out).toBe(0);
  const assigned = run(UNIT, ["assign", "checkout-ui=web"], dir);
  expect(assigned.status, assigned.out).toBe(0);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "teams chosen"]);
  git(dir, ["push", "-q", "origin", "main"]);
}

// The lead's chat at their project, driven by the agent stand-in until `until` picks a step.
function leadsChat(dir: string, options: StandInOptions): Directive {
  cpSync(join(REPO_ROOT, "dist", "claude"), dir, { recursive: true, force: false, errorOnExist: false });
  const host = hostFor("claude", dir, GIT_ENV);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["refunds", "checkout-ui", "reporting"],
    codeRepo: (unit) => [{ repo: unit === "refunds" ? "checkout-api" : "billing" }],
    ...options,
  });
  host.sessionStart("startup");
  person.say("/aidlc");
  return agent.drive(agent.next());
}

const isBoard = (d: Directive): boolean => d.kind === "print" && d.board_note !== undefined;

describe("a Unit the lead's project builds reads where its Unit Progress has it", () => {
  test("built through their gates, refunds and reporting read done, and reporting never waits on refunds", () => {
    const { home } = leadKeepsTwo();
    const end = leadsChat(home.dir, { until: isBoard });
    expect(isBoard(end), JSON.stringify(end)).toBe(true);
    expect(String(end.narration)).toBe([
      "Units of fixture:",
      "- refunds, here: done",
      "- checkout-ui, web: held for web, not taken yet",
      "- reporting, here: done",
    ].join("\n"));
    expect(teamBoard(home.dir)).toContain("- reporting, here: done");
  });

  test("while refunds's gate is open, the board says it waits for the lead's approval, and reporting waits on it", () => {
    const { home } = leadKeepsTwo();
    const gate = leadsChat(home.dir, { until: (d) => d.unit_gate !== undefined && d.unit === "refunds" });
    expect(gate.unit, JSON.stringify(gate)).toBe("refunds");
    const board = teamBoard(home.dir);
    // Approved stage by stage here, so its first stage waits for the lead.
    expect(board).toContain("- refunds, here: waiting for your approval at Functional Design");
    expect(board).toContain("- reporting, here: waits on refunds");
  });

  test("a Unit built before teams were chosen, its gate still open, never reads done", () => {
    const { home } = leadKeepsTwo(false);
    // The solo walk's first Unit, built through its last stage, its checkpoint not yet asked.
    const ask = leadsChat(home.dir, { until: (d) => d.construction_checkpoint !== undefined });
    const built = String((ask.construction_checkpoint as { unit?: string }).unit);
    const other = built === "refunds" ? "checkout-ui" : "refunds";
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const assigned = run(UNIT, ["assign", `${other}=payments`], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    const board = teamBoard(home.dir);
    // Asked once for the whole Unit, as its checkpoint was, though teams approve stage by stage here.
    expect(board).toContain(`- ${built}, here: built, waiting for your approval`);
    expect(board).not.toContain(`- ${built}, here: done`);
  });

  test("a Unit named for a team while it could not be held for them reads as theirs, never as the lead's project's", () => {
    const { home } = leadKeepsTwo(false);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    const kept = run(UNIT, ["assign", "refunds=payments", "--person-words", "payments takes refunds"], home.dir);
    expect(kept.status, kept.out).toBe(0);
    expect(next(home.dir).kind).toBe("print");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
    next(home.dir);
    const board = teamBoard(home.dir);
    expect(board).toContain("- refunds, payments: kept for payments, not held yet");
    expect(board).not.toContain("- refunds, here:");
  });
});

describe("a teammate's take offer", () => {
  test("a fresh clone never names a Unit done on its claim as being built, and what waited on it is ready", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    // The lead's state as last pushed, before this record of the merge.
    const bob = cloneOf(home.remote, "bob");
    const offer = next(bob);
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
    expect(String(offer.question)).not.toContain("Being built: refunds");
    expect(String(offer.question)).toContain("Ready to take: checkout-ui (for web; likely checkout-web), reporting (open; likely billing).");
  });
});

describe("a look at the board records nothing, and says so", () => {
  test("a merge team-board sees is not recorded yet, the next step records it, and the board then reads done", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    expect(teamBoard(home.dir)).toContain(
      "- refunds, payments: checkout-api merged, billing merged (2 of 2 merged), not recorded yet: " +
        "the next step here records it and opens reporting",
    );
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toEqual([]);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).not.toMatchObject({ done: true });
    next(home.dir);
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    const after = teamBoard(home.dir);
    expect(after).toContain("- refunds, payments: done");
    expect(after).not.toContain("not recorded yet");
  });
});
