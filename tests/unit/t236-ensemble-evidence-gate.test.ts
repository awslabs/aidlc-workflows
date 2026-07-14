// covers: subcommand:aidlc-orchestrate:report
//
// t236 — the ensemble evidence gate (2.5.0). On a mob stage (or a
// hub-and-spoke subagent stage with declared support_agents), the
// collaborators' contribution files are the deterministic proof the ensemble
// convened (stage-protocol §5 "Completion evidence"): one file per declared
// support agent at <record>/<phase>/<slug>/contributions/<agent-slug>.md
// whose FIRST line is `**Collaborator:** <agent-slug>` verbatim. handleReport
// refuses `--result approved` while any is missing or malformed, naming the
// gap and the remediation; AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1 is the escape
// hatch; inline and pipeline stages carry no requirement; an already-[x]
// stage is an idempotent replay and is never blocked.
//
// SOURCE UNDER TEST: the ensemble-evidence guard in handleReport
// (dist/claude/.claude/tools/aidlc-orchestrate.ts) — not exported, so the
// behaviour is observed on the JSON the spawned engine emits. mechanism = cli
// (same process boundary t186 drives for the per-unit coverage guard).
//
// FIXTURE DISCIPLINE: fresh temp project per case (createTestProject seeds
// the workspace shell + default record); state pivots Current Stage to
// user-stories (the shipped mob stage: supports = design, developer, quality)
// marked in-flight; contribution files seeded per case. Temp dirs cleaned in
// afterEach.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  resetAidlcEnv,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SHIPPED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

// user-stories' declared support agents (verified frontmatter).
const MOB_SUPPORTS = [
  "aidlc-design-agent",
  "aidlc-developer-agent",
  "aidlc-quality-agent",
];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  message?: string;
  [k: string]: unknown;
}

/** Inception state pivoted to user-stories, in-flight ([?] awaiting gate). */
function inceptionState(checkbox = "[?]"): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: ensemble evidence test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] requirements-analysis — EXECUTE
- ${checkbox} user-stories — EXECUTE
- [ ] delivery-planning — EXECUTE

## Current Status
- **Current Stage**: user-stories
- **Lifecycle Phase**: INCEPTION
- **Status**: In Progress
`;
}

function seedProject(checkbox = "[?]"): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(seededStateFile(proj), inceptionState(checkbox));
  return proj;
}

function contribDir(proj: string): string {
  return join(seededRecordDir(proj), "inception", "user-stories", "contributions");
}

function writeContribution(proj: string, agent: string, firstLine?: string): void {
  const dir = contribDir(proj);
  mkdirSync(dir, { recursive: true });
  const marker = firstLine ?? `**Collaborator:** ${agent}`;
  writeFileSync(
    join(dir, `${agent}.md`),
    `${marker}\n\n## Contribution\n- a point\n\n## Positions\n- None\n`,
  );
}

function runReport(
  proj: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Directive {
  const r = spawnSync(
    BUN,
    [
      ORCH,
      "report",
      ...args,
      "--project-dir",
      proj,
    ],
    {
      encoding: "utf-8",
      cwd: proj,
      env: { ...process.env, ...env },
    },
  );
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Directive;
  } catch {
    return { kind: "unparseable", message: r.stdout + r.stderr };
  }
}

function report(proj: string, env: Record<string, string | undefined> = {}): Directive {
  return runReport(
    proj,
    [
      "--stage",
      "user-stories",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ],
    env,
  );
}

function reportSingle(proj: string): Directive {
  return runReport(proj, [
    "--single",
    "--stage",
    "user-stories",
    "--result",
    "approved",
  ]);
}

function auditText(proj: string): string {
  const path = seededAuditShard(proj);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function graphVariant(
  proj: string,
  mutate: (node: Record<string, unknown>) => void,
): string {
  const graph = JSON.parse(readFileSync(SHIPPED_GRAPH, "utf-8")) as Array<Record<string, unknown>>;
  const node = graph.find((entry) => entry.slug === "user-stories");
  if (!node) throw new Error("shipped graph has no user-stories node");
  mutate(node);
  const path = join(proj, "stage-graph-fixture.json");
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
  return path;
}

function seedBoltDag(proj: string, units: string[]): void {
  writeFileSync(
    join(seededRecordDir(proj), "runtime-graph.json"),
    `${JSON.stringify({
      bolt_dag: {
        units: units.map((name) => ({ name, depends_on: [] })),
        batches: [units],
      },
    }, null, 2)}\n`,
  );
}

function writeUnitContribution(proj: string, unit: string, agent: string): void {
  const dir = join(
    seededRecordDir(proj),
    "construction",
    unit,
    "user-stories",
    "contributions",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${agent}.md`),
    `**Collaborator:** ${agent}\n\n## Contribution\n- a point\n\n## Positions\n- None\n`,
  );
}

function writeUnitArtifact(proj: string, unit: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, "user-stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture-artifact.md"), `# Fixture artifact for ${unit}\n`);
}

