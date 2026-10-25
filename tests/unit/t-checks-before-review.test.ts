// covers: subcommand:aidlc-log:review, subcommand:aidlc-orchestrate:report, subcommand:aidlc-state:completion-checks
// covers: function:completionChecksStep
//
// The stage's advisory gate checks used to run only when its gate opened, after
// the review had frozen the documents and after the learnings question, so the
// agent handed its own slips (a source tag, an input it did not name) to the
// person as a Request Changes call in the check's words. Now they run once when
// the documents are written and handed on: the review request, or the report
// that opens the gate when no review took them first, comes back as the agent's
// step naming what a check found and the same command; the next call goes on,
// and the gate fires the checks again, so it names only what is left. Nothing
// new is asked of the person, and a blocking check stays the gate's.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG, ORCHESTRATE, env, exec, say } from "../harness/aidlc-input-corpus.ts";
import {
  AIDLC_SRC,
  FIXTURES_DIR,
  cleanupTestProject,
  createOrchestrationTestProject,
  recordArtifactWriteViaHook,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 4);

const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor.ts");
const PRODUCT_LEAD = "aidlc-product-lead-agent";
const ARCHITECT_REVIEWER = "aidlc-architecture-reviewer-agent";

interface Reply { status: number; json: Record<string, unknown> | null; out: string }

async function run(proj: string, tool: string, args: string[], extra: Record<string, string> = {}): Promise<Reply> {
  const res = await exec([process.execPath, tool, ...args, "--project-dir", proj], { cwd: proj, env: env(proj, { env: extra }) });
  const line = res.stdout.split("\n").find((entry) => entry.startsWith("{"));
  let json: Record<string, unknown> | null = null;
  try {
    json = line ? JSON.parse(line) as Record<string, unknown> : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, out: `${res.stdout}${res.stderr}` };
}

const events = (proj: string): string[] => readAuditShardEvents(proj).map((row) => row.event);
const count = (proj: string, event: string): number => events(proj).filter((name) => name === event).length;
const fires = (proj: string, sensor: string) => readAuditShardEvents(proj).filter((row) =>
  row.event === "SENSOR_FIRED" && auditBlockField(row.block, "Sensor ID") === sensor);

function write(proj: string, path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const existed = existsSync(path);
  writeFileSync(path, body, "utf-8");
  recordArtifactWriteViaHook(proj, path, existed ? "Edit" : "Write");
}

// ---- A reviewed stage: a bugfix at Requirements Analysis, its document written from confirmed answers.
const RA = "requirements-analysis";
const raDir = (proj: string) => join(seededRecordDir(proj), "inception", RA);
const REQUIREMENTS = "# Requirements\n\n## Overview\n\nA to-do app whose titles are never blank.\n\n## Functional Requirements\n\n- FR-1: a blank title is refused.\n";
const CITED = `${REQUIREMENTS}\nBuilt from intent-statement.md.\n`;

async function reviewedStage(options: { requirements?: string | null } = {}): Promise<string> {
  const proj = createOrchestrationTestProject();
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  appendAuditEntry("STAGE_STARTED", { Stage: RA }, proj);
  // Intent Capture's statement is on disk, so the upstream-coverage check asks the requirements to name it.
  const ideation = join(seededRecordDir(proj), "ideation", "intent-capture");
  mkdirSync(ideation, { recursive: true });
  writeFileSync(join(ideation, "intent-statement.md"), "# Intent Statement\n\nA to-do app.\n", "utf-8");
  const questions = join(raDir(proj), `${RA}-questions.md`);
  write(proj, questions, "# Questions\n\n## Q1\n\nShould a blank title be refused?\n\n[Answer]: Yes\n\n" +
    "## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n- Looks correct\n- Request changes\n\n[Answer]: \n");
  const summary = ["--checkpoint", "summary-confirmation", "--stage", RA, "--questions-file", questions];
  expect((await run(proj, LOG, ["decision", ...summary, "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"])).status).toBe(0);
  await say(proj, "Looks correct", "claude");
  write(proj, questions, readFileSync(questions, "utf-8").replace(/\[Answer\]: \n$/, "[Answer]: Looks correct\n"));
  expect((await run(proj, LOG, ["answer", ...summary, "--details", "Looks correct"])).status).toBe(0);
  const requirements = options.requirements === undefined ? REQUIREMENTS : options.requirements;
  if (requirements !== null) write(proj, join(raDir(proj), "requirements.md"), requirements);
  return proj;
}

