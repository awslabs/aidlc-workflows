# Plan: close the compound Git plan-approval bypass

Date: 2026-09-12
PR: https://github.com/awslabs/aidlc-workflows/pull/996
Baseline: `5f984188` on `feat/devin-harness`

## Fact check and reproduction

The proposition is confirmed. In `core/hooks/aidlc-plan-approval-guard.ts`, `mutationIntent` uses `invocations.some(...)` to recognize `git add` or `git commit`, then returns an empty-target, non-opaque intent before computing write targets or dynamic evaluation. The guard's early exit therefore exempts the entire compound command, not just the checkpoint operation.

The hook was invoked as a Bun subprocess with a `PreToolUse` / `Bash` JSON payload, using copies of the existing `scratchProject`, `seedState`, `seedActiveDirectiveLoadSteering`, `BASH`, and `runHook` helpers from `tests/unit/t265-plan-approval-guard.test.ts`. Enforcement was explicitly enabled with `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=0`. Command strings were only hook input: none of the proposed writes, staging commands, or pushes were executed.

| Command in hook payload | Baseline exit | Required exit |
| --- | --- | --- |
| `echo x > src/app.ts` | 2 | 2 |
| `git add -A && echo x > src/app.ts` | 0 | 2 |
| `git add -A ; echo x > src/app.ts` | 0 | 2 |
| `git add -A && git push` | 0 | 2 |

All three compounds returned empty stderr. The bare write reported `Code generation cannot start because its Plan Approval authority is ambiguous or stale` and `the current state has no matching v2 code-generation active directive`.

Local reproduction evidence: `/tmp/t265-repro-stdout.txt` and `/tmp/t265-repro-stderr.txt`. The temporary reproduction file was removed and no tracked files were changed by reproduction.

### Adaptations to the proposition

1. Replacing `some` with `every` alone is insufficient: an all-Git command can still redirect output to a source file or contain dynamic evaluation. Compute concrete targets and dynamic evaluation before the exemption and require both to be absent, plus a non-empty invocation list consisting entirely of Git add/commit.
2. The existing load-steering fixture is not accepted as current authority by the present reader. It lacks required load-steering continuation fields, and it supplies a raw state hash rather than using `stateDigest`. Preserve the requested fixture cases, but also exercise the four commands using `seedActiveDirective(proj, "code-generation")`, which supplies a valid unapproved run-stage authority. Do not describe the original reproduction as proof of valid load-steering authority.
3. The existing Facet C standalone commit test passes raw non-JSON text to `runHook`; its success exercises malformed-input fail-open, not the Git exemption. Preserve all existing Facet A/C tests unchanged and add a real `BASH`-wrapped commit test and an all-Git compound allow case.
4. Earlier research in `plan-approval-guard-traps-conductor-fix-plan.md`, Step 1.3, prescribed the vulnerable `some` form. Mark that implementation recipe superseded by this tightening, preserving the historical account rather than presenting it as current safe guidance.

## Implementation

1. Add table-driven subprocess regressions to `tests/unit/t265-plan-approval-guard.test.ts` for the four exact commands above, expecting exit 2 and a plan-approval refusal. Run each with the existing load-steering fixture and a valid unapproved run-stage fixture. Before the fix, run the new tests and retain the red output.
2. Add proper-payload positive tests for `git commit -m "checkpoint"` and `git add -A && git commit -m "checkpoint"` (exit 0). Add negative cases for `git add -A > src/app.ts` and `git commit -m "$(echo x > src/app.ts)"` (exit 2).
3. In `mutationIntent`, compute `targets = shellWriteTargets(command, cwd)` and the dynamic-evaluation flag before considering the Git exemption. Require a non-empty invocation list and `every` invocation to normalize to Git with subcommand add/commit. Return an empty, non-opaque intent only when there are no targets and no dynamic evaluation. Otherwise use the existing normal target/opaque-shell computation. Do not change shared shell parsing, `READ_ONLY_GIT_SUBCOMMANDS`, review-freeze, or the separate framework-tool exemption.
4. Preserve existing code comments and Facet A/C cases. Do not broaden the task into general shell-parser or framework-tool exemption redesign. This is a targeted closure, not a claim that the hook is a general-purpose shell security boundary.
5. Bump the authored framework version and README badge from 2.9.5 to 2.9.6. Add a matching dated changelog entry with upgrade instructions and user-visible blocking behavior. Generated distributions are rebuilt locally, never hand-edited or committed.

## Verification

