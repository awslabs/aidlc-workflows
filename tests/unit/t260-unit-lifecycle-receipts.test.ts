// covers: subcommand:aidlc-state:unit, function:unitCompletedReceipts, function:unitLifecycleReceiptsInUse, function:activeUnitCheckpoint, function:latestMainWorkflowStageRunFloor, function:latestMainWorkflowStageRunFloorForProject, function:readAuditShardEvents, function:isRegularFile, audit:UNIT_STARTED, audit:UNIT_PAUSED, audit:UNIT_RESUMED, audit:UNIT_COMPLETED
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
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  parseBoltDag,
  readAllAuditShards,
  unitCompletedReceipts,
  unitLifecycleReceiptsInUse,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

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
    { encoding: "utf-8", env },
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
function constructionProject(): string {
  proj = createOrchestrationTestProject();
  writeFileSync(seededStateFile(proj), CONSTRUCTION_STATE, "utf-8");
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
    constructionProject();
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
  }, 30000);

  test("unit start uses top-level next/continue verbs through the compiled dispatcher seam", () => {
    constructionProject();
    const dispatcher = join(proj, "aidlc-compiled-shim");
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

    const started = unitVerb(proj, "start", "unit-a", [], {
      AIDLC_COMPILED_EXECUTABLE: dispatcher,
    });
    expect(started.rc).toBe(0);
    expect(started.out).toContain("UNIT_STARTED");
  }, 30000);

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
  }, 30000);
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
  }, 30000);

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
  }, 30000);

  test("`next` emits a paused-unit ask (unit_state: paused) and names the checkpoint", () => {
    constructionProject();
    pauseUnitA();
    const r = runNext(proj);
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

describe("t260 receipts bind to an exact stage attempt", () => {
  test("a same-second receipt from the prior attempt does not settle the new attempt", () => {
    constructionProject();
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
    constructionProject();
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
    expect(unitVerb(proj, "start", "unit-a").rc).toBe(0);
    expect(readAllAuditShards(proj)).toMatch(
      /\*\*Run floor\*\*: AMBIGUOUS:2026-08-05T00:00:00Z#[0-9a-f]{12}/,
    );
  });
});
