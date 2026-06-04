# Unit Contracts

> Minimum structure. Sections may be omitted with rationale or extended as needed.
> One entry per inter-unit boundary. If two units don't communicate, no contract is needed.

## Contract Inventory

| # | Provider Unit | Consumer Unit | Mechanism | Contract owner |
|---|---|---|---|---|
| C-1 | [unit that exposes the interface] | [unit that consumes it] | [REST API / async event / message queue / shared state / direct import] | [which unit owns the contract definition] |

## Contract Details

### C-1: [Provider] → [Consumer]

- **Mechanism:** [REST API / async event via queue/topic / shared database / gRPC / direct import / etc.]
- **Why this mechanism:** [rationale — sync because consumer needs immediate response, async because fire-and-forget, shared state because co-located, etc.]
- **Payload shape:**

```
{
  // Define the data structure exchanged.
  // For events: the event schema.
  // For APIs: the request/response shape.
  // For shared state: the table/document structure accessed.
}
```

- **Contract owner:** [which unit is responsible for defining and versioning this contract]
- **Versioning strategy:** [how breaking changes are handled — semver, additive-only, consumer-driven, etc.]
- **Error contract:**
  - Provider unavailable: [what the consumer does — retry, degrade, fail]
  - Invalid payload: [what the provider does — reject with error shape, dead-letter, ignore]
  - Timeout: [SLA expectation and consumer behaviour]

## Shared State Contracts

For units that share persistent state (database, cache, file system) rather than communicating via messages:

| Shared resource | Provider (writes) | Consumer (reads) | Access mechanism | Consistency guarantee |
|---|---|---|---|---|
| [table/bucket/cache] | [unit] | [unit] | [direct DB / read replica / event-sourced projection] | [strong / eventual / best-effort] |

## Open Questions

Contracts that couldn't be fully defined during units-generation (need resolution during per-unit design):

| Contract | Open question | Blocks |
|---|---|---|
| C-n | [what remains undecided] | [which unit's design is blocked until resolved] |
