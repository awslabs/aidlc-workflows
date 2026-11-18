// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:release, subcommand:aidlc-unit:adopt, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-unit:status
//
// Where a claim commit holds its claim file. A claim made by this release at
// the repository's top keeps it at the tree's top, where 2.11 and earlier
// write and read it; a claim a newer team writes holds it in the project's
// aidlc/ folder (aidlc/.aidlc-unit-claim.json). Every reader here reads the
// project's aidlc/ folder first, then the top, and every claim commit keeps the
// place its claim started in, so a team whose members run different releases
// works one claim. Neither place, nor a Unit's result folder
// (.aidlc-unit-result/) at either, is ever merged onto main by a landing.
// Built with real git: a remote, a lead's checkout and teams' clones; the
// newer team's claim is made here by rewriting the claim commit's tree with
// plumbing, as that release writes it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unitScopePath } from "../../dist/claude/.claude/tools/aidlc-record-core.ts";
import {
  cachedClaimFanoutActive,
  claimRegistryCachePath,
} from "../../dist/claude/.claude/tools/aidlc-unit-holders.ts";
import {
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
  tempDirs,
  UNIT,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS * 3);
afterEach(cleanupTempDirs);

const TOP = ".aidlc-unit-claim.json";
const NEW = "aidlc/.aidlc-unit-claim.json";

// The claim files a commit's tree holds.
function claimFiles(cwd: string, oid: string): string[] {
  return git(cwd, ["ls-tree", "-r", "--name-only", "--full-tree", oid, "--", TOP, NEW]).split("\n").filter(Boolean);
}

function claimTip(cwd: string, remote: string, unit: string): string {
  const listed = git(cwd, ["ls-remote", remote, `refs/heads/claim/*/${unit}`]);
  return listed.split(/\s+/)[0];
}

// Whether git has an object here, never fetching it.
function hereLocally(cwd: string, oid: string): boolean {
  return spawnSync("git", ["cat-file", "-e", oid], {
    cwd,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  }).status === 0;
}

