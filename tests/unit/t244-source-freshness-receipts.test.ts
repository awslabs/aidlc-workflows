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

// Seed the minimum an intent registry needs for intentRepos() to resolve a
// recorded repo set: the default space's intents dir, an active-intent cursor
// naming a record that holds an aidlc-state.md, and one registry row carrying
// `repos`. This is the layout sibling auto-discovery produces at intent birth
// (resolveBirthRepoSet -> discoverSiblingRepos), so it is the DEFAULT shape,
// not an exotic one - which is what makes the exclusion scope matter.
function registerRepos(projectDir: string, repos: string[]): void {
  const intents = join(projectDir, "aidlc", "spaces", "default", "intents");
  const record = "fixture-intent";
  mkdirSync(join(intents, record), { recursive: true });
  writeFileSync(join(intents, record, "aidlc-state.md"), "# state\n", "utf-8");
  writeFileSync(join(intents, "active-intent"), `${record}\n`, "utf-8");
  writeFileSync(
    join(intents, "intents.json"),
    `${JSON.stringify([{ dirName: record, slug: "fixture", repos }], null, 2)}\n`,
    "utf-8",
  );
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

  // #646 review - reproduction. Without `-z`, git's
  // default core.quotePath wraps a path containing a non-ASCII byte (or other
  // "unusual" character) in double quotes and C-escapes it in `ls-files -s`
  // output (e.g. `"vendor/caf\303\251"`); parsed as a literal string, that
  // quoted-and-escaped text never resolves to the real on-disk directory, so
  // the submodule is silently skipped and a reviewed-then-edited submodule at
  // such a path ships unreviewed.
  test("detects a submodule at a non-ASCII path (git core.quotePath) via -z, not the default quoted form", () => {
    const subDir = mkdtempSync(join(tmpdir(), "t244-fp-sub-"));
    try {
      git(subDir, ["init", "-q"]);
      git(subDir, ["config", "user.email", "t@test"]);
      git(subDir, ["config", "user.name", "t"]);
      writeFileSync(join(subDir, "lib.ts"), "export const v = 1;\n", "utf-8");
      git(subDir, ["add", "-A"]);
      git(subDir, ["commit", "-qm", "sub init"]);

      seedGitRepo(dir);
      git(dir, [
        "-c", "protocol.file.allow=always",
        "submodule", "add", "-q", subDir, "vendor/café-módulo",
      ]);
      git(dir, ["commit", "-qm", "add accented-path submodule"]);

      const fp1 = workspaceSourceFingerprint(dir);
      expect(fp1).not.toBeNull();

      // Edit the submodule's tracked file WITHOUT committing inside it.
      writeFileSync(
        join(dir, "vendor", "café-módulo", "lib.ts"),
        "export const v = 2;\n",
        "utf-8",
      );
      const fp2 = workspaceSourceFingerprint(dir);
      expect(fp2).not.toBe(fp1);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  }, 20000);

  // #646 review P2 - the aidlc-workspace exclusion was top-level
  // only; the type-check sensor anchors `.aidlc-sensors/.tsbuildinfo` at the
  // tsconfig dir (aidlc-sensor-type-check.ts's sensorsDir), which a monorepo
  // subpackage can nest arbitrarily deep, so nested engine-written churn
  // there altered the fingerprint with no real source change.
  test("excludes a nested .aidlc-sensors cache (any depth), but not real nested source", () => {
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

    // A REAL nested source file at the same depth DOES change the fingerprint
    // - proves the exclusion targets exactly .aidlc-sensors, not the whole
    // subdirectory tree.
    writeFileSync(join(dir, "services", "backend", "main.ts"), "export const x = 1;\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);

    // Sanity: the original top-level tracked file is still part of the tree
    // (the exclusion did not accidentally swallow real root-level content).
    expect(existsSync(src)).toBe(true);
  });

  // #646 review - reproduction. Unlike .aidlc-sensors, `aidlc`/`.aidlc` are
  // anchored at the top level of the dir that CARRIES the workspace shell:
  // they never legitimately nest inside application source. An earlier fix
  // applied the any-depth glob to all four names alike, which silently
  // dropped REAL application source that happens to live under a directory
  // coincidentally named `aidlc` (e.g. a feature module named after the
  // methodology itself) - a source-freshness bypass, since an edit under that
  // path would never invalidate a stale receipt. Occurrences at the
  // shell-carrying dir's own top level still exclude correctly (they ARE the
  // framework's own shell there); only the nested, coincidentally-named case
  // is no longer swallowed.
  test("excludes aidlc/.aidlc only where the workspace shell lives, never nested application source", () => {
    seedGitRepo(dir);
    const fp1 = workspaceSourceFingerprint(dir);

    // Top-level occurrences - genuinely the framework's own shell here - are
    // still excluded. `.aidlc/worktrees/` is where Bolt worktrees live
    // (worktreePath), covered by the `.aidlc/` entry.
    mkdirSync(join(dir, "aidlc"), { recursive: true });
    writeFileSync(join(dir, "aidlc", "x.md"), "record\n", "utf-8");
    mkdirSync(join(dir, ".aidlc", "worktrees"), { recursive: true });
    writeFileSync(join(dir, ".aidlc", "worktrees", "x.md"), "shell\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);

    // REAL application source nested under a directory coincidentally named
    // `aidlc` (not the shell's own top level) DOES change the fingerprint -
    // the bug this test guards was: it did not.
    mkdirSync(join(dir, "src", "aidlc"), { recursive: true });
    writeFileSync(join(dir, "src", "aidlc", "parser.ts"), "export function parse() {}\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  });

  // #646 review - the pathspecs are directory-anchored (trailing slash). A
  // plain pathspec also matches a FILE of that name, so a root file named
  // `aidlc` - a plausible CLI wrapper - was being dropped from the walk with
  // no framework reason at all.
  test("a root FILE named aidlc is application source; only the directory is the shell", () => {
    seedGitRepo(dir);
    const fp1 = workspaceSourceFingerprint(dir);

    writeFileSync(join(dir, "aidlc"), "#!/bin/sh\nexec bun ./cli.ts \"$@\"\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  });

  // #646 review - the exclusion was applied relative to EVERY fingerprinted
  // repo dir, so for a recorded sibling repo it stripped `repo-a/aidlc/**`.
  // But the record tree is the SIBLING `<workspace>/aidlc/` (repoDir /
  // resolveConstructionRepo) and Bolt worktrees are `<workspace>/.aidlc/
  // worktrees/` (worktreePath) - neither ever legitimately lives inside a
  // repo, where a directory of that name is application source. Reproduced:
  // the fingerprint was byte-identical after writing repo-a/aidlc/*.
  test("a directory named aidlc inside a REGISTERED sibling repo is application source", () => {
    const repoA = join(dir, "repo-a");
    mkdirSync(repoA, { recursive: true });
    seedGitRepo(repoA);
    registerRepos(dir, ["repo-a"]);

    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).not.toBeNull();

    mkdirSync(join(repoA, "aidlc"), { recursive: true });
    writeFileSync(join(repoA, "aidlc", "application.ts"), "export const real = 1;\n", "utf-8");
    const fp2 = workspaceSourceFingerprint(dir);
    expect(fp2).not.toBe(fp1);

    // Same for `.aidlc` one level in, and a control that ordinary source
    // still moves the hash (so the assertion above is not vacuous).
    mkdirSync(join(repoA, ".aidlc"), { recursive: true });
    writeFileSync(join(repoA, ".aidlc", "config.ts"), "export const cfg = 1;\n", "utf-8");
    const fp3 = workspaceSourceFingerprint(dir);
    expect(fp3).not.toBe(fp2);

    writeFileSync(join(repoA, "control.ts"), "export const control = 1;\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp3);
  });

  // The same defect one level further down: the recursion fingerprinted each
  // submodule with the shell exclusion applied to the submodule's own root.
  test("a directory named aidlc inside an initialized submodule is that submodule's source", () => {
    const subDir = mkdtempSync(join(tmpdir(), "t244-fp-sub-"));
    try {
      git(subDir, ["init", "-q"]);
      git(subDir, ["config", "user.email", "t@test"]);
      git(subDir, ["config", "user.name", "t"]);
      writeFileSync(join(subDir, "lib.ts"), "export const v = 1;\n", "utf-8");
      git(subDir, ["add", "-A"]);
      git(subDir, ["commit", "-qm", "sub init"]);

      seedGitRepo(dir);
      git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subDir, "vendor/lib"]);
      git(dir, ["commit", "-qm", "add submodule"]);

      const fp1 = workspaceSourceFingerprint(dir);
      mkdirSync(join(dir, "vendor", "lib", "aidlc"), { recursive: true });
      writeFileSync(
        join(dir, "vendor", "lib", "aidlc", "application.ts"),
        "export const real = 1;\n",
        "utf-8",
      );
      expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  }, 20000);

  // The nested-source regression from the same review round must hold in the
  // multi-repo layout too, not just the legacy single-repo one.
  test("nested source under a coincidentally-named dir holds in the multi-repo layout", () => {
    const repoA = join(dir, "repo-a");
    mkdirSync(repoA, { recursive: true });
    seedGitRepo(repoA);
    registerRepos(dir, ["repo-a"]);

    const fp1 = workspaceSourceFingerprint(dir);
    mkdirSync(join(repoA, "src", "aidlc"), { recursive: true });
    writeFileSync(join(repoA, "src", "aidlc", "engine.ts"), "export const e = 1;\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  });

  // The any-depth `.aidlc-sensors` match is orthogonal to the shell split and
  // must survive it inside a registered repo, where no shell exclusion applies.
  test("a nested .aidlc-sensors cache inside a registered sibling repo is still excluded", () => {
    const repoA = join(dir, "repo-a");
    mkdirSync(repoA, { recursive: true });
    seedGitRepo(repoA);
    registerRepos(dir, ["repo-a"]);

    const fp1 = workspaceSourceFingerprint(dir);
    mkdirSync(join(repoA, "packages", "pkg", ".aidlc-sensors"), { recursive: true });
    writeFileSync(
      join(repoA, "packages", "pkg", ".aidlc-sensors", "tsbuildinfo"),
      "cache\n",
      "utf-8",
    );
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);
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

  // #646 review - reproduction of the newest-receipt-only
  // bypass: alpha is reviewed, then TAMPERED (edited with no new review), then
  // beta is coded and reviewed - beta's receipt stamps a fingerprint over the
  // CURRENT tree, which already contains alpha's unreviewed edit. Comparing
  // only the newest receipt to the current tree passes here even though
  // nobody ever reviewed alpha's edit. Must refuse.
  test("a unit tampered after its own review, then masked by a later unit's review, must still refuse", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code v1"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    // Tampered with NO new review recorded for alpha.
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 999; // snuck in\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha TAMPERED, no re-review"]);

    writeFileSync(join(proj, "beta.ts"), "export const beta = 2;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("source-fingerprint mismatch");
  });

  // Same bypass, but proves the additions-only chain walk is not just an
  // adjacent-pair special case: the tamper sits between the 2nd and 3rd
  // review in a 3-unit chain (alpha -> beta -> TAMPER alpha -> gamma), so a
  // loop bug that only checked the first or last transition would miss it.
  test("a 3-unit chain with a mid-chain tamper (alpha tampered between beta's and gamma's review) must still refuse", () => {
    const dagDir = join(seededRecordDir(proj), "inception", "units-generation");
    writeFileSync(
      join(dagDir, "unit-of-work-dependency.md"),
      "```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n  - name: gamma\n    depends_on: []\n```\n",
      "utf-8",
    );

    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    writeFileSync(join(proj, "beta.ts"), "export const beta = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    // Tampered AFTER beta's review, before gamma's - no new review for alpha.
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 999; // snuck in after beta\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha TAMPERED between beta and gamma"]);

    writeFileSync(join(proj, "gamma.ts"), "export const gamma = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "gamma code"]);
    recordReview(proj, "code-generation", REVIEWER, "gamma");

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("source-fingerprint mismatch");
  });

  // #646 review (inline comment on aidlc-state.ts:1430) -
  // the reviewer's own exact reproduction, distinct from the two above: it is
  // an EARLIER unit (alpha) that gets RE-reviewed after a LATER unit (beta)
  // is tampered, not a later unit's first review masking an earlier one. The
  // reviewer's concern was that the newest fingerprint (stamped at alpha's
  // second review) matches the workspace while beta's now-stale receipt
  // remains in reviewedUnits. Must still refuse.
  test("re-reviewing an earlier unit must not launder a later unit's untouched-since tamper", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    writeFileSync(join(proj, "beta.ts"), "export const beta = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    // Tamper beta, no new review for beta.
    writeFileSync(join(proj, "beta.ts"), "export const beta = 999; // snuck in\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta TAMPERED"]);

    // Re-review alpha (not beta) - alpha's own content is unchanged, but the
    // tree now includes beta's unreviewed edit.
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("source-fingerprint mismatch");
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
