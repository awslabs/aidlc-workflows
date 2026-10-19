// covers: subcommand:aidlc-unit:push, subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:merged, audit:UNIT_PUSHED, audit:UNIT_MERGED, function:checkTeamResults, function:renderUnitBoard, function:teamsAcrossReposLine
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
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  ENV,
  git,
  HOME_RECORD,
  homeState,
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  finishBuild,
  hook,
  personsChat,
  personsNext,
  refundsTaken,
  run,
  tellsWhatToType,
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
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as {
      result: { by: string; repos: Array<{ repo: string; branch: string; paths: Record<string, string> }>; outputs: string[] };
    };
    expect(claim.result.by).toBe("alice");
    expect(claim.result.repos.map((repo: { repo: string; branch: string }) => [repo.repo, repo.branch]))
      .toEqual([["checkout-api", "refunds"], ["billing", "refunds"]]);
    expect(Object.keys(claim.result.repos[0].paths)).toEqual(["src/refunds.ts"]);
    expect(claim.result.outputs).toContain("construction/refunds/code-generation/code-summary.md");
    const rows = readAuditShardEvents(alice, basename(record), "payments").filter((row) => row.event === "UNIT_PUSHED");
    expect(rows).toHaveLength(1);
  });

  test("a file that held their own uncommitted change when the Unit was taken: only the Unit's change goes, theirs stays theirs", () => {
    const { hosts, alice, record } = refundsTaken(undefined, (dir) => {
      writeFileSync(join(dir, "checkout-api", "README.md"), "# checkout-api\n\nmy secret note\n");
      writeFileSync(join(dir, "billing", "README.md"), "# billing (my note)\n");
    });
    codeGenerated(alice, record);
    // Code Generation also writes both READMEs: in checkout-api apart from their
    // note, in billing on the very line their note changed.
    writeFileSync(join(alice, "checkout-api", "README.md"), "Refunds API.\n\n# checkout-api\n\nmy secret note\n");
    writeFileSync(join(alice, "billing", "README.md"), "# billing service\n");
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    const written = JSON.parse(readFileSync(manifest, "utf-8")) as { writes: Array<{ repo: string; path: string }> };
    written.writes.push({ repo: "checkout-api", path: "README.md" }, { repo: "billing", path: "README.md" });
    writeFileSync(manifest, `${JSON.stringify(written, null, 2)}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts["checkout-api"], ["show", "refunds:README.md"])).toBe("Refunds API.\n\n# checkout-api");
    expect(git(hosts.billing, ["show", "refunds:README.md"])).toBe("# billing");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
    expect(String(pushed.json?.notice)).toContain(
      "README.md in billing is not in the commit: it already had a change of yours when refunds was taken, and " +
        "refunds's own change could not be kept apart from it. Both are still in the file, uncommitted.",
    );
    // Nothing of theirs in the working tree changed; their note is theirs, uncommitted.
    expect(readFileSync(join(alice, "checkout-api", "README.md"), "utf-8")).toBe("Refunds API.\n\n# checkout-api\n\nmy secret note\n");
    expect(readFileSync(join(alice, "billing", "README.md"), "utf-8")).toBe("# billing service\n");
    expect(git(join(alice, "checkout-api"), ["status", "--porcelain"])).toBe("M README.md");
    expect(git(join(alice, "billing"), ["status", "--porcelain"])).toBe("M README.md");
    // A second push carries the Unit's newer change on top of what it sent, still never their note.
    writeFileSync(join(alice, "checkout-api", "README.md"), "Refunds API.\n\n# checkout-api\n\nmy secret note\n\nSee docs.\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const sent = git(hosts["checkout-api"], ["show", "refunds:README.md"]);
    expect(sent).toContain("Refunds API.");
    expect(sent).not.toContain("my secret note");
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
    expect(later.json?.notice).toBe("Nothing is pushed. I'll push refunds when you want it to go home.");
    expect(tellsWhatToType(ask.question, ask.choices, later.json?.notice)).toBe(false);
    const end = next(alice);
    expect(end.kind, JSON.stringify(end)).toBe("done");
    expect((end.change_notices ?? []) as string[]).toContain(
      "refunds is built and approved, and not pushed yet. Do you want me to push it now?",
    );
    expect(String(end.done_note)).toEndWith("aidlc-unit.ts push` and say its notice line.");
  });
});

