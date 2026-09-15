// POC (feat/typed-dependency-edges) · Phase 1 PoC evidence
//
// covers: core/tools/aidlc-validity.ts
// covers: function:computeProducerOutputChanges function:propagateStageInvalidation
//
// This suite is the deterministic A/B evidence for the "typed dependency
// edges" spike. It bypasses the filesystem entirely and drives
// propagateStageInvalidation with hand-constructed StageValidationBasis
// pairs so the differential is isolated from any resolver or audit code.
//
// Fixture (mirrors the story-deck example):
//
//     A (design)
//       |──> B (code-generation, sensitivity: content) — cares about bytes
//       |──> C (documentation,   sensitivity: structure) — cares about shape
//       └──> D (traceability, no declared sensitivity)   — pessimistic default
//
// Three mutations of A's produced artifact "X":
//
//   P1 content-only  : contentHash flips, structureHash unchanged
//                      (e.g., a typo fix in an appendix section)
//   P2 structure-only: structureHash flips, contentHash unchanged
//                      (e.g., a new unit instance added with empty content)
//   P3 both          : both hashes flip
//                      (e.g., a real semantic edit that reshapes and rewrites)
//
// Baseline (no producerOutputChanges argument) is the pre-PoC behavior:
// every direct edge propagates whenever the producer is stale. Candidate
// (with producerOutputChanges) filters by consumer sensitivity.
//
// The `console.log` blocks are intentional PoC evidence output — they let a
// reviewer inspect the differential without re-running the algorithm by
// hand. They stay in the PoC branch and are removed before the RFC PR.

import { describe, expect, test } from "bun:test";
import {
  computeProducerOutputChanges,
  propagateStageInvalidation,
  type ArtifactBasis,
  type StageValidationBasis,
  type StageValidityIssue,
  type StageValidityNode,
} from "../../core/tools/aidlc-validity.ts";

const stages: StageValidityNode[] = [
  { slug: "A", phase: "inception", produces: ["X"], consumes: [] },
  {
    slug: "B",
    phase: "construction",
    produces: ["code"],
    consumes: [{ artifact: "X", required: true, sensitivity: "content" }],
  },
  {
    slug: "C",
    phase: "construction",
    produces: ["docs"],
    consumes: [{ artifact: "X", required: true, sensitivity: "structure" }],
  },
  {
    slug: "D",
    phase: "operation",
    produces: ["trace"],
    consumes: [{ artifact: "X", required: true }], // no sensitivity
  },
];

const completedSlugs = new Set(["A", "B", "C", "D"]);

function ab(
  artifact: string,
  producer: string,
  structureHash: string,
  contentHash: string,
  sensitivity?: "structure" | "content",
): ArtifactBasis {
  const basis: ArtifactBasis = {
    artifact,
    producer,
    required: true,
    instanceCount: 1,
    presentCount: 1,
    structureHash: `sha256:${structureHash}`,
    contentHash: `sha256:${contentHash}`,
  };
  if (sensitivity) basis.sensitivity = sensitivity;
  return basis;
}

/**
 * Build the receipts snapshot as it was at each stage's completion.
 * A produced X with (structure=s0, content=c0). B/C/D each recorded a
 * consumption of that same X, tagged with their own sensitivity.
 */
function receiptsAt(sX: string, cX: string): Map<string, StageValidationBasis> {
  const producedX = ab("X", "A", sX, cX);
  const consumedX = (sens?: "structure" | "content"): ArtifactBasis =>
    ab("X", "A", sX, cX, sens);
  return new Map<string, StageValidationBasis>([
    ["A", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [], outputs: [producedX],
    }],
    ["B", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [consumedX("content")],
      outputs: [ab("code", "B", "s-code", "c-code")],
    }],
    ["C", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [consumedX("structure")],
      outputs: [ab("docs", "C", "s-docs", "c-docs")],
    }],
    ["D", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [consumedX()], // undeclared sensitivity
      outputs: [ab("trace", "D", "s-trc", "c-trc")],
    }],
  ]);
}

function currentBasesAfter(
  sX: string,
  cX: string,
  receiptSX: string,
  receiptCX: string,
): Map<string, StageValidationBasis> {
  // The consumers' receipts are frozen at completion time; the CURRENT
  // basis for the producer reflects whatever the file now looks like.
  // Consumers' own outputs are unchanged (they didn't rerun).
  const producedX = ab("X", "A", sX, cX);
  return new Map<string, StageValidationBasis>([
    ["A", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [], outputs: [producedX],
    }],
    // B/C/D still show their frozen input snapshot when we re-inspect them:
    // the inputs field on the CURRENT basis reflects what the resolver sees
    // now, which is A's updated X. We don't need to compare consumer bases
    // here because propagation is driven by directReasons on A + edges.
    ["B", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [ab("X", "A", sX, cX, "content")],
      outputs: [ab("code", "B", "s-code", "c-code")],
    }],
    ["C", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [ab("X", "A", sX, cX, "structure")],
      outputs: [ab("docs", "C", "s-docs", "c-docs")],
    }],
    ["D", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [ab("X", "A", sX, cX)],
      outputs: [ab("trace", "D", "s-trc", "c-trc")],
    }],
  ]);
}

