// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-jump:execute, subcommand:aidlc-log:review, audit:STAGE_JUMPED, audit:REVIEW_COMPLETED, function:freshReviewReceipts
//
// t304 - deterministic Build-and-Test -> Code Generation loop-back review
// replay. The backward jump preserves per-unit artifacts but invalidates the
// prior attempt's reviews. The real approval seam must refuse until every
// applicable unit has a fresh current-attempt REVIEW_COMPLETED.

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
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const UNITS = ["alpha", "beta"];

const STATE_CONTENT = `# AI-DLC State Tracking

## Project Information
- **Project**: loop-back review replay
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Autonomy Mode**: gated

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
- **Last Updated**: 2026-08-13T00:00:00Z
`;

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
  expect(result.status).toBe(0);
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
  expect(result.status).toBe(0);
  expect(result.directive).not.toBeNull();
  return result.directive as Directive;
}

function writeCodeGenerationArtifacts(unit: string): void {
  const dir = join(
    seededRecordDir(project),
    "construction",
    unit,
    "code-generation",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    `# Code Generation Plan - ${unit}\n\n- [x] Implement ${unit}\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "code-summary.md"),
    `# Code Summary - ${unit}\n\nImplemented ${unit}.\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "unit-test-instructions.md"),
    `# Unit Test Instructions - ${unit}\n\n## Run This Unit\n\n\`bun test tests/unit/${unit}.test.ts\`\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "traceability.json"),
    `{"stage":"code-generation","unit":"${unit}","upstream_ids":[],"coverage":[]}\n`,
    "utf-8",
  );
}

function recordReview(unit: string): void {
  const args = [
    "review",
    "--stage",
    "code-generation",
    "--unit",
    unit,
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

function audit(): string {
  const dir = seededAuditDir(project);
  return Array.from(new Bun.Glob("*.md").scanSync({ cwd: dir, absolute: true }))
    .sort()
    .map((path) => readFileSync(path, "utf-8"))
    .join("\n");
}

describe("t304 loop-back refreshes per-unit Code Generation reviews", () => {
  test("backward jump invalidates prior reviews; fresh per-unit receipts unblock approval", () => {
    project = createOrchestrationTestProject();
    writeFileSync(seededStateFile(project), STATE_CONTENT, "utf-8");
    seedBoltDag(project, UNITS);
    for (const unit of UNITS) {
      writeCodeGenerationArtifacts(unit);
      recordReview(unit);
    }

    const firstApproval = report([
      "--stage",
      "code-generation",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expect(firstApproval.kind).not.toBe("error");
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain(
      "- **Current Stage**: build-and-test",
    );

    const jumpPrint = next(["--stage", "code-generation"]);
    expect(jumpPrint.kind).toBe("print");
    const printed = jumpPrint.message ?? "";
    const match = printed.match(
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
    expect(audit()).toContain("**Event**: STAGE_JUMPED");

    const replayGate = next();
    expect(replayGate.kind).toBe("run-stage");
    expect(replayGate.stage).toBe("code-generation");
    expect(replayGate.unit).toBe("beta");
    expect(replayGate.gate).toBe(true);

    const stale = report([
      "--stage",
      "code-generation",
      "--result",
      "approved",
      "--user-input",
      "Retry with fix",
    ]);
    expect(stale.kind).toBe("error");
    expect(stale.message).toContain("2 of 2 applicable units have no fresh recorded review");
    expect(stale.message).toContain("alpha, beta");

    for (const unit of UNITS) recordReview(unit);

    const refreshed = report([
      "--stage",
      "code-generation",
      "--result",
      "approved",
      "--user-input",
      "Retry with fix",
    ]);
    expect(refreshed.kind).not.toBe("error");
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain(
      "- **Current Stage**: build-and-test",
    );
  }, 60_000);
});
