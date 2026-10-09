// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: Classic as it ships
// (Guard Policy off, review advisory), every stage, two Units: the case people
// reported, a later Unit editing an approved Unit's file. Guard Policy off never
// refuses or asks the person again; on, they are asked at most once and the way
// out works; no refusal comes back after its step. A case blocked today is a
// test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("classic as it ships, two Units", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit", options: { shipped: true }, label: "classic as it ships" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit-unclaimed", options: { shipped: true }, label: "classic as it ships" },
]);
