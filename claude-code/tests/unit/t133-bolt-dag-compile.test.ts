// covers: subcommand:aidlc-runtime:compile, subcommand:aidlc-sensor-required-sections, function:parseBoltDag
//
// t133 — Bolt-DAG runtime compile + gate-time edge-block sensor. Migrated from
// tests/unit/t133-bolt-dag-compile.sh (TAP plan 10).
//
// Mechanism: cli. Both surfaces under test are process-boundary seams that the
// .sh exercised by shelling out, and that an in-process import would lose:
//   - aidlc-runtime.ts `compile` writes runtime-graph.json to disk (the bolt_dag
//     node is only observable as on-disk bytes) and writes the omit-diagnostic to
//     STDERR (computeBoltDag, aidlc-runtime.ts:303-306). Byte-identical recompile
//     is a disk-bytes contract, not a return value.
//   - aidlc-sensor-required-sections.ts writes its Result JSON to STDOUT and
//     terminates with process.exit(0) (:101-102) — a CLI shell. The edge_block
//     field + pass flag are only observable on that stdout.
// Both spawn the real .ts via the BUN runtime (process.execPath) against the
// dist/ tool path — the same broadened-cli pattern milestone 3 credits (cf.
// tests/integration/t48-runtime-graph-end-to-end.test.ts, tests/feature/t104).
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-runtime.ts
//     :297 computeBoltDag(projectDir) — reads unit-of-work-dependency.md, calls
//          parseBoltDag; returns undefined (node omitted) + STDERR diagnostic on
//          absent/malformed/cyclic; pure data, no Date.now → byte-identical recompile.
//     :758-761 compile() appends graph.bolt_dag only when computeBoltDag returns
//          a node, so the absent envelope keeps key order {workflow_id, scope,
//          started_at, stages} (the pre-milestone-15 4-key shape).
//   dist/claude/.claude/tools/aidlc-sensor-required-sections.ts
//     :89-97 filename-gated extension: for unit-of-work-dependency.md, sets
//          result.edge_block = parseBoltDag().reason (or "ok"); a non-ok block
//          forces pass:false. Every other markdown keeps the generic ≥2-H2 check
//          with NO edge_block field.
//   dist/claude/.claude/tools/aidlc-lib.ts
//     :1968 parseBoltDag(body) — the single source of truth both consumers
//          branch on: {ok,units,batches} | {ok:false, reason: absent|malformed|cyclic}.
//          :1932 computeBatches — Kahn-by-level, each level sorted lexicographically.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1  valid block → bolt_dag node + 4 units             -> "valid edge block: bolt_dag node with 4 units"
//   .sh 2  batches are sorted topological levels             -> "valid edge block: batches are correct sorted topological levels"
//   .sh 3  second compile byte-identical                      -> "second compile is byte-identical (pure-data parse)"
//   .sh 4  cyclic → node omitted + stderr 'cyclic'            -> "cyclic edge block: bolt_dag omitted + stderr names 'cyclic'"
//   .sh 5  malformed (dangling) → omitted + stderr 'malformed' -> "malformed edge block: bolt_dag omitted + stderr names 'malformed'"
//   .sh 6  absent artifact → 4-key envelope                   -> "absent artifact: envelope keeps the pre-milestone-15 4-key shape"
//   .sh 7  sensor valid → pass:true, edge_block:ok            -> "sensor: valid block → pass:true, edge_block:ok"
//   .sh 8  sensor cyclic → pass:false, edge_block:cyclic      -> "sensor: cyclic block → pass:false, edge_block:cyclic"
//   .sh 9  sensor absent → pass:false, edge_block:absent      -> "sensor: absent block → pass:false, edge_block:absent"
//   .sh 10 sensor non-target md keeps generic check           -> "sensor: non-target markdown keeps generic H2 check (no edge_block)"

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR, toPortablePath } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const RUNTIME = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-required-sections.ts");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-construction.md");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// make_project (.sh:66-99): aidlc-state.md (the construction fixture) + an
// audit.md carrying WORKFLOW_STARTED so compile builds a real header rather
// than the empty-graph short-circuit. Each call is a fresh dir, torn down in
// afterAll — same isolation the .sh's mktemp -d + EXIT trap gave.
const AUDIT_MD = `# AI-DLC Audit Log

## Workflow Started
**Timestamp**: 2026-06-06T08:00:00Z
**Event**: WORKFLOW_STARTED
**Workflow ID**: t133-fixture
**Scope**: feature

---

## Stage Started
**Timestamp**: 2026-06-06T08:01:00Z
**Event**: STAGE_STARTED
**Stage**: units-generation
**Agent**: aidlc-architect-agent

---

## Stage Completed
**Timestamp**: 2026-06-06T08:02:00Z
**Event**: STAGE_COMPLETED
**Stage**: units-generation

---
`;

