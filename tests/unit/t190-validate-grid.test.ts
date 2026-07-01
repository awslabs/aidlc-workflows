// covers: function:validateGrid, function:validateScope, subcommand:aidlc-graph:validate-grid
//
// t190 - the P1 arbitrary-grid validator (adaptive workflows).
//
// validateScope's historical contract: its ONLY hard error is a TRUE orphan
// (no stage anywhere produces a required artifact); an off-path producer is
// ADVISORY and the result stays valid:true. That lenient posture is right for
// an authored scope (its author owns the upstream work) but WRONG for an
// in-flight recompose: an ADD whose required producer is SKIPped would run
// starved. P1 refactors the walk into validateGrid (arbitrary {slug: action}
// map, no named-scope binding) with a strict/recompose mode that PROMOTES the
// off-path advisory to a hard reject, and delegates validateScope to it so
// the legacy lenient behavior is preserved byte-for-byte.
//
// Cases (each named in the plan's P1 test list):
//   - TRUE orphan -> reject in BOTH modes (fixture graph: a consume no stage
//     produces).
//   - off-path required producer -> ADVISORY + valid:true in lenient mode,
//     hard ERROR in strict mode (real shipped graph: the infra scope's grid
//     has functional-design off-path while nfr-requirements requires its
//     artifacts - the spike-E case).
//   - conditional_on filtered by projectType (fixture graph: a brownfield-
//     conditional required consume passes when projectType=greenfield, rejects
//     strict when projectType=brownfield).
//   - a clean grid passes both modes (real graph: the feature scope's grid -
//     all 32 EXECUTE).
//   - unknown slug -> reject in both modes (a typo'd stage must never pass as
//     an implicit SKIP).
//   - validateScope parity: delegation preserves the legacy result exactly
//     (same valid/errors/advisories for a stock scope as the pre-refactor
//     contract: infra -> valid:true, 0 errors, advisories > 0).
//   - CLI: validate-grid --proposal <path> [--strict] exit codes + JSON body
//     (spawn, exit 1 iff invalid).
//
// Mechanism: MIXED - in-process imports for the library cases (none), spawns
// for the CLI exit-code rows (cli). Fixture graphs ride the AIDLC_STAGE_GRAPH
// env seam exactly like t124/t103.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateGrid,
  validateScope,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const BUN = process.execPath;
const GRAPH_TOOL = join(AIDLC_SRC, "tools", "aidlc-graph.ts");

// A minimal fixture graph for the cases the REAL graph cannot express:
// a TRUE orphan (ghost-artifact has no producer anywhere) and a required
// conditional_on consume (the shipped graph's conditional consumes are all
// required:false). Shape mirrors the compiled stage-graph.json rows the
// loader reads (extra compiled fields are optional for these walks).
const FIXTURE_GRAPH = [
  {
    slug: "alpha",
    number: "1.1",
    name: "Alpha",
    phase: "ideation",
    produces: ["alpha-artifact"],
    consumes: [],
    requires_stage: [],
    rules_in_context: [],
    sensors_applicable: [],
  },
  {
    slug: "beta",
    number: "1.2",
    name: "Beta",
    phase: "ideation",
    produces: [],
    consumes: [{ artifact: "ghost-artifact", required: true }],
    requires_stage: [],
    rules_in_context: [],
    sensors_applicable: [],
  },
  {
    slug: "gamma",
    number: "1.3",
    name: "Gamma",
    phase: "ideation",
    produces: [],
    consumes: [
      { artifact: "alpha-artifact", required: true, conditional_on: "brownfield" },
    ],
    requires_stage: [],
    rules_in_context: [],
    sensors_applicable: [],
  },
];

let tmp = "";
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function writeFixture(): { graphPath: string; dir: string } {
  tmp = mkdtempSync(join(tmpdir(), "aidlc-t190-"));
  const graphPath = join(tmp, "stage-graph.json");
  writeFileSync(graphPath, JSON.stringify(FIXTURE_GRAPH, null, 2), "utf-8");
  return { graphPath, dir: tmp };
}

