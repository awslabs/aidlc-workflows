# Architecture Guide

## Architectural Style Selection

Choose based on system characteristics:

| Style | When to Use | Avoid When |
|-------|-------------|------------|
| Modular Monolith | Single team, shared database, <10 bounded contexts | Independent scaling needed per module |
| Microservices | Multiple teams, independent deploy cycles, polyglot needs | Small team, simple domain, early-stage product |
| Event-Driven | Async workflows, audit trails, temporal decoupling needed | Strong consistency required everywhere |
| Serverless | Sporadic traffic, event-triggered compute, rapid prototyping | Long-running processes, predictable high throughput |
| Layered (N-Tier) | CRUD-dominant apps, well-understood domain | Complex domain logic, high-performance paths |

## Component Boundary Identification

A component boundary is correct when:
- The component has a single, nameable responsibility
- It owns its data (no shared mutable state across boundaries)
- Changes to its internals do not ripple to other components
- It can be tested in isolation with stub/mock dependencies
- It has a clear public API surface (no back-channel coupling)

Red flags for wrong boundaries:
- Two components that always deploy together
- Circular dependencies between components
- A component that is just a pass-through proxy
- Shared database tables written by multiple components

## Design Pattern Checklist

For each pattern decision, evaluate:
1. **Problem fit**: Does the pattern solve the specific problem, not a hypothetical one?
2. **Complexity cost**: Is the added indirection justified by the flexibility gained?
3. **Team familiarity**: Can the team maintain this pattern without the architect present?
4. **Testing impact**: Does the pattern make the system easier or harder to test?

Common patterns and their AI-DLC application:
- **Repository**: Data access abstraction -- use when persistence technology may change
- **CQRS**: Separate read/write models -- use when read and write patterns diverge significantly
- **Saga/Orchestrator**: Distributed transaction coordination -- use for cross-service workflows
- **Strategy**: Runtime algorithm selection -- use when behavior varies by configuration/tenant
- **Adapter/Port**: External integration isolation -- always use for third-party dependencies

## ADR Format

```
# ADR-NNN: [Decision Title]

## Status: [Proposed | Accepted | Deprecated | Superseded by ADR-NNN]

## Context
[What forces are at play? What constraints exist? What problem are we solving?]

## Decision
[What is the change we are making? Be specific and actionable.]

## Consequences
[What becomes easier? What becomes harder? What are the trade-offs?]

## Alternatives Considered
[What other options were evaluated and why were they rejected?]
```

## Infrastructure Pattern Alignment

When designing application topology, validate against infrastructure:
- **Stateless services**: Can scale horizontally behind a load balancer
- **Stateful services**: Need sticky sessions, distributed cache, or dedicated instances
- **Background workers**: Queue-driven, idempotent, with dead-letter handling
- **Scheduled jobs**: Cron-based, must handle overlapping executions
- **Edge functions**: Latency-sensitive, limited runtime, no persistent connections

## Reverse Engineering Synthesis Checklist

When receiving code scan results from Developer:
1. Identify the dominant architectural style (or lack thereof)
2. Map discovered components to bounded contexts
3. Trace data flow paths (request entry to persistence)
4. Flag coupling hotspots (high fan-in/fan-out modules)
5. Identify missing boundaries (God classes, shared state)
6. Assess test coverage alignment with architectural risk
7. Document observed patterns vs. intended patterns
8. Produce a component inventory with health ratings (healthy/at-risk/degraded)
