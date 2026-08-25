// covers: core/tools/aidlc-artifact-resolution.ts
// covers: core/tools/aidlc-artifact-vocabulary.ts
// covers: core/tools/aidlc-validity.ts
// covers: function:effectivePlanAction function:usesStageLevelPerUnitArtifacts
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveArtifactInstances,
  type ArtifactRuntimeUnit,
} from "../../core/tools/aidlc-artifact-resolution.ts";
import { artifactFilename } from "../../core/tools/aidlc-artifact-vocabulary.ts";
import { loadGraph } from "../../core/tools/aidlc-graph.ts";
import { producesArtifactFile } from "../../core/tools/aidlc-lib.ts";
import {
  captureStageValidationBasis,
  diffStageValidationBasis,
  inspectStageValidity,
  latestCompletionBasesFromAudit,
  parseStageValidationBasis,
  propagateStageInvalidation,
  stageValidationAuditFields,
  VALIDATION_BASIS_FIELD,
  VALIDATION_WARNING_FIELD,
  type ArtifactBasis,
  type StageValidationBasis,
  type StageValidityNode,
} from "../../core/tools/aidlc-validity.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LIVE_STAGE_GRAPH = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "data",
  "stage-graph.json",
);

// Authored core/ deliberately contains no compiled graph data. The package
// step emits the live graph only into dist/<harness>/<harnessDir>/tools/data.
// loadGraph() reads AIDLC_STAGE_GRAPH at call time, so pin these compatibility
// assertions to the generated Claude graph used as the canonical test seed.
process.env.AIDLC_STAGE_GRAPH = LIVE_STAGE_GRAPH;

const SEP = "\u2014";
const INTENT = "demo-12345678";
const roots: string[] = [];
const runtimeUnits: ArtifactRuntimeUnit[] = [
  { name: "payments-api", kind: "service" },
  { name: "payments-lib", kind: "library" },
];

const graph: StageValidityNode[] = [
  {
    slug: "requirements-analysis",
    phase: "inception",
    produces: ["requirements"],
    consumes: [],
  },
  {
    slug: "security-design",
    phase: "inception",
    produces: [],
    optional_produces: ["threat-model"],
    consumes: [],
  },
  {
    slug: "code-generation",
    phase: "construction",
    for_each: "unit-of-work",
    consumes: [
      { artifact: "requirements", required: true },
      { artifact: "threat-model", required: false },
    ],
    produces: ["code-summary"],
  },
  {
    slug: "build-and-test",
    phase: "construction",
    consumes: [{ artifact: "code-summary", required: true }],
    produces: ["build-test-results"],
  },
  {
    slug: "unrelated-stage",
    phase: "operation",
    consumes: [],
    produces: ["operations-note"],
  },
];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-validity-v2-"));
  roots.push(root);
  return root;
}

function intentRecord(projectDir: string): string {
  return join(projectDir, "aidlc", "spaces", "default", "intents", INTENT);
}

function stateContent(
  completed = graph.map((stage) => stage.slug),
  scope = "classic",
): string {
  const completedSet = new Set(completed);
  const rows = graph.map((stage) => {
    const marker = completedSet.has(stage.slug) ? "x" : " ";
    return `- [${marker}] ${stage.slug} ${SEP} EXECUTE`;
  });
  return `# AI-DLC State Tracking

## Runtime State
- **Project Type**: greenfield
- **Scope**: ${scope}

## Stage Progress
${rows.join("\n")}

## Current Status
- **Current Stage**: build-and-test
`;
}

function initializeProject(projectDir: string, state = stateContent()): string {
  const record = intentRecord(projectDir);
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), state);
  const intents = join(projectDir, "aidlc", "spaces", "default", "intents");
  writeFileSync(join(intents, "active-intent"), `${INTENT}\n`);
  return record;
}

