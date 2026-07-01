# Design Rework — Validation-Driven Requirements

> **OVERRIDE**: This file is exempt from the Adaptive Workflow Principle and adaptive depth. Every step MUST be executed exactly as written.

**Purpose**: Define a reusable mechanism for any stage (static validation, post-deployment testing, or future stages) to feed gaps back as new requirements, get user approval, and restart the workflow so the requirements are processed through the normal stage sequence.

**When to invoke**: Any stage that discovers a gap between what the rules require and what was built MUST use this mechanism instead of fixing code or design artifacts directly.

**Principle**: Gaps are expressed as requirements, approved by the user, and the workflow restarts from the appropriate stage via `core-workflow.md`. The model MUST NOT modify design artifacts or code directly — it presents proposed requirements, the user approves, and the workflow re-executes through the normal stage sequence.

---

## Step 1: Check Iteration Limit

**MANDATORY**: You MUST scan `aidlc-docs/operations/`, `aidlc-docs/inception/`, and `aidlc-docs/construction/` for existing folders matching `run-*/`. Find the highest number across all of them.

- If no `run-*/` folders exist in any phase: set **N = 1**. Set **MAX_REACHED = false**. Proceed to Step 2.
- If the highest number is **less than 5**: set **N = highest + 1**. Set **MAX_REACHED = false**. Proceed to Step 2.
- If the highest number is **5 or more**: set **N = highest + 1**. Set **MAX_REACHED = true**. Proceed to Step 2.

**MANDATORY**: You MUST create the folder `aidlc-docs/{calling-phase}/run-{N}/`.

---

## Step 2: Classify Gaps and Determine Plan Type

**MANDATORY**: You MUST create `aidlc-docs/{calling-phase}/run-{N}/rework-plan.md` and write the Gap Classification Analysis section to it.

For each gap, you MUST complete the following tasks in order:

1. You MUST read the infrastructure design document in `aidlc-docs/construction/`. You MUST record whether the design describes the capability this gap requires. If found, cite the document, section, and relevant text.

2. You MUST read the NFR design document in `aidlc-docs/construction/`. You MUST record whether the design describes the capability this gap requires. If found, cite the document, section, and relevant text.

3. You MUST read `aidlc-docs/construction/plans/{unit-name}-code-generation-plan.md` (or equivalent). You MUST record whether a checkbox item exists that should have produced this artifact. If found, cite the step number and description.

4. You MUST classify the gap:
   - **Implementation Gap IF**: At least one design citation (task 1 or task 2) is found AND a plan citation (task 3) is found.
   - **Design Gap IF**: No design citation found (neither task 1 nor task 2) OR plan citation not found.

5. You MUST write the gap section to `rework-plan.md` using the format below.

After all gaps are classified:

6. You MUST determine the plan type:
   - **Design Plan IF**: ANY gap is classified as Design Gap.
   - **Implementation Plan IF**: ALL gaps are classified as Implementation Gap.

7. You MUST write the Plan Type Determination section to `rework-plan.md`.

**Document format** — write this to `aidlc-docs/{calling-phase}/run-{N}/rework-plan.md`:

```markdown
# Rework Plan — Loop {N}

## Gap Classification Analysis

### Gap 1: [brief description]
**Rule**: [rule ID]
**Finding**: [what validation found — factual, not interpretive]

**Design Citation**: [document name, section, and relevant text — or "Not found"]
**Plan Citation**: [code-generation-plan.md step number and description — or "Not found"]

- **Design Gap IF**: Design Citation not found OR Plan Citation not found
- **Implementation Gap IF**: Design Citation found AND Plan Citation found

**Classification**: [Design Gap / Implementation Gap]

---

### Gap 2: [brief description]
...

---

## Plan Type Determination

- **Design Plan IF**: ANY gap is classified as Design Gap
- **Implementation Plan IF**: ALL gaps are classified as Implementation Gap

**Plan Type**: [Design Plan / Implementation Plan]
**Rationale**: [cite which gap(s) drove the decision]
```

Validation check:
- **MANDATORY**: Every gap MUST have a Design Citation field and a Plan Citation field (even if "Not found").
- **MANDATORY**: Every gap classified as Implementation MUST have both a design citation AND a plan citation. If either is "Not found", the classification MUST be Design Gap.
- **MANDATORY**: If any gap is classified as Design Gap, the Plan Type MUST be Design Plan.
- **MANDATORY**: `aidlc-docs/{calling-phase}/run-{N}/rework-plan.md` MUST exist with all gap sections and the Plan Type Determination before proceeding to Step 3.

---

## Step 3: Formulate as Requirements

**MANDATORY**: You MUST express each gap as a concrete blocking requirement in the standard question/answer format used by Requirements Analysis. The requirement MUST:

