// covers: subcommand:aidlc-swarm:prepare, subcommand:aidlc-audit:audit-fork, function:delegatedWorktreeIntent,
// function:bindCodeGenerationWorktreeApproval, function:validateCodeGenerationForkApproval,
// function:gitSubmoduleNames, audit:AUDIT_FORKED, audit:WORKTREE_DISCARDED
//
// A side-by-side (swarm) build must start on a project whose AI-DLC records are not committed yet (every fresh
// project), on a long-lived repo whose committed audit already holds a fork row for the Unit, and on the person's own
// branch ahead of main when the agent names main as the base. The t344 fixture commits every record and ignores the
// audit dir; a real project's .gitignore (the block AI-DLC's setup writes) commits the audit, so these cases use that
// block and four shapes of the base commit.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  activeIntentUuid, auditBlockField, boltSlugForUnit, readAuditShardEvents, workspaceSourceListing,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC, DEFAULT_INTENT_UUID, DEFAULT_RECORD_DIR, seedAidlcMemory, seedBoltDagBatches, seededAuditDir,
  seededStateFile, setupWorktreeFixture,
} from "../harness/fixtures.ts";
import {
  CHECK, ISOLATED_GIT_ENV, STAGE, approvalSnapshot, approvePlan, checkReviewFinalizeAndLand, checkpointChoice,
  cleanupCheckpointFixtures, git, nextDirective, plan, prepare, projects, publish, recordCommand, runCheckpointTool,
  writeUnitSource, wt,
} from "../harness/swarm-checkpoint.ts";
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

// The per-user files AI-DLC's setup ignores on a project. The audit dir is NOT among them: a records commit carries it.
const SHIPPED_GITIGNORE = [
  "# BEGIN AI-DLC:gitignore",
  "aidlc/active-space",
  "aidlc/spaces/*/intents/active-intent",
  "aidlc/.aidlc-clone-id",
  "aidlc/.aidlc-sessions/",
  "aidlc/spaces/*/intents/.aidlc-*",
  "**/aidlc/spaces/*/intents/**/.aidlc-engine/",
  "**/aidlc/spaces/*/intents/**/.aidlc-sensors/",
  "aidlc/spaces/*/intents/*/runtime-graph.json",
  "aidlc/spaces/*/intents/*/.aidlc-*",
  "# END AI-DLC:gitignore",
  "",
].join("\n");

const STATE = `# State
## Project Information
- **Project**: Fresh project swarm
- **Scope**: feature
- **Project Type**: Greenfield
- **State Version**: 8
## Runtime State
- **Construction Checkpoints**: enabled
- **Construction Iteration**: stage-major
- **Construction Execution**: swarm
- **Construction Autonomy Mode**: gated
- **Skeleton Stance**: off
- **Unit Ownership**: solo
- **Review Override**: adversarial
- **Change Control**: strict
- **Bolt Refs**: [empty list]
- **Worktree Path**: -
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
## Current Status
- **Current Stage**: code-generation
- **Lifecycle Phase**: CONSTRUCTION
- **Status**: Running
`;

const UNITS = ["alpha", "beta"];
const REGISTRY = "aidlc/spaces/default/intents/intents.json";
const OLDER_RECORD = "older-work-00000002";
const OLDER_UUID = "00000000-0000-7000-8000-000000000002";

type Shape = "records-untracked" | "registry-only" | "older-intent-committed" | "all-records" | "branch-ahead";

