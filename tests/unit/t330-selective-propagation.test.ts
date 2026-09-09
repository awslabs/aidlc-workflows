// PoC + reviewer-round-2 evidence for the typed-dependency-edges RFC
// (`docs/rfcs/typed-dependency-edges.md`, GitHub issue awslabs/aidlc-workflows#1001).
//
// covers: core/tools/aidlc-validity.ts
// covers: function:computeProducerOutputChanges function:propagateStageInvalidation
//
// This suite is the deterministic A/B evidence for the RFC. It bypasses the
// filesystem entirely and drives propagateStageInvalidation with hand-
// constructed StageValidationBasis pairs so the differential is isolated
// from any resolver or audit code.
//
// The `console.log` blocks are intentional PoC evidence output — they let a
// reviewer inspect the differential without re-running the algorithm by
// hand. They stay on the RFC branch and will be removed before the merge
// candidate is ready-for-review.
//
// Fixture (mirrors the story-deck example):
//
//     A (design)
//       |──> B (code-generation,  recheck_if: edited)                  — bytes matter
//       |──> C (documentation,    recheck_if: files-added-or-removed)  — file set matters
//       |──> D (traceability, undeclared)                              — pessimistic default
//       └──> E (auditor,          recheck_if: changed)                 — explicit pessimistic
//
// Payloads applied to A's produced artifact "X":
//
//   P1 edited-only               contentHash flips, structureHash unchanged
//                                (a typo fix in an appendix section)
//   P2 files-added-or-removed    structureHash flips, contentHash unchanged
//                                (a new unit instance added with empty content)
//   P3 both                      both hashes flip
//                                (a real semantic edit that reshapes and rewrites)
//   P4 byte-identical re-run     neither hash flips
//                                (producer re-executes deterministically)
//
// Baseline (no producerOutputChanges argument) is the pre-RFC behavior:
// every direct edge propagates whenever the producer is stale. Candidate
// (with producerOutputChanges) applies the typed-edge filter.

import { describe, expect, test } from "bun:test";
import {
  computeProducerOutputChanges,
  propagateStageInvalidation,
  type ArtifactBasis,
  type StageValidationBasis,
  type StageValidityIssue,
  type StageValidityNode,
} from "../../core/tools/aidlc-validity.ts";
import type { RecheckIf } from "../../core/tools/aidlc-graph.ts";

const stages: StageValidityNode[] = [
  { slug: "A", phase: "inception", produces: ["X"], consumes: [] },
  {
    slug: "B",
    phase: "construction",
    produces: ["code"],
    consumes: [{ artifact: "X", required: true, recheck_if: "edited" }],
  },
  {
    slug: "C",
    phase: "construction",
    produces: ["docs"],
    consumes: [
      { artifact: "X", required: true, recheck_if: "files-added-or-removed" },
    ],
  },
  {
    slug: "D",
    phase: "operation",
    produces: ["trace"],
    consumes: [{ artifact: "X", required: true }], // undeclared
  },
  {
    slug: "E",
    phase: "operation",
    produces: ["audit"],
    consumes: [{ artifact: "X", required: true, recheck_if: "changed" }],
  },
];

const completedSlugs = new Set(["A", "B", "C", "D", "E"]);

function ab(
  artifact: string,
  producer: string,
  structureHash: string,
  contentHash: string,
  recheck_if?: RecheckIf,
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
  if (recheck_if) basis.recheck_if = recheck_if;
  return basis;
}

function receiptsAt(sX: string, cX: string): Map<string, StageValidationBasis> {
  const producedX = ab("X", "A", sX, cX);
  const consumedX = (r?: RecheckIf): ArtifactBasis => ab("X", "A", sX, cX, r);
  return new Map<string, StageValidationBasis>([
    ["A", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [], outputs: [producedX],
    }],
    ["B", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [consumedX("edited")],
      outputs: [ab("code", "B", "s-code", "c-code")],
    }],
    ["C", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [consumedX("files-added-or-removed")],
      outputs: [ab("docs", "C", "s-docs", "c-docs")],
    }],
    ["D", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [consumedX()], // undeclared
      outputs: [ab("trace", "D", "s-trc", "c-trc")],
    }],
    ["E", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [consumedX("changed")], // explicit pessimistic
      outputs: [ab("audit", "E", "s-aud", "c-aud")],
    }],
  ]);
}

function currentBasesAfter(
  sX: string,
  cX: string,
): Map<string, StageValidationBasis> {
  const producedX = ab("X", "A", sX, cX);
  return new Map<string, StageValidationBasis>([
    ["A", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [], outputs: [producedX],
    }],
    ["B", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [ab("X", "A", sX, cX, "edited")],
      outputs: [ab("code", "B", "s-code", "c-code")],
    }],
    ["C", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [ab("X", "A", sX, cX, "files-added-or-removed")],
      outputs: [ab("docs", "C", "s-docs", "c-docs")],
    }],
    ["D", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [ab("X", "A", sX, cX)],
      outputs: [ab("trace", "D", "s-trc", "c-trc")],
    }],
    ["E", {
      schema: 3, graphContract: "g", projectType: null,
      inputs: [ab("X", "A", sX, cX, "changed")],
      outputs: [ab("audit", "E", "s-aud", "c-aud")],
    }],
  ]);
}

interface Scenario {
  label: string;
  receiptSX: string;
  receiptCX: string;
  currentSX: string;
  currentCX: string;
  producerDirectlyStale: boolean;
}

