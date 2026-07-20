// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-swarm:prepare, subcommand:aidlc-swarm:finalize, audit:REVIEW_COMPLETED, audit:SWARM_STARTED, audit:SWARM_COMPLETED, audit:SWARM_BATON_RETURNED
//
// CLI-contract port of tests/integration/t135-invoke-swarm.sh (TAP plan 8),
// mechanism = cli. The .sh proves invoke-swarm end-to-end across TWO real
// process surfaces, deterministically (no live model):
//
//   (1,2,7) THE ENGINE — `bun aidlc-orchestrate.ts next`. A Construction-phase
//     project parked at code-generation (in-flight) with a runtime-graph.json
//     carrying a bolt_dag batch. With `Construction Autonomy Mode: autonomous`
//     the engine emits {"kind":"invoke-swarm","units":[...]} naming the batch;
//     with the grant gated/unset it falls back to a run-stage for
//     code-generation. (7) the structural skeleton guard: under bugfix scope —
//     where code-generation IS the walking-skeleton gate stage — the engine
//     NEVER swarms even with autonomy granted (Bolt 1 is always human-gated).
//
//   (3-6) THE REFEREE — `bun aidlc-swarm.ts prepare|finalize` over a real git
//     worktree fixture, with THIS TEST playing the conductor (no `claude -p`
//     worker, no AIDLC_SWARM_CLAUDE_BIN). prepare a 2-unit batch, stage only
//     `win`'s impl on disk, then finalize claiming BOTH — `lose` is re-verified
//     red (the lying-conductor guard, aidlc-swarm.ts handleFinalize:~430) and
//     refused the merge. Assert the three batch-level audit events
//     SWARM_STARTED (prepare) / SWARM_COMPLETED / SWARM_BATON_RETURNED
//     (finalize) all land in audit.md, and the mixed batch returns the baton
//     (exit 2) with a 1-converged + 1-failed envelope. (The full referee
//     surface is t134's job — here we pin only the batch-level taxonomy.)
//
// SPAWN (not in-process): every assertion is on a PROCESS boundary the .sh was
// built around. The engine's directive is JSON on stdout from a tool that calls
// `process.exit` after `emit()` (aidlc-orchestrate.ts emit:139); the referee's
// audit rows are bytes written to audit.md by `appendAuditEntry` invoked inside
// the spawned `prepare`/`finalize` subprocesses, and the exit code (2 = baton
// returns) is `process.exit(failedCount > 0 ? 2 : 0)` (handleFinalize tail).
// The referee also forks REAL git worktrees (aidlc-worktree + aidlc-bolt start
// --worktree) — that needs an actual git repo on `main`, which only exists in
// the spawned process's cwd. An in-process twin would lose the git-fork +
// process.exit + cross-tool composition seams the .sh verifies. spawnCount =
// all 7 spawns (3 engine `next`, 1 referee `prepare`, 1 referee `finalize`).
//
// §6-E NON-GOLDEN: this is a baton-return / lying-conductor twin, NOT a happy
// path. The failure event (SWARM_BATON_RETURNED for the red `lose` unit) MUST
// ACTUALLY FIRE — staging only `win.txt` and claiming BOTH is what trips the
// guard. A happy-path-only twin (both units green) would emit no baton and is
// NOT equal-or-stronger. Test 5 asserts the event fires AND names `lose`.
//
// FIXTURE DISCIPLINE (mirrors the .sh):
//   - Engine cases: createTestProject() (a temp dir with aidlc-docs/), seeded
//     from tests/fixtures/state-construction.md with Current Stage pivoted to
//     code-generation, a bolt_dag runtime-graph.json written, and the autonomy
//     / scope line edited per case. Torn down per case (cleanupTestProject).
//   - Referee case: setupWorktreeFixture() — a real git repo on `main` with one
//     commit, gitignoring audit.md so the amend commit leaves a clean tree the
//     worktree fork can branch from. Torn down with cleanupWorktreeFixture
//     (chmod u+w first; git worktrees are read-locked).
//   - NOTHING is written under tests/fixtures/**; all temp dirs cleaned.
//
// Old TAP -> new test parity (1:1, every .sh `ok`/`assert_eq` -> a named test):
//   .sh (1) kind == invoke-swarm                 -> "1: autonomy granted + eligible batch -> engine emits invoke-swarm"
//   .sh (1) units == ["a","b"]                    -> "1b: invoke-swarm names the batch units off the compiled bolt_dag"
//   .sh (2) kind|stage == run-stage|code-generation -> "2: gated autonomy -> engine falls back to run-stage (no swarm)"
//   .sh (7) kind == run-stage (bugfix skeleton)   -> "7: skeleton-gate stage is never swarmed even under autonomy"
//   .sh (3) SWARM_STARTED in audit                -> "3: SWARM_STARTED emitted at batch start (prepare)"
//   .sh (4) SWARM_COMPLETED + converged/failed tally -> "4: SWARM_COMPLETED emitted with converged/failed tally"
//   .sh (5) SWARM_BATON_RETURNED naming lose       -> "5: SWARM_BATON_RETURNED emitted for the failed unit (lose)"
//   .sh (6) rc==2 + converged:1 + failed:1         -> "6: mixed batch exits 2 (baton returns) with 1 converged + 1 failed"

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  cleanupWorktreeFixture,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedStateFile,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SWARM_TOOL = join(AIDLC_SRC, "tools", "aidlc-swarm.ts");
const LOG_TOOL = join(AIDLC_SRC, "tools", "aidlc-log.ts");

