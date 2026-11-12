// t-review-granularity-flow — the phase-review flow end to end, against the
// real dist CLI (the same boundary t263 pins for per-stage reviews):
//
//   1. Directive emit: under phase granularity a deferred inception stage's
//      run-stage directive carries no reviewer block, and the anchor's carries
//      review_covers naming the completed deferred stages.
//   2. Gate precondition: a deferred stage's gate opens and approves with no
//      receipt; the anchor's gate refuses until every covered stage's receipt
//      is recorded, naming the missing stage and the exact request command.
//   3. The logger accepts a review request for a covered, already-completed
//      stage (the grouped pass records per-stage receipts at the anchor).
//   4. Measurement: audit/review-metrics.jsonl gets one line per request and
//      per verdict, stamped with the effective granularity and findings counts.
//
// Stage granularity stays byte-for-byte today's behavior; t263 pins that side.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveStage,
  reviewArtifactEntries,
  setCheckbox,
  setField,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seededAuditDir,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const STATE_TOOL = join(TOOLS_DIR, "aidlc-state.ts");
const LOG_TOOL = join(TOOLS_DIR, "aidlc-log.ts");
const UTILITY_TOOL = join(TOOLS_DIR, "aidlc-utility.ts");
const ORCHESTRATE_TOOL = join(TOOLS_DIR, "aidlc-orchestrate.ts");

const TEST_ENV = {
  AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_DISABLE_SENSORS: "1",
};

const tempDirs: string[] = [];
resetAidlcEnv();
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function run(tool: string, args: string[], p: string) {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, ...TEST_ENV },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// The bugfix mid-inception fixture, re-shaped into an mvp-like inception run:
// the three product-lead stages (requirements-analysis, user-stories,
// refined-mockups) on the plan, requirements-analysis in progress.
function phaseProject(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, "state-mid-inception.md");
  const path = stateFilePath(p);
  let content = readFileSync(path, "utf-8");
  content = setField(content, "Scope", "mvp");
  for (const slug of ["user-stories", "refined-mockups"]) {
    content = content.replace(
      new RegExp(`^(- \\[.\\] ${slug}\\s*—\\s*)SKIP[^\\n]*$`, "m"),
      "$1EXECUTE",
    );
  }
  writeFileSync(path, content);
  const set = run(UTILITY_TOOL, ["config-change", "--review-granularity", "phase"], p);
  expect(set.status, set.out).toBe(0);
  return p;
}

function writeStageOutputs(p: string, slug: string): void {
  const node = resolveStage(slug);
  expect(node).toBeTruthy();
  for (const entry of reviewArtifactEntries(p, node!) ?? []) {
    if (entry.path === null || existsSync(entry.path)) continue;
    mkdirSync(dirname(entry.path), { recursive: true });
    writeFileSync(
      entry.path,
      entry.path.endsWith(".json") ? '{"ids":[]}\n' : `# ${entry.logicalPath}\n`,
      "utf-8",
    );
  }
}

// The per-clone measurement file beside the audit shards.
function metricsFile(p: string): string | undefined {
  const dir = seededAuditDir(p);
  return readdirSync(dir)
    .filter((name) => /^review-metrics-.*\.jsonl$/.test(name))
    .map((name) => join(dir, name))[0];
}

function recordReview(p: string, slug: string, reviewer: string, coveredBy?: string): void {
  writeStageOutputs(p, slug);
  const base = ["review", "--stage", slug, "--reviewer", reviewer, "--iteration", "1",
    ...(coveredBy === undefined ? [] : ["--covered-by", coveredBy])];
  const requested = run(LOG_TOOL, base, p);
  expect(requested.status, `request for ${slug}: ${requested.out}`).toBe(0);
  const { reviewFile } = JSON.parse(requested.out) as { reviewFile: string };
  mkdirSync(dirname(join(p, reviewFile)), { recursive: true });
  writeFileSync(
    join(p, reviewFile),
    `**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Iteration:** 1\n\n` +
      "### Findings\n\nNo blocking findings.\n",
    "utf-8",
  );
  const verdict = run(LOG_TOOL, [...base, "--verdict", "READY"], p);
  expect(verdict.status, `verdict for ${slug}: ${verdict.out}`).toBe(0);
}

function advanceToAnchor(p: string): void {
  const path = stateFilePath(p);
  let content = readFileSync(path, "utf-8");
  for (const slug of ["requirements-analysis", "user-stories"]) {
    content = setCheckbox(content, slug, "completed");
  }
  content = setCheckbox(content, "refined-mockups", "in-progress");
  content = setField(content, "Current Stage", "refined-mockups");
  content = setField(content, "In Progress", "refined-mockups");
  writeFileSync(path, content);
}

