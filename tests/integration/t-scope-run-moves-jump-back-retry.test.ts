// covers: scope:classic, audit:GATE_REJECTED
//
// A person move in a scope run, with no model (tests/harness/jump-back.ts):
// both Units are built and approved, Build and Test fails with the root cause
// in Unit 2's code, and the person picks "Retry with fix". The Construction
// protocol's loop-back reopens Code Generation for the Unit the fix names
// (`next --stage code-generation --unit <unit>`), so the other Unit keeps its
// approval and is asked nothing. The loop-back wording is pinned by t305.

import { afterAll, describe, expect, test } from "bun:test";
import {
  after,
  approved,
  cleanupJumpBackRuns,
  expectCodeGenerationFor,
  followPrint,
  marksOf,
  toBuildAndTest,
  UNITS,
  unitWork,
} from "../harness/jump-back.ts";
import { SCOPE_RUN_TIMEOUT_MS } from "../harness/scope-run.ts";

afterAll(cleanupJumpBackRuns);

describe("Build and Test's loop-back after both Units are built", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: "Retry with fix" reopens Code Generation for the Unit the fix names`, () => {
      const { run, first } = toBuildAndTest(policy, "work");
      const { agent } = run;
      const marks = marksOf(agent);
      // Build and Test runs and fails: the root cause is extra's code (gated: the halt-and-ask).
      for (const p of (first!.produces as string[] | undefined) ?? []) {
        agent.host.write(p, p.endsWith("test-results.md")
          ? "# Test Results\n\n## Summary\n\n- FAILED: test/extra.test.ts expected 43, got 42.\n\n## Loop-Back Log\n\n" +
            "### Loop-back 1 - 2026-10-07T00:30:00Z\n\n- Diagnosis: extra() returns the old total.\n" +
            "- Root-cause stage: code-generation\n- Planned fix: return 43 from extra() (Unit extra only).\n" +
            "- Estimated impact: effort small; financial cost none; risk low.\n"
          : `# ${p.split("/").pop()}\n\nBuild and Test ran and failed (see test-results.md).\n`);
      }
      const question = "Build and Test failed: test/extra.test.ts expected 43, got 42. Root cause: extra's code returns " +
        "the old total. Candidate fix: return 43 from extra(). Loop-backs used: 1/3. How would you like to proceed?";
      agent.must("log", "decision", "--stage", "build-and-test", "--decision", question,
        "--options", "Retry with fix,Accept failure,Abort");
      agent.askPerson("build failure", "build-and-test", question, ["Retry with fix", "Accept failure", "Abort"], "Retry with fix");
      agent.must("log", "answer", "--stage", "build-and-test", "--details", "Retry with fix");
      // The protocol's loop-back: Code Generation for the Unit the diagnosis names.
      const jump = followPrint(agent, agent.next("--stage", "code-generation", "--unit", "extra"));
      expect(jump.ran).toContain("reopen --target code-generation");
      expect(jump.ran).toContain("--units extra");
      expectCodeGenerationFor(jump.next, "extra");
      expect(approved(agent, "core")).toBe(true);
      expect(agent.drive(jump.next).kind).toBe("done");
      const moved = after(agent, marks);
      expect(unitWork(moved.worked)).toEqual(["code-generation/extra"]);
      expect(unitWork(moved.reviewed)).toEqual(["code-generation/extra"]);
      expect(moved.asked.filter((q) => q.endsWith(" for core"))).toEqual([]);
      expect(moved.worked).toContain("build-and-test/-");
      for (const unit of UNITS) expect(approved(agent, unit)).toBe(true);
      expect(agent.refusalsMet).toEqual([]);
    }, SCOPE_RUN_TIMEOUT_MS);
  }
});
