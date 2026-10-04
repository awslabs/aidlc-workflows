// covers: subcommand:aidlc-state:unit, function:unitCompletedReceipts, function:unitLifecycleReceiptsInUse, function:activeUnitCheckpoint, function:latestMainWorkflowStageRunFloor, function:latestMainWorkflowStageRunFloorForProject, function:readAuditShardEvents, function:isRegularFile, audit:UNIT_STARTED, audit:UNIT_PAUSED, audit:UNIT_RESUMED, audit:UNIT_COMPLETED, audit:CONSTRUCTION_POLICY_SET
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
//      resume/restart race cannot create two active units. Same-active-unit
//      start is an idempotent acknowledge; restarting a completed unit reopens
//      it and clears settled coverage until a new completion.
//   3. PAUSE CARRIES THE CHECKPOINT. `unit pause` requires --reason and
//      --next-action, mirrors them into ## Runtime State (Active Unit / Unit
//      State / Unit Pause Reason / Unit Next Action), and the engine's `next`
//      hard-stops with a paused-unit ask until an explicit
//      `unit resume`. Approval entry is refused while a unit is paused.
//   4. LIFECYCLE ORDER. complete-while-paused refuses (resume first);
//      resume of a non-paused unit refuses; pause/complete of a non-active
//      unit refuses.
//
// Mechanism: cli — every step drives the real aidlc-state.ts / aidlc-orchestrate.ts
// through Bun.spawnSync against a seeded fixture project, and the receipt
// readers are asserted through the shipped aidlc-lib.ts exports.

import {
  NATIVE_COMPILE_TIMEOUT_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
  seedBoltDag,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  activeUnitCheckpoint,
  artifactFilename,
  consumeSharedDirectiveAsk,
  currentUnitLifecycleMode,
  latestMainWorkflowStageRunFloor,
  latestMainWorkflowStageRunFloorForProject,
  parseBoltDag,
  readAllAuditShards,
  readAuditShardEvents,
  stateDigest,
  swarmConvergedUnits,
  unitCompletedReceipts,
  unitLifecycleReceiptsInUse,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SLUG = "functional-design"; // inline per-unit stage
const PRODUCES = ["entities", "rules", "functional-spec", "traceability"];

// A minimal Construction state with functional-design in-flight and the
// skeleton stance recorded (mirrors t209's constructionState) — so the engine's
// per-unit walk runs instead of the classify round-trip, and the acted stage is
// genuinely in-progress for gate-start.
const CONSTRUCTION_STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: unit lifecycle receipts test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on
- **Construction Iteration**: unit-major

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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function runNext(proj: string): { rc: number; out: string } {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env });
  return { rc: result.status, out: result.out };
}

// The suite sets AIDLC_SKIP_ARTIFACT_GUARD=1 globally; unit complete's
// artifact verification is a subject under test here, so clear it per spawn.
function unitVerb(
  proj: string,
  action: string,
  unit: string,
  extra: string[] = [],
  envOverrides: NodeJS.ProcessEnv = {},
) {
  const env = { ...process.env, ...envOverrides };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = spawnSync(
    BUN,
    [STATE, "unit", action, "--stage", SLUG, "--unit", unit, ...extra, "--project-dir", proj],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env },
  );
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function writeUnitArtifacts(proj: string, unit: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, SLUG);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name}\nstub\n`, "utf-8");
  }
}

let proj = "";
function constructionProject(
  iteration: "unit-major" | "stage-major" = "unit-major",
): string {
  proj = createOrchestrationTestProject();
  // Exercise the serial lifecycle explicitly. Keep only functional-design in
  // the unit-major plan so it routes the next unit after each completion.
  const state = CONSTRUCTION_STATE.replace(
    "- **Construction Iteration**: unit-major",
    `- **Construction Iteration**: ${iteration}`,
  );
  writeFileSync(
    seededStateFile(proj),
    iteration === "unit-major" ? state.replaceAll("- [ ]", "- [S]") : state,
    "utf-8",
  );
  seedBoltDag(proj, ["unit-a", "unit-b"]);
  return proj;
}

function enableAutonomy(): void {
  const path = seededStateFile(proj);
  writeFileSync(
    path,
    readFileSync(path, "utf-8").replace(
      "- **Skeleton Stance**: on",
      "- **Skeleton Stance**: on\n- **Construction Autonomy Mode**: autonomous",
    ),
    "utf-8",
  );
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

  test("artifact-shaped directories neither complete nor settle a unit", () => {
    constructionProject();
    const dir = join(seededRecordDir(proj), "construction", "unit-a", SLUG);
    mkdirSync(dir, { recursive: true });
    for (const name of PRODUCES) {
      mkdirSync(join(dir, artifactFilename(name)));
    }

    expect(runNext(proj).out).toContain('"unit":"unit-a"');
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    const completed = unitVerb(proj, "complete", "unit-a");
    expect(completed.rc).not.toBe(0);
    expect(completed.out).toContain("missing");
    expect(readAllAuditShards(proj)).not.toContain("UNIT_COMPLETED");
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

  test("unit start requires a safe identifier from the authoritative DAG", () => {
    constructionProject();
    for (const unit of ["rogue-unit", "../unit-a", "unit/a", "unit-a\n- **Status**: Completed"]) {
      const result = unitVerb(proj, "start", unit);
      expect(result.rc).not.toBe(0);
    }
    expect(readAllAuditShards(proj)).not.toContain("UNIT_STARTED");
    expect(readFileSync(seededStateFile(proj), "utf-8")).not.toContain("rogue-unit");
  });

  test("unit start accepts legacy-safe DAG names without weakening path safety", () => {
    constructionProject();
    seedBoltDag(
      proj,
      ["2fa", "api_v2", "WebUI"],
      [["2fa"], ["api_v2"], ["WebUI"]],
    );
    for (const unit of ["2fa", "api_v2", "WebUI"]) {
      const parsed = parseBoltDag(
        `\`\`\`yaml\nunits:\n  - name: ${unit}\n    depends_on: []\n\`\`\`\n`,
      );
      expect(parsed.ok).toBe(true);
    }

    expect(unitVerb(proj, "start", "2fa").rc).toBe(0);
    writeUnitArtifacts(proj, "2fa");
    expect(unitVerb(proj, "complete", "2fa").rc).toBe(0);
    expect(unitVerb(proj, "start", "api_v2").rc).toBe(0);
    writeUnitArtifacts(proj, "api_v2");
    expect(unitVerb(proj, "complete", "api_v2").rc).toBe(0);
    expect(unitVerb(proj, "start", "WebUI").rc).toBe(0);
  });

  test("backward jumps to inline stages keep lifecycle receipts under autonomy", () => {
    constructionProject();
    enableAutonomy();

    const next = runNext(proj);
    expect(next.out).toContain('"stage":"functional-design"');
    expect(next.out).toContain('"unit":"unit-a"');
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    writeUnitArtifacts(proj, "unit-a");
    expect(unitVerb(proj, "complete", "unit-a").rc).toBe(0);
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
  });

  test("autonomous swarm stages still refuse interactive lifecycle receipts", () => {
    constructionProject("stage-major");
    enableAutonomy();

    const result = run(
      STATE,
      ["unit", "start", "--stage", "code-generation", "--unit", "unit-a"],
      proj,
    );
    expect(result.rc).not.toBe(0);
    expect(result.out).toContain("swarm referee");
  });

  test("authored DAG membership overrides a stale cached unit set", () => {
    constructionProject();
    const dependencyDir = join(
      seededRecordDir(proj),
      "inception",
      "units-generation",
    );
    mkdirSync(dependencyDir, { recursive: true });
    writeFileSync(
      join(dependencyDir, "unit-of-work-dependency.md"),
      "# Dependencies\n\n```yaml\nunits:\n  - name: unit-a\n    depends_on: []\n```\n",
      "utf-8",
    );

    expect(unitVerb(proj, "start", "unit-b").rc).not.toBe(0);
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
  });

  test("the authored DAG rejects unsafe path-component names", () => {
    for (const unit of ["../escape", "nested/unit", ".hidden", "white space"]) {
      const parsed = parseBoltDag(
        `\`\`\`yaml\nunits:\n  - name: ${unit}\n    depends_on: []\n\`\`\`\n`,
      );
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe("malformed");
        expect(parsed.detail).toContain("Invalid Unit name");
      }
    }
  });
});

