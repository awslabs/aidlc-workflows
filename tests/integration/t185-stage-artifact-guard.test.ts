// covers: cli:aidlc-state(approve,advance,finalize,complete-workflow), function:handleApprove, function:handleAdvance, function:handleFinalize, function:handleCompleteWorkflow, function:verifyStageArtifacts, function:producesArtifactsExist, function:workspaceHasSourceFile, function:checkSummaryConfirmationEvidence, function:readAuditShardEvents, function:summaryConfirmationAnswer, function:summaryConfirmationContentHash, function:visibleMarkdownLines
//
// t185 - stage-completion artifact guard (issue #366).
//
// Mechanism: cli. The subject is the deterministic filesystem guard the state
// tool runs BEFORE marking a stage complete on the four forward-completion
// paths - `approve` ([?] -> [x] + auto-advance), a direct `advance` (the
// gate-skip attack path), `finalize`, and `complete-workflow`. Each terminates
// with process.exit on a guard failure, and the guard reads the project's
// per-intent record dir + workspace tree, so this is a PROCESS boundary
// exercised by spawning the real dist tool (spawnSync(BUN, [STATE, ...])).
//
// V2 PATH NOTE: the workspace refactor (#429) removed the flat aidlc-docs/
// layout. A stage's produces[] artifacts now live under the ACTIVE intent's
// per-intent record dir (aidlc/spaces/<space>/intents/<slug>-<id8>/<phase>/
// <stage>/), per-unit Construction artifacts under that record's
// construction/<unit>/<stage>/, and codekb stages (reverse-engineering) under
// the space-level aidlc/spaces/<space>/codekb/<repo>/. This test seeds those
// live seams via seededRecordDir, NOT a flat aidlc-docs/ tree.
//
// Source under test (dist/claude/.claude/tools/aidlc-state.ts):
//   verifyStageArtifacts(pd, stage) - two layers:
//     1. producesArtifactsExist - a normal stage that declares produces[] must
//        have at least one declared .md on disk under
//        <record>/<phase>/<slug>/ (or
//        <record>/construction/<unit>/<slug>/ for per-unit stages). Codekb
//        stages require every declared artifact in every registered repo's
//        canonical <space>/codekb/<repo>/ directory. Empty-produces stages
//        vacuously pass.
//     2. workspace_requires - a code-producing stage (frontmatter flag, set on
//        code-generation) must ALSO have a file outside the aidlc/ workspace
//        tree + harness dirs (issue #366 Update 2: docs-only code-generation
//        must not pass).
//   Bypass: AIDLC_SKIP_ARTIFACT_GUARD=1 (env).
//
// CRITICAL test-harness note: run-tests.ts sets AIDLC_SKIP_ARTIFACT_GUARD=1 for
// the whole suite (most state tests rubber-stamp bare fixtures by design). This
// test re-enables enforcement by DELETING that var from the spawned tool's env
// - otherwise it would be testing the bypass, not the guard.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedBoltDag,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  pipelineAttemptStartedAt,
  SUMMARY_CONFIRMATION_HASH_SCOPE,
  sourceBaselineAuditFields,
  summaryConfirmationContentHash,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
setDefaultTimeout(30_000);

const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const MID_IDEATION = "state-mid-ideation.md"; // Current Stage: feasibility
let handoffClock = 0;

function ensurePipelineAttemptStarted(proj: string): void {
  if (pipelineAttemptStartedAt(proj, "reverse-engineering")) return;
  appendAuditEntry(
    "STAGE_STARTED",
    { Stage: "reverse-engineering", Agent: "aidlc-developer-agent" },
    proj,
  );
}

function reviewStage(
  proj: string,
  stage: string,
  reviewer: string,
  unit?: string,
): void {
  const artifact =
    stage === "intent-capture"
      ? join(
          seededRecordDir(proj),
          "ideation",
          stage,
          "intent-statement.md",
        )
      : join(
          seededRecordDir(proj),
          "construction",
          ...(unit ? [unit] : []),
          stage,
          "code-generation-plan.md",
        );
  mkdirSync(dirname(artifact), { recursive: true });
  const current = existsSync(artifact)
    ? readFileSync(artifact, "utf-8")
    : `# ${basename(artifact)}\n`;
  writeFileSync(
    artifact,
    `${current
      .replace(
        /(?:^|\r?\n)## Review[ \t]*(?:\r?\n|$)[\s\S]*$/,
        "",
      )
      .trimEnd()}\n`,
  );
  if (stage === "code-generation" && unit) {
    let unitIsResolved = false;
    try {
      const graph = JSON.parse(
        readFileSync(join(seededRecordDir(proj), "runtime-graph.json"), "utf-8"),
      ) as { bolt_dag?: { units?: Array<{ name?: unknown }> } };
      unitIsResolved =
        graph.bolt_dag?.units?.some((candidate) => candidate.name === unit) === true;
    } catch {
      // Seed a focused DAG below.
    }
    if (!unitIsResolved) seedBoltDag(proj, [unit]);

    const dir = join(
      seededRecordDir(proj),
      "construction",
      unit,
      "code-generation",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "source-manifest.json"),
      `${JSON.stringify({
        stage: "code-generation",
        unit,
        version: 1,
        writes: [{ path: "src/" }],
      }, null, 2)}\n`,
    );
  }
  const args = [
    LOG,
    "review",
    "--stage",
    stage,
    "--reviewer",
    reviewer,
    "--iteration",
    "1",
    "--project-dir",
    proj,
  ];
  if (unit) args.splice(4, 0, "--unit", unit);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Several artifact-guard fixtures are deliberately non-Git. Source binding
  // cannot be computed there, so isolate the artifact-guard contract with the
  // documented freshness switch while still requiring a valid manifest.
  env.AIDLC_SKIP_SOURCE_FRESHNESS = "1";
  // These fixtures assert the artifact guard, not review admission: the
  // documented switches keep Plan Approval and summary confirmation out of it.
  env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD = "1";
  env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = "1";
  const requested = spawnSync(BUN, args, { encoding: "utf-8", env });
  if ((requested.status ?? -1) !== 0) {
    throw new Error(
      `reviewStage request failed: ${requested.stdout}${requested.stderr}`,
    );
  }
  appendFileSync(
    artifact,
    [
      "",
      "## Review",
      "",
      "**Verdict:** READY",
      `**Reviewer:** ${reviewer}`,
      "**Date:** 2026-08-26T00:00:00Z",
      "**Iteration:** 1",
      "",
    ].join("\n"),
  );
  const completed = spawnSync(BUN, [...args, "--verdict", "READY"], {
    encoding: "utf-8",
    env,
  });
  if ((completed.status ?? -1) !== 0) {
    throw new Error(
      `reviewStage verdict failed: ${completed.stdout}${completed.stderr}`,
    );
  }
}

function reviewCodeGen(proj: string, unit?: string): void {
  reviewStage(
    proj,
    "code-generation",
    "aidlc-architecture-reviewer-agent",
    unit,
  );
}

