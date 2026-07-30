// covers: subcommand:aidlc-state:unit, function:unitCompletedReceipts, function:activeUnitCheckpoint, audit:UNIT_STARTED, audit:UNIT_PAUSED, audit:UNIT_RESUMED, audit:UNIT_COMPLETED
//
// t260 — unit lifecycle receipts on inline per-unit Construction stages
// (issue 681, claims 1/2/9). The contract under test:
//
//   1. RECEIPTS, NOT ARTIFACTS, ARE THE TRANSITION. `unit complete` verifies
//      the unit's required artifacts on disk (refuses when missing) and only
//      then writes UNIT_COMPLETED; once any receipt exists for a stage, the
//      engine's coverage requires a receipt per unit, so artifacts written by
//      a paused/partial unit can never read as done.
//   2. SINGLE ACTIVE UNIT. `unit start` refuses while another unit of the
//      stage is open (started/resumed/paused, no terminal receipt), so a
//      resume/restart race cannot create two active units. Same-unit start is
//      an idempotent acknowledge.
//   3. PAUSE CARRIES THE CHECKPOINT. `unit pause` requires --reason and
//      --next-action, mirrors them into ## Runtime State (Active Unit / Unit
//      State / Unit Pause Reason / Unit Next Action), and the engine's `next`
//      hard-stops with an ask naming unit_state: paused until an explicit
//      `unit resume`. Approval entry is refused while a unit is paused.
//   4. LIFECYCLE ORDER. complete-while-paused refuses (resume first);
//      resume of a non-paused unit refuses; pause/complete of a non-active
//      unit refuses.
//
// Mechanism: cli — every step drives the real aidlc-state.ts / aidlc-orchestrate.ts
// through Bun.spawnSync against a seeded fixture project, and the receipt
// readers are asserted through the shipped aidlc-lib.ts exports.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  activeUnitCheckpoint,
  readAllAuditShards,
  unitCompletedReceipts,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SLUG = "functional-design"; // inline per-unit stage
const PRODUCES = ["business-logic-model", "business-rules", "domain-entities"];

// A minimal Construction state with functional-design in-flight and the
// skeleton stance recorded (mirrors t209's constructionState) — so the engine's
// per-unit walk runs instead of the classify round-trip, and the acted stage is
// genuinely in-progress for gate-start.
const CONSTRUCTION_STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: unit lifecycle receipts test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0

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

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-07-30T00:00:00Z
`;

function run(tool: string, args: string[], proj: string): { rc: number; out: string } {
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The suite sets AIDLC_SKIP_ARTIFACT_GUARD=1 globally; unit complete's
// artifact verification is a subject under test here, so clear it per spawn.
function unitVerb(proj: string, action: string, unit: string, extra: string[] = []) {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = spawnSync(
    BUN,
    [STATE, "unit", action, "--stage", SLUG, "--unit", unit, ...extra, "--project-dir", proj],
    { encoding: "utf-8", env },
  );
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function writeUnitArtifacts(proj: string, unit: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, SLUG);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES) {
    writeFileSync(join(dir, `${name}.md`), `# ${name}\nstub\n`, "utf-8");
  }
}

let proj = "";
function constructionProject(): string {
  proj = createTestProject();
  writeFileSync(seededStateFile(proj), CONSTRUCTION_STATE, "utf-8");
  seedBoltDag(proj, ["unit-a", "unit-b"]);
  return proj;
}
afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
});

describe("t260 receipts are the transition, artifacts the evidence", () => {
  test("complete refuses while required artifacts are missing, commits once they exist", () => {
    constructionProject();
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);

    const early = unitVerb(proj, "complete", "unit-a");
    expect(early.rc).not.toBe(0);
    expect(early.out).toContain("missing");
    expect(readAllAuditShards(proj)).not.toContain("UNIT_COMPLETED");

    writeUnitArtifacts(proj, "unit-a");
    const done = unitVerb(proj, "complete", "unit-a");
    expect(done.rc).toBe(0);
    expect(done.out).toContain("UNIT_COMPLETED");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    expect(activeUnitCheckpoint(proj, SLUG)).toBeNull();
  });

  test("artifacts without a receipt do not settle a unit once the ledger is in use", () => {
    constructionProject();
    // unit-a earns a real receipt; unit-b gets artifacts only.
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    writeUnitArtifacts(proj, "unit-a");
    expect(unitVerb(proj, "complete", "unit-a").rc).toBe(0);
    writeUnitArtifacts(proj, "unit-b");

    const receipts = unitCompletedReceipts(proj, SLUG);
    expect(receipts.has("unit-a")).toBe(true);
    expect(receipts.has("unit-b")).toBe(false);
  });

  test("unit verbs refuse on non-per-unit stages and unknown stages", () => {
    constructionProject();
    const notPerUnit = run(STATE, ["unit", "start", "--stage", "feasibility", "--unit", "u"], proj);
    expect(notPerUnit.rc).not.toBe(0);
    expect(notPerUnit.out).toContain("not per-unit");
    expect(run(STATE, ["unit", "start", "--stage", "no-such-stage", "--unit", "u"], proj).rc).not.toBe(0);
  });
});

