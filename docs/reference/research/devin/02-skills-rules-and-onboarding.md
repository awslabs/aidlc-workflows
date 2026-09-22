# Skills, ambient rules, and onboarding

**Finding:** DEVIN-02. **Status:** Implemented; context-injection limits require host verification. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

Devin needed to discover AI-DLC's orchestrator and explicit runners without allowing ordinary model skill selection to start workflow-mutating entry points. It also needed concise ambient guidance without duplicating the engine-owned method tree.

## Current implementation

The root orchestrator is `.devin/skills/aidlc/SKILL.md`, explicitly user-triggered. Generated stage, initialization, scope, and composition runners receive `triggers: [user]` through `runnerFrontmatterAdditions`, which is also available to installed runner regeneration. `aidlc-knowledge` and `aidlc-outcomes-pack` receive explicit user-only metadata; the read-only reporting skills retain their authored metadata.

This is invocation policy, not a requirement to make a skill discoverable. Devin's creating-skills documentation gives the default triggers as `[user, model]`. The manifest comment claiming a missing triggers line makes slash invocation impossible is not supported by that documented default; this rewrite does not edit runtime-source comments.

`rules-aidlc.md` emits `.devin/rules/aidlc.md` with `trigger: always_on`. The loaded rule names the active-space memory directory; it does not import those files. Actual method delivery belongs to the engine's resolver and load-steering protocol. Skill `triggers` and rule `trigger` are different fields.

Onboarding renders from `core/templates/onboarding.md` plus Devin fills. t331 currently enforces at most 16,384 UTF-8 bytes, no duplicated DocumentKB section, and no blanket claim of identical behavior across harnesses. The old 12 KiB proposal is not the current test limit.

No custom statusline is wired for Devin. `/aidlc --status` is the on-demand alternative; injecting display text into model context is not an equivalent persistent user-visible status strip.

## Evidence and limits

The project-owned byte limit does not prove complete host injection under every configuration. Historical notes reported a 16,384-byte truncation marker, but the proposed shared-budget explanation was not established. Rule listing and source-file size alone do not prove what reached the model.

The authored orchestrator still contains statements such as ordinary `next` mutating nothing; current engine publication can update runtime metadata. Only explicit observer modes have the narrower write-free consultation contract described in DEVIN-11. Research must not copy the orchestrator sentence as an implementation fact.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Runner regeneration | Mutating runners stay user-only after packaging and regeneration | t331 pins packaged metadata; aidlc-runner-gen consumes it; exercise installed regeneration separately |
| Rule activation | Pointer is always-on, contains navigation, and does not inline memory | t331 rules and pointer tests; live injection NOT RUN |
| Onboarding growth | Rendered UTF-8 byte size stays within the current project limit and key guidance remains | t331 tests 7b–7d; not proof of host truncation behavior |
| Actual context delivery after a host update | In a disposable installation, beginning/end sentinels and required rules are visible in injected context | Manual verification gap; test with and without substantial global rules |
| Status behavior | Status is available on demand; no claim of a Devin custom statusline or complete Claude usage ledger | DEVIN-06 and DEVIN-14 |

## Superseded approaches and history

`801507ad` added invocation metadata, explicit rule activation, and onboarding reduction. Subsequent upstream template growth changed the project's size pin from the earlier 12 KiB target to 16 KiB.

Retired explanations: all rule files automatically activate regardless of trigger; a path pointer imports its target; user-invocable alone means model-disabled; explicit triggers are inherently needed for slash invocation; a byte-size check proves no truncation. Preserve the distinction between source policy and observed host behavior.

## Sources

- `harness/devin/manifest.ts` — runnerFrontmatterAdditions, frontmatterAdditions
- `harness/devin/rules-aidlc.md`
- `harness/devin/onboarding.fills.ts`
- `harness/devin/skills/aidlc/SKILL.md`
- `core/templates/onboarding.md`
- `core/tools/aidlc-runner-gen.ts`
- `tests/unit/t331-devin-packaging.test.ts` — tests 6, 7b–7d, 14–18
- https://docs.devin.ai/cli/extensibility/skills/creating-skills
- https://docs.devin.ai/cli/extensibility/rules

[Back to findings index](index.md)
