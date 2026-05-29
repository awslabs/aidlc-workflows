# Phase 3: Planning (PLAN)

## Objective

Design the implementation before writing code. A good plan prevents rework.

## Instructions

### Step 1: Analyze Requirements

Read `.aidlc/docs/requirements.md`. Identify:
- Components/modules involved
- Data flow and state changes
- Files to create, modify, delete
- Dependencies between steps
- Migration steps (brownfield only)

### Step 2: Design the Approach

For each requirement, determine:

**Greenfield:**
- Project structure and conventions
- Technology choices (if not already set)
- Component hierarchy / module layout

**Brownfield:**
- Where new code fits in existing structure
- What existing code to reuse/extend
- Migration strategy for existing data
- Backwards compatibility

### Step 3: Write Execution Plan

Write to `.aidlc/docs/execution-plan.md` using the XML-structured format:

```markdown
<plan_metadata>
  <name>...</name>
  <based_on>.aidlc/docs/requirements.md</based_on>
</plan_metadata>

<architecture_overview>
## Overview
...
</architecture_overview>

<files_to_create>
...
</files_to_create>

<files_to_modify>
...
</files_to_modify>

<execution_steps>
<step id="1">
  <title>...</title>
  <file>...</file>
  <description>...</description>
  <tests>...</tests>
</step>
</execution_steps>

<edge_cases>
...
</edge_cases>

<migration_plan>
...
</migration_plan>

<test_plan>
...
</test_plan>

<risks>
...
</risks>
```

### Step 4: Identify Risks

Note any risky decisions:
- New dependencies
- Breaking changes
- Performance concerns
- Security implications

### Step 5: Checkpoint

Present the execution plan. Ask: "Does this plan look correct? Adjust before I start coding?"

The user can:
- **Approve all** → proceed to implementation
- **Modify steps** → adjust specific steps
- **Skip steps** → remove unnecessary steps
- **Add steps** → include missing steps

Do NOT write ANY code until the plan is approved.

## Rollback from Later Phases

If rolling back to PLAN from implement/verify:
1. Read the most recent snapshot in `.aidlc/history/`
2. Check `.aidlc/audit.md` for decisions that affected implementation
3. Identify: which plan steps were wrong or missing?
4. Update `.aidlc/docs/execution-plan.md` with fixes
