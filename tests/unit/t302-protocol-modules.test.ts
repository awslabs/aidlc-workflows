// covers: file:aidlc-common/protocols/stage-protocol-reviewer.md, file:aidlc-common/protocols/stage-protocol-swarm.md, file:aidlc-common/protocols/stage-protocol-ensemble.md, file:aidlc-common/protocols/stage-protocol-construction.md, file:aidlc-common/protocols/stage-protocol-learnings.md, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  REPO_ROOT,
  resetAidlcEnv,
  runOrchestrateNext,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const MODULES = [
  "reviewer",
  "swarm",
  "ensemble",
  "construction",
  "learnings",
] as const;

let project = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  if (project) cleanupTestProject(project);
  project = "";
});

function directiveFor(
  stage: string,
  scope: string,
  withMainWorkflow = false,
): Record<string, unknown> {
  project = createOrchestrationTestProject();
  if (withMainWorkflow) {
    seedStateFile(project, "state-mid-inception.md");
    writeFileSync(
      seededStateFile(project),
      readFileSync(seededStateFile(project), "utf-8")
        .replace("- **Scope**: bugfix", `- **Scope**: ${scope}`),
    );
  }
  const result = runOrchestrateNext(
    ORCHESTRATE,
    project,
    ["--stage", stage, "--single", "--scope", scope],
    {
      cwd: project,
      env: { ...process.env, AWS_AIDLC_DEFAULT_SCOPE: undefined },
    },
  );
  expect(result.status).toBe(0);
  expect(result.directive?.kind).toBe("run-stage");
  return result.directive as Record<string, unknown>;
}

function moduleList(directive: Record<string, unknown>): string[] {
  const value = directive.protocol_modules;
  return Array.isArray(value) ? value.map(String) : [];
}

function singleRequirementsAuditShard(): string {
  const start = readAuditShardEvents(project).find((entry) =>
    entry.event === "STAGE_STARTED" &&
    auditBlockField(entry.block, "Workflow") === "single-stage:requirements-analysis"
  );
  if (!start) throw new Error("The isolated requirements attempt has no start boundary");
  return start.shard;
}

function seedSingleSummaryQuestions(): void {
  const dir = join(seededRecordDir(project), "inception", "requirements-analysis");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "requirements-analysis-questions.md"),
    "# Questions\n\n## Consolidated Summary Confirmation\n\n" +
      "- Looks correct\n- Request changes\n\n[Answer]: Looks correct\n",
  );
}

function reportSingleRequirements(): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      ORCHESTRATE,
      "report",
      "--project-dir", project,
      "--single",
      "--stage", "requirements-analysis",
      "--result", "approved",
    ],
    {
      cwd: project,
      encoding: "utf-8",
      env: {
        ...process.env,
        AWS_AIDLC_DEFAULT_SCOPE: undefined,
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: undefined,
      },
    },
  );
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function swarmDirective(): Record<string, unknown> {
  project = createOrchestrationTestProject();
  writeFileSync(
    seededStateFile(project),
    `# AI-DLC State Tracking

## Project Information
- **Project**: protocol module swarm test
- **Project Type**: Greenfield
- **Scope**: feature
- **Construction Autonomy Mode**: autonomous
- **Skeleton Stance**: off
- **State Version**: 8

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
`,
  );
  seedBoltDagBatches(project, [["alpha"]]);
  const result = runOrchestrateNext(ORCHESTRATE, project, [], {
    cwd: project,
    env: { ...process.env, AWS_AIDLC_DEFAULT_SCOPE: undefined },
  });
  expect(result.status).toBe(0);
  expect(result.directive?.kind).toBe("invoke-swarm");
  return result.directive as Record<string, unknown>;
}

