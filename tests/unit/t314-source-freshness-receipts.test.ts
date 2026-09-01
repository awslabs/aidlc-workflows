// covers: function:workspaceSourceFingerprint
// covers: function:gitCommitSourceListing
//
// t314 - reviewer receipts bound to workspace source state (#629).
//
// PR #569's freshness guard invalidates receipts via ARTIFACT_CREATED/UPDATED
// events for declared record artifacts - but code-generation produces
// application source OUTSIDE the record, and workspace writes deliberately
// emit no audit events. A source file could therefore change after the
// architecture reviewer recorded a terminal verdict and the stale receipt
// still satisfied the completion guard. The fix binds the receipt to a
// deterministic, bounded filesystem fingerprint shared by Git, non-Git, and
// missing-Git workspaces. The fingerprint is stamped on REVIEW_COMPLETED by
// `aidlc-log.ts review` and recomputed/compared by verifyReviewerPrecondition
// on every completion route. This file pins:
//
//   1. FINGERPRINT SEMANTICS (in-process) - deterministic; content-addressed
//      (revert restores it); sensitive to tracked edits AND untracked adds;
//      bindable off-git; never mutates the real index.
//   2. STAMPING (cli) - `review --verdict` records `Source Fingerprint` for
//      the workspace_requires stage (code-generation) and NOT for a
//      record-artifact stage (feasibility).
//   3. GUARD (cli) - approve passes while the source matches; a post-review
//      source edit refuses with the source-fingerprint-mismatch message; the
//      AIDLC_SKIP_SOURCE_FRESHNESS=1 off-switch restores the legacy pass;
//      genuinely pre-modern receipts retain migration fail-open behavior.
//   4. MULTI-UNIT ATTRIBUTION (cli) - the newest global fingerprint remains the
//      outer workspace boundary, while per-Unit manifests/snapshots bind each
//      Unit's paths. Newer validated claims may own intentional shared-file
//      integration; stale owners are invalidated individually, and changes
//      outside the fresh claims union fail closed against the stage baseline.
//
// Mechanism: MIXED - in-process import for the fingerprint pins, spawns of the
// real dist tools (log, state) for the stamping + guard rows. The guard rows
// ride the mid-ideation state fixture with NO units doc, so code-generation's
// per-unit branch resolves `none` and exercises the stage-level fallback -
// exactly the receipt path the fingerprint filter protects.

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  boltSlugForUnit,
  gitCommitSourceListing,
  readAllAuditShards,
  sourceBaselineAuditFields,
  reviewArtifactFingerprint,
  resolveStage,
  shapeSourceSnapshotIndex,
  workspaceSourceFingerprint,
  workspaceSourceListing,
  workspaceSourcePathIsExcluded,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  FIXTURES_DIR,
  cleanupTestProject,
  cleanupWorktreeFixture,
  createTestProject,
  resetAidlcEnv,
  seedBoltDag,
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
const WORKTREE_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent"; // code-generation's declared reviewer

function git(dir: string, args: string[]): void {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
  }
}

