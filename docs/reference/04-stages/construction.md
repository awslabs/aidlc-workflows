# Construction Phase -- Stage Reference (3.1-3.7)

## Phase Overview

The Construction phase transforms design artifacts from Inception into working,
tested software. It covers seven stages (3.1 through 3.7) that span functional
design, non-functional requirements and design, infrastructure design, code
generation, build/test verification, and CI pipeline configuration.

Construction is the fourth of five phases in the AI-DLC methodology. It is
driven by the **execution plan** produced during Delivery Planning (Stage 2.8).
The plan determines which stages execute, which are skipped, and in what order
units are built.

All stages follow `stage-protocol.md` for approval gates, question format,
completion messages, and state tracking.

> **Path convention.** Each workflow's artifacts live under its **intent record
> dir** — `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (where `<space>` is
> `default` unless a non-default space is in play, and `<YYMMDD>-<label>` is the
> intent directory: a compact UTC date prefix like `260624` plus a short
> kebab-case label so records sort chronologically). Below, `<record>/` is
> shorthand for that dir; e.g.
> `<record>/construction/{unit-name}/functional-design/` expands to
> `aidlc/spaces/default/intents/<YYMMDD>-<label>/construction/{unit-name}/functional-design/`.
> The dir name is a human-readable label; the canonical identity is the UUIDv7
> stored in the `intents.json` registry row. (Projects created before the
> per-intent layout used a flat tree; the engine migrates them on first run.)

---

## Bolt-by-Bolt Construction

Construction executes **Bolt by Bolt**, driven by `bolt-plan.md` (Bolt
sequence + walking-skeleton marker) from stage 2.8 and the dependency DAG
from stage 2.7. A [Bolt](../../guide/glossary.md) is one pass through stages
3.1–3.5 for a Unit or small group of dependency-linked Units. Stages 3.6
(Build and Test) and 3.7 (CI Pipeline) run **once** at the end across all
Bolts.

```
Bolt 1 (walking skeleton) — always gated:
  Questions (3.1–3.4 across the Bolt's Units in QUESTION-ONLY mode)
  → Answers gate (Bolt-level)
  Design artifacts (3.1–3.4 in ARTIFACT-ONLY mode)
  Code generation (3.5 per Unit via Task delegation)
  → Walking-skeleton gate
  → Ladder prompt (fires once): "autonomous" or "gated"
  → Write Construction Autonomy Mode to state

Bolt 2..N — autonomy mode governs the gate:
  (Parallel-eligible Bolts run as a batch; single batch-level gate covers
   every Bolt in it.)
  Questions → Answers gate (Bolt-level) → Design → Code-gen → Bolt/batch
  gate (skipped if autonomous). Failure always halts and asks.

After all Bolts:
  3.6 Build and Test (runs once across the full codebase)
  3.7 CI Pipeline    (runs once, conditional)
```

Each design stage file (3.1–3.4) supports QUESTION-ONLY and ARTIFACT-ONLY
execution modes — see the individual stage files for details. Code Generation's
Step 3 **Plan Approval always hard-stops before generation**, including during
Bolt execution. Only its Step 7 per-Unit completion approval gate is
**suppressed by the engine** during normal Bolt execution; a single Bolt-level
(or batch-level) completion gate replaces it. The per-Unit completion gate
remains for direct-invocation use (e.g., `/aidlc --stage code-generation`).

**Design-stage iteration order (opt-in).** By default the engine iterates the
four inline design stages (3.1 through 3.4) stage-major: it runs 3.1 for every Unit,
then 3.2 for every Unit, and so on. When the state file records
`Construction Iteration: unit-major` under `## Runtime State` (set at
delivery-planning via `aidlc-state.ts set-construction-iteration unit-major`, or
by a human), the engine walks unit-major instead: for each Unit in Bolt build
order, it authors that Unit's four design documents (3.1 through 3.4)
consecutively before the next Unit begins. The four per-stage approval gates are
unchanged in count and machinery; under unit-major they fire late, in stage
order, once the whole (stage by Unit) design grid is covered, one human approval
per stage.
`code-generation` (3.5, `mode: subagent`) is never part of this walk. Only the
exact value `unit-major` activates it; absent or `stage-major` is the default.

**Parallel batches.** When two or more Bolts share dependency-satisfaction
and don't depend on each other, the conductor dispatches their Code
Generation stages concurrently by issuing N `Task` calls in a single
assistant message. One batch-level gate covers them all. Audit events
(`BOLT_STARTED`, `BOLT_COMPLETED`) carry a `Batch=N` field so siblings are
recoverable from the log.

**Failure handling.** A Bolt failure always halts Construction regardless
of autonomy mode. Options are retry (re-run just the failed Bolt), skip
(mark `[S]` and continue — dependent Bolts may also fail), or abort.
Successful siblings in a parallel batch keep their `[x]` status and
artifacts. See `stage-protocol.md` §1 "Construction Bolt gates" and
SKILL.md §CONSTRUCTION Flow for the canonical specification.

---

## Stage Summary Table

