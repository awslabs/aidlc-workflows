// covers: subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:sign-off, subcommand:aidlc-unit:lead-sign-off, subcommand:aidlc-unit:take, subcommand:aidlc-unit:plan-change, function:viewWithWord
//
// The lead's word on a Unit is written on the plan, never in the Unit's
// record, which stays its builder's: the merge the lead's look sees, a
// turn-down, a sign-off and the sign-off setting. A word holds for the take
// and the push it was said of. A team whose own git reads a merge takes the
// Unit waiting on it without waiting for the lead's look. A record repository
// that does not answer keeps only its own Units as last read. A merge written
// on the plan is said to its builder once. A change on the plan this computer
// did not write is asked about before the lead's next word goes on it, and a
// computer with no baseline carries on from the plan as it stands.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { planNotFollowedLine, planShareAgainOffer, skeletonCodeInMain, viewWithWord, type UnitClaimView, type UnitWord } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { AIDLC_SRC, seededRecordDir, seededStateFile, writeLearningsSelections } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  ENV,
  finishBuild,
  GIT_ENV,
  git,
  HOME_RECORD,
  hook as hookRun,
  inSpace,
  makeHome,
  makePlanHome,
  mergeOnHost,
  next,
  ORCH,
  personsChat,
  planRefOf,
  planWordAt,
  recordAt,
  recordHostOf,
  refundsTaken,
  refundsTakenInClone,
  run,
  teamWorkspace,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

// refunds taken by alice in her own workspace, built and pushed to both repos.
function refundsPushed() {
  const taken = refundsTaken();
  codeGenerated(taken.alice, taken.record);
  const pushed = run(UNIT, ["push"], taken.alice);
  expect(pushed.status, pushed.out).toBe(0);
  return taken;
}

// A take's build folder in a space of a workspace.
function buildRecordOf(dir: string, space: string, unit: string): string {
  const intents = join(dir, "aidlc", "spaces", space, "intents");
  return join(intents, readdirSync(intents).find((name) => name.endsWith(`-${unit}`))!);
}

const recordTip = (home: ReturnType<typeof refundsTaken>["home"], unit: string): string =>
  git(recordHostOf(home, unit), ["rev-parse", `refs/aidlc/claims/${home.id8}/${unit}`]);

describe("the lead's word goes on the plan", () => {
  test("the lead's look writes the merge it sees on the plan, and the record stays as its builder wrote it", () => {
    const { home, hosts } = refundsPushed();
    const record = recordTip(home, "refunds");
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    next(home.dir);
    const word = planWordAt(home, "refunds") as { generation: number; done: boolean; verdicts: Array<{ repo: string; merged: boolean }> };
    expect(word).toMatchObject({ generation: 1, done: true });
    expect(word.verdicts.map((verdict) => [verdict.repo, verdict.merged]).sort()).toEqual([["billing", true], ["checkout-api", true]]);
    expect(recordTip(home, "refunds")).toBe(record);
  });

  test("a turn-down and a sign-off are written on the plan, and the team reads the turn-down at its next step", () => {
    const { home, alice } = refundsPushed();
    const record = recordTip(home, "refunds");
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    const plan = JSON.parse(git(Object.values(home.hosts)[0], ["show", `${planRefOf(home.id8)}:plan.json`])) as { settings: Record<string, string> };
    expect(plan.settings["Lead Sign-off"]).toBe("on");
    const signed = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(signed.status, signed.out).toBe(0);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir);
    expect(down.status, down.out).toBe(0);
    expect(planWordAt(home, "refunds")).toMatchObject({
      generation: 1, signoff: { words: "looks right" }, turned_down: { repo: "billing", words: "the totals are wrong" },
    });
    expect(recordTip(home, "refunds")).toBe(record);
    expect(JSON.stringify(next(alice))).toContain('refunds was turned down in billing by the lead: \\"the totals are wrong\\".');
  });

  test("the plan's repository refuses the write: nothing goes on the plan, and the lead hears git's words", () => {
    const { home, hosts } = refundsPushed();
    const tip = git(hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)]);
    const hook = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'plans are read only here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir);
    expect(down.status).not.toBe(0);
    expect(String(down.json?.error)).toStartWith("checkout-api did not take the change to the plan (");
    expect(String(down.json?.error)).toContain("plans are read only here");
    expect(String(down.json?.error)).toEndWith("so refunds's turn-down in billing is not written. Say when to try again.");
    expect(git(hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)])).toBe(tip);
  });

  test("a word whose message is kept: the same command with it comes back, and the line says the words are kept", () => {
    const { home, hosts } = refundsPushed();
    const hook = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'plans are read only here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const chat = "t-plan-leads-word-kept";
    const said = hookRun(home.dir, personsChat(chat), { hook_event_name: "UserPromptSubmit", session_id: chat, prompt: "turn refunds down in billing, the totals are wrong" });
    expect(said.status, said.out).toBe(0);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir, personsChat(chat));
    expect(down.status).not.toBe(0);
    expect(String(down.json?.error)).toEndWith("Say when to try again; I have your words.");
    const again = String(down.json?.again);
    expect(again).toContain("turned-down refunds --repo billing");
    expect(again).toMatch(/--message '?[\w-]+'?$/);
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  });

  test("the sign-off setting the plan does not take is changed here only, and goes with the lead's next write", () => {
    const { home, hosts } = refundsPushed();
    const hook = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'plans are read only here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const set = run(UNIT, ["lead-sign-off", "on"], home.dir);
    expect(set.status, set.out).toBe(0);
    expect(String(set.json?.notice)).toStartWith("checkout-api did not take the change to the plan (");
    expect(String(set.json?.notice)).toEndWith(
      "so the sign-off setting is not written. Say when to try again. The sign-off setting is changed here only; the plan gets it with my next write to it.",
    );
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir).status).toBe(0);
    const plan = JSON.parse(git(hosts["checkout-api"], ["show", `${planRefOf(home.id8)}:plan.json`])) as { settings: Record<string, string> };
    expect(plan.settings["Lead Sign-off"]).toBe("on");
  });
});