describe("t260 single active unit", () => {
  test("unit start must match the engine-routed topological unit", () => {
    constructionProject();
    seedBoltDag(
      proj,
      [
        { name: "unit-a", depends_on: [] },
        { name: "unit-b", depends_on: ["unit-a"] },
      ],
      [["unit-a"], ["unit-b"]],
    );

    const early = unitVerb(proj, "start", "unit-b");
    expect(early.rc).not.toBe(0);
    expect(JSON.parse(early.out).error).toContain(
      'routes "functional-design"/"unit-a"',
    );

    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    writeUnitArtifacts(proj, "unit-a");
    expect(unitVerb(proj, "complete", "unit-a").rc).toBe(0);
    expect(unitVerb(proj, "start", "unit-b").rc).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("unit start uses top-level next/continue verbs through the compiled dispatcher seam", () => {
    constructionProject();
    const dispatcherSource = join(proj, "aidlc-compiled-shim.ts");
    const dispatcher = join(
      proj,
      process.platform === "win32" ? "aidlc-compiled-shim.exe" : "aidlc-compiled-shim",
    );
    if (process.platform === "win32") {
      writeFileSync(
        dispatcherSource,
        [
          'import { spawnSync } from "node:child_process";',
          `const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(join(AIDLC_SRC, "tools", "aidlc.ts"))}, ...process.argv.slice(2)], {`,
          '  stdio: "inherit",',
          "  env: process.env,",
          "});",
          "process.exit(result.status ?? 1);",
          "",
        ].join("\n"),
        "utf-8",
      );
      const built = Bun.spawnSync([
        process.execPath,
        "build",
        "--compile",
        dispatcherSource,
        "--outfile",
        dispatcher,
      ], { timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS) });
      if (built.exitCode !== 0) {
        throw new Error(`fake compiled dispatcher build failed: ${built.stderr.toString()}`);
      }
    } else {
      writeFileSync(
        dispatcher,
        [
          "#!/usr/bin/env bun",
          `import { main } from ${JSON.stringify(pathToFileURL(join(AIDLC_SRC, "tools", "aidlc.ts")).href)};`,
          "await main(process.argv.slice(2));",
          "",
        ].join("\n"),
        "utf-8",
      );
      chmodSync(dispatcher, 0o755);
    }

    const started = unitVerb(proj, "start", "unit-a", [], {
      AIDLC_COMPILED_EXECUTABLE: dispatcher,
    });
    expect(started.rc).toBe(0);
    expect(started.out).toContain("UNIT_STARTED");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

  test("a picked recovery for a missing completion receipt records it from the Unit's artifacts (#1289)", () => {
    constructionProject();
    writeUnitArtifacts(proj, "unit-a");
    const publish = (unit: string, remedies: Array<Record<string, unknown>>) => {
      const state = readFileSync(seededStateFile(proj), "utf-8");
      writeActiveDirectiveMarker(proj, {
        kind: "ask",
        ask_type: "guard-recovery",
        stage: SLUG,
        unit,
        state_sha256: stateDigest(state),
        remedies: remedies as never,
      });
    };
    const record = (unit: string) => ({
      op: "record-unit-completion",
      action: `Record ${unit}.`,
      interaction: "command",
      operation: { kind: "record-unit-completion", stage: SLUG, unit },
    });
    // The Unit was never started, so completing it is refused on its own.
    expect(unitVerb(proj, "complete", "unit-a").rc).not.toBe(0);
    // An ask that offers something else does not open it.
    publish("unit-a", [{ op: "request-changes", action: "Ask.", interaction: "human-input" }]);
    expect(unitVerb(proj, "complete", "unit-a").rc).not.toBe(0);
    // Nor does an ask about another Unit.
    publish("unit-b", [record("unit-b")]);
    expect(unitVerb(proj, "complete", "unit-a").rc).not.toBe(0);
    // Picked for another Unit whose artifacts are missing: still checked.
    expect(consumeSharedDirectiveAsk(proj, "1")).toBe(true);
    const missing = unitVerb(proj, "complete", "unit-b");
    expect(missing.rc).not.toBe(0);
    expect(missing.out).toContain("required artifacts are missing");
    publish("unit-a", [record("unit-a")]);
    // Offered but not yet picked: still refused.
    expect(unitVerb(proj, "complete", "unit-a").rc).not.toBe(0);
    // The person picks it, as the human-turn hook records a reply.
    expect(consumeSharedDirectiveAsk(proj, "1")).toBe(true);
    const done = unitVerb(proj, "complete", "unit-a");
    expect(done.rc, done.out).toBe(0);
    expect(done.out).toContain("UNIT_COMPLETED");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
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

  test("a completed unit reopens only when the engine routes it again", () => {
    constructionProject();
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    writeUnitArtifacts(proj, "unit-a");
    expect(unitVerb(proj, "complete", "unit-a").rc).toBe(0);
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);

    const outOfOrder = unitVerb(proj, "start", "unit-a");
    expect(outOfOrder.rc).not.toBe(0);
    expect(JSON.parse(outOfOrder.out).error).toContain(
      'routes "functional-design"/"unit-b"',
    );

    rmSync(
      join(
        seededRecordDir(proj),
        "construction",
        "unit-a",
        SLUG,
        `${PRODUCES[0]}.md`,
      ),
    );
    const restart = unitVerb(proj, "start", "unit-a");
    expect(restart.rc).toBe(0);
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(false);
    expect(activeUnitCheckpoint(proj, SLUG)?.unit).toBe("unit-a");

    const next = runNext(proj);
    expect(next.out).toContain('"unit":"unit-a"');
    expect(next.out).toContain('"gate":false');
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t260 pause carries the checkpoint and hard-stops the engine", () => {
  const TIE_TS = "2026-08-06T12:00:00Z";

  function pauseUnitA(): void {
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    const p = unitVerb(proj, "pause", "unit-a", [
      "--reason", "blocked on auth contract",
      "--next-action", "confirm token flow, then finish rules.md",
    ]);
    expect(p.rc).toBe(0);
  }

  function seedLifecycleShard(
    name: string,
    events: { event: string; timestamp?: string; extra?: string }[],
  ): void {
    mkdirSync(seededAuditDir(proj), { recursive: true });
    const blocks = events.map(
      ({ event, timestamp = TIE_TS, extra = "" }) =>
        `\n## ${event}\n**Timestamp**: ${timestamp}\n**Event**: ${event}\n` +
        `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: unstarted#0\n${extra}\n---\n`,
    );
    writeFileSync(
      join(seededAuditDir(proj), name),
      ["# AI-DLC Audit Log\n", ...blocks].join(""),
      "utf-8",
    );
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("pause rejects line-breaking state values", () => {
    constructionProject();
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    for (const extra of [
      ["--reason", "blocked\n- **Status**: Completed", "--next-action", "resume"],
      ["--reason", "blocked", "--next-action", "resume\r- **Status**: Completed"],
    ]) {
      const result = unitVerb(proj, "pause", "unit-a", extra);
      expect(result.rc).not.toBe(0);
    }
    const state = readFileSync(seededStateFile(proj), "utf-8");
    expect(state).not.toContain("- **Status**: Completed");
    expect(activeUnitCheckpoint(proj, SLUG)?.state).toBe("in-progress");
  });

  test.each([
    ["aaaa-paused.md", "zzzz-started.md"],
    ["zzzz-paused.md", "aaaa-started.md"],
  ])(
    "same-second cross-shard pause wins over an unordered start (%s, %s)",
    (pausedShard, startedShard) => {
      constructionProject();
      seedLifecycleShard(pausedShard, [
        {
          event: "UNIT_PAUSED",
          extra: "**Reason**: waiting for review\n**Next Action**: confirm the contract\n",
        },
      ]);
      seedLifecycleShard(startedShard, [{ event: "UNIT_STARTED" }]);

      const checkpoint = activeUnitCheckpoint(proj, SLUG);
      expect(checkpoint?.unit).toBe("unit-a");
      expect(checkpoint?.state).toBe("paused");
      expect(checkpoint?.reason).toBe("waiting for review");

      writeUnitArtifacts(proj, "unit-a");
      const completed = unitVerb(proj, "complete", "unit-a");
      expect(completed.rc).not.toBe(0);
      expect(completed.out).toContain("paused");
    },
  );

  test("same-second cross-shard completion cannot override an unordered start", () => {
    constructionProject();
    seedLifecycleShard("aaaa-started.md", [{ event: "UNIT_STARTED" }]);
    seedLifecycleShard("zzzz-completed.md", [{ event: "UNIT_COMPLETED" }]);

    const checkpoint = activeUnitCheckpoint(proj, SLUG);
    expect(checkpoint?.unit).toBe("unit-a");
    expect(checkpoint?.state).toBe("in-progress");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(false);
  });

  test("same-second cross-shard pause wins over an unordered resume", () => {
    constructionProject();
    seedLifecycleShard("aaaa-resumed.md", [{ event: "UNIT_RESUMED" }]);
    seedLifecycleShard("zzzz-paused.md", [
      {
        event: "UNIT_PAUSED",
        extra: "**Reason**: still blocked\n**Next Action**: wait for review\n",
      },
    ]);

    const checkpoint = activeUnitCheckpoint(proj, SLUG);
    expect(checkpoint?.state).toBe("paused");
    expect(checkpoint?.reason).toBe("still blocked");
  });

  test("same-shard same-second lifecycle rows retain append order", () => {
    constructionProject();
    seedLifecycleShard("aaaa.md", [
      {
        event: "UNIT_PAUSED",
        extra: "**Reason**: blocked\n**Next Action**: resume\n",
      },
      { event: "UNIT_RESUMED" },
    ]);

    expect(activeUnitCheckpoint(proj, SLUG)?.state).toBe("in-progress");
  });

  test("a strictly later lifecycle row overrides earlier cross-shard state", () => {
    constructionProject();
    seedLifecycleShard("aaaa-paused.md", [
      {
        event: "UNIT_PAUSED",
        extra: "**Reason**: blocked\n**Next Action**: resume\n",
      },
    ]);
    seedLifecycleShard("zzzz-completed.md", [
      { event: "UNIT_COMPLETED", timestamp: "2026-08-06T12:00:01Z" },
    ]);

    expect(activeUnitCheckpoint(proj, SLUG)).toBeNull();
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("`next` emits a paused-unit ask in plain words and names the checkpoint", () => {
    constructionProject();
    pauseUnitA();
    const r = runNext(proj);
    const directive = JSON.parse(r.out) as {
      ask_type?: string;
      response_route?: string;
      stage?: string;
      unit?: string;
      resume_command?: string;
    };
    expect(r.rc).toBe(0);
    expect(r.out).toContain('"kind":"ask"');
    expect(r.out).toContain('Unit \\"unit-a\\" of stage');
    expect(r.out).toContain("is paused");
    expect(r.out, "no engine control narration reaches the human").not.toContain("STOP until");
    expect(r.out).toContain("unit-a");
    expect(r.out).toContain("blocked on auth contract");
    expect(r.out).toContain("confirm token flow");
    expect(directive.ask_type).toBe("unit-paused");
    expect(directive.response_route).toBe("command");
    expect(directive.stage).toBe(SLUG);
    expect(directive.unit).toBe("unit-a");
    expect(directive.resume_command).toBeDefined();
    const resumed = spawnSync("sh", ["-c", directive.resume_command!], {
      cwd: join(AIDLC_SRC, ".."),
      env: { ...process.env, AIDLC_PROJECT_DIR: proj },
      encoding: "utf-8",
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(activeUnitCheckpoint(proj, SLUG)?.state).toBe("in-progress");
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

describe("t260 receipts bind to an exact stage attempt", () => {
  test("a same-second receipt from the prior attempt does not settle the new attempt", () => {
    constructionProject("stage-major");
    const ts = "2026-07-30T10:00:00Z";
    const block = (event: string, fields: string) =>
      `\n## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${fields}\n---\n`;
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(
      seededAuditShard(proj),
      [
        "# AI-DLC Audit Log\n",
        block("STAGE_STARTED", `**Stage**: ${SLUG}\n`),
        block(
          "UNIT_COMPLETED",
          `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: STAGE_STARTED:${ts}#1\n`,
        ),
        block("STAGE_STARTED", `**Stage**: ${SLUG}\n`),
      ].join(""),
      "utf-8",
    );

    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(false);
    expect(unitLifecycleReceiptsInUse(proj, SLUG)).toBe(true);

    writeUnitArtifacts(proj, "unit-a");
    writeUnitArtifacts(proj, "unit-b");
    const next = runNext(proj);
    expect(next.out).toContain('"unit":"unit-a"');
    expect(next.out).toContain('"gate":false');
  });

  test("lifecycle receipts carry the exact run floor", () => {
    constructionProject();
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    expect(readAllAuditShards(proj)).toMatch(/\*\*Run floor\*\*:\s+\S+/);
  });

  test("same-second boundaries in different shards fail closed independent of filename order", () => {
    constructionProject("stage-major");
    const ts = "2026-08-05T00:00:00Z";
    const block = (event: string, fields: string) =>
      `\n## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${fields}\n---\n`;
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(
      join(seededAuditDir(proj), "zzzz-old.md"),
      [
        "# AI-DLC Audit Log\n",
        block("STAGE_STARTED", `**Stage**: ${SLUG}\n`),
        block(
          "UNIT_COMPLETED",
          `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: STAGE_STARTED:${ts}#1\n`,
        ),
      ].join(""),
      "utf-8",
    );
    writeFileSync(
      join(seededAuditDir(proj), "aaaa-new.md"),
      [
        "# AI-DLC Audit Log\n",
        block("GATE_REJECTED", `**Stage**: ${SLUG}\n**Feedback**: revise\n`),
      ].join(""),
      "utf-8",
    );

    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(false);
    const floor = latestMainWorkflowStageRunFloorForProject(proj, SLUG);
    expect(floor).toMatch(/^AMBIGUOUS:2026-08-05T00:00:00Z#[0-9a-f]{12}$/);
    // The old receipt was invalidated by the ambiguous boundary. A sibling's
    // current serial receipt keeps this a serial-stage fixture while unit-a's
    // new start must bind to the same ambiguity token.
    writeFileSync(
      seededAuditShard(proj),
      "# AI-DLC Audit Log\n" + block(
        "UNIT_COMPLETED",
        `**Stage**: ${SLUG}\n**Unit**: unit-b\n**Run floor**: ${floor}\n`,
      ),
      "utf-8",
    );
    expect(currentUnitLifecycleMode(proj, SLUG)).toBe("serial");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(false);
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    expect(readFileSync(seededAuditShard(proj), "utf-8")).toContain(
      `**Event**: UNIT_STARTED\n**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: ${floor}`,
    );
  });

  test("the reader floor matches the writer floor when the latest boundary is not in the last-read shard", () => {
    constructionProject();
    const block = (event: string, ts: string, fields: string) =>
      `\n## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${fields}\n---\n`;
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(
      seededAuditShard(proj),
      "# AI-DLC Audit Log\n" +
        block("STAGE_JUMPED", "2026-08-06T00:00:00Z", `**Stage**: ${SLUG}\n`),
      "utf-8",
    );
    writeFileSync(
      join(seededAuditDir(proj), "zzzz-other-clone.md"),
      "# AI-DLC Audit Log\n" +
        block("WORKFLOW_STARTED", "2026-07-26T00:00:00Z", "**Stage**: intent-capture\n"),
      "utf-8",
    );

    // Shards read in filename order, so this proves the older boundary is the
    // last raw row on this host and the reader path would take it unsorted.
    const rawRows = readAuditShardEvents(proj);
    expect(rawRows.at(-1)?.event).toBe("WORKFLOW_STARTED");

    const writerFloor = latestMainWorkflowStageRunFloorForProject(proj, SLUG, true);
    const readerFloor = latestMainWorkflowStageRunFloorForProject(
      proj,
      SLUG,
      true,
      undefined,
      rawRows,
    );
    expect(writerFloor).toBe("STAGE_JUMPED:2026-08-06T00:00:00Z#1");
    expect(readerFloor).toBe(writerFloor);

    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    expect(activeUnitCheckpoint(proj, SLUG)?.unit).toBe("unit-a");
    writeUnitArtifacts(proj, "unit-a");
    const completed = unitVerb(proj, "complete", "unit-a");
    expect(completed.out).not.toContain("no unit is active");
    expect(completed.rc).toBe(0);
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
  });
});

// A person can change Construction Iteration or Construction Checkpoints in
// the middle of a per-unit stage (with their approval during Construction).
// The change decides how later boundaries are read; it must never take away a
// Unit's finished work, so the engine never hands that Unit out again.
describe("t260 finished Units keep their receipts across a Construction policy change", () => {
  const block = (event: string, ts: string, fields: string) =>
    `\n## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${fields}\n---\n`;

  // functional-design is the only per-unit stage left, so either iteration
  // order routes the next Unit of this stage. Its STAGE_STARTED predates the
  // Units' work, as it does in a real stage-by-stage walk.
  function policyProject(
    iteration: "unit-major" | "stage-major",
    checkpoints?: "enabled" | "disabled",
  ): string {
    proj = createOrchestrationTestProject();
    let state = CONSTRUCTION_STATE.replace(
      "- **Construction Iteration**: unit-major",
      `- **Construction Iteration**: ${iteration}`,
    ).replaceAll("- [ ]", "- [S]");
    if (checkpoints) {
      state = state.replace(
        "- **Revision Count**: 0",
        `- **Revision Count**: 0\n- **Construction Checkpoints**: ${checkpoints}`,
      );
    }
    writeFileSync(seededStateFile(proj), state, "utf-8");
    seedBoltDag(proj, ["unit-a", "unit-b"]);
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(
      seededAuditShard(proj),
      "# AI-DLC Audit Log\n" +
        block("WORKFLOW_STARTED", "2026-01-01T00:00:00Z", "**Stage**: intent-capture\n") +
        block("STAGE_STARTED", "2026-01-02T00:00:00Z", `**Stage**: ${SLUG}\n`),
      "utf-8",
    );
    return proj;
  }

  // A stage-major Unit finished one at a time, as Code Generation runs there,
  // carries the stage-major floor: this stage's STAGE_STARTED.
  function seedStageMajorReceipt(unit: string): void {
    writeUnitArtifacts(proj, unit);
    const floor = latestMainWorkflowStageRunFloorForProject(proj, SLUG);
    expect(floor).toBe("STAGE_STARTED:2026-01-02T00:00:00Z#1");
    appendFileSync(
      seededAuditShard(proj),
      block("UNIT_COMPLETED", "2026-01-03T00:00:00Z", `**Stage**: ${SLUG}\n**Unit**: ${unit}\n**Run floor**: ${floor}\n`),
    );
    expect(unitCompletedReceipts(proj, SLUG).has(unit)).toBe(true);
  }

  function setPolicy(command: string, value: string): string {
    const result = run(STATE, [command, value], proj);
    expect(result.rc, result.out).toBe(0);
    return result.out;
  }

  test("switching to unit-major keeps a finished Unit and routes the next one", () => {
    policyProject("stage-major");
    seedStageMajorReceipt("unit-a");
    setPolicy("set-construction-iteration", "unit-major");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    const next = runNext(proj);
    expect(next.out).not.toContain('"unit":"unit-a"');
    expect(next.out).toContain('"unit":"unit-b"');
  });

  test("turning Construction Checkpoints on keeps a finished Unit", () => {
    policyProject("stage-major", "disabled");
    seedStageMajorReceipt("unit-a");
    setPolicy("set-construction-checkpoints", "enabled");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    expect(runNext(proj).out).not.toMatch(/"kind":"run-stage"[^\n]*"unit":"unit-a"/);
  });

  // A Unit finished under unit-major flooring, through the real lifecycle verbs,
  // carries the floor that ignored this stage's STAGE_STARTED.
  function finishUnderUnitFlooring(unit: string): void {
    const started = unitVerb(proj, "start", unit);
    expect(started.rc, started.out).toBe(0);
    writeUnitArtifacts(proj, unit);
    const completed = unitVerb(proj, "complete", unit);
    expect(completed.rc, completed.out).toBe(0);
    expect(unitCompletedReceipts(proj, SLUG).has(unit)).toBe(true);
  }

  test("switching back to stage-major keeps a finished Unit and routes the next one", () => {
    policyProject("unit-major");
    finishUnderUnitFlooring("unit-a");
    setPolicy("set-construction-iteration", "stage-major");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    const next = runNext(proj);
    expect(next.out).not.toContain('"unit":"unit-a"');
    expect(next.out).toContain('"unit":"unit-b"');
  });

  test("turning Construction Checkpoints off while stage-major keeps a finished Unit", () => {
    policyProject("stage-major", "enabled");
    // Checkpoints on run this stage as a wave; its receipt carries the floor
    // that ignored the stage's STAGE_STARTED.
    writeUnitArtifacts(proj, "unit-a");
    const floor = latestMainWorkflowStageRunFloorForProject(proj, SLUG, true, "unit-a");
    expect(floor).toBe("WORKFLOW_STARTED:2026-01-01T00:00:00Z#1");
    appendFileSync(
      seededAuditShard(proj),
      block("UNIT_COMPLETED", "2026-01-03T00:00:00Z", `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: ${floor}\n`),
    );
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    setPolicy("set-construction-checkpoints", "disabled");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    expect(runNext(proj).out).not.toMatch(/"kind":"run-stage"[^\n]*"unit":"unit-a"/);
  });

  test("after switching back, a new stage start still starts the Units' work again", () => {
    policyProject("unit-major");
    finishUnderUnitFlooring("unit-a");
    setPolicy("set-construction-iteration", "stage-major");
    appendFileSync(
      seededAuditShard(proj),
      block("STAGE_STARTED", "2099-01-01T00:00:00Z", `**Stage**: ${SLUG}\n`),
    );
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(false);
  });

  test("a stage start recorded under unit-major flooring stays ignored after the switch back", () => {
    const audit = [
      block("WORKFLOW_STARTED", "2026-01-01T00:00:00Z", "**Stage**: intent-capture\n"),
      block("STAGE_STARTED", "2026-01-02T00:00:00Z", `**Stage**: ${SLUG}\n`),
      block("CONSTRUCTION_POLICY_SET", "2026-01-03T00:00:00Z", "**Field**: Construction Iteration\n**Value**: stage-major\n**Previous Value**: unit-major\n**Construction Iteration**: stage-major\n**Construction Checkpoints**: unset\n"),
    ].join("");
    expect(latestMainWorkflowStageRunFloor(audit, SLUG, true)).toBe("WORKFLOW_STARTED:2026-01-01T00:00:00Z#1");
    expect(latestMainWorkflowStageRunFloor(audit, SLUG, false)).toBe("WORKFLOW_STARTED:2026-01-01T00:00:00Z#1");
  });

  test("the change is recorded with the policy it leaves in force", () => {
    policyProject("stage-major");
    setPolicy("set-construction-iteration", "unit-major");
    const rows = readAuditShardEvents(proj).filter((row) => row.event === "CONSTRUCTION_POLICY_SET");
    expect(rows).toHaveLength(1);
    expect(rows[0].block).toContain("**Field**: Construction Iteration");
    expect(rows[0].block).toContain("**Value**: unit-major");
    expect(rows[0].block).toContain("**Previous Value**: stage-major");
    expect(rows[0].block).toContain("**Construction Iteration**: unit-major");
    expect(rows[0].block).toContain("**Construction Checkpoints**: unset");
    // Setting the value it already has changes nothing and records nothing.
    setPolicy("set-construction-iteration", "unit-major");
    expect(readAuditShardEvents(proj).filter((row) => row.event === "CONSTRUCTION_POLICY_SET")).toHaveLength(1);
  });

  test("a later stage start does not take the finished Unit's work away", () => {
    policyProject("stage-major");
    seedStageMajorReceipt("unit-a");
    setPolicy("set-construction-iteration", "unit-major");
    appendFileSync(
      seededAuditShard(proj),
      block("STAGE_STARTED", "2099-01-01T00:00:00Z", `**Stage**: ${SLUG}\n`),
    );
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
  });

  test("a rejection after the change still starts the Unit's work again", () => {
    policyProject("stage-major");
    seedStageMajorReceipt("unit-a");
    setPolicy("set-construction-iteration", "unit-major");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    appendFileSync(
      seededAuditShard(proj),
      block("GATE_REJECTED", "2099-01-01T00:00:00Z", `**Stage**: ${SLUG}\n**Feedback**: redo\n`),
    );
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(false);
  });

  test("a stage start after the last recorded change follows the current policy", () => {
    // The state says unit-major although the last recorded change left
    // stage-major in force (an edit outside the typed setters).
    const audit = [
      block("WORKFLOW_STARTED", "2026-01-01T00:00:00Z", "**Stage**: intent-capture\n"),
      block("CONSTRUCTION_POLICY_SET", "2026-01-02T00:00:00Z", "**Field**: Construction Iteration\n**Value**: stage-major\n**Previous Value**: unit-major\n**Construction Iteration**: stage-major\n**Construction Checkpoints**: unset\n"),
      block("STAGE_STARTED", "2026-01-03T00:00:00Z", `**Stage**: ${SLUG}\n`),
    ].join("");
    expect(latestMainWorkflowStageRunFloor(audit, SLUG, true)).toBe("WORKFLOW_STARTED:2026-01-01T00:00:00Z#1");
    expect(latestMainWorkflowStageRunFloor(audit, SLUG, false)).toBe("STAGE_STARTED:2026-01-03T00:00:00Z#1");
  });

  // A change whose state write failed leaves its row behind; the start and the
  // Unit finished while the old policy still held keep counting after the retry.
  test("a change that never reached the state does not take away work done before the retry", () => {
    policyProject("unit-major");
    const change = (ts: string) =>
      block("CONSTRUCTION_POLICY_SET", ts, "**Field**: Construction Iteration\n**Value**: unit-major\n**Previous Value**: stage-major\n**Construction Iteration**: unit-major\n**Construction Checkpoints**: unset\n");
    appendFileSync(
      seededAuditShard(proj),
      change("2026-01-03T00:00:00Z") +
        block("STAGE_STARTED", "2026-01-04T00:00:00Z", `**Stage**: ${SLUG}\n`) +
        block("UNIT_COMPLETED", "2026-01-05T00:00:00Z", `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: STAGE_STARTED:2026-01-04T00:00:00Z#2\n`) +
        change("2026-01-06T00:00:00Z"),
    );
    writeUnitArtifacts(proj, "unit-a");
    expect(latestMainWorkflowStageRunFloorForProject(proj, SLUG, true)).toBe("STAGE_STARTED:2026-01-04T00:00:00Z#2");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
  });

  // Two clones can record a change and a stage start in the same second. Their
  // order is unknowable, so the start counts whichever shard sorts first.
  test("a stage start in the same second as a change in another shard does not depend on shard names", () => {
    const floors: string[] = [];
    for (const [changeShard, startShard] of [["aaaa-one.md", "zzzz-two.md"], ["zzzz-one.md", "aaaa-two.md"]]) {
      policyProject("unit-major");
      writeFileSync(
        join(seededAuditDir(proj), changeShard),
        "# AI-DLC Audit Log\n" +
          block("CONSTRUCTION_POLICY_SET", "2026-01-03T00:00:00Z", "**Field**: Construction Iteration\n**Value**: unit-major\n**Previous Value**: stage-major\n**Construction Iteration**: unit-major\n**Construction Checkpoints**: unset\n"),
      );
      writeFileSync(
        join(seededAuditDir(proj), startShard),
        `# AI-DLC Audit Log\n${block("STAGE_STARTED", "2026-01-03T00:00:00Z", `**Stage**: ${SLUG}\n`)}`,
      );
      floors.push(latestMainWorkflowStageRunFloorForProject(proj, SLUG, true));
      cleanupTestProject(proj);
      proj = "";
    }
    expect(floors).toEqual(["STAGE_STARTED:2026-01-03T00:00:00Z#2", "STAGE_STARTED:2026-01-03T00:00:00Z#2"]);
  });

  // With checkpoints on, stage starts were never boundaries before or after an
  // iteration change, so a same-second start in another shard stays ignored in
  // either order and the Unit finished before it keeps its receipt.
  test("a same-second stage start stays ignored when checkpoints were already on", () => {
    for (const [changeShard, startShard] of [["aaaa-one.md", "zzzz-two.md"], ["zzzz-one.md", "aaaa-two.md"]]) {
      policyProject("unit-major", "enabled");
      writeUnitArtifacts(proj, "unit-a");
      appendFileSync(
        seededAuditShard(proj),
        block("UNIT_COMPLETED", "2026-01-02T12:00:00Z", `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: WORKFLOW_STARTED:2026-01-01T00:00:00Z#1\n`),
      );
      writeFileSync(
        join(seededAuditDir(proj), changeShard),
        `# AI-DLC Audit Log\n${block("CONSTRUCTION_POLICY_SET", "2026-01-03T00:00:00Z", "**Field**: Construction Iteration\n**Value**: unit-major\n**Previous Value**: stage-major\n**Construction Iteration**: unit-major\n**Construction Checkpoints**: enabled\n")}`,
      );
      writeFileSync(
        join(seededAuditDir(proj), startShard),
        `# AI-DLC Audit Log\n${block("STAGE_STARTED", "2026-01-03T00:00:00Z", `**Stage**: ${SLUG}\n`)}`,
      );
      expect(latestMainWorkflowStageRunFloorForProject(proj, SLUG, true, "unit-a"), changeShard).toBe(
        "WORKFLOW_STARTED:2026-01-01T00:00:00Z#1",
      );
      expect(unitCompletedReceipts(proj, SLUG).has("unit-a"), changeShard).toBe(true);
      cleanupTestProject(proj);
      proj = "";
    }
  });

  // Two clones can each record a change in the same second after a start. Either
  // may be the first change after it, so the start counts if either found
  // stage-major flooring, whichever shard sorts first.
  test("two same-second changes in different shards after a start do not depend on shard names", () => {
    const results: Array<[string, boolean]> = [];
    for (const [stageShard, unitShard] of [["aaaa-one.md", "zzzz-two.md"], ["zzzz-one.md", "aaaa-two.md"]]) {
      policyProject("unit-major");
      writeUnitArtifacts(proj, "unit-a");
      appendFileSync(
        seededAuditShard(proj),
        block("UNIT_COMPLETED", "2026-01-02T12:00:00Z", `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: STAGE_STARTED:2026-01-02T00:00:00Z#1\n`),
      );
      writeFileSync(
        join(seededAuditDir(proj), stageShard),
        `# AI-DLC Audit Log\n${block("CONSTRUCTION_POLICY_SET", "2026-01-03T00:00:00Z", "**Field**: Construction Iteration\n**Value**: unit-major\n**Previous Value**: stage-major\n**Construction Iteration**: unit-major\n**Construction Checkpoints**: unset\n")}`,
      );
      writeFileSync(
        join(seededAuditDir(proj), unitShard),
        `# AI-DLC Audit Log\n${block("CONSTRUCTION_POLICY_SET", "2026-01-03T00:00:00Z", "**Field**: Construction Checkpoints\n**Value**: disabled\n**Previous Value**: enabled\n**Construction Iteration**: stage-major\n**Construction Checkpoints**: disabled\n")}`,
      );
      results.push([
        latestMainWorkflowStageRunFloorForProject(proj, SLUG, true),
        unitCompletedReceipts(proj, SLUG).has("unit-a"),
      ]);
      cleanupTestProject(proj);
      proj = "";
    }
    expect(results).toEqual([
      ["STAGE_STARTED:2026-01-02T00:00:00Z#1", true],
      ["STAGE_STARTED:2026-01-02T00:00:00Z#1", true],
    ]);
  });

  // A clock stepped back: the change is appended after the start in the same
  // shard but carries an earlier time. Append order wins, as everywhere else.
  test("a change appended after a start keeps it even when the clock stepped back", () => {
    policyProject("unit-major");
    writeUnitArtifacts(proj, "unit-a");
    appendFileSync(
      seededAuditShard(proj),
      block("UNIT_COMPLETED", "2026-01-02T12:00:00Z", `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: STAGE_STARTED:2026-01-02T00:00:00Z#1\n`) +
        block("CONSTRUCTION_POLICY_SET", "2026-01-01T23:00:00Z", "**Field**: Construction Iteration\n**Value**: unit-major\n**Previous Value**: stage-major\n**Construction Iteration**: unit-major\n**Construction Checkpoints**: unset\n"),
    );
    expect(latestMainWorkflowStageRunFloorForProject(proj, SLUG, true)).toBe("STAGE_STARTED:2026-01-02T00:00:00Z#1");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    const next = runNext(proj);
    expect(next.out).not.toContain('"unit":"unit-a"');
    expect(next.out).toContain('"unit":"unit-b"');
  });

  // An append cut short leaves a policy row with only its heading, time and
  // event. It says nothing about the policy, so it never moves the floor.
  test("a policy row cut short does not take a finished Unit's work away", () => {
    policyProject("unit-major");
    writeUnitArtifacts(proj, "unit-a");
    appendFileSync(
      seededAuditShard(proj),
      block("UNIT_COMPLETED", "2026-01-02T12:00:00Z", `**Stage**: ${SLUG}\n**Unit**: unit-a\n**Run floor**: WORKFLOW_STARTED:2026-01-01T00:00:00Z#1\n`) +
        "\n## Construction Policy Set\n**Timestamp**: 2026-01-03T00:00:00Z\n**Event**: CONSTRUCTION_POLICY_SET\n",
    );
    expect(latestMainWorkflowStageRunFloorForProject(proj, SLUG, true)).toBe("WORKFLOW_STARTED:2026-01-01T00:00:00Z#1");
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    const next = runNext(proj);
    expect(next.out).not.toContain('"unit":"unit-a"');
    expect(next.out).toContain('"unit":"unit-b"');
  });

  // Swarm convergence and the Plan Approval batch context floor every stage
  // start (they pass unitMajor false), whatever the policy. A recorded change
  // must not change what they read, even for a stage start recorded while Unit
  // receipts ignore stage starts.
  test("readers that count every stage start keep counting them after a change", () => {
    policyProject("stage-major", "disabled");
    setPolicy("set-construction-checkpoints", "enabled");
    const stage = "code-generation";
    appendFileSync(seededAuditShard(proj), block("STAGE_STARTED", "2099-01-01T00:00:00Z", `**Stage**: ${stage}\n`));
    const stageFloor = latestMainWorkflowStageRunFloorForProject(proj, stage, false);
    expect(stageFloor).toBe("STAGE_STARTED:2099-01-01T00:00:00Z#1");
    expect(latestMainWorkflowStageRunFloor(readAllAuditShards(proj), stage)).toBe(stageFloor);
    // Unit receipts under the new policy do not take the later stage start.
    expect(latestMainWorkflowStageRunFloorForProject(proj, stage, true)).toBe(
      "WORKFLOW_STARTED:2026-01-01T00:00:00Z#1",
    );
    appendFileSync(
      seededAuditShard(proj),
      block("SWARM_UNIT_CONVERGED", "2099-01-01T00:00:01Z", `**Stage**: ${stage}\n**Unit name**: unit-a\n**Run floor**: ${stageFloor}\n`),
    );
    expect(swarmConvergedUnits(proj, stage).has("unit-a")).toBe(true);
  });
});
