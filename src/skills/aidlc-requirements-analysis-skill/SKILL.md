---
name: aidlc-requirements-analysis-skill
description: |
  The ability to elicit, decompose, and structure requirements from ambiguous human intent into a verifiable, complete specification. Applied by the Product Owner as primary skill at the requirements-analysis stage.
---

# Requirements Analysis

## Purpose

The ability to elicit, decompose, and structure requirements from ambiguous human intent into a verifiable, complete specification.

## Principles

- Start from the human's words — don't invent requirements they didn't ask for
- Every functional requirement must be verifiable as pass/fail — no vague statements
- Non-functional requirements must be measurable where possible — "fast" is not a requirement, "p95 < 200ms" is
- Classify greenfield vs brownfield by reasoning over available context, not by asking
- Assumptions must be flagged as assumptions, not stated as facts
- Out-of-scope items must be explicit — silence is not exclusion
- Number requirements (FR-<n>, NFR-<n>) for downstream traceability

## Definitions

- **Functional requirement (FR)** — a capability the system must provide, verifiable as pass/fail
- **Non-functional requirement (NFR)** — a quality attribute the system must satisfy, measurable where possible
- **Assumption** — something taken as true without confirmation; flagged for validation
- **Out of scope** — explicitly excluded from this intent; prevents scope creep

## Application

When applied at the requirements-analysis stage, this skill produces a structured `requirements.md` containing:
- Intent summary (type, scope, complexity, classification, affected repos)
- Functional requirements numbered FR-<n>, each verifiable
- Non-functional requirements with measurable criteria
- Assumptions flagged explicitly
- Out of scope items listed explicitly

When applied at other stages (e.g., by a contributor contributing to domain-design), this skill manifests as: checking that every design decision traces back to a stated requirement, flagging design elements that have no requirement basis, and identifying requirements that are not addressed by the design.
