// covers: function:unitReceiptOnlyStep, subcommand:aidlc-orchestrate:next, subcommand:aidlc-state:unit, audit:UNIT_COMPLETED
//
// Issue #2021: a new solo workflow (Construction Checkpoints on, unit-major,
// autonomous) where the agent writes a Unit's files but never runs the Unit's
// start and completion receipts. Every `next` used to hand back the same
// Unit's stage, so the agent looped. Each `next` here is recorded and the Unit
// must leave its stage on the step `next` names.
//
// Mechanism: cli. Every step drives the real aidlc-state.ts, aidlc-log.ts and
// aidlc-orchestrate.ts against a seeded unit-major Construction fixture.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { artifactFilename, findStageBySlug } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SLUG = "functional-design";
const FIRST = "platform-foundation";
const START = `unit start --stage ${SLUG} --unit ${FIRST}`;
const COMPLETE = `unit complete --stage ${SLUG} --unit ${FIRST}`;
const SEPARATOR = "\u2014";
const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

// The issue's workflow: classic, greenfield, solo, checkpoints on, unit-major,
// serial, autonomous, in its first per-Unit stage.
function state(reviewOverride: string | null): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: checkpoint unit receipt step
- **Project Type**: Greenfield
- **Scope**: classic
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: autonomous
${reviewOverride === null ? "" : `- **Review Override**: ${reviewOverride}\n`}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
${STAGES.map((stage) => `- [${stage === SLUG ? "-" : " "}] ${stage} ${SEPARATOR} EXECUTE`).join("\n")}
- [ ] build-and-test ${SEPARATOR} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${SLUG}
- **Status**: Running
`;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

function run(tool: string, args: string[], proj: string): { rc: number; out: string } {
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: cleanEnv(),
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function directiveOf(out: string): Record<string, unknown> {
  const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  return line ? JSON.parse(line) as Record<string, unknown> : {};
}

// Every `next` of a case, in order, for the failure message.
let nexts: string[] = [];
function next(proj: string): Record<string, unknown> {
  const directive = runOrchestrateNext(ORCHESTRATE, proj, [], { env: cleanEnv() }).directive ?? {};
  nexts.push(JSON.stringify({
    kind: directive.kind, stage: directive.stage, unit: directive.unit, message: directive.message,
  }));
  return directive;
}

// unit complete's artifact check is a subject here, so the suite-wide
// artifact-guard skip is cleared per spawn, as in t260.
function unitVerb(proj: string, action: string, unit: string): { rc: number; out: string } {
  const env = cleanEnv();
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  const r = spawnSync(
    BUN,
    [STATE, "unit", action, "--stage", SLUG, "--unit", unit, "--project-dir", proj],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env },
  );
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function writeUnitArtifacts(proj: string, unit: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, SLUG);
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug(SLUG)!.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n${unit} design\n`, "utf-8");
  }
}

// The Unit's review as the reviewer agent records it: the request, the review
// file, then the verdict.
function reviewThroughLog(proj: string, unit: string): void {
  const reviewer = findStageBySlug(SLUG)!.reviewer!;
  const args = ["review", "--stage", SLUG, "--reviewer", reviewer, "--unit", unit, "--iteration", "1"];
  const requested = run(LOG, args, proj);
  expect(requested.rc, requested.out).toBe(0);
  const { reviewFile } = directiveOf(requested.out) as { reviewFile: string };
  mkdirSync(dirname(join(proj, reviewFile)), { recursive: true });
  writeFileSync(join(proj, reviewFile), `**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Iteration:** 1\n\n` +
    "### Findings\n\nNo blocking findings.\n");
  const recorded = run(LOG, [...args, "--verdict", "READY"], proj);
  expect(recorded.rc, recorded.out).toBe(0);
}

let proj = "";
afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
  nexts = [];
});

function project(reviewOverride: string | null): string {
  proj = createOrchestrationTestProject();
  writeFileSync(seededStateFile(proj), state(reviewOverride), "utf-8");
  seedBoltDag(proj, [FIRST, "orders-api"]);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, proj);
  return proj;
}

// The agent's turn on the first Unit's stage: it writes the files (and the
// review, when reviews are on) but runs no receipt.
function bodyWithoutReceipts(reviews: boolean): void {
  const first = next(proj);
  expect(first.kind, nexts.join("\n")).toBe("run-stage");
  expect(first.stage).toBe(SLUG);
  expect(first.unit).toBe(FIRST);
  writeUnitArtifacts(proj, FIRST);
  if (reviews) reviewThroughLog(proj, FIRST);
}

// Run the commands `next` named and expect the Unit's next stage.
function followStep(step: Record<string, unknown>, expected: string[]): void {
  expect(step.kind, nexts.join("\n")).toBe("print");
  const message = String(step.message);
  for (const command of expected) expect(message, nexts.join("\n")).toContain(command);
  for (const command of expected) {
    const action = command.split(" ")[1];
    const result = unitVerb(proj, action, FIRST);
    expect(result.rc, result.out).toBe(0);
  }
  const after = next(proj);
  expect(after.kind, nexts.join("\n")).toBe("run-stage");
  expect(after.stage, nexts.join("\n")).toBe("nfr-requirements");
  expect(after.unit).toBe(FIRST);
}

describe("t-checkpoint-unit-receipt-step: a checkpoint-enabled Unit done without receipts (#2021)", () => {
  test("files and a READY review: next names start then complete, and the Unit moves on", () => {
    project(null);
    bodyWithoutReceipts(true);
    followStep(next(proj), [START, COMPLETE]);
  });

  test("reviews off: next names start then complete, and the Unit moves on", () => {
    project("none");
    bodyWithoutReceipts(false);
    const step = next(proj);
    expect(String(step.message)).toContain("work is written, but its completion is not recorded");
    expect(String(step.message)).not.toContain("reviewed");
    // Every later `next` names the same step until it is run: no loop back to
    // the stage.
    expect(next(proj)).toEqual(step);
    followStep(step, [START, COMPLETE]);
  });

  test("reviews off, the Unit already started: next names only complete", () => {
    project("none");
    expect(next(proj).unit).toBe(FIRST);
    expect(unitVerb(proj, "start", FIRST).rc).toBe(0);
    writeUnitArtifacts(proj, FIRST);
    const step = next(proj);
    expect(String(step.message), nexts.join("\n")).not.toContain(START);
    followStep(step, [COMPLETE]);
  });
});

describe("t-checkpoint-unit-receipt-step: reviews off, work genuinely left keeps the stage", () => {
  // A jump moved the Unit's attempt on: the files on disk are the earlier
  // attempt's, so the stage is handed back (its re-use question runs there).
  test("files from before a jump: next hands back the stage", () => {
    project("none");
    bodyWithoutReceipts(false);
    appendAuditEntry("STAGE_JUMPED", { From: "code-generation", To: SLUG, Stage: SLUG }, proj);
    const d = next(proj);
    expect(d.kind, nexts.join("\n")).toBe("run-stage");
    expect(d.stage).toBe(SLUG);
    expect(d.unit).toBe(FIRST);
  });

  test("a required file missing: next hands back the stage", () => {
    project("none");
    bodyWithoutReceipts(false);
    rmSync(join(seededRecordDir(proj), "construction", FIRST, SLUG, artifactFilename("rules")));
    const d = next(proj);
    expect(d.kind, nexts.join("\n")).toBe("run-stage");
    expect(d.unit).toBe(FIRST);
  });
});
