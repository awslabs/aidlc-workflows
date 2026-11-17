// covers: subcommand:aidlc-unit:share, subcommand:aidlc-unit:release, subcommand:aidlc-unit:take, subcommand:aidlc-unit:plan-change, function:planJsonOf, function:planFilesNow, function:leadsPlanWrite
//
// What a release does with a key in plan.json that it does not know, so a newer
// AI-DLC can add one: a key at the plan's top level, and one in a Unit's word,
// are read past, and every writer carries them on (a word of the lead's, a share
// again, a move, a put-back). A key anywhere else is read past and carried by a
// word of the lead's, but a share again builds those parts itself and drops it;
// a known key in another shape makes no plan. The note a moved plan leaves is
// strict, its three keys only. So under one format a new key goes at the top
// level or in a Unit's word; anything else an older release must not read past
// raises the format number, and an older release then gives the update step and
// never writes over it, a plan or a note.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cleanupTeamBuild,
  ENV,
  git,
  makePlanHome,
  next,
  planRefOf,
  refundsTaken,
  run,
  teamWorkspace,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

type Json = Record<string, unknown> & { units?: Array<{ name: string; word: Record<string, unknown> }> };
const SOMEONE = { ...ENV, GIT_AUTHOR_NAME: "someone", GIT_AUTHOR_EMAIL: "someone@example.test", GIT_COMMITTER_NAME: "someone", GIT_COMMITTER_EMAIL: "someone@example.test" };

// plan.json at the plan's tip as `edit` leaves it, one commit on the tip by someone with push access; with
// `alone`, plan.json is the commit's only file, as a note's is. Returns the new tip.
function onTip(host: string, id8: string, edit: (plan: Json) => unknown, alone = false): string {
  const out = (args: string[], input?: string): string => spawnSync("git", args, { cwd: host, encoding: "utf-8", env: SOMEONE, input }).stdout.trim();
  const tip = git(host, ["rev-parse", planRefOf(id8)]);
  const read = JSON.parse(git(host, ["show", `${tip}:plan.json`])) as Json;
  const plan = (edit(read) as Json | undefined) ?? read;
  const blob = out(["hash-object", "-w", "--stdin"], `${JSON.stringify(plan, null, 2)}\n`);
  const entries = alone ? [`100644 blob ${blob}\tplan.json`]
    : out(["ls-tree", tip]).split("\n").map((line) => (line.endsWith("\tplan.json") ? `100644 blob ${blob}\tplan.json` : line));
  const commit = out(["commit-tree", out(["mktree"], `${entries.join("\n")}\n`), "-p", tip, "-m", "by hand"]);
  git(host, ["update-ref", planRefOf(id8), commit]);
  return commit;
}

const planAtHost = (host: string, id8: string): Json => JSON.parse(git(host, ["show", `${planRefOf(id8)}:plan.json`])) as Json;
const wordOf = (plan: Json, unit: string): Record<string, unknown> | undefined => plan.units?.find((entry) => entry.name === unit)?.word;

// The lead's yes to a change this computer did not write, so its next write builds on it.
function keep(dir: string, tip: string): void {
  const kept = run(UNIT, ["plan-change", "keep", "--tip", tip], dir);
  expect(kept.status, kept.out).toBe(0);
}

const LATER = { since: "a later release" };

describe("a key this release does not know, in plan.json", () => {
  test("is read past: a teammate's look offers the plan's Units and a take goes ahead", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    onTip(host, home.id8, (plan) => {
      plan.later = LATER;
      for (const unit of plan.units!) unit.word = { ...unit.word, later: LATER };
    });
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    const step = next(sam, ENV, ["--units"]);
    expect(((step.choices ?? []) as Array<{ label: string }>).map((choice) => choice.label), JSON.stringify(step).slice(0, 600))
      .toContain("Start checkout-ui");
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", host], sam);
    expect(took.status, took.out).toBe(0);
  });

  test("is carried on by a word of the lead's on that Unit, and by one on another Unit", () => {
    const { home, hosts } = refundsTaken();
    const host = hosts["checkout-api"];
    const tip = onTip(host, home.id8, (plan) => {
      plan.later = LATER;
      for (const unit of plan.units!) {
        unit.word = { ...unit.word, ...(unit.name === "refunds" ? { generation: 1 } : {}), later: LATER };
      }
    });
    keep(home.dir, tip);
    const released = run(UNIT, ["release", "refunds"], home.dir);
    expect(released.status, released.out).toBe(0);
    const plan = planAtHost(host, home.id8);
    expect(plan.later).toEqual(LATER);
    expect(wordOf(plan, "refunds")).toMatchObject({ generation: 1, later: LATER, open_again: {} });
    expect(wordOf(plan, "checkout-ui")).toMatchObject({ later: LATER });
  });

  test("is carried on by a share again that writes", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const tip = onTip(host, home.id8, (plan) => {
      plan.later = LATER;
      wordOf(plan, "checkout-ui")!.later = LATER;
      // A setting the share owns, changed, so the share writes again.
      (plan.settings as Record<string, string>).Depth = "changed by hand";
    });
    keep(home.dir, tip);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(git(host, ["rev-parse", planRefOf(home.id8)])).not.toBe(tip);
    const plan = planAtHost(host, home.id8);
    expect((plan.settings as Record<string, string>).Depth).not.toBe("changed by hand");
    expect(plan.later).toEqual(LATER);
    expect(wordOf(plan, "checkout-ui")).toMatchObject({ later: LATER });
  });

  test("is carried on by a move, and the note left at the old place has its three keys only", () => {
    const home = makePlanHome();
    const old = home.hosts["checkout-api"];
    const tip = onTip(old, home.id8, (plan) => {
      plan.later = LATER;
      wordOf(plan, "refunds")!.later = LATER;
    });
    keep(home.dir, tip);
    const moved = run(UNIT, ["share", "--plan", "--repo", "billing"], home.dir);
    expect(moved.status, moved.out).toBe(0);
    const there = planAtHost(home.hosts.billing, home.id8);
    expect(there.later).toEqual(LATER);
    expect(wordOf(there, "refunds")).toMatchObject({ later: LATER });
    expect(Object.keys(planAtHost(old, home.id8)).sort()).toEqual(["format", "moved_to", "work"]);
  });

  test("is carried on by a put-back as this computer last had it, and a key the change took out is not", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    // This computer's plan marks are ordered by their second: the yes comes a second after the share, as a person's does.
    Bun.sleepSync(1100);
    keep(home.dir, onTip(host, home.id8, (plan) => {
      plan.later = LATER;
    }));
    const theirs = onTip(host, home.id8, (plan) => {
      plan.theirs = LATER;
      (plan.settings as Record<string, string>).Depth = "changed by hand";
    });
    const out = run(UNIT, ["plan-change", "take-out", "--tip", theirs], home.dir);
    expect(out.status, out.out).toBe(0);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const plan = planAtHost(host, home.id8);
    expect(plan.later).toEqual(LATER);
    expect(plan.theirs).toBeUndefined();
  });
});

