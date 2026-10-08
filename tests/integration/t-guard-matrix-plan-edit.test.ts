// covers: scope:classic, audit:PLAN_APPROVAL_RECORDED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: The person edits the
// code plan while its approval waits, then approves it. Guard Policy off never
// refuses or asks the person again; on, they are asked at most once and the way
// out works; no refusal comes back after its step. A case blocked today is a
// test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("the person edits the plan while its approval waits", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "plan-edit" },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "plan-edit" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "plan-edit" },
]);