describe("a lead's write puts on the plan only what its step is for", () => {
  test("a Unit added to the lead's Unit plan since the share is not shared by a sign-off", () => {
    const { home } = refundsPushed();
    const dependencies = join(seededRecordDir(home.dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(dependencies, readFileSync(dependencies, "utf-8").replace("```\n", "  - name: audit-log\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
    const signed = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(signed.status, signed.out).toBe(0);
    const plan = JSON.parse(git(Object.values(home.hosts)[0], ["show", `${planRefOf(home.id8)}:plan.json`])) as { units: Array<{ name: string }> };
    expect(plan.units.map((unit) => unit.name)).toEqual(["refunds", "checkout-ui", "reporting"]);
    expect(planWordAt(home, "refunds")).toMatchObject({ signoff: { words: "looks right" } });
  });

  test("an approved change whose plan write does not go leaves the lead's copy as it was, with nothing recorded", () => {
    const taken = refundsTaken();
    const requirements = "inception/requirements-analysis/requirements.md";
    writeFileSync(join(taken.record, ...requirements.split("/")), "# Requirements\n\nFR1 refunds, partial amounts too.\n");
    const sent = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], taken.alice);
    expect(sent.status, sent.out).toBe(0);
    const { home, hosts } = taken;
    expect(next(home.dir).ask_type).toBe("unit-amend");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "yes, partial refunds" }, home.dir);
    const lead = join(seededRecordDir(home.dir), ...requirements.split("/"));
    const before = readFileSync(lead, "utf-8");
    const hook = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'plans are read only here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const approved = run(UNIT, ["amend", "refunds", "--input", requirements, "--answer", "approve", "--person-words", "yes, partial refunds"], home.dir);
    expect(approved.status).not.toBe(0);
    expect(approved.out).toContain("plans are read only here");
    expect(readFileSync(lead, "utf-8")).toBe(before);
    expect(readAuditShardEvents(home.dir).some((row) => row.event === "SHARED_INPUT_AMENDED")).toBe(false);
  });
});

describe("a take the lead opened again", () => {
  test("its builder's push keeps their record as theirs: taken, never given back", () => {
    const { home, alice, record } = refundsTaken();
    const released = run(UNIT, ["release", "refunds"], home.dir);
    expect(released.status, released.out).toBe(0);
    expect(released.json?.notice).toBe("Written on the plan: refunds is open again.");
    const open = run(UNIT, ["release", "reporting"], home.dir);
    expect([open.status, open.json?.notice]).toEqual([0, "reporting is not taken, so it is open already."]);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(recordAt(home, "refunds")!.json).toMatchObject({ status: "claimed", taken_by: "alice" });
  });
});

