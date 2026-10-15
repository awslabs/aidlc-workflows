// An explicit build order is independent of dependency batches. Its named
// proof can follow prerequisites without making a skipped Unit a proof.
import { describe, expect, test } from "bun:test";
import { parseConstructionPlan, validateConstructionPlan } from "../../core/tools/aidlc-construction-plan.ts";

const units = [
  { name: "u1", depends_on: [] }, { name: "u2", depends_on: ["u1"] },
  { name: "u3", depends_on: ["u1"] }, { name: "u4", depends_on: ["u3"] },
  { name: "u5", depends_on: ["u1", "u3"] }, { name: "u6", depends_on: ["u4", "u5"] },
  { name: "u7", depends_on: ["u6"] }, { name: "u8", depends_on: ["u6"] },
  { name: "u9", depends_on: ["u7", "u8"] }, { name: "u10", depends_on: ["u2", "u9"] },
];
const plan = { version: 1 as const, units: ["u1", "u2", "u3", "u5", "u4", "u6", "u7", "u8", "u9", "u10"], proof_unit: "u5" };

describe("explicit Construction plan", () => {
  test("keeps the ten-unit choice without changing thirteen dependencies", () => {
    expect(validateConstructionPlan(plan, units)).toEqual(plan);
    expect(units.flatMap((unit) => unit.depends_on)).toHaveLength(13);
  });
  test("default and retired plans preserve the legacy route", () => {
    expect(parseConstructionPlan(null)).toBeNull();
    expect(parseConstructionPlan("retired")).toBeNull();
    expect(parseConstructionPlan(JSON.stringify(plan))).toEqual(plan);
  });
  test("rejects malformed schema and unknown versions", () => {
    for (const value of ["{}", "[]", "not-json", JSON.stringify({ ...plan, version: 2 }), JSON.stringify({ ...plan, extra: true })]) {
      expect(() => parseConstructionPlan(value)).toThrow();
    }
  });
  test("rejects omitted, unknown, duplicate and out-of-order Units", () => {
    for (const order of [plan.units.slice(1), [...plan.units, "u11"], [...plan.units.slice(0, -1), "u1"], ["u2", "u1", ...plan.units.slice(2)]]) {
      expect(() => validateConstructionPlan({ ...plan, units: order }, units)).toThrow();
    }
    expect(() => validateConstructionPlan({ ...plan, proof_unit: "unknown" }, units)).toThrow();
  });
});
