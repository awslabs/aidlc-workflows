# ADR-005: tierFlavor "claude" for Cursor Harness

**Status**: Accepted  
**Date**: 2026-07  
**Decision Maker**: Architecture Team  
**Category**: Build Pipeline

---

## Context

The `HarnessManifest.tierFlavor` field determines which model identifier column the AI-DLC tier
projection system (`core/tools/aidlc-tiers.ts`) uses when projecting agent tier metadata. The
options are `"claude"`, `"codex"`, `"kiro"`, and `"opencode"`. Each maps to a different set of
model identifier strings.

- **Problem Statement**: Which tierFlavor should the Cursor harness use?
- **Requirements**: FR-002 (manifest declares correct configuration)
- **Constraints**: Cursor uses Anthropic Claude models natively; model selection is user-governed via Cursor UI

---

## Decision

**We will use `tierFlavor: "claude"` for the Cursor harness.**

Cursor uses Anthropic model identifiers (e.g., `claude-sonnet-4-5`) natively. The "claude"
tier flavor maps tier levels (judgment/balanced/templated) to the same Anthropic model
identifier strings used in the Claude Code harness.

---

## Research Conducted

### Option A: tierFlavor "claude" ✓ SELECTED

**Research Confidence**: High

| Source | Key Finding |
|--------|-------------|
| packager-integration-research.md §12 | "Cursor uses Claude model identifiers (e.g., claude-sonnet-4-5), so `tierFlavor: 'claude'` is correct." |
| cursor-platform-research.md | "Cursor: model selection is user-governed (UI picker), not per-agent file config." |
| technical-environment.md | Cursor uses Anthropic Claude models natively |

**Capabilities Verified**:
- Claude tier flavor uses Anthropic model identifier strings
- Model selection is user-governed in Cursor (cannot enforce tier via model selection, but identifiers match)
- No new tier flavor needed

### Option B: New "cursor" tierFlavor

**Research Confidence**: High

A new tier flavor would require adding a column to `core/tools/aidlc-tiers.ts`.

| Source | Key Finding |
|--------|-------------|
| packager-integration-research.md §12 | "No new tier flavor is needed unless Cursor's model naming diverges from raw Anthropic identifiers." |

**Capabilities Verified**:
- Adding a new flavor is possible but adds maintenance overhead
- Unnecessary since Cursor and Claude Code use the same model identifiers

---

## Capability Mapping

| Requirement | claude tierFlavor | Evidence | new cursor tierFlavor |
|-------------|-------------------|----------|-----------------------|
| FR-002: correct manifest config | Matches Anthropic identifiers used by Cursor | packager-integration-research.md §12 | Would work but unnecessary |
| Minimal changes to core | Uses existing flavor column | packager-integration-research.md | Requires core/tools/aidlc-tiers.ts change |

---

## Unknowns and Assumptions

| Item | Type | Impact | Mitigation |
|------|------|--------|------------|
| Cursor model naming may diverge from Anthropic in future | Unknown | Low — would require a new tier flavor at that point | Monitor Cursor model naming in future versions |

---

## Counter-Argument Analysis

### Q1: What evidence would make me create a new tierFlavor?

Cursor adopting a non-Anthropic model naming scheme (e.g., after a model provider switch).

### Q2: Is there a managed service that does this better?

Not applicable.

### Q3: What am I not seeing?

Cursor's model selection is entirely user-governed — the tier flavor primarily affects the
agent metadata injected into prompts, not the actual model selected. Even with "claude" flavor,
users can select any model in Cursor's UI.

---

## Alternative Consideration Checklist

- [x] Researched minimum 2 alternatives
- [x] Documented sources for each alternative
- [x] Created capability mapping
- [x] Documented unknowns
- [x] Assigned research confidence levels
- [x] Completed Counter-Argument analysis

---

## Alternatives Considered

### Option B: New "cursor" tierFlavor — REJECTED

Adds maintenance overhead with no functional difference. Cursor uses the same Anthropic model
identifiers as Claude Code, making the "claude" flavor correct.

---

## Rationale

"In the context of configuring tier projection for Cursor, we decided for `tierFlavor: 'claude'`
and rejected a new `tierFlavor: 'cursor'`, because Cursor uses Anthropic model identifiers
natively and no new column in aidlc-tiers.ts is needed."

---

## Consequences

### Positive
- Zero changes to `core/tools/aidlc-tiers.ts`
- Agent tier metadata matches the model identifiers users will see in Cursor's UI

### Negative
- If Cursor diverges from Anthropic identifiers in the future, a new tier flavor would be needed

---

## Related Decisions

- **Depends On**: FR-002 (manifest declares tierFlavor)

---

## Research Sources

1. packager-integration-research.md — §12 (tierFlavor for Cursor)
2. cursor-platform-research.md — Model configuration note
