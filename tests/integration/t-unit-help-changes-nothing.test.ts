// covers: subcommand:aidlc-unit:adopt, subcommand:aidlc-unit:claim, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, subcommand:aidlc-unit:merge-status, subcommand:aidlc-unit:participate, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:release, subcommand:aidlc-unit:share, subcommand:aidlc-unit:status, subcommand:aidlc-utility:claim
//
// `--help` or `-h` on a Unit command prints its usage and changes nothing, and a
// word the command does not take is named with that usage before anything runs
// (#3607): `unit share --help` used to commit the checkout and push main, and
// `unit claim alpha --help` claimed the Unit. Each case runs in a team
// workspace with an origin and checks that HEAD, the index, every file, every
// ref and the origin's refs are as they were. Every verb in UNIT_VERBS is run,
// so a new verb is covered here or fails. Known arguments still act.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { UNIT_VERBS } from "../../dist/claude/.claude/tools/aidlc-command.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  builtOnce,
  cleanupTempDirs,
  cleanupWorlds,
  clone,
  git,
  makeSeed,
  runMergeTool,
  UNIT,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);
afterAll(cleanupWorlds);

const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");

// The lead's checkout of team work with an origin and a teammate's clone that
// holds the claim on alpha. Nothing here has been shared since the plan.
const world = builtOnce(() => {
  const { seed: lead, remote } = makeSeed();
  const mate = clone(remote, "mate");
  const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "team-a"], mate);
  expect(claimed.status, claimed.out).toBe(0);
  return { lead, remote, mate };
});

