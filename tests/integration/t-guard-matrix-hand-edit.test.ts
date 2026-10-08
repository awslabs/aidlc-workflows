// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: The person edits an
// approved file by hand: Unit 1's source after its checkpoint, or the requirements
// after their gate. Guard Policy off never refuses or asks the person again; on,
// they are asked at most once and the way out works; no refusal comes back after
// its step. A case blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("the person hand-edits an approved file", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "hand-edit-source" },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "hand-edit-source" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "hand-edit-source" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "hand-edit-requirements" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "hand-edit-requirements" },
]);
