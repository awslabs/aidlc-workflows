// covers: subcommand:aidlc-orchestrate:next, function:swarmConvergedUnits, function:latestMainWorkflowStageStarted
//
// CLI-contract test for the autonomous Construction swarm batch advance.
// mechanism = cli.
//
// THE BUG: `tryEmitSwarm` hardcoded `batches[0]`, so an autonomous multi-batch
// Bolt DAG never progressed past its first topological batch: after batch 1
// merged, `next` re-emitted batch 1 forever (the run stalled). THE FIX: the
// engine walks the compiled `bolt_dag.batches` in topological order and emits an
// `invoke-swarm` for the FIRST batch that still owns an unconverged unit, so the
// run climbs the DAG batch by batch. When every batch has converged the engine
// emits the stage's settle directive (a run-stage on the last unit carrying the
// stage's real gate) instead of another invoke-swarm, so the conductor presents
// the single stage gate and the workflow advances.
//
// THE COMPLETION SIGNAL IS THE AUDIT LEDGER, NOT DISK ARTIFACTS. A swarm unit is
// built inside an isolated Bolt worktree; `aidlc-bolt complete --merge`
// consolidates only the AIDLC metadata (state + audit + runtime-graph fragment)
// back to the main checkout, never the unit's produced artifact files. So the
// engine keys batch advance on the `SWARM_UNIT_CONVERGED` audit rows the referee
// (`aidlc-swarm.ts finalize`) writes back, one per genuinely-converged unit,
// each carrying a `Unit name` field. This test seeds those rows directly into
// the deterministic audit shard (no git worktrees, no live model) to control the
// converged set, exactly the way it would look after real finalize merges.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   - tryEmitSwarm (batch selection + terminal settle) + swarmConvergedUnits
//     (the audit-ledger reader), wired into BOTH handleNext call sites.
// NONE are exported (the tool has zero exports), so the behaviour is observable
// only on the JSON directive the spawned engine emits to stdout; mechanism =
// cli: SPAWN `bun aidlc-orchestrate.ts next` and assert the parsed directive, the
// SAME process boundary t135 (invoke-swarm emission) and t186 (per-unit
// iteration) drive.
//
// FIXTURE DISCIPLINE (mirrors t186's fresh-temp-per-case + clean single-row
// state): each case uses a FRESH temp project (createTestProject seeds the
// per-intent workspace shell + default record). We write a clean single-row-per-
// slug Construction state pivoted to code-generation (the swarm stage) in-flight,
// grant autonomy, write a multi-batch bolt_dag runtime-graph.json, and seed
// SWARM_UNIT_CONVERGED rows into the audit shard to control the converged set.
// `Skeleton Stance: off` is recorded so code-generation (NOT the feature-scope
// skeleton-gate stage, functional-design is) is unaffected: code-generation is
// never the skeleton gate for feature scope, so no stance is strictly needed, but
// recording it keeps the state realistic. All temp dirs are cleaned in afterEach.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedBoltDagBatches,
  seededAuditShard,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath; // the bun running this test
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  units?: unknown;
  gate?: unknown;
  reviewer?: string;
  reviewer_max_iterations?: number;
  message?: string;
  [k: string]: unknown;
}

/**
 * A CLEAN Construction-phase state file parked at code-generation (in-flight),
 * one checkbox row per slug (the shape the engine actually writes). The upstream
 * construction stages are marked [x] so code-generation is the in-flight stage.
 * `Construction Autonomy Mode: autonomous` grants the swarm; `Skeleton Stance:
 * off` records a resolved stance.
 */
function constructionState(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: swarm batch advance test
- **Project Type**: Greenfield
- **Scope**: feature
- **Construction Autonomy Mode**: autonomous
- **Skeleton Stance**: off
- **State Version**: 7

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`;
}

/**
 * One audit block in the exact `\n## <heading>\n**Timestamp**: …\n**Event**: …\n
 * …\n---\n` shape appendAuditEntryUnlocked writes, so findAllEvents +
 * auditBlockField parse it the way they parse a real emitter's rows.
 */
function auditBlock(
  heading: string,
  ts: string,
  event: string,
  fields: [string, string][],
): string {
  let body = `\n## ${heading}\n`;
  body += `**Timestamp**: ${ts}\n`;
  body += `**Event**: ${event}\n`;
  for (const [k, v] of fields) body += `**${k}**: ${v}\n`;
  return `${body}\n---\n`;
}

/** Append raw block content to the deterministic audit shard. */
function appendShard(proj: string, content: string): void {
  const shard = seededAuditShard(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, content, { flag: "a" });
}

/** The fixture timestamp shape shared by the seeders below. */
function fixtureTs(atSecond: number): string {
  return `2026-07-05T00:00:${String(atSecond).padStart(2, "0")}.000Z`;
}

