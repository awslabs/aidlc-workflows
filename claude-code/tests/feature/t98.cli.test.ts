// covers: subcommand:aidlc-runtime:compile
//
// CLI-contract port of tests/feature/t98-sensor-firings-populator.sh (TAP
// plan 16), mechanism = cli. Equal-or-stronger migration: every .sh
// assertion that shelled out to `bun aidlc-runtime.ts --project-dir <p>
// compile` and then projected a scalar out of the written runtime-graph.json
// via a `bun -e` JSON.parse is preserved by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path) and asserting on the
// runtime-graph.json the tool WROTE — the PROCESS boundary plus its file
// effect. The .sh's `graph_query` helper read the same on-disk graph through
// an embedded `bun -e` expression; in-process we JSON.parse the identical file
// and assert against the real object, so the observable (the materialised
// field value) is unchanged, expressed against the return shape rather than a
// `bun -e` stringification. An in-process compile() twin would lose the
// re-compile-byte-equal half (case 8, which hashes the written file) and the
// process boundary the .sh's `run_compile` relies on.
//
// SUBCOMMAND UNIT: this .cli file credits `aidlc-runtime compile` (covers KEY
// subcommand:aidlc-runtime:compile, COLON form). compile is the only
// subcommand the .sh fires; every case runs it.
//
// PARITY NOTES (every .sh `ok` line maps to an expect()-bearing test() below;
// several are STRONGER than the original — flagged S#):
//   - .sh 1  aaaa0001 result == "passed"                       -> Test 1.
//   - .sh 2  bbbb0002 result == "failed" AND detail_path !=null -> Test 2
//       (exact "failed" + a non-empty detail_path string assert; the .sh only
//       checked != "null"/"" — we assert the literal path STRONGER S1).
//   - .sh 3  cccc0003 result == "budget-override"              -> Test 3.
//   - .sh 4  dddd0004 result == "incomplete" (closed window)   -> Test 4.
//   - .sh 5  old00001 result == "incomplete" (open ≥60s)       -> Test 5.
//   - .sh 6  young002 omitted from array (open <60s)           -> Test 6
//       (.some(...)===false -> we assert find(...)===undefined, same observable).
//   - .sh 7  fire0001..0004 each paired by fire_id, not posn   -> Test 7
//       (4 results asserted: passed/failed/passed/passed; the failed one also
//       carries its detail_path STRONGER S2).
//   - .sh 8  re-compile byte-equal runtime-graph.json          -> Test 8
//       (sha256 before/after, identical to the .sh's `shasum -a 256`).
//   - .sh 9  sensor_firings sorted ts-ascending                -> Test 9.
//   - .sh 10 auth=[auth0001] cart=[cart0002] pay=[] per inst   -> Test 10.
//   - .sh 11 parent holds only [pnt00003]                      -> Test 11.
//   - .sh 12 no double-count: parent excludes worktree fire_ids -> Test 12.
//   - .sh 13 approved stage learnings_captured = {2,1}         -> Test 13.
//   - .sh 14 pending stage learnings_captured = null           -> Test 14.
//   - .sh 15 instance-bearing parent learnings_captured = null -> Test 15.
//   - .sh 16 forward-compat shape (fire_id, 4-state enum,
//            detail_path only on failed)                       -> Test 16.
//
// 16 .sh asserts -> 16 expect()-bearing test() cases here.
//
// FIXTURE DISCIPLINE (mirrors the .sh's make_project_with_audit, itself a
// `mktemp -d` + copy of state-construction.md + the per-case audit fixture):
// each case builds a FRESH temp project dir via makeProjectWithAudit, which
// toPortablePath-wraps the mktemp path (the tool writes runtime-graph.json via
// forward-slash helpers, so on native Windows the read-back must use the
// cygpath-rewritten path — mirrors createTestProject / t90's makeProject).
// NOTHING is written under tests/fixtures/**; the on-disk audit fixtures under
// tests/fixtures/v05-mr12-learnings/ (and the one milestone 11 fixture for case 15)
// are READ ONLY, copied in by reading their bytes and re-writing into the temp
// dir — exactly as the .sh `cp`'d them. All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const RUNTIME_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-runtime.ts",
);
const STATE_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "state-construction.md");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures", "v05-mr12-learnings");
const MILESTONE11_DIR = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "v05-mr11-bolt-runtime-graph",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const graphPath = (proj: string): string =>
  join(proj, "aidlc-docs", "runtime-graph.json");

/**
 * make_project_with_audit (t98:66-78): fresh temp project carrying the shared
 * state-construction.md as aidlc-state.md plus the given audit fixture as
 * audit.md, both under aidlc-docs/. toPortablePath wraps the mktemp path so
 * the runtime-graph.json the tool writes round-trips on native Windows
 * (forward-slash path helpers). `auditFixturePath` is an absolute path to a
 * read-only on-disk fixture — copied in by byte-read + re-write (no fixtures
 * mutation).
 */
