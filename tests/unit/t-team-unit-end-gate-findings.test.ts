// covers: tool:aidlc-review-brief, subcommand:aidlc-orchestrate:report, audit:GATE_APPROVED,
// function:renderReviewBrief, function:approvalDispositionField, function:teamUnitGateStages
//
// A team Unit claimed with the unit-end rhythm is approved once, at its last
// stage, and that one Approve decides every stage of the Unit's walk. The gate's
// brief shows every gated stage's open findings, with the one line that says
// Approve accepts them as risk and how to decide one differently, and the
// approval records dispositions for exactly the findings the brief showed: the
// person is never recorded accepting a finding the gate did not show. A gate
// with no open findings reads as before, and a per-stage team gate is unchanged.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { REVIEW_FINDING_DISPOSITIONS_FIELD } from "../../dist/claude/.claude/tools/aidlc-review-brief.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

// The stage's checks run before its review and at its gate; this file's
// documents are not written for them and its subject is the gate's brief and
// the approval, so they stay off here, as in t324.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const BRIEF = join(AIDLC_SRC, "tools", "aidlc-review-brief.ts");

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};
delete ENV.AWS_AIDLC_DEFAULT_SCOPE;

const BLOCK = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  unit_gate?: string;
  reviewer?: string;
  message?: string;
  [key: string]: unknown;
}

interface Finding {
  id: string;
  severity: "Critical" | "Major" | "Minor";
  finding: string;
  action: string;
}

function constructionState(rhythm: "per-stage" | "unit-end", guardPolicy?: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: team unit-end gate findings
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Plan Approval**: off (set by you)
- **Unit Ownership**: team
- **Unit Gate Rhythm**: ${rhythm}
${guardPolicy === undefined ? "" : `- **Guard Policy**: ${guardPolicy}\n`}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`;
}

// The requirements as Requirements Analysis writes them: FR{n} and NFR{n} ids
// in requirements.md and the same ids listed in its traceability.json.
function seedRequirements(proj: string): void {
  const dir = join(seededRecordDir(proj), "inception", "requirements-analysis");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "requirements.md"),
    [
      "# Requirements",
      "",
      "## Functional requirements",
      "",
      "- FR1: The service greets a named caller.",
      "",
      "## Non-functional requirements",
      "",
      "- NFR1: A greeting returns within 100 ms.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "traceability.json"),
    `${JSON.stringify({
      stage: "requirements-analysis",
      ids: [{ id: "FR1", kind: "functional" }, { id: "NFR1", kind: "non-functional" }],
    }, null, 2)}\n`,
  );
}

function seedProject(rhythm: "per-stage" | "unit-end", guardPolicy?: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), constructionState(rhythm, guardPolicy));
  seedBoltDag(proj, ["alpha"]);
  seedRequirements(proj);
  return proj;
}

function runNext(proj: string): Directive {
  const result = runOrchestrateNext(ORCH, proj, [], { env: ENV });
  if (!result.directive) {
    throw new Error(`next failed: ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.directive as Directive;
}

function run(tool: string, proj: string, args: string[]): { rc: number; stdout: string; out: string } {
  const result = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: ENV,
  });
  return {
    rc: result.status ?? -1,
    stdout: result.stdout ?? "",
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function runReport(proj: string, args: string[]): Directive {
  const result = run(ORCH, proj, ["report", ...args]);
  try {
    return JSON.parse(result.stdout.trim()) as Directive;
  } catch {
    throw new Error(`report failed: ${result.rc}\n${result.out}`);
  }
}

function stageDir(proj: string, stage: string): string {
  return join(seededRecordDir(proj), "construction", "alpha", stage);
}

function coverUnit(proj: string, stage: string): void {
  const dir = stageDir(proj, stage);
  mkdirSync(dir, { recursive: true });
  for (const artifact of findStageBySlug(stage)!.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(artifact)), `# ${artifact} for alpha\n\nCovers FR1 and NFR1.\n`);
  }
  if (stage === "code-generation") {
    writeFileSync(
      join(dir, artifactFilename("code-generation-plan")),
      `# Plan for alpha\n\n${renderTestingContract(resolveTestingPosture(proj))}\n## Steps\n\n- [ ] Step 1 (FR1)\n`,
    );
    writeFileSync(
      join(dir, "source-manifest.json"),
      `${JSON.stringify({ stage, unit: "alpha", version: 1, writes: [] }, null, 2)}\n`,
    );
  }
}

