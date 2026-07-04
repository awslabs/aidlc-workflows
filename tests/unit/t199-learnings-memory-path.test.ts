// covers: subcommand:aidlc-runtime:compile, subcommand:aidlc-learnings:surface
//
// t199 - the per-intent memory path is recorded (write side) and read (read
// side) across the workspace layout.
//
// Mechanism: cli. Both sides are exercised by spawning the shipped tools through
// the bun runtime: `aidlc-runtime compile` writes the runtime-graph.json rows,
// `aidlc-learnings surface` reads a row's memory_path and derives the phase. The
// process boundary plus the bytes on disk are the subject; an in-process twin
// would lose the record-cursor resolution the tools do against the project tree.
//
// TWO DEFECTS PINNED (both made `learnings surface` dead under the workspace
// layout):
//   WRITE SIDE - compile recorded memory_path as `<bare-space-prefix>/<phase>/
//     <slug>/memory.md`, dropping the active intent's record dir
//     (aidlc/spaces/<sp>/intents/<slug>-<id8>). The state advance transition had
//     the same 2-arg relativeMemoryPath call. surface then join()'d that against
//     projectDir and missed the real diary, surfacing zero candidates.
//   READ SIDE - surface extracted the phase as memRel.split("/")[1], which under
//     the workspace prefix is "spaces", not the real phase. The robust extraction
//     is the third-from-last segment: memory_path always ends
//     `<prefix>/<phase>/<stageSlug>/memory.md` regardless of prefix shape.
//
// The legacy flat path `aidlc-docs/<phase>/<slug>/memory.md` shares that tail, so
// the read-side fix degrades correctly there too - the third case pins it.
//
// Source under test (dist/claude/.claude/tools/):
//   aidlc-runtime.ts compile      - the runtime-graph row's memory_path.
//   aidlc-learnings.ts surface    - the phase extraction + diary read.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const RUNTIME_TS = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const LEARNINGS_TS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");

// The active intent's RELATIVE record prefix a seeded workspace project resolves
// (createTestProject seeds the active-intent cursor at DEFAULT_RECORD_DIR).
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
});

/** A minimal audit shard: one WORKFLOW_STARTED + one STAGE_STARTED for a stage
 *  whose phase the stage-graph knows (user-stories -> inception). */
function auditShard(): string {
  return [
    "# AI-DLC Audit Log",
    "",
    "## Workflow Started",
    "**Timestamp**: 2026-05-28T08:00:00Z",
    "**Event**: WORKFLOW_STARTED",
    "**Workflow ID**: t199",
    "**Scope**: feature",
    "",
    "---",
    "",
    "## Stage Started",
    "**Timestamp**: 2026-05-28T08:01:00Z",
    "**Event**: STAGE_STARTED",
    "**Stage**: user-stories",
    "**Agent**: aidlc-product-agent",
    "",
    "---",
    "",
  ].join("\n");
}

/** Seed a per-intent workspace project with the state + audit compile needs. */
function mkWorkspaceProject(): string {
  const pd = createTestProject();
  projects.push(pd);
  const rec = seededRecordDir(pd);
  mkdirSync(rec, { recursive: true });
  writeFileSync(
    seededStateFile(pd),
    "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
  );
  const shard = seededAuditShard(pd);
  mkdirSync(join(rec, "audit"), { recursive: true });
  writeFileSync(shard, auditShard());
  return pd;
}

/** memory.md with one Interpretations entry so surface yields a candidate only
 *  when it resolved the diary at the right path. */
function memoryDiary(): string {
  // parseMemoryEntryLine counts any non-empty line under a heading as one entry
  // (a canonical `<ts> - <text>` bullet is parsed further, a bare line degrades
  // to a raw entry), so this single bullet yields exactly one candidate.
  return [
    "## Interpretations",
    "- Reused the existing auth module; saved a rewrite this stage",
    "",
  ].join("\n");
}

const TIMEOUT = 30000;

