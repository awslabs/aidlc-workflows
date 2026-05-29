# Phase 5: Verification (VERIFY)

## Objective

Confirm the implementation actually works. Catch issues before the user does.

## Instructions

### Step 1: Run Existing Tests

Run the project's test suite to check for regressions:
- All existing tests should pass
- If any fail, investigate and fix before proceeding

### Step 2: Run the Application

Start the app and manually verify:
- Feature works as described in acceptance criteria
- Happy path works
- Edge cases handled (empty, error, boundary)
- No console errors/warnings (or only pre-existing ones)
- UI looks correct at different viewport sizes (frontend)

### Step 3: Write New Tests (if planned)

If `.aidlc/docs/execution-plan.md` includes new tests:
- Write them following the project's test conventions
- Cover happy path and edge cases
- Run them to confirm they pass

### Step 4: Fix Issues

If problems are found:
1. Fix the issue
2. Re-run tests
3. Re-verify the feature
4. Note fixes — they will be logged in audit phase

If the issues require significant re-planning, recommend rollback to PLAN phase.

### Step 5: Verification Report

```
## Verification Report

**Test Results:**
- Existing tests: N passed, N failed, N skipped
- New tests: N added, all passing

**Manual Verification:**
- [x] Happy path
- [x] Edge case: empty state
- [x] Edge case: error state
- [x] No regressions observed

**Issues Found & Fixed:**
- ... (or "None")

### Verdict: READY FOR AUDIT | NEEDS REWORK
```

### Step 6: Checkpoint

Present the report. Ask: "Verification complete. Proceed to audit?"

If issues remain, go back to implementation. If the plan itself needs changes, recommend rollback.