function makeProject(): string {
  let proj = mkdtempSync(join(tmpdir(), "aidlc-t133-"));
  proj = toPortablePath(proj);
  tempDirs.push(proj);
  mkdirSync(join(proj, "aidlc-docs", "inception", "units-generation"), {
    recursive: true,
  });
  cpSync(STATE_FIXTURE, join(proj, "aidlc-docs", "aidlc-state.md"));
  writeFileSync(join(proj, "aidlc-docs", "audit.md"), AUDIT_MD, "utf-8");
  return proj;
}

function uowdPath(proj: string): string {
  return join(
    proj,
    "aidlc-docs",
    "inception",
    "units-generation",
    "unit-of-work-dependency.md",
  );
}

function graphPath(proj: string): string {
  return join(proj, "aidlc-docs", "runtime-graph.json");
}

// write_uowd (.sh:102-114): unit-of-work-dependency.md with the given fenced
// block body wrapped in prose H2 sections.
function writeUowd(proj: string, block: string): void {
  const body = [
    "# Unit Dependency DAG",
    "",
    "## Dependencies",
    block,
    "",
    "## Integration Points",
    "REST APIs between units.",
    "",
  ].join("\n");
  writeFileSync(uowdPath(proj), body, "utf-8");
}

interface CompileRun {
  stderr: string;
}