/**
 * Append SWARM_UNIT_CONVERGED audit rows (one per unit) into the deterministic
 * audit shard, exactly the way a real finalize's rows would look — including
 * the attempt-identity stamp (`Stage` + `Run floor`) the consumers require to
 * match before counting a row. `atSecond` offsets the (monotonically-
 * increasing) timestamps so a caller can place rows before or after a seeded
 * STAGE_STARTED floor; `runFloorSecond` is the floor the emitting finalize saw
 * (undefined = "" — no STAGE_STARTED at emission, matching a consumer-side
 * empty floor).
 */
function seedConverged(
  proj: string,
  units: string[],
  atSecond = 0,
  opts: { stage?: string; runFloorSecond?: number; omitStamp?: boolean } = {},
): void {
  let body = "";
  units.forEach((unit, i) => {
    const fields: [string, string][] = [
      ["Batch number", "1"],
      ["Unit name", unit],
    ];
    if (!opts.omitStamp) {
      fields.push(
        ["Stage", opts.stage ?? "code-generation"],
        [
          "Run floor",
          opts.runFloorSecond === undefined ? "" : fixtureTs(opts.runFloorSecond),
        ],
      );
    }
    body += auditBlock(
      "Swarm Unit Converged",
      fixtureTs(atSecond + i),
      "SWARM_UNIT_CONVERGED",
      fields,
    );
  });
  appendShard(proj, body);
}

/**
 * Append a STAGE_STARTED row for a slug — the freshness floor the converged-set
 * reader keys on. `workflow` mirrors the synthetic `Workflow: single-stage:<slug>`
 * tag a --single stage-runner row carries (absent on main-workflow rows).
 */
function seedStageStarted(
  proj: string,
  slug: string,
  atSecond: number,
  workflow?: string,
): void {
  const fields: [string, string][] = [
    ["Stage", slug],
    ["Agent", "aidlc-developer-agent"],
  ];
  if (workflow) fields.push(["Workflow", workflow]);
  appendShard(
    proj,
    auditBlock("Stage Start", fixtureTs(atSecond), "STAGE_STARTED", fields),
  );
}

/** Seed a fresh autonomous Construction project at code-generation. */
function seedProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(seededStateFile(proj), constructionState());
  return proj;
}

