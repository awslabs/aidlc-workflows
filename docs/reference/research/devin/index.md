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
| DEVIN-04 | [Permission scopes and configuration isolation](04-permissions-and-configuration.md) | Implemented defaults; compatibility-import isolation verified live on 3000.6.14/3000.10.21/3000.10.31/3000.11.1; effective host policy remains external |
| DEVIN-05 | [Optional MCP servers and default-off behavior](05-optional-mcp.md) | Implemented configuration; header interpolation proven live on 3000.10.21/3000.10.31; authenticated Context7 call verified on 3000.10.31; AWS launchers not exercised |
| DEVIN-06 | [Hook events, payload translation, and output contracts](06-hook-transport.md) | Implemented transport with explicit payload and enforcement gaps |
| DEVIN-07 | [Ensemble dispatch, reviewer attribution, and subagent lifecycle](07-subagent-lifecycle-and-ensemble.md) | Protocol binding and native dispatch translation accepted live on 3000.10.31; background lifecycle implemented, regression-covered, and accepted live on 3000.10.31 (2026-09-19); reviewer attribution implemented as a foreground reviewer window, regression-covered, and accepted live on 3000.10.31 (2026-09-20, reviewer-scope acceptance); follow-ups F1–F4 open |
| DEVIN-08 | [Structured questions and human-turn recording](08-questions-and-human-turns.md) | Implemented response compatibility; live batch/cancellation authority coverage remains limited |
| DEVIN-09 | [Plan Approval sessions, challenges, responses, and receipts](09-plan-approval-authority.md) | Strict session pairing implemented, regression-covered, and accepted live on 3000.10.31; receipt reuse without re-prompt inconclusive pending DEVIN-07 |
| DEVIN-10 | [Planning commands, shell composition, and working directories](10-shell-guards-and-working-directory.md) | Implemented protections with scoped guarantees |
| DEVIN-11 | [Stop-hook consultation must preserve live approval state](11-stop-hook-observer-safety.md) | Shared observer mechanism implemented and regression-covered |
| DEVIN-12 | [Testing Contract JSON compatibility repair and retirement](12-testing-contract-repair.md) | Temporary shared workaround; vendor fix version unconfirmed |
| DEVIN-13 | [Version baseline, binary discovery, and diagnostic evidence](13-version-support-and-diagnostics.md) | Implemented checks; not a full compatibility certification |
| DEVIN-14 | [Regression and evidence](14-regression-and-evidence.md) | Verification procedure and evidence limitations |

Read DEVIN-01–06 for the integration architecture, DEVIN-07–12 for behavioral boundaries and failures discovered during the port, and DEVIN-13–14 before changing the support baseline or validating an upgrade.

## Open findings that must not be mistaken for completed support