// A project at the Code Generation plan-approved point whose base commit holds:
// records-untracked: source and memory only (a fresh project after a copy install; the registry and record dir are untracked);
// registry-only: the registry too, but not the record dir;
// older-intent-committed: an earlier intent's registry row and record dir; this intent's row and record dir are untracked;
// all-records: every record, the audit included (a long-lived repo that commits its records);
// branch-ahead: every record on main, then the person's branch "feature" with a source change main never had and the
// records holding the plan approvals made there, committed (a team clone that commits its records with its work).
function project(shape: Shape, source?: (pd: string) => void): string {
  const pd = setupWorktreeFixture();
  projects.push(pd);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), STATE);
  writeFileSync(join(pd, ".gitignore"), SHIPPED_GITIGNORE);
  seedBoltDagBatches(pd, [UNITS, ["later"]]);
  mkdirSync(join(pd, "src"), { recursive: true });
  for (const unit of UNITS) writeFileSync(join(pd, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  if (shape === "branch-ahead") writeFileSync(join(pd, "src", "shared.ts"), "export const shared = 2;\n");
  source?.(pd);
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
  recordCommand(pd, CHECK);
  publish(pd, UNITS);
  for (const unit of UNITS) plan(pd, unit);
  const registry = join(pd, REGISTRY);
  const current = JSON.parse(readFileSync(registry, "utf-8")) as Array<Record<string, unknown>>;
  if (shape === "all-records" || shape === "branch-ahead") {
    git(pd, ["add", "-A"]);
    if (shape === "branch-ahead") git(pd, ["reset", "-q", "--", "src/shared.ts"]);
  } else {
    git(pd, ["add", "--", ".gitignore", "src", "aidlc/spaces/default/memory"]);
    if (shape === "registry-only") git(pd, ["add", "--", REGISTRY]);
    if (shape === "older-intent-committed") {
      const older = join(pd, "aidlc", "spaces", "default", "intents", OLDER_RECORD);
      mkdirSync(older, { recursive: true });
      writeFileSync(join(older, "aidlc-state.md"), "# AI-DLC State\n");
      const olderRow = { uuid: OLDER_UUID, slug: "older-work", dirName: OLDER_RECORD, status: "in-flight" };
      writeFileSync(registry, `${JSON.stringify([olderRow], null, 2)}\n`);
      git(pd, ["add", "--", REGISTRY, `aidlc/spaces/default/intents/${OLDER_RECORD}`]);
      writeFileSync(registry, `${JSON.stringify([olderRow, ...current], null, 2)}\n`);
    }
  }
  git(pd, ["commit", "-qm", `project (${shape})`]);
  if (shape === "branch-ahead") git(pd, ["checkout", "-q", "-b", "feature"]);
  for (const unit of UNITS) approvePlan(pd, unit);
  if (shape === "branch-ahead") {
    git(pd, ["add", "-A"]);
    git(pd, ["commit", "-qm", "feature: a shared helper, and the records with the plan approvals"]);
  }
  return pd;
}

function units(result: { out: string }): Array<{ unit: string; ok: boolean; error?: string }> {
  return JSON.parse(result.out).units;
}

function expectPrepared(pd: string, result: { code: number | null; out: string; err: string }): void {
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  for (const unit of units(result)) expect(unit.ok, JSON.stringify(unit)).toBe(true);
  for (const unit of UNITS) {
    expect(existsSync(wt(pd, unit))).toBe(true);
    approvalSnapshot(pd, unit);
  }
}

// The child's audit shard mirrors the parent's (same record dir, same clone token) under the child.
function childAuditPath(pd: string, unit: string): string {
  const forks = readAuditShardEvents(pd).filter((row) => row.event === "AUDIT_FORKED" &&
    auditBlockField(row.block, "Bolt slug") === boltSlugForUnit(unit));
  expect(forks.length).toBeGreaterThan(0);
  const shards = readdirSync(seededAuditDir(pd)).filter((name) => name.endsWith(".md"));
  expect(shards).toHaveLength(1);
  const path = join(wt(pd, unit), relative(pd, join(seededAuditDir(pd), shards[0])));
  expect(existsSync(path), path).toBe(true);
  return path;
}

function auditFork(pd: string, unit: string) {
  return runCheckpointTool(pd, "tools/aidlc-audit.ts", ["audit-fork", "--slug", boltSlugForUnit(unit), "--project-dir", pd]);
}

function embeddedRepo(pd: string, path: string): string {
  const dir = join(pd, path);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "source.ts"), "export const value = 1;\n");
  git(dir, ["add", "--", "source.ts"]);
  git(dir, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "nested source"]);
  git(pd, ["add", "--", path]);
  return dir;
}

