---
name: aidlc-work-method
description: |
  This skill describes how you work in each stage. As an owner, what are your tasks — plan, clarify, produce artifacts, refine based on feedback. As a reviewer, what are your tasks — read the artifact, write a review. Must be used to execute each stage. Defines what to produce at each step and ensures everything is persisted through the artifact repository per conventions.
---

# Work Method

## Purpose

You know how to work through a stage. When the orchestrator invokes you, it tells you what to do. Everything you produce is persisted through the artifact repository — nothing stays only in chat.

You address artifacts by their logical **type** (e.g. `requirements`, `units`, `plan`, `questions`) and act on them through the repository operations in `conventions/repository-interface.md`. You never choose a filename, an extension, or a path — the active repository adapter decides how and where an artifact is stored.

## What You May Be Asked To Do

### Plan and clarify

Produce TWO artifacts in the current stage scope:

- `questions` — clarification questions you need answered. Use the format in `conventions/question-format.md`. If you have no questions, record a brief note explaining why.
- `plan` — the steps you will take to produce the stage's output artifacts, with checkboxes for each substep.

After saving both, set this stage's status to `clarification-asked`.

### Review answers and decide

The human has answered your questions. Read the `questions` artifact with their answers. Decide:
- If clear → proceed to produce artifacts.
- If ambiguous → append follow-up questions to the `questions` artifact and set status to `further-clarification`.

You may revise the `plan` artifact based on what you learned from the answers.

### Produce artifacts

Follow your plan. Produce the artifacts declared in the stage definition. As you complete each substep, mark its checkbox in the `plan` artifact as done (`[x]`). Save all outputs into the current stage scope.

After all artifacts are saved, set this stage's status to `artifact-generated`.

### Contribute to someone else's work (as contributor)

Read the artifact produced by the owner from the stage scope. Save your findings as the `<your-persona-name>-contribution` artifact in the stage scope. Be specific — reference sections, fields, or gaps.

After saving your contribution, set your contribution entry in state to `contributed: true`.

### Final review (as reviewer)

You are the quality gate. Read ALL artifacts in the stage scope (use `listArtifacts`) — the output artifact, the `questions`, the `plan`, all contributor `*-contribution` artifacts, and the stage definition/templates. Check for completeness, coherence, and traceability.

Save your findings as the `<your-persona-name>-review` artifact in the stage scope. Your verdict is either "ready" or "not ready" with specific gaps listed.

Do NOT set the stage status. The orchestrator sets `final-review-complete` after you return.

### Refine based on contributor feedback

Read the contributor `*-contribution` artifacts. Address their findings — fix issues, fill gaps, respond to challenges. Update your artifacts in place. Document your reasoning for anything you chose not to address.

After refining, set this stage's status to `refined`.

### Finalise based on reviewer feedback

Read the reviewer's `*-review` artifact. Address their findings — fix remaining gaps, resolve any "not ready" items. Update your artifacts in place.

After finalising, set this stage's status to `finalised`.

## State Write Contract

Whenever you produce or modify an artifact in the stage scope, register it in the current stage entry's `outputs` array (via `registerOutput`) before handing control back. Use this exact format:

```json
{
  "type": "<artifact-type>",
  "address": {
    "container": "stage",
    "phase": "<inception|construction|operations>",
    "stage": "<stage-name>",
    "unit": "<unit-name, only for construction-phase stages>",
    "type": "<artifact-type>"
  }
}
```

Use the artifact's logical `type` from the catalog in `conventions/repository-interface.md` — never a filename. Omit `unit` for inception stages. For meta artifacts, set `container` to `intent-root`, `state`, or `audit` as appropriate and omit the stage fields.

## Artifact Resolution

Stages consume artifact roles, not rigid stage locations. For each concern needed by the current stage, use the richest available upstream artifact.

Stage definition inputs describe required knowledge and preferred artifact sources, not hard dependencies on specific upstream stages unless explicitly marked non-skippable. If an input says "Required: <artifact>", interpret that as "this concern must be understood"; use the preferred artifact when available, otherwise infer the minimum needed detail from the richest available upstream source and document the fallback in the `plan` artifact.

Use this priority:

1. **Prefer when available** — use later, more detailed upstream artifacts when they exist.
2. **Infer when skipped** — if a producing stage was skipped, infer the minimum needed detail from the best available earlier artifact.
3. **Preserve blueprint identity** — when inferring or expanding, preserve stable IDs, names, responsibilities, boundaries, and dependency directions from copied-forward artifacts.
4. **Document the fallback** — record in the `plan` artifact which artifacts were used and what had to be inferred because a stage was skipped.

A skipped stage is not an error. It only changes how much the current stage must infer from available upstream artifacts.

## Persistence

- Everything you produce is persisted through the repository — `saveArtifact` for artifacts, `registerOutput`/`setStageStatus` for state. Nothing stays only in chat.
- Read and follow all files in `conventions/` — especially `repository-interface.md` (how to address and persist artifacts) plus the question, state, and workflow formats.
- Use `resolveTemplate(type)` to get the starting content scaffold for an output artifact, when one exists.
- When a stage refines a previous artifact, `copyForwardArtifact` the relevant upstream artifact into the current stage scope first, preserve its stable IDs and structure, and expand it in place. New artifacts may be created when useful, but they must reference stable IDs from the copied-forward artifact so the blueprint does not drift as details are added.
- Never return content only in chat — always persist through the repository first.
- Read artifacts through the repository (`readArtifact`/`listArtifacts`) — do not rely on the orchestrator to pass content to you. You have the tools; use them.
