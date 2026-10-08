// covers: scope:classic, audit:WORKFLOW_PARKED, audit:WORKFLOW_UNPARKED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: The person stops
// between Units, the engine is updated (a new version and changed stage text), and
// they resume in a new chat. Guard Policy off never refuses or asks the person
// again; on, they are asked at most once and the way out works; no refusal comes
// back after its step. A case blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("resume after the engine version changes", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "engine-update" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "engine-update" },
]);