// ---------------------------------------------------------------------------
// Engine-side helpers (cases 1, 2, 7).
// ---------------------------------------------------------------------------

const engineProjects: string[] = [];

afterEach(() => {
  while (engineProjects.length) cleanupTestProject(engineProjects.pop());
});

/**
 * Seed a Construction-phase project parked at code-generation (in-flight) with
 * a bolt_dag batch on runtime-graph.json. `autonomy` is the value injected as
 * `Construction Autonomy Mode` (or "" to omit the field). Mirrors the .sh's
 * seed_codegen_project. The compiled batch DAG is the milestone 15 shape: one
 * topological level of units a, b.
 */
function seedCodegenProject(autonomy: string): string {
  const proj = createTestProject();
  engineProjects.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
  const statePath = seededStateFile(proj);
  let state = readFileSync(statePath, "utf-8");
  // Pivot Current Stage to code-generation (the per-unit build stage). Its
  // checkbox under widget-checkout is [ ] (pending) -> in-flight, so the engine
  // runs THAT stage next.
  state = state.replace(
    /^- \*\*Current Stage\*\*:.*$/m,
    "- **Current Stage**: code-generation",
  );
  if (autonomy) {
    // Add the autonomy field right after the Scope line.
    state = state.replace(
      /^(- \*\*Scope\*\*: .*)$/m,
      `$1\n- **Construction Autonomy Mode**: ${autonomy}`,
    );
  }
  writeFileSync(statePath, state);
  writeFileSync(
    join(seededRecordDir(proj), "runtime-graph.json"),
    JSON.stringify(
      {
        bolt_dag: {
          units: [
            { name: "a", depends_on: [] },
            { name: "b", depends_on: [] },
          ],
          batches: [["a", "b"]],
        },
      },
      null,
      2,
    ),
  );
  return proj;
}

/** Flip the seeded fixture's scope (e.g. feature -> bugfix). */
function setScope(proj: string, scope: string): void {
  const statePath = seededStateFile(proj);
  const state = readFileSync(statePath, "utf-8").replace(
    /^- \*\*Scope\*\*: .*$/m,
    `- **Scope**: ${scope}`,
  );
  writeFileSync(statePath, state);
}

