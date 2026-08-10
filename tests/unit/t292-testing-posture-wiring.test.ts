// covers: file:aidlc-common/stages/construction/code-generation.md, file:agents/aidlc-developer-agent.md, file:memory/org.md
//
// t292 - TESTING-POSTURE WIRING. Mechanism: none (readFileSync over authored
// prose, zero spawn, zero LLM, zero tokens). Technique: deterministic string
// predicates over the three authored surfaces that connect the affirmed
// `## Testing Posture` to the code-generation plan's step ordering.
//
// WHY THIS EXISTS: practices-discovery interviews the team on testing
// methodology and promotes the answer to memory/team.md `## Testing Posture`,
// but for a long time nothing in the Construction code-generation path was
// scoped to READ that section - a team that affirmed TDD still got an
// implementation-first plan, silently. The wiring is prose in three places,
// and prose drifts: any one of these regressions would reopen the gap without
// failing another test.
//
//   1. The stage file's Step 2 (Part 1, authored by the conductor - the
//      plan-approval guard makes the developer-agent undispatchable before a
//      plan exists) must resolve `## Testing Posture` and carry BOTH plan
//      shapes: the test-after structure and the test-first red-green-refactor
//      layer split.
//   2. The Step 4 delegation prompt must forward the posture to the Part 2
//      generation subagent.
//   3. The developer-agent's Knowledge Loading consult must name
//      `## Testing Posture` alongside `## Code Style` (it was the only
//      plan-authoring persona pointed at the styling section but not the
//      testing one).
//   4. memory/org.md must not resurrect the dangling "captured by the
//      testing-strategy stage when it ships" forward-reference - no such
//      stage exists; practices-discovery owns the capture.
//
// The gate reads the AUTHORED surfaces; dist is their byte-parity-guarded copy
// (t145 / package.ts --check), so gating the authored source covers every tree.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const STAGE_REL = "core/aidlc-common/stages/construction/code-generation.md";
const AGENT_REL = "core/agents/aidlc-developer-agent.md";
const ORG_REL = "core/memory/org.md";

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

// =========================================================================
// 1 - Part 1 planning resolves the posture and carries both plan shapes.
// =========================================================================
describe("t292 (1) code-generation Step 2 consumes the affirmed posture", () => {
  const stage = read(STAGE_REL);

  test("Step 2 resolves ## Testing Posture from the memory layers", () => {
    expect(stage).toContain("Test ordering follows the affirmed testing posture.");
    expect(stage).toContain("`## Testing Posture`");
    // The resolution rule is the delivery-planning idiom: most-specific
    // non-empty statement across the three memory layers, org fallback when
    // practices-discovery was skipped.
    expect(stage).toContain(
      "aidlc/spaces/<active-space>/memory/{project,team,org}.md",
    );
    expect(stage).toContain("most-specific non-empty statement");
    expect(stage).toContain("practices-discovery was skipped");
  });

  test("posture governs ordering while the test strategy keeps volume", () => {
    // The protocol's volume axis must survive next to the new ordering axis;
    // losing either sentence collapses the two concerns back into one.
    expect(stage).toContain("the test strategy above governs volume");
    expect(stage).toContain('stage-protocol.md §8 "Test Strategy"');
  });

  test("both plan shapes are present: test-after steps and the red-green-refactor split", () => {
    // Test-after (default) shape: the trailing per-layer test steps.
    expect(stage).toContain("Step 4: Business logic tests (unit tests for Step 3)");
    expect(stage).toContain("Step 6: API tests (unit + integration tests for Step 5)");
    // Test-first shape: the within-layer split, in dependency order.
    expect(stage).toContain("With a test-first posture (TDD, BDD, ATDD)");
    for (const step of ["3a", "3b", "3c", "5a", "5b", "5c"]) {
      expect(stage).toContain(`Step ${step}:`);
    }
    expect(stage).toMatch(/Red \(write the layer's failing tests\)/);
    expect(stage).toMatch(/Green \(implement until they pass\)/);
    expect(stage).toMatch(/Refactor \(clean up; tests stay green\)/);
  });

  test("the split never crosses layers, preserving dependency ordering", () => {
    expect(stage).toContain("The split happens within a layer, never across layers.");
    // The pre-existing rationale sentence the split must not displace.
    expect(stage).toContain(
      "dependencies are built before dependents (data models before business logic, business logic before API)",
    );
  });
});

// =========================================================================
// 2 - Part 2's delegation prompt forwards the posture to the subagent.
// =========================================================================
describe("t292 (2) the generation dispatch carries the posture", () => {
  const stage = read(STAGE_REL);

  test("Step 4 delegation prompt includes the resolved posture and Red-first instruction", () => {
    expect(stage).toContain("The affirmed testing posture (resolved in Step 2)");
    expect(stage).toContain(
      "write each layer's Red-step tests before that layer's implementation",
    );
  });

  test("failing-output capture is best-effort, bounded by workspace readiness", () => {
    // Code-generation never installs dependencies or runs suites itself
    // (build-and-test Step 10 owns the first run), so the evidence capture
    // must stay conditional: an unconditional "run the tests" here would
    // fail every greenfield unit.
    expect(stage).toContain("where the workspace can already run the test suite");
    expect(stage).toContain("record the failing run's output");
  });
});

// =========================================================================
// 3 - The developer-agent persona consults the testing section.
// =========================================================================
describe("t292 (3) developer-agent Knowledge Loading names ## Testing Posture", () => {
  const agent = read(AGENT_REL);

  test("the memory consult names both Code Style and Testing Posture", () => {
    const consult = agent
      .split("\n")
      .find((l) => l.includes("Consult `## Code Style`"));
    expect(consult).toBeDefined();
    expect(consult).toContain("`## Testing Posture`");
    // The affirmed-practice-over-scan rule must survive the extension.
    expect(consult).toContain(
      "follow affirmed practice over conventions inferred from a code scan",
    );
  });
});

// =========================================================================
// 4 - org.md points at the real capture stage, not a phantom one.
// =========================================================================
describe("t292 (4) org.md Testing Posture names its capture and consumer", () => {
  const org = read(ORG_REL);

  test("the dangling testing-strategy-stage forward-reference is gone", () => {
    // No stage by that name exists in core/aidlc-common/stages/; the sentence
    // made the shipped default read as a placeholder awaiting a stage that
    // never shipped.
    expect(org).not.toContain("testing-strategy stage");
  });

  test("capture is attributed to practices-discovery and consumption to Code Generation", () => {
    expect(org).toContain("affirmed at\npractices-discovery");
    expect(org).toMatch(/Code\nGeneration orders each layer's implementation and test steps to match/);
  });
});
