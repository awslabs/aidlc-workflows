// Pins the adversarial review contract (reviewer-as-verifier, 2.4.0) in the
// three authored surfaces that carry it:
//   - core/aidlc-common/protocols/stage-protocol.md §12a step 2 (the shared
//     contract - written once so any future reviewer inherits it)
//   - core/agents/aidlc-product-lead-agent.md (domain-voiced restatement)
//   - core/agents/aidlc-architecture-reviewer-agent.md (domain-voiced restatement)
// plus the shipped dist/claude projection of the protocol (the other dist
// trees are byte-parity-guarded by `package.ts --check`, so one projection
// pin suffices).
//
// Mechanism = none: pure text invariants over files already on disk, exactly
// like t68's metadata greps. A refactor that rewords the contract should
// update these pins deliberately, not silently drop the posture.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const CORE_PROTOCOL = join(
  REPO_ROOT,
  "core",
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
);
const DIST_PROTOCOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
);
const PRODUCT_LEAD = join(
  REPO_ROOT,
  "core",
  "agents",
  "aidlc-product-lead-agent.md",
);
const ARCH_REVIEWER = join(
  REPO_ROOT,
  "core",
  "agents",
  "aidlc-architecture-reviewer-agent.md",
);

describe("t234 adversarial review contract pins (reviewer-as-verifier)", () => {
  test("stage-protocol §12a step 2 carries the shared adversarial contract", () => {
    const src = readFileSync(CORE_PROTOCOL, "utf-8");
    // Posture: refute, not confirm; READY is failed-to-refute, not default.
    expect(src).toContain("adversarial review contract");
    expect(src).toContain("refute the artifact, not to confirm it");
    expect(src).toContain(
      "READY is the verdict it fails to reach after trying to break the artifact",
    );
    // Evidence: machine-checkable grounding; opinion is not NOT-READY grounds.
    expect(src).toContain("machine-checkable evidence");
    expect(src).toContain(
      "A finding backed only by opinion is a suggestion, not grounds for NOT-READY",
    );
  });

  test("shipped dist/claude protocol carries the same contract", () => {
    const src = readFileSync(DIST_PROTOCOL, "utf-8");
    expect(src).toContain("adversarial review contract");
    expect(src).toContain("machine-checkable evidence");
  });

  test("the revision path re-runs the reviewer on changed artifacts (Part 0 + §12a)", () => {
    // A rejection-driven revision edits produces[] AFTER the reviewer's
    // verdict landed; without this binding the gate reopens on a stale READY.
    // The learnings ritual, by contrast, runs once per stage - pin both so
    // neither drifts.
    for (const path of [CORE_PROTOCOL, DIST_PROTOCOL]) {
      const src = readFileSync(path, "utf-8");
      expect(src).toContain(
        "re-run the §12a reviewer step before reporting revised",
      );
      expect(src).toContain(
        "fresh `## Review` verdict replacing the stale one",
      );
      expect(src).toContain(
        "The §13 learnings ritual runs once per stage and is not re-run",
      );
      // Part 0 orders the gate open AFTER the logged learnings answer - the
      // QUESTION_ANSWERED-before-STAGE_AWAITING_APPROVAL audit proof.
      expect(src).toContain(
        "After the learnings answer is logged: `bun",
      );
      expect(src).not.toContain(
        "Before showing the completion message",
      );
    }
    const skill = readFileSync(
      join(REPO_ROOT, "harness", "claude", "skills", "aidlc", "SKILL.md"),
      "utf-8",
    );
    expect(skill).toContain("re-running the §12a reviewer step");
  });

  test("product-lead persona restates the contract in domain voice", () => {
    const src = readFileSync(PRODUCT_LEAD, "utf-8");
    expect(src).toContain("## Adversarial Posture");
    expect(src).toContain("REFUTE this artifact, not to confirm it");
    expect(src).toContain("not grounds for NOT-READY");
    // The 2.2.17 identity-marker contract stays intact alongside the new section.
    expect(src).toContain("**Reviewer:** aidlc-product-lead-agent");
  });

  test("architecture-reviewer persona restates the contract in domain voice", () => {
    const src = readFileSync(ARCH_REVIEWER, "utf-8");
    expect(src).toContain("## Adversarial Posture");
    expect(src).toContain("REFUTE this design, not to confirm it");
    expect(src).toContain("not grounds for NOT-READY");
    expect(src).toContain("**Reviewer:** aidlc-architecture-reviewer-agent");
  });
});
