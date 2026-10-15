import { expect, test } from "bun:test";
import { benchmarkPrompt, judgeMethodResponse, methodCases } from "./crisp-mlq-benchmark.ts";
import { crispMlqPhases, crispMlqReference } from "../tools/aws-mlops-crisp-mlq.ts";

// Synthetic scorer inputs only; passing this file says nothing about an LLM.
function fixture() {
  return {
    reference_revision: crispMlqReference.revision,
    cases: methodCases.map((entry) => ({
      id: entry.id, phase: entry.phase, disposition: entry.dispositions[0],
      actions: [...entry.expected],
      requirement_ids: crispMlqPhases.find((phase) => phase.id === entry.phase)?.requirements.map((requirement) => requirement.id) ?? [],
      reason: "Synthetic scorer fixture.",
      quality_assurance: {
        risk: "Synthetic failure.", mitigation: "Synthetic correction.",
        evidence_needed: "Synthetic check.", residual_risk: "Synthetic remaining limit.",
      },
    })),
  };
}

test("benchmark supplies the reference and scenarios, withholding the expected answers", () => {
  const prompt = benchmarkPrompt("fixture local reference");
  expect(prompt).toContain("fixture local reference");
  expect(prompt).toContain("PHASE CONTRACTS");
  expect(prompt).not.toContain('"expected":');
  expect(prompt).not.toContain('"disposition":"pending","scenario"');
  expect(methodCases).toHaveLength(6);
});

test("scorer accepts complete synthetic cases and rejects missing or contradictory answers", () => {
  expect(judgeMethodResponse(fixture())).toEqual([]);
  const revised = fixture();
  revised.cases[5].disposition = "revise";
  revised.cases[2].requirement_ids.push("DP-03", "EV-01");
  expect(judgeMethodResponse(revised)).toEqual([]);
  const unknown = fixture();
  unknown.cases[2].requirement_ids.push("UNKNOWN-99");
  expect(judgeMethodResponse(unknown)).toContain("modeling-best-run: unknown methodology requirement.");
  const missing = fixture();
  missing.cases.pop();
  expect(judgeMethodResponse(missing)).toContain("Missing case: maintenance-no-labels.");
  const wrong = fixture();
  const value: unknown = {
    ...wrong,
    cases: wrong.cases.map((entry, index) => index === 3
      ? { ...entry, disposition: "proceed", actions: ["proceed"], requirement_ids: [], quality_assurance: null }
      : entry),
  };
  expect(judgeMethodResponse(value).length).toBeGreaterThan(4);
  for (const invalid of [null, [], {}, { ...fixture(), reference_revision: "old" }]) {
    expect(judgeMethodResponse(invalid).length).toBeGreaterThan(0);
  }
});
