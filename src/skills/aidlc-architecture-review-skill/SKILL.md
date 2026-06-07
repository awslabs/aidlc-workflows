---
name: aidlc-architecture-review-skill
description: |
  Evaluate software architecture for sound boundaries, intentional coupling, explicit trade-offs, scalability, deployability, operability, and failure behaviour. Applies wherever architectural decisions are designed or reviewed.
---

# Architecture Review

## Definition

Assess whether a system design can hold up under real implementation and operation. This skill reviews the shape of the architecture: how responsibilities are divided, how components interact, what coupling is introduced, what trade-offs are being made, and how the system behaves under growth, change, and failure.

## Principles

- Boundaries must follow responsibility and ownership, not accidental technical layers.
- Coupling must be intentional, visible, and justified by the business or operational need.
- Dependency direction matters; dependencies should point toward stable abstractions and avoid circular flows.
- Every architectural decision has a trade-off; hidden trade-offs are risks.
- Scalability claims must identify the bottleneck, scaling unit, and constraint being addressed.
- Deployability matters; designs should be buildable, releasable, observable, and rollbackable.
- Failure modes are part of the architecture; timeouts, retries, partial failure, degradation, and recovery paths must be explicit.
- Data ownership must be clear; shared data without ownership rules creates long-term coupling.
- Cross-boundary communication should match the consistency, latency, reliability, and autonomy needs of the interaction.
- Simpler architecture is preferred until complexity is justified by scale, risk, team topology, or quality attributes.
- Review at the abstraction level of the artifact. In early conceptual stages, flag only issues knowable at that level, such as unclear responsibilities, poor boundaries, ambiguous ownership, circular conceptual dependencies, or premature technical decisions. Do not require deployability, infrastructure, runtime, scaling, or detailed failure-mode decisions before the relevant stage introduces them.

## Application

When applied to design work, this skill adds or sharpens:

- component and unit boundary rationale
- dependency direction and interaction mechanism decisions
- explicit trade-offs and rejected alternatives
- ownership rules for data, APIs, contracts, and operational responsibilities
- scalability assumptions and bottleneck analysis
- deployability and rollback considerations
- failure-mode handling for component, API, data, and infrastructure boundaries

When applied in review, this skill flags:

- components or units with mixed responsibilities
- circular dependencies or hidden runtime coupling
- contracts that leak provider internals or create consumer fragility
- data ownership ambiguity or uncontrolled shared data access
- designs that assume availability, ordering, consistency, or latency without saying so
- scalability patterns that do not match the actual bottleneck
- infrastructure choices that do not satisfy the stated quality attributes
- missing deployment, rollback, observability, or operational ownership decisions
- failure paths that are undefined, unsafe, or inconsistent with user/business expectations

When reviewing early-stage artifacts, this skill should classify later-stage concerns as "defer to later stage" rather than defects, unless the artifact makes a premature or contradictory claim about them.
