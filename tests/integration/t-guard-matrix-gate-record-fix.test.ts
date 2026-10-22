// covers: scope:classic, hook:aidlc-plan-approval-guard
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: at the open Code
// Generation gate, after its review, the agent fixes its traceability record
// and runs the gate's own report again. The gate it opened itself is the stage
// built stage by stage (one Unit at a time, `next` shows that gate). Guard
// Policy off never refuses or asks the person again; relaxed asks at most once
// and the way out works; no refusal comes back after its step. Strict hands
// the engine's own recovery review here, which the zero-Unit run in
// t-scope-run-moves-gate-record-fix follows.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

const WAVES = { options: { stageMajor: true }, label: "built stage by stage" };

guardMatrixSuite("the agent fixes its reviewed record at the open Code Generation gate", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "gate-record-fix", ...WAVES },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "gate-record-fix", ...WAVES },
]);
