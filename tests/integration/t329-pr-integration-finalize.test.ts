// covers: tool:aidlc-pr, subcommand:aidlc-state:unit,
// subcommand:aidlc-orchestrate:next, audit:PR_MERGED

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  getField,
  readStateFile,
  unitCompletedReceipts,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  emitOpenReceipts,
  type PullSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-pr.ts";
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
const PR = join(AIDLC_SRC, "tools", "aidlc-pr.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function state(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: PR finalize fixture
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
- **Integration Mode**: pr

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
- **Next Action**: Finalize merged PR
`;
}

function mergedPull(): PullSnapshot {
  return {
    repo: "example/service",
    number: 42,
    url: "https://github.com/example/service/pull/42",
    state: "MERGED",
    merged: true,
    mergedAt: "2026-08-28T01:00:00Z",
    mergeCommit: { oid: "merge-42" },
    mergedBy: { login: "maintainer" },
    headRefName: "bolt-alpha",
    baseRefName: "develop",
  };
}

describe("t329-pr-integration-finalize", () => {
  test("verified merge completes the integrating Unit and exposes the stage gate", () => {
    const proj = createOrchestrationTestProject();
    projects.push(proj);
    writeFileSync(seededStateFile(proj), state(), "utf-8");
    seedBoltDag(proj, ["alpha"]);
    appendAuditEntry("STAGE_STARTED", {
      Stage: "pr-integration",
      Agent: "aidlc-pipeline-deploy-agent",
    }, proj);

    const recordDir = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "pr-integration",
    );
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, "pr-record.md"),
      [
        "# PR Record",
        "",
        "## PR Summary",
        "",
        "Merged fixture.",
        "",
        "## Publication Plan",
        "",
        "Approved fixture.",
        "",
        "## Evidence Dossier",
        "",
        "Recorded fixture.",
        "",
        "## Integration Status",
        "",
        "MERGED",
        "",
      ].join("\n"),
      "utf-8",
    );
    emitOpenReceipts(
      proj,
      "pr-integration",
      "alpha",
      [{ ...mergedPull(), state: "OPEN", merged: false }],
    );

    const fixturePath = join(proj, "merged-pr.json");
    writeFileSync(fixturePath, JSON.stringify([mergedPull()]), "utf-8");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_TEST_PR_FIXTURES: "1",
    };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const finalized = spawnSync(
      process.execPath,
      [
        PR,
        "finalize",
        "--stage",
        "pr-integration",
        "--unit",
        "alpha",
        "--fixture",
        fixturePath,
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8", env },
    );
    expect(
      finalized.status,
      `${finalized.stdout}\n${finalized.stderr}`,
    ).toBe(0);
    expect(JSON.parse(finalized.stdout)).toMatchObject({
      finalized: true,
      unit_completed: true,
      metadata_consolidated: false,
      worktree_retired: false,
      cleanup_pending: false,
    });
    expect(unitCompletedReceipts(proj, "pr-integration").has("alpha"))
      .toBe(true);

    const routed = runOrchestrateNext(ORCH, proj, [], { env: process.env });
    expect(routed.status, routed.out).toBe(0);
    expect(routed.directive).toMatchObject({
      kind: "run-stage",
      stage: "pr-integration",
      unit: "alpha",
      gate: true,
    });
  }, 30_000);

  test("finalizing an integrating Unit preserves a different active checkpoint", () => {
    const proj = createOrchestrationTestProject();
    projects.push(proj);
    writeFileSync(seededStateFile(proj), state(), "utf-8");
    seedBoltDag(proj, ["alpha", "beta"]);
    appendAuditEntry("STAGE_STARTED", {
      Stage: "pr-integration",
      Agent: "aidlc-pipeline-deploy-agent",
    }, proj);

    const recordDir = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "pr-integration",
    );
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, "pr-record.md"),
      "# PR Record\n\n## PR Summary\n\nx\n\n## Publication Plan\n\nx\n\n## Evidence Dossier\n\nx\n\n## Integration Status\n\nMERGED\n",
      "utf-8",
    );
    emitOpenReceipts(
      proj,
      "pr-integration",
      "alpha",
      [{ ...mergedPull(), state: "OPEN", merged: false }],
    );

    const started = spawnSync(
      process.execPath,
      [
        STATE,
        "unit",
        "start",
        "--stage",
        "pr-integration",
        "--unit",
        "beta",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8", env: process.env },
    );
    expect(started.status, `${started.stdout}\n${started.stderr}`).toBe(0);

    const fixturePath = join(proj, "merged-pr-active-sibling.json");
    writeFileSync(fixturePath, JSON.stringify([mergedPull()]), "utf-8");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_TEST_PR_FIXTURES: "1",
    };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const finalized = spawnSync(
      process.execPath,
      [
        PR,
        "finalize",
        "--stage",
        "pr-integration",
        "--unit",
        "alpha",
        "--fixture",
        fixturePath,
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8", env },
    );
    expect(
      finalized.status,
      `${finalized.stdout}\n${finalized.stderr}`,
    ).toBe(0);
    const content = readStateFile(proj);
    expect(getField(content, "Active Unit")).toBe("beta");
    expect(getField(content, "Unit State")).toBe("in-progress");
    expect(unitCompletedReceipts(proj, "pr-integration").has("alpha"))
      .toBe(true);
  }, 30_000);
});
