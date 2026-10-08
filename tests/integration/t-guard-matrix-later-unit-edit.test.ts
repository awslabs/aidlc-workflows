// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: Unit 2's work edits
// a file Unit 1 made and the person approved, and claims it in its manifest. Guard
// Policy off never refuses or asks the person again; on, they are asked at most
// once and the way out works; no refusal comes back after its step. A case blocked
// today is a test.todo named after its block.

import { expect, test } from "bun:test";
import { guardMatrixSuite, runCell } from "../harness/guard-matrix.ts";
import { SCOPE_RUN_TIMEOUT_MS } from "../harness/scope-run.ts";

guardMatrixSuite("a later Unit edits an approved Unit's file, with the guards off", [
  { cell: { policy: "off", review: "none", plan: "on" }, change: "later-unit-edit" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit" },
  { cell: { policy: "off", review: "adversarial", plan: "on" }, change: "later-unit-edit" },
  { cell: { policy: "off", review: "advisory", plan: "off" }, change: "later-unit-edit" },
]);

test.todo("plan approval off typed with the request holds without the person saying it again (blocked by: intent create refuses --plan-approval off typed with the request, and the setting then waits for a new reply)", () => {
  const run = runCell({ policy: "off", review: "advisory", plan: "off" }, "none");
  expect(run.run?.agent.detours ?? ["stuck"]).toEqual([]);
}, SCOPE_RUN_TIMEOUT_MS);
