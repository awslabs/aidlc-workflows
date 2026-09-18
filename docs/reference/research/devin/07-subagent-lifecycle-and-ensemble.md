# Ensemble dispatch, reviewer attribution, and subagent lifecycle

**Finding:** DEVIN-07. **Status:** Protocol binding implemented; native dispatch translation implemented, regression-covered, and accepted live on Devin CLI 3000.10.31 (2026-09-18, full workflow completed); reviewer attribution and background lifecycle still open. **Source baseline:** `3baf4d54` plus uncommitted Item 2 fix. **Fact-checked:** 2026-09-18.

## Why this was needed

Adding Devin to the packaging roster did not tell the conductor how to execute subagent, pipeline, or mob topologies. Correct specialist dispatch also requires task translation, rule delivery, trustworthy reviewer attribution, and completion evidence—not just a native tool call.

## Current implementation

The shared ensemble protocol now has a Devin binding and the Devin orchestrator requires dispatched topologies to dispatch rather than silently run inline. The parent selects a named profile, coordinates participants, reads returned work, and owns questions. Foreground dependencies are sequential; parallel supports use background dispatch. Contribution files and pipeline-link receipts remain engine evidence, separate from SUBAGENT_COMPLETED telemetry.

The observed native dispatch fields are profile, task, is_background, and title. The adapter now normalizes `run_subagent` input through `normalizeRunSubagentInput` — `profile` to `subagent_type`, `task` to `prompt`, `is_background` to `run_in_background` — for both PreToolUse arms. The Plan Approval arm forwards the real `task` brief, so an approved developer dispatch is judged on the conductor's actual markers; legacy `agent`/`prompt` reads were dropped (no capture or live run ever produced them). Before the fix, the 2026-09-17 attended run reproduced the mismatch live on 3000.10.31: the conductor placed `AIDLC-STAGE: code-generation` and `AIDLC-TESTING-CONTRACT: …` at the top of `task`, the adapter forwarded an empty `prompt`, and the guard refused every developer dispatch with `(missing marker)` despite a valid receipt (`evidence/devin-e2e-run/session-isolation-run/09-run-subagent-task-field.txt`). The guard's zero-marker refusal text now names the actual defect ("carries no target marker") instead of claiming the plan is unapproved, so a conductor is no longer misdirected into re-presenting Plan Approval.

Stage-rule delivery now normalizes the native input before piping to the shared hook, so `profile` resolves as the agent identity (the core still scans `subagent_type`/`agent_type`/`agent`/`role`; the adapter owns the alias). The core's `updatedInput` rewrite is translated back to a Devin-native `{task}`-only subset — Devin merges `updatedInput` into the tool arguments — so the active-stage bundle lands inside the brief field Devin actually sends, and the injected aliases never reach the host. Devin applying a `task` rewrite to `run_subagent` was observed live on 3000.10.31 (2026-09-18, `evidence/devin-e2e-run/native-dispatch-run/`): the child received the brief plus one bundle while the parent-side record kept the pre-merge arguments.

The reviewer-scope adapter handles exec, edit/write, and patch branches, but read, grep, glob, and notebook_read fall through to allow. Captured child events also lack profile/agent_type/agent_id. The core's reviewer-specific read bound requires attributable identity. General unit-scoped write checks and other workflow guards are separate; neither fixes this reviewer-read attribution gap.

log-subagent calls the shared completion hook for every run_subagent PostToolUse; read_subagent is neither registered nor handled by that target. The core emits a completion row for a running workflow and defaults absent agent_type to unknown. A captured background launch acknowledgement is not completion. `is_background` is now translated to the core's `run_in_background` field, but only as a field mapping — whether the resulting in-flight bookkeeping is ever cleared correctly is unverified lifecycle work, not claimed here. Poll exclusion is not a persistent lifecycle design.

## Evidence and limits

t333 pins binding prose and must-dispatch instructions. t332's completion test uses a synthetic completion-shaped payload. Neither establishes the launch→pending→terminal lifecycle or native per-reviewer read enforcement.