// Spawn the CLI against an optional fixture graph (fresh process per call, so
// the module-level graph cache never leaks between cases).
function runValidateGrid(
  proposalPath: string,
  extra: string[] = [],
  env: Record<string, string> = {},
): { rc: number; out: string } {
  const res = spawnSync(
    BUN,
    [GRAPH_TOOL, "validate-grid", "--proposal", proposalPath, ...extra],
    { encoding: "utf-8", env: { ...process.env, ...env } },
  );
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// ===========================================================================
// Library cases against the REAL shipped graph (in-process).
// ===========================================================================
describe("t190 validateGrid - real-graph cases", () => {
  // The spike-E case: infra's grid leaves functional-design off-path while
  // nfr-requirements requires business-logic-model - lenient advises,
  // strict rejects.
  function infraGrid(): Record<string, string> {
    const grid: Record<string, string> = {};
    const shipped = JSON.parse(
      JSON.stringify(
        require("../../dist/claude/.claude/tools/data/scope-grid.json"),
      ),
    ) as Record<string, { stages: Record<string, string> }>;
    for (const [slug, action] of Object.entries(shipped.infra.stages)) {
      grid[slug] = action;
    }
    return grid;
  }

  test("off-path required producer: lenient = advisory + valid:true (the legacy posture)", () => {
    const r = validateGrid(infraGrid());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.advisories.length).toBeGreaterThan(0);
  });

  test("off-path required producer: strict = hard reject (the recompose posture)", () => {
    const r = validateGrid(infraGrid(), { strict: true });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => e.includes("Strict (recompose) mode"))).toBe(true);
  });

  test("a clean grid passes BOTH modes (feature: all stages EXECUTE)", () => {
    const shipped = require("../../dist/claude/.claude/tools/data/scope-grid.json") as Record<
      string,
      { stages: Record<string, string> }
    >;
    const grid = { ...shipped.feature.stages };
    expect(validateGrid(grid).valid).toBe(true);
    const strict = validateGrid(grid, { strict: true });
    expect(strict.valid).toBe(true);
    expect(strict.errors).toEqual([]);
  });

  test("unknown slug rejects in both modes (no implicit-SKIP typo pass)", () => {
    const lenient = validateGrid({ "no-such-stage": "EXECUTE" });
    expect(lenient.valid).toBe(false);
    expect(lenient.errors.some((e) => e.includes("unknown stage"))).toBe(true);
    const strict = validateGrid({ "no-such-stage": "EXECUTE" }, { strict: true });
    expect(strict.valid).toBe(false);
  });

  test("invalid action string rejects", () => {
    const r = validateGrid({ "intent-capture": "MAYBE" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("invalid action"))).toBe(true);
  });

  test("validateScope delegation preserves the legacy lenient contract (infra)", () => {
    const r = validateScope("infra");
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.advisories.length).toBeGreaterThan(0);
    // The advisory wording still names the scope (the label threads through).
    expect(r.advisories[0]).toContain('"infra" path');
  });
});

// ===========================================================================
// Fixture-graph cases (spawned - fresh graph cache per case) for shapes the
// real graph cannot express.
// ===========================================================================
describe("t190 validate-grid CLI - fixture graph (TRUE orphan, conditional_on)", () => {
  test("TRUE orphan rejects in BOTH modes (exit 1 + the no-producer error)", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(proposal, JSON.stringify({ alpha: "EXECUTE", beta: "EXECUTE" }), "utf-8");
    for (const extra of [[], ["--strict"]]) {
      const r = runValidateGrid(proposal, extra, { AIDLC_STAGE_GRAPH: graphPath });
      expect(r.rc).toBe(1);
      expect(r.out).toContain("no stage in the graph produces it");
    }
  });

  test("conditional_on filtered by projectType: greenfield passes, brownfield strict rejects", () => {
    const { graphPath, dir } = writeFixture();
    // gamma requires alpha-artifact ONLY on brownfield; alpha (the producer)
    // is SKIPped in the proposal.
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify({ alpha: "SKIP", beta: "SKIP", gamma: "EXECUTE" }),
      "utf-8",
    );
    const green = runValidateGrid(
      proposal,
      ["--strict", "--project-type", "greenfield"],
      { AIDLC_STAGE_GRAPH: graphPath },
    );
    expect(green.rc).toBe(0);
    const brown = runValidateGrid(
      proposal,
      ["--strict", "--project-type", "brownfield"],
      { AIDLC_STAGE_GRAPH: graphPath },
    );
    expect(brown.rc).toBe(1);
    expect(brown.out).toContain("Strict (recompose) mode");
  });

  test("accepts the {stages: {...}} wrapper shape (a scope-grid entry verbatim)", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify({ stages: { alpha: "EXECUTE", gamma: "SKIP" } }),
      "utf-8",
    );
    const r = runValidateGrid(proposal, [], { AIDLC_STAGE_GRAPH: graphPath });
    expect(r.rc).toBe(0);
    const body = JSON.parse(r.out) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  test("unreadable proposal path exits 1 with a legible error", () => {
    const r = runValidateGrid("/nonexistent/nope.json");
    expect(r.rc).toBe(1);
    expect(r.out).toContain("cannot read");
  });
});