describe("a side-by-side build can reproduce its nested repository source", () => {
  test("unregistered source gitlinks are named before any Unit worktree is created", () => {
    const pd = project("records-untracked", (root) => {
      embeddedRepo(root, "src/package one");
      embeddedRepo(root, "src/package-two");
    });
    const head = git(pd, ["rev-parse", "HEAD"]);
    const result = prepare(pd, UNITS);
    expect(result.code, `${result.out}\n${result.err}`).not.toBe(0);
    const message = `${result.out}\n${result.err}`;
    expect(message).toContain("src/package one");
    expect(message).toContain("src/package-two");
    expect(message).toContain(".gitmodules");
    expect(message).toContain("serially");
    for (const unit of UNITS) expect(existsSync(wt(pd, unit))).toBe(false);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "WORKTREE_CREATED")).toHaveLength(0);
    expect(git(pd, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(pd, ["diff", "--cached", "--name-only"])).toBe("");
  });

  test("a registered submodule copies the approved source into every Unit worktree", () => {
    const pd = project("records-untracked", (root) => {
      embeddedRepo(root, "src/package");
      writeFileSync(join(root, ".gitmodules"), '[submodule "package"]\n\tpath = src/package\n\turl = ./src/package\n');
      git(root, ["add", "--", ".gitmodules"]);
    });
    expectPrepared(pd, prepare(pd, UNITS));
    for (const unit of UNITS) {
      expect(readFileSync(join(wt(pd, unit), "src/package/source.ts"), "utf-8")).toBe("export const value = 1;\n");
    }
  });

  test("an unregistered gitlink inside a registered submodule is caught before creation", () => {
    const pd = project("records-untracked", (root) => {
      const submodule = embeddedRepo(root, "src/package");
      embeddedRepo(submodule, "nested");
      git(submodule, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "nested gitlink"]);
      git(root, ["add", "--", "src/package"]);
      writeFileSync(join(root, ".gitmodules"), '[submodule "package"]\n\tpath = src/package\n\turl = ./src/package\n');
      git(root, ["add", "--", ".gitmodules"]);
    });
    const result = prepare(pd, UNITS);
    expect(result.code, `${result.out}\n${result.err}`).not.toBe(0);
    expect(`${result.out}\n${result.err}`).toContain("src/package/nested");
    for (const unit of UNITS) expect(existsSync(wt(pd, unit))).toBe(false);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "WORKTREE_CREATED")).toHaveLength(0);
  });

  test("an excluded dependency gitlink does not block source preparation", () => {
    const pd = project("records-untracked", (root) => { embeddedRepo(root, "node_modules/package"); });
    expectPrepared(pd, prepare(pd, UNITS));
  });

  test("source registered inside an otherwise excluded gitlink is checked too", () => {
    const pd = project("records-untracked", (root) => {
      embeddedRepo(root, "dist");
      writeFileSync(join(root, ".aidlc-source-paths.json"), JSON.stringify({ version: 1, paths: ["dist/source.ts"] }));
      git(root, ["add", "--", ".aidlc-source-paths.json"]);
    });
    const result = prepare(pd, UNITS);
    expect(result.code, `${result.out}\n${result.err}`).not.toBe(0);
    expect(`${result.out}\n${result.err}`).toContain("dist");
    expect(`${result.out}\n${result.err}`).toContain(".gitmodules");
    for (const unit of UNITS) expect(existsSync(wt(pd, unit))).toBe(false);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "WORKTREE_CREATED")).toHaveLength(0);
  });

  test("an older base without registration does not block a Unit that starts at the registered approved HEAD", () => {
    const pd = project("records-untracked", (root) => { embeddedRepo(root, "src/package"); });
    const base = git(pd, ["rev-parse", "HEAD"]);
    writeFileSync(join(pd, ".gitmodules"), '[submodule "package"]\n\tpath = src/package\n\turl = ./src/package\n');
    git(pd, ["add", "--", ".gitmodules"]);
    git(pd, ["commit", "-qm", "register the package"]);
    for (const unit of UNITS) approvePlan(pd, unit, "registered");
    const head = git(pd, ["rev-parse", "HEAD"]);
    const result = runCheckpointTool(pd, "tools/aidlc-swarm.ts", [
      "prepare", "--batch", "1", "--units", UNITS.join(","), "--base", base, "--project-dir", pd,
    ]);
    expectPrepared(pd, result);
    for (const unit of UNITS) {
      expect(units(result).find((entry) => entry.unit === unit)).toMatchObject({ base_commit: head });
      expect(readFileSync(join(wt(pd, unit), "src/package/source.ts"), "utf-8")).toBe("export const value = 1;\n");
    }
  });

  test("a selected base that already holds the approved source still needs its own submodule registration", () => {
    const pd = project("records-untracked", (root) => {
      embeddedRepo(root, "src/package");
      writeFileSync(join(root, ".aidlc-source-paths.json"), JSON.stringify({ version: 1, exclude: [".gitmodules"] }));
      git(root, ["add", "--", ".aidlc-source-paths.json"]);
    });
    const base = git(pd, ["rev-parse", "HEAD"]);
    writeFileSync(join(pd, ".gitmodules"), '[submodule "package"]\n\tpath = src/package\n\turl = ./src/package\n');
    git(pd, ["add", "--", ".gitmodules"]);
    git(pd, ["commit", "-qm", "register the package outside the selected source"]);
    for (const unit of UNITS) approvePlan(pd, unit, "registered");
    const head = git(pd, ["rev-parse", "HEAD"]);
    const result = runCheckpointTool(pd, "tools/aidlc-swarm.ts", [
      "prepare", "--batch", "1", "--units", UNITS.join(","), "--base", base, "--project-dir", pd,
    ]);
    expect(result.code, `${result.out}\n${result.err}`).not.toBe(0);
    expect(`${result.out}\n${result.err}`).toContain("src/package");
    expect(`${result.out}\n${result.err}`).toContain(".gitmodules");
    for (const unit of UNITS) expect(existsSync(wt(pd, unit))).toBe(false);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "WORKTREE_CREATED")).toHaveLength(0);
    expect(git(pd, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("a registered base with the approved source remains usable when only the parent's excluded registration changed", () => {
    const pd = project("records-untracked", (root) => {
      embeddedRepo(root, "src/package");
      writeFileSync(join(root, ".aidlc-source-paths.json"), JSON.stringify({ version: 1, exclude: [".gitmodules"] }));
      writeFileSync(join(root, ".gitmodules"), '[submodule "package"]\n\tpath = src/package\n\turl = ./src/package\n');
      git(root, ["add", "--", ".aidlc-source-paths.json", ".gitmodules"]);
    });
    const base = git(pd, ["rev-parse", "HEAD"]);
    git(pd, ["rm", "--", ".gitmodules"]);
    git(pd, ["commit", "-qm", "remove the registration outside the selected source"]);
    for (const unit of UNITS) approvePlan(pd, unit, "registration-removed");
    const result = runCheckpointTool(pd, "tools/aidlc-swarm.ts", [
      "prepare", "--batch", "1", "--units", UNITS.join(","), "--base", base, "--project-dir", pd,
    ]);
    expectPrepared(pd, result);
    for (const unit of UNITS) {
      expect(units(result).find((entry) => entry.unit === unit)).toMatchObject({ base_commit: base });
      expect(readFileSync(join(wt(pd, unit), "src/package/source.ts"), "utf-8")).toBe("export const value = 1;\n");
    }
  });

  test("discard recovery checks the recorded registered baseline after the parent's source and registration changed", () => {
    const pd = project("records-untracked", (root) => {
      embeddedRepo(root, "src/package");
      writeFileSync(join(root, ".gitmodules"), '[submodule "package"]\n\tpath = src/package\n\turl = ./src/package\n');
      git(root, ["add", "--", ".gitmodules"]);
    });
    expectPrepared(pd, prepare(pd, UNITS));
    const baseline = git(wt(pd, "alpha"), ["rev-parse", "HEAD"]);
    const saved = approvalSnapshot(pd, "alpha");
    const discarded = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
      "discard", "--slug", boltSlugForUnit("alpha"), "--project-dir", pd,
    ]);
    expect(discarded.code, `${discarded.out}\n${discarded.err}`).toBe(0);
    expect(existsSync(wt(pd, "alpha"))).toBe(false);
    rmSync(join(pd, ".gitmodules"));
    writeFileSync(join(pd, "src/alpha.ts"), "export const alpha = 99;\n");
    git(pd, ["add", "-A"]);
    git(pd, ["commit", "-qm", "parent changes after the Unit was discarded"]);
    const head = git(pd, ["rev-parse", "HEAD"]);
    const result = prepare(pd, ["alpha"]);
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(units(result)).toEqual([expect.objectContaining({ unit: "alpha", ok: true, base_commit: baseline })]);
    expect(readFileSync(join(wt(pd, "alpha"), "src/package/source.ts"), "utf-8")).toBe("export const value = 1;\n");
    expect(readFileSync(join(wt(pd, "alpha"), "src/alpha.ts"), "utf-8")).toBe("export const alpha = 1;\n");
    expect(git(pd, ["rev-parse", "HEAD"])).toBe(head);
    expect(approvalSnapshot(pd, "alpha").parentReceipt).toEqual(saved.parentReceipt);
  });
});