function setAutonomous(proj: string): void {
  const path = seededStateFile(proj);
  const state = readFileSync(path, "utf-8").replace(
    /^(- \*\*Scope\*\*: .*)$/m,
    "$1\n- **Construction Autonomy Mode**: autonomous",
  );
  writeFileSync(path, state);
}

describe("t236 ensemble evidence gate — mob approval requires contribution files", () => {
  test("no contribution files -> approve refused, every missing agent named", () => {
    const proj = seedProject();
    const d = report(proj);
    expect(d.kind).toBe("error");
    for (const agent of MOB_SUPPORTS) {
      expect(d.message).toContain(agent);
    }
    expect(d.message).toContain("contributions/");
    expect(d.message).toContain("AIDLC_DISABLE_ENSEMBLE_EVIDENCE");
  });

  test("partial evidence -> refused, only the absent agents named", () => {
    const proj = seedProject();
    writeContribution(proj, "aidlc-design-agent");
    const d = report(proj);
    expect(d.kind).toBe("error");
    expect(d.message).not.toContain("aidlc-design-agent (");
    expect(d.message).toContain("aidlc-developer-agent (no contribution file)");
    expect(d.message).toContain("aidlc-quality-agent (no contribution file)");
  });

  test("file present but identity-marker first line wrong -> refused as malformed", () => {
    const proj = seedProject();
    for (const agent of MOB_SUPPORTS) writeContribution(proj, agent);
    // Overwrite one with a wrong first line.
    writeContribution(proj, "aidlc-quality-agent", "# Quality notes");
    const d = report(proj);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("aidlc-quality-agent (missing identity-marker first line)");
  });

  test("all three contribution files well-formed -> approve proceeds past the guard", () => {
    const proj = seedProject();
    for (const agent of MOB_SUPPORTS) writeContribution(proj, agent);
    const d = report(proj);
    // The guard passed; whatever the engine emits next, it is NOT the
    // ensemble-evidence refusal.
    expect(d.message ?? "").not.toContain("ensemble must convene");
  });

  test("escape hatch AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1 bypasses the guard", () => {
    const proj = seedProject();
    const d = report(proj, { AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1" });
    expect(d.message ?? "").not.toContain("ensemble must convene");
  });

  test("already-completed stage is an idempotent replay, never blocked", () => {
    const proj = seedProject("[x]");
    const d = report(proj);
    expect(d.message ?? "").not.toContain("ensemble must convene");
  });

  test("report --single refuses missing mob evidence without writing synthetic audit rows", () => {
    const proj = seedProject();
    const before = auditText(proj);
    const d = reportSingle(proj);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("aidlc-developer-agent");
    expect(d.message).toContain("ensemble must convene");
    expect(auditText(proj)).toBe(before);
  });

  test("per-unit ensemble evidence is required and accepted under every unit stage directory", () => {
    const missingProj = seedProject();
    const missingGraph = graphVariant(missingProj, (node) => {
      node.phase = "construction";
      node.for_each = "unit-of-work";
      node.mode = "mob";
      node.support_agents = ["aidlc-design-agent"];
      node.produces = ["fixture-artifact"];
      node.optional_produces = [];
    });
    seedBoltDag(missingProj, ["alpha", "beta"]);
    writeUnitArtifact(missingProj, "alpha");
    writeUnitArtifact(missingProj, "beta");
    writeUnitContribution(missingProj, "alpha", "aidlc-design-agent");
    const missing = report(missingProj, { AIDLC_STAGE_GRAPH: missingGraph });
    expect(missing.kind).toBe("error");
    expect(missing.message).toContain('aidlc-design-agent for unit "beta"');
    expect(missing.message).toContain(
      "construction/<unit>/user-stories/contributions/<agent-slug>.md",
    );

    const completeProj = seedProject();
    const completeGraph = graphVariant(completeProj, (node) => {
      node.phase = "construction";
      node.for_each = "unit-of-work";
      node.mode = "mob";
      node.support_agents = ["aidlc-design-agent"];
      node.produces = ["fixture-artifact"];
      node.optional_produces = [];
    });
    seedBoltDag(completeProj, ["alpha", "beta"]);
    writeUnitArtifact(completeProj, "alpha");
    writeUnitArtifact(completeProj, "beta");
    writeUnitContribution(completeProj, "alpha", "aidlc-design-agent");
    writeUnitContribution(completeProj, "beta", "aidlc-design-agent");
    const complete = report(completeProj, { AIDLC_STAGE_GRAPH: completeGraph });
    expect(complete.message ?? "").not.toContain("ensemble must convene");
  });

  test("autonomous subagent mode without real swarm eligibility still requires evidence", () => {
    const proj = seedProject();
    setAutonomous(proj);
    const graph = graphVariant(proj, (node) => {
      node.phase = "inception";
      delete node.for_each;
      node.mode = "subagent";
      node.support_agents = ["aidlc-design-agent"];
    });
    const d = report(proj, { AIDLC_STAGE_GRAPH: graph });
    expect(d.kind).toBe("error");
    expect(d.message).toContain("aidlc-design-agent (no contribution file)");
    expect(d.message).toContain("ensemble must convene");
  });
});
