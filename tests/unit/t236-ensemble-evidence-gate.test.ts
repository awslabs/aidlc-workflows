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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedBoltDag,
  seededAuditDir,
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
const PRACTICES_SUPPORTS = [
  "aidlc-quality-agent",
  "aidlc-developer-agent",
  "aidlc-devsecops-agent",
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

function practicesState(
  checkbox = "[?]",
  affirmedTimestamp = "",
): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: practices ensemble evidence test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
- **Practices Affirmed Timestamp**: ${affirmedTimestamp}

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [S] reverse-engineering — SKIP
- ${checkbox} practices-discovery — EXECUTE
- [ ] requirements-analysis — EXECUTE

## Current Status
- **Current Stage**: practices-discovery
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

function seedPracticesProject(
  checkbox = "[?]",
  affirmedTimestamp = "",
): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(
    seededStateFile(proj),
    practicesState(checkbox, affirmedTimestamp),
  );
  return proj;
}

function contribDir(
  proj: string,
  phase = "inception",
  stage = "user-stories",
): string {
  return join(seededRecordDir(proj), phase, stage, "contributions");
}

function writeContribution(
  proj: string,
  agent: string,
  firstLine?: string,
  phase = "inception",
  stage = "user-stories",
): void {
  const dir = contribDir(proj, phase, stage);
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
  const dir = seededAuditDir(proj);
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf-8"))
    .join("\n");
}

interface MutationSnapshot {
  state: string;
  audit: string;
}

function mutationSnapshot(proj: string): MutationSnapshot {
  return {
    state: readFileSync(seededStateFile(proj), "utf-8"),
    audit: auditText(proj),
  };
}

function eventCount(text: string, event: string): number {
  return text.split(`**Event**: ${event}`).length - 1;
}

function appendAuditEvent(
  proj: string,
  event: string,
  timestamp: string,
  fields: Record<string, string> = {},
): void {
  const shard = seededAuditShard(proj);
  mkdirSync(dirname(shard), { recursive: true });
  const lines = [
    "",
    `## ${event}`,
    `**Timestamp**: ${timestamp}`,
    `**Event**: ${event}`,
    ...Object.entries(fields).map(([key, value]) => `**${key}**: ${value}`),
    "",
    "---",
    "",
  ];
  writeFileSync(shard, lines.join("\n"), { flag: "a" });
}

