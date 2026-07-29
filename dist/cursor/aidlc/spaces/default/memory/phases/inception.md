# Inception Phase Guardrails

These rules apply to every stage whose `phase: inception` declaration
imports them as the matching phase rule.

## Requirements Quality

- Requirements must be testable and verifiable — each requirement must have a clear pass/fail criterion
- Avoid ambiguous language ("fast", "easy", "user-friendly") unless paired with a measurable threshold
- Never carry forward unresolved contradictions between requirements; surface and resolve them explicitly

## Architecture Standards

- Architecture decisions require trade-off analysis — document at least two alternatives considered
- All ADRs must include: Context, Decision, Consequences, and Alternatives Rejected
- Security and compliance implications must be addressed for every major architectural decision

## User Stories

- User stories follow Given/When/Then (BDD) format for acceptance criteria
- Each story must identify the actor, the action, and the business value
- Stories must be independently testable — avoid stories that only make sense in sequence

## Traceability

- Every requirement must trace back to an ideation artifact (intent, feasibility, or scope)
- Do not introduce new requirements in inception without documenting their origin

## Corrections
