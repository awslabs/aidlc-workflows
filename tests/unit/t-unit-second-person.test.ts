// covers: subcommand:aidlc-unit:lead-sign-off, subcommand:aidlc-unit:sign-off, function:switchSoloToTeams, function:builtFromAnotherMachine
//
// A second person on solo work, and the lead's sign-off (#2410, item 8). Solo
// work built one Unit at a time from another machine is offered to a teammate
// opening it: take an open Unit as their own, carry on the whole work, or
// follow along. Taking one never writes the home's state: the take goes on the
// claim, and the home's own session switches to teams at its next step,
// keeping everything done and asking nothing again. The lead's sign-off is off
// by default; switched on, a team's result waits for the lead's own word.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, seededStateFile } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  ENV,
  git,
  HOME_RECORD,
  makeHome,
  mergeOnHost,
  next,
  refundsTaken,
  run,
  stateOf,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

// Solo work on machine A, one Unit at a time, refunds under way there (and,
// with `refundsDone`, refunds finished and reporting under way), pushed.
function soloAtA(refundsDone = false) {
  const home = makeHome();
  const row = (event: string, stage: string, unit: string) => appendAuditEntry(event, { Stage: stage, Unit: unit, "Run floor": "0" }, home.dir);
  row("UNIT_STARTED", "functional-design", "refunds");
  if (refundsDone) {
    row("UNIT_COMPLETED", "code-generation", "refunds");
    row("UNIT_STARTED", "functional-design", "reporting");
  }
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "solo work under way"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  return home;
}

describe("a teammate opens solo work built from another machine", () => {
  test("is offered the whole work to carry on, an open Unit to take, or to follow along", () => {
    const home = soloAtA();
    const ask = next(cloneOf(home.remote, "bob"));
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(ask.question).toBe(
      "fixture is being built from another machine, on refunds (Functional Design). Carry on the whole work here, " +
        "take an open Unit as your own, or follow along?",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Carry on fixture here", "Take checkout-ui", "Follow along"]);
    expect(choices[1].command).toEndWith(`take checkout-ui --home ${HOME_RECORD}`);
    expect(choices[2].command).toContain(`status --space default --intent ${HOME_RECORD}`);
  });

  test("the same person on their own second machine is not asked: their work carries on as before", () => {
    const home = soloAtA();
    // The lead's laptop: the same git identity as the one who committed the work.
    const laptop = cloneOf(home.remote, "lead");
    expect(next(laptop).ask_type).not.toBe("unit-take");
    // The machine the work is built on, in a chat with no work selected yet.
    rmSync(join(home.dir, "aidlc", "spaces", "default", "intents", "active-intent"));
    expect(next(home.dir).ask_type).not.toBe("unit-take");
  });

  test("taking it writes nothing of the home's: the take is on the claim, the build in a folder of its own", () => {
    const home = soloAtA();
    const bob = cloneOf(home.remote, "bob");
    const homeStateBefore = readFileSync(seededStateFile(bob), "utf-8");
    const took = run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ space: "default" });
    expect(readFileSync(seededStateFile(bob), "utf-8")).toBe(homeStateBefore);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "bob", taken_by: "bob" });
    const other = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], cloneOf(home.remote, "carol"));
    expect(other.status).not.toBe(0);
    expect(other.out).toContain("refunds is being built on the other machine; take another Unit, or follow along.");
  });

  test("the home's own session switches to teams at its next step, keeps its work, and asks nothing again", () => {
    const home = soloAtA(true);
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const step = next(home.dir);
    expect((step.change_notices ?? []) as string[]).toContain(
      "Your teammate bob took checkout-ui; this session carries on with the rest, one Unit at a time.",
    );
    const state = stateOf(home.dir);
    expect(field(state, "Unit Ownership")).toBe("team");
    expect(field(state, "Home Location")).toBe(home.remote);
    expect(field(state, "Unit Gate Rhythm")).toBe("unit-end");
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged.map((row) => row.block).join("\n")).toContain("**Merged In**: built here before teams");
    // The work goes on with reporting, under way here; nothing is asked again.
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("reporting");
    expect(next(home.dir).ask_type).toBeUndefined();
  });
});

describe("the lead's sign-off", () => {
  test("off by default: a merged Unit is done with no sign-off asked", () => {
    const { home, hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(next(home.dir).ask_type).not.toBe("unit-signoff");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });

  test("on: the result waits for the lead's own word, asked once as it arrives", () => {
    const { home, hosts, alice, record } = refundsTaken();
    const on = run(UNIT, ["lead-sign-off", "on"], home.dir);
    expect(on.status, on.out).toBe(0);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-signoff");
    expect(ask.question).toBe(
      "refunds came back from payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged). Sign it off?",
    );
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const guarded: NodeJS.ProcessEnv = { ...ENV, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "" };
    const unasked = run(UNIT, ["sign-off", "refunds", "--person-words", "sign it off"], home.dir, guarded);
    expect(String(unasked.json?.error)).toBe("The sign-off is the person's own word: ask them first, then run this with their words.");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "let me look at the PRs first" }, home.dir);
    const board = next(home.dir);
    expect(String(board.message)).toContain("- refunds, payments: checkout-api merged, billing merged (2 of 2 merged), waiting for your sign-off");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.done).toBeUndefined();
    expect(run(UNIT, ["sign-off", "refunds", "--person-words", "looks right, sign it off"], home.dir).status).toBe(0);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });
});
