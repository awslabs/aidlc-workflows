// covers: function:workspaceSourceFingerprint
//
// t244 - reviewer receipts bound to workspace source state (#629).
//
// PR #569's freshness guard invalidates receipts via ARTIFACT_CREATED/UPDATED
// events for declared record artifacts - but code-generation produces
// application source OUTSIDE the record, and workspace writes deliberately
// emit no audit events. A source file could therefore change after the
// architecture reviewer recorded a terminal verdict and the stale receipt
// still satisfied the completion guard. The fix binds the receipt to a
// git-native source fingerprint (temp-index `git write-tree` over tracked +
// untracked content), stamped on REVIEW_COMPLETED by `aidlc-log.ts review`
// and recomputed/compared by verifyReviewerPrecondition on every completion
// route. This file pins:
//
//   1. FINGERPRINT SEMANTICS (in-process) - deterministic; content-addressed
//      (revert restores it); sensitive to tracked edits AND untracked adds;
//      null off-git; never mutates the real index.
//   2. STAMPING (cli) - `review --verdict` records `Source Fingerprint` for
//      the workspace_requires stage (code-generation) and NOT for a
//      record-artifact stage (feasibility).
//   3. GUARD (cli) - approve passes while the source matches; a post-review
//      source edit refuses with the source-fingerprint-mismatch message; the
//      AIDLC_SKIP_SOURCE_FRESHNESS=1 off-switch restores the legacy pass;
//      receipts without the field (legacy rows) keep passing (fail-open).
//
// Mechanism: MIXED - in-process import for the fingerprint pins, spawns of the
// real dist tools (log, state) for the stamping + guard rows. The guard rows
// ride the mid-ideation state fixture with NO units doc, so code-generation's
// per-unit branch resolves `none` and exercises the stage-level fallback -
// exactly the receipt path the fingerprint filter protects.

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAllAuditShards,
  workspaceSourceFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  FIXTURES_DIR,
  cleanupTestProject,
  cleanupWorktreeFixture,
  createTestProject,
  resetAidlcEnv,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SWARM_TOOL = join(AIDLC_SRC, "tools", "aidlc-swarm.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent"; // code-generation's declared reviewer

function git(dir: string, args: string[]): void {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
  }
}

