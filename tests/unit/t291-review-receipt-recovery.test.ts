// covers: function:freshReviewReceipts, subcommand:aidlc-log:review, subcommand:aidlc-state:approve
//
// A terminal review receipt that becomes stale after an artifact write gets one
// bounded recovery pass. The recovery receipt satisfies the completion guard,
// while a second invalidation refuses another recovery until the human resets
// the attempt at the gate.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const LOG_TOOL = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE_TOOL = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const tempDirs: string[] = [];
const TEST_ENV = {
  AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVISION_BACKSTOP: "1",
};

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function run(tool: string, args: string[], proj: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, tool, ...args, "--project-dir", proj],
    env: { ...process.env, ...TEST_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return {
    status: result.exitCode,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
  };
}

function writeRequirements(proj: string, content: string): string {
  const dir = join(
    seededRecordDir(proj),
    "inception",
    "requirements-analysis",
  );
  mkdirSync(dir, { recursive: true });
  const artifact = join(dir, "requirements.md");
  writeFileSync(artifact, content, "utf-8");
  return artifact;
}

function recordArtifactUpdate(proj: string, artifact: string): void {
  appendAuditEntry("ARTIFACT_UPDATED", {
    File: artifact,
    Tool: "Edit",
    Context: "inception > requirements-analysis > requirements.md",
  }, proj);
}

describe("t291 stale review receipt recovery", () => {
  test("one recovery receipt unblocks completion and a second invalidation is final", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-mid-inception.md");
    const artifact = writeRequirements(proj, "reviewed requirements\n");
    const review = [
      "review",
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
    ];

    expect(run(LOG_TOOL, [...review, "--iteration", "1"], proj).status).toBe(0);
    expect(
      run(
        LOG_TOOL,
        [...review, "--iteration", "1", "--verdict", "READY"],
        proj,
      ).status,
    ).toBe(0);
    expect(
      run(STATE_TOOL, ["gate-start", "requirements-analysis"], proj).status,
    ).toBe(0);

    writeRequirements(proj, "changed requirements\n");
    recordArtifactUpdate(proj, artifact);
    const stale = run(
      STATE_TOOL,
      ["approve", "requirements-analysis", "--user-input", "Approve"],
      proj,
    );
    expect(stale.status).not.toBe(0);
    expect(stale.out).toContain(
      "terminal review receipt from aidlc-product-lead-agent was invalidated",
    );
    expect(stale.out).toContain("one recovery review pass");

    const recovery = run(
      LOG_TOOL,
      [...review, "--iteration", "2"],
      proj,
    );
    expect(recovery.status).toBe(0);
    expect(recovery.stdout).toContain('"recovery":"stale-receipt"');
    expect(
      run(
        LOG_TOOL,
        [...review, "--iteration", "2", "--verdict", "READY"],
        proj,
      ).status,
    ).toBe(0);

    const completed = run(
      STATE_TOOL,
      ["approve", "requirements-analysis", "--user-input", "Approve"],
      proj,
    );
    expect(completed.status).toBe(0);

    writeRequirements(proj, "changed after recovery\n");
    recordArtifactUpdate(proj, artifact);
    const spent = run(
      LOG_TOOL,
      [...review, "--iteration", "3"],
      proj,
    );
    expect(spent.status).not.toBe(0);
    expect(spent.stderr).toContain(
      "stale-receipt recovery review pass was already spent",
    );
    expect(spent.stderr).toContain("human Request Changes decision");
  });

  test("a human Request Changes resets a spent recovery to iteration 1", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-mid-inception.md");
    const artifact = writeRequirements(proj, "reviewed requirements\n");
    const review = [
      "review",
      "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent",
    ];

    expect(run(LOG_TOOL, [...review, "--iteration", "1"], proj).status).toBe(0);
    expect(
      run(
        LOG_TOOL,
        [...review, "--iteration", "1", "--verdict", "READY"],
        proj,
      ).status,
    ).toBe(0);
    expect(
      run(STATE_TOOL, ["gate-start", "requirements-analysis"], proj).status,
    ).toBe(0);

    writeRequirements(proj, "changed before recovery\n");
    recordArtifactUpdate(proj, artifact);
    expect(run(LOG_TOOL, [...review, "--iteration", "2"], proj).status).toBe(0);
    expect(
      run(
        LOG_TOOL,
        [...review, "--iteration", "2", "--verdict", "READY"],
        proj,
      ).status,
    ).toBe(0);

    writeRequirements(proj, "changed after recovery\n");
    recordArtifactUpdate(proj, artifact);
    const spent = run(LOG_TOOL, [...review, "--iteration", "3"], proj);
    expect(spent.status).not.toBe(0);
    expect(spent.stderr).toContain(
      "stale-receipt recovery review pass was already spent",
    );

    const rejected = run(
      STATE_TOOL,
      ["reject", "requirements-analysis", "--feedback", "review the new content"],
      proj,
    );
    expect(rejected.status).toBe(0);

    const restarted = run(LOG_TOOL, [...review, "--iteration", "1"], proj);
    expect(restarted.status).toBe(0);
    expect(restarted.stdout).toContain('"emitted":"REVIEW_REQUESTED"');
    expect(restarted.stdout).not.toContain('"recovery"');
  });
});
