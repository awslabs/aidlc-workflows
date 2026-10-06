// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: A scope composed for
// the person, written the way the composer writes one, with \`guard_policy: off\`
// in its frontmatter. Guard Policy off never refuses or asks the person again; on,
// they are asked at most once and the way out works; no refusal comes back after
// its step. A case blocked today is a test.todo named after its block.

import { composedCell, guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("a composed scope with the guards off", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit", options: { composed: composedCell("guard-cell", "off", "advisory") }, label: "on a composed scope" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "hand-edit-source", options: { composed: composedCell("guard-cell", "off", "advisory") }, label: "on a composed scope" },
]);