describe("a turn-down at a team's build", () => {
  test("a team whose other record repository does not answer still hears it at its next step", () => {
    const home = makePlanHome();
    const { hosts } = home;
    const alice = teamWorkspace(hosts, "alice", ["checkout-api", "billing"]);
    inSpace(alice, "payments");
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", hosts["checkout-api"]], alice).status).toBe(0);
    codeGenerated(alice, buildRecordOf(alice, "payments", "refunds"));
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const bob = teamWorkspace(hosts, "bob", ["checkout-web"]);
    expect(run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", hosts["checkout-api"]], bob).status).toBe(0);
    renameSync(hosts["checkout-web"], `${hosts["checkout-web"]}-gone`);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir);
    expect(down.status, down.out).toBe(0);
    expect(JSON.stringify(next(alice))).toContain('refunds was turned down in billing by the lead: \\"the totals are wrong\\".');
  });

  test("a builder in a clone of the lead's workspace, with the lead's work on disk, hears it at their next step", () => {
    const { home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir);
    expect(down.status, down.out).toBe(0);
    expect(JSON.stringify(next(alice))).toContain('refunds was turned down in billing by the lead: \\"the totals are wrong\\".');
  });

  test("is heard and opens the build once; a push of the same commits is its answer, and it is not said or opened again", () => {
    const { home, alice, record } = refundsPushed();
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir);
    expect(down.status, down.out).toBe(0);
    const line = 'refunds was turned down in billing by the lead: \\"the totals are wrong\\".';
    expect(JSON.stringify(next(alice))).toContain(line);
    // Heard is kept as the engine's own once-mark, no file of another kind.
    const kept = readdirSync(join(record, ".aidlc-engine")).filter((name) => name.includes("turned-down")).sort();
    expect(kept.map((name) => name.replace(/-[0-9A-Za-z]+\.json$/, ""))).toEqual(["unit-turned-down-heard"]);
    // Its stages done again with the same code, and that code pushed again.
    finishBuild(record);
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(again.json?.notice).toContain("These are the commits that were turned down in billing, so refunds stays turned down there.");
    for (const chat of ["a-new-chat", "another-chat"]) {
      expect(JSON.stringify(next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: chat }))).not.toContain(line);
      expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Status**: Completed");
    }
  });

  test("a push of the same commits in fewer of its repositories is not said to keep it", () => {
    const { home, alice, record } = refundsPushed();
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir).status).toBe(0);
    next(alice);
    // Code Generation done again, writing the same code in checkout-api only.
    writeFileSync(join(record, "construction", "refunds", "code-generation", "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [{ repo: "checkout-api", path: "src/refunds.ts" }],
    }, null, 2)}\n`);
    finishBuild(record);
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toStartWith("Pushed branch refunds in checkout-api.");
    expect(String(again.json?.notice)).not.toContain("stays turned down");
  });
});

describe("a merge the lead's look writes on the plan", () => {
  test("is said to its builder once, in the chat of their next step, and not again there or in a later chat", () => {
    const { home, hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    next(home.dir);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    expect(JSON.stringify(next(alice, chat))).toContain("Your refunds is merged.");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "what next" }, alice);
    expect(JSON.stringify(next(alice, chat))).not.toContain("is merged.");
    expect(JSON.stringify(next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-later" }))).not.toContain("is merged.");
  });
});

describe("a merge the lead counts by word for a Unit whose record has no result", () => {
  test("goes on the plan for each repository the plan names, and the Unit is done once every one is counted", () => {
    const { home } = refundsTaken();
    const first = run(UNIT, ["merged", "refunds", "--repo", "checkout-api", "--person-words", "merged by hand"], home.dir);
    expect(first.status, first.out).toBe(0);
    expect(first.json?.notice).toBe("checkout-api counts as merged for refunds, in your words. billing has not merged it yet, so nothing is recorded here.");
    expect(run(UNIT, ["merged", "refunds", "--repo", "ledger", "--person-words", "merged"], home.dir).out).toContain("refunds changed checkout-api and billing, not ledger.");
    const second = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "merged by hand"], home.dir);
    expect(second.json?.notice, second.out).toBe("refunds is recorded as merged here.");
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED" && row.block.includes("refunds"))).toHaveLength(1);
  });
});

// The lead's other computer: a clone of the lead's workspace as last pushed, the lead's work selected.
function leadsLaptop(home: { dir: string; remote: string }): string {
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "--allow-empty", "-m", "the lead's work"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  const laptop = cloneOf(home.remote, "lead-laptop");
  const picked = run(join(AIDLC_SRC, "tools", "aidlc.ts"), ["engine", "intent", "switch", HOME_RECORD], laptop);
  expect(picked.status, picked.out).toBe(0);
  return laptop;
}

const notices = (step: Record<string, unknown>): string[] => (step.change_notices ?? []) as string[];
const tipOf = (command: string): string => /--tip ([0-9a-f]+)/.exec(command)![1];

describe("a change on the plan this computer did not write", () => {
  // A team's push, the lead's look, and the lead's other computer that turns refunds down.
  function changedOnTheLaptop() {
    const taken = refundsTakenInClone();
    codeGenerated(taken.alice, taken.record);
    expect(run(UNIT, ["push"], taken.alice).status).toBe(0);
    next(taken.home.dir);
    const laptop = leadsLaptop(taken.home);
    const first = next(laptop);
    expect(notices(first).filter((line) => line.includes("This computer carries on from it.")), JSON.stringify(first)).toEqual([
      expect.stringMatching(/^The plan of \S+ in checkout-api was last changed by lead, \d{1,2} [A-Z][a-z]{2}\. Its commit says ".+"\. This computer carries on from it\.$/),
    ]);
    expect(JSON.stringify(next(laptop))).not.toContain("This computer carries on from it.");
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "from the laptop"], laptop);
    expect(down.status, down.out).toBe(0);
    return { ...taken, laptop };
  }

  test("is asked about once at the lead's next step, and Keep it writes the lead's next word on top", () => {
    const { home } = changedOnTheLaptop();
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("lead-plan-change");
    expect(String(ask.question)).toMatch(
      /^The plan of \S+ in checkout-api has a change this computer did not write, by lead-laptop, \d{1,2} [A-Z][a-z]{2}\. Its commit says "refunds turned down in billing"\. Keep it on the plan\?$/,
    );
    const choices = ask.choices as Array<{ label: string; detail: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Keep it", "Take it out"]);
    // Until the lead answers, their project reads the lead's word as this computer last had it.
    const board = (): string => run(ORCH, ["team-board"], home.dir).out;
    expect(board()).not.toContain("turned down in billing");
    const kept = run(UNIT, ["plan-change", "keep", "--tip", tipOf(choices[0].command)], home.dir);
    expect(kept.status, kept.out).toBe(0);
    expect(board()).toContain("turned down in billing");
    expect(next(home.dir).ask_type).not.toBe("lead-plan-change");
    const signed = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(signed.status, signed.out).toBe(0);
    expect(planWordAt(home, "refunds")).toMatchObject({ turned_down: { words: "from the laptop" }, signoff: { words: "looks right" } });
  });

  test("a word asked for before the answer puts the question again; Take it out puts the plan back under the word", () => {
    const { home } = changedOnTheLaptop();
    expect(next(home.dir).ask_type).toBe("lead-plan-change");
    const early = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(early.status).not.toBe(0);
    expect(String(early.json?.error)).toStartWith("Before I write refunds's sign-off: The plan of ");
    expect(early.json?.ask_type).toBe("lead-plan-change");
    expect(String(early.json?.after_answer)).toContain("sign-off refunds");
    const out = (early.json?.choices as Array<{ label: string; command: string }>).find((choice) => choice.label === "Take it out")!;
    expect(run(UNIT, ["plan-change", "take-out", "--tip", tipOf(out.command)], home.dir).status).toBe(0);
    const signed = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(signed.status, signed.out).toBe(0);
    expect(String(signed.json?.notice)).toEndWith("The plan in checkout-api is back as you last had it. The change by lead-laptop stays in its history.");
    const word = planWordAt(home, "refunds") as Record<string, unknown>;
    expect(word.turned_down).toBeUndefined();
    expect(word.signoff).toMatchObject({ words: "looks right" });
  });

  test("a share over a tip that is not a plan, carrying a change this computer did not write, asks about it first", () => {
    const { home, hosts } = changedOnTheLaptop();
    notAPlanAt(hosts["checkout-api"], home.id8, true);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status).not.toBe(0);
    expect(String(shared.json?.error)).toMatch(/^The plan of \S+ in checkout-api has a change this computer did not write, by lead-laptop, /);
    expect(shared.json?.ask_type).toBe("lead-plan-change");
    expect(String(shared.json?.after_answer)).toContain("share --plan");
    const keep = (shared.json?.choices as Array<{ label: string; command: string }>)[0];
    expect(run(UNIT, ["plan-change", "keep", "--tip", tipOf(keep.command)], home.dir).status).toBe(0);
    const again = run(UNIT, ["share", "--plan"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(planWordAt(home, "refunds")).toMatchObject({ turned_down: { words: "from the laptop" } });
  });

  test("several changes are listed one a line, oldest first, and asked about as one", () => {
    const { home, laptop } = changedOnTheLaptop();
    expect(run(UNIT, ["merged", "refunds", "--repo", "checkout-api", "--person-words", "merged by hand"], laptop).status).toBe(0);
    const ask = next(home.dir);
    const lines = String(ask.question).split("\n");
    expect(lines[0]).toMatch(/^The plan of \S+ in checkout-api has 2 changes this computer did not write:$/);
    expect(lines[1]).toMatch(/^lead-laptop, \d{1,2} [A-Z][a-z]{2}\. Its commit says "refunds turned down in billing"\.$/);
    expect(lines[2]).toMatch(/^lead-laptop, \d{1,2} [A-Z][a-z]{2}\. Its commit says "checkout-api counted merged for refunds"\.$/);
    expect(lines.at(-1)).toBe("Keep them on the plan?");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toEqual(["Keep them", "Take them out"]);
  });

  test("a history put in place of the one this computer wrote is asked about, never carried on from", () => {
    const { home, hosts } = refundsPushed();
    planChangedOnHost(hosts["checkout-api"], home.id8, "refunds signed off", (plan) => {
      plan.units[0].word = { ...plan.units[0].word, signoff: { words: "not the lead's", at: "2026-11-17T09:00:00.000Z" } };
    });
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("lead-plan-change");
    expect(String(ask.question)).toMatch(
      /^The plan of \S+ in checkout-api has a change this computer did not write, by someone, \d{1,2} [A-Z][a-z]{2}\. Its commit says "refunds signed off"\. Keep it on the plan\?$/,
    );
    expect(JSON.stringify(ask)).not.toContain("This computer carries on from it.");
  });

  test("after Take it out, a share leaves none of that change on the plan, and says it is back", () => {
    const { home } = changedOnTheLaptop();
    const dependencies = join(seededRecordDir(home.dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(dependencies, readFileSync(dependencies, "utf-8").replace("```\n", "  - name: audit-log\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.json?.ask_type, shared.out).toBe("lead-plan-change");
    const out = (shared.json?.choices as Array<{ label: string; command: string }>).find((choice) => choice.label === "Take it out")!;
    expect(run(UNIT, ["plan-change", "take-out", "--tip", tipOf(out.command)], home.dir).status).toBe(0);
    const again = run(UNIT, ["share", "--plan"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain("The plan in checkout-api is back as you last had it. The change by lead-laptop stays in its history.");
    expect((planWordAt(home, "refunds") as Record<string, unknown>).turned_down).toBeUndefined();
    const plan = JSON.parse(git(home.hosts["checkout-api"], ["show", `${planRefOf(home.id8)}:plan.json`])) as { units: Array<{ name: string }> };
    expect(plan.units.map((unit) => unit.name)).toContain("audit-log");
    expect(next(home.dir).ask_type).not.toBe("lead-plan-change");
  });

  test("after Take it out and a word, the Units, repositories, record places and skeleton that change made are as this computer had them", () => {
    const { home, hosts } = refundsPushed();
    const host = hosts["checkout-api"];
    const planNow = (): HandPlan => JSON.parse(git(host, ["show", `${planRefOf(home.id8)}:plan.json`]));
    const before = planNow();
    planChangedOnHost(host, home.id8, "the plan by hand", (plan) => {
      plan.units.push({ name: "audit-log", waits_on: [], repos: ["billing"], record: "billing", word: {} });
      plan.units[2].waits_on = [];
      plan.units[1].record = "billing";
      plan.repos = plan.repos.map((repo) => (repo.name === "billing" ? { ...repo, address: `file://${repo.address}` } : repo));
      plan.skeleton = plan.skeleton === null ? "reporting" : null;
    }, true);
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("lead-plan-change");
    const out = (ask.choices as Array<{ label: string; command: string }>).find((choice) => choice.label === "Take it out")!;
    expect(run(UNIT, ["plan-change", "take-out", "--tip", tipOf(out.command)], home.dir).status).toBe(0);
    const signed = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(signed.status, signed.out).toBe(0);
    expect(String(signed.json?.notice)).toEndWith("The plan in checkout-api is back as you last had it. The change by someone stays in its history.");
    const after = planNow();
    const shape = (plan: HandPlan) => ({ ...plan, version: 0, units: plan.units.map(({ word: _, ...unit }) => unit) });
    expect(shape(after)).toEqual(shape(before));
    expect(after.units[0].word).toMatchObject({ signoff: { words: "looks right" } });
  });

  test("an approved change the question stops says nothing of its own, and goes on the plan after the answer", () => {
    const { home } = changedOnTheLaptop();
    writeFileSync(join(seededRecordDir(home.dir), "inception", "requirements-analysis", "requirements.md"), "# Requirements\n\nFR1 refunds, in the lead's new words.\n");
    appendAuditEntry("GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" }, home.dir);
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("lead-plan-change");
    expect(JSON.stringify(ask)).not.toContain("kept changing");
    const keep = (ask.choices as Array<{ label: string; command: string }>)[0];
    expect(run(UNIT, ["plan-change", "keep", "--tip", tipOf(keep.command)], home.dir).status).toBe(0);
    expect(notices(next(home.dir)).join(" ")).toContain("The requirements you changed are on the plan now, for refunds.");
  });

  test("the sign-off setting asked for before the answer puts the question again, and goes on the plan with the answer", () => {
    const { home } = changedOnTheLaptop();
    expect(next(home.dir).ask_type).toBe("lead-plan-change");
    const set = run(UNIT, ["lead-sign-off", "on"], home.dir);
    expect(set.status).not.toBe(0);
    expect(String(set.json?.error)).toStartWith("Before I write the sign-off setting: The plan of ");
    expect(set.json?.ask_type).toBe("lead-plan-change");
    expect(String(set.json?.after_answer)).toContain("lead-sign-off on");
    const keep = (set.json?.choices as Array<{ label: string; command: string }>)[0];
    expect(run(UNIT, ["plan-change", "keep", "--tip", tipOf(keep.command)], home.dir).status).toBe(0);
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    const plan = JSON.parse(git(home.hosts["checkout-api"], ["show", `${planRefOf(home.id8)}:plan.json`])) as { settings: Record<string, string> };
    expect(plan.settings["Lead Sign-off"]).toBe("on");
  });
});