function writeArtifact(
  record: string,
  phase: string,
  stage: string,
  artifactFile: string,
  content: string,
): string {
  const dir = join(record, phase, stage);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, artifactFile);
  writeFileSync(path, content);
  return path;
}

function writeUnitArtifact(
  record: string,
  unit: string,
  stage: string,
  artifactFile: string,
  content: string,
): string {
  return writeArtifact(
    record,
    join("construction", unit),
    stage,
    artifactFile,
    content,
  );
}

function writeGraphArtifacts(record: string, includeThreatModel = false): void {
  writeArtifact(
    record,
    "inception",
    "requirements-analysis",
    "requirements.md",
    "requirements-v1\n",
  );
  if (includeThreatModel) {
    writeArtifact(
      record,
      "inception",
      "security-design",
      "threat-model.md",
      "threat-v1\n",
    );
  }
  for (const unit of runtimeUnits) {
    writeUnitArtifact(
      record,
      unit.name,
      "code-generation",
      "code-summary.md",
      `code-${unit.name}-v1\n`,
    );
  }
  writeArtifact(
    record,
    "construction",
    "build-and-test",
    "test-results.md",
    "tests-v1\n",
  );
  writeArtifact(
    record,
    "operation",
    "unrelated-stage",
    "operations-note.md",
    "ops-v1\n",
  );
}

function auditEvent(
  event: string,
  timestamp: string,
  fields: Record<string, string> = {},
): string {
  const lines = [`**Event**: ${event}`, `**Timestamp**: ${timestamp}`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`**${key}**: ${value}`);
  }
  return lines.join("\n");
}

function completionAudit(
  projectDir: string,
  state: string,
  stages: readonly StageValidityNode[],
): string {
  const blocks = [
    auditEvent("WORKFLOW_STARTED", "2026-08-05T00:00:00.000Z"),
  ];
  stages.forEach((stage, index) => {
    const second = String(index + 1).padStart(2, "0");
    blocks.push(
      auditEvent("STAGE_STARTED", `2026-08-05T00:00:${second}.000Z`, {
        Stage: stage.slug,
      }),
    );
    blocks.push(
      auditEvent("STAGE_COMPLETED", `2026-08-05T00:01:${second}.000Z`, {
        Stage: stage.slug,
        ...stageValidationAuditFields(projectDir, stage, state, stages, {
          resolution: { runtimeUnits },
        }),
      }),
    );
  });
  return blocks.join("\n---\n");
}

function artifactBasis(
  overrides: Partial<ArtifactBasis> = {},
): ArtifactBasis {
  return {
    artifact: "requirements",
    producer: "requirements-analysis",
    required: true,
    instanceCount: 1,
    presentCount: 1,
    structureHash: "sha256:structure",
    contentHash: "sha256:content",
    ...overrides,
  };
}

function basis(
  overrides: Partial<StageValidationBasis> = {},
): StageValidationBasis {
  return {
    schema: 3,
    graphContract: "sha256:contract",
    projectType: "greenfield",
    inputs: [artifactBasis()],
    outputs: [
      artifactBasis({
        artifact: "application-design",
        producer: "application-design",
      }),
    ],
    ...overrides,
  };
}

