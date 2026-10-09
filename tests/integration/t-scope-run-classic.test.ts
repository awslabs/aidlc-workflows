// covers: scope:classic, stage:initialization/workspace-scaffold, stage:initialization/workspace-detection, stage:initialization/state-init, stage:inception/practices-discovery, stage:inception/requirements-analysis, stage:inception/user-stories, stage:inception/refined-mockups, stage:inception/domain-design, stage:inception/units-generation, stage:inception/contract-design, stage:inception/delivery-planning, stage:construction/functional-design, stage:construction/nfr-requirements, stage:construction/nfr-design, stage:construction/infrastructure-design, stage:construction/code-generation, stage:construction/build-and-test
//
// The classic scope from the person's first request to done, with no model: a
// scripted stand-in plays the agent and the person through the real engine and
// hooks (tests/harness/scope-run.ts says what the run checks).

import { expect, test } from "bun:test";
import { runScope, SCOPE_RUN_TIMEOUT_MS, scopeRunSuite } from "../harness/scope-run.ts";

scopeRunSuite("classic");

// Every scope with Units asks "How should I continue building the remaining
// work?". Where a question is numbered prose that ends the turn (Kiro CLI,
// Copilot, opencode, Codex without request_user_input), the shared Stop hook
// blocks that turn end today: it has no wait carve-out for this question, which
// the protocol forbids logging. The scope runs exempt that one hand-off
// (KNOWN_STOP_BLOCKS in tests/harness/scope-run.ts); the fix removes it there
// and turns this on.
test.todo(
  "the turn ends at the autonomy question on numbered-prose harnesses (blocked by: Stop hook has no wait carve-out for the autonomy offer)",
  () => {
    const run = runScope("classic");
    const asked = run.agent.handoffs.filter((h) => h.what === "autonomy");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((h) => h.blocked)).toEqual([]);
  },
  SCOPE_RUN_TIMEOUT_MS,
);