const request = (proj: string, extra: string[] = [], envExtra: Record<string, string> = {}) =>
  run(proj, LOG, ["review", "--stage", RA, "--reviewer", PRODUCT_LEAD, "--iteration", "1", ...extra], envExtra);

async function ready(proj: string, reply: Reply, stage = RA, reviewer = PRODUCT_LEAD, unit?: string): Promise<void> {
  const reviewFile = reply.json?.reviewFile as string;
  expect(reviewFile, reply.out).toBeString();
  writeFileSync(join(proj, reviewFile),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
      "### Findings\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
  const verdict = await run(proj, LOG, ["review", "--stage", stage, "--reviewer", reviewer, "--iteration", "1",
    ...(unit ? ["--unit", unit] : []), "--verdict", "READY"]);
  expect(verdict.status, verdict.out).toBe(0);
}

const report = (proj: string, stage: string, result: string, extra: string[] = []) =>
  run(proj, ORCHESTRATE, ["report", "--stage", stage, "--result", result, ...extra]);

describe("t-checks-before-review: a reviewed stage's checks run at its review request", () => {
  test("the first request comes back as the agent's step, naming the finding, where it is listed and the same request", async () => {
    const proj = await reviewedStage();
    try {
      const held = await request(proj);
      expect(held.status, held.out).toBe(0);
      expect(held.json?.kind, held.out).toBe("print");
      const message = held.json?.message as string;
      expect(message).toContain("Before the review, this stage's checks ran on its documents.");
      expect(message).toContain("The upstream-coverage check reports 1 finding in requirements.md.");
      expect(message).toContain(`review --stage ${RA} --reviewer ${PRODUCT_LEAD} --iteration 1`);
      // The run again does not check again, and the step says so.
      expect(message).toContain("it records the review request without checking again, and the gate checks again and says what is left.");
      const detail = /The findings are in (\S+)\. Fix what is yours/.exec(message)?.[1];
      expect(detail, message).toBeString();
      expect(existsSync(join(proj, detail as string))).toBe(true);
      // Nothing was recorded for the review; the checks ran first.
      expect(count(proj, "REVIEW_REQUESTED")).toBe(0);
      expect(fires(proj, "upstream-coverage").length).toBe(1);
      expect(held.json?.narration).toBeUndefined();
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("fixed, the next request records and the gate, firing the checks again, has nothing left to say", async () => {
    const proj = await reviewedStage();
    try {
      expect((await request(proj)).json?.kind).toBe("print");
      write(proj, join(raDir(proj), "requirements.md"), CITED);
      const asked = await request(proj);
      expect(asked.json?.emitted, asked.out).toBe("REVIEW_REQUESTED");
      expect(fires(proj, "upstream-coverage").length).toBe(1);
      await ready(proj, asked);
      const gate = await report(proj, RA, "awaiting-approval");
      expect(gate.json?.kind, gate.out).toBe("print");
      expect(count(proj, "STAGE_AWAITING_APPROVAL")).toBe(1);
      expect(fires(proj, "upstream-coverage").length).toBe(2);
      expect(String(gate.json?.narration ?? "")).not.toContain("check reports");
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("not fixed, the next request records anyway and the gate names what is left", async () => {
    const proj = await reviewedStage();
    try {
      expect((await request(proj)).json?.kind).toBe("print");
      const asked = await request(proj);
      expect(asked.json?.emitted, asked.out).toBe("REVIEW_REQUESTED");
      await ready(proj, asked);
      const gate = await report(proj, RA, "awaiting-approval");
      expect(count(proj, "STAGE_AWAITING_APPROVAL"), gate.out).toBe(1);
      expect(String(gate.json?.narration)).toContain("The upstream-coverage check reports 1 finding in requirements.md.");
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("clean documents: the checks run and the request records at once", async () => {
    const proj = await reviewedStage({ requirements: CITED });
    try {
      const asked = await request(proj);
      expect(asked.json?.emitted, asked.out).toBe("REVIEW_REQUESTED");
      const names = events(proj);
      expect(names.indexOf("SENSOR_FIRED")).toBeGreaterThan(-1);
      expect(names.indexOf("SENSOR_FIRED")).toBeLessThan(names.indexOf("REVIEW_REQUESTED"));
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("with Sensors off nothing runs and nothing is held", async () => {
    const proj = await reviewedStage();
    try {
      const asked = await request(proj, [], { AIDLC_DISABLE_SENSORS: "1" });
      expect(asked.json?.emitted, asked.out).toBe("REVIEW_REQUESTED");
      expect(fires(proj, "upstream-coverage").length).toBe(0);
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("a review the person asked for runs at once, and the gate after it holds nothing", async () => {
    const proj = await reviewedStage();
    try {
      const asked = await request(proj, ["--person-asked"]);
      expect(asked.json?.emitted, asked.out).toBe("REVIEW_REQUESTED");
      expect(fires(proj, "upstream-coverage").length).toBe(0);
      await ready(proj, asked);
      const gate = await report(proj, RA, "awaiting-approval");
      expect(count(proj, "STAGE_AWAITING_APPROVAL"), gate.out).toBe(1);
      expect(String(gate.json?.message)).not.toContain("Before the approval");
      expect(String(gate.json?.narration)).toContain("The upstream-coverage check reports 1 finding in requirements.md.");
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("a project folder reached through a link is held once, and the next request goes on", async () => {
    const proj = await reviewedStage();
    const link = join(mkdtempSync(join(tmpdir(), "aidlc-link-")), "project");
    symlinkSync(proj, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const viaLink = () => run(link, LOG, ["review", "--stage", RA, "--reviewer", PRODUCT_LEAD, "--iteration", "1"]);
      const held = await viaLink();
      expect(held.json?.kind, held.out).toBe("print");
      const asked = await viaLink();
      expect(asked.json?.emitted, asked.out).toBe("REVIEW_REQUESTED");
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("before the stage's document is written the checks wait, and the request answers as it always has", async () => {
    const proj = await reviewedStage({ requirements: null });
    try {
      const asked = await request(proj);
      expect(asked.out).not.toContain("Before the review");
      expect(fires(proj, "upstream-coverage").length).toBe(0);
    } finally {
      cleanupTestProject(proj);
    }
  });
});

// ---- A stage no review covers: a bugfix at Build and Test, after its code was built.
const BT = "build-and-test";
const btDir = (proj: string) => join(seededRecordDir(proj), "construction", BT);
const UNCITED_BUILD = "# Build Instructions\n\nRun `bun test` from the project folder.\n";
const CITED_BUILD = `${UNCITED_BUILD}\nFrom code-generation-plan.md, unit-test-instructions.md and code-summary.md.\n`;

function buildAndTest(): string {
  const proj = createOrchestrationTestProject();
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
    .replace("- **Learnings**: on (from scope bugfix)", "- **Learnings**: off (from scope bugfix)")
    .replace("- [-] requirements-analysis ", "- [x] requirements-analysis ")
    .replace("- [ ] code-generation ", "- [x] code-generation ")
    .replace("- [ ] build-and-test ", "- [-] build-and-test ")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, `- **Current Stage**: ${BT}`)
    .replace(/^- \*\*In Progress\*\*:.*$/m, `- **In Progress**: ${BT}`)
    .replace(/^- \*\*Lifecycle Phase\*\*:.*$/m, "- **Lifecycle Phase**: CONSTRUCTION")
    .replace("- **Inception**: Active", "- **Inception**: Verified")
    .replace("- **Construction**: Pending", "- **Construction**: Active"), "utf-8");
  appendAuditEntry("STAGE_STARTED", { Stage: BT }, proj);
  const built = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(built, { recursive: true });
  writeFileSync(join(built, "code-generation-plan.md"), "# Code Generation Plan\n\n- [x] Step 1: refuse a blank title\n", "utf-8");
  writeFileSync(join(built, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n", "utf-8");
  writeFileSync(join(built, "code-summary.md"), "# Code Summary\n\nsrc/todo.ts refuses a blank title.\n", "utf-8");
  return proj;
}

async function writeBuildAndTest(proj: string, buildInstructions = UNCITED_BUILD): Promise<void> {
  // The check reads the stage's documents as a set: only build-instructions.md may name the inputs.
  write(proj, join(btDir(proj), "build-instructions.md"), buildInstructions);
  write(proj, join(btDir(proj), "build-and-test-summary.md"), "# Build and Test Summary\n\n1 test passed.\n");
  write(proj, join(btDir(proj), "test-results.md"), "# Test Results\n\n1 passed.\n");
  write(proj, join(btDir(proj), "cross-unit-traceability.md"), "# Cross-Unit Traceability\n\nFR-1: src/todo.ts.\n");
}

const box = (proj: string): string => /^- \[(.)\] build-and-test /m.exec(readFileSync(seededStateFile(proj), "utf-8"))?.[1] ?? "?";

describe("t-checks-before-review: a stage no review covers runs them at the report that opens its gate", () => {
  test("the first report comes back as the agent's step and opens nothing; the next opens the gate with what is left", async () => {
    const proj = buildAndTest();
    try {
      await writeBuildAndTest(proj);
      const held = await report(proj, BT, "awaiting-approval");
      expect(held.json?.kind, held.out).toBe("print");
      const message = String(held.json?.message);
      expect(message).toContain("Before the approval, this stage's checks ran on its documents.");
      expect(message).toMatch(/The upstream-coverage check reports \d findings? in (build-instructions|build-and-test-summary|test-results|cross-unit-traceability)\.md\./);
      expect(message).toContain(`report --stage ${BT} --result awaiting-approval`);
      expect(message).toContain("it opens the gate, which checks again and says what is left.");
      expect(message).not.toContain("review");
      expect(held.json?.narration).toBeUndefined();
      expect(count(proj, "STAGE_AWAITING_APPROVAL")).toBe(0);
      expect(box(proj)).toBe("-");
      const gate = await report(proj, BT, "awaiting-approval");
      expect(count(proj, "STAGE_AWAITING_APPROVAL"), gate.out).toBe(1);
      expect(String(gate.json?.narration)).toMatch(/The upstream-coverage check reports \d findings? in (build-instructions|build-and-test-summary|test-results|cross-unit-traceability)\.md\./);
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("fixed between the two reports, the gate says nothing about checks", async () => {
    const proj = buildAndTest();
    try {
      await writeBuildAndTest(proj);
      expect((await report(proj, BT, "awaiting-approval")).json?.kind).toBe("print");
      write(proj, join(btDir(proj), "build-instructions.md"), CITED_BUILD);
      const gate = await report(proj, BT, "awaiting-approval");
      expect(count(proj, "STAGE_AWAITING_APPROVAL"), gate.out).toBe(1);
      expect(String(gate.json?.narration ?? "")).not.toContain("check reports");
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("the gate shown again holds nothing, and a revision after Request Changes is checked once more", async () => {
    const proj = buildAndTest();
    try {
      await writeBuildAndTest(proj, CITED_BUILD);
      const opened = await report(proj, BT, "awaiting-approval");
      expect(count(proj, "STAGE_AWAITING_APPROVAL"), opened.out).toBe(1);
      const again = await report(proj, BT, "awaiting-approval");
      expect(String(again.json?.message), again.out).not.toContain("Before the approval");
      await say(proj, "Request changes: say which command runs the tests", "claude");
      const rejected = await report(proj, BT, "rejected", ["--user-input", "Request Changes"]);
      expect(count(proj, "GATE_REJECTED"), rejected.out).toBe(1);
      write(proj, join(btDir(proj), "build-instructions.md"), `${UNCITED_BUILD}\nThe tests run with \`bun test\`.\n`);
      const held = await report(proj, BT, "revised");
      expect(String(held.json?.message), held.out).toContain("Before the approval");
      expect(String(held.json?.message)).toContain(`report --stage ${BT} --result revised`);
      const shown = await report(proj, BT, "revised");
      expect(count(proj, "STAGE_AWAITING_APPROVAL"), shown.out).toBe(2);
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("the person's Override pick goes to the gate without the step", async () => {
    const proj = buildAndTest();
    try {
      await writeBuildAndTest(proj);
      const picked = await report(proj, BT, "awaiting-approval", ["--override-blocking-sensors", "--user-input", "Override blocking sensors"]);
      expect(picked.out).not.toContain("Before the approval");
      expect(fires(proj, "upstream-coverage").length).toBeLessThanOrEqual(1);
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("a blocking check is the gate's alone: the step fires none, the gate refuses as it always has", async () => {
    const proj = buildAndTest();
    try {
      await writeBuildAndTest(proj);
      // The team made the input check blocking: the compiled graph says so for Build and Test.
      const graph = JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8")) as Array<{
        slug: string; sensors_applicable?: Array<{ id: string; default_severity: string }>;
      }>;
      for (const sensor of graph.find((stage) => stage.slug === BT)?.sensors_applicable ?? []) {
        if (sensor.id === "upstream-coverage") sensor.default_severity = "blocking";
      }
      const blockingGraph = join(proj, "blocking-stage-graph.json");
      writeFileSync(blockingGraph, JSON.stringify(graph), "utf-8");
      const refused = await run(proj, ORCHESTRATE, ["report", "--stage", BT, "--result", "awaiting-approval"],
        { AIDLC_STAGE_GRAPH: blockingGraph });
      expect(refused.out).not.toContain("Before the approval");
      expect(refused.out).toContain("upstream-coverage");
      expect(count(proj, "STAGE_AWAITING_APPROVAL")).toBe(0);
    } finally {
      cleanupTestProject(proj);
    }
  });
});

// ---- Units built one at a time: each Unit's request checks its own documents.
const FD = "functional-design";
const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

function unitMajor(): string {
  const proj = createOrchestrationTestProject();
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking
## Project Information
- **Project**: Units one at a time
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Autonomy Mode**: gated
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${STAGES.map((stage) => `- [${stage === FD ? "-" : " "}] ${stage} — EXECUTE`).join("\n")}
- [ ] build-and-test — EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${FD}
- **Status**: Running
`, "utf-8");
  seedBoltDag(proj, ["alpha", "beta"]);
  appendAuditEntry("STAGE_STARTED", { Stage: FD }, proj);
  const inception = join(seededRecordDir(proj), "inception", "requirements-analysis");
  mkdirSync(inception, { recursive: true });
  writeFileSync(join(inception, "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
  return proj;
}

const unitDir = (proj: string, unit: string) => join(seededRecordDir(proj), "construction", unit, FD);
const unitSpec = (proj: string, unit: string) => join(unitDir(proj, unit), "functional-spec.md");
// A Unit's design, its spec not naming the requirements it was built from.
function writeUnitDesign(proj: string, unit: string): void {
  write(proj, join(unitDir(proj, unit), "entities.md"), `# Entities\n\n${unit}: Task.\n`);
  write(proj, join(unitDir(proj, unit), "rules.md"), `# Rules\n\n${unit}: a title is never blank.\n`);
  write(proj, join(unitDir(proj, unit), "traceability.json"), "[]\n");
  write(proj, unitSpec(proj, unit), `# Functional Spec\n\n${unit} refuses a blank title.\n`);
}
const unitRequest = (proj: string, unit: string) =>
  run(proj, LOG, ["review", "--stage", FD, "--reviewer", ARCHITECT_REVIEWER, "--unit", unit, "--iteration", "1"],
    { AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" });

describe("t-checks-before-review: a Unit's request checks that Unit's documents", () => {
  test("Unit beta is checked at its own request after Unit alpha's checks and a stage-wide fire on alpha's files", async () => {
    const proj = unitMajor();
    try {
      writeUnitDesign(proj, "alpha");
      const alpha = await unitRequest(proj, "alpha");
      expect(alpha.json?.kind, alpha.out).toBe("print");
      expect(String(alpha.json?.message)).toContain("Before the review");
      expect(String(alpha.json?.message)).toContain(`--unit alpha`);
      const alphaFires = fires(proj, "upstream-coverage");
      expect(alphaFires.length).toBeGreaterThan(0);
      expect(alphaFires.every((row) => auditBlockField(row.block, "Unit") === "alpha")).toBe(true);
      // A gate's fire over alpha's files, with no Unit on its rows.
      const gateFire = await run(proj, SENSOR, ["fire", "upstream-coverage", "--stage", FD, "--output-path", unitSpec(proj, "alpha")]);
      expect(gateFire.status, gateFire.out).toBe(0);
      writeUnitDesign(proj, "beta");
      const beta = await unitRequest(proj, "beta");
      expect(beta.json?.kind, beta.out).toBe("print");
      expect(fires(proj, "upstream-coverage").some((row) => auditBlockField(row.block, "Unit") === "beta")).toBe(true);
      // Alpha's next request goes on: its checks already ran in this attempt.
      const alphaAgain = await unitRequest(proj, "alpha");
      expect(alphaAgain.out).not.toContain("Before the review");
    } finally {
      cleanupTestProject(proj);
    }
  });
});