// A change on the plan by someone with push access, by hand: plan.json as
// `edit` leaves it, in a commit on the tip (`onTop`), else as a history of its
// own in place of the plan's.
type HandPlan = {
  units: Array<{ name: string; waits_on: string[]; repos: string[]; record: string; word: Record<string, unknown> }>;
  repos: Array<{ name: string; address: string | null }>;
  skeleton: string | null;
};
function planChangedOnHost(host: string, id8: string, what: string, edit: (plan: HandPlan) => void, onTop = false): void {
  const out = (args: string[], input?: string): string => spawnSync("git", args, { cwd: host, encoding: "utf-8", env: SOMEONE, input }).stdout.trim();
  const tip = git(host, ["rev-parse", planRefOf(id8)]);
  const plan = JSON.parse(git(host, ["show", `${tip}:plan.json`])) as HandPlan;
  edit(plan);
  const blob = out(["hash-object", "-w", "--stdin"], `${JSON.stringify(plan, null, 2)}\n`);
  const entries = out(["ls-tree", tip]).split("\n").map((line) => (line.endsWith("\tplan.json") ? `100644 blob ${blob}\tplan.json` : line));
  const tree = out(["mktree"], `${entries.join("\n")}\n`);
  git(host, ["update-ref", planRefOf(id8), out(["commit-tree", tree, ...(onTop ? ["-p", tip] : []), "-m", what])]);
}

