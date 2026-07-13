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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

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

function report(proj: string, env: Record<string, string | undefined> = {}): Directive {
  const r = spawnSync(
    BUN,
    [
      ORCH,
      "report",
      "--stage",
      "user-stories",
      "--result",
      "approved",
      "--user-input",
      "Approve",
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
});
