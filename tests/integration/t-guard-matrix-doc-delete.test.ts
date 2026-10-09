// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: While Unit 2 builds,
// Unit 1's functional design is deleted: it has to be made again, the one stop
// allowed. Guard Policy off never refuses or asks the person again; on, they are
// asked at most once and the way out works; no refusal comes back after its step.
// A case blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

guardMatrixSuite("Unit 1's functional design is deleted while Unit 2 builds", [
  { cell: { policy: "off", review: "none", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "off", review: "adversarial", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "relaxed", review: "none", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "relaxed", review: "adversarial", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "strict", review: "none", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "strict", review: "adversarial", plan: "on" }, change: "doc-delete" },
  { cell: { policy: "off", review: "none", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
  { cell: { policy: "off", review: "adversarial", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
  { cell: { policy: "relaxed", review: "none", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
  { cell: { policy: "relaxed", review: "adversarial", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
  { cell: { policy: "strict", review: "none", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
  { cell: { policy: "strict", review: "adversarial", plan: "on" }, change: "doc-delete", options: { stageMajor: true, thenUnits: true }, label: "design stage by stage, then one Unit at a time" },
]);
