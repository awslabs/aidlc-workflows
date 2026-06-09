---
name: aidlc-requirements-review-skill
description: |
  Evaluate product artifacts — requirements, user stories, personas, and wireframes — for clarity, value, testability, traceability, and scope discipline. Applies wherever product-facing work is reviewed before it moves downstream.
---

# Requirements Review

## Definition

Assess whether a product artifact is ready to move forward. This skill reviews the shape of product thinking: are requirements unambiguous and verifiable, do stories trace to requirements, are personas consistent across artifacts, is scope explicit, are trade-offs and assumptions surfaced. It is the product-side counterpart to architecture review and code review.

## Principles

- Every requirement must be verifiable as pass/fail. Vague language ("fast," "user-friendly," "robust") is a defect, not a placeholder.
- Every story must trace back to at least one requirement. Stories without a parent requirement are scope creep.
- Every requirement must be covered by at least one story. Uncovered requirements are dropped work.
- Acceptance criteria must be specific, observable, and testable. "Works correctly" is not acceptance criteria.
- Scope boundaries must be explicit. Silence is not exclusion — out-of-scope items must be listed.
- Assumptions must be flagged as assumptions, not stated as facts.
- Personas must be consistent across requirements, stories, and wireframes. A persona introduced in stories that doesn't appear in personas.md is a gap.
- User journeys must be complete. Happy path without error paths is half-finished.
- Non-functional requirements must be measurable. "Highly available" is not measurable; "99.9% monthly uptime" is.
- Prioritization must be explicit. If everything is P0, nothing is P0.
- Edge cases and error scenarios must be addressed, not buried in happy-path stories.
- Review at the abstraction level of the artifact. Do not require implementation detail before the relevant stage introduces it.

## Definitions

- **Verifiable** — a requirement or acceptance criterion that can be objectively checked as pass or fail
- **Traceable** — an artifact that can be linked back to its parent (intent → requirement → story → screen) and forward to its children
- **Atomic** — a requirement or story that addresses one concern; if it has "and," it usually splits
- **INVEST** — Independent, Negotiable, Valuable, Estimable, Small, Testable (story quality criteria)
- **Coverage gap** — a requirement with no corresponding story, or a story with no parent requirement

## Application

When applied to review work, this skill flags:

- Requirements that are vague, untestable, or use weasel words ("should," "may," "preferably")
- Requirements without acceptance criteria or measurable thresholds
- Compound requirements that should be split (FR-X with multiple distinct capabilities joined by "and")
- Non-functional requirements without measurable targets
- Missing scope boundaries — no out-of-scope section, no assumptions section
- Assumptions presented as facts
- Stories that don't follow "As a [persona], I want [goal], so that [benefit]"
- Stories without acceptance criteria in Given/When/Then form
- Stories with acceptance criteria that are not testable
- Stories that don't trace to any requirement (orphan stories)
- Requirements with no covering story (orphan requirements)
- Personas that appear in stories but not in personas.md (or vice versa)
- Personas that are generic stereotypes instead of grounded archetypes
- Wireframes that don't match the screen flows implied by stories
- Wireframes missing screens needed by stories (or screens with no story justification)
- Missing edge cases, error states, or unhappy paths
- Prioritization that isn't explicit, or "everything is critical"
- Scope creep — content in the artifact that doesn't trace to the original intent
- Inconsistencies across artifacts (intent says X, requirements say Y, stories say Z)

When applied to producer feedback (contributor mode rather than reviewer), this skill manifests as: pointing out the same gaps but framed as "consider adding…" rather than "missing…", and offering specific suggestions rather than verdicts.

## Verdict Format

When this skill is used at the review stage, return:

- **READY** — the artifact is fit to move to the next stage
- **NOT-READY** — the artifact has blocking gaps; list each finding with the artifact section, the principle violated, and a concrete suggestion to fix it

Findings should be specific (file and section reference), actionable (what would resolve it), and proportional (do not block on stylistic preferences).
