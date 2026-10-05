// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: While Unit 2 builds,
// Unit 1's approved functional design is edited, by Unit 2's agent or by the
// person. Guard Policy off never refuses or asks the person again; on, they are
// asked at most once and the way out works; no refusal comes back after its step.
// A case blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

const BLOCK_7 = "a hand edit's change row names no changed path";

guardMatrixSuite("Unit 1's functional design is edited while Unit 2 builds", [
  { cell: { policy: "off", review: "none", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "off", review: "adversarial", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "relaxed", review: "none", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "relaxed", review: "adversarial", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "strict", review: "none", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "strict", review: "adversarial", plan: "on" }, change: "doc-edit-agent" },
  { cell: { policy: "off", review: "none", plan: "on" }, change: "doc-edit-hand" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "doc-edit-hand", recordBlocked: BLOCK_7 },
  { cell: { policy: "off", review: "adversarial", plan: "on" }, change: "doc-edit-hand", recordBlocked: BLOCK_7 },
  { cell: { policy: "relaxed", review: "none", plan: "on" }, change: "doc-edit-hand" },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "doc-edit-hand", recordBlocked: BLOCK_7 },
  { cell: { policy: "relaxed", review: "adversarial", plan: "on" }, change: "doc-edit-hand", recordBlocked: BLOCK_7 },
  { cell: { policy: "strict", review: "none", plan: "on" }, change: "doc-edit-hand" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "doc-edit-hand" },
  { cell: { policy: "strict", review: "adversarial", plan: "on" }, change: "doc-edit-hand" },
]);
