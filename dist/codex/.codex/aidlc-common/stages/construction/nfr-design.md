---
slug: nfr-design
phase: construction
execution: CONDITIONAL
condition: NFR Requirements was executed and NFR patterns need design. Skip if NFR Requirements was skipped.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-aws-platform-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-architecture-reviewer-agent
review_artifact: security-design
reviewer_max_iterations: 2
for_each: unit-of-work
produces:
  - performance-design
  - security-design
  - scalability-design
  - reliability-design
  - observability-design
  - logical-components
  - traceability
produces_kinds:
  performance-design: [service, ui]
  scalability-design: [service]
  reliability-design: [service]
  observability-design: [service]
  logical-components: [service, ui, library]
consumes:
  - artifact: performance-requirements
    required: true
  - artifact: security-requirements
    required: true
  - artifact: scalability-requirements
    required: true
  - artifact: reliability-requirements
    required: true
  - artifact: observability-requirements
    required: true
  - artifact: tech-stack-decisions
    required: true
  - artifact: functional-spec
    required: true
  - artifact: contract-summary
    required: false
requires_stage:
  - units-generation
  - nfr-requirements
sensors:
  - required-sections
  - upstream-coverage
  - linter
  - type-check
  - traceability
scopes:
  - enterprise
  - feature
  - mvp
  - infra
  - classic
  - workshop
inputs: NFR requirements artifacts, functional design artifacts
outputs: "performance-design.md, security-design.md, scalability-design.md, reliability-design.md, observability-design.md, logical-components.md, traceability.json (under this stage's per-unit record dir, engine-resolved); per-kind applicability via produces_kinds (untagged unit: all)"
---

# NFR Design

## Constraints

This is a design stage — artifacts describe architectural patterns, strategies, and decisions, not implementation-ready code. Complete implementations (middleware, interceptors, retry libraries, encryption routines) belong in code-generation. Limit code to short illustrative snippets (pseudocode or interface-level, ≤15 lines) that clarify a design decision.

## Steps

### Execution Modes

This stage supports two execution modes, controlled by the orchestrator:

**QUESTION-ONLY mode** (invoked by orchestrator during a Bolt's question phase):
Execute Steps 1–3 only (read artifacts, generate questions, collect answers).
Do NOT proceed to design or artifact generation. Return control to the orchestrator.

**ARTIFACT-ONLY mode** (invoked by orchestrator during a Bolt's design phase):
Skip Steps 1–3 (questions already collected and approved).
Read the answered questions file from the per-unit directory.
Execute Steps 4–7 only (design solutions, generate artifacts, update state, completion).

**Full mode** (default — single-unit projects or direct stage invocation):
Execute all steps sequentially as written.

### Step 1: Read Prior Artifacts

Read NFR requirements from `<record>/construction/{unit-name}/nfr-requirements/`. Read functional design artifacts from `<record>/construction/{unit-name}/functional-design/` (if they exist). Read the inter-unit contracts from `<record>/inception/contract-design/contract-summary.md` (if produced) — the integration mechanism and failure behaviour at each boundary drive the resilience and scalability patterns designed here. Read the domain-design component catalogue from `<record>/inception/domain-design/components.md` (if exists) for architectural context; when the scope skipped those design stages, derive the architectural context from the NFR requirements and, on brownfield, the code knowledge base — never invent the content of a missing artifact.

### Step 2: Generate Design Questions

Create a questions file at `<record>/construction/{unit-name}/nfr-design/nfr-design-questions.md` with context-appropriate questions using [Answer]: tags.

Focus areas:
- Resilience patterns (circuit breakers, bulkheads, fallback strategies)
- Scalability patterns (horizontal vs vertical, data partitioning, caching tiers)
- Performance optimization (latency budgets, throughput targets, resource pooling)
- Security approach (defense in depth, zero trust, encryption standards)
- Observability approach (metrics and SLI/SLO targets, structured logging, tracing depth, alerting philosophy, dashboard needs)
- Logical component boundaries (service isolation, failure domains, blast radius)

### Step 3: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file). After collecting answers, perform MANDATORY ambiguity analysis:
- Identify vague answers ("mix of", "not sure", "depends", "probably")
- Check for contradictions between answers
- Flag missing details needed for artifact generation

If ANY ambiguity found: create follow-up questions and resolve before proceeding.

### Step 4: Design NFR Solutions

Design concrete solutions for each NFR category:

- **Performance**: Caching strategies, query optimization, connection pooling, async processing, CDN usage, lazy loading, pagination
- **Security**: Authentication flows, authorization model, encryption (at rest and in transit), input validation, CSRF/XSS protection, secrets management, audit logging
- **Scalability**: Horizontal/vertical scaling approach, load balancing, data partitioning/sharding, queue-based decoupling, stateless design
- **Reliability**: Circuit breakers, retry policies with backoff, health checks, graceful degradation, failover strategies, data replication
- **Observability**: Metrics collection strategy, structured logging design, distributed tracing architecture, alerting rules, dashboard specifications, SLI/SLO tracking, correlation ID propagation

### Step 5: Generate Artifacts

Generate the following in `<record>/construction/{unit-name}/nfr-design/`:

- **performance-design.md**: Caching architecture, optimization strategies, resource pooling, async patterns, performance budgets
- **security-design.md**: Authentication/authorization architecture, encryption design, input validation strategy, security headers, compliance controls
- **scalability-design.md**: Scaling architecture, load distribution, data partitioning strategy, capacity thresholds, auto-scaling rules
- **reliability-design.md**: Resilience patterns, circuit breaker configuration, retry policies, health check design, failover procedures, backup strategy
- **observability-design.md**: Metrics collection architecture, structured logging design, distributed tracing strategy, alerting rules and escalation, dashboard specifications, SLI/SLO definitions, correlation ID propagation
- **logical-components.md**: Logical infrastructure component inventory — service boundaries, failure domains, blast radius mapping, component isolation strategy, shared resource identification. Bridges NFR design decisions with Infrastructure Design by providing a component-level view of where NFR patterns apply.

Create `<record>/construction/{unit-name}/nfr-design/traceability.json`.
Enumerate every `NFRx.y` from this Unit's NFR requirements and map it to the
concrete design solution:

```json
{
  "stage": "nfr-design",
  "unit": "u1-auth",
  "upstream_ids": ["NFR1.1", "NFR1.2"],
  "coverage": [
    { "id": "NFR1.1", "status": "OK", "target": "Redis cache with connection pooling" },
    { "id": "NFR1.2", "status": "GAP" }
  ]
}
```

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .codex/tools/aidlc-orchestrate.ts report --stage nfr-design --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 7: Completion

Present completion message and approval gate:

```
# :shield: NFR Design Complete — {unit-name}
```

Summary of design decisions per NFR category, then:

```
**Review:** `<record>/construction/{unit-name}/nfr-design/`
```

Approval gate: strictly 2-option (Approve / Request Changes).

## Sensors

This stage's outputs are markdown design artefacts under `<record>/construction/{unit-name}/nfr-design/`. Some sections include code samples that the code-shape sensors can also flag.

Imports: `required-sections`, `upstream-coverage`, `linter`, `type-check`, `traceability`.

Upstream targets: `performance-requirements`, `security-requirements`, `scalability-requirements`, `reliability-requirements`, `observability-requirements`, `tech-stack-decisions`, `functional-spec`, `contract-summary`.

`linter` and `type-check` inspect matching TypeScript/JavaScript snippets.
`traceability` verifies that every detailed NFR requirement is declared and
covered by a design solution.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
