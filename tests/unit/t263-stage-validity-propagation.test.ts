// covers: core/tools/aidlc-validity.ts
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
  captureStageValidationBasis,
  diffStageValidationBasis,
  fingerprintArtifactFiles,
  inspectStageValidity,
  latestCompletionBasesFromAudit,
  parseStageValidationBasis,
  propagateStageInvalidation,
  stageValidationAuditFields,
  type StageValidationBasis,
  type StageValidityNode,
} from "../../core/tools/aidlc-validity.ts";

const SEP = "\u2014";
const INTENT = "demo-12345678";
const roots: string[] = [];

const graph: StageValidityNode[] = [
  {
    slug: "requirements-analysis",
    phase: "inception",
    produces: ["requirements"],
    consumes: [],
  },
  {
    slug: "application-design",
    phase: "inception",
    consumes: [{ artifact: "requirements", required: true }],
    produces: ["application-design"],
  },
  {
    slug: "code-generation",
    phase: "construction",
    consumes: [{ artifact: "application-design", required: true }],
    produces: ["code-summary"],
  },
  {
    slug: "build-and-test",
    phase: "construction",
    consumes: [{ artifact: "code-summary", required: true }],
    produces: ["test-results"],
  },
  {
    slug: "unrelated-stage",
    phase: "operation",
    consumes: [],
    produces: ["operations-note"],
  },
];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-validity-"));
  roots.push(root);
  return root;
}

function recordDir(projectDir: string): string {
  return join(projectDir, "aidlc", "spaces", "default", "intents", INTENT);
}

function stateContent(completed = graph.map((stage) => stage.slug)): string {
  const completedSet = new Set(completed);
  const rows = graph.map((stage) => {
    const marker = completedSet.has(stage.slug) ? "x" : " ";
    return `- [${marker}] ${stage.slug} ${SEP} EXECUTE`;
  });
  return `# AI-DLC State Tracking

## Runtime State
- **Project Type**: greenfield

## Stage Progress
${rows.join("\n")}

## Current Status
- **Current Stage**: build-and-test
`;
}

function initializeProject(projectDir: string, state = stateContent()): string {
  const record = recordDir(projectDir);
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), state);
  return record;
}

