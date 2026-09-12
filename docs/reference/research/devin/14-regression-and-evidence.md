# Regression coverage, historical evidence, and upgrade verification

**Finding:** DEVIN-14. **Status:** verification procedure and evidence limitations. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

The port repeatedly exposed the difference between a configured integration, a green synthetic test, and a working human workflow. The regression record must make those boundaries visible rather than turn every historical PASS into a current support claim.

## Retained evidence and its limits

| Evidence | What it records | What it does not prove |
| --- | --- | --- |
| `tests/fixtures/devin-hook-payloads/captured-3000.6.14.json` with `capture-provenance.json` | Sanitized raw hook captures from the documented build; foreground/background dispatch, reads/writes, lifecycle fields, missing child identity | Current-build behavior; answered C07/C08 envelopes; separately captured cancel/fail/resume lifecycle |
| `tests/fixtures/devin-hook-payloads/payloads.json` | Synthetic/compatibility inputs used by adapter tests | That the host emitted every field or shape |
| `evidence/devin-e2e-run/first-run/SUMMARY.md` and associated artifacts | Historical headless workflow experiment; summary discloses permissive mode, auto-handled gates, manually created approval evidence, and no subagent test | Genuine native human approval or complete delegated workflow acceptance |
| `evidence/devin-e2e-run/second-run/` | Interactive run recorded as blocked at Plan Approval after response-recording problems | A successful full workflow or a current-build reproduction |
| `evidence/devin-e2e-run/third-run/` | Another blocked run showing the first response-wrapper fix was insufficient | That all later fixes or all response shapes were verified |
| `evidence/devin-e2e-run/fourth-run/` | Retained session exports, including native question schema/response observations used during later fixes | A blanket all-topology PASS or an independent raw hook capture for every tool result |
| Former frontmatter-revert log | Historical test narrative with an explicit notice of edited version text, recoverable in Git | Untouched raw evidence or a rerun on the newer baseline |

Leave existing evidence outside this research directory unchanged. Interpret summaries alongside their raw artifacts and disclosed interventions; summaries can contain diagnoses later corrected by source inspection.

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
| Adapter subprocess behavior | t332 | Native dispatch translation, reviewer attribution, and terminal lifecycle gaps in DEVIN-07 |
| Ensemble binding | t333 source-contract assertions | Real participation, contribution artifacts, pipeline receipts, and failure recovery |
| Version and diagnostics | t334, t294, t331/t332 SessionStart cases | Desktop execution, actual model selection, current hook approval |
| Plan Approval and shell safety | t265 and shared authority tests | Native field transport and current-session fallback isolation |
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
| Plan Approval | Real offered choice and human response certify current content; stale/wrong-session evidence refuses; Stop consultation preserves the challenge |
| Native dispatch | Exact profile/task field translation, augmented task content, supported reviewer identity, and no silent inline fallback |
| Background work | Distinguish launch, pending, terminal, repeated read, failure, cancellation, and resume across adapter processes |
| Ensemble modes | Ordered pipeline receipts; support contribution identity; parent-owned human questions; unavailable delegation uses explicit recovery |
| Optional MCP | Disabled defaults expose no server tools; deliberate enablement, header interpolation, permissions, and authenticated behavior checked separately |
| Desktop/platform differences | Record actual host/platform results rather than treating discovery stubs as execution evidence |

If a required contract is unavailable, record BLOCKED with the missing evidence and owner decision. Do not guess child identity or introduce lifecycle counts without a terminal path.

## Maintaining this record

Keep each finding ID stable. On an upgrade, update its baseline and distinguish source inspection, synthetic test results, captured behavior, and unresolved hypotheses. Append a short supersession reason when replacing a workaround. Preserve original capture versions and avoid copying ephemeral local `/tmp` paths into portable evidence claims.

History worth retaining: `c0dc757d` introduced the adapter/live-test scaffolding; `24aa87c1` added the omitted binary probe assertion and removed a tautological roster assertion; `fdaeb521` repaired earlier evidence-path and fixture issues; `6e208f7b` showed why upstream merge validation must cover both legitimate planning and blocking cases. Test names and harness counts are navigation aids, not substitutes for observable assertions.

[Back to findings index](index.md)
