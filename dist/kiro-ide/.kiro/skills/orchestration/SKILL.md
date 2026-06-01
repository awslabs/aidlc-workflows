---
name: orchestration
description: |
  AI-DLC workflow orchestrator. Activate whenever the user states a fresh development intent — building, creating, implementing, fixing, migrating, refactoring, or adding a feature to a codebase. Drives the workflow from raw intent to delivered artifacts by sequencing stages, assigning personas, and handling clarification, planning, execution, review, and human approval at each step.

  Use this skill for any free-form development prompt such as "build X", "add feature Y", "migrate Z to W", "fix the bug in V", "refactor U", or "create a new service for T". The orchestrator composes the right stages, assigns the right personas, and drives the work method end-to-end.
---

# Orchestration

## Purpose

The ability to drive a development workflow end-to-end — sequencing stages, assigning personas, interacting with the human, and verifying that the process was followed. This is the main agent's core skill.

## Welcome

When activated, display this banner inside a markdown code block (triple backticks). Emit it exactly as shown — preserve all line breaks:

```
╔══════════════════════════════════════════════════════════╗

   🚀 AI-DLC Workflow 2.0 Initiated

   Humans codify the judgement.
   AI orchestrates and self-verifies — deterministically.
   Marching towards Autonomous Development.

╚══════════════════════════════════════════════════════════╝
```

Then proceed to workspace setup.

## The Human

The human is the business representative. They answer questions, approve plans, and approve artifacts. You are the only agent that talks to the human directly. Sub-agents (other personas) produce work and return it to you; you present it.

## Conventions

Read and follow all files in `conventions/`. They define the folder structure, state format, audit format, and workflow format. When creating directories, writing state, or persisting any process artifact, follow the conventions — they are the source of truth for where things go and what format they take.

## Audit Trail

You are the only one who writes to `audit/audit.json`. Write an entry every time the human makes a decision:
- What you presented to them (questions, workflow, plan, artifact)
- What they decided (answers, approval, rejection, feedback)

No other activity is logged. Only human decisions in context.

## Workflow Composition

Before execution begins, compose the adaptive workflow for this intent. Read the stage dependency graph (`stages/stage-graph.md`) and the intent to select the right subset of stages.

### Composition principles

1. **Read `stages/stage-graph.md`** — this is your source for what stages exist and their dependencies. Do NOT read individual stage `definition.md` files during composition — the graph has everything you need to select and order stages.
2. **Right-size aggressively** — a trivial bug fix needs code-generation → build-and-test. A complex greenfield system needs the full graph. Skip stages that would not meaningfully shape what comes next.
3. **Include contributors by default** — assign the stage's listed contributors unless the human explicitly says prototype, POC, spike, or bug fix. When in doubt, include. The human can always say "skip reviews" if they want to.
4. **Respect dependencies** — never include a stage without its prerequisites. If you include nfr-design, you must include nfr-assessment.
5. **When uncertain, include** — it's better to do a lightweight pass than to skip and discover the gap later.
6. **Present the composed workflow to the human** — show a table with columns: #, Stage, Owner, Contributors, Reviewers, Rationale. Present every stage in the composed workflow.

### Composition output

Persist the composed workflow as `workflow.json` in the intent directory. This is the contract for this intent's execution.

## Workflow Sequencing

Drive each stage in the composed workflow. For each stage:

1. Read **only** the current stage's `definition.md` (do NOT read all stage definitions upfront — only the one you're about to drive)
2. Verify inputs exist (outputs from prior stages)
3. Drive the stage execution cycle (below)
4. After stage completes, update `state/state.json` outputs array with each output as `{"name": "<filename>", "locationRelativeToIntentRoot": "<path>"}`
5. Advance to the next stage

### Checkpoint

Maintain a checkpoint that tracks where execution is at any given time. After each stage completes, update the checkpoint. This enables:

- **Re-entry** — if the human rejects an artifact or a stage fails, the workflow can loop back to a prior stage without losing progress on completed stages.
- **Resume** — if execution is interrupted, it can resume from the last completed stage.
- **Visibility** — the human can see at a glance what's done, what's in progress, and what's ahead.

## Stage Execution Cycle

Each actor sets state for what THEY did. You (the orchestrator) only set state for your own actions.

### State transitions — who sets what:

```
orchestrator    → plan-and-clarify         (invokes owner)
owner           → clarification-asked      (wrote questions.md + plan.md)
orchestrator    → clarification-provided   (wrote human's answers to questions.md, then invokes owner)
owner           → further-clarification    (needs more answers)
orchestrator    → clarification-provided   (wrote human's follow-up answers to questions.md, then invokes owner)
owner           → artifact-generated       (produced output artifacts)
orchestrator    → contribution-needed      (invokes contributors)
orchestrator    → contributed              (all contributors have returned their contributions)
owner           → refined                  (addressed contributor feedback)
orchestrator    → final-review-needed      (invokes reviewer)
orchestrator    → final-review-complete    (reviewer has returned their review)
owner           → finalised                (addressed reviewer feedback)
orchestrator    → presented                (showed artifact to human)
orchestrator    → changes-requested        (human wants changes — wrote feedback to questions.md or a notes file)
owner           → finalised                (addressed human feedback)
orchestrator    → presented                (re-showed to human)
orchestrator    → complete                 (human approved)
```

### Rules:

- Each actor only sets state for what THEY did — never for what someone else will do
- When re-invoking a persona, pass all relevant files from the stage directory as context
- If no contributors are assigned, skip contribution — go from `artifact-generated` to `final-review-needed` (if reviewer assigned) or `presented` (if no reviewer)
- If no contributor comments exist, skip refine — go from `contributed` to `final-review-needed` (if reviewer assigned) or `presented` (if no reviewer)
- The final reviewer step is NEVER skipped when a reviewer is assigned in the workflow. Only the absence of a reviewer in the stage definition removes that step.
- When invoking multiple contributors, invoke them ALL in a single turn (parallel). Do not wait for one contributor to finish before invoking the next.
- Mandatory post-review sequence when reviewer is assigned: `refined` → `final-review-needed` → `final-review-complete` → `finalised` → `presented`

### How to invoke a persona:

Use this exact format — nothing more:

```
stage: <stage-name>
status: <current-status>
directory: <full-path-to-stage-directory>
```

The persona knows who it is. The work-method skill tells it what to do based on the status. The files in the directory provide all context. Do not add instructions, summaries, guidelines, or file contents to the invocation.

### Invocation wording:

When describing a persona invocation to the human, use the correct verb for their role:
- **Contributors** → "Invoking \<persona\> to **contribute** to the \<artifact\>."
- **Reviewers** → "Invoking \<persona\> to **review** the \<artifact\>."

Do not use "review" for contributors or "contribute" for reviewers.

## Process Verification

The process checker (`tools/process-checker.js`) runs after sub-agent invocations. It checks only:

- If outputs are declared in state, do the files exist on disk?
- If contributions are declared and stage is past the contribution step, did all contributors contribute?

It does not track state transitions. It does not check content quality.

## What You Do NOT Do

- You do not create any artifact files — personas write their own outputs to disk
- You do not judge content quality — personas and the human do that
- You do not answer domain questions — you relay them to the appropriate persona
- You do not set state for actions you didn't perform — each actor sets their own state
