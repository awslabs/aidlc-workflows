# ADR-003: Hook Adapter Blocking Contract — Permission Deny vs Exit Code 2

**Status**: Accepted  
**Date**: 2026-07  
**Decision Maker**: Architecture Team  
**Category**: Integration

---

## Context

Core AI-DLC hooks signal a "block this operation" intent by exiting with code 2 and writing a
reason to stderr. Cursor's hook contract is different: to block an operation, a hook must write
JSON `{"permission": "deny", ...}` to stdout and exit 0. The adapter must bridge these contracts.

- **Problem Statement**: How should `aidlc-cursor-adapter.ts` translate the core hook's exit-code-2
  block signal into Cursor's expected deny response?
- **Requirements**: FR-007 (adapter normalizes payload), NFR-101 (security gates use failClosed)
- **Constraints**: Cursor hooks.json v1 schema; core hooks must remain unchanged

---

## Decision

**The adapter will map core exit-code-2 to Cursor's `{"permission": "deny", ...}` JSON stdout,
and will exit 0 in all cases.**

For `failClosed: true` hooks, Cursor itself blocks the operation when the hook process crashes
or times out. For `failClosed: false` hooks, a crash is fail-open (exit 0, no output).

---

## Research Conducted

### Option A: Adapter maps exit-code-2 → permission:deny JSON, exits 0 ✓ SELECTED

**Research Confidence**: High

Official Cursor hooks documentation (fetched 2026-07-29, cursor-native-surfaces-research.md §3)
explicitly specifies the permission output format.

| Source | Key Finding |
|--------|-------------|
| cursor-native-surfaces-research.md §3 | Permission output: `{permission:"allow"/"deny"/"ask", user_message:..., agent_message:...}` (snake_case) |
| cursor-native-surfaces-research.md §5 | "Core hooks signal block via exit code 2 + stderr; Cursor expects JSON stdout with permission:deny" |
| harness/kiro/hooks/aidlc-kiro-adapter.ts | Reference: exit 2 + stderr IS Kiro's block contract — confirms per-harness contract difference |
| t147-kiro-hook-adapter.test.ts | Assertion pattern: `r.code === 2` for blocks (Kiro) vs `permission:deny` (Cursor) |

**Capabilities Verified**:
- `user_message` shown to user in Cursor UI (snake_case, not camelCase)
- `agent_message` sent to the LLM as context
- Exit 0 + no JSON = implicit allow
- `failClosed:true` means hook crash blocks the action — no extra code needed for that case

### Option B: Adapter exits with code 2 when core blocks

**Research Confidence**: High

Some Cursor documentation variants suggest exit-code-based blocking. The official hooks docs
(July 2026) clarify that only the JSON output determines allow/deny for most hooks.

| Source | Key Finding |
|--------|-------------|
| cursor-native-surfaces-research.md §5 | "Adapter: run core hook → if exit code 2: emit {permission:deny,...} → exit 0" — confirm exit 0 is correct |
| Official Cursor hooks docs | Permission output is stdout JSON, not exit code |

**Capabilities Verified**:
- Exit code 2 is the Kiro blocking contract, not Cursor's
- Using exit code 2 would be incorrect for Cursor hooks

### Option C: No adapter — rewrite core hooks to support both contracts

**Research Confidence**: High

Core hooks are shared across all five harnesses. Rewriting them to conditionally output Cursor's
permission-deny JSON would break the Claude, Kiro, and Codex harnesses.

| Source | Key Finding |
|--------|-------------|
| FR-007 acceptance criteria | "Core hook bodies remain unchanged; all adaptation is done in the adapter" |

---

## Capability Mapping

| Requirement | Option A (permission:deny JSON) | Evidence | Option B (exit code 2) |
|-------------|----------------------------------|----------|----------------------|
| FR-007: adapter normalizes contract | Maps exit-2 to correct Cursor format | cursor-native-surfaces-research.md | Incorrect — Cursor does not use exit code |
| NFR-101: security gates use failClosed | failClosed:true in hooks.json — Cursor handles crash behavior | Official hooks docs | Would not work |
| Cursor block contract | Correct | cursor-native-surfaces-research.md §3 | Incorrect |
| Core hooks unchanged | Core unchanged — adapter translates | FR-007 acceptance criteria | Requires core changes |

---

## Unknowns and Assumptions

| Item | Type | Impact | Mitigation |
|------|------|--------|------------|
| Field naming is snake_case (user_message not userMessage) | Verified (research confirmed) | High — wrong field name would fail to block | Use exact snake_case fields per research |
| `failClosed:true` behavior on crash | Verified in official docs | High — security gate relies on this | Documented in research; confirmed in hooks.json schema |

---

## Counter-Argument Analysis

### Q1: What evidence would make me choose exit code 2?

Cursor release notes showing that `beforeShellExecution` now uses exit code for blocking. The
current official documentation is clear that JSON output is the mechanism.

### Q2: Is there a managed service that does this better?

Not applicable — this is an adapter implementation choice.

### Q3: What am I not seeing about the alternative?

The official docs are authoritative and clear. There is no credible alternative reading.

---

## Alternative Consideration Checklist

- [x] Searched for managed alternatives — not applicable
- [x] Researched minimum 2 alternatives with equal depth
- [x] Documented specific sources for each alternative
- [x] Created capability mapping with evidence
- [x] Documented unknowns and assumptions
- [x] Assigned research confidence levels
- [x] Completed Counter-Argument analysis

---

## Alternatives Considered

### Option B: Adapter exits code 2 — REJECTED

The Cursor hooks contract uses JSON output for allow/deny decisions, not exit codes. Exit code 2 is the Kiro block contract, not Cursor's.

### Option C: Rewrite core hooks — REJECTED

Core hooks are shared across all harnesses; modifying them for Cursor would break other harnesses. FR-007 explicitly requires "all adaptation is done in the adapter."

---

## Rationale

"In the context of bridging core exit-code-2 blocking to Cursor's permission-deny JSON contract,
facing an explicit harness-specific protocol mismatch, we decided for the adapter mapping
exit-code-2 to permission:deny JSON and exiting 0, and rejected exit-code-based blocking,
to achieve correct Cursor hook semantics without modifying core hooks, accepting a thin adapter
translation layer, because the official Cursor documentation specifies this contract and the
same adapter pattern is established in the Kiro and Codex harnesses."

---

## Consequences

### Positive
- Core hooks remain unchanged and shared across all harnesses
- Correct Cursor blocking behavior for security gates
- failClosed:true provides defense-in-depth (crash = block for security hooks)

### Negative
- Adapter must handle the translation; an error in the adapter logic could result in fail-open behavior on security gates

### Neutral
- Same thin-adapter pattern as kiro and codex adapters

---

## Related Decisions

- **Depends On**: ADR-002 (emitter generates hooks.json with failClosed settings)
- **Related**: ADR-004 (session initialization via beforeSubmitPrompt)

---

## Research Sources

1. cursor-native-surfaces-research.md — §3 (hooks.json schema) and §5 (adapter contract)
2. harness/kiro/hooks/aidlc-kiro-adapter.ts — Kiro adapter reference pattern
3. testing-and-distribution-quality-research.md — §Q5 (adapter contract test patterns)