function makeProjectWithAudit(auditFixturePath: string): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t98f-")));
  tempDirs.push(proj);
  const docs = join(proj, "aidlc-docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "aidlc-state.md"), readFileSync(STATE_FIXTURE), "utf-8");
  writeFileSync(join(docs, "audit.md"), readFileSync(auditFixturePath), "utf-8");
  return proj;
}

/** run_compile (t98:80-82): bun RUNTIME_TS --project-dir <p> compile, output discarded. */
function runCompile(proj: string): number {
  const res = spawnSync(BUN, [RUNTIME_TS, "--project-dir", proj, "compile"], {
    encoding: "utf-8",
  });
  return res.status ?? -1;
}

/** Parse the runtime-graph.json the tool wrote (the .sh's graph_query target). */
// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary graph shape
function readGraph(proj: string): any {
  return JSON.parse(readFileSync(graphPath(proj), "utf-8"));
}

/** sha256 of the written graph — mirrors the .sh's `shasum -a 256 ... | awk '{print $1}'`. */
const sha256 = (proj: string): string =>
  createHash("sha256").update(readFileSync(graphPath(proj))).digest("hex");

interface SensorFiring {
  id: string;
  fire_id: string;
  result: "passed" | "failed" | "budget-override" | "incomplete";
  ts: string;
  detail_path?: string;
}

interface StageRow {
  stage_slug: string;
  sensor_firings: SensorFiring[];
  learnings_captured: { from_orchestrator: number; from_user_addition: number } | null;
  // biome-ignore lint/suspicious/noExplicitAny: instances shape exercised structurally
  instances?: any[];
}

/** g.stages.find(s => s.stage_slug === slug) — the .sh's repeated projection. */
// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary graph shape
function stage(g: any, slug: string): StageRow {
  // biome-ignore lint/suspicious/noExplicitAny: graph row is loosely typed
  const s = g.stages.find((x: any) => x.stage_slug === slug);
  expect(s).toBeDefined();
  return s as StageRow;
}

const fireIds = (firings: SensorFiring[]): string[] => firings.map((f) => f.fire_id);
const byFireId = (firings: SensorFiring[], id: string): SensorFiring | undefined =>
  firings.find((f) => f.fire_id === id);

// ============================================================
// Pairing — single-stage code-generation with mixed terminals
// (.sh "Pairing" block, audit-sensor-pairing.md)
// ============================================================

describe("t98 sensor_firings pairing (migrated from t98-sensor-firings-populator.sh, plan 16)", () => {
  // Compiled once; the pairing fixture's graph is reused by 1-4, 8, 9, 16.
  const PROJ = makeProjectWithAudit(join(FIXTURES_DIR, "audit-sensor-pairing.md"));
  const rc = runCompile(PROJ);
  const sf = (): SensorFiring[] => stage(readGraph(PROJ), "code-generation").sensor_firings;

  test("compile exits 0 (pairing fixture)", () => {
    // S: the .sh discarded stdout/$?; we pin a clean exit before reading the graph.
    expect(rc).toBe(0);
  });

  test("1: FIRED+PASSED paired by fire_id -> result passed", () => {
    expect(byFireId(sf(), "aaaa0001")?.result).toBe("passed");
  });

  test("2: FIRED+FAILED paired -> result failed with detail_path", () => {
    const f = byFireId(sf(), "bbbb0002");
    expect(f?.result).toBe("failed");
    // STRONGER (S1): the .sh only checked detail_path != "null"/"" — assert the
    // exact path the sensor-failed row carried.
    expect(f?.detail_path).toBe(
      "aidlc-docs/.aidlc-sensors/code-generation/linter-bbbb0002.md",
    );
  });

  test("3: FIRED+BUDGET_OVERRIDE paired -> result budget-override", () => {
    expect(byFireId(sf(), "cccc0003")?.result).toBe("budget-override");
  });

  test("4: orphan FIRED in closed window -> result incomplete", () => {
    expect(byFireId(sf(), "dddd0004")?.result).toBe("incomplete");
  });

  // --- Determinism + sort (audit-sensor-pairing.md graph) ---

  test("8: re-compile produces byte-equivalent runtime-graph.json (no wall-clock)", () => {
    const before = sha256(PROJ);
    runCompile(PROJ);
    const after = sha256(PROJ);
    expect(after).toBe(before);
  });

  test("9: sensor_firings sorted by ts ascending", () => {
    const ts = sf().map((f) => f.ts);
    expect(ts).toEqual([...ts].sort());
  });

  test("16: forward-compat shape — fire_id present, 4-state enum, detail_path only on failed", () => {
    const valid = ["passed", "failed", "budget-override", "incomplete"];
    for (const f of sf()) {
      expect(typeof f.fire_id).toBe("string");
      expect(f.fire_id.length).toBeGreaterThan(0);
      expect(valid).toContain(f.result);
      if (f.result !== "failed") {
        // detail_path is omitted (undefined) on every non-failed firing.
        expect(f.detail_path).toBeUndefined();
      }
    }
  });
});