// run_compile (.sh:124-127): `bun RUNTIME compile --project-dir <proj>`,
// capturing stderr (the omit diagnostic surface).
function runCompile(proj: string): CompileRun {
  const res = spawnSync(BUN, [RUNTIME, "compile", "--project-dir", proj], {
    encoding: "utf-8",
  });
  return { stderr: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary compiled-graph shape
function readGraph(proj: string): any {
  return JSON.parse(readFileSync(graphPath(proj), "utf-8"));
}

interface SensorResult {
  pass: boolean;
  edge_block?: string;
  raw: string;
}

function runSensor(outputPath: string): SensorResult {
  const res = spawnSync(
    BUN,
    [SENSOR, "--stage", "units-generation", "--output-path", outputPath],
    { encoding: "utf-8" },
  );
  const raw = res.stdout ?? "";
  const parsed = JSON.parse(raw.trim());
  return { pass: parsed.pass, edge_block: parsed.edge_block, raw };
}

const VALID_BLOCK = [
  "```yaml",
  "units:",
  "  - name: api",
  "    depends_on: [auth, db]",
  "  - name: auth",
  "    depends_on: []",
  "  - name: db",
  "    depends_on: []",
  "  - name: ui",
  "    depends_on: [api]",
  "```",
].join("\n");

const CYCLIC_BLOCK = [
  "```yaml",
  "units:",
  "  - name: a",
  "    depends_on: [b]",
  "  - name: b",
  "    depends_on: [a]",
  "```",
].join("\n");

const DANGLING_BLOCK = [
  "```yaml",
  "units:",
  "  - name: a",
  "    depends_on: [does-not-exist]",
  "```",
].join("\n");

describe("t133 Bolt-DAG runtime compile (migrated from t133-bolt-dag-compile.sh, plan 10)", () => {
  // ---- 1 & 2: valid block → bolt_dag node + correct batches ----------------
  test("valid edge block: bolt_dag node with 4 units [.sh test 1]", () => {
    const proj = makeProject();
    writeUowd(proj, VALID_BLOCK);
    runCompile(proj);
    const g = readGraph(proj);
    expect("bolt_dag" in g).toBe(true);
    expect(Array.isArray(g.bolt_dag.units)).toBe(true);
    expect(g.bolt_dag.units.length).toBe(4);
  }, 30000);

  test("valid edge block: batches are correct sorted topological levels [.sh test 2]", () => {
    const proj = makeProject();
    writeUowd(proj, VALID_BLOCK);
    runCompile(proj);
    const g = readGraph(proj);
    // auth+db (no deps) batch 0, sorted; api (deps satisfied) batch 1; ui batch 2.
    expect(g.bolt_dag.batches).toEqual([["auth", "db"], ["api"], ["ui"]]);
  }, 30000);

  // ---- 3: byte-identical re-compile (determinism) --------------------------
  test("second compile is byte-identical (pure-data parse) [.sh test 3]", () => {
    const proj = makeProject();
    writeUowd(proj, VALID_BLOCK);
    runCompile(proj);
    const first = readFileSync(graphPath(proj), "utf-8");
    runCompile(proj);
    const second = readFileSync(graphPath(proj), "utf-8");
    // Stronger than the .sh's `diff -q`: assert exact byte equality of the
    // whole file (no Date.now / Set-order nondeterminism in the bolt_dag path).
    expect(second).toBe(first);
  }, 30000);

  // ---- 4: cyclic block → node omitted + stderr diagnostic ------------------
  test("cyclic edge block: bolt_dag omitted + stderr names 'cyclic' [.sh test 4]", () => {
    const proj = makeProject();
    writeUowd(proj, CYCLIC_BLOCK);
    const { stderr } = runCompile(proj);
    const g = readGraph(proj);
    expect("bolt_dag" in g).toBe(false);
    expect(stderr).toContain("cyclic");
  }, 30000);

  // ---- 5: malformed (dangling dep) → node omitted + stderr diagnostic ------
  test("malformed edge block (dangling dep): bolt_dag omitted + stderr names 'malformed' [.sh test 5]", () => {
    const proj = makeProject();
    writeUowd(proj, DANGLING_BLOCK);
    const { stderr } = runCompile(proj);
    const g = readGraph(proj);
    expect("bolt_dag" in g).toBe(false);
    expect(stderr).toContain("malformed");
  }, 30000);

  // ---- 6: absent artifact → 4-key envelope ---------------------------------
  test("absent artifact: envelope keeps the pre-milestone-15 4-key shape (no empty node) [.sh test 6]", () => {
    const proj = makeProject(); // no unit-of-work-dependency.md written
    runCompile(proj);
    const g = readGraph(proj);
    // Stronger than the .sh's join check: assert exact key set AND order, and
    // that bolt_dag is genuinely absent (no empty-node noise).
    expect(Object.keys(g)).toEqual(["workflow_id", "scope", "started_at", "stages"]);
    expect("bolt_dag" in g).toBe(false);
  }, 30000);
});

describe("t133 edge-block sensor (aidlc-sensor-required-sections, units-generation 2.7)", () => {
  // ---- 7-9: sensor edge-block validation -----------------------------------
  test("sensor: valid block → pass:true, edge_block:ok [.sh test 7]", () => {
    const proj = makeProject();
    writeUowd(
      proj,
      ["```yaml", "units:", "  - name: a", "    depends_on: []", "  - name: b", "    depends_on: [a]", "```"].join("\n"),
    );
    const r = runSensor(uowdPath(proj));
    expect(r.pass).toBe(true);
    expect(r.edge_block).toBe("ok");
  }, 30000);

  test("sensor: cyclic block → pass:false, edge_block:cyclic [.sh test 8]", () => {
    const proj = makeProject();
    writeUowd(proj, CYCLIC_BLOCK);
    const r = runSensor(uowdPath(proj));
    expect(r.pass).toBe(false);
    expect(r.edge_block).toBe("cyclic");
  }, 30000);

  test("sensor: absent block → pass:false, edge_block:absent [.sh test 9]", () => {
    const proj = makeProject();
    // A doc with H2 headings but NO fenced yaml units block (.sh:255-261).
    writeFileSync(
      uowdPath(proj),
      ["## Dependencies", "Prose only: a depends on b.", "## Integration", "REST.", ""].join("\n"),
      "utf-8",
    );
    const r = runSensor(uowdPath(proj));
    expect(r.pass).toBe(false);
    expect(r.edge_block).toBe("absent");
  }, 30000);

  // ---- 10: non-target markdown keeps the generic check ---------------------
  test("sensor: non-target markdown keeps generic H2 check (no edge_block) [.sh test 10]", () => {
    const proj = makeProject();
    const other = join(
      proj,
      "aidlc-docs",
      "inception",
      "units-generation",
      "unit-of-work.md",
    );
    writeFileSync(
      other,
      ["## Units", "Body.", "## Responsibilities", "More.", ""].join("\n"),
      "utf-8",
    );
    const r = runSensor(other);
    expect(r.pass).toBe(true);
    // The filename gate (basename !== unit-of-work-dependency.md) means the
    // edge_block field is never set on a non-target artefact.
    expect(r.edge_block).toBeUndefined();
    expect(r.raw.includes("edge_block")).toBe(false);
  }, 30000);
});
