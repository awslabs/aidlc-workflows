# NFR Patterns

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Unit

[Unit name]

## Patterns Applied

### [Pattern Name — e.g. "Circuit Breaker", "Write-Behind Cache", "Rate Limiting"]

| Field | Value |
|---|---|
| Satisfies NFR | [NFR-x from nfr-targets.md] |
| Quality attribute | [resilience / performance / scalability / security / observability] |
| Where applied | [which component/interaction in this unit] |
| How it works | [brief description of the pattern's behaviour in this context] |
| Trade-off | [what you give up by using this pattern — complexity, latency, cost, etc.] |
| Failure mode | [what happens if this pattern itself fails or is misconfigured] |

## Pattern Interactions

Document how patterns interact or depend on each other:

| Pattern A | Pattern B | Interaction |
|---|---|---|
| [e.g. circuit breaker] | [e.g. retry] | [e.g. retries must respect circuit state — don't retry when open] |

## Gaps

| NFR Target | Gap | Resolution path |
|---|---|---|
| [target] | [what's not covered] | [what's needed] |
