// covers: scope:classic, audit:REVIEW_REQUESTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: The person asks for
// another review: at Unit 2's checkpoint before they approve, or of Unit 1 while
// Unit 2's code plan waits. Guard Policy off never refuses or asks the person
// again; on, they are asked at most once and the way out works; no refusal comes
// back after its step. A case blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

const BLOCK_5 = "the plan-approval guard holds the review the person asks for while a code plan waits";

guardMatrixSuite("the person asks for a second review after one cycle", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "second-review" },
  { cell: { policy: "off", review: "adversarial", plan: "on" }, change: "second-review" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "second-review" },
  { cell: { policy: "strict", review: "adversarial", plan: "on" }, change: "second-review" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "review-while-plan-waits", blocked: BLOCK_5 },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "review-while-plan-waits", blocked: BLOCK_5 },
]);
