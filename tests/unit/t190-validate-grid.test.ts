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

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateGrid,
  validateScope,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

function fixtureGrid(
  overrides: Record<string, "EXECUTE" | "SKIP"> = {},
): Record<string, "EXECUTE" | "SKIP"> {
  return {
    alpha: "SKIP",
    beta: "SKIP",
    gamma: "SKIP",
    ...overrides,
  };
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
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: { ...process.env, ...env } },
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
    writeFileSync(
      proposal,
      JSON.stringify(fixtureGrid({ alpha: "EXECUTE", beta: "EXECUTE" })),
      "utf-8",
    );
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
      JSON.stringify(fixtureGrid({ gamma: "EXECUTE" })),
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

  // Windows PowerShell 5.1 writes UTF-8 with a byte order mark; the composer's
  // proposal written that way is the same proposal (#2452), not unreadable.
  test("a proposal written with a byte order mark and CRLF is read as written", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      `﻿${JSON.stringify(fixtureGrid({ alpha: "EXECUTE" }), null, 2).replace(/\n/g, "\r\n")}\r\n`,
      "utf-8",
    );
    const r = runValidateGrid(proposal, [], { AIDLC_STAGE_GRAPH: graphPath });
    expect(r.out).not.toContain("cannot read");
    expect(r.rc, r.out).toBe(0);
  });

  test("accepts the {stages: {...}} wrapper shape (a scope-grid entry verbatim)", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify({ stages: fixtureGrid({ alpha: "EXECUTE" }) }),
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

// ===========================================================================
// --keywords: the gate-time collision check (composed-scope keyword grants).
// Compares against loadScopeMapping's keywords. Nothing picks a plan by a
// hint any more (the plan proposal lists every plan's hints for the agent), so
// a granted hint another plan has is a note naming that plan, and the grid
// still validates.
// ===========================================================================
describe("t190 validate-grid --keywords - collision check", () => {
  // A mapping fixture with two scopes claiming known keywords, riding the
  // AIDLC_SCOPE_MAPPING seam (fresh process per spawn, no cache leak).
  const MAPPING = {
    bugfix: {
      depth: "Minimal",
      stages: {},
      keywords: ["fix", "bug", "broken"],
    },
    feature: { depth: "Standard", stages: {}, keywords: [] },
  };

  function seamEnv(dir: string): Record<string, string> {
    const mappingPath = join(dir, "mapping.json");
    writeFileSync(mappingPath, JSON.stringify(MAPPING), "utf-8");
    return { AIDLC_SCOPE_MAPPING: mappingPath };
  }

  test("a hint another plan already has is a note naming that plan, and the grid still validates", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify(fixtureGrid({ alpha: "EXECUTE" })),
      "utf-8",
    );
    const r = runValidateGrid(proposal, ["--keywords", "fix,tune-up"], {
      AIDLC_STAGE_GRAPH: graphPath,
      ...seamEnv(dir),
    });
    expect(r.rc).toBe(0);
    const body = JSON.parse(r.out) as { valid: boolean; errors: string[]; advisories: string[] };
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.advisories).toContain('The hint "fix" is also bugfix\'s; the plan proposal lists it under both.');
    // The hint no other plan has gets no note.
    expect(body.advisories.some((e) => e.includes('"tune-up"'))).toBe(false);
  });

  test("a shared hint is found whatever its case", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify(fixtureGrid({ alpha: "EXECUTE" })),
      "utf-8",
    );
    const r = runValidateGrid(proposal, ["--keywords", "FIX"], {
      AIDLC_STAGE_GRAPH: graphPath,
      ...seamEnv(dir),
    });
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { advisories: string[] }).advisories.some((e) => e.includes("bugfix"))).toBe(true);
  });

  test("non-colliding keywords pass (exit 0, valid:true, no errors)", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify(fixtureGrid({ alpha: "EXECUTE" })),
      "utf-8",
    );
    const r = runValidateGrid(proposal, ["--keywords", "pipeline,observability"], {
      AIDLC_STAGE_GRAPH: graphPath,
      ...seamEnv(dir),
    });
    expect(r.rc).toBe(0);
    const body = JSON.parse(r.out) as { valid: boolean; errors: string[] };
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
  });

  test("omitted flag = today's behavior byte-for-byte (same grid, same JSON)", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify(fixtureGrid({ alpha: "EXECUTE" })),
      "utf-8",
    );
    const env = { AIDLC_STAGE_GRAPH: graphPath, ...seamEnv(dir) };
    const without = runValidateGrid(proposal, [], env);
    const withEmptyGrant = runValidateGrid(proposal, ["--keywords", ""], env);
    expect(without.rc).toBe(0);
    // An empty csv grants nothing, so the output matches the flag-less run.
    expect(withEmptyGrant.rc).toBe(0);
    expect(withEmptyGrant.out).toBe(without.out);
  });

  test("--keywords with a missing value is a legible usage error", () => {
    const { graphPath, dir } = writeFixture();
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify(fixtureGrid({ alpha: "EXECUTE" })),
      "utf-8",
    );
    const r = runValidateGrid(proposal, ["--keywords"], {
      AIDLC_STAGE_GRAPH: graphPath,
      ...seamEnv(dir),
    });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("--keywords requires");
  });

  test("a shared hint's note rides beside the grid's own errors", () => {
    const { graphPath, dir } = writeFixture();
    // beta requires ghost-artifact (TRUE orphan) AND the grant collides.
    const proposal = join(dir, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify(fixtureGrid({ beta: "EXECUTE" })),
      "utf-8",
    );
    const r = runValidateGrid(proposal, ["--keywords", "bug"], {
      AIDLC_STAGE_GRAPH: graphPath,
      ...seamEnv(dir),
    });
    expect(r.rc).toBe(1);
    const body = JSON.parse(r.out) as { errors: string[]; advisories: string[] };
    expect(body.errors.some((e) => e.includes("no stage in the graph produces it"))).toBe(true);
    expect(body.errors.some((e) => e.includes('"bug"'))).toBe(false);
    expect(body.advisories.some((e) => e.includes('The hint "bug" is also bugfix'))).toBe(true);
  });
});

