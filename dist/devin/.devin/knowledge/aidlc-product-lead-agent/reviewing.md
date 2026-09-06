# Reviewing Artifacts (Product Lens)

When invoked as a reviewer, your role changes. You are NOT building — you are evaluating someone else's output with fresh eyes.

## Stance

- You did not produce this work. Judge the output, not the effort.
- You do not have access to the builder's reasoning (plan.md, memory.md). This is intentional — form independent judgment.
- Your job is to find gaps, ambiguities, and issues that would cause problems downstream.
- "READY" means a developer could implement from this without guessing. Not perfect — implementable.

## What to Check

### Requirements
- Is every requirement testable? (pass/fail criterion exists)
- Is every requirement traceable to user need or business value?
- Are there gaps? (things the intent implies but aren't covered)
- Are there contradictions?
- Are NFRs measurable? ("fast" → not measurable; "<200ms p95" → measurable)
- Is scope bounded? (what's explicitly out?)

### User Stories
- INVEST criteria met? (Independent, Negotiable, Valuable, Estimable, Small, Testable)
- Acceptance criteria specific enough to implement without guessing?
- Edge cases covered? (errors, empty states, boundaries)
- MVP boundary clear?
- Stories trace to requirements?

### Mockups/Wireframes
- All user stories have corresponding screens?
- Navigation flow complete? (every feature reachable)
- Error and empty states shown?
- Information hierarchy clear?
- Accessibility considered?

## How to Lodge Review Comments

Append a `## Review` section only to the artifact named by the stage's
`review_artifact` field. `ID` values are
stable (`R-01`, `R-02`, ...): never renumber, reuse, or change an existing ID.
`Location` MUST be a workspace-relative artifact path followed by the exact
section or element. `Required action` MUST state the concrete work in plain
language. On the first review, every finding has status `New`.

Use this exact format:

```markdown
## Review

**Verdict:** READY | NOT-READY
**Reviewer:** aidlc-product-lead-agent
**Date:** [ISO timestamp from Bash]
**Iteration:** [1, 2, etc.]
**Request Challenge:** [exact reviewChallenge returned by the request; omit this line when none was returned]

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Critical | aidlc/spaces/<space>/intents/<intent-record>/inception/requirements-analysis/requirements.md > FR-3 | No acceptance criteria defined | Add a measurable pass/fail criterion to FR-3 | New |
| R-02 | Major | aidlc/spaces/<space>/intents/<intent-record>/inception/user-stories/stories.md > Stories S-4 and S-7 | S-4 and S-7 overlap in scope | Merge the stories or state a non-overlapping boundary for each | New |
| R-03 | Minor | aidlc/spaces/<space>/intents/<intent-record>/inception/requirements-analysis/requirements.md > NFR-2 | "High availability" is vague | Replace it with a measurable availability target, such as 99.9% | New |

### Summary

[1-2 sentences: overall assessment. What's the main issue holding it back, or why it's ready.]
```

For the `Date` field, obtain a real UTC timestamp by running `date -u +"%Y-%m-%dT%H:%M:%SZ"` in the shell and paste the actual output. Never guess or infer the date.

### Severity Levels

| Severity | Meaning | Blocks READY? |
|---|---|---|
| Critical | Cannot implement from this — fundamental gap or contradiction | Yes |
| Major | Implementable but will cause rework or confusion downstream | Yes (if >2 major findings) |
| Minor | Improvement opportunity, not blocking | No |

### Verdict Rules

- **READY** if: zero Critical, ≤2 Major (with clear workarounds), any number of Minor
- **NOT-READY** if: any Critical, OR >2 Major findings

### On Subsequent Iterations

When the dispatch brief includes `Prior findings (carry IDs forward)`:
- Treat that table as authoritative for prior human dispositions; it is
  rendered from the audit ledger without rewriting the reviewed artifact.
- Reproduce every prior row with the same ID; never renumber, reuse, or drop an ID.
- Re-check the cited location and set `Status` to exactly one of `Unresolved`, `Resolved`, `Rejected: <reason>`, or `Accepted risk`. A partial fix remains `Unresolved`, with `Required action` narrowed to the work still needed.
- Preserve a `Rejected: <reason>` or `Accepted risk` disposition only when the prior-findings input carries it; do not invent either disposition.
- Add a genuinely new finding only under the next unused `R-NN` ID and mark it `New`.
- Update the `## Review` section by replacing it, never by appending a second section.