| Finding | Unresolved boundary | Evidence needed to close it |
| --- | --- | --- |
| DEVIN-07 | ~~`runtime-graph.json` is never compiled on Devin: `classifyRuntimeCompileCommand` builds its harness-path pattern from `KNOWN_HARNESS_DIRS`, which omits `.devin`~~ — closed 2026-09-22 (PR #996 review 5248693673 finding 3): `.devin` added to `KNOWN_HARNESS_DIRS` (and the duplicate `aidlc-statusline.ts` list and `HARNESS_DOC_DIRS`), so `.devin` tool and dispatcher commands classify `fire`/`reject` like every other harness; `bun .devin/tools/aidlc-orchestrate.ts report --json` now returns `fire` | Coverage: t226 iterates `KNOWN_HARNESS_DIRS` asserting per-dir transition/read-only/recursion classifications (self-extending for future harnesses); t332 `14a` proves end-to-end `runtime-graph.json` compilation through the adapter's exec→Bash rewrite |
| DEVIN-07 | ~~Reviewer-specific read/search enforcement lacks adapter handling and captured child identity~~ — implemented as the foreground reviewer window (host `profile` + fresh dispatch record; dispatch-time refusals for background reviewers and pending background entries); t332 `Item 4`; accepted live 2026-09-20 (reviewer-scope acceptance, R1–R6 PASS) | Follow-ups from the run: F1 heredoc-body tokens and F4 `cd <root>` are core-scanner false positives that blocked legitimate reviewer writes/commands; F2 a present-but-invalid dispatch record fails open with no signal to the conductor (adapter should refuse); F3 the LLM-authored record drifted after compaction twice — proposal: `aidlc-log review` writes/deletes the record itself. C20 kill/resume and Ctrl+B remain residual |
| DEVIN-07 | Custom-profile children never receive `write` (Phase 0 probes and every review in the reviewer-scope acceptance: 0 child `write` calls); every live reviewer wrote its review via `exec` heredoc, which works but exposes F1 | Fix F1; consider stating the `exec`-heredoc write path in the Devin reviewer prose |
| DEVIN-07 | ~~Background launch is not terminal completion~~ — implemented on 3000.10.31 captures (launch annotates the in-flight entry; terminal forwards a synthesized `SubagentStop` by `agent_id`; repeated reads dedup); post-review hardening 2026-09-22 (review 5248693673 finding 1 residual): an unclassifiable background `run_subagent` output now drops with a log-subagent line instead of minting an id-less completion (foreground fail-open preserved) | Accepted live 2026-09-19 (background-lifecycle acceptance); t332 `Item 3` case 13 covers the drop path; unread/cancelled agents recover by TTL only (documented residual); a failing child was not exercised |
| DEVIN-08 | Unknown/partial/contradictory question responses and first-answer extraction | Batch/cancellation authority tests and fresh interactive hook captures |
| DEVIN-09 | Receipt reuse without re-prompt after a session change | A live run in which `/clear` + resume proceeds on the existing receipt with no new Plan Approval prompt (dispatch fix is in; the native-dispatch acceptance only exercised same-session resume/compaction) |
| DEVIN-12 | Testing Contract repair retirement | Vendor-confirmed fixed version, real write/read regression, supported baseline, and stored-plan migration |
| DEVIN-02, DEVIN-13 | Actual context injection, Desktop execution, current hook approval | Separate host/platform validation; static config or doctor output is insufficient |
| DEVIN-13 | Platform surfaces verified only on this WSL2 host: the Windows `.cmd` PATH shim through the spawned doctor (t331 9/9d; mechanism mirrors t150, never run on native Windows), the macOS Desktop candidate (plausible Electron twin, unverified), and the Linux Desktop candidates (unverified). Windows discovery paths were corrected against a real install on 2026-09-22 | A native Windows run of t331 9/9d; macOS and Linux Devin Desktop installs to inspect — see DEVIN-13's open-questions table |
| DEVIN-05 | ~~Header interpolation behavior~~ — closed 2026-09-21: `${env:VAR}` headers resolve (set → value, unset → empty string) on 3000.6.14/3000.10.21/3000.10.31 (probe; pinned by `t-exec-devin-mcp-headers`). ~~Authenticated MCP behavior~~ — closed 2026-09-21 for Context7 on 3000.10.31: valid key → tool result, unset → anonymous free-tier success, invalid key → `Invalid API key` rejection. The four `uvx` AWS servers remain unexercised | An enabled AWS server resolving its package and authenticating against the credential chain |

These are evidence-qualified findings, not permission to weaken guards or silently change the runtime. This documentation rewrite makes no runtime changes and runs no new live model/Devin/Desktop/MCP sessions.

## Upgrade checklist

1. Record the AI-DLC commit/build, Devin CLI version/build, OS, installation channel, and the exact scenario under test. Check whether the selected package actually includes Devin support.
2. Review the corresponding host release notes and current documentation, keeping the version of old captures intact. Then re-run the cheap non-inference probes against the new binary — `devin skills list` / `devin mcp list` in a scratch project (DEVIN-04 import isolation, DEVIN-05 registry) — before any probe that spends inference. Re-check every behavior recorded as **observed, contrary to docs** (today: `read_config_from` layer precedence user > project > project-local in DEVIN-04; bare `${VAR}` resolving in MCP headers in DEVIN-05): a vendor fix there changes AI-DLC's user guidance, not just a test.
3. Follow each affected finding's regression table. Exercise both legitimate operations and the refusals that protect authority; merely loading a skill or receiving exit 0 is insufficient.
4. Run the deterministic checks in DEVIN-14, then re-run the Devin unit family with `devin` **removed from PATH** (`PATH="$(… filtered …)" bun tests/run-tests.ts --unit --no-llm --filter devin`) — the deterministic tier must stay green without a binary; host-CLI behavior belongs behind `AIDLC_*_LIVE` gates or a `PATH` shim. Record what ran, what failed, what was skipped, and what was not attempted.
5. For changed native contracts, capture fresh sanitized hook input/output in a disposable installation before promoting a claim to live-verified. Do not edit old captures to resemble the new schema.
6. Reassess temporary workarounds against their retirement conditions. Neither a higher version number nor absent warning logs is enough.
7. Update the affected finding's baseline, status, evidence, and history. Do not erase an open gap because an adjacent fix passed.

## Evidence rules

- **Source-verified:** describes executable source or configuration at the baseline, not host execution.
- **Documented by Devin:** cites the published reference or the documentation bundle located through the `devin-cli` skill. Documentation can differ from a captured build, and two pages of the same bundle can disagree with each other (`config-file.mdx` lists three `read_config_from` keys, `read-config-from.mdx` seven); record both instead of selecting whichever is convenient.
- **Executed on the binary:** the installed CLI was driven and its output or wire behavior observed, with the build(s) named. This is the only class that decides what AI-DLC ships when documentation, a review comment, and the binary disagree — the review comment and the documentation are claims to be graded, not authority. Prefer probes that spend no inference (`devin skills list`, `devin mcp list`, a local header-capture server) and neutralise the user layer (`XDG_CONFIG_HOME` / `%APPDATA%` to a scratch dir) so the machine's own configuration cannot flip the result. Record the discrepancy and the builds, not just the winning answer.
- **Captured:** original hook stdin/output with provenance. The retained S02 fixture is sanitized and version-scoped.
- **Session-export evidence:** records what the agent/tool conversation exposed; not automatically an independent capture of hook stdin.
- **Synthetic regression:** tests a supplied shape or state. It proves only its assertions, not that the current host emits that shape.
- **Historical result:** belongs to its recorded revision, environment, and intervention history. A skip, environment blocker, modified log, or manually seeded approval is not a fresh live PASS.

The old frontmatter-revert `.log` explicitly warned that version text had been edited afterward. Its historical content remains in Git, but it is not preserved here as authoritative current-build test evidence. Under PR #996 Item 9 the campaign's top-level `README.md` and `HARNESS-REQUIREMENTS.md` were removed from `evidence/devin-e2e-run/`, and the historical `first-run/`–`fourth-run/` subdirectories remain absent from HEAD (Git history only). The owner then explicitly retained the four latest attended-run directories — `session-isolation-run/`, `native-dispatch-run/`, `background-lifecycle-run/`, `reviewer-scope-run/` (152 files / 2,885,101 bytes) — as a grandfathered exception to the minimal-evidence policy; the compact results, limits, and rerun protocols live in DEVIN-07, DEVIN-09, and DEVIN-14. The deterministic captures are the minimal, version-scoped fixtures in `tests/fixtures/devin-hook-payloads/` (`native-contracts-3000.10.31.json` + provenance, `payloads.json`, `s02-stop-gate-contract.md`).

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

Every PR #996 standalone review-item plan has been folded into the permanent findings and removed from the tree: Items 1–4 into DEVIN-07/09/14, Item 5 into DEVIN-05/14, Item 6 into DEVIN-04/14, Item 7 into DEVIN-13/14, and Item 9 into DEVIN-14 — including its fixture-reduction, evidence-policy, and history-boundary knowledge and the later owner override that retains the four latest attended-run directories. The tracked historical plans for Items 1–6 remain recoverable in Git history from their implementation commits — `8bbdb928`, `661527fa`, `75ce0ebf`, `9d38c245`, `ffc69f83`, and `79cf8498` — if archaeology is needed. Item 9's plan was untracked and was deleted only after its measurements, decisions, result, and history boundary were folded into DEVIN-14; it has no Git recovery path.

Old per-fix release-number recipes are intentionally omitted. Follow the current repository Release Metadata Policy: feature, fix, documentation, refactor, and test changes do not independently bump the framework version; explicit release preparation owns synchronized version/badge/changelog updates.

## Related documentation

- [AI-DLC on Devin CLI](../../../guide/harnesses/devin.md)
- [Porting to a new harness](../../../harness-engineering/09-porting-to-a-new-harness.md)
- [Testing strategy](../../09-testing.md)
- [Plugin mechanism](../../18-plugin-mechanism.md)