describe("at the home", () => {
  test("while the home builds the walking skeleton, the claims are fetched once in a chat, not at every step", () => {
    const dependencies = "# Unit dependencies\n\n```yaml\nunits:\n  - name: orders\n    depends_on: []\n" +
      "  - name: refunds\n    depends_on: [orders]\n  - name: checkout-ui\n    depends_on: [orders]\n```\n";
    const home = makeHome({ dependencies, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const trace = join(tempDir("trace"), "trace2.json");
    for (let step = 0; step < 3; step++) {
      const directive = next(home.dir, { ...ENV, GIT_TRACE2_EVENT: trace });
      expect(directive.unit, JSON.stringify(directive)).toBe("orders");
    }
    const claimFetches = readFileSync(trace, "utf-8").split("\n").filter((line) => {
      if (!line.includes('"event":"start"')) return false;
      const argv = (JSON.parse(line) as { argv: string[] }).argv;
      return argv.includes("fetch") && argv.some((arg) => arg.includes("refs/heads/claim/"));
    });
    expect(claimFetches).toHaveLength(1);
  });

  test("a look at the board writes nothing back to the claim until the home sees a new merge", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const ref = `refs/heads/claim/${fixtureIntentId8(home.dir)}/refunds`;
    const pushed = git(home.remote, ["rev-parse", ref]);
    next(home.dir);
    next(home.dir);
    expect(git(home.remote, ["rev-parse", ref])).toBe(pushed);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    next(home.dir);
    expect(git(home.remote, ["rev-parse", ref])).not.toBe(pushed);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.verdicts).toEqual([
      expect.objectContaining({ repo: "checkout-api", merged: true }),
      { repo: "billing", merged: false },
    ]);
  });

  test("a team's result brings home what Build and Test reads of the Unit, so its coverage check passes for team-built Units", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // What the team's Code Generation and NFR Requirements recorded for refunds.
    const table = { stage: "code-generation", upstream_ids: ["FR1"], coverage: [{ id: "FR1", status: "OK", target: "checkout-api/src/refunds.ts" }] };
    writeFileSync(join(record, "construction", "refunds", "code-generation", "traceability.json"), `${JSON.stringify(table, null, 2)}\n`);
    mkdirSync(join(record, "construction", "refunds", "nfr-requirements"), { recursive: true });
    writeFileSync(join(record, "construction", "refunds", "nfr-requirements", "performance-requirements.md"), "# Performance\n\nNFR1.1 fast refunds.\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    const homeUnit = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds");
    expect(JSON.parse(readFileSync(join(homeUnit, "code-generation", "traceability.json"), "utf-8"))).toEqual(table);
    expect(readFileSync(join(homeUnit, "nfr-requirements", "performance-requirements.md"), "utf-8")).toContain("NFR1.1");
    // The home has the merged code: Build and Test's cross-Unit coverage finds FR1 built.
    git(join(home.dir, "checkout-api"), ["pull", "-q", "origin", "main"]);
    const coverage = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-sensor-traceability.ts"), "--stage", "build-and-test"], {
      cwd: home.dir, encoding: "utf-8", env: { ...ENV, AIDLC_PROJECT_DIR: home.dir },
    });
    const result = JSON.parse(coverage.stdout) as { uncovered: string[] };
    expect(result.uncovered, coverage.stdout).not.toContain("FR1");
  });

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
    // reporting waited on refunds and is the home's to build now, as the home's own work.
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(after.unit).toBe("reporting");
    const started = run(STATE, ["unit", "start", "--stage", "functional-design", "--unit", "reporting"], home.dir);
    expect(started.status, started.out).toBe(0);
  });

  test("another machine or a fresh clone of the home reads a Unit done on its claim as done, and what waits on it opens", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    // The lead's laptop: the home's work as last pushed, without this machine's record of the merge.
    const laptop = cloneOf(home.remote, "lead-laptop");
    const picked = run(join(AIDLC_SRC, "tools", "aidlc.ts"), ["engine", "intent", "switch", HOME_RECORD], laptop);
    expect(picked.status, picked.out).toBe(0);
    const step = next(laptop);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("reporting");
    expect(readAuditShardEvents(laptop).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    expect(readFileSync(join(laptop, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds", "code-generation", "code-summary.md"), "utf-8"))
      .toBe("# Code summary\n\nRefunds.\n");
  });

  test("what a team sent shows at the home's next step, with no fetch by the lead", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(String(next(home.dir).message)).toContain(
      "- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
    );
  });

  test("a home remote that cannot be reached: the board is the last fetch's, with one line that it may be behind", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("notice");
    expect(String(step.message)).toContain("- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)");
    expect((step.change_notices ?? []) as string[]).toEqual([
      "origin could not be reached just now, so the board may be behind: it shows what your last fetch brought.",
      "If web cannot reach this workspace, I can hand checkout-ui to them as a file they build it from. Do you want me to?",
    ]);
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
      'refunds was turned down in billing at the home: "billing needs the ledger entry too".',
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

  test("the board names the agent's commands for the lead's words: a repo turned it down, or merged it where the check cannot see", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const board = next(home.dir);
    expect(board.kind).toBe("notice");
    expect(String(board.board_note)).toContain("aidlc-unit.ts turned-down <unit> --repo <repo> --person-words '<their words>'");
    expect(String(board.board_note)).toContain("aidlc-unit.ts merged <unit> --repo <repo> --person-words '<their words>'");
  });

  test("the lead's word that a repo merged where the check cannot see: kept in their words, and the Unit is done", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(String(next(home.dir).message)).toContain("checkout-api merged, billing not merged yet (1 of 2 merged)");
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing merged it by hand last night"], home.dir);
    expect(said.status, said.out).toBe(0);
    expect(said.json?.notice).toBe("billing counts as merged for refunds, in your words.");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged[0]?.block).toContain('billing (by your word: "billing merged it by hand last night")');
  });

  test("the lead's word that a repo turned a Unit down or merged it counts only with a turn of theirs behind it", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const guarded: NodeJS.ProcessEnv = { ...ENV, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "" };
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger"], home.dir, guarded);
    expect(down.status).not.toBe(0);
    expect(String(down.json?.error)).toBe("A turn-down is the person's own word: ask them first, then run this with their words.");
    const merged = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "merged by hand"], home.dir, guarded);
    expect(merged.status).not.toBe(0);
    expect(String(merged.json?.error)).toBe("That it merged is the person's own word: ask them first, then run this with their words.");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "billing merged it by hand" }, home.dir);
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing merged it by hand"], home.dir, guarded);
    expect(said.status, said.out).toBe(0);
  });

  test("a verdict the home's remote does not take stays here, said once, and goes at the next step", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    next(home.dir);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/heads/claim/*) echo 'claims are read-only today' >&2; exit 1;; esac; done\n");
    chmodSync(hook, 0o755);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const step = next(home.dir);
    expect((step.change_notices ?? []) as string[]).toContain(
      "What the board shows here could not be sent to origin just now; the teams may not see it yet, and the next step sends it again.",
    );
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.done).toBeUndefined();
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
  });

  test("a team whose pushed build waits on the home hears a turn-down at its next step in the same chat, and the build never reads as finished", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // The person's chat ran the build: its prompt hook has run in this record.
    const chat = personsChat("t-unit-push-waits");
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-push-waits", prompt: "build refunds" }).status).toBe(0);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const first = personsNext(alice, chat, "t-unit-push-waits");
    expect(first.kind, JSON.stringify(first)).toBe("done");
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir).status).toBe(0);
    const step = personsNext(alice, chat, "t-unit-push-waits");
    expect((step.change_notices ?? []) as string[]).toContain(
      'refunds was turned down in billing at the home: "billing needs the ledger entry too".',
    );
    expect(step.ask_type, JSON.stringify(step)).toBe("unit-turned-down");
    // Not now: it reads as not finished, and the question is not put again; the agent keeps the offer.
    const later = personsNext(alice, chat, "t-unit-push-waits");
    expect(later.kind, JSON.stringify(later)).toBe("notice");
    expect(later.message).toBe(
      "refunds is not finished: it was turned down at the home and waits for your change and a new push. " +
        "Do you want me to take it back to Code Generation?",
    );
    const offers = later.offers as Array<{ choices: Array<{ label: string; command?: string }> }>;
    expect(offers[0].choices[0].command).toEndWith("report --result resumed --choice redo --target code-generation");
    // Pushed again, the turn-down is answered: the build is finished once more.
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 2;\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.turned_down).toBeUndefined();
    expect(personsNext(alice, chat, "t-unit-push-waits").kind).toBe("done");
  });

  test("after a turn-down the build asks whether to go back to Code Generation, and the person's yes takes it there", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // The person's chat ran the build: its prompt hook has run in this record.
    const chat = personsChat("t-unit-push-turned-down");
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-push-turned-down", prompt: "build refunds" }).status).toBe(0);
    finishBuild(record);
    // The person approved the last stage: their earlier turns are spent.
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation", Unit: "refunds" }, alice, basename(record), "payments");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(personsNext(alice, chat, "t-unit-push-turned-down").kind).toBe("done");
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir).status).toBe(0);
    const ask = personsNext(alice, chat, "t-unit-push-turned-down");
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-turned-down");
    expect(ask.question).toBe(
      "Do you want me to take refunds back to Code Generation so you can change it and push it again? " +
        "That is what I'd do: billing needs the change before refunds can merge.",
    );
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Take refunds back to Code Generation", "Not now"]);
    expect(tellsWhatToType(ask.question, ask.choices, ask.change_notices)).toBe(false);
    expect(choices[0].command).toEndWith("report --result resumed --choice redo --target code-generation");
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).not.toContain("- **Status**: Completed");
    // The person says yes in their chat; the choice, the way back it prints, and the guard that lets it run.
    const said = hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-push-turned-down", prompt: "yes, take it back" });
    expect(said.status, said.out).toBe(0);
    const back = run(ORCH, ["report", "--result", "resumed", "--choice", "redo", "--target", "code-generation"], alice, chat);
    const jump = /`(bun \S+aidlc-jump\.ts execute [^`]+)`/.exec(String(back.json?.message))?.[1];
    expect(jump, back.out).toBeDefined();
    // The jump as the agent runs it, from the project's own tool tree.
    cpSync(AIDLC_SRC, join(alice, ".claude"), { recursive: true });
    const guard = hook(alice, chat, {
      hook_event_name: "PreToolUse", session_id: "t-unit-push-turned-down", tool_name: "Bash", tool_input: { command: jump },
    });
    expect(guard.status, guard.out).toBe(0);
    const ran = spawnSync("bash", ["-c", jump!.replace(/^bun /, `${process.execPath} `)], { cwd: alice, encoding: "utf-8", env: chat });
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const step = next(alice, chat);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("code-generation");
  });

  test("a turn-down at the home reaches the team once, in the home's words", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir);
    expect(down.status, down.out).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    const line = 'refunds was turned down in billing at the home: "billing needs the ledger entry too".';
    expect((next(alice).change_notices ?? []) as string[]).toContain(line);
  });
});
