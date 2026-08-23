// covers: subcommand:aidlc-state:unit, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-jump:execute, subcommand:aidlc-log:review, audit:UNIT_STARTED, audit:UNIT_COMPLETED, audit:STAGE_JUMPED, audit:REVIEW_COMPLETED, function:autonomousSwarmOwnsStage
//
// t307 - autonomous unit-major Build-and-Test -> Code Generation loop-back.
// Unit-major routes Code Generation through the inline walk even when autonomy
// is enabled, so unit start/complete receipts must remain available. The
// stage-major negative control preserves autonomous swarm ownership.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const UNITS = ["alpha", "beta"];

type Directive = {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  message?: string;
  [key: string]: unknown;
};

let project = "";

afterEach(() => {
  if (project) cleanupTestProject(project);
  project = "";
});

function stateContent(unitMajor: boolean): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: autonomous unit-major loop-back replay
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Autonomy Mode**: autonomous
${unitMajor ? "- **Construction Iteration**: unit-major\n" : ""}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
- **Last Updated**: 2026-08-19T00:00:00Z
`;
}

function run(
  tool: string,
  args: string[],
): { status: number; stdout: string; stderr: string; out: string } {
  const result = spawnSync(BUN, [tool, ...args, "--project-dir", project], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      AIDLC_SKIP_REVISION_BACKSTOP: "1",
      AIDLC_SKIP_SOURCE_FRESHNESS: "1",
    },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status ?? -1,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
  };
}

function report(args: string[]): Directive {
  const result = run(ORCHESTRATE, ["report", ...args]);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout.trim()) as Directive;
}

function next(args: string[] = []): Directive {
  const result = runOrchestrateNext(ORCHESTRATE, project, args, {
    env: {
      ...process.env,
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      AIDLC_SKIP_REVISION_BACKSTOP: "1",
      AIDLC_SKIP_SOURCE_FRESHNESS: "1",
    },
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(result.directive).not.toBeNull();
  return result.directive as Directive;
}

function unit(action: "start" | "complete", unitName: string) {
  return run(STATE, [
    "unit",
    action,
    "--stage",
    "code-generation",
    "--unit",
    unitName,
  ]);
}

function writeCodeGenerationArtifacts(unitName: string): void {
  const dir = join(
    seededRecordDir(project),
    "construction",
    unitName,
    "code-generation",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    `# Code Generation Plan - ${unitName}\n\n- [x] Implement ${unitName}\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "code-summary.md"),
    `# Code Summary - ${unitName}\n\nImplemented ${unitName}.\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "unit-test-instructions.md"),
    `# Unit Test Instructions - ${unitName}\n\n## Run This Unit\n\n\`bun test tests/unit/${unitName}.test.ts\`\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "traceability.json"),
    `{"stage":"code-generation","unit":"${unitName}","upstream_ids":[],"coverage":[]}\n`,
    "utf-8",
  );
}

function recordReview(unitName: string): void {
  const args = [
    "review",
    "--stage",
    "code-generation",
    "--unit",
    unitName,
    "--reviewer",
    REVIEWER,
    "--iteration",
    "1",
  ];
  const requested = run(LOG, args);
  expect(requested.status, requested.out).toBe(0);
  const completed = run(LOG, [...args, "--verdict", "READY"]);
  expect(completed.status, completed.out).toBe(0);
  expect(completed.stdout).toContain('"emitted":"REVIEW_COMPLETED"');
}

function seedProject(unitMajor: boolean): void {
  project = createOrchestrationTestProject();
  writeFileSync(seededStateFile(project), stateContent(unitMajor), "utf-8");
  seedBoltDag(project, UNITS);
}

function completeInitialAttempt(): void {
  for (const unitName of UNITS) {
    const started = unit("start", unitName);
    expect(started.status, started.out).toBe(0);
    writeCodeGenerationArtifacts(unitName);
    recordReview(unitName);
    const completed = unit("complete", unitName);
    expect(completed.status, completed.out).toBe(0);
  }
  const approved = report([
    "--stage",
    "code-generation",
    "--result",
    "approved",
    "--user-input",
    "Approve",
  ]);
  expect(approved.kind).not.toBe("error");
  expect(readFileSync(seededStateFile(project), "utf-8")).toContain(
    "- **Current Stage**: build-and-test",
  );
}

function executeBackwardJump(): void {
  const jumpPrint = next(["--stage", "code-generation"]);
  expect(jumpPrint.kind).toBe("print");
  const match = (jumpPrint.message ?? "").match(
    /aidlc-jump\.ts execute --target ([a-z][a-z0-9-]*) --direction (forward|backward|redo) --scope ([a-z][a-z0-9-]*)/,
  );
  expect(match).not.toBeNull();
  const jumped = run(JUMP, [
    "execute",
    "--target",
    match?.[1] ?? "",
    "--direction",
    match?.[2] ?? "",
    "--scope",
    match?.[3] ?? "",
  ]);
  expect(jumped.status, jumped.out).toBe(0);
}

describe("t307 autonomous unit-major loop-back receipts", () => {
  test("unit-major replay can start, review, complete, and approve every Unit", () => {
    seedProject(true);
    completeInitialAttempt();
    executeBackwardJump();

    const alphaDirective = next();
    expect(alphaDirective.kind).toBe("run-stage");
    expect(alphaDirective.stage).toBe("code-generation");
    expect(alphaDirective.unit).toBe("alpha");
    expect(alphaDirective.gate).toBe(false);

    const alphaStarted = unit("start", "alpha");
    expect(alphaStarted.status, alphaStarted.out).toBe(0);
    expect(alphaStarted.stdout).toContain('"emitted":"UNIT_STARTED"');
    recordReview("alpha");
    const alphaCompleted = unit("complete", "alpha");
    expect(alphaCompleted.status, alphaCompleted.out).toBe(0);

    const betaDirective = next();
    expect(betaDirective.kind).toBe("run-stage");
    expect(betaDirective.stage).toBe("code-generation");
    expect(betaDirective.unit).toBe("beta");
    expect(betaDirective.gate).toBe(false);

    const betaStarted = unit("start", "beta");
    expect(betaStarted.status, betaStarted.out).toBe(0);
    const betaCompleted = unit("complete", "beta");
    expect(betaCompleted.status, betaCompleted.out).toBe(0);

    const settle = next();
    expect(settle.kind).toBe("run-stage");
    expect(settle.stage).toBe("code-generation");
    expect(settle.unit).toBe("beta");
    expect(settle.gate).toBe(true);

    const missingReview = report([
      "--stage",
      "code-generation",
      "--result",
      "approved",
      "--user-input",
      "Autonomous loop-back 1 per construction protocol module",
    ]);
    expect(missingReview.kind).toBe("error");
    expect(missingReview.message).toContain(
      "1 of 2 applicable units have no fresh recorded review (beta)",
    );

    recordReview("beta");
    const refreshed = report([
      "--stage",
      "code-generation",
      "--result",
      "approved",
      "--user-input",
      "Autonomous loop-back 1 per construction protocol module",
    ]);
    expect(refreshed.kind).not.toBe("error");
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain(
      "- **Current Stage**: build-and-test",
    );
  }, 60_000);

  test("autonomous stage-major retains swarm ownership of Unit receipts", () => {
    seedProject(false);
    const refused = unit("start", "alpha");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(
      "swarm referee owns per-unit bookkeeping (SWARM_UNIT_* receipts)",
    );
  });
});
