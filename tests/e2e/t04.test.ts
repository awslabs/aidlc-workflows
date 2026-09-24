// covers: subcommand:aidlc-worktree:discard
//
// CLI-contract port of tests/e2e/t04-worktree-discard-list-verify.sh
// (TAP plan 12), mechanism = cli. The .sh exercises three read/destructive
// subcommands of aidlc-worktree.ts — discard, list, verify — but the single
// covers UNIT credited for this port is subcommand:aidlc-worktree:discard
// (the destructive one with the audit-first WORKTREE_DISCARDED emit + real
// git worktree-remove + branch -D side effects). list and verify are still
// asserted at full strength so parity is equal-or-stronger; they just aren't
// the credited id.
//
// MECHANISM: this is a .cli file, so every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status / res.stdout / res.stderr and the on-disk worktree
// state the tool mutates. An in-process twin would lose the stdout-JSON
// contract ('"emitted":"WORKTREE_DISCARDED"', '"verified":true',
// '"reason":"absent"', '"reason":"stale ...') and the real
// git-worktree-remove + branch-delete effects the .sh relies on.
//
// FIXTURE: aidlc-worktree.ts asserts discard runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts:459->101) and runs real git, so
// each case needs an ACTUAL git repo on `main` with one commit plus an
// aidlc-docs/ dir. setupWorktreeFixture (tests/harness/fixtures.ts) builds
// exactly that; the tool is spawned with cwd = the fixture so its
// `git rev-parse --show-toplevel` resolves to the main checkout. The .sh's
// inline `git -C "$FIX2" worktree add -q ... -b unrelated` (the non-bolt
// worktree the list filter must exclude) is reproduced via spawnSync("git",
// ...) below. cleanupWorktreeFixture prunes child worktrees then rm -rf's the
// parent. Nothing is written under tests/fixtures/**.
//
// PARITY NOTES — every .sh assertion has an equal-or-stronger counterpart:
//   .sh T1  discard exits 0                                   -> Test "1-4" (same)
//   .sh T2  stdout '"emitted":"WORKTREE_DISCARDED"'            -> Test "1-4" (same)
//   .sh T3  discard removed the worktree directory            -> Test "1-4" (same)
//   .sh T4  second discard on gone slug exits 0 (idempotent)   -> Test "1-4" (same)
//   .sh T5  list exits 0                                       -> Test "5-7" (same)
//   .sh T6  list includes '"slug":"listed"'                    -> Test "5-7" (same)
//   .sh T7  list excludes "non-bolt-wt"                        -> Test "5-7" (same)
//   .sh T8  verify (present) exits 0                           -> Test "8-9" (same)
//   .sh T9  verify (present) '"verified":true'                 -> Test "8-9" (same)
//   .sh T10 verify (absent slug) exits non-zero                -> Test "10-11" (same)
//   .sh T11 verify (absent slug) '"reason":"absent"'           -> Test "10-11" (same)
//   .sh T12 verify --max-age-seconds 0 -> non-zero + reason="stale -> Test "12" (same)
//
// 12 .sh asserts -> 12+ expect()s across 4 test() cases (grouped where the .sh
// shared one fixture). STRONGER additions:
//   * T4 also asserts the idempotent second discard prints emitted:null with
//     reason "already-discarded" (the .sh only checked the exit code; the
//     handler's no-op contract — aidlc-worktree.ts:470-480 — is now pinned).
//   * T1-4 also asserts the Bolt branch is gone, proving discard deletes the
//     branch as well as the directory.
//   * T12 also asserts the verify (present, default window) case still passes
//     in the SAME fixture before the max-age=0 stale check, isolating that the
//     non-zero is the window, not an absent event.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import {
  boltName,
  createIntent,
  gitCommitSourceListing,
  serializeSourceListing,
  sourceListingSha256,
  worktreePath,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  cleanupWorktreeFixture,
  fixtureIntentId8,
  seededRecordDir,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const fixtures: string[] = [];
// Every case owns its fixtures. Avoid accumulating all worktrees for one
// cleanup hook, and release their disk space before the next case starts.
afterEach(() => {
  while (fixtures.length > 0) cleanupWorktreeFixture(fixtures.pop()!);
});

