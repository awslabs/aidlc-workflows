// covers: function:freshReviewReceipts, subcommand:aidlc-log:review, subcommand:aidlc-state:approve
//
// A terminal review receipt that becomes stale after an artifact write gets one
// bounded recovery pass. The recovery receipt satisfies the completion guard,
// while a second invalidation refuses another recovery until the human resets
// the attempt at the gate.

import {
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  findStageBySlug,
  freshReviewReceipts,
  readStateFile,
  reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seedBoltDagBatches,
  seedStateFile,
} from "../harness/fixtures.ts";

const LOG_TOOL = join(AIDLC_SRC, "tools", "aidlc-log.ts");

setDefaultTimeout(30_000);
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
  const questions = join(dir, "requirements-analysis-questions.md");
  writeFileSync(questions, "# Requirements Questions\n", "utf-8");
  return artifact;
}

function recordArtifactUpdate(proj: string, artifact: string): void {
  appendAuditEntry("ARTIFACT_UPDATED", {
    File: artifact,
    Tool: "Edit",
    Context: "inception > requirements-analysis > requirements.md",
  }, proj);
}

function appendReview(
  artifact: string,
  iteration: number,
  verdict: "READY" | "NOT-READY" = "READY",
): void {
  appendFileSync(
    artifact,
    `\n## Review\n\n**Verdict:** ${verdict}\n**Reviewer:** aidlc-product-lead-agent\n**Iteration:** ${iteration}\n\n### Findings\n\nFixture review.\n`,
    "utf-8",
  );
}

describe("t291 stale review receipt recovery", () => {
  test("solo cross-shard ties retain legacy receipt and review-budget ordering", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-mid-inception.md");
    writeRequirements(proj, "reviewed requirements\n");
    const stage = findStageBySlug("requirements-analysis")!;
    const fingerprint = reviewArtifactFingerprint(proj, stage);
    const ts = "2026-08-20T00:00:00Z";
    const block = (event: string, fields: string) =>
      `## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${fields}\n---\n`;
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(
      join(seededAuditDir(proj), "aaaa-boundary.md"),
      block("WORKFLOW_STARTED", "**Scope**: feature"),
    );
    writeFileSync(
      join(seededAuditDir(proj), "zzzz-review.md"),
      block(
        "REVIEW_REQUESTED",
        "**Stage**: requirements-analysis\n**Reviewer**: aidlc-product-lead-agent\n" +
          `**Iteration**: 1\n**Artifact Fingerprint**: ${fingerprint}`,
      ) +
        block(
          "REVIEW_COMPLETED",
          "**Stage**: requirements-analysis\n**Reviewer**: aidlc-product-lead-agent\n" +
            `**Iteration**: 1\n**Verdict**: READY\n**Artifact Fingerprint**: ${fingerprint}`,
        ),
    );
    expect(
      freshReviewReceipts(proj, readStateFile(proj), stage).stageVerdict,
    ).toBe("READY");

    const budgetProj = createTestProject();
    tempDirs.push(budgetProj);
    seedAidlcMemory(budgetProj);
    seedStateFile(budgetProj, "state-mid-inception.md");
    const budgetState = readStateFile(budgetProj).replace(
      "- **Scope**: bugfix",
      "- **Scope**: enterprise",
    );
    writeFileSync(
      join(seededRecordDir(budgetProj), "aidlc-state.md"),
      budgetState,
      "utf-8",
    );
    seedBoltDagBatches(budgetProj, [["alpha"]]);
    const budgetStage = findStageBySlug("functional-design")!;
    const budgetDir = join(
      seededRecordDir(budgetProj),
      "construction",
      "alpha",
      "functional-design",
    );
    mkdirSync(budgetDir, { recursive: true });
    for (const name of [
      "entities.md",
      "rules.md",
      "functional-spec.md",
      "traceability.json",
    ]) {
      writeFileSync(join(budgetDir, name), `# ${name}\n`, "utf-8");
    }
    const budgetFingerprint = reviewArtifactFingerprint(
      budgetProj,
      budgetStage,
      "alpha",
    );
    mkdirSync(seededAuditDir(budgetProj), { recursive: true });
    writeFileSync(
      join(seededAuditDir(budgetProj), "aaaa-boundary.md"),
      block("WORKFLOW_STARTED", "**Scope**: feature"),
    );
    writeFileSync(
      join(seededAuditDir(budgetProj), "zzzz-review.md"),
      block(
        "REVIEW_REQUESTED",
        "**Stage**: functional-design\n**Reviewer**: aidlc-architecture-reviewer-agent\n" +
          `**Unit**: alpha\n**Iteration**: 1\n**Artifact Fingerprint**: ${budgetFingerprint}`,
      ) +
        block(
          "REVIEW_COMPLETED",
          "**Stage**: functional-design\n**Reviewer**: aidlc-architecture-reviewer-agent\n**Unit**: alpha\n" +
            `**Iteration**: 1\n**Verdict**: NOT-READY\n**Artifact Fingerprint**: ${budgetFingerprint}`,
        ),
    );
    const iterationTwo = run(
      LOG_TOOL,
      [
        "review",
        "--stage",
        "functional-design",
        "--reviewer",
        "aidlc-architecture-reviewer-agent",
        "--unit",
        "alpha",
        "--iteration",
        "2",
      ],
      budgetProj,
    );
    expect(iterationTwo.status, iterationTwo.out).toBe(0);
  });

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
    appendReview(artifact, 1);
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
      "output document changed after aidlc-product-lead-agent reviewed it",
    );
    expect(stale.out).toContain("one recovery review pass");

    const recovery = run(
      LOG_TOOL,
      [...review, "--iteration", "2"],
      proj,
    );
    expect(recovery.status).toBe(0);
    expect(recovery.stdout).toContain('"recovery":"stale-receipt"');
    appendReview(artifact, 2);
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
      "one recovery review was already used",
    );
    expect(spent.stderr).toContain("human Request Changes decision");
    expect(spent.stderr).toContain("human's behalf");
    expect(spent.stderr).toContain("restore the reviewed source state");
    expect(spent.stderr).toContain("/aidlc --stage requirements-analysis");
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
    appendReview(artifact, 1);
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
    appendReview(artifact, 2);
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
      "one recovery review was already used",
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
