// covers: function:failedCheckNotices, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next
//
// A check (sensor) that fails on a stage's output writes an audit row and a
// detail file, and until now that was the end of it: no harness told the agent
// or the person, so a conductor said "every requirement traced" and asked for
// approval while the traceability check reported 68 gaps (#2201). When a gate
// opens, or is shown again, the engine's reply now carries one sentence per
// check that still fails on a declared output in its `narration`, on its own
// line after what the stage produced (which stays whole), and the agent says it
// to the person with the approval question. The change lines stay what changed (the guard matrix counts them).
// Nothing is refused and nothing is re-fired: a check that passed later, or
// never ran, says nothing. The gate-open audit row's `Sensor State` is unchanged.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { artifactFilename, auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STAGE = "feasibility"; // state-mid-ideation.md: Current Stage feasibility, Scope feature
const DETAIL = (fireId: string) => `.aidlc-engine/sensors/${fireId}.json`;

let proj: string;

function envFor(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = "1";
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  // No sensor runs during the test: the lines read the checks the audit holds.
  // (The lines do not read this switch; the person's and the scope's do count.)
  env.AIDLC_DISABLE_SENSORS = "1";
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  Object.assign(env, extra);
  return env;
}

function run(tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env = envFor(extra);
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The engine's reply: the one JSON object a command prints.
function reply(tool: string, args: string[], extra: Record<string, string> = {}): Record<string, unknown> {
  const r = run(tool, args, extra);
  const line = r.out.split("\n").find((entry) => entry.startsWith("{"));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

function writeArtifact(name: string): string {
  const dir = join(seededRecordDir(proj), "ideation", STAGE);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `# ${name}\n\nContent.\n`);
  return path;
}

// The dispatcher records an artifact's Output path project-relative with
// forward slashes on every OS; the rows the gate reads are keyed the same way.
function outputPath(absolute: string): string {
  return relative(proj, absolute).split(sep).join("/");
}

function sensorRow(
  event: "SENSOR_PASSED" | "SENSOR_FAILED",
  fireId: string,
  outputRel: string,
  findings = 1,
  sensorId = "required-sections",
  note?: string,
): void {
  appendAuditEntry(event, {
    "Fire id": fireId,
    "Sensor ID": sensorId,
    "Stage slug": STAGE,
    "Output path": outputRel,
    ...(event === "SENSOR_PASSED"
      ? { "Duration ms": "12", ...(note ? { Note: note } : {}) }
      : { "Detail path": DETAIL(fireId), "Findings count": String(findings) }),
  }, proj);
}

// The gate shown again. The fixture has no hook heartbeat (no chat ran here), so
// the presence check that stops `next` on a record whose hooks never ran is
// skipped: what is under test is the gate's lines, not that stop.
function shownAgain(): Record<string, unknown> {
  return reply(ORCHESTRATE, ["next"], { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
}

function openGate(): Record<string, unknown> {
  expect(run(STATE, ["checkbox", `${STAGE}=in-progress`]).rc).toBe(0);
  return reply(ORCHESTRATE, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
}

describe("t-gate-names-failed-checks: a check that still fails is said with the gate", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    // `next` loads the space memory with the stage it shows again.
    seedAidlcMemory(proj);
  });
  afterEach(() => cleanupTestProject(proj));

  test("opening the gate names the failing check, the file, the count and the detail file, in one line", () => {
    const rel = outputPath(writeArtifact("feasibility-assessment"));
    sensorRow("SENSOR_FAILED", "aaaa0002", rel, 3);
    const opened = openGate();
    expect(opened.narration).toContain(
      `The required-sections check reports 3 findings in feasibility-assessment.md (details: ${DETAIL("aaaa0002")}).`,
    );
    // The change lines stay what changed: a failing check is not a change.
    expect(opened.change_notices).toBeUndefined();
    // The record keeps what it kept before: the row's field is the same string.
    const row = readAuditShardEvents(proj).filter((r) => r.event === "STAGE_AWAITING_APPROVAL").at(-1);
    expect(row).toBeDefined();
    expect(auditBlockField(row!.block, "Sensor State") ?? "").toContain(`required-sections@${rel}=failed(3)`);
  });

  test("the gate shown again carries the line; once the check passes, nothing is said", () => {
    const rel = outputPath(writeArtifact("feasibility-assessment"));
    sensorRow("SENSOR_FAILED", "aaaa0002", rel, 1);
    openGate();
    const shown = shownAgain();
    expect(shown.gate_only, JSON.stringify(shown)).toBe(true);
    expect(shown.narration).toContain(
      `The required-sections check reports 1 finding in feasibility-assessment.md (details: ${DETAIL("aaaa0002")}).`,
    );
    expect(shown.change_notices).toBeUndefined();
    sensorRow("SENSOR_PASSED", "aaaa0003", rel);
    const again = shownAgain();
    expect(again.gate_only, JSON.stringify(again)).toBe(true);
    expect(String(again.narration ?? "")).not.toContain("check reports");
  });

  test("the latest result wins, and a check that never ran says nothing", () => {
    const rel = outputPath(writeArtifact("feasibility-assessment"));
    sensorRow("SENSOR_FAILED", "aaaa0002", rel, 3);
    sensorRow("SENSOR_PASSED", "aaaa0003", rel);
    writeArtifact("constraint-register");
    const opened = openGate();
    expect(String(opened.narration ?? "")).not.toContain("check reports");
    expect(opened.change_notices).toBeUndefined();
  });

  test("more than three failing checks are three lines and a count", () => {
    const assessment = outputPath(writeArtifact("feasibility-assessment"));
    const register = outputPath(writeArtifact("constraint-register"));
    const raid = outputPath(writeArtifact("raid-log"));
    sensorRow("SENSOR_FAILED", "aaaa0001", assessment, 2);
    sensorRow("SENSOR_FAILED", "aaaa0002", register, 1);
    sensorRow("SENSOR_FAILED", "aaaa0003", raid, 4);
    sensorRow("SENSOR_FAILED", "aaaa0004", assessment, 5, "upstream-coverage");
    const narration = String(openGate().narration ?? "");
    expect(narration.match(/The [a-z-]+ check reports \d+ findings? in [a-z-]+\.md \(details: /g) ?? []).toHaveLength(3);
    expect(narration).toContain("1 more check reports findings on this stage's outputs.");
  });

  test("with Sensors switched off, the gate says nothing about the checks; the record keeps them", () => {
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace("- **Scope**: feature\n", "- **Scope**: feature\n- **Sensors**: off (set by you)\n"),
    );
    const rel = outputPath(writeArtifact("feasibility-assessment"));
    sensorRow("SENSOR_FAILED", "aaaa0002", rel, 3);
    const opened = openGate();
    expect(String(opened.narration ?? "")).not.toContain("check reports");
    expect(opened.change_notices).toBeUndefined();
    // The gate row still records what the checks said: only the person's line is silent.
    const row = readAuditShardEvents(proj).filter((r) => r.event === "STAGE_AWAITING_APPROVAL").at(-1);
    expect(auditBlockField(row!.block, "Sensor State") ?? "").toContain(`required-sections@${rel}=failed(3)`);
    const shown = shownAgain();
    expect(shown.gate_only, JSON.stringify(shown)).toBe(true);
    expect(String(shown.narration ?? "")).not.toContain("check reports");
  });

  test("a pass that carries a note evaluated nothing: the failure before it is still said", () => {
    const rel = outputPath(writeArtifact("feasibility-assessment"));
    sensorRow("SENSOR_FAILED", "aaaa0002", rel, 3);
    sensorRow("SENSOR_PASSED", "aaaa0003", rel, 1, "required-sections", "tool-unavailable");
    const opened = openGate();
    expect(opened.narration).toContain(
      `The required-sections check reports 3 findings in feasibility-assessment.md (details: ${DETAIL("aaaa0002")}).`,
    );
    sensorRow("SENSOR_PASSED", "aaaa0004", rel);
    const again = shownAgain();
    expect(again.gate_only, JSON.stringify(again)).toBe(true);
    expect(String(again.narration ?? "")).not.toContain("check reports");
  });
});

// A team's Unit gate speaks for that Unit's outputs: two Units at the same
// per-unit stage, each with a check failing on its own functional-spec, and
// alpha's gate names alpha's only (the team progress-gates test's fixture shape).
describe("t-gate-names-failed-checks: a team's Unit gate names that Unit's outputs only", () => {
  const UNIT_STAGE = "functional-design";
  const UNIT_PRODUCES = ["entities", "rules", "functional-spec", "frontend-components", "traceability"];
  const TEAM_STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: team unit gate test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: team
- **Unit Gate Rhythm**: per-stage
- **Review Override**: none

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design \u2014 EXECUTE
- [ ] nfr-requirements \u2014 EXECUTE
- [ ] nfr-design \u2014 EXECUTE
- [ ] infrastructure-design \u2014 EXECUTE
- [ ] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`;
  const TEAM_ENV = { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };

  function unitArtifact(unit: string, name: string): string {
    const dir = join(seededRecordDir(proj), "construction", unit, UNIT_STAGE);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, artifactFilename(name));
    writeFileSync(path, `# ${name} for ${unit}\n`);
    return path;
  }

  function unitFailure(fireId: string, unit: string, outputRel: string, findings: number): void {
    appendAuditEntry("SENSOR_FAILED", {
      "Fire id": fireId,
      "Sensor ID": "required-sections",
      "Stage slug": UNIT_STAGE,
      Unit: unit,
      "Output path": outputRel,
      "Detail path": DETAIL(fireId),
      "Findings count": String(findings),
    }, proj);
  }

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedAidlcMemory(proj);
    writeFileSync(seededStateFile(proj), TEAM_STATE);
    seedBoltDag(proj, ["alpha", "beta"]);
  });
  afterEach(() => cleanupTestProject(proj));

  test("alpha's gate names alpha's failing check, not beta's, when opened and when shown again", () => {
    // The walk opens alpha's stage run; its body is started, written (a check
    // fails on its functional-spec) and completed, as a team member's would be.
    // The walk's first step delivers the rules in parts before the stage run.
    const opened = runOrchestrateNext(ORCHESTRATE, proj, [], { env: envFor(TEAM_ENV) });
    const first = (opened.directive ?? {}) as Record<string, unknown>;
    expect(first.kind, JSON.stringify(opened)).toBe("run-stage");
    expect(first.unit, JSON.stringify(first)).toBe("alpha");
    const started = run(STATE, ["unit", "start", "--stage", UNIT_STAGE, "--unit", "alpha"], TEAM_ENV);
    expect(started.rc, started.out).toBe(0);
    const specs: Record<string, string> = {};
    for (const name of UNIT_PRODUCES) {
      const path = unitArtifact("alpha", name);
      if (name === "functional-spec") specs.alpha = outputPath(path);
    }
    unitFailure("aaaa0011", "alpha", specs.alpha, 2);
    const completed = run(STATE, ["unit", "complete", "--stage", UNIT_STAGE, "--unit", "alpha"], TEAM_ENV);
    expect(completed.rc, completed.out).toBe(0);
    // Beta's outputs, written by another member, with a check failing on them too.
    for (const name of UNIT_PRODUCES) {
      const path = unitArtifact("beta", name);
      if (name === "functional-spec") specs.beta = outputPath(path);
    }
    unitFailure("aaaa0012", "beta", specs.beta, 5);
    const gate = reply(ORCHESTRATE, ["report", "--stage", UNIT_STAGE, "--unit", "alpha", "--result", "awaiting-approval"], TEAM_ENV);
    expect(gate.kind, JSON.stringify(gate)).toBe("print");
    const narration = String(gate.narration ?? "");
    expect(narration).toContain(
      `The required-sections check reports 2 findings in functional-spec.md (details: ${DETAIL("aaaa0011")}).`,
    );
    expect(narration).not.toContain("5 findings");
    expect(gate.change_notices).toBeUndefined();
    // The gate shown again is alpha's, and says nothing of beta's checks. (A
    // per-unit beat's narration is the engine's own short line, or silence at
    // a gate, so the check line is heard when the Unit's gate opens.)
    const again = runOrchestrateNext(ORCHESTRATE, proj, [], { env: envFor(TEAM_ENV) });
    const shown = (again.directive ?? {}) as Record<string, unknown>;
    expect(shown.unit, JSON.stringify(again)).toBe("alpha");
    expect(String(shown.narration ?? "")).not.toContain("5 findings");
  });
});
