// covers: subcommand:aidlc-unit:take, subcommand:aidlc-unit:release, function:recordView, function:createRecordCommit, function:writeUnitRecord, function:recordLeadsOwnStart, function:leadsOwnClaims
//
// A Unit's record lives where the Unit's code goes: refs/aidlc/claims/<id8>/<unit>
// in the repository the shared plan names for that Unit, written only by its
// builder, from the builder's own workspace repository by that repository's
// address. Each record commit holds only unit.json (and, once pushed, the
// Unit's outputs under result/, a proposed text under proposals/), with no
// history but the record's own. Nothing of AI-DLC's goes into a code clone and
// no code clone's hook runs for it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import * as unitTools from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { unitBuildOf } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  DEPENDENCIES,
  git,
  GIT_ENV,
  HOME_RECORD,
  makeHome,
  makePlanHome,
  next,
  recordAt,
  recordHostOf,
  refundsTaken,
  refundsTakenInClone,
  run,
  STATE,
  teamWorkspace,
  tempDir,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

// The builder's side of a Unit: every key a record's unit.json may hold.
const RECORD_KEYS = new Set([
  "version", "status", "unit", "intent_uuid", "owner", "taken_by", "generation", "nonce",
  "base_oid", "integration_ref", "predecessor_oid", "early_on", "result", "proposals",
]);

// What a code clone holds of git's own: its refs, its remotes and its settings.
function cloneState(dir: string): string {
  return createHash("sha256").update(git(dir, ["for-each-ref"]) + git(dir, ["config", "--list", "--local"])).digest("hex");
}

function buildOf(dir: string, unit: string): string | null {
  const intents = join(dir, "aidlc", "spaces", "default", "intents");
  const found = existsSync(intents) ? readdirSync(intents).find((name) => name.endsWith(`-${unit}`)) : undefined;
  return found === undefined ? null : join(intents, found);
}

// checkout-ui changes checkout-web only, so its record goes there, never to
// checkout-api, where the plan is.
function takeCheckoutUi() {
  const home = makePlanHome();
  const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
  const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", home.hosts["checkout-api"]], web);
  return { home, web, took };
}