function writeArtifact(
  record: string,
  phase: string,
  stage: string,
  artifact: string,
  content: string,
): string {
  const dir = join(record, phase, stage);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${artifact}.md`);
  writeFileSync(path, content);
  return path;
}

function writeGraphArtifacts(record: string): void {
  writeArtifact(
    record,
    "inception",
    "requirements-analysis",
    "requirements",
    "requirements-v1\n",
  );
  writeArtifact(
    record,
    "inception",
    "application-design",
    "application-design",
    "design-v1\n",
  );
  writeArtifact(
    record,
    "construction",
    "code-generation",
    "code-summary",
    "code-v1\n",
  );
  writeArtifact(
    record,
    "construction",
    "build-and-test",
    "test-results",
    "tests-v1\n",
  );
  writeArtifact(
    record,
    "operation",
    "unrelated-stage",
    "operations-note",
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
        ...stageValidationAuditFields(projectDir, stage, state, stages),
      }),
    );
  });
  return blocks.join("\n---\n");
}

function writeAudit(record: string, audit: string): void {
  const dir = join(record, "audit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "host-clone.md"), audit);
}

function basis(overrides: Partial<StageValidationBasis> = {}): StageValidationBasis {
  return {
    schema: 1,
    definition: "sha256:def",
    projectType: "greenfield",
    inputs: { requirements: "sha256:input" },
    outputs: { design: "sha256:output" },
    ...overrides,
  };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("stage validation basis", () => {
  test("artifact fingerprints change with content, creation, and deletion", () => {
    const projectDir = tempProject();
    const path = join(projectDir, "artifact.md");

    const missing = fingerprintArtifactFiles(projectDir, [path]);
    writeFileSync(path, "v1\n");
    const first = fingerprintArtifactFiles(projectDir, [path]);
    writeFileSync(path, "v2\n");
    const second = fingerprintArtifactFiles(projectDir, [path]);
    rmSync(path);
    const deleted = fingerprintArtifactFiles(projectDir, [path]);

    expect(first).not.toBe(missing);
    expect(second).not.toBe(first);
    expect(deleted).toBe(missing);
  });

  test("parses only the supported validation-basis schema", () => {
    const valid = JSON.stringify(basis());
    expect(parseStageValidationBasis(valid)).toEqual(basis());
    expect(
      parseStageValidationBasis(JSON.stringify({ ...basis(), schema: 2 })),
    ).toBeNull();
    expect(
      parseStageValidationBasis(JSON.stringify({ ...basis(), inputs: [] })),
    ).toBeNull();
    expect(parseStageValidationBasis("not-json")).toBeNull();
  });

  test("reports definition, project-type, input, and output drift", () => {
    const before = basis();
    const after = basis({
      definition: "sha256:new-def",
      projectType: "brownfield",
      inputs: { requirements: "sha256:new-input", extra: "sha256:extra" },
      outputs: {},
    });

    expect(diffStageValidationBasis(before, after)).toEqual([
      "stage-definition",
      "project-type",
      "input:extra",
      "input:requirements",
      "output:design",
    ]);
  });

  test("latest attempt clears old or legacy completion evidence", () => {
    const tracked = JSON.stringify(basis());
    const audit = [
      auditEvent("WORKFLOW_STARTED", "2026-08-05T00:00:00.000Z"),
      auditEvent("STAGE_COMPLETED", "2026-08-05T00:00:01.000Z", {
        Stage: "application-design",
        "Validation Basis": tracked,
      }),
      auditEvent("STAGE_STARTED", "2026-08-05T00:00:02.000Z", {
        Stage: "application-design",
      }),
      auditEvent("STAGE_COMPLETED", "2026-08-05T00:00:03.000Z", {
        Stage: "application-design",
      }),
      auditEvent("STAGE_COMPLETED", "2026-08-05T00:00:04.000Z", {
        Workflow: "single-stage:application-design",
        Stage: "application-design",
        "Validation Basis": tracked,
      }),
    ].join("\n---\n");

    expect(latestCompletionBasesFromAudit(audit).has("application-design")).toBe(
      false,
    );
  });

  test("definition fingerprint changes when the validity contract changes", () => {
    const projectDir = tempProject();
    initializeProject(projectDir);
    const first: StageValidityNode = {
      slug: "stage-a",
      phase: "inception",
      consumes: [],
      produces: [],
      workspace_requires: false,
    };
    const second: StageValidityNode = {
      ...first,
      workspace_requires: true,
    };

    const firstBasis = captureStageValidationBasis(
      projectDir,
      first,
      stateContent([]),
      [first],
    );
    const secondBasis = captureStageValidationBasis(
      projectDir,
      second,
      stateContent([]),
      [second],
    );

    expect(firstBasis.definition).not.toBe(secondBasis.definition);
  });
});

describe("stage invalidation propagation", () => {
  test("propagates only through explicit artifact consumer edges", () => {
    const issues = propagateStageInvalidation(
      graph,
      new Set(graph.map((stage) => stage.slug)),
      new Map([["requirements-analysis", ["output:requirements"]]]),
    );

    expect(issues.map((issue) => [issue.stage, issue.status])).toEqual([
      ["requirements-analysis", "stale"],
      ["application-design", "needs-revalidation"],
      ["code-generation", "needs-revalidation"],
      ["build-and-test", "needs-revalidation"],
    ]);
  });

  test("propagates through reopened intermediates to later completed consumers", () => {
    const issues = propagateStageInvalidation(
      graph,
      new Set([
        "requirements-analysis",
        "code-generation",
        "build-and-test",
      ]),
      new Map([["requirements-analysis", ["output:requirements"]]]),
    );

    expect(issues.map((issue) => [issue.stage, issue.status])).toEqual([
      ["requirements-analysis", "stale"],
      ["code-generation", "needs-revalidation"],
      ["build-and-test", "needs-revalidation"],
    ]);
  });

  test("does not propagate through an inactive conditional consume", () => {
    const conditional: StageValidityNode[] = [
      {
        slug: "brownfield-scan",
        phase: "inception",
        consumes: [],
        produces: ["code-model"],
      },
      {
        slug: "greenfield-design",
        phase: "inception",
        consumes: [
          {
            artifact: "code-model",
            required: true,
            conditional_on: "brownfield",
          },
        ],
        produces: ["design"],
      },
    ];

    const issues = propagateStageInvalidation(
      conditional,
      new Set(["brownfield-scan", "greenfield-design"]),
      new Map([["brownfield-scan", ["output:code-model"]]]),
      "greenfield",
    );

    expect(issues.map((issue) => issue.stage)).toEqual(["brownfield-scan"]);
  });

  test("does not treat requires_stage as a validity dependency", () => {
    const orderingOnly: StageValidityNode[] = [
      {
        slug: "producer",
        phase: "inception",
        consumes: [],
        produces: [],
      },
      {
        slug: "ordered-after",
        phase: "inception",
        consumes: [],
        produces: [],
        requires_stage: ["producer"],
      },
    ];

    const issues = propagateStageInvalidation(
      orderingOnly,
      new Set(["producer", "ordered-after"]),
      new Map([["producer", ["stage-definition"]]]),
    );

    expect(issues.map((issue) => issue.stage)).toEqual(["producer"]);
  });

  test("terminates and preserves the direct root when artifact edges cycle", () => {
    const cyclic: StageValidityNode[] = [
      {
        slug: "a",
        phase: "inception",
        consumes: [{ artifact: "from-b", required: true }],
        produces: ["from-a"],
      },
      {
        slug: "b",
        phase: "inception",
        consumes: [{ artifact: "from-a", required: true }],
        produces: ["from-b"],
      },
    ];

    const issues = propagateStageInvalidation(
      cyclic,
      new Set(["a", "b"]),
      new Map([["a", ["output:from-a"]]]),
    );

    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ stage: "a", direct: true });
    expect(issues[1]).toMatchObject({
      stage: "b",
      direct: false,
      roots: ["a"],
    });
  });
});

describe("workflow validity inspection", () => {
  test("detects direct drift and propagates revalidation to completed consumers", () => {
    const projectDir = tempProject();
    const state = stateContent();
    const record = initializeProject(projectDir, state);
    writeGraphArtifacts(record);
    writeAudit(record, completionAudit(projectDir, state, graph));

    writeArtifact(
      record,
      "inception",
      "requirements-analysis",
      "requirements",
      "requirements-v2\n",
    );

    const inspection = inspectStageValidity(projectDir, state, { stages: graph });
    expect(inspection.untracked).toEqual([]);
    expect(inspection.issues.map((issue) => [issue.stage, issue.status])).toEqual([
      ["requirements-analysis", "stale"],
      ["application-design", "stale"],
      ["code-generation", "needs-revalidation"],
      ["build-and-test", "needs-revalidation"],
    ]);
    expect(
      inspection.issues.find((issue) => issue.stage === "unrelated-stage"),
    ).toBeUndefined();
  });

  test("does not propagate through a stage skipped by the active plan", () => {
    const projectDir = tempProject();
    const skippedGraph: StageValidityNode[] = [
      { slug: "a", phase: "inception", consumes: [], produces: ["from-a"] },
      {
        slug: "b",
        phase: "inception",
        consumes: [{ artifact: "from-a", required: true }],
        produces: ["from-b"],
      },
      {
        slug: "c",
        phase: "inception",
        consumes: [{ artifact: "from-b", required: true }],
        produces: ["from-c"],
      },
    ];
    const state = `- **Project Type**: greenfield
- [x] a ${SEP} EXECUTE
- [S] b ${SEP} SKIP: not in active plan
- [x] c ${SEP} EXECUTE
- **Current Stage**: c
`;
    const baselineA = basis({ inputs: {}, outputs: { "from-a": "sha256:v1" } });
    const baselineC = basis({
      inputs: { "from-b": "sha256:v1" },
      outputs: { "from-c": "sha256:v1" },
    });
    const audit = [
      auditEvent("WORKFLOW_STARTED", "2026-08-05T00:00:00.000Z"),
      auditEvent("STAGE_COMPLETED", "2026-08-05T00:00:01.000Z", {
        Stage: "a",
        "Validation Basis": JSON.stringify(baselineA),
      }),
      auditEvent("STAGE_COMPLETED", "2026-08-05T00:00:02.000Z", {
        Stage: "c",
        "Validation Basis": JSON.stringify(baselineC),
      }),
    ].join("\n---\n");

    const inspection = inspectStageValidity(projectDir, state, {
      stages: skippedGraph,
      audit,
      currentBasis: (stage) =>
        stage.slug === "a"
          ? { ...baselineA, outputs: { "from-a": "sha256:v2" } }
          : baselineC,
    });

    expect(inspection.issues.map((issue) => issue.stage)).toEqual(["a"]);
  });

  test("fails open for completed stages from ledgers without validation bases", () => {
    const projectDir = tempProject();
    const state = stateContent();
    const record = initializeProject(projectDir, state);
    writeGraphArtifacts(record);
    writeAudit(
      record,
      [
        auditEvent("WORKFLOW_STARTED", "2026-08-05T00:00:00.000Z"),
        ...graph.map((stage, index) =>
          auditEvent(
            "STAGE_COMPLETED",
            `2026-08-05T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
            { Stage: stage.slug },
          ),
        ),
      ].join("\n---\n"),
    );

    const inspection = inspectStageValidity(projectDir, state, { stages: graph });
    expect(inspection.issues).toEqual([]);
    expect(inspection.untracked).toEqual(graph.map((stage) => stage.slug));
  });

  test("does not project invalidity onto a stage that is no longer completed", () => {
    const projectDir = tempProject();
    const allCompleted = stateContent();
    const currentState = stateContent([
      "requirements-analysis",
      "application-design",
      "code-generation",
      "unrelated-stage",
    ]);
    const record = initializeProject(projectDir, currentState);
    writeGraphArtifacts(record);
    writeAudit(record, completionAudit(projectDir, allCompleted, graph));

    writeArtifact(
      record,
      "construction",
      "build-and-test",
      "test-results",
      "tests-v2\n",
    );

    const inspection = inspectStageValidity(projectDir, currentState, {
      stages: graph,
    });
    expect(
      inspection.issues.find((issue) => issue.stage === "build-and-test"),
    ).toBeUndefined();
  });
});
