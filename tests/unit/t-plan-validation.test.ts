// covers: function:planStructureErrors, function:validatePlan, function:scopePlanGrid
//
// t-plan-validation - the one check behind every route that changes which
// stages a plan runs. A grid may name only compiled stages and must run every
// initialization stage, whatever its route: stage changes at creation,
// recompose, or a hand-written scope record compiled into a scope. A change is
// judged against the plan it was made from, so a stock scope's own advisories
// never veto an unrelated change; strict (recompose) makes a required input
// the change leaves without a producer an error, lenient (creation) an
// advisory.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { planStructureErrors, validatePlan } from "../../core/tools/aidlc-graph.ts";
import { scopePlanGrid } from "../../core/tools/aidlc-lib.ts";
import { AIDLC_SRC, withEnvAndFreshCaches } from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENV = {
  AIDLC_HARNESS_DIR: ".claude",
  AIDLC_SCOPE_MAPPING: undefined,
  AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
  AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
  AIDLC_SCOPES_DIR: join(REPO_ROOT, "core", "scopes"),
};
const INIT = ["workspace-scaffold", "workspace-detection", "state-init"];

const inEnv = <T>(fn: () => T): T => withEnvAndFreshCaches(ENV, fn);

describe("planStructureErrors", () => {
  test("a stock scope's grid is a plan every route accepts", () => {
    inEnv(() => {
      for (const scope of ["poc", "bugfix", "feature"]) {
        expect(planStructureErrors(scopePlanGrid(scope))).toEqual([]);
      }
    });
  });

  test("a slug that is no stage is named", () => {
    inEnv(() => {
      const grid = { ...scopePlanGrid("poc"), "not-a-stage": "EXECUTE" };
      expect(planStructureErrors(grid)).toEqual([
        'Grid names unknown stage "not-a-stage" - not in the compiled stage graph.',
      ]);
    });
  });

  test("an initialization stage left out or skipped is named, one line each", () => {
    inEnv(() => {
      const missing = planStructureErrors({ "requirements-analysis": "EXECUTE", "code-generation": "EXECUTE" });
      expect(missing).toEqual(
        INIT.map((slug) => `Grid does not run "${slug}", an initialization stage; those always run.`),
      );
      const skipped = planStructureErrors({ ...scopePlanGrid("poc"), "state-init": "SKIP" });
      expect(skipped).toEqual(['Grid does not run "state-init", an initialization stage; those always run.']);
    });
  });

  test("it checks against the stages it is handed, as compile does", () => {
    const stages = [
      { slug: "boot", phase: "initialization" },
      { slug: "off-init", phase: "initialization", enabled: false as const },
      { slug: "build", phase: "construction" },
    ];
    expect(planStructureErrors({ boot: "EXECUTE", build: "SKIP" }, stages)).toEqual([]);
    expect(planStructureErrors({ build: "EXECUTE", gone: "SKIP" }, stages)).toEqual([
      'Grid names unknown stage "gone" - not in the compiled stage graph.',
      'Grid does not run "boot", an initialization stage; those always run.',
    ]);
  });
});

describe("validatePlan", () => {
  test("a skip that leaves a required input without its producer: an error in strict, an advisory otherwise", () => {
    inEnv(() => {
      const base = scopePlanGrid("poc");
      const proposed = { ...base, "requirements-analysis": "SKIP" };
      const strict = validatePlan(base, proposed, { strict: true, label: "poc changed" });
      expect(strict.advisories).toEqual([]);
      expect(strict.errors).toEqual([
        'Stage "code-generation" requires artifact "requirements" whose producer(s) [requirements-analysis] ' +
          'are not on the "poc changed" path. Strict (recompose) mode rejects a starved required input.',
      ]);
      const lenient = validatePlan(base, proposed, { label: "poc changed" });
      expect(lenient.errors).toEqual([]);
      expect(lenient.advisories).toEqual([
        'Stage "code-generation" requires artifact "requirements" whose producer(s) [requirements-analysis] ' +
          'are not on the "poc changed" path. Ensure existing artifact is current.',
      ]);
    });
  });

  test("what the base already has is never the change's fault", () => {
    inEnv(() => {
      // bugfix's code-generation already runs without units-generation's
      // unit-of-work; adding a stage whose own inputs are on the plan must not
      // be refused for it.
      const base = scopePlanGrid("bugfix");
      expect(base["units-generation"]).toBe("SKIP");
      expect(base["ci-pipeline"]).toBe("SKIP");
      expect(validatePlan(base, base, { strict: true })).toEqual({ errors: [], advisories: [] });
      const proposed = { ...base, "ci-pipeline": "EXECUTE" };
      expect(validatePlan(base, proposed, { strict: true })).toEqual({ errors: [], advisories: [] });
    });
  });

  test("a change that drops an initialization stage or names an unknown one is an error either way", () => {
    inEnv(() => {
      const base = scopePlanGrid("poc");
      for (const strict of [true, false]) {
        const result = validatePlan(base, { ...base, "workspace-detection": "SKIP", typo: "EXECUTE" }, { strict });
        expect(result.errors).toContain('Grid names unknown stage "typo" - not in the compiled stage graph.');
        expect(result.errors).toContain(
          'Grid does not run "workspace-detection", an initialization stage; those always run.',
        );
        // Named once, though both checks find it.
        expect(result.errors.filter((e) => e.includes('"typo"'))).toHaveLength(1);
      }
    });
  });

  test("scopePlanGrid covers every compiled stage, so a plan is never judged on a partial grid", () => {
    inEnv(() => {
      const grid = scopePlanGrid("poc");
      expect(Object.keys(grid).length).toBeGreaterThan(30);
      for (const slug of INIT) expect(grid[slug]).toBe("EXECUTE");
      expect(grid["domain-design"]).toBe("SKIP");
    });
  });
});