interface Directive {
  kind?: string;
  stage?: string;
  units?: unknown;
  [k: string]: unknown;
}

/** Run `aidlc-orchestrate.ts next` against the project and parse the directive. */
function runNext(proj: string): { directive: Directive; raw: string } {
  const r = spawnSync(BUN, [TOOL, "next", "--project-dir", proj], {
    encoding: "utf-8",
  });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  let directive: Directive;
  try {
    directive = JSON.parse(raw) as Directive;
  } catch {
    directive = {};
  }
  return { directive, raw };
}

// ---------------------------------------------------------------------------
// Referee-side state (cases 3-6) — one shared worktree fixture, run once.
// ---------------------------------------------------------------------------

let wtproj: string | undefined;
let reviewRefusalProj: string | undefined;
let finalizeStatus = -1;
let finalizeOut = "";
let auditBody = "";
let reviewRefusalStatus = -1;
let reviewRefusalOut = "";
let reviewRefusalAudit = "";

function seedRefereeProject(): string {
  const proj = setupWorktreeFixture();
  // The fixture already seeded the per-intent workspace shell + default record +
  // a seed commit (README only) on main. Write the construction state into the
  // seeded record, a bare audit shard, and a per-intent .gitignore (cursors +
  // audit/runtime machine-local), then amend so the worktree fork branches off a
  // clean tree that CARRIES the committed record.
  const state = readFileSync(
    join(FIXTURES_DIR, "state-construction.md"),
    "utf-8",
  ).replace(
    /^- \*\*Current Stage\*\*:.*$/m,
    "- **Current Stage**: code-generation",
  );
  writeFileSync(seededStateFile(proj), state);
  mkdirSync(seededAuditDir(proj), { recursive: true });
  writeFileSync(join(seededAuditDir(proj), "fixture.md"), "# AI-DLC Audit Log\n");
  writeFileSync(
    join(proj, ".gitignore"),
    [
      "aidlc/active-space",
      "aidlc/.aidlc-clone-id",
      "aidlc/spaces/*/intents/active-intent",
      "aidlc/spaces/*/intents/*/runtime-graph.json",
      "aidlc/spaces/*/intents/*/.aidlc-*",
      "aidlc/spaces/*/intents/*/audit/",
      "",
    ].join("\n"),
  );
  spawnSync("git", ["add", "-A"], { cwd: proj });
  spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--amend", "--no-edit"],
    { cwd: proj },
  );
  return proj;
}

function logWorktreeReview(proj: string, unit: string): void {
  const wt = join(proj, ".aidlc", "worktrees", `bolt-${unit}`);
  for (const terminal of [false, true]) {
    const args = [
      LOG_TOOL,
      "review",
      "--stage",
      "code-generation",
      "--unit",
      unit,
      "--reviewer",
      "aidlc-architecture-reviewer-agent",
      "--iteration",
      "1",
    ];
    if (terminal) args.push("--verdict", "READY");
    args.push("--project-dir", wt);
    const logged = spawnSync(BUN, args, { encoding: "utf-8" });
    if (logged.status !== 0) {
      throw new Error(`worktree review log failed: ${logged.stdout}${logged.stderr}`);
    }
  }
}

