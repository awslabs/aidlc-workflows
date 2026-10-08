// covers: scope:classic, audit:CEREMONY_SET
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: On strict work, the
// person types \`/aidlc --guard-policy off\` after Requirements Analysis; then the
// change. Guard Policy off never refuses or asks the person again; on, they are
// asked at most once and the way out works; no refusal comes back after its step.
// A case blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("the person switches the guards off on strict work", [
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "later-unit-edit", options: { personSwitchesOff: true }, label: "after the person switched Guard Policy off" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "hand-edit-source", options: { personSwitchesOff: true }, label: "after the person switched Guard Policy off" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "second-review", options: { personSwitchesOff: true }, label: "after the person switched Guard Policy off" },
]);
