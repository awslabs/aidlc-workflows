// covers: function:readUnitSourceManifest
// covers: function:sourceClaimCovers
// covers: function:readBaselineSourceSnapshot
// covers: function:readUnitSourceSnapshot
// covers: function:workspaceSourceListing
// covers: function:writeBaselineSourceSnapshot
// covers: function:writeUnitSourceSnapshot
// covers: function:currentStageSourceBaseline
// covers: function:currentSwarmSourceMergeChain
// covers: function:currentSwarmSourceOpeningFingerprint
// covers: function:currentSwarmAttemptObligations
// covers: function:sourceBaselineAuditFields
// covers: function:sourceListingEntriesEqual
// covers: audit:SWARM_SOURCE_MERGED
//
// t305 - focused #662 substrate and guard-contract coverage. End-to-end receipt,
// recovery, shielding, baselines, aggregate swarm authority, and multi-repo
// attribution are kept here so upstream-owned t304 remains conflict-minimal.

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  currentStageSourceBaseline,
  currentSwarmAttemptObligations,
  currentSwarmSourceMergeChain,
  currentSwarmSourceOpeningFingerprint,
  freshReviewReceipts,
  latestMainWorkflowStageRunFloorForProject,
  readAllAuditShards,
  readBaselineSourceSnapshot,
  readUnitSourceManifest,
  readUnitSourceSnapshot,
  recordDir,
  sourceClaimCovers,
  sourceListingEntriesEqual,
  serializeSourceListing,
  sourceBaselineAuditFields,
  sourceListingSha256,
  workspaceSourceListing,
  workspaceSourceState,
  writeBaselineSourceSnapshot,
  writeUnitSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  createTestProject,
  FIXTURES_DIR,
  seedBoltDag,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PROTOCOL = join(ROOT, "core", "aidlc-common", "protocols");
const STAGE = join(ROOT, "core", "aidlc-common", "stages", "construction", "code-generation.md");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const SWARM = join(AIDLC_SRC, "tools", "aidlc-swarm.ts");
const WORKTREE = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const dirs: string[] = [];
const worktreeDirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of worktreeDirs.splice(0)) cleanupWorktreeFixture(dir);
});

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function fixture(repos: string[] = []): { project: string; record: string } {
  const project = mkdtempSync(join(tmpdir(), "aidlc-t305-"));
  dirs.push(project);
  const record = join(project, "aidlc", "spaces", "default", "intents", "fixture-intent");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), "# State\n- **Scope**: feature\n", "utf-8");
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "intents.json"), `${JSON.stringify([{ uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos }])}\n`);
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", ".active-intent"), "fixture-intent\n");
  if (repos.length === 0) {
    git(project, ["init", "-q"]); git(project, ["config", "user.email", "t@test"]); git(project, ["config", "user.name", "t"]);
    writeFileSync(join(project, "app.ts"), "export const app = 1;\n"); git(project, ["add", "-A"]); git(project, ["commit", "-qm", "seed"]);
  } else {
    for (const repo of repos) {
      const path = join(project, repo); mkdirSync(path, { recursive: true });
      git(path, ["init", "-q"]); git(path, ["config", "user.email", "t@test"]); git(path, ["config", "user.name", "t"]);
      writeFileSync(join(path, `${repo}.ts`), `export const ${repo.replace(/-/g, "_")} = 1;\n`); git(path, ["add", "-A"]); git(path, ["commit", "-qm", "seed"]);
    }
  }
  return { project, record };
}

function manifest(record: string, unit: string, value: unknown): string {
  const dir = join(record, "construction", "units", unit, "code-generation"); mkdirSync(dir, { recursive: true });
  const path = join(dir, "source-manifest.json"); writeFileSync(path, `${JSON.stringify(value)}\n`); return path;
}

describe("t305 strict source-manifest validation", () => {
  test("accepts exact and directory claims and rejects schema/path violations", () => {
    const { project, record } = fixture();
    const valid = { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }, { path: "src/generated/" }] };
    manifest(record, "alpha", valid);
    const accepted = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(sourceClaimCovers("\0app.ts", accepted)).toBe(true);
      expect(sourceClaimCovers("\0src/generated/a.ts", accepted)).toBe(true);
    }
    const rejected = [
      { ...valid, unknown: true },
      { ...valid, stage: "other" },
      { ...valid, unit: "beta" },
      { ...valid, version: 2 },
      { ...valid, writes: [{ path: "../escape.ts" }] },
      { ...valid, writes: [{ path: "/absolute.ts" }] },
      { ...valid, writes: [{ path: "bad\\path.ts" }] },
      { ...valid, writes: [{ path: "*.ts" }] },
      { ...valid, writes: [{ path: "aidlc/internal.ts" }] },
      { ...valid, writes: [{ path: "app.ts" }, { path: "./app.ts" }] },
    ];
    for (const value of rejected) {
      manifest(record, "alpha", value);
      expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
    }
  });

  test("multi-repo requires recorded repo and scopes claims to it", () => {
    const { project, record } = fixture(["repo-a", "repo-b"]);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ repo: "repo-a", path: "repo-a.ts" }, { repo: "repo-b", path: "repo-b.ts" }] });
    const accepted = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(sourceClaimCovers("repo-b\0repo-b.ts", accepted)).toBe(true);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "repo-a.ts" }] });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ repo: "repo-c", path: "x.ts" }] });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
  });

  test("accepts a trailing-slash prefix for a directory committed in HEAD", () => {
    const { project, record } = fixture();
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "committed.ts"), "export const committed = true;\n");
    git(project, ["add", "--", "src/committed.ts"]);
    git(project, ["commit", "-qm", "commit source directory"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "src/" }],
    });

    const accepted = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(sourceClaimCovers("\0src/committed.ts", accepted)).toBe(true);
    }
  });

  test("accepts an exact claim when a committed directory becomes a file", () => {
    const { project, record } = fixture();
    mkdirSync(join(project, "generated"), { recursive: true });
    writeFileSync(join(project, "generated", "old.ts"), "old\n");
    git(project, ["add", "--", "generated/old.ts"]);
    git(project, ["commit", "-qm", "commit generated directory"]);
    rmSync(join(project, "generated"), { recursive: true });
    writeFileSync(join(project, "generated"), "replacement\n");
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "generated" }],
    });

    const accepted = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(sourceClaimCovers("\0generated", accepted)).toBe(true);
    const listing = workspaceSourceListing(project);
    expect(listing).not.toBeNull();
    if (listing === null) return;
    const fingerprint = writeUnitSourceSnapshot(
      project,
      "code-generation",
      "alpha",
      listing,
      accepted,
      accepted.rawBytesSha256,
    );
    const snapshot = readUnitSourceSnapshot(
      project,
      "code-generation",
      "alpha",
      fingerprint,
    );
    expect(snapshot?.listing.has("\0generated")).toBe(true);
    expect(snapshot?.listing.has("\0generated/old.ts")).toBe(false);
  });

  test("rejects ignored exact claims and prefixes containing ignored source", () => {
    const { project, record } = fixture();
    writeFileSync(
      join(project, ".gitignore"),
      "ignored.ts\nignored-dir/*.tmp\n",
    );
    writeFileSync(join(project, "ignored.ts"), "ignored\n");
    mkdirSync(join(project, "ignored-dir"), { recursive: true });
    writeFileSync(join(project, "ignored-dir", "generated.tmp"), "ignored\n");

    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "ignored.ts" }],
    });
    const exact = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(exact.ok).toBe(false);
    if (!exact.ok) expect(exact.reason).toContain("ignored by Git");

    mkdirSync(join(project, "ignored-root"), { recursive: true });
    writeFileSync(join(project, "ignored-root", "generated.js"), "ignored\n");
    writeFileSync(
      join(project, ".gitignore"),
      "ignored.ts\nignored-dir/*.tmp\nignored-root/\n",
    );
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "ignored-root" }],
    });
    const ignoredDirectoryExact = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(ignoredDirectoryExact.ok).toBe(false);
    if (!ignoredDirectoryExact.ok) {
      expect(ignoredDirectoryExact.reason).toContain(
        '"ignored-root" is ignored by Git',
      );
      expect(ignoredDirectoryExact.reason).not.toContain(
        "could not verify the current path type",
      );
    }

    writeFileSync(join(project, "ignored-replacement"), "tracked file\n");
    git(project, ["add", "--", "ignored-replacement"]);
    git(project, ["commit", "-qm", "track replacement source"]);
    rmSync(join(project, "ignored-replacement"));
    mkdirSync(join(project, "ignored-replacement"), { recursive: true });
    writeFileSync(
      join(project, "ignored-replacement", "generated.js"),
      "ignored\n",
    );
    writeFileSync(
      join(project, ".gitignore"),
      "ignored.ts\nignored-dir/*.tmp\nignored-root/\nignored-replacement/\n",
    );
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "ignored-replacement" }],
    });
    const ignoredReplacement = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(ignoredReplacement.ok).toBe(false);
    if (!ignoredReplacement.ok) {
      expect(ignoredReplacement.reason).toContain(
        '"ignored-replacement" is ignored by Git',
      );
    }

    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "ignored-dir/" }],
    });
    const prefix = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(prefix.ok).toBe(false);
    if (!prefix.ok) expect(prefix.reason).toContain("contains ignored application source");

    writeFileSync(join(project, "force-only.secret"), "staged but uncommitted\n");
    writeFileSync(
      join(project, ".gitignore"),
      "ignored.ts\nignored-dir/*.tmp\n*.secret\n",
    );
    git(project, ["add", ".gitignore"]);
    git(project, ["commit", "-qm", "ignore rules"]);
    git(project, ["add", "-f", "force-only.secret"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "force-only.secret" }],
    });
    const forceOnly = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(forceOnly.ok).toBe(false);
    if (!forceOnly.ok) expect(forceOnly.reason).toContain("ignored by Git");
    git(project, ["reset", "-q", "HEAD", "--", "force-only.secret"]);

    writeFileSync(join(project, "head-tracked.secret"), "tracked in HEAD\n");
    git(project, ["add", "-f", "head-tracked.secret"]);
    git(project, ["commit", "-qm", "track ignored source"]);
    git(project, ["rm", "-q", "--cached", "head-tracked.secret"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "head-tracked.secret" }],
    });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok)
      .toBe(true);
    expect(workspaceSourceListing(project)?.has("\0head-tracked.secret"))
      .toBe(true);

    mkdirSync(join(project, "slashless"), { recursive: true });
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "slashless" }],
    });
    const slashless = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(slashless.ok).toBe(false);
    if (!slashless.ok) expect(slashless.reason).toContain("must end with");
  });

  test("rejects a prefix containing a force-added ignored descendant", () => {
    const { project, record } = fixture();
    writeFileSync(join(project, ".gitignore"), "force-dir/*.secret\n");
    git(project, ["add", "--", ".gitignore"]);
    git(project, ["commit", "-qm", "commit ignore rules"]);
    mkdirSync(join(project, "force-dir"), { recursive: true });
    writeFileSync(join(project, "force-dir", "key.secret"), "secret\n");
    git(project, ["add", "-f", "--", "force-dir/key.secret"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "force-dir/" }],
    });

    const rejected = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toContain("contains ignored application source");
      expect(rejected.reason).toContain("force-dir/key.secret");
    }
    expect(
      workspaceSourceListing(project)?.has("\0force-dir/key.secret"),
    ).toBe(true);
  });

  test("validates fully resolved symlink targets for exact and directory claims", () => {
    const { project, record } = fixture();
    writeFileSync(join(project, ".gitignore"), "private/*.ts\n");
    mkdirSync(join(project, "private"), { recursive: true });
    writeFileSync(join(project, "private", "secret.ts"), "secret\n");
    symlinkSync("private/secret.ts", join(project, "ignored-link.ts"));
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "ignored-link.ts" }],
    });
    const exactIgnored = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(exactIgnored.ok).toBe(false);
    if (!exactIgnored.ok) {
      expect(exactIgnored.reason).toContain("ignored-link.ts");
      expect(exactIgnored.reason).toContain("private/secret.ts");
      expect(exactIgnored.reason).toContain("ignored by Git");
    }

    mkdirSync(join(project, "src"), { recursive: true });
    symlinkSync("../private/secret.ts", join(project, "src", "ignored-link.ts"));
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "src/" }],
    });
    const directoryIgnored = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(directoryIgnored.ok).toBe(false);
    if (!directoryIgnored.ok) {
      expect(directoryIgnored.reason).toContain("src/ignored-link.ts");
      expect(directoryIgnored.reason).toContain("ignored by Git");
    }

    symlinkSync("../outside.ts", join(project, "outside-link.ts"));
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "outside-link.ts" }],
    });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);

    symlinkSync("missing.ts", join(project, "dangling-link.ts"));
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "dangling-link.ts" }],
    });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);

    symlinkSync("cycle-b", join(project, "cycle-a"));
    symlinkSync("cycle-a", join(project, "cycle-b"));
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "cycle-a" }],
    });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);

    writeFileSync(join(project, "tracked-target.ts"), "tracked\n");
    symlinkSync("tracked-target.ts", join(project, "tracked-link.ts"));
    git(project, ["add", "--", ".gitignore", "tracked-target.ts", "tracked-link.ts"]);
    git(project, ["commit", "-qm", "track bindable symlink target"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "tracked-link.ts" }],
    });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(true);

    const projectAlias = `${project}-alias`;
    symlinkSync(
      project,
      projectAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    dirs.push(projectAlias);
    expect(
      readUnitSourceManifest(projectAlias, "code-generation", "alpha").ok,
    ).toBe(true);

    const outsideHopDir = mkdtempSync(
      join(tmpdir(), "aidlc-out-and-back-"),
    );
    dirs.push(outsideHopDir);
    symlinkSync(
      join(project, "tracked-target.ts"),
      join(outsideHopDir, "hop"),
    );
    symlinkSync(
      join(outsideHopDir, "hop"),
      join(project, "out-and-back-link.ts"),
    );
    git(project, ["add", "--", "out-and-back-link.ts"]);
    git(project, ["commit", "-qm", "track out-and-back symlink"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "out-and-back-link.ts" }],
    });
    const outAndBack = readUnitSourceManifest(
      projectAlias,
      "code-generation",
      "alpha",
    );
    expect(outAndBack.ok).toBe(false);
    if (!outAndBack.ok) {
      expect(outAndBack.reason).toContain("out-and-back-link.ts");
      expect(outAndBack.reason).toContain("outside the repository");
    }

    symlinkSync(
      outsideHopDir,
      join(project, "outside-directory-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    symlinkSync(
      "outside-directory-link/hop",
      join(project, "nested-out-and-back-link.ts"),
    );
    git(project, [
      "add",
      "--",
      "outside-directory-link",
      "nested-out-and-back-link.ts",
    ]);
    git(project, ["commit", "-qm", "track nested out-and-back symlink"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "nested-out-and-back-link.ts" }],
    });
    const nestedOutAndBack = readUnitSourceManifest(
      projectAlias,
      "code-generation",
      "alpha",
    );
    expect(nestedOutAndBack.ok).toBe(false);
    if (!nestedOutAndBack.ok) {
      expect(nestedOutAndBack.reason).toContain(
        "nested-out-and-back-link.ts",
      );
      expect(nestedOutAndBack.reason).toContain(
        "outside the repository",
      );
    }

    mkdirSync(join(project, "real-directory"), { recursive: true });
    writeFileSync(join(project, "real-directory", "inner.ts"), "inner\n");
    symlinkSync(
      "real-directory",
      join(project, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    );
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "linked-directory" }],
    });
    const linkedDirectoryExact = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(linkedDirectoryExact.ok).toBe(true);

    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "real-directory/inner.ts" }],
    });
    expect(
      readUnitSourceManifest(project, "code-generation", "alpha").ok,
    ).toBe(true);

    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "linked-directory/inner.ts" }],
    });
    const throughLinkedDirectory = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(throughLinkedDirectory.ok).toBe(false);
    if (!throughLinkedDirectory.ok) {
      expect(throughLinkedDirectory.reason).toContain(
        'traverses symlinked directory "linked-directory"',
      );
      expect(throughLinkedDirectory.reason).toContain(
        "Source claims bind link text, not target bytes",
      );
      expect(throughLinkedDirectory.reason).toContain(
        "claim the real target path instead, or restructure the link",
      );
      expect(throughLinkedDirectory.reason).not.toContain(
        "claim the link itself",
      );
      expect(throughLinkedDirectory.reason).not.toContain(
        "Git could not verify ignore rules",
      );
    }

    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "linked-directory/" }],
    });
    const linkedDirectoryPrefix = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(linkedDirectoryPrefix.ok).toBe(false);
    if (!linkedDirectoryPrefix.ok) {
      expect(linkedDirectoryPrefix.reason).toContain(
        '"real-directory" is a directory and cannot be bound through a symlinked directory claim',
      );
      expect(linkedDirectoryPrefix.reason).not.toContain(
        'directory claims must end with "/"',
      );
    }
  }, 30000);
});

