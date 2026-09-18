# Regression coverage, historical evidence, and upgrade verification

**Finding:** DEVIN-14. **Status:** verification procedure and evidence limitations. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

The port repeatedly exposed the difference between a configured integration, a green synthetic test, and a working human workflow. The regression record must make those boundaries visible rather than turn every historical PASS into a current support claim.

## Retained evidence and its limits

| Evidence | What it records | What it does not prove |
| --- | --- | --- |
| `tests/fixtures/devin-hook-payloads/captured-3000.6.14.json` with `capture-provenance.json` | Sanitized raw hook captures from the documented build; foreground/background dispatch, reads/writes, lifecycle fields, missing child identity | Current-build behavior; answered C07/C08 envelopes; separately captured cancel/fail/resume lifecycle |
| `tests/fixtures/devin-hook-payloads/payloads.json` | Synthetic/compatibility inputs used by adapter tests | That the host emitted every field or shape |
| Historical `evidence/devin-e2e-run/` run subdirectories (`first-run/` through `fourth-run/`) | Removed from the working tree; original run summaries, manifests, and session exports remain in Git history | A current-build reproduction, a blanket all-topology PASS, or an independent raw hook capture for every tool result |
| `evidence/devin-e2e-run/session-isolation-run/` | Attended 2026-09-17 run on Devin CLI 3000.10.31 at `bce80f29` plus the uncommitted Item 1 fix: three real sessions, native Plan Approval click, forced wrong-session `answer`, `/clear` receipt persistence; audit shard, runtime challenge/receipt files, session C export, SHA-256 manifest | A completed workflow (developer dispatch blocked by DEVIN-07), receipt reuse without re-prompt, exports for sessions A and B, or behavior on other builds |
| `evidence/devin-e2e-run/native-dispatch-run/` | Attended 2026-09-17/18 run on Devin CLI 3000.10.31 at `3baf4d54` plus the uncommitted Item 2 fix: approved developer dispatch allowed with zero guard blocks, child-received prompt carrying exactly one rule bundle (read from `sessions.db`, the parent-side record is pre-merge), full `hello.py` workflow to `WORKFLOW_COMPLETED`, doctor 58/0; SHA-256 manifest | A `/clear` receipt-reuse check (session was only resumed/compacted), an unapproved-dispatch or built-in-profile dispatch (none occurred), a session export covering the dispatch (export holds the post-compaction tail only), or behavior on other builds |
| Former frontmatter-revert log | Historical test narrative with an explicit notice of edited version text, recoverable in Git | Untouched raw evidence or a rerun on the newer baseline |

The four run subdirectories under `evidence/devin-e2e-run/` have been removed from the working tree; the top-level `README.md` and `HARNESS-REQUIREMENTS.md` are retained. Other evidence outside this directory is unchanged. Interpret summaries alongside their raw artifacts and disclosed interventions; summaries can contain diagnoses later corrected by source inspection.

## Deterministic verification commands

Run from the repository root. These commands are a reproducible procedure, not a declaration that this rewrite ran every suite. Record the exact command, revision, environment, exit status, and retained log location when executing them.

```bash
bun scripts/package.ts
bun scripts/package.ts --check
bun run typecheck
bun run lint
bun tests/run-tests.ts --unit --no-llm --filter '^t(331-devin-packaging|332-devin-adapter|333-ensemble-harness-bindings|334-devin-version|294-config-diagnostics|265-plan-approval-guard|299-testing-posture-wiring|37)\.test\.ts$' --debug
bun tests/run-tests.ts --integration --no-llm --filter '^t(121-stop-hook-enforce|328-authority-rebinding)\.test\.ts$' --debug
bun tests/run-tests.ts --smoke --no-llm --filter '^t250-question-fence-never-echo\.test\.ts$' --debug
```

For package/plugin/runtime changes, also select `t238-build-binaries.test.ts`, `t243-install-mechanism.test.ts`, `t315-plugin-build.test.ts`, and `t188-plugin-compose.serial.test.ts` in their appropriate tiers. Follow `docs/reference/09-testing.md` for release-scale verification. These extra checks are not mandatory for every documentation-only edit.