function observedBases(
  includeThreatModel: boolean,
): Map<string, StageValidationBasis> {
  const requirements = basis({
    inputs: [],
    outputs: [artifactBasis()],
  });
  const security = basis({
    inputs: [],
    outputs: includeThreatModel
      ? [
          artifactBasis({
            artifact: "threat-model",
            producer: "security-design",
            required: false,
          }),
        ]
      : [],
  });
  const code = basis({
    inputs: [
      artifactBasis(),
      ...(includeThreatModel
        ? [
            artifactBasis({
              artifact: "threat-model",
              producer: "security-design",
              required: false,
            }),
          ]
        : []),
    ],
    outputs: [
      artifactBasis({
        artifact: "code-summary",
        producer: "code-generation",
        instanceCount: runtimeUnits.length,
        presentCount: runtimeUnits.length,
        structureHash: "sha256:code-structure",
        contentHash: "sha256:code-content",
      }),
    ],
  });
  const build = basis({
    inputs: [
      artifactBasis({
        artifact: "code-summary",
        producer: "code-generation",
        instanceCount: runtimeUnits.length,
        presentCount: runtimeUnits.length,
        structureHash: "sha256:code-structure",
        contentHash: "sha256:code-content",
      }),
    ],
    outputs: [
      artifactBasis({
        artifact: "build-test-results",
        producer: "build-and-test",
      }),
    ],
  });
  return new Map([
    ["requirements-analysis", requirements],
    ["security-design", security],
    ["code-generation", code],
    ["build-and-test", build],
  ]);
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("v2 stage-graph compatibility", () => {
  test("loads the live graph contracts exercised by the validity projection", () => {
    const live = loadGraph();
    const code = live.find((stage) => stage.slug === "code-generation");
    const build = live.find((stage) => stage.slug === "build-and-test");

    expect(code?.for_each).toBe("unit-of-work");
    expect(code?.produces).toContain("code-summary");
    expect(build?.produces).toContain("build-test-results");
    expect(
      build?.consumes?.some((consume) => consume.artifact === "code-summary"),
    ).toBe(true);
  });

  test("maps collision-safe canonical names to their physical filename", () => {
    expect(artifactFilename("build-test-results")).toBe("test-results.md");
    expect(artifactFilename("load-test-results")).toBe("test-results.md");
    expect(artifactFilename("requirements")).toBe("requirements.md");
  });

  test("resolves build-test-results under test-results.md", () => {
    const projectDir = tempProject();
    initializeProject(projectDir);
    const build = graph.find((stage) => stage.slug === "build-and-test");
    if (!build) throw new Error("fixture missing build-and-test");

    const instances = resolveArtifactInstances(
      projectDir,
      "build-test-results",
      build,
    );
    expect(instances).toHaveLength(1);
    expect(instances[0].relativePath.endsWith("/build-and-test/test-results.md"))
      .toBe(true);
  });

  test("uses the canonical alias in review-artifact matching", () => {
    const stage = {
      slug: "build-and-test",
      produces: ["build-test-results"],
    };
    expect(
      producesArtifactFile(
        stage,
        "aidlc/construction/build-and-test/test-results.md",
        new Set(),
      ),
    ).toBe(true);
    expect(
      producesArtifactFile(
        stage,
        "aidlc/construction/build-and-test/build-test-results.md",
        new Set(),
      ),
    ).toBe(false);
  });

  test("expands per-unit artifacts from runtime units and produces_kinds", () => {
    const projectDir = tempProject();
    initializeProject(projectDir);
    const owner: StageValidityNode = {
      slug: "kind-aware-stage",
      phase: "construction",
      for_each: "unit-of-work",
      produces: ["service-contract"],
      produces_kinds: { "service-contract": ["service"] },
    };

    const instances = resolveArtifactInstances(
      projectDir,
      "service-contract",
      owner,
      { runtimeUnits },
    );
    expect(instances.map((instance) => instance.unit)).toEqual([
      "payments-api",
    ]);
  });

  test("resolves an express per-unit output as one stage-level fingerprint", () => {
    const projectDir = tempProject();
    const state = stateContent(["code-generation"], "express");
    const record = initializeProject(projectDir, state);
    const code = graph.find((stage) => stage.slug === "code-generation");
    if (!code) throw new Error("fixture missing code-generation");
    writeArtifact(
      record,
      "construction",
      "code-generation",
      "code-summary.md",
      "stage-level-v1\n",
    );

    const instances = resolveArtifactInstances(
      projectDir,
      "code-summary",
      code,
      { runtimeUnits, stateContent: state },
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      unit: null,
      unitKind: null,
    });
    expect(instances[0].relativePath.endsWith(
      "/construction/code-generation/code-summary.md",
    )).toBe(true);

    const captured = captureStageValidationBasis(
      projectDir,
      code,
      state,
      graph,
    );
    expect(captured.outputs).toEqual([
      expect.objectContaining({
        artifact: "code-summary",
        instanceCount: 1,
        presentCount: 1,
      }),
    ]);
  });

  test("ignores stale per-unit directories for an express stage-level owner", () => {
    const projectDir = tempProject();
    const state = stateContent(["code-generation"], "express");
    const record = initializeProject(projectDir, state);
    const code = graph.find((stage) => stage.slug === "code-generation");
    if (!code) throw new Error("fixture missing code-generation");
    writeArtifact(
      record,
      "construction",
      "code-generation",
      "code-summary.md",
      "stage-level-v1\n",
    );
    writeUnitArtifact(
      record,
      "stale-unit",
      "code-generation",
      "code-summary.md",
      "stale-unit-v1\n",
    );
    writeArtifact(
      record,
      "inception",
      "units-generation",
      "unit-of-work-dependency.md",
      "not a valid unit dag\n",
    );

    const instances = resolveArtifactInstances(
      projectDir,
      "code-summary",
      code,
      { stateContent: state },
    );
    expect(instances).toHaveLength(1);
    expect(instances[0].unit).toBeNull();
    expect(instances[0].relativePath).not.toContain("stale-unit");
  });

  test("falls back to existing per-unit stage directories only when no DAG exists", () => {
    const projectDir = tempProject();
    const record = initializeProject(projectDir);
    writeUnitArtifact(
      record,
      "legacy-unit",
      "legacy-stage",
      "legacy-note.md",
      "legacy\n",
    );
    const owner: StageValidityNode = {
      slug: "legacy-stage",
      phase: "construction",
      for_each: "unit-of-work",
      produces: ["legacy-note"],
    };

    const instances = resolveArtifactInstances(
      projectDir,
      "legacy-note",
      owner,
    );
    expect(
      instances.map((instance) => [instance.unit, instance.unitKind]),
    ).toEqual([["legacy-unit", null]]);
  });

  test("fails closed when the authored Bolt DAG is malformed", () => {
    const projectDir = tempProject();
    const record = initializeProject(projectDir);
    writeArtifact(
      record,
      "inception",
      "units-generation",
      "unit-of-work-dependency.md",
      "```yaml\nunits:\n  - name: api\n    kind: invalid-kind\n    depends_on: []\n```\n",
    );
    const owner: StageValidityNode = {
      slug: "malformed-stage",
      phase: "construction",
      for_each: "unit-of-work",
      produces: ["malformed-note"],
    };

    expect(() =>
      resolveArtifactInstances(projectDir, "malformed-note", owner),
    ).toThrow("Cannot resolve per-unit artifacts");
  });

  test("uses the active runtime-graph Bolt DAG when no override is supplied", () => {
    const projectDir = tempProject();
    const record = initializeProject(projectDir);
    writeFileSync(
      join(record, "runtime-graph.json"),
      JSON.stringify({
        bolt_dag: {
          batches: [["payments-api"], ["payments-lib"]],
          units: [
            { name: "payments-api", kind: "service" },
            { name: "payments-lib", kind: "library" },
          ],
        },
      }),
    );
    const owner: StageValidityNode = {
      slug: "runtime-stage",
      phase: "construction",
      for_each: "unit-of-work",
      produces: ["runtime-note"],
    };

    const instances = resolveArtifactInstances(
      projectDir,
      "runtime-note",
      owner,
    );
    expect(
      instances.map((instance) => [instance.unit, instance.unitKind]),
    ).toEqual([
      ["payments-api", "service"],
      ["payments-lib", "library"],
    ]);
  });

  test("applies a live v2 produces_kinds contract to runtime units", () => {
    const live = loadGraph();
    const unitKinds = ["service", "spec", "ui", "packaging", "library"];
    const selected = live
      .filter(
        (stage) =>
          stage.for_each === "unit-of-work" &&
          stage.produces_kinds !== undefined,
      )
      .flatMap((stage) =>
        Object.entries(stage.produces_kinds ?? {}).map(([artifact, kinds]) => ({
          stage,
          artifact,
          kinds,
        })),
      )
      .find(({ kinds }) => kinds.length > 0 && kinds.length < unitKinds.length);
    if (!selected) {
      throw new Error(
        "live v2 graph has no selective produces_kinds contract to test",
      );
    }
    const allowed = selected.kinds[0];
    const disallowed = unitKinds.find(
      (kind) => !selected.kinds.includes(kind),
    );
    if (!allowed || !disallowed) {
      throw new Error("could not derive allowed/disallowed unit kinds");
    }
    const projectDir = tempProject();
    initializeProject(projectDir);

    const instances = resolveArtifactInstances(
      projectDir,
      selected.artifact,
      selected.stage,
      {
        runtimeUnits: [
          { name: "allowed-unit", kind: allowed },
          { name: "disallowed-unit", kind: disallowed },
        ],
      },
    );
    expect(instances.map((instance) => instance.unit)).toEqual([
      "allowed-unit",
    ]);
  });
});