function expectApprovalCommitted(
  proj: string,
  directive: Directive,
  before: MutationSnapshot,
  stage = "user-stories",
): void {
  expect(directive.kind, directive.message).toBe("done");
  const state = readFileSync(seededStateFile(proj), "utf-8");
  const audit = auditText(proj);
  expect(state).not.toBe(before.state);
  expect(state).toContain(`- [x] ${stage} — EXECUTE`);
  expect(audit).not.toBe(before.audit);
  expect(eventCount(audit, "GATE_APPROVED")).toBe(
    eventCount(before.audit, "GATE_APPROVED") + 1,
  );
  expect(eventCount(audit, "STAGE_COMPLETED")).toBe(
    eventCount(before.audit, "STAGE_COMPLETED") + 1,
  );
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

function perUnitEnsembleGraph(
  proj: string,
  mutate?: (node: Record<string, unknown>) => void,
): string {
  return graphVariant(proj, (node) => {
    node.phase = "construction";
    node.for_each = "unit-of-work";
    node.mode = "mob";
    node.support_agents = ["aidlc-design-agent"];
    node.produces = ["fixture-artifact"];
    node.optional_produces = [];
    mutate?.(node);
  });
}

function seedSwarmConverged(proj: string, units: string[]): void {
  // Rows carry the attempt-identity stamp (Stage + Run floor) the consumers
  // require; the fixture audit has no STAGE_STARTED for the stage, so the
  // matching floor is "".
  const shard = seededAuditShard(proj);
  mkdirSync(dirname(shard), { recursive: true });
  const blocks = units.map((unit, index) =>
    [
      "## Swarm Unit Converged",
      `**Timestamp**: 2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z`,
      "**Event**: SWARM_UNIT_CONVERGED",
      `**Unit name**: ${unit}`,
      "**Stage**: user-stories",
      "**Run floor**: ",
      "",
      "---",
      "",
    ].join("\n")
  ).join("");
  writeFileSync(shard, blocks, { flag: "a" });
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

function writeFallbackContribution(proj: string, agent: string): void {
  const dir = join(
    seededRecordDir(proj),
    "construction",
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
  test("awaiting-approval and revised refuse before [?] when ensemble evidence is incomplete", () => {
    for (const [checkbox, result] of [
      ["[-]", "awaiting-approval"],
      ["[R]", "revised"],
    ] as const) {
      const proj = seedProject(checkbox);
      const before = mutationSnapshot(proj);
      const d = runReport(proj, [
        "--stage",
        "user-stories",
        "--result",
        result,
      ]);
      expect(d.kind, result).toBe("error");
      expect(d.message, result).toContain("ensemble must convene");
      expect(readFileSync(seededStateFile(proj), "utf-8"), result).toBe(
        before.state,
      );
      expect(auditText(proj), result).toBe(before.audit);
    }
  });

  test("awaiting-approval opens only after all contribution evidence exists", () => {
    const proj = seedProject("[-]");
    for (const agent of MOB_SUPPORTS) writeContribution(proj, agent);
    const d = runReport(proj, [
      "--stage",
      "user-stories",
      "--result",
      "awaiting-approval",
    ]);
    expect(d.kind, d.message).toBe("print");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
      "- [?] user-stories — EXECUTE",
    );
  });

  test("awaiting-approval refuses while any per-unit artifact is uncovered", () => {
    const proj = seedProject("[-]");
    const graph = perUnitEnsembleGraph(proj);
    seedBoltDag(proj, ["alpha", "beta"]);
    writeUnitArtifact(proj, "alpha");
    writeUnitContribution(proj, "alpha", "aidlc-design-agent");
    writeUnitContribution(proj, "beta", "aidlc-design-agent");
    const d = runReport(
      proj,
      [
        "--stage",
        "user-stories",
        "--result",
        "awaiting-approval",
      ],
      { AIDLC_STAGE_GRAPH: graph },
    );
    expect(d.kind).toBe("error");
    expect(d.message).toContain("1 of 2 units are not yet complete (beta)");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
      "- [-] user-stories — EXECUTE",
    );
  });

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

  test("all three contribution files well-formed -> approval commits state and audit", () => {
    const proj = seedProject();
    for (const agent of MOB_SUPPORTS) writeContribution(proj, agent);
    const before = mutationSnapshot(proj);
    const d = report(proj);
    expectApprovalCommitted(proj, d, before);
  });

  test("escape hatch AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1 commits approval", () => {
    const proj = seedProject();
    const before = mutationSnapshot(proj);
    const d = report(proj, { AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1" });
    expectApprovalCommitted(proj, d, before);
  });

  test("already-completed current stage recovers forward without evidence", () => {
    const proj = seedProject("[x]");
    const before = mutationSnapshot(proj);
    const d = report(proj);
    expect(d.kind).toBe("done");
    const state = readFileSync(seededStateFile(proj), "utf-8");
    const audit = auditText(proj);
    expect(state).not.toBe(before.state);
    expect(state).not.toContain("- **Current Stage**: user-stories");
    expect(audit).not.toBe(before.audit);
    expect(eventCount(audit, "STAGE_STARTED")).toBe(
      eventCount(before.audit, "STAGE_STARTED") + 1,
    );
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

  test("report --result skipped commits before ensemble evidence is checked", () => {
    const proj = seedProject("[-]");
    const before = mutationSnapshot(proj);
    const d = runReport(proj, [
      "--stage",
      "user-stories",
      "--result",
      "skipped",
      "--reason",
      "No user-facing workflow in this intent",
    ]);

    expect(d.kind).toBe("done");
    expect(d.message ?? "").not.toContain("ensemble must convene");
    const state = readFileSync(seededStateFile(proj), "utf-8");
    const audit = auditText(proj);
    expect(state).not.toBe(before.state);
    expect(state).toContain("- [S] user-stories — EXECUTE");
    expect(state).toContain("- **Current Stage**: refined-mockups");
    expect(eventCount(audit, "STAGE_SKIPPED")).toBe(
      eventCount(before.audit, "STAGE_SKIPPED") + 1,
    );
    expect(eventCount(audit, "STAGE_STARTED")).toBe(
      eventCount(before.audit, "STAGE_STARTED") + 1,
    );
    expect(eventCount(audit, "STAGE_COMPLETED")).toBe(
      eventCount(before.audit, "STAGE_COMPLETED"),
    );
    expect(eventCount(audit, "GATE_APPROVED")).toBe(
      eventCount(before.audit, "GATE_APPROVED"),
    );
  });

  test("report --single --result skipped remains rejected without mutation", () => {
    const proj = seedProject("[-]");
    const before = mutationSnapshot(proj);
    const d = runReport(proj, [
      "--single",
      "--stage",
      "user-stories",
      "--result",
      "skipped",
      "--reason",
      "single-stage runners cannot route workflow skips",
    ]);

    expect(d.kind).toBe("error");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before.state);
    expect(auditText(proj)).toBe(before.audit);
  });

  test("per-unit ensemble evidence is required and accepted under every unit stage directory", () => {
    const missingProj = seedProject();
    const missingGraph = perUnitEnsembleGraph(missingProj);
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
    const completeGraph = perUnitEnsembleGraph(completeProj);
    seedBoltDag(completeProj, ["alpha", "beta"]);
    writeUnitArtifact(completeProj, "alpha");
    writeUnitArtifact(completeProj, "beta");
    writeUnitContribution(completeProj, "alpha", "aidlc-design-agent");
    writeUnitContribution(completeProj, "beta", "aidlc-design-agent");
    const before = mutationSnapshot(completeProj);
    const complete = report(completeProj, { AIDLC_STAGE_GRAPH: completeGraph });
    expectApprovalCommitted(completeProj, complete, before);
  });

  test("kind-pruned units that never execute do not owe contribution files", () => {
    const proj = seedProject();
    const graph = perUnitEnsembleGraph(proj, (node) => {
      node.produces_kinds = {
        "fixture-artifact": ["service"],
      };
    });
    seedBoltDag(proj, [
      { name: "pack", kind: "packaging" },
      { name: "svc", kind: "service" },
    ]);
    writeUnitArtifact(proj, "svc");
    writeUnitContribution(proj, "svc", "aidlc-design-agent");

    const before = mutationSnapshot(proj);
    const d = report(proj, { AIDLC_STAGE_GRAPH: graph });
    expect(d.message ?? "").not.toContain('aidlc-design-agent for unit "pack"');
    expectApprovalCommitted(proj, d, before);
  });

  test("no-DAG per-unit fallback still requires stage-level ensemble evidence", () => {
    const missingProj = seedProject();
    const missingGraph = perUnitEnsembleGraph(missingProj);
    const missing = report(missingProj, { AIDLC_STAGE_GRAPH: missingGraph });
    expect(missing.kind).toBe("error");
    expect(missing.message).toContain("aidlc-design-agent (no contribution file)");
    expect(missing.message).toContain(
      "construction/user-stories/contributions/<agent-slug>.md",
    );

    const completeProj = seedProject();
    const completeGraph = perUnitEnsembleGraph(completeProj);
    writeFallbackContribution(completeProj, "aidlc-design-agent");
    const before = mutationSnapshot(completeProj);
    const complete = report(completeProj, {
      AIDLC_STAGE_GRAPH: completeGraph,
    });
    expectApprovalCommitted(completeProj, complete, before);
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

  test("Practices Discovery subagent spokes require all three contribution files", () => {
    const proj = seedPracticesProject();
    const d = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expect(d.kind).toBe("error");
    for (const agent of PRACTICES_SUPPORTS) {
      expect(d.message).toContain(`${agent} (no contribution file)`);
    }
    expect(d.message).toContain(
      "inception/practices-discovery/contributions/<agent-slug>.md",
    );
  });

  test("Practices Discovery cannot open its gate before all spoke evidence exists", () => {
    const missingProj = seedPracticesProject("[-]");
    const missingBefore = mutationSnapshot(missingProj);
    const missing = runReport(missingProj, [
      "--stage",
      "practices-discovery",
      "--result",
      "awaiting-approval",
    ]);
    expect(missing.kind).toBe("error");
    expect(missing.message).toContain("ensemble must convene");
    expect(readFileSync(seededStateFile(missingProj), "utf-8")).toBe(
      missingBefore.state,
    );
    expect(auditText(missingProj)).toBe(missingBefore.audit);

    const completeProj = seedPracticesProject("[-]");
    for (const agent of PRACTICES_SUPPORTS) {
      writeContribution(
        completeProj,
        agent,
        undefined,
        "inception",
        "practices-discovery",
      );
    }
    const completeBefore = mutationSnapshot(completeProj);
    const complete = runReport(completeProj, [
      "--stage",
      "practices-discovery",
      "--result",
      "awaiting-approval",
    ]);
    expect(complete.kind, complete.message).toBe("print");
    expect(readFileSync(seededStateFile(completeProj), "utf-8")).toContain(
      "- [?] practices-discovery — EXECUTE",
    );
    expect(eventCount(auditText(completeProj), "STAGE_AWAITING_APPROVAL")).toBe(
      eventCount(completeBefore.audit, "STAGE_AWAITING_APPROVAL") + 1,
    );
  });

  test("Practices Discovery approval requires a fresh promotion receipt after all spoke evidence exists", () => {
    const proj = seedPracticesProject();
    for (const agent of PRACTICES_SUPPORTS) {
      writeContribution(
        proj,
        agent,
        undefined,
        "inception",
        "practices-discovery",
      );
    }

    const unpromotedBefore = mutationSnapshot(proj);
    const unpromoted = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expect(unpromoted.kind).toBe("error");
    expect(unpromoted.message).toContain(
      "before practices-promote succeeds",
    );
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(
      unpromotedBefore.state,
    );
    expect(auditText(proj)).toBe(unpromotedBefore.audit);

    writeFileSync(
      seededStateFile(proj),
      practicesState("[?]", "not-an-iso-instant"),
    );
    const malformedBefore = mutationSnapshot(proj);
    const malformed = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expect(malformed.kind).toBe("error");
    expect(malformed.message).toContain(
      "before practices-promote succeeds",
    );
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(
      malformedBefore.state,
    );
    expect(auditText(proj)).toBe(malformedBefore.audit);

    writeFileSync(
      seededStateFile(proj),
      practicesState("[?]", "2026-07-17T14:00:00Z"),
    );
    const forgedBefore = mutationSnapshot(proj);
    const forged = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expect(forged.kind).toBe("error");
    expect(forged.message).toContain("before practices-promote succeeds");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(
      forgedBefore.state,
    );
    expect(auditText(proj)).toBe(forgedBefore.audit);

    appendAuditEvent(proj, "PRACTICES_AFFIRMED", "2026-07-17T14:00:00Z");
    appendAuditEvent(
      proj,
      "STAGE_STARTED",
      "2026-07-17T14:01:00Z",
      { Stage: "practices-discovery", Agent: "aidlc-pipeline-deploy-agent" },
    );
    const staleBefore = mutationSnapshot(proj);
    const stale = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expect(stale.kind).toBe("error");
    expect(stale.message).toContain("fresh PRACTICES_AFFIRMED receipt");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(
      staleBefore.state,
    );
    expect(auditText(proj)).toBe(staleBefore.audit);

    writeFileSync(
      seededStateFile(proj),
      practicesState("[?]", "2026-07-17T14:03:00Z"),
    );
    appendAuditEvent(proj, "PRACTICES_AFFIRMED", "2026-07-17T14:02:00Z");
    const mismatchedBefore = mutationSnapshot(proj);
    const mismatched = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expect(mismatched.kind).toBe("error");
    expect(mismatched.message).toContain("fresh PRACTICES_AFFIRMED receipt");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(
      mismatchedBefore.state,
    );
    expect(auditText(proj)).toBe(mismatchedBefore.audit);

    writeFileSync(
      seededStateFile(proj),
      practicesState("[?]", "2026-07-17T14:02:00Z"),
    );
    const before = mutationSnapshot(proj);
    const fresh = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expectApprovalCommitted(proj, fresh, before, "practices-discovery");
  });

  test("a rejection after promotion invalidates the receipt until the drafts are re-promoted", () => {
    const proj = seedPracticesProject();
    for (const agent of PRACTICES_SUPPORTS) {
      writeContribution(
        proj,
        agent,
        undefined,
        "inception",
        "practices-discovery",
      );
    }
    writeFileSync(
      seededStateFile(proj),
      practicesState("[?]", "2026-07-17T14:02:00Z"),
    );
    appendAuditEvent(proj, "PRACTICES_AFFIRMED", "2026-07-17T14:02:00Z");
    // The human rejects AFTER promotion: the drafts change, the receipt
    // authorizes content that no longer exists.
    appendAuditEvent(proj, "GATE_REJECTED", "2026-07-17T14:05:00Z", {
      Stage: "practices-discovery",
      Feedback: "tighten the testing posture",
    });
    appendAuditEvent(proj, "STAGE_REVISING", "2026-07-17T14:05:00Z", {
      Stage: "practices-discovery",
      "Revision count": "1",
    });
    appendAuditEvent(proj, "STAGE_AWAITING_APPROVAL", "2026-07-17T14:08:00Z", {
      Stage: "practices-discovery",
    });

    const staleBefore = mutationSnapshot(proj);
    const stale = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expect(stale.kind).toBe("error");
    expect(stale.message).toContain("fresh PRACTICES_AFFIRMED receipt");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(
      staleBefore.state,
    );
    expect(auditText(proj)).toBe(staleBefore.audit);

    // Re-promotion after the rejection restores approval.
    writeFileSync(
      seededStateFile(proj),
      practicesState("[?]", "2026-07-17T14:09:00Z"),
    );
    appendAuditEvent(proj, "PRACTICES_AFFIRMED", "2026-07-17T14:09:00Z");
    const before = mutationSnapshot(proj);
    const repromoted = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expectApprovalCommitted(proj, repromoted, before, "practices-discovery");
  });

  test("an unrelated stage's rejection does not invalidate the practices receipt", () => {
    const proj = seedPracticesProject();
    for (const agent of PRACTICES_SUPPORTS) {
      writeContribution(
        proj,
        agent,
        undefined,
        "inception",
        "practices-discovery",
      );
    }
    writeFileSync(
      seededStateFile(proj),
      practicesState("[?]", "2026-07-17T14:02:00Z"),
    );
    appendAuditEvent(
      proj,
      "STAGE_STARTED",
      "2026-07-17T14:01:00Z",
      { Stage: "practices-discovery", Agent: "aidlc-pipeline-deploy-agent" },
    );
    appendAuditEvent(proj, "PRACTICES_AFFIRMED", "2026-07-17T14:02:00Z");
    appendAuditEvent(proj, "GATE_REJECTED", "2026-07-17T14:05:00Z", {
      Stage: "user-stories",
      Feedback: "different stage entirely",
    });
    appendAuditEvent(proj, "STAGE_REVISING", "2026-07-17T14:05:00Z", {
      Stage: "user-stories",
      "Revision count": "1",
    });

    const before = mutationSnapshot(proj);
    const approved = runReport(proj, [
      "--stage",
      "practices-discovery",
      "--result",
      "approved",
      "--user-input",
      "Approve",
    ]);
    expectApprovalCommitted(proj, approved, before, "practices-discovery");
  });

  // The swarm exemption never applies to the scope's FIRST construction stage
  // (isSkeletonGateStage: the skeleton gate always runs inline, so disk-backed
  // guards stay correct there). The fixtures below therefore also pivot an
  // EARLIER stage into construction so the mutated user-stories is not the
  // skeleton gate - matching the real swarm stage (code-generation, 3.5).
  function nonSkeletonSwarmGraph(proj: string): string {
    const path = perUnitEnsembleGraph(proj, (node) => {
      node.mode = "subagent";
    });
    const graph = JSON.parse(readFileSync(path, "utf-8")) as Array<Record<string, unknown>>;
    const earlier = graph.find((entry) => entry.slug === "requirements-analysis");
    if (!earlier) throw new Error("fixture graph has no requirements-analysis node");
    earlier.phase = "construction";
    writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
    return path;
  }

  test("MID-RUN autonomous swarm fails closed until every unit converges", () => {
    const proj = seedProject();
    setAutonomous(proj);
    seedBoltDag(proj, ["unit-a", "unit-b"]);
    const graph = nonSkeletonSwarmGraph(proj);
    // No convergence rows, no contribution files anywhere: mid-run.
    const d = report(proj, { AIDLC_STAGE_GRAPH: graph });
    expect(d.kind).toBe("error");
    expect(d.message).toContain("(unit-a, unit-b)");
    expect(d.message).toContain("not yet complete");
  });

  test("a malformed swarm DAG fails closed because the expected unit set is unknowable", () => {
    const proj = seedProject();
    setAutonomous(proj);
    const depDir = join(seededRecordDir(proj), "inception", "units-generation");
    mkdirSync(depDir, { recursive: true });
    writeFileSync(
      join(depDir, "unit-of-work-dependency.md"),
      "# Corrupted\n\nno fenced units block here\n",
    );
    const graph = nonSkeletonSwarmGraph(proj);
    const d = report(proj, { AIDLC_STAGE_GRAPH: graph });
    expect(d.kind).toBe("error");
    expect(d.message).toContain("unit list cannot be resolved");
  });

  test("a fully converged autonomous swarm is exempt from main-tree evidence", () => {
    // Swarm artifacts and contributions remain in Bolt worktrees. Once every
    // valid-DAG unit has a current-run convergence row, the audit ledger is the
    // completion proof and main-tree disk guards must stand down.
    const proj = seedProject();
    setAutonomous(proj);
    seedBoltDag(proj, ["unit-a", "unit-b"]);
    seedSwarmConverged(proj, ["unit-a", "unit-b"]);
    const graph = nonSkeletonSwarmGraph(proj);
    const before = mutationSnapshot(proj);
    const d = report(proj, { AIDLC_STAGE_GRAPH: graph });
    expectApprovalCommitted(proj, d, before);
  });

  test("report --single on a per-unit ensemble stage checks STAGE-level evidence, not the main DAG", () => {
    // emitSingleRunStage never names a real unit ({unit-name} placeholder), so
    // --single must not demand per-unit contribution sets from the MAIN
    // workflow's DAG. Stage-level evidence still applies.
    const missingProj = seedProject();
    seedBoltDag(missingProj, ["unit-a", "unit-b"]);
    const missingGraph = perUnitEnsembleGraph(missingProj);
    const missing = runReport(missingProj, [
      "--single", "--stage", "user-stories", "--result", "approved",
    ], { AIDLC_STAGE_GRAPH: missingGraph });
    expect(missing.kind).toBe("error");
    // Refused at the STAGE level (no per-unit paths in the remediation).
    expect(missing.message).toContain("aidlc-design-agent (no contribution file)");
    expect(missing.message).not.toContain("for unit \"unit-a\"");

    const completeProj = seedProject();
    seedBoltDag(completeProj, ["unit-a", "unit-b"]);
    const completeGraph = perUnitEnsembleGraph(completeProj);
    writeFallbackContribution(completeProj, "aidlc-design-agent");
    const before = mutationSnapshot(completeProj);
    const complete = runReport(completeProj, [
      "--single", "--stage", "user-stories", "--result", "approved",
    ], { AIDLC_STAGE_GRAPH: completeGraph });
    expect(complete.kind).toBe("done");
    expect(readFileSync(seededStateFile(completeProj), "utf-8")).toBe(before.state);
    const afterAudit = auditText(completeProj);
    expect(afterAudit).not.toBe(before.audit);
    expect(eventCount(afterAudit, "STAGE_STARTED")).toBe(
      eventCount(before.audit, "STAGE_STARTED") + 1,
    );
    expect(eventCount(afterAudit, "STAGE_COMPLETED")).toBe(
      eventCount(before.audit, "STAGE_COMPLETED") + 1,
    );
  });
});