Use full descriptive filenames: numeric IDs are reused. For example, `t332-devin-adapter.test.ts`, `t332-preview-release-pipeline.test.ts`, and `t332-summary-authorization.test.ts` are different suites. A broad numeric filter can unexpectedly test unrelated subsystems or require unrelated local tools.

Packaging determinism, source parity, static protocol checks, runtime fixture assertions, and live host acceptance are separate evidence. A passing `--check` does not compare an existing tracked dist tree or establish before/after behavior.

## Coverage to preserve and gaps to close

| Concern | Existing coverage | Remaining boundary |
| --- | --- | --- |
| Packaging, profile metadata, triggers, permissions, MCP defaults | t331 and shared package/plugin tests | Actual host/plugin loading and effective local policies |
| Adapter subprocess behavior | t332 (including the `Item 2` native-dispatch cases); approved dispatch, rule injection, and full workflow completion observed live (native-dispatch-run) | Reviewer attribution and terminal lifecycle gaps in DEVIN-07; `rebuild-stage-graph` never compiles `runtime-graph.json` on Devin because `classifyRuntimeCompileCommand` derives its path pattern from `KNOWN_HARNESS_DIRS`, which omits `.devin` (`bun .devin/tools/aidlc-orchestrate.ts report …` classifies `pass`, the `.claude` form `fire`; `learnings surface` then fails with `runtime-graph.json not found`) — pre-existing core defect observed live, not covered by any test |
| Ensemble binding | t333 source-contract assertions | Real participation, contribution artifacts, pipeline receipts, and failure recovery |
| Version and diagnostics | t334, t294, t331/t332 SessionStart cases | Desktop execution, actual model selection, current hook approval |
| Plan Approval and shell safety | t265 and shared authority tests; strict session pairing covered by the t328 `Item 1 session isolation` suite and t332 adapter A/B transport cases; native `task` dispatch translation covered by the t332 `Item 2` cases | Receipt reuse without re-prompt after a session change (inconclusive in session-isolation-run; native-dispatch-run resumed/compacted the same session without re-prompt but issued no `/clear`) |
| Question rendering and recording | t250, focused t181 contract assertions, t332 | Fresh interactive batch, skip, Other, and contradictory-response cases |
| Read-only Stop consultation | t121 and t328 integration | New observer-reachable writers after engine changes |
| Contract repair | t299 and t37 | Host write-tool attribution/fix and safe retirement |

Do not weaken a test or turn an environment error into a skip solely to obtain green output. Reproduce a suspected baseline failure at the stated revision before labelling it pre-existing. Old notes about t118/t181 failures or a t294 type error describe their own baselines; the t294 literal-type error was fixed in `6e208f7b`, so it is not a standing exception.

## Live verification after a host update — not run by this rewrite

The existing automated Devin live test is deliberately narrow:

```bash
AIDLC_DEVIN_EXEC_LIVE=1 bun tests/run-tests.ts --e2e --filter '^t-exec-devin-status\.serial\.test\.ts$' --debug
```

It requires a supported binary, uses `AIDLC_DEVIN_BIN` when supplied, and covers no-workflow `/aidlc --status` plus absence of workflow scaffolding. It does not validate active workflow gates, subagents, Desktop, or all topologies. A skip is not a live PASS. Run only with explicit approval for model usage and the applicable environment.

A broader acceptance session needs a disposable project outside this checkout, intentional hook trust/permission setup, a confirmed build, and redacted captures. Keep source-copy and compiled/native installations distinct. Do not alter personal/global configuration or fabricate user approval to make a scenario proceed.