1. Use MUST/MUST NOT language — these are blocking requirements, not suggestions
2. State what is required (not what is wrong)
3. Reference the rule ID that drives the requirement

**IF MAX_REACHED = false**, use this format:

```markdown
## Question {N}: [brief description]

**Source**: [calling stage, e.g. "Rules Validation — Deployment Domain"]
**Rule**: [rule ID, e.g. DEPLOY-PIPE-007]

**Finding**: [what validation found — factual, not interpretive]

**Requirement**: [what MUST be true, in blocking language]

A) Approve — add this requirement and restart the workflow
B) Reject — document as known exception
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**IF MAX_REACHED = true**, use this format:

```markdown
## Question {N}: [brief description]

**Source**: [calling stage, e.g. "Rules Validation — Deployment Domain"]
**Rule**: [rule ID, e.g. DEPLOY-PIPE-007]

**Finding**: [what validation found — factual, not interpretive]

**Requirement**: [what MUST be true, in blocking language]

> ⚠️ Maximum rework iterations reached. This gap must be accepted as a known exception.

B) Reject — document as known exception

[Answer]:
```

Group related gaps into a single question when they share the same root cause.

---

## Step 4: Present to User for Approval

**MANDATORY**: You MUST present all proposed requirements to the user. You MUST NOT proceed until the user has answered every question.

For each question:
- **Answer A (Approve)**: The requirement will be added and the workflow will restart.
- **Answer B (Reject)**: The gap is documented as a known exception in the validation report and `aidlc-docs/audit.md` with the user's justification.
- **Answer X (Other)**: Process the user's custom response.

**Wait for Explicit Approval**: You MUST NOT proceed until all questions are answered.

---

## Step 5: Record Approved Requirements

For each approved requirement (Answer A):

1. **MANDATORY**: You MUST write the approved requirements and their answers to `aidlc-docs/inception/requirements/{calling-stage}-rework-loop-{N}.md` (using N from Step 1)
2. **MANDATORY**: You MUST log the requirement and approval in `aidlc-docs/audit.md` with timestamp, rule ID, loop number N, and user's answer

Validation check:
- **MANDATORY**: You MUST verify `aidlc-docs/inception/requirements/{calling-stage}-rework-loop-{N}.md` exists before proceeding to Step 6. If it does not exist, go back and create it.

---

## Step 6: Process Responses

Review all answers from Step 4:

- **If all answers are B (Reject)**: **MANDATORY**: You MUST exit rework and return to the step in the calling stage that invoked this mechanism. Do NOT proceed to Steps 7 or 8.
- **If any answer is A (Approve)**:
  1. **MANDATORY**: You MUST read the Plan Type from `aidlc-docs/{calling-phase}/run-{N}/rework-plan.md` (determined in Step 2).
  2. Proceed to Step 7.

Validation check:
- **MANDATORY**: Every answer MUST be A, B, or X — no unanswered questions. If any question has no answer, go back to Step 4.
- **MANDATORY**: The Plan Type in `rework-plan.md` MUST be either "Design Plan" or "Implementation Plan" before proceeding.

---

## Step 7: Append Archive and Workflow Tasks to Rework Plan

**MANDATORY**:
1. You MUST read the Plan Type from `aidlc-docs/{calling-phase}/run-{N}/rework-plan.md` (created in Step 2).
2. You MUST list `aidlc-docs/{calling-phase}/` and all its subfolders recursively, **excluding `run-*/` folders**. Record every file found with its path relative to `aidlc-docs/{calling-phase}/`. This is the **archive inventory**.
3. You MUST append the Archive Inventory, Archive Tasks, and Workflow Tasks sections to `aidlc-docs/{calling-phase}/run-{N}/rework-plan.md`.
4. You MUST populate EXECUTE or SKIP for each conditional step based on the Plan Type. All steps start unchecked `[ ]`.
5. You MUST add one copy task per item in the archive inventory (from task 2). Each item in the inventory MUST have a corresponding copy task in the plan.

```markdown
**Archive Inventory** ({count} items):
{list each file and folder from the scan, one per line}

## Archive Tasks

- [ ] **Copy `{relative-path/file}` to `run-{N}/{relative-path/file}`** — EXECUTE
  - You MUST add one task for each file in the Archive Inventory.
  - You MUST use the file's relative path exactly as recorded in the inventory.
  - You MUST have one checkbox per file until every file in the inventory has a task.
  - The copy MUST contain the full content of the source file. Do not summarise, abbreviate, or recreate from memory.

## Workflow Tasks

- [ ] **Append to requirements.md** — [EXECUTE/SKIP]
  - **Execute IF**: Design Plan
  - **Skip IF**: Implementation Plan