const scenarios: Scenario[] = [
  {
    label: "P1 edited-only (typo in appendix)",
    receiptSX: "s0", receiptCX: "c0",
    currentSX: "s0", currentCX: "c1",
    producerDirectlyStale: true,
  },
  {
    label: "P2 files-added-or-removed (new unit added, empty payload)",
    receiptSX: "s0", receiptCX: "c0",
    currentSX: "s1", currentCX: "c0",
    producerDirectlyStale: true,
  },
  {
    label: "P3 both (semantic reshape + rewrite)",
    receiptSX: "s0", receiptCX: "c0",
    currentSX: "s1", currentCX: "c1",
    producerDirectlyStale: true,
  },
  {
    label: "P4 byte-identical re-run (producer executed again, same outputs)",
    receiptSX: "s0", receiptCX: "c0",
    currentSX: "s0", currentCX: "c0",
    producerDirectlyStale: false,
  },
];

function directReasonsFor(scenario: Scenario): Map<string, string[]> {
  // Emulate what inspectStageValidity would set: A is directly stale iff
  // some hash on its own basis moved. Otherwise nothing enters directReasons.
  return scenario.producerDirectlyStale
    ? new Map([["A", ["output:X"]]])
    : new Map();
}

function slugsOf(issues: readonly StageValidityIssue[]): string[] {
  return issues
    .filter((issue) => issue.stage !== "A") // isolate propagation effect
    .map((issue) => `${issue.stage}(${issue.direct ? "direct" : issue.status})`)
    .sort();
}

describe("typed-dependency-edges PoC · A/B evidence", () => {
  for (const scenario of scenarios) {
    describe(scenario.label, () => {
      const receipts = receiptsAt(scenario.receiptSX, scenario.receiptCX);
      const current = currentBasesAfter(scenario.currentSX, scenario.currentCX);
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

      test("baseline reproduces pre-RFC behavior", () => {
        if (!scenario.producerDirectlyStale) {
          expect(slugsOf(baseline)).toEqual([]);
          return;
        }
        // Baseline pessimistic: any change to A cascades to every consumer.
        expect(slugsOf(baseline)).toEqual([
          "B(needs-revalidation)",
          "C(needs-revalidation)",
          "D(needs-revalidation)",
          "E(needs-revalidation)",
        ]);
      });

      test("candidate applies typed-edge filter", () => {
        const actual = slugsOf(candidate);
        const evidence = {
          scenario: scenario.label,
          producerChangeClass: {
            filesAddedOrRemoved: changes.get("A")?.get("X")?.filesAddedOrRemoved,
            edited: changes.get("A")?.get("X")?.edited,
          },
          baseline: slugsOf(baseline),
          candidate: actual,
        };
        console.log("[PoC evidence]", JSON.stringify(evidence, null, 2));

        if (scenario.label.startsWith("P1")) {
          // edited-only: `edited` consumers fire (B), `files-added-or-removed`
          // skips (C), undeclared/explicit-pessimistic fire (D, E).
          expect(actual).toEqual([
            "B(needs-revalidation)",
            "D(needs-revalidation)",
            "E(needs-revalidation)",
          ]);
        } else if (scenario.label.startsWith("P2")) {
          // files-only: `files-added-or-removed` fires (C), `edited` skips (B),
          // undeclared/explicit-pessimistic fire (D, E).
          expect(actual).toEqual([
            "C(needs-revalidation)",
            "D(needs-revalidation)",
            "E(needs-revalidation)",
          ]);
        } else if (scenario.label.startsWith("P3")) {
          // both classes moved: every consumer fires.
          expect(actual).toEqual([
            "B(needs-revalidation)",
            "C(needs-revalidation)",
            "D(needs-revalidation)",
            "E(needs-revalidation)",
          ]);
        } else {
          // P4 byte-identical re-run: producer is not directly stale, so
          // nothing propagates. This is the RFC's "byte-identical re-run
          // never flags consumers" emergent property.
          expect(actual).toEqual([]);
        }
      });
    });
  }

  test("undeclared recheck_if preserves pre-RFC pessimistic behavior", () => {
    // If NO consumer declares recheck_if, the algorithm must reduce to
    // pre-RFC propagation even when producerOutputChanges is supplied.
    // This guards the backward-compat contract required by decision 1
    // (default = pessimistic).
    const noDeclarationStages: StageValidityNode[] = stages.map((stage) => {
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
          const { recheck_if: _drop, ...rest } = input;
          return rest;
        }),
      });
    }
    const current = currentBasesAfter("s0", "c1");
    const direct = new Map([["A", ["output:X"]]]);
    const changes = computeProducerOutputChanges(receipts, current);

    const candidate = propagateStageInvalidation(
      noDeclarationStages,
      completedSlugs,
      direct,
      receipts,
      changes,
    );
    expect(slugsOf(candidate)).toEqual([
      "B(needs-revalidation)",
      "C(needs-revalidation)",
      "D(needs-revalidation)",
      "E(needs-revalidation)",
    ]);
  });

  test("explicit recheck_if: changed matches pessimistic default", () => {
    // Consumer E declares `changed` explicitly. It must behave identically
    // to consumer D (undeclared) across all payloads. Confirmed already by
    // the parametric tests above, but this test pins the equivalence in
    // one place to catch future divergence.
    for (const scenario of scenarios) {
      const receipts = receiptsAt(scenario.receiptSX, scenario.receiptCX);
      const current = currentBasesAfter(scenario.currentSX, scenario.currentCX);
      const direct = directReasonsFor(scenario);
      const changes = computeProducerOutputChanges(receipts, current);
      const candidate = propagateStageInvalidation(
        stages,
        completedSlugs,
        direct,
        receipts,
        changes,
      );
      const dFired = candidate.some((i) => i.stage === "D");
      const eFired = candidate.some((i) => i.stage === "E");
      expect(eFired).toBe(dFired);
    }
  });
});
