# Phase 4: Implementation (IMPLEMENT)

## Objective

Execute the plan step by step. Write correct, well-structured code following project conventions.

## Instructions

### Step 1: Load the Plan

Re-read `.aidlc/docs/execution-plan.md`. Confirm which steps are approved for implementation.

### Step 2: Implement One Step at a Time

For each step in the execution plan:
1. Announce which step you're starting
2. Write the code (create/edit/delete files)
3. Mark the step `<step id="X" status="done">` in execution-plan.md
4. Note any deviations from the plan

**Coding standards:**
- Follow existing code patterns and conventions
- Handle edge cases identified in the plan
- No commented-out code
- No dead code or unused imports
- No TODO comments (either do it now or don't mention it)
- Use meaningful names
- Default to no comments — only add when WHY is non-obvious

**Brownfield additional rules:**
- Match existing code style exactly
- Do not refactor unrelated code
- Maintain backwards compatibility
- Add to existing tests, don't rewrite them

### Step 3: Track Progress

After each step, update `.aidlc/docs/execution-plan.md`:
```markdown
<step id="1" status="done">
  <completed>What was done</completed>
  <deviations>none</deviations>
</step>
```

### Step 4: Self-Review

After all steps are implemented:
1. Check all imports are used
2. Check all new code is reachable
3. Check for obvious logical errors
4. Verify nothing was accidentally broken

### Step 5: Checkpoint

Present implementation summary:
```
## Implementation Complete

**Files created:** N
**Files modified:** N
**Files deleted:** N

### Deviations from plan:
- ... (or "None — followed plan exactly")

### Ready for verification.
```

Do NOT proceed to verification until user confirms.

## Rollback from Verification

If verification reveals problems that require planning changes:
1. Note specific issues found
2. Save a snapshot to `.aidlc/history/`
3. Roll back to PLAN phase
4. Fix the plan, then re-implement
