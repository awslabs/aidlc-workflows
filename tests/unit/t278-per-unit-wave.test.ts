// covers: subcommand:aidlc-orchestrate:next, function:validateDirective,
// file:aidlc-common/protocols/stage-protocol-construction.md,
// file:skills/aidlc/SKILL.md per-unit wave paragraph
//
// t278 - engine-emitted, receipt-settled waves for stage-major per-unit design.
// The engine derives complete sibling entries from one healed Bolt-DAG snapshot,
// keeps a batch active until every applicable unit has fresh review evidence,
// and transports the optional wave through the existing steering boundary.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  artifactFilename,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  appendAuditEntry,
} from "../../dist/claude/.claude/tools/aidlc-audit.ts";
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
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;
const SEP = "\u2014";
const REQUIRED_FD = [
  "entities",
  "rules",
  "functional-spec",
  "traceability",
];
interface WaveEntry {
  unit: string;
  unit_kind: string | null;
  build_required: boolean;
  completion_required: boolean;
  review_state:
    | "outstanding"
    | "retry-required"
    | "repair-required"
    | "recovery-required"
    | "escalation-required"
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
  reviewOverride?: "advisory" | "none",
  autonomy?: "autonomous" | "gated",
): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: wave test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on
- **Construction Iteration**: ${iteration}
${reviewOverride ? `- **Review Override**: ${reviewOverride}\n` : ""}
${autonomy ? `- **Construction Autonomy Mode**: ${autonomy}\n` : ""}

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
${row("x", "domain-design")}
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
  reviewOverride?: "advisory" | "none",
  autonomy?: "autonomous" | "gated",
): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(
    seededStateFile(proj),
    constructionState(current, iteration, reviewOverride, autonomy),
  );
  return proj;
}

function next(proj: string) {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = "1";
  const result = runOrchestrateNext(ORCH, proj, [], { env });
  if (result.directive === null) {
    throw new Error(
      `next emitted no JSON: ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  if (result.directive.kind === "error") {
    throw new Error(
      `next emitted an error directive: ${String(result.directive.message)}`,
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
    writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}\n`);
  }
}

function review(
  proj: string,
  unit: string,
  verdict: "READY" | "NOT-READY" = "READY",
  iteration = 1,
): void {
  const args = [
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
  ];
  for (const suffix of [[], ["--verdict", verdict]]) {
    const result = spawnSync(
      BUN,
      [...args, ...suffix, "--project-dir", proj],
      { encoding: "utf-8" },
    );
    if ((result.status ?? -1) !== 0) {
      throw new Error(`review failed: ${result.stdout}${result.stderr}`);
    }
  }
}

function requestReview(proj: string, unit: string, iteration = 1): void {
  const result = reviewRequestResult(proj, unit, iteration);
  if (result.status !== 0) {
    throw new Error(`review request failed: ${result.out}`);
  }
}

function reviewRequestResult(proj: string, unit: string, iteration = 1) {
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
      "--project-dir",
      proj,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      },
    },
  );
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function completeWave(proj: string, unit: string): void {
  const result = spawnSync(
    BUN,
    [
      STATE,
      "unit",
      "complete",
      "--wave",
      "--stage",
      "functional-design",
      "--unit",
      unit,
      "--project-dir",
      proj,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      },
    },
  );
  if ((result.status ?? -1) !== 0) {
    throw new Error(`wave completion failed: ${result.stdout}${result.stderr}`);
  }
}