// A commit at the plan's ref that is not a plan, as a push by hand can leave it (on the plan as it was, with `onTop`).
const SOMEONE = { ...GIT_ENV, GIT_AUTHOR_NAME: "someone", GIT_AUTHOR_EMAIL: "someone@example.test", GIT_COMMITTER_NAME: "someone", GIT_COMMITTER_EMAIL: "someone@example.test" };
function notAPlanAt(host: string, id8: string, onTop = false): void {
  const out = (args: string[], input?: string): string => spawnSync("git", args, { cwd: host, encoding: "utf-8", env: SOMEONE, input }).stdout.trim();
  const blob = out(["hash-object", "-w", "--stdin"], "not a plan\n");
  const tree = out(["mktree"], `100644 blob ${blob}\tREADME\n`);
  const parent = onTop ? ["-p", git(host, ["rev-parse", planRefOf(id8)])] : [];
  git(host, ["update-ref", planRefOf(id8), out(["commit-tree", tree, ...parent, "-m", "notes"])]);
}

describe("a moved plan whose note cannot be followed here", () => {
  test("is said in one shape by every caller, each naming what it did not do and its own way on", () => {
    const at = { label: "checkout", repo: "billing", address: "https://lead:tok3n@git.example.invalid/billing.git" };
    expect(planNotFollowedLine({ kind: "unread", ...at, said: "fatal: repository not found." }, "refunds's sign-off is not written", "Say when to try again."))
      .toBe("The plan of checkout moved to billing (https://***@git.example.invalid/billing.git), which could not be read (fatal: repository not found), so refunds's sign-off is not written. Say when to try again.");
    expect(planNotFollowedLine({ kind: "unread", ...at, said: null }, "the plan is not shared", "Say when to try again."))
      .toContain("which could not be read (it did not answer in time), so the plan is not shared.");
    const empty = { kind: "not-followed" as const, ...at, holds: "nothing" as const };
    expect(planNotFollowedLine(empty, "the merge of refunds is not written", planShareAgainOffer(empty, "checkout-api")))
      .toBe("The plan of checkout says it moved, but billing does not hold it, so the merge of refunds is not written. I can share the plan again in billing from your own record here: say if you want that.");
    const other = { ...empty, holds: "other" as const };
    expect(planNotFollowedLine(other, "the plan is not shared", planShareAgainOffer(other, "checkout-api")))
      .toBe("The plan of checkout says it moved, but billing does not hold it, so the plan is not shared. I can share the plan again in checkout-api, over the note that it moved, from your own record here: say if you want that.");
  });
});

