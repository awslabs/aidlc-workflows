// covers: function:freshReviewReceipts, function:judgeFreeze,
// subcommand:aidlc-log:review, hook:aidlc-review-freeze

import {
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  freshReviewReceipts,
  loadStageGraphAll,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-review-freeze.ts");
const tempDirs: string[] = [];

setDefaultTimeout(30_000);

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function runLog(proj: string, args: string[]) {
  const result = spawnSync(
    BUN,
    [LOG, "review", ...args, "--project-dir", proj],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      },
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function reviewArtifactPath(
  proj: string,
  stage: string,
  unit?: string,
): string {
  const definition = loadStageGraphAll().find((entry) => entry.slug === stage);
  if (!definition?.review_artifact) {
    throw new Error(`${stage} has no review_artifact`);
  }
  const dir =
    definition.for_each === "unit-of-work"
      ? join(
          seededRecordDir(proj),
          definition.phase,
          unit ?? "unit-alpha",
          stage,
        )
      : join(seededRecordDir(proj), definition.phase, stage);
  return join(dir, `${definition.review_artifact}.md`);
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
  reviewer: string,
  iteration: number,
): void {
  appendFileSync(
    artifact,
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Iteration:** ${iteration}\n\n### Findings\n\nNo blocking findings.\n`,
    "utf-8",
  );
}

function recordReview(
  proj: string,
  stage: string,
  reviewer: string,
  unit?: string,
): void {
  const base = [
    "--stage",
    stage,
    "--reviewer",
    reviewer,
    ...(unit ? ["--unit", unit] : []),
    "--iteration",
    "1",
  ];
  const artifact = reviewArtifactPath(proj, stage, unit);
  stripReviewAppendix(artifact);
  const request = runLog(proj, base);
  if (request.status !== 0) {
    throw new Error(`review request failed: ${request.out}`);
  }
  appendReviewAppendix(artifact, reviewer, 1);
  const verdict = runLog(proj, [...base, "--verdict", "READY"]);
  if (verdict.status !== 0) {
    throw new Error(`review verdict failed: ${verdict.out}`);
  }
}

function runHook(proj: string, target: string) {
  const result = spawnSync(BUN, [HOOK], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target },
    }),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return {
    status: result.status ?? -1,
    stderr: result.stderr ?? "",
  };
}

