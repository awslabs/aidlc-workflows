// covers: scope:classic, audit:GATE_REJECTED
//
// A person move in a scope run, with no model (tests/harness/jump-back.ts):
// both Units are built and approved, Build and Test's approval is open, and
// the person says "go back to Code Generation for Unit 2 only". Only that Unit
// redoes Code Generation: the other Unit keeps its approval and is asked
// nothing, and Build and Test runs again. The refusal that used to answer
// here ("only while Construction builds one unit at a time") is gone.

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

describe("a jump back for one Unit after both Units are built", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: "go back to Code Generation for Unit 2 only" redoes it for extra; core is asked nothing`, () => {
      const { run } = toBuildAndTest(policy, "gate");
      const { agent } = run;
      const marks = marksOf(agent);
      const print = jumpAtGate(agent, "go back to Code Generation for Unit 2 only", "code-generation", "extra");
      expect(print.kind, JSON.stringify(print)).toBe("print");
      expect(String(print.message)).not.toContain("one unit at a time");
      const jump = followPrint(agent, print);
      expect(jump.ran).toContain("reopen --target code-generation");
      expect(jump.ran).toContain("--units extra");
      expect(jump.said).toContain('"Reopened Code Generation for unit extra. core keeps its finished work.');
      expectCodeGenerationFor(jump.next, "extra");
      expect(approved(agent, "core")).toBe(true);
      expect(agent.drive(jump.next).kind).toBe("done");
      const moved = after(agent, marks);
      expect(unitWork(moved.worked)).toEqual(["code-generation/extra"]);
      expect(unitWork(moved.reviewed)).toEqual(["code-generation/extra"]);
      expect(moved.asked.filter((q) => q.endsWith(" for core"))).toEqual([]);
      expect(moved.asked.filter((q) => q.startsWith("unit checkpoint"))).toEqual(
        ["unit checkpoint at code-generation for extra"],
      );
      // A reopen is a redo: extra's plan comes back for approval once, under every Guard Policy.
      expect(moved.asked.filter((q) => q.startsWith("plan approval"))).toHaveLength(1);
      expect(moved.worked).toContain("build-and-test/-");
      for (const unit of UNITS) expect(approved(agent, unit)).toBe(true);
      expect(agent.refusalsMet).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);
  }
});