// Turn a dir into a committed git repo with one source file.
function seedGitRepo(dir: string): string {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@test"]);
  git(dir, ["config", "user.name", "t"]);
  const src = join(dir, "app.ts");
  writeFileSync(src, "export const answer = 42;\n", "utf-8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "seed"]);
  return src;
}

// Drive a state subcommand with the unrelated guards bypassed (bare fixtures
// don't satisfy them) - mirrors t205's guarded(). The source-freshness guard
// under test stays ON unless a scenario sets its own off-switch.
function guarded(
  proj: string,
  args: string[],
  extraEnv?: Record<string, string>,
): { rc: number; out: string } {
  const env = { ...process.env, ...extraEnv };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "1";
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  env.AIDLC_SKIP_REVISION_BACKSTOP = "1";
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function recordReview(
  proj: string,
  stage = "code-generation",
  reviewer = REVIEWER,
  unit?: string,
): void {
  const args = [
    LOG,
    "review",
    "--stage",
    stage,
    "--reviewer",
    reviewer,
    "--iteration",
    "1",
    "--verdict",
    "READY",
    "--project-dir",
    proj,
  ];
  if (unit) args.push("--unit", unit);
  const r = spawnSync(BUN, args, { encoding: "utf-8", env: process.env });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`recordReview failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
}

// Seed a 2-unit Bolt DAG (unit-of-work-dependency.md) for the active intent's
// record, so code-generation's for_each: unit-of-work branch resolves real
// units instead of falling back to the stage-level `none` path.
function seedTwoUnitDag(proj: string): void {
  const dir = join(seededRecordDir(proj), "inception", "units-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "unit-of-work-dependency.md"),
    "```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n",
    "utf-8",
  );
}

// Strip the stamped Source Fingerprint field from every audit shard - the
// exact shape of a pre-upgrade (legacy) REVIEW_COMPLETED row.
function stripFingerprintFields(proj: string): void {
  const intentsDir = join(proj, "aidlc", "spaces", "default", "intents");
  for (const intent of readdirSync(intentsDir)) {
    const auditDirPath = join(intentsDir, intent, "audit");
    if (!existsSync(auditDirPath)) continue;
    for (const f of readdirSync(auditDirPath)) {
      if (!f.endsWith(".md")) continue;
      const p = join(auditDirPath, f);
      const body = readFileSync(p, "utf-8");
      if (!body.includes("**Source Fingerprint**: ")) continue;
      writeFileSync(p, body.replace(/^\*\*Source Fingerprint\*\*: .*\r?\n/gm, ""), "utf-8");
    }
  }
}

describe("t244 workspace source fingerprint (in-process)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "t244-fp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("deterministic, content-addressed, and edit-sensitive", () => {
    const src = seedGitRepo(dir);
    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).toMatch(/^[0-9a-f]{40}$/); // single repo -> the tree sha itself
    expect(workspaceSourceFingerprint(dir)).toBe(fp1); // deterministic

    writeFileSync(src, "export const answer = 43;\n", "utf-8"); // tracked edit
    const fp2 = workspaceSourceFingerprint(dir);
    expect(fp2).not.toBe(fp1);

    writeFileSync(src, "export const answer = 42;\n", "utf-8"); // revert
    expect(workspaceSourceFingerprint(dir)).toBe(fp1); // content-addressed

    writeFileSync(join(dir, "untracked.ts"), "// new\n", "utf-8"); // untracked add
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
    rmSync(join(dir, "untracked.ts"));
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);
  });

  test("never mutates the real index, and returns null off-git", () => {
    const src = seedGitRepo(dir);
    writeFileSync(src, "export const answer = 99;\n", "utf-8"); // dirty worktree
    workspaceSourceFingerprint(dir);
    const status = spawnSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf-8",
    }).stdout;
    // The edit stays UNSTAGED (` M`) - a staged `M ` would mean the real index
    // was touched by the temp-index walk.
    expect(status).toContain(" M app.ts");
    const plain = mkdtempSync(join(tmpdir(), "t244-plain-"));
    try {
      expect(workspaceSourceFingerprint(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  // #646 review P2 - a bare `git add -A` records an initialized submodule as a
  // gitlink (its checked-out commit sha) only, so a tracked edit made INSIDE
  // the submodule without committing there leaves the gitlink - and the
  // parent's own write-tree sha - unchanged, shipping a reviewed-then-edited
  // submodule as if nothing had changed.
  test("recurses into an initialized submodule: an uncommitted edit inside it changes the fingerprint", () => {
    const subDir = mkdtempSync(join(tmpdir(), "t244-fp-sub-"));
    try {
      git(subDir, ["init", "-q"]);
      git(subDir, ["config", "user.email", "t@test"]);
      git(subDir, ["config", "user.name", "t"]);
      writeFileSync(join(subDir, "lib.ts"), "export const v = 1;\n", "utf-8");
      git(subDir, ["add", "-A"]);
      git(subDir, ["commit", "-qm", "sub init"]);

      seedGitRepo(dir);
      git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subDir, "vendor/sub"]);
      git(dir, ["commit", "-qm", "add submodule"]);

      const fp1 = workspaceSourceFingerprint(dir);
      expect(fp1).not.toBeNull();
      expect(workspaceSourceFingerprint(dir)).toBe(fp1); // deterministic

      // Edit the submodule's tracked file WITHOUT committing inside it - the
      // gitlink git add -A records for the submodule stays identical.
      writeFileSync(join(dir, "vendor", "sub", "lib.ts"), "export const v = 2;\n", "utf-8");
      const fp2 = workspaceSourceFingerprint(dir);
      expect(fp2).not.toBe(fp1);

      // Content-addressed: reverting the submodule edit restores fp1.
      writeFileSync(join(dir, "vendor", "sub", "lib.ts"), "export const v = 1;\n", "utf-8");
      expect(workspaceSourceFingerprint(dir)).toBe(fp1);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  }, 20000); // git submodule add is a real clone op - slower than bun's 5000ms default under load

  // #646 review P2 - the aidlc-workspace exclusion (`aidlc`/`.aidlc`/
  // `.aidlc-worktrees`/`.aidlc-sensors`) was top-level only; a monorepo
  // subpackage nesting one of these (e.g. the type-check sensor's
  // `.aidlc-sensors/.tsbuildinfo`, anchored at the tsconfig dir per
  // aidlc-sensor-type-check.ts's sensorsDir) still altered the fingerprint on
  // engine-written churn with no real source change.
  test("excludes the aidlc workspace family at any depth, but not real nested source", () => {
    const src = seedGitRepo(dir);
    const fp1 = workspaceSourceFingerprint(dir);

    // Engine-written sensor cache, nested under a monorepo subpackage - not at
    // the workspace root.
    mkdirSync(join(dir, "services", "backend", ".aidlc-sensors"), { recursive: true });
    writeFileSync(
      join(dir, "services", "backend", ".aidlc-sensors", "tsbuildinfo"),
      "cache\n",
      "utf-8",
    );
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);

    // The other three workspace-family names, also nested (not at the root).
    mkdirSync(join(dir, "services", "backend", "aidlc"), { recursive: true });
    writeFileSync(join(dir, "services", "backend", "aidlc", "x.md"), "record\n", "utf-8");
    mkdirSync(join(dir, "services", "backend", ".aidlc-worktrees"), { recursive: true });
    writeFileSync(join(dir, "services", "backend", ".aidlc-worktrees", "x.md"), "wt\n", "utf-8");
    mkdirSync(join(dir, "services", "backend", ".aidlc"), { recursive: true });
    writeFileSync(join(dir, "services", "backend", ".aidlc", "x.md"), "shell\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);

    // A REAL nested source file at the same depth DOES change the fingerprint
    // - proves the exclusion targets exactly the 4 workspace names, not the
    // whole subdirectory tree.
    writeFileSync(join(dir, "services", "backend", "main.ts"), "export const x = 1;\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);

    // Sanity: the original top-level tracked file is still part of the tree
    // (the exclusion did not accidentally swallow real root-level content).
    expect(existsSync(src)).toBe(true);
  });
});

describe("t244 receipt stamping + completion guard (cli)", () => {
  let proj: string;
  let src: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    src = seedGitRepo(proj);
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
    guarded(proj, ["gate-start", "code-generation"]);
  });

  afterEach(() => cleanupTestProject(proj));

  test("review --verdict stamps Source Fingerprint for code-generation; approve passes while source matches", () => {
    recordReview(proj);
    expect(readAllAuditShards(proj)).toContain("**Source Fingerprint**: ");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.out).not.toContain("source-fingerprint mismatch");
    expect(r.rc).toBe(0);
  });

  test("no stamp for a record-artifact stage (feasibility declares no workspace_requires)", () => {
    recordReview(proj, "feasibility", "aidlc-product-lead-agent");
    expect(readAllAuditShards(proj)).toContain("**Event**: REVIEW_COMPLETED");
    expect(readAllAuditShards(proj)).not.toContain("**Source Fingerprint**: ");
  });

  test("a post-review source edit refuses completion with the mismatch message", () => {
    recordReview(proj);
    writeFileSync(src, "export const answer = 1337; // edited after review\n", "utf-8");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("source-fingerprint mismatch");
    expect(r.out).toContain(REVIEWER);
  });

  test("AIDLC_SKIP_SOURCE_FRESHNESS=1 restores the legacy pass (off-switch)", () => {
    recordReview(proj);
    writeFileSync(src, "export const answer = 7;\n", "utf-8");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"], {
      AIDLC_SKIP_SOURCE_FRESHNESS: "1",
    });
    expect(r.rc).toBe(0);
  });

  test("a legacy receipt without the field keeps passing after a source edit (fail-open)", () => {
    recordReview(proj);
    expect(readAllAuditShards(proj)).toContain("**Source Fingerprint**: ");
    stripFingerprintFields(proj);
    writeFileSync(src, "export const answer = 8;\n", "utf-8");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).toBe(0);
  });
});

