// covers: function:reviewArtifactEntries, tool:aidlc-review-brief, audit:GATE_APPROVED,
// audit:GATE_REJECTED, audit:STAGE_JUMPED

import {
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFormatsForProject,
  findStageBySlug,
  readAllAuditShards,
  reviewArtifactEntries,
  sourcePathKey,
  writeUnitSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  acceptedRiskDispositionField,
  hydrateReviewArtifactContexts,
  parseReviewArtifact,
  readReviewArtifactContexts,
  readReviewFindingDispositions,
  rejectedFindingDispositionField,
  renderFindingsContext,
  renderReviewBrief,
  renderSummaryConfirmationBrief,
  REVIEW_FINDING_DISPOSITIONS_FIELD,
} from "../../dist/claude/.claude/tools/aidlc-review-brief.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seedBoltDag,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const REVIEW_BRIEF = join(AIDLC_SRC, "tools", "aidlc-review-brief.ts");

setDefaultTimeout(30_000);
const tempDirs: string[] = [];
const TEST_ENV = {
  ...process.env,
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
    env: TEST_ENV,
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

function reviewMarkdown(
  verdict: "READY" | "NOT-READY",
  rows: string[],
  iteration = 1,
): string {
  return [
    "# Requirements",
    "",
    "## Review",
    "",
    `**Verdict:** ${verdict}`,
    "**Reviewer:** aidlc-product-lead-agent",
    "**Date:** 2026-08-25T12:00:00Z",
    `**Iteration:** ${iteration}`,
    "",
    "### Findings",
    "",
    "| ID | Severity | Location | Finding | Required action | Status |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "### Summary",
    "",
    "Deterministic fixture.",
    "",
  ].join("\n");
}

function requirementProject(
  rows: string[],
  verdict: "READY" | "NOT-READY" = "READY",
) {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const dir = join(
    seededRecordDir(proj),
    "inception",
    "requirements-analysis",
  );
  mkdirSync(dir, { recursive: true });
  const artifact = join(dir, "requirements.md");
  const questions = join(dir, "requirements-analysis-questions.md");
  writeFileSync(artifact, reviewMarkdown(verdict, rows), "utf-8");
  writeFileSync(questions, "# Questions\n", "utf-8");
  return {
    proj,
    artifact,
    relativeArtifact: relative(proj, artifact).replaceAll("\\", "/"),
    questions,
  };
}

function recordReviewAndOpenGate(proj: string, artifact: string): void {
  const reviewed = readFileSync(artifact, "utf-8");
  const reviewStart = reviewed.indexOf("## Review");
  expect(reviewStart).toBeGreaterThanOrEqual(0);
  const requestedBody = reviewed.slice(0, reviewStart);
  const reviewerAppendix = reviewed.slice(reviewStart);
  writeFileSync(artifact, requestedBody, "utf-8");
  const base = [
    "review",
    "--stage",
    "requirements-analysis",
    "--reviewer",
    "aidlc-product-lead-agent",
    "--iteration",
    "1",
  ];
  expect(run(LOG, base, proj).status).toBe(0);
  writeFileSync(artifact, `${requestedBody}${reviewerAppendix}`, "utf-8");
  expect(run(LOG, [...base, "--verdict", "READY"], proj).status).toBe(0);
  expect(
    run(STATE, ["gate-start", "requirements-analysis"], proj).status,
  ).toBe(0);
}

function perUnitReviewProject(
  stageSlug: "functional-design" | "code-generation",
  units: string[],
): { proj: string; artifacts: Map<string, string> } {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-construction.md");
  seedBoltDag(proj, units);
  const artifacts = new Map<string, string>();
  const files = stageSlug === "functional-design"
    ? ["entities.md", "rules.md", "functional-spec.md", "traceability.json"]
    : [
      "code-generation-plan.md",
      "unit-test-instructions.md",
      "code-summary.md",
      "traceability.json",
    ];
  for (const [index, unit] of units.entries()) {
    const dir = join(
      seededRecordDir(proj),
      "construction",
      unit,
      stageSlug,
    );
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(dir, file), `# ${file}\n`, "utf-8");
    }
    const artifact = join(dir, files[0]);
    const relativeArtifact = relative(proj, artifact).replaceAll("\\", "/");
    writeFileSync(
      artifact,
      reviewMarkdown(
        "NOT-READY",
        [
          `| R-0${index + 1} | Major | ${relativeArtifact} > section | ${unit} concern | Fix ${unit} | New |`,
        ],
      ),
      "utf-8",
    );
    artifacts.set(unit, relativeArtifact);
  }
  return { proj, artifacts };
}