- Red/green: run new t265 cases before and after the fix; preserve the original Facet A and Facet C cases.
- Run the complete t265 file, review-freeze t264, runtime authority t328, and version/changelog t68.
- Run adapter suites for Kiro CLI (t147), Codex (t149), Kiro IDE (t218), opencode (t241), Copilot (t249 and security t250), Cursor (t276), and Devin (t332). The t265 subprocess lifecycle covers the native Claude core path, and its registration assertions cover other harness wiring.
- Run `bun scripts/package.ts` and `bun scripts/package.ts --check` to regenerate and check determinism across all eight harnesses.
- Run focused Biome checks on changed TypeScript files and `bun run typecheck`. A pre-existing typecheck failure at `tests/unit/t294-config-diagnostics.test.ts:314` is recorded in PR history; if encountered, report it accurately rather than silently fixing unrelated code or claiming a clean full check.
- Inspect the full diff, ensure existing tests/comments are preserved, check for stale documentation references, and run `git diff --check`.
- No live LLM sessions, remote Git operations inside hook payloads, or full release/binary build are required for this targeted core guard change. Report exactly which checks ran and any failures.

## Why this is a tightening

The current exemption allows a compound command whenever any invocation is Git add/commit, discarding evidence about the rest. The replacement recognizes only a non-empty all-checkpoint command without concrete write targets or dynamic evaluation. Other commands return to the existing approval checks; no new approval bypass is introduced. Standalone checkpoint operations remain available, both requested source-write compounds are blocked without approval, and Git push cannot inherit the checkpoint exemption. Review-freeze and other harness-specific permission policies remain unchanged.

## Delivery

After reviewing the implementation and verification evidence, commit the authored hook, tests, plan, supersession notice, and synchronized release metadata; push the existing PR head branch without rewriting history. Comment on PR #996 with the four before/after results, fixture caveat, test coverage and limitations, commit ID, plan path, and tightening rationale.

## Execution results

Implemented and reviewed on 2026-09-12, with the framework version synchronized to 2.9.6.

| Command in hook payload | Before | After |
| --- | --- | --- |
| `echo x > src/app.ts` | 2 | 2 |
| `git add -A && echo x > src/app.ts` | 0 | 2 |
| `git add -A ; echo x > src/app.ts` | 0 | 2 |
| `git add -A && git push` | 0 | 2 |

The four post-fix outcomes hold under both the original load-steering helper (with the authority caveat above) and an unapproved run-stage directive. Proper `BASH` payloads for a standalone commit and an add/commit compound exit 0. The direct source redirection and command-substitution cases exit 2. Existing Facet A/C tests and code comments were preserved unchanged.

Validation:

- New regression block before the fix: 4 pass / 8 fail, with the expected six compound-command failures plus direct-redirection and dynamic-evaluation failures (`/tmp/t265-compound-red.txt`).
- New regression block after the fix: 12 pass / 0 fail (`/tmp/t265-compound-green.txt`).
- Complete focused suite: 465 pass / 0 fail across 12 files (`/tmp/verify-test-suite.txt`). Command:

  ```bash
  bun test tests/unit/t265-plan-approval-guard.test.ts tests/unit/t264-review-freeze-hook.test.ts tests/unit/t328-plan-approval-runtime-authority.test.ts tests/unit/t68-version-changelog-sync.test.ts tests/unit/t147-kiro-hook-adapter.test.ts tests/unit/t149-codex-hook-adapter.test.ts tests/unit/t218-kiro-ide-hook-adapter.test.ts tests/unit/t241-opencode-adapter.test.ts tests/unit/t249-copilot-adapter.test.ts tests/unit/t250-copilot-adapter-security.test.ts tests/unit/t276-cursor-adapter.test.ts tests/unit/t332-devin-adapter.test.ts
  ```

- `bun scripts/package.ts` passed (`/tmp/verify-package.txt`). `bun scripts/package.ts --check` confirmed independent-build determinism for Claude, Codex, Copilot, Cursor, Devin, Kiro CLI, Kiro IDE, and opencode (`/tmp/verify-package-check.txt`). Generated files remain ignored and excluded from the commit.
- Focused Biome check passed for the three changed TypeScript files (`/tmp/verify-biome.txt`); `git diff --check` passed.
- `bun run typecheck` exited 2 at the previously recorded `tests/unit/t294-config-diagnostics.test.ts:314` TS2769 overload mismatch (`/tmp/verify-typecheck.txt`). The core TypeScript step passed; the tests step failed, so the chained adapter typecheck did not run. No unrelated source or compiler policy was changed. This is not a claim of a clean full-project typecheck.
- No live harness/LLM E2E run or full release suite was performed. Temporary evidence paths are local session artifacts; this document retains the commands and results for the PR record.

The reviewed change is confined to the Git exemption, its regressions, release metadata, and research documentation. No shared parser, review-freeze policy, harness adapter, or separate framework-tool exemption was changed.