// Reproduction of the maintainer review on #646 (a1e4d67): a workspace-global,
// time-of-stamp fingerprint compared per-receipt is fundamentally the wrong
// shape for a for_each: unit-of-work stage, where receipts are per-unit but
// the engine presents ONE stage-level gate after ALL units are built.
describe("t244 multi-unit sequential flow (reproduction, #646 review)", () => {
  let proj: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    seedGitRepo(proj);
    seedTwoUnitDag(proj);
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
    guarded(proj, ["gate-start", "code-generation"]);
  });

  afterEach(() => cleanupTestProject(proj));

  test("sequential per-unit review (alpha then beta, nothing edited after beta) must not refuse", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    writeFileSync(join(proj, "beta.ts"), "export const beta = 2;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    // Nothing edited after beta's review - both units are reviewed against
    // exactly the tree state that exists at approve time. This must pass.
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.out).not.toContain("source-fingerprint mismatch");
    expect(r.rc).toBe(0);
  });
});

// Reproduction of the maintainer review on #646 (a1e4d67), P1 finding 2: the
// swarm path stamps receipts inside per-unit Bolt worktrees, but the MAIN
// checkout never receives the merged-back code until finalize runs - so
// recomputing the fingerprint over the main checkout at a settle approve
// always mismatches every worktree-stamped receipt, deadlocking a run that
// never edited anything. isSettledSwarmForArtifactGuard's exemption (already
// proven for the produces-existence guard, t185) is reused here to skip the
// fingerprint reconciliation entirely once every DAG unit has converged.
describe("t244 settled-swarm exemption from fingerprint reconciliation (#646 review P1#2)", () => {
  let proj: string;
  const UNITS = ["alpha", "beta"];

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    seedGitRepo(proj);
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
    guarded(proj, ["gate-start", "code-generation"]);
    // Autonomy grant: append the field beside Scope (fixture ships without it).
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace(
        /^(- \*\*Scope\*\*: .*)$/m,
        "$1\n- **Construction Autonomy Mode**: autonomous",
      ),
    );
    // A valid two-unit DAG in the compiled runtime graph (isSettledSwarmForArtifactGuard
    // reads this, not the units-generation doc).
    writeFileSync(
      join(seededRecordDir(proj), "runtime-graph.json"),
      `${JSON.stringify({
        bolt_dag: { units: UNITS.map((name) => ({ name, depends_on: [] })), batches: [UNITS] },
      })}\n`,
    );
    // Referee convergence rows for every unit, carrying the attempt-identity
    // stamp (Stage + Run floor); the fixture has no STAGE_STARTED row, so the
    // matching floor is "".
    const shard = seededAuditShard(proj);
    mkdirSync(join(shard, ".."), { recursive: true });
    const rows = UNITS.map((unit, i) =>
      [
        "## Swarm Unit Converged",
        `**Timestamp**: 2026-07-18T00:00:0${i}.000Z`,
        "**Event**: SWARM_UNIT_CONVERGED",
        `**Unit name**: ${unit}`,
        "**Stage**: code-generation",
        "**Run floor**: ",
        "",
        "---",
        "",
      ].join("\n"),
    ).join("");
    writeFileSync(shard, rows, { flag: "a" });
    for (const unit of UNITS) recordReview(proj, "code-generation", REVIEWER, unit);
  });

  afterEach(() => cleanupTestProject(proj));

  test("approve PASSES despite a main-checkout mismatch once every DAG unit has converged", () => {
    // Simulates the worktree code never having merged into the main checkout:
    // the recorded receipts' fingerprints (stamped in this test's proj, since
    // no real worktree is involved here) no longer match the current tree.
    writeFileSync(join(proj, "app.ts"), "export const answer = 999;\n", "utf-8");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.out).not.toContain("source-fingerprint mismatch");
    expect(r.rc).toBe(0);
  });
});