// The move as the plan writer makes it, made by hand at the hosts: at `to`
// the plan as one commit on the old tip naming `to` as its own, at the old
// place a pointer on top of the old plan, and the moving computer's Home
// Location the new address.
function movedByHand(home: ReturnType<typeof refundsTaken>["home"], to: string): void {
  const lead = { ...GIT_ENV, GIT_AUTHOR_NAME: "lead", GIT_AUTHOR_EMAIL: "lead@example.test", GIT_COMMITTER_NAME: "lead", GIT_COMMITTER_EMAIL: "lead@example.test" };
  const at = (host: string) => (args: string[], input?: string): string =>
    spawnSync("git", args, { cwd: host, encoding: "utf-8", env: lead, input }).stdout.trim();
  const old = at(home.hosts["checkout-api"]);
  const fresh = at(home.hosts[to]);
  const ref = planRefOf(home.id8);
  const tip = old(["rev-parse", ref]);
  fresh(["fetch", "-q", home.hosts["checkout-api"], `${ref}:${ref}`]);
  const plan = JSON.parse(fresh(["show", `${tip}:plan.json`])) as HandPlan & { version: number; plan_repo: unknown; work: { label: string } };
  plan.plan_repo = { name: to, address: home.hosts[to] };
  plan.version += 1;
  const blob = fresh(["hash-object", "-w", "--stdin"], `${JSON.stringify(plan, null, 2)}\n`);
  const entries = fresh(["ls-tree", tip]).split("\n").map((line) => (line.endsWith("\tplan.json") ? `100644 blob ${blob}\tplan.json` : line));
  const moved = fresh(["commit-tree", fresh(["mktree"], `${entries.join("\n")}\n`), "-p", tip, "-m", `aidlc plan ${plan.work.label} ${plan.version}: shared again`]);
  fresh(["update-ref", ref, moved]);
  const pointer = { format: 1, work: plan.work, moved_to: { name: to, address: home.hosts[to] } };
  const note = old(["hash-object", "-w", "--stdin"], `${JSON.stringify(pointer, null, 2)}\n`);
  old(["update-ref", ref, old(["commit-tree", old(["mktree"], `100644 blob ${note}\tplan.json\n`), "-p", tip, "-m", `aidlc plan ${plan.work.label}: moved to ${to}`])]);
  followedTo(home.dir, home.hosts[to]);
}

// A computer of the lead's whose Home Location names `address`, as the
// plan writer's follow leaves it.
function followedTo(dir: string, address: string): void {
  const state = seededStateFile(dir);
  writeFileSync(state, readFileSync(state, "utf-8").replace(/^- \*\*Home Location\*\*: .*$/m, `- **Home Location**: ${address}`));
}

const planAtHost = (host: string, id8: string): HandPlan & { plan_repo: { name: string } } =>
  JSON.parse(git(host, ["show", `${planRefOf(id8)}:plan.json`]));

describe("a plan moved to another repository, at the lead's other computers", () => {
  test("a word asked for at the lead's other computer follows it there, never with the offer to share the plan again", () => {
    const { home, hosts } = refundsPushed();
    const laptop = leadsLaptop(home);
    next(laptop);
    movedByHand(home, "billing");
    const set = run(UNIT, ["lead-sign-off", "on"], laptop);
    expect(set.status, set.out).toBe(0);
    expect(set.out).not.toContain("share the plan again");
    expect(set.out).not.toContain("could not be read");
    expect(planAtHost(hosts.billing, home.id8)).toMatchObject({ plan_repo: { name: "billing" }, settings: { "Lead Sign-off": "on" } });
    expect(JSON.parse(git(hosts["checkout-api"], ["show", `${planRefOf(home.id8)}:plan.json`]))).toHaveProperty("moved_to");
  });

  test("a co-lead's computer with a merge to write follows it there, and says no offer to share again", () => {
    const { home, hosts } = refundsPushed();
    const colead = leadsLaptop(home);
    // The co-lead has the code repositories, as the lead does, so its look sees their merges.
    for (const name of ["checkout-api", "billing"] as const) cloneCode(hosts[name], colead, name, "co-lead");
    next(colead);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    movedByHand(home, "billing");
    // The look that finds the note follows it; the merge is written at the place it moved to.
    for (const step of [next(colead), next(colead)]) {
      expect(step.ask_type, JSON.stringify(step)).not.toBe("lead-plan-change");
      expect(JSON.stringify(step)).not.toContain("share the plan with the teams");
      expect(JSON.stringify(step)).not.toContain("share the plan again");
      expect(JSON.stringify(step)).not.toContain("could not be written on the plan");
    }
    expect(planAtHost(hosts.billing, home.id8).units.find((unit) => unit.name === "refunds")?.word).toMatchObject({ done: true });
    expect(JSON.parse(git(hosts["checkout-api"], ["show", `${planRefOf(home.id8)}:plan.json`]))).toHaveProperty("moved_to");
  });

  // The lead's other computer, its baseline read, after a move made on the lead's computer.
  function laptopAfterTheMove() {
    const { home, hosts } = refundsPushed();
    const laptop = leadsLaptop(home);
    next(laptop);
    movedByHand(home, "billing");
    return { home, hosts, laptop };
  }

  test("a word where the place the note names cannot be read says so, names what is not written, and keeps the way on", () => {
    const { hosts, laptop } = laptopAfterTheMove();
    renameSync(hosts.billing, `${hosts.billing}-gone`);
    const released = run(UNIT, ["release", "refunds"], laptop);
    expect(released.status, released.out).not.toBe(0);
    expect(String(released.json?.error)).toMatch(
      /^The plan of \S+ moved to billing \(.+\), which could not be read \(.+\), so refunds's reopening is not written\. Say when to try again\.$/,
    );
  });

  test("a word where the place the note names holds no plan offers to share it again there, then the word", () => {
    const { home, hosts, laptop } = laptopAfterTheMove();
    git(hosts.billing, ["update-ref", "-d", planRefOf(home.id8)]);
    const released = run(UNIT, ["release", "refunds"], laptop);
    expect(released.status, released.out).not.toBe(0);
    expect(String(released.json?.error)).toMatch(
      /^The plan of \S+ says it moved, but billing does not hold it, so refunds's reopening is not written\. I can share the plan again in billing from your own record here: say if you want that\.$/,
    );
    const onYes = String(released.json?.on_yes);
    expect(onYes).toContain("unit share --plan --repo billing");
    expect(onYes.indexOf("release refunds")).toBeGreaterThan(onYes.indexOf("unit share --plan --repo billing"));
  });

  test("a word where the place the note names holds something else offers to share it again over the note, then the word", () => {
    const { home, hosts, laptop } = laptopAfterTheMove();
    notAPlanAt(hosts.billing, home.id8);
    const released = run(UNIT, ["release", "refunds"], laptop);
    expect(released.status, released.out).not.toBe(0);
    expect(String(released.json?.error)).toMatch(
      /^The plan of \S+ says it moved, but billing does not hold it, so refunds's reopening is not written\. I can share the plan again in checkout-api, over the note that it moved, from your own record here: say if you want that\.$/,
    );
    expect(String(released.json?.on_yes)).toContain("unit share --plan --repo checkout-api");
  });

  test("once this computer follows it, the move itself is never asked about: no Keep it or Take it out for it", () => {
    const { home, hosts } = refundsPushed();
    const laptop = leadsLaptop(home);
    next(laptop);
    movedByHand(home, "billing");
    followedTo(laptop, hosts.billing);
    const step = next(laptop);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("lead-plan-change");
    expect(JSON.stringify(step)).not.toContain("Take it out");
  });

  // A word the moving computer wrote before the move, unseen here.
  function changedThenMoved() {
    const { home, hosts } = refundsPushed();
    const laptop = leadsLaptop(home);
    next(laptop);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir).status).toBe(0);
    movedByHand(home, "billing");
    followedTo(laptop, hosts.billing);
    return { home, hosts, laptop, ask: next(laptop) };
  }

  test("a change the moving computer made before the move is asked about alone", () => {
    const { ask } = changedThenMoved();
    expect(ask.ask_type, JSON.stringify(ask)).toBe("lead-plan-change");
    expect(String(ask.question)).toMatch(/has a change this computer did not write, by lead, .*Its commit says "refunds turned down in billing"\. Keep it on the plan\?$/);
  });

  test("Take it out of a change made before the move puts the plan back where it is now, never where it was", () => {
    const { home, hosts, laptop, ask } = changedThenMoved();
    expect(ask.ask_type, JSON.stringify(ask)).toBe("lead-plan-change");
    const out = (ask.choices as Array<{ label: string; command: string }>).find((choice) => choice.label.startsWith("Take"))!;
    expect(run(UNIT, ["plan-change", "take-out", "--tip", tipOf(out.command)], laptop).status).toBe(0);
    const set = run(UNIT, ["lead-sign-off", "on"], laptop);
    expect(set.status, set.out).toBe(0);
    const plan = planAtHost(hosts.billing, home.id8);
    expect(plan.plan_repo.name).toBe("billing");
    expect(plan.units.find((unit) => unit.name === "refunds")?.word.turned_down).toBeUndefined();
  });
});

