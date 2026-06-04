---
name: stage-execution
description: |
  AI-DLC stage execution. Defines how to drive each stage through its cycle — state transitions, persona invocation format, and rules. Read by the orchestrator when executing stages.
---

# Stage Execution

Drive each stage in the composed workflow through its cycle.

## Sequencing

For each stage in `workflow.json`:

1. Read **only** the current stage's `definition.md` (do NOT read all stage definitions upfront)
2. Verify inputs exist (outputs from prior stages)
3. Drive the stage execution cycle (below)
4. After stage completes, update `state/state.json` outputs array with each output as `{"name": "<filename>", "locationRelativeToIntentRoot": "<path>/"}`
5. Advance to the next stage

## Checkpoint

After each stage completes, update the checkpoint. This enables:

- **Re-entry** — loop back to a prior stage on rejection without losing progress
- **Resume** — resume from the last completed stage if interrupted
- **Visibility** — human can see what's done, in progress, and ahead

## State Transitions — Who Sets What

```
orchestrator    → plan-and-clarify         (invokes owner)
owner           → clarification-asked      (wrote questions.md + plan.md)
orchestrator    → clarification-provided   (wrote human's answers to questions.md, then invokes owner)
owner           → further-clarification    (needs more answers)
orchestrator    → clarification-provided   (wrote human's follow-up answers to questions.md, then invokes owner)
owner           → artifact-generated       (produced output artifacts)
orchestrator    → review-needed            (invokes contributors)
orchestrator    → reviewed                 (all contributors have returned their reviews)
owner           → refined                  (addressed contributor feedback)
orchestrator    → final-review-needed      (invokes reviewer)
orchestrator    → final-review-complete    (reviewer has returned their review)
owner           → finalised                (addressed reviewer feedback)

--- REVIEW LOOP DECISION (orchestrator) ---
IF reviewer verdict is "ready"        → presented (show to human)
IF reviewer verdict is "not-ready"
  AND reviewIterations < maxReviewIterations
                                      → final-review-needed (increment reviewIterations, send back to owner then reviewer)
IF reviewer verdict is "not-ready"
  AND reviewIterations >= maxReviewIterations
                                      → presented (reviewer bypassed, human becomes quality gate)

orchestrator    → presented                (showed artifact to human)
orchestrator    → changes-requested        (human wants changes)
owner           → finalised                (addressed human feedback)
orchestrator    → presented                (re-showed to human)
orchestrator    → complete                 (human approved)
```

## Review Loop

When a reviewer is assigned, the cycle between owner and reviewer repeats until either:
1. The reviewer returns verdict "ready" — artifact proceeds to human
2. The iteration cap (`maxReviewIterations` in workflow.json, default 3) is reached — reviewer is bypassed, artifact goes to human with unresolved findings noted

After the cap is reached, the reviewer is out of the loop for that stage. The human and owner iterate directly (`presented → changes-requested → finalised → presented`) until the human approves.

The `reviewIterations` counter in state.json tracks how many times the reviewer has returned "not-ready" for this stage. It is incremented each time the reviewer returns a "not-ready" verdict and the owner is sent back to address findings.

## Rules

- Each actor only sets state for what THEY did — never for what someone else will do
- When re-invoking a persona, pass all relevant files from the stage directory as context
- If no contributors are assigned, skip review — go from `artifact-generated` to `final-review-needed` (if reviewer assigned) or `presented` (if no reviewer)
- If no contributor comments exist, skip refine — go from `reviewed` to `final-review-needed` (if reviewer assigned) or `presented` (if no reviewer)
- The final reviewer step is NEVER skipped when a reviewer is assigned — unless `reviewIterations` has reached `maxReviewIterations`
- After the reviewer returns a verdict, the orchestrator decides next step based on verdict + iteration count (see Review Loop above)
- Once the iteration cap is reached, the reviewer does not participate again for that stage — human and owner work together directly

## How to Invoke a Persona

Use this exact format — nothing more:

```
stage: <stage-name>
status: <current-status>
directory: <full-path-to-stage-directory>
```

The persona knows who it is. The work-method skill tells it what to do based on the status. The files in the directory provide all context. Do not add instructions, summaries, guidelines, or file contents to the invocation.

## Process Verification

The process checker (`tools/process-checker.js`) runs after sub-agent invocations. It checks only:

- If outputs are declared in state, do the files exist on disk?
- If reviews are declared and stage is past review, did all reviewers review?

It does not track state transitions. It does not check content quality.
