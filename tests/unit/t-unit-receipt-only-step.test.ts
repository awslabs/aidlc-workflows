// covers: function:unitReceiptOnlyStep, function:checkStageCompletionEvidence, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-state:unit, audit:UNIT_COMPLETED, audit:REVIEW_COMPLETED
//
// A Unit whose stage files are written and freshly reviewed READY, but whose
// completion was never recorded (receipt mode needs UNIT_COMPLETED), used to
// loop: approval was refused with "Run `next`", and `next` handed back the same
// Unit's stage body. Seen live on Kiro IDE 1.2.4: the agent wrote the files,
// the review passed, and it never ran the completion receipt. The step left is
// the receipt, so both the refusal and `next` now name its exact commands. A
// Unit with work genuinely left (a file missing, or no fresh review proving the
// files are this attempt's) keeps "Run `next`" and its stage body.
//
// Mechanism: cli. Every step drives the real aidlc-state.ts and
// aidlc-orchestrate.ts against a seeded unit-major Construction fixture.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import {
  artifactFilename,
  findStageBySlug,
  readAllAuditShards,
  reviewArtifactFingerprint,
  unitCompletedReceipts,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SLUG = "functional-design";
const PRODUCES = ["entities", "rules", "functional-spec", "traceability"];
const START_B = `unit start --stage ${SLUG} --unit unit-b`;
const COMPLETE_B = `unit complete --stage ${SLUG} --unit unit-b`;

// Unit-major Construction with functional-design in flight and only that
// stage in the plan, as in t260.
const CONSTRUCTION_STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: unit receipt only step test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on
- **Construction Iteration**: unit-major

## Runtime State
- **Revision Count**: 0

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [S] nfr-requirements — EXECUTE
- [S] nfr-design — EXECUTE
- [S] infrastructure-design — EXECUTE
- [S] code-generation — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-07-30T00:00:00Z
`;

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
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

function next(proj: string, extra: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: cleanEnv(extra) });
  return result.directive ?? {};
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

function writeUnitArtifacts(proj: string, unit: string, skip: string | null = null): void {
  const dir = join(seededRecordDir(proj), "construction", unit, SLUG);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES) {
    if (name === skip) continue;
    writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n${unit} design\n`, "utf-8");
  }
}

// A fresh READY review of the Unit's current files, through the same audit
// rows t341 seeds.
function reviewReady(proj: string, unit: string): void {
  const stage = findStageBySlug(SLUG)!;
  const fields: Record<string, string> = {
    Stage: SLUG,
    Unit: unit,
    Reviewer: stage.reviewer!,
    Iteration: "1",
    "Artifact Fingerprint": reviewArtifactFingerprint(proj, stage, unit)!,
  };
  appendAuditEntry("REVIEW_REQUESTED", fields, proj);
  appendAuditEntry("REVIEW_COMPLETED", { ...fields, Verdict: "READY" }, proj);
}

let proj = "";
afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
});

// unit-a is done the proper way (start, files, complete), which puts the
// stage in receipt mode; unit-b is left for each case to shape.
function projectWithFirstUnitDone(): string {
  proj = createOrchestrationTestProject();
  writeFileSync(seededStateFile(proj), CONSTRUCTION_STATE, "utf-8");
  seedBoltDag(proj, ["unit-a", "unit-b"]);
  expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
  writeUnitArtifacts(proj, "unit-a");
  expect(unitVerb(proj, "complete", "unit-a").rc).toBe(0);
  return proj;
}

