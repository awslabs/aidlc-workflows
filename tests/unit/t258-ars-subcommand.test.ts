// covers: function:computeArs, function:loadArsPriors, subcommand:aidlc-graph:ars
//
// t258 - deterministic ARS arithmetic.
//
// The composer persona used to carry the ARS arithmetic as prose — the same
// five component scores could render different composites across runs because
// a model did the multiplication. The `ars` subcommand is the who-computes
// swap: weights/bands/cost-priors/EV-thresholds live in
// tools/data/ars-priors.json, and this file is the calibration anchor:
//
//   1. ARITHMETIC PIN — the persona's own worked example (0.55/0.75/0.65/
//      0.50/0.55) must render composite 63 / "Comprehensive", byte-matching
//      the Table 1 composite row the persona documents.
//   2. BAND EDGES — component bands are continuous with no gaps: 0.29 LOW,
//      0.30 MED, 0.69 MED, 0.70 HIGH; composite 20 Near-direct vs 21 Focused.
//      A composite that is EXACTLY a half-point rounds by the documented
//      formula, not by the IEEE sum's drift below it.
//   3. PRIORS SCHEMA — the shipped ars-priors.json loads, weights sum to 1.0,
//      and every compiled graph stage has a priors entry (no `no-prior` rows).
//   4. INVALID INPUT — out-of-range scores, a score finer than the rubric's
//      two decimals, a trailing --project-type with no value, unknown
//      --completed slugs, and a corrupted priors file (weights not summing to
//      1, wrong schemaVersion, a string cost, an unknown projectTypes value)
//      exit 1 with a naming error, never a silent fallback.
//   5. CONDITION AGREEMENT — --project-type screens out a stage whose
//      compiled condition restricts it to the other project type, so the
//      mechanical screen cannot contradict the stage it would have to run.
//      Pinned in BOTH directions: every priors `projectTypes` mirror answers
//      to a restricting condition, and every restricting condition has a
//      mirror — editing one side alone turns this file red.
//   6. INSTALL TOLERANCE — an install whose plugin selection disables a core
//      stage still runs `ars`: priors validate against the unfiltered graph.
//
// Mechanism: MIXED — in-process imports for the arithmetic/band/schema pins,
// spawns for the CLI exit-code rows (cli). Priors fault-injection rides the
// AIDLC_ARS_PRIORS env seam (mirrors AIDLC_SCOPE_GRID).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeArs, loadArsPriors } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const BUN = process.execPath;
const GRAPH_TOOL = join(AIDLC_SRC, "tools", "aidlc-graph.ts");
const PRIORS_PATH = join(AIDLC_SRC, "tools", "data", "ars-priors.json");
const STAGE_GRAPH_PATH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

// The persona's worked example (Step 8a, Table 1): 0.20*0.55 + 0.30*0.75 +
// 0.25*0.65 + 0.15*0.50 + 0.10*0.55 = 0.6275 -> raw 62.75 -> total 63.
const PERSONA_EXAMPLE = { iae: 0.55, csu: 0.75, ve: 0.65, r: 0.5, ua: 0.55 };

