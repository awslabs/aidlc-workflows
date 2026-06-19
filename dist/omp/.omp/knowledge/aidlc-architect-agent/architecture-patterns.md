# Architecture Patterns

## Purpose
Select the right architectural style for your system's requirements. No pattern is universally best — each encodes trade-offs between complexity, scalability, team autonomy, and operational cost.

## Pattern Overview

| Pattern | Best For | Team Size | Complexity |
|---------|----------|-----------|------------|
| Modular Monolith | Most new projects, small-medium teams | 1-4 teams | Low-Medium |
| Microservices | Large orgs, independent deployment needs | 5+ teams | High |
| Serverless | Event-driven workloads, variable traffic | Any | Medium |
| Event-Driven | Async workflows, loose coupling, audit trails | 2+ teams | Medium-High |
| CQRS | Read-heavy with complex queries, separate scaling needs | 2+ teams | High |
| Hexagonal | Testability, swappable infrastructure, long-lived systems | Any | Medium |

## Modular Monolith

### Description
A single deployable unit with well-defined internal module boundaries. Modules communicate through explicit interfaces, not shared database tables.

### When to Use
- Starting a new product (default choice)
- Team is small (fewer than 20 developers)
- Domain boundaries are not yet clear
- Deployment simplicity is valued

### Key Rules
- Each module owns its data (separate schemas or schema prefixes)
- Modules communicate via defined interfaces (not direct database queries across modules)
- Module dependencies are acyclic and explicitly declared
- Extract to microservices later when boundaries are proven

### Trade-offs
- (+) Simple deployment, debugging, and testing
- (+) Refactoring across modules is straightforward
- (-) Scaling is all-or-nothing (cannot scale one module independently)
- (-) Technology choices are shared across all modules

## Microservices

### Description
Independently deployable services, each owning a bounded context with its own data store.

### When to Use
- Multiple teams need to deploy independently
- Different parts of the system have very different scaling needs
- Polyglot technology requirements
- Organization has mature DevOps and observability practices

### Key Rules
- Each service owns its database — no shared data stores
- Services communicate via APIs or events, never direct database access
- Design for failure: every remote call can fail
- Deploy independently with backward-compatible API changes

### Trade-offs
- (+) Independent deployment, scaling, and technology choice
- (+) Team autonomy and clear ownership boundaries
- (-) Distributed system complexity (network failures, data consistency, debugging)
- (-) Operational overhead (monitoring, deployment pipelines per service)
- (-) Integration testing is difficult

## Serverless

### Description
Application logic runs in ephemeral, event-triggered functions managed by the cloud provider. No server provisioning or management.

### When to Use
- Event-driven workloads (file processing, webhooks, scheduled tasks)
- Highly variable traffic with long idle periods
- Rapid prototyping with minimal infrastructure
- Cost optimization for low or bursty traffic

### Key Rules
- Functions should be stateless — use external stores for state
- Keep cold start impact low (small bundles, provisioned concurrency for latency-sensitive paths)
- Design for idempotency — events may be delivered more than once
- Set concurrency limits to protect downstream systems

### Trade-offs
- (+) Zero infrastructure management, pay-per-use pricing
- (+) Automatic scaling to zero and to peak
- (-) Cold start latency (problematic for synchronous user-facing requests)
- (-) Vendor lock-in to cloud provider's function runtime and event sources
- (-) Debugging distributed function chains is difficult
- (-) Execution time limits (15 minutes on AWS Lambda)

## Event-Driven Architecture

### Description
Components communicate by producing and consuming events through a message broker. Producers do not know about consumers.

### When to Use
- Loose coupling between components is essential
- Workflows are asynchronous (order processing, notifications, data pipelines)
- Audit trails and event replay are needed
- Multiple consumers need to react to the same event

### Key Patterns
- **Event Notification**: Signal that something happened; consumer fetches details
- **Event-Carried State Transfer**: Event contains all data the consumer needs
- **Event Sourcing**: Store the sequence of events as the source of truth (not current state)

### Trade-offs
- (+) Loose coupling, independent scalability, natural audit trail
- (-) Eventual consistency (not all components see changes simultaneously)
- (-) Event ordering and deduplication complexity
- (-) Debugging event flows requires distributed tracing

## CQRS (Command Query Responsibility Segregation)

### Description
Separate the write model (commands that change state) from the read model (queries that return data). Each can use different data stores and schemas optimized for their purpose.

### When to Use
- Read and write patterns are very different (read-heavy with complex projections)
- Read and write sides need to scale independently
- Domain model is complex and queries require flattened/denormalized views

### Key Rules
- Commands validate business rules and write to the write store
- Events propagate changes to the read store (eventually consistent)
- Read models are disposable — they can be rebuilt from the event stream
- Accept eventual consistency between write and read sides

### Trade-offs
- (+) Optimized read and write performance independently
- (+) Read models tailored to specific UI needs without compromising domain model
- (-) Increased complexity (two models, synchronization, eventual consistency)
- (-) Overkill for simple CRUD applications

## Hexagonal Architecture (Ports and Adapters)

### Description
Business logic at the center, surrounded by ports (interfaces) and adapters (implementations). External systems connect through adapters; business logic never depends on infrastructure.

### Structure
```
Adapters (Infrastructure)
  └── Ports (Interfaces)
       └── Domain (Business Logic) ← depends on nothing external
```

### When to Use
- Business logic is complex and must be testable in isolation
- Infrastructure may change (swap database, replace message broker, change cloud provider)
- Long-lived systems where technology choices will evolve

### Key Rules
- Domain layer has zero dependencies on frameworks or infrastructure
- All external interactions go through port interfaces defined by the domain
- Adapters implement ports and translate between domain and external formats
- Tests can use in-memory adapters (no database, no network required)

## Migration Paths

| From | To | Approach |
|------|----|----------|
| Monolith | Modular Monolith | Identify module boundaries, enforce interface contracts, separate data |
| Modular Monolith | Microservices | Extract one module at a time (strangler fig pattern), starting with the least coupled |
| Monolith | Serverless | Extract event-driven workflows first (background jobs, file processing) |
| Microservices | Modular Monolith | Consolidate when services are too small, team boundaries have shifted, or operational cost exceeds benefit |

## Decision Framework
1. Start with a modular monolith unless you have proven reasons not to
2. Extract to microservices only when team autonomy or independent scaling demands it
3. Use serverless for event-driven workloads and glue code, not for core request-response APIs
4. Apply CQRS only when read and write models genuinely diverge
5. Use hexagonal architecture in the domain layer regardless of the outer architecture style