/** Fresh git-repo fixture on `main` + aidlc-docs/, registered for cleanup. */
function freshFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-worktree.ts <sub> ... --project-dir <p>` from cwd=<p>. */
function wt(p: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

const wtPath = (p: string, slug: string): string =>
  worktreePath(p, fixtureIntentId8(p), slug);

/** True iff a local branch ref exists in the fixture repo. */
function branchExists(p: string, branch: string): boolean {
  const r = spawnSync(
    "git",
    ["-C", p, "rev-parse", "--verify", `refs/heads/${branch}`],
    { encoding: "utf-8" },
  );
  return r.status === 0;
}

function git(p: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: p, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Plant the pre-upgrade metadata and audit provenance, without the new identity fields. */
function plantLegacyBolt(p: string): { dir: string; branch: string } {
  const branch = "bolt-demo";
  const dir = join(p, ".aidlc", "worktrees", branch);
  const baseCommit = git(p, "rev-parse", "main");
  const listing = gitCommitSourceListing(p, baseCommit, true, true);
  if (listing === null) throw new Error("Cannot snapshot legacy Bolt base");
  const serialized = serializeSourceListing(listing);
  const baseSourceListing = `sha256:${sourceListingSha256(serialized)}`;
  const commonDir = realpathSync(resolve(p, git(p, "rev-parse", "--git-common-dir")))
    .replaceAll("\\", "/");
  const intentRecord = relative(p, seededRecordDir(p)).replaceAll("\\", "/");
  git(p, "worktree", "add", "-q", dir, "-b", branch, "main");
  mkdirSync(join(dir, ".aidlc"), { recursive: true });
  writeFileSync(join(dir, ".aidlc", "base-source-listing.tsv"), serialized);
  writeFileSync(join(dir, ".aidlc", "worktree-meta.json"), `${JSON.stringify({
    version: 1,
    boltSlug: "demo",
    baseBranch: "main",
    baseCommit,
    baseSourceListing,
    repoSelector: null,
    gitCommonDirHash: createHash("sha256")
      .update(process.platform === "win32" ? commonDir.toLowerCase() : commonDir)
      .digest("hex"),
    intentRecord,
  }, null, 2)}\n`);
  appendAuditEntry("WORKTREE_CREATED", {
    "Bolt slug": "demo",
    "Worktree path": relative(p, dir).replaceAll("\\", "/"),
    "Branch name": branch,
    "Base branch": "main",
    "Base commit": baseCommit,
    "Base Source Listing": baseSourceListing,
    Repo: "-",
    "Intent record": intentRecord,
  }, p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
  return { dir, branch };
}

function plantConflictingLegacyBolt(p: string): { dir: string; branch: string; sourceCommit: string } {
  const legacy = plantLegacyBolt(p);
  writeFileSync(join(legacy.dir, "README.md"), "legacy Bolt source\n");
  git(legacy.dir, "add", "README.md");
  git(legacy.dir, "commit", "-qm", "legacy Bolt change");
  const sourceCommit = git(legacy.dir, "rev-parse", "HEAD");
  writeFileSync(join(p, "README.md"), "target source\n");
  git(p, "add", "README.md");
  git(p, "commit", "-qm", "conflicting target change");
  return { ...legacy, sourceCommit };
}

describe("t04 aidlc-worktree discard/list/verify (migrated from t04-worktree-discard-list-verify.sh, plan 12)", () => {
  test("1-4: discard removes worktree + branch, emits WORKTREE_DISCARDED, idempotent on re-run", () => {
    const p = freshFixture();
    // Seed a worktree to discard.
    const created = wt(p, ["create", "--slug", "demo", "--base", "main"]);
    expect(created.status).toBe(0);
    expect(existsSync(wtPath(p, "demo"))).toBe(true);

    const r = wt(p, ["discard", "--slug", "demo"]);
    expect(r.status).toBe(0); // T1
    expect(r.out).toContain('"emitted":"WORKTREE_DISCARDED"'); // T2
    expect(existsSync(wtPath(p, "demo"))).toBe(false); // T3
    // Discard deletes the branch as well as its checkout.
    expect(branchExists(p, boltName(fixtureIntentId8(p), "demo"))).toBe(false);

    // T4: second discard on the now-gone slug exits 0 (idempotent).
    const r2 = wt(p, ["discard", "--slug", "demo"]);
    expect(r2.status).toBe(0);
    // STRONGER: the no-op path emits null + reason already-discarded
    // (aidlc-worktree.ts:470-480).
    expect(r2.out).toContain('"emitted":null');
    expect(r2.out).toContain('"reason":"already-discarded"');
  });

  test("5-7: list returns only bolt-* worktrees under the framework dir", () => {
    const p = freshFixture();
    // Add a NON-bolt worktree to confirm the filter excludes it (mirrors the
    // .sh's `git -C "$FIX2" worktree add -q "$FIX2/non-bolt-wt" -b unrelated`).
    const add = spawnSync(
      "git",
      ["-C", p, "worktree", "add", "-q", join(p, "non-bolt-wt"), "-b", "unrelated"],
      { encoding: "utf-8" },
    );
    expect(add.status).toBe(0);

    const created = wt(p, ["create", "--slug", "listed", "--base", "main"]);
    expect(created.status).toBe(0);

    const r = wt(p, ["list"]);
    expect(r.status).toBe(0); // T5
    expect(r.out).toContain('"slug":"listed"'); // T6
    expect(r.out).not.toContain("non-bolt-wt"); // T7
  });

  test("8-9: verify finds the most recent matching event within the window", () => {
    const p = freshFixture();
    const created = wt(p, ["create", "--slug", "ver", "--base", "main"]);
    expect(created.status).toBe(0);

    const r = wt(p, ["verify", "--event", "WORKTREE_CREATED", "--slug", "ver"]);
    expect(r.status).toBe(0); // T8
    expect(r.out).toContain('"verified":true'); // T9
  });

  test("10-12: verify reports absent for a missing slug and stale for an out-of-window event", () => {
    const p = freshFixture();
    const created = wt(p, ["create", "--slug", "ver", "--base", "main"]);
    expect(created.status).toBe(0);

    // T10-11: verify on a slug that never emitted WORKTREE_CREATED.
    const absent = wt(p, ["verify", "--event", "WORKTREE_CREATED", "--slug", "other"]);
    expect(absent.status).not.toBe(0); // T10
    expect(absent.out).toContain('"reason":"absent"'); // T11

    // STRONGER: the present event still verifies within the default window —
    // isolates that the stale failure below is the window, not an absent event.
    const present = wt(p, ["verify", "--event", "WORKTREE_CREATED", "--slug", "ver"]);
    expect(present.status).toBe(0);
    expect(present.out).toContain('"verified":true');

    // T12: --max-age-seconds 0 makes even the fresh entry stale.
    const stale = wt(p, [
      "verify",
      "--event",
      "WORKTREE_CREATED",
      "--slug",
      "ver",
      "--max-age-seconds",
      "0",
    ]);
    expect(stale.status).not.toBe(0);
    expect(stale.out).toContain('"reason":"stale');
  });

  test("two intents in one checkout create the same slug with distinct list identities", () => {
    const p = freshFixture();
    const intentA = DEFAULT_RECORD_DIR;
    const idA = fixtureIntentId8(p, intentA, DEFAULT_SPACE);
    const intentB = createIntent(p, "other-intent", DEFAULT_SPACE);
    const idB = fixtureIntentId8(p, intentB.dirName, DEFAULT_SPACE);
    for (const intent of [intentA, intentB.dirName]) {
      const created = wt(p, ["create", "--slug", "demo", "--base", "main", "--intent", intent, "--space", DEFAULT_SPACE]);
      expect(created.status, created.out).toBe(0);
    }

    const listed = wt(p, ["list"]);
    expect(listed.status, listed.out).toBe(0);
    expect(idA).not.toBe(idB);
    const rows = JSON.parse(listed.stdout).worktrees;
    expect(rows).toHaveLength(2);
    for (const id8 of [idA, idB]) {
      expect(rows).toContainEqual(expect.objectContaining({
        slug: "demo",
        branch: boltName(id8, "demo"),
        worktree_path: worktreePath(p, id8, "demo").replaceAll("\\", "/"),
        intent_id8: id8,
        legacy: false,
      }));
      expect(existsSync(worktreePath(p, id8, "demo"))).toBe(true);
    }
  });

  test("legacy merge conflict can be resolved and retried without stranding the branch", () => {
    // R4(a): WORKTREE_MERGED is audit-of-intent, not proof that the legacy checkout closed.
    const p = freshFixture();
    const legacy = plantConflictingLegacyBolt(p);
    const failed = wt(p, ["merge", "--slug", "demo", "--target", "main", "--strategy", "squash"]);
    expect(failed.status, failed.out).not.toBe(0);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "conflict", conflict_files: ["README.md"] });
    expect(existsSync(legacy.dir)).toBe(true);
    expect(git(p, "rev-parse", legacy.branch)).toBe(legacy.sourceCommit);

    // Resolve on the Bolt, so the retry performs a real source merge rather than a no-op commit.
    git(p, "reset", "--hard", "HEAD");
    const conflict = spawnSync("git", ["merge", "--no-commit", "main"], { cwd: legacy.dir, encoding: "utf-8" });
    expect(conflict.status).not.toBe(0);
    expect(git(legacy.dir, "diff", "--name-only", "--diff-filter=U")).toBe("README.md");
    writeFileSync(join(legacy.dir, "README.md"), "resolved target and legacy Bolt source\n");
    git(legacy.dir, "add", "README.md");
    git(legacy.dir, "commit", "-qm", "resolve legacy Bolt conflict");

    const retried = wt(p, ["merge", "--slug", "demo", "--target", "main", "--strategy", "squash"]);
    expect(retried.status, retried.out).toBe(0);
    expect(JSON.parse(retried.stdout).emitted).toBe("WORKTREE_MERGED");
    expect(readFileSync(join(p, "README.md"), "utf-8")).toBe("resolved target and legacy Bolt source\n");
    expect(existsSync(legacy.dir)).toBe(false);
    expect(branchExists(p, legacy.branch)).toBe(false);
    expect(git(p, "for-each-ref", "--format=%(refname)", "refs/aidlc/reviewed-source/demo/")).toBe("");
  });

  test("legacy swarm cleanup-only merge removes the landed branch and retained source refs", () => {
    // R4(b): a landed swarm source remains cleanable after WORKTREE_MERGED and directory removal.
    const p = freshFixture();
    const legacy = plantLegacyBolt(p);
    writeFileSync(join(legacy.dir, "landed.txt"), "legacy reviewed source\n");
    git(legacy.dir, "add", "landed.txt");
    git(legacy.dir, "commit", "-qm", "legacy reviewed source");
    const sourceCommit = git(legacy.dir, "rev-parse", "HEAD");
    const retainedRef = `refs/aidlc/reviewed-source/demo/${sourceCommit}`;
    git(p, "update-ref", retainedRef, sourceCommit);
    const authority = {
      "Batch number": "1",
      "Unit name": "demo",
      Stage: "code-generation",
      "Run floor": "2026-01-01T00:00:00Z",
      "Source Commit": sourceCommit,
    };
    appendAuditEntry("SWARM_UNIT_CONVERGED", authority, p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    appendAuditEntry("WORKTREE_MERGED", {
      "Bolt slug": "demo",
      "Worktree path": relative(p, legacy.dir).replaceAll("\\", "/"),
      "Target branch": "main",
      Strategy: "merge",
    }, p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    git(p, "merge", "--ff-only", legacy.branch);
    appendAuditEntry("SWARM_SOURCE_MERGED", {
      ...authority,
      "Merge commit": sourceCommit,
      Repo: "-",
    }, p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    git(p, "worktree", "remove", "--force", legacy.dir);
    expect(branchExists(p, legacy.branch)).toBe(true);
    expect(git(p, "rev-parse", retainedRef)).toBe(sourceCommit);

    const create = wt(p, ["create", "--slug", "demo", "--base", "main"]);
    expect(create.status, create.out).not.toBe(0);
    expect(create.out).toContain("Legacy Bolt demo left branch bolt-demo and 1 retained refs behind");
    expect(create.out).toContain("run discard --slug demo under its intent");
    expect(existsSync(wtPath(p, "demo"))).toBe(false);
    expect(git(p, "rev-parse", legacy.branch)).toBe(sourceCommit);
    expect(git(p, "rev-parse", retainedRef)).toBe(sourceCommit);

    const retried = wt(p, ["merge", "--slug", "demo", "--target", "main", "--strategy", "merge"]);
    expect(retried.status, retried.out).toBe(0);
    expect(JSON.parse(retried.stdout)).toMatchObject({
      emitted: null, cleanup_reconciled: true, source_authority: sourceCommit,
    });
    expect(git(p, "rev-parse", "main")).toBe(sourceCommit);
    expect(readFileSync(join(p, "landed.txt"), "utf-8")).toBe("legacy reviewed source\n");
    expect(existsSync(legacy.dir)).toBe(false);
    expect(branchExists(p, legacy.branch)).toBe(false);
    expect(git(p, "for-each-ref", "--format=%(refname)", "refs/aidlc/reviewed-source/demo/")).toBe("");
  });

  test("a completed legacy merge never lets discard claim a later attempt's reuse of the legacy name", () => {
    // After A's legacy merge fully completed, the only lifecycle frontier A has
    // is WORKTREE_MERGED. A pre-upgrade intent B may then have reused the global
    // `bolt-demo` name and left an unchecked-out branch behind. A's discard has
    // no recorded parked tip to check against, so it must refuse rather than park
    // and delete B's branch; the cleanup-only merge retry refuses too because the
    // tip is not A's landed source.
    const p = freshFixture();
    const legacy = plantLegacyBolt(p);
    writeFileSync(join(legacy.dir, "landed.txt"), "legacy reviewed source\n");
    git(legacy.dir, "add", "landed.txt");
    git(legacy.dir, "commit", "-qm", "legacy reviewed source");
    const sourceCommit = git(legacy.dir, "rev-parse", "HEAD");
    const authority = {
      "Batch number": "1",
      "Unit name": "demo",
      Stage: "code-generation",
      "Run floor": "2026-01-01T00:00:00Z",
      "Source Commit": sourceCommit,
    };
    appendAuditEntry("SWARM_UNIT_CONVERGED", authority, p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    appendAuditEntry("WORKTREE_MERGED", {
      "Bolt slug": "demo",
      "Worktree path": relative(p, legacy.dir).replaceAll("\\", "/"),
      "Target branch": "main",
      Strategy: "merge",
    }, p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    git(p, "merge", "--ff-only", legacy.branch);
    appendAuditEntry("SWARM_SOURCE_MERGED", {
      ...authority,
      "Merge commit": sourceCommit,
      Repo: "-",
    }, p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    // A's cleanup completed: checkout and branch gone.
    git(p, "worktree", "remove", "--force", legacy.dir);
    git(p, "branch", "-D", legacy.branch);

    // B reused the legacy name, did work, and only its unchecked-out branch and
    // retained ref remain (its own records live elsewhere).
    git(p, "branch", legacy.branch, "main");
    git(p, "worktree", "add", "-q", join(p, "scratch-b"), legacy.branch);
    writeFileSync(join(p, "scratch-b", "b.txt"), "intent B work\n");
    git(join(p, "scratch-b"), "add", "b.txt");
    git(join(p, "scratch-b"), "commit", "-qm", "intent B work");
    git(p, "worktree", "remove", "--force", join(p, "scratch-b"));
    const bTip = git(p, "rev-parse", legacy.branch);
    const bRetained = `refs/aidlc/reviewed-source/demo/${bTip}`;
    git(p, "update-ref", bRetained, bTip);
    expect(bTip).not.toBe(sourceCommit);

    const discarded = wt(p, ["discard", "--slug", "demo"]);
    expect(discarded.status, discarded.out).not.toBe(0);
    expect(discarded.out).toContain("recorded a merge; finish it with merge --slug demo");
    const retried = wt(p, ["merge", "--slug", "demo", "--target", "main", "--strategy", "merge"]);
    expect(retried.status, retried.out).not.toBe(0);
    expect(retried.out).toContain("moved after source landing");
    expect(git(p, "rev-parse", legacy.branch)).toBe(bTip);
    expect(git(p, "rev-parse", bRetained)).toBe(bTip);
    expect(git(p, "for-each-ref", "--format=%(refname)", "refs/aidlc/parked/demo/")).toBe("");
  });

  test("discard after a failed legacy merge parks source and removes the checkout, branch and review refs", () => {
    // R4(c): the failed merge's terminal audit row must not strand a live legacy Bolt.
    const p = freshFixture();
    const legacy = plantConflictingLegacyBolt(p);
    const failed = wt(p, ["merge", "--slug", "demo", "--target", "main", "--strategy", "squash"]);
    expect(failed.status, failed.out).not.toBe(0);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "conflict", conflict_files: ["README.md"] });
    git(p, "reset", "--hard", "HEAD");
    // Retained review evidence requires swarm merge authority, so add it only after the ordinary merge fails.
    git(p, "update-ref", `refs/aidlc/reviewed-source/demo/${legacy.sourceCommit}`, legacy.sourceCommit);

    const discarded = wt(p, ["discard", "--slug", "demo"]);
    expect(discarded.status, discarded.out).toBe(0);
    const parked = JSON.parse(discarded.stdout);
    expect(parked.emitted).toBe("WORKTREE_DISCARDED");
    expect(parked.parked_ref.startsWith("refs/aidlc/parked/demo/")).toBe(true);
    expect(git(p, "show", `${parked.parked_ref}/head:README.md`)).toBe("legacy Bolt source");
    expect(git(p, "rev-parse", `${parked.parked_ref}/reviewed-source/${legacy.sourceCommit}`)).toBe(legacy.sourceCommit);
    expect(readFileSync(join(p, "README.md"), "utf-8")).toBe("target source\n");
    expect(existsSync(legacy.dir)).toBe(false);
    expect(branchExists(p, legacy.branch)).toBe(false);
    expect(git(p, "for-each-ref", "--format=%(refname)", "refs/aidlc/reviewed-source/demo/")).toBe("");
  });

  test("legacy provenance belongs only to intent A while intent B creates its own same-slug Bolt", () => {
    const p = freshFixture();
    const legacy = plantLegacyBolt(p);
    const legacyHead = git(p, "rev-parse", legacy.branch);
    const intentB = createIntent(p, "other-intent", DEFAULT_SPACE);
    const idB = fixtureIntentId8(p, intentB.dirName, DEFAULT_SPACE);
    // R4(e): absence of B's identity is not an idempotent discard while A's same-slug checkout is live.
    const foreignDiscard = wt(p, ["discard", "--slug", "demo", "--intent", intentB.dirName, "--space", DEFAULT_SPACE]);
    expect(foreignDiscard.status, foreignDiscard.out).not.toBe(0);
    expect(foreignDiscard.out).toContain(`no Bolt demo belongs to intent aidlc/spaces/${DEFAULT_SPACE}/intents/${intentB.dirName}`);
    expect(foreignDiscard.out).toContain(`this checkout holds ${legacy.branch} (legacy)`);
    expect(foreignDiscard.out).toContain("select that intent to discard it");
    expect(existsSync(legacy.dir)).toBe(true);
    expect(git(p, "rev-parse", legacy.branch)).toBe(legacyHead);
    expect(readFileSync(join(legacy.dir, "README.md"), "utf-8")).toBe("seed\n");
    const created = wt(p, ["create", "--slug", "demo", "--base", "main", "--intent", intentB.dirName, "--space", DEFAULT_SPACE]);
    expect(created.status, created.out).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      worktree_path: worktreePath(p, idB, "demo"),
      branch: boltName(idB, "demo"),
    });
    expect(existsSync(legacy.dir)).toBe(true);
    expect(git(p, "rev-parse", legacy.branch)).toBe(legacyHead);

    const discarded = wt(p, ["discard", "--slug", "demo", "--intent", DEFAULT_RECORD_DIR, "--space", DEFAULT_SPACE]);
    expect(discarded.status, discarded.out).toBe(0);
    expect(JSON.parse(discarded.stdout).emitted).toBe("WORKTREE_DISCARDED");
    expect(existsSync(legacy.dir)).toBe(false);
    expect(branchExists(p, legacy.branch)).toBe(false);
    expect(existsSync(worktreePath(p, idB, "demo"))).toBe(true);
    expect(branchExists(p, boltName(idB, "demo"))).toBe(true);

    const idA = fixtureIntentId8(p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    const recreated = wt(p, ["create", "--slug", "demo", "--base", "main", "--intent", DEFAULT_RECORD_DIR, "--space", DEFAULT_SPACE]);
    expect(recreated.status, recreated.out).toBe(0);
    expect(JSON.parse(recreated.stdout)).toMatchObject({
      worktree_path: worktreePath(p, idA, "demo"),
      branch: boltName(idA, "demo"),
    });
    expect(existsSync(worktreePath(p, idA, "demo"))).toBe(true);
    expect(existsSync(legacy.dir)).toBe(false);
    expect(existsSync(worktreePath(p, idB, "demo"))).toBe(true);
    expect(branchExists(p, boltName(idB, "demo"))).toBe(true);
  });

  test("foreign unchecked-out legacy branch and retained ref survive intent B discard and purge", () => {
    const p = freshFixture();
    const intentB = createIntent(p, "other-intent", DEFAULT_SPACE);
    const branch = "bolt-demo";
    const head = git(p, "rev-parse", "HEAD");
    const retainedRef = `refs/aidlc/reviewed-source/demo/${head}`;
    // No worktree and no demo lifecycle rows belong to B: a global legacy ref
    // is not provenance, even when git would allow deleting its idle branch.
    git(p, "branch", branch, "main");
    git(p, "update-ref", retainedRef, head);
    const branchHead = git(p, "rev-parse", "--verify", `refs/heads/${branch}`);
    const retainedHead = git(p, "rev-parse", "--verify", retainedRef);
    expect(existsSync(join(p, ".aidlc", "worktrees", branch))).toBe(false);

    for (const command of ["discard", "purge"]) {
      const result = wt(p, [command, "--slug", "demo", "--intent", intentB.dirName, "--space", DEFAULT_SPACE]);
      // Nothing-to-clean refusals are allowed; deleting either foreign ref is not.
      expect(git(p, "rev-parse", "--verify", `refs/heads/${branch}`), result.out).toBe(branchHead);
      expect(git(p, "rev-parse", "--verify", retainedRef), result.out).toBe(retainedHead);
    }
  });

  test("a namespaced branch with no creation row in the selected intent is not discard's to park", () => {
    // Models a linked checkout whose committed registry diverged onto the same
    // id8, or a hand-made name: the branch exists in the shared ref database but
    // this intent never recorded creating it. Branch-only evidence is not
    // provenance for an intent-scoped Bolt; only pre-upgrade Bolts may fall back
    // to evidence-only ownership.
    const p = freshFixture();
    const branch = boltName(fixtureIntentId8(p), "demo");
    git(p, "branch", branch, "main");
    const branchHead = git(p, "rev-parse", "--verify", `refs/heads/${branch}`);

    const result = wt(p, ["discard", "--slug", "demo"]);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain(`no WORKTREE_CREATED row of intent`);
    expect(result.out).toContain(`names ${branch}`);
    expect(git(p, "rev-parse", "--verify", `refs/heads/${branch}`)).toBe(branchHead);
    expect(git(p, "for-each-ref", "--format=%(refname)", "refs/aidlc/parked/")).toBe("");
  });

  test("a phantom pre-upgrade creation (audit row, no git evidence) does not block the slug", () => {
    const p = freshFixture();
    // Pre-upgrade audit-first create that died between WORKTREE_CREATED and
    // `git worktree add`: an open legacy row, but no directory, branch,
    // registration or retained ref. Doctor owns the row; create must still work.
    appendAuditEntry("WORKTREE_CREATED", {
      "Bolt slug": "demo",
      "Worktree path": ".aidlc/worktrees/bolt-demo",
      "Branch name": "bolt-demo",
      "Base branch": "main",
      "Base commit": git(p, "rev-parse", "main"),
      Repo: "-",
      "Intent record": `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`,
    }, p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    expect(branchExists(p, "bolt-demo")).toBe(false);

    const created = wt(p, ["create", "--slug", "demo", "--base", "main"]);
    expect(created.status, created.out).toBe(0);
    expect(existsSync(wtPath(p, "demo"))).toBe(true);
    expect(branchExists(p, boltName(fixtureIntentId8(p), "demo"))).toBe(true);
    expect(branchExists(p, "bolt-demo")).toBe(false);
  });
});