describe("t199 per-intent memory path (write + read)", () => {
  // ===========================================================================
  // WRITE SIDE - compile records memory_path WITH the per-intent record dir.
  // ===========================================================================
  test("compile records a memory_path that includes the per-intent record dir", () => {
    const pd = mkWorkspaceProject();
    const r = spawnSync(BUN, [RUNTIME_TS, "--project-dir", pd, "compile"], {
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    const graph = JSON.parse(
      readFileSync(join(seededRecordDir(pd), "runtime-graph.json"), "utf-8"),
    );
    const row = graph.stages.find(
      (s: { stage_slug: string }) => s.stage_slug === "user-stories",
    );
    expect(row).toBeDefined();
    // The row's memory_path carries the active intent's record dir, not the bare
    // space prefix - so join(projectDir, memory_path) points at the real diary.
    expect(row.memory_path).toBe(`${RP}/inception/user-stories/memory.md`);
  }, TIMEOUT);

  // ===========================================================================
  // READ SIDE - surface finds the diary + derives the phase under the workspace
  // layout. Drives the write side first so the row is real, then seeds the diary
  // at the recorded path.
  // ===========================================================================
  test("surface finds the diary and reports the correct phase under the workspace layout", () => {
    const pd = mkWorkspaceProject();
    expect(
      spawnSync(BUN, [RUNTIME_TS, "--project-dir", pd, "compile"], {
        encoding: "utf-8",
      }).status,
    ).toBe(0);
    // Seed memory.md at the per-intent record path the row now records.
    const diaryDir = join(seededRecordDir(pd), "inception", "user-stories");
    mkdirSync(diaryDir, { recursive: true });
    writeFileSync(join(diaryDir, "memory.md"), memoryDiary());

    const s = spawnSync(
      BUN,
      [LEARNINGS_TS, "surface", "--slug", "user-stories", "--project-dir", pd],
      { encoding: "utf-8" },
    );
    expect(s.status).toBe(0);
    const out = JSON.parse(s.stdout);
    // The phase is the real one (inception), NOT "spaces" (the old front-index bug).
    expect(out.phase).toBe("inception");
    // The diary was resolved: one Interpretations entry -> one candidate.
    expect(out.candidates.length).toBe(1);
  }, TIMEOUT);

  // ===========================================================================
  // LEGACY FLAT LAYOUT - a hand-written flat memory_path still degrades
  // correctly: the phase is extracted right and no crash. Seeds the flat
  // aidlc-docs/ shape directly (a pre-workspace project awaiting migration).
  // ===========================================================================
  test("surface extracts the right phase from a legacy flat memory_path", () => {
    const pd = mkWorkspaceProject();
    // Overwrite the runtime-graph with a flat-layout row (no per-intent prefix).
    const rec = seededRecordDir(pd);
    writeFileSync(
      join(rec, "runtime-graph.json"),
      JSON.stringify({
        workflow_id: "w1",
        scope: "feature",
        started_at: "2026-05-28T08:00:00Z",
        stages: [
          {
            stage_slug: "user-stories",
            memory_path: "aidlc-docs/inception/user-stories/memory.md",
          },
        ],
      }),
    );
    // Seed the diary at the flat path (relative to projectDir, per surface's join).
    const flatDir = join(pd, "aidlc-docs", "inception", "user-stories");
    mkdirSync(flatDir, { recursive: true });
    writeFileSync(join(flatDir, "memory.md"), memoryDiary());

    const s = spawnSync(
      BUN,
      [LEARNINGS_TS, "surface", "--slug", "user-stories", "--project-dir", pd],
      { encoding: "utf-8" },
    );
    expect(s.status).toBe(0);
    const out = JSON.parse(s.stdout);
    expect(out.phase).toBe("inception");
    expect(out.candidates.length).toBe(1);
  }, TIMEOUT);

  // A guard-rail: the runtime-graph.json must exist where surface reads it (the
  // seeded record root), proving compile wrote to the per-intent record dir.
  test("compile writes runtime-graph.json under the per-intent record dir", () => {
    const pd = mkWorkspaceProject();
    expect(
      spawnSync(BUN, [RUNTIME_TS, "--project-dir", pd, "compile"], {
        encoding: "utf-8",
      }).status,
    ).toBe(0);
    expect(existsSync(join(seededRecordDir(pd), "runtime-graph.json"))).toBe(true);
  }, TIMEOUT);
});
