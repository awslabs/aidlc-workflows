# NFR Specification

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Quality Targets

| ID | Attribute | Target | Measure | Rationale | Source |
|---|---|---|---|---|---|
| NFR-1 | [performance / availability / scalability / security / reliability / observability] | [measurable target] | [how measured] | [why this number] | [NFR-n from requirements] |

## Tech Stack

| Layer | Choice | Rationale | Alternatives Considered |
|---|---|---|---|
| [runtime / database / messaging / cache / framework] | [specific technology] | [why — tied to which quality target] | [what else was considered and why not] |

## Patterns

| Pattern | Satisfies | Applied to | How it works | Trade-off | Failure mode |
|---|---|---|---|---|---|
| [name] | [NFR-n] | [CMP-001 / API-001 / UNIT-001 / UDEP-001] | [brief description] | [what you give up] | [what happens if it fails] |

## Blueprint Annotations

| Blueprint ID | Type | NFRs Applied | Required Expansion |
|---|---|---|---|
| CMP-001 | component | NFR-1 | [what must be added to copied-forward components.yaml] |
| API-001 | API | NFR-2 | [what must be added to copied-forward api-specification.md] |

## API Quality Annotations

| API ID | Limit / Target | Timeout | Retry / Idempotency | Observability |
|---|---|---|---|---|
| API-001 | [rate, payload, latency, or availability target] | [timeout expectation] | [retry/idempotency expectation] | [logs, metrics, traces needed] |

## Component Quality Annotations

| Component ID | Data Classification | Resiliency Need | Scaling Need | Security Controls |
|---|---|---|---|---|
| CMP-001 | [public/internal/confidential/etc.] | [degrade/retry/circuit breaker/etc.] | [scale trigger or constraint] | [authz/encryption/audit/etc.] |

## Trade-offs

| Prioritised | Over | Decision | Rationale |
|---|---|---|---|
| [attribute] | [attribute] | [what was chosen] | [why] |

## Constraints

| Constraint | Impact | Source |
|---|---|---|
| [org standard / existing infra / team expertise / etc.] | [what it forced or ruled out] | [where it comes from] |
