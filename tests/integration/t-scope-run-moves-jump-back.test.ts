// covers: scope:classic, audit:STAGE_JUMPED
//
// A person move in a scope run, with no model (tests/harness/jump-back.ts):
// both Units are built and approved, Build and Test's approval is open, and
// the person goes back to a whole earlier stage. The jump redoes exactly what
// they asked for: "go back to Code Generation" redoes Code Generation for each
// Unit and keeps Functional Design; "go back to Functional Design" redoes the
// stage it names and the one after it. One Unit only, and Build and Test's
// "Retry with fix", are t-scope-run-moves-jump-back-one-unit and -retry.

import { afterAll, describe, expect, test } from "bun:test";
import {
  after,
  approved,
  cleanupJumpBackRuns,
  expectCodeGenerationFor,
  followPrint,
  jumpAtGate,
  marksOf,
  toBuildAndTest,
  UNITS,
  unitWork,
} from "../harness/jump-back.ts";
import { SCOPE_RUN_TIMEOUT_MS } from "../harness/scope-run.ts";

afterAll(cleanupJumpBackRuns);

describe("a jump back to a whole stage after both Units are built", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: "go back to Code Generation" redoes Code Generation for each Unit and keeps Functional Design`, () => {
      const { run } = toBuildAndTest(policy, "gate");
      const { agent } = run;
      const marks = marksOf(agent);
      const jump = followPrint(agent, jumpAtGate(agent, "Jump back to Code Generation and redo it", "code-generation"));
      expect(jump.ran).toContain("--target code-generation");
      expectCodeGenerationFor(jump.next);
      expect(agent.drive(jump.next).kind).toBe("done");
      const moved = after(agent, marks);
      // No Functional Design pass or review: the person asked for Code Generation.
      expect(unitWork(moved.worked).sort()).toEqual(["code-generation/core", "code-generation/extra"]);
      expect(unitWork(moved.reviewed).sort()).toEqual(["code-generation/core", "code-generation/extra"]);
      expect(moved.asked.filter((q) => q.includes("functional-design"))).toEqual([]);
      // Each Unit's code changed, so each Unit's approval is asked once.
      expect(moved.asked.filter((q) => q.startsWith("unit checkpoint")).sort()).toEqual(
        ["unit checkpoint at code-generation for core", "unit checkpoint at code-generation for extra"],
      );
      expect(moved.worked).toContain("build-and-test/-");
      for (const unit of UNITS) expect(approved(agent, unit)).toBe(true);
      expect(agent.refusalsMet).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);
  }

  test(`"go back to Functional Design" redoes Functional Design and Code Generation for every Unit, as asked`, () => {
    const { run } = toBuildAndTest("off", "gate");
    const { agent } = run;
    const marks = marksOf(agent);
    const jump = followPrint(agent, jumpAtGate(agent, "go back to Functional Design", "functional-design"));
    expect(jump.ran).toContain("--target functional-design");
    expect(jump.next.stage).toBe("functional-design");
    expect(agent.drive(jump.next).kind).toBe("done");
    expect(unitWork(after(agent, marks).worked).sort()).toEqual([
      "code-generation/core", "code-generation/extra", "functional-design/core", "functional-design/extra",
    ]);
    for (const unit of UNITS) expect(approved(agent, unit)).toBe(true);
    expect(agent.refusalsMet).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);
});
