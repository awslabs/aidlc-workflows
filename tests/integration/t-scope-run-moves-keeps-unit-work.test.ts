// covers: subcommand:aidlc-utility:scope-change, subcommand:aidlc-orchestrate:report, audit:SCOPE_CHANGED, audit:CEREMONY_SET
//
// A scope change part way through Construction keeps the Unit work already
// done, with no model (tests/harness/scope-change-run.ts). Classic, Units
// alpha and beta built one at a time: alpha is approved at its checkpoint and
// beta's NFR Design question is open when the person types a new scope. The
// change goes through and the run carries on to done:
//   - bugfix drops Functional Design and the NFR stages: they are settled as
//     skipped for the Units that already did them (their files stay), and beta
//     goes on to Code Generation;
//   - mvp turns summary confirmation on: the Functional Design both Units
//     finished while it was off is never asked about again, and alpha's
//     approved work is never redone.
// In each, alpha's checkpoint approval stands: the new plan's steps, review
// cap or walking skeleton never ask about alpha again. And with beta's
// checkpoint question open at the switch, the person's one "approve" records
// it: beta is not verified or asked again.

import { afterAll, describe, expect, test } from "bun:test";
import { switchAndFinish } from "../harness/scope-change-run.ts";
import { cleanupScopeProjects, field, SCOPE_RUN_TIMEOUT_MS } from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

describe("a scope change in Construction keeps the Unit work already done", () => {
  test("classic to bugfix with beta in progress: the dropped stages are skipped, beta's code is built, done", () => {
    const { said, rows, worked, printed } = switchAndFinish("bugfix", []);
    expect(said).toContain("Switched to bugfix");
    expect(said).toContain("The beta Unit's NFR Design work is no longer part of the plan.");
    expect(rows.filter((e) => e.event === "STAGE_SKIPPED").map((e) => field(e.block, "Stage"))).toContain("functional-design");
    expect(worked.filter((d) => d.stage === "code-generation").map((d) => d.unit)).toEqual(["beta"]);
    // Said once, with the step the agent speaks from next (every engine call goes through bash).
    const line = "Functional Design is not part of the bugfix plan; what the Units already did for it stays as it is.";
    expect(printed.filter((out) => out.includes(line))).toHaveLength(1);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("classic to mvp with beta in progress: finished Functional Design is not asked a summary, done", () => {
    const { said, rows, asked } = switchAndFinish("mvp", []);
    expect(said).toContain("Switched to mvp");
    expect(said).toContain("Summary Confirmation changed: off (from scope classic) to on (from scope mvp)");
    const set = rows.filter((e) => e.event === "CEREMONY_SET" && field(e.block, "Key") === "summary_confirmation");
    expect(set.map((e) => field(e.block, "New"))).toEqual(["on"]);
    // No Functional Design summary for the work both Units finished before the change.
    expect(asked.filter((q) => q.what === "summary confirmation" && q.stage === "functional-design")).toEqual([]);
    expect(rows.filter((e) => e.event === "UNIT_STARTED" && field(e.block, "Stage") === "functional-design")).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("classic to mvp with beta's checkpoint question open: one approve records it, done", () => {
    const { rows, asked } = switchAndFinish("mvp", [], {}, "beta-checkpoint");
    expect(asked.filter((q) => q.unit === "beta" && q.what.endsWith("checkpoint"))).toEqual([]);
    const approved = rows.filter((e) => e.event === "GATE_APPROVED" && field(e.block, "Unit") === "beta" &&
      field(e.block, "Gate Scope") === "unit-end");
    expect(approved).toHaveLength(1);
    expect(rows.filter((e) => e.event === "CHECKPOINT_VERIFICATION_RECORDED" && field(e.block, "Unit") === "beta")).toEqual([]);
  }, SCOPE_RUN_TIMEOUT_MS);
});