describe("schema-3 validation basis", () => {
  test("parses schema 3 and deliberately fails open on earlier schemas", () => {
    expect(parseStageValidationBasis(JSON.stringify(basis()))).toEqual(basis());
    for (const schema of [1, 2]) {
      expect(
        parseStageValidationBasis(
          JSON.stringify({
            schema,
            graphContract: "sha256:old",
            projectType: "greenfield",
            inputs: [],
            outputs: [],
          }),
        ),
      ).toBeNull();
    }
  });

  test("reports graph, project-type, aggregate input, and output drift", () => {
    const before = basis();
    const after = basis({
      graphContract: "sha256:new-contract",
      projectType: "brownfield",
      inputs: [artifactBasis({ contentHash: "sha256:new-input" })],
      outputs: [],
    });

    expect(diffStageValidationBasis(before, after)).toEqual([
      "graph-contract",
      "project-type",
      expect.stringContaining("input:requirements"),
      expect.stringContaining("output:application-design"),
    ]);
  });

  test("aggregates concrete per-unit inputs at stage granularity", () => {
    const projectDir = tempProject();
    const state = stateContent();
    const record = initializeProject(projectDir, state);
    writeGraphArtifacts(record);
    const build = graph.find((stage) => stage.slug === "build-and-test");
    if (!build) throw new Error("fixture missing build-and-test");

    const captured = captureStageValidationBasis(
      projectDir,
      build,
      state,
      graph,
      { resolution: { runtimeUnits } },
    );
    expect(captured.inputs).toHaveLength(1);
    expect(captured.inputs[0]).toMatchObject({
      artifact: "code-summary",
      producer: "code-generation",
      instanceCount: 2,
      presentCount: 2,
    });
    expect(captured.outputs[0]).toMatchObject({
      artifact: "build-test-results",
      producer: "build-and-test",
      instanceCount: 1,
      presentCount: 1,
    });
    expect("path" in captured.inputs[0]).toBe(false);
    expect("unit" in captured.inputs[0]).toBe(false);
  });

  test("separates runtime structure drift from content drift", () => {
    const projectDir = tempProject();
    const state = stateContent();
    const record = initializeProject(projectDir, state);
    writeGraphArtifacts(record);
    const build = graph.find((stage) => stage.slug === "build-and-test");
    if (!build) throw new Error("fixture missing build-and-test");

    const before = captureStageValidationBasis(
      projectDir,
      build,
      state,
      graph,
      { resolution: { runtimeUnits } },
    ).inputs[0];
    writeUnitArtifact(
      record,
      "payments-api",
      "code-generation",
      "code-summary.md",
      "code-payments-api-v2\n",
    );
    const contentChanged = captureStageValidationBasis(
      projectDir,
      build,
      state,
      graph,
      { resolution: { runtimeUnits } },
    ).inputs[0];
    const expanded = captureStageValidationBasis(
      projectDir,
      build,
      state,
      graph,
      {
        resolution: {
          runtimeUnits: [
            ...runtimeUnits,
            { name: "payments-worker", kind: "service" },
          ],
        },
      },
    ).inputs[0];

    expect(contentChanged.structureHash).toBe(before.structureHash);
    expect(contentChanged.contentHash).not.toBe(before.contentHash);
    expect(expanded.structureHash).not.toBe(before.structureHash);
    expect(expanded.instanceCount).toBe(3);
  });

  test("records only optional inputs that were actually present", () => {
    const projectDir = tempProject();
    const state = stateContent();
    const record = initializeProject(projectDir, state);
    writeGraphArtifacts(record, false);
    const code = graph.find((stage) => stage.slug === "code-generation");
    if (!code) throw new Error("fixture missing code-generation");

    const absent = captureStageValidationBasis(
      projectDir,
      code,
      state,
      graph,
      { resolution: { runtimeUnits } },
    );
    expect(absent.inputs.some((input) => input.artifact === "threat-model"))
      .toBe(false);

    writeArtifact(
      record,
      "inception",
      "security-design",
      "threat-model.md",
      "threat-v1\n",
    );
    const present = captureStageValidationBasis(
      projectDir,
      code,
      state,
      graph,
      { resolution: { runtimeUnits } },
    );
    expect(present.inputs.some((input) => input.artifact === "threat-model"))
      .toBe(true);
  });

  test("skips a legal optional consume with no producer", () => {
    const projectDir = tempProject();
    const state = stateContent(["plugin-consumer"]);
    initializeProject(projectDir, state);
    const consumer: StageValidityNode = {
      slug: "plugin-consumer",
      phase: "inception",
      consumes: [{ artifact: "optional-plugin-output", required: false }],
      produces: [],
    };

    expect(
      captureStageValidationBasis(
        projectDir,
        consumer,
        state,
        [consumer],
      ).inputs,
    ).toEqual([]);
  });

  test("keeps required missing and ambiguous optional producers strict", () => {
    const projectDir = tempProject();
    const state = stateContent(["consumer"]);
    initializeProject(projectDir, state);
    const requiredConsumer: StageValidityNode = {
      slug: "consumer",
      phase: "inception",
      consumes: [{ artifact: "missing", required: true }],
      produces: [],
    };
    expect(() =>
      captureStageValidationBasis(
        projectDir,
        requiredConsumer,
        state,
        [requiredConsumer],
      ),
    ).toThrow("found 0");

    const optionalConsumer: StageValidityNode = {
      ...requiredConsumer,
      consumes: [{ artifact: "duplicate", required: false }],
    };
    const producers: StageValidityNode[] = [
      { slug: "one", phase: "inception", produces: ["duplicate"] },
      { slug: "two", phase: "inception", produces: ["duplicate"] },
      optionalConsumer,
    ];
    expect(() =>
      captureStageValidationBasis(
        projectDir,
        optionalConsumer,
        state,
        producers,
      ),
    ).toThrow("found 2");
  });

  test("lifecycle capture fails open with a persistent warning", () => {
    const projectDir = tempProject();
    const state = stateContent(["consumer"]);
    initializeProject(projectDir, state);
    const consumer: StageValidityNode = {
      slug: "consumer",
      phase: "inception",
      consumes: [{ artifact: "missing", required: true }],
      produces: [],
    };

    const fields = stageValidationAuditFields(
      projectDir,
      consumer,
      state,
      [consumer],
    );
    expect(fields[VALIDATION_BASIS_FIELD]).toBeUndefined();
    expect(fields[VALIDATION_WARNING_FIELD]).toContain(
      "Validity receipt omitted",
    );
  });

  test("a later STAGE_STARTED clears current tracking without erasing old dependency evidence", () => {
    const tracked = JSON.stringify(basis());
    const audit = [
      auditEvent("WORKFLOW_STARTED", "2026-08-05T00:00:00.000Z"),
      auditEvent("STAGE_COMPLETED", "2026-08-05T00:00:01.000Z", {
        Stage: "code-generation",
        "Validation Basis": tracked,
      }),
      auditEvent("STAGE_STARTED", "2026-08-05T00:00:02.000Z", {
        Stage: "code-generation",
      }),
    ].join("\n---\n");

    expect(latestCompletionBasesFromAudit(audit).has("code-generation")).toBe(
      false,
    );
  });
});