describe("t260 single active unit", () => {
  test("a second unit cannot start while one is open; same-unit start acknowledges", () => {
    constructionProject();
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);

    const second = unitVerb(proj, "start", "unit-b");
    expect(second.rc).not.toBe(0);
    expect(second.out).toContain("One active unit");

    const again = unitVerb(proj, "start", "unit-a");
    expect(again.rc).toBe(0);
    expect(again.out).toContain("already_active");
    // no duplicate UNIT_STARTED row from the acknowledge
    const rows = readAllAuditShards(proj).match(/\*\*Event\*\*: UNIT_STARTED/g) ?? [];
    expect(rows.length).toBe(1);
  });

  test("pause/complete/resume validate against the active checkpoint", () => {
    constructionProject();
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    // pause/complete of a NON-active unit refuses
    expect(unitVerb(proj, "pause", "unit-b", ["--reason", "r", "--next-action", "n"]).rc).not.toBe(0);
    expect(unitVerb(proj, "complete", "unit-b").rc).not.toBe(0);
    // resume of a non-paused unit refuses
    expect(unitVerb(proj, "resume", "unit-a").rc).not.toBe(0);
  });
});

describe("t260 pause carries the checkpoint and hard-stops the engine", () => {
  function pauseUnitA(): void {
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    const p = unitVerb(proj, "pause", "unit-a", [
      "--reason", "blocked on auth contract",
      "--next-action", "confirm token flow, then finish business-rules.md",
    ]);
    expect(p.rc).toBe(0);
  }

  test("pause requires reason + next-action and mirrors them into runtime state", () => {
    constructionProject();
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    expect(unitVerb(proj, "pause", "unit-a").rc).not.toBe(0);
    expect(unitVerb(proj, "pause", "unit-a", ["--reason", "r"]).rc).not.toBe(0);

    const p = unitVerb(proj, "pause", "unit-a", ["--reason", "why", "--next-action", "what next"]);
    expect(p.rc).toBe(0);
    const state = readFileSync(seededStateFile(proj), "utf-8");
    expect(state).toContain("- **Active Unit**: unit-a");
    expect(state).toContain("- **Unit State**: paused");
    expect(state).toContain("- **Unit Pause Reason**: why");
    expect(state).toContain("- **Unit Next Action**: what next");

    const cp = activeUnitCheckpoint(proj, SLUG);
    expect(cp?.unit).toBe("unit-a");
    expect(cp?.state).toBe("paused");
    expect(cp?.reason).toBe("why");
    expect(cp?.nextAction).toBe("what next");
  });

  test("complete while paused refuses until an explicit resume", () => {
    constructionProject();
    pauseUnitA();
    writeUnitArtifacts(proj, "unit-a");

    const blocked = unitVerb(proj, "complete", "unit-a");
    expect(blocked.rc).not.toBe(0);
    expect(blocked.out).toContain("paused");

    expect(unitVerb(proj, "resume", "unit-a").rc).toBe(0);
    expect(unitVerb(proj, "complete", "unit-a").rc).toBe(0);
    // the checkpoint mirror is cleared on complete
    const state = readFileSync(seededStateFile(proj), "utf-8");
    expect(state).not.toContain("- **Active Unit**:");
    expect(state).not.toContain("- **Unit Pause Reason**:");
  });

  test("`next` emits a paused-unit ask (unit_state: paused) and names the checkpoint", () => {
    constructionProject();
    pauseUnitA();
    const r = run(ORCHESTRATE, ["next"], proj);
    expect(r.rc).toBe(0);
    expect(r.out).toContain('"kind":"ask"');
    expect(r.out).toContain("unit_state: paused");
    expect(r.out).toContain("unit-a");
    expect(r.out).toContain("blocked on auth contract");
    expect(r.out).toContain("confirm token flow");
  });

  test("report --result awaiting-approval is refused while a unit is paused", () => {
    constructionProject();
    pauseUnitA();
    const r = run(ORCHESTRATE, ["report", "--stage", SLUG, "--result", "awaiting-approval"], proj);
    const out = r.out;
    expect(out).toContain("paused");
    expect(out).not.toContain('"kind":"present-gate"');
  });
});
