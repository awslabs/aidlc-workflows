// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: A team's own plugin
// whose scope names no Guard Policy: each case checks what the person meets under
// the Guard Policy the engine resolves for it. Guard Policy off never refuses or
// asks the person again; on, they are asked at most once and the way out works; no
// refusal comes back after its step. A case blocked today is a test.todo named
// after its block.

import { expect, test } from "bun:test";
import { guardMatrixSuite, pluginCell, resolvedPolicy, runCell } from "../harness/guard-matrix.ts";
import { SCOPE_RUN_TIMEOUT_MS } from "../harness/scope-run.ts";

guardMatrixSuite("a plugin's scope that names no Guard Policy", [
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "hand-edit-source", options: { composed: pluginCell("team-flow", null, "advisory") }, label: "on a plugin's scope that names no Guard Policy" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "later-unit-edit-unclaimed", options: { composed: pluginCell("team-flow", null, "advisory") }, label: "on a plugin's scope that names no Guard Policy" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "second-review", options: { composed: pluginCell("team-flow", null, "advisory") }, label: "on a plugin's scope that names no Guard Policy" },
]);

test("a plugin scope with no guard_policy key runs with Guard Policy off", () => {
  const run = runCell({ policy: "off", review: "advisory", plan: "on" }, "none", { composed: pluginCell("team-flow", null, "advisory") });
  expect(resolvedPolicy(run)).toBe("off");
}, SCOPE_RUN_TIMEOUT_MS);