describe("observed stage-level stale propagation", () => {
  test("propagates through inputs recorded by completed consumers", () => {
    const issues = propagateStageInvalidation(
      graph,
      new Set(graph.map((stage) => stage.slug)),
      new Map([["requirements-analysis", ["output:requirements"]]]),
      observedBases(false),
    );

    expect(issues.map((issue) => [issue.stage, issue.status])).toEqual([
      ["requirements-analysis", "stale"],
      ["code-generation", "needs-revalidation"],
      ["build-and-test", "needs-revalidation"],
    ]);
  });

  test("does not propagate through a declared but absent optional consume", () => {
    const issues = propagateStageInvalidation(
      graph,
      new Set(graph.map((stage) => stage.slug)),
      new Map([["security-design", ["output:threat-model"]]]),
      observedBases(false),
    );

    expect(issues.map((issue) => issue.stage)).toEqual(["security-design"]);
  });

  test("does propagate through an optional consume that was present", () => {
    const issues = propagateStageInvalidation(
      graph,
      new Set(graph.map((stage) => stage.slug)),
      new Map([["security-design", ["output:threat-model"]]]),
      observedBases(true),
    );

    expect(issues.map((issue) => [issue.stage, issue.status])).toEqual([
      ["security-design", "stale"],
      ["code-generation", "needs-revalidation"],
      ["build-and-test", "needs-revalidation"],
    ]);
  });

  test("reopened stale roots still invalidate later completed consumers", () => {
    const issues = propagateStageInvalidation(
      graph,
      new Set(["build-and-test"]),
      new Map([["code-generation", ["output:code-summary"]]]),
      observedBases(false),
    );

    expect(issues.map((issue) => [issue.stage, issue.status])).toEqual([
      ["build-and-test", "needs-revalidation"],
    ]);
  });

  test("terminates on observed dependency cycles", () => {
    const cyclic: StageValidityNode[] = [
      { slug: "a", phase: "inception", produces: ["a-out"] },
      { slug: "b", phase: "inception", produces: ["b-out"] },
    ];
    const bases = new Map<string, StageValidationBasis>([
      [
        "a",
        basis({
          inputs: [
            artifactBasis({ artifact: "b-out", producer: "b" }),
          ],
          outputs: [],
        }),
      ],
      [
        "b",
        basis({
          inputs: [
            artifactBasis({ artifact: "a-out", producer: "a" }),
          ],
          outputs: [],
        }),
      ],
    ]);
    const issues = propagateStageInvalidation(
      cyclic,
      new Set(["a", "b"]),
      new Map([["a", ["output:a-out"]]]),
      bases,
    );
    expect(issues.map((issue) => issue.stage)).toEqual(["a", "b"]);
  });
});

