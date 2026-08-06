// covers: subcommand:aidlc-orchestrate:next, function:validateDirective,
// file:aidlc-common/protocols/stage-protocol.md §3 §5,
// file:skills/aidlc/SKILL.md per-unit wave paragraph
//
// t249 - engine-emitted, receipt-settled waves for stage-major per-unit design.
// The engine derives complete sibling entries from one healed Bolt-DAG snapshot,
// keeps a batch active until every applicable unit has fresh review evidence,
// and transports the optional wave through the existing steering boundary.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;
const SEP = "\u2014";
const REQUIRED_FD = [
  "business-logic-model",
  "business-rules",
  "domain-entities",
];
interface WaveEntry {
  unit: string;
  unit_kind: string | null;
  build_required: boolean;
  review_state:
    | "outstanding"
    | "repair-required"
    | "READY"
    | "NOT-READY"
    | "not-required";
  review_iteration: number | null;
  unit_memory_path: string;
  consumes: string[];
  consumes_absent: Array<{ path: string; expected: boolean }>;
  produces: string[];
  required_produces: string[];
}

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  memory_path?: string;
  inline_context_paths?: string[];
  context_warnings?: string[];
  rules_in_context?: string[];
  wave?: { batch_index: number; entries: WaveEntry[] };
  message?: string;
  [key: string]: unknown;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop());
});

function row(marker: " " | "-" | "x", slug: string): string {
  return `- [${marker}] ${slug} ${SEP} EXECUTE`;
}

function constructionState(
  current: string,
  iteration: "stage-major" | "unit-major" = "stage-major",
): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: wave test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
- **Skeleton Stance**: on
- **Construction Iteration**: ${iteration}

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
${row("x", "application-design")}
${row("x", "units-generation")}

### CONSTRUCTION PHASE
${row(current === "functional-design" ? "-" : " ", "functional-design")}
${row(current === "nfr-requirements" ? "-" : " ", "nfr-requirements")}
${row(current === "nfr-design" ? "-" : " ", "nfr-design")}
${row(current === "infrastructure-design" ? "-" : " ", "infrastructure-design")}
${row(current === "code-generation" ? "-" : " ", "code-generation")}
${row(" ", "build-and-test")}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`;
}

function project(
  current = "functional-design",
  iteration: "stage-major" | "unit-major" = "stage-major",
): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), constructionState(current, iteration));
  return proj;
}

function next(proj: string) {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const result = runOrchestrateNext(ORCH, proj, [], { env });
  if (result.directive === null) {
    throw new Error(
      `next emitted no JSON: ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    ...result,
    directive: result.directive as Directive,
  };
}

function cover(
  proj: string,
  unit: string,
  stage: string,
  names: string[],
): void {
  const dir = join(seededRecordDir(proj), "construction", unit, stage);
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, `${name}.md`), `# ${name} for ${unit}\n`);
  }
}

function review(
  proj: string,
  unit: string,
  verdict: "READY" | "NOT-READY" = "READY",
  iteration = 1,
): void {
  const result = spawnSync(
    BUN,
    [
      LOG,
      "review",
      "--stage",
      "functional-design",
      "--reviewer",
      "aidlc-architecture-reviewer-agent",
      "--unit",
      unit,
      "--iteration",
      String(iteration),
      "--verdict",
      verdict,
      "--project-dir",
      proj,
    ],
    { encoding: "utf-8" },
  );
  if ((result.status ?? -1) !== 0) {
    throw new Error(`review failed: ${result.stdout}${result.stderr}`);
  }
}

function writeDependencyArtifact(
  proj: string,
  units: Array<{ name: string; kind?: string; depends_on: string[] }>,
): void {
  const dir = join(seededRecordDir(proj), "inception", "units-generation");
  mkdirSync(dir, { recursive: true });
  const lines = ["# Unit Dependency", "", "```yaml", "units:"];
  for (const unit of units) {
    lines.push(`  - name: ${unit.name}`);
    if (unit.kind) lines.push(`    kind: ${unit.kind}`);
    lines.push(
      `    depends_on: [${unit.depends_on.join(", ")}]`,
    );
  }
  lines.push("```", "");
  writeFileSync(join(dir, "unit-of-work-dependency.md"), lines.join("\n"));
}