// ============================================================
// Open-window orphan cutoff (audit-orphan-open-window.md)
// ============================================================

describe("t98 open-window orphan cutoff", () => {
  const PROJ = makeProjectWithAudit(join(FIXTURES_DIR, "audit-orphan-open-window.md"));
  runCompile(PROJ);
  const sf = (): SensorFiring[] => stage(readGraph(PROJ), "code-generation").sensor_firings;

  test("5: orphan in open window >=60s past baseline_ts -> incomplete", () => {
    expect(byFireId(sf(), "old00001")?.result).toBe("incomplete");
  });

  test("6: orphan in open window <60s past baseline_ts -> omitted (no 5th pending state)", () => {
    // .sh: .some(f => f.fire_id === 'young002') === false.
    expect(byFireId(sf(), "young002")).toBeUndefined();
  });
});

// ============================================================
// 4 parallel FIRED, interleaved terminals (audit-4-parallel-interleaved.md)
// ============================================================

describe("t98 four-parallel fire_id pairing", () => {
  const PROJ = makeProjectWithAudit(join(FIXTURES_DIR, "audit-4-parallel-interleaved.md"));
  runCompile(PROJ);

  test("7: 4 parallel FIRED, interleaved terminals -> each paired by fire_id (not positional)", () => {
    const sf = stage(readGraph(PROJ), "code-generation").sensor_firings;
    expect(byFireId(sf, "fire0001")?.result).toBe("passed");
    expect(byFireId(sf, "fire0002")?.result).toBe("failed");
    expect(byFireId(sf, "fire0003")?.result).toBe("passed");
    expect(byFireId(sf, "fire0004")?.result).toBe("passed");
    // STRONGER (S2): the failed pairing carries its own detail_path even though
    // its terminal row interleaved after two later PASSED rows by spawn duration.
    expect(byFireId(sf, "fire0002")?.detail_path).toBe(
      "aidlc-docs/.aidlc-sensors/code-generation/upstream-coverage-fire0002.md",
    );
  });
});

// ============================================================
// BoltInstance worktree-scoped attribution (audit-3-bolts-sensors.md)
// ============================================================

describe("t98 BoltInstance worktree-scoped firings", () => {
  const PROJ = makeProjectWithAudit(join(FIXTURES_DIR, "audit-3-bolts-sensors.md"));
  runCompile(PROJ);
  const cg = (): StageRow => stage(readGraph(PROJ), "code-generation");
  // biome-ignore lint/suspicious/noExplicitAny: instances shape exercised structurally
  const inst = (g: StageRow, bolt: string): any =>
    // biome-ignore lint/suspicious/noExplicitAny: graph row is loosely typed
    (g.instances ?? []).find((i: any) => i.bolt === bolt);

  test("10: each instance carries its own worktree-scoped firings (auth/cart/pay)", () => {
    const g = cg();
    expect(fireIds(inst(g, "auth").sensor_firings)).toEqual(["auth0001"]);
    expect(fireIds(inst(g, "cart").sensor_firings)).toEqual(["cart0002"]);
    expect(fireIds(inst(g, "pay").sensor_firings)).toEqual([]);
  });

  test("11: instance-bearing parent holds only firings NOT under any worktree (pnt00003)", () => {
    expect(fireIds(cg().sensor_firings)).toEqual(["pnt00003"]);
  });

  test("12: worktree-scoped firings are not double-counted on the parent", () => {
    const parentIds = fireIds(cg().sensor_firings);
    expect(parentIds).not.toContain("auth0001");
    expect(parentIds).not.toContain("cart0002");
  });
});

// ============================================================
// learnings_captured (audit-learnings-captured.md + milestone 11 failed rollup)
// ============================================================

describe("t98 learnings_captured", () => {
  const PROJ_L = makeProjectWithAudit(join(FIXTURES_DIR, "audit-learnings-captured.md"));
  runCompile(PROJ_L);

  test("13: approved stage learnings_captured = {from_orchestrator:2, from_user_addition:1}", () => {
    expect(stage(readGraph(PROJ_L), "user-stories").learnings_captured).toEqual({
      from_orchestrator: 2,
      from_user_addition: 1,
    });
  });

  test("14: pending stage learnings_captured = null", () => {
    expect(stage(readGraph(PROJ_L), "application-design").learnings_captured).toBeNull();
  });

  test("15: instance-bearing parent (any-failed rollup) learnings_captured = null (invariant)", () => {
    const projF = makeProjectWithAudit(join(MILESTONE11_DIR, "audit-3-bolts-1-failed.md"));
    runCompile(projF);
    expect(stage(readGraph(projF), "code-generation").learnings_captured).toBeNull();
  });
});
