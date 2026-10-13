# Planning commands, shell composition, and working directories

**Finding:** DEVIN-10. **Status:** Upstream's rewritten guard adopted verbatim; only the adapter-side working-directory lift remains Devin-specific. **Source baseline:** upstream `59264b2c` (the `a3953609` rewrite); the prior branch baseline was `6e208f7b`. **Fact-checked:** 2026-09-12; guard convergence 2026-10-13.

## Why this was needed

The conductor must be able to read and present a plan before approval, but the same shell tool can also generate code. Early fixes removed false-positive blocks too broadly and allowed unsafe companion commands to inherit an exemption.

## Current implementation

For exec in the Plan Approval adapter, tool_input.workdir is copied into top-level cwd only when top-level cwd is missing or empty. Existing cwd wins. The project root remains separately selected through DEVIN_PROJECT_DIR. This normalization is local to that adapter branch; it is not applied to every guard. The lifted cwd is what upstream's `installedEngineArgs` resolves the tool script path against, so a `bun .devin/tools/...` run from a subdirectory is still recognised as the installed engine.

The core distinguishes concrete write targets, dynamic evaluation, and mutation-capable invocations. Approved planning prerequisites are upstream's: `installedEngineArgs` recognises the native engine spelling and the installed unified Bun entry point (script resolved against project dir and the lifted cwd), and `engineCommandAdmitted` judges the resulting route — AI-DLC's own commands are admitted by what the engine's verbs do, with the recorded-switch exception passing only when a person has asked. Executable spelling, PATH changes, data-driven wrappers, and possible cwd changes matter; basename alone is insufficient.

Pseudo-device output handling and valid file-descriptor redirection do not trap legitimate planning, under upstream's shared parser: `review-freeze-command.ts`'s `isNullDevice` drops `/dev/null`/`NUL` redirect targets, an fd-duplication target (`&1`) is never a file path, and a real source-file redirect remains a mutation target.

Git checkpoints need no explicit carve-out under the rewrite: `git add`/`git commit`/`git push` name no file they write, so a checkpoint-only compound passes the main gate's "names no file it writes" pass once the lexer has read it whole; a companion source write adds a project target and is refused — the exemption is not inherited. `git push` has run this way since the `b8d9bdc3` merge — "only the build waits for the plan" (t265 Facet C expects exit 0 and `git add -A && git push` sits in the allowed checkpoint list). Review-freeze and host permission policies remain independent.

Upstream's rewrite (`a3953609`, #2382) trusts direct installed-engine invocations and judges only the build. The branch's `isFrameworkToolInvocation` re-resolution is gone: `cd` is handled by the guard's own branch (a literal, absolute, glob-free return to the current directory passes; every actual change, wrapper, and dynamic operand stays opaque), and a `mkdir` names no file it writes. Neither sits in `READ_ONLY_SHELL_COMMANDS`.

## Evidence and limits

The old live notes explicitly corrected the claim that 2>&1 was a concrete file write: their parser returned a numeric invocation artifact instead. The subsequent bare-command rejection lacked complete exec arguments, so workdir was a hypothesis for that incident, not a proven universal cause.

The guard is a workflow-specific parser and policy, not a general shell sandbox. `sed` is classified by upstream: it sits in `TRACKED_SHELL_MUTATORS` and its `-i` write targets come from `review-freeze-command.ts` (the branch's own "sed without `-i` is read-only" rule was not re-added — the branch's sed tests pass on upstream's code). The same is now true of everything else the branch once carried: `cd`/`mkdir`, the `2>&1` numeric-artifact reading, and the git add/commit checkpoint pass are all upstream-owned after the `59264b2c` merge; the Devin adapter's `rewriteStdinCwd` is unchanged. These classifications and the checkpoint exceptions must not be represented as a proof that all shell syntax, hooks, aliases, or indirect writes are harmless.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Planning with descriptor redirects | Supported planning commands can run before approval without permitting source redirection | t265 planning and Facet A cases |
| Native executable/wrapper spoofing | ./aidlc, PATH changes, data-driven wrappers, and uncertain unified-entry cwd do not inherit planning trust | t265 native/Bun prerequisite negative cases |
| Compound checkpoint | Standalone/checkpoint-only compounds pass — including `git add -A && git push` (push is allowed before Plan Approval); checkpoint plus source write, redirection, or substitution is refused | t265 compound Git checkpoint block and Facet C |
| Directory creation before approval | A bare `mkdir -p <dir>` names no file it writes, so it passes the rewritten guard's "read whole, names no file it writes" pass (source-verified at `59264b2c`); a `mkdir` beside a source write is refused with that write | Coverage gap: neither t265 nor t332 has a `mkdir` case before or after the merge; the branch's old `READ_ONLY_SHELL_COMMANDS` entry was never test-pinned either |
| workdir/cwd precedence | Relative paths are evaluated under the supplied working directory; explicit top-level cwd is preserved | t332 tests 17b–17c; additional cross-guard normalization is not claimed |
| Upstream parser or route update | Run both legitimate-planning positives and mutation negatives through core and the Devin adapter | t265 plus t332; passing one side alone is insufficient |

## Superseded approaches and history

`bbc8f348` and later small follow-ups addressed false positives and working-directory handling. `f3b3810c` fixed the any-Git compound exemption. `6e208f7b` reconciled framework exemptions with upstream detailed parsing and fixed the unrelated diagnostics-test literal typing error. The `a6f8597a` merge of upstream `b8d9bdc3` (2026-10-09) adopted upstream's classifications: `git push` runs before Plan Approval, `sed` moved to `TRACKED_SHELL_MUTATORS` with `review-freeze-command.ts` owning `-i` targets, and the branch's separate sed read-only rule was not re-added. The merge of upstream `59264b2c` then dropped every remaining branch guard adaptation — the `isFrameworkToolInvocation`/`isFrameworkBash` re-resolution, the pseudo-device and numeric-descriptor rules, and the git add/commit carve-out — because upstream's `a3953609` rewrite passes the same tests (the t265 Facet A and Facet C cases, the compound Git checkpoint block, and the `cd` cases); the Devin adapter's `rewriteStdinCwd` is unchanged, and t265 + t332 remain the regression guard.

Superseded recipes: exempt an entire command if any invocation is Git add/commit; ignore opaque shell whenever any framework tool occurs; reject every redirect during planning; treat workdir as the confirmed cause of an incident without its full payload. Keep valid BASH/exec JSON in tests—one old raw-string commit test exercised malformed-input fail-open, not checkpoint approval.

## Sources

- `harness/devin/hooks/aidlc-devin-adapter.ts` — rewriteStdinCwd, plan-approval-guard
- `core/hooks/aidlc-plan-approval-guard.ts` — mutationIntent, shellInvocationNeedsApproval, installedEngineArgs, engineCommandAdmitted
- `core/hooks/review-freeze-command.ts` — isNullDevice, shellWriteTargets
- `tests/unit/t265-plan-approval-guard.test.ts`
- `tests/unit/t332-devin-adapter.test.ts` — 17b, 17c
- `tests/unit/t264-review-freeze-hook.test.ts`

[Back to findings index](index.md)
