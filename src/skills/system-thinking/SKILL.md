---
name: system-thinking
description: |
  The ability to reason about systems as wholes — understanding how components interact, where complexity hides, what scales and what doesn't, and whether stated requirements are technically feasible within real-world constraints. Applied by the Architect persona as a contributor at design and requirements stages.
---

# System Thinking

## Purpose

The ability to reason about systems as wholes — understanding how components interact, where complexity hides, what scales and what doesn't, and whether stated requirements are technically feasible within real-world constraints.

## Principles

- Think in interactions, not just parts — a system's behaviour emerges from how components connect
- Every requirement has implementation implications — flag hidden complexity early
- Constraints are first-class — acknowledge technical, resource, and time constraints rather than ignoring them
- Trade-offs must be explicit — there is no free lunch in system design
- Non-functional requirements shape architecture more than functional ones — performance, reliability, and security drive structural decisions

## Definitions

- **System boundary** — what is inside vs outside the system being built
- **Integration point** — where this system touches another system or service
- **Constraint** — a limitation that bounds the solution space (technical, regulatory, resource, time)
- **Feasibility** — whether a requirement can be satisfied given known constraints

## Application

When applied at requirements-analysis: validate that requirements are technically feasible, flag requirements that imply hidden complexity (e.g., "real-time sync across regions" implies distributed consensus), identify missing non-functional requirements that the functional requirements imply, and flag contradictions between requirements.

When applied at domain-design: reason about component boundaries, dependency directions, communication patterns, and whether the decomposition supports the stated NFRs.

When applied at infrastructure-design: validate that infrastructure choices can meet the stated performance, reliability, and scalability targets.