| Stage | Name                  | Execution   | Condition                                                                                          | Lead Agent          | Support Agents    | Mode                       | Per-Unit |
|-------|-----------------------|-------------|----------------------------------------------------------------------------------------------------|---------------------|-------------------|-----------------------------|----------|
| 3.1   | Functional Design     | CONDITIONAL | New data models, complex business logic, or business rules need design                             | aidlc-architect-agent     | aidlc-developer-agent   | inline                      | Yes      |
| 3.2   | NFR Requirements      | CONDITIONAL | Performance, security, scalability concerns, or tech stack selection needed                         | aidlc-architect-agent     | aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent   | inline                      | Yes      |
| 3.3   | NFR Design            | CONDITIONAL | NFR Requirements was executed and NFR patterns need design                                          | aidlc-architect-agent     | aidlc-aws-platform-agent| inline                      | Yes      |
| 3.4   | Infrastructure Design | CONDITIONAL | Infrastructure services need mapping, deployment architecture required, or cloud resources needed   | aidlc-aws-platform-agent  | aidlc-devsecops-agent, aidlc-compliance-agent   | inline                      | Yes      |
| 3.5   | Code Generation       | ALWAYS      | Always executes for every unit in the execution plan                                               | aidlc-developer-agent     | (none)            | subagent (aidlc-developer-agent)  | Yes      |
| 3.6   | Build and Test        | ALWAYS      | Always executes once after all per-unit stages are finished                                         | aidlc-quality-agent       | aidlc-devsecops-agent   | inline                      | No       |
| 3.7   | CI Pipeline           | CONDITIONAL | Execute when CI pipeline needs creation or significant modification                                | aidlc-pipeline-deploy-agent| (none)           | inline                      | No       |

---

## Stage 3.1: Functional Design

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.1                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (per execution plan)                                                                  |
| Condition         | New data models, complex business logic, or business rules need design. Skip if simple logic changes with no new business logic. |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-developer-agent                                                                                   |
| mode              | inline                                                                                            |
| Inputs            | unit-of-work.md, unit-of-work-story-map.md, requirements.md, application design artifacts         |
| Outputs           | `<record>/construction/{unit-name}/functional-design/` -- business-logic-model.md, business-rules.md, domain-entities.md, CONDITIONAL: frontend-components.md |

### Purpose

Design the business logic, domain model, and rules for a single unit of work.
The aidlc-architect-agent leads with the aidlc-developer-agent providing technical
feasibility input.

### Inputs

- Unit definition from `<record>/inception/units-generation/unit-of-work.md`
- Assigned stories from `<record>/inception/units-generation/unit-of-work-story-map.md`
- Requirements from `<record>/inception/requirements-analysis/requirements.md`
- Application design artifacts from `<record>/inception/application-design/`

### Steps

1. **Load Personas** -- Load aidlc-architect-agent (lead) persona and knowledge.
   Load aidlc-developer-agent persona and knowledge for technical implementation
   input. Apply aidlc-architect-agent as the primary perspective.

2. **Read Unit Context** -- Read the unit definition, assigned stories,
   requirements, and application design artifacts.

3. **Create Functional Design Plan** -- Analyze the unit's scope and create a
   questions file at
   `<record>/construction/{unit-name}/functional-design/functional-design-questions.md`
   with context-appropriate questions using `[Answer]:` tags. Focus areas:
   - Business logic workflows and algorithms
   - Domain models and entity relationships
   - Business rules, constraints, and validation logic
   - Data flow and transformations
   - Integration points with other units or external systems
   - Error handling and edge cases
   - Frontend components (component hierarchy, props/state, interaction flows,
     form validation)
   - Business scenarios (end-to-end user journeys, happy/unhappy paths,
     concurrency edge cases)

4. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md question flow (offer interaction mode choice, collect
   answers, write back to file). Perform MANDATORY ambiguity analysis:
   - Identify vague answers ("mix of", "not sure", "depends", "probably")
   - Check for contradictions between answers
   - Flag missing details needed for artifact generation
   - If ANY ambiguity found: create follow-up questions and resolve before
     proceeding

5. **Generate Artifacts** -- Generate the following in
   `<record>/construction/{unit-name}/functional-design/`:
   - **business-logic-model.md**: Detailed algorithms, workflows, data
     transformations, processing sequences, and decision trees for the unit's
     business logic
   - **business-rules.md**: Decision rules, validation logic, constraints,
     policies, conditional behavior, and business invariants
   - **domain-entities.md**: Entities, relationships, data structures,
     attributes, lifecycle states, and entity interaction patterns
   - **frontend-components.md** (CONDITIONAL -- only if unit includes
     frontend/UI): Component hierarchy, props/state design, interaction flows,
     form validation rules, API integration points

6. **Prepare Completion** -- Verify the unit's Functional Design artifacts.
   Do not edit state; report the gate outcome through `aidlc-orchestrate.ts`.

7. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                 | Description                                                              |
|--------------------------|--------------------------------------------------------------------------|
| business-logic-model.md  | Algorithms, workflows, data transformations, processing sequences, decision trees |
| business-rules.md        | Decision rules, validation logic, constraints, policies, conditional behavior |
| domain-entities.md       | Entities, relationships, data structures, attributes, lifecycle states   |
| frontend-components.md   | (CONDITIONAL) Component hierarchy, props/state, interaction flows, form validation, API integration |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes

- The questions file is co-located with stage artifacts at
  `<record>/construction/{unit-name}/functional-design/functional-design-questions.md`.
- frontend-components.md is only produced when the unit includes frontend/UI
  work.
- All questions use the tri-mode interaction flow (Guide me / I'll edit the
  file / Chat).

---

## Stage 3.2: NFR Requirements

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.2                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (per execution plan)                                                                  |
| Condition         | Performance requirements, security considerations, scalability concerns, or tech stack selection needed. Skip if no NFR requirements and tech stack already determined. |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent                                       |
| mode              | inline                                                                                            |
| Inputs            | functional design artifacts, requirements.md, RE artifacts                                        |
| Outputs           | `<record>/construction/{unit-name}/nfr-requirements/` -- performance-requirements.md, security-requirements.md, scalability-requirements.md, reliability-requirements.md, tech-stack-decisions.md |

### Purpose

