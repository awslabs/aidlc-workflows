---
name: aidlc-stage-execution
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

## State Transitions

Each row is one transition. The "Blocks on Human?" column determines whether the orchestrator must yield and wait for a human response before proceeding.

| # | From State | To State | State Setter | Activity | Blocks on Human? |
|---|---|---|---|---|---|
| 1 | pending | plan-and-clarify | Orchestrator | Invoke owner persona | NO |
| 2 | plan-and-clarify | clarification-asked | Owner | Wrote plan.md (and questions.md if questions exist) | NO |
| 3 | clarification-asked | clarification-provided | Orchestrator | Present plan and questions to human, write answers | **If supervised** |
| 4 | clarification-provided | further-clarification | Owner | Needs more answers (optional, may skip to #6) | NO |
| 5 | further-clarification | clarification-provided | Orchestrator | Present follow-up questions to human, write answers | **If supervised** |
| 6 | clarification-provided | artifact-generated | Owner | Produced output artifacts | NO |
| 7 | artifact-generated | contribution-needed | Orchestrator | Invoke contributors (skip to #10 if no contributors) | NO |
| 8 | contribution-needed | contributed | Contributors | All contributors wrote their contribution files | NO |
| 9 | contributed | refined | Owner | Addressed contributor feedback, updated artifacts | NO |
| 10 | refined | final-review-needed | Orchestrator | Invoke reviewer (skip to #13 if no reviewer) | NO |
| 11 | final-review-needed | final-review-complete | Reviewer | Returned verdict (READY or NOT-READY) | NO |
| 12a | final-review-complete (NOT-READY, iterations < max) | final-review-needed | Orchestrator | Increment reviewIterations, send back to owner then reviewer | NO |
| 12b | final-review-complete (READY) | presented | Orchestrator | Present artifact summary to human | NO |
| 12c | final-review-complete (NOT-READY, iterations >= max) | presented | Orchestrator | Bypass reviewer, present to human with unresolved findings noted | NO |
| 13 | presented | complete | Orchestrator | Record human's approval in audit, advance to next stage | **If supervised** |
| 14 | presented | changes-requested | Orchestrator | Record human's requested changes in audit | **If supervised** |
| 15 | changes-requested | finalised | Owner | Addressed human feedback, updated artifacts | NO |
| 16 | finalised | presented | Orchestrator | Re-present updated artifact to human | NO |

## Per-Stage Autonomy

Each stage in `workflow.json` has an `autonomy` property:

| Mode | Behaviour |
|---|---|
| `full` | Human gates are auto-approved. Orchestrator still sets `presented` (for auditability) but immediately advances to `complete`. Clarification questions are self-answered using the owner's recommendations. Audit entries note "auto-approved (full autonomy)." |
| `supervised` | All human gates block. Orchestrator must yield and wait for the human to respond at every row marked "If supervised." |

## Review Loop

When a reviewer is assigned, the cycle between owner and reviewer repeats until either:
1. The reviewer returns verdict "ready" — artifact proceeds to human (row 12b)
2. The iteration cap (`maxReviewIterations` in workflow.json, default 3) is reached — reviewer is bypassed, artifact goes to human with unresolved findings noted (row 12c)

The `reviewIterations` counter in state.json tracks how many times the reviewer has returned "not-ready." Once the cap is reached, the reviewer does not participate again — human and owner work together directly.

## Rules

1. **Transitions that block on human (in supervised mode) must NEVER be completed in the same turn as the preceding transition.** The orchestrator must yield and wait for a human message before proceeding.
2. **No row may be skipped** unless explicitly noted (e.g., "skip to #10 if no contributors").
3. **The orchestrator must NEVER write an audit entry recording a human decision until the human has actually responded in chat.**
4. **The `presented` state is always a hard stop in supervised mode** — the orchestrator presents a summary and waits. Period.
5. **Row 3 is always a human gate in supervised mode.** Even if the owner has no questions, the plan itself is presented for human approval or adjustment.
6. **The human can override autonomy at any time** by saying "stop" or "let me review that" — this implicitly switches the current stage to supervised.
7. **In full autonomy mode**, the audit log must clearly distinguish auto-approved entries from actual human decisions. Use "auto-approved (full autonomy)" rather than recording a fabricated human decision.
8. Each actor only sets state for what THEY did — never for what someone else will do.
9. When re-invoking a persona, pass all relevant files from the stage directory as context.
10. **If a stage has no `autonomy` property in workflow.json, default to `supervised`.** Human gates always block unless explicitly opted out.

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
