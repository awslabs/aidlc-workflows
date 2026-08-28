// covers: subcommand:aidlc-orchestrate:next, directive:awaiting-integration,
// subcommand:aidlc-utility:status, audit:UNIT_INTEGRATING

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  emitOpenReceipts,
  prIntegrationRunFloor,
  type PullSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-pr.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
  seedBoltDag,
  seedStateFile,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DORMANT_GOLDEN = join(
  import.meta.dir,
  "..",
  "fixtures",
  "pr-integration-dormant-v2.json",
);
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function state(mode?: string, iteration?: "unit-major"): string {
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
${iteration === undefined ? "" : `- **Construction Iteration**: ${iteration}\n`}
## Phase Progress
- **Initialization**: Verified
- **Ideation**: Skipped
- **Inception**: Verified
- **Construction**: Active
- **Operation**: Pending

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
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

function project(mode?: string, iteration?: "unit-major"): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  writeFileSync(seededStateFile(proj), state(mode, iteration), "utf-8");
  seedBoltDag(proj, ["alpha", "beta"], [["alpha", "beta"]]);
  appendAuditEntry("STAGE_STARTED", {
    Stage: "pr-integration",
    Agent: "aidlc-pipeline-deploy-agent",
  }, proj);
  return proj;
}

function legacyProject(): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  seedStateFile(proj, "state-construction-bolt1.md");
  seedBoltDag(proj, ["widget-cart"]);
  appendAuditEntry("STAGE_STARTED", {
    Stage: "functional-design",
    Agent: "aidlc-architect-agent",
  }, proj);
  const floor = prIntegrationRunFloor(
    proj,
    "functional-design",
    "widget-cart",
  );
  appendAuditEntry("UNIT_STARTED", {
    Stage: "functional-design",
    Unit: "widget-cart",
    "Run floor": floor,
  }, proj);
  appendAuditEntry("UNIT_INTEGRATING", {
    Stage: "functional-design",
    Unit: "widget-cart",
    "Run floor": floor,
    Repos: "example/service",
    "PR URLs": "https://github.com/example/service/pull/1",
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
  const floor = prIntegrationRunFloor(proj, "pr-integration", unit);
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

function snapshot(unit: string, number: number): PullSnapshot {
  return {
    repo: "example/service",
    number,
    url: `https://github.com/example/service/pull/${number}`,
    state: "OPEN",
    headRefName: `bolt-${unit}`,
    baseRefName: "develop",
  };
}

type IntegratingRow = { unit: string; prs: { url: string }[] };
type NextDirective = {
  kind: string;
  stage?: string;
  unit?: string;
  gate?: boolean;
  integrating_units: IntegratingRow[];
};

function next(proj: string): NextDirective {
  const result = runOrchestrateNext(ORCH, proj, [], { env: process.env });
  expect(result.status, result.out).toBe(0);
  expect(result.directive).not.toBeNull();
  return result.directive as unknown as NextDirective;
}

describe("t328-pr-integration-routing", () => {
  test("knob-absent routing matches the normalized v2 directive sequence byte-for-byte", () => {
    const proj = legacyProject();
    const result = runOrchestrateNext(ORCH, proj, [], { env: process.env });
    expect(result.status, result.out).toBe(0);
    const normalize = (value: Record<string, unknown> | null) => {
      const copy = structuredClone(value);
      if (
        copy !== null &&
        typeof copy === "object" &&
        "continue_token" in copy
      ) {
        copy.continue_token = "<opaque-token>";
      }
      return copy;
    };
    const actual = `${JSON.stringify([
      ...result.steering.map(normalize),
      normalize(result.directive),
    ], null, 2)}\n`;
    expect(actual).toBe(readFileSync(DORMANT_GOLDEN, "utf-8"));
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

  test("unit-major emitter stamps a visible integrating receipt and skips ahead", () => {
    const proj = project("pr", "unit-major");
    record(proj, "alpha");
    emitOpenReceipts(
      proj,
      "pr-integration",
      "alpha",
      [snapshot("alpha", 11)],
    );
    const directive = next(proj);
    expect(directive.kind).toBe("run-stage");
    expect(directive.stage).toBe("pr-integration");
    expect(directive.unit).toBe("beta");
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
    expect(directive.integrating_units.map((row) => row.unit))
      .toEqual(["alpha", "beta"]);
    expect(directive.integrating_units[0].prs[0].url)
      .toBe("https://github.com/example/service/pull/1");
    expect(directive.gate).toBeUndefined();
  });

  test("PR mode cannot be disabled while a Unit is integrating", () => {
    const proj = project("pr");
    record(proj, "alpha");
    integrating(proj, "alpha", 4);
    const result = spawnSync(
      process.execPath,
      [STATE, "set-integration-mode", "absent", "--project-dir", proj],
      { encoding: "utf-8", env: process.env },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Refusing to disable PR integration while Units are integrating",
    );
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
