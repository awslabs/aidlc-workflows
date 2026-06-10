// covers: subcommand:aidlc-learnings:surface, subcommand:aidlc-learnings:persist, subcommand:aidlc-graph:compile, function:parseSensorManifest
//
// t99 (integration) — §13 learning-gate END-TO-END (v0.5.0 milestone 12). Migrated
// from tests/integration/t99-learnings-gate-flow.sh (TAP plan 16).
//
// Mechanism: cli. The body SPAWNS the real tools via the Bun runtime against
// the shipped .ts paths — `aidlc-learnings.ts surface|persist` and
// `aidlc-graph.ts compile` — against a real dist/claude/.claude COPY + audit.md
// + memory.md + state + runtime-graph (the same surface→glue→persist round-trip
// the .sh drove). The process boundary IS the subject: exit codes, on-disk
// audit rows, the learnings-file lines, the two-write sensor bind, and
// concurrent-write serialisation are all observable only through the spawned
// process + the bytes it leaves on disk. Case 3 ALSO imports parseSensorManifest
// IN-PROCESS to prove the scaffolded manifest round-trips through the real
// schema parser (the .sh did this via an inline `bun -e` one-liner) — that is
// the one `function:` unit credited here; everything else is the CLI seam.
//
// Per the .sh header: the conflict-check COMPARISON is the orchestrator-LLM's
// job (KNOWLEDGE) and never lives in the tool. Case 3b models the verdict by
// what the test writes into the selections-json (persist receives only
// conflict-clear / user-escalated selections and never judges) — the §6-E
// non-golden reject path actually fires (empty selections → zero RULE_LEARNED
// rows), and the escalate path writes through.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-learnings.ts
//     surface  (:166) — test-run skip emits {"skipped":"test-run-mode"} (:181-190);
//                        else JSON {schema_version, stage_slug, phase,
//                        memory_entries_total, candidates[], parked_open_questions[]}
//                        (:228-236). Candidate carries {id "c<n>", source_heading,
//                        ts, summary, context, default_scope:"project"} (:218-225);
//                        Open-questions entries are parked, not candidates (:213-216).
//     persist  (:399) — one withAuditLock body (decide-inside-lock). auditTestRun
//                        (:352) skips ALL writes when the most-recent audit block
//                        carries **Test-Run**: true. Writes dated lines under
//                        "## Learnings" to .claude/rules/aidlc-{project,team}-learnings.md
//                        (:451-494) keyed by a `cid:<slug>:<id>` marker (:395), emits
//                        RULE_LEARNED (:475-486). Two-write sensor bind (:500-553):
//                        scaffolds .claude/sensors/aidlc-<id>.md + appends the id to the
//                        origin stage's `sensors:` frontmatter, emits SENSOR_PROPOSED
//                        with Destinations: JSON.stringify([origin_stage]) (:536-549).
//                        Idempotent (row+line both present → no-op, :463) + recovery
//                        (row present, line gone → re-write only, skip emit, :467-487).
//   dist/claude/.claude/tools/aidlc-graph.ts
//     compile  (:1293) — recompiles stage-graph.json (AIDLC_STAGE_GRAPH seam,
//                        :154-162) from stage YAML (AIDLC_STAGES_DIR) + sensors
//                        (AIDLC_SENSORS_DIR); the newly-bound `sensors:` import
//                        resolves into the stage node's sensors_applicable[] (:131-133).
//   dist/claude/.claude/tools/aidlc-sensor-schema.ts
//     parseSensorManifest (:54) — extracts {id, matches, ...} from manifest YAML.
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol.md
//     §13 span "## 13. Learnings Ritual" (:848) → "### Artifact Re-use" (:941):
//     fossil sweep — zero sensor-protocol.md / applies_to / pre-v3 PR-doctor refs.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh assert 1  (Case 1: surface → 3 candidates + 1 parked)        -> "Case 1: surface emits 3 candidates (I/D/T) + 1 parked open question"
//   .sh assert 2  (Case 1: project pick lands in project-learnings)  -> "Case 1: project pick lands in aidlc-project-learnings.md"
//   .sh assert 3  (Case 1: team pick lands in team-learnings)        -> "Case 1: team-scoped pick lands in aidlc-team-learnings.md"
//   .sh assert 4  (Case 1: two RULE_LEARNED rows)                    -> "Case 1: two RULE_LEARNED audit rows"
//   .sh assert 5  (Case 2: surface skipped in test-run mode)         -> "Case 2: surface skipped in test-run mode"
//   .sh assert 6  (Case 2: persist refuses in test-run)              -> "Case 2: persist refuses in test-run — no learnings file written"
//   .sh assert 7  (Case 3: manifest parses via parseSensorManifest)  -> "Case 3: project-tier manifest parses + carries matches glob"
//   .sh assert 8  (Case 3: compile binds id into sensors_applicable) -> "Case 3: next compile binds the id into user-stories sensors_applicable"
//   .sh assert 9  (Case 3: SENSOR_PROPOSED Destinations array)       -> "Case 3: SENSOR_PROPOSED row carries Destinations array [user-stories]"
//   .sh assert 10 (Case 3b: rejected entry never persists)           -> "Case 3b: rejected entry never reaches persist — no RULE_LEARNED row"
//   .sh assert 11 (Case 3b: escalated entry writes through)          -> "Case 3b: user-escalated entry writes through to the learnings file"
//   .sh assert 12 (Case 4: idempotent re-run → 1 row + 1 line)       -> "Case 4: idempotent re-run → exactly one audit row + one file line"
//   .sh assert 13 (Case 5: concurrent persist → 1 row + 1 line)      -> "Case 5: concurrent persist serialises → exactly one row + one line"
//   .sh assert 14 (Case 6: recovery → re-write only, exit 0)         -> "Case 6: recovery re-writes the line, skips re-emit, exit 0"
//   .sh assert 15 (Glue: candidate field contract)                  -> "Glue: candidate carries {id, summary, source_heading, default_scope}"
//   .sh assert 16 (§13 fossil sweep)                                 -> "§13 rewrite carries zero sensor-protocol.md / applies_to / pre-v3 PR-doctor fossils"

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, createTestProject, FIXTURES_DIR } from "../harness/fixtures.ts";
import { parseSensorManifest } from "../../dist/claude/.claude/tools/aidlc-sensor-schema.ts";

