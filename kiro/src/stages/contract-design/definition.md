# Contract Design

## Description

Define the contracts between units so teams can build in parallel with confidence. A contract is the formal agreement between a provider unit and a consumer unit — what data crosses the boundary, in what shape, via what protocol, and what happens when things go wrong. This must be 90% right from the start. Think of two teams in two companies — the contract is the B2B agreement. Get it wrong and integration becomes a rework disaster.

## Inputs

- **Required:** `units` + `unit-dependencies` from units-generation (must know who talks to whom)
- **Optional context:** `components` from domain-design (entity shapes inform payload design), `requirements` (NFRs shape SLAs and error budgets)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `components` — copied from units-generation and expanded only with contract references for component interactions that cross unit boundaries
- `units` — copied from units-generation and expanded only with boundary contract references
- `unit-dependencies` — copied from units-generation and expanded only with contract IDs/spec references for each integration point
- `contracts` — a collection, one contract spec per inter-unit boundary, in the appropriate format:
  - OpenAPI spec (for synchronous REST/HTTP contracts)
  - AsyncAPI spec (for event-driven/message-based contracts)
  - Shared schema definitions (for shared database or shared model contracts)
  - Any other contract format appropriate to the integration mechanism
- `contract-summary` — human-readable overview: which units have contracts, what mechanism, who owns the contract

## Owner

aidlc-app-architect-agent

## Contributors

- aidlc-product-manager-agent

## Reviewer

aidlc-architecture-reviewer-agent