// The scope stamp and registry cache a claim leaves in the claiming checkout.
function jsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// Rewrites a just-made claim as a newer team's release writes it: the claim
// commit's tree holds the file in the project's aidlc/ folder and none at the
// top. The claim ref, the claiming checkout's scope stamp and registry cache
// then name the rewritten commit.
function asNewStyle(checkout: string, unit: string): string {
  const stampPath = unitScopePath(checkout);
  const stamp = jsonFile(stampPath);
  const old = String(stamp.claim_oid);
  const ref = String(stamp.claim_ref);
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-claim-place-"));
  tempDirs.push(scratch);
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  const run = (args: string[], extra: Record<string, string> = {}): string => {
    const result = spawnSync("git", args, { cwd: checkout, encoding: "utf-8", env: { ...env, ...extra } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(["read-tree", old]);
  const blob = run(["rev-parse", `${old}:${TOP}`]);
  run(["update-index", "--add", "--cacheinfo", `100644,${blob},${NEW}`]);
  run(["update-index", "--force-remove", "--", TOP]);
  const tree = run(["write-tree"]);
  const [parents, name, email, date, message] = [
    run(["log", "-1", "--format=%P", old]),
    run(["log", "-1", "--format=%an", old]),
    run(["log", "-1", "--format=%ae", old]),
    run(["log", "-1", "--format=%aI", old]),
    run(["log", "-1", "--format=%B", old]),
  ];
  const rewritten = run(
    ["commit-tree", tree, ...parents.split(/\s+/).filter(Boolean).flatMap((parent) => ["-p", parent]), "-m", message],
    { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  );
  git(checkout, ["push", "-q", "--force", "origin", `${rewritten}:${ref}`]);
  git(checkout, ["fetch", "-q", "origin"]);
  writeFileSync(stampPath, `${JSON.stringify({ ...stamp, claim_oid: rewritten }, null, 2)}\n`);
  const cachePath = claimRegistryCachePath(checkout);
  if (existsSync(cachePath)) {
    const cache = jsonFile(cachePath) as { claims?: Record<string, { oid?: string }> };
    if (cache.claims?.[unit]) cache.claims[unit].oid = rewritten;
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  }
  return rewritten;
}

describe("a claim whose file is in the project's aidlc/ folder", () => {
  test("is published, pinned and landed, and the landing merges neither place onto main", () => {
    const { seed: lead, remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", { afterClaim: (dir) => asNewStyle(dir, "alpha") });
    // Publish kept the claim's place.
    expect(claimFiles(checkout, claimTip(checkout, remote, "alpha"))).toEqual([NEW]);
    git(lead, ["pull", "--no-rebase", "--no-edit", "origin", "main"]);
    gateAndLand(lead, "alpha");
    expect(git(lead, ["ls-tree", "-r", "--name-only", "HEAD", "--", TOP, NEW])).toBe("");
    expect(existsSync(join(lead, TOP)) || existsSync(join(lead, NEW))).toBe(false);
  });

  test("the lead's status reads it as claimed", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a", { afterClaim: (dir) => asNewStyle(dir, "alpha"), publish: false });
    git(lead, ["fetch", "-q", "origin"]);
    // The Stop hook's and next's read of the claims seen here, from the
    // fetched claim ref alone.
    expect(existsSync(claimRegistryCachePath(lead))).toBe(false);
    expect(cachedClaimFanoutActive(lead)).toBe(true);
    const status = runMergeTool(UNIT, ["status"], lead);
    expect(status.status, status.out).toBe(0);
    expect(JSON.stringify(JSON.parse(status.stdout))).toContain('"alpha"');
    expect(JSON.parse(status.stdout).claimable ?? []).not.toContain("alpha");
  });

  test("a fresh clone adopts it from the checked-out claim and publishes at the same place", () => {
    const { remote } = makeSeed();
    const owner = clone(remote, "place-owner");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "place-team"], owner);
    expect(claimed.status, claimed.out).toBe(0);
    asNewStyle(owner, "alpha");
    const ref = JSON.parse(claimed.stdout).claim_ref as string;
    const teammate = clone(remote, "place-teammate");
    git(teammate, ["fetch", "origin", `+${ref}:${ref}`]);
    git(teammate, ["switch", ref.replace("refs/heads/", "")]);
    const adopted = runMergeTool(UNIT, ["adopt", "alpha"], teammate);
    expect(adopted.status, adopted.out).toBe(0);
    writeFileSync(join(teammate, "adopted.txt"), "continued by the teammate\n");
    git(teammate, ["add", "adopted.txt"]);
    git(teammate, ["commit", "-q", "-m", "continue the adopted Unit"]);
    const published = runMergeTool(UNIT, ["publish", "alpha"], teammate);
    expect(published.status, published.out).toBe(0);
    expect(published.out).not.toContain("claim registry is unavailable");
    expect(claimFiles(teammate, claimTip(teammate, remote, "alpha"))).toEqual([NEW]);
  });

  test("a release, and a claim made again after it, keep the place", () => {
    const { seed: lead, remote } = makeSeed();
    const owner = clone(remote, "place-release");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "place-release"], owner);
    expect(claimed.status, claimed.out).toBe(0);
    asNewStyle(owner, "alpha");
    git(lead, ["fetch", "-q", "origin"]);
    const released = runMergeTool(UNIT, ["release", "alpha"], lead);
    expect(released.status, released.out).toBe(0);
    expect(claimFiles(lead, claimTip(lead, remote, "alpha"))).toEqual([NEW]);
    const again = clone(remote, "place-again");
    const reclaimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "place-again"], again);
    expect(reclaimed.status, reclaimed.out).toBe(0);
    expect(claimFiles(again, claimTip(again, remote, "alpha"))).toEqual([NEW]);
  });
});

