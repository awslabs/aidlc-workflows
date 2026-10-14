// covers: subcommand:aidlc-runtime:compile
//
// Mechanism = cli. The tests SPAWN the real CLI via node:child_process
// spawnSync (BUN + the tool .ts path) and assert on the runtime-graph.json
// the tool WROTE - the PROCESS boundary plus its file effect. We JSON.parse
// that file and assert against the real object (the materialised field
// value). An in-process compile() twin would lose the process boundary.
//
// SUBCOMMAND UNIT: this test file credits `aidlc-runtime compile` (covers KEY
// subcommand:aidlc-runtime:compile, COLON form). compile is the only
// subcommand these tests fire.
//
// FIXTURE DISCIPLINE: each fixture gets a FRESH temp project dir via
// makeProjectWithAudit, which toPortablePath-wraps the mktemp path (the tool
// writes runtime-graph.json via forward-slash helpers, so on native Windows
// the read-back must use the cygpath-rewritten path - mirrors
// createTestProject / t90's makeProject). NOTHING is written under
// tests/fixtures/**; the on-disk audit fixtures under
// tests/fixtures/v05-mr12-learnings/ (and the one milestone 11 fixture for
// case 15) are READ ONLY, copied in by reading their bytes and re-writing into
// the temp dir. All temp dirs cleaned in afterAll.

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
import { dirname, join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";
import { auditFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// With no intent cursor seeded, compile resolves the BARE space record root
// (docsRoot -> spaceRecordRoot) at aidlc/spaces/default/intents/. State,
// runtime-graph, and the per-clone audit SHARD live under it (there is no flat
// aidlc-docs/ fallback). The detail_path strings asserted below are read
// VERBATIM from the read-only audit fixtures, so they keep their recorded
// aidlc-docs/ values (compile echoes the recorded row).
const RECORD_REL = join("aidlc", "spaces", "default", "intents");
function recordRoot(proj: string): string {
  return join(proj, RECORD_REL);
}

const BUN = process.execPath;
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
  join(recordRoot(proj), "runtime-graph.json");

/**
 * makeProjectWithAudit: fresh temp project carrying the shared
 * state-construction.md as aidlc-state.md plus the given audit fixture, both
 * under the bare space record root. toPortablePath wraps the mktemp path so the
 * runtime-graph.json the tool writes round-trips on native Windows
 * (forward-slash path helpers). `auditFixturePath` is an absolute path to a
 * read-only on-disk fixture — copied into the DETERMINISTIC audit shard the
 * compile tool resolves (auditFilePath), by byte-read + re-write (no fixtures
 * mutation).
 */
function makeProjectWithAudit(auditFixturePath: string): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t98f-")));
  tempDirs.push(proj);
  const rec = recordRoot(proj);
  mkdirSync(rec, { recursive: true });
  writeFileSync(join(rec, "aidlc-state.md"), readFileSync(STATE_FIXTURE), "utf-8");
  const shard = auditFilePath(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, readFileSync(auditFixturePath), "utf-8");
  return proj;
}

function runCompile(proj: string): number {
  const res = spawnSync(BUN, [RUNTIME_TS, "--project-dir", proj, "compile"], {
    encoding: "utf-8",
  });
  return res.status ?? -1;
}

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary graph shape
function readGraph(proj: string): any {
  return JSON.parse(readFileSync(graphPath(proj), "utf-8"));
}

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
// (audit-sensor-pairing.md)
// ============================================================

describe("t98 sensor_firings pairing (migrated from t98-sensor-firings-populator.sh, plan 16)", () => {
  // Compiled once; the pairing fixture's graph is reused by 1-4, 8, 9, 16.
  const PROJ = makeProjectWithAudit(join(FIXTURES_DIR, "audit-sensor-pairing.md"));
  const rc = runCompile(PROJ);
  const sf = (): SensorFiring[] => stage(readGraph(PROJ), "code-generation").sensor_firings;

  test("compile exits 0 (pairing fixture)", () => {
    expect(rc).toBe(0);
  });

  test("1: FIRED+PASSED paired by fire_id -> result passed", () => {
    expect(byFireId(sf(), "aaaa0001")?.result).toBe("passed");
  });

  test("2: FIRED+FAILED paired -> result failed with detail_path", () => {
    const f = byFireId(sf(), "bbbb0002");
    expect(f?.result).toBe("failed");
    // Assert the exact path the sensor-failed row carried.
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
    // The failed pairing carries its own detail_path even though its terminal row
    // interleaved after two PASSED rows by spawn duration.
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
    expect(stage(readGraph(PROJ_L), "domain-design").learnings_captured).toBeNull();
  });

  test("15: instance-bearing parent (any-failed rollup) learnings_captured = null (invariant)", () => {
    const projF = makeProjectWithAudit(join(MILESTONE11_DIR, "audit-3-bolts-1-failed.md"));
    runCompile(projF);
    expect(stage(readGraph(projF), "code-generation").learnings_captured).toBeNull();
  });
});
