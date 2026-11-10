// covers: function:checkInLine, function:arrivedAtLastPull, subcommand:aidlc-unit:take, subcommand:aidlc-unit:push
//
// The lines a person meets in a workspace teams share by git (#2410). Carry on
// is offered only for the person's own take, by their git name, whatever space
// their clone is in: another's build is said, with who builds it and where, and
// carried on only when they ask; one pushed waits for its merge. The check-in
// line is said once at a stop, at the push and at a Unit's end, never from
// what git status shows (AI-DLC's own audit rows always change aidlc/), and
// never names the person's tool folder. Status says what the last pull brought
// from the other teams.

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
  takeIn,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const LINE = "Your teammates get where this work stands when you check it in: `git add aidlc`, then commit and push.";
type Choice = { label: string; detail?: string };

// The lead's work, teams chosen and every Unit open, shared.
function homeWithTeams() {
  const home = makeHome();
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
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
  test("a fresh clone is offered only the builds its own git name took; another's is said with who and where, and carried on when asked", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(takeIn("payments", ["refunds", "--home", HOME_RECORD], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(takeIn("web", ["checkout-ui", "--home", HOME_RECORD], bea).status).toBe(0);
    checkIn(bea, "web: checkout-ui started");

    // Someone who took neither, in the default space: each build is said, nothing is offered to carry on.
    const abe = cloneOf(home.remote, "abe");
    const fresh = next(abe);
    expect(carryOns(fresh), JSON.stringify(fresh)).toEqual([]);
    expect(String(fresh.narration ?? fresh.question), JSON.stringify(fresh)).toContain(
      "Being built: refunds (being built by ana in payments, on another computer), checkout-ui (being built by bea in web, on another computer).",
    );

    // Ana's own second clone, also in the default space: her build is offered, bea's is said.
    const laptop = cloneOf(home.remote, "ana");
    const own = next(laptop);
    expect(carryOns(own), JSON.stringify(own)).toEqual([
      expect.objectContaining({ label: "Carry on refunds", detail: "Your build of it in the payments space, from another computer." }),
    ]);
    expect(String(own.question), JSON.stringify(own)).toContain("checkout-ui (being built by bea in web, on another computer)");
    const mine = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], laptop);
    expect(mine.status, mine.out).toBe(0);
    expect(mine.json?.notice).toBe("Carrying on refunds, your build in the payments space.");
    expect(readFileSync(join(laptop, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");

    // Abe asks to carry on ana's build all the same: it is carried on, said as hers.
    const carried = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], abe);
    expect(carried.status, carried.out).toBe(0);
    expect(carried.json?.notice).toBe("Carrying on refunds, ana's build in the payments space.");
    expect(readFileSync(join(abe, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");
    // With nothing of theirs selected, abe's look still offers neither build.
    writeFileSync(join(abe, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
    const later = next(abe);
    expect(carryOns(later), JSON.stringify(later)).toEqual([]);
  });

  test("a pushed build waits for its merge and is not offered; one the lead turned down is said so and stays its taker's to carry on", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    checkIn(alice, "payments: refunds pushed");
    const look = next(cloneOf(home.remote, "alice"));
    expect(carryOns(look), JSON.stringify(look)).toEqual([]);
    expect(String(look.question), JSON.stringify(look)).toContain("refunds (pushed by alice in payments, waiting for its merge)");

    // The lead turns it down in billing: it is back with alice.
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"], home.dir);
    expect(down.status, down.out).toBe(0);
    const again = next(cloneOf(home.remote, "alice"));
    expect(String(again.question), JSON.stringify(again)).not.toContain("waiting for its merge");
    expect(carryOns(again), JSON.stringify(again)).toEqual([
      expect.objectContaining({
        label: "Carry on refunds",
        detail: "Your build of it in the payments space, from another computer; turned down in billing, back with alice in payments.",
      }),
    ]);
    // Someone else hears where it is, and is not offered it.
    const other = next(cloneOf(home.remote, "abe"));
    expect(carryOns(other), JSON.stringify(other)).toEqual([]);
    expect(String(other.question), JSON.stringify(other)).toContain("refunds (turned down in billing, back with alice in payments)");
  });

  test("a build the lead sent back from Build and Test says it was the lead's Build and Test", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    checkIn(alice, "payments: refunds pushed");
    git(home.dir, ["fetch", "-q", "origin"]);
    const sent = run(UNIT, ["send-back", "refunds", "--person-words", "the refund total is off by one"], home.dir);
    expect(sent.status, sent.out).toBe(0);
    const look = next(cloneOf(home.remote, "alice"));
    expect(carryOns(look), JSON.stringify(look)).toEqual([
      expect.objectContaining({
        detail: "Your build of it in the payments space, from another computer; sent back from the lead's Build and Test, back with alice in payments.",
      }),
    ]);
    expect(JSON.stringify(look)).not.toContain("your Build and Test");
    const other = next(cloneOf(home.remote, "abe"));
    expect(String(other.question), JSON.stringify(other)).toContain("refunds (sent back from the lead's Build and Test, back with alice in payments)");
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

  test("said when the push is put off, and not again by a later look at the finished build", () => {
    const { alice, record } = refundsTaken();
    const step = next(alice);
    expect(JSON.stringify(step)).not.toContain("git add aidlc");
    codeGenerated(alice, record);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    expect(next(alice).ask_type).toBe("unit-push");
    const later = run(UNIT, ["push", "--later"], alice);
    expect(later.status, later.out).toBe(0);
    expect(later.json?.notice).toBe(`Nothing is pushed. I'll push refunds when you want it to go to the lead. ${LINE}`);
    // The end, and every look after it, carry nothing more.
    for (let look = 0; look < 2; look++) {
      const end = next(alice);
      expect(end.kind, JSON.stringify(end)).toBe("done");
      expect(JSON.stringify(end)).not.toContain("git add aidlc");
    }
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
    expect(takeIn("payments", ["refunds", "--home", HOME_RECORD], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    expect(arrivedAtLastPull(ana, "payments")).toBeNull();
    const bea = cloneOf(home.remote, "bea");
    expect(takeIn("web", ["checkout-ui", "--home", HOME_RECORD], bea).status).toBe(0);
    checkIn(bea, "web: checkout-ui started");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana, "payments")).toBe("checkout-ui in web");
    const status = run(UTILITY, ["status"], ana, ENV);
    expect(status.out).toContain("From others:    checkout-ui in web (at your last pull that brought changes)");
    // Another pull, straight after, that brings the lead's change: only that one is said.
    writeFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "notes.md"), "Lead's note.\n");
    git(home.dir, ["pull", "-q", "--no-rebase", "--no-edit"]);
    checkIn(home.dir, "the lead's note");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana, "payments")).toStartWith("the lead's ");
    expect(arrivedAtLastPull(ana, "payments")).not.toContain("checkout-ui");
  });
});