const BUN = process.execPath; // the bun running this test
const TOOLS = join(AIDLC_SRC, "tools");
const LEARNINGS_TS = join(TOOLS, "aidlc-learnings.ts");
const GRAPH_TS = join(TOOLS, "aidlc-graph.ts");
const SEED_GRAPH = join(TOOLS, "data", "stage-graph.json");
const FIX = join(FIXTURES_DIR, "v05-mr12-learnings");
const MEMORY_MIXED = join(FIX, "memory-mixed.md");

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
});

/**
 * mkproj — mirrors the .sh mkproj(): a fresh temp project with a full
 * dist/claude/.claude copy, a user-stories state file, and a runtime-graph
 * pointing the stage at its memory.md. The default state is the live
 * (non-test-run) one; callers override aidlc-state.md when they need
 * Test-Run Mode.
 */
function mkproj(): string {
  const pd = createTestProject();
  projects.push(pd);
  cpSync(AIDLC_SRC, join(pd, ".claude"), { recursive: true });
  mkdirSync(join(pd, "aidlc-docs", "inception", "user-stories"), { recursive: true });
  writeFileSync(
    join(pd, "aidlc-docs", "aidlc-state.md"),
    "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
  );
  writeFileSync(
    join(pd, "aidlc-docs", "runtime-graph.json"),
    JSON.stringify({
      workflow_id: "w1",
      scope: "feature",
      started_at: "2026-05-28T13:00:00Z",
      stages: [
        {
          stage_slug: "user-stories",
          memory_path: "aidlc-docs/inception/user-stories/memory.md",
        },
      ],
    }),
  );
  return pd;
}