/** Run `aidlc-orchestrate.ts next` and parse the emitted directive. */
function runNext(proj: string): Directive {
  const r = spawnSync(BUN, [ORCH, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(
      `runNext did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
}

function runReport(proj: string): Directive {
  const r = spawnSync(BUN, [
    ORCH,
    "report",
    "--stage",
    "code-generation",
    "--result",
    "approved",
    "--project-dir",
    proj,
  ], { encoding: "utf-8", env: process.env });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(
      `runReport did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
}

function logReviewReady(proj: string, unit: string): void {
  const r = spawnSync(BUN, [
    LOG,
    "review",
    "--stage",
    "code-generation",
    "--reviewer",
    "aidlc-architecture-reviewer-agent",
    "--unit",
    unit,
    "--iteration",
    "1",
    "--verdict",
    "READY",
    "--project-dir",
    proj,
  ], { encoding: "utf-8" });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`review log failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
}

describe("t201 autonomous swarm advances through every Bolt batch (issue headline)", () => {
  // 1: batch 1 incomplete (nothing converged) -> invoke-swarm emits batch 1.
  test("1: with no unit converged, next emits invoke-swarm for the first batch", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["auth"]);
    expect(d.stage).toBe("code-generation");
    expect(d.reviewer).toBe("aidlc-architecture-reviewer-agent");
    expect(d.reviewer_max_iterations).toBe(2);
  }, 30000);

  // 2: batch 1 complete, batch 2 incomplete -> invoke-swarm emits batch 2 ONLY.
  // This is the bug's core: the old engine re-emitted batch 1 forever; the fix
  // advances to the next unconverged batch.
  test("2: with the first batch converged, next advances to the second batch", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedConverged(proj, ["auth"]);
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["api"]);
  }, 30000);

  // 3: every batch converged -> NO invoke-swarm. The engine emits the stage's
  // settle directive: a run-stage on the LAST unit carrying the stage's real gate
  // (true), so the conductor presents the single stage gate and the workflow can
  // complete the stage.
  test("3: with every batch converged, next presents the stage settle gate (no swarm)", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedConverged(proj, ["auth", "api"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("code-generation");
    expect(d.kind).not.toBe("invoke-swarm");
    expect(d.unit).toBe("api"); // the last unit in topological order
    expect(d.gate).toBe(true);
  }, 30000);

  // 4: a batch with a PARTIAL pass -> the engine re-fans only that batch's
  // still-owed units. A batch [a, b] with only `a` converged re-emits [b]; a
  // later batch is not reached until this one fully converges.
  test("4: a partially-converged batch re-emits only its unconverged units", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["a", "b"], ["c"]]);
    seedConverged(proj, ["a"]);
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["b"]);
  }, 30000);

  test("4b: autonomous settle requires one architecture review per converged unit", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedConverged(proj, ["auth", "api"]);

    const refused = runReport(proj);
    expect(refused.kind).toBe("error");
    expect(refused.message).toContain("declares a reviewer");

    logReviewReady(proj, "auth");
    logReviewReady(proj, "api");
    const accepted = runReport(proj);
    expect(accepted.kind).toBe("done");
  }, 30000);
});

describe("t201 converged-set freshness floor (stage re-run replay guard)", () => {
  // The audit is append-only and per-intent, and the stage can re-run within
  // the same intent (backward/redo jump resets checkboxes but never deletes
  // ledger rows, and the autonomy grant survives the jump). The converged set
  // is therefore FLOORED at the stage's latest main-workflow STAGE_STARTED:
  // rows older than the floor belong to a prior run and are not coverage.

  // 5: the replay scenario itself. Every unit converged in a prior run, then
  // the stage re-entered (a fresh STAGE_STARTED lands after those rows). The
  // stale rows must NOT settle the stage - the swarm re-fans batch 1.
  test("5: converged rows older than the stage's latest STAGE_STARTED are ignored", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedConverged(proj, ["auth", "api"]); // prior run, seconds 0-1
    seedStageStarted(proj, "code-generation", 10); // re-entry floor
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["auth"]);
  }, 30000);

  // 6: rows AFTER the floor, stamped with the CURRENT attempt's floor, are the
  // current run's coverage - the normal flow. Also proves earlier-batch rows
  // from the same run are never orphaned (no new STAGE_STARTED fires between
  // batches).
  test("6: converged rows stamped with the current floor still advance the batches", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedStageStarted(proj, "code-generation", 0);
    seedConverged(proj, ["auth"], 10, { runFloorSecond: 0 });
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["api"]);
  }, 30000);

  // 7: a --single stage-runner's STAGE_STARTED carries the synthetic
  // `Workflow: single-stage:<slug>` tag and must NOT move the floor - it
  // belongs to no main workflow (mirrors hasStageAuditEvent's filter).
  test("7: a single-stage-runner STAGE_STARTED does not move the floor", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedConverged(proj, ["auth", "api"]); // seconds 0-1
    seedStageStarted(proj, "code-generation", 10, "single-stage:code-generation");
    const d = runNext(proj);
    // The single-stage row is not a floor, so the converged rows still count:
    // every batch converged -> settle directive, not a re-fan.
    expect(d.kind).toBe("run-stage");
    expect(d.gate).toBe(true);
  }, 30000);

  // 8: a STAGE_STARTED for a DIFFERENT slug is not this stage's floor.
  test("8: another stage's STAGE_STARTED does not move the floor", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedConverged(proj, ["auth", "api"]); // seconds 0-1
    seedStageStarted(proj, "build-and-test", 10);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.gate).toBe(true);
  }, 30000);

  // 9: no qualifying STAGE_STARTED at all -> the floor degrades to "count all
  // rows" (never to "exclude all"), preserving cases 1-4's fixture shape.
  test("9: with no STAGE_STARTED row the converged set counts every row", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedConverged(proj, ["auth", "api"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.gate).toBe(true);
  }, 30000);
});

describe("t201 converged-row attempt identity (Stage + Run floor stamp)", () => {
  // Timestamp flooring alone cannot reject a STALE-ATTEMPT row emitted with a
  // CURRENT timestamp (a late `finalize` retry against a prior attempt's
  // preserved worktree) or another swarm stage's rows when the floor degrades
  // to "". Each row therefore carries the emitting attempt's identity - Stage
  // + Run floor - and the consumers count a row only when BOTH match.

  // 10: the late-retry replay. The stage re-entered (fresh floor at second
  // 10); a finalize retry against the attempt-1 worktree then lands rows with
  // CURRENT timestamps but attempt 1's floor. They must not settle attempt 2.
  test("10: a current-timestamp row carrying a prior attempt's floor is rejected", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedStageStarted(proj, "code-generation", 0); // attempt 1 floor
    seedStageStarted(proj, "code-generation", 10); // attempt 2 floor
    seedConverged(proj, ["auth", "api"], 20, { runFloorSecond: 0 });
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["auth"]);
  }, 30000);

  // 11: rows naming ANOTHER stage never count, even when this stage has no
  // STAGE_STARTED yet (the ""-floor degrade that used to fail open).
  test("11: another stage's converged rows are rejected by the Stage stamp", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedConverged(proj, ["auth", "api"], 0, { stage: "build-and-test" });
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["auth"]);
  }, 30000);

  // 12: pre-2.5.0 rows without the stamp fail CLOSED - the affected units
  // re-fan (finalize's re-verify makes the re-run safe), never silently count.
  test("12: unstamped legacy rows are not coverage", () => {
    const proj = seedProject();
    seedBoltDagBatches(proj, [["auth"], ["api"]]);
    seedStageStarted(proj, "code-generation", 0);
    seedConverged(proj, ["auth", "api"], 10, { omitStamp: true });
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["auth"]);
  }, 30000);
});