// The stage's review, as the reviewer writes it to the slot the request names:
// READY with no findings, NOT-READY when a finding is above Minor.
function logReview(proj: string, stage: string, reviewer: string, findings: Finding[], iteration = 1): string {
  const said = findings.some((finding) => finding.severity !== "Minor") ? "NOT-READY" : "READY";
  const base = [
    "review", "--stage", stage, "--reviewer", reviewer, "--unit", "alpha", "--iteration", String(iteration),
  ];
  const request = run(LOG, proj, base);
  if (request.rc !== 0) throw new Error(`review request failed: ${request.out}`);
  const { reviewFile } = JSON.parse(request.stdout) as { reviewFile: string };
  const location = `${relative(proj, stageDir(proj, stage)).replaceAll("\\", "/")}/${
    artifactFilename(findStageBySlug(stage)!.produces![0])
  } > section`;
  const rows = findings.map((finding) =>
    `| ${finding.id} | ${finding.severity} | ${location} | ${finding.finding} | ${finding.action} | New |`
  );
  const draft = join(proj, reviewFile);
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(
    draft,
    [
      `**Verdict:** ${said}`,
      `**Reviewer:** ${reviewer}`,
      `**Iteration:** ${iteration}`,
      "",
      "### Findings",
      "",
      ...(rows.length > 0
        ? ["| ID | Severity | Location | Finding | Required action | Status |", "|---|---|---|---|---|---|", ...rows]
        : ["No blocking findings."]),
      "",
      "### Summary",
      "",
      `The ${stage} review.`,
      "",
    ].join("\n"),
  );
  const completed = run(LOG, proj, [...base, "--verdict", said]);
  if (completed.rc !== 0) throw new Error(`review completion failed: ${completed.out}`);
  return relative(proj, stageDir(proj, stage)).replaceAll("\\", "/");
}

// Walks alpha's stages to its gate, each reviewed with the findings given for
// it, and returns the gate's directive. A NOT-READY review is reviewed again
// and stays NOT-READY: the review's last pass, whose concerns go to the gate.
function walkToGate(
  proj: string,
  reviews: Record<string, Finding[]>,
  stages = BLOCK,
  beforeGate?: () => void,
): Directive {
  for (const stage of stages) {
    const directive = runNext(proj);
    expect(directive, JSON.stringify(directive)).toMatchObject({ stage, unit: "alpha" });
    expect(run(STATE, proj, ["unit", "start", "--stage", stage, "--unit", "alpha"]).rc).toBe(0);
    coverUnit(proj, stage);
    if (stage === "code-generation") {
      expect(runNext(proj)).toMatchObject({ kind: "run-stage", stage, unit: "alpha" });
    }
    const completed = run(STATE, proj, ["unit", "complete", "--stage", stage, "--unit", "alpha"]);
    expect(completed.rc, completed.out).toBe(0);
    if (directive.reviewer) {
      const findings = reviews[stage] ?? [];
      logReview(proj, stage, directive.reviewer, findings);
      if (findings.some((finding) => finding.severity !== "Minor")) logReview(proj, stage, directive.reviewer, findings, 2);
    }
  }
  beforeGate?.();
  const gate = runNext(proj);
  expect(gate, JSON.stringify(gate)).toMatchObject({ unit: "alpha", gate: true });
  return gate;
}

function brief(proj: string, stage: string): string {
  const printed = run(BRIEF, proj, ["review", "--stage", stage, "--unit", "alpha", "--why", "first"]);
  expect(printed.rc, printed.out).toBe(0);
  return printed.stdout;
}

const NFR_DESIGN_FINDINGS: Finding[] = [
  {
    id: "R-01",
    severity: "Critical",
    finding: "operability-design.md and testability-design.md do not exist",
    action: "Write the two design documents",
  },
  {
    id: "R-02",
    severity: "Major",
    finding: "The traceability file uses ids the requirements do not define",
    action: "Trace the requirement ids as requirements.md spells them",
  },
];

// What the Unit's one GATE_APPROVED row records, as "<artifact>#<id> <status>".
function recorded(proj: string): string[] {
  const rows = readAuditShardEvents(proj).filter((row) =>
    row.event === "GATE_APPROVED" && auditBlockField(row.block, "Unit") === "alpha"
  );
  expect(rows).toHaveLength(1);
  const field = auditBlockField(rows[0].block, REVIEW_FINDING_DISPOSITIONS_FIELD);
  if (field === null) return [];
  const { dispositions } = JSON.parse(field) as { dispositions: Array<{ artifact: string; id: string; status: string }> };
  return dispositions.map(({ artifact, id, status }) => `${artifact}#${id} ${status}`).sort();
}

