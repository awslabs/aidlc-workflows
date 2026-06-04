# NFR Design

## Description

Design the architectural patterns and logical components that satisfy the NFR targets established in nfr-assessment. Resilience patterns, caching strategies, scaling mechanisms, observability instrumentation, security enforcement points. Defines what logical capabilities are needed, not which cloud services implement them.

## Inputs

- **Required:** `nfr-targets.md` and `tech-stack-decisions.md` from nfr-assessment
- **Optional context:** functional-design artifacts (business logic shapes the patterns), `unit-contracts.md` (integration patterns affect resilience design)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `nfr-patterns.md` — architectural patterns selected to meet each NFR target (with rationale and trade-offs)
- `logical-components.md` — non-business components needed: caches, queues, circuit breakers, rate limiters, health checks, metric emitters

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent: validate security patterns are defence-in-depth and enforcement points are complete

## Reviewer

aidlc-architecture-reviewer-agent