describe("a key this release does not know anywhere else in plan.json", () => {
  test("is read past, carried by a word of the lead's, and dropped by a share again, which builds those parts itself", () => {
    const { home, hosts } = refundsTaken();
    const host = hosts["checkout-api"];
    const tip = onTip(host, home.id8, (plan) => {
      for (const unit of plan.units!) {
        (unit as Record<string, unknown>).later = LATER;
        if (unit.name === "refunds") unit.word = { ...unit.word, generation: 1 };
      }
      (plan.settings as Record<string, unknown>).Later = "a later setting";
    });
    keep(home.dir, tip);
    expect(run(UNIT, ["release", "refunds"], home.dir).status).toBe(0);
    const worded = planAtHost(host, home.id8);
    expect((worded.units![0] as Record<string, unknown>).later).toEqual(LATER);
    expect((worded.settings as Record<string, unknown>).Later).toBe("a later setting");
    // A share again that writes: a setting it owns changed by hand, kept.
    keep(home.dir, onTip(host, home.id8, (plan) => {
      (plan.settings as Record<string, string>).Depth = "changed by hand";
    }));
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const shared = planAtHost(host, home.id8);
    expect((shared.units![0] as Record<string, unknown>).later).toBeUndefined();
    expect((shared.settings as Record<string, unknown>).Later).toBeUndefined();
  });

  test("a known key in a shape this release does not write makes no plan: a take cannot read it, and the lead's share writes over it", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const odd = onTip(host, home.id8, (plan) => {
      plan.skeleton = 5;
    });
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", host], pay);
    expect(took.status, took.out).not.toBe(0);
    expect(took.out).not.toContain("refunds is yours");
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(git(host, ["rev-parse", `${planRefOf(home.id8)}^`])).toBe(odd);
    expect(planAtHost(host, home.id8).skeleton).not.toBe(5);
  });
});

describe("the note a moved plan leaves", () => {
  test("with a key more than its three, is no note: the look at its place says it cannot read it, and follows nothing", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    onTip(host, home.id8, (plan) => ({
      format: 1, work: plan.work, moved_to: { name: "billing", address: home.hosts.billing }, later: LATER,
    }), true);
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const step = next(pay, ENV, ["--lead-address", host]);
    // The place is named by its address here, since what is there names none.
    expect(String(step.narration), JSON.stringify(step).slice(0, 600))
      .toEndWith(" could not be read: what is there is not a plan this AI-DLC can read.");
    // Not a plan to the lead either: the share writes the plan over it, so a key a note needs takes the next format.
    const note = git(host, ["rev-parse", planRefOf(home.id8)]);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    expect(git(host, ["rev-parse", `${planRefOf(home.id8)}^`])).toBe(note);
    expect(planAtHost(host, home.id8).units).toBeDefined();
  });
});

describe("a format above this release's", () => {
  test("on a plan: a word of the lead's gives the update step and writes nothing over it", () => {
    const { home, hosts } = refundsTaken();
    const host = hosts["checkout-api"];
    const newer = onTip(host, home.id8, (plan) => {
      plan.format = 2;
    });
    const released = run(UNIT, ["release", "refunds"], home.dir);
    expect(released.status).not.toBe(0);
    expect(released.out).toContain("This plan was set up with a newer AI-DLC");
    expect(git(host, ["rev-parse", planRefOf(home.id8)])).toBe(newer);
  });

  test("on a note: a share and a take give the update step, and nothing is written over it", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const newer = onTip(host, home.id8, (plan) => ({
      format: 2, work: plan.work, moved_to: { name: "billing", address: home.hosts.billing },
    }), true);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status).not.toBe(0);
    expect(shared.out).toContain("This plan was set up with a newer AI-DLC");
    expect(git(host, ["rev-parse", planRefOf(home.id8)])).toBe(newer);
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", host], pay);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("This plan was set up with a newer AI-DLC");
  });
});
