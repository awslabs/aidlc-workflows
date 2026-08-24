// covers: function:freshReviewReceipts, subcommand:aidlc-log:review,
// audit:BOLT_STARTED

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  boltSlugForUnit,
  freshReviewReceipts,
  loadStageGraphAll,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  cleanupWorktreeFixture,
  createTestProject,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SWARM = join(AIDLC_SRC, "tools", "aidlc-swarm.ts");
const tempDirs: string[] = [];
const worktreeDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
  while (worktreeDirs.length > 0) {
    cleanupWorktreeFixture(worktreeDirs.pop()!);
  }
});

function runReview(proj: string, args: string[]) {
  const result = spawnSync(
    BUN,
    [LOG, "review", ...args, "--project-dir", proj],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      },
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("t322 fix-round hardening", () => {
  test("a fresh Bolt attempt floors an unmatched recovery from the prior attempt", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-construction.md");
    seedBoltDag(proj, ["alpha"]);

    const dir = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "functional-design",
    );
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "entities.md",
      "rules.md",
      "functional-spec.md",
      "traceability.json",
    ]) {
      writeFileSync(join(dir, name), `# ${name}\n`);
    }
    const artifact = join(dir, "functional-spec.md");
    const review = [
      "--stage",
      "functional-design",
      "--reviewer",
      "aidlc-architecture-reviewer-agent",
      "--unit",
      "alpha",
    ];

    expect(runReview(proj, [...review, "--iteration", "1"]).status).toBe(0);
    expect(
      runReview(proj, [
        ...review,
        "--iteration",
        "1",
        "--verdict",
        "READY",
      ]).status,
    ).toBe(0);

    writeFileSync(artifact, "# changed\n");
    appendAuditEntry(
      "ARTIFACT_UPDATED",
      { File: artifact, Tool: "Edit" },
      proj,
    );
    const recovery = runReview(proj, [...review, "--iteration", "2"]);
    expect(recovery.status).toBe(0);
    expect(recovery.stdout).toContain('"recovery":"stale-receipt"');

    appendAuditEntry(
      "BOLT_STARTED",
      {
        "Bolt names": "alpha",
        "Batch number": "2",
        "Walking skeleton": "false",
        "Bolt slug": boltSlugForUnit("alpha"),
      },
      proj,
    );

    const stage = loadStageGraphAll().find(
      (entry) => entry.slug === "functional-design",
    )!;
    const receipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      stage,
      { reviewClass: "adversarial" },
    );
    expect(receipts.unitPending.has("alpha")).toBe(false);
    expect(receipts.unitStale.has("alpha")).toBe(false);

    const restarted = runReview(proj, [...review, "--iteration", "1"]);
    expect(restarted.status).toBe(0);
    expect(restarted.stdout).toContain('"emitted":"REVIEW_REQUESTED"');
    expect(restarted.stdout).not.toContain('"recovery"');
  });

  test("invalid degraded-from fails before swarm preparation has side effects", () => {
    const proj = setupWorktreeFixture();
    worktreeDirs.push(proj);
    seedStateFile(proj, "state-construction-with-worktree.md");
    const runtimeGraph = join(seededRecordDir(proj), "runtime-graph.json");

    const result = spawnSync(
      BUN,
      [
        SWARM,
        "--project-dir",
        proj,
        "prepare",
        "--batch",
        "1",
        "--units",
        "alpha",
        "--base",
        "main",
        "--degraded-from",
        "invalid",
      ],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(result.status ?? -1).not.toBe(0);
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain(
      "--degraded-from must be one of",
    );
    expect(existsSync(runtimeGraph)).toBe(false);
  });
});
