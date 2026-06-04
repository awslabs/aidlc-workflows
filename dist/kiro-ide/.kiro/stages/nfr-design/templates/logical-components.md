# Logical Components

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Unit

[Unit name]

## Component Inventory

| Component | Type | Satisfies NFR | Integrates with |
|---|---|---|---|
| [e.g. request cache] | [cache / queue / circuit breaker / rate limiter / health check / metric emitter / retry handler / etc.] | [NFR-x] | [which business component uses it] |

## Component Details

### [Component Name]

- **Type:** [what kind of infrastructure-adjacent component]
- **Purpose:** [what quality attribute it serves and how]
- **Behaviour:**
  - [how it operates in the happy path]
  - [how it operates under failure]
  - [how it recovers]
- **Configuration:** [key knobs — TTL, max retries, thresholds, window sizes]
- **Observability:** [what metrics/logs this component emits for monitoring]
- **Dependencies:** [what it needs to function]
