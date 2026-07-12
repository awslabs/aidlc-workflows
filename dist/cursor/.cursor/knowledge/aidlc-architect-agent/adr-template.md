# Architecture Decision Records (ADRs)

## Purpose
ADRs capture significant architectural decisions, the context that drove them, and the consequences of choosing one option over alternatives. They create a decision journal that explains WHY the architecture looks the way it does.

## When to Create an ADR

Create an ADR when the decision:
- Is difficult to reverse once implemented (database choice, API contract, framework)
- Affects multiple teams or components
- Has significant cost, performance, or security implications
- Was debated — if there was disagreement, the reasoning needs documentation
- Changes a previous architectural direction

Do NOT create an ADR for:
- Routine implementation choices (variable names, code formatting)
- Decisions that are trivially reversible
- Standard practices already documented in team guidelines

## ADR Template

```markdown
# ADR-[NUMBER]: [Title - Short Descriptive Name]

## Status
[Proposed | Accepted | Deprecated | Superseded by ADR-XXX]

## Date
[YYYY-MM-DD]

## Context
What is the issue or situation that motivates this decision? Describe the forces
at play: technical constraints, business requirements, team capabilities, timeline
pressures, and any other factors influencing the decision.

Be specific. Include:
- What problem are we solving?
- What constraints exist (budget, timeline, team skill, compliance)?
- What quality attributes matter most (performance, security, maintainability)?
- What existing decisions or systems does this interact with?

## Decision
State the decision clearly and concisely. Use active voice:
"We will use PostgreSQL as the primary data store for the order management service."

Not: "It was decided that PostgreSQL might be a good option."

## Consequences

### Positive
- What becomes easier, faster, or better as a result of this decision?
- What risks are mitigated?

### Negative
- What becomes harder or more expensive?
- What new risks are introduced?
- What capabilities are foreclosed?

### Neutral
- What trade-offs are we accepting?
- What follow-up decisions will be needed?

## Alternatives Considered

### Alternative 1: [Name]
- Description: Brief explanation of this option
- Pros: What would this have given us?
- Cons: Why did we reject it?

### Alternative 2: [Name]
- Description: Brief explanation of this option
- Pros: What would this have given us?
- Cons: Why did we reject it?

## References
- Links to relevant RFCs, design documents, benchmark results, or discussions
```

## Numbering Convention

Use sequential numbering with zero-padding:
```
ADR-001-use-postgresql-for-orders.md
ADR-002-adopt-event-driven-integration.md
ADR-003-select-react-for-frontend.md
```

### Naming Rules
- Sequential numbers, never reused (even if deprecated)
- Kebab-case descriptive suffix after the number
- Store in a dedicated `/docs/adr/` or `/architecture/decisions/` directory
- Include an `index.md` that lists all ADRs with status and one-line summary

## ADR Lifecycle

### Proposed
The decision is under discussion. The ADR is a draft open for review and feedback. Include it in pull requests or architecture review meetings.

### Accepted
The decision has been approved and should be followed. Implementation can proceed. Record the acceptance date and approver(s).

### Deprecated
The decision is no longer relevant — the system or feature it applied to has been removed. Keep the ADR for historical context but mark it clearly.

### Superseded
A new decision has replaced this one. Link to the new ADR:
```
## Status
Superseded by [ADR-015](./ADR-015-migrate-to-dynamodb.md)
```
The superseding ADR should reference the original:
```
## Context
This decision supersedes [ADR-003](./ADR-003-select-postgresql.md) because...
```

## Best Practices

### Writing Quality
- Write for a future reader who has no context — assume they joined the team after the decision was made
- Focus on WHY, not just WHAT — the code shows what was built; the ADR explains why
- Be honest about trade-offs — every decision has downsides; documenting them builds trust
- Include quantitative data when available (benchmark results, cost estimates, load test numbers)

### Process
- Create the ADR BEFORE implementation, not after — it is a decision tool, not documentation
- Review ADRs in pull requests alongside the code they influence
- Revisit ADRs quarterly — some may need updating as circumstances change
- Keep ADRs concise — one to two pages is ideal; longer suggests the scope is too broad

### Common Mistakes
- Writing ADRs after the fact as documentation (they should drive the decision)
- Omitting alternatives (makes the decision look unconsidered)
- Not recording negative consequences (creates false confidence)
- Making ADRs too granular (implementation details do not need ADRs)
- Letting ADRs become stale without status updates

## Example ADR Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| 001 | Use PostgreSQL for order management | Accepted | 2024-01-15 |
| 002 | Adopt event-driven integration between services | Accepted | 2024-02-01 |
| 003 | Select React with TypeScript for frontend | Accepted | 2024-02-10 |
| 004 | Use JWT for API authentication | Superseded by 012 | 2024-03-01 |
| 005 | Deploy to AWS ECS Fargate | Accepted | 2024-03-15 |