describe("a claim whose file is in the project's aidlc/ folder, from a blobless partial clone", () => {
  test("with its commit fetched and its claim file not: the file is fetched, and the release keeps its place", () => {
    const { remote } = makeSeed();
    git(remote, ["config", "uploadpack.allowFilter", "true"]);
    const partial = join(mkdtempSync(join(tmpdir(), "aidlc-claim-place-partial-")), "c");
    tempDirs.push(join(partial, ".."));
    git(tmpdir(), ["clone", "-q", "--filter=blob:none", "--no-local", pathToFileURL(remote).href, partial]);
    git(partial, ["config", "user.name", "place-partial"]);
    git(partial, ["config", "user.email", "place-partial@example.test"]);
    const owner = clone(remote, "place-partial-owner");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "place-partial-owner"], owner);
    expect(claimed.status, claimed.out).toBe(0);
    const tip = asNewStyle(owner, "alpha");
    const blob = git(owner, ["rev-parse", `${tip}:${NEW}`]);
    git(partial, ["fetch", "-q", "origin"]);
    expect(hereLocally(partial, tip)).toBe(true);
    expect(hereLocally(partial, blob)).toBe(false);
    const released = runMergeTool(UNIT, ["release", "alpha"], partial, false, { GIT_NO_LAZY_FETCH: "1" });
    expect(released.status, released.out).toBe(0);
    expect(released.out).not.toContain("missing the claim payload blob");
    expect(hereLocally(partial, blob)).toBe(true);
    expect(claimFiles(partial, claimTip(partial, remote, "alpha"))).toEqual([NEW]);
  });
});

describe("a claim this release makes at the repository's top", () => {
  test("keeps its file at the tree's top through publish, as 2.11 reads it", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a");
    expect(claimFiles(checkout, claimTip(checkout, remote, "alpha"))).toEqual([TOP]);
  });

  test("with a hand-made claim file in main's aidlc/ folder: the claim holds only its own, and main keeps that file", () => {
    const { seed: lead, remote } = makeSeed();
    const stray = `${JSON.stringify({ unit: "beta", intent_uuid: "another" })}\n`;
    writeFileSync(join(lead, ...NEW.split("/")), stray);
    git(lead, ["add", "-f", "--", NEW]);
    git(lead, ["commit", "-q", "-m", "a claim file made by hand"]);
    git(lead, ["push", "-q", "origin", "main"]);
    const { checkout } = prepareCandidate(remote, "alpha", "team-a");
    expect(claimFiles(checkout, claimTip(checkout, remote, "alpha"))).toEqual([TOP]);
    git(lead, ["pull", "--no-rebase", "--no-edit", "origin", "main"]);
    gateAndLand(lead, "alpha");
    expect(git(lead, ["ls-tree", "-r", "--name-only", "HEAD", "--", TOP, NEW])).toBe(NEW);
    expect(readFileSync(join(lead, ...NEW.split("/")), "utf-8")).toBe(stray);
  });
});

describe("a Unit's result folder in a candidate", () => {
  test("is merged onto main at neither place, and left on the lead's disk at neither", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a", {
      beforePublish: (checkout) => {
        for (const folder of [".aidlc-unit-result", "aidlc/.aidlc-unit-result"]) {
          mkdirSync(join(checkout, ...folder.split("/"), "amendments"), { recursive: true });
          writeFileSync(join(checkout, ...folder.split("/"), "amendments", "x.md"), "a team's amendment\n");
        }
        git(checkout, ["add", "-f", "--", ".aidlc-unit-result", "aidlc/.aidlc-unit-result"]);
        git(checkout, ["commit", "-q", "-m", "a result the team's release writes"]);
      },
    });
    git(lead, ["pull", "--no-rebase", "--no-edit", "origin", "main"]);
    gateAndLand(lead, "alpha");
    expect(git(lead, ["ls-tree", "-r", "--name-only", "HEAD", "--", ".aidlc-unit-result", "aidlc/.aidlc-unit-result"])).toBe("");
    expect(existsSync(join(lead, ".aidlc-unit-result"))).toBe(false);
    expect(existsSync(join(lead, "aidlc", ".aidlc-unit-result"))).toBe(false);
  });
});
