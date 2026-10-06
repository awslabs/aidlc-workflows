// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: The person commits
// Unit 1's approved code, then reverts that commit before Build and Test. Guard
// Policy off never refuses or asks the person again; on, they are asked at most
// once and the way out works; no refusal comes back after its step. A case blocked
// today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("the person reverts an approved Unit's commit", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "revert" },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "revert" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "revert" },
]);
