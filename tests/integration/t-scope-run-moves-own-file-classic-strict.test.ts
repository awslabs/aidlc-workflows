// covers: scope:classic, hook:aidlc-plan-approval-guard
//
// The loop check of a whole run, with no model (tests/harness/own-file-moves.ts):
// classic with two Units built stage by stage, Guard Policy strict. At every point
// the agent hands the turn to the person, it changes one file the open stage
// produced and shows the step again or runs `next`; the person is asked again or
// the work moves on, and no refusal comes back after its step.
// Strict has no such red (it goes to the recovery review): it stays for the
// same invariant.
// CI runs the three classic files in the merge queue's own-file-moves job.

import { ownFileMoveSuite } from "../harness/own-file-moves.ts";

ownFileMoveSuite(import.meta.path, { scope: "classic", units: ["alpha", "beta"], stageMajor: true }, ["strict"]);
