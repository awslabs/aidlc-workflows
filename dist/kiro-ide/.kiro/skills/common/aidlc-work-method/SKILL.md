---
name: aidlc-work-method
description: |
  This skill describes how you work in each stage. As an owner, what are your tasks — plan, clarify, produce artifacts, refine based on feedback. As a reviewer, what are your tasks — read the artifact, write a review. Must be used to execute each stage. Defines what to produce at each step and ensures everything is persisted to disk per conventions.
---

# Work Method

## Purpose

You know how to work through a stage. When the orchestrator invokes you, it tells you what to do. Everything you produce gets written to disk — nothing stays only in chat.

## What You May Be Asked To Do

### Plan and clarify

Write TWO files in the stage output directory:

- `questions.md` — clarification questions you need answered. Use the format in `conventions/question-format.md`. If you have no questions, write a brief note explaining why.
- `plan.md` — the steps you will take to produce the stage's output artifacts, with checkboxes for each substep.

After writing both files, set this stage's status in `state/state.json` to `clarification-asked`.

### Review answers and decide

The human has answered your questions. Read `questions.md` with their answers. Decide:
- If clear → proceed to produce artifacts.
- If ambiguous → append follow-up questions to `questions.md` and set status to `further-clarification`.

You may revise `plan.md` based on what you learned from the answers.

### Produce artifacts

Follow your plan. Produce the artifacts declared in the stage definition. As you complete each substep, mark its checkbox in `plan.md` as done (`[x]`). Write all outputs to the stage output directory.

After all artifacts are written, set this stage's status in `state/state.json` to `artifact-generated`.

### Contribute to someone else's work (as contributor)

Read the artifact produced by the owner from the stage directory. Write your findings to `<your-persona-name>-contribution.md` in the stage directory. Be specific — reference sections, fields, or gaps.

After writing your contribution, set your contribution entry in `state/state.json` to `contributed: true`.

### Final review (as reviewer)

You are the quality gate. Read ALL files in the stage directory — the artifact, the questions.md, the plan.md, all contributor contribution files, and the stage definition/templates. Check for completeness, coherence, and traceability.

Write your findings to `<your-persona-name>-review.md` in the stage directory. Your verdict is either "ready" or "not ready" with specific gaps listed.

Do NOT set the stage status. The orchestrator sets `final-review-complete` after you return.

### Refine based on contributor feedback

Read the contributor contribution files (`*-contribution.md` from contributors). Address their findings — fix issues, fill gaps, respond to challenges. Update your artifacts in place. Document your reasoning for anything you chose not to address.

After refining, set this stage's status in `state/state.json` to `refined`.

### Finalise based on reviewer feedback

Read the final reviewer's review file. Address their findings — fix remaining gaps, resolve any "not ready" items. Update your artifacts in place.

After finalising, set this stage's status in `state/state.json` to `finalised`.

## Artifact Resolution

Stages consume artifact roles, not rigid stage paths. For each concern needed by the current stage, use the richest available upstream artifact.

Use this priority:

1. **Prefer when available** — use later, more detailed upstream artifacts when they exist.
2. **Infer when skipped** — if a producing stage was skipped, infer the minimum needed detail from the best available earlier artifact.
3. **Preserve blueprint identity** — when inferring or expanding, preserve stable IDs, names, responsibilities, boundaries, and dependency directions from copied-forward artifacts.
4. **Document the fallback** — record in `plan.md` which artifacts were used and what had to be inferred because a stage was skipped.

A skipped stage is not an error. It only changes how much the current stage must infer from available upstream artifacts.

## Persistence

- Everything you produce gets written to a file on disk
- Read and follow all files in `conventions/` — they define folder structure, question format, state format, and where everything goes
- Use the templates in the stage's `templates/` directory as the starting format for output artifacts
- When a stage refines a previous artifact, copy the relevant upstream artifact into the current stage directory first, preserve its stable IDs and structure, and expand it in place. New artifacts may be created when useful, but they must reference stable IDs from the copied-forward artifact so the blueprint does not drift as details are added.
- Never return content only in chat — always write to disk first
- Read files directly from the file system — do not rely on the orchestrator to pass file contents to you. You have file read tools; use them.