describe("t249 engine-emitted wave contract", () => {
  test("mixed-kind entries are independently resolved and keep parent versus unit memory distinct", () => {
    const proj = project("infrastructure-design");
    const knowledgeDir = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "knowledge",
      "aidlc-aws-platform-agent",
    );
    mkdirSync(knowledgeDir, { recursive: true });
    symlinkSync(
      join(knowledgeDir, "missing-target.md"),
      join(knowledgeDir, "broken.md"),
    );
    seedBoltDag(proj, [
      { name: "api", kind: "service" },
      { name: "web", kind: "ui" },
      { name: "contract", kind: "spec" },
    ]);

    const result = next(proj);
    const directive = result.directive;
    expect(directive.kind).toBe("run-stage");
    expect(directive.stage).toBe("infrastructure-design");
    expect(directive.wave?.batch_index).toBe(0);
    expect(directive.wave?.entries.map((entry) => entry.unit)).toEqual([
      "api",
      "web",
    ]);

    const api = directive.wave?.entries[0] as WaveEntry;
    const web = directive.wave?.entries[1] as WaveEntry;
    expect(api.unit_kind).toBe("service");
    expect(api.required_produces).toHaveLength(4);
    expect(
      api.required_produces.every((path) =>
        path.includes("/construction/api/infrastructure-design/")
      ),
    ).toBe(true);
    expect(web.unit_kind).toBe("ui");
    expect(web.required_produces).toEqual([
      `${RP}/construction/web/infrastructure-design/deployment-architecture.md`,
      `${RP}/construction/web/infrastructure-design/cicd-pipeline.md`,
    ]);
    expect(web.produces).toContain(
      `${RP}/construction/web/infrastructure-design/shared-infrastructure.md`,
    );
    expect(web.required_produces).not.toContain(
      `${RP}/construction/web/infrastructure-design/shared-infrastructure.md`,
    );
    expect(api.consumes_absent).toBeArray();
    expect(web.consumes_absent).toBeArray();
    expect(directive.memory_path).toBe(
      `${RP}/construction/infrastructure-design/memory.md`,
    );
    expect(api.unit_memory_path).toBe(
      `${RP}/construction/api/infrastructure-design/memory.md`,
    );
    expect(web.unit_memory_path).toBe(
      `${RP}/construction/web/infrastructure-design/memory.md`,
    );

    expect(result.steering.length).toBeGreaterThan(0);
    expect(directive.rules_in_context?.length ?? 0).toBeGreaterThan(0);
    expect(directive.inline_context_paths?.length ?? 0).toBeGreaterThan(0);
    const deliveredRulePaths = [
      ...new Set(
        result.steering.flatMap((part) =>
          (
            part.rules_content as Array<{ path: string; text: string }>
          ).map((entry) => entry.path)
        ),
      ),
    ];
    expect(deliveredRulePaths).toEqual(directive.rules_in_context ?? []);
    expect(directive.context_warnings?.join("\n")).toContain(
      "aidlc-aws-platform-agent/broken.md",
    );
  }, 30000);

  test("downstream consumes omit artifacts pruned by the producer for this unit kind", () => {
    const proj = project("nfr-design");
    seedBoltDag(proj, [{ name: "contract", kind: "spec" }]);

    const entry = next(proj).directive.wave?.entries[0] as WaveEntry;
    const consumePaths = [
      ...entry.consumes,
      ...entry.consumes_absent.map((item) => item.path),
    ];
    for (const pruned of [
      "performance-requirements",
      "scalability-requirements",
      "reliability-requirements",
      "business-logic-model",
    ]) {
      expect(consumePaths.some((path) => path.endsWith(`/${pruned}.md`))).toBe(
        false,
      );
    }
    expect(consumePaths).toContain(
      `${RP}/construction/contract/nfr-requirements/security-requirements.md`,
    );
    expect(consumePaths).toContain(
      `${RP}/construction/contract/nfr-requirements/tech-stack-decisions.md`,
    );
    expect(entry.required_produces).toEqual([
      `${RP}/construction/contract/nfr-design/security-design.md`,
    ]);
  }, 30000);

  test("wave membership comes from the healed authored DAG, never the stale cache", () => {
    const proj = project();
    seedBoltDag(
      proj,
      [
        { name: "alpha", kind: "service" },
        { name: "beta", kind: "service" },
      ],
      [["alpha", "beta"]],
    );
    writeDependencyArtifact(proj, [
      { name: "alpha", kind: "service", depends_on: [] },
      { name: "beta", kind: "service", depends_on: ["alpha"] },
    ]);

    const result = next(proj);
    expect(result.directive.wave?.batch_index).toBe(0);
    expect(result.directive.wave?.entries.map((entry) => entry.unit)).toEqual([
      "alpha",
    ]);
    expect(result.stderr).toContain("bolt_dag is missing or stale");
  }, 30000);

  test("dependent batches wait for fresh terminal receipts, including NOT-READY at cap", () => {
    const proj = project();
    seedBoltDag(
      proj,
      ["alpha", "beta"],
      [["alpha"], ["beta"]],
    );
    cover(proj, "alpha", "functional-design", REQUIRED_FD);

    const alphaReview = next(proj).directive;
    expect(alphaReview.unit).toBe("alpha");
    expect(alphaReview.gate).toBe(false);
    expect(alphaReview.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      build_required: false,
      review_state: "outstanding",
    });

    review(proj, "alpha");
    const betaBuild = next(proj).directive;
    expect(betaBuild.unit).toBe("beta");
    expect(betaBuild.wave?.batch_index).toBe(1);
    expect(betaBuild.wave?.entries[0].build_required).toBe(true);

    cover(proj, "beta", "functional-design", REQUIRED_FD);
    const betaReview = next(proj).directive;
    expect(betaReview.unit).toBe("beta");
    expect(betaReview.gate).toBe(false);
    expect(betaReview.wave?.entries[0]).toMatchObject({
      build_required: false,
      review_state: "outstanding",
    });

    review(proj, "beta", "NOT-READY", 1);
    const repair = next(proj).directive;
    expect(repair.unit).toBe("beta");
    expect(repair.gate).toBe(false);
    expect(repair.wave?.entries[0]).toMatchObject({
      review_state: "repair-required",
      review_iteration: 1,
    });

    writeFileSync(
      join(
        seededRecordDir(proj),
        "construction",
        "beta",
        "functional-design",
        "business-logic-model.md",
      ),
      "# repaired after iteration 1\n",
    );
    const reReview = next(proj).directive;
    expect(reReview.wave?.entries[0]).toMatchObject({
      review_state: "outstanding",
      review_iteration: 2,
    });

    review(proj, "beta", "NOT-READY", 2);
    const settled = next(proj).directive;
    expect(settled.unit).toBe("beta");
    expect(settled.gate).toBe(true);
    expect(settled.wave).toBeUndefined();
  }, 30000);

  test("a post-review artifact change reopens only its owning earlier batch", () => {
    const proj = project();
    seedBoltDag(
      proj,
      ["alpha", "beta"],
      [["alpha"], ["beta"]],
    );
    cover(proj, "alpha", "functional-design", REQUIRED_FD);
    cover(proj, "beta", "functional-design", REQUIRED_FD);
    review(proj, "alpha");
    review(proj, "beta");
    expect(next(proj).directive.gate).toBe(true);

    writeFileSync(
      join(
        seededRecordDir(proj),
        "construction",
        "alpha",
        "functional-design",
        "business-logic-model.md",
      ),
      "# changed after review\n",
    );
    const reopened = next(proj).directive;
    expect(reopened.wave?.batch_index).toBe(0);
    expect(reopened.wave?.entries).toHaveLength(1);
    expect(reopened.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      build_required: false,
      review_state: "outstanding",
    });
  }, 30000);

  test("fully settled siblings are omitted from a repeated same-batch wave", () => {
    const proj = project();
    seedBoltDag(proj, ["alpha", "beta"]);
    cover(proj, "alpha", "functional-design", REQUIRED_FD);
    review(proj, "alpha");

    const wave = next(proj).directive.wave;
    expect(wave?.batch_index).toBe(0);
    expect(wave?.entries.map((entry) => entry.unit)).toEqual(["beta"]);
  }, 30000);

  test("large independent batches emit deterministic same-batch prefixes below the transport cap", () => {
    const proj = project();
    const units = Array.from({ length: 100 }, (_, index) => ({
      name: `unit-${index.toString().padStart(3, "0")}`,
      kind: "service",
    }));
    seedBoltDag(proj, units);
    const result = next(proj);
    const entries = result.directive.wave?.entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(units.length);
    expect(entries[0].unit).toBe("unit-000");
    expect(result.directive.wave?.batch_index).toBe(0);
    expect(Buffer.byteLength(result.stdout.trim(), "utf-8")).toBeLessThanOrEqual(
      28 * 1024,
    );
  }, 30000);

  test("unit-major design and non-autonomous code-generation remain serial", () => {
    const unitMajor = project("functional-design", "unit-major");
    seedBoltDag(unitMajor, ["alpha", "beta"]);
    expect(next(unitMajor).directive.wave).toBeUndefined();

    const codegen = project("code-generation");
    seedBoltDag(codegen, ["alpha", "beta"]);
    const directive = next(codegen).directive;
    expect(directive.stage).toBe("code-generation");
    expect(directive.unit).toBe("alpha");
    expect(directive.wave).toBeUndefined();
  }, 30000);
});

