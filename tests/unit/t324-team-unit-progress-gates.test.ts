// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-state:set-unit-ownership, subcommand:aidlc-state:set-unit-gate-rhythm, subcommand:aidlc-state:refresh-unit-progress, audit:UNIT_OWNERSHIP_SET, audit:UNIT_GATE_RHYTHM_SET, function:UNIT_OWNERSHIP_FIELD, function:UNIT_GATE_RHYTHM_FIELD, function:isTeamUnitOwnership, function:readUnitGateRhythm, function:unitGateStatus, function:unitLifecycleSnapshot, function:unitMajorConstructionStageSlugs, function:deriveTeamUnitProgressModel

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  findStageBySlug,
  freshReviewReceipts,
  isTeamUnitOwnership,
  readAllAuditShards,
  readUnitGateRhythm,
  UNIT_GATE_RHYTHM_FIELD,
  UNIT_OWNERSHIP_FIELD,
  unitCompletedReceipts,
  unitGateStatus,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  deriveTeamUnitProgressModel,
} from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import {
  readReviewFindingDispositions,
} from "../../dist/claude/.claude/tools/aidlc-review-brief.ts";

resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};
delete ENV.AWS_AIDLC_DEFAULT_SCOPE;

const PRODUCES: Record<string, string[]> = {
  "functional-design": [
    "entities",
    "rules",
    "functional-spec",
    "frontend-components",
    "traceability",
  ],
  "nfr-requirements": [
    "performance-requirements",
    "security-requirements",
    "scalability-requirements",
    "reliability-requirements",
    "observability-requirements",
    "tech-stack-decisions",
    "traceability",
  ],
  "nfr-design": [
    "performance-design",
    "security-design",
    "scalability-design",
    "reliability-design",
    "observability-design",
    "logical-components",
    "traceability",
  ],
  "infrastructure-design": [
    "infrastructure-specification",
    "monitoring-design",
    "cicd-pipeline",
    "traceability",
  ],
  "code-generation": [
    "code-generation-plan",
    "unit-test-instructions",
    "code-summary",
    "traceability",
  ],
};
const BLOCK = [
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  unit_gate?: string;
  reviewer?: string;
  message?: string;
  [key: string]: unknown;
}

function constructionState(opts: {
  ownership?: string;
  rhythm?: "per-stage" | "unit-end";
} = {}): string {
  const ownership = opts.ownership
    ? `- **Unit Ownership**: ${opts.ownership}\n`
    : "";
  const rhythm = opts.rhythm
    ? `- **Unit Gate Rhythm**: ${opts.rhythm}\n`
    : "";
  return `# AI-DLC State Tracking

## Project Information
- **Project**: team unit progress test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
${ownership}${rhythm}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`;
}

function seedProject(opts: {
  ownership?: string;
  rhythm?: "per-stage" | "unit-end";
} = {}, units = ["alpha", "beta"]): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), constructionState(opts));
  seedBoltDag(proj, units);
  return proj;
}

function runNext(proj: string): Directive {
  return runNextWithEnv(proj, ENV);
}