Define non-functional requirements across performance, security, scalability,
reliability, and technology selection for a single unit. The aidlc-architect-agent
leads, with the aidlc-devsecops-agent providing security input, the
aidlc-compliance-agent providing regulatory input, and the aidlc-quality-agent
providing testability and measurability input.

### Inputs

- Functional design artifacts from
  `<record>/construction/{unit-name}/functional-design/` (if they exist)
- Requirements from `<record>/inception/requirements-analysis/requirements.md`
- Reverse engineering artifacts from
  `aidlc/spaces/<active-space>/codekb/<repo>/` (if they exist)

### Steps

1. **Load Personas** -- Load aidlc-architect-agent (lead) persona and knowledge.
   Load aidlc-devsecops-agent (security requirements), aidlc-compliance-agent
   (regulatory requirements), and aidlc-quality-agent (testability) personas and
   knowledge for support input.

2. **Read Prior Artifacts** -- Read functional design artifacts (if they
   exist), requirements, and reverse engineering artifacts.

3. **Assess NFR Categories** -- Analyze the unit across NFR categories:
   - **Performance**: Response times, throughput, latency targets, resource
     utilization
   - **Security**: Authentication, authorization, data protection, compliance
     requirements
   - **Scalability**: Load handling, growth projections, scaling strategies
   - **Reliability**: Availability targets, fault tolerance, disaster recovery,
     data durability
   - **Observability**: Monitoring, logging, alerting, tracing requirements

4. **Generate Questions** -- Create a questions file at
   `<record>/construction/{unit-name}/nfr-requirements/nfr-requirements-questions.md`
   for unclear NFR areas using `[Answer]:` tags. Focus on quantifiable targets
   and specific constraints.

5. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md question flow. Perform MANDATORY ambiguity analysis:
   - Identify vague answers ("fast enough", "highly available", "secure")
   - Check for contradictions between NFR targets
   - Flag missing quantitative targets
   - If ANY ambiguity found: create follow-up questions and resolve before
     proceeding

6. **Generate Artifacts** -- Generate the following in
   `<record>/construction/{unit-name}/nfr-requirements/`:
   - **performance-requirements.md**: Response time targets, throughput
     requirements, latency budgets, resource constraints, benchmarks
   - **security-requirements.md**: Authentication requirements, authorization
     model, data protection, compliance, threat considerations
   - **scalability-requirements.md**: Load projections, scaling triggers,
     capacity planning, data growth, concurrency targets
   - **reliability-requirements.md**: Availability targets (SLA/SLO), fault
     tolerance requirements, backup/recovery, graceful degradation
   - **tech-stack-decisions.md**: Technology selections and rationale --
     languages, frameworks, databases, infrastructure tools, and justification
     for each choice

7. **Prepare Completion** -- Verify the unit's NFR Requirements artifacts.
   Do not edit state; report the gate outcome through `aidlc-orchestrate.ts`.

8. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                     | Description                                                                |
|------------------------------|----------------------------------------------------------------------------|
| performance-requirements.md  | Response times, throughput, latency budgets, resource constraints, benchmarks |
| security-requirements.md     | Authentication, authorization, data protection, compliance, threats        |
| scalability-requirements.md  | Load projections, scaling triggers, capacity planning, concurrency         |
| reliability-requirements.md  | Availability targets (SLA/SLO), fault tolerance, backup/recovery           |
| tech-stack-decisions.md      | Technology selections with rationale for each choice                       |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes -- NFR Granularity Expansion

This stage produces **5 artifact files**, expanded from the upstream reference
which defines only 2 files for NFR Requirements. This is a deliberate deviation
documented in SKILL.md ("Deliberate Deviations from Reference"). The finer
granularity improves traceability and allows per-concern review without
overloading a single document. The five files separate performance, security,
scalability, and reliability into dedicated artifacts, and add a dedicated
tech-stack-decisions.md for technology selection rationale.

---

## Stage 3.3: NFR Design

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.3                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (only if NFR Requirements was executed)                                               |
| Condition         | NFR Requirements was executed and NFR patterns need design. Skip if NFR Requirements was skipped. |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-aws-platform-agent                                                                                |
| mode              | inline                                                                                            |
| Inputs            | NFR requirements artifacts, functional design artifacts                                           |
| Outputs           | `<record>/construction/{unit-name}/nfr-design/` -- performance-design.md, security-design.md, scalability-design.md, reliability-design.md, logical-components.md |

### Purpose

Translate NFR requirements into concrete design patterns and architectural
solutions. The aidlc-architect-agent leads with the aidlc-aws-platform-agent providing
infrastructure and platform input.

### Inputs

- NFR requirements from `<record>/construction/{unit-name}/nfr-requirements/`
- Functional design artifacts from
  `<record>/construction/{unit-name}/functional-design/` (if they exist)
- Application design from `<record>/inception/application-design/` for
  architectural context

### Steps

1. **Load Personas** -- Load aidlc-architect-agent (lead) persona and knowledge.
   Load aidlc-aws-platform-agent persona and knowledge for infrastructure and
   platform input.

2. **Read Prior Artifacts** -- Read NFR requirements, functional design
   artifacts (if they exist), and application design for architectural context.

3. **Generate Design Questions** -- Create a questions file at
   `<record>/construction/{unit-name}/nfr-design/nfr-design-questions.md`
   with context-appropriate questions using `[Answer]:` tags. Focus areas:
   - Resilience patterns (circuit breakers, bulkheads, fallback strategies)
   - Scalability patterns (horizontal vs vertical, data partitioning, caching
     tiers)
   - Performance optimization (latency budgets, throughput targets, resource
     pooling)
   - Security approach (defense in depth, zero trust, encryption standards)
   - Logical component boundaries (service isolation, failure domains, blast
     radius)

4. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md question flow. Perform MANDATORY ambiguity analysis:
   - Identify vague answers ("mix of", "not sure", "depends", "probably")
   - Check for contradictions between answers
   - Flag missing details needed for artifact generation
   - If ANY ambiguity found: create follow-up questions and resolve before
     proceeding

5. **Design NFR Solutions** -- Design concrete solutions for each NFR
   category:
   - **Performance**: Caching strategies, query optimization, connection
     pooling, async processing, CDN usage, lazy loading, pagination
   - **Security**: Authentication flows, authorization model, encryption (at
     rest and in transit), input validation, CSRF/XSS protection, secrets
     management, audit logging
   - **Scalability**: Horizontal/vertical scaling approach, load balancing,
     data partitioning/sharding, queue-based decoupling, stateless design
   - **Reliability**: Circuit breakers, retry policies with backoff, health
     checks, graceful degradation, failover strategies, data replication

6. **Generate Artifacts** -- Generate the following in
   `<record>/construction/{unit-name}/nfr-design/`:
   - **performance-design.md**: Caching architecture, optimization strategies,
     resource pooling, async patterns, performance budgets
   - **security-design.md**: Authentication/authorization architecture,
     encryption design, input validation strategy, security headers, compliance
     controls
   - **scalability-design.md**: Scaling architecture, load distribution, data
     partitioning strategy, capacity thresholds, auto-scaling rules
   - **reliability-design.md**: Resilience patterns, circuit breaker
     configuration, retry policies, health check design, failover procedures,
     backup strategy
   - **logical-components.md**: Logical infrastructure component inventory --
     service boundaries, failure domains, blast radius mapping, component
     isolation strategy, shared resource identification. Bridges NFR design
     decisions with Infrastructure Design by providing a component-level view
     of where NFR patterns apply.

7. **Prepare Completion** -- Verify the unit's NFR Design artifacts. Do not
   edit state; report the gate outcome through `aidlc-orchestrate.ts`.

8. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact               | Description                                                                     |
|------------------------|---------------------------------------------------------------------------------|
| performance-design.md  | Caching architecture, optimization strategies, resource pooling, async patterns |
| security-design.md     | Auth architecture, encryption design, input validation, security headers        |
| scalability-design.md  | Scaling architecture, load distribution, data partitioning, auto-scaling rules  |
| reliability-design.md  | Resilience patterns, circuit breakers, retry policies, failover procedures      |
| logical-components.md  | Component inventory, service boundaries, failure domains, blast radius mapping  |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes -- NFR Design Granularity

This stage produces **5 artifact files** (4 NFR-specific designs plus
logical-components.md), expanded from the upstream reference which defines only
2 files for NFR Design. This is a deliberate deviation documented in SKILL.md
("Deliberate Deviations from Reference"). The logical-components.md artifact
serves as a bridge between NFR design and Infrastructure Design (Stage 3.4)
by mapping where NFR patterns apply at the component level.

---

## Stage 3.4: Infrastructure Design

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.4                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (per execution plan)                                                                  |
| Condition         | Infrastructure services need mapping, deployment architecture required, or cloud resources needed. Skip if no infrastructure changes and infrastructure already defined. |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-aws-platform-agent                                                                                |
| support_agents    | aidlc-devsecops-agent, aidlc-compliance-agent                                                           |
| mode              | inline                                                                                            |
| Inputs            | NFR design artifacts, application design, functional design                                       |
| Outputs           | `<record>/construction/{unit-name}/infrastructure-design/` -- deployment-architecture.md, infrastructure-services.md, monitoring-design.md, cicd-pipeline.md, CONDITIONAL: shared-infrastructure.md |

### Purpose

Design the infrastructure, deployment architecture, monitoring, and CI/CD
pipeline for a single unit. The aidlc-aws-platform-agent leads, with the
aidlc-devsecops-agent ensuring infrastructure security and the
aidlc-compliance-agent checking data residency and regulatory constraints.

### Inputs

- NFR design from `<record>/construction/{unit-name}/nfr-design/` (if exists)
- Functional design from
  `<record>/construction/{unit-name}/functional-design/` (if exists)
- Application design from `<record>/inception/application-design/`
- NFR requirements from
  `<record>/construction/{unit-name}/nfr-requirements/` (if exists)

### Steps

1. **Load Personas** -- Load aidlc-aws-platform-agent (lead) persona and knowledge.
   Load aidlc-devsecops-agent (infrastructure security) and aidlc-compliance-agent
   (data residency, regulatory constraints) personas and knowledge for support input.

2. **Read Prior Artifacts** -- Read all prior design artifacts for context:
   NFR design, functional design, application design, NFR requirements.

3. **Generate Infrastructure Questions** -- Create a questions file at
   `<record>/construction/{unit-name}/infrastructure-design/infrastructure-design-questions.md`
   with context-appropriate questions using `[Answer]:` tags. Focus areas:
   - Deployment strategy (containerized, serverless, hybrid, multi-region)
   - Compute/storage/networking (sizing, topology, latency requirements)
   - Monitoring approach (metrics, logging, tracing, alerting thresholds)
   - CI/CD pipeline (build stages, deployment strategy, rollback procedures)
   - Secrets management (vault, environment variables, rotation policy)
   - Scaling policy (auto-scaling triggers, capacity limits, cost constraints)

4. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md question flow. Perform MANDATORY ambiguity analysis:
   - Identify vague answers ("cloud-based", "auto-scale", "standard
     monitoring")
   - Check for contradictions between answers
   - Flag missing details needed for artifact generation
   - If ANY ambiguity found: create follow-up questions and resolve before
     proceeding

5. **Design Infrastructure** -- Design infrastructure across four areas:
   - **Deployment Architecture**: Compute model (containers, serverless, VMs),
     networking topology, storage strategy, environment layout
     (dev/staging/prod)
   - **Infrastructure Services**: Databases (type, sizing, replication), caches
     (strategy, eviction), message queues, search services, CDN, DNS, load
     balancers
   - **Monitoring & Observability**: Metrics collection, log aggregation,
     distributed tracing, alerting rules, dashboards, SLI/SLO tracking
   - **CI/CD Pipeline**: Build stages, test stages, deployment stages,
     environment promotion, rollback strategy, feature flags, artifact
     management

6. **Generate Artifacts** -- Generate the following in
   `<record>/construction/{unit-name}/infrastructure-design/`:
   - **deployment-architecture.md**: Compute resources, networking, storage,
     environment definitions, infrastructure-as-code approach, resource sizing
   - **infrastructure-services.md**: Database design, caching layer, messaging
     infrastructure, external service integrations, service discovery
   - **monitoring-design.md**: Metrics and KPIs, log strategy, tracing
     configuration, alert definitions, dashboard specifications, incident
     response
   - **cicd-pipeline.md**: Pipeline stages, build configuration, test
     automation integration, deployment strategy (blue-green, canary, rolling),
     rollback procedures, secrets management in CI/CD
   - **shared-infrastructure.md** (CONDITIONAL -- produce when multiple units
     share infrastructure resources): Shared databases, shared caches, shared
     message queues, shared networking, cross-unit service discovery, resource
     ownership and access boundaries

7. **Prepare Completion** -- Verify the unit's Infrastructure Design
   artifacts. Do not edit state; report the gate outcome through
   `aidlc-orchestrate.ts`.

8. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                   | Description                                                               |
|----------------------------|---------------------------------------------------------------------------|
| deployment-architecture.md | Compute, networking, storage, environment definitions, IaC approach       |
| infrastructure-services.md | Databases, caching, messaging, external integrations, service discovery   |
| monitoring-design.md       | Metrics, logs, tracing, alerts, dashboards, SLI/SLO tracking             |
| cicd-pipeline.md           | Pipeline stages, build config, deployment strategy, rollback procedures   |
| shared-infrastructure.md   | (CONDITIONAL) Shared resources across units, ownership boundaries         |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes -- Infrastructure Design Expansion

This stage produces **5 artifact files**, expanded from the upstream reference
which has 2-3 files. This is a deliberate deviation documented in SKILL.md
("Deliberate Deviations from Reference"). The additions of monitoring-design.md
and cicd-pipeline.md as dedicated artifacts improve operational visibility.
shared-infrastructure.md is produced conditionally only when multiple units
share infrastructure resources.

---

## Stage 3.5: Code Generation

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.5                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | ALWAYS (per-unit)                                                                                 |
| Condition         | Always executes for every unit in the execution plan.                                             |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-developer-agent                                                                                   |
| support_agents    | (none -- focused implementation)                                                                  |
| mode              | subagent (Task tool subagent_type: aidlc-developer-agent)                                               |
| Inputs            | ALL prior design artifacts for this unit                                                          |
| Outputs           | application code (workspace root) + `<record>/construction/{unit-name}/code-generation/` -- code-generation-plan.md, code-generation-questions.md, code-summary.md |

### Purpose

Generate all application code, tests, and configuration for a single unit of
work. This is the only stage that always executes for every unit regardless of
the execution plan. Code is written to the workspace root, never to
`<record>/`.

### Critical Rules

- Application code goes to workspace root, NEVER to `<record>/`
- Brownfield: modify files in-place. NEVER create duplicates like
  `ClassName_modified.java`
- Add `data-testid` attributes to interactive UI elements for test automation

### Inputs

- Functional design from
  `<record>/construction/{unit-name}/functional-design/` (if exists)
- NFR requirements from
  `<record>/construction/{unit-name}/nfr-requirements/` (if exists)
- NFR design from `<record>/construction/{unit-name}/nfr-design/` (if exists)
- Infrastructure design from
  `<record>/construction/{unit-name}/infrastructure-design/` (if exists)
- Application design from `<record>/inception/application-design/`
- Unit definition from
  `<record>/inception/units-generation/unit-of-work.md`
- Story map from
  `<record>/inception/units-generation/unit-of-work-story-map.md`

### Steps

This stage has a **two-part structure**: planning followed by generation.

#### PART 1 -- Planning (Steps 1-3)

1. **Read All Unit Artifacts** -- Read all design artifacts for the current
   unit (functional design, NFR requirements, NFR design, infrastructure
   design, application design, unit definition, story map).

2. **Create Code Generation Plan** -- Create a detailed plan at
   `<record>/construction/{unit-name}/code-generation/code-generation-plan.md`
   with checkboxes for each implementation step. Include story-to-code-step
   traceability -- map each plan step back to the user story it implements.

   **Recommended plan structure** (adapt if architecture warrants different
   ordering):

   ```
   Step 1:  Project structure setup (directories, config files, package.json/Cargo.toml/etc.)
   Step 2:  Data models / database schema / migrations
   Step 3:  Business logic layer (core domain logic, services)
   Step 4:  Business logic tests (unit tests for Step 3)
   Step 5:  API / endpoint layer (routes, controllers, handlers)
   Step 6:  API tests (unit + integration tests for Step 5)
   Step 7:  Repository / data access layer (queries, ORM config)
   Step 8:  Frontend components (if applicable -- UI components, pages, state)
   Step 9:  Frontend tests (component tests, interaction tests)
   Step 10: Configuration and environment setup (.env templates, build config)
   Step 11: Test configuration (vitest.config, jest.config, or equivalent)
   Step 12: Documentation (inline docs, API docs, README updates)
   ```

   This layer-by-layer approach ensures dependencies are built before
   dependents (data models before business logic, business logic before API).
   Deviate when the architecture requires it (e.g., event-driven systems,
   microservices with independent stacks).

   **Test files are MANDATORY in the plan.** The plan MUST include steps for:
   - Unit test files (one per component/module with key behavior coverage)
   - Test configuration (vitest.config, jest.config, or equivalent)

   If the plan omits test file steps, they must be added before presenting to
   the user. Tests are not deferred to Build and Test -- that stage verifies
   and extends, not creates from scratch.

   Number each plan step sequentially (Step 1, Step 2, etc.) for clear
   execution ordering and traceability.

3. **Plan Approval** -- Present the plan summary to the user and request
   approval. First create or reset
   `<record>/construction/{unit-name}/code-generation/code-generation-questions.md`
   with a **Plan Approval** question and blank `[Answer]:`, then render it as a
   structured question and stop the turn:
   - "Approve Plan" -- proceed to code generation
   - "Request Changes" -- revise the plan

   Fill the tag only after the human responds. A request for changes is
   recorded, the plan is revised, and the Plan Approval tag is reset to blank
   before re-prompting. A forwarding-loop continuation is never approval.

#### PART 2 -- Generation (Steps 4-7)

4. **Generate Code** -- Before delegating, display to the user:
   "Generating code for [N] plan steps. This may take several minutes
   depending on project complexity. I'll show a summary when complete."

   Delegate to Task tool with the aidlc-developer-agent subagent
   (subagent_type="aidlc-developer-agent").

   **Context passed to subagent:**
   - The lead agent's persona from `agents/aidlc-developer-agent.md` and knowledge
     from `.claude/knowledge/aidlc-developer-agent/` (included in the prompt
     since subagents cannot access conversation history)
   - Design artifacts for the CURRENT UNIT ONLY (not all units)
   - A 1-2 line summary of each inception-phase artifact with its file path
     (requirements summary, stories summary, app design summary) -- the
     subagent can Read specific files if it needs full content
   - The approved code-generation-plan.md (full content)
   - Project workspace details (languages, frameworks, conventions from
     aidlc-state.md)
   - Instructions to execute each plan step sequentially and mark checkboxes
     as completed

   **Context budget:** Pass only the current unit's design artifacts, not all
   units. Summarize inception artifacts with file paths rather than embedding
   full content. The subagent generates all code, test files, and
   configuration artifacts in the workspace.

5. **Generate Code Summary** -- After subagent completes, create
   `<record>/construction/{unit-name}/code-generation/code-summary.md`
   documenting:
   - Files created/modified
   - Key implementation decisions
   - Test coverage summary
   - Any deviations from the plan

6. **Prepare Completion** -- Verify the unit's code and summary artifacts.
   Do not edit state; report the gate outcome through `aidlc-orchestrate.ts`.

7. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                  | Description                                                         |
|---------------------------|---------------------------------------------------------------------|
| code-generation-plan.md   | Detailed plan with checkboxes, story traceability, step sequencing  |
| code-generation-questions.md | Persisted Plan Approval question and explicit human answer       |
| code-summary.md           | Files created/modified, decisions, test coverage, plan deviations   |
| (application code)        | All source code, tests, and config written to workspace root        |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes

- **Two-part structure**: The planning phase (Steps 1-3) runs inline with user
  interaction and plan approval. The generation phase (Steps 4-7) delegates to
  the aidlc-developer-agent subagent via the Task tool. This is different from most
  Construction stages which run entirely inline.
- **Developer-agent subagent**: Code generation uses `subagent_type="aidlc-developer-agent"`
  (delegated via Task tool), not inline execution. This is the only
  Construction stage that uses a subagent. The subagent inherits the full
  session toolset (the aidlc-developer-agent declares no `tools:` allowlist),
  so it reaches Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion, and the
  inherited MCP tools.
- **Context budget**: Only the current unit's design artifacts are passed to
  the subagent. Inception-phase artifacts are summarized in 1-2 lines with
  file paths so the subagent can selectively Read what it needs.
- **Mandatory test file inclusion**: Test files MUST be part of the code
  generation plan. Stage 3.6 (Build and Test) verifies and extends tests but
  does not create them from scratch.
- **Brownfield awareness**: In brownfield projects, the subagent modifies
  existing files in-place rather than creating duplicates.

---

## Stage 3.6: Build and Test

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.6                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | ALWAYS (after ALL units complete)                                                                 |
| Condition         | Always executes once after all per-unit stages are finished.                                      |
| Per-Unit          | No (runs once for all units)                                                                     |
| Lead Agent        | aidlc-quality-agent                                                                                     |
| support_agents    | aidlc-devsecops-agent                                                                                   |
| mode              | inline                                                                                            |
| Inputs            | ALL code generation outputs across all units                                                      |
| Outputs           | `<record>/construction/build-and-test/` -- build-instructions.md, unit-test-instructions.md, integration-test-instructions.md, performance-test-instructions.md, security-test-instructions.md, build-and-test-summary.md, test-results.md, plus conditional test instruction files |

### Purpose

Generate test instructions across all test types, then actually execute the
build and tests via Bash. This stage operates across ALL units -- it is NOT
per-unit. The aidlc-quality-agent leads with the aidlc-devsecops-agent providing security
testing expertise.

### Inputs

- Code generation outputs across all units from
  `<record>/construction/*/code-generation/code-summary.md`
- NFR requirements across units (if they exist) for performance and security
  testing needs

### Steps

1. **Load Personas** -- Load aidlc-quality-agent (lead) persona and knowledge. Load
   aidlc-devsecops-agent persona and knowledge for security testing input.

2. **Analyze Testing Requirements** -- Read code generation outputs across all
   units. Review NFR requirements (if they exist) to identify performance and
   security testing needs. Catalog all test types required.

3. **Generate Build Instructions** -- Create
   `<record>/construction/build-and-test/build-instructions.md`:
   - Dependency installation steps
   - Environment setup (env vars, config files, local services)
   - Build commands (compile, bundle, transpile)
   - Build verification steps
   - Troubleshooting common build issues

4. **Generate Unit Test Instructions** -- Create
   `<record>/construction/build-and-test/unit-test-instructions.md`:
   - Test framework setup and configuration
   - How to run unit tests (commands, flags, filters)
   - Expected test coverage targets
   - Mocking/stubbing guidance
   - Test data management

5. **Generate Integration Test Instructions** -- Create
   `<record>/construction/build-and-test/integration-test-instructions.md`:
   - Test environment prerequisites (databases, services, queues)
   - How to run integration tests
   - Cross-unit interaction testing
   - External dependency handling (stubs, test doubles, sandboxes)
   - Test data setup and teardown

6. **Generate Performance Test Instructions** (CONDITIONAL) -- IF NFR
   performance requirements exist for any unit, create
   `performance-test-instructions.md`:
   - Load testing tools and configuration
   - Performance test scenarios mapped to NFR targets
   - Baseline measurements and benchmarks
   - Stress and soak test procedures
   - Performance regression detection

7. **Generate Security Test Instructions** (CONDITIONAL) -- IF NFR security
   requirements exist for any unit, create
   `security-test-instructions.md`:
   - Security scanning tools (SAST, DAST, dependency audit)
   - Authentication/authorization test scenarios
   - Input validation and injection testing
   - Compliance verification steps
   - Vulnerability assessment procedures

8. **Generate Additional Test Types** (CONDITIONAL) -- As applicable based on
   project architecture, create specifically named files:
   - **contract-test-instructions.md**: For microservice APIs --
     consumer-driven contracts, schema validation, API compatibility
   - **e2e-test-instructions.md**: For UI-driven applications -- browser
     automation, user journey tests, cross-browser verification
   - **accessibility-test-instructions.md**: For user-facing interfaces --
     WCAG compliance, screen reader testing, keyboard navigation

   All files go in `<record>/construction/build-and-test/`.

9. **Generate Build and Test Summary** -- Create
   `<record>/construction/build-and-test/build-and-test-summary.md`:
   - Overall build status and prerequisites
   - Test type inventory (which test types were generated)
   - Coverage expectations per unit
   - Readiness assessment (build-ready, test-ready, deployment-ready)
   - Known limitations or outstanding items

10. **Execute Build and Tests** -- Attempt to execute the build and test
    commands documented in the instruction files **via Bash**:

    a. **Build**: Run the build commands from build-instructions.md via Bash.
       Capture output.
    b. **Unit tests**: Run the unit test command from
       unit-test-instructions.md via Bash. Capture pass/fail counts.
    c. **Integration tests** (if applicable): Run integration test commands.
       Capture results.
    d. **Report results**: Create or update
       `<record>/construction/build-and-test/test-results.md` with:
       - Build status (success/failure + output)
       - Test results (total, passed, failed, skipped)
       - Failure details (test name, assertion, stack trace)
       - Coverage report (if test framework supports it)

    **Failure diagnosis loop (2 attempts):** On failure, if build or tests
    fail, attempt to diagnose and fix the issue:
    - Read the error output
    - Identify the failing code
    - Apply the fix
    - Re-run the failing step
    - If unable to fix after 2 attempts, log the failure in test-results.md
      and present the issue to the user at the approval gate

    **On success:** Update the Build and Test Summary with actual results (not
    just instructions).

11. **Prepare Completion** -- Verify the build/test evidence. Do not edit
    stage or phase state; the reported gate outcome owns the transition.

12. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                          | Description                                                     | Condition          |
|-----------------------------------|-----------------------------------------------------------------|--------------------|
| build-instructions.md             | Dependency install, env setup, build commands, troubleshooting  | Always             |
| unit-test-instructions.md         | Test framework setup, run commands, coverage targets, mocking   | Always             |
| integration-test-instructions.md  | Prerequisites, cross-unit testing, external deps, data setup    | Always             |
| performance-test-instructions.md  | Load testing, NFR scenarios, baselines, stress/soak tests       | If NFR perf exists |
| security-test-instructions.md     | SAST/DAST, auth testing, injection testing, compliance          | If NFR sec exists  |
| contract-test-instructions.md     | Consumer-driven contracts, schema validation, API compat        | If microservices   |
| e2e-test-instructions.md          | Browser automation, user journeys, cross-browser                | If UI-driven       |
| accessibility-test-instructions.md| WCAG compliance, screen reader, keyboard nav                    | If user-facing UI  |
| build-and-test-summary.md         | Overall status, test inventory, coverage, readiness assessment  | Always             |
| test-results.md                   | Actual build/test execution results, pass/fail, coverage        | Always             |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes

- **Actual Bash execution**: This stage does not just document test
  instructions -- it actually runs the build and test commands via Bash and
  captures real results. This is one of the few stages that executes
  real commands against the codebase.
- **Failure diagnosis loop**: The stage attempts to automatically diagnose and
  fix failures, with a maximum of 2 attempts. If the fix fails after 2
  attempts, the failure is logged and surfaced to the user at the approval
  gate.
- **Conditional test types**: Performance tests, security tests, contract
  tests, E2E tests, and accessibility tests are only generated when relevant
  conditions are met (NFR requirements exist, microservice architecture,
  UI-driven application, user-facing interfaces).
- **Cross-unit scope**: Unlike stages 3.1-3.5 which are per-unit, Build and
  Test runs once across all code produced by all units. It validates the
  integrated codebase, not individual units.
- **Phase completion**: This stage (along with 3.7 if applicable) marks the
  end of the Construction phase. The final approved report makes the engine
  mark Construction complete and route to Operation atomically.

---

## Stage 3.7: CI Pipeline

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.7                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL (skip if CI already exists and is adequate)                                           |
| Condition         | Execute when CI pipeline needs creation or significant modification                               |
| Per-Unit          | No (runs once for all units)                                                                     |
| Lead Agent        | aidlc-pipeline-deploy-agent                                                                             |
| support_agents    | (none)                                                                                            |
| mode              | inline                                                                                            |
| Inputs            | Code generation output from Stage 3.5, build/test results from Stage 3.6                         |
| Outputs           | `<record>/construction/ci-pipeline/` -- ci-config.md, quality-gates.md, ci-pipeline-questions.md |

### Purpose

Configure the CI (Continuous Integration) pipeline with quality gates,
artifact management, and build/test automation. The aidlc-pipeline-deploy-agent
leads with no support agents.

### Inputs

- Build/test results from `<record>/construction/build-and-test/`
- Infrastructure design from `<record>/construction/infrastructure-design/`
  (if exists)
- Workspace profile for existing CI configuration

### Steps

1. **Load Agent Personas** -- Load aidlc-pipeline-deploy-agent persona and
   knowledge.

2. **Load Prior Context** -- Read build/test results, infrastructure design
   (if exists), and workspace profile for existing CI configuration.

3. **Generate Clarifying Questions** -- Create
   `<record>/construction/ci-pipeline/ci-pipeline-questions.md` with
   questions:
   - What CI tool is in use (CodePipeline, CodeBuild, GitHub Actions,
     Jenkins)?
   - What is the branch strategy?
   - What quality gates are required before merge?
   - What artifact repositories are used (ECR, CodeArtifact, S3)?

   Follow stage-protocol.md question flow.

4. **Collect and Analyze Answers** -- Validate CI choices against existing
   infrastructure and team capabilities.

5. **Generate Artifacts** -- Create CI pipeline configuration (buildspec.yml,
   workflow YAML, or equivalent), quality gate definitions, and artifact
   repository configuration.

6. **Phase Boundary Verification** -- Run Construction-to-Operation
   verification check:
   - Architecture-to-code-to-tests alignment
   - All code traces to design
   - Test coverage against acceptance criteria
   - Write results to `<record>/verification/phase-check-construction.md`

7. **Prepare Completion** -- Verify the CI and boundary artifacts. Do not
   edit stage or phase state; the reported gate outcome owns the transition.

8. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                  | Description                                              |
|---------------------------|----------------------------------------------------------|
| ci-config.md              | CI pipeline configuration (buildspec, workflow YAML, etc.) |
| quality-gates.md          | Quality gate definitions for merge/promotion             |
| ci-pipeline-questions.md  | Clarifying questions with answers                        |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes

- **Phase boundary verification**: This is the last stage of the Construction
  phase. It performs the Construction-to-Operation phase boundary verification
  check (per stage-protocol-governance.md section 13), validating that architecture traces
  to code and code traces to tests. Results are written to
  `<record>/verification/phase-check-construction.md`.
- **Conditional execution**: This stage is skipped if the project already has
  an adequate CI pipeline. The execution plan from Delivery Planning determines
  whether it runs.
- **Post-unit execution**: Like Stage 3.6, this stage runs once after all
  per-unit work is complete, not per-unit.

---

## Phase Summary

The Construction phase transforms Inception designs into working software
through a phased construction flow:

**Per-unit stages (3.1-3.5):**
- 3.1 Functional Design -- Business logic, domain models, rules (architect-led)
- 3.2 NFR Requirements -- Performance, security, scalability, reliability,
  tech stack (architect-led)
- 3.3 NFR Design -- Concrete patterns for NFR categories (architect-led)
- 3.4 Infrastructure Design -- Deployment, services, monitoring, CI/CD
  (aws-platform-led)
- 3.5 Code Generation -- Two-part planning + generation via subagent
  (developer-led)

**Post-unit stages (3.6-3.7):**
- 3.6 Build and Test -- Instruction generation + actual Bash execution with
  failure diagnosis (quality-led)
- 3.7 CI Pipeline -- CI configuration + phase boundary verification
  (pipeline-deploy-led)

**Key characteristics:**
- Stages 3.1-3.4 are CONDITIONAL; 3.5-3.6 ALWAYS execute; 3.7 is CONDITIONAL
- All conditional stages follow the execution plan from Delivery Planning
- Per-unit loop ensures one unit completes fully before the next begins
- NFR artifacts use expanded granularity (5 files for requirements, 5 for
  design) compared to the upstream reference
- Infrastructure Design is expanded to 5 artifacts with dedicated monitoring
  and CI/CD files
- Code generation uses the aidlc-developer-agent subagent with context budget controls
- Build and Test performs actual command execution and automated failure
  diagnosis
- CI Pipeline includes phase boundary verification before transitioning to
  Operation

**Deliberate deviations from upstream reference:**
- NFR Requirements: 5 files (expanded from 2 in reference)
- NFR Design: 5 files including logical-components.md (expanded from 2 in
  reference)
- Infrastructure Design: 5 files including monitoring-design.md and
  cicd-pipeline.md (expanded from 2-3 in reference)
- Plan/question file co-location with stage artifacts
