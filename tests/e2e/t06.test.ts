// covers: subcommand:aidlc-worktree:create
//
// CLI-contract port of tests/e2e/t06-worktree-sibling-rejection.sh (TAP
// plan 3), mechanism = cli. The .sh drives `aidlc-worktree.ts create` from
// INSIDE a sibling worktree to prove the tool's pre-audit
// assertNotSiblingWorktree guard (aidlc-worktree.ts:101-121, called at
// :162 before any audit emit) rejects the call. The covers UNIT credited is
// subcommand:aidlc-worktree:create — the same subcommand t02 covers, here
// exercised on its sibling-rejection branch.
//
// MECHANISM: this is a .cli file, so every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status / combined stdout+stderr (the .sh's 2>&1). The guard
// fires inside the real process from the real cwd, so an in-process twin would
// not reproduce the `git rev-parse --show-toplevel` resolution that drives the
// main-checkout-vs-sibling comparison.
//
// FIXTURE: aidlc-worktree.ts resolves the main checkout from process cwd, so
// the .sh builds a REAL sibling worktree under
// <fixture>/.claude/worktrees/dev-slug (via `git worktree add -b dev-branch`)
// and runs the tool with cwd = that sibling. setupWorktreeFixture
// (tests/harness/fixtures.ts) builds the parent git repo on `main` with one
// commit + aidlc-docs/; we add the sibling inline with spawnSync("git", ...)
// exactly as the .sh did. cleanupWorktreeFixture prunes child worktrees then
// rm -rf's the parent. Nothing is written under tests/fixtures/**.
//
// PARITY NOTES — every .sh assertion has an equal-or-stronger counterpart:
//   .sh T1  create from sibling worktree exits non-zero          -> expect status !== 0
//   .sh T2  error names "must run from the main repo checkout"    -> expect out contains it
//   .sh T3  error explains the nesting rule                    -> expect out contains
//             "inside another worktree's tracked tree"
//
// 3 .sh asserts -> 3 equal counterparts + STRONGER additions: the guard is
// pre-audit, so we also assert NO WORKTREE_CREATED row for the slug landed in
// the sibling's audit.md and NO Bolt worktree dir was created (the .sh's
// "pre-audit check" intent, which it only documented in its header comment).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import {
  boltName,
  createIntent,
  reviewedSourceRef,
  reviewedSourceRefPrefix,
  workspaceSourceFingerprint,
  worktreePath,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  cleanupWorktreeFixture,
  fixtureIntentId8,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const fixtures: string[] = [];
// Worktrees created OUTSIDE a fixture's tree: cleanupWorktreeFixture prunes a
// fixture's own children, so these are removed here.
const outsideWorktrees: string[] = [];
afterAll(() => {
  for (const w of outsideWorktrees) rmSync(w, { recursive: true, force: true });
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

/** Fresh git-repo fixture on `main` + aidlc-docs/, registered for cleanup. */
function freshFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  return p;
}

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.trim()}`);
  return r.stdout ?? "";
};

function addOutsideWorktree(fixture: string): { outside: string; featureHead: string; mainHead: string } {
  // Commit the workspace shell so it travels into the new worktree (the fixture
  // seeds it after its own seed commit, which is why the nested case has no record).
  git(fixture, "add", "--", "aidlc");
  git(fixture, "commit", "-qm", "seed aidlc workspace shell");

  const outside = `${fixture}-feature`;
  outsideWorktrees.push(outside);
  git(fixture, "worktree", "add", "-q", outside, "-b", "feature-x");
  writeFileSync(join(outside, "feature.txt"), "approved work\n");
  git(outside, "add", "--", "feature.txt");
  git(outside, "commit", "-qm", "work the main checkout does not have");

  const featureHead = git(outside, "rev-parse", "HEAD").trim();
  const mainHead = git(fixture, "rev-parse", "HEAD").trim();
  return { outside, featureHead, mainHead };
}

/** Add a real sibling worktree at <fixture>/<relativePath> on a new branch,
 *  mirroring the .sh's nested-worktree setup. */
function addSibling(fixture: string, relativePath: string, branch: string): string {
  git(fixture, "add", "--", "aidlc");
  git(fixture, "commit", "-qm", "seed aidlc workspace shell");
  const sibling = join(fixture, relativePath);
  const r = spawnSync(
    "git",
    ["-C", fixture, "worktree", "add", "-q", sibling, "-b", branch],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `git worktree add (sibling) failed: ${r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status}`}`,
    );
  }
  return sibling;
}

