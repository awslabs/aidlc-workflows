// covers: subcommand:aidlc-unit:push, subcommand:aidlc-unit:turned-down, audit:UNIT_PUSHED, audit:UNIT_MERGED, function:checkTeamResults, function:renderUnitBoard, function:teamsAcrossReposLine
//
// A Unit's build goes home (#2410, item 5). Teams build Units across repos when
// the workspace is in git. At the build's end the person is offered the push;
// it commits exactly the files the Unit's Code Generation recorded writing, on
// the Unit's branch in each repo, pushes them with the person's own git, and
// sends the result home on the claim. The person's other uncommitted work is
// never committed. The home checks each repo's integration branch, shows how
// far the Unit merged, and records it done once every repo merged, so the
// Units waiting on it open. A turn-down at the home reaches the team once.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  git,
  HOME_RECORD,
  makeHome,
  mergeOnHost,
  next,
  refundsTaken,
  run,
  STATE,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

describe("teams build Units across repos when the workspace is in git", () => {
  test("choosing teams on work across repos goes through, and the home asks who builds which Unit", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
  });
});

describe("the push", () => {
  test("commits only the Unit's files on its branch in each repo, pushes them, and sends the result home", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // Their own work in progress in checkout-api stays theirs.
    writeFileSync(join(alice, "checkout-api", "README.md"), "# checkout-api\n\nmy notes\n");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe(
      "Pushed branch refunds in checkout-api and billing. Open a PR in each your usual way. " +
        "You are on branch refunds in checkout-api and billing now.",
    );
    expect(git(hosts["checkout-api"], ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toEqual(["README.md", "src/refunds.ts"]);
    expect(git(join(alice, "checkout-api"), ["status", "--porcelain"])).toBe("M README.md");
    expect(git(join(alice, "checkout-api"), ["show", "-s", "--format=%an", "refunds"])).toBe("alice");
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as Record<string, any>;
    expect(claim.result.by).toBe("alice");
    expect(claim.result.repos.map((repo: { repo: string; branch: string }) => [repo.repo, repo.branch]))
      .toEqual([["checkout-api", "refunds"], ["billing", "refunds"]]);
    expect(Object.keys(claim.result.repos[0].paths)).toEqual(["src/refunds.ts"]);
    expect(claim.result.outputs).toContain("construction/refunds/code-generation/code-summary.md");
    const rows = readAuditShardEvents(alice, record.split("/").at(-1), "payments").filter((row) => row.event === "UNIT_PUSHED");
    expect(rows).toHaveLength(1);
  });

  test("a push a repo's host refuses is said once, in its words, and nothing is retried", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const hook = join(hosts.billing, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'branch protection: refunds needs a ticket' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status).not.toBe(0);
    expect(String(pushed.json?.error)).toBe(
      "The push of refunds in billing was refused: branch protection: refunds needs a ticket (pre-receive hook declined). " +
        "Nothing was retried.",
    );
  });

  test("the build's end offers the push; not now pushes nothing, and the end says so once", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // Every planned stage of the build done and approved.
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    expect(ask.question).toBe(
      "Refunds is built and you approved it. It changed checkout-api and billing. Commit its changes on branch " +
        "refunds in each and push them?",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Push", "Not now"]);
    expect(choices[1].command).toEndWith("aidlc-unit.ts push --later");
    const later = run(UNIT, ["push", "--later"], alice);
    expect(later.status, later.out).toBe(0);
    expect(later.json?.notice).toBe("Nothing is pushed. Say push when refunds is ready to go home.");
    const end = next(alice);
    expect(end.kind, JSON.stringify(end)).toBe("done");
    expect((end.change_notices ?? []) as string[]).toContain(
      "refunds is built and approved, and not pushed yet: say push when it is ready to go home.",
    );
  });
});

describe("at the home", () => {
  test("the board counts the merges, and the Unit is done once every repo merged; what waits on it opens", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const first = next(home.dir);
    expect(first.kind, JSON.stringify(first)).toBe("notice");
    expect(String(first.message)).toBe([
      "Units of fixture:",
      "- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
      "- checkout-ui, web: held for web, not taken yet",
      "- reporting, here: waits on refunds",
    ].join("\n"));
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(String(next(home.dir).message)).toContain(
      "- refunds, payments: checkout-api merged, billing not merged yet (1 of 2 merged)",
    );
    mergeOnHost(hosts.billing, "refunds", "merge");
    const after = next(home.dir);
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged).toHaveLength(1);
    expect(merged[0].block).toContain("**Built By**: alice");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    expect(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds", "code-generation", "code-summary.md"), "utf-8"))
      .toBe("# Code summary\n\nRefunds.\n");
    // reporting waited on refunds and is the home's to build now.
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(after.unit).toBe("reporting");
  });

  test("what a team sent shows at the home's next step, with no fetch by the lead", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(String(next(home.dir).message)).toContain(
      "- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
    );
  });

  test("a turn-down reaches the team at its next step, with no fetch by the team, in its own workspace repo too", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    // payments keeps its own workspace repo, made from the home's: its pulls
    // never bring the home's claims.
    const seed = cloneOf(home.remote, "seed");
    const own = tempDir("payments-host");
    git(own, ["init", "-q", "--bare", "-b", "main"]);
    git(seed, ["remote", "set-url", "origin", own]);
    git(seed, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(own, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], alice).status).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    codeGenerated(alice, join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!));
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir).status).toBe(0);
    expect((next(alice).change_notices ?? []) as string[]).toContain(
      'refunds was turned down in billing at the home: "billing needs the ledger entry too". ' +
        "Say go back to Code Generation to change it, then push again.",
    );
  });

  test("code a team merged into the workspace itself is the work's own: the home never asks whether it is existing code", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    mkdirSync(join(home.dir, "services", "checkout-api", "src"), { recursive: true });
    writeFileSync(join(home.dir, "services", "checkout-api", "src", "refunds.ts"), "export const refunds = 1;\n");
    writeFileSync(join(home.dir, "package.json"), '{ "name": "platform" }\n');
    expect(next(home.dir).ask_type).not.toBe("project-type");
  });

  test("a turn-down at the home reaches the team once, in the home's words", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir);
    expect(down.status, down.out).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    const line = 'refunds was turned down in billing at the home: "billing needs the ledger entry too". ' +
      "Say go back to Code Generation to change it, then push again.";
    expect((next(alice).change_notices ?? []) as string[]).toContain(line);
  });
});