function seedReviewedPerUnitStage(
  proj: string,
  stageSlug: string,
  unit: string,
  findingId: string,
): string {
  const stage = findStageBySlug(stageSlug)!;
  const entries = reviewArtifactEntries(
    proj,
    stage,
    artifactFormatsForProject(proj),
    unit,
  ) ?? [];
  const primary = entries.find((entry) =>
    entry.path !== null && entry.required && entry.path.endsWith(".md")
  );
  if (primary?.path === null || primary === undefined) {
    throw new Error(`No reviewable artifact for ${stageSlug}/${unit}`);
  }
  for (const entry of entries) {
    if (entry.path === null) continue;
    mkdirSync(dirname(entry.path), { recursive: true });
    writeFileSync(entry.path, `# ${entry.logicalPath}\n`, "utf-8");
  }
  const artifact = relative(proj, primary.path).replaceAll("\\", "/");
  writeFileSync(
    primary.path,
    reviewMarkdown(
      "NOT-READY",
      [
        `| ${findingId} | Major | ${artifact} > section | ${stageSlug} concern | Re-check ${stageSlug} | New |`,
      ],
    ),
    "utf-8",
  );
  return artifact;
}

function auditBlock(
  title: string,
  timestamp: string,
  event: string,
  fields: Record<string, string>,
): string {
  return [
    `## ${title}`,
    "",
    `**Timestamp**: ${timestamp}`,
    `**Event**: ${event}`,
    ...Object.entries(fields).map(([name, value]) => `**${name}**: ${value}`),
    "",
    "---",
    "",
  ].join("\n");
}

const ROW_NEW =
  "| R-01 | Minor | aidlc/spaces/default/intents/fixture/inception/requirements-analysis/requirements.md > FR-1 | Deadline is missing | Add a delivery date | New |";
const ROW_UNRESOLVED =
  "| R-01 | Minor | aidlc/spaces/default/intents/fixture/inception/requirements-analysis/requirements.md > FR-1 | Deadline is still missing | Add a delivery date | Unresolved |";
const ROW_RESOLVED =
  "| R-01 | Minor | aidlc/spaces/default/intents/fixture/inception/requirements-analysis/requirements.md > FR-1 | Deadline was missing | No further action | Resolved |";
const ROW_NEW_SECOND =
  "| R-02 | Major | aidlc/spaces/default/intents/fixture/inception/requirements-analysis/requirements-analysis-questions.md > Q4 | Owner is unclear | Name the accountable owner | New |";

