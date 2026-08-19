// covers: file:aidlc-common/protocols/stage-protocol-reviewer.md, file:aidlc-common/protocols/stage-protocol-swarm.md, file:aidlc-common/protocols/stage-protocol-ensemble.md, file:aidlc-common/protocols/stage-protocol-construction.md, file:skills/aidlc/SKILL.md, subcommand:aidlc-orchestrate:next

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  REPO_ROOT,
  resetAidlcEnv,
  runOrchestrateNext,
  seedBoltDagBatches,
  seededStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import {
  discoverScopes,
  renderRunner,
  renderStageRunner,
  runnableStages,
} from "../../dist/claude/.claude/tools/aidlc-runner-gen.ts";

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const MODULES = [
  "reviewer",
  "swarm",
  "ensemble",
  "construction",
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
): Record<string, unknown> {
  project = createOrchestrationTestProject();
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
  test("the four module files exist in core and every generated harness tree", () => {
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

  test("requirements-analysis under classic lists reviewer", () => {
    expect(moduleList(directiveFor("requirements-analysis", "classic"))).toEqual([
      "reviewer",
    ]);
  });

  test("express code-generation omits reviewer under review_cap none", () => {
    const modules = moduleList(directiveFor("code-generation", "express"));
    expect(modules).toEqual(["ensemble", "construction"]);
    expect(modules).not.toContain("reviewer");
  });

  test("user-stories mob lists ensemble", () => {
    const modules = moduleList(directiveFor("user-stories", "classic"));
    expect(modules).toEqual(["reviewer", "ensemble"]);
  });

  test("classic code-generation lists construction", () => {
    const modules = moduleList(directiveFor("code-generation", "classic"));
    expect(modules).toEqual(["reviewer", "ensemble", "construction"]);
  });

  test("non-construction inline stage without reviewer has no module hint", () => {
    const directive = directiveFor("market-research", "feature");
    expect(moduleList(directive)).toEqual([]);
    expect(directive.protocol_modules).toBeUndefined();
  });

  test("invoke-swarm lists reviewer, construction, and swarm modules", () => {
    expect(moduleList(swarmDirective())).toEqual([
      "reviewer",
      "construction",
      "swarm",
    ]);
  });

  test("reviewer module preserves every harness invocation binding", () => {
    const reviewerModule = readFileSync(
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol-reviewer.md",
      ),
      "utf-8",
    );
    for (const clause of [
      "via `Task` targeting the reviewer agent",
      "via the `subagent` tool targeting the reviewer agent config",
      "the harness resolves its `.codex/agents/aidlc-<role>-agent.toml",
      "via the `task` tool targeting the reviewer agent",
      "delegate to the reviewer custom agent",
    ]) {
      expect(reviewerModule).toContain(clause);
    }
  });

  test("every harness SKILL names all four modules and the load-once rule", () => {
    for (const harness of HARNESS_MATRIX) {
      const skill = readFileSync(
        join(harness.authoredRoot, "skills", "aidlc", "SKILL.md"),
        "utf-8",
      );
      for (const module of MODULES) {
        expect(skill).toContain(`stage-protocol-${module}.md`);
      }
      expect(skill).toContain(
        "skip a module already loaded earlier in the session",
      );
      expect(skill).toContain(
        "Load every module named in `directive.protocol_modules` before acting",
      );
      expect(skill).toContain(
        "When a `run-stage` carries `directive.swarm_settled === true`",
      );
    }
  });

  test("generated stage and scope runners load the base protocol and every emitted module", () => {
    const codeGeneration = runnableStages().find((stage) =>
      stage.slug === "code-generation"
    );
    expect(codeGeneration).toBeDefined();
    if (!codeGeneration) throw new Error("code-generation is not runnable");

    const stageRunner = renderStageRunner(codeGeneration);
    const scopes = discoverScopes();
    const scopeRunner = renderRunner(
      "express",
      scopes.express?.description ?? "",
    );
    for (const runner of [stageRunner, scopeRunner]) {
      expect(runner).toContain("aidlc-common/protocols/stage-protocol.md");
      expect(runner).toContain("stage-protocol-<module>.md");
      expect(runner).toContain("`directive.protocol_modules`");
      expect(runner).toContain("Load every listed module before");
    }
  });

  test("Construction module conditions Unit, Bolt, and reviewer ceremonies", () => {
    const construction = readFileSync(
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol-construction.md",
      ),
      "utf-8",
    );
    expect(construction).toContain(
      "ceremonies apply only when the engine resolved a real non-empty Unit DAG",
    );
    expect(construction).toContain(
      "module applies only when `directive.reviewer` is present",
    );
    expect(construction).toContain(
      "run one ordinary stage iteration with no Bolt or per-Unit ceremony",
    );
  });

  test("moved headings live only in their modules, not the static protocol", () => {
    const staticProtocol = readFileSync(
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol.md",
      ),
      "utf-8",
    );
    const expected = [
      ["Construction Bolt gates", "construction"],
      ["Within-Bolt Question Collection", "construction"],
      ["Multi-agent stages (ensemble topologies)", "ensemble"],
      ["Subagent Return Summary", "ensemble"],
      ["12a. Reviewer Invocation", "reviewer"],
    ] as const;
    for (const [heading, module] of expected) {
      expect(staticProtocol).not.toContain(heading);
      const body = readFileSync(
        join(
          REPO_ROOT,
          "core",
          "aidlc-common",
          "protocols",
          `stage-protocol-${module}.md`,
        ),
        "utf-8",
      );
      expect(body).toContain(heading);
    }
  });
});