// Drive a state subcommand with the artifact guard ENABLED (clear the suite's
// bypass var). Returns exit code + combined output.
function guarded(
  proj: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { rc: number; out: string } {
  const env = { ...process.env, ...extraEnv };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Same but with the bypass var set - proves the escape hatch.
function bypassed(proj: string, args: string[]): { rc: number; out: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SOURCE_FRESHNESS: "1",
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  };
  delete env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function gateSetupBypassed(proj: string, args: string[]): { rc: number; out: string } {
  const env = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  };
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function summaryGuarded(proj: string, args: string[]): { rc: number; out: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  };
  delete env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function summaryReportGuarded(
  proj: string,
  args: string[],
): { rc: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  const r = spawnSync(BUN, [ORCHESTRATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function field(proj: string, name: string): string {
  return guarded(proj, ["get", name]).out.trim();
}

// Write a stage's produces[] doc under the ACTIVE intent's record dir so the
// produces-existence layer is satisfied. `rel` is relative to the record dir
// (e.g. "ideation/feasibility/feasibility-assessment.md").
function writeRecordDoc(proj: string, rel: string): void {
  const full = join(seededRecordDir(proj), rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "# stub\n\n## A\n\n## B\n");
}

function writeSummaryQuestions(
  proj: string,
  answer = "",
  stage = "feasibility",
): string {
  const full = join(
    seededRecordDir(proj),
    "ideation",
    stage,
    `${stage}-questions.md`,
  );
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    [
      "# Questions",
      "",
      "## Sources",
      "",
      "- [desc] Initial description: Build a purchasing workflow.",
      "",
      "## Q1. Is the proposed approach feasible?",
      "",
      "A. Proceed",
      "X. Other (please specify)",
      "",
      "[Answer]: A. Proceed",
      "",
      "## Q2. Which review mode should be used?",
      "",
      "A. Human review",
      "X. Other (please specify)",
      "",
      "[Answer]: A. Human review",
      "",
      "## Consolidated Summary Confirmation",
      "",
      "- Proceed with a purchasing workflow.",
      "",
      "- Looks correct",
      "- Request changes",
      "",
      `[Answer]: ${answer}`,
      "",
    ].join("\n"),
  );
  return full;
}

function appendAudit(
  proj: string,
  event: string,
  fields: Record<string, string> = {},
): void {
  appendAuditEntry(event, fields, proj);
}

function writeAuditShardRows(
  proj: string,
  name: string,
  rows: Array<{
    timestamp: string;
    event: string;
    fields?: Record<string, string>;
  }>,
): void {
  const dir = dirname(seededAuditShard(proj));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    `${rows.map((row) => [
      `## ${row.event}`,
      `**Timestamp**: ${row.timestamp}`,
      `**Event**: ${row.event}`,
      ...Object.entries(row.fields ?? {}).map(([key, value]) =>
        `**${key}**: ${value}`
      ),
    ].join("\n")).join("\n---\n")}\n\n---\n`,
  );
}

function scopedSummaryReceiptFields(
  proj: string,
  questions: string,
  details = "Looks correct",
): Record<string, string> {
  return {
    Stage: "feasibility",
    Details: details,
    Checkpoint: "Consolidated Summary Confirmation",
    "Questions File": relative(proj, questions).replaceAll("\\", "/"),
    "Questions SHA-256": summaryConfirmationContentHash(
      readFileSync(questions, "utf-8"),
    ),
    "Hash Scope": SUMMARY_CONFIRMATION_HASH_SCOPE,
  };
}

function appendSummaryReceipt(
  proj: string,
  questions: string,
  hashScope?: string,
): void {
  const fields: Record<string, string> = {
    Stage: "feasibility",
    Details: "Looks correct",
    Checkpoint: "Consolidated Summary Confirmation",
    "Questions File": relative(proj, questions).replaceAll("\\", "/"),
    "Questions SHA-256": createHash("sha256")
      .update(readFileSync(questions))
      .digest("hex"),
  };
  if (hashScope) fields["Hash Scope"] = hashScope;
  appendAudit(proj, "SUMMARY_CONFIRMATION_RECORDED", fields);
}

function confirmSummary(
  proj: string,
  questions: string,
  stage = "feasibility",
  confirmedBody?: string,
): void {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const decision = spawnSync(BUN, [
    LOG,
    "decision",
    "--stage",
    stage,
    "--checkpoint",
    "summary-confirmation",
    "--questions-file",
    questions,
    "--decision",
    "Does this all look correct?",
    "--project-dir",
    proj,
  ], { encoding: "utf-8", env });
  expect(decision.status).toBe(0);
  appendAudit(proj, "HUMAN_TURN");
  if (confirmedBody === undefined) {
    writeSummaryQuestions(proj, "Looks correct", stage);
  } else {
    writeFileSync(questions, confirmedBody);
  }
  const answer = spawnSync(BUN, [
    LOG,
    "answer",
    "--stage",
    stage,
    "--checkpoint",
    "summary-confirmation",
    "--questions-file",
    questions,
    "--details",
    "Looks correct",
    "--project-dir",
    proj,
  ], { encoding: "utf-8", env });
  expect(answer.status).toBe(0);
}

function recordArtifactWrite(proj: string, rel: string): string {
  const full = join(seededRecordDir(proj), rel);
  writeRecordDoc(proj, rel);
  appendAudit(proj, "ARTIFACT_CREATED", { File: full, Tool: "Write" });
  return full;
}

function summaryMutationResult(
  proj: string,
  mutate: (body: string) => string,
): { rc: number; out: string } {
  const questions = writeSummaryQuestions(proj);
  confirmSummary(proj, questions);
  writeFileSync(questions, mutate(readFileSync(questions, "utf-8")));
  recordArtifactWrite(
    proj,
    "ideation/feasibility/feasibility-assessment.md",
  );
  return summaryGuarded(proj, ["advance", "feasibility"]);
}

// Write a file at the workspace root (outside the aidlc/ tree + harness dirs).
function writeWorkspaceFile(proj: string, rel: string): void {
  const full = join(proj, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "export const x = 1;\n");
}

const RE_PRODUCES = [
  "business-overview",
  "architecture",
  "code-structure",
  "api-documentation",
  "component-inventory",
  "technology-stack",
  "dependencies",
  "code-quality-assessment",
  "reverse-engineering-timestamp",
];

function rewriteIntentRepos(proj: string, repos: string[]): void {
  const registry = join(
    proj,
    "aidlc",
    "spaces",
    "default",
    "intents",
    "intents.json",
  );
  const rows = JSON.parse(readFileSync(registry, "utf-8")) as Array<
    Record<string, unknown>
  >;
  rows[0].repos = repos;
  writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
}

function writeCodekbSet(
  proj: string,
  repo: string,
  omitted?: string,
): void {
  const dir = join(proj, "aidlc", "spaces", "default", "codekb", repo);
  mkdirSync(dir, { recursive: true });
  for (const name of RE_PRODUCES) {
    if (name === omitted) continue;
    writeFileSync(join(dir, `${name}.md`), "# stub\n");
  }
}

function completePipelineReceipts(proj: string, repos: string[] = []): void {
  ensurePipelineAttemptStarted(proj);
  const chains = repos.length > 0 ? repos : [undefined];
  for (const repo of chains) {
    for (const link of ["aidlc-developer-agent", "aidlc-architect-agent"]) {
      const args = [
        LOG,
        "link",
        "--stage",
        "reverse-engineering",
        "--link",
        link,
        "--project-dir",
        proj,
      ];
      if (repo) args.splice(args.length - 2, 0, "--repo", repo);
      if (link === "aidlc-developer-agent") {
        const handoff = join(
          seededRecordDir(proj),
          "inception",
          "reverse-engineering",
          repo ? `developer-scan-${repo}.md` : "developer-scan.md",
        );
        mkdirSync(dirname(handoff), { recursive: true });
        writeFileSync(
          handoff,
          "## Developer Code Scan Results\n\n## Handoff Summary\n\nFixture scan.\n",
        );
        const attemptStartedAt = pipelineAttemptStartedAt(
          proj,
          "reverse-engineering",
        );
        const attemptMs = Date.parse(attemptStartedAt);
        const writtenAt = new Date(
          Math.max(Date.now(), Number.isNaN(attemptMs) ? 0 : attemptMs) +
            1_000 +
            handoffClock++,
        );
        utimesSync(handoff, writtenAt, writtenAt);
        args.splice(
          args.length - 2,
          0,
          "--artifact",
          relative(proj, handoff),
        );
      }
      const env = { ...process.env };
      delete env.AIDLC_SKIP_ARTIFACT_GUARD;
      delete env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
      const result = spawnSync(BUN, args, { encoding: "utf-8", env });
      if ((result.status ?? -1) !== 0) {
        throw new Error(
          `pipeline receipt failed: ${result.stdout ?? ""}${result.stderr ?? ""}`,
        );
      }
    }
  }
}

let proj: string;

describe("t185: stage-completion artifact guard (#366)", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION); // Current Stage: feasibility
  });

  afterEach(() => cleanupTestProject(proj));

  // --- Layer 1: produces-existence, ideation stage (feasibility) -------------

  test("approve REFUSES when the stage produced no artifacts", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    bypassed(proj, ["checkbox", `${slug}=in-progress`]);
    bypassed(proj, ["gate-start", slug]);
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).not.toBe(0);
    expect((JSON.parse(r.out) as { error: string }).error).toContain(
      'Cannot complete "feasibility": none of its declared artifacts exist',
    );
    // State untouched: the stage is NOT marked completed.
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  test("gate-start REFUSES before [?] when the stage produced no artifacts", () => {
    const slug = field(proj, "Current Stage");
    const r = guarded(proj, ["gate-start", slug]);
    expect(r.rc).not.toBe(0);
    expect((JSON.parse(r.out) as { error: string }).error).toContain(
      'Cannot present "feasibility" for approval: none of its declared artifacts exist',
    );
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
      `- [-] ${slug}`,
    );
  });

  test("revise REFUSES before [?] when revised artifacts are absent", () => {
    const slug = field(proj, "Current Stage");
    bypassed(proj, ["checkbox", `${slug}=revising`]);
    const r = guarded(proj, ["revise", slug]);
    expect(r.rc).not.toBe(0);
    expect((JSON.parse(r.out) as { error: string }).error).toContain(
      'Cannot present "feasibility" for approval: none of its declared artifacts exist',
    );
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
      `- [R] ${slug}`,
    );
  });

  test("direct advance (gate-skipping path) REFUSES when no artifacts", () => {
    const slug = field(proj, "Current Stage");
    const r = guarded(proj, ["advance", slug]);
    expect(r.rc).not.toBe(0);
    expect((JSON.parse(r.out) as { error: string }).error).toContain(
      'Cannot complete "feasibility": none of its declared artifacts exist',
    );
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // The other two completing transitions (finalize + complete-workflow) also
  // mark a stage [x], so they must run the same guard - otherwise they are an
  // unguarded rubber-stamp backdoor on the direct-CLI surface.
  test("finalize REFUSES when no artifacts", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    const r = guarded(proj, ["finalize", slug]);
    expect(r.rc).not.toBe(0);
    expect((JSON.parse(r.out) as { error: string }).error).toContain(
      'Cannot complete "feasibility": none of its declared artifacts exist',
    );
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  test("complete-workflow REFUSES when no artifacts", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    const r = guarded(proj, ["complete-workflow", slug]);
    expect(r.rc).not.toBe(0);
    expect((JSON.parse(r.out) as { error: string }).error).toContain(
      'Cannot complete "feasibility": none of its declared artifacts exist',
    );
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  test("finalize bypasses the guard under AIDLC_SKIP_ARTIFACT_GUARD (no artifacts)", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    const r = bypassed(proj, ["finalize", slug]);
    expect(r.rc).toBe(0);
  });

  test("approve PASSES once a declared produces[] artifact exists", () => {
    const slug = field(proj, "Current Stage"); // feasibility, phase ideation
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    writeRecordDoc(proj, `ideation/${slug}/feasibility-assessment.md`);
    guarded(proj, ["gate-start", slug]);
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
    // Auto-advanced off feasibility.
    expect(field(proj, "Current Stage")).not.toBe(slug);
  });

  describe("consolidated-summary confirmation guard", () => {
    test("refuses a self-written Looks correct with no human-backed receipt", () => {
      writeSummaryQuestions(proj, "Looks correct");
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain(
        "no fresh human-backed consolidated summary confirmation",
      );
    });

    test("refuses an artifact whose last native write predates confirmation", () => {
      const questions = writeSummaryQuestions(proj);
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      confirmSummary(proj, questions);
      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("was not saved after the confirmed answers");
    });

    test("allows Assumption Confirmation after generation and terminal review", () => {
      bypassed(proj, ["set", "Current Stage=intent-capture"]);
      bypassed(proj, ["checkbox", "intent-capture=in-progress"]);
      const questions = writeSummaryQuestions(proj, "", "intent-capture");
      confirmSummary(proj, questions, "intent-capture");
      recordArtifactWrite(
        proj,
        "ideation/intent-capture/intent-statement.md",
      );
      recordArtifactWrite(
        proj,
        "ideation/intent-capture/stakeholder-map.md",
      );
      writeFileSync(
        questions,
        `${readFileSync(questions, "utf-8")}\n## Assumption Confirmation\n\n- A procurement reviewer may be needed.\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
      );
      appendAudit(proj, "ARTIFACT_UPDATED", {
        File: questions,
        Tool: "Edit",
      });
      reviewStage(
        proj,
        "intent-capture",
        "aidlc-product-lead-agent",
      );

      const result = summaryReportGuarded(proj, [
        "report",
        "--stage",
        "intent-capture",
        "--result",
        "awaiting-approval",
      ]);
      expect(result.rc).toBe(0);
      expect(result.out).toContain('"kind":"print"');
      expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
        "- [?] intent-capture",
      );
    });

    test("accepts a follow-up Q section after Assumption Confirmation on a fresh receipt", () => {
      const questions = writeSummaryQuestions(proj);
      const body = `${readFileSync(questions, "utf-8")}
## Assumption Confirmation

[Answer]: B. Convert to follow-up questions

## Q3. Which fallback should be used?

A. Manual review
X. Other (please specify)

[Answer]: A. Manual review
`;
      writeFileSync(questions, body);
      confirmSummary(
        proj,
        questions,
        "feasibility",
        body.replace("[Answer]: \n", "[Answer]: Looks correct\n"),
      );
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      expect(summaryGuarded(proj, ["advance", "feasibility"]).rc).toBe(0);
    });

    test("accepts stage-specific question headings without imposing Q<n> grammar", () => {
      const questions = writeSummaryQuestions(proj);
      const body = readFileSync(questions, "utf-8")
        .replace("## Q1. Is the proposed approach feasible?", "## Question 1")
        .replace(
          "## Q2. Which review mode should be used?",
          "## Context\n\nThe stage may use contextual sections.\n\n## Q1 ##",
        );
      writeFileSync(questions, body);
      confirmSummary(
        proj,
        questions,
        "feasibility",
        body.replace("[Answer]: \n", "[Answer]: Looks correct\n"),
      );
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      expect(summaryGuarded(proj, ["advance", "feasibility"]).rc).toBe(0);
    });

    test("accepts two consecutive Requested Changes feedback sections in order", () => {
      const questions = writeSummaryQuestions(proj);
      const body = `${readFileSync(questions, "utf-8")}\n` +
        [
          "## Requested Changes Feedback",
          "",
          "[Answer]: Clarify the workflow owner.",
          "",
          "## Requested Changes Feedback",
          "",
          "[Answer]: Add the fallback reviewer.",
          "",
        ].join("\n");
      writeFileSync(questions, body);
      confirmSummary(
        proj,
        questions,
        "feasibility",
        body.replace("[Answer]: \n", "[Answer]: Looks correct\n"),
      );
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      expect(summaryGuarded(proj, ["advance", "feasibility"]).rc).toBe(0);
    });

    test("ignores H2-looking text in comments, tilde fences, and indented fences", () => {
      const questions = writeSummaryQuestions(proj);
      const body = readFileSync(questions, "utf-8").replace(
        "## Consolidated Summary Confirmation",
        [
          "<!--",
          "## Commented Example",
          "-->",
          "",
          "~~~markdown",
          "## Tilde Fence Example",
          "~~~",
          "",
          "   ```markdown",
          "   ## Indented Fence Example",
          "   ```",
          "",
          "## Consolidated Summary Confirmation",
        ].join("\n"),
      );
      writeFileSync(questions, body);
      confirmSummary(
        proj,
        questions,
        "feasibility",
        body.replace("[Answer]: \n", "[Answer]: Looks correct\n"),
      );
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      expect(summaryGuarded(proj, ["advance", "feasibility"]).rc).toBe(0);
    });

    test("does not launder a Q section through a tilde fence containing backticks", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "~~~text\n```\n~~~\n\n## Q3. Fabricated question\n\n[Answer]: A. Fabricated\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("does not let a comment marker in a fence info string hide a later question", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "~~~markdown <!--\n~~~\n## Q3. Fabricated question\n\n[Answer]: A. Fabricated\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("does not let a multiline code span comment marker hide a later question", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "`literal comment example\n<!-- marker inside code\nstill literal code`\n" +
          "## Q3. Fabricated question\n\n[Answer]: A. Fabricated\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    for (const [name, opener] of [
      ["unescaped", "`literal"],
      ["escaped", "\\`literal"],
    ] as const) {
      test(`does not let an ${name} multiline code opener consume an ATX heading`, () => {
        const result = summaryMutationResult(
          proj,
          (body) =>
            `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
            `${opener}\n## Q3. Fabricated question \`\n\n[Answer]: A. Fabricated\n`,
        );
        expect(result.rc).not.toBe(0);
        expect(result.out).toContain("changed after the human confirmed");
      });
    }

    for (const [name, block] of [
      ["pre", "<pre>\n## Literal example\n</pre>"],
      ["script", "<script>\n## Literal example\n</script>"],
    ] as const) {
      test(`keeps H2-looking text literal inside a raw ${name} HTML block`, () => {
        const result = summaryMutationResult(
          proj,
          (body) =>
            `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
            `${block}\n`,
        );
        expect(result.rc).toBe(0);
      });
    }

    for (const [name, indentation] of [["space", "    "], ["tab", "\t"]]) {
      test(`does not let a ${name}-indented code comment marker hide a later question`, () => {
        const result = summaryMutationResult(
          proj,
          (body) =>
            `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
            `${indentation}<!-- literal comment marker\n` +
            "## Q3. Fabricated question\n\n[Answer]: A. Fabricated\n",
        );
        expect(result.rc).not.toBe(0);
        expect(result.out).toContain("changed after the human confirmed");
      });
    }

    test("does not let a multiline HTML attribute comment marker hide a later question", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          '<div data-example="\n<!--">literal</div>\n' +
          "## Q3. Fabricated question\n\n[Answer]: A. Fabricated\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("does not accept a summary answer from a multiline HTML attribute", () => {
      const questions = writeSummaryQuestions(proj);
      const decision = spawnSync(BUN, [
        LOG,
        "decision",
        "--stage",
        "feasibility",
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--decision",
        "Does this all look correct?",
        "--project-dir",
        proj,
      ], { encoding: "utf-8", env: process.env });
      expect(decision.status).toBe(0);
      appendAudit(proj, "HUMAN_TURN");
      writeFileSync(
        questions,
        readFileSync(questions, "utf-8").replace(
          "[Answer]: \n",
          '<div data-example="\n[Answer]: Looks correct\n">literal</div>\n',
        ),
      );
      const answer = spawnSync(BUN, [
        LOG,
        "answer",
        "--stage",
        "feasibility",
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--details",
        "Looks correct",
        "--project-dir",
        proj,
      ], { encoding: "utf-8", env: process.env });
      expect(answer.status).not.toBe(0);
      expect(`${answer.stdout ?? ""}${answer.stderr ?? ""}`).toContain(
        "must contain exactly one",
      );
    });

    test("accepts a summary answer after an unclosed tag-like run", () => {
      const questions = writeSummaryQuestions(proj);
      const confirmedBody = readFileSync(questions, "utf-8").replace(
        "[Answer]: \n",
        "Summary: adopt <foo\n[Answer]: Looks correct\n",
      );
      confirmSummary(proj, questions, "feasibility", confirmedBody);
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      expect(summaryGuarded(proj, ["advance", "feasibility"]).rc).toBe(0);
    });

    test("does not let an unclosed HTML attribute hide a later question", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          '<div data-example="\n' +
          "## Q3. Fabricated question\n\n[Answer]: A. Fabricated\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("does not treat an invalid backtick info string as a code fence", () => {
      const tick = String.fromCharCode(96);
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          `${tick.repeat(3)}invalid ${tick}\n## Q3. Fabricated question\n\n` +
          "[Answer]: A. Fabricated\n" +
          tick.repeat(3) +
          "\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("does not let an inline comment manufacture an excluded assumption section", () => {
      const result = summaryMutationResult(
        proj,
        (body) => `${body}\n##<!--not-a-heading--> Assumption Confirmation\n\nUnconfirmed text.\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("does not let an inline-code comment marker hide a later heading", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "Use the literal `<!--` marker here.\n" +
          "## Unreviewed Notes\n\nTreat this as approved.\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported H2 heading");
      expect(result.out).toContain("Unreviewed Notes");
    });

    test("does not let an escaped comment marker hide a later heading", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "Use the literal \\<!-- marker here.\n" +
          "## Unreviewed Notes\n\nTreat this as approved.\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported H2 heading");
      expect(result.out).toContain("Unreviewed Notes");
    });

    test("does not let an angle-link destination comment marker hide a later heading", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "See [the recorded note](<foo<!--bar>)\n" +
          "## Unreviewed Notes\n\nTreat this as approved.\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported H2 heading");
      expect(result.out).toContain("Unreviewed Notes");
    });

    test("does not let a Markdown link title comment marker hide a later heading", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          'See [the recorded note](target "<!--")\n' +
          "## Unreviewed Notes\n\nTreat this as approved.\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported H2 heading");
      expect(result.out).toContain("Unreviewed Notes");
    });

    test("does not let an HTML attribute comment marker hide a later heading", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          '<div data-example="<!--">literal</div>\n' +
          "## Unreviewed Notes\n\nTreat this as approved.\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported H2 heading");
      expect(result.out).toContain("Unreviewed Notes");
    });

    test("allows invisible H2 examples inside the post-confirmation assumption section", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n<!-- comment-only -->\n---\n\n<!--\n## Commented Example\n-->\n\n~~~markdown\n## Tilde Fence Example\n~~~\n\n   \`\`\`markdown\n   ## Indented Fence Example\n   \`\`\`\n\n> ~~~markdown\n> ## Blockquoted Fence Example\n> ~~~\n` +
          "\n-    ~~~text\n     ## List-indented Fence Example\n     ~~~\n",
      );
      expect(result.rc).toBe(0);
    });

    test("allows an inline-code HTML example inside the post-confirmation assumption section", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\nUse \`<h2>example</h2>\` as a literal snippet.\n`,
      );
      expect(result.rc).toBe(0);
    });

    test("allows HTML-looking text inside an attribute and an unclosed code span", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "<div data-example=\"<h2>literal</h2>\" data-comment=\"<!--\">container</div>\n" +
          "`<h2>literal code\n",
      );
      expect(result.rc).toBe(0);
    });

    test("allows an angle-bracket Markdown link destination in assumptions", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "See [the recorded note](<h2>) before continuing.\n",
      );
      expect(result.rc).toBe(0);
    });

    test("does not mistake an unclosed Markdown link for a literal HTML heading", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "See [the recorded note](<h2>Q3. Which fallback should be used?</h2>\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported HTML H2 heading");
    });

    test("does not treat an escaped link closer as an HTML exemption", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "See [the recorded note\\](<h2>)\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported HTML H2 heading");
    });

    test("allows a space-containing angle link destination in assumptions", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "See [the recorded note](<h2 class=example>) before continuing.\n",
      );
      expect(result.rc).toBe(0);
    });

    test("does not treat an unclosed space-containing angle link as literal HTML", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "See [the recorded note](<h2 class=example>\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported HTML H2 heading");
    });

    test("allows four-space indented container-looking examples in assumptions", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "    > ## Literal example\n    - ## Another literal example\n" +
          "    <h2>Indented literal example</h2>\n" +
          "\t<h2>Tab-indented literal example</h2>\n",
      );
      expect(result.rc).toBe(0);
    });

    test("does not launder a heading after a list-indented fenced block", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "-    ~~~text\n     ## Literal example\n     ~~~\n" +
          "## Q3. Which fallback should be used?\n\n[Answer]: A. Manual review\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    for (const [name, opener] of [
      ["list-item tilde fence", "- ~~~text"],
      ["blockquote tilde fence", "> ~~~text"],
      ["list-item backtick fence", " * ```"],
      ["list-item HTML comment", "- <!--"],
      ["blockquote HTML comment", "> <!--"],
    ] as const) {
      test(`does not launder a heading through an unclosed container-scoped ${name}`, () => {
        const result = summaryMutationResult(
          proj,
          (body) =>
            `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
            `${opener}\n\n## Q3. Which fallback should be used?\n\n` +
            "[Answer]: A. Manual review\n",
        );
        expect(result.rc).not.toBe(0);
        expect(result.out).toContain("changed after the human confirmed");
      });
    }

    for (const [name, body] of [
      ["a list-continuation fence", "- item\n  ~~~text"],
      ["a list-continuation comment", "- item\n  <!--"],
      [
        "a lazily continued list fence",
        "- item\ncontinued paragraph\n  ~~~text",
      ],
      ["a lazily continued blockquote fence", "> item\n  ~~~text"],
      ["a blockquote-following top-level fence", "> item\n~~~text"],
      ["a lazily continued blockquote comment", "> item\n  <!--"],
    ] as const) {
      test(`does not launder a heading through ${name}`, () => {
        const result = summaryMutationResult(
          proj,
          (original) =>
            `${original}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
            `${body}\n\n## Q3. Which fallback should be used?\n\n` +
            "[Answer]: A. Manual review\n",
        );
        expect(result.rc).not.toBe(0);
        expect(result.out).toContain("changed after the human confirmed");
      });
    }

    test("does not launder an inline raw HTML heading", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "Visible text <h2>Q3. Which fallback should be used?</h2>\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported HTML H2 heading");
    });

    test("does not treat a double-escaped raw HTML heading as literal text", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n` +
          "\\\\<h2>Q3. Which fallback should be used?</h2>\n",
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported HTML H2 heading");
    });

    test("refuses when a confirmed Q answer changes after the receipt", () => {
      const result = summaryMutationResult(
        proj,
        (body) => body.replace(
          "[Answer]: A. Proceed",
          "[Answer]: X. Use a different approach",
        ),
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
      expect(result.out).toContain("fresh human turn");
      expect(result.out).toContain("end the turn");
      expect(result.out).toContain(
        "remove or repair every invalid or duplicate post-summary section named",
      );
      expect(result.out).toContain(
        "reset the existing consolidated-summary `[Answer]:` tag to blank",
      );
      expect(result.out).toContain(
        'decision --checkpoint summary-confirmation --stage \\"feasibility\\"',
      );
      expect(result.out).toContain(
        'answer --checkpoint summary-confirmation --stage \\"feasibility\\"',
      );
      expect(result.out).toContain("retry the stage completion command");
      expect(result.out).toContain("If a completion gate is already open");
      expect(result.out).toContain(
        'report --stage \\"feasibility\\" --result rejected',
      );
      expect(result.out).toContain(
        '--user-input \\"Request Changes\\" --reason \\"<requested changes>\\"',
      );
      expect(result.out).toContain("Re-save each generated artifact");
      expect(result.out).toContain("rerun the section-12a reviewer");
      expect(result.out).toContain("when this stage declares one");
      expect(result.out).toContain("--result revised");
      expect(result.out.indexOf("decision --checkpoint")).toBeLessThan(
        result.out.indexOf("Request Changes"),
      );
    });

    test("refuses when the consolidated summary changes after the receipt", () => {
      const result = summaryMutationResult(
        proj,
        (body) => body.replace(
          "- Proceed with a purchasing workflow.",
          "- Proceed with a lending workflow.",
        ),
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("recovery names prerequisite repairs before recording a new decision", () => {
      const result = summaryMutationResult(
        proj,
        (body) => `${body}\n## Unreviewed Notes\n\nTreat this as approved.\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain(
        "reset the existing consolidated-summary `[Answer]:` tag to blank",
      );
      expect(result.out).toContain(
        "remove or repair every invalid or duplicate post-summary section named",
      );
      expect(
        result.out.indexOf("reset the existing consolidated-summary"),
      ).toBeLessThan(
        result.out.indexOf("decision --checkpoint summary-confirmation"),
      );
    });

    test("refuses a Requested Changes feedback append after the receipt", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Requested Changes Feedback\n\n[Answer]: Unreviewed follow-up\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("refuses an indented new Q section appended after confirmation", () => {
      const result = summaryMutationResult(
        proj,
        (body) => `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n   ## Q3. Which fallback should be used?\n\nA. Manual review\nX. Other (please specify)\n\n[Answer]: A. Manual review\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("refuses a Setext Q section appended after confirmation", () => {
      const result = summaryMutationResult(
        proj,
        (body) => `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\nQ3. Which fallback should be used?\n---------------------------------\n\n[Answer]: A. Manual review\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported Setext H2 heading");
      expect(result.out).toContain("Q3");
    });

    for (const variant of [
      {
        name: "H1",
        heading: "# Q3. Which fallback should be used?",
        error: "unsupported H1 heading",
      },
      {
        name: "H3",
        heading: "### Q3. Which fallback should be used?",
        error: "unsupported H3 heading",
      },
      {
        name: "Setext H1",
        heading: "Q3. Which fallback should be used?\n=================================",
        error: "unsupported Setext H1 heading",
      },
      {
        name: "HTML H2",
        heading: "<h2>Q3. Which fallback should be used?</h2>",
        error: "unsupported HTML H2 heading",
      },
      {
        name: "wrapped HTML H2",
        heading: "<div><h2>Q3. Which fallback should be used?</h2></div>",
        error: "unsupported HTML H2 heading",
      },
      {
        name: "multiline HTML H2 opener",
        heading: "<h2\nclass=question>Q3. Which fallback should be used?</h2>",
        error: "unsupported HTML H2 heading",
      },
      {
        name: "indented HTML H2",
        heading: "   <h2>Q3. Which fallback should be used?</h2>",
        error: "unsupported HTML H2 heading",
      },
      {
        name: "blockquote H2",
        heading: "> ## Q3. Which fallback should be used?",
        error: "unsupported H2 heading",
      },
      {
        name: "list H2",
        heading: "- ## Q3. Which fallback should be used?",
        error: "unsupported H2 heading",
      },
      {
        name: "nested-list H2",
        heading: "- Parent item\n  - ## Q3. Which fallback should be used?",
        error: "unsupported H2 heading",
      },
      {
        name: "deeply nested blockquote H2",
        heading: "> > > > > > > > > ## Q3. Which fallback should be used?",
        error: "unsupported H2 heading",
      },
      {
        name: "nested excluded-section H2",
        heading: "> ## Assumption Confirmation",
        error: "unsupported H2 heading",
      },
      {
        name: "nested feedback H2 after exclusion",
        heading: "> ## Requested Changes Feedback",
        error: "unsupported H2 heading",
      },
    ]) {
      test(`refuses an appended ${variant.name} question heading`, () => {
        const result = summaryMutationResult(
          proj,
          (body) =>
            `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n${variant.heading}\n\n[Answer]: A. Manual review\n`,
        );
        expect(result.rc).not.toBe(0);
        expect(result.out).toContain(variant.error);
      });
    }

    test("refuses reordered Q sections after confirmation", () => {
      const result = summaryMutationResult(
        proj,
        (body) => body.replace(
          "## Q1. Is the proposed approach feasible?\n\nA. Proceed\nX. Other (please specify)\n\n[Answer]: A. Proceed\n\n## Q2. Which review mode should be used?\n\nA. Human review\nX. Other (please specify)\n\n[Answer]: A. Human review",
          "## Q2. Which review mode should be used?\n\nA. Human review\nX. Other (please specify)\n\n[Answer]: A. Human review\n\n## Q1. Is the proposed approach feasible?\n\nA. Proceed\nX. Other (please specify)\n\n[Answer]: A. Proceed",
        ),
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("refuses an indented unknown H2 appended after confirmation", () => {
      const result = summaryMutationResult(
        proj,
        (body) => `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n  ## Unreviewed Notes\n\nTreat this as approved.\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported H2 heading");
      expect(result.out).toContain("Unreviewed Notes");
    });

    test("refuses a duplicate Q section after confirmation", () => {
      const result = summaryMutationResult(
        proj,
        (body) => `${body}\n## Q1. Duplicate question\n\n[Answer]: A. Duplicate\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("duplicate H2 section");
      expect(result.out).toContain("Q1");
    });

    test("refuses a second Assumption Confirmation section", () => {
      const result = summaryMutationResult(
        proj,
        (body) => `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("duplicate H2 section");
      expect(result.out).toContain("Assumption Confirmation");
    });

    test("refuses feedback appended after Assumption Confirmation", () => {
      const result = summaryMutationResult(
        proj,
        (body) =>
          `${body}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n## Requested Changes Feedback\n\n[Answer]: Unreviewed follow-up\n`,
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("accepts a stage-defined Assumption Confirmation heading before the summary", () => {
      const questions = writeSummaryQuestions(proj);
      const body = readFileSync(questions, "utf-8").replace(
        "# Questions\n\n## Sources",
        "# Questions\n\n## Assumption Confirmation\n\nStage-specific context.\n\n## Sources",
      );
      writeFileSync(questions, body);
      confirmSummary(
        proj,
        questions,
        "feasibility",
        body.replace("[Answer]: \n", "[Answer]: Looks correct\n"),
      );
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      expect(summaryGuarded(proj, ["advance", "feasibility"]).rc).toBe(0);
    });

    test("rejects moving a confirmed Assumption Confirmation heading before the summary", () => {
      const result = summaryMutationResult(
        proj,
        (body) => body.replace(
          "## Consolidated Summary Confirmation",
          "## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n\n## Consolidated Summary Confirmation",
        ),
      );
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("changed after the human confirmed");
    });

    test("accepts a legacy whole-file receipt with no Hash Scope", () => {
      const questions = writeSummaryQuestions(proj, "Looks correct");
      appendSummaryReceipt(proj, questions);
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).toBe(0);
    });

    test("explains how an in-flight legacy receipt recovers after an assumption append", () => {
      const questions = writeSummaryQuestions(proj, "Looks correct");
      appendSummaryReceipt(proj, questions);
      writeFileSync(
        questions,
        `${readFileSync(questions, "utf-8")}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n`,
      );
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("legacy unscoped receipt");
      expect(result.out).toContain("fresh human turn");
      expect(result.out).toContain("new scoped receipt");
    });

    test("refuses an unsupported receipt Hash Scope", () => {
      const questions = writeSummaryQuestions(proj, "Looks correct");
      appendSummaryReceipt(proj, questions, "confirmed-content-v99");
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("unsupported summary-confirmation Hash Scope");
      expect(result.out).toContain("confirmed-content-v99");
    });

    test("refuses same-second matching receipts from different audit shards", () => {
      const questions = writeSummaryQuestions(proj, "Looks correct");
      const artifact = join(
        seededRecordDir(proj),
        "ideation",
        "feasibility",
        "feasibility-assessment.md",
      );
      writeRecordDoc(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      const timestamp = "2026-08-19T12:00:00Z";
      writeAuditShardRows(proj, "aaa-request-changes.md", [{
        timestamp,
        event: "SUMMARY_CONFIRMATION_RECORDED",
        fields: scopedSummaryReceiptFields(
          proj,
          questions,
          "Request changes",
        ),
      }]);
      writeAuditShardRows(proj, "zzz-looks-correct.md", [
        {
          timestamp,
          event: "SUMMARY_CONFIRMATION_RECORDED",
          fields: scopedSummaryReceiptFields(proj, questions),
        },
        {
          timestamp: "2026-08-19T12:00:01Z",
          event: "ARTIFACT_CREATED",
          fields: { File: artifact, Tool: "Write" },
        },
      ]);

      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("matching summary receipts");
      expect(result.out).toContain("causal order cannot be proven");
    });

    test("refuses a receipt unordered with the current-attempt floor", () => {
      const questions = writeSummaryQuestions(proj, "Looks correct");
      const artifact = join(
        seededRecordDir(proj),
        "ideation",
        "feasibility",
        "feasibility-assessment.md",
      );
      writeRecordDoc(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      const timestamp = "2026-08-19T12:00:00Z";
      writeAuditShardRows(proj, "aaa-floor.md", [{
        timestamp,
        event: "WORKFLOW_STARTED",
      }]);
      writeAuditShardRows(proj, "zzz-receipt.md", [
        {
          timestamp,
          event: "SUMMARY_CONFIRMATION_RECORDED",
          fields: scopedSummaryReceiptFields(proj, questions),
        },
        {
          timestamp: "2026-08-19T12:00:01Z",
          event: "ARTIFACT_CREATED",
          fields: { File: artifact, Tool: "Write" },
        },
      ]);

      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain(
        "current-attempt boundary and matching summary receipt",
      );
      expect(result.out).toContain("causal order cannot be proven");
    });

    test("refuses an artifact write unordered with its summary receipt", () => {
      const questions = writeSummaryQuestions(proj, "Looks correct");
      const artifact = join(
        seededRecordDir(proj),
        "ideation",
        "feasibility",
        "feasibility-assessment.md",
      );
      writeRecordDoc(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      const timestamp = "2026-08-19T12:00:00Z";
      writeAuditShardRows(proj, "aaa-receipt.md", [{
        timestamp,
        event: "SUMMARY_CONFIRMATION_RECORDED",
        fields: scopedSummaryReceiptFields(proj, questions),
      }]);
      writeAuditShardRows(proj, "zzz-write.md", [{
        timestamp,
        event: "ARTIFACT_CREATED",
        fields: { File: artifact, Tool: "Write" },
      }]);

      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("summary receipt and artifact write");
      expect(result.out).toContain("causal order cannot be proven");
    });

    test("passes with matching digest and a post-confirmation artifact write", () => {
      const questions = writeSummaryQuestions(proj);
      confirmSummary(proj, questions);
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      const result = summaryGuarded(proj, ["advance", "feasibility"]);
      expect(result.rc).toBe(0);
      expect(field(proj, "Current Stage")).not.toBe("feasibility");
    });

    test("accepts a legacy pre-move absolute artifact write after the workspace moves", () => {
      const questions = writeSummaryQuestions(proj);
      confirmSummary(proj, questions);
      const artifact = join(
        seededRecordDir(proj),
        "ideation",
        "feasibility",
        "feasibility-assessment.md",
      );
      writeRecordDoc(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      appendFileSync(
        seededAuditShard(proj),
        [
          "",
          "## ARTIFACT_CREATED",
          `**Timestamp**: ${new Date().toISOString()}`,
          "**Event**: ARTIFACT_CREATED",
          `**File**: ${artifact}`,
          "**Tool**: Write",
          "",
          "---",
          "",
        ].join("\n"),
      );
      const moved = `${proj}-moved`;
      renameSync(proj, moved);
      proj = moved;

      expect(summaryGuarded(proj, ["advance", "feasibility"]).rc).toBe(0);
    });

    test("normalizes line endings in a scoped receipt", () => {
      const questions = writeSummaryQuestions(proj);
      confirmSummary(proj, questions);
      writeFileSync(
        questions,
        readFileSync(questions, "utf-8").replaceAll("\n", "\r\n"),
      );
      recordArtifactWrite(
        proj,
        "ideation/feasibility/feasibility-assessment.md",
      );
      expect(summaryGuarded(proj, ["advance", "feasibility"]).rc).toBe(0);
    });
  });

  // --- Bypasses --------------------------------------------------------------

  test("approve bypasses the guard under AIDLC_SKIP_ARTIFACT_GUARD (no artifacts)", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    bypassed(proj, ["gate-start", slug]);
    const r = bypassed(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
  });

  test("AIDLC_SKIP_ARTIFACT_GUARD=1 bypasses the guard (no artifacts)", () => {
    const slug = field(proj, "Current Stage");
    const r = bypassed(proj, ["advance", slug]);
    expect(r.rc).toBe(0);
  });

  // --- Layer 2: workspace_requires (code-generation, per-unit) ---------------

  describe("workspace_requires (code-generation)", () => {
    const UNIT = "user-auth";

    // Move the pointer to code-generation, in-progress, and write its three
    // per-unit produces[] docs under the record's construction/<unit>/ subtree
    // (satisfies layer 1) but NO source code.
    function stageCodeGenDocsOnly(): void {
      guarded(proj, ["set", "Current Stage=code-generation"]);
      guarded(proj, ["checkbox", "code-generation=in-progress"]);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/code-generation-plan.md`);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/unit-test-instructions.md`);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/code-summary.md`);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/traceability.json`);
    }

    test("REFUSES code-generation with planning docs but no source code", () => {
      stageCodeGenDocsOnly();
      reviewCodeGen(proj);
      bypassed(proj, ["gate-start", "code-generation"]);
      const r = guarded(proj, ["approve", "code-generation", "--user-input", "ok"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("workspace_requires");
    });

    test("PASSES code-generation once real source exists outside aidlc/", () => {
      stageCodeGenDocsOnly();
      writeWorkspaceFile(proj, "src/auth/login.ts"); // outside aidlc/ + harness
      reviewCodeGen(proj, UNIT);
      bypassed(proj, ["gate-start", "code-generation"]);
      const r = guarded(proj, ["approve", "code-generation", "--user-input", "ok"], {
        AIDLC_SKIP_SOURCE_FRESHNESS: "1",
      });
      expect(r.rc).toBe(0);
    });

    test("PASSES stage-level code-generation artifacts when the effective plan skips Units Generation", () => {
      guarded(proj, ["set", "Current Stage=code-generation"]);
      guarded(proj, ["checkbox", "code-generation=in-progress"]);
      const statePath = seededStateFile(proj);
      const state = readFileSync(statePath, "utf-8").replace(
        /^(- \[[ xSR?-]\] units-generation\s+—\s+)EXECUTE$/m,
        "$1SKIP",
      );
      writeFileSync(statePath, state);
      writeRecordDoc(proj, "construction/code-generation/code-generation-plan.md");
      writeRecordDoc(proj, "construction/code-generation/unit-test-instructions.md");
      writeRecordDoc(proj, "construction/code-generation/code-summary.md");
      writeWorkspaceFile(proj, "src/stage-level.ts");

      reviewCodeGen(proj);
      const r = guarded(proj, ["gate-start", "code-generation"], {
        AIDLC_SKIP_SOURCE_FRESHNESS: "1",
      });
      expect(r.rc).toBe(0);
    });
  });

  // --- Layer 1 (codekb placement): reverse-engineering -----------------------
  //
  // V2-specific: codekb stages (reverse-engineering) write their produces[] to
  // the space-level aidlc/spaces/<space>/codekb/<repo>/ dir, NOT a per-intent
  // record dir. The guard must resolve THAT placement, else it false-refuses a
  // real reverse-engineering approval. (The old flat-path design had no codekb
  // concept; this case did not exist in the reference t154.)
  describe("codekb placement (reverse-engineering)", () => {
    test("REFUSES reverse-engineering with no codekb artifacts", () => {
      guarded(proj, ["set", "Current Stage=reverse-engineering"]);
      guarded(proj, ["checkbox", "reverse-engineering=in-progress"]);
      completePipelineReceipts(proj);
      bypassed(proj, ["gate-start", "reverse-engineering"]);
      const r = guarded(proj, ["approve", "reverse-engineering", "--user-input", "ok"]);
      expect(r.rc).not.toBe(0);
      expect((JSON.parse(r.out) as { error: string }).error).toContain(
        'Cannot complete "reverse-engineering": none of its declared artifacts exist',
      );
    });

    test("PASSES reverse-engineering once the complete codekb artifact set exists", () => {
      guarded(proj, ["set", "Current Stage=reverse-engineering"]);
      guarded(proj, ["checkbox", "reverse-engineering=in-progress"]);
      writeCodekbSet(proj, basename(proj));
      completePipelineReceipts(proj);
      guarded(proj, ["gate-start", "reverse-engineering"]);
      const r = guarded(proj, ["approve", "reverse-engineering", "--user-input", "ok"]);
      expect(r.rc).toBe(0);
    });

    test("REFUSES multi-repo codekb when one registered repo is missing one artifact", () => {
      const repos = ["repo-a", "repo-b"];
      rewriteIntentRepos(proj, repos);
      guarded(proj, ["set", "Current Stage=reverse-engineering"]);
      guarded(proj, ["checkbox", "reverse-engineering=in-progress"]);
      writeCodekbSet(proj, "repo-a");
      writeCodekbSet(proj, "repo-b", "dependencies");
      completePipelineReceipts(proj, repos);

      const r = guarded(proj, ["gate-start", "reverse-engineering"]);
      expect(r.rc).not.toBe(0);
      expect((JSON.parse(r.out) as { error: string }).error).toContain(
        'Cannot present "reverse-engineering" for approval: none of its declared artifacts exist',
      );
    });

    test("PASSES multi-repo codekb when every registered repo has the full set", () => {
      const repos = ["repo-a", "repo-b"];
      rewriteIntentRepos(proj, repos);
      guarded(proj, ["set", "Current Stage=reverse-engineering"]);
      guarded(proj, ["checkbox", "reverse-engineering=in-progress"]);
      writeCodekbSet(proj, "repo-a");
      writeCodekbSet(proj, "repo-b");
      completePipelineReceipts(proj, repos);

      const r = guarded(proj, ["gate-start", "reverse-engineering"]);
      expect(r.rc).toBe(0);
    });

    test("PASSES mixed reuse and scan with receipts only for the scanned repo", () => {
      const repos = ["repo-a", "repo-b"];
      rewriteIntentRepos(proj, repos);
      guarded(proj, ["set", "Current Stage=reverse-engineering"]);
      guarded(proj, ["checkbox", "reverse-engineering=in-progress"]);
      writeCodekbSet(proj, "repo-a");
      writeCodekbSet(proj, "repo-b");
      ensurePipelineAttemptStarted(proj);
      const reused = guarded(proj, [
        "reuse-artifact",
        "reverse-engineering",
        "--decision",
        "keep",
        "--artifacts",
        "aidlc/spaces/default/codekb/repo-a/",
        "--repo",
        "repo-a",
      ]);
      expect(reused.rc).toBe(0);
      completePipelineReceipts(proj, ["repo-b"]);

      const r = guarded(proj, ["gate-start", "reverse-engineering"]);
      expect(r.rc, r.out).toBe(0);
    });
  });

  // --- Layer 2 (git-aware): workspace_requires in a GIT workspace ------------
  //
  // The bare filesystem check (above) passes whenever ANY non-doc file exists -
  // which on a BROWNFIELD repo (pre-existing src/) is always true, even if this
  // session's code-generation produced nothing. In a git workspace the guard
  // instead asks git "was there real source work?" - an uncommitted/untracked
  // non-doc change, OR a non-doc path in the last commit (so commit-then-approve
  // still passes; #366 Update 3's clean-tree false-block is closed). "Non-doc" =
  // first path segment not in the aidlc/ workspace tree + harness dirs.
  describe("workspace_requires git-aware (code-generation in a git repo)", () => {
    const UNIT = "user-auth";

    function git(args: string[]): void {
      const r = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    function initGitRepo(): void {
      git(["init", "-q"]);
      git(["config", "user.email", "t185@example.com"]);
      git(["config", "user.name", "t185"]);
      git(["config", "commit.gpgsign", "false"]);
    }
    function stageCodeGenDocsOnly(): void {
      guarded(proj, ["set", "Current Stage=code-generation"]);
      guarded(proj, ["checkbox", "code-generation=in-progress"]);
      appendAuditEntry(
        "STAGE_STARTED",
        {
          Stage: "code-generation",
          Agent: "aidlc-developer-agent",
          ...sourceBaselineAuditFields(proj, "code-generation"),
        },
        proj,
      );
      const boundarySecond = Math.floor(Date.now() / 1000);
      while (Math.floor(Date.now() / 1000) === boundarySecond) {}
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/code-generation-plan.md`);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/code-summary.md`);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/traceability.json`);
    }
    function approveCodeGen(): { rc: number; out: string } {
      reviewCodeGen(proj, UNIT);
      bypassed(proj, ["gate-start", "code-generation"]);
      return guarded(
        proj,
        ["approve", "code-generation", "--user-input", "ok"],
      );
    }

    // BROWNFIELD bug closed: a git repo whose src/ was committed in a PRIOR
    // commit, with a clean tree and only doc changes this session, must REFUSE -
    // the bare FS check would have wrongly passed on the pre-existing src/.
    test("REFUSES when src/ is pre-existing (committed earlier) and no new code this session", () => {
      initGitRepo();
      writeWorkspaceFile(proj, "src/legacy/old.ts"); // brownfield baseline
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "baseline brownfield code"]);
      // This session: only the code-gen planning docs (no new code), then commit
      // ONLY the aidlc/ docs so the working tree is clean and the last commit is
      // doc-only.
      stageCodeGenDocsOnly();
      git(["add", "aidlc"]);
      git(["commit", "-q", "-m", "code-gen planning docs only"]);
      const r = approveCodeGen();
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("workspace_requires");
    }, 30000);

    // Uncommitted/untracked new source this session -> PASS.
    test("PASSES with an uncommitted new source file this session", () => {
      initGitRepo();
      git(["commit", "-q", "--allow-empty", "-m", "init"]);
      stageCodeGenDocsOnly();
      writeWorkspaceFile(proj, "src/auth/login.ts"); // untracked, uncommitted
      const r = approveCodeGen();
      expect(r.rc).toBe(0);
    }, 30000);

    // commit-then-approve (clean tree, code in the LAST commit) -> PASS. This is
    // the exact pattern #366 Update 3 reported as a false-block under a naive
    // git-diff-HEAD check; the HEAD~1..HEAD fallback covers it.
    test("PASSES when this session's code is in the last commit (clean tree)", () => {
      initGitRepo();
      git(["commit", "-q", "--allow-empty", "-m", "init"]);
      stageCodeGenDocsOnly();
      writeWorkspaceFile(proj, "src/auth/login.ts");
      git(["add", "-A"]); // stage BOTH the docs and the new code
      git(["commit", "-q", "-m", "code-generation output"]);
      const r = approveCodeGen();
      expect(r.rc, r.out).toBe(0);
    }, 30000);

    // SINGLE-commit clean tree, the source IS in the sole commit -> PASS. The
    // greenfield "git init, generate, commit, approve" path: there is no parent,
    // so `git diff HEAD~1 HEAD` errors and gitHasSourceWork cannot inspect the
    // last commit. It must return null (NOT false) so workspaceHasWork falls back
    // to the filesystem probe, which sees the committed src/ - otherwise the
    // code-generation approve is false-refused (gitHasSourceWork header contract;
    // @leandrodamascena's PR #443 review). Distinct from the case above: that one
    // makes a separate `--allow-empty init` commit first (HEAD~1 resolves); this
    // one has exactly ONE commit (HEAD~1 misses).
    test("PASSES on a single-commit clean tree whose only commit contains the source", () => {
      initGitRepo();
      stageCodeGenDocsOnly();
      writeWorkspaceFile(proj, "src/auth/login.ts");
      git(["add", "-A"]); // stage docs + the new code into the FIRST and ONLY commit
      git(["commit", "-q", "-m", "first commit: code-generation output"]);
      const r = approveCodeGen();
      expect(r.rc, r.out).toBe(0);
    }, 30000);
  });

  // --- Settled-swarm exemption (code-generation under autonomous swarm) ------
  //
  // A swarm's per-unit artifacts and source live in Bolt WORKTREES; the main
  // checkout has neither, so both guard layers would refuse the settle
  // approval the engine just presented. The referee's per-unit convergence
  // ledger is the evidence instead: with a valid DAG whose EVERY unit has a
  // current-run SWARM_UNIT_CONVERGED row, the guard exempts. Any unconverged
  // unit keeps the guard strict (fails closed).
  describe("settled-swarm exemption (autonomous code-generation)", () => {
    const UNITS = ["user-auth", "billing"];

    function seedSwarm(converged: string[]): void {
      guarded(proj, ["set", "Current Stage=code-generation"]);
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
      // A valid two-unit DAG in the compiled runtime graph.
      writeFileSync(
        join(seededRecordDir(proj), "runtime-graph.json"),
        `${JSON.stringify({
          bolt_dag: {
            units: UNITS.map((name) => ({ name, depends_on: [] })),
            batches: [UNITS],
          },
        })}\n`,
      );
      // Referee convergence rows for the converged subset, carrying the
      // attempt-identity stamp (Stage + Run floor) the consumers require; the
      // fixture has no STAGE_STARTED row, so the matching floor is the exact
      // no-boundary sentinel.
      const shard = seededAuditShard(proj);
      mkdirSync(join(shard, ".."), { recursive: true });
      const rows = converged
        .map((unit, i) =>
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
          ].join("\n")
        )
        .join("");
      writeFileSync(shard, rows, { flag: "a" });
      for (const unit of converged) reviewCodeGen(proj, unit);
    }

    test("PASSES with zero on-disk artifacts once every DAG unit converged", () => {
      // The migrated review flow writes each converged unit's reviewed plan
      // into the record dir, but the exemption is still granted from the
      // convergence ledger before any produces walk.
      seedSwarm(UNITS); // all converged
      bypassed(proj, ["gate-start", "code-generation"]);
      const r = guarded(
        proj,
        ["approve", "code-generation", "--user-input", "ok"],
        { AIDLC_SKIP_SOURCE_FRESHNESS: "1" },
      );
      expect(r.rc).toBe(0);
    });

    test("REFUSES while any DAG unit is unconverged (fails closed)", () => {
      seedSwarm([UNITS[0]]); // one of two converged
      gateSetupBypassed(proj, ["gate-start", "code-generation"]);
      const r = guarded(proj, ["approve", "code-generation", "--user-input", "ok"]);
      expect(r.rc).not.toBe(0);
      // The converged unit's reviewed plan exists in the record dir (the
      // request -> appendix -> verdict flow writes it), so the refusal falls
      // through the produces walk to the workspace_requires source-work
      // guard - still fail-closed, no state mutation.
      expect((JSON.parse(r.out) as { error: string }).error).toContain(
        'Cannot complete "code-generation"',
      );
      expect((JSON.parse(r.out) as { error: string }).error).toContain(
        "no source work is evident",
      );
    });

    test("unexpected settled-swarm probe failures are controlled and leave state unchanged", () => {
      seedSwarm(UNITS);
      const brokenScopes = join(proj, "broken-scopes");
      mkdirSync(brokenScopes, { recursive: true });
      writeFileSync(join(brokenScopes, "broken.md"), "# Missing frontmatter\n");
      const statePath = seededStateFile(proj);
      const before = readFileSync(statePath, "utf-8");

      const r = guarded(
        proj,
        ["gate-start", "code-generation"],
        { AIDLC_SCOPES_DIR: brokenScopes },
      );

      expect(r.rc).toBe(1);
      const refusal = JSON.parse(r.out) as { error: string };
      expect(refusal.error).toContain(
        'Cannot present "code-generation" for approval: the settled-swarm probe failed unexpectedly',
      );
      expect(refusal.error).toContain("settled-swarm probe failed unexpectedly");
      expect(refusal.error).toContain("Scope file missing frontmatter");
      expect(readFileSync(statePath, "utf-8")).toBe(before);
    });
  });
});
