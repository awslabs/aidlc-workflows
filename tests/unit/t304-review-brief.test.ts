// covers: function:reviewArtifactEntries, tool:aidlc-review-brief, audit:GATE_APPROVED,
// audit:GATE_REJECTED, audit:STAGE_JUMPED, function:latestReviewRecordRefs,
// function:reviewRecordFindings, function:readReviewRecord, function:parseReviewSection,
// function:reviewFindingFingerprint, function:validReviewFindingStatus,
// function:reviewSectionVerdict, function:reviewFindingsSectionLines,
// function:unreadableFindingsTableFinding, function:isUnreadableFindingsTableFinding,
// function:readFindingsTable

import { deterministicCaseTimeoutMs } from "../harness/test-budget.ts";
import {
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  findStageBySlug,
  parseReviewSection,
  readAllAuditShards,
  readAuditShardEvents,
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

setDefaultTimeout(Math.max(30_000, deterministicCaseTimeoutMs()));
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

function standaloneReview(verdict: "READY" | "NOT-READY", rows: string[]): string {
  return [
    `**Verdict:** ${verdict}`,
    "**Reviewer:** aidlc-product-lead-agent",
    "**Iteration:** 1",
    "",
    "### Findings",
    "",
    "| ID | Severity | Location | Finding | Required action | Status |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

const REVIEW_REQUEST = [
  "review",
  "--stage",
  "requirements-analysis",
  "--reviewer",
  "aidlc-product-lead-agent",
  "--iteration",
  "1",
];

// A request whose one --retry-pending attempt is spent, with an empty slot:
// the state in which the retried incomplete fallback applies.
function retriedReviewRequest(): { proj: string; draft: string } {
  const { proj, artifact } = requirementProject([]);
  writeFileSync(artifact, "# Requirements\n\nReviewed requirements.\n", "utf-8");
  const requested = run(LOG, REVIEW_REQUEST, proj);
  expect(requested.status, requested.out).toBe(0);
  const retried = run(LOG, [...REVIEW_REQUEST, "--retry-pending"], proj);
  expect(retried.status, retried.out).toBe(0);
  const draft = join(proj, (JSON.parse(retried.stdout) as { reviewFile: string }).reviewFile);
  mkdirSync(dirname(draft), { recursive: true });
  return { proj, draft };
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
  const requested = run(LOG, base, proj);
  expect(requested.status, requested.out).toBe(0);
  const { reviewFile } = JSON.parse(requested.stdout) as { reviewFile: string };
  const draft = join(proj, reviewFile);
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, reviewerAppendix.replace(/^## Review\s*/, ""), "utf-8");
  expect(run(LOG, [...base, "--verdict", "READY"], proj).status).toBe(0);
  expect(
    run(STATE, ["gate-start", "requirements-analysis"], proj).status,
  ).toBe(0);
}

// The record path: the reviewer writes the review to the slot the request
// names; the verdict records it and the artifact keeps its requested bytes.
function recordReviewViaRecordAndOpenGate(
  proj: string,
  reviewBody: string,
): { reviewRecord: string } {
  const base = [
    "review",
    "--stage",
    "requirements-analysis",
    "--reviewer",
    "aidlc-product-lead-agent",
    "--iteration",
    "1",
  ];
  const requested = run(LOG, base, proj);
  expect(requested.status, requested.out).toBe(0);
  const { reviewFile } = JSON.parse(requested.stdout) as { reviewFile: string };
  const draft = join(proj, reviewFile);
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, reviewBody, "utf-8");
  const completed = run(LOG, [...base, "--verdict", "READY"], proj);
  expect(completed.status, completed.out).toBe(0);
  const { reviewRecord } = JSON.parse(completed.stdout) as { reviewRecord: string };
  expect(reviewRecord).toMatch(
    /^\.aidlc-engine\/reviews\/requirements-analysis\/stage\/[0-9a-f]{16}\/1\.json$/,
  );
  expect(existsSync(draft)).toBe(false);
  expect(
    run(STATE, ["gate-start", "requirements-analysis"], proj).status,
  ).toBe(0);
  return { reviewRecord };
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
  const entries = reviewArtifactEntries(proj, stage, unit) ?? [];
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

  test.each(["New", "Unresolved", "Resolved", "Accepted risk", "Rejected: duplicate"])(
    "a short findings row offers a repair hint for trailing status %s",
    (status) => {
      // Required action was omitted here, but the parser cannot identify
      // that column reliably from the remaining positional values.
      const shortRow =
        `| R-05 | Minor | aidlc/requirements.md > FR-1 | Deadline is missing | ${status} |`;
      expect(() =>
        parseReviewArtifact(
          reviewMarkdown("NOT-READY", [shortRow]),
          "aidlc/requirements.md",
        )
      ).toThrow(
        "aidlc/requirements.md#R-05: row has 5 cells, header declares 6. " +
          "Expected columns: ID | Severity | Location | Finding | Required action | Status. " +
          `The last cell ${JSON.stringify(status)} looks like Status; check earlier cells for a missing value or "|" separator`,
      );
    },
  );

  test.each([
    ["| R-05 | Minor | aidlc/requirements.md > FR-1 | Deadline is missing | Fix it |", 5],
    ["| R-05 | Minor | aidlc/requirements.md > FR-1 | Deadline is missing |", 4],
    ["| R-05 | Minor | aidlc/requirements.md > FR-1 | Deadline is missing | |", 5],
  ] satisfies [string, number][])("a short row without a recognizable trailing status shows the expected columns: %s", (row, count) => {
    expect(() =>
      parseReviewArtifact(
        reviewMarkdown("NOT-READY", [row]),
        "aidlc/requirements.md",
      )
    ).toThrow(
      `aidlc/requirements.md#R-05: row has ${count} cells, header declares 6. ` +
        "Expected columns: ID | Severity | Location | Finding | Required action | Status. " +
        'Check for a missing cell or "|" separator',
    );
  });

  test("reordered headers keep their declared order without treating a non-final Status as shifted", () => {
    const review = reviewMarkdown("NOT-READY", [
      "| R-05 | Resolved | Minor | aidlc/requirements.md > FR-1 | New |",
    ]).replace(
      "| ID | Severity | Location | Finding | Required action | Status |",
      "| ID | Status | Severity | Location | Finding | Required action |",
    );
    expect(() => parseReviewArtifact(review, "aidlc/requirements.md")).toThrow(
      "aidlc/requirements.md#R-05: row has 5 cells, header declares 6. " +
        "Expected columns: ID | Status | Severity | Location | Finding | Required action. " +
        'Check for a missing cell or "|" separator',
    );
  });

  test("a findings row with extra cells reports the surplus", () => {
    const longRow =
      "| R-06 | Minor | aidlc/requirements.md > FR-1 | Extra | Fix it | New | surplus |";
    expect(() =>
      parseReviewArtifact(
        reviewMarkdown("NOT-READY", [longRow]),
        "aidlc/requirements.md",
      )
    ).toThrow("row has 7 cells, header declares 6: 1 unexpected extra cell(s)");
  });

  const findingIds = (body: string) =>
    parseReviewSection(body, "aidlc/requirements.md").findings.map((finding) => finding.id);
  const unpiped = (row: string) => row.replace(/^\| /, "").replace(/ \|$/, "");
  const CANONICAL_SEPARATOR = "|---|---|---|---|---|---|";

  test("a missing separator cannot silently consume the first finding", () => {
    const body = reviewMarkdown("NOT-READY", [ROW_NEW, ROW_NEW_SECOND])
      .replace(`${CANONICAL_SEPARATOR}\n`, "");
    expect(() => findingIds(body))
      .toThrow("requires a Markdown separator row immediately after its header");
  });

  test("a separator with the wrong number of cells is named", () => {
    const body = reviewMarkdown("NOT-READY", [ROW_NEW])
      .replace(CANONICAL_SEPARATOR, "|---|---|---|---|---|");
    expect(() => findingIds(body)).toThrow("separator row has 5 cells, header declares 6");
  });

  test("a separator with no header above it is named", () => {
    const body = reviewMarkdown("NOT-READY", [ROW_NEW]).replace(`${CANONICAL_HEADER}\n`, "");
    expect(() => findingIds(body)).toThrow("findings table has no header row above its separator");
  });

  test("duplicate required columns cannot shadow a finding's identity", () => {
    const body = reviewMarkdown("NOT-READY", [])
      .replace("| Status |", "| Status | ID |")
      .replace(CANONICAL_SEPARATOR, "|---|---|---|---|---|---|---|");
    expect(() => findingIds(body)).toThrow("findings table repeats required columns: ID");
  });

  test("findings split across two tables are named", () => {
    const body = reviewMarkdown("NOT-READY", [
      ROW_NEW, "", CANONICAL_HEADER, CANONICAL_SEPARATOR, ROW_NEW_SECOND,
    ]);
    expect(() => findingIds(body)).toThrow("findings are split across more than one table");
  });

  test("text with a pipe directly under the table is told to leave a blank line", () => {
    const body = reviewMarkdown("NOT-READY", [ROW_NEW, "See the note | above."]);
    expect(() => findingIds(body)).toThrow("put a blank line between them");
  });

  test("literal table examples in fences and comments do not hide or invalidate the findings", () => {
    const example = ["| ID | Status |", "|---|---|", "| R-99 | New |"].join("\n");
    const body = reviewMarkdown("NOT-READY", [ROW_NEW]).replace("### Findings", [
      "```markdown", `### Findings\n${example}`, "```", "", "<!--", example, "-->", "", "### Findings",
    ].join("\n"));
    expect(findingIds(body)).toEqual(["R-01"]);
  });

  test.each(["`", "``"])("inline code delimiters cannot pair across finding rows: %s", (marker) => {
    const body = reviewMarkdown("NOT-READY", [
      `| R-01 | Minor | a.md | Literal ${marker} token is unclear | Clarify the token | New |`,
      `| R-02 | Major | b.md | Another ${marker} token is unclear | Correct the contract | New |`,
    ]);
    const findings = parseReviewSection(body, "aidlc/requirements.md").findings;
    expect(findings.map((finding) => finding.id)).toEqual(["R-01", "R-02"]);
    expect(findings.map((finding) => finding.finding)).toEqual([
      `Literal ${marker} token is unclear`, `Another ${marker} token is unclear`,
    ]);
  });

  test("unfinished inline HTML in one finding cannot hide a later row", () => {
    const body = reviewMarkdown("NOT-READY", [
      "| R-01 | Minor | a.md | Literal <span token is unclear | Clarify it | New |",
      '| R-02 | Major | b.md | Attribute title="x"> is unclear | Correct it | New |',
    ]);
    expect(findingIds(body)).toEqual(["R-01", "R-02"]);
  });

  test("unfinished HTML or code before the table cannot hide its findings", () => {
    for (const prose of ["Malformed <span", "Unclosed `code"]) {
      const body = reviewMarkdown("NOT-READY", [ROW_NEW])
        .replace("### Findings\n\n| ID |", `### Findings\n\n${prose}\n| ID |`);
      expect(findingIds(body)).toEqual(["R-01"]);
    }
  });

  test("a pipe line inside a multiline code span is not a table row", () => {
    const body = reviewMarkdown("NOT-READY", [ROW_NEW]).replace(
      "### Findings\n\n| ID |",
      "### Findings\n\nThe example `row\n| not a finding |\nend` stays literal.\n\n| ID |",
    );
    expect(findingIds(body)).toEqual(["R-01"]);
  });

  test("rows hidden by unfinished markup without a separator are refused", () => {
    const body = reviewMarkdown("NOT-READY", ["| R-01 | Major | a.md | Missing criterion | Add it | New |"])
      .replace("### Findings\n\n| ID |", "### Findings\n\nMalformed <span\n| ID |")
      .replace(`${CANONICAL_SEPARATOR}\n`, "");
    expect(() => findingIds(body)).toThrow("findings rows do not render as a table");
  });

  test.each([
    ["an unclosed fence", "```text"],
    ["an unclosed HTML comment", "<!-- reviewer note"],
  ])("a findings table after %s is refused", (_, opener) => {
    const body = reviewMarkdown("NOT-READY", [ROW_NEW])
      .replace("### Findings\n\n| ID |", `### Findings\n\n${opener}\n| ID |`);
    expect(() => findingIds(body))
      .toThrow("hidden by a code fence, HTML comment, or HTML block that is never closed");
  });

  test("a literal opened after the findings section cannot refuse a table-free review", () => {
    const body = reviewMarkdown("READY", [])
      .replace(`${CANONICAL_HEADER}\n${CANONICAL_SEPARATOR}\n`, "No findings.\n\n```text\n| example |\n```\n")
      .replace("Deterministic fixture.", "Deterministic fixture.\n\n<!-- unfinished note");
    expect(parseReviewSection(body, "aidlc/requirements.md")).toMatchObject({
      findings: [],
      tablePresent: false,
    });
  });

  test("a GFM table without leading pipes is read", () => {
    const body = reviewMarkdown("NOT-READY", [unpiped(ROW_NEW)])
      .replace(CANONICAL_HEADER, unpiped(CANONICAL_HEADER))
      .replace(CANONICAL_SEPARATOR, "---|---|---|---|---|---");
    expect(findingIds(body)).toEqual(["R-01"]);
  });

  test("rows without a leading pipe inside a piped table are read", () => {
    const body = reviewMarkdown("NOT-READY", [
      unpiped(ROW_NEW), "continued prose rendered as a one-cell row", ROW_NEW_SECOND,
    ]);
    expect(findingIds(body)).toEqual(["R-01", "R-02"]);
  });

  test("a shortened table without leading pipes is refused", () => {
    const body = reviewMarkdown("NOT-READY", []).replace(
      `${CANONICAL_HEADER}\n${CANONICAL_SEPARATOR}`,
      "ID | Severity | Finding | Recommendation\n---|---|---|---\nR-01 | Major | Missing criterion | Add it",
    );
    expect(() => findingIds(body)).toThrow("Missing: Location, Required action, Status");
  });

  test("a findings header without leading pipes or a separator is refused", () => {
    const body = reviewMarkdown("NOT-READY", []).replace(
      `${CANONICAL_HEADER}\n${CANONICAL_SEPARATOR}`,
      `${unpiped(CANONICAL_HEADER)}\nR-01 | Major | a.md | Missing criterion | Add it | New`,
    );
    expect(() => findingIds(body)).toThrow("findings rows do not render as a table");
  });

  test.each([
    ["a blockquote", (table: string) => table.split("\n").map((line) => `> ${line}`).join("\n")],
    ["a list item", (table: string) =>
      `- Findings:\n\n${table.split("\n").map((line) => `    ${line}`).join("\n")}`],
  ])("a findings table nested in %s is refused", (_, nest) => {
    const table = [CANONICAL_HEADER, CANONICAL_SEPARATOR, ROW_NEW].join("\n");
    const body = reviewMarkdown("NOT-READY", [ROW_NEW]).replace(`${table}\n`, `${nest(table)}\n`);
    expect(() => findingIds(body)).toThrow("R-01 renders in a table the findings table does not contain");
  });

  test.each([
    ["a second table in another section", (body: string) => body.replace(
      "### Summary\n",
      `### Summary\n\n${CANONICAL_HEADER}\n${CANONICAL_SEPARATOR}\n${ROW_NEW_SECOND}\n`,
    )],
    ["a repeated findings heading", (body: string) =>
      body.replace("### Findings\n", "### Findings\n\nNone recorded yet.\n\n### Findings\n")],
    ["a renamed findings heading", (body: string) => body.replace("### Findings", "### Findings (1)")],
    ["a header ending in a hard line break", (body: string) => body.replace(
      "### Summary\n",
      "### Summary\n\n> | ID | Status |  \n> |---|---|\n> | R-02 | New |\n",
    )],
  ])("findings rendered outside the read table are refused: %s", (_, change) => {
    const body = change(reviewMarkdown("NOT-READY", [ROW_NEW]));
    expect(() => findingIds(body)).toThrow(/R-0[12] renders in a table the findings table does not contain/);
  });

  test("a finding ID quoted in another column does not refuse a complete review", () => {
    const body = reviewMarkdown("NOT-READY", [
      "| R-01 | Minor | R-07 | Duplicates an earlier finding | Merge it | New |",
    ]);
    expect(findingIds(body)).toEqual(["R-01"]);
  });

  test("finding IDs in fenced or commented examples do not refuse a complete review", () => {
    const example = "| ID | Status |\n|---|---|\n| R-99 | New |";
    const body = reviewMarkdown("NOT-READY", [ROW_NEW])
      .replace("### Summary\n", `### Summary\n\n\`\`\`markdown\n${example}\n\`\`\`\n\n`)
      .replace("### Findings\n", `### Findings\n\n<!--\n${example}\n-->\n`);
    expect(findingIds(body)).toEqual(["R-01"]);
  });

  test("a legacy review with findings under a renamed heading reaches the gate as written", () => {
    const { proj } = requirementProject([ROW_NEW], "NOT-READY");
    const stage = findStageBySlug("requirements-analysis")!;
    const artifact = reviewArtifactEntries(proj, stage)![0].path!;
    writeFileSync(
      artifact,
      readFileSync(artifact, "utf-8").replace("### Findings", "### Findings (1)"),
      "utf-8",
    );
    const [context] = readReviewArtifactContexts(proj, stage);
    expect(context.findings.map((finding) => finding.id)).toEqual(["R-00"]);
    expect(context.findingsText).toContain("Deadline is missing");
  });

  test("valid findings preserve escaped pipes and explicit empty cells", () => {
    expect(
      parseReviewArtifact(
        reviewMarkdown("NOT-READY", [
          ROW_NEW,
          String.raw`| R-02 | Minor | aidlc/requirements.md > A\|B | A\|B is missing | | New |`,
        ]).replace("|---|---|---|---|---|---|", "|:---|---:|:---:|---|---|---|"),
        "aidlc/requirements.md",
      )!.findings.map(({ id, location, finding, requiredAction, status }) =>
        ({ id, location, finding, requiredAction, status })
      ),
    ).toEqual([
      {
        id: "R-01",
        location: "aidlc/spaces/default/intents/fixture/inception/requirements-analysis/requirements.md > FR-1",
        finding: "Deadline is missing",
        requiredAction: "Add a delivery date",
        status: "New",
      },
      {
        id: "R-02",
        location: "aidlc/requirements.md > A|B",
        finding: "A|B is missing",
        requiredAction: "",
        status: "New",
      },
    ]);
  });

  test("review completion carries the short-row repair hint without recording a terminal receipt", () => {
    const { proj, artifact } = requirementProject([]);
    writeFileSync(artifact, "# Requirements\n\nFR-1: ship it.\n", "utf-8");
    const base = [
      "review",
      "--stage",
      "requirements-analysis",
      "--reviewer",
      "aidlc-product-lead-agent",
      "--iteration",
      "1",
    ];
    const requested = run(LOG, base, proj);
    expect(requested.status, requested.out).toBe(0);
    const draft = join(proj, JSON.parse(requested.stdout).reviewFile);
    mkdirSync(dirname(draft), { recursive: true });
    writeFileSync(draft, reviewMarkdown("NOT-READY", [
      "| R-05 | Minor | aidlc/requirements.md > FR-1 | Deadline is missing | New |",
    ]).replace(/^# Requirements\n\n/, ""), "utf-8");
    const completed = run(LOG, [...base, "--verdict", "NOT-READY"], proj);
    expect(completed.status).not.toBe(0);
    const diagnostic = JSON.parse(completed.stderr).error;
    expect(diagnostic).toContain('Refusing REVIEW_COMPLETED for "requirements-analysis"');
    expect(diagnostic).toContain("row has 5 cells, header declares 6");
    expect(diagnostic).toContain('The last cell "New" looks like Status');
    expect(diagnostic).not.toContain('missing "Status"');
    expect(
      readAuditShardEvents(proj).filter((entry) => entry.event === "REVIEW_COMPLETED"),
    ).toHaveLength(0);
  });

  test("a findings header the record schema cannot read is refused, not read as no findings", () => {
    // A reviewer that documents its rows under its own column names still
    // names every finding, so dropping the two columns the record addresses
    // must not turn a rejection into an empty findings list.
    const review = reviewMarkdown("NOT-READY", [
      "| R-01 | Critical | aidlc/requirements.md > FR-1 | Cookie transport contradicts the bearer contract | contract-summary.md L10 | Reconcile the contract |",
    ]).replace(
      "| ID | Severity | Location | Finding | Required action | Status |",
      "| ID | Severity | Location | Finding | Evidence | Recommendation |",
    );
    expect(() => parseReviewArtifact(review, "aidlc/requirements.md")).toThrow(
      "aidlc/requirements.md: findings table header declares " +
        "ID | Severity | Location | Finding | Evidence | Recommendation. " +
        "Expected columns: ID | Severity | Location | Finding | Required action | Status. " +
        "Missing: Required action, Status",
    );
  });

  test("a NOT-READY review whose findings section is prose is still recorded", () => {
    // The narrowing that keeps this seam out of the reviewer-protocol's
    // incomplete-review territory: a body with no findings TABLE is not refused
    // here, so bodies that predate the table contract still record.
    const { proj, artifact } = requirementProject([]);
    writeFileSync(artifact, "# Requirements\n\nFR-1: ship it.\n", "utf-8");
    const base = [
      "review",
      "--stage",
      "requirements-analysis",
      "--reviewer",
      "aidlc-product-lead-agent",
      "--iteration",
      "1",
    ];
    const requested = run(LOG, base, proj);
    expect(requested.status, requested.out).toBe(0);
    const draft = join(proj, JSON.parse(requested.stdout).reviewFile);
    mkdirSync(dirname(draft), { recursive: true });
    writeFileSync(
      draft,
      [
        "**Verdict:** NOT-READY",
        "**Reviewer:** aidlc-product-lead-agent",
        "**Date:** 2026-08-25T12:00:00Z",
        "**Iteration:** 1",
        "",
        "### Findings",
        "",
        "Fixture review.",
        "",
      ].join("\n"),
      "utf-8",
    );
    const completed = run(LOG, [...base, "--verdict", "NOT-READY"], proj);
    expect(completed.status, completed.out).toBe(0);
    expect(
      readAuditShardEvents(proj).filter((entry) => entry.event === "REVIEW_COMPLETED"),
    ).toHaveLength(1);
  });

  test.each([
    [
      "a noncanonical findings header",
      reviewMarkdown("NOT-READY", [
        "| R-01 | Critical | aidlc/requirements.md > FR-1 | Cookie transport contradicts the bearer contract | contract-summary.md L10 | Reconcile the contract |",
      ]).replace(
        "| ID | Severity | Location | Finding | Required action | Status |",
        "| ID | Severity | Location | Finding | Evidence | Recommendation |",
      ),
      "Missing: Required action, Status",
    ],
    [
      "a canonical header carrying no rows",
      reviewMarkdown("NOT-READY", []),
      "must record at least one finding",
    ],
  ] satisfies [string, string, string][])(
    "review completion refuses a NOT-READY review with %s without recording a terminal receipt",
    (_case, body, expected) => {
      const { proj, artifact } = requirementProject([]);
      writeFileSync(artifact, "# Requirements\n\nFR-1: ship it.\n", "utf-8");
      const base = [
        "review",
        "--stage",
        "requirements-analysis",
        "--reviewer",
        "aidlc-product-lead-agent",
        "--iteration",
        "1",
      ];
      const requested = run(LOG, base, proj);
      expect(requested.status, requested.out).toBe(0);
      const draft = join(proj, JSON.parse(requested.stdout).reviewFile);
      mkdirSync(dirname(draft), { recursive: true });
      writeFileSync(draft, body.replace(/^# Requirements\n\n/, ""), "utf-8");
      const completed = run(LOG, [...base, "--verdict", "NOT-READY"], proj);
      expect(completed.status).not.toBe(0);
      const diagnostic = JSON.parse(completed.stderr).error;
      expect(diagnostic).toContain('Refusing REVIEW_COMPLETED for "requirements-analysis"');
      expect(diagnostic).toContain(expected);
      // The draft survives the refusal, so the one retry the reviewer protocol
      // allows for an incomplete attempt has something to rewrite.
      expect(existsSync(draft)).toBe(true);
      expect(
        readAuditShardEvents(proj).filter((entry) => entry.event === "REVIEW_COMPLETED"),
      ).toHaveLength(0);
    },
  );

  const CANONICAL_HEADER = "| ID | Severity | Location | Finding | Required action | Status |";
  const UNREADABLE_HEADER = "| ID | Severity | Location | Finding | Evidence | Recommendation |";
  const UNREADABLE_ROW =
    "| R-01 | Critical | aidlc/requirements.md > FR-1 | Cookie transport contradicts the bearer contract | contract-summary.md L10 | Reconcile the contract |";

  test("a legacy embedded review whose findings table cannot be read reaches the gate with its rows as written", () => {
    // Migration keeps a legacy embedded review readable at the brief and the
    // redispatch context. One the record schema cannot read renders one R-00
    // finding naming why, beside the reviewer's section as written, so the
    // approval and --reject-finding still have a finding to address.
    const { proj, artifact, relativeArtifact } = requirementProject([UNREADABLE_ROW], "NOT-READY");
    writeFileSync(
      artifact,
      readFileSync(artifact, "utf-8").replace(CANONICAL_HEADER, UNREADABLE_HEADER),
      "utf-8",
    );
    const stage = findStageBySlug("requirements-analysis")!;
    const contexts = readReviewArtifactContexts(proj, stage);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].verdict).toBe("NOT-READY");
    expect(contexts[0].findings.map((finding) => [finding.id, finding.status])).toEqual([
      ["R-00", "Unresolved"],
    ]);
    expect(contexts[0].findings[0].finding).toContain("Missing: Required action, Status");

    const brief = run(REVIEW_BRIEF, ["review", "--stage", "requirements-analysis", "--why", "first"], proj);
    expect(brief.status, brief.out).toBe(0);
    expect(brief.stdout).toContain("**Review outcome:** Concerns remain for your decision.");
    expect(brief.stdout).toContain("| R-00 | Major |");
    expect(brief.stdout).toContain("**The reviewer's findings, as written:**");
    expect(brief.stdout).toContain(`> ${UNREADABLE_ROW}`);
    const context = run(REVIEW_BRIEF, ["context", "--stage", "requirements-analysis"], proj);
    expect(context.status, context.out).toBe(0);
    expect(context.stdout).toContain(`> ${UNREADABLE_ROW}`);

    expect(JSON.parse(acceptedRiskDispositionField(proj, stage)!).dispositions).toEqual([
      expect.objectContaining({ artifact: relativeArtifact, id: "R-00", status: "Accepted risk" }),
    ]);
    expect(
      JSON.parse(
        rejectedFindingDispositionField(proj, stage, [
          `${relativeArtifact}#R-00=Read the rows by hand`,
        ])!,
      ).dispositions,
    ).toEqual([
      expect.objectContaining({ id: "R-00", status: "Rejected: Read the rows by hand" }),
    ]);
  });

  test.each([
    [
      "a noncanonical findings header",
      [UNREADABLE_ROW],
      UNREADABLE_HEADER,
      "Missing: Required action, Status",
    ],
    [
      "a canonical header carrying no rows",
      [],
      CANONICAL_HEADER,
      "must record at least one finding",
    ],
  ] satisfies [string, string[], string, string][])(
    "a retried NOT-READY review with %s records its text and one finding naming the unreadable table",
    (_case, rows, header, reason) => {
      // The first attempt is refused so the one retry can write a readable
      // table. A retried attempt that repeats the table records instead:
      // refusing it too would leave no verdict to record while the draft exists.
      const { proj, artifact } = requirementProject([]);
      writeFileSync(artifact, "# Requirements\n\nFR-1: ship it.\n", "utf-8");
      const body = reviewMarkdown("NOT-READY", rows)
        .replace(CANONICAL_HEADER, header)
        .replace(/^# Requirements\n\n/, "");
      const base = [
        "review",
        "--stage",
        "requirements-analysis",
        "--reviewer",
        "aidlc-product-lead-agent",
        "--iteration",
        "1",
      ];
      const requested = run(LOG, base, proj);
      expect(requested.status, requested.out).toBe(0);
      const draft = join(proj, JSON.parse(requested.stdout).reviewFile);
      mkdirSync(dirname(draft), { recursive: true });
      writeFileSync(draft, body, "utf-8");
      const refused = run(LOG, [...base, "--verdict", "NOT-READY"], proj);
      expect(refused.status).not.toBe(0);
      expect(JSON.parse(refused.stderr).error).toContain(reason);

      const retried = run(LOG, [...base, "--retry-pending"], proj);
      expect(retried.status, retried.out).toBe(0);
      expect(existsSync(draft)).toBe(false);
      writeFileSync(draft, body, "utf-8");
      const completed = run(LOG, [...base, "--verdict", "NOT-READY"], proj);
      expect(completed.status, completed.out).toBe(0);
      expect(
        readAuditShardEvents(proj).filter((entry) => entry.event === "REVIEW_COMPLETED"),
      ).toHaveLength(1);
      expect(existsSync(draft)).toBe(false);
      const { reviewRecord } = JSON.parse(completed.stdout) as { reviewRecord: string };
      const record = JSON.parse(readFileSync(join(seededRecordDir(proj), reviewRecord), "utf-8"));
      expect(record.verdict).toBe("NOT-READY");
      expect(record.body).toBe(body);
      expect(record.findings).toHaveLength(1);
      expect(record.findings[0]).toMatchObject({ id: "R-00", severity: "Major", status: "Unresolved" });
      expect(record.findings[0].finding).toContain(reason);
      // One cell even if a reviewer carries it forward without escaping pipes.
      expect(record.findings[0].finding).not.toContain("|");

      const rendered = renderReviewBrief(proj, findStageBySlug("requirements-analysis")!, "first");
      expect(rendered).toContain("**Review outcome:** Concerns remain for your decision.");
      expect(rendered).toContain("| R-00 | Major |");
      expect(rendered).toContain("**The reviewer's findings, as written:**");
      expect(rendered).toContain(`> ${header}`);
      for (const row of rows) expect(rendered).toContain(`> ${row}`);
    },
  );

  test("a readable table that carries R-00 forward renders without the as-written section", () => {
    // A later review resolves the unreadable-table finding by carrying R-00
    // forward in a readable table. The section as written is shown only while
    // the body's table cannot be read, so this table is not repeated under it.
    const { proj, artifact } = requirementProject([]);
    writeFileSync(artifact, "# Requirements\n\nFR-1: ship it.\n", "utf-8");
    const carried =
      "| R-00 | Major | inception/requirements-analysis/requirements.md > review findings table | " +
      "The reviewer's findings table could not be read | Address the reviewer's findings | Resolved |";
    recordReviewViaRecordAndOpenGate(
      proj,
      reviewMarkdown("READY", [carried]).replace(/^# Requirements\n\n/, ""),
    );
    const rendered = renderReviewBrief(proj, findStageBySlug("requirements-analysis")!, "first");
    expect(rendered).toContain("| R-00 | Major |");
    expect(rendered).toContain("**Review outcome:** No open findings remain.");
    expect(rendered).not.toContain("**The reviewer's findings, as written:**");
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
    // #1082: the `stale` lead line must not assert a cause that may not apply. A
    // conductor edit can self-invalidate the receipt with nothing upstream changed,
    // and the accurate cause is appended below as **Changed upstream:** anyway.
    expect(brief).toContain("**Why now:**");
    expect(brief).not.toContain("Re-check required after upstream work changed");
    expect(brief).toContain("the previous review receipt is no longer valid");
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

  test("an unknown reject selector names only rejectable current findings (#1082)", () => {
    // The accepted selectors are in hand at the throw. Without them a stem-vs-full-path
    // mismatch in the artifact is invisible: the reader is told their selector is wrong
    // and has to guess which identifier the gate actually holds.
    const { proj, relativeArtifact } = requirementProject([
      ROW_RESOLVED,
      ROW_NEW_SECOND,
    ]);
    const stage = findStageBySlug("requirements-analysis")!;
    let message = "";
    try {
      rejectedFindingDispositionField(proj, stage, ["wrong/path.md#R-01=Not applicable"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("not a current review finding");
    expect(message).toContain("Current rejectable findings:");
    expect(message).toContain(`${relativeArtifact}#R-02`);
    expect(message).not.toContain(`${relativeArtifact}#R-01`);
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

  test("a review recorded as a record renders at the gate and in redispatch context, and its findings take dispositions", () => {
    const { proj, artifact, relativeArtifact } = requirementProject([ROW_NEW]);
    // The artifact carries no review section: the review lives in its record.
    const body = "# Requirements\n\nFR-1: ship it.\n";
    writeFileSync(artifact, body, "utf-8");
    const reviewBody = reviewMarkdown("READY", [ROW_NEW, ROW_NEW_SECOND]).replace(
      /^# Requirements\n\n/,
      "",
    );
    const { reviewRecord } = recordReviewViaRecordAndOpenGate(proj, reviewBody);
    expect(readFileSync(artifact, "utf-8")).toBe(body);
    const recordPath = join(seededRecordDir(proj), reviewRecord);
    expect(existsSync(recordPath)).toBe(true);

    const stage = findStageBySlug("requirements-analysis")!;
    const contexts = readReviewArtifactContexts(proj, stage);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].artifact).toBe(relativeArtifact);
    expect(contexts[0].verdict).toBe("READY");
    expect(contexts[0].findings.map((finding) => finding.id)).toEqual(["R-01", "R-02"]);

    const brief = run(REVIEW_BRIEF, ["review", "--stage", "requirements-analysis", "--why", "first"], proj);
    expect(brief.status, brief.out).toBe(0);
    expect(brief.stdout).toContain(`**Review artifact:** \`${relativeArtifact}\``);
    expect(brief.stdout).toContain("| R-01 |");
    expect(brief.stdout).toContain("| R-02 |");
    expect(brief.stdout).toContain("Concerns remain for your decision.");
    expect(brief.stdout).not.toContain("READY");
    const context = run(REVIEW_BRIEF, ["context", "--stage", "requirements-analysis"], proj);
    expect(context.status, context.out).toBe(0);
    expect(context.stdout).toContain("| R-01 |");

    // Dispositions address the record's findings through the reviewed
    // artifact's path, as they always did.
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
    const hydrated = hydrateReviewArtifactContexts(
      readReviewArtifactContexts(proj, stage),
      readReviewFindingDispositions(proj, stage.slug),
    );
    expect(hydrated[0].findings.map((finding) => finding.status)).toEqual([
      "Rejected: Internal milestones intentionally have no public date",
      "New",
    ]);

    // A completion row that descends from no request is not a review, whatever
    // it names: the real record it points at, a made-up record, a legacy shape
    // with no record at all. Only the paired completion decides what is read.
    const completion = readAllAuditShards(proj)
      .replace(/\r\n/g, "\n")
      .split(/\n---\n/)
      .find((block) => auditBlockField(block, "Event") === "REVIEW_COMPLETED");
    const recordDigest = auditBlockField(completion ?? "", "Review Record Digest") as string;
    const base = {
      Stage: "requirements-analysis",
      Reviewer: "aidlc-product-lead-agent",
      Iteration: "1",
      Verdict: "NOT-READY",
      "Request Fingerprint": auditBlockField(completion ?? "", "Request Fingerprint") as string,
      "Artifact Fingerprint": auditBlockField(completion ?? "", "Artifact Fingerprint") as string,
    };
    for (const forged of [
      { ...base, "Request Id": `review:${"f".repeat(32)}`, "Review Record": reviewRecord, "Review Record Digest": recordDigest },
      { ...base, "Request Id": `review:${"f".repeat(32)}`, "Review Record": ".aidlc-engine/reviews/requirements-analysis/stage/0123456789abcdef/1.json", "Review Record Digest": `sha256:${"0".repeat(64)}` },
      { ...base, "Request Id": `review:${"f".repeat(32)}` },
      { ...base },
    ]) {
      appendAuditEntry("REVIEW_COMPLETED", forged, proj);
      const after = readReviewArtifactContexts(proj, stage);
      expect(after).toHaveLength(1);
      expect(after[0].verdict).toBe("READY");
      expect(after[0].findings.map((finding) => finding.id)).toEqual(["R-01", "R-02"]);
    }

    // A record edited after the fact is not the review: the gate falls back to
    // what the artifact says, which here is nothing.
    writeFileSync(recordPath, readFileSync(recordPath, "utf-8").replace("R-02", "R-09"), "utf-8");
    expect(readReviewArtifactContexts(proj, stage)).toHaveLength(0);
  });

  test("an empty incomplete-review record leaves room for the explicit gate fallback finding", () => {
    const { proj, artifact } = requirementProject([]);
    writeFileSync(artifact, "# Requirements\n\nReviewed requirements.\n", "utf-8");
    const request = [
      "review",
      "--stage",
      "requirements-analysis",
      "--reviewer",
      "aidlc-product-lead-agent",
      "--iteration",
      "1",
    ];
    const requested = run(LOG, request, proj);
    expect(requested.status, requested.out).toBe(0);
    const retried = run(LOG, [...request, "--retry-pending"], proj);
    expect(retried.status, retried.out).toBe(0);
    const completed = run(LOG, [...request, "--verdict", "NOT-READY"], proj);
    expect(completed.status, completed.out).toBe(0);
    const { reviewRecord } = JSON.parse(completed.stdout) as { reviewRecord: string };
    const recordPath = join(seededRecordDir(proj), reviewRecord);
    expect(existsSync(recordPath)).toBe(true);
    expect(JSON.parse(readFileSync(recordPath, "utf-8"))).toMatchObject({
      verdict: "NOT-READY",
      body: "",
      findings: [],
    });

    const stage = findStageBySlug("requirements-analysis")!;
    expect(readReviewArtifactContexts(proj, stage)).toHaveLength(0);
    const fallbackFinding = "review did not complete within its turn budget";
    const brief = run(
      REVIEW_BRIEF,
      [
        "review",
        "--stage",
        "requirements-analysis",
        "--why",
        "first",
        "--fallback-finding",
        fallbackFinding,
      ],
      proj,
    );
    expect(brief.status, brief.out).toBe(0);
    expect(brief.stdout).toContain(fallbackFinding);
    expect(brief.stdout).not.toContain(
      "| - | - | - | No findings | No action required | Resolved |",
    );
  });

  const unreadableSlots: [string, (draft: string) => string, string][] = [
    ["an oversized draft", (draft) => {
      writeFileSync(draft, Buffer.alloc(4 * 1024 * 1024 + 1, "a"));
      return "above the 4194304-byte limit";
    }, ""],
    ["a directory", (draft) => {
      mkdirSync(draft);
      writeFileSync(join(draft, "notes.md"), "not a review\n", "utf-8");
      return "review file";
    }, ""],
  ];
  if (process.platform !== "win32") {
    unreadableSlots.push(["a symlink", (draft) => {
      const outside = join(dirname(draft), "..", "outside-review.md");
      writeFileSync(outside, standaloneReview("NOT-READY", [ROW_NEW]), "utf-8");
      symlinkSync(outside, draft);
      return "is a symlink, which is not followed";
    }, "outside-review.md"]);
  }
  test.each(unreadableSlots)("after the retry, %s left in the slot is cleared without following it", (_, leave, survivor) => {
    const { proj, draft } = retriedReviewRequest();
    const reason = leave(draft);
    const completed = run(LOG, [...REVIEW_REQUEST, "--verdict", "NOT-READY"], proj);
    expect(completed.status, completed.out).toBe(0);
    const output = JSON.parse(completed.stdout) as Record<string, string>;
    expect(output.discardedDraft).toContain(reason);
    expect(output.discardedDraft).not.toContain(proj);
    expect(() => lstatSync(draft)).toThrow();
    if (survivor !== "") {
      expect(readFileSync(join(dirname(draft), "..", survivor), "utf-8")).toContain("Deadline is missing");
    }
    expect(JSON.parse(readFileSync(join(seededRecordDir(proj), output.reviewRecord), "utf-8")))
      .toMatchObject({ verdict: "NOT-READY", body: "", findings: [] });
    expect(run(STATE, ["gate-start", "requirements-analysis"], proj).status).toBe(0);
  });

  test("before the retry, an unreadable slot is refused and left in place", () => {
    const { proj, artifact } = requirementProject([]);
    writeFileSync(artifact, "# Requirements\n\nReviewed requirements.\n", "utf-8");
    const requested = run(LOG, REVIEW_REQUEST, proj);
    expect(requested.status, requested.out).toBe(0);
    const draft = join(proj, (JSON.parse(requested.stdout) as { reviewFile: string }).reviewFile);
    mkdirSync(draft, { recursive: true });
    const completed = run(LOG, [...REVIEW_REQUEST, "--verdict", "NOT-READY"], proj);
    expect(completed.status).not.toBe(0);
    expect(completed.out).toContain("is not a plain readable file");
    expect(lstatSync(draft).isDirectory()).toBe(true);
    expect(readAuditShardEvents(proj).filter((entry) => entry.event === "REVIEW_COMPLETED")).toHaveLength(0);
  });

  test("the retried fallback refuses a redirected slot directory instead of clearing through it", () => {
    const { proj, draft } = retriedReviewRequest();
    const outside = join(proj, "outside-slot");
    mkdirSync(outside);
    writeFileSync(join(outside, basename(draft)), standaloneReview("NOT-READY", [ROW_NEW]), "utf-8");
    rmSync(dirname(draft), { recursive: true, force: true });
    symlinkSync(outside, dirname(draft), process.platform === "win32" ? "junction" : "dir");
    const completed = run(LOG, [...REVIEW_REQUEST, "--verdict", "NOT-READY"], proj);
    expect(completed.status).not.toBe(0);
    expect(completed.out).toContain("is a symlink");
    expect(existsSync(join(outside, basename(draft)))).toBe(true);
    expect(readAuditShardEvents(proj).filter((entry) => entry.event === "REVIEW_COMPLETED")).toHaveLength(0);
  });

  test("a completed review whose table omits leading pipes reaches the gate with its findings", () => {
    const { proj, artifact } = requirementProject([]);
    writeFileSync(artifact, "# Requirements\n\nReviewed requirements.\n", "utf-8");
    const requested = run(LOG, REVIEW_REQUEST, proj);
    expect(requested.status, requested.out).toBe(0);
    const draft = join(proj, (JSON.parse(requested.stdout) as { reviewFile: string }).reviewFile);
    mkdirSync(dirname(draft), { recursive: true });
    writeFileSync(
      draft,
      standaloneReview("NOT-READY", [ROW_NEW])
        .split("\n")
        .map((line) => line.startsWith("|") ? line.replace(/^\| ?/, "").replace(/ ?\|$/, "") : line)
        .join("\n"),
      "utf-8",
    );
    const completed = run(LOG, [...REVIEW_REQUEST, "--verdict", "NOT-READY"], proj);
    expect(completed.status, completed.out).toBe(0);
    const { reviewRecord } = JSON.parse(completed.stdout) as { reviewRecord: string };
    expect(JSON.parse(readFileSync(join(seededRecordDir(proj), reviewRecord), "utf-8")))
      .toMatchObject({ verdict: "NOT-READY", findings: [{ id: "R-01", status: "New" }] });
    expect(run(STATE, ["gate-start", "requirements-analysis"], proj).status).toBe(0);
    const brief = run(REVIEW_BRIEF, ["review", "--stage", "requirements-analysis", "--why", "first"], proj);
    expect(brief.status, brief.out).toBe(0);
    expect(brief.stdout).toContain("Deadline is missing");
  });

  test("a record replaces a legacy embedded review for the same scope at the gate", () => {
    const { proj, artifact, relativeArtifact } = requirementProject([ROW_UNRESOLVED]);
    // The artifact still carries an old embedded section; the fresh review is
    // a record. The record wins for the scope, the section stays as content.
    const legacyBytes = readFileSync(artifact, "utf-8");
    const reviewBody = reviewMarkdown("READY", [ROW_RESOLVED]).replace(/^# Requirements\n\n/, "");
    recordReviewViaRecordAndOpenGate(proj, reviewBody);
    expect(readFileSync(artifact, "utf-8")).toBe(legacyBytes);
    const stage = findStageBySlug("requirements-analysis")!;
    const contexts = readReviewArtifactContexts(proj, stage);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].artifact).toBe(relativeArtifact);
    expect(contexts[0].findings.map((finding) => finding.status)).toEqual(["Resolved"]);
  });
});