describe("t-review-granularity-flow (phase mode, real CLI)", () => {
  test("a deferred stage's directive drops the reviewer block; the anchor's carries review_covers", () => {
    const p = phaseProject();
    const deferred = runOrchestrateNext(ORCHESTRATE_TOOL, p, [], {
      env: { ...process.env, ...TEST_ENV },
    });
    expect(deferred.status, deferred.out).toBe(0);
    expect(deferred.directive?.kind, deferred.out).toBe("run-stage");
    expect(deferred.directive?.stage).toBe("requirements-analysis");
    expect(deferred.directive?.reviewer).toBeUndefined();
    expect(deferred.directive?.review_covers).toBeUndefined();
    // The gate's one plain-words sentence reads its anchor from here (§12a).
    expect(deferred.directive?.review_deferred).toEqual({
      anchor: "refined-mockups",
      anchor_name: "Refined Mockups",
    });

    advanceToAnchor(p);
    const anchor = runOrchestrateNext(ORCHESTRATE_TOOL, p, [], {
      env: { ...process.env, ...TEST_ENV },
    });
    expect(anchor.status, anchor.out).toBe(0);
    expect(anchor.directive?.stage, anchor.out).toBe("refined-mockups");
    expect(anchor.directive?.reviewer).toBe("aidlc-product-lead-agent");
    expect(anchor.directive?.review_class).toBe("advisory");
    expect(anchor.directive?.review_covers).toEqual([
      { slug: "requirements-analysis", name: "Requirements Analysis" },
      { slug: "user-stories", name: "User Stories" },
    ]);
  });

  test("a deferred stage's gate opens and approves with no receipt", () => {
    const p = phaseProject();
    writeStageOutputs(p, "requirements-analysis");
    const gate = run(STATE_TOOL, ["gate-start", "requirements-analysis"], p);
    expect(gate.status, gate.out).toBe(0);
    const approved = run(
      STATE_TOOL,
      ["approve", "requirements-analysis", "--user-input", "Approve"],
      p,
    );
    expect(approved.status, approved.out).toBe(0);
  });

  test("the anchor's gate stands on every covered receipt, then opens; metrics carry the granularity", () => {
    const p = phaseProject();
    writeStageOutputs(p, "requirements-analysis");
    run(STATE_TOOL, ["gate-start", "requirements-analysis"], p);
    run(STATE_TOOL, ["approve", "requirements-analysis", "--user-input", "Approve"], p);
    advanceToAnchor(p);

    // The anchor's own receipt alone is not enough: the gate refuses, naming
    // the covered stage that still owes its review and the exact command.
    recordReview(p, "refined-mockups", "aidlc-product-lead-agent");
    const refused = run(STATE_TOOL, ["gate-start", "refined-mockups"], p);
    expect(refused.status, refused.out).not.toBe(0);
    expect(refused.out).toContain("requirements-analysis");
    expect(refused.out).toContain("aidlc-log.ts review --stage requirements-analysis");

    // The grouped pass records each covered stage's own receipt — the logger
    // accepts a request for a completed stage — and the gate then opens.
    recordReview(p, "requirements-analysis", "aidlc-product-lead-agent", "refined-mockups");
    recordReview(p, "user-stories", "aidlc-product-lead-agent", "refined-mockups");
    const opened = run(STATE_TOOL, ["gate-start", "refined-mockups"], p);
    expect(opened.status, opened.out).toBe(0);
    const approved = run(
      STATE_TOOL,
      ["approve", "refined-mockups", "--user-input", "Approve"],
      p,
    );
    expect(approved.status, approved.out).toBe(0);

    const metricsPath = metricsFile(p);
    expect(metricsPath).toBeDefined();
    const rows = readFileSync(metricsPath!, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.granularity === "phase")).toBe(true);
    expect(rows.filter((row) => row.event === "request")).toHaveLength(3);
    const verdicts = rows.filter((row) => row.event === "verdict");
    expect(verdicts).toHaveLength(3);
    for (const row of verdicts) {
      expect(row.verdict).toBe("READY");
      expect(row.findings_total).toBe(0);
    }
    expect(new Set(rows.map((row) => row.stage))).toEqual(
      new Set(["refined-mockups", "requirements-analysis", "user-stories"]),
    );
  });

  test("the logger itself enforces the deferral: a per-stage dispatch at a deferred stage is refused", () => {
    const p = phaseProject();
    writeStageOutputs(p, "requirements-analysis");
    // An agent that read the stage file's reviewer and dispatched anyway.
    const rogue = run(LOG_TOOL, [
      "review", "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent", "--iteration", "1",
    ], p);
    expect(rogue.status).not.toBe(0);
    expect(rogue.out).toContain("Refined Mockups");
    expect(rogue.out).toContain("--covered-by");
    // A covered-by naming the wrong anchor is refused the same way.
    const wrong = run(LOG_TOOL, [
      "review", "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent", "--iteration", "1",
      "--covered-by", "contract-design",
    ], p);
    expect(wrong.status).not.toBe(0);
    expect(wrong.out).toContain("--covered-by");
    expect(wrong.out).toContain("refined-mockups");
    // A bare --person-asked (no proved message) lifts nothing: the person's
    // ask is their words on record, not the agent's say-so.
    const sayso = run(LOG_TOOL, [
      "review", "--stage", "requirements-analysis",
      "--reviewer", "aidlc-product-lead-agent", "--iteration", "1",
      "--person-asked",
    ], p);
    expect(sayso.status).not.toBe(0);
    expect(sayso.out).toContain("Refined Mockups");
    // No receipt or metrics row leaked from the refusals.
    expect(metricsFile(p)).toBeUndefined();
  });

  test("stage granularity logs metrics rows marked stage", () => {
    const p = createTestProject();
    tempDirs.push(p);
    seedAidlcMemory(p);
    seedStateFile(p, "state-mid-inception.md");
    recordReview(p, "requirements-analysis", "aidlc-product-lead-agent");
    const rows = readFileSync(metricsFile(p)!, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.granularity === "stage")).toBe(true);
  });
});