function setupReferee(): void {
  if (wtproj !== undefined) return; // build once; cases 3-6 read the result
  const proj = seedRefereeProject();
  wtproj = proj;

  // Conductor step 1: prepare forks a worktree per unit + emits SWARM_STARTED.
  spawnSync(
    BUN,
    [SWARM_TOOL, "--project-dir", proj, "prepare", "--batch", "1", "--units", "win,lose", "--base", "main"],
    { encoding: "utf-8" },
  );

  // Conductor step 2: the worker for `win` converged (writes win.txt); `lose`
  // did not. This test stages win's impl directly — no model.
  const winWorktree = join(proj, ".aidlc", "worktrees", "bolt-win");
  if (existsSync(winWorktree)) {
    writeFileSync(join(winWorktree, "win.txt"), "done\n");
    logWorktreeReview(proj, "win");
  }

  // Conductor step 3: finalize claiming BOTH (the conductor wrongly claims
  // lose). finalize re-verifies, refuses lose, returns the baton.
  const fin = spawnSync(
    BUN,
    [
      SWARM_TOOL, "--project-dir", proj, "finalize",
      "--batch", "1", "--units", "win,lose", "--claimed", "win,lose",
      "--check-cmd", "test -f win.txt",
    ],
    { encoding: "utf-8" },
  );
  finalizeStatus = fin.status ?? -1;
  finalizeOut = fin.stdout ?? "";
  // Audit is now a per-clone shard DIR — the swarm tool writes its SWARM_* rows
  // to its own <host>-<clone>.md shard alongside the seeded fixture.md; glob +
  // concat all shards so the batch-level taxonomy assertions see the whole trail.
  auditBody = readAllShards(seededAuditDir(proj));
}

function setupReviewRefusal(): void {
  if (reviewRefusalProj !== undefined) return;
  const proj = seedRefereeProject();
  reviewRefusalProj = proj;
  spawnSync(
    BUN,
    [SWARM_TOOL, "--project-dir", proj, "prepare", "--batch", "1", "--units", "unreviewed", "--base", "main"],
    { encoding: "utf-8" },
  );
  const fin = spawnSync(
    BUN,
    [
      SWARM_TOOL, "--project-dir", proj, "finalize",
      "--batch", "1", "--units", "unreviewed", "--claimed", "unreviewed",
      "--check-cmd", "true",
    ],
    { encoding: "utf-8" },
  );
  reviewRefusalStatus = fin.status ?? -1;
  reviewRefusalOut = fin.stdout ?? "";
  reviewRefusalAudit = readAllShards(seededAuditDir(proj));
}

/** Concatenate every audit shard (audit/*.md), sorted by filename. */
function readAllShards(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
}

afterAll(() => {
  if (wtproj !== undefined) {
    // Worktrees are read-locked; loosen perms before the recursive remove.
    spawnSync("chmod", ["-R", "u+w", wtproj]);
    cleanupWorktreeFixture(wtproj);
  }
  if (reviewRefusalProj !== undefined) {
    spawnSync("chmod", ["-R", "u+w", reviewRefusalProj]);
    cleanupWorktreeFixture(reviewRefusalProj);
  }
});

// ---------------------------------------------------------------------------
// (1, 2, 7) THE ENGINE — invoke-swarm vs run-stage.
// ---------------------------------------------------------------------------

describe("t135 engine — invoke-swarm emission gated on autonomy (migrated from t135-invoke-swarm.sh, plan 8)", () => {
  test("1: autonomy granted + eligible batch -> engine emits invoke-swarm", () => {
    const { directive } = runNext(seedCodegenProject("autonomous"));
    expect(directive.kind).toBe("invoke-swarm");
  }, 30000);

  test("1b: invoke-swarm names the batch units off the compiled bolt_dag (order-preserved)", () => {
    const { directive } = runNext(seedCodegenProject("autonomous"));
    // STRONGER than the .sh's string compare of the JSON array: assert the
    // parsed units array equals the first batch, in order, off the DAG.
    expect(directive.units).toEqual(["a", "b"]);
  }, 30000);

  test("2: gated autonomy -> engine falls back to run-stage for code-generation (no swarm)", () => {
    const { directive } = runNext(seedCodegenProject("gated"));
    // The .sh asserted "$KIND|$STG" == "run-stage|code-generation".
    expect(directive.kind).toBe("run-stage");
    expect(directive.stage).toBe("code-generation");
    // STRONGER: it is definitively NOT a swarm directive.
    expect(directive.kind).not.toBe("invoke-swarm");
  }, 30000);

  test("7: skeleton-gate stage is never swarmed even under autonomy (structural guard)", () => {
    // bugfix scope: code-generation IS the walking-skeleton gate stage (the
    // first Construction EXECUTE stage). Even WITH autonomy granted, the engine
    // must NOT swarm it — Bolt 1 is always human-gated. Defense-in-depth that
    // does not rest on conductor ordering (tryEmitSwarm:isSkeletonGateStage).
    const proj = seedCodegenProject("autonomous");
    setScope(proj, "bugfix");
    const { directive } = runNext(proj);
    expect(directive.kind).toBe("run-stage");
    expect(directive.kind).not.toBe("invoke-swarm");
  }, 30000);
});

