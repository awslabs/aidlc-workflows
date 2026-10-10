# Skills, ambient rules, and onboarding

**Finding:** DEVIN-02. **Status:** Implemented; host injection limits documented in the 3000.11.3 bundle, effective threshold unmeasured. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12; injection limits 2026-10-10.

## Why this was needed

Devin needed to discover AI-DLC's orchestrator and explicit runners without allowing ordinary model skill selection to start workflow-mutating entry points. It also needed concise ambient guidance without duplicating the engine-owned method tree.

## Current implementation

The root orchestrator is `.devin/skills/aidlc/SKILL.md`, explicitly user-triggered. Generated stage, initialization, scope, and composition runners receive `triggers: [user]` through `runnerFrontmatterAdditions`, which is also available to installed runner regeneration. `aidlc-knowledge` and `aidlc-outcomes-pack` receive explicit user-only metadata; the read-only reporting skills retain their authored metadata.

This is invocation policy, not a requirement to make a skill discoverable. Devin's creating-skills documentation gives the default triggers as `[user, model]`. The manifest comment claiming a missing triggers line makes slash invocation impossible is not supported by that documented default; this rewrite does not edit runtime-source comments.

`rules-aidlc.md` emits `.devin/rules/aidlc.md` with `trigger: always_on`. The loaded rule names the active-space memory directory; it does not import those files. Since the `b8d9bdc3` merge it also names `aidlc/active-memory/` — the engine's git-ignored copy of the active space's memory — as readable, while edits go only to `aidlc/spaces/<active-space>/memory/`. Actual method delivery belongs to the engine's resolver and load-steering protocol. Skill `triggers` and rule `trigger` are different fields.

Upstream's harness-neutral skill changes were ported to Devin's `SKILL.md` and `question-rendering.md` (`ea936ecb`, 2026-10-09): for example the engine now emits nine directive kinds including `notice`. `composer.md` now ships as `.devin/skills/aidlc/composer.md`. Upstream also retired the per-harness "fresh session" hand-off text (`aidlc-runner-gen.ts` `freshSessionFlow` removed); "exit or restart Devin CLI and start a new session" survives only in t123's `RETIRED_FRESH_SESSION_TEXT` as retired wording.

Onboarding is split: root `AGENTS.md` renders from `core/templates/onboarding.md` and is byte-identical across the harnesses that share it, while the Devin onboarding rule `.devin/rules/aidlc-onboarding.md` renders from `core/templates/onboarding-harness.md` with `harness/devin/onboarding.fills.ts` — the fills gained upstream's "Show AI-DLC's questions and choices…" paragraph in the same pass. t331 currently enforces at most 16,384 UTF-8 bytes on that Devin onboarding rule, no duplicated DocumentKB section, and no blanket claim of identical behavior across harnesses. The old 12 KiB proposal is not the current test limit.

No custom statusline is wired for Devin. `/aidlc --status` is the on-demand alternative; injecting display text into model context is not an equivalent persistent user-visible status strip.

## Evidence and limits

The project-owned byte limit does not prove complete host injection under every configuration. The 3000.11.3 documentation bundle now documents the host mechanism: always-on rule files are capped at 32 KiB each, with oversized ones truncated alongside a source-path hint (`changelog/stable.mdx:743`, v2026.4.17-0), and triggered rules that exceed the available context budget switch to path-only guidance (`stable.mdx:655`, v2026.4.24-1). The current always-on set at `4ed211f6` totals 25,666 bytes before user rules — root `AGENTS.md` 7,866, `.devin/rules/aidlc-onboarding.md` 15,229, `.devin/rules/aidlc.md` 2,571 — every file under the per-file cap. The PR #996 reviewer measured an `AGENTS.md` truncated at 15,309 of 19,908 bytes on 3000.6.7; that figure is external and unverified here, and the documented limits are 3000.11.3's, not that build's. Rule listing and source-file size alone do not prove what reached the model.

The authored orchestrator still contains statements such as ordinary `next` mutating nothing; current engine publication can update runtime metadata. Only explicit observer modes have the narrower write-free consultation contract described in DEVIN-11. Research must not copy the orchestrator sentence as an implementation fact.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Runner regeneration | Mutating runners stay user-only after packaging and regeneration | t331 pins packaged metadata; aidlc-runner-gen consumes it; exercise installed regeneration separately |
| Rule activation | Pointer is always-on, contains navigation, and does not inline memory | t331 rules and pointer tests; live injection NOT RUN |
| Onboarding growth | Rendered UTF-8 byte size stays within the current project limit and key guidance remains | t331 tests 7b–7d; not proof of host truncation behavior |
| Actual context delivery after a host update | In a disposable installation, beginning/end sentinels and required rules are visible in injected context; each always-on file stays under the documented 32 KiB cap and triggered rules inject rather than degrading to path-only guidance | Manual verification gap; test with and without substantial global rules |
| Status behavior | Status is available on demand; no claim of a Devin custom statusline or complete Claude usage ledger | DEVIN-06 and DEVIN-14 |

## Superseded approaches and history

`801507ad` added invocation metadata, explicit rule activation, and onboarding reduction. Subsequent upstream template growth changed the project's size pin from the earlier 12 KiB target to 16 KiB.

Retired explanations: all rule files automatically activate regardless of trigger; a path pointer imports its target; user-invocable alone means model-disabled; explicit triggers are inherently needed for slash invocation; a byte-size check proves no truncation. Preserve the distinction between source policy and observed host behavior.

## Sources

- `harness/devin/manifest.ts` — runnerFrontmatterAdditions, frontmatterAdditions
- `harness/devin/rules-aidlc.md`
- `harness/devin/onboarding.fills.ts`
- `harness/devin/skills/aidlc/SKILL.md`
- `harness/devin/skills/aidlc/composer.md`
- `core/templates/onboarding.md`
- `core/templates/onboarding-harness.md`
- `core/tools/aidlc-runner-gen.ts`
- `tests/unit/t331-devin-packaging.test.ts` — tests 6, 7b–7d, 14–18
- https://docs.devin.ai/cli/extensibility/skills/creating-skills
- https://docs.devin.ai/cli/extensibility/rules

[Back to findings index](index.md)
