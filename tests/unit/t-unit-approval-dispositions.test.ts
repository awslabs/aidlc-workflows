// covers: audit:GATE_APPROVED, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-orchestrate:next,
// subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:review, function:approvalDispositionField
//
// #2208 part 2: what the record says about a Unit's open review findings when
// Construction approves it. The Unit's own approval records them: Accepted risk
// when the person approved the Unit, Approved autonomously when nobody did (no
// decision, so the finding stays open for the next review). The stage's own
// row the engine writes after every Unit is approved records none of them, and
// a stage approval nobody gave records Approved autonomously. No question,
// step or refusal changes; a finding the person accepted at a Unit's
// checkpoint is not put to them again when the Unit is asked about again.
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
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAllAuditShards, readAuditShardEvents, type AuditShardEvent,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  readReviewArtifactContexts, renderFindingsContext, REVIEW_FINDING_DISPOSITIONS_FIELD,
} from "../../dist/claude/.claude/tools/aidlc-review-brief.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
// The state file's separator between a stage slug and its action.
const SEPARATOR = "\u2014";

type Options = {
  iteration?: "unit-major" | "stage-major";
  autonomous?: boolean;
  policy?: "off" | "strict";
};

// Classic, two Units, advisory reviews (one pass per stage), checkpoints on.
function fixture(options: Options = {}) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Unit approval dispositions
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: ${options.iteration ?? "unit-major"}
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: ${options.autonomous ? "autonomous" : "gated"}
- **Unit Ownership**: solo
- **Review Override**: advisory
- **Guard Policy**: ${options.policy ?? "off"} (set by you)
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${STAGES.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} ${SEPARATOR} EXECUTE`).join("\n")}
- [ ] build-and-test ${SEPARATOR} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) {
    writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  }
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, p);
  if (options.autonomous) appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, p);
  return p;
}

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [
    join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  return { status: result.status, stdout: result.stdout, out: `${result.stdout}${result.stderr}` };
}

function human(p: string, prompt: string, session: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

type Beat = {
  kind: string; stage: string; unit?: string; gate?: boolean;
  construction_policy?: { completion_only?: boolean; human_completion_required?: boolean };
  construction_checkpoint?: {
    unit: string; ready?: boolean; human_required?: boolean;
    rereview?: { stage: string; iteration: number; command: string };
  };
};

function next(p: string): Beat {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as Beat;
}

function recordCommand(p: string) {
  if (readFileSync(seededStateFile(p), "utf-8").includes("- **Construction Verification Command**:")) return;
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t-dispositions-command"];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  const decision = tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env);
  expect(decision.status, decision.out).toBe(0);
  human(p, "Approve", "t-dispositions-command");
  for (const [name, args] of [["log", ["answer", ...identity, "--details", "Approve"]], ["state", ["set-construction-verification-command", command]]] as const) {
    const result = tool(p, name, [...args], env);
    expect(result.status, result.out).toBe(0);
  }
}

// The Unit's checkpoint, as the conductor runs it: the person's Approve, or the
// approval Construction records on its own when the person let it run.
function approveUnit(p: string, unit: string, autonomous: boolean) {
  recordCommand(p);
  const checkpoint = (args: string[]) => {
    const result = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", ...args]);
    expect(result.status, result.out).toBe(0);
    return JSON.parse(result.stdout);
  };
  const verified = checkpoint(["--action", "verify"]);
  expect(verified.errors).toEqual([]);
  expect(verified.verified).toBe(true);
  expect(verified.human_required).toBe(!autonomous);
  if (autonomous) {
    expect(checkpoint(["--action", "approve"]).approved).toBe(true);
    return;
  }
  const session = `t-dispositions-${unit}`;
  checkpoint(["--action", "ask", "--session", session]);
  human(p, "Approve", session);
  expect(checkpoint(["--action", "approve", "--session", session, "--user-input", "Approve"]).approved).toBe(true);
}

// The Unit's reviewed document of a stage, which its findings are recorded against.
function stageArtifact(p: string, slug: string, unit: string): string {
  const stage = findStageBySlug(slug)!;
  const document = join(seededRecordDir(p), "construction", unit, slug,
    artifactFilename(stage.review_artifact ?? stage.produces![0]));
  return relative(p, document).replaceAll("\\", "/");
}

// One review through the logger, as a real run records it: the request, the
// reviewer's report in the slot it names, then the verdict. `open` is the one
// Major finding the review raises; `still` reports R-01 as still applying.
function reviewThroughLog(
  p: string, slug: string, unit: string, iteration: number,
  report: { open?: string; still?: boolean } = {},
) {
  const reviewer = findStageBySlug(slug)!.reviewer!;
  const args = ["review", "--stage", slug, "--reviewer", reviewer, "--unit", unit, "--iteration", String(iteration)];
  const requested = tool(p, "log", args);
  expect(requested.status, requested.out).toBe(0);
  const request = JSON.parse(requested.stdout.trim().split(/\r?\n/).at(-1)!) as { recovery?: string; reviewFile: string };
  const verdict = report.open !== undefined || report.still ? "NOT-READY" : "READY";
  mkdirSync(dirname(join(p, request.reviewFile)), { recursive: true });
  writeFileSync(join(p, request.reviewFile), [
    `**Verdict:** ${verdict}`, `**Reviewer:** ${reviewer}`, `**Iteration:** ${iteration}`, "",
    "### Findings", "",
    "**Prior findings**", "", "| ID | Now | Severity | Note |", "|---|---|---|---|",
    ...(report.still ? ["| R-01 | Still applies | Major | The rule is still not covered. |"] : []), "",
    "**New findings**", "", "| Severity | Location | Finding | Required action |", "|---|---|---|---|",
    ...(report.open !== undefined
      ? [`| Major | ${stageArtifact(p, slug, unit)} > ${report.open} | It is not covered. | Cover it. |`]
      : []),
    "",
  ].join("\n"));
  const recorded = tool(p, "log", [...args, "--verdict", verdict]);
  expect(recorded.status, recorded.out).toBe(0);
  return request;
}

// A Unit built as a run records it: each stage's outputs, its review through
// the logger, then its completion. Alpha's Functional Design review leaves one
// Major finding open, R-01.
function buildUnit(p: string, unit: string, stages = STAGES) {
  for (const slug of stages) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    }
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
        stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
      }));
    }
    reviewThroughLog(p, slug, unit, 1, unit === "alpha" && slug === "functional-design" ? { open: "rule 3" } : {});
    const floor = latestMainWorkflowStageRunFloorForProject(p, slug, true, unit);
    appendAuditEntry("UNIT_COMPLETED", { Stage: slug, Unit: unit, "Run floor": floor }, p);
  }
}

// An edit to the Unit's first document of a stage, as the write hook records it.
function editDocument(p: string, slug: string, unit: string) {
  const document = join(p, stageArtifact(p, slug, unit));
  writeFileSync(document, `${readFileSync(document, "utf-8")}\nRule 3 is covered by the retry test.\n`);
  appendAuditEntry("ARTIFACT_UPDATED", { File: stageArtifact(p, slug, unit), Stage: slug, Unit: unit }, p);
}

function approvals(p: string): AuditShardEvent[] {
  return readAuditShardEvents(p).filter((row) => row.event === "GATE_APPROVED");
}

function unitApprovals(p: string, unit: string): AuditShardEvent[] {
  return approvals(p).filter((row) => auditBlockField(row.block, "Unit") === unit);
}

function stageApprovals(p: string, slug: string): AuditShardEvent[] {
  return approvals(p).filter((row) =>
    auditBlockField(row.block, "Stage") === slug && auditBlockField(row.block, "Unit") === null);
}

function recorded(row: AuditShardEvent) {
  const field = auditBlockField(row.block, REVIEW_FINDING_DISPOSITIONS_FIELD);
  if (field === null) return [];
  return (JSON.parse(field) as { dispositions: Array<{ artifact: string; id: string; status: string }> })
    .dispositions.map(({ artifact, id, status }) => ({ artifact, id, status }));
}

function alphaFinding(p: string) {
  return readReviewArtifactContexts(p, findStageBySlug("functional-design")!, "alpha")
    .flatMap((context) => context.findings)
    .map(({ id, status }) => ({ id, status }));
}

describe("t-unit-approval-dispositions: a Unit's findings on its own approval", () => {
  // The person saw alpha's open finding at alpha's checkpoint and approved it.
  test("the person approves each Unit: its row records Accepted risk, the stage's own row records none", () => {
    const p = fixture();
    for (const unit of ["alpha", "beta"]) {
      buildUnit(p, unit);
      expect(next(p).construction_checkpoint?.unit).toBe(unit);
      approveUnit(p, unit, false);
    }
    expect(next(p).stage).not.toBe("functional-design");
    const finding = { artifact: stageArtifact(p, "functional-design", "alpha"), id: "R-01" };
    expect(unitApprovals(p, "alpha").map(recorded)).toEqual([[{ ...finding, status: "Accepted risk" }]]);
    expect(unitApprovals(p, "beta").map(recorded)).toEqual([[]]);
    const stageRows = stageApprovals(p, "functional-design");
    expect(stageRows).toHaveLength(1);
    expect(auditBlockField(stageRows[0].block, "User Input")).toBeNull();
    expect(recorded(stageRows[0])).toEqual([]);
    expect(alphaFinding(p)).toEqual([{ id: "R-01", status: "Accepted risk" }]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Nobody saw it: Construction ran on its own. The finding stays open, so the
  // next review of alpha's Functional Design re-checks it.
  test("Construction approves each Unit on its own: its row records Approved autonomously and the finding stays open", () => {
    const p = fixture({ autonomous: true });
    for (const unit of ["alpha", "beta"]) {
      buildUnit(p, unit);
      expect(next(p).construction_checkpoint).toMatchObject({ unit, human_required: false });
      approveUnit(p, unit, true);
    }
    expect(next(p).stage).not.toBe("functional-design");
    const finding = { artifact: stageArtifact(p, "functional-design", "alpha"), id: "R-01" };
    expect(unitApprovals(p, "alpha").map(recorded)).toEqual([[{ ...finding, status: "Approved autonomously" }]]);
    for (const slug of STAGES) {
      expect(stageApprovals(p, slug).map(recorded), slug).toEqual([[]]);
    }
    expect(readAllAuditShards(p)).not.toContain("Accepted risk");
    expect(alphaFinding(p)).toEqual([{ id: "R-01", status: "New" }]);
    const reviewer = renderFindingsContext(
      readReviewArtifactContexts(p, findStageBySlug("functional-design")!, "alpha"), "reviewer",
    );
    const recheck = reviewer.slice(
      reviewer.indexOf("**Open findings to re-check**"),
      reviewer.indexOf("**Decided findings (settled, read-only)**"),
    );
    expect(recheck).toContain("| R-01 | Major |");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The work changed after its review and nothing re-checked it: whoever
  // approved, the Unit's row says so (#2208 part 1), and the finding stays open.
  test("a Unit whose reviewed document changed after its review is recorded as Changed after review on its row", () => {
    const p = fixture({ autonomous: true });
    buildUnit(p, "alpha");
    editDocument(p, "functional-design", "alpha");
    expect(next(p).construction_checkpoint).toMatchObject({ unit: "alpha", human_required: false });
    approveUnit(p, "alpha", true);
    expect(unitApprovals(p, "alpha").map(recorded)).toEqual([[{
      artifact: stageArtifact(p, "functional-design", "alpha"), id: "R-01", status: "Changed after review",
    }]]);
    expect(alphaFinding(p)).toEqual([{ id: "R-01", status: "New" }]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Under strict a change to alpha's approved work gets its one re-check. It
  // finds the finding nobody accepted still there: that verdict is the last
  // word on the re-check, nothing refuses, and Construction approves alpha
  // again on its own, the finding still open.
  test("Guard Policy strict: a re-check that finds the open finding again stops at nothing, and the Unit is approved again", () => {
    const p = fixture({ autonomous: true, policy: "strict" });
    buildUnit(p, "alpha");
    approveUnit(p, "alpha", true);
    editDocument(p, "functional-design", "alpha");
    const recheck = next(p);
    expect(recheck.construction_checkpoint?.rereview?.stage, JSON.stringify(recheck)).toBe("functional-design");
    expect(reviewThroughLog(p, "functional-design", "alpha", 2, { still: true }).recovery).toBe("stale-receipt");
    const asked = next(p);
    expect(asked.construction_checkpoint, JSON.stringify(asked)).toMatchObject({
      unit: "alpha", ready: true, human_required: false,
    });
    expect(asked.construction_checkpoint?.rereview).toBeFalsy();
    approveUnit(p, "alpha", true);
    const rows = unitApprovals(p, "alpha");
    expect(rows).toHaveLength(2);
    expect(recorded(rows[1])).toEqual([{
      artifact: stageArtifact(p, "functional-design", "alpha"), id: "R-01", status: "Approved autonomously",
    }]);
    expect(next(p)).toMatchObject({ stage: "functional-design", unit: "beta" });
    const record = readAllAuditShards(p);
    for (const refusal of ["REVIEW_RECOVERY_SPENT", "REVIEW_BUDGET_EXHAUSTED"]) expect(record).not.toContain(refusal);
    expect(readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED")).toEqual([]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The person accepted alpha's open finding at its checkpoint. Under strict a
  // later change to alpha's work gets its one re-check and the person is asked
  // about alpha again: the finding they accepted shows as decided, as at a
  // stage's gate, and is not put to them again as an open concern.
  test("Guard Policy strict, the person: asked about a Unit again after its re-check, a finding they accepted is not asked again", () => {
    const p = fixture({ policy: "strict" });
    buildUnit(p, "alpha");
    approveUnit(p, "alpha", false);
    editDocument(p, "functional-design", "alpha");
    expect(next(p).construction_checkpoint?.rereview?.stage).toBe("functional-design");
    reviewThroughLog(p, "functional-design", "alpha", 2, { still: true });
    expect(next(p).construction_checkpoint).toMatchObject({ unit: "alpha", ready: true, human_required: true });
    const brief = tool(p, "review-brief", ["review", "--stage", "functional-design", "--why", "stale", "--unit", "alpha"]);
    expect(brief.status, brief.out).toBe(0);
    expect(brief.stdout).toContain("**Review outcome:** No open findings remain.");
    expect(brief.stdout).toContain("| R-01 | Major | functional-spec.md > rule 3 | Accepted risk |");
    expect(brief.stdout).toContain("- **Approve** - continue; no findings are open.");
    approveUnit(p, "alpha", false);
    expect(next(p)).toMatchObject({ stage: "functional-design", unit: "beta" });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Stage by stage, the stage's own approval covers every Unit: the person's
  // records Accepted risk, and one nobody gave records Approved autonomously.
  test.each([
    { autonomous: false, status: "Accepted risk" },
    { autonomous: true, status: "Approved autonomously" },
  ])("stage by stage, autonomous $autonomous: the stage's approval records $status", ({ autonomous, status }) => {
    const p = fixture({ iteration: "stage-major", autonomous });
    for (const unit of ["alpha", "beta"]) buildUnit(p, unit, ["functional-design"]);
    const gate = next(p);
    expect(gate.stage, JSON.stringify(gate)).toBe("functional-design");
    expect(gate.construction_policy?.human_completion_required ?? true).toBe(!autonomous);
    if (!autonomous) human(p, "Approve", "t-dispositions-stage");
    for (const result of ["awaiting-approval", "approved"]) {
      const reported = tool(p, "orchestrate", ["report", "--stage", "functional-design", "--result", result,
        ...(result === "approved" && !autonomous ? ["--user-input", "Approve"] : [])]);
      expect(reported.status, reported.out).toBe(0);
    }
    const rows = stageApprovals(p, "functional-design");
    expect(rows).toHaveLength(1);
    expect(recorded(rows[0])).toEqual([{
      artifact: stageArtifact(p, "functional-design", "alpha"), id: "R-01", status,
    }]);
    expect(alphaFinding(p)).toEqual([{ id: "R-01", status: autonomous ? "New" : "Accepted risk" }]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