function seedMemoryMixed(pd: string): void {
  cpSync(MEMORY_MIXED, join(pd, "aidlc-docs", "inception", "user-stories", "memory.md"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Spawn `bun aidlc-learnings.ts surface --slug <slug> --project-dir <pd>`. */
function surface(pd: string, slug = "user-stories"): CliResult {
  const r = spawnSync(BUN, [LEARNINGS_TS, "surface", "--slug", slug, "--project-dir", pd], {
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Spawn `bun aidlc-learnings.ts persist --slug <slug> --selections-json <sel> --project-dir <pd>`. */
function persist(pd: string, sel: string, slug = "user-stories", env?: NodeJS.ProcessEnv): CliResult {
  const r = spawnSync(
    BUN,
    [LEARNINGS_TS, "persist", "--slug", slug, "--selections-json", sel, "--project-dir", pd],
    { encoding: "utf-8", env: env ? { ...process.env, ...env } : process.env },
  );
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readAudit(pd: string): string {
  const p = join(pd, "aidlc-docs", "audit.md");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

function ruleLearnedRows(pd: string): number {
  // Mirror the .sh's `grep -c "Event.*: RULE_LEARNED"`.
  return readAudit(pd)
    .split("\n")
    .filter((l) => /Event.*: RULE_LEARNED/.test(l)).length;
}

function countLines(file: string, needle: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.includes(needle)).length;
}

function projectLearnings(pd: string): string {
  return join(pd, ".claude", "rules", "aidlc-project-learnings.md");
}
function teamLearnings(pd: string): string {
  return join(pd, ".claude", "rules", "aidlc-team-learnings.md");
}

const TIMEOUT = 30000;

describe("t99 §13 learning-gate end-to-end (migrated from t99-learnings-gate-flow.sh, plan 16)", () => {
  // ===========================================================================
  // Case 1 — surface mixed → persist project + team learnings + 2 audit rows.
  // ===========================================================================
  test("Case 1: surface emits 3 candidates (I/D/T) + 1 parked open question [.sh 1]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const r = surface(pd);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    // STRONGER than the .sh's "3:1" string: assert the two array LENGTHS directly.
    expect(j.candidates.length).toBe(3);
    expect(j.parked_open_questions.length).toBe(1);
  }, TIMEOUT);

  test("Case 1: project pick lands in aidlc-project-learnings.md [.sh 2]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const sel = join(pd, "sel1.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "project",
          heading: "Interpretation",
          text: "Reused the existing auth module; saved a full rewrite",
          source: "orchestrator",
        },
        {
          candidate_id: "c2",
          type: "learning",
          scope: "team",
          heading: "Deviation",
          text: "Used Given/When/Then for AC; team standardised",
          source: "orchestrator",
        },
      ],
    });
    expect(persist(pd, sel).status).toBe(0);
    expect(readFileSync(projectLearnings(pd), "utf-8")).toContain("cid:user-stories:c1");
  }, TIMEOUT);

  test("Case 1: team-scoped pick lands in aidlc-team-learnings.md [.sh 3]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const sel = join(pd, "sel1.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "project",
          heading: "Interpretation",
          text: "Reused the existing auth module; saved a full rewrite",
          source: "orchestrator",
        },
        {
          candidate_id: "c2",
          type: "learning",
          scope: "team",
          heading: "Deviation",
          text: "Used Given/When/Then for AC; team standardised",
          source: "orchestrator",
        },
      ],
    });
    expect(persist(pd, sel).status).toBe(0);
    expect(readFileSync(teamLearnings(pd), "utf-8")).toContain("cid:user-stories:c2");
  }, TIMEOUT);

  test("Case 1: two RULE_LEARNED audit rows [.sh 4]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const sel = join(pd, "sel1.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "project",
          heading: "Interpretation",
          text: "Reused the existing auth module; saved a full rewrite",
          source: "orchestrator",
        },
        {
          candidate_id: "c2",
          type: "learning",
          scope: "team",
          heading: "Deviation",
          text: "Used Given/When/Then for AC; team standardised",
          source: "orchestrator",
        },
      ],
    });
    expect(persist(pd, sel).status).toBe(0);
    expect(ruleLearnedRows(pd)).toBe(2);
  }, TIMEOUT);

  // ===========================================================================
  // Case 2 — test-run end-to-end → surface skipped + persist refuses.
  // ===========================================================================
  test("Case 2: surface skipped in test-run mode [.sh 5]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    writeFileSync(
      join(pd, "aidlc-docs", "aidlc-state.md"),
      "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Test-Run Mode**: true\n",
    );
    const r = surface(pd);
    expect(r.status).toBe(0);
    // .sh: assert_contains "$SURF" '"skipped":"test-run-mode"'.
    expect(r.stdout).toContain('"skipped":"test-run-mode"');
    // STRONGER: the parsed payload surfaces zero candidates.
    const j = JSON.parse(r.stdout);
    expect(j.candidates).toEqual([]);
  }, TIMEOUT);

  test("Case 2: persist refuses in test-run — no learnings file written [.sh 6]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    writeFileSync(
      join(pd, "aidlc-docs", "aidlc-state.md"),
      "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Test-Run Mode**: true\n",
    );
    // The most-recent audit block flags Test-Run → persist refuses (auditTestRun).
    writeFileSync(
      join(pd, "aidlc-docs", "audit.md"),
      "\n## Stage Start\n**Timestamp**: 2026-05-29T10:00:00Z\n**Event**: STAGE_STARTED\n**Stage**: user-stories\n**Test-Run**: true\n\n---\n",
    );
    const sel = join(pd, "sel2.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "project",
          heading: "Interpretation",
          text: "should not write",
          source: "orchestrator",
        },
      ],
    });
    expect(persist(pd, sel).status).toBe(0);
    // .sh: assert_file_not_exists project-learnings.md.
    expect(existsSync(projectLearnings(pd))).toBe(false);
    // STRONGER: zero RULE_LEARNED rows emitted either.
    expect(ruleLearnedRows(pd)).toBe(0);
  }, TIMEOUT);

  // ===========================================================================
  // Case 3 — sensor proposal → project-tier manifest + frontmatter bind →
  // compile binds. Drives the parseSensorManifest in-proc check + a real
  // `aidlc-graph compile` against the AIDLC_STAGES_DIR / AIDLC_SENSORS_DIR /
  // AIDLC_STAGE_GRAPH seam, exactly as the .sh did.
  // ===========================================================================
  function seedSensorProposal(pd: string): string {
    const sel = join(pd, "sel3.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c5",
          type: "sensor",
          origin_stage: "user-stories",
          manifest_fields: {
            id: "acceptance-format",
            kind: "deterministic",
            command: "bun .claude/tools/aidlc-sensor.ts fire acceptance-format",
            default_severity: "advisory",
            description: "Checks AC uses Given/When/Then",
            matches: "**/aidlc-docs/inception/user-stories/**",
            timeout_seconds: 30,
          },
        },
      ],
    });
    return sel;
  }

  const STAGES_DIR_OF = (pd: string) => join(pd, ".claude", "aidlc-common", "stages");
  const SENSORS_DIR_OF = (pd: string) => join(pd, ".claude", "sensors");

  test("Case 3: project-tier manifest parses + carries matches glob [.sh 7]", () => {
    const pd = mkproj();
    const sel = seedSensorProposal(pd);
    const r = persist(pd, sel, "user-stories", { AIDLC_STAGES_DIR: STAGES_DIR_OF(pd) });
    expect(r.status).toBe(0);
    const manifest = join(SENSORS_DIR_OF(pd), "aidlc-acceptance-format.md");
    expect(existsSync(manifest)).toBe(true);
    // In-process: the scaffolded manifest round-trips through the REAL schema
    // parser (the .sh's inline `bun -e` parseSensorManifest one-liner).
    const m = parseSensorManifest(readFileSync(manifest, "utf-8"));
    expect(m.id).toBe("acceptance-format");
    expect(m.matches).toBe("**/aidlc-docs/inception/user-stories/**");
  }, TIMEOUT);

  test("Case 3: next compile binds the id into user-stories sensors_applicable [.sh 8]", () => {
    const pd = mkproj();
    const sel = seedSensorProposal(pd);
    expect(
      persist(pd, sel, "user-stories", { AIDLC_STAGES_DIR: STAGES_DIR_OF(pd) }).status,
    ).toBe(0);
    // Recompile against the project's stage tree (now carrying the bound
    // `sensors:` import) + the project's sensors dir, writing to a private graph.
    const sg = join(pd, "sg.json");
    cpSync(SEED_GRAPH, sg);
    const c = spawnSync(BUN, [GRAPH_TS, "compile", "--project-dir", pd], {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_STAGES_DIR: STAGES_DIR_OF(pd),
        AIDLC_SENSORS_DIR: SENSORS_DIR_OF(pd),
        AIDLC_STAGE_GRAPH: sg,
      },
    });
    expect(c.status).toBe(0);
    const g = JSON.parse(readFileSync(sg, "utf-8")) as Array<{
      slug: string;
      sensors_applicable?: Array<{ id: string }>;
    }>;
    const node = g.find((x) => x.slug === "user-stories");
    expect(node).toBeDefined();
    const ids = (node?.sensors_applicable ?? []).map((row) => row.id);
    // .sh: BOUND === "true". Two-write install: the manifest + the frontmatter
    // edit make the id resolvable on the NEXT compile.
    expect(ids).toContain("acceptance-format");
  }, TIMEOUT);

  test("Case 3: SENSOR_PROPOSED row carries Destinations array [user-stories] [.sh 9]", () => {
    const pd = mkproj();
    const sel = seedSensorProposal(pd);
    expect(
      persist(pd, sel, "user-stories", { AIDLC_STAGES_DIR: STAGES_DIR_OF(pd) }).status,
    ).toBe(0);
    const audit = readAudit(pd);
    // Extract the SENSOR_PROPOSED block (the .sh's awk span) and assert the
    // Destinations array landed verbatim.
    const blocks = audit.split(/\n---\n/);
    const spBlock = blocks.find((b) => /Event.*: SENSOR_PROPOSED/.test(b)) ?? "";
    expect(spBlock).toContain('Destinations**: ["user-stories"]');
  }, TIMEOUT);

  // ===========================================================================
  // Case 3b — admission conflict-check (STUBBED verdict). §6-E non-golden: the
  // reject path actually fires (empty selections → zero writes), then the
  // escalate path writes the same entry through.
  // ===========================================================================
  test("Case 3b: rejected entry never reaches persist — no RULE_LEARNED row [.sh 10]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    // Reject verdict: the conflicting candidate was dropped pre-write → empty.
    const sel = join(pd, "sel3b-reject.json");
    writeJson(sel, { stage_slug: "user-stories", selections: [] });
    expect(persist(pd, sel).status).toBe(0);
    // The failure event (a write) MUST NOT fire: zero RULE_LEARNED rows.
    expect(ruleLearnedRows(pd)).toBe(0);
    expect(existsSync(projectLearnings(pd))).toBe(false);
  }, TIMEOUT);

  test("Case 3b: user-escalated entry writes through to the learnings file [.sh 11]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const sel = join(pd, "sel3b-escalate.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c_escalated",
          type: "learning",
          scope: "project",
          heading: "Deviation",
          text: "This project uses long-lived release branches despite the org trunk-based default",
          source: "user_addition",
        },
      ],
    });
    expect(persist(pd, sel).status).toBe(0);
    expect(readFileSync(projectLearnings(pd), "utf-8")).toContain("cid:user-stories:c_escalated");
  }, TIMEOUT);

  // ===========================================================================
  // Case 4 — idempotent re-run (same selections-json) → no-op.
  // ===========================================================================
  test("Case 4: idempotent re-run → exactly one audit row + one file line [.sh 12]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const sel = join(pd, "sel4.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "project",
          heading: "Interpretation",
          text: "kept once",
          source: "orchestrator",
        },
      ],
    });
    expect(persist(pd, sel).status).toBe(0);
    expect(persist(pd, sel).status).toBe(0);
    expect(ruleLearnedRows(pd)).toBe(1);
    expect(countLines(projectLearnings(pd), "cid:user-stories:c1")).toBe(1);
  }, TIMEOUT);

  // ===========================================================================
  // Case 5 — concurrent persist (same selections-json) → exactly one. The
  // withAuditLock serialisation is the subject; both spawns race, the lock
  // sequences them, the cid-marker dedup collapses to one row + one line.
  // ===========================================================================
  test("Case 5: concurrent persist serialises → exactly one row + one line [.sh 13]", async () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const sel = join(pd, "sel5.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "project",
          heading: "Tradeoff",
          text: "race-safe write",
          source: "orchestrator",
        },
      ],
    });
    // Launch two persists concurrently (the .sh's `& ... wait`). Bun.spawn is
    // async, so both processes are genuinely in flight before either is awaited.
    const a = Bun.spawn([BUN, LEARNINGS_TS, "persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const b = Bun.spawn([BUN, LEARNINGS_TS, "persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await Promise.all([a.exited, b.exited]);
    expect(ruleLearnedRows(pd)).toBe(1);
    expect(countLines(projectLearnings(pd), "cid:user-stories:c1")).toBe(1);
  }, TIMEOUT);

  // ===========================================================================
  // Case 6 — recovery: audit row present, file line gone → re-write only,
  // skip re-emit, exit 0.
  // ===========================================================================
  test("Case 6: recovery re-writes the line, skips re-emit, exit 0 [.sh 14]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const sel = join(pd, "sel6.json");
    writeJson(sel, {
      stage_slug: "user-stories",
      selections: [
        {
          candidate_id: "c1",
          type: "learning",
          scope: "project",
          heading: "Deviation",
          text: "recover me",
          source: "orchestrator",
        },
      ],
    });
    expect(persist(pd, sel).status).toBe(0);
    // Simulate crash-between-emit-and-write: strip the file line, keep the row.
    const lf = projectLearnings(pd);
    const stripped = readFileSync(lf, "utf-8")
      .split("\n")
      .filter((l) => !l.includes("cid:user-stories:c1"))
      .join("\n");
    writeFileSync(lf, stripped);
    const r = persist(pd, sel);
    // .sh: EC:ROWS:LINES === "0:1:1".
    expect(r.status).toBe(0);
    expect(ruleLearnedRows(pd)).toBe(1);
    expect(countLines(lf, "cid:user-stories:c1")).toBe(1);
  }, TIMEOUT);

  // ===========================================================================
  // Glue — label → candidate_id → selection-record mapping. The surface JSON
  // must expose {id, summary, source_heading, default_scope} so two
  // implementers can't build incompatible AUQ glue.
  // ===========================================================================
  test("Glue: candidate carries {id, summary, source_heading, default_scope} [.sh 15]", () => {
    const pd = mkproj();
    seedMemoryMixed(pd);
    const r = surface(pd);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    const c = j.candidates[0];
    // .sh: GLUE === "string:string:Interpretations:project".
    expect(typeof c.id).toBe("string");
    expect(typeof c.summary).toBe("string");
    expect(c.source_heading).toBe("Interpretations");
    expect(c.default_scope).toBe("project");
  }, TIMEOUT);

  // ===========================================================================
  // §13 fossil sweep — after the §13 rewrite, the "## 13. Learnings Ritual"
  // span (up to "### Artifact Re-use") must carry ZERO sensor-protocol.md /
  // applies_to / pre-v3 "PR <N>" doctor-coverage refs. Reads the SHIPPED doc.
  // ===========================================================================
  test("§13 rewrite carries zero sensor-protocol.md / applies_to / pre-v3 PR-doctor fossils [.sh 16]", () => {
    const sp = join(
      AIDLC_SRC,
      "aidlc-common",
      "protocols",
      "stage-protocol.md",
    );
    const lines = readFileSync(sp, "utf-8").split("\n");
    // Extract the §13 span: from "## 13. Learnings Ritual" up to (not
    // including) "### Artifact Re-use" — the .sh's awk window.
    let collecting = false;
    const section: string[] = [];
    for (const line of lines) {
      if (line === "## 13. Learnings Ritual") collecting = true;
      if (collecting && line === "### Artifact Re-use (backward jump / redo)") break;
      if (collecting) section.push(line);
    }
    expect(section.length).toBeGreaterThan(0); // span actually found
    const fossilRe = /sensor-protocol\.md|applies_to|milestone 1[0-9]|milestone 9|doctor coverage check/;
    const fossils = section.filter((l) => fossilRe.test(l));
    expect(fossils).toEqual([]);
  }, TIMEOUT);
});
