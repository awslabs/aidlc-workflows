// covers: function:checkInLine, function:arrivedAtLastPull, subcommand:aidlc-unit:take, subcommand:aidlc-unit:push
//
// The lines a person meets in a workspace teams share by git (#2410). Carry on
// is offered only for the person's own team's build: another team's is said,
// with who builds it and where, and one pushed waits for its merge (a fresh
// clone, whose team is not known yet, names each team's). The check-in line is
// said once at a stop, at the push and at a Unit's end, never from what git
// status shows (AI-DLC's own audit rows always change aidlc/), and never names
// the person's tool folder. Status says what the last pull brought from the
// other teams.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { arrivedAtLastPull, checkInLine } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  ENV,
  finishBuild,
  git,
  HOME_RECORD,
  makeHome,
  next,
  ORCH,
  refundsTaken,
  run,
  STATE,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const LINE = "Your teammates get where this work stands when you check it in: `git add aidlc`, then commit and push.";
type Choice = { label: string; detail?: string };

// The lead's work with its Units held for two teams, shared.
function homeWithTeams() {
  const home = makeHome();
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "teams"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  return home;
}

// What a person does by hand: commit the team's record and push it.
function checkIn(dir: string, message: string): void {
  git(dir, ["add", "aidlc"]);
  git(dir, ["commit", "-q", "-m", message]);
  git(dir, ["pull", "-q", "--no-rebase", "--no-edit"]);
  git(dir, ["push", "-q", "origin", "HEAD:main"]);
}

const carryOns = (step: Record<string, unknown>): Choice[] =>
  ((step.choices ?? []) as Choice[]).filter((choice) => choice.label.startsWith("Carry on") && !choice.label.endsWith("as the lead"));

describe("Carry on in a shared workspace", () => {
  test("a fresh clone names each team's build; once the team is known, only its own is offered and the other is said", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD, "--team", "payments"], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD, "--team", "web"], bea).status).toBe(0);
    checkIn(bea, "web: checkout-ui started");

    const abe = cloneOf(home.remote, "abe");
    const fresh = next(abe);
    expect(carryOns(fresh), JSON.stringify(fresh)).toEqual([
      expect.objectContaining({ label: "Carry on refunds for the payments team", detail: "ana's build of it, from another computer." }),
      expect.objectContaining({ label: "Carry on checkout-ui for the web team", detail: "bea's build of it, from another computer." }),
    ]);

    const carried = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], abe);
    expect(carried.status, carried.out).toBe(0);
    expect(readFileSync(join(abe, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");
    // Abe's team is known now: the look with nothing of theirs selected.
    writeFileSync(join(abe, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
    const known = next(abe);
    expect(carryOns(known).map((choice) => choice.label), JSON.stringify(known)).toEqual(["Carry on refunds"]);
    expect(carryOns(known)[0].detail).toBe("ana's build of it, from another computer.");
    expect(String(known.question), JSON.stringify(known)).toContain("checkout-ui (being built by bea on another computer)");
  });

  test("a pushed build waits for its merge and is not offered; one the lead turned down is said so and stays its team's to carry on", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    checkIn(alice, "payments: refunds pushed");
    const look = next(cloneOf(home.remote, "abe"));
    expect(carryOns(look).map((choice) => choice.label), JSON.stringify(look)).not.toContain("Carry on refunds for the payments team");
    expect(String(look.question), JSON.stringify(look)).toContain("refunds (pushed, waiting for its merge)");

    // The lead turns it down in billing: it is back with payments.
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"], home.dir);
    expect(down.status, down.out).toBe(0);
    const again = next(cloneOf(home.remote, "abe-again"));
    expect(String(again.question), JSON.stringify(again)).not.toContain("refunds (pushed, waiting for its merge)");
    expect(carryOns(again), JSON.stringify(again)).toEqual([
      expect.objectContaining({ label: "Carry on refunds for the payments team", detail: "alice's build of it, from another computer; turned down in billing, back with payments." }),
    ]);
  });
});

describe("the check-in line", () => {
  test("said at the person's stop, once: a plain look over the parked work does not say it again", () => {
    const { alice } = refundsTaken();
    next(alice);
    const parked = run(ORCH, ["park"], alice);
    expect(parked.status, parked.out).toBe(0);
    expect(String(parked.json?.narration), parked.out).toEndWith(LINE);
    const look = next(alice);
    expect(look.kind, JSON.stringify(look)).toBe("parked");
    expect(JSON.stringify(look)).not.toContain("git add aidlc");
  });

  test("said at the push, last, and never the tool folder", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toEndWith(` ${LINE}`);
    expect(pushed.out).not.toContain("own folder");
  });

  test("said at the build's end when the push was put off, and not on the look after a check-in", () => {
    const { alice, record } = refundsTaken();
    const step = next(alice);
    expect(JSON.stringify(step)).not.toContain("git add aidlc");
    codeGenerated(alice, record);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    expect(next(alice).ask_type).toBe("unit-push");
    expect(run(UNIT, ["push", "--later"], alice).status).toBe(0);
    const end = next(alice);
    expect(end.kind, JSON.stringify(end)).toBe("done");
    expect(String(end.narration)).toEndWith(LINE);
  });

  test("said at the lead's own Build and Test end, with the approval", () => {
    const home = homeWithTeams();
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \[ \] build-and-test /m, "- [?] build-and-test ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test"));
    const approved = run(ORCH, ["report", "--stage", "build-and-test", "--result", "approved", "--user-input", "Approve"], home.dir);
    expect(approved.status, approved.out).toBe(0);
    expect(String(approved.json?.narration), approved.out).toEndWith(LINE);
  });

  test("only for teams across repos with a remote: main's team Units on the workspace's own repo never hear it", () => {
    const { alice } = refundsTaken();
    expect(checkInLine(alice)).toBe(LINE);
    git(alice, ["remote", "remove", "origin"]);
    expect(checkInLine(alice)).toBeNull();
    const onRepo = makeHome({ repos: {} });
    expect(run(STATE, ["set-unit-ownership", "team"], onRepo.dir).status).toBe(0);
    expect(checkInLine(onRepo.dir)).toBeNull();
  });
});

describe("where things stand", () => {
  test("status says what the last pull brought from the other teams", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD, "--team", "payments"], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    expect(arrivedAtLastPull(ana, "payments")).toBeNull();
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD, "--team", "web"], bea).status).toBe(0);
    checkIn(bea, "web: checkout-ui started");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana, "payments")).toBe("the web team's checkout-ui");
    const status = run(UTILITY, ["status"], ana, ENV);
    expect(status.out).toContain("From others:    the web team's checkout-ui (at your last pull)");
  });
});

