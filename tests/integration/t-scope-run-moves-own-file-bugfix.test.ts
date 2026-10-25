// covers: scope:bugfix, hook:aidlc-plan-approval-guard
//
// The loop check of a whole run, with no model (tests/harness/own-file-moves.ts):
// bugfix, where the agent opens the Code Generation gate itself. At every point
// it hands the turn to the person, the agent changes one file the open stage
// produced and shows the step again or runs `next`; the person is asked again or
// the work moves on, and no refusal comes back after its step. Under off and
// relaxed the Code Generation gate looped here before the gate's own report was
// let through; strict went to the recovery review and has no such red: it stays
// for the same invariant.

import { ownFileMoveSuite } from "../harness/own-file-moves.ts";

ownFileMoveSuite(import.meta.path, { scope: "bugfix" }, ["off", "relaxed", "strict"]);
