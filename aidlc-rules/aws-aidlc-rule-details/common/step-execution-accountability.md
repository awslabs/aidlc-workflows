# Step Execution Accountability

> **OVERRIDE**: This file is exempt from the Adaptive Workflow Principle, adaptive depth, and any rule that permits the model to skip steps, reduce detail, or apply judgement about whether to follow instructions. The requirements in this file are unconditional and apply to every rule detail file loaded during the workflow. The model MUST NOT apply adaptive thinking, depth adaptation, or value-based assessment to any instruction in this file. Every instruction below MUST be followed exactly as written, for every file loaded, for every stage, every time.

**Purpose**: MANDATORY tracking of every step in every loaded rule detail file. No silent skipping. No exceptions.

## Core Rule

**MANDATORY**: When a rule detail file is loaded, the model MUST:

1. **Read the entire file** — MUST NOT stop reading before the end of the file
2. **Identify all steps** in the file — MUST list every step found in the step-decision-log before beginning execution
3. **Process every identified step** in sequence — for each step, either execute it or log justification for skipping in the step-decision-log
4. **Update the step-decision-log as each step is processed** — MUST NOT write the log retrospectively after all steps are complete. Each step's status MUST be recorded immediately after it is processed.
5. **Verify step count** — the number of steps in the decision log MUST match the number of steps identified in the file. If they differ, the log is incomplete and MUST be corrected before proceeding.

The model MUST NOT do any of the following without logging justification in the step-decision-log:
- Decide that a step is not relevant and skip it
- Treat numbered steps as optional guidance
- Stop processing steps after an approval gate
- Combine multiple steps into one and skip the individual logging
- Determine a step adds no value and omit it from execution

The word "relevant" in Rule Details Loading applies to **which files to load**, not which steps within a loaded file to follow. Once a file is loaded, ALL its steps MUST be processed.

## Sub-Task Accountability

**MANDATORY**: Every step in a rule detail file contains one or more sub-tasks (bullet points, numbered items, checklists, or instructions within the step body). The model MUST:

1. **Identify every sub-task** within the step — MUST NOT treat any bullet point, numbered item, or instruction as optional
2. **Execute every sub-task** — MUST NOT selectively complete some sub-tasks and skip others
3. **Mark the step PARTIAL if any sub-task is not performed** — MUST list every skipped sub-task and justification in the decision log

The model MUST NOT:
- Summarise multiple sub-tasks into a single action and skip the individual sub-tasks
- Decide a sub-task is implied by another sub-task and skip it
- Treat sub-tasks as examples or suggestions — they are instructions
- Mark a step EXECUTED if any sub-task within it was not performed

## Decision Log Format

**MANDATORY**: The model MUST maintain `aidlc-docs/step-decision-log.md`. For every loaded rule detail file, the model MUST append an entry using this exact format:

```markdown
## [Stage Name]

**File**: `[full path to the rule detail file]`
**Steps identified**: [total count]
**Steps executed**: [count]
**Steps skipped**: [count]
**Steps partial**: [count]

| Step | Title | Status | Justification |
|------|-------|--------|---------------|
| Step 1 | [step title from file] | EXECUTED | |
| Step 2 | [step title from file] | EXECUTED | |
| Step 3 | [step title from file] | SKIPPED | [specific reason referencing condition or context] |
| Step 4 | [step title from file] | PARTIAL | Sub-tasks skipped: [list each]. Reason: [specific reason] |
```

### Status Definitions

- **EXECUTED**: Step was performed including ALL sub-tasks. No justification needed.
- **SKIPPED**: Step was not performed. Justification is MANDATORY — MUST NOT leave blank.
- **PARTIAL**: Step was performed but one or more sub-tasks were not completed. MUST list every skipped sub-task and justification.

### Justification Requirements

Justification MUST reference the specific condition or context that makes the step unnecessary. The following are NOT acceptable justifications:
- "Not needed"
- "Not applicable"
- "Not relevant"
- "Skipped for efficiency"
- "Already covered"

Acceptable justifications reference specific facts, for example:
- "No extensions are active in aidlc-state.md — Extension Configuration table shows all extensions disabled"
- "Brownfield-only step — this is a greenfield project per workspace detection"
- "Conditional step — NFR Requirements was not executed for this unit"

### Timing

- The step-decision-log entry MUST be created when the file is loaded (Step 2 — identify all steps)
- Each row MUST be updated immediately after the step is processed — MUST NOT be written retrospectively
- The completed entry MUST exist BEFORE presenting the stage completion message
- The decision log MUST NOT be omitted, deferred, or summarised

## What This Applies To

**MANDATORY**: This rule applies to ALL rule detail files loaded via `Load all steps from` instructions in core-workflow, including but not limited to:
- `construction/infrastructure-design.md`
- `construction/code-generation.md`
- `construction/functional-design.md`
- `construction/nfr-design.md`
- `construction/nfr-requirements.md`
- `construction/build-and-test.md`
- `inception/requirements-analysis.md`
- `inception/workspace-detection.md`
- `operations/rules-validation.md`

## What This Does NOT Apply To

- Extension baseline files (these define rules, not steps)
- Operations domain rule files (these define rules, not steps)
- Common files without numbered steps (e.g. `terminology.md`, `depth-levels.md`)

## Enforcement

This rule is a **blocking requirement**. The model MUST NOT present a stage completion message if the step-decision-log entry for that stage has not been written. If the log is missing, the stage is not complete.
