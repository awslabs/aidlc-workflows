// covers: function:auditShardName, function:auditShardHostSegment, function:cloneIdFileContent, function:ensureCloneId, function:copiedAuditBlocks, function:readAuditShardEvents, function:readAllAuditShards, function:humanTurnState, function:parseAuditShardEvents
//
// t-audit-shard-identity - one audit shard per clone, and copied rows read once.
//
// 1. ONE SHARD PER CLONE. The shard name is `<host>-<token>.md`, and the host is
//    recorded in aidlc/.aidlc-clone-id next to the token when the token is
//    minted. A laptop whose host name changes (a new network, a VPN) or a folder
//    copied to another machine keeps writing the SAME shard; before, every
//    process computed the host from hostname(), so one clone grew a new shard
//    per name and same-second rows across those shards read as unordered.
//    A token-only file from an earlier version is upgraded once, keeping its
//    token.
// 2. COPIED ROWS READ ONCE. A shard copied by a sync tool ("<shard> 2.md") or by
//    hand repeats rows another shard holds. Every copied boundary then tied with
//    itself across two files, so every finished Unit stopped counting and the
//    engine handed the same Unit out again. Files that start alike are copies of
//    one file; readers read a byte-identical timestamped block among them once,
//    from this clone's own shard first, then the larger file, then filename
//    order. Repeats inside one file, and rows two independent clones happen to
//    write alike, stay.
//
// Mechanism: in-process calls to the shipped aidlc-lib.ts readers over seeded
// shard files, plus real CLI spawns of aidlc-audit.ts, aidlc-state.ts and
// aidlc-orchestrate.ts for the process-boundary claims (a spawned tool honours
// the recorded host; the person's Unit walk survives a copied shard).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  artifactFilename,
  auditShardHostSegment,
  auditShardName,
  cloneIdFileContent,
  copiedAuditBlocks,
  ensureCloneId,
  humanTurnState,
  latestMainWorkflowStageRunFloorForProject,
  parseAuditShardEvents,
  readAllAuditShards,
  readAuditShardEvents,
  unitCompletedReceipts,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURE_CLONE_ID,
  runOrchestrateNext,
  seedBoltDag,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const AUDIT = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

// The state grammar separates the stage and its verdict with U+2014.
const STATE_MD = `# AI-DLC State Tracking

## Project Information
- **Project**: copied audit shard
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
- [-] functional-design \u2014 EXECUTE
- [S] nfr-requirements \u2014 EXECUTE
- [S] nfr-design \u2014 EXECUTE
- [S] infrastructure-design \u2014 EXECUTE
- [S] code-generation \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-07-30T00:00:00Z
`;

let proj = "";
afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
});

// A fixture project whose intent resolves (a record with a state file), so
// readers and the CLI use the record's audit dir.
function project(): string {
  const created = createTestProject();
  writeFileSync(seededStateFile(created), STATE_MD, "utf-8");
  return created;
}

function cloneFile(): string {
  return join(proj, "aidlc", ".aidlc-clone-id");
}

// One audit block in the shape the emitter writes (heading, Timestamp, Event,
// fields), so a seeded shard parses exactly like a written one.
function block(event: string, timestamp: string, fields: Record<string, string> = {}): string {
  const lines = Object.entries(fields).map(([key, value]) => `**${key}**: ${value}\n`).join("");
  return `\n## ${event}\n**Timestamp**: ${timestamp}\n**Event**: ${event}\n${lines}\n---\n`;
}

function shard(...blocks: string[]): string {
  return `# AI-DLC Audit Log\n${blocks.join("")}`;
}

function shardFiles(): string[] {
  return readdirSync(seededAuditDir(proj)).filter((file) => file.endsWith(".md")).sort();
}

