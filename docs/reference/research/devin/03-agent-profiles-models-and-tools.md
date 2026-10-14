# Agent profiles, model selection, and tool restrictions

**Finding:** DEVIN-03. **Status:** Implemented for shipped core profiles; documented profile fields pinned from the 3000.11.3 bundle; effective model and plugin policy not inferred. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12; profile fields and model pins 2026-10-10.

## Why this was needed

AI-DLC specialists must load as named Devin profiles without forking shared persona metadata, silently changing model expectations, or allowing specialists to take over the conductor's delegation role.

## Current implementation

Flat `.devin/agents/aidlc-<role>-agent.md` files are custom profiles. Devin derives the identifier from the file, overridden by `name:`; the body supplies the profile's system prompt. Naming a persona only in task text is not equivalent to selecting its profile. Since the `b8d9bdc3` merge the packager rewrites persona references from `aidlc/spaces/<active-space>/memory/` to `aidlc/active-memory/` — the engine's git-ignored copy of the active space's memory — the same rewrite cursor, opencode, and Copilot get; the generated profile bodies read the active-memory copy rather than the space path.

Shared `display_name`, `examples`, `disallowedTools`, and `maxTurns` metadata is retained where authored. Devin's documented profile frontmatter fields are exactly `name`, `description`, `model`, `allowed-tools` (alias `tools`), and `max-nesting` (3000.11.3 bundle, `subagents.mdx:296-303`), so `disallowedTools` and `maxTurns` are inert on Devin; prior native diagnostics reported CFG005 warnings. Retention is deliberate — the same bodies render on every harness — with one noted consequence: the two review-only persona bodies still describe `maxTurns: 60` as a HARD cap that Devin does not enforce (open finding in the index). AI-DLC's own metadata parser still requires `display_name` consistently. Do not recreate the removed field-stripper or Devin-only parser exemption to silence warnings.

AI-DLC's Devin model projection omits model pins. Custom profiles without `model:` use Devin's default subagent model, not automatic parent-model inheritance. The documented Subagent router default is SWE-1.6; an organization can select a different default or None. A profile `model:` pin is the separate Devin override — and on 3000.11.3 it was NOT validated at spawn on this account: a profile pinned to a nonexistent model and one pinned to `opus` both ran, with no refusal and no failed-start event (R2/R2b), so the "unsupported model is refused" claim is account policy at most. The effective model can coincide with the parent and is not measured by AI-DLC doctor. Built-in subagent_general's inheritance policy does not describe AI-DLC custom profiles. The merge also added `devin` to the harness-keyed tables this honesty depends on: `HARNESS_PRODUCT_NAMES` (`"Devin CLI"`) in `aidlc-model-policy.ts`, `HOST_LABELS` in `aidlc-runtime-paths.ts`, `MODEL_HARNESSES` and the settings schema in `aidlc-settings.ts`, and `RELEASE_DISTRIBUTIONS` in `scripts/verify-release.ts`. It is deliberately absent from `scripts/ci-update-from-previous.ts` `HARNESSES` — that check installs the previous published release, which has no Devin.

The manifest adds a native `allowed-tools` list to the 14 named core profiles, excluding `run_subagent`, `read_subagent`, and `skill`. This restricts tool availability, independently of native default nesting behavior. It is not a permission auto-approval list, shell sandbox, or guarantee about arbitrary plugin profiles. Devin always withholds ask_user_question from subagents; the parent owns human questions.

The added allowlist names specific native tools, so a host rename or newly introduced tool requires review. The generic MCP operations on the list do not prove that every server-specific tool is available or authorized.

## Evidence and limits

t331 tests retained metadata, core-profile allowlists, absence of cross-harness leakage, onboarding, and model-policy wording. These static/package tests do not inspect an organization's selected model or run every profile under a live host.

The explicit list is generated for the manifest's core profile roster. Do not extend the claim to all plugin agents merely because plugin metadata preservation is shared.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Persona identity and metadata | Named profiles retain authored fields and body; AI-DLC still requires display_name | t331 profile tests; shared metadata parser |
| Non-delegating core profiles | Every listed core profile excludes direct subagent and skill tools; other harnesses remain unchanged | t331 tests 19–20 |
| Model advisory | Doctor explains the default-subagent policy without claiming actual model inspection | t331 tests 9c, 21–22; aidlc-model-policy |
| Host profile schema update | Recheck supported fields, warnings, tools, nesting, and model precedence against the new CLI | Live profile/organization verification NOT RUN |
| Plugin profile | Independently review its grants and model rather than assuming the core allowlist applies | Plugin-host acceptance gap |

## Superseded approaches and history

`801507ad` introduced stripping; `02b7e319` restored shared metadata and removed the helper/parser exception. `5f984188` added the native core-profile allowlist and corrected the model advisory.

Superseded: inherit-by-omission means parent-model inheritance; unsupported Claude denylist fields enforce Devin restrictions; every specialist necessarily runs a different model; native default no-nesting eliminates the need to review explicit tool policy.

## Sources

- `harness/devin/manifest.ts` — DELEGATION_AGENTS, frontmatterAdditions
- `core/tools/aidlc-tiers.ts`
- `core/tools/aidlc-model-policy.ts` — HARNESS_HONESTY
- `core/tools/aidlc-lib.ts` — parseAgentFrontmatter
- `core/tools/aidlc-utility.ts` — Devin model advisory
- `tests/unit/t331-devin-packaging.test.ts`
- <https://docs.devin.ai/cli/subagents>

[Back to findings index](index.md)