| Scenario | Required observation |
| --- | --- |
| Skill and rule loading | User-only invocation policy; actual beginning/end context visibility, not only a rules listing |
| SessionStart and blocking | Genuine startup produces evidence; a harmless test denial preserves the sentinel file and surfaces its reason |
| Human questions | Single and multiple choices, Other, skip, cancellation, and partial answers retain identity and never manufacture approval |
| Plan Approval | Real offered choice and human response certify current content; stale/wrong-session evidence refuses; Stop consultation preserves the challenge; session isolation per the protocol below |
| Native dispatch | Exact profile/task field translation, augmented task content, supported reviewer identity, and no silent inline fallback. Translation and augmentation observed live 2026-09-18 (`native-dispatch-run/`); read the child's received prompt from `sessions.db`, not the parent's tool-call record, which stores pre-merge arguments |
| Background work | Distinguish launch, pending, terminal, repeated read, failure, cancellation, and resume across adapter processes |
| Ensemble modes | Ordered pipeline receipts; support contribution identity; parent-owned human questions; unavailable delegation uses explicit recovery |
| Optional MCP | Disabled defaults expose no server tools; deliberate enablement, header interpolation, permissions, and authenticated behavior checked separately |
| Desktop/platform differences | Record actual host/platform results rather than treating discovery stubs as execution evidence |

If a required contract is unavailable, record BLOCKED with the missing evidence and owner decision. Do not guess child identity or introduce lifecycle counts without a terminal path.

**Plan Approval session-isolation protocol** (executed 2026-09-17; see `evidence/devin-e2e-run/session-isolation-run/`): run the workflow to the Plan Approval prompt in session A and leave it pending. In a second interactive session B in the same project, type `Approve Plan` — no `response-*.json` or receipt may appear under `aidlc/.aidlc-sessions/plan-approval/` for A. Then run `aidlc-log.ts answer --checkpoint plan-approval --session <B>` with the `[Answer]` tag filled as B's conductor would, and confirm the refusal `Plan Approval requires the actual offered choice from this prompt and session`. Approve in A via the native prompt, hash the receipt, `/clear`, resume, and confirm the same receipt path is honored without a new approval prompt; if a re-prompt occurs, record the guard's stated reason before retrying (a missing `AIDLC-STAGE`/`AIDLC-UNIT` marker block is a dispatch translation failure, not an approval one). Only the current session can be exported (`--export` writes it each turn; `/clear` starts a new session), so enable export from the start of every session whose transcript matters.

**Native dispatch acceptance protocol** (executed 2026-09-17/18; see `evidence/devin-e2e-run/native-dispatch-run/`): on a fresh project installed from the rebuilt `dist/devin`, run the express `hello.py` workflow to Plan Approval and approve through the native prompt. The approved `run_subagent → aidlc-developer-agent` must pass on the first attempt with no new `PLAN_APPROVAL_BLOCKED` row, `SUBAGENT_COMPLETED` recorded once, and the receipt at `status: generation`. Read the dispatch from `~/.local/share/devin/cli/sessions.db` (`message_nodes`, read-only copy including `-wal`): the parent's tool-call record stores the emitted, pre-merge arguments (`profile`, `task`, `title` only), and the child's first `user` node must be the conductor's brief followed by exactly one `AIDLC_DISPATCH_RULES_BEGIN … stage:<stage>` block — a parent record without the bundle is not a failure, a child prompt without it is. If a developer dispatch is attempted before approval, its refusal must name the missing approval for the target or, for a marker-less brief, "carries no target marker"; the conductor must not re-present Plan Approval in response. Let the workflow run to `WORKFLOW_COMPLETED` (operation stages may self-skip), then `/clear` and `/aidlc` to check receipt reuse per the session-isolation protocol; the export covers only the current post-compaction context, so snapshot the DB right after dispatch rather than rely on `--export`.

## Maintaining this record

Keep each finding ID stable. On an upgrade, update its baseline and distinguish source inspection, synthetic test results, captured behavior, and unresolved hypotheses. Append a short supersession reason when replacing a workaround. Preserve original capture versions and avoid copying ephemeral local `/tmp` paths into portable evidence claims.

History worth retaining: `c0dc757d` introduced the adapter/live-test scaffolding; `24aa87c1` added the omitted binary probe assertion and removed a tautological roster assertion; `fdaeb521` repaired earlier evidence-path and fixture issues; `6e208f7b` showed why upstream merge validation must cover both legitimate planning and blocking cases. Test names and harness counts are navigation aids, not substitutes for observable assertions.

[Back to findings index](index.md)