- [ ] **Copy `aidlc-docs/aidlc-state.md` to `aidlc-docs/{calling-phase}/run-{N}/aidlc-state.md`** — EXECUTE
  - The copy MUST contain the full content of aidlc-state.md (all sections, all tables).

- [ ] **Copy `aidlc-docs/step-decision-log.md` to `aidlc-docs/{calling-phase}/run-{N}/step-decision-log.md`** — EXECUTE
  - The copy MUST contain the full content of step-decision-log.md (all stage sections, all step rows).

- [ ] **Reset aidlc-state.md for Design Plan** — [EXECUTE/SKIP]
  - **Execute IF**: Design Plan — delete all content from aidlc-state.md. Workspace Detection will create a fresh one.
  - **Skip IF**: Implementation Plan

- [ ] **Uncheck Code Generation and subsequent stages in aidlc-state.md** — [EXECUTE/SKIP]
  - **Execute IF**: Implementation Plan — uncheck Code Generation, Build and Test, Rules Validation, Deployment, Post-Deployment Testing. Set Current Stage to Code Generation.
  - **Skip IF**: Design Plan

- [ ] **Reset step-decision-log.md** — delete all content and write only `# Step Decision Log` — EXECUTE
  - The restarted workflow will populate this file from scratch.

- [ ] **Restart the workflow** — EXECUTE
```

**Wait for Explicit Approval**: Present the rework plan to the user. You MUST NOT proceed to Step 8 until the user approves.

Validation check:
- **MANDATORY**: `aidlc-docs/{calling-phase}/run-{N}/rework-plan.md` MUST exist before presenting for approval
- **MANDATORY**: Every item in the Archive Inventory MUST have a corresponding copy task in the Archive Tasks section. If any item is missing a task, go back and add it.
- **MANDATORY IF Design Plan**: verify "Append to requirements.md" = EXECUTE, "Reset aidlc-state.md for Design Plan" = EXECUTE, "Uncheck Code Generation" = SKIP
- **MANDATORY IF Implementation Plan**: verify "Append to requirements.md" = SKIP, "Reset aidlc-state.md for Design Plan" = SKIP, "Uncheck Code Generation" = EXECUTE
- **MANDATORY**: If any step has the wrong value, go back and correct the plan before presenting for approval

---

## Step 8: Execute Rework Plan

**MANDATORY**: You MUST execute each EXECUTE step in `aidlc-docs/{calling-phase}/run-{N}/rework-plan.md` in order, marking `[x]` when complete. You MUST NOT proceed to the next step until the current step is marked `[x]`.

Validation check:
- **MANDATORY**: You MUST NOT mark "Restart the workflow" as `[x]` until all preceding EXECUTE steps are `[x]` and the following file state is confirmed.
- **MANDATORY**: Every copy task in the Archive Tasks section MUST be marked `[x]`. If any are unchecked, go back and execute them.
- **MANDATORY**: After all Archive Tasks are complete, `aidlc-docs/{calling-phase}/` MUST contain only `run-*/` folders and `rework-plan.md` files. If it still contains other files or folders, a copy task was missed — go back and copy them.
- **MANDATORY**: `aidlc-docs/{calling-phase}/run-{N}/step-decision-log.md` MUST contain multiple `## Stage Name` sections with step tables. If it contains fewer than 10 lines, the copy failed — go back and copy the full content of step-decision-log.md.
- **MANDATORY**: `aidlc-docs/step-decision-log.md` MUST contain only `# Step Decision Log` and no stage sections. If it still contains stage sections, the reset failed — delete the content and write only the heading.
- **MANDATORY IF Implementation Plan**: `aidlc-docs/aidlc-state.md` MUST have Code Generation and all subsequent stages unchecked. Current Stage MUST be set to Code Generation. `aidlc-docs/{calling-phase}/run-{N}/aidlc-state.md` MUST contain the full previous state with all stages as they were before unchecking.
- **MANDATORY IF Design Plan**: `aidlc-docs/aidlc-state.md` MUST be empty or deleted. `aidlc-docs/{calling-phase}/run-{N}/aidlc-state.md` MUST contain the full previous state (all sections, all tables).

## Constraints

- **Maximum rework iterations**: 5. Checked in Step 1 by scanning `aidlc-docs/operations/`, `aidlc-docs/inception/`, and `aidlc-docs/construction/` for `run-*/` folders and finding the highest number. File-based — no context required.
- **Audit trail**: Every proposed requirement and its outcome MUST be logged in `aidlc-docs/audit.md`.
- **No direct fixes**: The model MUST NOT modify design artifacts or code in `workspace/` without going through this mechanism. All gaps — whether design gaps or implementation gaps — MUST follow the restart process defined in Steps 7 and 8. The model MUST NOT jump directly into a detail file step.
- **User control**: The user can reject any proposed requirement. Rejected gaps become known exceptions, not silent failures.
