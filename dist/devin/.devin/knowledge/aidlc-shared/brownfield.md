# Brownfield Safeguards

For any stage that modifies existing code or infrastructure, these safeguards apply.

## Safeguard Matrix

| Safeguard | What It Does | When Applied |
|-----------|-------------|--------------|
| **Blast Radius Analysis** | Identifies affected files/components and their downstream dependents | Before code generation (stage `code-generation`, 3.5) |
| **Diff Preview** | Shows exact proposed changes before applying | Before any file modification |
| **Test Baseline** | Runs existing tests BEFORE changes to establish baseline | Before code generation (stage `code-generation`, 3.5) |
| **Test Validation** | Runs existing tests AFTER changes to confirm nothing broke | After code generation (stage `build-and-test`, 3.6) |
| **Impact Analysis** | Documents affected APIs, components, and dependencies | During reverse engineering (stage `reverse-engineering`, 2.1) and code generation (3.5) |
| **Rollback Plan** | Documents how to undo changes if needed | Before deployment (stage `deployment-execution`, 4.3) |

## Blast Radius Analysis Template

Before modifying existing code:
1. List all files that will be changed
2. For each file, identify: imports/consumers, test files, configuration references
3. Classify impact: low (isolated change), medium (affects 2-3 dependents), high (cross-cutting)
4. Present impact summary to user before proceeding

## Test Baseline Protocol

1. Run full test suite before ANY code changes
2. Record: total tests, passing, failing, skipped, coverage %
3. After code generation, re-run full test suite
4. Compare: new failures = regressions introduced by changes
5. If regressions found, fix before proceeding