interface CliResult {
  status: number;
  stdout: string;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn a worktree subcommand at the process boundary from the given checkout. */
function worktree(cwd: string, projectDir: string, args: string[]): CliResult {
  const res = spawnSync(
    BUN,
    [TOOL, ...args, "--project-dir", projectDir],
    { cwd, encoding: "utf-8" },
  );
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function create(cwd: string, projectDir: string, args: string[]): CliResult {
  return worktree(cwd, projectDir, ["create", ...args]);
}

/** Count Bolt slug rows across the selected fixture record's audit shards. */
function boltSlugRows(dir: string): string[] {
  const auditDir = seededAuditDir(dir);
  let names: string[];
  try {
    names = readdirSync(auditDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    for (const line of readFileSync(join(auditDir, n), "utf-8").split("\n")) {
      const m = line.match(/^\*\*Bolt slug\*\*:\s*(\S+)/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

const wtPath = (dir: string, slug: string): string =>
  worktreePath(dir, fixtureIntentId8(dir), slug);

/** Model post-landing partial cleanup: durable authority exists but branch/refs remain. */
function seedPostLandingCleanup(fixture: string, slug: string, id8: string): string {
  const dir = worktreePath(fixture, id8, slug);
  const sourceCommit = git(dir, "rev-parse", "HEAD").trim();
  const openingFingerprint = workspaceSourceFingerprint(fixture, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
  if (openingFingerprint === null) throw new Error("Cannot fingerprint merge fixture");
  const attempt = {
    "Unit name": slug,
    "Batch number": "1",
    Stage: "code-generation",
    "Run floor": "unstarted#0",
    "Source Commit": sourceCommit,
    Repo: "-",
  };
  git(fixture, "update-ref", reviewedSourceRef(id8, slug, sourceCommit), sourceCommit);
  appendAuditEntry("SWARM_UNIT_CONVERGED", attempt, fixture, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
  appendAuditEntry("WORKTREE_MERGED", {
    "Bolt slug": slug,
    "Worktree path": relative(fixture, dir).replaceAll("\\", "/"),
    "Target branch": "main",
    Strategy: "rebase",
  }, fixture, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
  git(fixture, "merge", "--ff-only", boltName(id8, slug));
  const landedFingerprint = workspaceSourceFingerprint(fixture, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
  if (landedFingerprint === null) throw new Error("Cannot fingerprint landed source");
  appendAuditEntry("SWARM_SOURCE_MERGED", {
    ...attempt,
    "Merge commit": sourceCommit,
    "Previous Source Fingerprint": openingFingerprint,
    "Source Fingerprint": landedFingerprint,
  }, fixture, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
  git(fixture, "worktree", "remove", "--force", dir);
  return sourceCommit;
}

describe("t06 aidlc-worktree sibling rejection (migrated from t06-worktree-sibling-rejection.sh, plan 3)", () => {
  test("1-3: create from inside a sibling worktree is rejected pre-audit with the main-checkout error", () => {
    const fixture = freshFixture();
    const sibling = addSibling(fixture, join(".claude", "worktrees", "dev-slug"), "dev-branch");

    // Run aidlc-worktree create from INSIDE the sibling worktree.
    const r = create(sibling, sibling, ["--slug", "demo", "--base", "main"]);

    expect(r.status).not.toBe(0); // T1
    expect(r.out).toContain("must run from the main repo checkout"); // T2
    expect(r.out).toContain("inside another worktree's tracked tree"); // T3

    // STRONGER: the guard fires BEFORE the audit emit, so nothing landed in
    // either checkout's audit, and no Bolt worktree directory was created.
    expect(boltSlugRows(sibling)).not.toContain("demo");
    expect(boltSlugRows(fixture)).not.toContain("demo");
    expect(existsSync(wtPath(sibling, "demo"))).toBe(false);
    expect(existsSync(wtPath(fixture, "demo"))).toBe(false);
  }, 30000);

  // #567: the rule is NESTING, not "is a linked worktree". A worktree that lives
  // OUTSIDE the main checkout is the ordinary one-worktree-per-branch layout and
  // is allowed — the case above stays refused because it is nested INSIDE the
  // fixture's working tree. The Bolt lands under the INVOKING worktree and
  // `--base feature-x` resolves as given. Branch refs are shared across worktrees;
  // the feature branch is deliberately one commit ahead of `main` so the selected
  // base is distinguishable from the main checkout's HEAD.
  test("4: create from a worktree OUTSIDE the main checkout is allowed and places the Bolt under the invoking worktree", () => {
    const fixture = freshFixture();
    const { outside, featureHead, mainHead } = addOutsideWorktree(fixture);
    expect(featureHead).not.toBe(mainHead); // fixture precondition

    const r = create(outside, outside, ["--slug", "demo", "--base", "feature-x"]);

    expect(r.status, r.out).toBe(0);
    expect(existsSync(wtPath(outside, "demo"))).toBe(true);
    // The Bolt starts at the explicit `--base feature-x`, NOT the main checkout's HEAD.
    const boltHead = git(wtPath(outside, "demo"), "rev-parse", "HEAD").trim();
    expect(boltHead).toBe(featureHead);
    expect(boltHead).not.toBe(mainHead);
  }, 30000);

  // Pin the segment-boundary rule: a `..` PREFIX in a directory name is not an
  // escape from the main checkout. A worktree named `..dev` is still nested
  // INSIDE the fixture's working tree and must be refused before creating a Bolt.
  test("5: a nested worktree whose directory name starts with '..' is still refused", () => {
    const fixture = freshFixture();
    const nested = addSibling(fixture, "..dev", "dotdot-dev-branch");

    const r = create(nested, nested, ["--slug", "demo", "--base", "main"]);

    expect(r.status).not.toBe(0);
    expect(r.out).toContain("must run from the main repo checkout");
    expect(existsSync(wtPath(nested, "demo"))).toBe(false);
    expect(existsSync(wtPath(fixture, "demo"))).toBe(false);
  }, 30000);

  // Both checkouts select the SAME registry intent: its branch remains unique
  // within this clone and the refusal must identify the worktree holding it.
  test("6: the same intent cannot create its same-slug Bolt in two worktrees", () => {
    const fixture = freshFixture();
    // emitError only records ERROR_LOGGED when the record has a state file.
    writeFileSync(seededStateFile(fixture), "- **Current Stage**: code-generation\n", "utf-8");
    const { outside } = addOutsideWorktree(fixture);
    const selectors = ["--intent", DEFAULT_RECORD_DIR, "--space", DEFAULT_SPACE];
    const branch = boltName(fixtureIntentId8(fixture), "demo");
    const r1 = create(outside, outside, ["--slug", "demo", "--base", "feature-x", ...selectors]);
    expect(r1.status, r1.out).toBe(0);

    const r2 = create(fixture, fixture, ["--slug", "demo", "--base", "main", ...selectors]);
    expect(r2.status).not.toBe(0);
    expect(r2.out).toContain(`Branch already exists: ${branch}`);
    expect(r2.out).toContain(`checked out at ${wtPath(outside, "demo").replaceAll("\\", "/")}`);
    expect(existsSync(wtPath(fixture, "demo"))).toBe(false);

    // Stderr may name the owner in another checkout, but the committed audit
    // shard must stay portable and must not include that checkout's absolute path.
    const auditDir = seededAuditDir(fixture);
    const auditText = readdirSync(auditDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => readFileSync(join(auditDir, name), "utf-8"))
      .join("\n");
    expect(auditText).toContain("**Event**: ERROR_LOGGED");
    expect(auditText).toContain(`Branch already exists: ${branch} (checked out in another worktree of this repository)`);
    expect(auditText).not.toContain(outside);
  }, 30000);

  test("7: different intents in two worktrees share a slug without sharing cleanup authority", () => {
    const fixture = freshFixture();
    const { outside } = addOutsideWorktree(fixture);
    const intentB = createIntent(outside, "other-intent", DEFAULT_SPACE);
    const idA = fixtureIntentId8(fixture, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
    const idB = fixtureIntentId8(outside, intentB.dirName, DEFAULT_SPACE);
    const slug = "demo";
    const a = create(fixture, fixture, ["--slug", slug, "--base", "main", "--intent", DEFAULT_RECORD_DIR, "--space", DEFAULT_SPACE]);
    const b = create(outside, outside, ["--slug", slug, "--base", "feature-x", "--intent", intentB.dirName, "--space", DEFAULT_SPACE]);
    expect(a.status, a.out).toBe(0);
    expect(b.status, b.out).toBe(0);
    expect(idA).not.toBe(idB);
    const listedA = worktree(fixture, fixture, ["list"]);
    const listedB = worktree(outside, outside, ["list"]);
    expect(listedA.status, listedA.out).toBe(0);
    expect(listedB.status, listedB.out).toBe(0);
    expect(JSON.parse(listedA.stdout).worktrees).toEqual([expect.objectContaining({
      slug, intent_id8: idA, legacy: false,
      branch: boltName(idA, slug), worktree_path: worktreePath(fixture, idA, slug).replaceAll("\\", "/"),
    })]);
    expect(JSON.parse(listedB.stdout).worktrees).toEqual([expect.objectContaining({
      slug, intent_id8: idB, legacy: false,
      branch: boltName(idB, slug), worktree_path: worktreePath(outside, idB, slug).replaceAll("\\", "/"),
    })]);

    const bHead = git(outside, "rev-parse", boltName(idB, slug)).trim();
    const bBase = git(outside, "rev-parse", "main").trim();
    for (const commit of [bHead, bBase]) {
      git(outside, "update-ref", reviewedSourceRef(idB, slug, commit), commit);
    }
    const bRefsBefore = git(outside, "for-each-ref", "--format=%(refname)%09%(objectname)", reviewedSourceRefPrefix(idB, slug));
    expect(bRefsBefore.split("\n").filter(Boolean).sort()).toEqual([
      `${reviewedSourceRef(idB, slug, bHead)}\t${bHead}`,
      `${reviewedSourceRef(idB, slug, bBase)}\t${bBase}`,
    ].sort());
    const aDir = worktreePath(fixture, idA, slug);
    writeFileSync(join(aDir, "intent-a.txt"), "intent A source\n");
    git(aDir, "add", "--", "intent-a.txt");
    git(aDir, "commit", "-qm", "intent A source");
    const landed = seedPostLandingCleanup(fixture, slug, idA);
    expect(git(fixture, "rev-parse", "main").trim()).toBe(landed);
    expect(readFileSync(join(fixture, "intent-a.txt"), "utf-8")).toBe("intent A source\n");
    expect(existsSync(aDir)).toBe(false);

    const retried = worktree(fixture, fixture, [
      "merge", "--slug", slug, "--target", "main", "--strategy", "squash",
      "--intent", DEFAULT_RECORD_DIR, "--space", DEFAULT_SPACE,
    ]);
    expect(retried.status, retried.out).toBe(0);
    expect(JSON.parse(retried.stdout).cleanup_reconciled).toBe(true);
    expect(git(fixture, "rev-parse", "main").trim()).toBe(landed);
    expect(spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${boltName(idA, slug)}`], { cwd: fixture }).status).toBe(1);
    expect(git(fixture, "for-each-ref", "--format=%(refname)", reviewedSourceRefPrefix(idA, slug))).toBe("");
    expect(existsSync(worktreePath(outside, idB, slug))).toBe(true);
    expect(git(outside, "rev-parse", boltName(idB, slug)).trim()).toBe(bHead);
    expect(git(outside, "for-each-ref", "--format=%(refname)%09%(objectname)", reviewedSourceRefPrefix(idB, slug))).toBe(bRefsBefore);
  }, 60000);
});
