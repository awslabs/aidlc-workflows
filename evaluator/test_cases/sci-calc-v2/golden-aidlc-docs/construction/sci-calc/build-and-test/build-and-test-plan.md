# Build and Test Plan — sci-calc

Skill: build-and-test:sci-calc
Status: complete
Date: 2025-01-21T16:20:00Z
Completed: 2025-01-21T16:30:00Z

---

## Overview

Execute the build toolchain against the generated Scientific Calculator API code in `workspace/`. The goal is to install dependencies, lint, test, verify coverage, fix any issues iteratively, and produce a final build-and-test report.

## Inputs

- Generated code: 33 files in `workspace/` (see CODE_SUMMARY.md)
- Configuration: `workspace/pyproject.toml` (hatchling build, ruff, pytest-cov)
- Tech environment: 90% coverage threshold, ruff (line-length 100, py313), pytest with pytest-asyncio + httpx

## Plan

### Phase 1: Dependency Installation

- [x] Run `uv sync` in `workspace/` to install all dependencies from pyproject.toml
- [x] Verify the command exits successfully (exit code 0)
- [x] Confirm the virtual environment is created and packages are installed

### Phase 2: Linting with Auto-Fix

- [x] Run `uv run ruff check . --fix` in `workspace/` to lint and auto-fix trivial issues
- [x] Review ruff output for any remaining unfixable errors
- [x] If unfixable errors remain, manually fix them in the source code
- [x] Re-run `uv run ruff check .` to confirm a clean lint pass (exit code 0)

### Phase 3: Test Execution with Coverage

- [x] Run `uv run pytest --cov=src/sci_calc --cov-report=term-missing` in `workspace/`
- [x] Capture test results (pass count, fail count, error count)
- [x] Capture coverage percentage and uncovered lines

### Phase 4: Coverage Threshold Verification

- [x] Verify overall coverage >= 90% (as specified in tech-env.md)
- [x] If coverage < 90%, identify uncovered lines and add/fix tests to increase coverage

### Phase 5: Iterative Failure Resolution

- [x] If any tests fail: diagnose root cause, fix source or test code, re-run pytest
- [x] If lint issues reappear after fixes: re-run ruff check --fix and verify clean
- [x] If coverage drops below 90% after fixes: add additional test cases
- [x] Repeat iterations until: all tests pass AND lint is clean AND coverage >= 90%

### Phase 6: Build Report Production

- [x] Produce `build-and-test-report.md` in the skill output directory containing:
  - Dependency installation status (success/failure, package count)
  - Linting results (issues found, issues auto-fixed, final clean status)
  - Test results (total tests, passed, failed, errors, skipped)
  - Coverage summary (overall %, per-file breakdown, uncovered lines if any)
  - Pass/fail determination with justification
  - Number of fix iterations required (if any)

---

## Success Criteria

1. ✅ `uv sync` completes successfully
2. ✅ `ruff check .` exits with code 0 (no remaining lint errors)
3. ✅ All pytest tests pass (0 failures, 0 errors)
4. ✅ Line coverage >= 90% (actual: 99.76%)
5. ✅ `build-and-test-report.md` is produced with all sections populated

## Artifacts Produced

- `build-and-test-report.md` — comprehensive build health report
