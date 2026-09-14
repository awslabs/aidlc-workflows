# Ensemble dispatch, reviewer attribution, and subagent lifecycle

**Finding:** DEVIN-07. **Status:** Protocol binding implemented; adapter acceptance incomplete. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

Adding Devin to the packaging roster did not tell the conductor how to execute subagent, pipeline, or mob topologies. Correct specialist dispatch also requires task translation, rule delivery, trustworthy reviewer attribution, and completion evidence—not just a native tool call.

## Current implementation

The shared ensemble protocol now has a Devin binding and the Devin orchestrator requires dispatched topologies to dispatch rather than silently run inline. The parent selects a named profile, coordinates participants, reads returned work, and owns questions. Foreground dependencies are sequential; parallel supports use background dispatch. Contribution files and pipeline-link receipts remain engine evidence, separate from SUBAGENT_COMPLETED telemetry.

The observed native dispatch fields are profile, task, is_background, and title. Current Plan Approval translation chooses legacy agent before profile and forwards only prompt, defaulting it to an empty string; it does not map native task to prompt. This is a source/capture mismatch, not a newly reproduced live failure on 3000.10.21.

Stage-rule delivery only renames run_subagent to Task. The core accepts task as a text field, but augmentSingleDispatch selects identity from subagent_type, agent_type, agent, or role—not profile. A captured-style profile-only dispatch therefore has no recognized AI-DLC agent identity for that augmentation. Do not claim automatic rule injection is complete because the matcher fires.

The reviewer-scope adapter handles exec, edit/write, and patch branches, but read, grep, glob, and notebook_read fall through to allow. Captured child events also lack profile/agent_type/agent_id. The core's reviewer-specific read bound requires attributable identity. General unit-scoped write checks and other workflow guards are separate; neither fixes this reviewer-read attribution gap.

log-subagent calls the shared completion hook for every run_subagent PostToolUse; read_subagent is neither registered nor handled by that target. The core emits a completion row for a running workflow and defaults absent agent_type to unknown. A captured background launch acknowledgement is not completion. is_background is also not translated to the core's run_in_background field for in-flight bookkeeping. Poll exclusion is not a persistent lifecycle design.

## Evidence and limits

t333 pins binding prose and must-dispatch instructions. t332's completion test uses a synthetic completion-shaped payload. Neither establishes the launch→pending→terminal lifecycle or native per-reviewer read enforcement.

C04–C06 and C09 document foreground/background payloads and missing child identity on 3000.6.14. Cancel/fail/resume were not captured. A new host may change these contracts: preserve the old captures and record new ones separately.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Profile/task dispatch | Native task reaches the core approval check unchanged and generated rule updates target the native task field | OPEN: current translation does not satisfy the captured-field contract |
| Profile identity and rule injection | A named AI-DLC profile receives the exact rule bundle; unrelated profiles remain untouched | OPEN: profile alias is not consumed by current core augmentation |
| Reviewer read/search boundary | Supported identity distinguishes reviewer from conductor; all native read/search/notebook paths are handled | OPEN: missing attribution and adapter branches; no invented identity heuristic |
| Background lifecycle | Launch is pending, actual terminal completion is recorded once, repeated reads add nothing, interruption/restart remains consistent | OPEN: persistent completion/identity contract needed; current poll exclusion is insufficient |
| Topology outputs | Supports write contributions, pipeline links produce current-attempt receipts, parent handles human questions | t333 is prose coverage; live all-topology acceptance NOT RUN by this rewrite |

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