describe("t305 content-addressed source review evidence", () => {
  test("baseline and unit snapshots round-trip and fail closed after destruction or tamper", () => {
    const { project, record } = fixture();
    const listing = workspaceSourceListing(project); expect(listing).not.toBeNull();
    if (listing === null) return;
    expect(listing.get("\0app.ts")).toMatch(/^100644 [0-9a-f]{40,64}$/);
    const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
    expect(readBaselineSourceSnapshot(project, "code-generation", baseline)?.get("\0app.ts"))
      .toMatch(/^100644 [0-9a-f]{40,64}$/);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }] });
    const claims = readUnitSourceManifest(project, "code-generation", "alpha"); expect(claims.ok).toBe(true);
    if (!claims.ok) return;
    const unit = writeUnitSourceSnapshot(project, "code-generation", "alpha", listing, claims, claims.rawBytesSha256);
    expect(readUnitSourceSnapshot(project, "code-generation", "alpha", unit)?.manifestSha256).toBe(claims.rawBytesSha256);
    const unitPath = join(record, ".aidlc-source-review", "code-generation", `unit-alpha-${unit.slice(7, 19)}.tsv`);
    writeFileSync(unitPath, "tampered\n");
    expect(readUnitSourceSnapshot(project, "code-generation", "alpha", unit)).toBeNull();
  });

  test("manifest bytes are bound, covering direct-fs post-review tamper and deleted claims", () => {
    const { project, record } = fixture();
    const path = manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }] });
    const first = readUnitSourceManifest(project, "code-generation", "alpha"); expect(first.ok).toBe(true);
    writeFileSync(path, `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [] }, null, 2)}\n`);
    const second = readUnitSourceManifest(project, "code-generation", "alpha"); expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.rawBytesSha256).not.toBe(first.rawBytesSha256);
    rmSync(join(project, "app.ts"));
    expect(workspaceSourceListing(project)?.has("\0app.ts")).toBe(false);
  });

  test("legacy OID-only entries migrate by content while modern mode changes remain distinct", () => {
    const oid = "a".repeat(40);
    expect(sourceListingEntriesEqual(oid, `100644 ${oid}`)).toBe(true);
    expect(sourceListingEntriesEqual(`100644 ${oid}`, `100755 ${oid}`)).toBe(false);
  });

  test("a no-Git workspace binds both empty and populated source listings", () => {
    const project = createTestProject();
    dirs.push(project);
    const empty = workspaceSourceState(project);
    expect(empty).not.toBeNull();
    expect(empty?.listing.size).toBe(0);
    expect(empty?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(project, "untracked-without-git.ts"), "unbound\n");
    const populated = workspaceSourceState(project);
    expect(populated).not.toBeNull();
    expect(populated?.listing.get("\0untracked-without-git.ts")).toMatch(
      /^100644 [0-9a-f]{64}$/,
    );
    expect(populated?.fingerprint).not.toBe(empty?.fingerprint);
  });

  test("no-Git workflow creation is empty while a jump preserves populated source", () => {
    const project = createTestProject();
    dirs.push(project);
    const creationResult = spawnSync(
      process.execPath,
      [
        UTILITY,
        "intent-create",
        "--scope",
        "feature",
        "--label",
        "empty-baseline",
        "--project-dir",
        project,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_WORKFLOW_INTENT: "empty baseline creation",
        },
      },
    );
    expect(
      creationResult.status,
      `${creationResult.stdout ?? ""}${creationResult.stderr ?? ""}`,
    ).toBe(0);
    const creationAudit = readAllAuditShards(project);
    const creationField =
      /\*\*Event\*\*: WORKFLOW_STARTED[\s\S]*?\*\*Source Baseline\*\*: (sha256:[0-9a-f]{64})/
        .exec(creationAudit)?.[1];
    expect(creationField).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      readBaselineSourceSnapshot(
        project,
        "code-generation",
        creationField as string,
      )?.size,
    ).toBe(0);
    const creationBaseline = currentStageSourceBaseline(
      project,
      "code-generation",
      true,
    );
    expect(creationBaseline.state).toBe("ready");
    if (creationBaseline.state === "ready") {
      expect(creationBaseline.listing.size).toBe(0);
    }

    const jumped = createTestProject();
    dirs.push(jumped);
    seedStateFile(jumped, "state-mid-ideation.md");
    git(jumped, ["init", "-q"]);
    git(jumped, ["config", "user.email", "t@test"]);
    git(jumped, ["config", "user.name", "t"]);
    writeFileSync(join(jumped, "existing.ts"), "export const existing = true;\n");
    git(jumped, ["add", "-A"]);
    git(jumped, ["commit", "-qm", "existing source"]);
    const initial = writeBaselineSourceSnapshot(
      jumped,
      "code-generation",
      workspaceSourceListing(jumped) as Map<string, string>,
    );
    appendAuditEntry(
      "WORKFLOW_STARTED",
      { Scope: "feature", "Source Baseline": initial },
      jumped,
    );
    rmSync(join(jumped, ".git"), { recursive: true, force: true });
    const boundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === boundarySecond) {}
    const executed = spawnSync(
      process.execPath,
      [
        JUMP,
        "execute",
        "--target",
        "code-generation",
        "--direction",
        "forward",
        "--scope",
        "feature",
        "--project-dir",
        jumped,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
        },
      },
    );
    expect(executed.status, `${executed.stdout ?? ""}${executed.stderr ?? ""}`)
      .toBe(0);
    const jumpBlock = readAllAuditShards(jumped)
      .split(/\n---\n/)
      .filter((block) => block.includes("**Event**: STAGE_JUMPED"))
      .at(-1);
    const jumpField = jumpBlock?.match(
      /^\*\*Source Baseline\*\*: (sha256:[0-9a-f]{64})$/m,
    )?.[1];
    expect(jumpField).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(jumpField).toBe(initial);
    expect(
      readBaselineSourceSnapshot(
        jumped,
        "code-generation",
        jumpField as string,
      )?.size,
    ).toBe(1);
    const selected = currentStageSourceBaseline(
      jumped,
      "code-generation",
      true,
    );
    expect(selected.state).toBe("ready");
    if (selected.state === "ready") expect(selected.listing.size).toBe(1);
    const selectedStageMajor = currentStageSourceBaseline(
      jumped,
      "code-generation",
      false,
    );
    expect(selectedStageMajor.state).toBe("ready");
    if (selectedStageMajor.state === "ready") {
      expect(selectedStageMajor.listing.size).toBe(1);
    }
    const opening = currentSwarmSourceOpeningFingerprint(
      jumped,
      "code-generation",
    );
    expect(opening.state).toBe("ready");
    expect(recordDir(jumped)).not.toBeNull();
  }, 30000);

  test("current swarm source chain binds its opening baseline and latest per-unit convergence", () => {
    const { project } = runtimeFixture();
    const floor = latestMainWorkflowStageRunFloorForProject(
      project,
      "code-generation",
    );
    const opening = currentSwarmSourceOpeningFingerprint(
      project,
      "code-generation",
    );
    expect(opening.state).toBe("ready");
    if (opening.state !== "ready") return;
    const current = workspaceSourceState(project);
    expect(current).not.toBeNull();
    if (current === null) return;
    const commit = spawnSync(
      "git",
      ["-C", project, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    expect(commit).toMatch(/^[0-9a-f]{40,64}$/);

    for (const unit of ["alpha", "beta"]) {
      appendAuditEntry(
        "SWARM_UNIT_CONVERGED",
        {
          "Batch number": "1",
          "Unit name": unit,
          Stage: "code-generation",
          "Run floor": floor,
          "Source Commit": commit,
        },
        project,
      );
      appendAuditEntry(
        "SWARM_SOURCE_MERGED",
        {
          "Batch number": "1",
          "Unit name": unit,
          Stage: "code-generation",
          "Run floor": floor,
          "Previous Source Fingerprint":
            unit === "alpha" ? opening.fingerprint : current.fingerprint,
          "Source Fingerprint": current.fingerprint,
          "Source Commit": commit,
          "Merge commit": commit,
        },
        project,
      );
    }

    const chain = currentSwarmSourceMergeChain(project, "code-generation");
    expect(chain.state).toBe("ready");
    if (chain.state === "ready") {
      expect(chain.fingerprint).toBe(current.fingerprint);
      expect([...chain.units].sort()).toEqual(["alpha", "beta"]);
    }
    expect(opening.fingerprint).toBe(
      sourceListingSha256(
        serializeSourceListing(
          opening.listing ?? new Map(),
        ),
      ),
    );
  }, 30000);
});