function writeOwnShard(content: string): string {
  const path = seededAuditShard(proj);
  mkdirSync(seededAuditDir(proj), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return path;
}

function copyAs(path: string, suffix: string): string {
  const copy = path.replace(/\.md$/, `${suffix}.md`);
  copyFileSync(path, copy);
  return copy;
}

function rowsView(rows: ReturnType<typeof readAuditShardEvents>) {
  return rows.map((row) => ({ event: row.event, timestamp: row.timestamp, block: row.block, shard: basename(row.shard) }));
}

const T0 = "2026-09-01T09:00:00Z";
const T1 = "2026-09-01T14:00:00Z";
const T2 = "2026-09-01T14:05:00Z";

describe("t-audit-shard-identity: one shard per clone", () => {
  test("a new clone records its host next to its token, and the shard uses that host", () => {
    proj = project();
    rmSync(cloneFile());
    const name = auditShardName(proj);
    const recorded = readFileSync(cloneFile(), "utf-8");
    const match = /^([a-z0-9]{12})\n([a-z0-9][a-z0-9-]*)\n$/.exec(recorded);
    expect(match, recorded).not.toBeNull();
    expect(match![2]).toBe(auditShardHostSegment());
    expect(name).toBe(`${match![2]}-${match![1]}.md`);
    expect(ensureCloneId(proj)).toBe(match![1]);
  });

  test("the recorded host names the shard in every process, whatever the machine is called now", () => {
    proj = project();
    // The folder was minted on laptop-a and is now used on this machine.
    expect(auditShardHostSegment()).not.toBe("laptop-a");
    writeFileSync(cloneFile(), cloneIdFileContent(FIXTURE_CLONE_ID, "laptop-a"), "utf-8");
    expect(auditShardName(proj)).toBe(`laptop-a-${FIXTURE_CLONE_ID}.md`);

    const env = { ...process.env };
    delete env.AWS_AIDLC_DEFAULT_SCOPE;
    const appended = spawnSync(
      BUN,
      [AUDIT, "append", "HEALTH_CHECKED", "--field", "Details=written on another machine", "--project-dir", proj],
      { encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
    );
    expect(appended.status, `${appended.stdout}${appended.stderr}`).toBe(0);
    expect(shardFiles()).toEqual([`laptop-a-${FIXTURE_CLONE_ID}.md`]);
    expect(readFileSync(join(seededAuditDir(proj), `laptop-a-${FIXTURE_CLONE_ID}.md`), "utf-8"))
      .toContain("written on another machine");
    expect(readFileSync(cloneFile(), "utf-8")).toBe(cloneIdFileContent(FIXTURE_CLONE_ID, "laptop-a"));
  });

  test("a token-only file from an earlier version is upgraded once and keeps its token", () => {
    proj = project();
    expect(readFileSync(cloneFile(), "utf-8")).toBe(`${FIXTURE_CLONE_ID}\n`);
    expect(auditShardName(proj)).toBe(basename(seededAuditShard(proj)));
    expect(readFileSync(cloneFile(), "utf-8")).toBe(cloneIdFileContent(FIXTURE_CLONE_ID, auditShardHostSegment()));
  });

  test("an unusable host line is replaced and the token kept", () => {
    proj = project();
    writeFileSync(cloneFile(), `${FIXTURE_CLONE_ID}\nBad Host!\n`, "utf-8");
    expect(auditShardName(proj)).toBe(basename(seededAuditShard(proj)));
    expect(readFileSync(cloneFile(), "utf-8")).toBe(cloneIdFileContent(FIXTURE_CLONE_ID, auditShardHostSegment()));
  });
});

describe("t-audit-shard-identity: copied rows are read once", () => {
  const original = () => shard(
    block("WORKFLOW_STARTED", T0, { Scope: "feature" }),
    block("STAGE_STARTED", T1, { Stage: "nfr-design" }),
    block("UNIT_STARTED", T1, { Stage: "nfr-design", Unit: "unit-a" }),
  );

  test("a sync-tool copy of the shard changes no row, floor or merged buffer", () => {
    proj = project();
    const own = writeOwnShard(original());
    const before = rowsView(readAuditShardEvents(proj));
    const floorBefore = latestMainWorkflowStageRunFloorForProject(proj, "nfr-design");
    const bufferBefore = readAllAuditShards(proj);

    copyAs(own, " 2");
    expect(shardFiles()).toHaveLength(2);
    expect(rowsView(readAuditShardEvents(proj))).toEqual(before);
    expect(latestMainWorkflowStageRunFloorForProject(proj, "nfr-design")).toBe(floorBefore);
    expect(floorBefore).toBe(`STAGE_STARTED:${T1}#1`);
    const buffer = readAllAuditShards(proj);
    expect(buffer.match(/\*\*Event\*\*: STAGE_STARTED/g)).toHaveLength(1);
    expect(buffer.match(/\*\*Event\*\*: STAGE_STARTED/g)).toEqual(bufferBefore.match(/\*\*Event\*\*: STAGE_STARTED/g));
  });

  test("a copy that grew elsewhere keeps its new rows, and this clone's shard keeps the shared ones", () => {
    proj = project();
    const own = writeOwnShard(original());
    const copy = own.replace(/\.md$/, " (1).md");
    // The copy is LARGER than this clone's shard: it carries three rows the
    // other machine added after the copy was taken.
    writeFileSync(
      copy,
      original() +
        block("UNIT_COMPLETED", T2, { Stage: "nfr-design", Unit: "unit-a", Note: "other machine 1" }) +
        block("HEALTH_CHECKED", T2, { Details: "other machine 2" }) +
        block("HEALTH_CHECKED", T2, { Details: "other machine 3" }),
      "utf-8",
    );
    const rows = rowsView(readAuditShardEvents(proj));
    const shared = rows.filter((row) => row.timestamp !== T2);
    expect(shared.map((row) => row.event)).toEqual(["WORKFLOW_STARTED", "STAGE_STARTED", "UNIT_STARTED"]);
    expect(new Set(shared.map((row) => row.shard))).toEqual(new Set([basename(own)]));
    const grown = rows.filter((row) => row.timestamp === T2);
    expect(grown).toHaveLength(3);
    expect(new Set(grown.map((row) => row.shard))).toEqual(new Set([basename(copy)]));
  });

  test("between two shards that are neither this clone's, the larger one keeps the shared rows", () => {
    proj = project();
    const dir = seededAuditDir(proj);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a-laptop-111111111111.md"), original(), "utf-8");
    writeFileSync(
      join(dir, "b-laptop-111111111111.md"),
      original() + block("HEALTH_CHECKED", T2, { Details: "later" }),
      "utf-8",
    );
    const rows = rowsView(readAuditShardEvents(proj));
    expect(rows.map((row) => row.event)).toEqual([
      "WORKFLOW_STARTED", "STAGE_STARTED", "UNIT_STARTED", "HEALTH_CHECKED",
    ]);
    expect(new Set(rows.map((row) => row.shard))).toEqual(new Set(["b-laptop-111111111111.md"]));
  });

  test("two clones that wrote one identical row are not copies of each other", () => {
    proj = project();
    const dir = seededAuditDir(proj);
    mkdirSync(dir, { recursive: true });
    const same = block("HEALTH_CHECKED", T2, { Details: "same second, same words" });
    writeFileSync(join(dir, "a-laptop-111111111111.md"), shard(block("SESSION_STARTED", T0, { Session: "a" }), same), "utf-8");
    writeFileSync(join(dir, "b-laptop-222222222222.md"), shard(block("SESSION_STARTED", T1, { Session: "b" }), same), "utf-8");
    expect(readAuditShardEvents(proj).filter((row) => row.event === "HEALTH_CHECKED")).toHaveLength(2);
  });

  test("repeats inside one file are not copies and stay", () => {
    proj = project();
    const twice = block("HEALTH_CHECKED", T1, { Details: "same second, same words" });
    writeOwnShard(shard(twice, twice));
    expect(readAuditShardEvents(proj).filter((row) => row.event === "HEALTH_CHECKED")).toHaveLength(2);
  });

  test("a copied gate answer does not use up the person's later turn", () => {
    proj = project();
    // This clone recorded the approval and then the person's next turn in the
    // same second; the copy was taken between the two writes.
    const approved = block("GATE_APPROVED", T1, { Stage: "nfr-design" });
    const own = writeOwnShard(shard(approved, block("HUMAN_TURN", T1, { Session: "s1" })));
    expect(humanTurnState(proj)).toBe("acted");
    writeFileSync(own.replace(/\.md$/, " 2.md"), shard(approved), "utf-8");
    expect(humanTurnState(proj)).toBe("acted");
  });

  test("readers never write: a copy found while reading leaves a token-only clone file alone", () => {
    proj = project();
    copyAs(writeOwnShard(original()), " 2");
    readAuditShardEvents(proj);
    readAllAuditShards(proj);
    humanTurnState(proj);
    expect(readFileSync(cloneFile(), "utf-8")).toBe(`${FIXTURE_CLONE_ID}\n`);
  });

  test("the rule takes positions in the parser's block sequence", () => {
    const shared = block("STAGE_STARTED", T1, { Stage: "nfr-design" });
    const texts = [
      { shard: "audit/x 2.md", content: shard(shared) },
      { shard: "audit/x.md", content: shard(shared, block("HEALTH_CHECKED", T2)) },
    ];
    const copied = copiedAuditBlocks(texts, () => null);
    // Block 0 carries the file header and the first row in both files.
    expect([...copied[0]]).toEqual([0]);
    expect(copied[1].size).toBe(0);
    expect(parseAuditShardEvents(texts[0].content, texts[0].shard, 0, copied[0])).toEqual([]);
    expect(parseAuditShardEvents(texts[1].content, texts[1].shard, 1, copied[1]).map((row) => row.event))
      .toEqual(["STAGE_STARTED", "HEALTH_CHECKED"]);
  });
});

// The person's view: a Unit they finished stays finished when a sync tool
// copies the audit file. Before, `next` handed unit-a out again, forever.
describe("t-audit-shard-identity: the Unit walk survives a copied audit file", () => {
  const SLUG = "functional-design";
  const PRODUCES = ["entities", "rules", "functional-spec", "traceability"];

  function env(): NodeJS.ProcessEnv {
    const e = { ...process.env };
    delete e.AWS_AIDLC_DEFAULT_SCOPE;
    return e;
  }

  function unitVerb(action: string, unit: string): { rc: number; out: string } {
    const e = env();
    // unit complete verifies the Unit's artifacts; keep that check on.
    delete e.AIDLC_SKIP_ARTIFACT_GUARD;
    const r = spawnSync(
      BUN,
      [STATE, "unit", action, "--stage", SLUG, "--unit", unit, "--project-dir", proj],
      { encoding: "utf-8", env: e, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
    );
    return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  function nextUnit(): unknown {
    return runOrchestrateNext(ORCHESTRATE, proj, [], { env: env() }).directive?.unit;
  }

  test("a finished Unit stays finished and the next Unit is handed out", () => {
    proj = createOrchestrationTestProject();
    writeFileSync(seededStateFile(proj), STATE_MD, "utf-8");
    seedBoltDag(proj, ["unit-a", "unit-b"]);
    const started = spawnSync(
      BUN,
      [AUDIT, "append", "WORKFLOW_STARTED", "--field", "Scope=feature", "--project-dir", proj],
      { encoding: "utf-8", env: env(), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
    );
    expect(started.status, `${started.stdout}${started.stderr}`).toBe(0);

    expect(nextUnit()).toBe("unit-a");
    expect(unitVerb("start", "unit-a").rc).toBe(0);
    const dir = join(seededRecordDir(proj), "construction", "unit-a", SLUG);
    mkdirSync(dir, { recursive: true });
    for (const name of PRODUCES) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\nstub\n`, "utf-8");
    const completed = unitVerb("complete", "unit-a");
    expect(completed.rc, completed.out).toBe(0);
    expect(nextUnit()).toBe("unit-b");

    copyAs(seededAuditShard(proj), " 2");
    expect(shardFiles()).toHaveLength(2);
    expect(unitCompletedReceipts(proj, SLUG).has("unit-a")).toBe(true);
    expect(nextUnit()).toBe("unit-b");
    const again = unitVerb("start", "unit-a");
    expect(again.rc).not.toBe(0);
    expect(again.out).toContain("Refusing to start unit");
    expect(again.out).toMatch(/routes \\+"functional-design\\+"\/\\+"unit-b/);
  });
});
