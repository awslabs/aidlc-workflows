---
slug: nfr-design
phase: construction
execution: CONDITIONAL
condition: NFR Requirements was executed and NFR patterns need design. Skip if NFR Requirements was skipped.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-aws-platform-agent
mode: inline
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
for_each: unit-of-work
produces:
  - performance-design
  - security-design
  - scalability-design
  - reliability-design
  - logical-components
produces_kinds:
  performance-design: [service, ui]
  scalability-design: [service]
  reliability-design: [service]
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
  - artifact: tech-stack-decisions
    required: true
  - artifact: business-logic-model
    required: true
requires_stage:
  - units-generation
  - nfr-requirements
sensors:
  - required-sections
  - upstream-coverage
  - linter
  - type-check
scopes:
  - enterprise
  - feature
  - mvp
  - infra
  - workshop
inputs: NFR requirements artifacts, functional design artifacts
outputs: "performance-design.md, security-design.md, scalability-design.md, reliability-design.md, logical-components.md (under this stage's per-unit record dir, engine-resolved); per-kind applicability via produces_kinds (untagged unit: all)"
---

# NFR Design

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Execution Modes

This stage supports two execution modes, controlled by the orchestrator:

**QUESTION-ONLY mode** (invoked by orchestrator during a Bolt's question phase):
Execute Steps 1–4 only (load personas, read artifacts, generate questions, collect answers).
Do NOT proceed to design or artifact generation. Return control to the orchestrator.

**ARTIFACT-ONLY mode** (invoked by orchestrator during a Bolt's design phase):
Skip Steps 1–4 (questions already collected and approved).
Read the answered questions file from the per-unit directory.
Execute Steps 5–8 only (design solutions, generate artifacts, update state, completion).

**Full mode** (default — single-unit projects or direct stage invocation):
Execute all steps sequentially as written.

### Step 1: Load Personas

Load aidlc-architect-agent (lead) persona from `agents/aidlc-architect-agent.md` and knowledge from `.claude/knowledge/aidlc-architect-agent/`. Load aidlc-aws-platform-agent persona from `agents/aidlc-aws-platform-agent.md` and knowledge from `.claude/knowledge/aidlc-aws-platform-agent/` for infrastructure and platform input. Apply aidlc-architect-agent as the primary perspective with aidlc-aws-platform-agent providing domain-specific input.

### Step 2: Read Prior Artifacts

Read NFR requirements from `<record>/construction/{unit-name}/nfr-requirements/`. Read functional design artifacts from `<record>/construction/{unit-name}/functional-design/` (if they exist). Read application design from `<record>/inception/application-design/` (if exists) for architectural context; when the scope skipped those design stages, derive the architectural context from the NFR requirements and, on brownfield, the code knowledge base — never invent the content of a missing artifact.

### Step 3: Generate Design Questions

Create a questions file at `<record>/construction/{unit-name}/nfr-design/nfr-design-questions.md` with context-appropriate questions using [Answer]: tags.

Focus areas:
- Resilience patterns (circuit breakers, bulkheads, fallback strategies)
- Scalability patterns (horizontal vs vertical, data partitioning, caching tiers)
- Performance optimization (latency budgets, throughput targets, resource pooling)
- Security approach (defense in depth, zero trust, encryption standards)
- Logical component boundaries (service isolation, failure domains, blast radius)

### Step 4: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file). After collecting answers, perform MANDATORY ambiguity analysis:
- Identify vague answers ("mix of", "not sure", "depends", "probably")
- Check for contradictions between answers
- Flag missing details needed for artifact generation

If ANY ambiguity found: create follow-up questions and resolve before proceeding.

### Step 5: Design NFR Solutions

Design concrete solutions for each NFR category:

- **Performance**: Caching strategies, query optimization, connection pooling, async processing, CDN usage, lazy loading, pagination
- **Security**: Authentication flows, authorization model, encryption (at rest and in transit), input validation, CSRF/XSS protection, secrets management, audit logging
- **Scalability**: Horizontal/vertical scaling approach, load balancing, data partitioning/sharding, queue-based decoupling, stateless design
- **Reliability**: Circuit breakers, retry policies with backoff, health checks, graceful degradation, failover strategies, data replication

### Step 6: Generate Artifacts

Generate the following in `<record>/construction/{unit-name}/nfr-design/`:

- **performance-design.md**: Caching architecture, optimization strategies, resource pooling, async patterns, performance budgets
- **security-design.md**: Authentication/authorization architecture, encryption design, input validation strategy, security headers, compliance controls
- **scalability-design.md**: Scaling architecture, load distribution, data partitioning strategy, capacity thresholds, auto-scaling rules
- **reliability-design.md**: Resilience patterns, circuit breaker configuration, retry policies, health check design, failover procedures, backup strategy
- **logical-components.md**: Logical infrastructure component inventory — service boundaries, failure domains, blast radius mapping, component isolation strategy, shared resource identification. Bridges NFR design decisions with Infrastructure Design by providing a component-level view of where NFR patterns apply.

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage nfr-design --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 8: Completion

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

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings).
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter (this stage consumes `performance-requirements`, `security-requirements`, `scalability-requirements`, `reliability-requirements`, `tech-stack-decisions`, `business-logic-model`).
- **`linter`** runs against any TypeScript/JavaScript snippets the design includes (matches `**/*.{ts,js}`).
- **`type-check`** runs against any TypeScript/TSX snippets the design includes (matches `**/*.{ts,tsx}`).

Failure modes land in `<record>/.aidlc-sensors/<stage-slug>/` as `SENSOR_FAILED` audit rows with per-sensor detail files.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → a practice line under the routed heading in
  `aidlc/spaces/<active-space>/memory/project.md` (default) or `team.md` (promoted)
- Verification check → new manifest at `.claude/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