describe("a plan to share again before the lead's word goes on it", () => {
  test("over a tip that is not a plan: the stop names the share, then the word; after the share the word is written with the lead's words", () => {
    const { home, hosts } = refundsPushed();
    notAPlanAt(hosts["checkout-api"], home.id8);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir);
    expect(down.status).not.toBe(0);
    expect(down.json?.error).toBe("The plan in checkout-api could not be read: what is there is not a plan this AI-DLC can read. " +
      "I can share the plan again from your own record here, as a new commit over what is there: say if you want that.");
    const onYes = String(down.json?.on_yes);
    expect(onYes.indexOf("unit share --plan")).toBeGreaterThan(-1);
    expect(onYes.indexOf("turned-down refunds --repo billing")).toBeGreaterThan(onYes.indexOf("unit share --plan"));
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const again = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(planWordAt(home, "refunds")).toMatchObject({ turned_down: { words: "the totals are wrong" } });
  });

  test("a plan gone from its repository: the stop says so with the same way on, and a word that still does not go after the share says why", () => {
    const { home, hosts } = refundsPushed();
    git(hosts["checkout-api"], ["update-ref", "-d", planRefOf(home.id8)]);
    const down = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(down.status).not.toBe(0);
    expect(String(down.json?.error)).toMatch(/^The plan of \S+ is no longer in checkout-api\. I can share it again from your own record here: say if you want that\.$/);
    expect(String(down.json?.on_yes)).toContain("sign-off refunds");
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const hook = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'plans are read only here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const still = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(still.status).not.toBe(0);
    expect(String(still.json?.error)).toEndWith("so refunds's sign-off is not written. Say when to try again.");
  });

  test("a merge the lead's look sees while the plan is gone from its repository: said once in the chat, with the share as the way on", () => {
    const { home, hosts } = refundsPushed();
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(hosts["checkout-api"], ["update-ref", "-d", planRefOf(home.id8)]);
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-chat" };
    const gone = /^The plan of \S+ is no longer in checkout-api\. I can share it again from your own record here: say if you want that\.$/;
    const step = next(home.dir, chat);
    expect(notices(step).filter((line) => gone.test(line)), JSON.stringify(step)).toHaveLength(1);
    expect(JSON.stringify(step)).toContain("unit share --plan");
    expect(notices(next(home.dir, chat)).filter((line) => gone.test(line))).toEqual([]);
  });
});

