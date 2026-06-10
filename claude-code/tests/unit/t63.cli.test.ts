// covers: subcommand:aidlc-graph:artifacts
//
// CLI-contract port of tests/unit/t63-tool-graph.sh (TAP plan 14),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-graph.ts artifacts` (with the AIDLC_STAGE_GRAPH
// fixture-injection env-var seam — lib.ts:702-703 / aidlc-graph.ts:153-155)
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status / res.stdout / res.stderr
// exactly as the .sh asserted on $? / stdout (2>&1) — the PROCESS boundary,
// not an in-process artifactsRegistry() call. An in-process twin would lose
// the exit-code half the .sh relies on for the unknown/missing-subcommand
// arms (main()'s process.exit(1), aidlc-graph.ts:1222/1230) AND the
// stdout-shaping half (the `artifacts` handler's console.log-per-line,
// aidlc-graph.ts:1094-1098).
//
// SUBCOMMAND UNIT: this .cli file credits the single subcommand unit the .sh
// exercises — `aidlc-graph artifacts` (covers KEY subcommand:aidlc-graph
// artifacts, written in COLON form per the claim parser). The .sh fires this
// subcommand against five injected fixtures plus the real graph, and pokes
// the two dispatch-error arms (unknown / missing subcommand) that the
// `artifacts` contract shares with every other subcommand.
//
// CACHE CASE (.sh test 6) is the ONE non-`artifacts`-subcommand spawn: the
// .sh ran `bun -e` importing artifactsRegistry() twice and compared `a === b`
// (ReadonlySet identity). That is still a spawned subprocess (mechanism =
// process boundary via `bun -e`), so it is preserved as a `bun -e` spawn that
// imports the tool and prints same-ref / different-ref — byte-identical to the
// .sh's protocol. It pins the memoisation invariant on artifactsRegistry()
// (aidlc-graph.ts:768-780, `_artifactsRegistry` cache).
//
// PARITY NOTES (every .sh `ok`/`assert_eq` line maps to an expect() below;
// several are STRONGER than the original):
//   - .sh L64-65  empty.json -> "" (no output)            -> test 1: stdout==""
//       AND status===0 (STRONGER: the .sh only checked the empty string, not
//       the exit code; clean exit pinned here too).
//   - .sh L67-68  no-produces.json -> "" (no output)      -> test 2: stdout==""
//       AND status===0 (STRONGER, exit pinned).
//   - .sh L74-75  single.json -> $'alpha\nbeta'           -> test 3: exact
//       stdout 'alpha\nbeta\n' (trimmed compare 'alpha\nbeta').
//   - .sh L81-82  union.json -> $'alpha\nbeta\ngamma'     -> test 4: exact.
//   - .sh L88-89  dedup.json -> $'only-one\nonly-two\nshared' -> test 5: exact;
//       'shared' appears exactly once (dedup observable).
//   - .sh L95-101 cache same-ref via `bun -e` a===b       -> test 6: spawned
//       `bun -e` prints 'same-ref' (same observable, same mechanism).
//   - .sh L111-117 real graph -> >= 100 artifacts          -> test 7: line count
//       >= 100 AND status===0 (STRONGER: exit pinned; the real graph today
//       carries 122 distinct produces slugs, verified at port time).
//   - .sh L124-125 union sorted alphabetically            -> test 8: the lines
//       array equals its own .slice().sort() AND equals ['alpha','beta','gamma']
//       (STRONGER: asserts BOTH sortedness AND exact content; fixture order in
//       union.json is alpha/beta then gamma across stages, so the union must be
//       re-sorted by the handler, not merely concatenated).
//   - .sh L128-129 dedup one-name-per-line: 3 lines        -> test 9: exactly 3
//       non-empty lines.
//   - .sh L135-136 empty.json exits 0 cleanly              -> test 10: status===0.
//   - .sh L142-151 unknown subcommand exit 1 + stderr 'artifacts'
//                                                          -> test 11: status===1
//       AND stderr contains 'artifacts' (the Valid-list) AND mentions the bad
//       cmd (STRONGER: also asserts the offending token is echoed).
//   - .sh L157-166 no subcommand exit 1 + stderr 'artifacts'
//                                                          -> test 12: status===1
//       AND stderr contains 'artifacts' AND 'Usage' (STRONGER: usage banner).
//   - .sh L172-175 union fixture names all kebab-case      -> test 13: every line
//       matches /^[a-z][a-z0-9-]*$/.
//   - .sh L177-180 dedup fixture names all kebab-case      -> test 14: every line
//       matches /^[a-z][a-z0-9-]*$/.
//
// 14 .sh asserts -> 14 expect()-bearing test() cases here (one observable per
// case, matching the .sh's 14 `ok` lines exactly; plan 14 == 14 test()s).
//
// FIXTURE DISCIPLINE (mirrors the .sh's `mktemp -d` + per-fixture heredoc +
// `trap rm -rf` cleanup): the five graph fixtures are written to a FRESH temp
// dir (mkdtempSync) in beforeAll, each injected via AIDLC_STAGE_GRAPH on the
// spawn's env (exactly the .sh's `AIDLC_STAGE_GRAPH=... bun "$TOOL" artifacts`).
// Nothing is written under tests/fixtures/**. The temp dir is removed in
// afterAll. The fixture JSON bytes are copied verbatim from the .sh heredocs
// (lines 23-56) so the graph shapes round-trip identically. No project dir /
// audit.md is involved — `artifacts` reads only the stage graph, writes
// nothing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath; // the bun running this test
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
// Bytes copied verbatim from t63-tool-graph.sh:23-56.

