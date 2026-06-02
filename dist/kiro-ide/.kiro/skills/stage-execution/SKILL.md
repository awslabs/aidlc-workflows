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
orchestrator    → presented                (showed artifact to human)
orchestrator    → changes-requested        (human wants changes)
owner           → finalised                (addressed human feedback)
orchestrator    → presented                (re-showed to human)
orchestrator    → complete                 (human approved)
```

## Rules

- Each actor only sets state for what THEY did — never for what someone else will do
- When re-invoking a persona, pass all relevant files from the stage directory as context
- If no contributors are assigned, skip review — go from `artifact-generated` to `final-review-needed` (if reviewer assigned) or `presented` (if no reviewer)
- If no contributor comments exist, skip refine — go from `reviewed` to `final-review-needed` (if reviewer assigned) or `presented` (if no reviewer)
- The final reviewer step is NEVER skipped when a reviewer is assigned in the workflow
- Mandatory post-review sequence when reviewer is assigned: `refined` → `final-review-needed` → `final-review-complete` → `finalised` → `presented`

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