function runtimeFixture(): { project: string; record: string } {
  const { project, record } = fixture();
  let state = readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8");
  state = state
    .replace("- **Current Stage**: feasibility", "- **Current Stage**: code-generation\n- **Construction Iteration**: stage-major")
    .replace("- [ ] code-generation — EXECUTE", "- [?] code-generation — EXECUTE");
  writeFileSync(join(record, "aidlc-state.md"), state, "utf-8");
  const dag = join(record, "inception", "units-generation");
  mkdirSync(dag, { recursive: true });
  writeFileSync(join(dag, "unit-of-work-dependency.md"), "```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n");
  const listing = workspaceSourceListing(project);
  if (listing === null) throw new Error("runtime fixture source listing missing");
  const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, project);
  appendAuditEntry("STAGE_STARTED", {
    Stage: "code-generation",
    Agent: "aidlc-developer-agent",
    "Source Baseline": baseline,
  }, project);
  // Audit timestamps are second-precision. The boundary is emitted in this
  // test process while product CLIs append from child processes/shards; wait
  // for the next second so the fixture does not manufacture causal ambiguity.
  const boundarySecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === boundarySecond) {}
  return { project, record };
}

function seedArtifacts(record: string, unit: string): string {
  const dir = join(record, "construction", "units", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "code-summary.md", "traceability.json"])
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), name.endsWith(".json") ? "{}\n" : `# ${name}\n`);
  return dir;
}

function reviewArtifact(record: string, unit?: string): string {
  const dir = unit
    ? join(record, "construction", "units", unit, "code-generation")
    : join(record, "construction", "code-generation");
  return join(dir, "code-generation-plan.md");
}

function stripReviewAppendix(artifact: string): void {
  const current = readFileSync(artifact, "utf-8");
  const reviewStart = current.search(/^## Review[ \t]*$/m);
  if (reviewStart === -1) return;
  writeFileSync(
    artifact,
    `${current.slice(0, reviewStart).replace(/\s+$/, "")}\n`,
    "utf-8",
  );
}

function appendReviewAppendix(
  artifact: string,
  iteration: string,
  verdict: "READY" | "NOT-READY" = "READY",
): void {
  appendFileSync(
    artifact,
    `\n## Review\n\n**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** ${iteration}\n\n### Findings\n\nNo blocking findings.\n`,
    "utf-8",
  );
}

function writeManifest(record: string, unit: string, writes: Array<{ path: string; repo?: string }>): void {
  const dir = seedArtifacts(record, unit);
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit, version: 1, writes }, null, 2)}\n`);
}

function cli(tool: string, args: string[], project: string, env: Record<string, string> = {}): { rc: number; out: string } {
  const merged = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_REVISION_BACKSTOP: "1", ...env };
  const r = spawnSync(process.execPath, [tool, ...args, "--project-dir", project], { encoding: "utf-8", env: merged });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function review(
  project: string,
  record: string,
  unit: string,
  writes: Array<{ path: string; repo?: string }>,
  env: Record<string, string> = {},
  iteration?: string,
): { request: {rc:number;out:string}; verdict: {rc:number;out:string} } {
  writeManifest(record, unit, writes);
  const prior = (readAllAuditShards(project).match(new RegExp(`\\*\\*Event\\*\\*: REVIEW_REQUESTED[\\s\\S]*?\\*\\*Unit\\*\\*: ${unit}`, "g")) ?? []).length;
  const reviewIteration = iteration ?? String(prior + 1);
  const artifact = reviewArtifact(record, unit);
  stripReviewAppendix(artifact);
  const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", unit, "--iteration", reviewIteration];
  const request = cli(LOG, args, project, env);
  if (request.rc === 0) appendReviewAppendix(artifact, reviewIteration);
  const verdict = request.rc === 0 ? cli(LOG, [...args, "--verdict", "READY"], project, env) : { rc: request.rc, out: request.out };
  return { request, verdict };
}

function approve(project: string, env: Record<string, string> = {}): { rc: number; out: string } {
  return cli(STATE, ["approve", "code-generation", "--user-input", "ship"], project, env);
}

function stripUnitBindings(project: string): void {
  const root = join(project, "aidlc", "spaces", "default", "intents");
  for (const rec of readdirSync(root)) {
    const audit = join(root, rec, "audit"); if (!existsSync(audit)) continue;
    for (const file of readdirSync(audit)) {
      const path = join(audit, file); let body = readFileSync(path, "utf-8");
      body = body.replace(/^\*\*(?:Unit Source Fingerprint|Unit Source Binding Bypass)\*\*: .*\r?\n/gm, "");
      writeFileSync(path, body);
    }
  }
}

function stripAuditFields(
  project: string,
  event: string,
  fields: string[],
): void {
  const intentsRoot = join(
    project,
    "aidlc",
    "spaces",
    "default",
    "intents",
  );
  for (const record of readdirSync(intentsRoot)) {
    const auditDir = join(intentsRoot, record, "audit");
    if (!existsSync(auditDir)) continue;
    for (const file of readdirSync(auditDir).filter((name) => name.endsWith(".md"))) {
      const path = join(auditDir, file);
      const body = readFileSync(path, "utf-8");
      const stripped = body
        .split("\n---\n")
        .map((block) => {
          if (!block.includes(`**Event**: ${event}`)) return block;
          return block
            .split("\n")
            .filter(
              (line) =>
                !fields.some((field) => line.startsWith(`**${field}**:`)),
            )
            .join("\n");
        })
        .join("\n---\n");
      writeFileSync(path, stripped, "utf-8");
    }
  }
}

function swarmFixture(
  seedApplication?: (project: string) => void,
): string {
  const project = setupWorktreeFixture();
  worktreeDirs.push(project);
  git(project, ["config", "user.email", "t@test"]);
  git(project, ["config", "user.name", "t"]);
  const state = readFileSync(
    join(FIXTURES_DIR, "state-construction-with-worktree.md"),
    "utf-8",
  ).replace(/^(- \*\*Bolt Refs\*\*: ).*$/m, "$1");
  writeFileSync(seededStateFile(project), state);
  mkdirSync(seededAuditDir(project), { recursive: true });
  writeFileSync(
    seededAuditShard(project),
    "# AI-DLC Audit Log\n",
    "utf-8",
  );
  writeFileSync(
    join(project, ".gitignore"),
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
  seedApplication?.(project);
  git(project, ["add", "-A"]);
  git(project, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--amend",
    "--no-edit",
  ]);
  appendAuditEntry(
    "WORKFLOW_STARTED",
    {
      Scope: "feature",
      ...sourceBaselineAuditFields(project, "code-generation"),
    },
    project,
  );
  const boundarySecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === boundarySecond) {}
  return project;
}

function writeAuthoredDag(
  project: string,
  units: Array<{ name: string; dependsOn: string[] }>,
): void {
  const dir = join(
    seededRecordDir(project),
    "inception",
    "units-generation",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "unit-of-work-dependency.md"),
    [
      "```yaml",
      "units:",
      ...units.flatMap((unit) => [
        `  - name: ${unit.name}`,
        `    depends_on: [${unit.dependsOn.join(", ")}]`,
      ]),
      "```",
      "",
    ].join("\n"),
  );
}