describe("t304 executable review brief scenarios", () => {
  test("READY and NOT-READY render the exact first-review outcome without exposing raw verdict tokens", () => {
    for (const verdict of ["READY", "NOT-READY"] as const) {
      const { proj } = requirementProject(
        verdict === "READY" ? [] : [ROW_NEW],
        verdict,
      );
      const stage = findStageBySlug("requirements-analysis")!;
      const rendered = renderReviewBrief(proj, stage, "first");
      expect(rendered).toContain("**Why now:** First review completed.");
      expect(rendered).toContain(
        verdict === "READY"
          ? "**Review outcome:** No blocking concerns were found."
          : "**Review outcome:** Concerns remain for your decision.",
      );
      expect(rendered).not.toContain(`**Review outcome:** ${verdict}`);
      if (verdict === "NOT-READY") expect(rendered).toContain("R-01");
    }
  });

  test("re-review preserves resolved, unresolved, and new stable IDs across multiple referenced artifacts", () => {
    const first = parseReviewArtifact(
      reviewMarkdown("NOT-READY", [ROW_NEW, ROW_NEW_SECOND]),
      "aidlc/requirements.md",
    )!;
    const second = parseReviewArtifact(
      reviewMarkdown("NOT-READY", [ROW_RESOLVED, ROW_NEW_SECOND], 2),
      "aidlc/requirements.md",
    )!;
    expect(first.findings.map((finding) => finding.id)).toEqual([
      "R-01",
      "R-02",
    ]);
    expect(second.findings.map((finding) => finding.id)).toEqual([
      "R-01",
      "R-02",
    ]);
    expect(second.findings[0].status).toBe("Resolved");
    expect(renderFindingsContext([second])).toContain(
      "requirements-analysis-questions.md > Q4",
    );
  });

  test("the single per-Unit stage gate displays exactly the open findings approval dispositions cover", () => {
    const { proj, artifacts } = perUnitReviewProject(
      "functional-design",
      ["unit-a", "unit-b"],
    );
    const rendered = run(
      REVIEW_BRIEF,
      [
        "review",
        "--stage",
        "functional-design",
        "--why",
        "first",
        "--unit",
        "unit-b",
      ],
      proj,
    );
    expect(rendered.status, rendered.out).toBe(0);

    const displayed = new Set<string>();
    let currentArtifact = "";
    for (const line of rendered.stdout.split(/\r?\n/)) {
      const artifact = /^\*\*Review artifact:\*\* `([^`]+)`$/.exec(line);
      if (artifact) {
        currentArtifact = artifact[1];
        continue;
      }
      const finding = /^\| (R-[0-9]+) \|/.exec(line);
      if (finding && currentArtifact) {
        displayed.add(`${currentArtifact}#${finding[1]}`);
      }
    }

    const stage = findStageBySlug("functional-design")!;
    const serialized = acceptedRiskDispositionField(proj, stage);
    expect(serialized).toBeString();
    const dispositioned = new Set(
      (
        JSON.parse(serialized!) as {
          dispositions: Array<{ artifact: string; id: string }>;
        }
      ).dispositions.map((finding) => `${finding.artifact}#${finding.id}`),
    );
    expect([...displayed].sort()).toEqual([...dispositioned].sort());
    expect(displayed).toEqual(
      new Set([
        `${artifacts.get("unit-a")}#R-01`,
        `${artifacts.get("unit-b")}#R-02`,
      ]),
    );
  });

  test("Unit-end disposition readback follows Gate Stages and Unit scope", () => {
    const { proj, artifacts } = perUnitReviewProject(
      "functional-design",
      ["unit-a", "unit-b"],
    );
    const stage = findStageBySlug("functional-design")!;
    const serialized = acceptedRiskDispositionField(proj, stage, "unit-b");
    expect(serialized).toBeString();
    expect(
      (
        JSON.parse(serialized!) as {
          dispositions: Array<{ artifact: string; id: string }>;
        }
      ).dispositions,
    ).toMatchObject([
      { artifact: artifacts.get("unit-b"), id: "R-02" },
    ]);

    appendAuditEntry(
      "GATE_APPROVED",
      {
        Stage: "code-generation",
        Unit: "unit-b",
        "Gate Scope": "unit-end",
        "Gate Stages": "functional-design,code-generation",
        [REVIEW_FINDING_DISPOSITIONS_FIELD]: serialized!,
      },
      proj,
    );
    expect([
      ...readReviewFindingDispositions(
        proj,
        "functional-design",
        "unit-b",
      ).values(),
    ]).toMatchObject([
      { artifact: artifacts.get("unit-b"), status: "Accepted risk" },
    ]);
    expect(
      readReviewFindingDispositions(
        proj,
        "functional-design",
        "unit-a",
      ).size,
    ).toBe(0);
  });

  test("Approve records Accepted risk atomically and future context hydrates it", () => {
    const { proj, artifact } = requirementProject([ROW_NEW]);
    recordReviewAndOpenGate(proj, artifact);
    const approved = run(
      ORCHESTRATE,
      [
        "report",
        "--stage",
        "requirements-analysis",
        "--result",
        "approved",
        "--user-input",
        "Approve",
      ],
      proj,
    );
    expect(approved.status, approved.out).toBe(0);

    const dispositions = [
      ...readReviewFindingDispositions(proj, "requirements-analysis").values(),
    ];
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0].status).toBe("Accepted risk");
    expect(readAllAuditShards(proj)).toContain(
      `**${REVIEW_FINDING_DISPOSITIONS_FIELD}**:`,
    );

    const stage = findStageBySlug("requirements-analysis")!;
    const hydrated = hydrateReviewArtifactContexts(
      readReviewArtifactContexts(proj, stage),
      readReviewFindingDispositions(proj, stage.slug),
    );
    expect(hydrated[0].findings[0].status).toBe("Accepted risk");
  });

  test("Request Changes records only explicitly rejected findings with the exact reason", () => {
    const { proj, artifact, relativeArtifact } = requirementProject([ROW_NEW]);
    recordReviewAndOpenGate(proj, artifact);
    const rejected = run(
      ORCHESTRATE,
      [
        "report",
        "--stage",
        "requirements-analysis",
        "--result",
        "rejected",
        "--user-input",
        "Request Changes",
        "--reason",
        "R-01 does not apply to this internal milestone",
        "--reject-finding",
        `${relativeArtifact}#R-01=Internal milestones intentionally have no public date`,
      ],
      proj,
    );
    expect(rejected.status, rejected.out).toBe(0);
    const dispositions = [
      ...readReviewFindingDispositions(proj, "requirements-analysis").values(),
    ];
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0].status).toBe(
      "Rejected: Internal milestones intentionally have no public date",
    );
  });

  test("generic Request Changes leaves findings unresolved", () => {
    const { proj, artifact } = requirementProject([ROW_UNRESOLVED]);
    recordReviewAndOpenGate(proj, artifact);
    expect(
      run(
        STATE,
        [
          "reject",
          "requirements-analysis",
          "--user-input",
          "Request Changes",
          "--feedback",
          "Add the missing date",
        ],
        proj,
      ).status,
    ).toBe(0);
    expect(
      readReviewFindingDispositions(proj, "requirements-analysis").size,
    ).toBe(0);
  });

  test("stale artifact brief retains the changed output through the required recovery review", () => {
    const { proj, questions, relativeArtifact } = requirementProject([ROW_NEW]);
    appendAuditEntry(
      "REVIEW_COMPLETED",
      {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
        Iteration: "1",
        Verdict: "READY",
        "Artifact Fingerprint": `sha256:${"a".repeat(64)}`,
      },
      proj,
    );
    appendAuditEntry(
      "ARTIFACT_UPDATED",
      {
        File: questions,
        Tool: "Edit",
      },
      proj,
    );
    appendAuditEntry(
      "REVIEW_REQUESTED",
      {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
        Iteration: "2",
        Recovery: "stale-receipt",
        "Artifact Fingerprint": `sha256:${"b".repeat(64)}`,
      },
      proj,
    );
    appendAuditEntry(
      "REVIEW_COMPLETED",
      {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
        Iteration: "2",
        Verdict: "READY",
        "Artifact Fingerprint": `sha256:${"b".repeat(64)}`,
      },
      proj,
    );
    const stage = findStageBySlug("requirements-analysis")!;
    const brief = renderReviewBrief(proj, stage, "stale");
    const relativeQuestions = relative(proj, questions).replaceAll("\\", "/");
    expect(brief).toContain(`**Changed upstream:** \`${relativeQuestions}\``);
    expect(brief).toContain(
      `**Downstream reviews requiring re-check:** \`${relativeArtifact}#Review\``,
    );
    appendAuditEntry(
      "GATE_REJECTED",
      {
        Stage: "requirements-analysis",
        Feedback: "Revise the changed questions",
      },
      proj,
    );
    const nextAttempt = renderReviewBrief(proj, stage, "stale");
    expect(nextAttempt).not.toContain(relativeQuestions);
    expect(nextAttempt).not.toContain(`${relativeArtifact}#Review`);
  });

  test("cross-shard equal-second gate and write do not invent an ordering", () => {
    const { proj, questions, relativeArtifact } = requirementProject([ROW_NEW]);
    const auditDir = seededAuditDir(proj);
    rmSync(auditDir, { recursive: true, force: true });
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      join(auditDir, "a.md"),
      auditBlock(
        "Review Completed",
        "2026-08-26T00:00:00Z",
        "REVIEW_COMPLETED",
        {
          Stage: "requirements-analysis",
          Reviewer: "aidlc-product-lead-agent",
          Iteration: "1",
          Verdict: "READY",
          "Artifact Fingerprint": `sha256:${"a".repeat(64)}`,
        },
      ) +
        auditBlock(
          "Artifact Updated",
          "2026-08-26T00:00:01Z",
          "ARTIFACT_UPDATED",
          {
            File: questions,
            Tool: "Edit",
          },
        ),
      "utf-8",
    );
    writeFileSync(
      join(auditDir, "b.md"),
      auditBlock(
        "Gate Rejected",
        "2026-08-26T00:00:01Z",
        "GATE_REJECTED",
        {
          Stage: "requirements-analysis",
          Feedback: "Revise the questions",
        },
      ),
      "utf-8",
    );

    const stage = findStageBySlug("requirements-analysis")!;
    const brief = renderReviewBrief(proj, stage, "stale");
    expect(brief).not.toContain(relative(proj, questions).replaceAll("\\", "/"));
    expect(brief).not.toContain(`${relativeArtifact}#Review`);
  });

  test("cross-shard equal-second gate does not consume backward-jump invalidation paths", () => {
    const { proj, relativeArtifact } = requirementProject([ROW_NEW]);
    seedStateFile(proj, "state-construction.md");
    seedBoltDag(proj, ["widget-checkout"]);
    const functionalRelative = seedReviewedPerUnitStage(
      proj,
      "functional-design",
      "widget-checkout",
      "R-03",
    );
    const auditDir = seededAuditDir(proj);
    rmSync(auditDir, { recursive: true, force: true });
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      join(auditDir, "a.md"),
      auditBlock(
        "Gate Approved",
        "2026-08-26T00:00:01Z",
        "GATE_APPROVED",
        {
          Stage: "functional-design",
          Decision: "Approve",
        },
      ),
      "utf-8",
    );
    writeFileSync(
      join(auditDir, "b.md"),
      auditBlock(
        "Stage Jumped",
        "2026-08-26T00:00:01Z",
        "STAGE_JUMPED",
        {
          Direction: "BACKWARD",
          Source: "code-generation",
          Target: "requirements-analysis",
          Scope: "feature",
          "Changed Upstream Artifacts": JSON.stringify([relativeArtifact]),
          "Invalidated Downstream Artifacts": JSON.stringify([
            functionalRelative,
          ]),
          "Invalidated Downstream Reviews": JSON.stringify([
            `${functionalRelative}#Review`,
          ]),
        },
      ),
      "utf-8",
    );

    const stage = findStageBySlug("requirements-analysis")!;
    const brief = renderReviewBrief(proj, stage, "stale");
    expect(brief).toContain(`\`${functionalRelative}\``);
    expect(brief).toContain(`\`${functionalRelative}#Review\``);
  });

  test("stale source brief retains changed claimed paths through recovery and a later Unit review", () => {
    const { proj, artifacts } = perUnitReviewProject(
      "code-generation",
      ["unit-a", "unit-b"],
    );
    const key = sourcePathKey("", "src/app.ts");
    const claims = { claims: new Set([key]), prefixes: [] };
    const before = writeUnitSourceSnapshot(
      proj,
      "code-generation",
      "unit-a",
      new Map([[key, `100644 ${"a".repeat(40)}`]]),
      claims,
      "b".repeat(64),
    );
    const after = writeUnitSourceSnapshot(
      proj,
      "code-generation",
      "unit-a",
      new Map([[key, `100644 ${"c".repeat(40)}`]]),
      claims,
      "b".repeat(64),
    );
    appendAuditEntry(
      "REVIEW_COMPLETED",
      {
        Stage: "code-generation",
        Reviewer: "aidlc-architecture-reviewer-agent",
        Unit: "unit-a",
        Iteration: "1",
        Verdict: "READY",
        "Artifact Fingerprint": `sha256:${"d".repeat(64)}`,
        "Unit Source Fingerprint": before,
      },
      proj,
    );
    appendAuditEntry(
      "REVIEW_REQUESTED",
      {
        Stage: "code-generation",
        Reviewer: "aidlc-architecture-reviewer-agent",
        Unit: "unit-a",
        Iteration: "2",
        Recovery: "stale-receipt",
        "Artifact Fingerprint": `sha256:${"e".repeat(64)}`,
        "Unit Source Fingerprint": after,
      },
      proj,
    );
    appendAuditEntry(
      "REVIEW_COMPLETED",
      {
        Stage: "code-generation",
        Reviewer: "aidlc-architecture-reviewer-agent",
        Unit: "unit-a",
        Iteration: "2",
        Verdict: "READY",
        "Artifact Fingerprint": `sha256:${"e".repeat(64)}`,
        "Unit Source Fingerprint": after,
      },
      proj,
    );
    const unitAArtifact = artifacts.get("unit-a")!;
    appendAuditEntry(
      "ARTIFACT_UPDATED",
      {
        File: join(proj, unitAArtifact),
        Tool: "Edit",
      },
      proj,
    );
    appendAuditEntry(
      "REVIEW_COMPLETED",
      {
        Stage: "code-generation",
        Reviewer: "aidlc-architecture-reviewer-agent",
        Unit: "unit-b",
        Iteration: "1",
        Verdict: "READY",
        "Artifact Fingerprint": `sha256:${"f".repeat(64)}`,
      },
      proj,
    );

    const stage = findStageBySlug("code-generation")!;
    const brief = renderReviewBrief(proj, stage, "stale", "unit-b");
    expect(brief).toContain("`src/app.ts`");
    expect(brief).toContain(`\`${unitAArtifact}\``);
    expect(brief).toContain(`${artifacts.get("unit-a")}#Review`);
  });

  test("reviewer-free stages cannot record finding dispositions", () => {
    const { proj } = requirementProject([]);
    const stage = findStageBySlug("workspace-scaffold")!;
    expect(() =>
      rejectedFindingDispositionField(
        proj,
        stage,
        ["aidlc/workspace.md#R-01=Not applicable"],
      )
    ).toThrow("the stage has no reviewer");
  });

  test("backward jump records concrete upstream, downstream artifact, and review paths", () => {
    const { proj, relativeArtifact } = requirementProject([ROW_NEW]);
    seedStateFile(proj, "state-construction.md");
    seedBoltDag(proj, ["widget-checkout"]);
    const statePath = seededStateFile(proj);
    const cleanState = readFileSync(statePath, "utf-8")
      .replace(
        "Per unit: widget-cart\n- [x] functional-design — EXECUTE\n- [x] nfr-requirements — EXECUTE\n",
        "",
      )
      .replace("- [-] functional-design — EXECUTE", "- [x] functional-design — EXECUTE")
      .replace("- [ ] nfr-requirements — EXECUTE", "- [x] nfr-requirements — EXECUTE")
      .replace("- [ ] code-generation — EXECUTE", "- [-] code-generation — EXECUTE")
      .replace("**Current Stage**: functional-design", "**Current Stage**: code-generation");
    writeFileSync(statePath, cleanState, "utf-8");
    const functionalDir = join(
      seededRecordDir(proj),
      "construction",
      "widget-checkout",
      "functional-design",
    );
    mkdirSync(functionalDir, { recursive: true });
    for (const name of ["entities.md", "rules.md", "traceability.json"]) {
      writeFileSync(join(functionalDir, name), `# ${name}\n`, "utf-8");
    }
    const functional = join(functionalDir, "functional-spec.md");
    writeFileSync(functional, reviewMarkdown("READY", []), "utf-8");
    const nfrRelative = seedReviewedPerUnitStage(
      proj,
      "nfr-requirements",
      "widget-checkout",
      "R-03",
    );
    const jumped = run(
      JUMP,
      [
        "execute",
        "--target",
        "requirements-analysis",
        "--direction",
        "backward",
        "--scope",
        "feature",
      ],
      proj,
    );
    expect(jumped.status, jumped.out).toBe(0);
    appendAuditEntry(
      "REVIEW_REQUESTED",
      {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
        Iteration: "1",
        "Artifact Fingerprint": `sha256:${"a".repeat(64)}`,
      },
      proj,
    );
    appendAuditEntry(
      "REVIEW_COMPLETED",
      {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
        Iteration: "1",
        Verdict: "READY",
        "Artifact Fingerprint": `sha256:${"a".repeat(64)}`,
      },
      proj,
    );

    const stage = findStageBySlug("requirements-analysis")!;
    const brief = renderReviewBrief(proj, stage, "stale");
    const functionalRelative = relative(proj, functional).replaceAll("\\", "/");
    expect(brief).toContain(`\`${relativeArtifact}\``);
    expect(brief).toContain(`\`${functionalRelative}\``);
    expect(brief).toContain(`\`${functionalRelative}#Review\``);
    expect(brief).toContain(`\`${nfrRelative}\``);

    appendAuditEntry(
      "GATE_APPROVED",
      {
        Stage: "functional-design",
        Decision: "Approve",
      },
      proj,
    );
    const nfrStage = findStageBySlug("nfr-requirements")!;
    const laterBrief = renderReviewBrief(
      proj,
      nfrStage,
      "stale",
      "widget-checkout",
    );
    expect(laterBrief).toContain(`\`${nfrRelative}\``);
    expect(laterBrief).not.toContain(functionalRelative);
  });

  test("Guide Me, self-edit, and Chat use the same exact pre-generation decision brief", () => {
    const { proj, questions } = requirementProject([]);
    const stage = findStageBySlug("requirements-analysis")!;
    const expected = renderSummaryConfirmationBrief(
      proj,
      stage,
      questions,
    );
    for (const mode of ["Guide Me", "I'll edit the file", "Chat"]) {
      const rendered = renderSummaryConfirmationBrief(
        proj,
        stage,
        questions,
      );
      expect(rendered, mode).toBe(expected);
      expect(rendered).toContain("**Stage:** Requirements Analysis");
      expect(rendered).toContain("**Confirming:** Consolidated answers in");
      expect(rendered).toContain(
        "**Why now:** All stage questions are answered",
      );
      expect(rendered).toContain(
        "**Looks correct** - record this confirmation and generate",
      );
      expect(rendered).toContain(
        "**Request changes** - leave the artifacts ungenerated",
      );
    }
  });

  test("the shipped CLI renders the same summary brief", () => {
    const { proj, questions } = requirementProject([]);
    const result = run(
      REVIEW_BRIEF,
      [
        "summary",
        "--stage",
        "requirements-analysis",
        "--questions-file",
        questions,
      ],
      proj,
    );
    expect(result.status, result.out).toBe(0);
    expect(result.stdout).toContain("**Stage:** Requirements Analysis");
    expect(result.stdout).toContain("**Decision options:**");
  });
});

describe("t304 protocol and harness projections use the deterministic renderer", () => {
  test("all harnesses ship the review brief tool", () => {
    for (const harness of HARNESS_MATRIX) {
      expect(
        existsSync(
          join(harness.engineRoot, "tools", "aidlc-review-brief.ts"),
        ),
      ).toBe(true);
    }
  });

  test("authored protocols invoke summary, context, and review modes", () => {
    const stageProtocol = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol.md",
      ),
      "utf-8",
    );
    const reviewerProtocol = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol-reviewer.md",
      ),
      "utf-8",
    );
    expect(stageProtocol).toContain("aidlc-review-brief.ts summary");
    expect(reviewerProtocol).toContain("aidlc-review-brief.ts context");
    expect(reviewerProtocol).toContain("aidlc-review-brief.ts review");
    expect(reviewerProtocol).toContain("--reject-finding");
  });
});
