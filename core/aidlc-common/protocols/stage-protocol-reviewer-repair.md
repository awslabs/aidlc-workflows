# Reviewer Repair Protocol Module

Load this module when the engine lists `reviewer-repair` in `directive.protocol_modules`: an `adversarial` review, Guard Policy `strict`, a Unit checkpoint's re-check, and every `invoke-swarm`. It adds to the reviewer module's §12a, at the step each part names.

**Step 3, a write that voided the terminal receipt, under `strict`.** Under `strict`, the first request after that stale terminal evidence is exactly one recovery review at the next ordinal, even when an adversarial stage had unused normal iterations. The logger marks it `Recovery: stale-receipt`; the reviewed-output freeze stays on throughout (the reviewer writes its review beside the artifact, never inside it). Record either verdict as terminal, then stop editing reviewed outputs, `source-manifest.json`, and claimed source paths. Any human gate after that recovery verdict uses the required Review brief of the reviewer module. If that recovery receipt is invalidated again, request no further review. On an interactive stage, present the recovery-spent refusal to the human; only Request Changes (`GATE_REJECTED`) resets the attempt.

**Step 3, branching on the verdict.**

**On an `adversarial` review**, branch on the verdict:
- **READY** → the receipt is terminal (the reviewer module); run the §13 learnings ritual only when `directive.protocol_modules` lists `learnings`, then present the approval gate using the reviewer module's required Review brief
- **NOT-READY** and `reviewIterations < reviewer_max_iterations` (default 2):
  - Increment review iteration counter
  - Re-invoke the stage's lead agent ALONE, dispatched per `directive.mode` (inline in your context, or as a subagent on the dispatched modes). On an ensemble stage (pipeline/mob) the room or chain is NOT re-convened - review findings are artifact defects and the lead owns the artifacts; the repair loop is lead-reviewer ping-pong (`stage-protocol-ensemble.md` §5). The builder addresses the findings and updates the artifact.
  - Return to step 1 (re-invoke reviewer)
- **NOT-READY** and iterations exhausted:
  - Proceed to the approval gate using the reviewer module's required Review brief, with the unresolved findings table. The separate SAY sentence for exhausted rounds remains the only narration before that gate.