function runSwarm(
  project: string,
  args: string[],
): { rc: number; out: string } {
  const result = spawnSync(
    process.execPath,
    [SWARM, "--project-dir", project, ...args],
    { cwd: project, encoding: "utf-8" },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function mergeSwarmUnit(
  project: string,
  unit: string,
): { rc: number; out: string } {
  const result = spawnSync(
    process.execPath,
    [
      WORKTREE,
      "merge",
      "--slug",
      unit,
      "--target",
      "main",
      "--strategy",
      "squash",
      "--project-dir",
      project,
    ],
    { cwd: project, encoding: "utf-8" },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function auditLockWatcher(
  shard: string,
  marker: string,
  slug: string,
) {
  const script = `
    const fs = require("node:fs");
    const shard = process.env.AIDLC_TEST_AUDIT_SHARD;
    const marker = process.env.AIDLC_TEST_AUDIT_MARKER;
    const slug = process.env.AIDLC_TEST_BOLT_SLUG;
    const deadline = Date.now() + 15000;
    const poll = () => {
      let body = "";
      try { body = fs.readFileSync(shard, "utf8"); } catch {}
      if (
        body.includes("**Event**: WORKTREE_MERGED") &&
        body.includes("**Bolt slug**: " + slug)
      ) {
        fs.chmodSync(shard, 0o444);
        fs.writeFileSync(marker, "locked\\n");
        process.exit(0);
      }
      if (Date.now() >= deadline) process.exit(2);
      setTimeout(poll, 1);
    };
    poll();
  `;
  return spawn(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      AIDLC_TEST_AUDIT_SHARD: shard,
      AIDLC_TEST_AUDIT_MARKER: marker,
      AIDLC_TEST_BOLT_SLUG: slug,
    },
    stdio: "ignore",
  });
}

describe("t305 real receipt and guard flows", () => {
  test("2 REVIEW_REQUESTED refuses a missing manifest even with the freshness bypass", () => {
    const { project, record } = runtimeFixture(); seedArtifacts(record, "alpha");
    const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "1"];
    const refused = cli(LOG, args, project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("has no valid source manifest");
    const bypass = cli(LOG, args, project, {
      AIDLC_SKIP_SOURCE_FRESHNESS: "1",
    });
    expect(bypass.rc).toBe(1);
    expect(bypass.out).toContain("has no valid source manifest");
    expect(readAllAuditShards(project)).not.toContain("**Event**: REVIEW_REQUESTED");
  }, 30000);

  test("REVIEW_COMPLETED and retry-pending refuse source edited after dispatch", () => {
    const { project, record } = runtimeFixture();
    writeManifest(record, "alpha", [{ path: "app.ts" }]);
    const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "1"];
    expect(cli(LOG, args, project).rc).toBe(0);
    appendReviewAppendix(reviewArtifact(record, "alpha"), "1");
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");

    const refused = cli(LOG, [...args, "--verdict", "READY"], project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("workspace source changed after REVIEW_REQUESTED");
    const retryWhileChanged = cli(
      LOG,
      [...args, "--retry-pending"],
      project,
    );
    expect(retryWhileChanged.rc).toBe(1);
    expect(retryWhileChanged.out).toContain(
      "cannot rebaseline source changed while review was pending",
    );
    writeFileSync(join(project, "app.ts"), "export const app = 1;\n");
    expect(cli(LOG, [...args, "--retry-pending"], project).rc).toBe(0);
    expect(cli(LOG, [...args, "--verdict", "READY"], project).rc).toBe(0);
  }, 30000);

  test("REVIEW_COMPLETED refuses source-manifest bytes edited after dispatch", () => {
    const { project, record } = runtimeFixture();
    writeManifest(record, "alpha", [{ path: "app.ts" }]);
    const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "1"];
    expect(cli(LOG, args, project).rc).toBe(0);
    appendReviewAppendix(reviewArtifact(record, "alpha"), "1");
    const path = join(
      record,
      "construction",
      "units",
      "alpha",
      "code-generation",
      "source-manifest.json",
    );
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n`);

    const refused = cli(LOG, [...args, "--verdict", "READY"], project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain(
      "unit source or source-manifest.json changed after REVIEW_REQUESTED",
    );
  }, 30000);

  test("review request refuses an explicitly claimed ignored path without minting a receipt", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(project, "ignored.ts"), "ignored\n");
    writeManifest(record, "alpha", [{ path: "ignored.ts" }]);
    const args = [
      "review",
      "--stage",
      "code-generation",
      "--reviewer",
      REVIEWER,
      "--unit",
      "alpha",
      "--iteration",
      "1",
    ];
    const refused = cli(LOG, args, project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("ignored by Git");
    expect(readAllAuditShards(project)).not.toMatch(
      /\*\*Event\*\*: REVIEW_REQUESTED[\s\S]*?\*\*Unit\*\*: alpha/,
    );
  }, 30000);

  test("3 disjoint unit invalidation names only beta and bounded recovery clears", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "alpha.ts"), "export const a=1\n"); writeFileSync(join(project, "beta.ts"), "export const b=1\n");
    review(project, record, "alpha", [{ path: "alpha.ts" }]); review(project, record, "beta", [{ path: "beta.ts" }]);
    writeFileSync(join(project, "beta.ts"), "export const b=2\n");
    // Refresh the global outer binding with alpha while beta remains stale.
    review(project, record, "alpha", [{ path: "alpha.ts" }]);
    const refused = approve(project); expect(refused.rc).toBe(1); expect(refused.out).toContain("Changed after review: beta"); expect(refused.out).not.toContain("Changed after review: alpha");
    const recovered = review(project, record, "beta", [{ path: "beta.ts" }]); expect(recovered.verdict.rc).toBe(0); expect(approve(project).rc).toBe(0);
  }, 30000);

  test("executable-bit changes invalidate the owning unit after another review refreshes the global binding", () => {
    const { project, record } = runtimeFixture();
    const script = join(project, "script.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o644);
    review(project, record, "alpha", [{ path: "script.sh" }]);
    review(project, record, "beta", []);

    chmodSync(script, 0o755);
    review(project, record, "beta", []);
    const refused = approve(project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("Changed after review: alpha");
  }, 30000);

  test("retargeting a reviewed in-repo symlink invalidates its owning receipt", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "target-a.ts"), "a\n");
    writeFileSync(join(project, "target-b.ts"), "b\n");
    symlinkSync("target-a.ts", join(project, "tracked-link.ts"));
    git(project, ["add", "--", "target-a.ts", "target-b.ts", "tracked-link.ts"]);
    git(project, ["commit", "-qm", "commit tracked symlink and targets"]);
    const alpha = review(
      project,
      record,
      "alpha",
      [{ path: "tracked-link.ts" }, { path: "target-a.ts" }],
    );
    expect(alpha.verdict.rc, alpha.verdict.out).toBe(0);
    rmSync(join(project, "tracked-link.ts"));
    symlinkSync("target-b.ts", join(project, "tracked-link.ts"));
    const beta = review(
      project,
      record,
      "beta",
      [{ path: "target-b.ts" }],
    );
    expect(beta.verdict.rc, beta.verdict.out).toBe(0);
    const refused = approve(project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("Changed after review: alpha");
  }, 30000);

  test("4 newest claimant shields overlap, but a stale newer claimant invalidates both", () => {
    const pass = runtimeFixture(); writeFileSync(join(pass.project, "shared.ts"), "export const s=1\n");
    review(pass.project, pass.record, "alpha", [{ path: "shared.ts" }]); writeFileSync(join(pass.project, "shared.ts"), "export const s=2\n"); review(pass.project, pass.record, "beta", [{ path: "shared.ts" }]); expect(approve(pass.project).rc).toBe(0);
    const fail = runtimeFixture(); writeFileSync(join(fail.project, "shared.ts"), "export const s=1\n");
    review(fail.project, fail.record, "alpha", [{ path: "shared.ts" }]); writeFileSync(join(fail.project, "shared.ts"), "export const s=2\n"); review(fail.project, fail.record, "beta", [{ path: "shared.ts" }]); writeFileSync(join(fail.project, "shared.ts"), "export const s=3\n");
    const r=approve(fail.project); expect(r.rc).toBe(1); expect(r.out).toContain("project source changed after aidlc-architecture-reviewer-agent reviewed it");
    const state=readFileSync(join(fail.record,"aidlc-state.md"),"utf-8"); const receipts=freshReviewReceipts(fail.project,state,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,review_artifact:"code-generation-plan",reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect([...receipts.unitStale].sort()).toEqual(["alpha","beta"]);
  }, 30000);

  test("5 unclaimed add refuses; claim+recovery and revert both clear", () => {
    const claimed = runtimeFixture(); review(claimed.project, claimed.record, "alpha", [{ path: "app.ts" }]); review(claimed.project, claimed.record, "beta", []);
    writeFileSync(join(claimed.project, "extra.ts"), "export const x=1\n"); review(claimed.project, claimed.record, "beta", []);
    expect(approve(claimed.project).out).toContain("Unclaimed source changes fail closed");
    review(claimed.project, claimed.record, "alpha", [{ path: "app.ts" }, { path: "extra.ts" }]); expect(approve(claimed.project).rc).toBe(0);
    const reverted = runtimeFixture(); review(reverted.project, reverted.record, "alpha", [{ path: "app.ts" }]); review(reverted.project, reverted.record, "beta", []);
    writeFileSync(join(reverted.project, "extra.ts"), "export const x=1\n"); review(reverted.project, reverted.record, "beta", []); expect(approve(reverted.project).rc).toBe(1); rmSync(join(reverted.project, "extra.ts")); expect(approve(reverted.project).rc).toBe(0);
  }, 30000);

  test("rejection never launders an unclaimed path into the next attempt baseline", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "evil.ts"), "export const evil = true;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    review(project, record, "beta", []);

    const rejected = cli(
      STATE,
      ["reject", "code-generation", "--feedback", "revise the reviewed work"],
      project,
    );
    expect(rejected.rc, rejected.out).toBe(0);
    expect(
      review(project, record, "alpha", [{ path: "app.ts" }], {}, "1").verdict.rc,
    ).toBe(0);
    expect(review(project, record, "beta", [], {}, "1").verdict.rc).toBe(0);
    const refused = cli(STATE, ["revise", "code-generation"], project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("evil.ts");
    expect(refused.out).toContain("Unclaimed source changes fail closed");
  }, 30000);

  test("6 unit-major ignores late STAGE_STARTED and destroyed baseline fails closed", () => {
    const late = runtimeFixture(); const state=join(late.record,"aidlc-state.md"); writeFileSync(state,readFileSync(state,"utf-8").replace("stage-major","unit-major"));
    writeFileSync(join(late.project,"late.ts"),"export const late=1\n");
    const now=workspaceSourceListing(late.project)!; appendAuditEntry("STAGE_STARTED",{Workflow:"single-stage:code-generation",Stage:"code-generation",Agent:"aidlc-developer-agent","Source Baseline":writeBaselineSourceSnapshot(late.project,"code-generation",now)},late.project);
    const syntheticSecond=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===syntheticSecond){}
    review(late.project,late.record,"alpha",[{path:"app.ts"}]); review(late.project,late.record,"beta",[]); const lateState=readFileSync(state,"utf-8"); const lateReceipts=freshReviewReceipts(late.project,lateState,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,review_artifact:"code-generation-plan",reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect(lateReceipts.sourceBaseline.state).toBe("ready"); if (lateReceipts.sourceBaseline.state === "ready") expect(lateReceipts.sourceBaseline.listing.has("\0late.ts")).toBe(false); expect(approve(late.project).out).toContain("late.ts");
    const destroyed=runtimeFixture(); review(destroyed.project,destroyed.record,"alpha",[{path:"app.ts"}]); review(destroyed.project,destroyed.record,"beta",[]);
    const audit=readAllAuditShards(destroyed.project); const hash=/\*\*Source Baseline\*\*: sha256:([0-9a-f]{64})/.exec(audit)![1]; rmSync(join(destroyed.record,".aidlc-source-review","code-generation",`baseline-${hash.slice(0,12)}.tsv`)); expect(approve(destroyed.project).out).toContain("baseline snapshot is missing");
  }, 30000);

  test("7 manifest tamper and 8 claimed deletion make only the owning unit stale", () => {
    const tamper=runtimeFixture(); review(tamper.project,tamper.record,"alpha",[{path:"app.ts"}]); review(tamper.project,tamper.record,"beta",[]); writeManifest(tamper.record,"alpha",[]); expect(approve(tamper.project).out).toContain("Changed after review: alpha");
    const deleted=runtimeFixture(); writeFileSync(join(deleted.project,"alpha.ts"),"a\n"); review(deleted.project,deleted.record,"alpha",[{path:"alpha.ts"}]); review(deleted.project,deleted.record,"beta",[]); rmSync(join(deleted.project,"alpha.ts")); review(deleted.project,deleted.record,"beta",[]); expect(approve(deleted.project).out).toContain("Changed after review: alpha");
  }, 30000);

  test("9 fieldless per-unit bindings preserve legacy global policy and 11 zero-unit stays manifest-free", () => {
    const legacy=runtimeFixture(); review(legacy.project,legacy.record,"alpha",[{path:"app.ts"}]); review(legacy.project,legacy.record,"beta",[]); stripUnitBindings(legacy.project); expect(approve(legacy.project).rc).toBe(0);
    const zero=runtimeFixture(); rmSync(join(zero.record,"inception"),{recursive:true,force:true});
    const zeroArtifact=reviewArtifact(zero.record); mkdirSync(join(zeroArtifact,".."),{recursive:true}); writeFileSync(zeroArtifact,"# code-generation-plan.md\n");
    const args=["review","--stage","code-generation","--reviewer",REVIEWER,"--iteration","1"]; expect(cli(LOG,args,zero.project).rc).toBe(0); appendReviewAppendix(zeroArtifact,"1"); expect(cli(LOG,[...args,"--verdict","READY"],zero.project).rc).toBe(0); expect(approve(zero.project).rc).toBe(0);
  }, 30000);

  test("missing baseline fields fail closed after modern evidence but pure legacy stays open", () => {
    const modern = runtimeFixture();
    review(modern.project, modern.record, "alpha", [{ path: "app.ts" }]);
    review(modern.project, modern.record, "beta", []);
    stripAuditFields(modern.project, "WORKFLOW_STARTED", ["Source Baseline"]);
    stripAuditFields(modern.project, "STAGE_STARTED", ["Source Baseline"]);
    const modernState = readFileSync(
      join(modern.record, "aidlc-state.md"),
      "utf-8",
    );
    expect(
      freshReviewReceipts(modern.project, modernState, {
        slug: "code-generation",
        phase: "construction",
        for_each: "unit-of-work",
        reviewer: REVIEWER,
        review_artifact: "code-generation-plan",
        reviewer_max_iterations: 2,
        workspace_requires: true,
        produces: [
          "code-generation-plan",
          "unit-test-instructions",
          "code-summary",
          "traceability",
        ],
      }).sourceBaseline.state,
    ).toBe("invalid");
    expect(
      currentStageSourceBaseline(
        modern.project,
        "code-generation",
        false,
      ).state,
    ).toBe("invalid");
    const refused = approve(modern.project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain(
      "inconsistent with other modern source-binding evidence",
    );

    const legacy = runtimeFixture();
    review(legacy.project, legacy.record, "alpha", [{ path: "app.ts" }]);
    review(legacy.project, legacy.record, "beta", []);
    stripAuditFields(legacy.project, "WORKFLOW_STARTED", ["Source Baseline"]);
    stripAuditFields(legacy.project, "STAGE_STARTED", ["Source Baseline"]);
    stripUnitBindings(legacy.project);
    rmSync(
      join(legacy.record, ".aidlc-source-review"),
      { recursive: true, force: true },
    );
    for (const unit of ["alpha", "beta"]) {
      rmSync(
        join(
          legacy.record,
          "construction",
          "units",
          unit,
          "code-generation",
          "source-manifest.json",
        ),
        { force: true },
      );
    }
    const legacyState = readFileSync(
      join(legacy.record, "aidlc-state.md"),
      "utf-8",
    );
    expect(
      freshReviewReceipts(legacy.project, legacyState, {
        slug: "code-generation",
        phase: "construction",
        for_each: "unit-of-work",
        reviewer: REVIEWER,
        review_artifact: "code-generation-plan",
        reviewer_max_iterations: 2,
        workspace_requires: true,
        produces: [
          "code-generation-plan",
          "unit-test-instructions",
          "code-summary",
          "traceability",
        ],
      }).sourceBaseline.state,
    ).toBe("legacy");
    expect(approve(legacy.project).rc).toBe(0);
  }, 30000);

  test("durable source artifacts preserve modernity after whole audit-row deletion and stay intent-scoped", () => {
    const modern = runtimeFixture();
    review(modern.project, modern.record, "alpha", [{ path: "app.ts" }]);
    const modernAudit = join(modern.record, "audit");
    for (const file of readdirSync(modernAudit)) {
      writeFileSync(
        join(modernAudit, file),
        "# AI-DLC Audit Log\n",
      );
    }
    expect(
      currentStageSourceBaseline(
        modern.project,
        "code-generation",
        false,
      ).state,
    ).toBe("invalid");

    const isolated = fixture();
    const other = join(
      isolated.project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "other-intent",
    );
    mkdirSync(
      join(other, ".aidlc-source-review", "code-generation"),
      { recursive: true },
    );
    writeFileSync(
      join(
        other,
        ".aidlc-source-review",
        "code-generation",
        "baseline-deadbeef.tsv",
      ),
      "other\n",
    );
    mkdirSync(
      join(other, "construction", "units", "other", "code-generation"),
      { recursive: true },
    );
    writeFileSync(
      join(
        other,
        "construction",
        "units",
        "other",
        "code-generation",
        "source-manifest.json",
      ),
      "{}\n",
    );
    const otherWorktree = join(
      isolated.project,
      ".aidlc",
      "worktrees",
      "bolt-other",
      ".aidlc",
    );
    mkdirSync(otherWorktree, { recursive: true });
    writeFileSync(
      join(otherWorktree, "worktree-meta.json"),
      `${JSON.stringify({
        version: 1,
        boltSlug: "other",
        baseCommit: "a".repeat(40),
        baseSourceListing: `sha256:${"b".repeat(64)}`,
        intentRecord:
          "aidlc/spaces/default/intents/other-intent",
      })}\n`,
    );
    expect(
      currentStageSourceBaseline(
        isolated.project,
        "code-generation",
        false,
        "fixture-intent",
      ).state,
    ).toBe("legacy");
    const matchingMeta = join(otherWorktree, "worktree-meta.json");
    writeFileSync(
      matchingMeta,
      readFileSync(matchingMeta, "utf-8").replace(
        "aidlc/spaces/default/intents/other-intent",
        "aidlc/spaces/default/intents/fixture-intent",
      ),
    );
    expect(
      currentStageSourceBaseline(
        isolated.project,
        "code-generation",
        false,
        "fixture-intent",
      ).state,
    ).toBe("invalid");
  }, 30000);

  test("cross-shard baseline ties accept identical values and refuse differing values", () => {
    const stage = {
      slug: "code-generation",
      phase: "construction",
      for_each: "unit-of-work",
      reviewer: REVIEWER,
      review_artifact: "code-generation-plan",
      reviewer_max_iterations: 2,
      workspace_requires: true,
      produces: [
        "code-generation-plan",
        "unit-test-instructions",
        "code-summary",
        "traceability",
      ],
    };
    const timestamp = "2026-08-22T12:00:00Z";
    const writeTiedRows = (
      record: string,
      baseline?: string,
      secondBaseline = baseline,
    ): void => {
      const auditDir = join(record, "audit");
      mkdirSync(auditDir, { recursive: true });
      const firstBaselineLine =
        baseline === undefined ? "" : `**Source Baseline**: ${baseline}\n`;
      const secondBaselineLine =
        secondBaseline === undefined
          ? ""
          : `**Source Baseline**: ${secondBaseline}\n`;
      writeFileSync(
        join(auditDir, "a.md"),
        [
          "# AI-DLC Audit Log",
          "## Workflow Start",
          `**Timestamp**: ${timestamp}`,
          "**Event**: WORKFLOW_STARTED",
          "**Scope**: feature",
          firstBaselineLine.trimEnd(),
          "",
          "---",
          "",
        ].filter((line, index, rows) =>
          line !== "" || rows[index - 1] !== ""
        ).join("\n"),
      );
      writeFileSync(
        join(auditDir, "b.md"),
        [
          "# AI-DLC Audit Log",
          "## Stage Start",
          `**Timestamp**: ${timestamp}`,
          "**Event**: STAGE_STARTED",
          "**Stage**: code-generation",
          "**Agent**: aidlc-developer-agent",
          secondBaselineLine.trimEnd(),
          "",
          "---",
          "",
        ].filter((line, index, rows) =>
          line !== "" || rows[index - 1] !== ""
        ).join("\n"),
      );
    };

    const legacy = fixture();
    writeTiedRows(legacy.record);
    const legacyState = readFileSync(
      join(legacy.record, "aidlc-state.md"),
      "utf-8",
    );
    expect(
      freshReviewReceipts(
        legacy.project,
        legacyState,
        stage,
      ).sourceBaseline.state,
    ).toBe("legacy");
    expect(
      currentStageSourceBaseline(
        legacy.project,
        "code-generation",
        false,
      ).state,
    ).toBe("legacy");

    const modern = fixture();
    const listing = workspaceSourceListing(modern.project);
    expect(listing).not.toBeNull();
    if (listing === null) return;
    const baseline = writeBaselineSourceSnapshot(
      modern.project,
      "code-generation",
      listing,
    );
    writeTiedRows(modern.record, baseline);
    const modernState = readFileSync(
      join(modern.record, "aidlc-state.md"),
      "utf-8",
    );
    expect(
      freshReviewReceipts(
        modern.project,
        modernState,
        stage,
      ).sourceBaseline.state,
    ).toBe("ready");
    expect(
      currentStageSourceBaseline(
        modern.project,
        "code-generation",
        false,
      ).state,
    ).toBe("ready");

    const differing = fixture();
    const differingListing = workspaceSourceListing(differing.project);
    expect(differingListing).not.toBeNull();
    if (differingListing === null) return;
    const firstBaseline = writeBaselineSourceSnapshot(
      differing.project,
      "code-generation",
      differingListing,
    );
    writeFileSync(
      join(differing.project, "different.ts"),
      "different\n",
    );
    const changedListing = workspaceSourceListing(differing.project);
    expect(changedListing).not.toBeNull();
    if (changedListing === null) return;
    const secondBaseline = writeBaselineSourceSnapshot(
      differing.project,
      "code-generation",
      changedListing,
    );
    writeTiedRows(differing.record, firstBaseline, secondBaseline);
    const differingState = readFileSync(
      join(differing.record, "aidlc-state.md"),
      "utf-8",
    );
    expect(
      freshReviewReceipts(
        differing.project,
        differingState,
        stage,
      ).sourceBaseline.state,
    ).toBe("unbindable");
    expect(
      currentStageSourceBaseline(
        differing.project,
        "code-generation",
        false,
      ).state,
    ).toBe("unbindable");

    const writeJumpTie = (
      record: string,
      baseline: string,
      foreignBaseline: string,
    ): void => {
      const auditDir = join(record, "audit");
      mkdirSync(auditDir, { recursive: true });
      const timestamp = "2026-08-22T12:30:00Z";
      const writeBoundary = (
        file: string,
        event: "STAGE_JUMPED" | "STAGE_STARTED" | "WORKFLOW_STARTED",
        value: string,
      ) => {
        writeFileSync(
          join(auditDir, file),
          [
            "# AI-DLC Audit Log",
            "## Boundary",
            `**Timestamp**: ${timestamp}`,
            `**Event**: ${event}`,
            ...(event === "STAGE_STARTED"
              ? [
                  "**Stage**: code-generation",
                  "**Agent**: aidlc-developer-agent",
                ]
              : event === "STAGE_JUMPED"
                ? ["**Target**: code-generation"]
                : ["**Scope**: feature"]),
            `**Source Baseline**: ${value}`,
            "",
            "---",
            "",
          ].join("\n"),
        );
      };
      writeBoundary("a.md", "STAGE_JUMPED", baseline);
      writeBoundary("b.md", "STAGE_STARTED", baseline);
      writeBoundary("c.md", "WORKFLOW_STARTED", foreignBaseline);
    };

    const sameJump = fixture();
    const sameJumpListing = workspaceSourceListing(sameJump.project);
    expect(sameJumpListing).not.toBeNull();
    if (sameJumpListing === null) return;
    const sameJumpBaseline = writeBaselineSourceSnapshot(
      sameJump.project,
      "code-generation",
      sameJumpListing,
    );
    writeJumpTie(
      sameJump.record,
      sameJumpBaseline,
      sameJumpBaseline,
    );
    const sameJumpState = readFileSync(
      join(sameJump.record, "aidlc-state.md"),
      "utf-8",
    );
    expect(
      freshReviewReceipts(
        sameJump.project,
        sameJumpState,
        stage,
      ).sourceBaseline.state,
    ).toBe("ready");
    expect(
      currentStageSourceBaseline(
        sameJump.project,
        "code-generation",
        false,
      ).state,
    ).toBe("ready");

    const differingJump = fixture();
    const differingJumpListing = workspaceSourceListing(
      differingJump.project,
    );
    expect(differingJumpListing).not.toBeNull();
    if (differingJumpListing === null) return;
    const jumpBaseline = writeBaselineSourceSnapshot(
      differingJump.project,
      "code-generation",
      differingJumpListing,
    );
    writeFileSync(join(differingJump.project, "jump-different.ts"), "x\n");
    const differingJumpChanged = workspaceSourceListing(
      differingJump.project,
    );
    expect(differingJumpChanged).not.toBeNull();
    if (differingJumpChanged === null) return;
    const foreignBaseline = writeBaselineSourceSnapshot(
      differingJump.project,
      "code-generation",
      differingJumpChanged,
    );
    writeJumpTie(
      differingJump.record,
      jumpBaseline,
      foreignBaseline,
    );
    const differingJumpState = readFileSync(
      join(differingJump.record, "aidlc-state.md"),
      "utf-8",
    );
    expect(
      freshReviewReceipts(
        differingJump.project,
        differingJumpState,
        stage,
      ).sourceBaseline.state,
    ).toBe("unbindable");
    expect(
      currentStageSourceBaseline(
        differingJump.project,
        "code-generation",
        false,
      ).state,
    ).toBe("unbindable");
  }, 30000);

  test("shrinking the live DAG cannot erase current-attempt swarm obligations", () => {
    const project = swarmFixture();
    const alpha = { name: "alpha", dependsOn: [] };
    const beta = { name: "beta", dependsOn: ["alpha"] };
    seedBoltDag(
      project,
      [
        { name: alpha.name, depends_on: alpha.dependsOn },
        { name: beta.name, depends_on: beta.dependsOn },
      ],
      [["alpha"], ["beta"]],
    );
    writeAuthoredDag(project, [alpha, beta]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "alpha",
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);
    expect(readAllAuditShards(project)).toContain(
      "**Unit obligations**: alpha,beta",
    );
    const wt = join(project, ".aidlc", "worktrees", "bolt-alpha");
    writeFileSync(join(wt, "alpha.ts"), "export const alpha = true;\n");
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      "alpha",
      [{ path: "alpha.ts" }],
    );
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "alpha",
      "--claimed",
      "alpha",
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('alpha.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);
    const merged = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        "alpha",
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    expect(merged.status, `${merged.stdout ?? ""}${merged.stderr ?? ""}`)
      .toBe(0);

    writeAuthoredDag(project, [alpha]);
    const statePath = seededStateFile(project);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8")
        .replace(
          "- **Construction Autonomy Mode**: gated",
          "- **Construction Autonomy Mode**: autonomous",
        )
        .replace("- [-] code-generation", "- [?] code-generation"),
    );
    const refused = approve(project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("missing attempt Units: beta");
    expect(refused.out).toContain(
      "Restore unit-of-work-dependency.md to the attempt-bound Unit set or restart the stage attempt",
    );
    expect(readAllAuditShards(project)).not.toContain(
      "**Event**: STAGE_COMPLETED",
    );
  }, 120000);

  test("uniformly fieldless swarm starts migrate open while mixed starts refuse", () => {
    const legacy = swarmFixture();
    const legacyUnit = "legacy-obligations";
    seedBoltDag(legacy, [legacyUnit]);
    const legacyFloor = latestMainWorkflowStageRunFloorForProject(
      legacy,
      "code-generation",
    );
    appendAuditEntry(
      "SWARM_STARTED",
      {
        "Batch number": "1",
        "Unit names": legacyUnit,
        "Concurrency cap": "1",
        Stage: "code-generation",
        "Run floor": legacyFloor,
      },
      legacy,
    );
    appendAuditEntry(
      "SWARM_UNIT_CONVERGED",
      {
        "Batch number": "1",
        "Unit name": legacyUnit,
        Stage: "code-generation",
        "Run floor": legacyFloor,
      },
      legacy,
    );
    expect(
      currentSwarmAttemptObligations(
        legacy,
        "code-generation",
      ).state,
    ).toBe("none");
    const legacyStatePath = seededStateFile(legacy);
    writeFileSync(
      legacyStatePath,
      readFileSync(legacyStatePath, "utf-8")
        .replace(
          "- **Construction Autonomy Mode**: gated",
          "- **Construction Autonomy Mode**: autonomous",
        )
        .replace("- [-] code-generation", "- [?] code-generation"),
    );
    const approved = approve(legacy, {
      AIDLC_SKIP_SOURCE_FRESHNESS: "1",
    });
    expect(approved.rc, approved.out).toBe(0);
    expect(readAllAuditShards(legacy)).toContain(
      "**Event**: STAGE_COMPLETED",
    );

    const stripped = swarmFixture();
    const strippedUnit = "stripped-obligations";
    seedBoltDag(stripped, [strippedUnit]);
    const strippedFloor = latestMainWorkflowStageRunFloorForProject(
      stripped,
      "code-generation",
    );
    appendAuditEntry(
      "SWARM_STARTED",
      {
        "Batch number": "1",
        "Unit names": strippedUnit,
        "Unit obligations": strippedUnit,
        "Concurrency cap": "1",
        Stage: "code-generation",
        "Run floor": strippedFloor,
      },
      stripped,
    );
    appendAuditEntry(
      "SWARM_UNIT_CONVERGED",
      {
        "Batch number": "1",
        "Unit name": strippedUnit,
        Stage: "code-generation",
        "Run floor": strippedFloor,
        "Source Fingerprint": "a".repeat(40),
        "Source Commit": "b".repeat(40),
      },
      stripped,
    );
    appendAuditEntry(
      "SWARM_SOURCE_MERGED",
      {
        "Batch number": "1",
        "Unit name": strippedUnit,
        Stage: "code-generation",
        "Run floor": strippedFloor,
        "Previous Source Fingerprint": "c".repeat(40),
        "Source Fingerprint": "d".repeat(40),
        "Source Commit": "b".repeat(40),
        "Merge commit": "e".repeat(40),
      },
      stripped,
    );
    stripAuditFields(stripped, "SWARM_STARTED", ["Unit obligations"]);
    const strippedObligations = currentSwarmAttemptObligations(
      stripped,
      "code-generation",
    );
    expect(strippedObligations.state).toBe("invalid");
    if (strippedObligations.state === "invalid") {
      expect(strippedObligations.reason).toContain(
        "modern current-attempt swarm evidence exists without SWARM_STARTED Unit obligations",
      );
    }

    const mixed = swarmFixture();
    const mixedUnit = "mixed-obligations";
    seedBoltDag(mixed, [mixedUnit]);
    const mixedPrepared = runSwarm(mixed, [
      "prepare",
      "--batch",
      "1",
      "--units",
      mixedUnit,
      "--base",
      "main",
    ]);
    expect(mixedPrepared.rc, mixedPrepared.out).toBe(0);
    appendAuditEntry(
      "SWARM_STARTED",
      {
        "Batch number": "2",
        "Unit names": mixedUnit,
        "Concurrency cap": "1",
        Stage: "code-generation",
        "Run floor": latestMainWorkflowStageRunFloorForProject(
          mixed,
          "code-generation",
        ),
      },
      mixed,
    );
    expect(
      currentSwarmAttemptObligations(
        mixed,
        "code-generation",
      ).state,
    ).toBe("invalid");
    const mixedStatePath = seededStateFile(mixed);
    writeFileSync(
      mixedStatePath,
      readFileSync(mixedStatePath, "utf-8").replace(
        "- **Construction Autonomy Mode**: gated",
        "- **Construction Autonomy Mode**: autonomous",
      ),
    );
    const refused = cli(
      STATE,
      ["gate-start", "code-generation"],
      mixed,
    );
    expect(refused.rc).toBe(1);
    const refusal = JSON.parse(refused.out) as { error: string };
    expect(refusal.error).toContain(
      'Cannot present "code-generation" for approval',
    );
    expect(refusal.error).toContain(
      "mixes fieldless and field-bearing Unit obligations",
    );
    expect(refusal.error).not.toContain(
      "settled-swarm probe failed unexpectedly",
    );
    expect(readFileSync(mixedStatePath, "utf-8")).toContain(
      "- [-] code-generation",
    );
  }, 120000);

  test("12 two recorded repos invalidate only the owning repo and unit", () => {
    const base=runtimeFixture(); const project=base.project; const record=base.record; rmSync(join(project,".git"),{recursive:true,force:true}); for (const repo of ["repo-a","repo-b"]) { const path=join(project,repo); mkdirSync(path,{recursive:true}); git(path,["init","-q"]); git(path,["config","user.email","t@test"]); git(path,["config","user.name","t"]); writeFileSync(join(path,`${repo}.ts`),`export const ${repo.replace(/-/g,"_")}=1\n`); git(path,["add","-A"]); git(path,["commit","-qm","seed"]); } const registry=join(project,"aidlc","spaces","default","intents","intents.json"); const rows=JSON.parse(readFileSync(registry,"utf-8")); rows[0].repos=["repo-a","repo-b"]; writeFileSync(registry,`${JSON.stringify(rows)}\n`); const initial=workspaceSourceListing(project)!; appendAuditEntry("STAGE_JUMPED",{Target:"code-generation","Source Baseline":writeBaselineSourceSnapshot(project,"code-generation",initial)},project); const multiBoundary=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===multiBoundary){}
    review(project,record,"alpha",[{repo:"repo-a",path:"repo-a.ts"}]); review(project,record,"beta",[{repo:"repo-b",path:"repo-b.ts"}]); writeFileSync(join(project,"repo-b","repo-b.ts"),"export const repo_b=2\n"); review(project,record,"alpha",[{repo:"repo-a",path:"repo-a.ts"}]); const r=approve(project); expect(r.out).toContain("Changed after review: beta"); expect(r.out).not.toContain("Changed after review: alpha");
  }, 30000);

  test("absent exact claim becomes stale when the path appears before an unrelated review", () => {
    const {project,record}=runtimeFixture(); review(project,record,"alpha",[{path:"future.ts"}]); writeFileSync(join(project,"future.ts"),"future\n"); review(project,record,"beta",[{path:"app.ts"}]); expect(approve(project).out).toContain("Changed after review: alpha");
  }, 30000);

  test("ghost/non-applicable units cannot mint review authority or cover unclaimed source", () => {
    const {project,record}=runtimeFixture();
    review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]);
    writeFileSync(join(project,"extra.ts"),"extra\n");
    writeManifest(record,"ghost",[{path:"extra.ts"}]);
    const ghost=cli(LOG,["review","--stage","code-generation","--reviewer",REVIEWER,"--unit","ghost","--iteration","1"],project);
    expect(ghost.rc).toBe(1); expect(ghost.out).toContain("not present in the authoritative unit DAG");
    const forgedState=readFileSync(join(record,"aidlc-state.md"),"utf-8");
    const receipts=freshReviewReceipts(project,forgedState,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,review_artifact:"code-generation-plan",reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]});
    expect(receipts.freshUnitClaims.has("ghost")).toBe(false);
  }, 30000);

  test("stage-major selects the tighter STAGE_STARTED baseline", () => {
    const {project,record}=runtimeFixture();
    // Replace the fixture's equal workflow/stage snapshots with a workflow
    // baseline, a pre-stage source addition, and a tighter stage baseline.
    const auditDir=join(record,"audit"); rmSync(auditDir,{recursive:true,force:true}); mkdirSync(auditDir,{recursive:true});
    const workflow=writeBaselineSourceSnapshot(project,"code-generation",workspaceSourceListing(project)!);
    appendAuditEntry("WORKFLOW_STARTED",{Scope:"feature","Source Baseline":workflow},project);
    writeFileSync(join(project,"prestage.ts"),"pre\n");
    const stageBaseline=writeBaselineSourceSnapshot(project,"code-generation",workspaceSourceListing(project)!);
    appendAuditEntry("STAGE_STARTED",{Stage:"code-generation",Agent:"aidlc-developer-agent","Source Baseline":stageBaseline},project);
    const second=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===second){}
    writeFileSync(join(project,"later.ts"),"later\n"); review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]);
    const out=approve(project).out; expect(out).toContain("later.ts"); expect(out).not.toContain("prestage.ts");
  }, 30000);

  test("an empty modern baseline still exposes source created after Git initialization", () => {
    const { project, record } = runtimeFixture();
    rmSync(join(project, ".git"), { recursive: true, force: true });
    const auditDir = join(record, "audit");
    rmSync(auditDir, { recursive: true, force: true });
    mkdirSync(auditDir, { recursive: true });
    const emptyBaseline = writeBaselineSourceSnapshot(
      project,
      "code-generation",
      new Map(),
    );
    appendAuditEntry("WORKFLOW_STARTED", {
      Scope: "feature",
      "Source Baseline": emptyBaseline,
    }, project);
    const boundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === boundarySecond) {}

    git(project, ["init", "-q"]);
    git(project, ["config", "user.email", "t@test"]);
    git(project, ["config", "user.name", "t"]);
    writeFileSync(join(project, "claimed.ts"), "claimed\n");
    writeFileSync(join(project, "unclaimed.ts"), "unclaimed\n");
    const alpha = review(project, record, "alpha", [{ path: "claimed.ts" }]);
    expect(alpha.verdict.rc, alpha.verdict.out).toBe(0);
    const beta = review(project, record, "beta", []);
    expect(beta.verdict.rc, beta.verdict.out).toBe(0);

    const refused = approve(project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("unclaimed.ts");
  }, 30000);

  test("calls freshReviewReceipts directly for a modern unit chain", () => {
    const {project,record}=runtimeFixture(); review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]); const state=readFileSync(join(record,"aidlc-state.md"),"utf-8"); const receipts=freshReviewReceipts(project,state,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,review_artifact:"code-generation-plan",reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect(receipts.unitVerdicts.size).toBe(2);
  }, 30000);
});

describe("t305 healthy settled-swarm source completion", () => {
  test("one reviewed source merge forms a ready chain and approves without a freshness bypass", () => {
    const project = swarmFixture();
    const unit = "healthy-one";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);

    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(join(wt, source), "export const healthy = true;\n");
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);
    const merged = mergeSwarmUnit(project, unit);
    expect(merged.rc, merged.out).toBe(0);
    expect(
      (readAllAuditShards(project).match(
        /\*\*Event\*\*: SWARM_SOURCE_MERGED/g,
      ) ?? []).length,
    ).toBe(1);
    const chain = currentSwarmSourceMergeChain(
      project,
      "code-generation",
    );
    expect(chain.state).toBe("ready");
    if (chain.state === "ready") {
      expect([...chain.units]).toEqual([unit]);
      const current = workspaceSourceState(project);
      expect(current).not.toBeNull();
      if (current !== null) {
        expect(chain.fingerprint).toBe(current.fingerprint);
      }
    }

    const statePath = seededStateFile(project);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8")
        .replace(
          "- **Construction Autonomy Mode**: gated",
          "- **Construction Autonomy Mode**: autonomous",
        )
        .replace("- [-] code-generation", "- [?] code-generation"),
    );
    expect(process.env.AIDLC_SKIP_SOURCE_FRESHNESS).not.toBe("1");
    const approved = approve(project);
    expect(approved.rc, approved.out).toBe(0);
    expect(readAllAuditShards(project)).toContain(
      "**Event**: STAGE_COMPLETED",
    );
  }, 120000);

  for (const mergeMode of ["default", "union"] as const) {
    test(`two reviewed Units can merge non-overlapping shared-file edits with the ${mergeMode} text driver and approve`, () => {
    const baseLines = Array.from(
      { length: 40 },
      (_, index) => `export const line${index} = ${index};`,
    );
    const project = swarmFixture((root) => {
      writeFileSync(join(root, "shared.ts"), `${baseLines.join("\n")}\n`);
      if (mergeMode === "union") {
        writeFileSync(join(root, ".gitattributes"), "shared.ts merge=union\n");
      }
    });
    const units = ["alpha", "beta"];
    seedBoltDag(
      project,
      units.map((name) => ({ name, depends_on: [] })),
      [units],
    );
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      units.join(","),
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);

    for (const [unit, index, value] of [
      ["alpha", 0, "export const alphaOwned = true;"],
      ["beta", 39, "export const betaOwned = true;"],
    ] as Array<[string, number, string]>) {
      const wt = join(
        project,
        ".aidlc",
        "worktrees",
        `bolt-${unit}`,
      );
      const lines = [...baseLines];
      lines[index] = value;
      writeFileSync(join(wt, "shared.ts"), `${lines.join("\n")}\n`);
      const reviewed = review(
        wt,
        seededRecordDir(wt),
        unit,
        [{ path: "shared.ts" }],
      );
      expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    }
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      units.join(","),
      "--claimed",
      units.join(","),
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('shared.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const alphaMerge = mergeSwarmUnit(project, "alpha");
    expect(alphaMerge.rc, alphaMerge.out).toBe(0);
    const alphaChain = currentSwarmSourceMergeChain(
      project,
      "code-generation",
    );
    expect(alphaChain.state).toBe("ready");
    if (alphaChain.state === "ready") {
      expect([...alphaChain.units]).toEqual(["alpha"]);
    }

    const betaMerge = mergeSwarmUnit(project, "beta");
    expect(betaMerge.rc, betaMerge.out).toBe(0);
    const audit = readAllAuditShards(project);
    expect(
      (audit.match(/\*\*Event\*\*: SWARM_SOURCE_MERGED/g) ?? []).length,
    ).toBe(2);
    const chain = currentSwarmSourceMergeChain(
      project,
      "code-generation",
    );
    expect(chain.state).toBe("ready");
    if (chain.state === "ready") {
      expect([...chain.units].sort()).toEqual(units);
      const current = workspaceSourceState(project);
      expect(current).not.toBeNull();
      if (current !== null) {
        expect(chain.fingerprint).toBe(current.fingerprint);
      }
    }
    const shared = readFileSync(join(project, "shared.ts"), "utf-8");
    expect(shared).toContain("alphaOwned");
    expect(shared).toContain("betaOwned");

    const statePath = seededStateFile(project);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8")
        .replace(
          "- **Construction Autonomy Mode**: gated",
          "- **Construction Autonomy Mode**: autonomous",
        )
        .replace("- [-] code-generation", "- [?] code-generation"),
    );
    expect(process.env.AIDLC_SKIP_SOURCE_FRESHNESS).not.toBe("1");
    const approved = approve(project);
    expect(approved.rc, approved.out).toBe(0);
    expect(readAllAuditShards(project)).toContain(
      "**Event**: STAGE_COMPLETED",
    );
    }, 120000);
  }

  for (const driverCase of [
    { attributeName: "evil", configName: "evil", unit: "driver-guard-evil" },
    { attributeName: "set", configName: "set", unit: "driver-guard-set" },
    { attributeName: "unset", configName: "unset", unit: "driver-guard-unset" },
    {
      attributeName: "unspecified",
      configName: "unspecified",
      unit: "driver-guard-unspecified",
    },
    {
      attributeName: "evil",
      configName: "my driver",
      unit: "driver-guard-spaced",
    },
  ]) {
    test(`configured merge driver ${JSON.stringify(driverCase.configName)} is refused before main mutation`, () => {
    const project = swarmFixture((root) => {
      writeFileSync(join(root, "driver-target.ts"), "export const base = true;\n");
      writeFileSync(
        join(root, ".gitattributes"),
        `driver-target.ts merge=${driverCase.attributeName}\n`,
      );
    });
    const driverDir = mkdtempSync(join(tmpdir(), "aidlc-merge-driver-"));
    dirs.push(driverDir);
    const driver = join(driverDir, "evil-merge.sh");
    const marker = join(driverDir, "evil-driver-ran");
    writeFileSync(
      driver,
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '%s\\n' 'export const BACKDOOR = true;' > "$1"\n`,
    );
    chmodSync(driver, 0o755);
    git(project, [
      "config",
      `merge.${driverCase.configName}.driver`,
      `${driver} %A %O %B`,
    ]);
    const unit = driverCase.unit;
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);
    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    writeFileSync(
      join(wt, "driver-target.ts"),
      "export const reviewed = true;\n",
    );
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: "driver-target.ts" }],
    );
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('driver-target.ts')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);
    const before = spawnSync(
      "git",
      ["-C", project, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    const merged = mergeSwarmUnit(project, unit);
    expect(merged.rc).toBe(1);
    expect(merged.out).toContain(
      `merge.${driverCase.configName}.driver`,
    );
    expect(merged.out).toContain("remove the merge.<name>.driver configuration");
    expect(merged.out).toContain("AIDLC_SKIP_SOURCE_FRESHNESS=1");
    expect(merged.out).not.toContain("[merge-succeeded:");
    expect(existsSync(marker)).toBe(false);
    expect(
      spawnSync("git", ["-C", project, "rev-parse", "HEAD"], {
        encoding: "utf-8",
      }).stdout.trim(),
    ).toBe(before);
    expect(existsSync(wt)).toBe(true);
    }, 120000);
  }
});

