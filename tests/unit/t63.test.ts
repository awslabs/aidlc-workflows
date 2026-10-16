// covers: subcommand:aidlc-graph:artifacts
//
// Mechanism = cli. Every assertion about `bun aidlc-graph.ts artifacts`
// (exit code, stdout and stderr; with the AIDLC_STAGE_GRAPH
// fixture-injection env-var seam - lib.ts / aidlc-graph.ts)
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status / res.stdout / res.stderr
// - the PROCESS boundary, not an in-process artifactsRegistry() call. An
// in-process twin would lose the exit-code half on the unknown/missing-subcommand
// arms (main()'s process.exit(1), aidlc-graph.ts) AND the
// stdout-shaping half (the `artifacts` handler's console.log-per-line,
// aidlc-graph.ts).
//
// SUBCOMMAND UNIT: this test file credits the single subcommand unit it
// exercises — `aidlc-graph artifacts` (covers KEY subcommand:aidlc-graph
// artifacts, written in COLON form per the claim parser). It fires this
// subcommand against five injected fixtures plus the real graph, and pokes
// the two dispatch-error arms (unknown / missing subcommand) that the
// `artifacts` contract shares with every other subcommand.
//
// CACHE CASE is the ONE non-`artifacts`-subcommand spawn: a `bun -e` script
// imports the tool, calls artifactsRegistry() twice and prints same-ref /
// different-ref on `a === b` (ReadonlySet identity). It pins the
// memoisation invariant on artifactsRegistry()
// (aidlc-graph.ts, `_artifactsRegistry` cache).
//
// FIXTURE DISCIPLINE: the five graph fixtures are written to a FRESH temp dir
// (mkdtempSync) in beforeAll, each injected via AIDLC_STAGE_GRAPH on the
// spawn's env. Nothing is written under tests/fixtures/**. The temp dir is
// removed in afterAll. No project dir / audit shard is involved - `artifacts`
// reads only the stage graph, writes nothing.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-graph.ts",
);

// --- Fixtures — written to a temp dir, injected via AIDLC_STAGE_GRAPH ---

let fixtureDir: string;
const fx = (name: string): string => join(fixtureDir, name);

const FIXTURES: Record<string, string> = {
  "empty.json": "[]\n",
  "no-produces.json": `[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline"},
  {"slug": "s2", "number": "1.2", "name": "S2", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline"}
]
`,
  "single.json": `[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["alpha", "beta"]}
]
`,
  // Multiple stages, disjoint produces — tests union.
  "union.json": `[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["alpha", "beta"]},
  {"slug": "s2", "number": "1.2", "name": "S2", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["gamma"]}
]
`,
  // Multiple stages, overlapping produces — tests dedup.
  "dedup.json": `[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["shared", "only-one"]},
  {"slug": "s2", "number": "1.2", "name": "S2", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["shared", "only-two"]}
]
`,
};

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "aidlc-t63-"));
  for (const [name, body] of Object.entries(FIXTURES)) {
    writeFileSync(fx(name), body, "utf-8");
  }
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  out: string;
}