function reportRejected(proj: string, feedback: string) {
  const env = { ...process.env };
  env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = "1";
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const result = spawnSync(
    BUN,
    [
      ORCH,
      "report",
      "--stage",
      "functional-design",
      "--result",
      "rejected",
      "--user-input",
      feedback,
      "--project-dir",
      proj,
    ],
    { encoding: "utf-8", env },
  );
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function auditEventCount(proj: string, event: string): number {
  return readAllAuditShards(proj)
    .split("\n")
    .filter((line) => line === `**Event**: ${event}`).length;
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

describe("t278 engine-emitted wave contract", () => {
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
    expect(api.completion_required).toBe(true);
    expect(api.required_produces).toHaveLength(4);
    expect(
      api.required_produces.every((path) =>
        path.includes("/construction/api/infrastructure-design/")
      ),
    ).toBe(true);
    expect(web.unit_kind).toBe("ui");
    expect(web.required_produces).toEqual([
      `${RP}/construction/web/infrastructure-design/infrastructure-specification.md`,
      `${RP}/construction/web/infrastructure-design/monitoring-design.md`,
      `${RP}/construction/web/infrastructure-design/cicd-pipeline.md`,
      `${RP}/construction/web/infrastructure-design/traceability.json`,
    ]);
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
      "observability-requirements",
      "functional-spec",
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
      `${RP}/construction/contract/nfr-design/traceability.json`,
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
    expect(next(proj).directive.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      build_required: false,
      completion_required: true,
      review_state: "READY",
    });
    completeWave(proj, "alpha");
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
        "functional-spec.md",
      ),
      "# repaired after iteration 1\n",
    );
    const reReview = next(proj).directive;
    expect(reReview.wave?.entries[0]).toMatchObject({
      review_state: "outstanding",
      review_iteration: 2,
    });

    review(proj, "beta", "NOT-READY", 2);
    const completion = next(proj).directive;
    expect(completion.wave?.entries[0]).toMatchObject({
      unit: "beta",
      completion_required: true,
      review_state: "NOT-READY",
    });
    completeWave(proj, "beta");
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
    completeWave(proj, "alpha");
    completeWave(proj, "beta");
    expect(next(proj).directive.gate).toBe(true);

    writeFileSync(
      join(
        seededRecordDir(proj),
        "construction",
        "alpha",
        "functional-design",
        "functional-spec.md",
      ),
      "# changed after review\n",
    );
    const reopened = next(proj).directive;
    expect(reopened.wave?.batch_index).toBe(0);
    expect(reopened.wave?.entries).toHaveLength(1);
    expect(reopened.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      build_required: false,
      completion_required: true,
      review_state: "recovery-required",
      review_iteration: 2,
    });

    const recoveryIteration = reopened.wave?.entries[0].review_iteration;
    expect(recoveryIteration).toBe(2);
    review(proj, "alpha", "READY", recoveryIteration ?? 0);
    expect(next(proj).directive.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      completion_required: true,
      review_state: "READY",
    });
    completeWave(proj, "alpha");
    expect(next(proj).directive.gate).toBe(true);
  }, 30000);

  test("a second stale wave receipt escalates instead of re-emitting recovery", () => {
    const proj = project();
    seedBoltDag(proj, ["alpha"]);
    cover(proj, "alpha", "functional-design", REQUIRED_FD);
    review(proj, "alpha");

    writeFileSync(
      join(
        seededRecordDir(proj),
        "construction",
        "alpha",
        "functional-design",
        "functional-spec.md",
      ),
      "# changed before recovery\n",
    );
    const recovery = next(proj).directive.wave?.entries[0];
    expect(recovery).toMatchObject({
      unit: "alpha",
      review_state: "recovery-required",
      review_iteration: 2,
    });
    review(proj, "alpha", "READY", recovery?.review_iteration ?? 0);

    writeFileSync(
      join(
        seededRecordDir(proj),
        "construction",
        "alpha",
        "functional-design",
        "functional-spec.md",
      ),
      "# changed after recovery\n",
    );
    expect(next(proj).directive.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      review_state: "escalation-required",
      review_iteration: 3,
    });
  }, 30000);

  test("an autonomous inline wave cannot reset spent recovery without a human turn", () => {
    const proj = project(
      "functional-design",
      "stage-major",
      undefined,
      "autonomous",
    );
    seedBoltDag(proj, ["alpha"]);
    cover(proj, "alpha", "functional-design", REQUIRED_FD);
    review(proj, "alpha");

    const artifact = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "functional-design",
      "functional-spec.md",
    );
    writeFileSync(artifact, "# changed before recovery\n");
    review(proj, "alpha", "READY", 2);
    writeFileSync(artifact, "# changed after recovery\n");

    expect(next(proj).directive.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      review_state: "escalation-required",
      review_iteration: 3,
    });

    const rejected = reportRejected(
      proj,
      "Request Changes: restart review after the invalidating write",
    );
    expect(rejected.status).toBe(0);
    expect(rejected.out).toContain('"kind":"error"');
    expect(rejected.out).toContain("Refusing to reject");
    expect(rejected.out).toContain(
      "stale-receipt recovery review was already spent",
    );
    expect(rejected.out).toContain("only after a real human has acted");
    expect(next(proj).directive.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      review_state: "escalation-required",
      review_iteration: 3,
    });

    const stillSpent = reviewRequestResult(proj, "alpha", 1);
    expect(stillSpent.status).not.toBe(0);
    expect(stillSpent.out).toContain(
      "stale-receipt recovery review pass was already spent",
    );
    expect(auditEventCount(proj, "GATE_REJECTED")).toBe(0);

    appendAuditEntry("HUMAN_TURN", {}, proj);
    const humanRejected = reportRejected(
      proj,
      "Request Changes: restart review after the invalidating write",
    );
    expect(humanRejected.status).toBe(0);
    expect(humanRejected.out).not.toContain('"kind":"error"');
    expect(auditEventCount(proj, "GATE_REJECTED")).toBe(1);

    const restarted = reviewRequestResult(proj, "alpha", 1);
    expect(restarted.status).toBe(0);
    expect(restarted.out).toContain('"emitted":"REVIEW_REQUESTED"');
    expect(restarted.out).not.toContain('"recovery"');
  }, 30000);

  test("fully settled siblings are omitted from a repeated same-batch wave", () => {
    const proj = project();
    seedBoltDag(proj, ["alpha", "beta"]);
    cover(proj, "alpha", "functional-design", REQUIRED_FD);
    review(proj, "alpha");
    completeWave(proj, "alpha");

    const wave = next(proj).directive.wave;
    expect(wave?.batch_index).toBe(0);
    expect(wave?.entries.map((entry) => entry.unit)).toEqual(["beta"]);
  }, 30000);

  test("large independent batches emit deterministic same-batch prefixes below the transport cap", () => {
    const proj = project();
    const installedTemplate = join(
      proj,
      ".claude",
      "knowledge",
      "aidlc-shared",
      "memory-template.md",
    );
    mkdirSync(dirname(installedTemplate), { recursive: true });
    copyFileSync(
      join(AIDLC_SRC, "knowledge", "aidlc-shared", "memory-template.md"),
      installedTemplate,
    );
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
    const emitted = new Set(entries.map((entry) => entry.unit));
    for (const unit of units) {
      const memory = join(
        seededRecordDir(proj),
        "construction",
        unit.name,
        "functional-design",
        "memory.md",
      );
      expect(existsSync(memory)).toBe(emitted.has(unit.name));
    }
  }, 30000);

  test("an unmatched paired review request is re-emitted as retry-required", () => {
    const proj = project();
    seedBoltDag(proj, ["alpha"]);
    cover(proj, "alpha", "functional-design", REQUIRED_FD);
    requestReview(proj, "alpha");

    expect(next(proj).directive.wave?.entries[0]).toMatchObject({
      unit: "alpha",
      review_state: "retry-required",
      review_iteration: 1,
      completion_required: true,
    });
  }, 30000);

  test("effective advisory and none review classes settle with their declared contracts", () => {
    const advisory = project("functional-design", "stage-major", "advisory");
    seedBoltDag(advisory, ["alpha"]);
    cover(advisory, "alpha", "functional-design", REQUIRED_FD);
    review(advisory, "alpha", "NOT-READY", 1);
    expect(next(advisory).directive.wave?.entries[0]).toMatchObject({
      review_state: "NOT-READY",
      completion_required: true,
    });
    completeWave(advisory, "alpha");
    expect(next(advisory).directive.gate).toBe(true);

    const none = project("functional-design", "stage-major", "none");
    seedBoltDag(none, ["alpha"]);
    cover(none, "alpha", "functional-design", REQUIRED_FD);
    expect(next(none).directive.wave?.entries[0]).toMatchObject({
      review_state: "not-required",
      completion_required: true,
    });
    completeWave(none, "alpha");
    expect(next(none).directive.gate).toBe(true);
  }, 30000);

  test("wave completion fans Unit memory into the parent diary before settlement", () => {
    const proj = project();
    seedBoltDag(proj, ["alpha"]);
    cover(proj, "alpha", "functional-design", REQUIRED_FD);
    const unitMemory = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "functional-design",
      "memory.md",
    );
    writeFileSync(
      unitMemory,
      "## Interpretations\n- 2026-08-12T00:00:00Z \u2014 preserve this note; verbatim context\n\n## Deviations\n\n## Tradeoffs\n\n## Open questions\n",
    );
    review(proj, "alpha");
    expect(next(proj).directive.wave?.entries[0]).toMatchObject({
      review_state: "READY",
      completion_required: true,
    });

    completeWave(proj, "alpha");
    const parentMemory = readFileSync(
      join(
        seededRecordDir(proj),
        "construction",
        "functional-design",
        "memory.md",
      ),
      "utf-8",
    );
    expect(parentMemory).toContain(
      "- 2026-08-12T00:00:00Z \u2014 preserve this note; verbatim context",
    );
    expect(parentMemory.match(/aidlc-wave-memory:alpha:/g)?.length).toBe(1);
    expect(next(proj).directive.gate).toBe(true);
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
    "then `directive.wave` when present, otherwise `directive.gate`",
  );
  expect(body).toContain("parent Unit fields are only a projection");
  expect(body).toContain("complete steering bundle verbatim");
  expect(body).toContain("every `inline_context_paths` file");
  expect(body).toContain("`context_warnings`");
  expect(body).toContain("entry.required_produces");
  expect(body).toContain("completion_required");
  expect(body).toContain("entry.unit_memory_path");
  expect(body).toContain("retry-required");
  expect(body).toContain("repair-required");
  expect(body).toContain("recovery-required");
  expect(body).toContain("escalation-required");
  expect(body).toContain("`--retry-pending`");
  expect(body).toContain("emits `UNIT_COMPLETED`");
  expect(body).toContain("Code Generation and unit-major iteration never carry a wave");
  expect(body).not.toContain(
    "read `bolt_dag.batches` from the intent's `runtime-graph.json`",
  );
}

describe("t278 wave protocol parity", () => {
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
      expect(authored).toContain(
        "Serialize reviews wherever the single reviewer-scope record is enforced",
      );
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
        "stage-protocol-construction.md",
      ),
      "utf-8",
    );
    expect(core).toContain(
      "**Per-unit batch waves (optional, stage-major only).**",
    );
    expect(core).toContain("engine may emit `directive.wave`");
    expect(core).toContain(
      "branch on it before the ordinary per-Unit or gate path",
    );
    expect(core).toContain("entry.required_produces");
    expect(core).toContain("completion_required");
    expect(core).toContain("`unit_memory_path`");
    expect(core).toContain('"retry-required"');
    expect(core).toContain('"repair-required"');
    expect(core).toContain('"recovery-required"');
    expect(core).toContain('"escalation-required"');
    expect(core).toContain("unit complete --wave");
    expect(core).toContain("UNIT_COMPLETED");
    expect(core).toContain("accumulated steering bundle");
    expect(core).not.toContain(
      "read `bolt_dag.batches` from the intent's `runtime-graph.json`",
    );
  });
});