function expectWaveProse(body: string): void {
  expect(body).toContain("**Per-unit batch waves (optional).**");
  expect(body).toContain("directive.wave");
  expect(body).toContain(
    "branch on `directive.wave` before the ordinary per-unit or gate path",
  );
  expect(body).toContain("do not execute those parent Unit fields separately");
  expect(body).toContain("engine's healed Bolt-DAG snapshot");
  expect(body).toContain("accumulated `load-steering.rules_content` bundle verbatim");
  expect(body).toContain("parent `inline_context_paths`");
  expect(body).toContain("parent `context_warnings`");
  expect(body).toContain("unit-scoped PRE-GENERATION SUMMARY STOP");
  expect(body).toContain("entry.required_produces");
  expect(body).toContain("entry.unit_memory_path");
  expect(body).toContain('review_state: "repair-required"');
  expect(body).toContain("review_iteration + 1");
  expect(body).toContain("fresh terminal `REVIEW_COMPLETED`");
  expect(body).toContain("Code-generation (`workspace_requires: true`) is NEVER wave-eligible");
  expect(body).toContain("The wave is a MAY, never a MUST");
  expect(body).not.toContain(
    "read `bolt_dag.batches` from the intent's `runtime-graph.json`",
  );
}

describe("t249 wave protocol parity", () => {
  test("authored and generated conductor skills carry the current engine contract", () => {
    for (const harness of HARNESS_MATRIX) {
      const authored = readFileSync(
        join(harness.authoredRoot, "skills", "aidlc", "SKILL.md"),
        "utf-8",
      );
      const generated = readFileSync(
        join(harness.skillsRoot, "aidlc", "SKILL.md"),
        "utf-8",
      );
      expectWaveProse(authored);
      expectWaveProse(generated);
      if (harness.capabilities.reviewerScopeRegistration === "unsupported") {
        expect(authored).toContain(
          "wave reviewers MAY run as parallel FOREGROUND dispatches",
        );
      } else {
        expect(authored).toContain(
          "per-unit reviews here serialize: write the record, review, delete, then the next unit",
        );
      }
    }
  });

  test("shared protocol carries the engine, receipt, steering, and memory invariants", () => {
    const core = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol.md",
      ),
      "utf-8",
    );
    expect(core).toContain(
      "**Per-unit batch waves (optional, stage-major only).**",
    );
    expect(core).toContain("engine emits `directive.wave`");
    expect(core).toContain(
      "branch here before the ordinary per-Unit or gate path",
    );
    expect(core).toContain("entry.required_produces");
    expect(core).toContain("entry.unit_memory_path");
    expect(core).toContain('review_state: "repair-required"');
    expect(core).toContain("unit-scoped PRE-GENERATION SUMMARY STOP");
    expect(core).toContain("fresh terminal `REVIEW_COMPLETED`");
    expect(core).toContain(
      "accumulated `load-steering.rules_content` bundle VERBATIM",
    );
    expect(core).not.toContain(
      "read `bolt_dag.batches` from the intent's `runtime-graph.json`",
    );
  });
});
