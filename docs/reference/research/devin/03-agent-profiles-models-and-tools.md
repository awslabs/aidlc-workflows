# Agent profiles, model selection, and tool restrictions

**Finding:** DEVIN-03. **Status:** Implemented for shipped core profiles; effective model and plugin policy not inferred. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

AI-DLC specialists must load as named Devin profiles without forking shared persona metadata, silently changing model expectations, or allowing specialists to take over the conductor's delegation role.

## Current implementation

Flat `.devin/agents/aidlc-<role>-agent.md` files are custom profiles. Devin derives the identifier from the file, overridden by `name:`; the body supplies the profile's system prompt. Naming a persona only in task text is not equivalent to selecting its profile.

Shared `display_name`, `examples`, `disallowedTools`, and `maxTurns` metadata is retained where authored. Devin does not document these as native enforcement fields; prior native diagnostics reported CFG005 warnings. AI-DLC's own metadata parser still requires `display_name` consistently. Do not recreate the removed field-stripper or Devin-only parser exemption to silence warnings.

AI-DLC's Devin model projection omits model pins. Custom profiles without `model:` use Devin's default subagent model, not automatic parent-model inheritance. The documented Subagent router default is SWE-1.6; an organization can select a different default or None. The effective model can coincide with the parent and is not measured by AI-DLC doctor. Built-in subagent_general's inheritance policy does not describe AI-DLC custom profiles.

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
- https://docs.devin.ai/cli/subagents

[Back to findings index](index.md)