// The open findings the brief shows, as "<review folder>#<id>": each review
// artifact line, then the rows of its table that are still open.
function shownOpen(text: string): string[] {
  const shown: string[] = [];
  let folder = "";
  for (const line of text.split("\n")) {
    const artifact = /^\*\*Review artifact:\*\* `(.+)\/[^/]+`$/.exec(line);
    if (artifact) folder = artifact[1];
    const row = /^\| (R-\d+) \| [^|]+ \| [^|]+ \| (New|Unresolved) \|$/.exec(line);
    if (row) shown.push(`${folder}#${row[1]}`);
  }
  return shown.sort();
}

function folderOf(entry: string): string {
  const [path, rest] = entry.split("#");
  return `${path.slice(0, path.lastIndexOf("/"))}#${rest.split(" ")[0]}`;
}

// The review artifact a stage's findings are recorded against, as a fix or a
// rejection names it.
function recordedArtifact(proj: string, stage: string): string {
  const dir = relative(proj, stageDir(proj, stage)).replaceAll("\\", "/");
  return `${dir}/${artifactFilename(findStageBySlug(stage)!.review_artifact!)}`;
}

function gateReport(proj: string, result: string, extra: string[] = []): Directive {
  return runReport(proj, ["--stage", "code-generation", "--unit", "alpha", "--result", result, ...extra]);
}