function runArs(args: string[], env?: Record<string, string>) {
  return spawnSync(BUN, [GRAPH_TOOL, "ars", ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

const SCORE_FLAGS = ["--iae", "0.55", "--csu", "0.75", "--ve", "0.65", "--r", "0.5", "--ua", "0.55"];

describe("t258 ars arithmetic pin (in-process)", () => {
  test("persona worked example: composite 63 / Comprehensive, Table 1 row byte-exact", () => {
    const r = computeArs(PERSONA_EXAMPLE);
    expect(r.composite.raw).toBeCloseTo(62.75, 10);
    expect(r.composite.total).toBe(63);
    expect(r.composite.label).toBe("Comprehensive");
    expect(r.tables.arsScores).toContain(
      "| **Composite ARS (advisory)** | - | **63 / 100** | **Comprehensive** |"
    );
    expect(r.tables.arsScores).toContain("| Codebase Structural Uncertainty | CSU | 0.75 | HIGH |");
  });

  test("component band edges: 0.29 LOW, 0.30 MED, 0.69 MED, 0.70 HIGH", () => {
    const at = (v: number) =>
      computeArs({ iae: v, csu: 0, ve: 0, r: 0, ua: 0 }).components.iae.band;
    expect(at(0.29)).toBe("LOW");
    expect(at(0.3)).toBe("MED");
    expect(at(0.69)).toBe("MED");
    expect(at(0.7)).toBe("HIGH");
  });

  test("composite band edges: uniform 0.20 -> 20 Near-direct, 0.21 -> 21 Focused", () => {
    const flat = (v: number) => computeArs({ iae: v, csu: v, ve: v, r: v, ua: v }).composite;
    expect(flat(0.2).total).toBe(20);
    expect(flat(0.2).label).toBe("Near-direct");
    expect(flat(0.21).total).toBe(21);
    expect(flat(0.21).label).toBe("Focused");
    expect(flat(1).total).toBe(100);
    expect(flat(1).label).toBe("Full ceremony");
  });

  test("exact half-point composite rounds by the formula, not by IEEE drift", () => {
    // 0.25*0.03 + 0.15*0.83 + 0.10*0.73 = 0.75 + 12.45 + 7.3 = 20.5 exactly,
    // but the IEEE sum of those terms is 20.499999999999996 - rounding the
    // raw sum would report 20 / Near-direct, one band below the documented
    // arithmetic, on the one figure the gate table bolds.
    const r = computeArs({ iae: 0, csu: 0, ve: 0.03, r: 0.83, ua: 0.73 });
    expect(r.composite.raw).toBe(20.5);
    expect(r.composite.total).toBe(21);
    expect(r.composite.label).toBe("Focused");
    // Same normalisation keeps the shipped JSON free of representation noise.
    expect(computeArs(PERSONA_EXAMPLE).composite.raw).toBe(62.75);
  });

  test("--project-type screens a brownfield-only stage out of a greenfield run", () => {
    // CSU 0.80 clears reverse-engineering's cost-4 threshold, so the
    // component screen alone says EXECUTE on every project type.
    const scores = { iae: 0, csu: 0.8, ve: 0, r: 0, ua: 0 };
    const unset = computeArs(scores);
    expect(unset.screenGrid["reverse-engineering"]).toBe("EXECUTE");
    expect(unset.evScreen.find((x) => x.stage === "reverse-engineering")?.screen).toBe("component");

    const brownfield = computeArs(scores, { projectType: "brownfield" });
    expect(brownfield.screenGrid["reverse-engineering"]).toBe("EXECUTE");

    const greenfield = computeArs(scores, { projectType: "greenfield" });
    expect(greenfield.screenGrid["reverse-engineering"]).toBe("SKIP");
    const row = greenfield.evScreen.find((x) => x.stage === "reverse-engineering");
    expect(row?.decision).toBe("SKIP");
    expect(row?.screen).toBe("project-type");
    expect(row?.reason).toContain("project is greenfield");
    expect(greenfield.projectType).toBe("greenfield");
    // Unrestricted stages are untouched by the flag.
    expect(greenfield.screenGrid["practices-discovery"]).toBe(
      brownfield.screenGrid["practices-discovery"]
    );
  });

  test("--completed outranks the project-type screen (the stage already ran)", () => {
    const r = computeArs(
      { iae: 0, csu: 0.8, ve: 0, r: 0, ua: 0 },
      { projectType: "greenfield", completed: ["reverse-engineering"] }
    );
    expect(r.evScreen.find((x) => x.stage === "reverse-engineering")?.decision).toBe("COMPLETED");
    expect(r.screenGrid["reverse-engineering"]).toBe("EXECUTE");
  });

  test("projectTypes mirrors the compiled condition in BOTH directions", () => {
    // The mirror is data, and nothing at runtime re-derives it: schema
    // validation is enum-only, so editing a stage's `condition:` (or adding a
    // project-restricted stage) would leave the priors silently stale and let
    // the screen contradict the stage again. The compiled graph carries the
    // condition prose verbatim, so the drift guard is cheap and lives here.
    //
    // A condition RESTRICTS a stage when it says to skip the other project
    // type outright. Naming both types to describe per-type BEHAVIOUR is not a
    // restriction — practices-discovery runs on either and must stay unmirrored.
    const SKIP_RE = /\bskip\s+for\s+(brownfield|greenfield)\b/i;
    const OTHER = { brownfield: "greenfield", greenfield: "brownfield" } as const;
    type ProjectType = keyof typeof OTHER;

    const graph = JSON.parse(readFileSync(STAGE_GRAPH_PATH, "utf-8")) as {
      slug: string;
      condition?: string;
    }[];
    const restricted = new Map<string, ProjectType>();
    for (const s of graph) {
      const m = SKIP_RE.exec(s.condition ?? "");
      if (m) restricted.set(s.slug, OTHER[m[1].toLowerCase() as ProjectType]);
    }
    const mirrored = new Map<string, string[]>();
    for (const [slug, st] of Object.entries(loadArsPriors().stages)) {
      if (st.projectTypes !== undefined) mirrored.set(slug, st.projectTypes);
    }

    // Anchor first: a regex that stopped matching would make both directions
    // pass vacuously over two empty sets.
    expect(restricted.get("reverse-engineering")).toBe("brownfield");
    expect(restricted.has("practices-discovery")).toBe(false);

    // 1. Every mirror answers to a restricting condition, naming the same type.
    for (const [slug, types] of mirrored) {
      // Paired with the slug so a failure names the stage that drifted.
      expect([slug, types]).toEqual([slug, [restricted.get(slug) as string]]);
    }
    // 2. Every restricting condition has its mirror.
    for (const [slug, type] of restricted) {
      expect([slug, mirrored.get(slug)]).toEqual([slug, [type]]);
    }
  });

  test("a score finer than two decimals throws (table and band cannot disagree)", () => {
    // 0.299 bands on the exact value (LOW) but renders "0.30" against the
    // documented LOW < 0.30; 0.4004 renders the self-contradictory reason
    // "reduces CSU=0.40 > threshold 0.4".
    expect(() => computeArs({ iae: 0.299, csu: 0, ve: 0, r: 0, ua: 0 })).toThrow(
      "--iae must have at most two decimals"
    );
    expect(() => computeArs({ iae: 0, csu: 0.4004, ve: 0, r: 0, ua: 0 })).toThrow(
      "--csu must have at most two decimals"
    );
    // Two decimals, one decimal, and integers all stay legal.
    for (const v of [0, 0.29, 0.3, 0.07, 1]) {
      expect(() => computeArs({ iae: v, csu: 0, ve: 0, r: 0, ua: 0 })).not.toThrow();
    }
  });

  test("EV screen: spine always executes, all-zero scores collapse the ideation gate", () => {
    const zero = computeArs({ iae: 0, csu: 0, ve: 0, r: 0, ua: 0 });
    expect(zero.screenGrid["code-generation"]).toBe("EXECUTE");
    expect(zero.screenGrid["build-and-test"]).toBe("EXECUTE");
    expect(zero.screenGrid["workspace-detection"]).toBe("EXECUTE");
    // cost-1 stages justify only on a NON-ZERO component (strict >), so a
    // fully-resolved intent folds the whole ideation phase — including its
    // phase gate: no ideation stage runs, so the boundary does not exist.
    expect(zero.screenGrid["intent-capture"]).toBe("SKIP");
    expect(zero.screenGrid["approval-handoff"]).toBe("SKIP");
    // Any non-zero IAE re-opens intent-capture and with it the phase gate.
    const some = computeArs({ iae: 0.5, csu: 0, ve: 0, r: 0, ua: 0 });
    expect(some.screenGrid["intent-capture"]).toBe("EXECUTE");
    expect(some.screenGrid["approval-handoff"]).toBe("EXECUTE");
  });

  test("--completed keeps the stage EXECUTE in the derived grid and marks the row COMPLETED", () => {
    const r = computeArs(
      { iae: 0, csu: 0, ve: 0, r: 0, ua: 0 },
      { completed: ["intent-capture"] }
    );
    const row = r.evScreen.find((x) => x.stage === "intent-capture");
    expect(row?.decision).toBe("COMPLETED");
    expect(r.screenGrid["intent-capture"]).toBe("EXECUTE");
  });

  test("shipped priors: schema loads, weights sum to 1.0, every graph stage covered", () => {
    const priors = loadArsPriors();
    expect(priors.schemaVersion).toBe(1);
    const r = computeArs(PERSONA_EXAMPLE);
    // 32 stages screened, none falling through to the no-prior branch.
    expect(r.evScreen.length).toBeGreaterThanOrEqual(32);
    expect(r.evScreen.filter((x) => x.screen === "no-prior")).toHaveLength(0);
    // Table 2 carries one row per screened stage plus its two header lines.
    expect(r.tables.stageDecisions.split("\n")).toHaveLength(r.evScreen.length + 2);
    // nearestScopes is sorted ascending by diff.
    const diffs = r.nearestScopes.map((s) => s.diff);
    expect([...diffs].sort((a, b) => a - b)).toEqual(diffs);
  });

  test("out-of-range score throws (in-process typo discipline)", () => {
    expect(() => computeArs({ iae: 1.5, csu: 0, ve: 0, r: 0, ua: 0 })).toThrow("[0.00, 1.00]");
    expect(() =>
      computeArs({ iae: 0, csu: 0, ve: 0, r: 0, ua: 0 }, { completed: ["not-a-stage"] })
    ).toThrow('unknown stage "not-a-stage"');
  });
});

describe("t258 ars CLI (spawn)", () => {
  test("happy path prints the full ArsResult JSON and exits 0", () => {
    const r = runArs(SCORE_FLAGS);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.composite.total).toBe(63);
    expect(out.tables.arsScores).toContain("**63 / 100**");
    expect(Object.keys(out.screenGrid).length).toBeGreaterThanOrEqual(32);
  });

  test("score outside [0,1] exits 1 naming the flag", () => {
    const r = runArs(["--iae", "1.5", "--csu", "0.5", "--ve", "0.5", "--r", "0.5", "--ua", "0.5"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--iae must be a number in [0.00, 1.00]");
  });

  test("missing required flag exits 1", () => {
    const r = runArs(["--iae", "0.5"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--csu");
  });

  test("unknown --completed slug exits 1 (typo discipline, like validate-grid)", () => {
    const r = runArs([...SCORE_FLAGS, "--completed", "intent-capture,not-a-stage"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown stage "not-a-stage"');
  });

  test("invalid --project-type exits 1", () => {
    const r = runArs([...SCORE_FLAGS, "--project-type", "purplefield"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("brownfield or greenfield");
  });

  test("trailing --project-type with no value exits 1 (never a silent unset)", () => {
    // Falling through to "unset" here is worse than a typo: the run succeeds
    // and reports EXECUTE for a stage the caller believes the greenfield
    // screen excluded. --completed rejects exactly this shape one screen up.
    const r = runArs([...SCORE_FLAGS, "--project-type"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--project-type requires a value");
    // The flag-as-value case keeps its more specific message.
    const r2 = runArs([...SCORE_FLAGS, "--project-type", "--completed", "intent-capture"]);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("brownfield or greenfield");
  });

  test("a score with more than two decimals exits 1 naming the flag", () => {
    const r = runArs(["--iae", "0.299", "--csu", "0.8", "--ve", "0", "--r", "0", "--ua", "0"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--iae must have at most two decimals");
    const ok = runArs(["--iae", "0.29", "--csu", "0.8", "--ve", "0", "--r", "0", "--ua", "0"]);
    expect(ok.status).toBe(0);
  });

  test("priors fault injection: bad weight sum and wrong schemaVersion exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "t258-priors-"));
    try {
      const shipped = JSON.parse(readFileSync(PRIORS_PATH, "utf-8"));
      const badSum = { ...shipped, weights: { ...shipped.weights, iae: 0.5 } };
      const badSumPath = join(dir, "bad-sum.json");
      writeFileSync(badSumPath, JSON.stringify(badSum));
      const r1 = runArs(SCORE_FLAGS, { AIDLC_ARS_PRIORS: badSumPath });
      expect(r1.status).toBe(1);
      expect(r1.stderr).toContain("must sum to 1.0");

      const badVersion = { ...shipped, schemaVersion: 2 };
      const badVersionPath = join(dir, "bad-version.json");
      writeFileSync(badVersionPath, JSON.stringify(badVersion));
      const r2 = runArs(SCORE_FLAGS, { AIDLC_ARS_PRIORS: badVersionPath });
      expect(r2.status).toBe(1);
      expect(r2.stderr).toContain("unsupported schemaVersion 2");

      // A STRING cost passes a bare `String(cost) in evThresholds` lookup and
      // then leaks into the result JSON's `cost` fields, which the ArsPriors
      // and ArsScreenRow contracts both declare `number | null`.
      const stringCost = {
        ...shipped,
        stages: {
          ...shipped.stages,
          "market-research": { ...shipped.stages["market-research"], cost: "1" },
        },
      };
      const stringCostPath = join(dir, "string-cost.json");
      writeFileSync(stringCostPath, JSON.stringify(stringCost));
      const r3 = runArs(SCORE_FLAGS, { AIDLC_ARS_PRIORS: stringCostPath });
      expect(r3.status).toBe(1);
      expect(r3.stderr).toContain("stages.market-research.cost must be a number or null");

      const badProjectTypes = {
        ...shipped,
        stages: {
          ...shipped.stages,
          "reverse-engineering": {
            ...shipped.stages["reverse-engineering"],
            projectTypes: ["purplefield"],
          },
        },
      };
      const badProjectTypesPath = join(dir, "bad-project-types.json");
      writeFileSync(badProjectTypesPath, JSON.stringify(badProjectTypes));
      const r4 = runArs(SCORE_FLAGS, { AIDLC_ARS_PRIORS: badProjectTypesPath });
      expect(r4.status).toBe(1);
      expect(r4.stderr).toContain("stages.reverse-engineering.projectTypes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an install with a disabled stage still screens (priors validate against the unfiltered graph)", () => {
    // The plugin-selection recompile marks deselected stages `enabled: false`;
    // loadGraph() filters those out, but the shipped priors still name all of
    // them. Validating the priors against the FILTERED graph would exit 1 on
    // every `ars` call on such an install.
    const dir = mkdtempSync(join(tmpdir(), "t258-graph-"));
    try {
      const graph = JSON.parse(readFileSync(STAGE_GRAPH_PATH, "utf-8"));
      const disabled = graph.map((s: { slug: string }) =>
        s.slug === "market-research" ? { ...s, enabled: false } : s
      );
      const graphPath = join(dir, "stage-graph.json");
      writeFileSync(graphPath, JSON.stringify(disabled));
      const r = runArs(SCORE_FLAGS, { AIDLC_STAGE_GRAPH: graphPath });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.screenGrid["market-research"]).toBeUndefined();
      expect(out.screenGrid["intent-capture"]).toBeDefined();
      // A slug in the priors that no longer exists ANYWHERE is still stale
      // data and still exits 1 - the tolerance is for disabled, not unknown.
      const renamed = graph.map((s: { slug: string }) =>
        s.slug === "market-research" ? { ...s, slug: "market-research-renamed" } : s
      );
      const renamedPath = join(dir, "renamed-graph.json");
      writeFileSync(renamedPath, JSON.stringify(renamed));
      const r2 = runArs(SCORE_FLAGS, { AIDLC_STAGE_GRAPH: renamedPath });
      expect(r2.status).toBe(1);
      expect(r2.stderr).toContain("stages.market-research is not in the compiled stage graph");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
