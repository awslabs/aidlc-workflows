# Planning commands, shell composition, and working directories

**Finding:** DEVIN-10. **Status:** Implemented protections with scoped guarantees. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

The conductor must be able to read and present a plan before approval, but the same shell tool can also generate code. Early fixes removed false-positive blocks too broadly and allowed unsafe companion commands to inherit an exemption.

## Current implementation

For exec in the Plan Approval adapter, tool_input.workdir is copied into top-level cwd only when top-level cwd is missing or empty. Existing cwd wins. The project root remains separately selected through DEVIN_PROJECT_DIR. This normalization is local to that adapter branch; it is not applied to every guard.

The core distinguishes concrete write targets, dynamic evaluation, and mutation-capable invocations. Approved planning prerequisites include restricted native engine routes and the installed unified Bun entry point. Executable spelling, PATH changes, data-driven wrappers, and possible cwd changes matter; basename alone is insufficient.

Pseudo-device output handling and valid file-descriptor redirection must not trap legitimate planning. Real source-file redirects remain mutations. The detailed parser's real numeric executable is not treated like a legacy synthetic descriptor artifact.

Git checkpoints have a narrow exemption: a nonempty invocation list entirely of add/commit, with no concrete write targets or dynamic evaluation. A companion source write or git push must not inherit the exemption. Review-freeze and host permission policies remain independent.

At baseline 6e208f7b the former framework-tool any-match bypass was tightened: reclassification checks every invocation with full executable/wrapper metadata and rejects dynamic evaluation or executable-resolution changes. Possible cd/pushd/popd changes also prevent trusting the unified entry point as a direct invocation. This was necessary when combining the branch with upstream's stricter planning checks.

## Evidence and limits

The old live notes explicitly corrected the claim that 2>&1 was a concrete file write: their parser returned a numeric invocation artifact instead. The subsequent bare-command rejection lacked complete exec arguments, so workdir was a hypothesis for that incident, not a proven universal cause.

The guard is a workflow-specific parser and policy, not a general shell sandbox. Existing sed/mkdir classifications and checkpoint exceptions must not be represented as a proof that all shell syntax, hooks, aliases, or indirect writes are harmless.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Planning with descriptor redirects | Supported planning commands can run before approval without permitting source redirection | t265 planning and Facet A cases |
| Native executable/wrapper spoofing | ./aidlc, PATH changes, data-driven wrappers, and uncertain unified-entry cwd do not inherit planning trust | t265 native/Bun prerequisite negative cases |
| Compound checkpoint | Standalone/checkpoint-only compounds pass; checkpoint plus source write, push, redirection, or substitution is refused | t265 compound Git checkpoint block |
| workdir/cwd precedence | Relative paths are evaluated under the supplied working directory; explicit top-level cwd is preserved | t332 tests 17b–17c; additional cross-guard normalization is not claimed |
| Upstream parser or route update | Run both legitimate-planning positives and mutation negatives through core and the Devin adapter | t265 plus t332; passing one side alone is insufficient |

## Superseded approaches and history

`bbc8f348` and later small follow-ups addressed false positives and working-directory handling. `f3b3810c` fixed the any-Git compound exemption. `6e208f7b` reconciled framework exemptions with upstream detailed parsing and fixed the unrelated diagnostics-test literal typing error.

Superseded recipes: exempt an entire command if any invocation is Git add/commit; ignore opaque shell whenever any framework tool occurs; reject every redirect during planning; treat workdir as the confirmed cause of an incident without its full payload. Keep valid BASH/exec JSON in tests—one old raw-string commit test exercised malformed-input fail-open, not checkpoint approval.

## Sources

- `harness/devin/hooks/aidlc-devin-adapter.ts` — rewriteStdinCwd, plan-approval-guard
- `core/hooks/aidlc-plan-approval-guard.ts` — mutationIntent, shellInvocationNeedsApproval, isFrameworkToolInvocation
- `core/hooks/review-freeze-command.ts`
- `tests/unit/t265-plan-approval-guard.test.ts`
- `tests/unit/t332-devin-adapter.test.ts` — 17b, 17c
- `tests/unit/t264-review-freeze-hook.test.ts`

[Back to findings index](index.md)
