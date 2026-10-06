// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: Two Units built and
// approved with nothing changed by anyone: the baseline every change is measured
// against. Guard Policy off never refuses or asks the person again; on, they are
// asked at most once and the way out works; no refusal comes back after its step.
// A case blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("nothing changes", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "none" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "none" },
]);