function singleGitMetadataLineForTest(raw: string): string {
  const line = raw.replace(/\r?\n$/, "");
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) {
    throw new Error("expected one Git metadata line");
  }
  return line;
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
  claimPaths?: Array<{ path: string; repo?: string }>,
): void {
  // Review requests require every declared output. Seed the minimal real
  // contract in fixtures that focus on source freshness; never overwrite a
  // test's content.
  const definition = resolveStage(stage);
  if (!definition?.review_artifact) {
    throw new Error(`${stage} has no review_artifact`);
  }
  const reviewUnit =
    definition.for_each === "unit-of-work" ? unit : undefined;
  const artifactDir =
    definition.for_each === "unit-of-work"
      ? reviewUnit
        ? join(seededRecordDir(proj), "construction", reviewUnit, stage)
        : join(seededRecordDir(proj), "construction", stage)
      : join(seededRecordDir(proj), definition.phase, stage);
  mkdirSync(artifactDir, { recursive: true });
  const reviewArtifactPath = join(
    artifactDir,
    `${definition.review_artifact}.md`,
  );
  if (!existsSync(reviewArtifactPath)) {
    writeFileSync(reviewArtifactPath, `# ${definition.review_artifact}\n`, "utf-8");
  } else {
    const current = readFileSync(reviewArtifactPath, "utf-8");
    const reviewStart = current.search(/^## Review[ \t]*$/m);
    if (reviewStart !== -1) {
      writeFileSync(
        reviewArtifactPath,
        `${current.slice(0, reviewStart).replace(/\s+$/, "")}\n`,
        "utf-8",
      );
    }
  }
  if (stage === "code-generation" || stage === "functional-design") {
    mkdirSync(artifactDir, { recursive: true });
    const artifacts =
      stage === "code-generation"
        ? [
            "code-generation-plan.md",
            "unit-test-instructions.md",
            "code-summary.md",
            "traceability.json",
          ]
        : [
            "entities.md",
            "rules.md",
            "functional-spec.md",
            "traceability.json",
          ];
    for (const artifact of artifacts) {
      const path = join(artifactDir, artifact);
      if (!existsSync(path)) writeFileSync(path, `# ${artifact}\n`, "utf-8");
    }
  }
  if (stage === "code-generation" && reviewUnit) {
    const listing = workspaceSourceListing(proj);
    const writes = claimPaths ?? (listing === null
      ? []
      : [...listing.keys()].map((key) => {
          const separator = key.indexOf("\0");
          const repo = key.slice(0, separator);
          const path = key.slice(separator + 1);
          return repo.length > 0 ? { repo, path } : { path };
        }));
    writeFileSync(
      join(artifactDir, "source-manifest.json"),
      `${JSON.stringify({ stage, unit: reviewUnit, version: 1, writes }, null, 2)}\n`,
      "utf-8",
    );
  }
  const audit = readAllAuditShards(proj).replace(/\r\n/g, "\n");
  const priorRequests = audit
    .split(/\n---\n/)
    .filter((block) =>
      block.includes("**Event**: REVIEW_REQUESTED") &&
      block.includes(`**Stage**: ${stage}`) &&
      block.includes(`**Reviewer**: ${reviewer}`) &&
      (unit
        ? block.includes(`**Unit**: ${unit}`)
        : !block.includes("**Unit**:")),
    ).length;
  let iteration = String(priorRequests + 1);
  let baseArgs = [
    LOG,
    "review",
    "--stage",
    stage,
    "--reviewer",
    reviewer,
    "--iteration",
    iteration,
    "--project-dir",
    proj,
  ];
  if (unit) baseArgs.push("--unit", unit);
  let requested = spawnSync(BUN, baseArgs, {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    },
  });
  if ((requested.status ?? -1) !== 0) {
    const expected = `${requested.stdout ?? ""}${requested.stderr ?? ""}`.match(
      /next iteration is ([1-9][0-9]*)/,
    )?.[1];
    if (expected !== undefined && expected !== iteration) {
      iteration = expected;
      baseArgs = baseArgs.map((arg, index) =>
        index > 0 && baseArgs[index - 1] === "--iteration" ? iteration : arg
      );
      requested = spawnSync(BUN, baseArgs, {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        },
      });
    }
  }
  if ((requested.status ?? -1) !== 0) {
    throw new Error(
      `recordReview request failed: ${requested.stdout ?? ""}${requested.stderr ?? ""}`,
    );
  }
  appendFileSync(
    reviewArtifactPath,
    `\n## Review\n\n**Verdict:** ${verdict}\n**Reviewer:** ${reviewer}\n**Iteration:** ${iteration}\n\n### Findings\n\nFixture review.\n`,
    "utf-8",
  );
  const args = [...baseArgs, "--verdict", verdict];
  const r = spawnSync(BUN, args, {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    },
  });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`recordReview failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  if (stage === "code-generation") {
    const gate = guarded(proj, ["gate-start", stage]);
    if (!unit && verdict === "READY" && gate.rc !== 0) {
      throw new Error(`gate-start after review failed: ${gate.out}`);
    }
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
// `repos`. This is the layout sibling auto-discovery produces at intent creation
// (resolveIntentRepoSet -> discoverSiblingRepos), so it is the DEFAULT shape,
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

describe("t314 workspace source fingerprint (in-process)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "t314-fp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("deterministic, content-addressed, and edit-sensitive", () => {
    const src = seedGitRepo(dir);
    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
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

  test("never mutates the real index, and fingerprints non-Git workspaces", () => {
    const src = seedGitRepo(dir);
    writeFileSync(src, "export const answer = 99;\n", "utf-8"); // dirty worktree
    workspaceSourceFingerprint(dir);
    const status = spawnSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf-8",
    }).stdout;
    // The edit stays UNSTAGED (` M`) - a staged `M ` would mean the real index
    // was touched by the temp-index walk.
    expect(status).toContain(" M app.ts");
    const plain = mkdtempSync(join(tmpdir(), "t314-plain-"));
    try {
      const first = workspaceSourceFingerprint(plain);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(plain, "app.ts"), "export const plain = true;\n");
      expect(workspaceSourceFingerprint(plain)).not.toBe(first);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("Git repository availability does not change the source identity", () => {
    const src = seedGitRepo(dir);
    const gitMetadata = `${dir}-git-metadata`;
    try {
      const withGit = workspaceSourceFingerprint(dir);
      renameSync(join(dir, ".git"), gitMetadata);
      expect(workspaceSourceFingerprint(dir)).toBe(withGit);
      writeFileSync(src, "export const answer = 100;\n");
      expect(workspaceSourceFingerprint(dir)).not.toBe(withGit);
    } finally {
      if (existsSync(gitMetadata)) {
        renameSync(gitMetadata, join(dir, ".git"));
      }
    }
  });

  test("dependency and cache trees stay outside the boundary while nested application source remains bound", () => {
    seedGitRepo(dir);
    const baseline = workspaceSourceFingerprint(dir);
    for (const name of [
      "node_modules",
      ".cache",
      ".gradle",
      ".mypy_cache",
      ".next",
      ".nuxt",
      ".pytest_cache",
      ".ruff_cache",
      ".tox",
      ".venv",
      "venv",
    ]) {
      const nested = join(dir, name, "deep");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "volatile.js"), `generated("${name}");\n`);
    }
    expect(workspaceSourceFingerprint(dir)).toBe(baseline);

    writeFileSync(
      join(dir, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["src/build/rules.ts"] })}\n`,
    );
    const registeredBaseline = workspaceSourceFingerprint(dir);
    const application = join(dir, "src", "build", "rules.ts");
    mkdirSync(join(application, ".."), { recursive: true });
    writeFileSync(application, "export const rule = 1;\n");
    expect(workspaceSourceFingerprint(dir)).not.toBe(registeredBaseline);
  });

  test("ignored application source outside generated-output boundaries remains bound", () => {
    seedGitRepo(dir);
    writeFileSync(join(dir, ".gitignore"), "ignored-source.ts\n");
    git(dir, ["add", ".gitignore"]);
    git(dir, ["commit", "-qm", "ignore application source fixture"]);
    const ignoredSource = join(dir, "ignored-source.ts");
    writeFileSync(ignoredSource, "export const ignored = 1;\n");
    const baseline = workspaceSourceFingerprint(dir);

    writeFileSync(ignoredSource, "export const ignored = 2;\n");
    expect(workspaceSourceFingerprint(dir)).not.toBe(baseline);
  });

  test("user-owned top-level dot-directories remain application source", () => {
    seedGitRepo(dir);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    const workflow = join(dir, ".github", "workflows", "build.yml");
    writeFileSync(workflow, "name: build-one\n");
    const baseline = workspaceSourceFingerprint(dir);

    writeFileSync(workflow, "name: build-two\n");
    expect(workspaceSourceFingerprint(dir)).not.toBe(baseline);
  });

  test("ignored generated output stays outside the boundary while registered ignored source remains bound", () => {
    seedGitRepo(dir);
    writeFileSync(join(dir, ".gitignore"), "dist/\n");
    writeFileSync(
      join(dir, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["dist/worker.js"] }, null, 2)}\n`,
    );
    git(dir, ["add", ".gitignore", ".aidlc-source-paths.json"]);
    git(dir, ["commit", "-qm", "register ignored source"]);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "worker.js"), "export const worker = 1;\n");
    writeFileSync(join(dir, "dist", "bundle.js"), "generated(1);\n");
    const baseline = workspaceSourceFingerprint(dir);

    writeFileSync(join(dir, "dist", "bundle.js"), "generated(2);\n");
    expect(workspaceSourceFingerprint(dir)).toBe(baseline);

    writeFileSync(join(dir, "dist", "worker.js"), "export const worker = 2;\n");
    expect(workspaceSourceFingerprint(dir)).not.toBe(baseline);
  });

  test("registered binary source under a generated-output boundary remains bound", () => {
    writeFileSync(
      join(dir, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["dist/module.wasm"] })}\n`,
    );
    mkdirSync(join(dir, "dist"), { recursive: true });
    const module = join(dir, "dist", "module.wasm");
    writeFileSync(module, Buffer.from([0, 1, 2, 3]));
    const baseline = workspaceSourceFingerprint(dir);

    writeFileSync(module, Buffer.from([0, 1, 2, 4]));
    expect(workspaceSourceFingerprint(dir)).not.toBe(baseline);
  });

  test("dependency-name symlinks remain outside the source boundary", () => {
    writeFileSync(join(dir, "app.ts"), "export const app = true;\n");
    const external = mkdtempSync(join(tmpdir(), "t304-dependency-store-"));
    try {
      writeFileSync(join(external, "pkg.js"), "module.exports = 1;\n");
      symlinkSync(external, join(dir, "node_modules"), "dir");
      const baseline = workspaceSourceFingerprint(dir);

      writeFileSync(join(external, "pkg.js"), "module.exports = 2;\n");
      expect(workspaceSourceFingerprint(dir)).toBe(baseline);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("workspace-shell and generated-output symlinks remain outside the source boundary", () => {
    writeFileSync(join(dir, "app.ts"), "export const app = true;\n");
    const shellTarget = mkdtempSync(join(tmpdir(), "t304-shell-target-"));
    const generatedTarget = mkdtempSync(join(tmpdir(), "t304-generated-target-"));
    try {
      writeFileSync(join(shellTarget, "audit.md"), "review row one\n");
      writeFileSync(join(generatedTarget, "bundle.js"), "generated(1);\n");
      symlinkSync(shellTarget, join(dir, "aidlc"), "dir");
      symlinkSync(generatedTarget, join(dir, "dist"), "dir");
      const baseline = workspaceSourceFingerprint(dir);
      expect(baseline).not.toBeNull();

      writeFileSync(join(shellTarget, "audit.md"), "review row two\n");
      writeFileSync(join(generatedTarget, "bundle.js"), "generated(2);\n");
      expect(workspaceSourceFingerprint(dir)).toBe(baseline);
    } finally {
      rmSync(shellTarget, { recursive: true, force: true });
      rmSync(generatedTarget, { recursive: true, force: true });
    }
  });

  test("registered source beneath a generated-output symlink remains bindable", () => {
    const sourceTarget = mkdtempSync(join(tmpdir(), "t304-linked-dist-source-"));
    try {
      writeFileSync(
        join(dir, ".aidlc-source-paths.json"),
        `${JSON.stringify({ version: 1, paths: ["dist/worker.js"] })}\n`,
      );
      writeFileSync(join(sourceTarget, "worker.js"), "export const worker = 1;\n");
      symlinkSync(sourceTarget, join(dir, "dist"), "dir");
      const baseline = workspaceSourceFingerprint(dir);
      expect(baseline).toMatch(/^[0-9a-f]{64}$/);

      writeFileSync(join(sourceTarget, "worker.js"), "export const worker = 2;\n");
      expect(workspaceSourceFingerprint(dir)).not.toBe(baseline);
    } finally {
      rmSync(sourceTarget, { recursive: true, force: true });
    }
  });

  test("a registered alias strengthens an earlier source-only traversal of the same target", () => {
    const sourceTarget = mkdtempSync(join(tmpdir(), "t304-alias-strength-"));
    try {
      writeFileSync(
        join(dir, ".aidlc-source-paths.json"),
        `${JSON.stringify({ version: 1, paths: ["dist/module.wasm"] })}\n`,
      );
      writeFileSync(join(sourceTarget, "module.wasm"), Buffer.from([0, 1, 2, 3]));
      symlinkSync(sourceTarget, join(dir, "a-link"), "dir");
      symlinkSync(sourceTarget, join(dir, "dist"), "dir");
      const baseline = workspaceSourceFingerprint(dir);
      expect(baseline).toMatch(/^[0-9a-f]{64}$/);

      writeFileSync(join(sourceTarget, "module.wasm"), Buffer.from([0, 1, 2, 4]));
      expect(workspaceSourceFingerprint(dir)).not.toBe(baseline);
    } finally {
      rmSync(sourceTarget, { recursive: true, force: true });
    }
  });

  test("entry, directory, and dangling-symlink budgets fail closed", () => {
    const originalEntries = process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES;
    const originalDirectories = process.env.AIDLC_TEST_SOURCE_MAX_DIRECTORIES;
    const originalSymlinks = process.env.AIDLC_TEST_SOURCE_MAX_SYMLINKS;
    const restore = (
      name: string,
      value: string | undefined,
    ): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    try {
      process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES = "4";
      for (let i = 0; i < 5; i++) {
        mkdirSync(join(dir, `empty-${i}`));
      }
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);

      process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES = "100";
      process.env.AIDLC_TEST_SOURCE_MAX_DIRECTORIES = "3";
      mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);

      process.env.AIDLC_TEST_SOURCE_MAX_DIRECTORIES = "100";
      process.env.AIDLC_TEST_SOURCE_MAX_SYMLINKS = "2";
      for (let i = 0; i < 3; i++) {
        symlinkSync(`missing-${i}`, join(dir, `dangling-${i}`), "file");
      }
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);

      process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES = "3";
      registerRepos(dir, ["repo-a"]);
      mkdirSync(join(dir, "repo-a"));
      mkdirSync(join(dir, "unrelated-a"));
      mkdirSync(join(dir, "unrelated-b"));
      expect(workspaceSourceFingerprint(dir)).toBeNull();
    } finally {
      restore("AIDLC_TEST_SOURCE_MAX_ENTRIES", originalEntries);
      restore("AIDLC_TEST_SOURCE_MAX_DIRECTORIES", originalDirectories);
      restore("AIDLC_TEST_SOURCE_MAX_SYMLINKS", originalSymlinks);
    }
  });

  test("the ignored-source registry rejects traversal, dependency, and active-harness paths", () => {
    seedGitRepo(dir);
    for (const path of [
      "../outside.ts",
      "node_modules/pkg/source.ts",
      ".claude/custom.ts",
    ]) {
      writeFileSync(
        join(dir, ".aidlc-source-paths.json"),
        `${JSON.stringify({ version: 1, paths: [path] })}\n`,
      );
      expect(workspaceSourceFingerprint(dir)).toBeNull();
    }
  });

  test("source identity excludes every installed harness root regardless of the executing harness", () => {
    seedGitRepo(dir);
    for (const [installedDir, name] of [
      [".claude", "claude"],
      [".kiro", "kiro-ide"],
    ] as const) {
      const dataDir = join(dir, installedDir, "tools", "data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, "harness.json"),
        `${JSON.stringify({ name })}\n`,
      );
      writeFileSync(
        join(dir, installedDir, "managed.ts"),
        `export const harness = ${JSON.stringify(name)};\n`,
      );
    }
    const originalHarnessDir = process.env.AIDLC_HARNESS_DIR;
    try {
      process.env.AIDLC_HARNESS_DIR = ".claude";
      const claudeFingerprint = workspaceSourceFingerprint(dir);
      const claudeListing = workspaceSourceListing(dir);
      process.env.AIDLC_HARNESS_DIR = ".kiro";
      const kiroFingerprint = workspaceSourceFingerprint(dir);
      const kiroListing = workspaceSourceListing(dir);

      expect(claudeFingerprint).not.toBeNull();
      expect(kiroFingerprint).toBe(claudeFingerprint);
      expect(kiroListing).toEqual(claudeListing);
      expect(
        [...(kiroListing?.keys() ?? [])].some(
          (path) => path.includes(".claude/") || path.includes(".kiro/"),
        ),
      ).toBe(false);

      writeFileSync(
        join(dir, ".kiro", "managed.ts"),
        "export const harness = \"changed\";\n",
      );
      expect(workspaceSourceFingerprint(dir)).toBe(kiroFingerprint);

      writeFileSync(join(dir, "app.ts"), "export const app = 2;\n");
      expect(workspaceSourceFingerprint(dir)).not.toBe(kiroFingerprint);
    } finally {
      if (originalHarnessDir === undefined) {
        delete process.env.AIDLC_HARNESS_DIR;
      } else {
        process.env.AIDLC_HARNESS_DIR = originalHarnessDir;
      }
    }
  });

  test("an unverified harness-like directory remains source under every runtime", () => {
    seedGitRepo(dir);
    mkdirSync(join(dir, ".kiro"), { recursive: true });
    const hiddenSource = join(dir, ".kiro", "application.ts");
    writeFileSync(hiddenSource, "export const application = 1;\n");
    const originalHarnessDir = process.env.AIDLC_HARNESS_DIR;
    try {
      process.env.AIDLC_HARNESS_DIR = ".claude";
      const claudeFingerprint = workspaceSourceFingerprint(dir);
      process.env.AIDLC_HARNESS_DIR = ".kiro";
      const kiroFingerprint = workspaceSourceFingerprint(dir);
      expect(kiroFingerprint).toBe(claudeFingerprint);
      expect(
        workspaceSourcePathIsExcluded(dir, ".kiro/application.ts"),
      ).toBe(false);

      writeFileSync(hiddenSource, "export const application = 2;\n");
      expect(workspaceSourceFingerprint(dir)).not.toBe(kiroFingerprint);
    } finally {
      if (originalHarnessDir === undefined) {
        delete process.env.AIDLC_HARNESS_DIR;
      } else {
        process.env.AIDLC_HARNESS_DIR = originalHarnessDir;
      }
    }
  });

  test("the source registry itself must be a regular file", () => {
    seedGitRepo(dir);
    const external = `${dir}-external-source-registry.json`;
    try {
      writeFileSync(
        external,
        `${JSON.stringify({ version: 1, paths: ["dist/worker.js"] })}\n`,
      );
      symlinkSync(external, join(dir, ".aidlc-source-paths.json"), "file");
      git(dir, ["add", "--", ".aidlc-source-paths.json"]);
      git(dir, ["commit", "-qm", "track symlinked source registry"]);
      const head = spawnSync(
        "git",
        ["-C", dir, "rev-parse", "HEAD"],
        { encoding: "utf-8" },
      ).stdout.trim();
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      expect(gitCommitSourceListing(dir, head, true)).toBeNull();

      writeFileSync(external, "not-json\n");
      expect(gitCommitSourceListing(dir, head, true)).toBeNull();
      rmSync(external);
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      expect(gitCommitSourceListing(dir, head, true)).toBeNull();
    } finally {
      rmSync(external, { force: true });
    }
  });

  test("a logical registry alias into a physically excluded tree is rejected", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "worker.ts"),
      "export const dependency = true;\n",
    );
    symlinkSync("node_modules", join(dir, "dist"), "dir");
    writeFileSync(
      join(dir, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["dist/worker.ts"] })}\n`,
    );
    expect(workspaceSourceFingerprint(dir)).toBeNull();
  });

  test("a registry alias cannot enter a reserved harness directory", () => {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(
      join(dir, ".codex", "worker.ts"),
      "export const hidden = true;\n",
    );
    symlinkSync(".codex", join(dir, "dist"), "dir");
    writeFileSync(
      join(dir, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["dist/worker.ts"] })}\n`,
    );
    expect(workspaceSourceFingerprint(dir)).toBeNull();
  });

  test("a registered alias cannot leave the workspace and re-enter it", () => {
    const outside = mkdtempSync(join(tmpdir(), "t314-registry-hop-"));
    try {
      mkdirSync(join(dir, "generated-src"), { recursive: true });
      writeFileSync(
        join(dir, "generated-src", "worker.js"),
        "export const worker = true;\n",
      );
      symlinkSync(
        join(dir, "generated-src"),
        join(outside, "hop"),
        "dir",
      );
      symlinkSync(join(outside, "hop"), join(dir, "dist"), "dir");
      writeFileSync(
        join(dir, ".aidlc-source-paths.json"),
        `${JSON.stringify({ version: 1, paths: ["dist/worker.js"] })}\n`,
      );
      expect(workspaceSourceFingerprint(dir)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // #646 review P2 - a bare `git add -A` records an initialized submodule as a
  // gitlink (its checked-out commit sha) only, so a tracked edit made INSIDE
  // the submodule without committing there leaves the gitlink - and the
  // parent's own write-tree sha - unchanged, shipping a reviewed-then-edited
  // submodule as if nothing had changed.
  test("recurses into an initialized submodule: an uncommitted edit inside it changes the fingerprint", () => {
    const subDir = mkdtempSync(join(tmpdir(), "t314-fp-sub-"));
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

  test("an initialized submodule keeps the same fingerprint and gitlink listing without Git on PATH", () => {
    const subDir = mkdtempSync(join(tmpdir(), "t314-fp-sub-nogit-"));
    const noGitPath = mkdtempSync(join(tmpdir(), "t314-empty-path-"));
    try {
      git(subDir, ["init", "-q"]);
      git(subDir, ["config", "user.email", "t@test"]);
      git(subDir, ["config", "user.name", "t"]);
      writeFileSync(join(subDir, "lib.ts"), "export const v = 1;\n", "utf-8");
      git(subDir, ["add", "-A"]);
      git(subDir, ["commit", "-qm", "sub init"]);

      seedGitRepo(dir);
      git(dir, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        subDir,
        "vendor/sub",
      ]);
      git(dir, ["commit", "-qm", "add submodule"]);
      const nestedDir = join(dir, "vendor", "sub");
      git(nestedDir, ["checkout", "-q", "--detach"]);
      git(nestedDir, ["config", "pack.indexVersion", "1"]);
      git(nestedDir, ["gc", "--prune=now"]);

      const baseline = workspaceSourceFingerprint(dir);
      const nestedHead = spawnSync(
        "git",
        ["-C", nestedDir, "rev-parse", "HEAD"],
        { encoding: "utf-8" },
      ).stdout.trim();
      expect(baseline).not.toBeNull();
      expect(nestedHead).toMatch(/^[0-9a-f]{40,64}$/);

      const gitProbe = spawnSync("git", ["--version"], {
        encoding: "utf-8",
        env: { ...process.env, PATH: noGitPath },
      });
      expect(gitProbe.status ?? -1).not.toBe(0);

      const libPath = join(AIDLC_SRC, "tools", "aidlc-lib.ts");
      const child = spawnSync(
        BUN,
        [
          "-e",
          [
            `const lib = await import(${JSON.stringify(libPath)});`,
            `const project = ${JSON.stringify(dir)};`,
            "const listing = lib.workspaceSourceListing(project);",
            "console.log(JSON.stringify({",
            "  fingerprint: lib.workspaceSourceFingerprint(project),",
            '  gitlink: listing?.get("\\0vendor/sub") ?? null,',
            "}));",
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          env: { ...process.env, PATH: noGitPath },
          timeout: 30_000,
        },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        fingerprint: baseline,
        gitlink: `160000 ${nestedHead}`,
      });

      const marker = singleGitMetadataLineForTest(
        readFileSync(join(nestedDir, ".git"), "utf-8"),
      );
      expect(marker.startsWith("gitdir: ")).toBe(true);
      const pointer = marker.slice("gitdir: ".length);
      const nestedGitDir = isAbsolute(pointer)
        ? pointer
        : resolvePath(nestedDir, pointer);
      const headPath = join(nestedGitDir, "HEAD");
      const originalHead = readFileSync(headPath, "utf-8");
      writeFileSync(headPath, `${"a".repeat(41)}\n`);
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      writeFileSync(headPath, `${"a".repeat(64)}\n`);
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      writeFileSync(headPath, `${"0".repeat(40)}\n`);
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      writeFileSync(headPath, originalHead);
      expect(workspaceSourceFingerprint(dir)).toBe(baseline);

      const configPath = join(nestedGitDir, "config");
      const originalConfig = readFileSync(configPath, "utf-8");
      writeFileSync(
        configPath,
        `${originalConfig}\n[extensions "ignored"]\n\tobjectFormat = sha256\n`,
      );
      expect(workspaceSourceFingerprint(dir)).toBe(baseline);
      const versionOneConfig = originalConfig.replace(
        /repositoryformatversion\s*=\s*0/i,
        "repositoryformatversion = 1",
      );
      expect(versionOneConfig).not.toBe(originalConfig);
      writeFileSync(
        configPath,
        `${versionOneConfig}\n[extensions]\n\tunknownFeature = true\n`,
      );
      expect(workspaceSourceFingerprint(dir)).toBeNull();
      writeFileSync(configPath, originalConfig);
      expect(workspaceSourceFingerprint(dir)).toBe(baseline);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
      rmSync(noGitPath, { recursive: true, force: true });
    }
  }, 30000);

  test("a nested linked worktree resolves shared branch refs from commondir", () => {
    const repo = mkdtempSync(join(tmpdir(), "t314-linked-origin-"));
    try {
      seedGitRepo(repo);
      const linked = join(dir, "linked");
      git(repo, [
        "worktree",
        "add",
        "-q",
        "-b",
        "linked-source",
        linked,
      ]);
      const linkedHead = spawnSync(
        "git",
        ["-C", linked, "rev-parse", "HEAD"],
        { encoding: "utf-8" },
      ).stdout.trim();
      writeFileSync(
        join(repo, "app.ts"),
        "export const answer = 43;\n",
        "utf-8",
      );
      git(repo, ["add", "app.ts"]);
      git(repo, ["commit", "-qm", "advance main"]);
      const otherHead = spawnSync(
        "git",
        ["-C", repo, "rev-parse", "HEAD"],
        { encoding: "utf-8" },
      ).stdout.trim();

      const marker = singleGitMetadataLineForTest(
        readFileSync(join(linked, ".git"), "utf-8"),
      );
      const pointer = marker.slice("gitdir: ".length);
      const linkedGitDir = isAbsolute(pointer)
        ? pointer
        : resolvePath(linked, pointer);
      mkdirSync(join(linkedGitDir, "refs", "heads"), { recursive: true });
      writeFileSync(
        join(linkedGitDir, "refs", "heads", "linked-source"),
        `${otherHead}\n`,
      );
      expect(workspaceSourceListing(dir)?.get("\0linked")).toBe(
        `160000 ${linkedHead}`,
      );

      const commonPath = join(linkedGitDir, "commondir");
      const originalCommon = readFileSync(commonPath, "utf-8");
      writeFileSync(commonPath, "missing-common-dir\n");
      expect(workspaceSourceListing(dir)).toBeNull();
      writeFileSync(commonPath, originalCommon);
      expect(workspaceSourceListing(dir)?.get("\0linked")).toBe(
        `160000 ${linkedHead}`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30000);

  // #646 review - reproduction. Without `-z`, git's
  // default core.quotePath wraps a path containing a non-ASCII byte (or other
  // "unusual" character) in double quotes and C-escapes it in `ls-files -s`
  // output (e.g. `"vendor/caf\303\251"`); parsed as a literal string, that
  // quoted-and-escaped text never resolves to the real on-disk directory, so
  // the submodule is silently skipped and a reviewed-then-edited submodule at
  // such a path ships unreviewed.
  test("detects a submodule at a non-ASCII path (git core.quotePath) via -z, not the default quoted form", () => {
    const subDir = mkdtempSync(join(tmpdir(), "t314-fp-sub-"));
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

  // #646 review P2 - the aidlc-workspace exclusion was top-level only. Before
  // 2.6.94, type-check anchored `.aidlc-sensors/.tsbuildinfo` at the tsconfig
  // dir, so a monorepo subpackage could retain an engine-written cache
  // arbitrarily deep after upgrade. That legacy churn must not alter the
  // fingerprint. The cache is matched by the path the engine wrote
  // (sensorsDir -> docsRoot -> intentsDir -> workspaceRoot), not by its leaf
  // name - see the sibling test below for why the leaf alone is unsafe.
  test("excludes a nested .aidlc-sensors cache (any depth), but not real nested source", () => {
    const src = seedGitRepo(dir);
    const fp1 = workspaceSourceFingerprint(dir);

    // Legacy engine-written sensor cache, nested under a monorepo subpackage -
    // not at the workspace root. Before 2.6.94 the `services/backend` tsconfig
    // anchor gave the cache its own `aidlc/spaces/<space>/intents/` root.
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

  test("live identity binds an external symlink while commit reconstruction stays tree-only during target mutation", () => {
    seedGitRepo(dir);
    git(dir, ["config", "core.symlinks", "true"]);
    git(dir, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    writeFileSync(join(dir, ".gitattributes"), "*.link filter=tidy\n", "utf-8");
    const external = `${dir}-external-target.txt`;
    try {
      writeFileSync(external, "external v1\n", "utf-8");
      symlinkSync(external, join(dir, "outside.link"), "file");
      git(dir, ["add", "--", ".gitattributes", "outside.link"]);
      git(dir, ["commit", "-qm", "tracked filtered symlink"]);
      const head = spawnSync(
        "git",
        ["-C", dir, "rev-parse", "HEAD"],
        { encoding: "utf-8" },
      ).stdout.trim();
      const fp = workspaceSourceFingerprint(dir);
      const committedBefore = gitCommitSourceListing(dir, head, true);
      expect(fp).not.toBeNull();
      expect(committedBefore?.has("\0outside.link")).toBe(true);
      expect(committedBefore?.has("\0outside.link@target")).toBe(false);

      writeFileSync(external, "external v2\n", "utf-8");
      expect(workspaceSourceFingerprint(dir)).not.toBe(fp);
      const committedAfter = gitCommitSourceListing(dir, head, true);
      expect([...(committedAfter ?? new Map()).entries()]).toEqual([
        ...(committedBefore ?? new Map()).entries(),
      ]);
    } finally {
      rmSync(external, { force: true });
    }
  });

  test("commit reconstruction ignores mutable smudge output", () => {
    seedGitRepo(dir);
    const external = mkdtempSync(join(tmpdir(), "t314-smudge-listing-"));
    try {
      const script = join(external, "smudge.mjs");
      const payload = join(external, "payload.txt");
      writeFileSync(
        script,
        [
          'import { readFileSync } from "node:fs";',
          "process.stdin.resume();",
          "process.stdin.on('end', () => {",
          "  process.stdout.write(readFileSync(process.argv.at(-1)));",
          "});",
          "",
        ].join("\n"),
      );
      writeFileSync(payload, "SMUDGED-ONE\n");
      git(dir, [
        "config",
        "filter.mutable.smudge",
        `"${process.execPath}" "${script}" "${payload}"`,
      ]);
      writeFileSync(join(dir, ".gitattributes"), "app.ts filter=mutable\n");
      git(dir, ["add", "--", ".gitattributes", "app.ts"]);
      git(dir, ["commit", "-qm", "track smudged source"]);
      const head = spawnSync(
        "git",
        ["-C", dir, "rev-parse", "HEAD"],
        { encoding: "utf-8" },
      ).stdout.trim();

      const before = gitCommitSourceListing(dir, head, true);
      expect(before).not.toBeNull();
      writeFileSync(payload, "SMUDGED-TWO\n");
      const after = gitCommitSourceListing(dir, head, true);
      expect([...(after ?? new Map()).entries()]).toEqual([
        ...(before ?? new Map()).entries(),
      ]);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("commit reconstruction preserves a batch header split at the 64 KiB refill boundary", () => {
    git(dir, ["init", "-q", "--object-format=sha1"]);
    git(dir, ["config", "user.email", "t@test"]);
    git(dir, ["config", "user.name", "t"]);
    const first = Buffer.alloc(65_482, 0x61);
    const second = Buffer.alloc(65_482, 0x62);
    const third = Buffer.from("tail\n");
    const paths = [
      "a-boundary.bin",
      "b-split-header.bin",
      "c-refill.bin",
    ] as const;
    for (const [path, bytes] of [
      [paths[0], first],
      [paths[1], second],
      [paths[2], third],
    ] as const) {
      writeFileSync(join(dir, path), bytes);
    }
    git(dir, ["add", "--", ...paths]);
    git(dir, ["commit", "-qm", "batch boundary"]);
    const head = spawnSync(
      "git",
      ["-C", dir, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    const oids = paths.map((path) =>
      spawnSync(
        "git",
        ["-C", dir, "rev-parse", `${head}:${path}`],
        { encoding: "utf-8" },
      ).stdout.trim()
    );
    const responseBytes = (oid: string, bytes: Buffer): number =>
      Buffer.byteLength(`${oid} blob ${bytes.length}\n`, "ascii") +
      bytes.length +
      1;
    const firstResponseBytes = responseBytes(oids[0], first);
    const secondResponseBytes = responseBytes(oids[1], second);
    const thirdResponseBytes = responseBytes(oids[2], third);

    // The first response leaves byte 65,535 as the first byte of the second
    // header. The next full refill reaches the third header and overwrites that
    // borrowed buffer position, so a non-owning partial-line slice is corrupted.
    expect(oids.every((oid) => /^[0-9a-f]{40}$/.test(oid))).toBe(true);
    expect(firstResponseBytes).toBe(64 * 1024 - 1);
    expect(secondResponseBytes).toBe(64 * 1024 - 1);
    expect(secondResponseBytes - 1 + thirdResponseBytes).toBeGreaterThanOrEqual(
      64 * 1024,
    );
    expect(oids[1][0]).not.toBe(oids[2][1]);

    const listing = gitCommitSourceListing(dir, head, true);
    expect([...(listing ?? new Map()).entries()]).toEqual(
      paths.map((path, index) => [
        `\0${path}`,
        `100644 ${createHash("sha256")
          .update([first, second, third][index])
          .digest("hex")}`,
      ]),
    );
  });

  test("commit reconstruction never reads a symlinked worktree metadata target", () => {
    seedGitRepo(dir);
    const external = `${dir}-external-worktree-meta.json`;
    try {
      mkdirSync(join(dir, ".aidlc"), { recursive: true });
      writeFileSync(external, `${JSON.stringify({ repoSelector: null })}\n`);
      symlinkSync(
        external,
        join(dir, ".aidlc", "worktree-meta.json"),
        "file",
      );
      git(dir, ["add", "--", ".aidlc/worktree-meta.json"]);
      git(dir, ["commit", "-qm", "track symlinked worktree metadata"]);
      const head = spawnSync(
        "git",
        ["-C", dir, "rev-parse", "HEAD"],
        { encoding: "utf-8" },
      ).stdout.trim();
      const before = gitCommitSourceListing(dir, head, false);
      expect(before?.has("\0.aidlc/worktree-meta.json")).toBe(true);
      expect(before?.has("\0.aidlc/worktree-meta.json@target")).toBe(false);

      writeFileSync(external, "not-json\n");
      const after = gitCommitSourceListing(dir, head, false);
      expect([...(after ?? new Map()).entries()]).toEqual([
        ...(before ?? new Map()).entries(),
      ]);
    } finally {
      rmSync(external, { force: true });
    }
  });

  // #646 review - the gate deciding whether to run the precise `check-attr`
  // scan read only TRACKED `.gitattributes` plus `<dir>/.git/info/attributes`,
  // and asked for `core.attributesFile` without `-C <repo>`. Every missed
  // source is a false pass in the direction that matters: the filter really
  // runs, the tree hashes filtered bytes, and the raw supplement that would
  // have caught the difference is never computed.
  test("core.attributesFile in the repo's own local config binds raw bytes", () => {
    const src = seedGitRepo(dir);
    git(dir, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    const attrs = join(dir, "outside-attributes");
    writeFileSync(attrs, "app.ts filter=tidy\n", "utf-8");
    // Local to THIS repository: a bare `git config` run in the engine's own
    // process never reads it.
    git(dir, ["config", "core.attributesFile", attrs]);

    writeFileSync(src, "export const answer = 42;\n", "utf-8");
    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).not.toBeNull();
    writeFileSync(src, "export const answer = 42;   \n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  });

  test("an ignored worktree .gitattributes file still binds raw bytes", () => {
    const src = seedGitRepo(dir);
    git(dir, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    writeFileSync(join(dir, ".git", "info", "exclude"), ".gitattributes\n", "utf-8");
    writeFileSync(join(dir, ".gitattributes"), "app.ts filter=tidy\n", "utf-8");

    writeFileSync(src, "export const answer = 42;\n", "utf-8");
    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).not.toBeNull();
    writeFileSync(src, "export const answer = 42;   \n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  });

  test("a process-only clean filter cannot collapse two worktrees", () => {
    const src = seedGitRepo(dir);
    const filter = join(dir, "filter-process.mjs");
    writeFileSync(filter, String.raw`
let input = Buffer.alloc(0);
let phase = "hello";
let content = [];
const pkt = (s) => Buffer.concat([Buffer.from((Buffer.byteLength(s) + 4).toString(16).padStart(4, "0")), Buffer.from(s)]);
const send = (...parts) => process.stdout.write(Buffer.concat(parts));
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const n = Number.parseInt(input.subarray(0, 4).toString(), 16);
    if (n === 0) {
      input = input.subarray(4);
      if (phase === "hello") {
        send(pkt("git-filter-server\n"), pkt("version=2\n"), pkt("capability=clean\n"), Buffer.from("0000"));
        phase = "request";
      } else if (phase === "request") {
        phase = "content";
      } else {
        const cleaned = Buffer.concat(content).toString().replace(/[ \t]+$/gm, "");
        send(pkt("status=success\n"), Buffer.from("0000"), pkt(cleaned), Buffer.from("00000000"));
        content = [];
        phase = "request";
      }
      continue;
    }
    if (!Number.isFinite(n) || n < 4 || input.length < n) break;
    const payload = input.subarray(4, n);
    input = input.subarray(n);
    if (phase === "content") content.push(payload);
  }
});
`, "utf-8");
    git(dir, ["config", "filter.tidy.process", `"${process.execPath}" "${filter}"`]);
    writeFileSync(join(dir, ".gitattributes"), "app.ts filter=tidy\n", "utf-8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "process filter"]);

    writeFileSync(src, "export const answer = 42;\n", "utf-8");
    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).not.toBeNull();
    writeFileSync(src, "export const answer = 42;   \n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  }, 20000);

  // Git's built-in `$Id$` conversion needs no driver at all, so scanning for
  // `filter=` alone missed it while it collapsed worktrees just the same.
  test("the built-in ident conversion cannot collapse two worktrees", () => {
    const src = seedGitRepo(dir);
    writeFileSync(join(dir, ".gitattributes"), "app.ts ident\n", "utf-8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "ident"]);

    writeFileSync(src, "const id = '$Id: aaaaaaa $';\n", "utf-8");
    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).not.toBeNull();
    // Both clean back to a bare `$Id$`, so the indexed blob is byte-identical.
    writeFileSync(src, "const id = '$Id: bbbbbbb $';\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  });

  // #646 review - `git ls-files -s -z` ran on the default spawn buffer. A large
  // index overran it, the call failed with ENOBUFS, the submodule and
  // clean-filter scans were skipped, and the bare tree sha came back as if the
  // repository had neither.
  //
  // This uses real worktree files so both the `ls-files` and `check-attr`
  // subprocesses actually cross the default buffer boundary.
  test("a large index does not silently drop the clean-filter binding", () => {
    const src = seedGitRepo(dir);
    git(dir, ["config", "core.autocrlf", "false"]);
    git(dir, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    writeFileSync(join(dir, ".gitattributes"), "app.ts filter=tidy\n", "utf-8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "filter"]);

    // Real worktree paths are required: the temp index's `git add -A` removes
    // synthetic index-only entries before `check-attr` runs. Repeating a long
    // flat filename makes the two-attribute NUL stream exceed Node's default
    // spawn buffer while staying below Windows MAX_PATH.
    for (let i = 0; i < 4500; i++) {
      const name = `module-${String(i).padStart(5, "0")}-${"x".repeat(150)}.ts`;
      writeFileSync(join(dir, name), "export const v = 1;\n", "utf-8");
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "bulk"]);

    writeFileSync(src, "export const answer = 42;\n", "utf-8");
    const fp1 = workspaceSourceFingerprint(dir);
    expect(fp1).not.toBeNull();
    writeFileSync(src, "export const answer = 42;   \n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp1);
  }, 45000);

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
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "commit root framework shell"]);
    const rootHead = spawnSync(
      "git",
      ["-C", dir, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    const rootLive = workspaceSourceListing(dir);
    const rootCommitted = gitCommitSourceListing(dir, rootHead, true);
    for (const path of [
      "\0aidlc/x.md",
      "\0.aidlc/worktrees/x.md",
    ]) {
      expect(rootLive?.has(path)).toBe(false);
      expect(rootCommitted?.has(path)).toBe(false);
    }

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

  test("a root FILE named aidlc is also source without Git", () => {
    const baseline = workspaceSourceFingerprint(dir);
    writeFileSync(join(dir, "aidlc"), "#!/bin/sh\nexec bun ./cli.ts \"$@\"\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(baseline);
  });

  test("snapshot shaping preserves regular files that share boundary names", () => {
    seedGitRepo(dir);
    for (const name of ["aidlc", "dist", "node_modules"]) {
      writeFileSync(join(dir, name), `regular source file ${name}\n`);
    }
    const indexFile = join(
      tmpdir(),
      `t304-boundary-file-index-${process.pid}-${Date.now()}`,
    );
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    try {
      expect(
        spawnSync("git", ["-C", dir, "read-tree", "HEAD"], {
          env,
          encoding: "utf-8",
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["-C", dir, "add", "-A"], {
          env,
          encoding: "utf-8",
        }).status,
      ).toBe(0);
      expect(shapeSourceSnapshotIndex(dir, indexFile, true)).not.toBeNull();
      const tree = spawnSync("git", ["-C", dir, "write-tree"], {
        env,
        encoding: "utf-8",
      }).stdout.trim();
      const files = spawnSync(
        "git",
        ["-C", dir, "ls-tree", "-r", "--name-only", tree],
        { encoding: "utf-8" },
      ).stdout;
      for (const name of ["aidlc", "dist", "node_modules"]) {
        expect(files).toContain(name);
      }
    } finally {
      rmSync(indexFile, { force: true });
    }
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
    git(repoA, ["add", "-A"]);
    git(repoA, ["commit", "-qm", "commit sibling aidlc application source"]);
    const siblingHead = spawnSync(
      "git",
      ["-C", repoA, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    const siblingLive = workspaceSourceListing(dir);
    const siblingCommitted = gitCommitSourceListing(
      repoA,
      siblingHead,
      false,
    );
    expect(
      siblingLive?.has("repo-a\0aidlc/application.ts"),
    ).toBe(true);
    expect(
      siblingLive?.has("repo-a\0.aidlc/config.ts"),
    ).toBe(true);
    expect(siblingCommitted?.has("\0aidlc/application.ts")).toBe(true);
    expect(siblingCommitted?.has("\0.aidlc/config.ts")).toBe(true);

    writeFileSync(join(repoA, "control.ts"), "export const control = 1;\n", "utf-8");
    expect(workspaceSourceFingerprint(dir)).not.toBe(fp3);
  });

  // The same defect one level further down: the recursion fingerprinted each
  // submodule with the shell exclusion applied to the submodule's own root.
  test("a directory named aidlc inside an initialized submodule is that submodule's source", () => {
    const subDir = mkdtempSync(join(tmpdir(), "t314-fp-sub-"));
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

  test("partial multi-repo layouts stay bindable and detect a missing repo appearing", () => {
    const repoA = join(dir, "repo-a");
    mkdirSync(repoA, { recursive: true });
    seedGitRepo(repoA);
    registerRepos(dir, ["repo-a", "repo-b"]);

    const partial = workspaceSourceFingerprint(dir);
    expect(partial).toMatch(/^[0-9a-f]{64}$/);

    const repoB = join(dir, "repo-b");
    mkdirSync(repoB, { recursive: true });
    writeFileSync(join(repoB, "app.ts"), "export const b = true;\n");
    expect(workspaceSourceFingerprint(dir)).not.toBe(partial);
  });

  test("registered repo subsets ignore unrelated sibling repos but bind workspace-roof source", () => {
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    seedGitRepo(repoA);
    seedGitRepo(repoB);
    registerRepos(dir, ["repo-a"]);
    const compose = join(dir, "docker-compose.yml");
    writeFileSync(compose, "services:\n  api:\n    image: one\n");
    const baseline = workspaceSourceFingerprint(dir);
    const repoBMetadata = `${dir}-repo-b-git-metadata`;
    try {
      renameSync(join(repoB, ".git"), repoBMetadata);
      expect(workspaceSourceFingerprint(dir)).toBe(baseline);

      writeFileSync(join(repoB, "app.ts"), "export const unrelated = true;\n");
      expect(workspaceSourceFingerprint(dir)).toBe(baseline);
    } finally {
      if (existsSync(repoBMetadata)) {
        renameSync(repoBMetadata, join(repoB, ".git"));
      }
    }

    writeFileSync(compose, "services:\n  api:\n    image: two\n");
    expect(workspaceSourceFingerprint(dir)).not.toBe(baseline);
  });
});

describe("t314 receipt stamping + completion guard (cli)", () => {
  let proj: string;
  let src: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    src = seedGitRepo(proj);
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
  });

  afterEach(() => cleanupTestProject(proj));

  test("review --verdict stamps Source Fingerprint for code-generation; approve passes while source matches", () => {
    recordReview(proj);
    expect(readAllAuditShards(proj)).toContain("**Source Fingerprint**: ");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.out).not.toContain("project source changed after");
    expect(r.rc).toBe(0);
  }, 60_000);

  test("no stamp for a reviewer-bearing record-artifact stage without workspace_requires", () => {
    recordReview(proj, "functional-design", REVIEWER);
    expect(readAllAuditShards(proj)).toContain("**Event**: REVIEW_COMPLETED");
    expect(readAllAuditShards(proj)).not.toContain("**Source Fingerprint**: ");
  }, 60_000);

  test("a post-review source edit refuses completion with the mismatch message", () => {
    recordReview(proj);
    writeFileSync(src, "export const answer = 1337; // edited after review\n", "utf-8");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("project source changed after");
    expect(r.out).toContain(REVIEWER);
  }, 60_000);

  test("source changed while review is pending cannot become the accepted request baseline", () => {
    const definition = resolveStage("code-generation");
    if (!definition?.review_artifact) {
      throw new Error("code-generation review artifact missing");
    }
    const artifactDir = join(
      seededRecordDir(proj),
      "construction",
      "unit-alpha",
      "code-generation",
    );
    mkdirSync(artifactDir, { recursive: true });
    const artifact = join(
      artifactDir,
      `${definition.review_artifact}.md`,
    );
    const artifactBase = "# code-generation-plan\n";
    writeFileSync(artifact, artifactBase, "utf-8");
    for (const name of [
      "unit-test-instructions.md",
      "code-summary.md",
      "traceability.json",
    ]) {
      const path = join(artifactDir, name);
      if (!existsSync(path)) writeFileSync(path, `${name}\n`, "utf-8");
    }
    const request = [
      LOG,
      "review",
      "--stage",
      "code-generation",
      "--reviewer",
      REVIEWER,
      "--iteration",
      "1",
      "--project-dir",
      proj,
    ];
    const originalSource = readFileSync(src, "utf-8");
    expect(spawnSync(BUN, request, { encoding: "utf-8" }).status).toBe(0);
    writeFileSync(src, "export const answer = 9001; // pending mutation\n", "utf-8");
    appendFileSync(
      artifact,
      `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nPending source mutation.\n`,
      "utf-8",
    );

    const completion = spawnSync(
      BUN,
      [...request, "--verdict", "READY"],
      { encoding: "utf-8" },
    );
    expect(completion.status).not.toBe(0);
    expect(`${completion.stdout}${completion.stderr}`).toContain(
      "workspace source changed after REVIEW_REQUESTED",
    );
    writeFileSync(artifact, artifactBase, "utf-8");
    const retryWhileStale = spawnSync(
      BUN,
      [...request, "--retry-pending"],
      { encoding: "utf-8" },
    );
    expect(retryWhileStale.status).not.toBe(0);
    expect(`${retryWhileStale.stdout}${retryWhileStale.stderr}`).toContain(
      "cannot rebaseline source changed while review was pending",
    );

    writeFileSync(src, originalSource, "utf-8");
    expect(
      spawnSync(BUN, [...request, "--retry-pending"], {
        encoding: "utf-8",
      }).status,
    ).toBe(0);
    appendFileSync(
      artifact,
      `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nFresh source.\n`,
      "utf-8",
    );
    expect(
      spawnSync(BUN, [...request, "--verdict", "READY"], {
        encoding: "utf-8",
      }).status,
    ).toBe(0);
  });

  test("a legacy workspace request upgrades once to request-time source binding", () => {
    const definition = resolveStage("code-generation");
    if (!definition?.review_artifact) {
      throw new Error("code-generation review artifact missing");
    }
    const artifactDir = join(
      seededRecordDir(proj),
      "construction",
      "unit-alpha",
      "code-generation",
    );
    mkdirSync(artifactDir, { recursive: true });
    for (const name of [
      "code-generation-plan.md",
      "unit-test-instructions.md",
      "code-summary.md",
      "traceability.json",
    ]) {
      writeFileSync(join(artifactDir, name), `${name}\n`, "utf-8");
    }
    const artifact = join(
      artifactDir,
      `${definition.review_artifact}.md`,
    );
    const fingerprint = reviewArtifactFingerprint(proj, definition);
    if (!fingerprint) throw new Error("legacy artifact fingerprint failed");
    appendAuditEntry(
      "REVIEW_REQUESTED",
      {
        Stage: "code-generation",
        Reviewer: REVIEWER,
        Iteration: "1",
        "Artifact Fingerprint": fingerprint,
      },
      proj,
    );
    const request = [
      LOG,
      "review",
      "--stage",
      "code-generation",
      "--reviewer",
      REVIEWER,
      "--iteration",
      "1",
      "--project-dir",
      proj,
    ];
    const upgrade = spawnSync(BUN, [...request, "--retry-pending"], {
      encoding: "utf-8",
    });
    expect(upgrade.status, `${upgrade.stdout}${upgrade.stderr}`).toBe(0);
    expect(upgrade.stdout).toContain('"upgrade":"legacy-request"');
    const audit = readAllAuditShards(proj);
    expect(audit).toContain("**Upgrade**: legacy-request");
    expect(audit).toContain("**Source Fingerprint**: ");

    appendFileSync(
      artifact,
      `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nUpgraded legacy request.\n`,
      "utf-8",
    );
    const completed = spawnSync(BUN, [...request, "--verdict", "READY"], {
      encoding: "utf-8",
    });
    expect(completed.status, `${completed.stdout}${completed.stderr}`).toBe(0);
  });

  test("source mismatch permits one real recovery review within the normal budget", () => {
    recordReview(proj);
    writeFileSync(src, "export const answer = 200; // stale within budget\n", "utf-8");
    const refused = guarded(proj, [
      "approve",
      "code-generation",
      "--user-input",
      "ship it",
    ]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("project source changed after");

    recordReview(proj);
    const audit = readAllAuditShards(proj);
    expect(audit).toContain("**Recovery**: stale-receipt");
    expect(audit).toContain("**Iteration**: 2");
    expect(
      guarded(proj, ["approve", "code-generation", "--user-input", "ship it"])
        .rc,
    ).toBe(0);
  }, 60_000);

  test("source mismatch permits one real recovery review after the normal budget is exhausted", () => {
    recordReview(proj, "code-generation", REVIEWER, undefined, "NOT-READY");
    writeFileSync(src, "export const answer = 201; // ordinary repair\n", "utf-8");
    recordReview(proj); // iteration 2: ordinary adversarial budget is now exhausted
    writeFileSync(src, "export const answer = 202; // stale after budget\n", "utf-8");
    const refused = guarded(proj, [
      "approve",
      "code-generation",
      "--user-input",
      "ship it",
    ]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("project source changed after");

    recordReview(proj); // iteration 3: bounded stale-receipt recovery
    const audit = readAllAuditShards(proj);
    expect(audit).toContain("**Recovery**: stale-receipt");
    expect(audit).toContain("**Iteration**: 3");
    expect(
      guarded(proj, ["approve", "code-generation", "--user-input", "ship it"])
        .rc,
    ).toBe(0);
  }, 60_000);

  test("AIDLC_SKIP_SOURCE_FRESHNESS=1 restores the legacy pass (off-switch)", () => {
    recordReview(proj);
    writeFileSync(src, "export const answer = 7;\n", "utf-8");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"], {
      AIDLC_SKIP_SOURCE_FRESHNESS: "1",
    });
    expect(r.rc).toBe(0);
  }, 60_000);

  test("a legacy receipt without the field keeps passing after a source edit (fail-open)", () => {
    recordReview(proj);
    expect(readAllAuditShards(proj)).toContain("**Source Fingerprint**: ");
    stripFingerprintFields(proj);
    writeFileSync(src, "export const answer = 8;\n", "utf-8");
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).toBe(0);
  }, 60_000);

  test("a newly stamped unbindable receipt remains fail-closed while Git is still unavailable", () => {
    recordReview(proj);
    const shard = seededAuditShard(proj);
    writeFileSync(
      shard,
      readFileSync(shard, "utf-8")
        .replace(
          /^\*\*Source Fingerprint\*\*: .*$/gm,
          "**Source Fingerprint**: unbindable",
        )
        .replace(
          /^\*\*Request Source Fingerprint\*\*: .*$/gm,
          "**Request Source Fingerprint**: unbindable",
        ),
      "utf-8",
    );
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("reviewed source boundary could not be fingerprinted");
    expect(r.out).toContain(".aidlc-source-paths.json");
    expect(r.out).not.toContain("project source changed after");
    expect(r.out).not.toContain("revert the source change");
  }, 60_000);

  test("a true advance replay stays idempotent even if source later changes", () => {
    recordReview(proj);
    expect(guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]).rc).toBe(0);
    writeFileSync(src, "export const answer = 99; // after completed transition\n", "utf-8");
    const replay = guarded(proj, ["advance", "code-generation"]);
    expect(replay.rc).toBe(0);
    expect(replay.out).toContain('"replay":true');
  }, 60_000);

  for (const route of ["advance", "finalize", "complete-workflow"] as const) {
    test(`an already-completed stage without receipts recovers through ${route}`, () => {
      expect(guarded(proj, ["checkbox", "code-generation=completed"]).rc).toBe(0);
      const recovery = guarded(proj, [route, "code-generation"]);
      expect(recovery.out).not.toContain("has not reviewed the current output");
      expect(recovery.rc).toBe(0);
    }, 60_000);

    test(`a partial approval crash window still rechecks source freshness through ${route}`, () => {
      recordReview(proj);
      expect(guarded(proj, ["checkbox", "code-generation=completed"]).rc).toBe(0);
      writeFileSync(src, `export const answer = 100; // ${route} after partial approval\n`, "utf-8");
      const recovery = guarded(proj, [route, "code-generation"]);
      expect(recovery.rc).not.toBe(0);
      expect(recovery.out).toContain("project source changed after");
    }, 60_000);

    test(`an artifact change cannot hide stale source during completed-stage recovery through ${route}`, () => {
      recordReview(proj);
      expect(guarded(proj, ["checkbox", "code-generation=completed"]).rc).toBe(0);

      // Change the declared-artifact manifest as well as application source.
      // Recovery skips artifact receipt existence/cardinality for an already
      // [x] stage, but the valid recorded source binding must still be checked.
      const artifactDir = join(
        seededRecordDir(proj),
        "construction",
        "late-unit",
        "code-generation",
      );
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, "code-generation-plan.md"), "# changed after review\n", "utf-8");
      writeFileSync(join(artifactDir, "code-summary.md"), "# changed after review\n", "utf-8");
      writeFileSync(src, `export const answer = 101; // ${route} source + artifact change\n`, "utf-8");

      const recovery = guarded(proj, [route, "code-generation"]);
      expect(recovery.rc).not.toBe(0);
      expect(recovery.out).toContain("project source changed after");
    }, 60_000);
  }

  for (const artifactBinding of ["missing", "malformed"] as const) {
    test(`completed-stage recovery does not trust Source Fingerprint when Artifact Fingerprint is ${artifactBinding}`, () => {
      recordReview(proj);
      const shard = seededAuditShard(proj);
      const audit = readFileSync(shard, "utf-8");
      expect(audit).toContain("**Source Fingerprint**: ");
      const altered =
        artifactBinding === "missing"
          ? audit.replace(/^\*\*Artifact Fingerprint\*\*: .*\r?\n/gm, "")
          : audit.replace(
              /^\*\*Artifact Fingerprint\*\*: .*$/gm,
              "**Artifact Fingerprint**: sha256:not-a-valid-digest",
            );
      writeFileSync(shard, altered, "utf-8");

      expect(guarded(proj, ["checkbox", "code-generation=completed"]).rc).toBe(0);
      writeFileSync(src, `export const answer = 102; // ${artifactBinding} artifact binding\n`, "utf-8");
      const recovery = guarded(proj, ["advance", "code-generation"]);
      expect(recovery.out).not.toContain("project source changed after");
      expect(recovery.rc).toBe(0);
    }, 60_000);
  }
});

describe("t304 non-Git and unavailable-Git completion paths", () => {
  let proj: string;
  let src: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    src = join(proj, "app.ts");
    writeFileSync(src, "export const answer = 42;\n");
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
  });

  afterEach(() => cleanupTestProject(proj));

  test("non-Git review receipt completes normally while source is unchanged", () => {
    recordReview(proj);
    const fingerprint = readAllAuditShards(proj).match(
      /\*\*Source Fingerprint\*\*: ([0-9a-f]{64})/,
    )?.[1];
    expect(fingerprint).toBeDefined();

    const approved = guarded(
      proj,
      ["approve", "code-generation", "--user-input", "ship it"],
    );
    expect(approved.rc, approved.out).toBe(0);
  });

  test("non-Git source edits invalidate the receipt and a fresh review restores completion", () => {
    recordReview(proj);
    writeFileSync(src, "export const answer = 43;\n");
    const stale = guarded(
      proj,
      ["approve", "code-generation", "--user-input", "ship it"],
    );
    expect(stale.rc).not.toBe(0);
    expect(stale.out).toContain("project source changed after");

    recordReview(proj);
    const recovered = guarded(
      proj,
      ["approve", "code-generation", "--user-input", "ship it"],
    );
    expect(recovered.rc, recovered.out).toBe(0);
  });

  test("registered non-Git binary source invalidates completion after review", () => {
    writeFileSync(
      join(proj, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["dist/module.wasm"] })}\n`,
    );
    mkdirSync(join(proj, "dist"), { recursive: true });
    const module = join(proj, "dist", "module.wasm");
    writeFileSync(module, Buffer.from([0, 1, 2, 3]));
    recordReview(proj);

    writeFileSync(module, Buffer.from([0, 1, 2, 4]));
    const stale = guarded(
      proj,
      ["approve", "code-generation", "--user-input", "ship it"],
    );
    expect(stale.rc).not.toBe(0);
    expect(stale.out).toContain("project source changed after");
  });

  test("registered source through a generated-output symlink reviews normally and invalidates on change", () => {
    const sourceTarget = mkdtempSync(join(tmpdir(), "t304-linked-review-source-"));
    try {
      writeFileSync(
        join(proj, ".aidlc-source-paths.json"),
        `${JSON.stringify({ version: 1, paths: ["dist/worker.js"] })}\n`,
      );
      writeFileSync(join(sourceTarget, "worker.js"), "export const worker = 1;\n");
      symlinkSync(sourceTarget, join(proj, "dist"), "dir");
      recordReview(proj);
      expect(readAllAuditShards(proj)).toMatch(
        /\*\*Source Fingerprint\*\*: [0-9a-f]{64}/,
      );

      writeFileSync(join(sourceTarget, "worker.js"), "export const worker = 2;\n");
      const stale = guarded(
        proj,
        ["approve", "code-generation", "--user-input", "ship it"],
      );
      expect(stale.rc).not.toBe(0);
      expect(stale.out).toContain("project source changed after");
    } finally {
      rmSync(sourceTarget, { recursive: true, force: true });
    }
  });

  test("a receipt stamped with Git remains valid after repository metadata becomes unavailable", () => {
    seedGitRepo(proj);
    const gitMetadata = `${proj}-git-metadata`;
    try {
      recordReview(proj);
      renameSync(join(proj, ".git"), gitMetadata);
      const approved = guarded(
        proj,
        ["approve", "code-generation", "--user-input", "ship it"],
      );
      expect(approved.rc, approved.out).toBe(0);
    } finally {
      if (existsSync(gitMetadata)) {
        renameSync(gitMetadata, join(proj, ".git"));
      }
    }
  });

  test("Git becoming available after a non-Git recovery review does not spend a second recovery", () => {
    recordReview(proj);
    writeFileSync(src, "export const answer = 43;\n");
    const stale = guarded(
      proj,
      ["approve", "code-generation", "--user-input", "ship it"],
    );
    expect(stale.rc).not.toBe(0);
    expect(stale.out).toContain("project source changed after");

    recordReview(proj);
    git(proj, ["init", "-q"]);
    git(proj, ["config", "user.email", "t@test"]);
    git(proj, ["config", "user.name", "t"]);
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "Git became available"]);

    const approved = guarded(
      proj,
      ["approve", "code-generation", "--user-input", "ship it"],
    );
    expect(approved.rc, approved.out).toBe(0);
  });
});

// Per-unit attribution composes two boundaries. The newest global fingerprint
// proves no source changed after the last terminal review. Unit snapshots bind
// manifest bytes plus exact/directory claims and are checked newest-first, so a
// newer fresh claimant may intentionally own an overlapping shared path. The
// stage-entry baseline then rejects every changed path outside the fresh claim
// union. The cases below pin legitimate sequential/rework/shared integration,
// owner-specific stale invalidation, and fail-closed unclaimed additions.
describe("t314 multi-unit source attribution", () => {
  let proj: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    seedGitRepo(proj);
    seedTwoUnitDag(proj);
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
    appendAuditEntry(
      "WORKFLOW_STARTED",
      {
        Scope: "feature",
        ...sourceBaselineAuditFields(proj, "code-generation"),
      },
      proj,
    );
    const boundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === boundarySecond) {}
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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

  // Alpha's manifest/snapshot owns alpha.ts. A later beta review refreshes the
  // global outer binding but cannot shield alpha.ts because beta does not claim
  // it, so alpha alone is invalidated.
  test("a unit edited after its own review, then masked by a later unit's review, is refused", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code v1"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha", "READY", [
      { path: "alpha.ts" },
    ]);

    // Edited with NO new review recorded for alpha.
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 999; // no re-review\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha edited, no re-review"]);

    writeFileSync(join(proj, "beta.ts"), "export const beta = 2;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta", "READY", [
      { path: "beta.ts" },
    ]);

    const gate = guarded(
      proj,
      ["gate-start", "code-generation"],
      { AIDLC_SKIP_REVIEWER_GATE_GUARD: "1" },
    );
    expect(gate.rc, gate.out).toBe(0);
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("Changed after review: alpha");
  }, 60_000);

  // Re-reviewing alpha refreshes the global outer binding, but beta's own
  // snapshot still detects the unreviewed beta.ts edit and invalidates beta.
  test("re-reviewing an earlier unit refuses a later unit's stale receipt", () => {
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha", "READY", [
      { path: "alpha.ts" },
    ]);

    writeFileSync(join(proj, "beta.ts"), "export const beta = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta", "READY", [
      { path: "beta.ts" },
    ]);

    // Edit beta, no new review for beta.
    writeFileSync(join(proj, "beta.ts"), "export const beta = 999; // no re-review\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta edited"]);

    // Re-review alpha (not beta) - alpha's own content is unchanged, but the
    // tree now includes beta's unreviewed edit.
    recordReview(proj, "code-generation", REVIEWER, "alpha", "READY", [
      { path: "alpha.ts" },
    ]);

    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("Changed after review: beta");
  }, 60_000);

  // The stage-entry baseline sees unreviewed.ts, while neither fresh Unit
  // manifest claims it. A newer beta review cannot launder an unclaimed path.
  test("an addition nobody reviewed is refused as unclaimed", () => {
    appendAuditEntry(
      "WORKFLOW_STARTED",
      {
        Scope: "feature",
        ...sourceBaselineAuditFields(proj, "code-generation"),
      },
      proj,
    );
    const boundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === boundarySecond) {}
    writeFileSync(join(proj, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "alpha code"]);
    recordReview(proj, "code-generation", REVIEWER, "alpha", "READY", [
      { path: "alpha.ts" },
    ]);

    writeFileSync(join(proj, "unreviewed.ts"), "export const extra = () => process.env;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "addition no reviewer was shown"]);

    writeFileSync(join(proj, "beta.ts"), "export const beta = 2;\n", "utf-8");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "beta code"]);
    recordReview(proj, "code-generation", REVIEWER, "beta", "READY", [
      { path: "beta.ts" },
    ]);

    const gate = guarded(
      proj,
      ["gate-start", "code-generation"],
      { AIDLC_SKIP_REVIEWER_GATE_GUARD: "1" },
    );
    expect(gate.rc, gate.out).toBe(0);
    const r = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("Unclaimed source changes fail closed");
    expect(r.out).toContain("unreviewed.ts");
  }, 60_000);

  // #646 review - the recorded-repo layout is the DEFAULT (sibling
  // auto-discovery populates `repos` at intent creation via resolveIntentRepoSet
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
    appendAuditEntry(
      "STAGE_JUMPED",
      {
        Target: "code-generation",
        ...sourceBaselineAuditFields(proj, "code-generation"),
      },
      proj,
    );
    const repoBoundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === repoBoundarySecond) {}

    writeFileSync(join(repoA, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
    recordReview(proj, "code-generation", REVIEWER, "alpha", "READY", [
      { repo: "repo-a", path: "alpha.ts" },
    ]);
    writeFileSync(join(repoA, "beta.ts"), "export const beta = 2;\n", "utf-8");
    recordReview(proj, "code-generation", REVIEWER, "beta", "READY", [
      { repo: "repo-a", path: "beta.ts" },
    ]);

    const clean = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(clean.out).not.toContain("project source changed after");
    expect(clean.rc).toBe(0);

    // Now edit inside the recorded repo after the last review: must refuse.
    // Reopening without a human rejection keeps the prior per-unit receipts.
    // With accurate per-unit claims, a re-review only counts as the one
    // bounded stale-receipt recovery when the unit's claimed scope really
    // changed, so stale alpha's scope first, spend the recovery rebinding it,
    // then let a further edit invalidate the recovery receipt.
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
    writeFileSync(join(repoA, "alpha.ts"), "export const alpha = 99;\n", "utf-8");
    recordReview(proj, "code-generation", REVIEWER, "alpha", "READY", [
      { repo: "repo-a", path: "alpha.ts" },
    ]);
    writeFileSync(join(repoA, "alpha.ts"), "export const alpha = 999;\n", "utf-8");
    const dirty = guarded(proj, ["approve", "code-generation", "--user-input", "ship it"]);
    expect(dirty.rc).not.toBe(0);
    expect(dirty.out).toContain(
      "workspace source changed again after the one recovery review",
    );
    expect(dirty.out).toContain("To change this document");
    expect(dirty.out).toContain("Request Changes decision");
  }, 60_000);
});

// Reproduction of the maintainer review on #646 (a1e4d67), P1 finding 2: the
// swarm path stamps receipts inside per-unit Bolt worktrees, but the MAIN
// checkout never receives the merged-back code until finalize runs - so
// recomputing the fingerprint over the main checkout at a settle approve
// always mismatches every worktree-stamped receipt, deadlocking a run that
// never edited anything. isSettledSwarmForArtifactGuard's exemption (already
// proven for the produces-existence guard, t185) is reused here to skip the
// fingerprint reconciliation entirely once every DAG unit has converged.
describe("t314 settled-swarm exemption from fingerprint reconciliation (#646 review P1#2)", () => {
  let proj: string;
  const UNITS = ["alpha", "beta"];

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    seedGitRepo(proj);
    guarded(proj, ["checkbox", "code-generation=in-progress"]);
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
    // stamp (Stage + Run floor). Current v2 uses the no-boundary sentinel when
    // the fixture has no STAGE_STARTED row.
    const shard = seededAuditShard(proj);
    mkdirSync(join(shard, ".."), { recursive: true });
    const rows = UNITS.map((unit, i) =>
      [
        "## Swarm Unit Converged",
        `**Timestamp**: 2026-07-18T00:00:0${i}.000Z`,
        "**Event**: SWARM_UNIT_CONVERGED",
        `**Unit name**: ${unit}`,
        "**Stage**: code-generation",
        "**Run floor**: unstarted#0",
        "",
        "---",
        "",
      ].join("\n"),
    ).join("");
    writeFileSync(shard, rows, { flag: "a" });
    for (const unit of UNITS) recordReview(proj, "code-generation", REVIEWER, unit);
  });

  afterEach(() => cleanupTestProject(proj));

  test("approve refuses a settled swarm without a main-checkout source-merge chain", () => {
    // Simulates the worktree code never having merged into the main checkout:
    // the recorded receipts' fingerprints (stamped in this test's proj, since
    // no real worktree is involved here) no longer match the current tree.
    writeFileSync(join(proj, "app.ts"), "export const answer = 999;\n", "utf-8");
    const r = guarded(proj, ["gate-start", "code-generation"]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain(
      "no current-attempt post-merge main-checkout source binding",
    );
  }, 60_000);
});

// Reproduction of the maintainer review on #646 (a1e4d67), P1 finding 3:
// `reviewerReceiptError` (aidlc-swarm.ts) accepted any terminal READY/NOT-READY
// verdict and never read the receipt's own Source Fingerprint, so finalize
// could merge a unit whose worktree source was edited after its review.
describe("t314 swarm finalize source-fingerprint check (#646 review P1#3)", () => {
  const fixtures: string[] = [];
  const extraDirs: string[] = [];
  afterAll(() => {
    for (const f of fixtures) cleanupWorktreeFixture(f);
    for (const f of extraDirs) rmSync(f, { recursive: true, force: true });
  });

  // Mirrors t134's makeSwarmFixture, but seeded with Current Stage:
  // code-generation (a workspace_requires stage) instead of functional-design,
  // so aidlc-log.ts review actually stamps a Source Fingerprint to check.
  function makeFixture(): string {
    const proj = setupWorktreeFixture();
    fixtures.push(proj);
    git(proj, ["config", "user.email", "t@test"]);
    git(proj, ["config", "user.name", "t"]);
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
    appendAuditEntry(
      "WORKFLOW_STARTED",
      {
        Scope: "feature",
        ...sourceBaselineAuditFields(proj, "code-generation"),
      },
      proj,
    );
    const boundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === boundarySecond) {}
    return proj;
  }

  function wtPath(proj: string, unit: string): string {
    return join(proj, ".aidlc", "worktrees", `bolt-${unit}`);
  }

  function ensureDagUnit(proj: string, unit: string): void {
    seedBoltDag(proj, [unit]);
  }

  function runSwarm(
    proj: string,
    args: string[],
    extraEnv?: Record<string, string>,
  ): { rc: number; out: string } {
    if (args[0] === "prepare") {
      const unitsIndex = args.indexOf("--units");
      if (unitsIndex !== -1 && args[unitsIndex + 1]) {
        seedBoltDag(proj, args[unitsIndex + 1].split(","));
      }
    }
    const r = spawnSync(BUN, [SWARM_TOOL, "--project-dir", proj, ...args], {
      cwd: proj,
      encoding: "utf-8",
      env: { ...process.env, ...extraEnv },
    });
    return { rc: r.status ?? -1, out: r.stdout ?? "" };
  }

  function addNestedSubmodule(
    proj: string,
    nestedGitignore: string,
  ): void {
    const nestedOrigin = mkdtempSync(
      join(tmpdir(), "aidlc-t304-nested-origin-"),
    );
    const outerOrigin = mkdtempSync(
      join(tmpdir(), "aidlc-t304-outer-origin-"),
    );
    extraDirs.push(nestedOrigin, outerOrigin);
    seedGitRepo(nestedOrigin);
    writeFileSync(join(nestedOrigin, ".gitignore"), nestedGitignore);
    git(nestedOrigin, ["add", ".gitignore"]);
    git(nestedOrigin, ["commit", "-qm", "nested ignore policy"]);

    seedGitRepo(outerOrigin);
    git(outerOrigin, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      nestedOrigin,
      "vendor/nested",
    ]);
    git(outerOrigin, ["commit", "-qm", "add nested submodule"]);

    git(proj, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      outerOrigin,
      "vendor/outer",
    ]);
    git(proj, ["commit", "-qm", "add outer submodule"]);
  }

  test("finalize refuses a claimed unit whose worktree source changed after its terminal review", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "foo");
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
      `"${process.execPath}" -e "require('fs').accessSync('foo.ts')"`,
    ]);
    expect(f.rc).toBe(2);
    const env = JSON.parse(f.out);
    const row = env.units.find((u: { unit: string }) => u.unit === "foo");
    expect(row?.status).toBe("failed");
    expect(row?.detail).toContain("source-fingerprint mismatch");
  }, 120000);

  test("dependency churn after review neither invalidates swarm convergence nor enters the Source Commit", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "deps", "--base", "main"]);
    const wt = wtPath(proj, "deps");
    writeFileSync(join(wt, "reviewed.ts"), "export const reviewed = true;\n");
    const dependency = join(wt, "node_modules", "pkg", "cache.js");
    mkdirSync(join(dependency, ".."), { recursive: true });
    writeFileSync(dependency, "module.exports = 1;\n");
    recordReview(wt, "code-generation", REVIEWER, "deps");

    writeFileSync(dependency, "module.exports = 2;\n");
    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "deps",
      "--claimed",
      "deps",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: deps[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      audit,
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const tree = spawnSync(
      "git",
      ["-C", proj, "ls-tree", "-r", "--name-only", sourceCommit ?? ""],
      { encoding: "utf-8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).toContain("reviewed.ts");
    expect(tree.stdout).not.toContain("node_modules/");
  }, 120000);

  test("a hard-excluded dependency symlink added after review cannot enter the Source Commit", () => {
    const proj = makeFixture();
    const external = mkdtempSync(join(tmpdir(), "aidlc-t304-dependency-link-"));
    extraDirs.push(external);
    writeFileSync(join(external, "pkg.js"), "module.exports = 'unreviewed';\n");
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "dep-link", "--base", "main"]);
    const wt = wtPath(proj, "dep-link");
    writeFileSync(join(wt, "reviewed.ts"), "export const reviewed = true;\n");
    recordReview(wt, "code-generation", REVIEWER, "dep-link");

    symlinkSync(external, join(wt, "node_modules"), "dir");
    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "dep-link",
      "--claimed",
      "dep-link",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: dep-link[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      audit,
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const tree = spawnSync(
      "git",
      ["-C", proj, "ls-tree", "-r", "--name-only", sourceCommit ?? ""],
      { encoding: "utf-8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).not.toContain("node_modules");
  }, 120000);

  test("finalize rejects an external source symlink before minting Source Commit authority", () => {
    const proj = makeFixture();
    const external = mkdtempSync(join(tmpdir(), "aidlc-t314-external-source-"));
    extraDirs.push(external);
    const target = join(proj, "tracked-target.ts");
    writeFileSync(target, "export const target = 'reviewed';\n");
    symlinkSync(target, join(external, "hop"), "file");
    symlinkSync(join(external, "hop"), join(proj, "outside.ts"), "file");
    git(proj, ["add", "--", "tracked-target.ts", "outside.ts"]);
    git(proj, ["commit", "-qm", "add out-and-back source link"]);
    runSwarm(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "external-link",
      "--base",
      "main",
    ]);
    const wt = wtPath(proj, "external-link");
    writeFileSync(join(wt, "unit.ts"), "export const unit = true;\n");
    recordReview(
      wt,
      "code-generation",
      REVIEWER,
      "external-link",
      "READY",
      [{ path: "unit.ts" }],
    );

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "external-link",
      "--claimed",
      "external-link",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('unit.ts')"`,
    ]);
    expect(finalized.rc).toBe(2);
    const row = JSON.parse(finalized.out).units.find(
      (unit: { unit: string }) => unit.unit === "external-link",
    );
    expect(row?.detail).toContain(
      "cannot bind external source symlink target (outside.ts)",
    );
    expect(readAllAuditShards(proj)).not.toMatch(
      /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: external-link/,
    );
    const refs = spawnSync(
      "git",
      [
        "-C",
        proj,
        "for-each-ref",
        "refs/aidlc/reviewed-source/external-link/",
      ],
      { encoding: "utf-8" },
    );
    expect(refs.status).toBe(0);
    expect(refs.stdout.trim()).toBe("");
  }, 120000);

  test("clean-filtered generated and harness files stay at HEAD in the Source Commit", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "filtered-excluded");
    git(proj, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    writeFileSync(
      join(proj, ".gitattributes"),
      "dist/** filter=tidy\n.claude/** filter=tidy\n",
    );
    mkdirSync(join(proj, "dist"), { recursive: true });
    mkdirSync(join(proj, ".claude", "tools", "data"), { recursive: true });
    writeFileSync(
      join(proj, ".claude", "tools", "data", "harness.json"),
      `${JSON.stringify({ name: "claude" })}\n`,
    );
    writeFileSync(join(proj, "dist", "out.js"), "BASELINE_GENERATED\n");
    writeFileSync(join(proj, ".claude", "managed.md"), "BASELINE_HARNESS\n");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "tracked filtered exclusions"]);

    runSwarm(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "filtered-excluded",
      "--base",
      "main",
    ]);
    const wt = wtPath(proj, "filtered-excluded");
    writeFileSync(join(wt, "reviewed.ts"), "export const reviewed = true;\n");
    recordReview(wt, "code-generation", REVIEWER, "filtered-excluded");
    writeFileSync(join(wt, "dist", "out.js"), "UNREVIEWED_GENERATED   \n");
    writeFileSync(
      join(wt, ".claude", "managed.md"),
      "UNREVIEWED_HARNESS   \n",
    );

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "filtered-excluded",
      "--claimed",
      "filtered-excluded",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: filtered-excluded[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      readAllAuditShards(proj),
    )?.[1];
    expect(sourceCommit).toBeDefined();
    for (const [path, expected] of [
      ["dist/out.js", "BASELINE_GENERATED\n"],
      [".claude/managed.md", "BASELINE_HARNESS\n"],
    ] as const) {
      const shown = spawnSync(
        "git",
        ["-C", proj, "show", `${sourceCommit}:${path}`],
        { encoding: "utf-8" },
      );
      expect(shown.status, `${shown.stdout}${shown.stderr}`).toBe(0);
      expect(shown.stdout).toBe(expected);
    }
  }, 120000);

  test("registered clean-filtered generated source keeps reviewed raw bytes", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "filtered-registered");
    git(proj, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    writeFileSync(join(proj, ".gitattributes"), "dist/** filter=tidy\n");
    git(proj, ["add", ".gitattributes"]);
    git(proj, ["commit", "-qm", "configure generated source filter"]);

    runSwarm(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "filtered-registered",
      "--base",
      "main",
    ]);
    const wt = wtPath(proj, "filtered-registered");
    writeFileSync(
      join(wt, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["dist/worker.js"] })}\n`,
    );
    mkdirSync(join(wt, "dist"), { recursive: true });
    const reviewed = "export const worker = 'reviewed';   \n";
    writeFileSync(join(wt, "dist", "worker.js"), reviewed);
    recordReview(wt, "code-generation", REVIEWER, "filtered-registered");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "filtered-registered",
      "--claimed",
      "filtered-registered",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('dist/worker.js')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: filtered-registered[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      readAllAuditShards(proj),
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const shown = spawnSync(
      "git",
      ["-C", proj, "show", `${sourceCommit}:dist/worker.js`],
      { encoding: "utf-8" },
    );
    expect(shown.status, `${shown.stdout}${shown.stderr}`).toBe(0);
    expect(shown.stdout).toBe(reviewed);
  }, 120000);

  test("ordinary ignored and registered binary source enter the bound Source Commit and later merge", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "ignored", "--base", "main"]);
    const wt = wtPath(proj, "ignored");
    writeFileSync(
      join(wt, ".gitignore"),
      `${readFileSync(join(wt, ".gitignore"), "utf-8")}ignored-source.ts\ndist/\n`,
    );
    writeFileSync(
      join(wt, ".aidlc-source-paths.json"),
      `${JSON.stringify({
        version: 1,
        paths: ["dist/module.wasm", "ignored-source.ts"],
      })}\n`,
    );
    mkdirSync(join(wt, "dist"), { recursive: true });
    writeFileSync(join(wt, "dist", "module.wasm"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(wt, "reviewed.ts"), "export const reviewed = true;\n");
    writeFileSync(
      join(wt, "ignored-source.ts"),
      "export const ignored = 'reviewed and merged';\n",
    );
    recordReview(wt, "code-generation", REVIEWER, "ignored");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "ignored",
      "--claimed",
      "ignored",
      "--check-cmd",
      `"${process.execPath}" -e "const fs=require('fs');fs.accessSync('ignored-source.ts');fs.accessSync('dist/module.wasm')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: ignored[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      audit,
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const tree = spawnSync(
      "git",
      ["-C", proj, "ls-tree", "-r", "--name-only", sourceCommit ?? ""],
      { encoding: "utf-8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).toContain("ignored-source.ts");
    expect(tree.stdout).toContain("dist/module.wasm");

    const merged = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "ignored",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    expect(readFileSync(join(proj, "ignored-source.ts"), "utf-8")).toContain(
      "reviewed and merged",
    );
    expect(readFileSync(join(proj, "dist", "module.wasm"))).toEqual(
      Buffer.from([0, 1, 2, 3]),
    );
  }, 120000);

  test("registered source through an internal generated-boundary symlink finalizes and merges", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "linked", "--base", "main"]);
    const wt = wtPath(proj, "linked");
    writeFileSync(
      join(wt, ".gitignore"),
      `${readFileSync(join(wt, ".gitignore"), "utf-8")}generated-src/worker.js\n`,
    );
    writeFileSync(
      join(wt, ".aidlc-source-paths.json"),
      `${JSON.stringify({
        version: 1,
        paths: ["dist/worker.js"],
      })}\n`,
    );
    mkdirSync(join(wt, "generated-src"), { recursive: true });
    writeFileSync(
      join(wt, "generated-src", "worker.js"),
      "export const linked = 'reviewed';\n",
    );
    symlinkSync("generated-src", join(wt, "dist"), "dir");
    recordReview(wt, "code-generation", REVIEWER, "linked");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "linked",
      "--claimed",
      "linked",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('dist/worker.js')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: linked[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      audit,
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const tree = spawnSync(
      "git",
      ["-C", proj, "ls-tree", "-r", "--name-only", sourceCommit ?? ""],
      { encoding: "utf-8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).toContain("dist");
    expect(tree.stdout).toContain("generated-src/worker.js");

    const merged = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "linked",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    expect(
      readFileSync(join(proj, "generated-src", "worker.js"), "utf-8"),
    ).toContain("reviewed");
    const mergedLink = lstatSync(join(proj, "dist"));
    if (mergedLink.isSymbolicLink()) {
      expect(readlinkSync(join(proj, "dist"))).toBe("generated-src");
    } else {
      expect(readFileSync(join(proj, "dist"), "utf-8").trim()).toBe(
        "generated-src",
      );
    }
  }, 120000);

  test("a staged registered-source deletion remains deleted in the Source Commit and merge", () => {
    const proj = makeFixture();
    writeFileSync(
      join(proj, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["dist/worker.js"] })}\n`,
    );
    mkdirSync(join(proj, "dist"), { recursive: true });
    writeFileSync(join(proj, "dist", "worker.js"), "export const stale = true;\n");
    git(proj, ["add", ".aidlc-source-paths.json", "dist/worker.js"]);
    git(proj, ["commit", "-qm", "tracked registered source"]);
    appendAuditEntry(
      "STAGE_JUMPED",
      {
        Target: "code-generation",
        ...sourceBaselineAuditFields(proj, "code-generation"),
      },
      proj,
    );
    const deletionBoundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === deletionBoundarySecond) {}

    runSwarm(proj, ["prepare", "--batch", "1", "--units", "deleted", "--base", "main"]);
    const wt = wtPath(proj, "deleted");
    rmSync(join(wt, "dist", "worker.js"));
    git(wt, ["add", "-A", "--", "dist/worker.js"]);
    recordReview(
      wt,
      "code-generation",
      REVIEWER,
      "deleted",
      "READY",
      [
        { path: ".aidlc-source-paths.json" },
        { path: "dist/worker.js" },
      ],
    );

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "deleted",
      "--claimed",
      "deleted",
      "--check-cmd",
      `"${process.execPath}" -e "process.exit(require('fs').existsSync('dist/worker.js')?1:0)"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: deleted[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      audit,
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const tree = spawnSync(
      "git",
      ["-C", proj, "ls-tree", "-r", "--name-only", sourceCommit ?? ""],
      { encoding: "utf-8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).not.toContain("dist/worker.js");

    const merged = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "deleted",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    expect(existsSync(join(proj, "dist", "worker.js"))).toBe(false);
  }, 120000);

  test("an internal symlink sorted before its real directory cannot suppress ignored source from the Source Commit", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "alias", "--base", "main"]);
    const wt = wtPath(proj, "alias");
    writeFileSync(
      join(wt, ".gitignore"),
      `${readFileSync(join(wt, ".gitignore"), "utf-8")}z-source/ignored-source.ts\n`,
    );
    writeFileSync(
      join(wt, ".aidlc-source-paths.json"),
      `${JSON.stringify({
        version: 1,
        paths: ["z-source/ignored-source.ts"],
      })}\n`,
    );
    mkdirSync(join(wt, "z-source"), { recursive: true });
    writeFileSync(
      join(wt, "z-source", "ignored-source.ts"),
      "export const aliased = 'reviewed';\n",
    );
    symlinkSync("z-source", join(wt, "a-link"), "dir");
    recordReview(wt, "code-generation", REVIEWER, "alias");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "alias",
      "--claimed",
      "alias",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('a-link/ignored-source.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: alias[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      audit,
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const tree = spawnSync(
      "git",
      ["-C", proj, "ls-tree", "-r", "--name-only", sourceCommit ?? ""],
      { encoding: "utf-8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).toContain("a-link");
    expect(tree.stdout).toContain("z-source/ignored-source.ts");

    const merged = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "alias",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    expect(
      readFileSync(join(proj, "z-source", "ignored-source.ts"), "utf-8"),
    ).toContain("reviewed");
  }, 120000);

  test("swarm source and exclusion batching stay below Windows command-line limits", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "argv", "--base", "main"]);
    const wt = wtPath(proj, "argv");
    writeFileSync(
      join(wt, ".gitignore"),
      `${readFileSync(join(wt, ".gitignore"), "utf-8")}ignored-*.ts\n`,
    );
    const names: string[] = [];
    for (let i = 0; i < 400; i++) {
      const name = `ignored-${String(i).padStart(3, "0")}-${"x".repeat(72)}.ts`;
      names.push(name);
      writeFileSync(join(wt, name), `export const value${i} = ${i};\n`);
    }
    writeFileSync(
      join(wt, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: names })}\n`,
    );
    recordReview(wt, "code-generation", REVIEWER, "argv");
    const dependencyTarget = mkdtempSync(
      join(tmpdir(), "aidlc-t304-argv-dependency-"),
    );
    extraDirs.push(dependencyTarget);
    writeFileSync(join(dependencyTarget, "pkg.js"), "module.exports = true;\n");
    for (let i = 0; i < 320; i++) {
      const parent = join(
        wt,
        "packages",
        `excluded-${String(i).padStart(3, "0")}-${"y".repeat(60)}`,
      );
      mkdirSync(parent, { recursive: true });
      symlinkSync(dependencyTarget, join(parent, "node_modules"), "dir");
    }

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "argv",
      "--claimed",
      "argv",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${names.at(-1)}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: argv[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      audit,
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const tree = spawnSync(
      "git",
      ["-C", proj, "ls-tree", "-r", "--name-only", sourceCommit ?? ""],
      { encoding: "utf-8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).toContain(names[0]);
    expect(tree.stdout).toContain(names.at(-1) ?? "");
    expect(tree.stdout).not.toContain("node_modules");
  }, 120000);

  test("finalize fails closed when reviewed bytes live only in a dirty initialized submodule", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "subdirty");
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t314-submodule-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    git(proj, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "vendor/sub"]);
    git(proj, ["commit", "-qm", "add submodule"]);

    runSwarm(proj, ["prepare", "--batch", "1", "--units", "subdirty", "--base", "main"]);
    const wt = wtPath(proj, "subdirty");
    git(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
    writeFileSync(
      join(wt, "vendor", "sub", "app.ts"),
      "export const answer = 99; // reviewed but not committed in submodule\n",
      "utf-8",
    );
    recordReview(wt, "code-generation", REVIEWER, "subdirty");

    const f = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "subdirty",
      "--claimed",
      "subdirty",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('vendor/sub/app.ts')"`,
    ]);
    expect(f.rc).toBe(2);
    const row = JSON.parse(f.out).units.find((u: { unit: string }) => u.unit === "subdirty");
    expect(row?.detail).toContain("cannot bind dirty initialized submodule vendor/sub");
    expect(readAllAuditShards(proj)).not.toMatch(
      /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: subdirty/,
    );
    const refs = spawnSync("git", ["-C", proj, "for-each-ref", "refs/aidlc/reviewed-source/subdirty/"], {
      encoding: "utf-8",
    });
    expect(refs.status).toBe(0);
    expect(refs.stdout.trim()).toBe("");
  }, 120000);

  test("review request fails closed when source is ignored inside an initialized submodule", () => {
    const proj = makeFixture();
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t304-submodule-ignored-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    writeFileSync(join(origin, ".gitignore"), "ignored-source.ts\n");
    git(origin, ["add", ".gitignore"]);
    git(origin, ["commit", "-qm", "ignore application source"]);
    git(proj, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "vendor/sub"]);
    git(proj, ["commit", "-qm", "add ignored-source submodule"]);

    runSwarm(proj, ["prepare", "--batch", "1", "--units", "subignored", "--base", "main"]);
    const wt = wtPath(proj, "subignored");
    git(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
    writeFileSync(
      join(wt, "vendor", "sub", "ignored-source.ts"),
      "export const ignored = 'reviewed but not in gitlink';\n",
    );
    expect(() =>
      recordReview(wt, "code-generation", REVIEWER, "subignored")
    ).toThrow("ignored by Git");
    expect(readAllAuditShards(proj)).not.toMatch(
      /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: subignored/,
    );
  }, 120000);

  test("ignored dependency cache inside an initialized submodule does not block finalize", () => {
    const proj = makeFixture();
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t304-submodule-cache-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    writeFileSync(join(origin, ".gitignore"), "node_modules/\n");
    git(origin, ["add", ".gitignore"]);
    git(origin, ["commit", "-qm", "ignore dependency cache"]);
    git(proj, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "vendor/sub"]);
    git(proj, ["commit", "-qm", "add dependency-cache submodule"]);

    runSwarm(proj, ["prepare", "--batch", "1", "--units", "subcache", "--base", "main"]);
    const wt = wtPath(proj, "subcache");
    git(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
    mkdirSync(join(wt, "vendor", "sub", "node_modules", "pkg"), {
      recursive: true,
    });
    writeFileSync(
      join(wt, "vendor", "sub", "node_modules", "pkg", "cache.js"),
      "module.exports = 'cache';\n",
    );
    recordReview(wt, "code-generation", REVIEWER, "subcache");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "subcache",
      "--claimed",
      "subcache",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('vendor/sub/node_modules/pkg/cache.js')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);
  }, 120000);

  test("nested initialized submodule ignored source blocks review recursively", () => {
    const proj = makeFixture();
    addNestedSubmodule(proj, "ignored-source.ts\n");
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "nestedignored", "--base", "main"]);
    const wt = wtPath(proj, "nestedignored");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
    ]);
    const nested = join(wt, "vendor", "outer", "vendor", "nested");
    writeFileSync(
      join(nested, "ignored-source.ts"),
      "export const nestedIgnored = 'reviewed but not in nested gitlink';\n",
    );
    expect(() =>
      recordReview(wt, "code-generation", REVIEWER, "nestedignored")
    ).toThrow("ignored by Git");
  }, 120000);

  test("nested initialized submodule ignored dependency cache remains allowed", () => {
    const proj = makeFixture();
    addNestedSubmodule(proj, "node_modules/\n");
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "nestedcache", "--base", "main"]);
    const wt = wtPath(proj, "nestedcache");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
    ]);
    const cache = join(
      wt,
      "vendor",
      "outer",
      "vendor",
      "nested",
      "node_modules",
      "pkg",
    );
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "cache.js"), "module.exports = 'nested cache';\n");
    recordReview(wt, "code-generation", REVIEWER, "nestedcache");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "nestedcache",
      "--claimed",
      "nestedcache",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('vendor/outer/vendor/nested/node_modules/pkg/cache.js')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);
  }, 120000);

  test("ignored embedded Git checkout source is shaped as a gitlink and rejected when dirty", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "embeddedignored", "--base", "main"]);
    const wt = wtPath(proj, "embeddedignored");
    writeFileSync(
      join(wt, ".gitignore"),
      `${readFileSync(join(wt, ".gitignore"), "utf-8")}embedded/\n`,
    );
    writeFileSync(
      join(wt, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["embedded"] })}\n`,
    );
    const embedded = join(wt, "embedded");
    mkdirSync(embedded);
    git(embedded, ["init", "-q"]);
    git(embedded, ["config", "user.email", "t@test"]);
    git(embedded, ["config", "user.name", "t"]);
    writeFileSync(join(embedded, "app.ts"), "export const embedded = true;\n");
    writeFileSync(join(embedded, ".gitignore"), "ignored-source.ts\n");
    git(embedded, ["add", "-A"]);
    git(embedded, ["commit", "-qm", "embedded source"]);
    writeFileSync(
      join(embedded, "ignored-source.ts"),
      "export const ignored = 'reviewed but not in gitlink';\n",
    );
    recordReview(wt, "code-generation", REVIEWER, "embeddedignored");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "embeddedignored",
      "--claimed",
      "embeddedignored",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('embedded/ignored-source.ts')"`,
    ]);
    expect(finalized.rc).toBe(2);
    const row = JSON.parse(finalized.out).units.find(
      (unit: { unit: string }) => unit.unit === "embeddedignored",
    );
    expect(row?.detail).toContain("embedded");
    expect(row?.detail).toContain("ignored application source");
  }, 120000);

  test("ignored clean embedded Git checkout is rejected without tracked submodule metadata", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "embeddedcache", "--base", "main"]);
    const wt = wtPath(proj, "embeddedcache");
    writeFileSync(
      join(wt, ".gitignore"),
      `${readFileSync(join(wt, ".gitignore"), "utf-8")}embedded/\n`,
    );
    writeFileSync(
      join(wt, ".aidlc-source-paths.json"),
      `${JSON.stringify({ version: 1, paths: ["embedded"] })}\n`,
    );
    const embedded = join(wt, "embedded");
    mkdirSync(embedded);
    git(embedded, ["init", "-q"]);
    git(embedded, ["config", "user.email", "t@test"]);
    git(embedded, ["config", "user.name", "t"]);
    writeFileSync(join(embedded, "app.ts"), "export const embedded = true;\n");
    writeFileSync(join(embedded, ".gitignore"), "node_modules/\n");
    git(embedded, ["add", "-A"]);
    git(embedded, ["commit", "-qm", "embedded source"]);
    mkdirSync(join(embedded, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      join(embedded, "node_modules", "pkg", "cache.js"),
      "module.exports = 'cache';\n",
    );
    recordReview(wt, "code-generation", REVIEWER, "embeddedcache");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "embeddedcache",
      "--claimed",
      "embeddedcache",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('embedded/node_modules/pkg/cache.js')"`,
    ]);
    expect(finalized.rc).toBe(2);
    const row = JSON.parse(finalized.out).units.find(
      (unit: { unit: string }) => unit.unit === "embeddedcache",
    );
    expect(row?.detail).toContain("not a tracked submodule");
    expect(row?.detail).toContain("git submodule add");
    expect(readAllAuditShards(proj)).not.toMatch(
      /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: embeddedcache/,
    );
  }, 120000);

  test("unignored bare embedded Git checkout is rejected despite git add discovering its gitlink", () => {
    const proj = makeFixture();
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "embeddedbare", "--base", "main"]);
    const wt = wtPath(proj, "embeddedbare");
    const embedded = join(wt, "embedded");
    mkdirSync(embedded);
    git(embedded, ["init", "-q"]);
    git(embedded, ["config", "user.email", "t@test"]);
    git(embedded, ["config", "user.name", "t"]);
    writeFileSync(join(embedded, "app.ts"), "export const embedded = true;\n");
    git(embedded, ["add", "-A"]);
    git(embedded, ["commit", "-qm", "embedded source"]);
    recordReview(wt, "code-generation", REVIEWER, "embeddedbare");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "embeddedbare",
      "--claimed",
      "embeddedbare",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('embedded/app.ts')"`,
    ]);
    expect(finalized.rc).toBe(2);
    const row = JSON.parse(finalized.out).units.find(
      (unit: { unit: string }) => unit.unit === "embeddedbare",
    );
    expect(row?.detail).toContain("not a tracked submodule");
    expect(row?.detail).toContain("git submodule add");
  }, 120000);

  test("new-submodule recovery proof cap is shared across claimed units", () => {
    const proj = makeFixture();
    const units = ["proof-a", "proof-b"];
    seedBoltDag(proj, units);
    const origins = units.map((unit) => {
      const origin = mkdtempSync(
        join(tmpdir(), `aidlc-t304-${unit}-origin-`),
      );
      extraDirs.push(origin);
      seedGitRepo(origin);
      return origin;
    });
    runSwarm(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      units.join(","),
      "--base",
      "main",
    ]);
    for (let index = 0; index < units.length; index++) {
      const unit = units[index];
      const wt = wtPath(proj, unit);
      git(wt, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        origins[index],
        "declared",
      ]);
      recordReview(wt, "code-generation", REVIEWER, unit);
    }

    const finalized = runSwarm(
      proj,
      [
        "finalize",
        "--batch",
        "1",
        "--units",
        units.join(","),
        "--claimed",
        units.join(","),
        "--check-cmd",
        `"${process.execPath}" -e "require('fs').accessSync('declared/app.ts')"`,
      ],
      { AIDLC_TEST_NEW_GITLINK_RECOVERY_PROOF_CAP: "1" },
    );
    expect(finalized.rc).toBe(2);
    const result = JSON.parse(finalized.out) as {
      units: Array<{ detail?: string; status: string; unit: string }>;
    };
    expect(result.units.find((row) => row.unit === "proof-a")?.status).toBe(
      "converged",
    );
    expect(
      result.units.find((row) => row.unit === "proof-b")?.detail,
    ).toContain("recovery proof cap exceeded (1 per finalize)");
  }, 120000);

  test("new-submodule recovery obeys the remaining aggregate deadline", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "proof-deadline");
    const origin = mkdtempSync(
      join(tmpdir(), "aidlc-t304-proof-deadline-origin-"),
    );
    const shimDir = mkdtempSync(
      join(tmpdir(), "aidlc-t304-proof-deadline-bin-"),
    );
    extraDirs.push(origin, shimDir);
    seedGitRepo(origin);
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf-8",
    }).stdout.trim();
    expect(realGit).not.toBe("");
    writeFileSync(
      join(shimDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "ls-remote" ]; then sleep 1; fi',
        `exec ${JSON.stringify(realGit)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    runSwarm(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "proof-deadline",
      "--base",
      "main",
    ]);
    const wt = wtPath(proj, "proof-deadline");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      origin,
      "declared",
    ]);
    recordReview(wt, "code-generation", REVIEWER, "proof-deadline");

    const started = Date.now();
    const finalized = runSwarm(
      proj,
      [
        "finalize",
        "--batch",
        "1",
        "--units",
        "proof-deadline",
        "--claimed",
        "proof-deadline",
        "--check-cmd",
        `"${process.execPath}" -e "require('fs').accessSync('declared/app.ts')"`,
      ],
      {
        AIDLC_TEST_NEW_GITLINK_RECOVERY_BUDGET_MS: "100",
        AIDLC_TEST_NEW_GITLINK_RECOVERY_COMMAND_TIMEOUT_MS: "1000",
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(finalized.rc).toBe(2);
    const row = (
      JSON.parse(finalized.out) as {
        units: Array<{ detail?: string; unit: string }>;
      }
    ).units.find((unit) => unit.unit === "proof-deadline");
    expect(row?.detail).toContain(
      "recovery deadline exceeded (100ms cumulative per finalize)",
    );
  }, 120000);

  test("new submodule with gitmodules recovery metadata finalizes normally", () => {
    const proj = makeFixture();
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t304-new-submodule-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "newsub", "--base", "main"]);
    const wt = wtPath(proj, "newsub");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      origin,
      "declared",
    ]);
    recordReview(wt, "code-generation", REVIEWER, "newsub");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "newsub",
      "--claimed",
      "newsub",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('declared/app.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: newsub[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(
      audit,
    )?.[1];
    expect(sourceCommit).toBeDefined();
    const tree = spawnSync(
      "git",
      ["-C", proj, "ls-tree", "-r", "--name-only", sourceCommit ?? ""],
      { encoding: "utf-8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).toContain(".gitmodules");
    expect(tree.stdout).toContain("declared");

    const merged = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "newsub",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    const recovered = spawnSync(
      "git",
      [
        "-C",
        proj,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      ],
      { encoding: "utf-8" },
    );
    expect(recovered.status, `${recovered.stdout}${recovered.stderr}`).toBe(0);
    expect(readFileSync(join(proj, "declared", "app.ts"), "utf-8")).toContain(
      "answer",
    );
  }, 120000);

  test("new submodule pinned to an older advertised-history commit remains recoverable", () => {
    const proj = makeFixture();
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t304-historic-submodule-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    const historicCommit = spawnSync(
      "git",
      ["-C", origin, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    writeFileSync(join(origin, "app.ts"), "export const answer = 43;\n");
    git(origin, ["commit", "-qam", "new tip"]);

    runSwarm(proj, ["prepare", "--batch", "1", "--units", "historicsub", "--base", "main"]);
    const wt = wtPath(proj, "historicsub");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      origin,
      "declared",
    ]);
    git(join(wt, "declared"), ["checkout", "-q", historicCommit]);
    git(wt, ["add", "declared"]);
    recordReview(wt, "code-generation", REVIEWER, "historicsub");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "historicsub",
      "--claimed",
      "historicsub",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('declared/app.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const merged = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "historicsub",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    const recovered = spawnSync(
      "git",
      [
        "-C",
        proj,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      ],
      { encoding: "utf-8" },
    );
    expect(recovered.status, `${recovered.stdout}${recovered.stderr}`).toBe(0);
    const recoveredCommit = spawnSync(
      "git",
      ["-C", join(proj, "declared"), "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    expect(recoveredCommit).toBe(historicCommit);
    expect(readFileSync(join(proj, "declared", "app.ts"), "utf-8")).toContain(
      "answer = 42",
    );
  }, 120000);

  test("new submodule pinned to older history remains recoverable after remote advancement", () => {
    const proj = makeFixture();
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t304-advanced-submodule-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    const historicCommit = spawnSync(
      "git",
      ["-C", origin, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    writeFileSync(join(origin, "app.ts"), "export const answer = 43;\n");
    git(origin, ["commit", "-qam", "tip before clone"]);

    runSwarm(proj, ["prepare", "--batch", "1", "--units", "advancedsub", "--base", "main"]);
    const wt = wtPath(proj, "advancedsub");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      origin,
      "declared",
    ]);
    git(join(wt, "declared"), ["checkout", "-q", historicCommit]);
    git(wt, ["add", "declared"]);

    writeFileSync(join(origin, "app.ts"), "export const answer = 44;\n");
    git(origin, ["commit", "-qam", "remote advanced"]);
    recordReview(wt, "code-generation", REVIEWER, "advancedsub");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "advancedsub",
      "--claimed",
      "advancedsub",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('declared/app.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const merged = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "advancedsub",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    const recovered = spawnSync(
      "git",
      [
        "-C",
        proj,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      ],
      { encoding: "utf-8" },
    );
    expect(recovered.status, `${recovered.stdout}${recovered.stderr}`).toBe(0);
    const recoveredCommit = spawnSync(
      "git",
      ["-C", join(proj, "declared"), "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    expect(recoveredCommit).toBe(historicCommit);
  }, 120000);

  test("new submodule remains recoverable after its remote branch is renamed", () => {
    const proj = makeFixture();
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t304-renamed-submodule-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    const originalBranch = spawnSync(
      "git",
      ["-C", origin, "branch", "--show-current"],
      { encoding: "utf-8" },
    ).stdout.trim();
    const historicCommit = spawnSync(
      "git",
      ["-C", origin, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    writeFileSync(join(origin, "app.ts"), "export const answer = 43;\n");
    git(origin, ["commit", "-qam", "tip before clone"]);

    runSwarm(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "renamedsub",
      "--base",
      "main",
    ]);
    const wt = wtPath(proj, "renamedsub");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      origin,
      "declared",
    ]);
    git(join(wt, "declared"), ["checkout", "-q", historicCommit]);
    git(wt, ["add", "declared"]);

    git(origin, ["branch", "-m", originalBranch, "recovery-trunk"]);
    for (let i = 0; i < 40; i++) {
      git(origin, ["branch", `published-after-clone-${i}`]);
    }
    recordReview(wt, "code-generation", REVIEWER, "renamedsub");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "renamedsub",
      "--claimed",
      "renamedsub",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('declared/app.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const merged = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "renamedsub",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    const recovered = spawnSync(
      "git",
      [
        "-C",
        proj,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      ],
      { encoding: "utf-8" },
    );
    expect(recovered.status, `${recovered.stdout}${recovered.stderr}`).toBe(0);
    const recoveredCommit = spawnSync(
      "git",
      ["-C", join(proj, "declared"), "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    expect(recoveredCommit).toBe(historicCommit);
  }, 120000);

  test("an exact advertised submodule tip must still be fetchable", () => {
    const proj = makeFixture();
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t304-broken-tip-submodule-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    const tip = spawnSync("git", ["-C", origin, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();

    runSwarm(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "brokentip",
      "--base",
      "main",
    ]);
    const wt = wtPath(proj, "brokentip");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      origin,
      "declared",
    ]);
    git(wt, ["add", "declared"]);
    recordReview(wt, "code-generation", REVIEWER, "brokentip");

    const tipObject = join(
      origin,
      ".git",
      "objects",
      tip.slice(0, 2),
      tip.slice(2),
    );
    expect(existsSync(tipObject)).toBe(true);
    rmSync(tipObject);
    const advertised = spawnSync(
      "git",
      ["ls-remote", origin, "HEAD", "refs/heads/*"],
      { encoding: "utf-8" },
    );
    expect(advertised.status, `${advertised.stdout}${advertised.stderr}`).toBe(
      0,
    );
    expect(advertised.stdout).toContain(tip);

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "brokentip",
      "--claimed",
      "brokentip",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('declared/app.ts')"`,
    ]);
    expect(finalized.rc).toBe(2);
    const row = JSON.parse(finalized.out).units.find(
      (unit: { unit: string }) => unit.unit === "brokentip",
    );
    expect(row?.detail).toContain(
      "cannot fetch advertised recovery history",
    );
    expect(readAllAuditShards(proj)).not.toMatch(
      /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: brokentip/,
    );
  }, 120000);

  test("new submodule with an unavailable recovery URL cannot finalize", () => {
    const proj = makeFixture();
    const origin = mkdtempSync(join(tmpdir(), "aidlc-t304-dead-submodule-"));
    extraDirs.push(origin);
    seedGitRepo(origin);
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "deadsub", "--base", "main"]);
    const wt = wtPath(proj, "deadsub");
    git(wt, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      origin,
      "declared",
    ]);
    git(wt, [
      "config",
      "-f",
      ".gitmodules",
      "submodule.declared.url",
      `${origin}-missing`,
    ]);
    recordReview(wt, "code-generation", REVIEWER, "deadsub");

    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "deadsub",
      "--claimed",
      "deadsub",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('declared/app.ts')"`,
    ]);
    expect(finalized.rc).toBe(2);
    const row = JSON.parse(finalized.out).units.find(
      (unit: { unit: string }) => unit.unit === "deadsub",
    );
    expect(row?.detail).toContain("recovery endpoint is unavailable");
    expect(readAllAuditShards(proj)).not.toMatch(
      /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Unit name\*\*: deadsub/,
    );
  }, 120000);

  test("a finalize-time bypass cannot become fieldless legacy evidence after the switch is unset", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "bypass");
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "bypass", "--base", "main"]);
    const wt = wtPath(proj, "bypass");
    writeFileSync(join(wt, "reviewed.ts"), "export const reviewed = true;\n", "utf-8");
    git(wt, ["add", "--", "reviewed.ts"]);
    git(wt, ["commit", "-qm", "reviewed source"]);
    recordReview(wt, "code-generation", REVIEWER, "bypass");

    const finalized = runSwarm(
      proj,
      [
        "finalize",
        "--batch",
        "1",
        "--units",
        "bypass",
        "--claimed",
        "bypass",
        "--check-cmd",
        `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
      ],
      { AIDLC_SKIP_SOURCE_FRESHNESS: "1" },
    );
    expect(finalized.rc).toBe(0);
    const convergence = readAllAuditShards(proj).split("## Swarm Unit Converged").at(-1) ?? "";
    expect(convergence).toContain("**Unit name**: bypass");
    expect(convergence).toContain("**Source Freshness Bypass**: true");
    expect(convergence).not.toContain("**Source Commit**:");

    writeFileSync(join(wt, "unreviewed.ts"), "export const unreviewed = true;\n", "utf-8");
    git(wt, ["add", "--", "unreviewed.ts"]);
    git(wt, ["commit", "-qm", "unreviewed branch advance"]);
    const before = spawnSync("git", ["-C", proj, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
    const mergeEnv = { ...process.env };
    delete mergeEnv.AIDLC_SKIP_SOURCE_FRESHNESS;
    const merge = spawnSync(BUN, [
      WORKTREE_TOOL, "merge", "--slug", "bypass", "--target", "main",
      "--strategy", "squash", "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8", env: mergeEnv });
    expect(merge.status).not.toBe(0);
    const refusal = `${merge.stdout}${merge.stderr}`;
    expect(refusal).toContain("finalized with source freshness bypassed");
    expect(refusal).toContain("AIDLC_SKIP_SOURCE_FRESHNESS=1");
    expect(refusal).toContain("aidlc-worktree discard --slug bypass");
    expect(refusal).not.toContain("re-run review and finalize with source freshness enabled");
    const after = spawnSync("git", ["-C", proj, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
    expect(after).toBe(before);
    expect(existsSync(join(proj, "reviewed.ts"))).toBe(false);
    expect(existsSync(join(proj, "unreviewed.ts"))).toBe(false);

    const discarded = spawnSync(BUN, [
      WORKTREE_TOOL, "discard", "--slug", "bypass", "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8" });
    expect(discarded.status).toBe(0);

    expect(runSwarm(proj, ["prepare", "--batch", "2", "--units", "bypass", "--base", "main"]).rc).toBe(0);
    const redoneWt = wtPath(proj, "bypass");
    writeFileSync(join(redoneWt, "reviewed.ts"), "export const reviewed = 'redone';\n", "utf-8");
    git(redoneWt, ["add", "--", "reviewed.ts"]);
    git(redoneWt, ["commit", "-qm", "redo reviewed source"]);
    recordReview(redoneWt, "code-generation", REVIEWER, "bypass");
    const rebound = runSwarm(proj, [
      "finalize", "--batch", "2", "--units", "bypass", "--claimed", "bypass",
      "--check-cmd", `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
    ]);
    expect(rebound.rc).toBe(0);
    const newestConvergence = readAllAuditShards(proj).split("## Swarm Unit Converged").at(-1) ?? "";
    expect(newestConvergence).toContain("**Source Commit**:");
    expect(newestConvergence).not.toContain("**Source Freshness Bypass**: true");

    const reboundMerge = spawnSync(BUN, [
      WORKTREE_TOOL, "merge", "--slug", "bypass", "--target", "main",
      "--strategy", "squash", "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8", env: mergeEnv });
    expect(reboundMerge.status).toBe(0);
    expect(readFileSync(join(proj, "reviewed.ts"), "utf-8")).toContain("redone");
  }, 180000);

  test("a bypassed convergence merges when the source merge repeats the switch", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "bypass-switch");
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "bypass-switch", "--base", "main"]);
    const wt = wtPath(proj, "bypass-switch");
    writeFileSync(join(wt, "reviewed.ts"), "export const reviewed = true;\n", "utf-8");
    git(wt, ["add", "--", "reviewed.ts"]);
    git(wt, ["commit", "-qm", "reviewed source"]);
    recordReview(wt, "code-generation", REVIEWER, "bypass-switch");

    const finalized = runSwarm(
      proj,
      [
        "finalize",
        "--batch",
        "1",
        "--units",
        "bypass-switch",
        "--claimed",
        "bypass-switch",
        "--check-cmd",
        `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
      ],
      { AIDLC_SKIP_SOURCE_FRESHNESS: "1" },
    );
    expect(finalized.rc).toBe(0);
    const convergence = readAllAuditShards(proj).split("## Swarm Unit Converged").at(-1) ?? "";
    expect(convergence).toContain("**Source Freshness Bypass**: true");

    writeFileSync(join(wt, "after-finalize.ts"), "export const afterFinalize = true;\n", "utf-8");
    git(wt, ["add", "--", "after-finalize.ts"]);
    git(wt, ["commit", "-qm", "source advanced under explicit bypass"]);
    const refused = spawnSync(BUN, [
      WORKTREE_TOOL, "merge", "--slug", "bypass-switch", "--target", "main",
      "--strategy", "squash", "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8" });
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain(
      "retry this merge with AIDLC_SKIP_SOURCE_FRESHNESS=1",
    );
    expect(existsSync(wt)).toBe(true);

    const merge = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "bypass-switch",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      {
        cwd: proj,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_SKIP_SOURCE_FRESHNESS: "1" },
      },
    );
    expect(merge.status, `${merge.stdout}${merge.stderr}`).toBe(0);
    expect(readFileSync(join(proj, "reviewed.ts"), "utf-8")).toContain("reviewed");
    expect(readFileSync(join(proj, "after-finalize.ts"), "utf-8")).toContain("afterFinalize");
  }, 120000);

  test("bypass cleanup preserves untracked and ignored application source", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "bypass-dirty");
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "bypass-dirty", "--base", "main"]);
    const wt = wtPath(proj, "bypass-dirty");
    writeFileSync(
      join(wt, ".gitignore"),
      `${readFileSync(join(wt, ".gitignore"), "utf-8")}ignored-source.ts\n`,
      "utf-8",
    );
    writeFileSync(join(wt, "reviewed.ts"), "export const reviewed = true;\n", "utf-8");
    git(wt, ["add", "--", ".gitignore", "reviewed.ts"]);
    git(wt, ["commit", "-qm", "reviewed source"]);
    recordReview(wt, "code-generation", REVIEWER, "bypass-dirty");
    const finalized = runSwarm(
      proj,
      [
        "finalize",
        "--batch",
        "1",
        "--units",
        "bypass-dirty",
        "--claimed",
        "bypass-dirty",
        "--check-cmd",
        `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
      ],
      { AIDLC_SKIP_SOURCE_FRESHNESS: "1" },
    );
    expect(finalized.rc).toBe(0);

    writeFileSync(
      join(wt, "uncommitted.ts"),
      "export const uncommitted = 'must survive cleanup';\n",
      "utf-8",
    );
    const merge = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "bypass-dirty",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      {
        cwd: proj,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_SKIP_SOURCE_FRESHNESS: "1" },
      },
    );
    const output = `${merge.stdout}${merge.stderr}`;
    expect(merge.status).not.toBe(0);
    expect(output).toContain("uncommitted or ignored application paths");
    expect(output).not.toContain("[merge-succeeded:");
    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(wt, "uncommitted.ts"), "utf-8")).toContain("must survive cleanup");
    expect(existsSync(join(proj, "reviewed.ts"))).toBe(false);
    expect(existsSync(join(proj, "uncommitted.ts"))).toBe(false);

    rmSync(join(wt, "uncommitted.ts"));
    writeFileSync(
      join(wt, "ignored-source.ts"),
      "export const ignored = 'must also survive cleanup';\n",
      "utf-8",
    );
    const ignoredMerge = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "bypass-dirty",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      {
        cwd: proj,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_SKIP_SOURCE_FRESHNESS: "1" },
      },
    );
    const ignoredOutput = `${ignoredMerge.stdout}${ignoredMerge.stderr}`;
    expect(ignoredMerge.status).not.toBe(0);
    expect(ignoredOutput).toContain("uncommitted or ignored application paths");
    expect(ignoredOutput).not.toContain("[merge-succeeded:");
    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(wt, "ignored-source.ts"), "utf-8")).toContain(
      "must also survive cleanup",
    );
    expect(existsSync(join(proj, "ignored-source.ts"))).toBe(false);
  }, 120000);

  test("a tracked symlink matched by a broad clean filter stays a symlink through finalize and merge", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "link");
    git(proj, ["config", "core.symlinks", "true"]);
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "link", "--base", "main"]);
    const wt = wtPath(proj, "link");
    git(wt, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    writeFileSync(join(wt, ".gitattributes"), "* filter=tidy\n", "utf-8");
    writeFileSync(join(wt, "target.txt"), "reviewed target\n", "utf-8");
    symlinkSync("target.txt", join(wt, "link.txt"), "file");
    git(wt, ["add", "--", ".gitattributes", "target.txt", "link.txt"]);
    git(wt, ["commit", "-qm", "tracked filtered symlink"]);
    recordReview(wt, "code-generation", REVIEWER, "link");

    const finalized = runSwarm(proj, [
      "finalize", "--batch", "1", "--units", "link", "--claimed", "link",
      "--check-cmd", `"${process.execPath}" -e "require('fs').lstatSync('link.txt').isSymbolicLink()||process.exit(1)"`,
    ]);
    expect(finalized.rc).toBe(0);
    const merge = spawnSync(BUN, [
      WORKTREE_TOOL, "merge", "--slug", "link", "--target", "main",
      "--strategy", "squash", "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8" });
    if (merge.status !== 0) {
      throw new Error(`filtered symlink merge failed: ${merge.stdout ?? ""}${merge.stderr ?? ""}`);
    }
    expect(lstatSync(join(proj, "link.txt")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(proj, "link.txt"))).toBe("target.txt");
    expect(readFileSync(join(proj, "target.txt"), "utf-8").replace(/\r\n/g, "\n"))
      .toBe("reviewed target\n");
  }, 120000);

  test("mutable checkout filters are refused before target mutation or source-merge authority", () => {
    const proj = makeFixture();
    const external = mkdtempSync(join(tmpdir(), "aidlc-t314-smudge-merge-"));
    extraDirs.push(external);
    const script = join(external, "smudge.mjs");
    const payload = join(external, "payload.txt");
    writeFileSync(
      script,
      [
        'import { readFileSync } from "node:fs";',
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(readFileSync(process.argv.at(-1)));",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(payload, "REVIEWED\n");

    ensureDagUnit(proj, "smudge");
    runSwarm(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "smudge",
      "--base",
      "main",
    ]);
    const wt = wtPath(proj, "smudge");
    git(wt, [
      "config",
      "filter.mutable.smudge",
      `"${process.execPath}" "${script}" "${payload}"`,
    ]);
    writeFileSync(join(wt, ".gitattributes"), "smudged.ts filter=mutable\n");
    writeFileSync(join(wt, "smudged.ts"), "REVIEWED\n");
    recordReview(wt, "code-generation", REVIEWER, "smudge");
    const finalized = runSwarm(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "smudge",
      "--claimed",
      "smudge",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('smudged.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    writeFileSync(payload, "UNREVIEWED\n");
    const beforeHead = spawnSync(
      "git",
      ["-C", proj, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    const beforeStatus = spawnSync(
      "git",
      ["-C", proj, "status", "--porcelain=v1"],
      { encoding: "utf-8" },
    ).stdout;
    const merge = spawnSync(
      BUN,
      [
        WORKTREE_TOOL,
        "merge",
        "--slug",
        "smudge",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    const output = `${merge.stdout}${merge.stderr}`;
    expect(merge.status).not.toBe(0);
    expect(output).toContain("repository checkout-filter configuration is present");
    expect(output).toContain("filter.mutable.smudge");
    expect(output).not.toContain("[merge-succeeded:");
    expect(readAllAuditShards(proj)).not.toContain(
      "**Event**: SWARM_SOURCE_MERGED",
    );
    const afterHead = spawnSync(
      "git",
      ["-C", proj, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    const afterStatus = spawnSync(
      "git",
      ["-C", proj, "status", "--porcelain=v1"],
      { encoding: "utf-8" },
    ).stdout;
    expect(afterHead).toBe(beforeHead);
    expect(afterStatus).toBe(beforeStatus);
    expect(existsSync(join(proj, "smudged.ts"))).toBe(false);
    expect(existsSync(wt)).toBe(true);
  }, 120000);

  test("finalize merges a claimed unit whose worktree source is unchanged since its terminal review", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "bar");
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "bar", "--base", "main"]);
    const wt = wtPath(proj, "bar");
    git(wt, ["config", "filter.tidy.clean", "sed 's/[[:space:]]*$//'"]);
    writeFileSync(join(wt, ".gitattributes"), "bar.ts filter=tidy\n", "utf-8");
    writeFileSync(join(wt, "bar.ts"), "export const bar = 1;   \n", "utf-8");
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
      `"${process.execPath}" -e "require('fs').accessSync('bar.ts')"`,
    ]);
    expect(f.rc).toBe(0);
    expect(JSON.parse(f.out).converged).toBe(1);
    const audit = readAllAuditShards(proj);
    const reviewFp = /\*\*Event\*\*: REVIEW_COMPLETED[\s\S]*?\*\*Source Fingerprint\*\*: ([0-9a-f]+)/.exec(audit)?.[1];
    const convergedFp = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Source Fingerprint\*\*: ([0-9a-f]+)/.exec(audit)?.[1];
    expect(convergedFp).toBe(reviewFp);
    expect(audit).toMatch(/\*\*Source Commit\*\*: [0-9a-f]{40}/);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(audit)?.[1];
    if (!sourceCommit) throw new Error("convergence row did not carry Source Commit");
    const retainedRef = `refs/aidlc/reviewed-source/bar/${sourceCommit}`;
    const retained = spawnSync("git", ["-C", proj, "rev-parse", "--verify", retainedRef], {
      encoding: "utf-8",
    });
    expect(retained.status).toBe(0);
    expect(retained.stdout.trim()).toBe(sourceCommit);

    // commit-tree objects without a ref are pruned. The private per-commit ref
    // must keep this delayed merge target alive through an aggressive GC.
    git(proj, ["reflog", "expire", "--expire=now", "--all"]);
    git(proj, ["gc", "--prune=now"]);
    const afterGc = spawnSync("git", ["-C", proj, "cat-file", "-e", `${sourceCommit}^{commit}`]);
    expect(afterGc.status).toBe(0);

    // Make another intent active with a hostile same-unit row. `--intent`
    // must select the requested audit rather than silently reading this cursor.
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const originalIntent = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const decoyAudit = join(intents, "decoy-intent", "audit");
    mkdirSync(decoyAudit, { recursive: true });
    writeFileSync(
      join(decoyAudit, "decoy.md"),
      [
        "## Swarm Unit Converged",
        "**Timestamp**: 2099-01-01T00:00:00.000Z",
        "**Event**: SWARM_UNIT_CONVERGED",
        "**Unit name**: bar",
        "**Source Fingerprint**: unbindable",
        "",
        "---",
        "",
      ].join("\n"),
    );
    writeFileSync(join(intents, "active-intent"), "decoy-intent\n", "utf-8");

    const merge = spawnSync(BUN, [
      WORKTREE_TOOL, "merge", "--slug", "bar", "--target", "main",
      "--strategy", "squash", "--intent", originalIntent, "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8" });
    expect(merge.status).toBe(0);
    expect(readFileSync(join(proj, "bar.ts"), "utf-8").replace(/\r\n/g, "\n"))
      .toBe("export const bar = 1;   \n");
    const afterMerge = spawnSync("git", ["-C", proj, "show-ref", "--verify", "--quiet", retainedRef]);
    expect(afterMerge.status).toBe(1);
  }, 120000);

  test("an explicit intent binds a normalized legacy Unit to that intent's convergence", () => {
    const proj = makeFixture();
    const unit = "2fa";
    const slug = boltSlugForUnit(unit);
    seedBoltDag(proj, [unit]);

    const prepared = runSwarm(proj, [
      "prepare", "--batch", "1", "--units", unit, "--base", "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);
    const wt = wtPath(proj, slug);
    writeFileSync(join(wt, "reviewed.ts"), "export const reviewed = true;\n", "utf-8");
    recordReview(wt, "code-generation", REVIEWER, unit);
    const finalized = runSwarm(proj, [
      "finalize", "--batch", "1", "--units", unit, "--claimed", unit,
      "--check-cmd", `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    writeFileSync(join(wt, "unreviewed.ts"), "export const unreviewed = true;\n", "utf-8");
    git(wt, ["add", "--", "reviewed.ts", "unreviewed.ts"]);
    git(wt, ["commit", "-qm", "source advanced after convergence"]);

    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const originalIntent = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const decoyIntent = join(intents, "decoy-intent");
    mkdirSync(decoyIntent, { recursive: true });
    writeFileSync(
      join(decoyIntent, "aidlc-state.md"),
      readFileSync(join(intents, originalIntent, "aidlc-state.md"), "utf-8"),
      "utf-8",
    );
    writeFileSync(join(intents, "active-intent"), "decoy-intent\n", "utf-8");

    const merge = spawnSync(BUN, [
      WORKTREE_TOOL, "merge", "--slug", slug, "--target", "main",
      "--strategy", "squash", "--intent", originalIntent, "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8" });
    const output = `${merge.stdout}${merge.stderr}`;
    expect(merge.status).not.toBe(0);
    expect(output).toContain("source-fingerprint mismatch");
    expect(output).not.toContain("[merge-succeeded:");
    expect(existsSync(join(proj, "reviewed.ts"))).toBe(false);
    expect(existsSync(join(proj, "unreviewed.ts"))).toBe(false);
  }, 120000);

  test("discard removes the retained reviewed-source refs for that Bolt", () => {
    const proj = makeFixture();
    ensureDagUnit(proj, "drop");
    runSwarm(proj, ["prepare", "--batch", "1", "--units", "drop", "--base", "main"]);
    const wt = wtPath(proj, "drop");
    writeFileSync(join(wt, "drop.ts"), "export const drop = true;\n", "utf-8");
    recordReview(wt, "code-generation", REVIEWER, "drop");
    const finalized = runSwarm(proj, [
      "finalize", "--batch", "1", "--units", "drop", "--claimed", "drop",
      "--check-cmd", `"${process.execPath}" -e "require('fs').accessSync('drop.ts')"`,
    ]);
    expect(finalized.rc).toBe(0);
    const audit = readAllAuditShards(proj);
    const sourceCommit = /\*\*Event\*\*: SWARM_UNIT_CONVERGED[\s\S]*?\*\*Source Commit\*\*: ([0-9a-f]{40})/.exec(audit)?.[1];
    if (!sourceCommit) throw new Error("convergence row did not carry Source Commit");
    const retainedRef = `refs/aidlc/reviewed-source/drop/${sourceCommit}`;
    expect(spawnSync("git", ["-C", proj, "show-ref", "--verify", "--quiet", retainedRef]).status).toBe(0);

    const discarded = spawnSync(BUN, [
      WORKTREE_TOOL, "discard", "--slug", "drop", "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8" });
    expect(discarded.status).toBe(0);
    expect(spawnSync("git", ["-C", proj, "show-ref", "--verify", "--quiet", retainedRef]).status).toBe(1);
  }, 120000);
});