describe("t305 post-merge source authority failure", () => {
  test("historical source authority does not block a reused Unit in a later attempt", () => {
    const project = swarmFixture();
    const unit = "reused-unit";
    const source = `${unit}.ts`;
    seedBoltDag(project, [unit]);

    const runCycle = (batch: string, value: string): void => {
      const prepared = runSwarm(project, [
        "prepare",
        "--batch",
        batch,
        "--units",
        unit,
        "--base",
        "main",
      ]);
      expect(prepared.rc, prepared.out).toBe(0);
      const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
      writeFileSync(join(wt, source), `export const value = ${JSON.stringify(value)};\n`);
      const reviewed = review(
        wt,
        seededRecordDir(wt),
        unit,
        [{ path: source }],
        {},
        "1",
      );
      expect(reviewed.request.rc, reviewed.request.out).toBe(0);
      expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
      const finalized = runSwarm(project, [
        "finalize",
        "--batch",
        batch,
        "--units",
        unit,
        "--claimed",
        unit,
        "--check-cmd",
        `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
      ]);
      expect(finalized.rc, finalized.out).toBe(0);
      const merged = spawnSync(
        process.execPath,
        [
          WORKTREE,
          "merge",
          "--slug",
          unit,
          "--target",
          "main",
          "--strategy",
          "squash",
          "--project-dir",
          project,
        ],
        { cwd: project, encoding: "utf-8" },
      );
      expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
    };

    runCycle("1", "first");
    const firstChain = currentSwarmSourceMergeChain(project, "code-generation");
    if (firstChain.state !== "ready") {
      throw new Error("first source merge did not form a ready chain");
    }
    appendAuditEntry(
      "GATE_REJECTED",
      {
        Stage: "code-generation",
        Feedback: "repeat",
        "Prior Accepted Source Fingerprint": firstChain.fingerprint,
      },
      project,
    );
    runCycle("2", "second");
    expect(readFileSync(join(project, source), "utf-8")).toContain("second");
  }, 120000);

  test("a post-authority branch cleanup failure is idempotently reconcilable", () => {
    const project = swarmFixture();
    const unit = "cleanup-retry";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);
    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(join(wt, source), "export const cleanupRetry = true;\n");
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.request.rc, reviewed.request.out).toBe(0);
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const marker = join(project, ".aidlc", "cleanup-branch-blocked");
    const hook = join(project, ".git", "hooks", "reference-transaction");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        '[ "$1" = "prepared" ] || exit 0',
        "while read old new ref; do",
        `  if [ "$ref" = "refs/heads/bolt-${unit}" ]; then`,
        '    case "$new" in',
        "      000000*)",
        `        if [ ! -e "${marker}" ]; then`,
        `          touch "${marker}"`,
        "          exit 1",
        "        fi",
        "        ;;",
        "    esac",
        "  fi",
        "done",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);

    const first = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        unit,
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    const firstOutput = `${first.stdout ?? ""}${first.stderr ?? ""}`;
    expect(first.status).not.toBe(0);
    expect(firstOutput).toContain("[merge-succeeded:");
    expect(firstOutput).toContain(`branch -D bolt-${unit} failed`);
    expect(existsSync(join(project, source))).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(readAllAuditShards(project).match(/\*\*Event\*\*: SWARM_SOURCE_MERGED/g))
      .toHaveLength(1);

    const authorityBlocks = readAllAuditShards(project)
      .split(/\n---\n/)
      .filter(
        (block) =>
          block.includes(`**Unit name**: ${unit}`) &&
          (
            block.includes("**Event**: SWARM_UNIT_CONVERGED") ||
            block.includes("**Event**: SWARM_SOURCE_MERGED")
          ),
      );
    const decoyAudit = join(
      project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "cleanup-decoy",
      "audit",
    );
    mkdirSync(decoyAudit, { recursive: true });
    writeFileSync(
      join(decoyAudit, "decoy.md"),
      `# AI-DLC Audit Log\n${authorityBlocks.join("\n---\n")}\n---\n`,
    );
    const ambiguous = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        unit,
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    expect(ambiguous.status).not.toBe(0);
    expect(`${ambiguous.stdout}${ambiguous.stderr}`).toContain(
      "multiple durable SWARM_SOURCE_MERGED authorities",
    );

    appendAuditEntry(
      "STAGE_STARTED",
      { Stage: "code-generation", Agent: "aidlc-developer-agent" },
      project,
    );
    const originalIntent = basename(seededRecordDir(project));
    const headAfterLanding = spawnSync(
      "git",
      ["-C", project, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    const retried = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        unit,
        "--target",
        "main",
        "--strategy",
        "squash",
        "--space",
        "default",
        "--intent",
        originalIntent,
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    expect(retried.status, `${retried.stdout ?? ""}${retried.stderr ?? ""}`).toBe(0);
    expect(retried.stdout).toContain('"cleanup_reconciled":true');
    expect(
      spawnSync("git", ["-C", project, "rev-parse", "HEAD"], {
        encoding: "utf-8",
      }).stdout.trim(),
    ).toBe(headAfterLanding);
    expect(
      spawnSync(
        "git",
        ["-C", project, "show-ref", "--verify", "--quiet", `refs/heads/bolt-${unit}`],
        { encoding: "utf-8" },
      ).status,
    ).toBe(1);
    expect(readAllAuditShards(project).match(/\*\*Event\*\*: SWARM_SOURCE_MERGED/g))
      .toHaveLength(1);
  }, 120000);

  test("durable modern worktree evidence prevents field-deletion branch fallback", () => {
    const project = swarmFixture();
    const unit = "modern-downgrade";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);
    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(join(wt, source), "export const reviewed = true;\n");
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.request.rc, reviewed.request.out).toBe(0);
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    writeFileSync(join(wt, "unreviewed.ts"), "export const unreviewed = true;\n");
    git(wt, ["add", "--", "unreviewed.ts"]);
    git(wt, ["commit", "-qm", "advance movable branch"]);
    stripAuditFields(project, "WORKTREE_CREATED", [
      "Base commit",
      "Base Source Listing",
    ]);
    stripAuditFields(project, "SWARM_STARTED", ["Stage", "Run floor"]);
    const before = spawnSync("git", ["-C", project, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    const merged = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        unit,
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    const output = `${merged.stdout ?? ""}${merged.stderr ?? ""}`;
    expect(merged.status).not.toBe(0);
    expect(output).toContain("durable modern worktree evidence is inconsistent");
    expect(output).not.toContain("[merge-succeeded:");
    expect(
      spawnSync("git", ["-C", project, "rev-parse", "HEAD"], {
        encoding: "utf-8",
      }).stdout.trim(),
    ).toBe(before);
    expect(existsSync(join(project, source))).toBe(false);
    expect(existsSync(join(project, "unreviewed.ts"))).toBe(false);
  }, 120000);

  test("a post-merge hook cannot stage unrelated source into aggregate authority", () => {
    const project = swarmFixture();
    const unit = "merge-interleave";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);

    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(join(wt, source), "export const reviewed = true;\n");
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.request.rc, reviewed.request.out).toBe(0);
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const hook = join(project, ".git", "hooks", "post-merge");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        "printf '%s\\n' 'export const unreviewed = true;' > merge-interleaved.ts",
        "git add -- merge-interleaved.ts",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const merged = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        unit,
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    const output = `${merged.stdout ?? ""}${merged.stderr ?? ""}`;
    expect(merged.status, output).toBe(0);
    expect(output).not.toContain("[merge-succeeded:");
    expect(existsSync(join(project, source))).toBe(true);
    expect(existsSync(join(project, "merge-interleaved.ts"))).toBe(false);
    expect(existsSync(wt)).toBe(false);
    expect(readAllAuditShards(project)).toContain(
      "**Event**: SWARM_SOURCE_MERGED",
    );
  }, 120000);

  test("a post-merge hook cannot replace the reviewed source path", () => {
    const project = swarmFixture();
    const unit = "merge-interleave-same-path";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);

    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(join(wt, source), "export const reviewed = true;\n");
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.request.rc, reviewed.request.out).toBe(0);
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const hook = join(project, ".git", "hooks", "post-merge");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        `printf '%s\\n' 'export const tampered = true;' >> ${source}`,
        `git add -- ${source}`,
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const merged = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        unit,
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    const output = `${merged.stdout ?? ""}${merged.stderr ?? ""}`;
    expect(merged.status, output).toBe(0);
    expect(output).not.toContain("[merge-succeeded:");
    expect(readFileSync(join(project, source), "utf-8")).toBe(
      "export const reviewed = true;\n",
    );
    expect(existsSync(wt)).toBe(false);
    expect(readAllAuditShards(project)).toContain(
      "**Event**: SWARM_SOURCE_MERGED",
    );
  }, 120000);

  test("a post-commit hook cannot create a second source commit", () => {
    const project = swarmFixture();
    const unit = "merge-second-commit";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);

    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(join(wt, source), "export const reviewed = true;\n");
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const hook = join(project, ".git", "hooks", "post-commit");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        'marker="$(git rev-parse --git-dir)/aidlc-second-commit"',
        'if [ -e "$marker" ]; then exit 0; fi',
        'touch "$marker"',
        "printf '%s\\n' 'export const injected = true;' > hook-commit.ts",
        "git add -- hook-commit.ts",
        "git -c user.name=hook -c user.email=hook@test commit --no-verify -m hook-commit >/dev/null 2>&1",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const merged = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        unit,
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    const output = `${merged.stdout ?? ""}${merged.stderr ?? ""}`;
    expect(merged.status, output).toBe(0);
    expect(output).not.toContain("[merge-succeeded:");
    expect(existsSync(join(project, "hook-commit.ts"))).toBe(false);
    expect(existsSync(wt)).toBe(false);
    expect(readAllAuditShards(project)).toContain(
      "**Event**: SWARM_SOURCE_MERGED",
    );
  }, 120000);

  test("an audit append failure after source merge is tagged, non-retryable, and preserves recovery state", () => {
    expect(typeof process.getuid === "function" ? process.getuid() : -1)
      .not.toBe(0);
    const project = swarmFixture();
    const unit = "audit-failure";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);

    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(
      join(wt, source),
      "export const auditFailure = true;\n",
    );
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.request.rc, reviewed.request.out).toBe(0);
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const shard = seededAuditShard(project);
    const marker = join(project, ".aidlc", "audit-lock-marker");
    const originalMode = statSync(shard).mode & 0o777;
    const watcher = auditLockWatcher(shard, marker, unit);
    let merge: ReturnType<typeof spawnSync>;
    let locked = false;
    try {
      merge = spawnSync(
        process.execPath,
        [
          WORKTREE,
          "merge",
          "--slug",
          unit,
          "--target",
          "main",
          "--strategy",
          "squash",
          "--project-dir",
          project,
        ],
        { cwd: project, encoding: "utf-8" },
      );
      locked = existsSync(marker);
    } finally {
      watcher.kill();
      chmodSync(shard, originalMode);
      rmSync(marker, { force: true });
    }

    const output = `${merge.stdout ?? ""}${merge.stderr ?? ""}`;
    expect(locked).toBe(true);
    expect(merge.status).not.toBe(0);
    expect(output).toContain("[merge-succeeded:");
    expect(output).toContain("Do not retry this merge");
    expect(existsSync(join(project, source))).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(readAllAuditShards(project)).not.toContain(
      "**Event**: SWARM_SOURCE_MERGED",
    );
  }, 120000);
});

