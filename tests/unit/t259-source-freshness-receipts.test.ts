// covers: function:workspaceSourceFingerprint
//
// t259 - reviewer receipts bound to workspace source state (#629).
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
//   4. MULTI-UNIT POLICY (cli) - what the workspace-global hash proves and
//      what it does not. It proves source-state equality against the NEWEST
//      recorded review, so the ordinary sequential run, the §12a rework loop
//      and shared-file integration all pass. It does NOT prove per-unit
//      attribution: an earlier unit's edit masked by a later unit's review,
//      and an addition no reviewer was shown, are accepted - the documented
//      policy #629's acceptance criterion allows. Those rows assert the
//      limitation deliberately and go red when attribution lands.
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
  verdict = "READY",
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
    verdict,
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

describe("t259 workspace source fingerprint (in-process)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "t259-fp-"));
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
    const plain = mkdtempSync(join(tmpdir(), "t259-plain-"));
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
    const subDir = mkdtempSync(join(tmpdir(), "t259-fp-sub-"));
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
    const subDir = mkdtempSync(join(tmpdir(), "t259-fp-sub-"));
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
  // there altered the fingerprint with no real source change. The cache is
  // matched by the path the engine actually writes (sensorsDir -> docsRoot ->
  // intentsDir -> workspaceRoot), not by its leaf name - see the sibling test
  // below for why the leaf alone is not safe to exclude.
  test("excludes a nested .aidlc-sensors cache (any depth), but not real nested source", () => {
    const src = seedGitRepo(dir);
    const fp1 = workspaceSourceFingerprint(dir);

    // Engine-written sensor cache, nested under a monorepo subpackage - not at
    // the workspace root. The tsconfig anchor is `services/backend`, so the
    // cache lands at the anchor's own `aidlc/spaces/<space>/intents/` root.
    const cache = join(
      dir, "services", "backend", "aidlc", "spaces", "default", "intents", ".aidlc-sensors",
    );
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "tsbuildinfo"), "cache\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);

    // The per-record form (an active intent) resolves one level deeper and is
    // excluded by the same rule.
    const recordCache = join(
      dir, "services", "backend", "aidlc", "spaces", "default", "intents",
      "add-login-ab12cd34", ".aidlc-sensors", "code-generation",
    );
    mkdirSync(recordCache, { recursive: true });
    writeFileSync(join(recordCache, "required-sections-1.md"), "finding\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);

    // A REAL nested source file at the same depth DOES change the fingerprint
    // - proves the exclusion targets exactly the cache, not the whole
    // subdirectory tree.
    writeFileSync(join(dir, "services", "backend", "main.ts"), "export const x = 1;\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);

    // Sanity: the original top-level tracked file is still part of the tree
    // (the exclusion did not accidentally swallow real root-level content).
    expect(existsSync(src)).toBe(true);
  });

  // #646 review - reproduction. Depth tolerance for the sensor cache was
  // implemented as a bare `**/.aidlc-sensors/**` leaf match, which excludes ANY
  // directory of that name - so an application tracking its own source under a
  // dot-prefixed, framework-named directory could be edited or DELETED without
  // moving the fingerprint, and a receipt bound to it stayed valid.
  test("a .aidlc-sensors directory outside the engine's cache path is real source", () => {
    seedGitRepo(dir);
    mkdirSync(join(dir, "src", ".aidlc-sensors"), { recursive: true });
    const shipped = join(dir, "src", ".aidlc-sensors", "shipped.ts");
    writeFileSync(shipped, "export const rule = 1;\n", "utf-8");

    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).not.toBeNull();

    // Editing it must move the fingerprint - it is application source that no
    // reviewer signed off on otherwise.
    writeFileSync(shipped, "export const rule = 2;\n", "utf-8");
    const fp2 = workspaceSourceFingerprint(dir);
    expect(fp2).not.toBe(fp1);

    // Deleting it must move it too: the leaf-name exclusion hid removals as
    // well as edits.
    rmSync(shipped);
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp2);
  });

  // #646 review P2 - a configured `clean` filter runs as content enters the
  // index, so a tree sha hashes the FILTERED bytes. A lossy filter mapped two
  // different worktrees onto one fingerprint, and the stage executes against
  // the bytes the reviewer read - so a reviewed-then-edited file shipped with a
  // matching receipt.
  test("a lossy clean filter cannot collapse two worktrees onto one fingerprint", () => {
    const src = seedGitRepo(dir);
    // Lossy by construction: it drops trailing whitespace on the way in. The
    // driver has to live in the reader's own config - a .gitattributes alone is
    // inert - which is why this is not injectable by pushing to the repo.
    git(dir, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    writeFileSync(join(dir, ".gitattributes"), "app.ts filter=tidy\n", "utf-8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "filter"]);

    writeFileSync(src, "export const answer = 42;\n", "utf-8");
    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).not.toBeNull();

    // Same content to the filter, DIFFERENT bytes on disk. This is the case
    // that collapsed.
    writeFileSync(src, "export const answer = 42;   \n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);

    // Restoring the exact bytes restores the fingerprint - still content
    // addressed, not a one-way invalidation.
    writeFileSync(src, "export const answer = 42;\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);

    // And a real semantic edit still moves it (the filter path did not become
    // the only thing being compared).
    writeFileSync(src, "export const answer = 43;\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  });

  // The raw-content binding is scoped to paths a clean driver actually touches,
  // so a repo that filters nothing must keep the bare tree sha it had before -
  // otherwise every receipt stamped by the shipped build would stop comparing.
  test("no configured clean filter leaves the fingerprint untouched", () => {
    seedGitRepo(dir);
    const fp1 = workspaceSourceFingerprint(dir);
    // A .gitattributes naming a driver that is NOT configured is inert: git
    // warns and stores the content verbatim, so nothing needs raw binding.
    writeFileSync(join(dir, ".gitattributes"), "app.ts filter=absent\n", "utf-8");
    git(dir, ["add", "-A"]);
    const fp2 = workspaceSourceFingerprint(dir);
    expect(fp2).not.toBeNull();
    expect(fp2).not.toBe(fp1); // the new tracked file itself moved it
    expect(workspaceSourceFingerprint(dir)).toBe(fp2); // and it is stable
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
    const subDir = mkdtempSync(join(tmpdir(), "t259-fp-sub-"));
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

  // The depth-tolerant sensor-cache match is orthogonal to the shell split and
  // must survive it inside a registered repo, where no shell exclusion applies.
  test("a nested .aidlc-sensors cache inside a registered sibling repo is still excluded", () => {
    const repoA = join(dir, "repo-a");
    mkdirSync(repoA, { recursive: true });
    seedGitRepo(repoA);
    registerRepos(dir, ["repo-a"]);

    const fp1 = workspaceSourceFingerprint(dir);
    const cache = join(
      repoA, "packages", "pkg", "aidlc", "spaces", "default", "intents", ".aidlc-sensors",
    );
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "tsbuildinfo"), "cache\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).toBe(fp1);

    // ...while a `.aidlc-sensors` directory that is NOT on the engine's cache
    // path stays real source inside a registered repo too - the sibling-repo
    // walk uses the same rule, so the leaf-name blind spot cannot survive here.
    mkdirSync(join(repoA, "src", ".aidlc-sensors"), { recursive: true });
    writeFileSync(
      join(repoA, "src", ".aidlc-sensors", "shipped.ts"),
      "export const rule = 1;\n",
      "utf-8",
    );
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  });
});

describe("t259 receipt stamping + completion guard (cli)", () => {
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

// What the workspace-global fingerprint does and does not prove on a
// for_each: unit-of-work stage, where receipts are per-unit but the engine
// presents ONE stage-level gate after ALL units are built (#646 review).
//
// It proves SOURCE-STATE EQUALITY: the current tree is identical to the one
// the newest recorded review inspected. It does NOT prove PER-UNIT
// ATTRIBUTION - one hash cannot say which unit wrote a given file, so source
// changed before that newest review passes, and a fresh receipt re-validates
// every earlier one. An earlier revision tried to recover attribution from the
// diff SHAPE (every consecutive transition a pure addition); it was removed
// after being reproduced failing in both directions - refusing the §12a rework
// loop and ordinary shared-file integration, while still admitting an
// addition nobody reviewed. #629's acceptance criterion allows this via
// "ambiguous attribution fails closed OR FOLLOWS AN EXPLICITLY DOCUMENTED
// POLICY"; the policy is stated in the CHANGELOG, docs/reference/
// 12-state-machine.md and verifyReviewerPrecondition's own comment block, and
// pinned by the two limitation tests below. When per-unit attribution lands
// those two turn red on purpose.
describe("t259 multi-unit flow: what the workspace-global fingerprint does and does not prove", () => {
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

  // #646 review - the protocol's own rework loop. stage-protocol.md §12a
  // requires recording a NOT-READY receipt, re-invoking the lead to fix the
  // artifact IN PLACE, then re-reviewing. Fixing in place is an `M` transition
  // between the two receipts, which the removed additions-only rule refused -
  // even though the newest fingerprint EQUALS the current tree, i.e. the
  // reviewer inspected exactly the source being completed. Nothing here is
  // tampered; refusing this refuses the documented repair loop.
  test("the stage-protocol §12a rework loop (NOT-READY, fix in place, re-review) must not refuse", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code v1"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha", "NOT-READY");

    // §12a step 3: the lead addresses the findings and updates the artifact.
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1; // finding addressed\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha v2 addresses review findings"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    writeFileSync(join(proj, "beta.ts"), "export const beta = 2;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.out).not.toContain("source-fingerprint mismatch");
    expect(r.rc).toBe(0);
  });

  // #646 review - the second `M`-shaped legitimate transition: a unit that
  // wires itself into a file an earlier unit already created. Ordinary
  // integration, not tampering - beta's own reviewer saw the wiring.
  test("a second unit modifying a pre-existing shared file must not refuse", () => {
    writeFileSync(join(proj, "index.ts"), "export const wired: string[] = [];\n", "utf-8");
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code + index"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    writeFileSync(join(proj, "beta.ts"), "export const beta = 2;\n", "utf-8");
    writeFileSync(join(proj, "index.ts"), "export const wired = ['alpha', 'beta'];\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code + wire into index"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.out).not.toContain("source-fingerprint mismatch");
    expect(r.rc).toBe(0);
  });

  // DOCUMENTED LIMITATION (#646 review, first reported as a laundering bypass
  // on aidlc-state.ts). alpha is reviewed, then edited with NO new review,
  // then beta is coded and reviewed - beta's receipt stamps a fingerprint over
  // the CURRENT tree, which already contains alpha's unreviewed edit, so the
  // newest-matches-current comparison passes. The finding is real and is NOT
  // fixed here: a workspace-global hash cannot attribute the changed file to
  // alpha. Per #629's "explicitly documented policy" branch this is accepted
  // and written down rather than guessed at; see the describe comment. This
  // test asserts the documented behaviour so the policy is visible in code,
  // and goes red when per-unit attribution lands.
  test("a unit edited after its own review, then masked by a later unit's review, is accepted (documented limitation)", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code v1"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    // Edited with NO new review recorded for alpha.
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 999; // no re-review\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha edited, no re-review"]);

    writeFileSync(join(proj, "beta.ts"), "export const beta = 2;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.out).not.toContain("source-fingerprint mismatch");
    expect(r.rc).toBe(0);
  });

  // DOCUMENTED LIMITATION, the inverse ordering (#646 review, inline comment
  // on aidlc-state.ts): an EARLIER unit is RE-reviewed after a LATER unit was
  // edited, so the newest fingerprint (stamped at alpha's second review)
  // matches the workspace while beta's now-stale receipt survives. Same root
  // cause, same accepted policy, same red-on-attribution intent.
  test("re-reviewing an earlier unit carries a later unit's stale receipt (documented limitation)", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    writeFileSync(join(proj, "beta.ts"), "export const beta = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    // Edit beta, no new review for beta.
    writeFileSync(join(proj, "beta.ts"), "export const beta = 999; // no re-review\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta edited"]);

    // Re-review alpha (not beta) - alpha's own content is unchanged, but the
    // tree now includes beta's unreviewed edit.
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.out).not.toContain("source-fingerprint mismatch");
    expect(r.rc).toBe(0);
  });

  // DOCUMENTED LIMITATION - the `A`-shaped case, which the removed rule never
  // blocked either: an added file is exactly as unreviewed as a modified one.
  // Reachable in practice because the per-unit reviewer is briefed with only
  // its own unit's artifacts (stage-protocol §12a), so beta's reviewer is
  // never pointed at this file. Asserting rc 0 states the policy explicitly
  // rather than leaving the gap undocumented.
  test("an addition nobody reviewed is accepted by the workspace-global binding (documented limitation)", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");

    writeFileSync(join(proj, "unreviewed.ts"), "export const extra = () => process.env;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "addition no reviewer was shown"]);

    writeFileSync(join(proj, "beta.ts"), "export const beta = 2;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta");

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).toBe(0);
  });

  // #646 review - the recorded-repo layout is the DEFAULT (sibling
  // auto-discovery populates `repos` at intent birth via resolveBirthRepoSet
  // -> discoverSiblingRepos), and its fingerprint is a sha256 composite over
  // the roof's child repos rather than a single tree object. The removed rule
  // could never consume that shape at all. What must hold: a clean two-unit
  // run passes, and an edit after the last review still refuses.
  test("a recorded-repo two-unit run passes clean and refuses after a post-review edit", () => {
    const repoA = join(proj, "repo-a");
    mkdirSync(repoA, { recursive: true });
    seedGitRepo(repoA);
    const regPath = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
    const rows = JSON.parse(readFileSync(regPath, "utf-8")) as Array<Record<string, unknown>>;
    rows[0].repos = ["repo-a"];
    writeFileSync(regPath, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");

    writeFileSync(join(repoA, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    recordReview(proj, "code-generation", REVIEWER, "alpha");
    writeFileSync(join(repoA, "beta.ts"), "export const beta = 2;\n", "utf-8");
    recordReview(proj, "code-generation", REVIEWER, "beta");

    const clean = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(clean.out).not.toContain("source-fingerprint mismatch");
    expect(clean.rc).toBe(0);

    // Now edit inside the recorded repo after the last review: must refuse.
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
    guarded(proj, ["gate-start", "code-generation"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha");
    recordReview(proj, "code-generation", REVIEWER, "beta");
    writeFileSync(join(repoA, "alpha.ts"), "export const alpha = 999;\n", "utf-8");
    const dirty = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(dirty.rc).not.toBe(0);
    expect(dirty.out).toContain("source-fingerprint mismatch");
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
describe("t259 settled-swarm exemption from fingerprint reconciliation (#646 review P1#2)", () => {
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
describe("t259 swarm finalize source-fingerprint check (#646 review P1#3)", () => {
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