describe("read-only inspection", () => {
  test("detects direct drift in an express stage-level artifact", () => {
    const projectDir = tempProject();
    const state = stateContent(["code-generation"], "express");
    const record = initializeProject(projectDir, state);
    const code = graph.find((stage) => stage.slug === "code-generation");
    if (!code) throw new Error("fixture missing code-generation");
    writeArtifact(
      record,
      "inception",
      "requirements-analysis",
      "requirements.md",
      "requirements-v1\n",
    );
    const output = writeArtifact(
      record,
      "construction",
      "code-generation",
      "code-summary.md",
      "stage-level-v1\n",
    );
    const fields = stageValidationAuditFields(
      projectDir,
      code,
      state,
      graph,
    );
    expect(fields[VALIDATION_WARNING_FIELD]).toBeUndefined();
    const audit = [
      auditEvent("WORKFLOW_STARTED", "2026-08-23T00:00:00.000Z"),
      auditEvent("STAGE_COMPLETED", "2026-08-23T00:00:01.000Z", {
        Stage: code.slug,
        ...fields,
      }),
    ].join("\n---\n");

    writeFileSync(output, "stage-level-v2\n");
    const result = inspectStageValidity(projectDir, state, {
      stages: graph,
      audit,
    });

    expect(result.issues).toEqual([
      expect.objectContaining({
        stage: "code-generation",
        status: "stale",
        direct: true,
        reasons: [expect.stringContaining("output:code-summary")],
      }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("detects direct artifact drift and transitive revalidation", () => {
    const projectDir = tempProject();
    const state = stateContent();
    const record = initializeProject(projectDir, state);
    writeGraphArtifacts(record);
    const audit = completionAudit(projectDir, state, graph);

    writeFileSync(
      join(
        record,
        "inception",
        "requirements-analysis",
        "requirements.md",
      ),
      "requirements-v2\n",
    );

    const result = inspectStageValidity(projectDir, state, {
      stages: graph,
      audit,
      currentBasis: (stage, stages) =>
        captureStageValidationBasis(projectDir, stage, state, stages, {
          resolution: { runtimeUnits },
        }),
    });

    expect(result.issues.map((issue) => [issue.stage, issue.status])).toEqual([
      ["requirements-analysis", "stale"],
      ["code-generation", "stale"],
      ["build-and-test", "needs-revalidation"],
    ]);
    expect(result.untracked).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("schema-2 and receipt-less completions remain untracked and fail open", () => {
    const legacyAudit = [
      auditEvent("WORKFLOW_STARTED", "2026-08-05T00:00:00.000Z"),
      auditEvent("STAGE_COMPLETED", "2026-08-05T00:00:01.000Z", {
        Stage: "requirements-analysis",
        "Validation Basis": JSON.stringify({
          ...basis({
            outputs: [],
          }),
          schema: 2,
        }),
      }),
    ].join("\n---\n");
    const result = inspectStageValidity(
      tempProject(),
      stateContent(["requirements-analysis"]),
      {
        stages: graph,
        audit: legacyAudit,
        currentBasis: () => basis(),
      },
    );
    expect(result.issues).toEqual([]);
    expect(result.untracked).toEqual(["requirements-analysis"]);
    expect(result.warnings).toEqual([]);
  });

  test("an unavailable recapture is untracked and non-blocking", () => {
    const tracked = JSON.stringify(basis());
    const audit = [
      auditEvent("WORKFLOW_STARTED", "2026-08-05T00:00:00.000Z"),
      auditEvent("STAGE_COMPLETED", "2026-08-05T00:00:01.000Z", {
        Stage: "requirements-analysis",
        [VALIDATION_BASIS_FIELD]: tracked,
      }),
    ].join("\n---\n");
    const result = inspectStageValidity(
      tempProject(),
      stateContent(["requirements-analysis"]),
      {
        stages: graph,
        audit,
        currentBasis: () => {
          throw new Error("fixture recapture failure");
        },
      },
    );
    expect(result.issues).toEqual([]);
    expect(result.untracked).toEqual(["requirements-analysis"]);
    expect(result.warnings).toEqual([
      expect.stringContaining("fixture recapture failure"),
    ]);
  });
});