describe("a take writes the Unit's record where its code goes", () => {
  test("in the repository the plan names for the Unit, and nowhere else: unit.json alone, no parent, the builder's fields", () => {
    const { home, took } = takeCheckoutUi();
    expect(took.status, took.out).toBe(0);
    expect(recordHostOf(home, "checkout-ui")).toBe(home.hosts["checkout-web"]);
    const record = recordAt(home, "checkout-ui");
    expect(record).not.toBeNull();
    expect(record!.files).toEqual(["unit.json"]);
    expect(record!.parents).toEqual([]);
    expect(record!.message).toBe("aidlc unit checkout-ui: taken");
    expect(Object.keys(record!.json).filter((key) => !RECORD_KEYS.has(key))).toEqual([]);
    expect(record!.json).toMatchObject({ version: 1, status: "claimed", unit: "checkout-ui", owner: "default", taken_by: "web", generation: 1 });
    expect(record!.json.base_oid).toBe(home.plan);
    // The plan's repository holds the plan and no record of checkout-ui.
    expect(git(home.hosts["checkout-api"], ["for-each-ref", "--format=%(refname)", `refs/aidlc/claims/${home.id8}/`])).toBe("");
  });

  test("the first take wins: a second person's take hears who builds it, and the record is as the first wrote it", () => {
    const { home, took } = takeCheckoutUi();
    expect(took.status, took.out).toBe(0);
    const first = git(recordHostOf(home, "checkout-ui"), ["rev-parse", `refs/aidlc/claims/${home.id8}/checkout-ui`]);
    const other = teamWorkspace(home.hosts, "ui2", ["checkout-web"]);
    const second = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", home.hosts["checkout-api"]], other);
    expect(second.status).not.toBe(0);
    expect(second.out).toContain("checkout-ui is already taken: web builds it");
    expect(git(recordHostOf(home, "checkout-ui"), ["rev-parse", `refs/aidlc/claims/${home.id8}/checkout-ui`])).toBe(first);
    expect(buildOf(other, "checkout-ui")).toBeNull();
  });

  test("the code clone is left as it was: no ref, remote or setting of AI-DLC's, and its pre-push hook does not run", () => {
    const home = makePlanHome();
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    const clone = join(web, "checkout-web");
    const ran = join(web, "hook-ran");
    const hook = join(clone, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch '${ran}'\n`);
    chmodSync(hook, 0o755);
    const before = cloneState(clone);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", home.hosts["checkout-api"]], web);
    expect(took.status, took.out).toBe(0);
    expect(recordAt(home, "checkout-ui")).not.toBeNull();
    expect(cloneState(clone)).toBe(before);
    expect(existsSync(ran)).toBe(false);
  });

  test("the record's repository cannot be read: the take says so in its own words, and nothing is written", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-web"];
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    renameSync(host, `${host}-away`);
    try {
      const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", home.hosts["checkout-api"]], web);
      expect(took.status).not.toBe(0);
      expect(took.out).toContain("checkout-ui was not taken: checkout-web could not be read (");
      expect(took.out).toContain("Nothing was written; say when to try again.");
      expect(buildOf(web, "checkout-ui")).toBeNull();
    } finally {
      renameSync(`${host}-away`, host);
    }
  });

  test("the record's repository refuses the take: the build is made all the same, and nothing is written there", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-web"];
    writeFileSync(join(host, "hooks", "pre-receive"),
      "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/aidlc/*|refs/heads/aidlc/*) echo \"no records here\" >&2; exit 1;; esac; done\nexit 0\n");
    chmodSync(join(host, "hooks", "pre-receive"), 0o755);
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", home.hosts["checkout-api"]], web);
    expect(took.status, took.out).toBe(0);
    expect(took.out).toContain("checkout-ui is yours.");
    expect(took.out).toContain("checkout-web takes no push from you (no records here (pre-receive hook declined)), so your take of checkout-ui " +
      "is not written there, and someone else could still take it.");
    expect(buildOf(web, "checkout-ui")).not.toBeNull();
    expect(git(host, ["for-each-ref", "--format=%(refname)", "refs/aidlc/"])).toBe("");
    expect(git(home.hosts["checkout-api"], ["for-each-ref", "--format=%(refname)", `refs/aidlc/claims/${home.id8}/`])).toBe("");
  });
});

// A record is written by anyone who can push to its repository: its
// integration_ref is read only in the shapes AI-DLC writes.
describe("a record's integration_ref is read only as AI-DLC writes it", () => {
  test("a record commit made by plain git with another shape: the build's view has none", () => {
    const { home, web, took } = takeCheckoutUi();
    expect(took.status, took.out).toBe(0);
    const host = recordHostOf(home, "checkout-ui");
    const ref = `refs/aidlc/claims/${home.id8}/checkout-ui`;
    const scratch = tempDir("record-writer");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "someone"]);
    git(scratch, ["config", "user.email", "someone@example.test"]);
    git(scratch, ["fetch", "-q", host, `${ref}:refs/tip`]);
    git(scratch, ["read-tree", "refs/tip"]);
    const json = JSON.parse(git(scratch, ["show", "refs/tip:unit.json"])) as Record<string, unknown>;
    json.integration_ref = "refs/tags/v1";
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: scratch, input: `${JSON.stringify(json, null, 2)}\n`, encoding: "utf-8" });
    git(scratch, ["update-index", "--cacheinfo", `100644,${blob.stdout.trim()},unit.json`]);
    const commit = git(scratch, ["commit-tree", git(scratch, ["write-tree"]), "-p", "refs/tip", "-m", "another shape"]);
    git(scratch, ["push", "-q", host, `${commit}:${ref}`]);
    next(web);
    const build = buildOf(web, "checkout-ui");
    expect(build).not.toBeNull();
    const view = unitTools.buildClaimHere(web, { space: "default", dirName: build!.split(/[\\/]/).at(-1)! });
    expect(view?.payload.unit).toBe("checkout-ui");
    expect(view?.payload.integration_ref).toBe("");
  });
});

describe("a give back writes the record's next commit", () => {
  test("given back from the build: released, the generation one more, on the take's own commit", () => {
    const { home, web, took } = takeCheckoutUi();
    expect(took.status, took.out).toBe(0);
    const taken = git(recordHostOf(home, "checkout-ui"), ["rev-parse", `refs/aidlc/claims/${home.id8}/checkout-ui`]);
    const back = run(UNIT, ["release", "checkout-ui"], web);
    expect(back.status, back.out).toBe(0);
    const record = recordAt(home, "checkout-ui");
    expect(record!.files).toEqual(["unit.json"]);
    expect(record!.parents).toEqual([taken]);
    expect(record!.message).toBe("aidlc unit checkout-ui: given back");
    expect(record!.json).toMatchObject({ status: "released", owner: "released", generation: 2, predecessor_oid: taken });
    expect(record!.json.taken_by).toBeUndefined();
  });
});

const REQUIREMENTS = "inception/requirements-analysis/requirements.md";

// git with what it reads on stdin, its output as printed (nothing trimmed).
function gitRaw(cwd: string, args: string[], input?: string): string {
  const ran = spawnSync("git", args, { cwd, encoding: "utf-8", input, env: GIT_ENV });
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.stderr}`);
  return ran.stdout;
}

function tempClone(host: string): string {
  const dir = join(tempDir("hand"), "clone");
  git(tempDir("hand-parent"), ["clone", "-q", host, dir]);
  return dir;
}
const refundsRef = (id8: string): string => `refs/aidlc/claims/${id8}/refunds`;

describe("the builder's later writes go on the record's tip", () => {
  test("the push: the result in unit.json, the outputs under result/, on the take's own commit", () => {
    const { home, alice, record } = refundsTaken();
    const taken = git(recordHostOf(home, "refunds"), ["rev-parse", refundsRef(home.id8)]);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const after = recordAt(home, "refunds")!;
    expect(after.message).toBe("aidlc unit refunds: pushed");
    expect(after.parents).toEqual([taken]);
    const result = after.json.result as { by: string; repos: Array<{ repo: string; branch: string; heads: string[] }>; outputs: string[] };
    expect(result.by).toBe("alice");
    expect(result.repos.map((repo) => [repo.repo, repo.branch])).toEqual([["checkout-api", "refunds"], ["billing", "refunds"]]);
    expect(result.repos[0].heads.at(-1)).toBe(git(home.hosts["checkout-api"], ["rev-parse", "refunds"]));
    expect(result.outputs.length).toBeGreaterThan(0);
    expect(after.files).toEqual([...result.outputs.map((rel) => `result/${rel}`), "unit.json"].sort());
  });

  test("in a clone of the lead's workspace, the push writes on the one record the take wrote, in the Unit's own repository", () => {
    const { home, alice, record } = refundsTakenInClone();
    const taken = git(recordHostOf(home, "refunds"), ["rev-parse", refundsRef(home.id8)]);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const after = recordAt(home, "refunds")!;
    expect(after.message).toBe("aidlc unit refunds: pushed");
    expect(after.parents).toEqual([taken]);
    expect(after.json.result).toBeDefined();
    // The lead's workspace's own remote holds no record of it.
    expect(git(home.remote, ["for-each-ref", "--format=%(refname)", "refs/aidlc/"])).toBe("");
  });

  test("in a clone of the lead's workspace made when its copy of the lead's work still read solo, the push writes on the take's own record", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const id8 = fixtureIntentId8(home.dir);
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    const took = run(UNIT, ["take", "refunds", "--plan", id8, "--from", hosts["checkout-api"]], alice);
    expect(took.status, took.out).toBe(0);
    const ref = `refs/aidlc/claims/${id8}/refunds`;
    const taken = git(hosts["checkout-api"], ["rev-parse", ref]);
    codeGenerated(alice, buildOf(alice, "refunds")!);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    // One record of refunds: the take's, in checkout-api, with the result on it.
    expect(git(hosts["checkout-api"], ["log", "-1", "--format=%s%x00%P", ref]).split("\0")).toEqual(["aidlc unit refunds: pushed", taken]);
    expect(git(home.remote, ["for-each-ref", "--format=%(refname)", "refs/aidlc/claims/"])).toBe("");
  });

  test("a proposal: its text under proposals/ byte for byte, its entry in unit.json, the result's files kept", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const pushed = recordAt(home, "refunds")!;
    const text = "# Requirements\r\n\r\nFR1 refunds, partial amounts too.\r\n";
    writeFileSync(join(record, ...REQUIREMENTS.split("/")), text);
    const sent = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], alice);
    expect(sent.status, sent.out).toBe(0);
    const after = recordAt(home, "refunds")!;
    expect(after.message).toBe(`aidlc unit refunds: proposed a change to ${REQUIREMENTS}`);
    expect(after.files).toEqual([...pushed.files, `proposals/${REQUIREMENTS}`].sort());
    const host = recordHostOf(home, "refunds");
    expect(gitRaw(host, ["cat-file", "blob", `${refundsRef(home.id8)}:proposals/${REQUIREMENTS}`])).toBe(text);
    const proposals = after.json.proposals as Array<Record<string, unknown>>;
    expect(proposals.map((entry) => Object.keys(entry).sort())).toEqual([["at", "by", "input", "words"]]);
    expect(proposals[0]).toMatchObject({ input: REQUIREMENTS, by: "alice", words: "refunds need partial amounts" });
  });

  test("a repository the plan did not list goes on the record with the address the lead reaches it by", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const ledger = codeHost("ledger");
    cloneCode(ledger, alice, "ledger", "alice");
    writeFileSync(join(alice, "ledger", "entries.ts"), "export const entry = 1;\n");
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    const written = JSON.parse(readFileSync(manifest, "utf-8")) as { writes: Array<{ repo: string; path: string }> };
    written.writes.push({ repo: "ledger", path: "entries.ts" });
    writeFileSync(manifest, `${JSON.stringify(written, null, 2)}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const repos = (recordAt(home, "refunds")!.json.result as { repos: Array<{ repo: string; address?: string }> }).repos;
    expect(repos.find((repo) => repo.repo === "ledger")?.address).toBe(ledger);
    expect(repos.find((repo) => repo.repo === "billing")?.address).toBeUndefined();
  });

  test("a repository added by hand during the build is said with where its address goes", () => {
    const { alice } = refundsTaken();
    cloneCode(codeHost("ledger"), alice, "ledger", "alice");
    const added = run(UTILITY, ["intent", "add-repo", "ledger"], alice);
    expect(added.status, added.out).toBe(0);
    expect(added.out).toContain("Added ledger to refunds's repos: the lead's plan did not list it, so refunds's record carries its address when you push.");
  });

  test("a record holds only its own keys and safe names: what is pushed into unit.json by hand is not in the next record", () => {
    const { home, alice, record } = refundsTaken();
    const host = recordHostOf(home, "refunds");
    // Anyone with push access can write a record: a unit.json with the lead's fields in it.
    const seeded = tempClone(host);
    git(seeded, ["fetch", "-q", "origin", `${refundsRef(home.id8)}:refs/tmp/record`]);
    const json = JSON.parse(git(seeded, ["show", "refs/tmp/record:unit.json"])) as Record<string, unknown>;
    // And what a record must never make the tools do: a proposal that names a path outside the work's record,
    // a repository address git would take as an option.
    const planted = {
      ...json, verdicts: [{ repo: "billing", merged: true }], turned_down: { repo: "billing", words: "no", at: "x" }, open_again: { at: "x" },
      proposals: [
        { input: "../../outside.md", by: "x", words: "x", at: "x", answer: "approved" },
        { input: "construction/refunds/notes.md", by: "x", words: "x", at: "x" },
      ],
      result: {
        by: "x", outputs: ["../escape.md"], repos: [
          null,
          { repo: "../outside", branch: "refunds", base: "", heads: [], paths: {} },
          { repo: "billing", branch: "--force", base: "", heads: ["HEAD"], paths: {} },
          { repo: "billing", branch: "refunds", base: "", heads: [], paths: {}, address: "--upload-pack=touch /tmp/x" },
        ],
      },
    };
    const blob = gitRaw(seeded, ["hash-object", "-w", "--stdin"], `${JSON.stringify(planted, null, 2)}\n`).trim();
    const tree = gitRaw(seeded, ["mktree"], `100644 blob ${blob}\tunit.json\n`).trim();
    const commit = git(seeded, ["-c", "user.name=someone", "-c", "user.email=someone@example.test", "commit-tree", tree, "-p", "refs/tmp/record", "-m", "aidlc unit refunds: taken"]);
    git(seeded, ["push", "-q", "origin", `${commit}:${refundsRef(home.id8)}`]);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const after = recordAt(home, "refunds")!;
    expect(after.parents).toEqual([commit]);
    expect(Object.keys(after.json).filter((key) => !RECORD_KEYS.has(key))).toEqual([]);
    expect(after.json.proposals ?? []).toEqual([]);
    expect(JSON.stringify(after.json)).not.toContain("upload-pack");
    expect(JSON.stringify(after.json)).not.toContain("escape.md");
    expect(JSON.stringify(after.json)).not.toContain("outside");
    expect(JSON.stringify(after.json)).not.toContain("--force");
  });
});

describe("a Unit the lead's project builds has a record like any builder's", () => {
  test("assign --here writes its record in that Unit's repository, and a teammate's take hears who builds it", () => {
    const home = makePlanHome();
    const assigned = run(UNIT, ["assign", "--here", "checkout-ui"], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    const record = recordAt(home, "checkout-ui");
    expect(record).not.toBeNull();
    expect(record!.message).toBe("aidlc unit checkout-ui: taken");
    expect(record!.json).toMatchObject({ status: "claimed", owner: "default", taken_by: "lead", generation: 1 });
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", home.hosts["checkout-api"]], web);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("checkout-ui is already taken: lead builds it");
  });
});

// The walk's start of a Unit at the lead's project: its UNIT_STARTED row, then
// what `state unit start` runs after writing it.
function walkStarts(home: { dir: string }, unit: string, stage = "functional-design"): void {
  appendAuditEntry("UNIT_STARTED", { Stage: stage, Unit: unit }, home.dir);
  unitTools.recordLeadsOwnStart(home.dir, unit);
}

describe("what a builder hears from the record", () => {
  // A commit on refunds's record, as anyone with push access can write one: the tip's unit.json with `change` over it.
  function plantOnRecord(home: { id8: string; hosts: Record<string, string> }, change: (json: Record<string, unknown>, parent: string) => Record<string, unknown>): string {
    const host = recordHostOf(home as Parameters<typeof recordHostOf>[0], "refunds");
    const seeded = tempClone(host);
    git(seeded, ["fetch", "-q", "origin", `${refundsRef(home.id8)}:refs/tmp/record`]);
    const json = change(JSON.parse(git(seeded, ["show", "refs/tmp/record:unit.json"])) as Record<string, unknown>, git(seeded, ["rev-parse", "refs/tmp/record"]));
    const blob = gitRaw(seeded, ["hash-object", "-w", "--stdin"], `${JSON.stringify(json, null, 2)}\n`).trim();
    const tree = gitRaw(seeded, ["mktree"], `100644 blob ${blob}\tunit.json\n`).trim();
    const commit = git(seeded, ["-c", "user.name=bob", "-c", "user.email=bob@example.test", "commit-tree", tree, "-p", "refs/tmp/record", "-m", "aidlc unit refunds: taken"]);
    git(seeded, ["push", "-q", "origin", `${commit}:${refundsRef(home.id8)}`]);
    return commit;
  }

  test("a record a newer AI-DLC wrote: the take hears the update offer, and nothing is written there", () => {
    const { home } = refundsTaken();
    const tip = plantOnRecord(home, (json) => ({ ...json, version: 2 }));
    const bob = teamWorkspace(home.hosts, "bob");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], bob);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("refunds's record in checkout-api was written by a newer AI-DLC");
    expect(git(recordHostOf(home, "refunds"), ["rev-parse", refundsRef(home.id8)])).toBe(tip);
    expect(buildOf(bob, "refunds")).toBeNull();
  });

  test("a take on top of this build's own after the lead opened it again: the build hears whose it is now, and writes nothing over it", () => {
    const { home, alice, record } = refundsTaken();
    const tip = plantOnRecord(home, (json, parent) => ({ ...json, taken_by: "bob", owner: "web", generation: 2, nonce: "n2", predecessor_oid: parent }));
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.out).toContain("refunds was taken by bob on ");
    expect(pushed.out).toContain(" after the lead opened it again, so its record in checkout-api has their take now, not yours. " +
      "Your build is still here: agree with bob who carries it on, or give yours back.");
    expect(git(recordHostOf(home, "refunds"), ["rev-parse", refundsRef(home.id8)])).toBe(tip);
  });
});

describe("the Units the lead's project builds, and no others", () => {
  test("a Unit the lead takes from the plan in the lead's own workspace is that build's: the lead's board shows it taken, never built by the walk", () => {
    const home = makePlanHome();
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], home.dir);
    expect(took.status, took.out).toBe(0);
    expect(run(UTILITY, ["intent", "switch", HOME_RECORD], home.dir).status).toBe(0);
    const board = next(home.dir);
    expect(String(board.narration), JSON.stringify(board).slice(0, 600)).toMatch(/- refunds: building since \d{1,2} [A-Z][a-z]{2}, taken by lead/);
  });

  test("the lead's walk starts a Unit a teammate gave back: its record becomes the lead's project's take", () => {
    const { home, web, took } = takeCheckoutUi();
    expect(took.status, took.out).toBe(0);
    expect(run(UNIT, ["release", "checkout-ui"], web).status).toBe(0);
    // The lead's look reads the given-back record into the lead's copy.
    next(home.dir);
    walkStarts(home, "checkout-ui");
    expect(recordAt(home, "checkout-ui")!.json).toMatchObject({ status: "claimed", owner: "default", taken_by: "lead", generation: 2 });
  });

  test("the walk's later starts of a Unit whose record could not be written try nothing again", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-web"];
    const tried = join(tempDir("tries"), "pushes");
    writeFileSync(join(host, "hooks", "pre-receive"), `#!/bin/sh\necho push >> '${tried}'\nexit 1\n`);
    chmodSync(join(host, "hooks", "pre-receive"), 0o755);
    walkStarts(home, "checkout-ui");
    walkStarts(home, "checkout-ui", "nfr-requirements");
    expect(readFileSync(tried, "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("a share again leaves a Unit with a record as it is, and says nothing of it", () => {
    const { home, took } = takeCheckoutUi();
    expect(took.status, took.out).toBe(0);
    const host = recordHostOf(home, "checkout-ui");
    const ref = `refs/aidlc/claims/${home.id8}/checkout-ui`;
    const tip = git(host, ["rev-parse", ref]);
    // The lead's audit names checkout-ui started at the lead's project.
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "checkout-ui" }, home.dir);
    const again = run(UNIT, ["share", "--plan"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(again.out).not.toContain("already taken");
    expect(git(host, ["rev-parse", ref])).toBe(tip);
  });

  test("a take waits on a dependency whose repository cannot be read just now, as it would on one not done", () => {
    const home = makePlanHome({ dependencies: DEPENDENCIES.replace("depends_on: [refunds]", "depends_on: [checkout-ui]") });
    const web = home.hosts["checkout-web"];
    const reporting = teamWorkspace(home.hosts, "rep", ["billing"]);
    renameSync(web, `${web}-away`);
    try {
      const took = run(UNIT, ["take", "reporting", "--plan", home.id8, "--from", home.hosts["checkout-api"]], reporting);
      expect(took.status).not.toBe(0);
      expect(took.out).toContain("reporting waits on checkout-ui, which is not done yet.");
    } finally {
      renameSync(`${web}-away`, web);
    }
  });
});

describe("an early take whose record's repository takes no push from them", () => {
  // reporting builds in checkout-api and billing, and waits on refunds (pushed in both) and on checkout-ui (pushed in
  // checkout-web, none of reporting's): one dependency with two repositories, one with none.
  const EARLY = "# Unit dependencies\n\n```yaml\nunits:\n" +
    "  - name: refunds\n    kind: service\n    repos: [checkout-api, billing]\n    depends_on: []\n" +
    "  - name: checkout-ui\n    kind: ui\n    repos: [checkout-web]\n    depends_on: []\n" +
    "  - name: reporting\n    kind: service\n    repos: [checkout-api, billing]\n    depends_on: [refunds, checkout-ui]\n```\n";

  function earlyTake() {
    const home = makePlanHome({ dependencies: EARLY });
    const from = ["--plan", home.id8, "--from", home.hosts["checkout-api"]];
    const alice = teamWorkspace(home.hosts, "alice", ["checkout-api", "billing"]);
    expect(run(UNIT, ["take", "refunds", ...from], alice).status).toBe(0);
    codeGenerated(alice, buildOf(alice, "refunds")!);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    expect(run(UNIT, ["take", "checkout-ui", ...from], web).status).toBe(0);
    const ui = buildOf(web, "checkout-ui")!;
    writeFileSync(join(web, "checkout-web", "ui.tsx"), "export const ui = 1;\n");
    const stage = join(ui, "construction", "checkout-ui", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "checkout-ui", version: 1, writes: [{ repo: "checkout-web", path: "ui.tsx" }],
    }, null, 2)}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\ncheckout-ui.\n");
    expect(run(UNIT, ["push"], web).status).toBe(0);
    // reporting's record goes to checkout-api, which now takes no push of AI-DLC's records.
    const api = home.hosts["checkout-api"];
    writeFileSync(join(api, "hooks", "pre-receive"),
      "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/aidlc/*|refs/heads/aidlc/*) echo \"no records here\" >&2; exit 1;; esac; done\nexit 0\n");
    chmodSync(join(api, "hooks", "pre-receive"), 0o755);
    // dana's team keeps its workspace on a host of its own.
    const dana = teamWorkspace(home.hosts, "dana", ["checkout-api", "billing"]);
    const teamHost = join(tempDir("dana-team"), "workspace.git");
    git(tempDir("dana-team-parent"), ["init", "-q", "--bare", "-b", "main", teamHost]);
    git(dana, ["remote", "add", "origin", teamHost]);
    git(dana, ["push", "-q", "-u", "origin", "main"]);
    const took = run(UNIT, ["take", "reporting", ...from, "--early"], dana);
    const starts = [
      { unit: "refunds", repos: [
        { repo: "checkout-api", branch: "refunds", head: git(api, ["rev-parse", "refunds"]) },
        { repo: "billing", branch: "refunds", head: git(home.hosts.billing, ["rev-parse", "refunds"]) },
      ] },
      { unit: "checkout-ui", repos: [] },
    ];
    return { home, api, dana, teamHost, took, starts };
  }

  const takeRow = (dir: string): string | null => {
    const build = buildOf(dir, "reporting")!;
    const row = readAuditShardEvents(dir, build.split(/[\\/]/).pop()!, "default").findLast((entry) => entry.event === "UNIT_TAKEN_IN");
    return row === undefined ? null : auditBlockField(row.block, "Early On");
  };

  test("the take goes ahead, and its take row holds where it started: two repositories of one dependency, none of the other", () => {
    const { home, dana, took, starts } = earlyTake();
    expect(took.status, took.out).toBe(0);
    expect(took.out).toContain("reporting is yours.");
    expect(buildOf(dana, "reporting")).not.toBeNull();
    expect(git(home.hosts["checkout-api"], ["for-each-ref", "--format=%(refname)", `refs/aidlc/claims/${home.id8}/reporting`])).toBe("");
    const [refunds] = starts;
    expect(takeRow(dana)).toBe(`refunds: checkout-api refunds ${refunds.repos[0].head}, billing refunds ${refunds.repos[1].head}; checkout-ui`);
    const build = unitBuildOf(readFileSync(join(buildOf(dana, "reporting")!, "aidlc-state.md"), "utf-8"))!;
    expect(unitTools.buildEarlyOn(dana, build)).toEqual(starts);
  });

  test("a teammate carrying the build on from the team's workspace reads the same starts", () => {
    const { home, dana, teamHost, took, starts } = earlyTake();
    expect(took.status, took.out).toBe(0);
    git(dana, ["add", "-A"]);
    git(dana, ["commit", "-q", "-m", "reporting taken"]);
    git(dana, ["push", "-q", "origin", "main"]);
    const dan = join(tempDir("dan-ws"), "workspace");
    git(tempDir("dan-parent"), ["clone", "-q", teamHost, dan]);
    git(dan, ["config", "user.name", "dan"]);
    git(dan, ["config", "user.email", "dan@example.test"]);
    for (const repo of ["checkout-api", "billing"]) cloneCode(home.hosts[repo], dan, repo, "dan");
    const carried = run(UNIT, ["take", "reporting", "--plan", home.id8, "--from", home.hosts["checkout-api"]], dan);
    expect(carried.status, carried.out).toBe(0);
    expect(carried.json).toMatchObject({ resumed: true });
    const build = unitBuildOf(readFileSync(join(buildOf(dan, "reporting")!, "aidlc-state.md"), "utf-8"))!;
    expect(unitTools.buildEarlyOn(dan, build)).toEqual(starts);
  });

  test("once its repository takes pushes from them, the take is written with the same starts", () => {
    const { home, api, dana, took, starts } = earlyTake();
    expect(took.status, took.out).toBe(0);
    writeFileSync(join(api, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
    next(dana);
    const record = recordAt(home, "reporting");
    expect(record?.message).toBe("aidlc unit reporting: taken early");
    expect(record?.json).toMatchObject({ status: "claimed", taken_by: "dana", early_on: starts });
  });
});

describe("solo work a teammate took, shared since", () => {
  test("the record stays in the workspace's own repository: the plan names it there, and the teammate's push writes on it", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing"), "checkout-web": codeHost("checkout-web") };
    const home = makeHome({ repos: hosts });
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "refunds", "Run floor": "0" }, home.dir);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "solo work under way"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const bob = cloneOf(home.remote, "bob");
    cloneCode(hosts["checkout-web"], bob, "checkout-web", "bob");
    const took = run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob);
    expect(took.status, took.out).toBe(0);
    const id8 = fixtureIntentId8(home.dir);
    const ref = `refs/aidlc/claims/${id8}/checkout-ui`;
    const taken = git(home.remote, ["rev-parse", ref]);
    // The lead's next step hears the take and goes to teams; the share puts the plan in checkout-api.
    next(home.dir);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const plan = JSON.parse(git(hosts["checkout-api"], ["show", `refs/aidlc/plans/${id8}:plan.json`])) as {
      units: Array<{ name: string; record: string }>; repos: Array<{ name: string; address: string | null }>;
    };
    const named = plan.units.find((unit) => unit.name === "checkout-ui")!.record;
    expect(plan.repos.find((repo) => repo.name === named)?.address).toBe(home.remote);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "shared"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    // The teammate's clone takes the lead's push, has no copy of the plan, and pushes checkout-ui.
    git(bob, ["pull", "-q", "--no-rebase", "origin", "main"]);
    const intents = join(bob, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-checkout-ui"))!);
    writeFileSync(join(bob, "checkout-web", "ui.tsx"), "export const ui = 1;\n");
    const stage = join(record, "construction", "checkout-ui", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "checkout-ui", version: 1, writes: [{ repo: "checkout-web", path: "ui.tsx" }],
    }, null, 2)}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\ncheckout-ui.\n");
    const pushed = run(UNIT, ["push"], bob);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["log", "-1", "--format=%s%x00%P", ref]).split("\0")).toEqual(["aidlc unit checkout-ui: pushed", taken]);
    // The plan's repository holds the lead's own record of refunds, started here, and none of checkout-ui.
    expect(git(hosts["checkout-api"], ["for-each-ref", "--format=%(refname)", `refs/aidlc/claims/${id8}/`])).toBe(`refs/aidlc/claims/${id8}/refunds`);
  });
});

describe("a person alone meets nothing of it", () => {
  test("solo work with a remote, one Unit at a time: its steps write no record anywhere and leave the remote as it was", () => {
    const home = makeHome({ repos: {} });
    const before = git(home.remote, ["for-each-ref"]);
    for (let step = 0; step < 3; step++) next(home.dir);
    expect(git(home.remote, ["for-each-ref", "--format=%(refname)", "refs/aidlc/"])).toBe("");
    expect(git(home.remote, ["for-each-ref"])).toBe(before);
  });
});