describe("a practice kept at the lead's project", () => {
  test("that the plan's repository does not take is said once, with the share that carries it", () => {
    const { home, hosts } = refundsPushed();
    const hook = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'plans are read only here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const path = writeLearningsSelections(home.dir, {
      space: "default", intent: HOME_RECORD, stage_slug: "functional-design",
      selections: [{ candidate_id: "c1", type: "learning", scope: "project", heading: "Corrections", text: "Keep refund handlers thin", source: "orchestrator" }],
    });
    const kept = run(join(AIDLC_SRC, "tools", "aidlc-learnings.ts"), ["persist", "--slug", "functional-design", "--selections-json", path], home.dir);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.json?.rule_learned).toBe(1);
    expect(kept.json?.notes).toEqual([
      expect.stringMatching(/^checkout-api did not take the change to the plan \(.*plans are read only here.*\), so the practice you chose is not written\. Say when to try again\.$/s),
    ]);
    expect(String(kept.json?.again)).toContain("unit share --plan");
  });
});

describe("the walking skeleton's code", () => {
  test("is in main only once every file it wrote is on main's branch as it is here", () => {
    const home = makeHome({ repos: {} });
    const manifest = join(seededRecordDir(home.dir), "construction", "skeleton", "code-generation", "source-manifest.json");
    mkdirSync(join(manifest, ".."), { recursive: true });
    writeFileSync(manifest, `${JSON.stringify({ stage: "code-generation", unit: "skeleton", version: 1, writes: [{ path: "src/skeleton.ts" }] }, null, 2)}\n`);
    git(home.dir, ["switch", "-q", "-c", "aidlc-plan-skeleton"]);
    mkdirSync(join(home.dir, "src"), { recursive: true });
    writeFileSync(join(home.dir, "src", "skeleton.ts"), "export const skeleton = 1;\n");
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "the skeleton"]);
    git(home.dir, ["push", "-q", "origin", "aidlc-plan-skeleton"]);
    expect(seededStateFile(home.dir)).toBeString();
    expect(skeletonCodeInMain(home.dir, "skeleton")).toBe(false);
    git(home.dir, ["push", "-q", "origin", "aidlc-plan-skeleton:main"]);
    expect(skeletonCodeInMain(home.dir, "skeleton")).toBe(true);
  });
});

describe("a team reads a merge with its own git", () => {
  test("the Unit waiting on a merged one opens for a team that has its repositories, before the lead's look", () => {
    const { home, hosts } = refundsPushed();
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const dan = teamWorkspace(hosts, "dan", ["checkout-api", "billing"]);
    const took = run(UNIT, ["take", "reporting", "--plan", home.id8, "--from", hosts["checkout-api"]], dan);
    expect(took.status, took.out).toBe(0);
    expect(planWordAt(home, "refunds")?.done).toBeUndefined();
  });
});

describe("a record repository that does not answer", () => {
  test("keeps its own Unit's row as last read; the Units whose records answered get their merge written", () => {
    const home = makePlanHome();
    const { hosts } = home;
    const alice = teamWorkspace(hosts, "alice", ["checkout-api", "billing"]);
    inSpace(alice, "payments");
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", hosts["checkout-api"]], alice).status).toBe(0);
    codeGenerated(alice, buildRecordOf(alice, "payments", "refunds"));
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const bob = teamWorkspace(hosts, "bob", ["checkout-web"]);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", hosts["checkout-api"]], bob);
    expect(took.status, took.out).toBe(0);
    expect(recordHostOf(home, "checkout-ui")).toBe(hosts["checkout-web"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    renameSync(hosts["checkout-web"], `${hosts["checkout-web"]}-gone`);
    next(home.dir);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
  });
});

describe("which take and push a word is for", () => {
  const view = (generation: number, heads: Record<string, string>): UnitClaimView => ({
    unit: "refunds", status: "claimed", owner: "payments", generation, nonce: "n", oid: "o", ref: "r",
    payload: {
      version: 1, status: "claimed", owner: "payments", space: "default", intent_uuid: "u", intent_id8: "i", unit: "refunds",
      generation, nonce: "n", base_oid: "", integration_ref: "", claim_ref: "r", predecessor_oid: null, gate_rhythm: "per-stage",
      result: { by: "alice", outputs: [], repos: Object.entries(heads).map(([repo, head]) => ({ repo, branch: "refunds", base: "b", heads: [head], paths: {} })) },
    },
  });
  const word: UnitWord = {
    generation: 1,
    verdicts: [{ repo: "billing", head: "h1", merged: true }],
    turned_down: { repo: "billing", heads: { billing: "h1" }, words: "no", at: "t" },
    signoff: { words: "ok", at: "t" },
  };

  test("a word holds for its take and push; a new push clears the turn-down and the verdicts, never the sign-off", () => {
    expect(viewWithWord(view(1, { billing: "h1" }), word).payload).toMatchObject({ turned_down: { words: "no" }, signoff: { words: "ok" } });
    const pushedAgain = viewWithWord(view(1, { billing: "h2" }), word).payload;
    expect(pushedAgain.turned_down).toBeUndefined();
    expect(pushedAgain.verdicts).toBeUndefined();
    expect(pushedAgain.signoff).toEqual({ words: "ok", at: "t" });
  });

  test("a new take starts clean, a send-back from Build and Test hides the result, and an open-again reads as given back", () => {
    expect(viewWithWord(view(2, { billing: "h1" }), word).payload.signoff).toBeUndefined();
    const sent = viewWithWord(view(1, { billing: "h1" }), { generation: 1, done: true, turned_down: { repo: "", heads: { billing: "h1" }, words: "fails", at: "t", from: "build-and-test" } });
    expect(sent.payload.result).toBeUndefined();
    expect(sent.payload.done).toBeUndefined();
    const opened = viewWithWord(view(1, { billing: "h1" }), { generation: 1, open_again: { at: "t" } });
    expect([opened.status, opened.payload.open_again, opened.payload.status]).toEqual(["released", { at: "t" }, "claimed"]);
  });
});