C04–C06 and C09 document foreground/background payloads and missing child identity on 3000.6.14. Cancel/fail/resume were not captured. A new host may change these contracts: preserve the old captures and record new ones separately.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Profile/task dispatch | Native task reaches the core approval check unchanged and generated rule updates target the native task field | Implemented: t332 `Item 2` cases 1-5 (approved dispatch allows, unapproved/no-marker/legacy variants block or allow correctly). Live (`evidence/devin-e2e-run/native-dispatch-run/`, 2026-09-18): the approved `run_subagent → aidlc-developer-agent` passed on the first attempt with `PLAN_APPROVAL_BLOCKED` = 0, the receipt moved to `generation`, and the `hello.py` workflow ran to `WORKFLOW_COMPLETED` (the pre-fix run on the same build recorded 7 `(missing marker)` blocks and never left code-generation) |
| Profile identity and rule injection | A named AI-DLC profile receives the exact rule bundle; unrelated profiles remain untouched | Implemented: t332 `Item 2` cases 6-10 (`{task}`-only rewrite, idempotent, built-in and exempt profiles untouched). Live: the child received the conductor's native `task` plus exactly one `AIDLC_DISPATCH_RULES_BEGIN … stage:code-generation` bundle, while the parent's recorded arguments kept only `profile`/`task`/`title` — first observation that Devin merges a `PreToolUse` `updatedInput.task` into `run_subagent`. Caveat: the parent-side tool-call record stores the pre-merge arguments, so only the child's received prompt evidences the rewrite. Built-in-profile passthrough was not exercised live |
| Reviewer read/search boundary | Supported identity distinguishes reviewer from conductor; all native read/search/notebook paths are handled | OPEN: missing attribution and adapter branches; no invented identity heuristic |
| Background lifecycle | Launch is pending, actual terminal completion is recorded once, repeated reads add nothing, interruption/restart remains consistent | OPEN: persistent completion/identity contract needed; current poll exclusion is insufficient |
| Topology outputs | Supports write contributions, pipeline links produce current-attempt receipts, parent handles human questions | t333 is prose coverage; live all-topology acceptance NOT RUN by this rewrite |

### Native dispatch translation contract (upgrade checklist)

When Devin changes its `run_subagent` argument shape, or the core dispatch hooks change the fields they read or rewrite, the contract to keep is: the adapter is the only place that knows Devin's field names. Inbound, `profile` is the sole identity and `task` the sole brief (`profile`→`subagent_type`, `task`→`prompt`, `is_background`→`run_in_background`; legacy `agent`/`prompt` are not read). Outbound, a stage-rule rewrite is emitted as the smallest Devin-native subset, `updatedInput: { task }` only — never `prompt`, `subagent_type`, or `run_in_background` — relying on Devin's documented subset merge; a host that replaced arguments wholesale would drop `profile` and fail visibly, which is preferable to running the wrong profile silently. The rewrite source is whichever core field differs from the original task: the core's `withPrompt` writes into `prompt` first, so a translation that reads only `updated.task` silently discards the bundle. The shared guard's zero-marker refusal must name the malformed handoff and tell the conductor not to re-present a recorded Plan Approval; the audit `Unit: (missing marker)` value stays.

The deterministic cases to keep green live in t332 under `Item 2`: approved stage-level dispatch with markers in native `task` allows and adds no `PLAN_APPROVAL_BLOCKED` row; the same brief without approval blocks with the one-target wording and audit `Unit: stage:code-generation`; a developer `task` with no marker blocks with "carries no target marker" and never "not currently approved"; non-developer and legacy-field payloads are allowed early; rule delivery for an AI-DLC profile emits a `{task}`-only `updatedInput` with exactly one bundle (also with `is_background: true`); built-in and `EXEMPT_AGENTS` profiles and an already-bundled `task` produce empty stdout; a core exit 2 is forwarded; malformed stdin is fail-open. t265 pins the zero-marker and several-target wording. The t332 seeding helper must stamp `state_sha256` with `stateDigest(state)` (as t149 does), otherwise the seeded directive is stale and the guard refuses before ever evaluating the dispatch.

Residual limitations: `is_background` translation makes the core start marking Devin background dispatches in-flight, and whether that bookkeeping is cleared correctly is the open background-lifecycle row; child tool calls still carry no identity, so reviewer attribution stays open.

## Superseded approaches and history

`10a0fbd0` added the missing binding; `d7ad958e` added binding parity tests. S02 captures in `0d7f63f9` exposed the separate dispatch, identity, and lifecycle gaps. They must not disappear from the findings merely because later prose work landed.

Superseded: profile selection alone makes both core dispatch hooks fully compatible; a background launch can stand in for completion; ignoring read_subagent is completion deduplication; absent child identity can be guessed from tool_use_id prefixes; a hook registration proves reviewer read enforcement. The older instruction that status reconciles stuck background bookkeeping has no established repair contract here.

## Sources

- `core/aidlc-common/protocols/stage-protocol-ensemble.md` — Devin binding, contribution and pipeline evidence
- `harness/devin/skills/aidlc/SKILL.md` — must-dispatch instruction
- `harness/devin/hooks/aidlc-devin-adapter.ts` — plan-approval-guard, deliver-stage-rules, reviewer-scope, log-subagent
- `core/hooks/aidlc-deliver-stage-rules.ts` — augmentSingleDispatch, promptText, withPrompt, recordAcceptedBackgroundDispatch
- `core/hooks/aidlc-reviewer-scope.ts` — candidateStrings, identity check
- `core/hooks/aidlc-log-subagent.ts`
- `tests/fixtures/devin-hook-payloads/capture-provenance.json` — C04–C06, C09
- `tests/fixtures/devin-hook-payloads/s02-stop-gate-contract.md`
- `tests/unit/t333-ensemble-harness-bindings.test.ts`
- `tests/unit/t332-devin-adapter.test.ts`
- https://docs.devin.ai/cli/subagents

[Back to findings index](index.md)
