// covers: scope:classic, subcommand:aidlc-orchestrate:next, subcommand:aidlc-state:set-unit-ownership, audit:UNIT_OWNERSHIP_SET
//
// Who builds the Units, in a scope run with no model (tests/harness/scope-run.ts).
// The incident: a feature, a workshop and a composed run with two Units each
// reached Construction with nobody asked, because the question lived in one
// paragraph of Delivery Planning prose and nothing in the engine asked it. Here
// a plan with Delivery Planning and one without it both put the question to the
// person once, after Inception's last approval and before the first Unit is
// built, and never again for the rest of the run.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composedCell, installComposed } from "../harness/guard-matrix.ts";
import {
  activeRecord,
  auditEvents,
  cleanupScopeProjects,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  type ScopeRun,
  scopeScratchDir,
} from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

const CONSTRUCTION = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

function asksOnceBeforeTheBuild(run: ScopeRun): void {
  expect(run.final.kind).toBe("done");
  const staffing = run.agent.asked.filter((q) => q.what === "staffing");
  expect(staffing).toHaveLength(1);
  const directives = run.agent.directives;
  const asked = directives.findIndex((d) => d.kind === "ask" && d.ask_type === "construction-staffing");
  const built = directives.findIndex((d) => d.kind === "run-stage" && CONSTRUCTION.includes(String(d.stage)));
  const inception = directives.map((d, i) => d.kind === "run-stage" &&
    ["units-generation", "delivery-planning"].includes(String(d.stage)) ? i : -1).filter((i) => i >= 0 && i < asked);
  const lastInception = inception.length > 0 ? inception[inception.length - 1] : -1;
  expect(lastInception).toBeGreaterThanOrEqual(0);
  expect(asked).toBeGreaterThan(lastInception);
  expect(asked).toBeLessThan(built);
  expect(directives.filter((d) => d.ask_type === "construction-staffing")).toHaveLength(1);
  const state = readFileSync(join(activeRecord(run.proj).dir, "aidlc-state.md"), "utf-8");
  expect(/^- \*\*Unit Ownership\*\*: solo$/m.test(state)).toBe(true);
  expect(auditEvents(run.proj).filter((e) => e.event === "UNIT_OWNERSHIP_SET").map((e) => field(e.block, "Mode")))
    .toEqual(["solo"]);
}

describe("who builds the Units is asked once, as Inception ends", () => {
  test("a plan with Delivery Planning", () => {
    const run = runScope("classic", {
      units: ["alpha", "beta"],
      flags: ["--skip", ["practices-discovery", "user-stories", "refined-mockups", "contract-design",
        "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"].join(",")],
    });
    expect(run.agent.worked.some((d) => d.stage === "delivery-planning")).toBe(true);
    asksOnceBeforeTheBuild(run);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("a composed plan without Delivery Planning", () => {
    const composed = composedCell("two-units-composed", "strict", "advisory");
    const scopeFile = join(scopeScratchDir("staffing-composed-"), `aidlc-${composed.name}.md`);
    writeFileSync(scopeFile, composed.text);
    const run = runScope(composed.name, {
      units: ["alpha", "beta"],
      scopeFile,
      prepare: (proj) => void installComposed(proj, composed),
    });
    expect(run.agent.worked.some((d) => d.stage === "delivery-planning")).toBe(false);
    asksOnceBeforeTheBuild(run);
  }, SCOPE_RUN_TIMEOUT_MS);
});