interface Scenario {
  label: string;
  receiptSX: string;
  receiptCX: string;
  currentSX: string;
  currentCX: string;
  changeClass: string;
}

const scenarios: Scenario[] = [
  {
    label: "P1 content-only (typo in appendix)",
    receiptSX: "s0", receiptCX: "c0",
    currentSX: "s0", currentCX: "c1",
    changeClass: "content changed, structure unchanged",
  },
  {
    label: "P2 structure-only (new unit added, empty payload)",
    receiptSX: "s0", receiptCX: "c0",
    currentSX: "s1", currentCX: "c0",
    changeClass: "structure changed, content unchanged",
  },
  {
    label: "P3 both (semantic reshape + rewrite)",
    receiptSX: "s0", receiptCX: "c0",
    currentSX: "s1", currentCX: "c1",
    changeClass: "structure changed, content changed",
  },
];

function directReasonsFor(scenario: Scenario): Map<string, string[]> {
  // A is directly stale in every scenario because at least one output hash
  // moved. The exact reason string does not affect propagation, only its
  // presence in the map.
  return new Map([["A", ["output:X"]]]);
}

function slugsOf(issues: readonly StageValidityIssue[]): string[] {
  return issues
    .filter((issue) => issue.stage !== "A") // isolate propagation effect
    .map((issue) => `${issue.stage}(${issue.direct ? "direct" : issue.status})`)
    .sort();
}

describe("selective propagation PoC · A/B evidence", () => {
  for (const scenario of scenarios) {
    describe(scenario.label, () => {
      const receipts = receiptsAt(scenario.receiptSX, scenario.receiptCX);
      const current = currentBasesAfter(
        scenario.currentSX,
        scenario.currentCX,
        scenario.receiptSX,
        scenario.receiptCX,
      );
      const direct = directReasonsFor(scenario);
      const changes = computeProducerOutputChanges(receipts, current);

      const baseline = propagateStageInvalidation(
        stages,
        completedSlugs,
        direct,
        receipts,
      );

      const candidate = propagateStageInvalidation(
        stages,
        completedSlugs,
        direct,
        receipts,
        changes,
      );

      test("baseline propagates to every direct consumer", () => {
        // Baseline is pessimistic: any change to A cascades to B, C, D.
        expect(slugsOf(baseline)).toEqual([
          "B(needs-revalidation)",
          "C(needs-revalidation)",
          "D(needs-revalidation)",
        ]);
      });

      test(`candidate applies sensitivity filter (${scenario.changeClass})`, () => {
        const actual = slugsOf(candidate);
        const evidence = {
          scenario: scenario.label,
          producerChangeClass: {
            structure: changes.get("A")?.get("X")?.structure,
            content: changes.get("A")?.get("X")?.content,
          },
          baselinePropagation: slugsOf(baseline),
          candidatePropagation: actual,
        };
        console.log("[PoC evidence]", JSON.stringify(evidence, null, 2));

        if (scenario.label.startsWith("P1")) {
          // content-only: content-sensitive B propagates, structure-sensitive
          // C skips, undeclared D remains pessimistic (still propagates).
          expect(actual).toEqual([
            "B(needs-revalidation)",
            "D(needs-revalidation)",
          ]);
        } else if (scenario.label.startsWith("P2")) {
          // structure-only: structure-sensitive C propagates, content-
          // sensitive B skips, undeclared D remains pessimistic.
          expect(actual).toEqual([
            "C(needs-revalidation)",
            "D(needs-revalidation)",
          ]);
        } else {
          // both: every consumer propagates (matches baseline).
          expect(actual).toEqual([
            "B(needs-revalidation)",
            "C(needs-revalidation)",
            "D(needs-revalidation)",
          ]);
        }
      });
    });
  }

  test("undeclared sensitivity preserves pre-PoC pessimistic behavior", () => {
    // If NO consumer declares sensitivity, the algorithm must reduce to
    // pre-PoC propagation regardless of whether producerOutputChanges is
    // supplied. This guards the backward-compat contract.
    const noSensitivityStages: StageValidityNode[] = stages.map((stage) => {
      if (!stage.consumes || stage.consumes.length === 0) return stage;
      return {
        ...stage,
        consumes: stage.consumes.map((c) => ({
          artifact: c.artifact,
          required: c.required,
        })),
      };
    });
    const receipts = new Map<string, StageValidationBasis>();
    for (const [slug, basis] of receiptsAt("s0", "c0")) {
      receipts.set(slug, {
        ...basis,
        inputs: basis.inputs.map((input) => {
          const { sensitivity: _drop, ...rest } = input;
          return rest;
        }),
      });
    }
    const current = currentBasesAfter("s0", "c1", "s0", "c0");
    const direct = directReasonsFor(scenarios[0]);
    const changes = computeProducerOutputChanges(receipts, current);

    const candidate = propagateStageInvalidation(
      noSensitivityStages,
      completedSlugs,
      direct,
      receipts,
      changes,
    );
    expect(slugsOf(candidate)).toEqual([
      "B(needs-revalidation)",
      "C(needs-revalidation)",
      "D(needs-revalidation)",
    ]);
  });
});
