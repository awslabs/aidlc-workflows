// covers: subcommand:aidlc-orchestrate:next
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath; // the bun running this test
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

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

/** Write a multi-batch bolt_dag (each inner array is one topological batch). */
function seedMultiBatchDag(proj: string, batches: string[][]): void {
  const names = batches.flat();
  writeFileSync(
    join(seededRecordDir(proj), "runtime-graph.json"),
    JSON.stringify(
      {
        bolt_dag: {
          units: names.map((name) => ({ name, depends_on: [] })),
          batches,
        },
      },
      null,
      2,
    ),
  );
}

/**
 * Append SWARM_UNIT_CONVERGED audit rows (one per unit) into the deterministic
 * audit shard, in the exact `\n## <heading>\n**Timestamp**: …\n**Event**: …\n…\n
 * ---\n` block shape appendAuditEntryUnlocked writes, so findAllEvents +
 * auditBlockField parse them the way they parse a real finalize's rows. `ts` is
 * a monotonically-increasing suffix so the blocks carry distinct timestamps.
 */
function seedConverged(proj: string, units: string[]): void {
  const shard = seededAuditShard(proj);
  mkdirSync(dirname(shard), { recursive: true });
  let body = "";
  units.forEach((unit, i) => {
    const ts = `2026-07-05T00:00:0${i}.000Z`;
    body += `\n## Swarm Unit Converged\n`;
    body += `**Timestamp**: ${ts}\n`;
    body += `**Event**: SWARM_UNIT_CONVERGED\n`;
    body += `**Batch number**: 1\n`;
    body += `**Unit name**: ${unit}\n`;
    body += `\n---\n`;
  });
  writeFileSync(shard, body);
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

describe("t201 autonomous swarm advances through every Bolt batch (issue headline)", () => {
  // 1: batch 1 incomplete (nothing converged) -> invoke-swarm emits batch 1.
  test("1: with no unit converged, next emits invoke-swarm for the first batch", () => {
    const proj = seedProject();
    seedMultiBatchDag(proj, [["auth"], ["api"]]);
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["auth"]);
  }, 30000);

  // 2: batch 1 complete, batch 2 incomplete -> invoke-swarm emits batch 2 ONLY.
  // This is the bug's core: the old engine re-emitted batch 1 forever; the fix
  // advances to the next unconverged batch.
  test("2: with the first batch converged, next advances to the second batch", () => {
    const proj = seedProject();
    seedMultiBatchDag(proj, [["auth"], ["api"]]);
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
    seedMultiBatchDag(proj, [["auth"], ["api"]]);
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
    seedMultiBatchDag(proj, [["a", "b"], ["c"]]);
    seedConverged(proj, ["a"]);
    const d = runNext(proj);
    expect(d.kind).toBe("invoke-swarm");
    expect(d.units).toEqual(["b"]);
  }, 30000);
});