function fileHashes(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (dir === root && name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) fileHashes(path, root, out);
    else out.push(`${relative(root, path)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
  }
  return out;
}

// Everything a Unit command could change: the commit, the index, the files
// (ignored ones included), this checkout's refs and the origin's.
function snapshot(checkout: string, remote: string): Record<string, string> {
  return {
    head: git(checkout, ["rev-parse", "HEAD"]),
    index: git(checkout, ["write-tree"]),
    status: git(checkout, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]),
    refs: git(checkout, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    origin: git(remote, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    files: fileHashes(checkout).sort().join("\n"),
  };
}

type Run = { status: number; stdout: string; stderr: string };

function unitTool(args: string[], cwd: string): Run {
  const run = runMergeTool(UNIT, args, cwd);
  return { status: run.status, stdout: run.stdout, stderr: run.out.slice(run.stdout.length) };
}

function dispatcher(args: string[], cwd: string): Run {
  const run = spawnSync(process.execPath, [DISPATCHER, ...args, "--project-dir", cwd], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" },
  });
  return { status: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function unchangedBy(checkout: string, remote: string, run: () => Run): Run {
  const before = snapshot(checkout, remote);
  const result = run();
  const after = snapshot(checkout, remote);
  for (const key of Object.keys(before)) {
    expect(after[key], `${key} changed\n${result.stdout}${result.stderr}`).toBe(before[key]);
  }
  return result;
}

function expectUsage(result: Run, verb: string): void {
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toMatch(new RegExp(`^usage: \\S.* unit ${verb}( .*)?\\n$`));
}

function expectRefused(result: Run, verb: string, word: string): void {
  expect(result.status, result.stdout + result.stderr).toBe(2);
  expect(result.stdout).toBe("");
  const error = JSON.parse(result.stderr.trim()) as { error: string; usage: string };
  expect(error.error).toBe(`unit ${verb} does not take ${word.startsWith("-") ? word : JSON.stringify(word)}`);
  expect(error.usage).toMatch(new RegExp(`^\\S.* unit ${verb}( |$)`));
}

// Where each verb would act today: publish acts in the clone that holds the
// claim; the others on the lead's unscoped main.
function checkoutFor(verb: string, w: { lead: string; mate: string }): string {
  return verb === "publish" || verb === "adopt" ? w.mate : w.lead;
}

describe("every Unit command's --help and -h print its usage and change nothing", () => {
  for (const [verb, takesName] of UNIT_VERBS) {
    test(`unit ${verb}`, () => {
      const w = world();
      const checkout = checkoutFor(verb, w);
      writeFileSync(join(checkout, "notes.txt"), "a note nobody asked to share\n");
      const name = takesName ? ["alpha"] : [];
      for (const help of ["--help", "-h"]) {
        expectUsage(unchangedBy(checkout, w.remote, () => unitTool([verb, ...name, help], checkout)), verb);
      }
      // Ahead of the Unit name too, and next to the options a verb reads.
      if (takesName) {
        expectUsage(unchangedBy(checkout, w.remote, () => unitTool([verb, "--help", "alpha"], checkout)), verb);
      }
      expectRefused(unchangedBy(checkout, w.remote, () => unitTool([verb, ...name, "--bogus"], checkout)), verb, "--bogus");
      expectRefused(unchangedBy(checkout, w.remote, () => unitTool([verb, ...name, "extra"], checkout)), verb, "extra");
    });
  }
});

describe("the doors a person or the agent types reach the same check", () => {
  test("aidlc unit, aidlc --claim and a launcher flag", () => {
    const w = world();
    writeFileSync(join(w.lead, "notes.txt"), "a note nobody asked to share\n");
    expectUsage(unchangedBy(w.lead, w.remote, () => dispatcher(["unit", "share", "--help"], w.lead)), "share");
    expectUsage(unchangedBy(w.lead, w.remote, () => dispatcher(["unit", "--json", "share", "-h"], w.lead)), "share");
    expectUsage(unchangedBy(w.lead, w.remote, () => dispatcher(["unit", "claim", "beta", "--help"], w.lead)), "claim");
    expectUsage(unchangedBy(w.lead, w.remote, () => dispatcher(["--claim", "beta", "--help"], w.lead)), "claim");
    expectRefused(
      unchangedBy(w.lead, w.remote, () => dispatcher(["unit", "claim", "beta", "--tem", "Alice"], w.lead)),
      "claim",
      "--tem",
    );
    // The launcher's own flags, which it hands on, stay every verb's.
    const status = dispatcher(["unit", "status", "--json"], w.lead);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toHaveProperty("claimed");
  });
});

// A switch takes no value, so the word after it is never read as its value:
// `-h` there is still a request for the usage, and any other word is one the
// verb does not take.
describe("a switch never takes the next word", () => {
  test("publish --commit, land --accept-released-attempt and a launcher flag", () => {
    const w = world();
    writeFileSync(join(w.mate, "notes.txt"), "a note nobody asked to publish\n");
    writeFileSync(join(w.lead, "notes.txt"), "a note nobody asked to share\n");
    expectUsage(unchangedBy(w.mate, w.remote, () => unitTool(["publish", "alpha", "--commit", "-h"], w.mate)), "publish");
    expectRefused(
      unchangedBy(w.mate, w.remote, () => unitTool(["publish", "alpha", "--commit", "extra"], w.mate)),
      "publish",
      "extra",
    );
    expectUsage(
      unchangedBy(w.mate, w.remote, () => unitTool(["publish", "alpha", "--commit", "--include", ".", "-h"], w.mate)),
      "publish",
    );
    expectUsage(
      unchangedBy(w.lead, w.remote, () => unitTool(["land", "alpha", "--accept-released-attempt", "-h"], w.lead)),
      "land",
    );
    expectUsage(unchangedBy(w.lead, w.remote, () => unitTool(["share", "--yes", "-h"], w.lead)), "share");
    expectRefused(unchangedBy(w.lead, w.remote, () => unitTool(["share", "--yes", "now"], w.lead)), "share", "now");
  });
});

describe("known arguments act as before", () => {
  test("share with no words commits and pushes; release reads --expect-nonce", () => {
    const w = world();
    const released = unitTool(["release", "alpha", "--expect-nonce", "not-the-nonce"], w.lead);
    expect(released.status, released.stderr).toBe(1);
    expect(released.stderr).toContain("current claim nonce does not match --expect-nonce");
    writeFileSync(join(w.lead, "notes.txt"), "a note to share\n");
    const shared = unitTool(["share"], w.lead);
    expect(shared.status, shared.stderr).toBe(0);
    expect(JSON.parse(shared.stdout)).toMatchObject({ shared: true, branch: "main", remote: "origin" });
    expect(git(w.remote, ["rev-parse", "main"])).toBe(git(w.lead, ["rev-parse", "HEAD"]));
    expect(git(w.lead, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  test("a teammate's claim with --team and --rhythm still claims", () => {
    const { remote } = makeSeed();
    const other = clone(remote, "other");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "team-b", "--rhythm", "unit-end"], other);
    expect(claimed.status, claimed.out).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ claimed: true, unit: "alpha", owner: "team-b" });
  });
});