describe("t-unit-receipt-only-step: a Unit done but not recorded gets its receipt step", () => {
  test("next names the receipt commands, and running them settles the Unit", () => {
    projectWithFirstUnitDone();
    writeUnitArtifacts(proj, "unit-b");
    reviewReady(proj, "unit-b");

    const d = next(proj);
    expect(d.kind, JSON.stringify(d)).toBe("print");
    const message = String(d.message);
    expect(message).toContain(START_B);
    expect(message).toContain(COMPLETE_B);
    expect(message.indexOf(START_B)).toBeLessThan(message.indexOf(COMPLETE_B));
    expect(message).not.toContain("Run `next` to finish");

    // unit start reads the engine's route as a read-only check: that route is
    // still unit-b's stage, so the printed commands work as written.
    const probe = next(proj, { AIDLC_ROUTE_CHECK: "1" });
    expect(probe.kind, JSON.stringify(probe)).toBe("run-stage");
    expect(probe.unit).toBe("unit-b");

    expect(unitVerb(proj, "start", "unit-b").rc).toBe(0);
    const completed = unitVerb(proj, "complete", "unit-b");
    expect(completed.rc, completed.out).toBe(0);
    expect(unitCompletedReceipts(proj, SLUG).has("unit-b")).toBe(true);
    // Every Unit is settled now, so next presents the stage's own gate.
    const after = next(proj);
    expect(JSON.stringify(after)).not.toContain(START_B);
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(after.gate).toBe(true);
  });

  test("a Unit already started gets only its complete command", () => {
    projectWithFirstUnitDone();
    expect(unitVerb(proj, "start", "unit-b").rc).toBe(0);
    writeUnitArtifacts(proj, "unit-b");
    reviewReady(proj, "unit-b");

    const d = next(proj);
    expect(d.kind, JSON.stringify(d)).toBe("print");
    expect(String(d.message)).toContain(COMPLETE_B);
    expect(String(d.message)).not.toContain(START_B);
  });

  test("the approval refusal names the same commands instead of Run next", () => {
    projectWithFirstUnitDone();
    writeUnitArtifacts(proj, "unit-b");
    reviewReady(proj, "unit-b");

    for (const result of ["awaiting-approval", "approved"]) {
      const r = run(ORCHESTRATE, ["report", "--stage", SLUG, "--result", result, "--user-input", "Approve"], proj);
      const d = directiveOf(r.out);
      expect(d.kind, r.out).toBe("print");
      expect(String(d.message)).toContain(START_B);
      expect(String(d.message)).toContain(COMPLETE_B);
      expect(String(d.message)).not.toContain("Run `next` to finish");
    }
    expect(readAllAuditShards(proj)).not.toContain("GATE_APPROVED");

    // Reporting the one Unit directly is a team-only form; for this solo Unit
    // the refusal names the same receipt step.
    const byUnit = run(ORCHESTRATE, ["report", "--stage", SLUG, "--result", "approved", "--unit", "unit-b", "--user-input", "Approve"], proj);
    const d = directiveOf(byUnit.out);
    expect(d.kind, byUnit.out).toBe("print");
    expect(String(d.message)).toContain(COMPLETE_B);
    expect(String(d.message)).not.toContain("Unit Ownership: team");
  });
});

describe("t-unit-receipt-only-step: work genuinely left keeps Run next", () => {
  for (const [label, shape] of [
    ["a required file is missing", (p: string) => { writeUnitArtifacts(p, "unit-b", "rules"); reviewReady(p, "unit-b"); }],
    ["no fresh review shows the files are this attempt's", (p: string) => writeUnitArtifacts(p, "unit-b")],
  ] as const) {
    test(`${label}: next hands back the stage and the refusal says Run next`, () => {
      projectWithFirstUnitDone();
      shape(proj);

      const d = next(proj);
      expect(d.kind, JSON.stringify(d)).toBe("run-stage");
      expect(d.unit).toBe("unit-b");
      expect(JSON.stringify(d)).not.toContain(COMPLETE_B);

      const r = run(ORCHESTRATE, ["report", "--stage", SLUG, "--result", "awaiting-approval"], proj);
      const refusal = directiveOf(r.out);
      expect(refusal.kind, r.out).toBe("error");
      expect(String(refusal.message)).toContain("1 of 2 work items are not complete (unit-b)");
      expect(String(refusal.message)).toContain("Run `next`");
      expect(String(refusal.message)).not.toContain(COMPLETE_B);

      const byUnit = directiveOf(
        run(ORCHESTRATE, ["report", "--stage", SLUG, "--result", "approved", "--unit", "unit-b", "--user-input", "Approve"], proj).out,
      );
      expect(byUnit.kind).toBe("error");
      expect(String(byUnit.message)).toContain("Unit Ownership: team");
    });
  }

  test("unit complete still refuses a Unit whose files are missing", () => {
    projectWithFirstUnitDone();
    writeUnitArtifacts(proj, "unit-b", "rules");
    expect(unitVerb(proj, "start", "unit-b").rc).toBe(0);
    const completed = unitVerb(proj, "complete", "unit-b");
    expect(completed.rc).not.toBe(0);
    expect(completed.out).toContain("missing");
  });
});