// Reproduction of the maintainer review on #646 (a1e4d67), P1 finding 3:
// `reviewerReceiptError` (aidlc-swarm.ts) accepted any terminal READY/NOT-READY
// verdict and never read the receipt's own Source Fingerprint, so finalize
// could merge a unit whose worktree source was edited after its review.
describe("t244 swarm finalize source-fingerprint check (#646 review P1#3)", () => {
  const fixtures: string[] = [];
  afterAll(() => {
    for (const f of fixtures) cleanupWorktreeFixture(f);
  });

  // Mirrors t134's makeSwarmFixture, but seeded with Current Stage:
  // code-generation (a workspace_requires stage) instead of functional-design,
  // so aidlc-log.ts review actually stamps a Source Fingerprint to check.
  function makeFixture(): string {
    const proj = setupWorktreeFixture();
    fixtures.push(proj);
    // The fixture ships with a pre-populated `Bolt Refs: [foo]` for its own
    // (unrelated) milestone-11 worktree-lifecycle purpose - clear it so a
    // fresh `prepare` for any unit name here doesn't collide with a stale ref.
    const seeded = readFileSync(join(FIXTURES_DIR, "state-construction-with-worktree.md"), "utf-8")
      .replace(/^(- \*\*Bolt Refs\*\*: ).*$/m, "$1");
    writeFileSync(seededStateFile(proj), seeded);
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(join(seededAuditDir(proj), "fixture.md"), "# AI-DLC Audit Log\n");
    writeFileSync(
      join(proj, ".gitignore"),
      [
        "aidlc/active-space",
        "aidlc/.aidlc-clone-id",
        "aidlc/spaces/*/intents/active-intent",
        "aidlc/spaces/*/intents/*/runtime-graph.json",
        "aidlc/spaces/*/intents/*/.aidlc-*",
        "aidlc/spaces/*/intents/*/audit/",
        "",
      ].join("\n"),
    );
    git(proj, ["add", "-A"]);
    git(proj, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--amend", "--no-edit"]);
    return proj;
  }

  function wtPath(proj: string, unit: string): string {
    return join(proj, ".aidlc", "worktrees", `bolt-${unit}`);
  }

  function runSwarm(proj: string, args: string[]): { rc: number; out: string } {
    const r = spawnSync(BUN, [SWARM_TOOL, "--project-dir", proj, ...args], {
      cwd: proj,
      encoding: "utf-8",
    });
    return { rc: r.status ?? -1, out: r.stdout ?? "" };
  }

  test("finalize refuses a claimed unit whose worktree source changed after its terminal review", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "foo", "--base", "main"]);
    const wt = wtPath(proj, "foo");
    writeFileSync(join(wt, "foo.ts"), "export const foo = 1;\n", "utf-8");
    recordReview(wt, "code-generation", REVIEWER, "foo");
    expect(readAllAuditShards(wt)).toContain("**Source Fingerprint**: ");

    // Edited AFTER the review was stamped, before finalize.
    writeFileSync(join(wt, "foo.ts"), "export const foo = 2; // edited after review\n", "utf-8");
    const f = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "foo",
      "--claimed",
      "foo",
      "--check-cmd",
      "test -f foo.ts",
    ]);
    expect(f.rc).toBe(2);
    const env = JSON.parse(f.out);
    const row = env.units.find((u: { unit: string }) => u.unit === "foo");
    expect(row?.status).toBe("failed");
    expect(row?.detail).toContain("source-fingerprint mismatch");
  }, 120000);

  test("finalize merges a claimed unit whose worktree source is unchanged since its terminal review", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "bar", "--base", "main"]);
    const wt = wtPath(proj, "bar");
    writeFileSync(join(wt, "bar.ts"), "export const bar = 1;\n", "utf-8");
    recordReview(wt, "code-generation", REVIEWER, "bar");
    const f = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "bar",
      "--claimed",
      "bar",
      "--check-cmd",
      "test -f bar.ts",
    ]);
    expect(f.rc).toBe(0);
    expect(JSON.parse(f.out).converged).toBe(1);
  }, 120000);
});
