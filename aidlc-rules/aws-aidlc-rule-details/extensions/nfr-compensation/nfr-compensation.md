# NFR Compensation Extension

**Extension ID**: `NFR-COMP`
**Category**: `nfr-compensation`
**Phase Coverage**: CONSTRUCTION (Functional Design)

---

## Core Principle: Domain-Specific NFR Concerns Belong in Domain Design

A global NFR pass covers system-wide concerns (database choice, caching layer, retry framework). It cannot anticipate unit-specific performance characteristics — how a particular unit handles slow dependencies, what its latency budget is, or what happens at its specific system boundaries. This extension ensures those concerns are captured where they are best understood: during the functional design of each domain unit.

---

## Rule NFR-COMP-001: Mandatory Performance Section in Functional Design

**Applies to**: CONSTRUCTION → Functional Design (per-unit)
**Trigger**: This unit's NFR Requirements / NFR Design / Infrastructure Design stages are being SKIPPED (e.g., because NFR was handled globally during a foundation unit)

When Functional Design executes for a unit whose NFR stages are skipped, each Functional Design artifact MUST include a section titled:

**"## Performance & Behavioral Considerations"**

This section (2-5 paragraphs) covers unit-specific non-functional concerns that a global NFR pass cannot anticipate. Include:

- **Latency budgets**: Expected response time for critical operations in this unit (e.g., multi-hop forwarding chain resolution, parallel Lambda invocation timeout)
- **Timeout strategies**: How this unit handles slow dependencies (partial results vs full failure, retry behavior, graceful degradation)
- **Resource constraints**: File size limits, concurrent operation limits, presigned URL TTLs, cache TTLs specific to this unit
- **Edge-case behavior**: What happens at system boundaries (expired tokens during playback, circular references, one dependency returns while another times out)
- **Testable acceptance criteria**: Specific, measurable NFR thresholds for this unit that QA can validate (e.g., "forwarding chain evaluation ≤ 200ms for ≤ 5 hops")

This is NOT a full NFR stage — it is a lightweight addendum ensuring domain-specific performance concerns are captured where they are best understood: during the functional design of that domain.

---

## Rule NFR-COMP-002: Cross-Reference with Global NFR

**Applies to**: CONSTRUCTION → Functional Design (per-unit)
**Trigger**: Same as NFR-COMP-001

When writing the Performance & Behavioral Considerations section:

- **Reference the global NFR artifacts**: Cite specific decisions from the foundation unit's NFR Design that this unit inherits (e.g., "Uses the retry framework from foundation NFR Design — 3 retries with exponential backoff")
- **Identify gaps**: Note any area where the global NFR does not cover this unit's specific needs (e.g., "Global NFR specifies 5s timeout; this unit's forwarding chain may need 10s for deep chains")
- **Flag conflicts**: If this unit's performance needs conflict with global NFR decisions, flag for resolution before Code Generation

---

## Extension Compliance Summary Format

When presenting stage completion, include:

```markdown
### NFR Compensation Extension Compliance
- **NFR-COMP-001**: [COMPLIANT — Performance section included] or [N/A — NFR stages executed for this unit]
- **NFR-COMP-002**: [COMPLIANT — global NFR cross-referenced] or [N/A — NFR stages executed for this unit]
```