function runNextWithEnv(
  proj: string,
  env: NodeJS.ProcessEnv,
): Directive {
  const result = runOrchestrateNext(ORCH, proj, [], { env });
  if (!result.directive) {
    throw new Error(`next failed: ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.directive as Directive;
}

function runState(
  proj: string,
  args: string[],
  env: Record<string, string | undefined> = ENV,
): { rc: number; out: string } {
  const result = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function runReport(proj: string, args: string[]): Directive {
  const result = spawnSync(
    BUN,
    [ORCH, "report", ...args, "--project-dir", proj],
    { encoding: "utf-8", env: ENV },
  );
  try {
    return JSON.parse((result.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(`report failed: ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
}

function coverUnit(proj: string, unit: string, stage: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, stage);
  mkdirSync(dir, { recursive: true });
  for (const artifact of PRODUCES[stage]) {
    writeFileSync(
      join(dir, artifactFilename(artifact)),
      `# ${artifact} for ${unit}\n`,
    );
  }
  if (stage === "code-generation") {
    writeFileSync(
      join(dir, "source-manifest.json"),
      `${JSON.stringify({ stage, unit, version: 1, writes: [] }, null, 2)}\n`,
    );
  }
}

function addReviewFinding(
  proj: string,
  unit: string,
  stage: string,
  findingId = "R-01",
): string {
  const artifact = join(
    seededRecordDir(proj),
    "construction",
    unit,
    stage,
    artifactFilename(PRODUCES[stage][0]),
  );
  const relativeArtifact = artifact.slice(proj.length + 1).replaceAll("\\", "/");
  writeFileSync(
    artifact,
    [
      `# ${stage} review fixture`,
      "",
      "## Review",
      "",
      "**Verdict:** NOT-READY",
      "**Reviewer:** aidlc-architecture-reviewer-agent",
      "**Date:** 2026-08-26T12:00:00Z",
      "**Iteration:** 1",
      "",
      "### Findings",
      "",
      "| ID | Severity | Location | Finding | Required action | Status |",
      "|---|---|---|---|---|---|",
      `| ${findingId} | Major | ${relativeArtifact} > section | Unit concern | Fix the Unit | New |`,
      "",
      "### Summary",
      "",
      "Fixture review.",
      "",
    ].join("\n"),
  );
  return relativeArtifact;
}

function logReviewReady(
  proj: string,
  stage: string,
  unit: string,
  reviewer: string,
): void {
  const base = [
    LOG,
    "review",
    "--stage",
    stage,
    "--reviewer",
    reviewer,
    "--unit",
    unit,
    "--iteration",
    "1",
    "--project-dir",
    proj,
  ];
  for (const suffix of [[], ["--verdict", "READY"]]) {
    const result = spawnSync(BUN, [...base, ...suffix], {
      encoding: "utf-8",
      env: ENV,
    });
    if ((result.status ?? -1) !== 0) {
      throw new Error(`review failed: ${result.stdout}${result.stderr}`);
    }
  }
}

function settleBody(proj: string, directive: Directive): void {
  const stage = directive.stage!;
  const unit = directive.unit!;
  const started = runState(
    proj,
    ["unit", "start", "--stage", stage, "--unit", unit],
  );
  if (started.rc !== 0) {
    throw new Error(`${started.out}\nnext=${JSON.stringify(runNext(proj))}`);
  }
  coverUnit(proj, unit, stage);
  expect(runState(proj, ["unit", "complete", "--stage", stage, "--unit", unit]).rc)
    .toBe(0);
  if (directive.reviewer) {
    logReviewReady(proj, stage, unit, directive.reviewer);
  }
}

function approveGate(proj: string, directive: Directive): void {
  const args = [
    "--stage",
    directive.stage!,
    "--unit",
    directive.unit!,
  ];
  expect(runReport(proj, [...args, "--result", "awaiting-approval"]).kind)
    .toBe("print");
  expect(
    runReport(proj, [
      ...args,
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]).kind,
  ).toBe("done");
}

function state(proj: string): string {
  return readFileSync(seededStateFile(proj), "utf-8");
}

function unitProgress(proj: string): string {
  const content = state(proj);
  const start = content.search(/^## Unit Progress$/m);
  if (start < 0) return "";
  const afterHeading = content.indexOf("\n", start) + 1;
  const nextRelative = content.slice(afterHeading).search(/^## /m);
  const end = nextRelative < 0 ? content.length : afterHeading + nextRelative;
  return content.slice(start, end).trimEnd();
}

describe("t324 team-owned unit progress and per-unit gates", () => {
  test("a merge override marks only merged status, not unsupported live stages", () => {
    const proj = seedProject({ ownership: "team" }, ["alpha"]);
    const model = deriveTeamUnitProgressModel(
      proj,
      state(proj),
      undefined,
      new Set(["alpha"]),
      { ownerOverrides: new Map([["alpha", "team-a"]]) },
    );
    const row = model.section
      .split(/\r?\n/)
      .find((line) => line.startsWith("| alpha |"))!;
    expect(row).toContain("| alpha | - | [ ] |");
    expect(row).toEndWith("| [ ] | [x] |");
    expect(Object.values(model.stageStates)).not.toContain("completed");
  });

  const dormantStates: Array<{
    name: string;
    cover: (proj: string) => void;
    expected: { stage: string; unit: string; gate: boolean };
  }> = [
    {
      name: "empty coverage",
      cover: () => {},
      expected: { stage: "functional-design", unit: "alpha", gate: false },
    },
    {
      name: "alpha functional-design covered",
      cover: (proj) => coverUnit(proj, "alpha", "functional-design"),
      expected: { stage: "nfr-requirements", unit: "alpha", gate: false },
    },
    {
      name: "alpha first two stages covered",
      cover: (proj) => {
        coverUnit(proj, "alpha", "functional-design");
        coverUnit(proj, "alpha", "nfr-requirements");
      },
      expected: { stage: "nfr-design", unit: "alpha", gate: false },
    },
  ];

  for (const dormant of dormantStates) {
    test(`dormancy [${dormant.name}]: absent, solo, and junk ownership are byte-identical`, () => {
      const results = [undefined, "solo", "team-ish"].map((ownership) => {
        const proj = seedProject(ownership ? { ownership } : {});
        dormant.cover(proj);
        const stateBefore = state(proj);
        const auditBefore = readAllAuditShards(proj);
        const directive = runNext(proj);
        expect(state(proj)).toBe(stateBefore);
        expect(readAllAuditShards(proj)).toBe(auditBefore);
        expect(unitProgress(proj)).toBe("");
        expect("unit_gate" in directive).toBe(false);
        return directive;
      });
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(results[0]).toMatchObject({
        kind: "run-stage",
        ...dormant.expected,
      });
    }, 30000);
  }

  test("per-stage rhythm gates every settled pair before the next stage", () => {
    const proj = seedProject({ ownership: "team" });
    const unitGates: Directive[] = [];
    for (const stage of BLOCK) {
      const body = runNext(proj);
      expect(body).toMatchObject({
        kind: "run-stage",
        stage,
        unit: "alpha",
        gate: false,
      });
      settleBody(proj, body);

      const gate = runNext(proj);
      expect(gate).toMatchObject({
        kind: "run-stage",
        stage,
        unit: "alpha",
        gate: true,
        unit_gate: "per-stage",
      });
      unitGates.push(gate);
      approveGate(proj, gate);
    }
    for (const stage of BLOCK) {
      const body = runNext(proj);
      expect(body).toMatchObject({
        stage,
        unit: "beta",
        gate: false,
      });
      settleBody(proj, body);
      const gate = runNext(proj);
      expect(gate).toMatchObject({
        stage,
        unit: "beta",
        gate: true,
        unit_gate: "per-stage",
      });
      unitGates.push(gate);
      approveGate(proj, gate);
    }
    expect(runNext(proj)).toMatchObject({
      stage: "build-and-test",
    });
    expect(state(proj)).toContain("- [-] build-and-test — EXECUTE");
    expect(state(proj)).toContain("- **Current Stage**: build-and-test");
    expect(
      runReport(proj, ["--stage", "build-and-test", "--result", "awaiting-approval"])
        .kind,
    ).toBe("print");
    for (const stage of BLOCK) {
      expect(state(proj)).toContain(`- [x] ${stage} — EXECUTE`);
    }
    expect(unitGates).toHaveLength(BLOCK.length * 2);
    expect(unitGates.every((gate) => gate.unit_gate === "per-stage"))
      .toBe(true);
    expect(unitGates.every((gate) => typeof gate.unit === "string")).toBe(true);
  }, 120000);

  test("unit-end rhythm emits one chain gate after code-generation", () => {
    const proj = seedProject(
      { ownership: "team", rhythm: "unit-end" },
      ["alpha", "beta"],
    );
    for (const unit of ["alpha", "beta"]) {
      for (const stage of BLOCK) {
        const body = runNext(proj);
        expect(body).toMatchObject({
          stage,
          unit,
          gate: false,
        });
        expect(body.unit_gate).toBeUndefined();
        settleBody(proj, body);
      }
      const gate = runNext(proj);
      expect(gate).toMatchObject({
        stage: "code-generation",
        unit,
        gate: true,
        unit_gate: "unit-end",
      });
      expect(state(proj)).toContain("- [-] functional-design — EXECUTE");
      approveGate(proj, gate);
    }
    expect(runNext(proj)).toMatchObject({
      stage: "build-and-test",
    });
    expect(state(proj)).toContain("- [-] build-and-test — EXECUTE");
    expect(state(proj)).toContain("- **Current Stage**: build-and-test");
  }, 120000);

  test("team ownership leaves ordinary Delivery Planning gates unitless", () => {
    const proj = seedProject({ ownership: "team" });
    writeFileSync(
      seededStateFile(proj),
      constructionState({ ownership: "team" })
        .replace(
          `### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE`,
          `### INCEPTION PHASE
- [-] delivery-planning — EXECUTE`,
        )
        .replace(
          "- **Lifecycle Phase**: CONSTRUCTION",
          "- **Lifecycle Phase**: INCEPTION",
        )
        .replace(
          "- **Current Stage**: functional-design",
          "- **Current Stage**: delivery-planning",
        ),
    );
    expect(
      runReport(proj, [
        "--stage",
        "delivery-planning",
        "--result",
        "awaiting-approval",
      ]).kind,
    ).toBe("print");
    expect(state(proj)).toContain("- [?] delivery-planning — EXECUTE");
  });

  test("team per-unit gates require --unit and solo gates refuse it", () => {
    const team = seedProject({ ownership: "team" }, ["alpha"]);
    const missingUnit = runReport(team, [
      "--stage",
      "functional-design",
      "--result",
      "awaiting-approval",
    ]);
    expect(missingUnit.kind).toBe("error");
    expect(missingUnit.message).toContain("requires --unit");

    const solo = seedProject({ ownership: "solo" }, ["alpha"]);
    const foreignUnit = runReport(solo, [
      "--stage",
      "functional-design",
      "--unit",
      "alpha",
      "--result",
      "awaiting-approval",
    ]);
    expect(foreignUnit.kind).toBe("error");
    expect(foreignUnit.message).toContain(
      "--unit gate reporting requires Unit Ownership: team",
    );
  });

  test("stop-hook probe next leaves team state and audit byte-identical", () => {
    const proj = seedProject({ ownership: "team" }, ["alpha"]);
    const stateBefore = state(proj);
    const auditBefore = readAllAuditShards(proj);
    expect(
      runNextWithEnv(proj, { ...ENV, AIDLC_STOP_HOOK_PROBE: "1" }),
    ).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "alpha",
    });
    expect(state(proj)).toBe(stateBefore);
    expect(readAllAuditShards(proj)).toBe(auditBefore);
  });

  test("team projection preserves recomposed skipped per-unit stages", () => {
    const proj = seedProject({ ownership: "team" }, ["alpha"]);
    writeFileSync(
      seededStateFile(proj),
      state(proj).replace(
        "- [ ] nfr-design — EXECUTE",
        "- [S] nfr-design — SKIP",
      ),
    );
    expect(runNext(proj)).toMatchObject({
      stage: "functional-design",
      unit: "alpha",
    });
    expect(state(proj)).toContain("- [S] nfr-design — SKIP");
    expect(unitProgress(proj).split("\n")[2]).not.toContain("nfr-design");
  });

  test("unit-end excludes skipped mid-chain and anchors to the final unskipped stage", () => {
    const midSkip = seedProject(
      { ownership: "team", rhythm: "unit-end" },
      ["alpha"],
    );
    writeFileSync(
      seededStateFile(midSkip),
      state(midSkip).replace(
        "- [ ] nfr-design — EXECUTE",
        "- [S] nfr-design — SKIP",
      ),
    );
    for (const stage of BLOCK.filter((slug) => slug !== "nfr-design")) {
      const body = runNext(midSkip);
      expect(body).toMatchObject({ stage, unit: "alpha", gate: false });
      settleBody(midSkip, body);
    }
    const midGate = runNext(midSkip);
    expect(midGate).toMatchObject({
      stage: "code-generation",
      unit: "alpha",
      unit_gate: "unit-end",
    });
    approveGate(midSkip, midGate);
    const midAudit = readAllAuditShards(midSkip);
    expect(midAudit).toContain(
      "**Gate Stages**: functional-design,nfr-requirements,infrastructure-design,code-generation",
    );
    expect(midAudit).not.toContain(
      "**Gate Stages**: functional-design,nfr-requirements,nfr-design",
    );

    const finalSkip = seedProject(
      { ownership: "team", rhythm: "unit-end" },
      ["alpha"],
    );
    writeFileSync(
      seededStateFile(finalSkip),
      state(finalSkip).replace(
        "- [ ] code-generation — EXECUTE",
        "- [S] code-generation — SKIP",
      ),
    );
    for (const stage of BLOCK.filter((slug) => slug !== "code-generation")) {
      const body = runNext(finalSkip);
      expect(body).toMatchObject({ stage, unit: "alpha", gate: false });
      settleBody(finalSkip, body);
    }
    const finalGate = runNext(finalSkip);
    expect(finalGate).toMatchObject({
      stage: "infrastructure-design",
      unit: "alpha",
      unit_gate: "unit-end",
    });
    approveGate(finalSkip, finalGate);
    expect(readAllAuditShards(finalSkip)).toContain(
      "**Gate Stages**: functional-design,nfr-requirements,nfr-design,infrastructure-design",
    );
  }, 120000);

  test("team block completion finalizes a plan with no later stage", () => {
    const proj = seedProject({ ownership: "team" }, ["alpha"]);
    writeFileSync(
      seededStateFile(proj),
      state(proj).replace(
        "- [ ] build-and-test — EXECUTE",
        `- [S] build-and-test — SKIP
- [S] ci-pipeline — SKIP

### OPERATION PHASE
- [S] deployment-pipeline — SKIP
- [S] environment-provisioning — SKIP
- [S] deployment-execution — SKIP
- [S] observability-setup — SKIP
- [S] incident-response — SKIP
- [S] performance-validation — SKIP
- [S] feedback-optimization — SKIP`,
      ),
    );
    for (const stage of BLOCK) {
      const body = runNext(proj);
      expect(body.stage).toBe(stage);
      settleBody(proj, body);
      approveGate(proj, runNext(proj));
    }
    expect(runNext(proj).kind).toBe("done");
    expect(state(proj)).toContain("- **Status**: Completed");
    expect(readAllAuditShards(proj)).toContain("**Event**: WORKFLOW_COMPLETED");
  }, 120000);

  test("cross-shard boundary ties fail a unit gate closed", () => {
    const proj = seedProject({ ownership: "team" }, ["alpha"]);
    const ts = "2026-08-20T00:00:00Z";
    const block = (event: string, fields: string) =>
      `## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${fields}\n---\n`;
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(
      join(seededAuditDir(proj), "aaaa-approved.md"),
      block(
        "GATE_APPROVED",
        "**Stage**: functional-design\n**Unit**: alpha\n**Gate Scope**: per-stage",
      ),
    );
    writeFileSync(
      join(seededAuditDir(proj), "zzzz-boundary.md"),
      block("WORKFLOW_STARTED", "**Scope**: feature"),
    );
    expect(unitGateStatus(proj, "functional-design", "alpha", "per-stage"))
      .toBe("pending");
  });

  test("team routing fails closed when the authoritative Unit DAG disappears", () => {
    const proj = seedProject({ ownership: "team" }, ["alpha"]);
    rmSync(join(seededRecordDir(proj), "runtime-graph.json"), { force: true });
    rmSync(
      join(
        seededRecordDir(proj),
        "inception",
        "units-generation",
        "unit-of-work-dependency.md",
      ),
      { force: true },
    );
    const directive = runNext(proj);
    expect(directive.kind, JSON.stringify(directive)).toBe("error");
    expect(directive.message).toContain(
      "Unit Ownership: team requires a valid non-empty authoritative Unit DAG",
    );
    expect(directive.unit).toBeUndefined();
  });

  test("team routing fails closed when Current Stage is outside the active Unit block", () => {
    const proj = seedProject({ ownership: "team" }, ["alpha"]);
    writeFileSync(
      seededStateFile(proj),
      state(proj).replace(
        "- [-] functional-design — EXECUTE",
        "- [-] functional-design — SKIP",
      ),
    );
    const directive = runNext(proj);
    expect(directive.kind).toBe("error");
    expect(directive.message).toContain(
      'current stage "functional-design": it is not in the active unskipped per-unit Construction block',
    );
  });

  test("grid is derived, rewrites hand edits, derives columns, and refresh is guarded", () => {
    const proj = seedProject({ ownership: "team" });
    const first = runNext(proj);
    expect(unitProgress(proj)).toContain("| alpha | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |");

    expect(runState(proj, [
      "unit",
      "start",
      "--stage",
      first.stage!,
      "--unit",
      first.unit!,
    ]).rc).toBe(0);
    const resumed = runNext(proj);
    expect(resumed).toMatchObject({ stage: "functional-design", unit: "alpha" });
    expect(unitProgress(proj)).toContain("| alpha | - | [-] | [ ] | [ ] | [ ] | [ ] | [-] |");

    coverUnit(proj, "alpha", "functional-design");
    expect(runState(proj, [
      "unit",
      "complete",
      "--stage",
      "functional-design",
      "--unit",
      "alpha",
    ]).rc).toBe(0);
    logReviewReady(
      proj,
      "functional-design",
      "alpha",
      first.reviewer!,
    );
    expect(runNext(proj)).toMatchObject({
      stage: "functional-design",
      unit: "alpha",
      gate: true,
    });
    expect(unitProgress(proj)).toContain("| alpha | - | [?] | [ ] | [ ] | [ ] | [ ] | [?] |");

    writeFileSync(
      seededStateFile(proj),
      state(proj).replace(
        "| alpha | - | [?] |",
        "| alpha | - | [x] |",
      ),
    );
    runNext(proj);
    expect(unitProgress(proj)).toContain("| alpha | - | [?] |");

    const authoritativeSection = unitProgress(proj);
    const stateBeforeForgery = state(proj);
    const auditBeforeForgery = readAllAuditShards(proj);
    const forgedPayloads = [
      {
        section: `${authoritativeSection}\n## Current Status`,
        stage_states: {},
      },
      {
        section: `${authoritativeSection}\n- **Status**: Completed`,
        stage_states: {},
      },
      {
        section: authoritativeSection,
        stage_states: Object.fromEntries(
          BLOCK.map((slug) => [slug, "completed"]),
        ),
      },
      {
        section: authoritativeSection,
        stage_states: { "functional-design": "in-progress" },
      },
      {
        section: authoritativeSection,
        stage_states: {
          "functional-design": "in-progress",
          "foreign-stage": "completed",
        },
      },
    ];
    for (const forged of forgedPayloads) {
      const forgedPayload = Buffer.from(JSON.stringify(forged)).toString(
        "base64url",
      );
      const refused = runState(
        proj,
        ["refresh-unit-progress", "--payload", forgedPayload],
        { ...ENV, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
      );
      expect(refused.rc).not.toBe(0);
      expect(state(proj)).toBe(stateBeforeForgery);
      expect(readAllAuditShards(proj)).toBe(auditBeforeForgery);
    }

    const payload = Buffer.from(
      JSON.stringify({
        section: "## Unit Progress\n| unit | owner | gate |\n| --- | --- | --- |",
        stage_states: {},
      }),
    ).toString("base64url");
    const blocked = runState(
      proj,
      ["refresh-unit-progress", "--payload", payload],
      { ...ENV, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: undefined },
    );
    expect(blocked.rc).not.toBe(0);
    expect(blocked.out).toContain(
      "Stage status cannot be changed with aidlc-state.ts refresh-unit-progress",
    );
  }, 60000);

  test("unit-keyed rejection floors only the rejected unit's lifecycle and review receipts", () => {
    const proj = seedProject({ ownership: "team" });
    for (const unit of ["alpha", "beta"]) {
      coverUnit(proj, unit, "functional-design");
      appendAuditEntry(
        "UNIT_COMPLETED",
        {
          Stage: "functional-design",
          Unit: unit,
          "Run floor": "unstarted#0",
        },
        proj,
      );
      logReviewReady(
        proj,
        "functional-design",
        unit,
        "aidlc-architecture-reviewer-agent",
      );
    }
    expect([...unitCompletedReceipts(proj, "functional-design")].sort())
      .toEqual(["alpha", "beta"]);

    const rejected = runReport(proj, [
      "--stage",
      "functional-design",
      "--unit",
      "alpha",
      "--result",
      "rejected",
      "--user-input",
      "Change alpha only",
    ]);
    expect(rejected.kind).toBe("print");
    expect([...unitCompletedReceipts(proj, "functional-design")])
      .toEqual(["beta"]);
    const stage = findStageBySlug("functional-design")!;
    const reviews = freshReviewReceipts(proj, state(proj), stage);
    expect([...reviews.unitVerdicts.keys()]).toEqual(["beta"]);
  }, 60000);

  test("team gates record review finding dispositions for only the gated Unit", () => {
    const approved = seedProject({ ownership: "team" }, ["alpha"]);
    const approvedDirective = runNext(approved);
    expect(approvedDirective).toMatchObject({
      stage: "functional-design",
      unit: "alpha",
    });
    expect(
      runState(approved, [
        "unit",
        "start",
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
      ]).rc,
    ).toBe(0);
    coverUnit(approved, "alpha", "functional-design");
    addReviewFinding(approved, "alpha", "functional-design");
    expect(
      runState(approved, [
        "unit",
        "complete",
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
      ]).rc,
    ).toBe(0);
    logReviewReady(
      approved,
      "functional-design",
      "alpha",
      approvedDirective.reviewer!,
    );
    expect(
      runReport(approved, [
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
        "--result",
        "awaiting-approval",
      ]).kind,
    ).toBe("print");
    expect(
      runReport(approved, [
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
        "--result",
        "approved",
        "--user-input",
        "Approve",
      ]).kind,
    ).toBe("done");
    expect([
      ...readReviewFindingDispositions(
        approved,
        "functional-design",
        "alpha",
      ).values(),
    ]).toMatchObject([{ status: "Accepted risk" }]);

    const rejected = seedProject({ ownership: "team" }, ["alpha"]);
    const rejectedDirective = runNext(rejected);
    expect(
      runState(rejected, [
        "unit",
        "start",
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
      ]).rc,
    ).toBe(0);
    coverUnit(rejected, "alpha", "functional-design");
    const artifact = addReviewFinding(
      rejected,
      "alpha",
      "functional-design",
    );
    expect(
      runState(rejected, [
        "unit",
        "complete",
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
      ]).rc,
    ).toBe(0);
    logReviewReady(
      rejected,
      "functional-design",
      "alpha",
      rejectedDirective.reviewer!,
    );
    expect(
      runReport(rejected, [
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
        "--result",
        "awaiting-approval",
      ]).kind,
    ).toBe("print");
    expect(
      runReport(rejected, [
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
        "--result",
        "rejected",
        "--reason",
        "Revise the Unit design",
        "--reject-finding",
        `${artifact}#R-01=This concern must be addressed`,
      ]).kind,
    ).toBe("print");
    expect([
      ...readReviewFindingDispositions(
        rejected,
        "functional-design",
        "alpha",
      ).values(),
    ]).toMatchObject([
      { status: "Rejected: This concern must be addressed" },
    ]);
  }, 120000);

  test("legacy unitless rejection remains stage-global under team ownership", () => {
    const proj = seedProject({ ownership: "team" });
    for (const unit of ["alpha", "beta"]) {
      coverUnit(proj, unit, "functional-design");
      appendAuditEntry(
        "UNIT_COMPLETED",
        {
          Stage: "functional-design",
          Unit: unit,
          "Run floor": "unstarted#0",
        },
        proj,
      );
    }
    expect([...unitCompletedReceipts(proj, "functional-design")].sort())
      .toEqual(["alpha", "beta"]);
    appendAuditEntry(
      "GATE_REJECTED",
      {
        Stage: "functional-design",
        Feedback: "legacy stage-global rejection",
      },
      proj,
    );
    expect([...unitCompletedReceipts(proj, "functional-design")]).toEqual([]);
  });

  test("set verbs enforce prerequisites, defaults, values, and emit audit events", () => {
    const noDag = createTestProject();
    tempDirs.push(noDag);
    seedAidlcMemory(noDag);
    writeFileSync(seededStateFile(noDag), constructionState());
    const missingDag = runState(noDag, ["set-unit-ownership", "team"]);
    expect(missingDag.rc).not.toBe(0);
    expect(missingDag.out).toContain("requires a non-empty authoritative unit DAG");

    const proj = seedProject();
    appendAuditEntry(
      "UNIT_STARTED",
      {
        Stage: "functional-design",
        Unit: "alpha",
        "Run floor": "unstarted#0",
      },
      proj,
    );
    writeFileSync(
      seededStateFile(proj),
      state(proj).replace("- **Construction Iteration**: unit-major\n", ""),
    );
    const premature = runState(proj, ["set-unit-ownership", "team"]);
    expect(premature.rc).not.toBe(0);
    expect(premature.out).toContain("requires Construction Iteration: unit-major");
    const prematureRhythm = runState(
      proj,
      ["set-unit-gate-rhythm", "unit-end"],
    );
    expect(prematureRhythm.rc).not.toBe(0);
    expect(prematureRhythm.out).toContain("requires Unit Ownership: team");

    expect(runState(proj, ["set-construction-iteration", "unit-major"]).rc)
      .toBe(0);
    expect(runState(proj, ["set-unit-ownership", "team"]).rc).toBe(0);
    expect(state(proj)).toContain("- **Unit Ownership**: team");
    expect(UNIT_OWNERSHIP_FIELD).toBe("Unit Ownership");
    expect(isTeamUnitOwnership(state(proj))).toBe(true);
    expect(readUnitGateRhythm(state(proj))).toBe("per-stage");
    expect(runState(proj, ["set-unit-gate-rhythm", "unit-end"]).rc).toBe(0);
    expect(state(proj)).toContain("- **Unit Gate Rhythm**: unit-end");
    expect(UNIT_GATE_RHYTHM_FIELD).toBe("Unit Gate Rhythm");
    expect(readUnitGateRhythm(state(proj))).toBe("unit-end");

    appendAuditEntry(
      "UNIT_STARTED",
      {
        Stage: "functional-design",
        Unit: "alpha",
        "Run floor": "unstarted#0",
      },
      proj,
    );
    const frozenOwnership = runState(proj, ["set-unit-ownership", "solo"]);
    expect(frozenOwnership.rc).not.toBe(0);
    expect(frozenOwnership.out).toContain(
      "frozen after team Unit activity in the current workflow attempt",
    );
    const frozenRhythm = runState(
      proj,
      ["set-unit-gate-rhythm", "per-stage"],
    );
    expect(frozenRhythm.rc).not.toBe(0);
    expect(frozenRhythm.out).toContain(
      "frozen after team Unit activity in the current workflow attempt",
    );

    appendAuditEntry(
      "STAGE_JUMPED",
      {
        Stage: "functional-design",
        Direction: "redo",
      },
      proj,
    );
    expect(runState(proj, ["set-unit-gate-rhythm", "per-stage"]).rc).toBe(0);
    expect(runState(proj, ["set-unit-ownership", "solo"]).rc).toBe(0);

    expect(runState(proj, ["set-unit-ownership", "bogus"]).rc).not.toBe(0);
    expect(runState(proj, ["set-unit-gate-rhythm", "bogus"]).rc).not.toBe(0);
    const audit = readAllAuditShards(proj);
    expect(audit).toContain("**Event**: UNIT_OWNERSHIP_SET");
    expect(audit).toContain("**Event**: UNIT_GATE_RHYTHM_SET");
  }, 30000);

  test("team ownership rejects recorded workspace repos before changing state", () => {
    const proj = seedProject();
    const registryPath = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "intents.json",
    );
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<
      Record<string, unknown>
    >;
    registry[0].repos = ["repo-a", "repo-b"];
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const stateBefore = state(proj);
    const auditBefore = readAllAuditShards(proj);

    const result = runState(proj, ["set-unit-ownership", "team"]);
    expect(result.rc).not.toBe(0);
    expect(result.out).toContain("not supported for intents with recorded workspace repos");
    expect(state(proj)).toBe(stateBefore);
    expect(readAllAuditShards(proj)).toContain("**Event**: ERROR_LOGGED");
    expect(readAllAuditShards(proj)).not.toContain(
      "**Event**: UNIT_OWNERSHIP_SET",
    );
    expect(auditBefore).toBe("");
  });

  test("switching team ownership off removes only Unit Progress bytes", () => {
    const proj = seedProject({ ownership: "team" }, ["alpha"]);
    runNext(proj);
    const withGrid = state(proj).replace(
      "## Scope Configuration",
      "## Scope Configuration\n\n\n<!-- unrelated spacing -->",
    ).replace("\n## Unit Progress", "\n\n\n## Unit Progress");
    writeFileSync(seededStateFile(proj), withGrid);
    const expected = withGrid.replace(
      /^## Unit Progress\r?\n[\s\S]*?(?=^## Current Status$)/m,
      "",
    );
    expect(runState(proj, ["set-unit-ownership", "solo"]).rc).toBe(0);
    expect(state(proj)).toBe(
      expected.replace("- **Unit Ownership**: team", "- **Unit Ownership**: solo"),
    );
    expect(state(proj)).toContain("\n\n\n<!-- unrelated spacing -->");
    expect(state(proj)).toContain("\n\n\n## Current Status");
  });

  test("cross-shard activity tied with a jump is outside the new team attempt", () => {
    const proj = seedProject(
      { ownership: "team", rhythm: "unit-end" },
      ["alpha"],
    );
    const ts = "2026-08-20T00:00:00Z";
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(
      join(seededAuditDir(proj), "zzzz-activity.md"),
      `## UNIT_STARTED\n**Timestamp**: ${ts}\n**Event**: UNIT_STARTED\n` +
        "**Stage**: functional-design\n**Unit**: alpha\n**Run floor**: unstarted#0\n\n---\n",
    );
    writeFileSync(
      join(seededAuditDir(proj), "aaaa-jump.md"),
      `## STAGE_JUMPED\n**Timestamp**: ${ts}\n**Event**: STAGE_JUMPED\n` +
        "**Stage**: functional-design\n**Direction**: redo\n\n---\n",
    );
    expect(runState(proj, ["set-unit-gate-rhythm", "per-stage"]).rc).toBe(0);
  });
});