describe("t302 conditional protocol modules", () => {
  test("conditional module files exist in core and every generated harness tree", () => {
    for (const module of MODULES) {
      expect(
        existsSync(
          join(
            REPO_ROOT,
            "core",
            "aidlc-common",
            "protocols",
            `stage-protocol-${module}.md`,
          ),
        ),
      ).toBe(true);
      for (const harness of HARNESS_MATRIX) {
        expect(
          existsSync(
            join(
              harness.engineRoot,
              "aidlc-common",
              "protocols",
              `stage-protocol-${module}.md`,
            ),
          ),
        ).toBe(true);
      }
    }
  });

  test("classic requirements-analysis omits reviewer and learnings ceremonies", () => {
    const directive = directiveFor("requirements-analysis", "classic");
    expect(moduleList(directive)).toEqual([]);
    expect(directive.reviewer).toBeUndefined();
    expect(directive.sensors_applicable).toEqual([]);
    expect(directive.ceremony).toEqual({
      sensors: "off",
      learnings: "off",
      summary_confirmation: "off",
    });
  });

  test("feature requirements-analysis retains active sensor bindings", () => {
    const directive = directiveFor("requirements-analysis", "feature");
    expect(directive.sensors_applicable).toEqual([
      "required-sections",
      "upstream-coverage",
    ]);
    expect(moduleList(directive)).toContain("learnings");
  });

  test.each([
    { scope: "classic", mainScope: "feature", confirmation: "off", outcome: "done" },
    { scope: "feature", mainScope: "classic", confirmation: "on", outcome: "error" },
  ])("isolated summary policy follows $scope rather than the main workflow", ({
    scope, mainScope, confirmation, outcome,
  }) => {
    const directive = directiveFor("requirements-analysis", scope, true);
    expect(directive.ceremony).toMatchObject({ summary_confirmation: confirmation });
    seedSingleSummaryQuestions();
    // Keep the attempt in the same intent ledger while main-workflow policy changes.
    const shard = singleRequirementsAuditShard();
    const state = readFileSync(seededStateFile(project), "utf-8")
      .replace(`- **Scope**: ${scope}`, `- **Scope**: ${mainScope}`);
    writeFileSync(seededStateFile(project), state);
    const auditBefore = readFileSync(shard, "utf-8");

    const result = reportSingleRequirements();

    expect(result.kind, JSON.stringify(result)).toBe(outcome);
    expect(readFileSync(seededStateFile(project), "utf-8")).toBe(state);
    const auditAfter = readFileSync(shard, "utf-8");
    if (outcome === "done") {
      expect(auditAfter.slice(auditBefore.length)).toContain("**Event**: STAGE_COMPLETED");
      expect(auditAfter.slice(auditBefore.length)).toContain("**Workflow**: single-stage:requirements-analysis");
    } else {
      expect(result.message).toContain("consolidated summary confirmation");
      expect(auditAfter).toBe(auditBefore);
    }
  });

  test("isolated summary policy rejects a different scope while an attempt is open", () => {
    directiveFor("requirements-analysis", "classic");
    const shard = singleRequirementsAuditShard();
    const audit = readFileSync(shard, "utf-8");
    const options = {
      cwd: project,
      env: { ...process.env, AWS_AIDLC_DEFAULT_SCOPE: undefined },
    };

    const changed = runOrchestrateNext(
      ORCHESTRATE,
      project,
      ["--stage", "requirements-analysis", "--single", "--scope", "feature"],
      options,
    );

    expect(changed.directive?.kind, JSON.stringify(changed.directive)).toBe("error");
    expect(readFileSync(shard, "utf-8")).toBe(audit);
    expect(existsSync(seededStateFile(project))).toBe(false);

    const resumed = runOrchestrateNext(
      ORCHESTRATE,
      project,
      ["--stage", "requirements-analysis", "--single", "--scope", "classic"],
      options,
    );

    expect(resumed.directive?.kind, JSON.stringify(resumed.directive)).toBe("run-stage");
    expect(resumed.directive?.ceremony).toMatchObject({ summary_confirmation: "off" });
    expect(readFileSync(shard, "utf-8")).toBe(audit);
    expect(existsSync(seededStateFile(project))).toBe(false);
  });

  test("isolated summary policy remains on for legacy attempts without Scope", () => {
    directiveFor("requirements-analysis", "classic", true);
    seedSingleSummaryQuestions();
    const state = readFileSync(seededStateFile(project), "utf-8");
    const shard = singleRequirementsAuditShard();
    const audit = readFileSync(shard, "utf-8")
      .replace(/^(?:- )?\*\*Scope\*\*:[^\n]*\n/gm, "");
    writeFileSync(shard, audit);

    const result = reportSingleRequirements();

    expect(result.kind, JSON.stringify(result)).toBe("error");
    expect(result.message).toContain("consolidated summary confirmation");
    expect(readFileSync(shard, "utf-8")).toBe(audit);
    expect(readFileSync(seededStateFile(project), "utf-8")).toBe(state);
  });

  test("express code-generation omits reviewer under review_cap none", () => {
    const modules = moduleList(directiveFor("code-generation", "express"));
    expect(modules).toEqual(["ensemble", "construction", "learnings"]);
    expect(modules).not.toContain("reviewer");
  });

  test("user-stories mob lists ensemble", () => {
    const directive = directiveFor("user-stories", "classic");
    expect(moduleList(directive)).toEqual(["ensemble"]);
    expect(directive.reviewer).toBeUndefined();
  });

  test("classic code-generation lists construction", () => {
    const directive = directiveFor("code-generation", "classic");
    expect(moduleList(directive)).toEqual(["ensemble", "construction"]);
    expect(directive.reviewer).toBeUndefined();
  });

  test("feature inline stage includes learnings without an ordinary reviewer", () => {
    const directive = directiveFor("market-research", "feature");
    expect(moduleList(directive)).toEqual(["learnings"]);
    expect(directive.reviewer).toBeUndefined();
    expect(directive.ceremony).toEqual({
      sensors: "on",
      learnings: "on",
      summary_confirmation: "on",
    });
  });

  test("invoke-swarm lists reviewer, construction, and swarm modules", () => {
    expect(moduleList(swarmDirective())).toEqual([
      "reviewer",
      "construction",
      "swarm",
    ]);
  });
});
