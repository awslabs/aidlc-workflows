// covers: subcommand:aidlc-orchestrate:next, directive:awaiting-integration,
// subcommand:aidlc-utility:status, audit:UNIT_INTEGRATING

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { latestMainWorkflowStageRunFloorForProject } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function state(mode?: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: PR routing fixture
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Active Agent**: aidlc-pipeline-deploy-agent

## Scope Configuration
- **Stages to Execute**: 3.5, 3.6, 3.7
- **Stages to Skip**: all others
- **Depth**: Standard
- **Test Strategy**: Standard

## Runtime State
- **Revision Count**: 0
${mode === undefined ? "" : `- **Integration Mode**: ${mode}\n`}
## Phase Progress
- **Initialization**: Verified
- **Ideation**: Skipped
- **Inception**: Verified
- **Construction**: Active
- **Operation**: Pending

## Stage Progress

### CONSTRUCTION PHASE
- [x] code-generation — EXECUTE
- [-] pr-integration — EXECUTE
- [ ] build-and-test — EXECUTE
- [S] ci-pipeline — SKIP

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: pr-integration
- **Next Stage**: build-and-test
- **Status**: Running
- **Last Updated**: 2026-08-28T00:00:00Z

## Session Resume Point
- **Last Completed Stage**: code-generation
- **Next Action**: Integrate Units
`;
}

function project(mode?: string): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  writeFileSync(seededStateFile(proj), state(mode), "utf-8");
  seedBoltDag(proj, ["alpha", "beta"], [["alpha", "beta"]]);
  appendAuditEntry("STAGE_STARTED", {
    Stage: "pr-integration",
    Agent: "aidlc-pipeline-deploy-agent",
  }, proj);
  return proj;
}

function record(proj: string, unit: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, "pr-integration");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pr-record.md"),
    "# PR Record\n\n## PR Summary\n\nx\n\n## Publication Plan\n\nx\n\n## Evidence Dossier\n\nx\n\n## Integration Status\n\nOPEN\n",
  );
}

function integrating(proj: string, unit: string, number: number): void {
  const floor = latestMainWorkflowStageRunFloorForProject(
    proj,
    "pr-integration",
    false,
    unit,
  );
  appendAuditEntry("UNIT_STARTED", {
    Stage: "pr-integration",
    Unit: unit,
    "Run floor": floor,
  }, proj);
  appendAuditEntry("PR_OPENED", {
    Stage: "pr-integration",
    Unit: unit,
    "Run floor": floor,
    Repo: "example/service",
    "PR Number": String(number),
    "PR URL": `https://github.com/example/service/pull/${number}`,
    Head: `bolt-${unit}`,
    Base: "develop",
  }, proj);
  appendAuditEntry("UNIT_INTEGRATING", {
    Stage: "pr-integration",
    Unit: unit,
    "Run floor": floor,
    Repos: "example/service",
    "PR URLs": `https://github.com/example/service/pull/${number}`,
  }, proj);
}

function next(proj: string): Record<string, any> {
  const result = runOrchestrateNext(ORCH, proj, [], { env: process.env });
  expect(result.status, result.out).toBe(0);
  expect(result.directive).not.toBeNull();
  return result.directive as Record<string, any>;
}

describe("t328-pr-integration-routing", () => {
  test("dormant knob values preserve identical legacy routing output", () => {
    const absent = project();
    const explicitAbsent = project("absent");
    record(absent, "alpha");
    record(explicitAbsent, "alpha");
    integrating(absent, "alpha", 1);
    integrating(explicitAbsent, "alpha", 1);
    expect(next(absent)).toEqual(next(explicitAbsent));
    expect(next(absent).unit).toBe("alpha");
  });

  test("integrating Unit is terminal to checkpoint and next Unit starts", () => {
    const proj = project("pr");
    record(proj, "alpha");
    integrating(proj, "alpha", 1);
    const directive = next(proj);
    expect(directive.kind).toBe("run-stage");
    expect(directive.stage).toBe("pr-integration");
    expect(directive.unit).toBe("beta");
    expect(directive.gate).toBe(false);
  });

  test("all remaining integrating emits terminal shape and never opens gate", () => {
    const proj = project("pr");
    for (const [index, unit] of ["alpha", "beta"].entries()) {
      record(proj, unit);
      integrating(proj, unit, index + 1);
    }
    const directive = next(proj);
    expect(directive.kind).toBe("awaiting-integration");
    expect(directive.stage).toBe("pr-integration");
    expect(directive.integrating_units.map((row: any) => row.unit))
      .toEqual(["alpha", "beta"]);
    expect(directive.integrating_units[0].prs[0].url)
      .toBe("https://github.com/example/service/pull/1");
    expect(directive.gate).toBeUndefined();
  });

  test("status shows URL, last-known state, age, and refresh offer", () => {
    const proj = project("pr");
    record(proj, "alpha");
    integrating(proj, "alpha", 7);
    const result = spawnSync(
      process.execPath,
      [UTILITY, "status", "--project-dir", proj],
      { encoding: "utf-8", env: process.env },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Integrating Units:");
    expect(result.stdout).toContain("https://github.com/example/service/pull/7");
    expect(result.stdout).toContain("OPEN");
    expect(result.stdout).toContain("/aidlc --status --refresh");
  });
});