describe("t-team-unit-end-gate-findings: the end-of-Unit gate shows what its Approve decides", () => {
  test("a NOT-READY NFR Design review is shown at the end-of-Unit gate, and Approve records only what it showed", () => {
    const proj = seedProject("unit-end");
    const gate = walkToGate(proj, { "nfr-design": NFR_DESIGN_FINDINGS });
    expect(gate).toMatchObject({ stage: "code-generation", unit_gate: "unit-end" });
    expect(gateReport(proj, "awaiting-approval").kind).toBe("print");
    const shown = brief(proj, "code-generation");
    expect(shown).toContain("**Stages:** NFR Design, Code Generation");
    expect(shown).toContain("**Review outcome:** Concerns remain for your decision.");
    expect(shown).toContain("construction/alpha/nfr-design/");
    expect(shown).toContain("> R-01 Finding: operability-design.md and testability-design.md do not exist");
    expect(shown).toContain("> R-02 Finding: The traceability file uses ids the requirements do not define");
    expect(shown).toContain(
      "Approve accepts the open review findings R-01 (operability-design.md and testability-design.md do not exist) " +
        "and R-02 (The traceability file uses ids the requirements do not define) as risk; you can also approve and " +
        "ask for one to be fixed, or reject one as not applying, saying why.",
    );
    expect(shown).toContain("- **Approve** - continue.");
    expect(shown).not.toContain("No blocking concerns were found.");
    expect(shown).not.toContain("no findings are open");

    expect(gateReport(proj, "approved", ["--user-input", "Approve"]).kind).toBe("done");
    // Exactly the findings the brief showed, each accepted as risk.
    const record = recorded(proj);
    expect(record.map(folderOf)).toEqual(shownOpen(shown));
    expect(record).toHaveLength(2);
    for (const entry of record) {
      expect(entry).toContain("/construction/alpha/nfr-design/");
      expect(entry).toEndWith(" Accepted risk");
    }
  });

  test("findings open on two stages are named with their stage, and a fix asked for one leaves the other accepted", () => {
    const proj = seedProject("unit-end");
    walkToGate(proj, {
      "nfr-requirements": [{ id: "R-01", severity: "Minor", finding: "Name the latency budget's owner", action: "Add an owner" }],
      "nfr-design": [NFR_DESIGN_FINDINGS[0]],
    });
    expect(gateReport(proj, "awaiting-approval").kind).toBe("print");
    const shown = brief(proj, "code-generation");
    expect(shown).toContain("**Stages:** NFR Requirements, NFR Design, Code Generation");
    expect(shown).toContain(
      "Approve accepts the open review findings NFR Requirements R-01 (Name the latency budget's owner) and " +
        "NFR Design R-01 (operability-design.md and testability-design.md do not exist) as risk; you can also " +
        "approve and ask for one to be fixed, or reject one as not applying, saying why.",
    );
    expect(shownOpen(shown)).toHaveLength(2);
    const nfrDesign = recordedArtifact(proj, "nfr-design");
    expect(gateReport(proj, "approved", ["--user-input", "Approve", "--fix-finding", `${nfrDesign}#R-01`]).kind)
      .toBe("done");
    const record = recorded(proj);
    expect(record.map(folderOf)).toEqual(shownOpen(shown));
    expect(record).toEqual([
      expect.stringMatching(/\/nfr-design\/[^#]+#R-01 Fix requested$/),
      expect.stringMatching(/\/nfr-requirements\/[^#]+#R-01 Accepted risk$/),
    ]);
  });

  test("a Request Changes that rejects an earlier stage's finding records it rejected", () => {
    const proj = seedProject("unit-end");
    walkToGate(proj, { "nfr-design": [NFR_DESIGN_FINDINGS[0]] });
    expect(gateReport(proj, "awaiting-approval").kind).toBe("print");
    expect(shownOpen(brief(proj, "code-generation"))).toHaveLength(1);
    const nfrDesign = recordedArtifact(proj, "nfr-design");
    expect(gateReport(proj, "rejected", [
      "--user-input", "Request Changes", "--reason", "Rename the handler",
      "--reject-finding", `${nfrDesign}#R-01=Those documents are not this Unit's`,
    ]).kind).toBe("print");
    const rejected = readAuditShardEvents(proj).filter((row) =>
      row.event === "GATE_REJECTED" && auditBlockField(row.block, "Unit") === "alpha"
    );
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(auditBlockField(rejected[0].block, REVIEW_FINDING_DISPOSITIONS_FIELD)!).dispositions).toEqual([
      expect.objectContaining({ artifact: nfrDesign, id: "R-01", status: "Rejected: Those documents are not this Unit's" }),
    ]);
  });

  test("an earlier stage's finding on work changed after its review shows and records as changed, not accepted", () => {
    const proj = seedProject("unit-end", "relaxed (set by you)");
    walkToGate(proj, { "nfr-design": [NFR_DESIGN_FINDINGS[0]] }, BLOCK, () => {
      const document = join(stageDir(proj, "nfr-design"), artifactFilename(findStageBySlug("nfr-design")!.produces![1]));
      writeFileSync(document, `${readFileSync(document, "utf-8")}\nThe handler is renamed.\n`);
    });
    expect(gateReport(proj, "awaiting-approval").kind).toBe("print");
    const shown = brief(proj, "code-generation");
    expect(shown).toContain("**Stages:** NFR Design, Code Generation");
    expect(shown).toMatch(/^\| R-01 \| Critical \| [^|]+ \| Changed after review \|$/m);
    expect(shown).not.toContain("Approve accepts the open review finding");
    expect(shown).toContain("- **Approve** - continue with the work as changed after review.");
    expect(gateReport(proj, "approved", ["--user-input", "Approve"]).kind).toBe("done");
    expect(recorded(proj)).toEqual([expect.stringMatching(/\/nfr-design\/[^#]+#R-01 Changed after review$/)]);
  });

  test("with no open findings the end-of-Unit gate reads as before and records none", () => {
    const proj = seedProject("unit-end");
    walkToGate(proj, {});
    expect(gateReport(proj, "awaiting-approval").kind).toBe("print");
    const plan = `${relative(proj, stageDir(proj, "code-generation")).replaceAll("\\", "/")}/code-generation-plan.md`;
    expect(brief(proj, "code-generation")).toBe(
      [
        "**Stage:** Code Generation",
        "**Review outcome:** No blocking concerns were found.",
        "",
        `**Review artifact:** \`${plan}\``,
        "",
        "| ID | Severity | Where | Status |",
        "|---|---|---|---|",
        "| - | - | - | No findings |",
        "",
        "**Decision options:**",
        "- **Approve** - continue; no findings are open.",
        "- **Request Changes** - return to the listed artifacts so the required actions can be addressed.",
        "",
      ].join("\n"),
    );
    expect(gateReport(proj, "approved", ["--user-input", "Approve"]).kind).toBe("done");
    expect(recorded(proj)).toEqual([]);
  });

  test("a per-stage team gate shows its own review as before", () => {
    const proj = seedProject("per-stage");
    const gate = walkToGate(proj, { "functional-design": [NFR_DESIGN_FINDINGS[1]] }, ["functional-design"]);
    expect(gate).toMatchObject({ stage: "functional-design", unit_gate: "per-stage" });
    expect(runReport(proj, ["--stage", "functional-design", "--unit", "alpha", "--result", "awaiting-approval"]).kind)
      .toBe("print");
    const shown = brief(proj, "functional-design");
    expect(shown).toStartWith("**Stage:** Functional Design\n**Review outcome:** Concerns remain for your decision.\n");
    expect(shown).toContain("- **Approve** - continue with the open findings accepted.");
    expect(shown).not.toContain("Approve accepts the open review finding");
  });
});
