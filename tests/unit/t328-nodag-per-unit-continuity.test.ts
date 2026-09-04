// covers: function:reviewAttemptWindow, function:freshReviewReceipts,
// subcommand:aidlc-log:review, subcommand:aidlc-bolt:start,
// subcommand:aidlc-bolt:complete, subcommand:aidlc-bolt:fail,
// subcommand:aidlc-runtime:compile

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  boltSlugForUnit,
  freshReviewReceipts,
  loadStageGraphAll,
  readAllAuditShards,
  reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const RUNTIME = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const STAGE = "functional-design";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
  out: string;
};

function run(tool: string, args: string[], proj: string): RunResult {
  const result = Bun.spawnSync({
    cmd: [BUN, tool, ...args, "--project-dir", proj],
    env: {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    },
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

function project(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-construction-bolt1.md");
  const statePath = seededStateFile(proj);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace(
      /^(- )\[ \]( functional-design .* EXECUTE)$/m,
      "$1[-]$2",
    ),
  );
  return proj;
}

function seedOutputs(proj: string, unit: string): void {
  const dir = join(
    seededRecordDir(proj),
    "construction",
    unit,
    STAGE,
  );
  mkdirSync(dir, { recursive: true });
  for (const name of [
    "entities.md",
    "rules.md",
    "functional-spec.md",
    "traceability.json",
  ]) {
    writeFileSync(join(dir, name), `# ${name} for ${unit}\n`);
  }
}

function seedStageOutputs(proj: string): void {
  const dir = join(seededRecordDir(proj), "construction", STAGE);
  mkdirSync(dir, { recursive: true });
  for (const name of [
    "entities.md",
    "rules.md",
    "functional-spec.md",
    "traceability.json",
  ]) {
    writeFileSync(join(dir, name), `# stage-level ${name}\n`);
  }
}

function startBolt(proj: string, unit: string, batch = "1"): void {
  appendAuditEntry(
    "BOLT_STARTED",
    {
      "Bolt names": unit,
      "Batch number": batch,
      "Walking skeleton": "false",
      "Bolt slug": boltSlugForUnit(unit),
    },
    proj,
  );
}

function completeBolt(proj: string, unit: string, batch = "1"): void {
  appendAuditEntry(
    "BOLT_COMPLETED",
    {
      "Bolt names": unit,
      "Batch number": batch,
      "Bolt slug": boltSlugForUnit(unit),
    },
    proj,
  );
}

// Merge evidence for a slug-backed completion: `aidlc-audit audit-merge`
// appends the worktree delta and this receipt to main only after the state
// merge succeeded, so a synthesized AUDIT_MERGED stands in for a landed
// merge sequence.
function confirmMerge(proj: string, unit: string, slug?: string): void {
  appendAuditEntry(
    "AUDIT_MERGED",
    {
      "Bolt slug": slug ?? boltSlugForUnit(unit),
      "Entries Merged": "1",
    },
    proj,
  );
}

function mergeBolt(proj: string, unit: string, batch = "1"): void {
  completeBolt(proj, unit, batch);
  confirmMerge(proj, unit);
}

function startNameOnlyBolt(
  proj: string,
  unit: string,
  batch = "1",
): void {
  const result = run(
    BOLT,
    ["start", "--name", unit, "--batch", batch],
    proj,
  );
  expect(result.status, result.out).toBe(0);
  expect(result.stdout).toContain('"emitted":"BOLT_STARTED"');
}

function completeNameOnlyBolt(
  proj: string,
  unit: string,
  batch = "1",
): void {
  const result = run(
    BOLT,
    ["complete", "--name", unit, "--batch", batch],
    proj,
  );
  expect(result.status, result.out).toBe(0);
  expect(result.stdout).toContain('"emitted":"BOLT_COMPLETED"');
}

function failBolt(proj: string, unit: string): void {
  const result = run(
    BOLT,
    ["fail", "--name", unit, "--error", "discarded"],
    proj,
  );
  expect(result.status, result.out).toBe(0);
  expect(result.stdout).toContain('"emitted":"BOLT_FAILED"');
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

function reviewArgs(
  unit: string | undefined,
  iteration: number,
  verdict?: "READY" | "NOT-READY",
  retryPending = false,
): string[] {
  return [
    "review",
    "--stage",
    STAGE,
    "--reviewer",
    REVIEWER,
    ...(unit ? ["--unit", unit] : []),
    "--iteration",
    String(iteration),
    ...(retryPending ? ["--retry-pending"] : []),
    ...(verdict ? ["--verdict", verdict] : []),
  ];
}

// The request opens this dispatch's review slot and names it in its JSON; the
// reviewer writes its review there and the verdict records it as the review
// record. Remember the slot per scope so a later verdict finds it.
const reviewFiles = new Map<string, string>();

function requestReview(
  proj: string,
  unit: string | undefined,
  iteration = 1,
  retryPending = false,
): RunResult {
  const result = run(LOG, reviewArgs(unit, iteration, undefined, retryPending), proj);
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as {
      reviewFile?: string;
    };
    if (typeof parsed.reviewFile === "string") {
      reviewFiles.set(`${unit ?? ""}\u0000${iteration}`, parsed.reviewFile);
    }
  }
  return result;
}

let reviewPass = 0;

function writeReviewFile(
  proj: string,
  unit: string | undefined,
  iteration: number,
): void {
  const reviewFile = reviewFiles.get(`${unit ?? ""}\u0000${iteration}`);
  if (!reviewFile) return;
  const absolute = join(proj, reviewFile);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    "## Review\n\n" +
      "**Verdict:** READY\n" +
      `**Reviewer:** ${REVIEWER}\n` +
      `**Iteration:** ${iteration}\n\n` +
      `### Findings\n\nNo blocking findings (pass ${++reviewPass}).\n`,
  );
}

function recordVerdict(
  proj: string,
  unit: string | undefined,
  iteration = 1,
): RunResult {
  writeReviewFile(proj, unit, iteration);
  return run(LOG, reviewArgs(unit, iteration, "READY"), proj);
}

function recordReview(proj: string, unit: string | undefined): void {
  const requested = requestReview(proj, unit);
  expect(requested.status, requested.out).toBe(0);
  expect(requested.stdout).toContain('"emitted":"REVIEW_REQUESTED"');
  const completed = recordVerdict(proj, unit);
  expect(completed.status, completed.out).toBe(0);
  expect(completed.stdout).toContain('"emitted":"REVIEW_COMPLETED"');
}

function finalize(proj: string): RunResult {
  return run(STATE, ["finalize", STAGE], proj);
}

function stageDefinition() {
  const stage = loadStageGraphAll().find((entry) => entry.slug === STAGE);
  if (!stage) throw new Error(`${STAGE} missing from stage graph`);
  return stage;
}

function receipts(proj: string) {
  return freshReviewReceipts(
    proj,
    readFileSync(seededStateFile(proj), "utf-8"),
    stageDefinition(),
    { reviewClass: "adversarial" },
  );
}

function forgeUnitReceipt(proj: string, unit: string): void {
  seedOutputs(proj, unit);
  const fingerprint = reviewArtifactFingerprint(
    proj,
    stageDefinition(),
    unit,
  );
  if (fingerprint === null) {
    throw new Error(`could not fingerprint forged receipt for ${unit}`);
  }
  const fields = {
    Stage: STAGE,
    Reviewer: REVIEWER,
    Unit: unit,
    Iteration: "1",
    "Artifact Fingerprint": fingerprint,
    "Review Appendix Artifact":
      `construction/${unit}/${STAGE}/functional-spec.md`,
    "Review Appendix Offset": "0",
  };
  appendAuditEntry("REVIEW_REQUESTED", fields, proj);
  appendAuditEntry(
    "REVIEW_COMPLETED",
    { ...fields, Verdict: "READY" },
    proj,
  );
}

describe("t328 no-DAG per-unit review continuity", () => {
  test("cross-shard completed and failed ties are order-independent and merged", () => {
    const timestamp = "2026-08-24T22:00:00Z";
    const outcomes: Array<{
      merged: string[];
      open: string[];
      owesReview: boolean;
    }> = [];
    for (const completedSortsFirst of [true, false]) {
      const proj = project();
      const auditDir = seededAuditDir(proj);
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "m-start.md"),
        auditBlock("2026-08-24T21:59:59Z", "BOLT_STARTED", {
          "Bolt names": "alpha",
          "Batch number": "1",
          "Walking skeleton": "false",
          "Bolt slug": boltSlugForUnit("alpha"),
        }),
      );
      const completedShard = completedSortsFirst
        ? "a-completed.md"
        : "z-completed.md";
      const failedShard = completedSortsFirst
        ? "z-failed.md"
        : "a-failed.md";
      writeFileSync(
        join(auditDir, completedShard),
        auditBlock(timestamp, "BOLT_COMPLETED", {
          "Bolt names": "alpha",
          "Batch number": "1",
          "Bolt slug": boltSlugForUnit("alpha"),
        }),
      );
      writeFileSync(
        join(auditDir, failedShard),
        auditBlock(timestamp, "BOLT_FAILED", {
          "Failed Bolt": "alpha",
          "Bolt slug": boltSlugForUnit("alpha"),
          "Error summary": "merge failed",
        }),
      );
      writeFileSync(
        join(auditDir, "m-merge.md"),
        auditBlock("2026-08-24T22:00:01Z", "AUDIT_MERGED", {
          "Bolt slug": boltSlugForUnit("alpha"),
          "Entries Merged": "1",
        }),
      );

      const refused = finalize(proj);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("merged Bolt unit alpha");
      const observed = receipts(proj);
      outcomes.push({
        merged: [...observed.mergedBoltUnits],
        open: [...observed.openBoltUnits],
        owesReview:
          refused.status !== 0 &&
          refused.out.includes("merged Bolt unit alpha"),
      });
    }
    expect(outcomes).toEqual([
      { merged: ["alpha"], open: [], owesReview: true },
      { merged: ["alpha"], open: [], owesReview: true },
    ]);
  });

  test("cross-shard started and completed ties are order-independent and merged", () => {
    const timestamp = "2026-08-24T22:00:00Z";
    const outcomes: Array<{
      merged: string[];
      open: string[];
      owesReview: boolean;
    }> = [];
    for (const startedSortsFirst of [true, false]) {
      const proj = project();
      seedOutputs(proj, "alpha");
      const auditDir = seededAuditDir(proj);
      mkdirSync(auditDir, { recursive: true });
      const startedShard = startedSortsFirst
        ? "a-started.md"
        : "z-started.md";
      const completedShard = startedSortsFirst
        ? "z-completed.md"
        : "a-completed.md";
      writeFileSync(
        join(auditDir, startedShard),
        auditBlock(timestamp, "BOLT_STARTED", {
          "Bolt names": "alpha",
          "Batch number": "1",
          "Walking skeleton": "false",
          "Bolt slug": boltSlugForUnit("alpha"),
        }),
      );
      writeFileSync(
        join(auditDir, completedShard),
        auditBlock(timestamp, "BOLT_COMPLETED", {
          "Bolt names": "alpha",
          "Batch number": "1",
          "Bolt slug": boltSlugForUnit("alpha"),
        }),
      );
      writeFileSync(
        join(auditDir, "m-merge.md"),
        auditBlock("2026-08-24T22:00:01Z", "AUDIT_MERGED", {
          "Bolt slug": boltSlugForUnit("alpha"),
          "Entries Merged": "1",
        }),
      );

      const refused = finalize(proj);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("merged Bolt unit alpha");
      const request = requestReview(proj, "alpha");
      expect(request.status, request.out).toBe(0);
      const observed = receipts(proj);
      outcomes.push({
        merged: [...observed.mergedBoltUnits],
        open: [...observed.openBoltUnits],
        owesReview:
          refused.status !== 0 &&
          refused.out.includes("merged Bolt unit alpha"),
      });
    }
    expect(outcomes).toEqual([
      { merged: ["alpha"], open: [], owesReview: true },
      { merged: ["alpha"], open: [], owesReview: true },
    ]);
  });

  test("same-shard terminal order survives an unrelated cross-shard tie", () => {
    const timestamp = "2026-08-25T00:00:00Z";
    for (const unrelatedSortsFirst of [true, false]) {
      const proj = project();
      const auditDir = seededAuditDir(proj);
      mkdirSync(auditDir, { recursive: true });
      const boltShard = unrelatedSortsFirst
        ? "z-bolt.md"
        : "a-bolt.md";
      const unrelatedShard = unrelatedSortsFirst
        ? "a-session.md"
        : "z-session.md";
      writeFileSync(
        join(auditDir, boltShard),
        [
          auditBlock("2026-08-24T23:59:59Z", "BOLT_STARTED", {
            "Bolt names": "alpha",
            "Batch number": "1",
            "Walking skeleton": "false",
            "Bolt slug": boltSlugForUnit("alpha"),
          }),
          auditBlock(timestamp, "BOLT_COMPLETED", {
            "Bolt names": "alpha",
            "Batch number": "1",
            "Bolt slug": boltSlugForUnit("alpha"),
          }),
          auditBlock(timestamp, "BOLT_FAILED", {
            "Failed Bolt": "alpha",
            "Bolt slug": boltSlugForUnit("alpha"),
            "Error summary": "merge failed",
          }),
        ].join(""),
      );
      writeFileSync(
        join(auditDir, unrelatedShard),
        auditBlock(timestamp, "SESSION_RESUMED", { Source: "other clone" }),
      );

      const observed = receipts(proj);
      expect([...observed.mergedBoltUnits]).toEqual([]);
      expect([...observed.openBoltUnits]).toEqual([]);
    }
  });

  test("older merged and newer open attempts coexist and retain review receipts", () => {
    for (const newerSlug of ["alpha-new", null]) {
      const proj = project();
      seedOutputs(proj, "alpha");
      const auditDir = seededAuditDir(proj);
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "m-attempts.md"),
        [
          auditBlock("2026-08-25T00:00:00Z", "BOLT_STARTED", {
            "Bolt names": "alpha",
            "Batch number": "1",
            "Walking skeleton": "false",
            "Bolt slug": "alpha-old",
          }),
          auditBlock("2026-08-25T00:00:01Z", "BOLT_STARTED", {
            "Bolt names": "alpha",
            "Batch number": "2",
            "Walking skeleton": "false",
            ...(newerSlug === null ? {} : { "Bolt slug": newerSlug }),
          }),
          auditBlock("2026-08-25T00:00:02Z", "BOLT_COMPLETED", {
            "Bolt names": "alpha",
            "Batch number": "1",
            "Bolt slug": "alpha-old",
          }),
          auditBlock("2026-08-25T00:00:03Z", "AUDIT_MERGED", {
            "Bolt slug": "alpha-old",
            "Entries Merged": "1",
          }),
        ].join(""),
      );

      const beforeReview = receipts(proj);
      expect([...beforeReview.mergedBoltUnits]).toEqual(["alpha"]);
      expect([...beforeReview.openBoltUnits]).toEqual(["alpha"]);
      const refused = finalize(proj);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("merged Bolt unit alpha");

      const request = requestReview(proj, "alpha");
      expect(request.status, request.out).toBe(0);
      expect(recordVerdict(proj, "alpha").status).toBe(0);
      const afterReview = receipts(proj);
      expect(afterReview.unitVerdicts.has("alpha")).toBe(true);
      expect([...afterReview.mergedBoltUnits]).toEqual(["alpha"]);
      expect([...afterReview.openBoltUnits]).toEqual(["alpha"]);
      expect(finalize(proj).status).toBe(0);
    }
  });

  test("merged per-unit receipts survive compile and satisfy completion without a stage receipt", () => {
    const proj = project();
    for (const unit of ["alpha", "beta"]) {
      seedOutputs(proj, unit);
      startBolt(proj, unit);
    }
    recordReview(proj, "alpha");
    recordReview(proj, "beta");
    mergeBolt(proj, "alpha");
    mergeBolt(proj, "beta");

    const compile = run(RUNTIME, ["compile"], proj);
    expect(compile.status, compile.out).toBe(0);

    const result = finalize(proj);
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toMatch(
      /- \[x\] functional-design .* EXECUTE/,
    );

    const observed = receipts(proj);
    expect([...observed.mergedBoltUnits].sort()).toEqual(["alpha", "beta"]);
    expect([...observed.openBoltUnits]).toEqual([]);
    expect(observed.stageVerdict).toBeNull();
    expect([...observed.unitVerdicts.keys()].sort()).toEqual(["alpha", "beta"]);

    const audit = readAllAuditShards(proj);
    expect(audit.match(/\*\*Event\*\*: REVIEW_COMPLETED/g)?.length).toBe(2);
    const completedBlocks = audit
      .split(/\n---\n/)
      .filter(
        (block) =>
          block.includes("**Event**: REVIEW_COMPLETED") &&
          block.includes("**Stage**: functional-design"),
      );
    expect(completedBlocks).toHaveLength(2);
    expect(completedBlocks.every((block) => block.includes("**Unit**:"))).toBe(
      true,
    );
  });

  test("a missing merged-unit verdict refuses with an executable per-unit request", () => {
    const proj = project();
    for (const unit of ["alpha", "beta"]) {
      seedOutputs(proj, unit);
      startNameOnlyBolt(proj, unit);
    }
    recordReview(proj, "alpha");
    completeNameOnlyBolt(proj, "alpha");
    mergeBolt(proj, "beta");

    const refused = finalize(proj);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("merged Bolt unit beta");
    expect(refused.out).toContain(
      "aidlc-log.ts review --stage functional-design --unit beta",
    );
    expect(refused.out).toContain("--iteration 1");

    const executable = requestReview(proj, "beta");
    expect(executable.status, executable.out).toBe(0);
    expect(recordVerdict(proj, "beta").status).toBe(0);
    expect(finalize(proj).status).toBe(0);
  });

  test("a forged historyless receipt cannot satisfy with or without observed units", () => {
    const withoutObserved = project();
    forgeUnitReceipt(withoutObserved, "ghost");
    const noHistory = finalize(withoutObserved);
    expect(noHistory.status).not.toBe(0);
    expect(noHistory.out).toContain("has not reviewed the current output");

    const withObserved = project();
    seedOutputs(withObserved, "alpha");
    startBolt(withObserved, "alpha");
    mergeBolt(withObserved, "alpha");
    forgeUnitReceipt(withObserved, "ghost");
    const refused = finalize(withObserved);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("merged Bolt unit alpha");
    expect(refused.out).not.toContain("merged Bolt unit ghost");
    const observed = receipts(withObserved);
    expect(observed.mergedBoltUnits.has("alpha")).toBe(true);
    expect(observed.unitVerdicts.has("ghost")).toBe(false);
  });

  test("a discarded Bolt unit owes no review", () => {
    const proj = project();
    for (const unit of ["alpha", "beta"]) {
      seedOutputs(proj, unit);
      startBolt(proj, unit);
    }
    recordReview(proj, "alpha");
    mergeBolt(proj, "alpha");
    completeBolt(proj, "beta");
    failBolt(proj, "beta");

    const result = finalize(proj);
    expect(result.status, result.out).toBe(0);
    const observed = receipts(proj);
    expect([...observed.mergedBoltUnits]).toEqual(["alpha"]);
    expect(observed.openBoltUnits.size).toBe(0);
  });

  test("post-merge requests and pending retries remain reachable, but historyless units refuse", () => {
    const proj = project();
    seedOutputs(proj, "alpha");
    seedOutputs(proj, "ghost");
    startBolt(proj, "alpha");
    mergeBolt(proj, "alpha");

    const request = requestReview(proj, "alpha");
    expect(request.status, request.out).toBe(0);
    expect(request.stdout).not.toContain('"retry"');
    const freshRequest = readAllAuditShards(proj)
      .split(/\n---\n/)
      .find(
        (block) =>
          block.includes("**Event**: REVIEW_REQUESTED") &&
          block.includes("**Unit**: alpha"),
      );
    expect(freshRequest).toBeDefined();
    expect(freshRequest).not.toContain("**Retry**:");
    const retry = requestReview(proj, "alpha", 1, true);
    expect(retry.status, retry.out).toBe(0);
    expect(retry.stdout).toContain('"retry":"pending-request"');
    const verdict = recordVerdict(proj, "alpha");
    expect(verdict.status, verdict.out).toBe(0);

    const ghost = requestReview(proj, "ghost");
    expect(ghost.status).not.toBe(0);
    expect(ghost.out).toContain(
      "no matching active or merged Bolt attempt was found",
    );
    expect(ghost.out).toContain("aidlc-bolt.ts start");
    expect(ghost.out).toContain("ghost");
    expect(ghost.out).toContain("--batch 1");
    expect(readAllAuditShards(proj)).not.toMatch(
      /\*\*Event\*\*: REVIEW_REQUESTED[\s\S]*?\*\*Unit\*\*: ghost/,
    );
  });

  test("a fresh stage-level receipt still satisfies when merged units exist", () => {
    const proj = project();
    for (const unit of ["alpha", "beta"]) {
      seedOutputs(proj, unit);
      startBolt(proj, unit);
      mergeBolt(proj, unit);
    }
    recordReview(proj, undefined);

    const observed = receipts(proj);
    expect(observed.stageVerdict).toBe("READY");
    expect(observed.unitVerdicts.size).toBe(0);
    const result = finalize(proj);
    expect(result.status, result.out).toBe(0);
  });

  test("an open-only stage review uses fallback paths and goes stale after merge", () => {
    const proj = project();
    // The stage-level fallback needs a real append owner on disk: the
    // review request must snapshot the stage-level review_artifact file.
    seedStageOutputs(proj);
    startBolt(proj, "alpha");

    const request = requestReview(proj, undefined);
    expect(request.status, request.out).toBe(0);
    const verdict = recordVerdict(proj, undefined);
    expect(verdict.status, verdict.out).toBe(0);
    const beforeMerge = receipts(proj);

    mergeBolt(proj, "alpha");
    const afterMerge = receipts(proj);
    const refused = finalize(proj);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("merged Bolt unit alpha");

    expect(beforeMerge.stageVerdict).toBe("READY");
    expect(beforeMerge.mergedBoltUnits.size).toBe(0);
    expect([...beforeMerge.openBoltUnits]).toEqual(["alpha"]);
    expect(afterMerge.stageVerdict).toBeNull();
    expect(afterMerge.stageStale).toBe(true);
    expect([...afterMerge.mergedBoltUnits]).toEqual(["alpha"]);
  });

  test("a worktree completion without merge evidence stays pending and recovers once the merge lands", () => {
    const proj = project();
    seedOutputs(proj, "alpha");
    startBolt(proj, "alpha");
    completeBolt(proj, "alpha");

    // Crash window: `aidlc-bolt complete --merge` emits BOLT_COMPLETED
    // before the state and audit merges. Completion alone is pending, not
    // merged: the gate must not demand or accept a post-merge review yet.
    const pending = receipts(proj);
    expect([...pending.mergedBoltUnits]).toEqual([]);
    expect([...pending.openBoltUnits]).toEqual(["alpha"]);
    const refused = finalize(proj);
    expect(refused.status).not.toBe(0);
    expect(refused.out).not.toContain("merged Bolt unit alpha");
    const premature = requestReview(proj, "alpha");
    expect(premature.status).not.toBe(0);
    expect(premature.out).toContain(
      "no matching active or merged Bolt attempt was found",
    );

    // Recovery: re-running complete --merge lands AUDIT_MERGED, which
    // confirms the pending completion and opens the per-unit review path.
    confirmMerge(proj, "alpha");
    const merged = receipts(proj);
    expect([...merged.mergedBoltUnits]).toEqual(["alpha"]);
    expect([...merged.openBoltUnits]).toEqual([]);
    const owes = finalize(proj);
    expect(owes.status).not.toBe(0);
    expect(owes.out).toContain("merged Bolt unit alpha");
    recordReview(proj, "alpha");
    expect(finalize(proj).status).toBe(0);
  });

  test("a slugless completion cannot close a slug-backed attempt", () => {
    const proj = project();
    seedOutputs(proj, "alpha");
    startBolt(proj, "alpha");
    appendAuditEntry(
      "BOLT_COMPLETED",
      { "Bolt names": "alpha", "Batch number": "1" },
      proj,
    );

    const observed = receipts(proj);
    expect([...observed.mergedBoltUnits]).toEqual([]);
    expect([...observed.openBoltUnits]).toEqual(["alpha"]);
    const refused = finalize(proj);
    expect(refused.status).not.toBe(0);
    expect(refused.out).not.toContain("merged Bolt unit alpha");
  });

  test("a fragment-cleanup failure after merge evidence keeps the unit merged", () => {
    const proj = project();
    seedOutputs(proj, "alpha");
    startBolt(proj, "alpha");
    mergeBolt(proj, "alpha");
    appendAuditEntry(
      "BOLT_FAILED",
      {
        "Failed Bolt": "alpha",
        "Bolt slug": boltSlugForUnit("alpha"),
        "Error summary": "fragment-merge-failed",
      },
      proj,
    );

    const observed = receipts(proj);
    expect([...observed.mergedBoltUnits]).toEqual(["alpha"]);
    expect([...observed.openBoltUnits]).toEqual([]);
    const refused = finalize(proj);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("merged Bolt unit alpha");
    recordReview(proj, "alpha");
    expect(finalize(proj).status).toBe(0);
  });

  test("a same-second cross-shard AUDIT_MERGED does not make a team review receipt ambiguous", () => {
    const proj = project();
    seedOutputs(proj, "alpha");
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace(
        "- **Revision Count**: 0",
        "- **Revision Count**: 0\n- **Unit Ownership**: team",
      ),
    );
    const fingerprint = reviewArtifactFingerprint(
      proj,
      stageDefinition(),
      "alpha",
    );
    if (fingerprint === null) {
      throw new Error("could not fingerprint alpha outputs");
    }
    const fields = {
      Stage: STAGE,
      Reviewer: REVIEWER,
      Unit: "alpha",
      Iteration: "1",
      "Artifact Fingerprint": fingerprint,
      "Review Appendix Artifact":
        `construction/alpha/${STAGE}/functional-spec.md`,
      "Review Appendix Offset": "0",
    };
    const timestamp = "2026-08-25T02:00:00Z";
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      join(auditDir, "m-bolt.md"),
      [
        auditBlock("2026-08-25T01:59:59Z", "BOLT_STARTED", {
          "Bolt names": "alpha",
          "Batch number": "1",
          "Walking skeleton": "false",
          "Bolt slug": boltSlugForUnit("alpha"),
        }),
        auditBlock("2026-08-25T01:59:59Z", "BOLT_COMPLETED", {
          "Bolt names": "alpha",
          "Batch number": "1",
          "Bolt slug": boltSlugForUnit("alpha"),
        }),
      ].join(""),
    );
    writeFileSync(
      join(auditDir, "a-review.md"),
      [
        auditBlock(timestamp, "REVIEW_REQUESTED", fields),
        auditBlock(timestamp, "REVIEW_COMPLETED", {
          ...fields,
          Verdict: "READY",
        }),
      ].join(""),
    );
    // The merge receipt lands in another shard within the same second. It
    // carries no reviewer authority, so the request/verdict pair above must
    // stay matched instead of failing closed as an unordered tie.
    writeFileSync(
      join(auditDir, "z-merge.md"),
      auditBlock(timestamp, "AUDIT_MERGED", {
        "Bolt slug": boltSlugForUnit("alpha"),
        "Entries Merged": "1",
      }),
    );

    const observed = receipts(proj);
    expect([...observed.mergedBoltUnits]).toEqual(["alpha"]);
    expect(observed.unitVerdicts.get("alpha")).toBe("READY");
    expect(observed.unitStale.has("alpha")).toBe(false);
  });
});