function graph(args: string[], stageGraph?: string): CliResult {
  const env = { ...process.env };
  if (stageGraph) env.AIDLC_STAGE_GRAPH = stageGraph;
  else delete env.AIDLC_STAGE_GRAPH;
  const res = spawnSync(BUN, [TOOL, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return {
    status: res.status ?? -1,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
  };
}

function lines(r: CliResult): string[] {
  return r.stdout.split("\n").filter((l) => l !== "");
}

const KEBAB = /^[a-z][a-z0-9-]*$/;

describe("t63 aidlc-graph artifacts — CLI contract (migrated from t63-tool-graph.sh, plan 14)", () => {
  // ============================================================
  // Empty-graph behaviour (2 assertions)
  // ============================================================

  test("1: empty graph -> no output (exit 0)", () => {
    const r = graph(["artifacts"], fx("empty.json"));
    expect(r.stdout.trim()).toBe("");
    expect(r.status).toBe(0);
  });

  test("2: stages without produces -> no output (exit 0)", () => {
    const r = graph(["artifacts"], fx("no-produces.json"));
    expect(r.stdout.trim()).toBe("");
    expect(r.status).toBe(0);
  });

  // ============================================================
  // Single-stage behaviour (1 assertion)
  // ============================================================

  test("3: single stage -> sorted produces list", () => {
    const r = graph(["artifacts"], fx("single.json"));
    expect(lines(r)).toEqual(["alpha", "beta"]);
  });

  // ============================================================
  // Union across stages (1 assertion)
  // ============================================================

  test("4: two stages -> sorted union", () => {
    const r = graph(["artifacts"], fx("union.json"));
    expect(lines(r)).toEqual(["alpha", "beta", "gamma"]);
  });

  // ============================================================
  // Dedup (1 assertion)
  // ============================================================

  test("5: overlapping produces -> dedup; shared appears once", () => {
    const r = graph(["artifacts"], fx("dedup.json"));
    const ls = lines(r);
    expect(ls).toEqual(["only-one", "only-two", "shared"]);
    // Dedup observable: "shared" is declared by BOTH stages but emitted once.
    expect(ls.filter((l) => l === "shared")).toHaveLength(1);
  });

  // ============================================================
  // Cache returns same reference on repeat call (1 assertion)
  // ============================================================

  test("6: cache returns same reference on repeat call", () => {
    const script = `
      import { artifactsRegistry } from ${JSON.stringify(TOOL)};
      const a = artifactsRegistry();
      const b = artifactsRegistry();
      console.log(a === b ? 'same-ref' : 'different-ref');
    `;
    const res = spawnSync(BUN, ["-e", script], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_STAGE_GRAPH: fx("union.json") },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out.trim()).toBe("same-ref");
  });

  // ============================================================
  // Real stage-graph.json returns populated registry (1 assertion)
  // ============================================================

  test("7: real stage-graph.json -> non-empty registry (>= 100 artifacts)", () => {
    const r = graph(["artifacts"]); // no fixture -> default DATA_DIR/stage-graph.json
    expect(r.status).toBe(0);
    const ls = lines(r);
    expect(ls.length).toBeGreaterThanOrEqual(100);
  });

  // ============================================================
  // CLI stdout shape (2 assertions)
  // ============================================================

  test("8: CLI output sorted alphabetically", () => {
    const r = graph(["artifacts"], fx("union.json"));
    const ls = lines(r);
    // Assert BOTH that the output equals its own sorted copy AND
    // that it is the exact expected union. union.json declares alpha/beta on
    // s1 and gamma on s2 - this fixture's concatenation is already sorted.
    expect(ls).toEqual([...ls].sort());
    expect(ls).toEqual(["alpha", "beta", "gamma"]);
  });

  test("9: CLI prints one name per line", () => {
    const r = graph(["artifacts"], fx("dedup.json"));
    expect(lines(r)).toHaveLength(3);
  });

  // ============================================================
  // CLI empty-data exits 0 cleanly (1 assertion)
  // ============================================================

  test("10: CLI exits 0 when registry is empty", () => {
    const r = graph(["artifacts"], fx("empty.json"));
    expect(r.status).toBe(0);
  });

  // ============================================================
  // CLI unknown subcommand exits 1, stderr mentions 'artifacts' (1 assertion)
  // ============================================================

  test("11: unknown subcommand -> exit 1, stderr mentions 'artifacts'", () => {
    const r = graph(["bogus"]);
    expect(r.status).toBe(1);
    // 'artifacts' appears in the Valid-list the dispatcher prints to stderr.
    expect(r.stderr).toContain("artifacts");
    expect(r.stderr).toContain("bogus");
  });

  // ============================================================
  // CLI no subcommand exits 1, stderr mentions 'artifacts' (1 assertion)
  // ============================================================

  test("12: no subcommand -> exit 1, stderr mentions 'artifacts'", () => {
    const r = graph([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("artifacts");
    expect(r.stderr).toContain("Usage: aidlc-graph");
  });

  // ============================================================
  // Shape regression - every registry name matches the regex (2 assertions)
  // ============================================================

  test("13: union fixture names all match kebab-case regex", () => {
    const r = graph(["artifacts"], fx("union.json"));
    const bad = lines(r).filter((l) => !KEBAB.test(l));
    expect(bad).toEqual([]);
  });

  test("14: dedup fixture names all match kebab-case regex", () => {
    const r = graph(["artifacts"], fx("dedup.json"));
    const bad = lines(r).filter((l) => !KEBAB.test(l));
    expect(bad).toEqual([]);
  });
});