// ===========================================================================
// The plan offer's one skip line. The composer's final --custom run names, as
// summary.skipped_inputs, every stage the plan drops from the stock scope it
// runs on (the stages creation records as skipped) and every stage a kept stage
// needs that only the plan's own changes leave out (a stock scope leaves some
// required inputs unmade by design: t66 pins those edges), each with every kept
// stage that uses what it makes, in the names the person reads. The composer
// copies summary verbatim, and the conductor says it once on the offer.
// ===========================================================================
describe("t190 validate-grid --custom names every stage a plan skips, with the stages it keeps that use it", () => {
  const SETTINGS = {
    sensors: "on", learnings: "on", summary_confirmation: "on", plan_approval: "on", collaborators: "off", review_cap: "adversarial",
  };
  type Body = {
    valid: boolean;
    advisories: string[];
    routing?: string;
    base_scope?: string;
    plan_changes?: { skip: string[]; add: string[] };
    summary: { skipped_inputs?: Array<{ stage: string; used_by: string[] }> };
  };
  function stock(scope: string, edits: Record<string, "EXECUTE" | "SKIP"> = {}): Record<string, string> {
    const grids = require("../../dist/claude/.claude/tools/data/scope-grid.json") as Record<string, { stages: Record<string, string> }>;
    return { ...grids[scope].stages, ...edits };
  }
  // The composer's final run: --custom or --matched with the members they require.
  function finalRun(
    stages: Record<string, string>,
    route: string[],
    opts: { projectType?: string; depth?: string } = {},
  ): Body {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t190-gaps-"));
    const proposal = join(tmp, "p.json");
    writeFileSync(
      proposal,
      JSON.stringify({ stages, scopeSettings: SETTINGS, guardPolicy: "strict", depth: opts.depth ?? "comprehensive" }),
      "utf-8",
    );
    const r = runValidateGrid(proposal, [...route, "--project-type", opts.projectType ?? "greenfield"], { AIDLC_PROJECT_DIR: tmp });
    expect(r.rc, r.out).toBe(0);
    return JSON.parse(r.out) as Body;
  }
  const SKIP = "SKIP" as const;
  const EXECUTE = "EXECUTE" as const;
  const UNITS = { stage: "Units Generation", used_by: ["Contract Design", "Functional Design", "Code Generation"] };
  const DELIVERY = { stage: "Delivery Planning", used_by: [] };
  const named = (body: Body): string[] => (body.summary.skipped_inputs ?? []).map((entry) => entry.stage);

  test("the live run's plan on a new project names what it drops, Units Generation with the three stages that use it", () => {
    const body = finalRun(stock("classic", {
      "reverse-engineering": SKIP, "user-stories": SKIP, "refined-mockups": SKIP, "units-generation": SKIP,
      "delivery-planning": SKIP, "intent-capture": EXECUTE, feasibility: EXECUTE, "scope-definition": EXECUTE,
      "approval-handoff": EXECUTE,
    }), ["--custom"]);
    expect(body).toMatchObject({ valid: true, routing: "custom", base_scope: "classic" });
    // Reverse Engineering is not named: creation skips it on a new project.
    expect(body.summary.skipped_inputs).toEqual([
      { stage: "User Stories", used_by: [] },
      { stage: "Refined Mockups", used_by: [] },
      UNITS,
      DELIVERY,
    ]);
    expect(body.plan_changes?.skip).toEqual([
      "reverse-engineering", "user-stories", "refined-mockups", "units-generation", "delivery-planning",
    ]);
    // The validator's own words stay in the advisories, beside the stage table.
    expect(body.advisories.filter((a) => a.includes("[units-generation]")).length).toBe(4);
  });

  test("a matched stock plan says nothing: its unmade inputs are the scope's design", () => {
    const body = finalRun(stock("bugfix"), ["--matched", "bugfix"]);
    expect(body.routing).toBe("matched");
    expect(body.advisories.length).toBeGreaterThan(0);
    expect(body.summary).not.toHaveProperty("skipped_inputs");
  });

  test("a custom plan that leaves unmade only what its base already does names only the stage it drops", () => {
    const body = finalRun(stock("classic", { "user-stories": SKIP }), ["--custom"]);
    expect(body.base_scope).toBe("classic");
    expect(body.advisories.some((a) => a.includes('"refined-mockups"'))).toBe(true);
    expect(body.summary.skipped_inputs).toEqual([{ stage: "User Stories", used_by: [] }]);
  });

  test("a custom plan that only adds stages its base makes the inputs for says nothing", () => {
    const body = finalRun(stock("classic", { "intent-capture": EXECUTE }), ["--custom"]);
    expect(body).toMatchObject({ base_scope: "classic", plan_changes: { skip: [], add: ["intent-capture"] } });
    expect(body.summary).not.toHaveProperty("skipped_inputs");
  });

  test("a stage the plan adds whose producer its base skips names that producer with every stage that uses it", () => {
    const body = finalRun(stock("express", { "functional-design": EXECUTE }), ["--custom"], { depth: "minimal" });
    expect(body.base_scope).toBe("express");
    // Express runs Code Generation without Units Generation by design; once the
    // plan's own Functional Design needs it too, the line names both users.
    expect(body.summary.skipped_inputs).toEqual([
      { stage: "Domain Design", used_by: ["Functional Design"] },
      { stage: "Units Generation", used_by: ["Functional Design", "Code Generation"] },
    ]);
  });

  test("existing code: the project type reaches the walk and the same gap is named", () => {
    const body = finalRun(
      stock("classic", { "units-generation": SKIP, "delivery-planning": SKIP }),
      ["--custom"],
      { projectType: "brownfield" },
    );
    expect(body.base_scope).toBe("classic");
    expect(body.summary.skipped_inputs).toEqual([UNITS, DELIVERY]);
  });

  // A live run: a plan for hardening a deployment pipeline dropped Deployment
  // Execution from express, the offer never said so, and the record then said
  // "Stages skipped: deployment-execution" under the person's approval.
  test("a plan that drops a stage no kept stage uses names it, with no users", () => {
    const body = finalRun(stock("express", { "deployment-execution": SKIP }), ["--custom"], {
      projectType: "brownfield", depth: "minimal",
    });
    expect(body).toMatchObject({ valid: true, base_scope: "express", plan_changes: { skip: ["deployment-execution"] } });
    expect(body.summary.skipped_inputs).toEqual([{ stage: "Deployment Execution", used_by: [] }]);
  });

  test("existing code names a dropped Reverse Engineering; a new project, where creation skips it, does not", () => {
    const plan = stock("express", { "reverse-engineering": SKIP });
    const existing = finalRun(plan, ["--custom"], { projectType: "brownfield", depth: "minimal" });
    expect(existing.summary.skipped_inputs).toEqual([{ stage: "Reverse Engineering", used_by: [] }]);
    const fresh = finalRun(plan, ["--custom"], { projectType: "greenfield", depth: "minimal" });
    expect(fresh.base_scope).toBe("express");
    expect(fresh.summary).not.toHaveProperty("skipped_inputs");
  });

  test("two skipped stages are named in the plan's order, each with the stages that use it", () => {
    const body = finalRun(
      stock("classic", { "units-generation": SKIP, "delivery-planning": SKIP, "nfr-design": SKIP }),
      ["--custom"],
    );
    expect(body.base_scope).toBe("classic");
    expect(body.summary.skipped_inputs).toEqual([
      UNITS,
      DELIVERY,
      { stage: "NFR Design", used_by: ["Infrastructure Design"] },
    ]);
  });

  // The record says "Stages skipped: <plan_changes.skip>" under the person's
  // approval, so every one of them is on the line the approval answered; the
  // one exception is Reverse Engineering on a new project, which creation skips
  // there whatever the plan says.
  test("every stage creation will record as skipped is on the line", () => {
    const graph = require("../../dist/claude/.claude/tools/data/stage-graph.json") as Array<{ slug: string; name: string }>;
    const display = new Map(graph.map((stage) => [stage.slug, stage.name]));
    for (const [scope, edits, projectType] of [
      ["express", { "deployment-execution": SKIP, "requirements-analysis": SKIP }, "brownfield"],
      ["feature", { "deployment-execution": SKIP, "observability-setup": SKIP, "user-stories": SKIP }, "brownfield"],
      ["express", { "reverse-engineering": SKIP, "deployment-execution": SKIP }, "brownfield"],
    ] as const) {
      const body = finalRun(stock(scope, edits), ["--custom"], { projectType, depth: "minimal" });
      expect(body.plan_changes?.skip.length, JSON.stringify(body)).toBeGreaterThan(0);
      for (const slug of body.plan_changes?.skip ?? []) expect(named(body)).toContain(display.get(slug) ?? slug);
    }
    const fresh = finalRun(
      stock("express", { "reverse-engineering": SKIP, "deployment-execution": SKIP }),
      ["--custom"],
      { projectType: "greenfield", depth: "minimal" },
    );
    expect(fresh.plan_changes?.skip).toEqual(["reverse-engineering", "deployment-execution"]);
    expect((fresh.plan_changes?.skip ?? []).filter((slug) => !named(fresh).includes(display.get(slug) ?? slug)))
      .toEqual(["reverse-engineering"]);
  });
});