// ---------------------------------------------------------------------------
// (3-6) THE REFEREE — prepare/finalize batch-level audit + baton return.
// ---------------------------------------------------------------------------

describe("t135 referee — batch-level swarm audit taxonomy + baton return (the lying-conductor guard)", () => {
  test("3: SWARM_STARTED emitted at batch start (prepare)", () => {
    setupReferee();
    expect(auditBody).toContain("SWARM_STARTED");
  }, 60000);

  test("4: SWARM_COMPLETED emitted with converged/failed tally (finalize)", () => {
    setupReferee();
    // The .sh grepped three independent lines; assert the same three observables.
    expect(auditBody).toContain("SWARM_COMPLETED");
    expect(auditBody).toContain("Converged count");
    expect(auditBody).toContain("Failed count");
    // STRONGER: the tally is the genuine 1-converged / 1-failed verdict, not a
    // happy-path zero — the SWARM_COMPLETED block carries those exact counts.
    const block = auditBody.slice(auditBody.indexOf("SWARM_COMPLETED"));
    expect(block).toContain("**Converged count**: 1");
    expect(block).toContain("**Failed count**: 1");
  }, 60000);

  test("5: SWARM_BATON_RETURNED emitted for the failed unit (lose)", () => {
    setupReferee();
    // §6-E: the failure event must ACTUALLY FIRE. The .sh asserted the event is
    // present AND the lines after it name `lose`. STRONGER: scope the unit-name
    // check to the SWARM_BATON_RETURNED block, so a stray `lose` elsewhere in
    // the audit can't satisfy it.
    const idx = auditBody.indexOf("SWARM_BATON_RETURNED");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = auditBody.slice(idx);
    expect(block).toContain("**Unit name**: lose");
  }, 60000);

  test("6: mixed batch exits 2 (baton returns) with 1 converged + 1 failed", () => {
    setupReferee();
    // The .sh asserted rc==2 AND the envelope on stdout carries "converged": 1
    // and "failed": 1. finalize prints the envelope pretty (2-space indent).
    expect(finalizeStatus).toBe(2);
    expect(finalizeOut).toContain('"converged": 1');
    expect(finalizeOut).toContain('"failed": 1');
  }, 60000);

  test("6b: the accepted worktree review receipt is merged into the main audit", () => {
    setupReferee();
    expect(auditBody).toContain("**Event**: REVIEW_COMPLETED");
    const review = auditBody.slice(auditBody.indexOf("**Event**: REVIEW_COMPLETED"));
    expect(review).toContain("**Stage**: code-generation");
    expect(review).toContain("**Unit**: win");
    expect(review).toContain("**Reviewer**: aidlc-architecture-reviewer-agent");
  }, 60000);
});

describe("t135 referee - autonomous reviewer receipt is a finalize precondition", () => {
  test("8: a green claimed unit without a worktree review is refused before merge", () => {
    setupReviewRefusal();
    expect(reviewRefusalStatus).toBe(2);
    expect(reviewRefusalOut).toContain("no terminal REVIEW_COMPLETED");
    expect(reviewRefusalOut).toContain('"converged": 0');
    expect(reviewRefusalOut).toContain('"failed": 1');
    expect(reviewRefusalAudit).not.toContain("**Event**: SWARM_UNIT_CONVERGED");
  }, 60000);
});