let fixtureDir: string;
const fx = (name: string): string => join(fixtureDir, name);

const FIXTURES: Record<string, string> = {
  // Empty array — no stages at all.
  "empty.json": "[]\n",
  // Stages without any produces fields.
  "no-produces.json": `[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline"},
  {"slug": "s2", "number": "1.2", "name": "S2", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline"}
]
`,
  // Single stage with produces.
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
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/**
 * Spawn `bun aidlc-graph.ts artifacts` with an optional AIDLC_STAGE_GRAPH
 * fixture injected on the env. Mirrors the .sh's
 * `AIDLC_STAGE_GRAPH="$FIXTURE_DIR/<f>" bun "$TOOL" artifacts 2>&1`.
 */
function graph(args: string[], stageGraph?: string): CliResult {
  const env = { ...process.env };
  if (stageGraph) env.AIDLC_STAGE_GRAPH = stageGraph;
  else delete env.AIDLC_STAGE_GRAPH;
  const res = spawnSync(BUN, [TOOL, ...args], { encoding: "utf-8", env });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return {
    status: res.status ?? -1,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
  };
}

/** `artifacts` output split into non-empty lines (one slug per line). */
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
    expect(r.status).toBe(0); // STRONGER: exit pinned (the .sh only checked "")
  });

  test("2: stages without produces -> no output (exit 0)", () => {
    const r = graph(["artifacts"], fx("no-produces.json"));
    expect(r.stdout.trim()).toBe("");
    expect(r.status).toBe(0); // STRONGER: exit pinned
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
  // Preserved as a `bun -e` spawn (the .sh's mechanism), importing the tool
  // and comparing artifactsRegistry() === artifactsRegistry() (Set identity).
  // ============================================================

  test("6: cache returns same reference on repeat call", () => {
    const script = `
      import { artifactsRegistry } from ${JSON.stringify(TOOL)};
      const a = artifactsRegistry();
      const b = artifactsRegistry();
      console.log(a === b ? 'same-ref' : 'different-ref');
    `;
    const res = spawnSync(BUN, ["-e", script], {
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
    expect(r.status).toBe(0); // STRONGER: exit pinned
    const ls = lines(r);
    expect(ls.length).toBeGreaterThanOrEqual(100);
  });

  // ============================================================
  // CLI stdout shape (2 assertions)
  // ============================================================

  test("8: CLI output sorted alphabetically", () => {
    const r = graph(["artifacts"], fx("union.json"));
    const ls = lines(r);
    // STRONGER: assert BOTH that the output equals its own sorted copy AND
    // that it is the exact expected union. union.json declares alpha/beta on
    // s1 and gamma on s2 — the handler must re-sort the union, not concatenate.
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
    // STRONGER: the offending token is echoed (aidlc-graph.ts:1227-1229).
    expect(r.stderr).toContain("bogus");
  });

  // ============================================================
  // CLI no subcommand exits 1, stderr mentions 'artifacts' (1 assertion)
  // ============================================================

  test("12: no subcommand -> exit 1, stderr mentions 'artifacts'", () => {
    const r = graph([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("artifacts");
    // STRONGER: the usage banner is emitted (aidlc-graph.ts:1219-1221).
    expect(r.stderr).toContain("Usage: aidlc-graph");
  });

  // ============================================================
  // Shape regression — every registry name matches milestone 5's regex (2 assertions)
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
