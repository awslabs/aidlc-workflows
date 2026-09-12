# Devin harness: implementation findings and upgrade history

This is the engineering record of what was needed to add Devin CLI to AI-DLC, what is implemented, which attempts were superseded, and what still needs evidence. It replaces the chronological working plans, not the original capture evidence. It is not an instruction to execute an old implementation plan or bypass an approval gate.

**Source baseline:** `6e208f7b` on `feat/devin-harness` (PR #996). **Fact-check date:** 2026-09-12. **Selected Devin support floor:** `3000.10.21`. Historical host captures include older builds, particularly `3000.6.14`; they are not relabelled as current-build observations. This baseline includes the local merge of upstream `main`; it is not a claim that a released package contains the branch.

## How the port fits together

AI-DLC keeps the deterministic workflow engine and methodology in `core/`. The Devin manifest projects that source and adds the native skill, rules pointer, configuration, and hook adapter. The adapter bridges host events to the core's internal hook interface. The parent conductor runs engine directives, delegates named profiles, and presents human questions. The engine—not UI text or a successful hook process alone—owns workflow state and approval authority.

Four distinctions are essential:

- **Host requirement versus AI-DLC policy:** for example, the native hook format is a host contract; user-only runners and the selected version floor are AI-DLC choices.
- **Implemented versus intended:** a protocol instruction or configured hook does not prove its adapter path works with native payloads.
- **Regression test versus live evidence:** deterministic fixtures, raw hook captures, session exports, and historical summaries have different evidentiary scope.
- **Current workaround versus superseded attempt:** temporary compatibility behavior needs removal criteria; abandoned recipes belong in Git history, not current instructions.

## Findings and reading order

| Finding | Topic | Status |
| --- | --- | --- |
| DEVIN-01 | [Distribution, installation, and packaging](01-distribution-and-packaging.md) | Implemented; live native/plugin acceptance remains separate |
| DEVIN-02 | [Skills, ambient rules, and onboarding](02-skills-rules-and-onboarding.md) | Implemented; context-injection limits require host verification |
| DEVIN-03 | [Agent profiles, model selection, and tool restrictions](03-agent-profiles-models-and-tools.md) | Implemented for shipped core profiles; effective model and plugin policy not inferred |
| DEVIN-04 | [Permission scopes and configuration isolation](04-permissions-and-configuration.md) | Implemented defaults; effective host policy remains external |
| DEVIN-05 | [Optional MCP servers and default-off behavior](05-optional-mcp.md) | Implemented configuration; authenticated connections not verified |
| DEVIN-06 | [Hook events, payload translation, and output contracts](06-hook-transport.md) | Implemented transport with explicit payload and enforcement gaps |
| DEVIN-07 | [Ensemble dispatch, reviewer attribution, and subagent lifecycle](07-subagent-lifecycle-and-ensemble.md) | Protocol binding implemented; adapter acceptance incomplete |
| DEVIN-08 | [Structured questions and human-turn recording](08-questions-and-human-turns.md) | Implemented response compatibility; live batch/cancellation authority coverage remains limited |
| DEVIN-09 | [Plan Approval sessions, challenges, responses, and receipts](09-plan-approval-authority.md) | Shared authority implemented; fallback isolation needs explicit regression evidence |
| DEVIN-10 | [Planning commands, shell composition, and working directories](10-shell-guards-and-working-directory.md) | Implemented protections with scoped guarantees |
| DEVIN-11 | [Stop-hook consultation must preserve live approval state](11-stop-hook-observer-safety.md) | Shared observer mechanism implemented and regression-covered |
| DEVIN-12 | [Testing Contract JSON compatibility repair and retirement](12-testing-contract-repair.md) | Temporary shared workaround; vendor fix version unconfirmed |
| DEVIN-13 | [Version baseline, binary discovery, and diagnostic evidence](13-version-support-and-diagnostics.md) | Implemented checks; not a full compatibility certification |
| DEVIN-14 | [Regression and evidence](14-regression-and-evidence.md) | Verification procedure and evidence limitations |

Read DEVIN-01–06 for the integration architecture, DEVIN-07–12 for behavioral boundaries and failures discovered during the port, and DEVIN-13–14 before changing the support baseline or validating an upgrade.

## Open findings that must not be mistaken for completed support

| Finding | Unresolved boundary | Evidence needed to close it |
| --- | --- | --- |
| DEVIN-07 | Native `profile`/`task` dispatch translation and rule augmentation are incomplete | Realistic field-contract tests through the adapter, then current-host dispatch evidence |
| DEVIN-07 | Reviewer-specific read/search enforcement lacks adapter handling and captured child identity | Supported identity contract plus native read/search/notebook boundary tests |
| DEVIN-07 | Background launch is not terminal completion; poll exclusion is not lifecycle tracking | Capture-backed persistent lifecycle and restart/repeated-read tests |
| DEVIN-08 | Unknown/partial/contradictory question responses and first-answer extraction | Batch/cancellation authority tests and fresh interactive hook captures |
| DEVIN-09 | Current-session fallback isolation | Explicit intended-fallback and concurrent-session negative cases |
| DEVIN-12 | Testing Contract repair retirement | Vendor-confirmed fixed version, real write/read regression, supported baseline, and stored-plan migration |
| DEVIN-02, DEVIN-05, DEVIN-13 | Actual context injection, authenticated MCP/header behavior, Desktop execution, current hook approval | Separate host/platform validation; static config or doctor output is insufficient |

These are evidence-qualified findings, not permission to weaken guards or silently change the runtime. This documentation rewrite makes no runtime changes and runs no new live model/Devin/Desktop/MCP sessions.

## Upgrade checklist

1. Record the AI-DLC commit/build, Devin CLI version/build, OS, installation channel, and the exact scenario under test. Check whether the selected package actually includes Devin support.
2. Review the corresponding host release notes and current documentation, keeping the version of old captures intact.
3. Follow each affected finding's regression table. Exercise both legitimate operations and the refusals that protect authority; merely loading a skill or receiving exit 0 is insufficient.
4. Run the deterministic checks in DEVIN-14. Record what ran, what failed, what was skipped, and what was not attempted.
5. For changed native contracts, capture fresh sanitized hook input/output in a disposable installation before promoting a claim to live-verified. Do not edit old captures to resemble the new schema.
6. Reassess temporary workarounds against their retirement conditions. Neither a higher version number nor absent warning logs is enough.
7. Update the affected finding's baseline, status, evidence, and history. Do not erase an open gap because an adjacent fix passed.

## Evidence rules

- **Source-verified:** describes executable source or configuration at the baseline, not host execution.
- **Documented by Devin:** cites the published reference or the documentation bundle located through the `devin-cli` skill. Documentation can differ from a captured build; record both instead of selecting whichever is convenient.
- **Captured:** original hook stdin/output with provenance. The retained S02 fixture is sanitized and version-scoped.
- **Session-export evidence:** records what the agent/tool conversation exposed; not automatically an independent capture of hook stdin.
- **Synthetic regression:** tests a supplied shape or state. It proves only its assertions, not that the current host emits that shape.
- **Historical result:** belongs to its recorded revision, environment, and intervention history. A skip, environment blocker, modified log, or manually seeded approval is not a fresh live PASS.

The old frontmatter-revert `.log` explicitly warned that version text had been edited afterward. Its historical content remains in Git, but it is not preserved here as authoritative current-build test evidence. Original captures and `evidence/devin-e2e-run/` are untouched.

## Historical source map

The following former files are recoverable from baseline `6e208f7b`. Names in this table are historical identifiers, not links to current files. Recover a source with:

```bash
git show 6e208f7b:docs/reference/research/devin/devin-harness-port-plan.md
```

| Former source | Findings |
| --- | --- |
| devin-harness-port-plan.md | DEVIN-01–07 |
| devin-adapter-ask-user-question-fix-plan.md | DEVIN-08–09 |
| devin-ensemble-binding-fix-plan.md | DEVIN-03, DEVIN-07 |
| devin-doctor-hook-evidence-plan.md | DEVIN-13 |
| devin-mcp-opt-in-plan.md | DEVIN-05 |
| devin-persona-frontmatter-projection-revert-plan.md | DEVIN-03 |
| devin-persona-frontmatter-projection-revert-unit.log | DEVIN-14 (edited historical log, not raw evidence) |
| devin-subagent-model-and-tools-plan.md | DEVIN-03–04 |
| devin-version-floor-unification-plan.md | DEVIN-13 |
| handoff-run-real-devin-session.md | DEVIN-01, DEVIN-13–14 |
| handoff-run-real-devin-session-notes.md | DEVIN-07–12, DEVIN-14 |
| human-turn-not-written-on-ask-user-question-fix-plan.md | DEVIN-08–09, DEVIN-11 |
| plan-approval-compound-git-bypass-fix-plan.md | DEVIN-10 |
| plan-approval-guard-traps-conductor-fix-plan.md | DEVIN-10 |
| pr-996-devin-review-fixes.TEMP.md | DEVIN-01–14 |
| pr-996-handoff-s02.md | DEVIN-06–08, DEVIN-14 |
| pr-996-review-fixes-implementation-plan.md | DEVIN-01–14 |
| pr-996-review-fixes-testing-plan.md | DEVIN-14 and topic regression tables |
| pr1-post-merge-fix-plan.md | DEVIN-01, DEVIN-14 |
| pre-existing-test-failures-fix-plan.md | DEVIN-14 |
| question-rendering-core-extraction-plan.md | DEVIN-08 |
| stop-hook-read-only-probe-plan.md | DEVIN-11 |
| testing-contract-repair-observability-plan.md | DEVIN-12 |

Old per-fix release-number recipes are intentionally omitted. Follow the current repository Release Metadata Policy: feature, fix, documentation, refactor, and test changes do not independently bump the framework version; explicit release preparation owns synchronized version/badge/changelog updates.

## Related documentation

- [AI-DLC on Devin CLI](../../../guide/harnesses/devin.md)
- [Porting to a new harness](../../../harness-engineering/09-porting-to-a-new-harness.md)
- [Testing strategy](../../09-testing.md)
- [Plugin mechanism](../../18-plugin-mechanism.md)
