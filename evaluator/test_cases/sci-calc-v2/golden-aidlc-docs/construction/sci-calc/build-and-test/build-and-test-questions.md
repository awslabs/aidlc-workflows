# Build and Test Questions

Skill: build-and-test:sci-calc
Status: answered
Date: 2025-01-21T16:15:00Z

---

### Q1: Should we run `uv sync` first to install all dependencies?

a) Yes — run `uv sync` to install all dependencies from pyproject.toml before any other step
b) No — assume dependencies are already installed
c) Other

**Recommendation:** Option (a). Since this is a greenfield project and the workspace was just populated by code-generation, dependencies have not been installed yet. `uv sync` is the standard first step per the tech-env document.

[Answer]: A

---

### Q2: Should we run `uv run ruff check` for linting?

a) Yes — run ruff check against the entire `src/` directory with the configured rules (line-length 100, target py313)
b) Yes — run ruff check with `--fix` to auto-fix any issues found
c) No — skip linting in this build-and-test pass
d) Other

**Trade Offs:** Option (a) reports issues without modifying code, giving visibility. Option (b) auto-fixes trivial issues (imports, whitespace) but may mask generated-code quality. Option (c) defers linting but risks accumulating tech debt.

**Recommendation:** Option (a). Report linting results without auto-fixing. If issues are found, we can fix them in a subsequent step with full visibility of what changed.

[Answer]: B

Rationale: Since we're iteratively fixing failures anyway (Q5), auto-fixing trivial lint issues with `--fix` is more efficient. We still get visibility in the report of what was fixed.

---

### Q3: Should we run `uv run pytest --cov` for tests with coverage measurement?

a) Yes — run `pytest --cov=src/sci_calc --cov-report=term-missing` for full test suite with coverage
b) Yes — run `pytest` only (no coverage measurement)
c) Yes — run `pytest --cov` with HTML coverage report as well
d) Other

**Trade Offs:** Option (a) gives coverage percentage and identifies uncovered lines. Option (c) adds an HTML report artifact but adds complexity. Option (b) verifies tests pass but doesn't measure coverage.

**Recommendation:** Option (a). Coverage measurement with term-missing output is lightweight and directly shows which lines lack coverage, making it easy to verify the 90% threshold.

[Answer]: A

---

### Q4: What is the minimum acceptable coverage threshold?

a) 90% — as specified in the tech-env document
b) 80% — a more relaxed threshold for initial generation
c) 95% — a stricter threshold for a calculator API where correctness is paramount
d) Other (specify percentage)

**Recommendation:** Option (a). The tech-env document explicitly states 90% coverage threshold with `pytest-cov`. We should honour that specification.

[Answer]: A

---

### Q5: Should we attempt to fix any failures found, or just report them?

a) Fix failures — iteratively fix code until all tests pass, linting is clean, and coverage meets threshold
b) Report only — produce a report of pass/fail status without attempting fixes
c) Fix up to 3 iterations, then report remaining failures
d) Other

**Trade Offs:** Option (a) ensures the skill produces a working, validated codebase but may require multiple iterations. Option (b) is faster but may leave the codebase in a broken state. Option (c) balances effort with progress.

**Recommendation:** Option (a). The goal of build-and-test is to deliver a verified, working codebase. We should fix issues until the build is green, as the generated code should be close to correct already.

[Answer]: A

---

### Q6: Should we produce a build-and-test report as the skill artifact?

a) Yes — produce a `build-and-test-report.md` summarising: dependency install status, lint results, test results, coverage percentage, and pass/fail determination
b) No — the passing build itself is sufficient evidence
c) Other

**Recommendation:** Option (a). A structured report provides traceability and a permanent record of build health at this point in the workflow. It also gives the validator and human verifier a clear summary.

[Answer]: A