function seedGitRepo(proj: string): string {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
    if ((result.status ?? -1) !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t321@example.com"]);
  git(["config", "user.name", "t321"]);
  const source = join(proj, "app.ts");
  writeFileSync(source, "export const value = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  return source;
}

function seedCodeGenerationOutputs(proj: string, unit: string): string {
  const dir = join(
    seededRecordDir(proj),
    "construction",
    unit,
    "code-generation",
  );
  mkdirSync(dir, { recursive: true });
  for (const name of [
    "code-generation-plan.md",
    "unit-test-instructions.md",
    "code-summary.md",
    "traceability.json",
  ]) {
    writeFileSync(join(dir, name), `# ${name} for ${unit}\n`);
  }
  writeFileSync(
    join(dir, "source-manifest.json"),
    `${JSON.stringify(
      {
        stage: "code-generation",
        unit,
        version: 1,
        writes: [],
      },
      null,
      2,
    )}\n`,
  );
  return join(dir, "code-generation-plan.md");
}

function auditBlock(
  timestamp: string,
  event: string,
  fields: Record<string, string>,
): string {
  return [
    "# AI-DLC Audit Log",
    "",
    `## ${event}`,
    `**Timestamp**: ${timestamp}`,
    `**Event**: ${event}`,
    ...Object.entries(fields).map(([key, value]) => `**${key}**: ${value}`),
    "",
    "---",
    "",
  ].join("\n");
}

describe("t321 request-bound source-recovery freeze suspension", () => {
  test("cross-shard session ties keep recovery retryable but never leave its write suspension active", () => {
    const timestamp = "2026-08-24T22:00:00Z";
    for (const sessionEvent of ["SESSION_STARTED", "SESSION_RESUMED"]) {
      for (const requestSortsFirst of [true, false]) {
        const proj = createTestProject();
        tempDirs.push(proj);
        seedAidlcMemory(proj);
        seedStateFile(proj, "state-construction.md");
        seedBoltDag(proj, ["alpha"]);
        const auditDir = seededAuditDir(proj);
        mkdirSync(auditDir, { recursive: true });
        const requestShard = requestSortsFirst
          ? "a-review.md"
          : "z-review.md";
        const sessionShard = requestSortsFirst
          ? "z-session.md"
          : "a-session.md";
        writeFileSync(
          join(auditDir, requestShard),
          auditBlock(timestamp, "REVIEW_REQUESTED", {
            Stage: "functional-design",
            Reviewer: "aidlc-architecture-reviewer-agent",
            Unit: "alpha",
            Iteration: "2",
            Recovery: "stale-receipt",
            "Artifact Fingerprint": `sha256:${"a".repeat(64)}`,
          }),
        );
        writeFileSync(
          join(auditDir, sessionShard),
          auditBlock(timestamp, sessionEvent, { Source: "test" }),
        );
        const stage = loadStageGraphAll().find(
          (entry) => entry.slug === "functional-design",
        );
        expect(stage).toBeDefined();
        const receipts = freshReviewReceipts(
          proj,
          readFileSync(seededStateFile(proj), "utf-8"),
          stage!,
          { reviewClass: "adversarial" },
        );
        expect(receipts.unitPending.get("alpha")).toEqual({
          state: "retry-required",
          iteration: 2,
          recovery: true,
          suspensionActive: false,
          recoveryCause: null,
        });
      }
    }
  });

  test("only the requested Unit thaws until the matching recovery verdict", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-construction-with-worktree.md");
    seedBoltDag(proj, ["alpha", "beta"]);
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace(
        "## Current Status",
        [
          "### INCEPTION REVIEW CONTROL",
          "- [-] requirements-analysis — EXECUTE",
          "",
          "## Current Status",
        ].join("\n"),
      ),
    );

    const source = seedGitRepo(proj);
    const alphaPlan = seedCodeGenerationOutputs(proj, "alpha");
    const betaPlan = seedCodeGenerationOutputs(proj, "beta");
    const requirementsDir = join(
      seededRecordDir(proj),
      "inception",
      "requirements-analysis",
    );
    mkdirSync(requirementsDir, { recursive: true });
    const requirements = join(requirementsDir, "requirements.md");
    writeFileSync(requirements, "# Requirements\n");
    writeFileSync(
      join(requirementsDir, "requirements-analysis-questions.md"),
      "# Questions\n",
    );

    recordReview(
      proj,
      "requirements-analysis",
      "aidlc-product-lead-agent",
    );
    recordReview(
      proj,
      "code-generation",
      "aidlc-architecture-reviewer-agent",
      "alpha",
    );
    recordReview(
      proj,
      "code-generation",
      "aidlc-architecture-reviewer-agent",
      "beta",
    );

    writeFileSync(source, "export const value = 2;\n");
    expect(runHook(proj, betaPlan).status).toBe(2);

    const recoveryArgs = [
      "--stage",
      "code-generation",
      "--reviewer",
      "aidlc-architecture-reviewer-agent",
      "--unit",
      "beta",
      "--iteration",
      "2",
    ];
    const recovery = runLog(proj, recoveryArgs);
    expect(recovery.status).toBe(0);
    expect(recovery.stdout).toContain('"recovery":"stale-receipt"');
    stripReviewAppendix(betaPlan);
    const recoveryReceipts = freshReviewReceipts(
      proj,
      readFileSync(seededStateFile(proj), "utf-8"),
      loadStageGraphAll().find((entry) => entry.slug === "code-generation")!,
      { reviewClass: "adversarial" },
    );
    expect(recoveryReceipts.unitPending.get("beta")?.recoveryCause).toBe(
      "source",
    );

    expect(runHook(proj, betaPlan).status).toBe(0);
    expect(runHook(proj, alphaPlan).status).toBe(2);
    expect(runHook(proj, requirements).status).toBe(2);

    writeFileSync(source, "export const value = 1;\n");
    expect(runHook(proj, betaPlan).status).toBe(2);

    writeFileSync(source, "export const value = 2;\n");
    expect(runHook(proj, betaPlan).status).toBe(0);

    Bun.sleepSync(1100);
    appendAuditEntry("SESSION_RESUMED", { Source: "resume" }, proj);
    expect(runHook(proj, betaPlan).status).toBe(2);
    const retry = runLog(proj, [...recoveryArgs, "--retry-pending"]);
    expect(retry.status, retry.stderr).toBe(0);
    expect(runHook(proj, betaPlan).status).toBe(0);

    const gate = spawnSync(
      BUN,
      [STATE, "gate-start", "code-generation", "--project-dir", proj],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        },
      },
    );
    expect(gate.status ?? -1).not.toBe(0);
    expect(`${gate.stdout ?? ""}${gate.stderr ?? ""}`).toContain(
      "recovery review for Unit beta is still in progress",
    );

    writeFileSync(betaPlan, "# code-generation-plan.md for beta\n\n## Review\n");
    appendAuditEntry(
      "ARTIFACT_UPDATED",
      { File: betaPlan, Tool: "Edit" },
      proj,
    );
    expect(runHook(proj, betaPlan).status).toBe(0);

    const staleVerdict = runLog(proj, [
      ...recoveryArgs,
      "--verdict",
      "READY",
    ]);
    expect(staleVerdict.status).not.toBe(0);
    expect(staleVerdict.stderr).toContain(
      "exactly one canonical verdict line matching --verdict",
    );

    stripReviewAppendix(betaPlan);
    appendReviewAppendix(
      betaPlan,
      "aidlc-architecture-reviewer-agent",
      2,
    );
    expect(
      runLog(proj, [...recoveryArgs, "--verdict", "READY"]).status,
    ).toBe(0);
    expect(runHook(proj, betaPlan).status).toBe(2);
  });
});
