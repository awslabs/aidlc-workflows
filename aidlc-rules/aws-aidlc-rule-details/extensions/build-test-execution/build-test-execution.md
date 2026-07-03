# Build & Test Execution Extension

**Extension ID**: `BUILD-TEST-EXEC`
**Category**: `build-test-execution`
**Phase Coverage**: CONSTRUCTION (Build & Test, Code Generation)

---

## Core Principle: Tests Must Actually Pass

The default AI-DLC Build & Test phase generates test instruction documentation. This extension upgrades it to **actual test execution** — the AI runs the test suites, diagnoses failures, fixes code, and iterates until green. A Build & Test stage that only generates markdown files without running the test runner is incomplete when this extension is enabled.

---

## Rule BUILD-TEST-EXEC-001: Environment Validation Pre-flight

**Applies to**: CONSTRUCTION → Build & Test (before test execution)

Before executing any tests, validate that the build and test environment is operational:

- [ ] Run the project's dependency installation command and confirm it completes without errors
- [ ] Confirm the test runner starts and recognizes the test configuration (e.g., config file found, test files discovered)
- [ ] **Zero warnings policy**: The test runner output must contain zero configuration warnings, deprecation warnings, or unknown-option warnings. Any warning emitted during configuration loading is treated as a pre-flight failure — it may indicate a misspelled configuration key, a missing setup file, or an incompatible plugin version. Resolve every warning before proceeding
- [ ] Verify required test infrastructure is present and functional (setup files, polyfills, test utilities, shared fixtures). Confirm that setup files listed in the test configuration are actually executed — not silently skipped due to a misconfigured key
- [ ] **Environment isolation check**: Verify the test environment does not inherit runtime configuration values from development or production environment files. Run a targeted check: do tests behave identically with and without the local environment file present? If removing the environment file changes test behavior, the test setup is leaking external configuration and must be fixed before proceeding
- [ ] Check that environment variables, configuration files, and credentials needed for testing are accessible
- [ ] If any pre-flight check fails, resolve the issue before proceeding to test execution
- [ ] Document any environment issues and their resolutions in the test summary

**CRITICAL**: Do not skip this step. A failing environment produces misleading test results.

---

## Rule BUILD-TEST-EXEC-002: Contract Verification

**Applies to**: CONSTRUCTION → Build & Test (before test execution)

Before executing tests, perform static validation that test files align with source files:

- [ ] Verify all import/require paths in test files resolve to actual source files on disk
- [ ] Confirm all identifiers referenced in tests (component names, function names, class names) exist in the corresponding source
- [ ] Validate that all selectors used in tests (data-testid attributes, CSS selectors, accessibility queries, DOM identifiers) exist in the source markup or templates
- [ ] Check that mock module paths match the actual module structure and export types (named vs default)
- [ ] Verify that prop names, method signatures, and API contracts in test assertions match the source implementation
- [ ] **Pagination contract check**: For every source function that reads from a paginated data source (database scan, API list call, file-system enumeration), verify the implementation consumes ALL pages — not just the first. If the implementation only processes one page or logs a warning instead of iterating, this is a contract violation that must be fixed before testing
- [ ] **Error serialization contract check**: For every error class that defines machine-readable fields (error codes, types, detail objects), verify the error handler/serializer includes ALL defined fields in the response body. A field present on the error class but absent from the serialized response is a contract gap — fix the serializer or the test expectations before proceeding
- [ ] **Mock lifecycle alignment check**: For every test file that resets the module registry or dependency container (to get fresh instances), verify that ALL mock/stub references used in assertions are re-acquired AFTER the reset — not captured once at module scope. Stale references are a silent contract break between the test and the mock framework
- [ ] If mismatches are found, fix the test or source file before proceeding to execution

**NOTE**: This step is performed by reading and searching source files — no execution required. It catches the class of errors where generated tests reference identifiers, paths, or contracts that do not exist in the generated source.

---

## Rule BUILD-TEST-EXEC-003: Test Execution and Iteration

**Applies to**: CONSTRUCTION → Build & Test (after contract verification)

Actually execute the project's test suites and iterate until all tests pass:

1. Run the project's dependency installation command (if not already done in BUILD-TEST-EXEC-001)
2. Execute the full test suite using the project's test runner
3. Capture and analyze test output (pass count, fail count, error details)
4. If tests fail:
   a. Categorize failures (environment issues, import errors, assertion mismatches, missing implementations)
   b. Fix each failure in the source or test code as appropriate
   c. Re-run the full test suite
   d. Repeat until all tests pass or a blocking issue requires user input
5. Record the final test results (total tests, passed, failed, skipped, coverage if available)
6. If any tests cannot be fixed without user guidance, document them clearly and flag for review

**CRITICAL**: This step mandates actual test execution — not generating documentation about tests. The test suite MUST be run, and results MUST be verified through the test runner's actual output.

---

## Rule BUILD-TEST-EXEC-004: Inline Test Execution During Code Generation

**Applies to**: CONSTRUCTION → Code Generation (per-unit, per-step)

When a Code Generation step generates test files:
- Run the project's test runner targeting the newly generated or modified tests immediately after generation
- If tests fail, fix the source or test code and re-run until passing
- Do not proceed to the next Code Generation step until generated tests execute successfully
- This applies to all testing sub-steps (e.g., "Unit Testing", "Integration Testing")

---

## Rule BUILD-TEST-EXEC-005: Results Presentation

**Applies to**: CONSTRUCTION → Build & Test (completion)

All results presented MUST come from actual test execution output (BUILD-TEST-EXEC-003), not estimates or projections. The completion message must include actual pass/fail counts from the test runner.

The Build & Test completion prompt should read:
> "Build and test complete. All tests passing. Ready to proceed to Operations stage?"

(Not: "Build and test instructions complete.")

---

## Extension Compliance Summary Format

When presenting stage completion, include:

```markdown
### Build & Test Execution Extension Compliance
- **BUILD-TEST-EXEC-001**: [COMPLIANT — environment validated, zero warnings] or [N/A]
- **BUILD-TEST-EXEC-002**: [COMPLIANT — all contracts verified] or [N/A]
- **BUILD-TEST-EXEC-003**: [COMPLIANT — X tests passed, 0 failed] or [N/A]
- **BUILD-TEST-EXEC-004**: [COMPLIANT — inline tests executed per step] or [N/A]
- **BUILD-TEST-EXEC-005**: [COMPLIANT — actual results presented] or [N/A]
```
