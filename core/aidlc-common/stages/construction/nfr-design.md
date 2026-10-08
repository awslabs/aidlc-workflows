---
slug: nfr-design
name: NFR Design
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

## Merged-mode note

When `nfr-requirements` is SKIP in scope (today: `classic`), this stage is the
only NFR pass per Unit — it elicits non-functional requirements inline during
its question phase and then designs the solutions in one dispatch and one
advisory review. Classic deliberately uses this merged shape to halve the NFR
dispatch and review cost per Unit; `feature` / `enterprise` keep the two
stages separate when the finer requirements-vs-design separation is wanted.

In merged mode the stage writes informational requirements files
(`performance-requirements.md`, `security-requirements.md`,
`scalability-requirements.md`, `reliability-requirements.md`,
`observability-requirements.md`, `tech-stack-decisions.md`) alongside the
declared design artifacts, under the same per-Unit record directory. Those
requirements files are not formal `produces` outputs (the engine's artifact
guard does not require them), but they carry the elicited targets and keep
the audit trail legible.

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

Read NFR requirements from `<record>/construction/{unit-name}/nfr-requirements/` **when `nfr-requirements` ran in scope**. When it did not run (merged-mode scopes such as `classic`), this directory does not exist and the requirements are not yet elicited — Step 2 below handles the elicitation inline. Read functional design artifacts from `<record>/construction/{unit-name}/functional-design/` (if they exist). Read the inter-unit contracts from `<record>/inception/contract-design/contract-summary.md` (if produced) — the integration mechanism and failure behaviour at each boundary drive the resilience and scalability patterns designed here. Read the domain-design component catalogue from `<record>/inception/domain-design/components.md` (if exists) for architectural context; when the scope skipped those design stages, derive the architectural context from the available inputs and, on brownfield, the code knowledge base — never invent the content of a missing artifact.

### Step 2: Generate Questions

Create a questions file at `<record>/construction/{unit-name}/nfr-design/nfr-design-questions.md` with context-appropriate questions using [Answer]: tags.

**Standalone mode (`nfr-requirements` ran).** Questions focus on design only:

- Resilience patterns (circuit breakers, bulkheads, fallback strategies)
- Scalability patterns (horizontal vs vertical, data partitioning, caching tiers)
- Performance optimization (latency budgets, throughput targets, resource pooling)
- Security approach (defense in depth, zero trust, encryption standards)
- Observability approach (metrics and SLI/SLO targets, structured logging, tracing depth, alerting philosophy, dashboard needs)
- Logical component boundaries (service isolation, failure domains, blast radius)

**Merged mode (`nfr-requirements` is SKIP in scope).** The questions span both
requirements (what to target) and design (how to achieve it) in one pass, so
include quantifiable requirement questions alongside the design ones:

- **Performance requirements**: response time targets, throughput, latency budgets, resource constraints
- **Security requirements**: authentication and authorization needs, data classification, compliance obligations
- **Scalability requirements**: load projections, scaling triggers, capacity planning
- **Reliability requirements**: availability targets (SLA/SLO), fault tolerance, backup/recovery expectations
- **Observability requirements**: monitoring, logging, tracing, and alerting needs
- **Technology stack**: selections and rationale where not yet decided
- All the design focus areas listed under Standalone mode above

In merged mode, assign a stable `NFR{n}.{m}` ID to every detailed requirement
you elicit (inheriting from the inception `NFR{n}` IDs in
`<record>/inception/requirements-analysis/requirements.md`). Design decisions
reference those IDs, so the one-pass elicitation preserves the same
traceability keys as the two-stage path.

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

**Design artifacts (always written — these are the stage's declared outputs):**

- **performance-design.md**: Caching architecture, optimization strategies, resource pooling, async patterns, performance budgets
- **security-design.md**: Authentication/authorization architecture, encryption design, input validation strategy, security headers, compliance controls
- **scalability-design.md**: Scaling architecture, load distribution, data partitioning strategy, capacity thresholds, auto-scaling rules
- **reliability-design.md**: Resilience patterns, circuit breaker configuration, retry policies, health check design, failover procedures, backup strategy
- **observability-design.md**: Metrics collection architecture, structured logging design, distributed tracing strategy, alerting rules and escalation, dashboard specifications, SLI/SLO definitions, correlation ID propagation
- **logical-components.md**: Logical infrastructure component inventory — service boundaries, failure domains, blast radius mapping, component isolation strategy, shared resource identification. Bridges NFR design decisions with Infrastructure Design by providing a component-level view of where NFR patterns apply.

**Requirements artifacts (merged mode only — informational, not declared `produces`):**

In merged mode (`nfr-requirements` SKIP in scope), also write the elicited
requirements alongside the design artifacts, in the same directory. These
files carry the targets the designs reference and keep the audit trail
legible; they are informational, so the engine's artifact guard does not
require their presence:

- **performance-requirements.md**: Response time targets, throughput requirements, latency budgets, resource constraints, benchmarks
- **security-requirements.md**: Authentication requirements, authorization model, data protection, compliance, threat considerations
- **scalability-requirements.md**: Load projections, scaling triggers, capacity planning, data growth, concurrency targets
- **reliability-requirements.md**: Availability targets (SLA/SLO), fault tolerance requirements, backup/recovery, graceful degradation
- **observability-requirements.md**: Monitoring requirements, logging standards, distributed tracing needs, alerting thresholds, dashboard requirements, SLI/SLO definitions
- **tech-stack-decisions.md**: Technology selections and rationale — languages, frameworks, databases, infrastructure tools, and justification for each choice

Every detailed requirement carries its `NFR{n}.{m}` ID (inherited from the
inception `NFR{n}` IDs in `requirements.md`). Design artifacts reference
those IDs.

Create `<record>/construction/{unit-name}/nfr-design/traceability.json`.
In standalone mode, enumerate every `NFRx.y` from this Unit's NFR
requirements and map it to the concrete design solution. In merged mode,
enumerate every inception `NFR{n}` applicable to this Unit and target the
derived `NFRx.y` IDs together with their design solutions. `N/A` requires a
justification:

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
`{{INVOKE}} engine orchestrate report --stage nfr-design --result <outcome>`.
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

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