describe("t305 stage and protocol source-attribution requirements", () => {
  test("pins schema, Bolt-relative paths, review freeze, and workspace_requires semantics", () => {
    const stage=readFileSync(STAGE,"utf-8"); const reviewer=readFileSync(join(PROTOCOL,"stage-protocol-reviewer.md"),"utf-8"); const construction=readFileSync(join(PROTOCOL,"stage-protocol-construction.md"),"utf-8"); const definition=readFileSync(join(PROTOCOL,"stage-definition.md"),"utf-8"); const swarm=readFileSync(join(PROTOCOL,"stage-protocol-swarm.md"),"utf-8");
    expect(stage).toContain('"version": 1'); expect(stage).toContain("created, modified, or deleted"); expect(stage).toContain("trailing `/` directory claim"); expect(stage).toContain("MUST omit `repo`"); expect(stage).toContain("unclaimed changed paths\nblock stage completion"); expect(stage).toContain("engine-validated against its strict schema");
    expect(reviewer).toContain("differentially at those paths"); expect(reviewer).toContain("source-manifest.json"); expect(reviewer).toContain("claimed source paths");
    expect(construction).toContain("before the in-Bolt review"); expect(construction).toContain("worktree-relative and omit `repo`"); expect(definition).toContain("source-manifest.json"); expect(definition).toContain("stage-entry source baseline");
    expect(swarm).toContain("Post-finalize source landing"); expect(swarm).toContain("cleanup-only reconciliation"); expect(swarm).toContain("SWARM_SOURCE_MERGED");
  });
});
