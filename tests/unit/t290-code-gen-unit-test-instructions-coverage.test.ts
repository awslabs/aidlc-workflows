// covers: subcommand:aidlc-orchestrate:next
//
// t290 - unit-test-instructions belongs to each code-generation unit. The
// engine must require it for per-unit coverage under every test strategy, and
// build-and-test must consume the artifact from a real producer.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadGraph,
  producersOf,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;
const TEST_STRATEGIES = ["Minimal", "Standard", "Comprehensive"] as const;
const CG_PRODUCES = [
  "code-generation-plan",
  "unit-test-instructions",
  "code-summary",
  "traceability",
] as const;

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  produces?: string[];
  [key: string]: unknown;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function constructionStateAtCodeGen(strategy: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: unit-test-instructions coverage test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: ${strategy}

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

### INCEPTION PHASE
- [x] domain-design — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`;
}

function seedProject(strategy: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), constructionStateAtCodeGen(strategy));
  seedBoltDag(proj, ["alpha", "beta"]);
  return proj;
}

function realisticArtifact(name: string, unit: string): string {
  if (name === "traceability") {
    return `{"stage":"code-generation","unit":"${unit}","upstream_ids":[],"coverage":[]}\n`;
  }
  if (name === "unit-test-instructions") {
    return `# Unit Test Instructions - ${unit}

## Framework Setup

Use Bun's test runner with the repository configuration.

## Run This Unit

\`bun test tests/unit/${unit}.test.ts\`

## Coverage and Test Data

Cover the unit's requirements with isolated fixtures and stub external services.
`;
  }
  if (name === "code-generation-plan") {
    return `# Code Generation Plan - ${unit}

## Implementation Steps

- [ ] Implement ${unit}.
- [ ] Add unit-scoped tests.

## Traceability

- The implementation steps cover the ${unit} requirements.
`;
  }
  return `# Code Summary - ${unit}

## Files

- Source and tests for ${unit}.

## Test Coverage

- Unit-scoped tests are present.
`;
}

function coverUnit(proj: string, unit: string, names: readonly string[]): void {
  const dir = join(seededRecordDir(proj), "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, artifactFilename(name)), realisticArtifact(name, unit));
  }
}

function runNext(proj: string): Directive {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const result = runOrchestrateNext(ORCH, proj, [], { env });
  if (result.directive === null) {
    throw new Error(
      `runNext did not emit parseable JSON. status=${result.status}\n` +
        `${result.stdout}\n${result.stderr}`,
    );
  }
  return result.directive as Directive;
}

describe("t290 code-generation coverage requires per-unit test instructions", () => {
  for (const strategy of TEST_STRATEGIES) {
    test(`${strategy}: missing unit-test-instructions re-emits the unit`, () => {
      const proj = seedProject(strategy);
      coverUnit(proj, "alpha", ["code-generation-plan", "code-summary", "traceability"]);

      const directive = runNext(proj);

      expect(directive.kind).toBe("run-stage");
      expect(directive.stage).toBe("code-generation");
      expect(directive.unit).toBe("alpha");
      expect(directive.produces).toContain(
        `${RP}/construction/alpha/code-generation/unit-test-instructions.md`,
      );
    }, 30000);

    test(`${strategy}: all four outputs advance to the next unit`, () => {
      const proj = seedProject(strategy);
      coverUnit(proj, "alpha", CG_PRODUCES);

      const directive = runNext(proj);

      expect(directive.kind).toBe("run-stage");
      expect(directive.stage).toBe("code-generation");
      expect(directive.unit).toBe("beta");
    }, 30000);
  }

  test("build-and-test requires the artifact and code-generation produces it", () => {
    const buildAndTest = loadGraph().find((stage) => stage.slug === "build-and-test");
    expect(buildAndTest).toBeDefined();
    expect(buildAndTest?.consumes).toContainEqual({
      artifact: "unit-test-instructions",
      required: true,
    });
    expect(producersOf("unit-test-instructions").map((stage) => stage.slug)).toEqual([
      "code-generation",
    ]);
  });

  test("stage prose pins unit scoping and deduplicated execution", () => {
    const codeGeneration = readFileSync(
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "stages",
        "construction",
        "code-generation.md",
      ),
      "utf-8",
    );
    const buildAndTest = readFileSync(
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "stages",
        "construction",
        "build-and-test.md",
      ),
      "utf-8",
    );

    expect(codeGeneration).toContain(
      "Every run command in this file MUST be scoped to this unit only",
    );
    expect(codeGeneration).toContain(
      "A bare project-wide command like\n`npm test` is not acceptable",
    );
    expect(buildAndTest).toContain("Deduplicate identical commands");
    expect(buildAndTest).toContain("run each distinct command ONCE");
    expect(buildAndTest).toContain("run that command\n   once, never N");
  });

  test("Express stage-level test instructions execute and traceability joins the final gate", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    const codeDir = join(seededRecordDir(proj), "construction", "code-generation");
    const sourceDir = join(proj, "src");
    mkdirSync(codeDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });

    const marker = "express-stage-level-test-ran.txt";
    const instructionsPath = join(codeDir, "unit-test-instructions.md");
    writeFileSync(
      instructionsPath,
      `# Express Unit Test Instructions

\`\`\`bash
${process.execPath} -e 'await Bun.write("${marker}", "passed")'
\`\`\`
`,
    );
    writeFileSync(join(sourceDir, "express.ts"), "export const express = true;\n");

    const traceabilityPath = join(codeDir, "traceability.json");
    writeFileSync(
      traceabilityPath,
      `${JSON.stringify({
        stage: "code-generation",
        upstream_ids: ["FR1"],
        coverage: [{ id: "FR1", status: "OK", target: "src/express.ts" }],
      }, null, 2)}\n`,
    );

    const buildAndTest = readFileSync(
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "stages",
        "construction",
        "build-and-test.md",
      ),
      "utf-8",
    );
    expect(buildAndTest).toContain(
      "<record>/construction/code-generation/unit-test-instructions.md",
    );
    expect(buildAndTest).toContain(
      "<record>/construction/*/code-generation/unit-test-instructions.md",
    );
    expect(buildAndTest).toContain(
      "<record>/construction/code-generation/traceability.json",
    );
    expect(buildAndTest).toContain(
      "<record>/construction/*/code-generation/traceability.json",
    );

    const command = readFileSync(instructionsPath, "utf-8")
      .match(/```bash\n([\s\S]*?)\n```/)?.[1]
      .trim();
    expect(command).toBeTruthy();
    const executed = spawnSync("bash", ["-lc", command!], {
      cwd: proj,
      encoding: "utf-8",
    });
    expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
    expect(readFileSync(join(proj, marker), "utf-8")).toBe("passed");

    const traceability = JSON.parse(readFileSync(traceabilityPath, "utf-8")) as {
      coverage: Array<{ id: string; status: string; target: string }>;
    };
    const fr1 = traceability.coverage.find((entry) => entry.id === "FR1");
    expect(fr1?.status).toBe("OK");
    expect(existsSync(join(proj, fr1!.target))).toBe(true);
  });
});