describe("a side-by-side build starts whatever the base commit holds of the records", () => {
  test("a fresh project: records untracked, the child has no registry of its own", () => {
    const pd = project("records-untracked");
    expectPrepared(pd, prepare(pd, UNITS));
    const child = wt(pd, "alpha");
    expect(existsSync(join(child, REGISTRY))).toBe(false);
    expect(activeIntentUuid(child)).toBeNull();
  });

  test("the registry committed and the record dir untracked", () => {
    const pd = project("registry-only");
    expectPrepared(pd, prepare(pd, UNITS));
  });

  test("a long-lived repo with an earlier intent committed: two record dirs and no cursor in the child", () => {
    const pd = project("older-intent-committed");
    expectPrepared(pd, prepare(pd, UNITS));
    const child = wt(pd, "alpha");
    expect(existsSync(join(child, "aidlc", "spaces", "default", "intents", OLDER_RECORD, "aidlc-state.md"))).toBe(true);
    expect(existsSync(join(child, "aidlc", "spaces", "default", "intents", DEFAULT_RECORD_DIR, "aidlc-state.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(child, REGISTRY), "utf-8"))).toHaveLength(1);
    expect(approvalSnapshot(pd, "alpha").childReceipt.intentId).toBe(DEFAULT_INTENT_UUID);
  });

  test("the second round on a long-lived repo: the first side-by-side build landed and its records were committed", () => {
    const pd = project("all-records");
    expectPrepared(pd, prepare(pd, UNITS));
    for (const unit of UNITS) writeUnitSource(pd, unit, 2);
    checkReviewFinalizeAndLand(pd, Object.fromEntries(UNITS.map((unit) => [unit, 2])));
    git(pd, ["add", "-A"]);
    git(pd, ["commit", "-qm", "AI-DLC records after the first side-by-side build"]);
    expect(nextDirective(pd)).toMatchObject({
      kind: "run-stage", swarm_checkpoint: { batch: 1, units: UNITS, ready: true, approved: false },
    });
    checkpointChoice(pd, UNITS, "Request Changes");
    const rejected = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
      "swarm-checkpoint", "--action", "reject", "--batch", "1", "--units", UNITS.join(","),
      "--session", "t344-checkpoint", "--user-input", "Request Changes", "--reason", "Please revise the batch",
      "--project-dir", pd,
    ]);
    expect(rejected.code, `${rejected.out}\n${rejected.err}`).toBe(0);
    expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm", units: UNITS, resume_existing: true });
    for (const unit of UNITS) approvePlan(pd, unit, "second-round");
    expectPrepared(pd, prepare(pd, UNITS, true));
  });
});

describe("the person's branch is ahead of main and carries the records: prepare --base main", () => {
  // The plans were approved on the branch, so each Unit starts on the branch's commit. Started on main and moved to
  // the branch after the fork had written the Unit's audit, every Unit failed on that file, and so did the discard
  // and prepare the failure named.
  test("every Unit starts on the branch's commit, records it as its base, and lands back on the branch", () => {
    const pd = project("branch-ahead");
    const head = git(pd, ["rev-parse", "HEAD"]);
    expect(git(pd, ["diff", "--name-only", "main", "HEAD", "--", "aidlc"])).toContain("/audit/");
    const result = prepare(pd, UNITS);
    expectPrepared(pd, result);
    expect(JSON.parse(result.out)).toMatchObject({ base: "main", landing_branch: "feature" });
    const rows = readAuditShardEvents(pd);
    for (const unit of UNITS) {
      expect(units(result).find((entry) => entry.unit === unit)).toMatchObject({ base_commit: head });
      expect(git(wt(pd, unit), ["rev-parse", "HEAD"])).toBe(head);
      for (const event of ["WORKTREE_CREATED", "BOLT_STARTED"]) {
        const row = rows.filter((entry) => entry.event === event &&
          auditBlockField(entry.block, "Bolt slug") === boltSlugForUnit(unit)).at(-1);
        expect(row && auditBlockField(row.block, "Base commit"), event).toBe(head);
      }
      writeUnitSource(pd, unit, 2);
    }
    checkReviewFinalizeAndLand(pd, Object.fromEntries(UNITS.map((unit) => [unit, 2])), "feature");
    expect(git(pd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
    expect(readFileSync(join(pd, "src", "shared.ts"), "utf-8")).toBe("export const shared = 2;\n");
  });

  // The landing branch is the one prepare found, not whatever is checked out at landing: a switch in between is
  // still caught by the landing's own branch check.
  test("finalize names the branch prepare found even after the checkout moved, and the landing refuses there", () => {
    const pd = project("branch-ahead");
    expectPrepared(pd, prepare(pd, UNITS));
    for (const unit of UNITS) writeUnitSource(pd, unit, 2);
    git(pd, ["checkout", "-q", "-b", "elsewhere"]);
    expect(() => checkReviewFinalizeAndLand(pd, { alpha: 2, beta: 2 }, "feature")).toThrow("expected branch feature, found elsewhere");
  });

  test("on main itself the Units start on the named base, as before", () => {
    const pd = project("all-records");
    const result = prepare(pd, UNITS);
    expectPrepared(pd, result);
    expect(JSON.parse(result.out)).toMatchObject({ base: "main", landing_branch: "main" });
    const head = git(pd, ["rev-parse", "HEAD"]);
    for (const unit of UNITS) expect(units(result).find((entry) => entry.unit === unit)).toMatchObject({ base_commit: head });
  });
});

describe("a child audit with the child's own rows is never taken for the inherited copy", () => {
  test("fresh project: a second audit-fork on the same child is a no-op, and refuses once the child has written a row", () => {
    const pd = project("records-untracked");
    expectPrepared(pd, prepare(pd, UNITS));
    const path = childAuditPath(pd, "alpha");
    const forked = readFileSync(path);
    const again = auditFork(pd, "alpha");
    expect(again.code, `${again.out}\n${again.err}`).toBe(0);
    expect(JSON.parse(again.out).already_current).toBe(true);
    expect(readFileSync(path).equals(forked)).toBe(true);
    appendAuditEntry("ARTIFACT_CREATED", { Tool: "Write", File: "src/alpha.ts", Context: "alpha" }, wt(pd, "alpha"));
    const written = readFileSync(path);
    expect(written.equals(forked)).toBe(false);
    const refused = auditFork(pd, "alpha");
    expect(refused.code).not.toBe(0);
    expect(`${refused.out}\n${refused.err}`).toContain("unmerged work after AUDIT_FORKED");
    expect(readFileSync(path).equals(written)).toBe(true);
    // Committed by hand on the child's branch, the file equals the child's HEAD but not its creation commit: still the child's work.
    git(wt(pd, "alpha"), ["add", "-A"]);
    git(wt(pd, "alpha"), ["commit", "-qm", "worker commit"]);
    const stillRefused = auditFork(pd, "alpha");
    expect(stillRefused.code).not.toBe(0);
    expect(`${stillRefused.out}\n${stillRefused.err}`).toContain("unmerged work after AUDIT_FORKED");
    expect(readFileSync(path).equals(written)).toBe(true);
  });

  test("long-lived repo: a row the child wrote after its fork keeps today's refusal", () => {
    const pd = project("all-records");
    expectPrepared(pd, prepare(pd, UNITS));
    const path = childAuditPath(pd, "alpha");
    appendAuditEntry("ARTIFACT_CREATED", { Tool: "Write", File: "src/alpha.ts", Context: "alpha" }, wt(pd, "alpha"));
    const written = readFileSync(path);
    const refused = auditFork(pd, "alpha");
    expect(refused.code).not.toBe(0);
    expect(`${refused.out}\n${refused.err}`).toContain("unmerged work after AUDIT_FORKED");
    expect(readFileSync(path).equals(written)).toBe(true);
  });
});

// A project whose checkout is deep enough that the Bolt's nested audit path passes Windows MAX_PATH while the main
// checkout's audit path stays under it. Git for Windows handles such a path only with core.longpaths, which the engine's
// own git calls supply; the tools here run with the machine's Git config dropped and without the runner's long-path
// entry, as on a machine that never enabled it. Elsewhere the depth changes nothing.
function deepTempDir(): string {
  const root = tmpdir();
  const segments: string[] = [];
  let dir = root;
  while (join(dir, "aidlc-worktree-XXXXXX").length < 145) {
    segments.push(`deep-swarm-path-${segments.length}`);
    dir = join(root, ...segments);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function prepareWithoutLongPaths(pd: string) {
  const env: NodeJS.ProcessEnv = { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd };
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_KEY_0;
  delete env.GIT_CONFIG_VALUE_0;
  const r = Bun.spawnSync([
    process.execPath, join(AIDLC_SRC, "tools/aidlc-swarm.ts"),
    "prepare", "--batch", "1", "--units", UNITS.join(","), "--base", "main", "--project-dir", pd,
  ], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd, env, stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("the committed audit already holds fork rows for the Units (the records committed after a failed attempt)", () => {
  test("in a deep checkout, the inherited copy is forked over and both Units start", () => {
    const deep = deepTempDir();
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = deep;
    let pd: string;
    try {
      pd = setupWorktreeFixture();
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    projects.push(pd);
    seedAidlcMemory(pd);
    writeFileSync(seededStateFile(pd), STATE);
    writeFileSync(join(pd, ".gitignore"), SHIPPED_GITIGNORE);
    seedBoltDagBatches(pd, [UNITS, ["later"]]);
    mkdirSync(join(pd, "src"), { recursive: true });
    for (const unit of UNITS) writeFileSync(join(pd, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
    const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
    recordCommand(pd, CHECK);
    publish(pd, UNITS);
    for (const unit of UNITS) plan(pd, unit);
    // An earlier attempt forked each Unit and failed; its rows are in the audit the records commit carries.
    for (const unit of UNITS) {
      appendAuditEntry("AUDIT_FORKED", {
        "Bolt slug": boltSlugForUnit(unit), "Source Audit Hash": "0".repeat(64), "Fork Boundary": "1",
      }, pd);
      appendAuditEntry("BOLT_FAILED", {
        "Failed Bolt": unit, "Error summary": "Interrupted swarm preparation; source and records preserved for recovery",
        "Bolt slug": boltSlugForUnit(unit),
      }, pd);
    }
    git(pd, ["add", "-A"]);
    git(pd, ["commit", "-qm", "AI-DLC records after the failed attempt"]);
    for (const unit of UNITS) approvePlan(pd, unit);
    const result = prepareWithoutLongPaths(pd);
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    for (const unit of units(result)) expect(unit.ok, JSON.stringify(unit)).toBe(true);
    const child = wt(pd, "alpha");
    expect(child.length).toBeGreaterThan(pd.length + 30);
    expect(readAuditShardEvents(child).at(-1)?.event).toBe("AUDIT_FORKED");
  });
});
