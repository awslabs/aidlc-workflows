# Construction Phase -- Stage Reference (3.1-3.7)

## Phase Overview

The Construction phase transforms design artifacts from Inception into working,
tested software. It covers seven stages (3.1 through 3.7) that span functional
design, non-functional requirements and design, infrastructure design, code
generation, build/test verification, and CI pipeline configuration.

Construction is the fourth of five phases in the AI-DLC methodology. It is
driven by the **execution plan** produced during Delivery Planning (Stage 2.9).
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
sequence + walking-skeleton marker) from stage 2.9 and the dependency DAG
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

**Construction iteration order (opt-in).** By default the engine iterates the
per-unit construction stages stage-major: it runs 3.1 for every Unit, then 3.2
for every Unit, and so on, with 3.5 Code Generation last for every Unit. When
the state file records `Construction Iteration: unit-major` under
`## Runtime State` (set at delivery-planning via
`aidlc-state.ts set-construction-iteration unit-major`, or by a human), the
engine walks unit-major instead: for each Unit in Bolt build order, it authors
that Unit's four design documents (3.1 through 3.4) and then generates its code
(3.5) before the next Unit begins — the first working code lands after one
Unit's design, not after every Unit's. Code Generation's per-Unit Plan Approval
(Step 3) still hard-stops before generation, and the autonomous Construction
swarm never fires while the knob is set (the walk owns the build, serially in
Bolt build order; parallel batch swarms are stage-major territory). The
per-stage approval gates are unchanged in count and machinery; under unit-major
they fire late, in stage order, once the whole (stage by Unit) grid — Code
Generation included — is covered, one human approval per stage.
Only the exact value `unit-major` activates it; absent or `stage-major` is the
default.

**Per-unit batch waves (optional, stage-major only).** On the default
stage-major walk, the engine MAY emit `directive.wave` for one of the four
inline design stages (3.1–3.4). The wave comes from one healed DAG snapshot;
the conductor does not read `runtime-graph.json` or derive sibling paths.
Code Generation (3.5, `workspace_requires: true`) is NEVER wave-eligible:
concurrent builders would collide writing into the shared workspace (the
swarm path's per-unit worktrees exist for exactly this isolation), and its
Step 3 Plan Approval is a mandatory hard stop in every execution mode that
cannot fold into a builder's return message.

Each entry carries kind-resolved consumes, explicit absent consumes, all
produces, the applicable required subset, a Unit-local diary path, build state,
paired-review state, and whether its wave completion receipt is still required.
Builders receive the parent stage file, inline context roster, warnings, and
exact accumulated steering content. A blocked builder withholds an applicable
required path, not an optional or kind-exempt path. After build and review,
`unit complete --wave` verifies the live entry, fans Unit diary entries into the
parent diary idempotently, and emits `UNIT_COMPLETED`. The engine holds the
current batch until every applicable Unit has all of that evidence, then permits
a dependent batch or the single stage gate. Waves never apply under
`Construction Iteration: unit-major`; harnesses without a parallel dispatch
primitive process the entries serially. See
`stage-protocol-construction.md` § "Per-unit batch waves" for the full contract.

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
artifacts. See `stage-protocol-construction.md` § "Construction Bolt gates" and
SKILL.md §CONSTRUCTION Flow for the canonical specification.

---

## Stage Summary Table

| Stage | Name                  | Execution   | Condition                                                                                          | Lead Agent          | Support Agents    | Mode                       | Per-Unit |
|-------|-----------------------|-------------|----------------------------------------------------------------------------------------------------|---------------------|-------------------|-----------------------------|----------|
| 3.1   | Functional Design     | CONDITIONAL | New data models, complex business logic, or business rules need design                             | aidlc-architect-agent     | aidlc-developer-agent   | inline                      | Yes      |
| 3.2   | NFR Requirements      | CONDITIONAL | Performance, security, scalability, reliability, or observability requirements needed, or tech stack selection needed | aidlc-architect-agent     | aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent   | inline                      | Yes      |
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
| Inputs            | unit-of-work.md, unit-of-work-story-map.md, requirements.md, domain design artifacts         |
| Outputs           | `<record>/construction/{unit-name}/functional-design/` -- functional-spec.md, rules.md, entities.md, CONDITIONAL: frontend-components.md |

### Purpose

Design the business logic, domain model, and rules for a single unit of work.
The aidlc-architect-agent leads with the aidlc-developer-agent providing technical
feasibility input.

### Inputs

- Unit definition from `<record>/inception/units-generation/unit-of-work.md`
- Assigned stories from `<record>/inception/units-generation/unit-of-work-story-map.md`
- Requirements from `<record>/inception/requirements-analysis/requirements.md`
- Domain design artifacts from `<record>/inception/domain-design/`

### Steps

1. **Load Personas** -- Load aidlc-architect-agent (lead) persona and knowledge.
   Load aidlc-developer-agent persona and knowledge for technical implementation
   input. Apply aidlc-architect-agent as the primary perspective.

2. **Read Unit Context** -- Read the unit definition, assigned stories,
   requirements, and domain design artifacts.

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
   - **functional-spec.md**: Detailed algorithms, workflows, data
     transformations, processing sequences, and decision trees for the unit's
     business logic
   - **rules.md**: Decision rules, validation logic, constraints,
     policies, conditional behavior, and business invariants
   - **entities.md**: Entities, relationships, data structures,
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
| functional-spec.md  | Algorithms, workflows, data transformations, processing sequences, decision trees |
| rules.md        | Decision rules, validation logic, constraints, policies, conditional behavior |
| entities.md       | Entities, relationships, data structures, attributes, lifecycle states   |
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
| Condition         | Performance, security, scalability, reliability, or observability requirements needed, or tech stack selection needed. Skip if no NFR requirements and tech stack already determined. |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent                                       |
| mode              | inline                                                                                            |
| Inputs            | functional design artifacts, requirements.md, RE artifacts                                        |
| Outputs           | `<record>/construction/{unit-name}/nfr-requirements/` -- performance-requirements.md, security-requirements.md, scalability-requirements.md, reliability-requirements.md, observability-requirements.md, tech-stack-decisions.md |

### Purpose

Define non-functional requirements across performance, security, scalability,
reliability, observability, and technology selection for a single unit. The aidlc-architect-agent
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
   - **observability-requirements.md**: Monitoring requirements, logging
     standards, distributed tracing needs, alerting thresholds, dashboard
     requirements, SLI/SLO definitions
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
| observability-requirements.md | Monitoring, logging, tracing, alerting, dashboards, SLI/SLO definitions    |
| tech-stack-decisions.md      | Technology selections with rationale for each choice                       |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes -- NFR Granularity Expansion

This stage produces **6 artifact files**, expanded from the upstream reference
which defines only 2 files for NFR Requirements. This is a deliberate deviation
documented in SKILL.md ("Deliberate Deviations from Reference"). The finer
granularity improves traceability and allows per-concern review without
overloading a single document. The six files separate performance, security,
scalability, reliability, and observability into dedicated artifacts, and add
a dedicated tech-stack-decisions.md for technology selection rationale.

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
| Outputs           | `<record>/construction/{unit-name}/nfr-design/` -- performance-design.md, security-design.md, scalability-design.md, reliability-design.md, observability-design.md, logical-components.md |

### Purpose

Translate NFR requirements into concrete design patterns and architectural
solutions. The aidlc-architect-agent leads with the aidlc-aws-platform-agent providing
infrastructure and platform input.

### Inputs

- NFR requirements from `<record>/construction/{unit-name}/nfr-requirements/`
- Functional design artifacts from
  `<record>/construction/{unit-name}/functional-design/` (if they exist)
- Domain design from `<record>/inception/domain-design/` for
  architectural context

### Steps

1. **Load Personas** -- Load aidlc-architect-agent (lead) persona and knowledge.
   Load aidlc-aws-platform-agent persona and knowledge for infrastructure and
   platform input.

2. **Read Prior Artifacts** -- Read NFR requirements, functional design
   artifacts (if they exist), and domain design for architectural context.

3. **Generate Design Questions** -- Create a questions file at
   `<record>/construction/{unit-name}/nfr-design/nfr-design-questions.md`
   with context-appropriate questions using `[Answer]:` tags. Focus areas:
   - Resilience patterns (circuit breakers, bulkheads, fallback strategies)
   - Scalability patterns (horizontal vs vertical, data partitioning, caching
     tiers)
   - Performance optimization (latency budgets, throughput targets, resource
     pooling)
   - Security approach (defense in depth, zero trust, encryption standards)
   - Observability approach (metrics and SLI/SLO targets, structured logging,
     tracing depth, alerting philosophy, dashboard needs)
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
   - **Observability**: Metrics collection strategy, structured logging design,
     distributed tracing architecture, alerting rules, dashboard specifications,
     SLI/SLO tracking, correlation ID propagation

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
   - **observability-design.md**: Metrics collection architecture, structured
     logging design, distributed tracing strategy, alerting rules and escalation,
     dashboard specifications, SLI/SLO definitions, correlation ID propagation
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
| observability-design.md | Metrics, structured logs, tracing, alerts, dashboards, SLI/SLO definitions      |
| logical-components.md  | Component inventory, service boundaries, failure domains, blast radius mapping  |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes -- NFR Design Granularity

This stage produces **6 artifact files** (5 NFR-specific designs plus
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
| Inputs            | NFR design artifacts, domain design, functional design                                       |
| Outputs           | `<record>/construction/{unit-name}/infrastructure-design/` -- infrastructure-specification.md (deployment + services + CONDITIONAL shared), monitoring-design.md, cicd-pipeline.md |

### Purpose

Design the infrastructure, deployment architecture, monitoring, and CI/CD
pipeline for a single unit. The aidlc-aws-platform-agent leads, with the
aidlc-devsecops-agent ensuring infrastructure security and the
aidlc-compliance-agent checking data residency and regulatory constraints.

### Inputs

- NFR design from `<record>/construction/{unit-name}/nfr-design/` (if exists)
- Functional design from
  `<record>/construction/{unit-name}/functional-design/` (if exists)
- Domain design from `<record>/inception/domain-design/`
- NFR requirements from
  `<record>/construction/{unit-name}/nfr-requirements/` (if exists)

### Steps

1. **Load Personas** -- Load aidlc-aws-platform-agent (lead) persona and knowledge.
   Load aidlc-devsecops-agent (infrastructure security) and aidlc-compliance-agent
   (data residency, regulatory constraints) personas and knowledge for support input.

2. **Read Prior Artifacts** -- Read all prior design artifacts for context:
   NFR design, functional design, domain design, NFR requirements.

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
   `<record>/construction/{unit-name}/infrastructure-design/`. Keep the content
   **tabular** (deployment, services, shared, and monitoring are tables):
   - **infrastructure-specification.md**: the core infra design — a
     **Deployment** table (compute, networking, storage, environments, IaC,
     sizing), an **Infrastructure Services** table (databases, caches,
     messaging, integrations, service discovery), and a CONDITIONAL **Shared
     Infrastructure** table (shared resources across units + ownership/access
     boundaries), all in one document
   - **monitoring-design.md**: the monitoring that implements NFR Design's
     observability-design strategy, tabular — metrics/KPIs,
     alerts, SLIs/SLOs, plus log-aggregation and tracing configuration and
     dashboard specifications
   - **cicd-pipeline.md**: pipeline stages, build configuration, test
     automation integration, deployment strategy (blue-green, canary, rolling),
     rollback procedures, environment promotion, secrets management in CI/CD

7. **Prepare Completion** -- Verify the unit's Infrastructure Design
   artifacts. Do not edit state; report the gate outcome through
   `aidlc-orchestrate.ts`.

8. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                       | Description                                                               |
|--------------------------------|---------------------------------------------------------------------------|
| infrastructure-specification.md | Deployment (compute/networking/storage/environments/IaC), infrastructure services, and CONDITIONAL shared resources — tabular |
| monitoring-design.md           | Metrics, alerts, SLIs/SLOs, logs, tracing, dashboards — tabular where possible |
| cicd-pipeline.md               | Pipeline stages, build config, deployment strategy, rollback procedures   |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

### Notes -- Infrastructure Design Consolidation

This stage produces **3 artifact files**. Deployment, infrastructure services,
and shared resources were consolidated into a single tabular
`infrastructure-specification.md` (closer to the upstream reference's single
infra doc), while `monitoring-design.md` and `cicd-pipeline.md` stay dedicated
artifacts because downstream Operation stages consume them independently
(observability-setup reads monitoring; deployment-pipeline reads the CI/CD
design). Shared infrastructure is a CONDITIONAL section of the specification,
present only when multiple units share resources.

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
| Outputs           | application code (workspace root) + `<record>/construction/{unit-name}/code-generation/` -- code-generation-plan.md, code-generation-questions.md, unit-test-instructions.md, code-summary.md |

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
- Domain design from `<record>/inception/domain-design/`
- Unit definition from
  `<record>/inception/units-generation/unit-of-work.md`
- Story map from
  `<record>/inception/units-generation/unit-of-work-story-map.md`

### Steps

This stage has a **two-part structure**: planning followed by generation.

#### PART 1 -- Planning (Steps 1-3)

1. **Read All Unit Artifacts** -- Read all design artifacts for the current
   unit (functional design, NFR requirements, NFR design, infrastructure
   design, domain design, unit definition, story map).

2. **Create Code Generation Plan** -- Create a detailed plan at
   `<record>/construction/{unit-name}/code-generation/code-generation-plan.md`
   with checkboxes for each implementation step. Include story-to-code-step
   traceability -- map each plan step back to the user story it implements.

   Run `aidlc-testing-posture.ts render` and paste its complete
   `## Testing Contract` JSON block into the plan. The resolver reads
   org/team/project Testing Posture sections additively: a project coverage or
   integration note remains applicable but does not erase a team methodology;
   a contradictory narrower methodology is rejected.

   The contract supplies a methodology-specific plan profile:

   - **TDD** -- Red/Green/Refactor for every applicable testable layer: data,
     repository, business logic, API, and frontend.
   - **BDD** -- executable behavior scenarios before an observable feature
     slice, followed by cross-layer implementation, green scenarios, and
     refactoring. It is not converted to layer-local TDD.
   - **ATDD** -- executable acceptance tests before the complete cross-layer
     feature implementation, followed by acceptance-green and refactoring.
   - **Custom/mixed** -- the exact affirmed ordering is preserved, including
     combinations such as scenario-first BDD with lower-level unit tests after
     implementation.
   - **Test-after** -- implementation then tests for every applicable testable
     layer.

   Greenfield plans bootstrap a minimal runnable test command before the first
   Red/scenario/acceptance step; brownfield plans verify the existing command
   first. The selected Test Strategy supplies volume/types and the scope adds
   its floor (coverage/CI, targeted regression, or no additional floor);
   neither obligation replaces the other. Under Minimal, a bug/security
   targeted regression may add one integration/E2E test when that is the
   narrowest level that reproduces the defect.

   **Test files are MANDATORY in the plan.** The plan MUST include steps for:
   - Unit test files (one per component/module with key behavior coverage)
   - Test configuration (vitest.config, jest.config, or equivalent)

   If the plan omits test file steps, they must be added before presenting to
   the user. Tests are not deferred to Build and Test -- that stage verifies
   and extends, not creates from scratch.

   Number each plan step sequentially (Step 1, Step 2, etc.) for clear
   execution ordering and traceability.

   Also create
   `<record>/construction/{unit-name}/code-generation/unit-test-instructions.md`
   before Plan Approval. Match the active test strategy:
   - **Minimal**: Requirement-driven unit tests (1 test per requirement,
     happy-path floor per component), approximately 5-15 tests total
   - **Standard**: 5-8 tests per component, with key behavior coverage
   - **Comprehensive**: 10-15 tests per component, with thorough coverage

   Include test framework setup and configuration, the exact runnable command
   available before the first test-first cycle, expected coverage targets,
   mocking/stubbing guidance, and test data management. Every run command MUST
   be scoped to this unit using exact test file paths or an exact unit filter.
   A bare project-wide command such as `npm test` is not acceptable because
   Build and Test executes every unit's commands.

   Present the unit test instruction summary together with the plan summary.

3. **Plan Approval** -- Request approval for both
   `code-generation-plan.md`, its Testing Contract, and
   `unit-test-instructions.md`. On a revision, reset the prior `[Answer]:` to
   blank first. Run `aidlc-testing-posture.ts fingerprint --unit <unit>` after
   both files are final, then create or reset
   `<record>/construction/{unit-name}/code-generation/code-generation-questions.md`
   with that `[Approval Fingerprint]`, a **Plan Approval** question, and blank
   `[Answer]:`; render it as a structured question and stop the turn:
   - "Approve Plan" -- proceed to code generation
   - "Request Changes" -- revise the plan

   Fill the tag only after the human responds. A request for changes is
   recorded, both files are revised as needed, the contract/fingerprint are
   regenerated, and the Plan Approval tag is reset before re-prompting. A
   post-approval plan/instruction change or Testing Posture/scope/strategy/type
   change invalidates the fingerprint and reopens approval. A forwarding-loop
   continuation is never approval.

#### PART 2 -- Generation (Steps 4-7)

4. **Generate Code** -- Before delegating, display to the user:
   "Generating code for [N] plan steps. This may take several minutes
   depending on project complexity. I'll show a summary when complete."

   Delegate to Task tool with the aidlc-developer-agent subagent
   (subagent_type="aidlc-developer-agent").

   **Context passed to subagent:**
   - As the first prompt line, the exact target marker
     `AIDLC-UNIT: <directive.unit>` (or the current unit name for a
     single-iteration directive without `unit`). Contextual dependencies do
     not receive additional markers.
   - As the second line, `AIDLC-TESTING-CONTRACT: <contract_sha256>` from the
     approved plan. The dispatch guard rejects missing, different, or stale
     hashes.
   - The lead agent's persona from `agents/aidlc-developer-agent.md` and knowledge
     from `.claude/knowledge/aidlc-developer-agent/` (included in the prompt
     since subagents cannot access conversation history)
   - Design artifacts for the CURRENT UNIT ONLY (not all units)
   - A 1-2 line summary of each inception-phase artifact with its file path
     (requirements summary, stories summary, app design summary) -- the
     subagent can Read specific files if it needs full content
   - The approved code-generation-plan.md (full content)
   - The approved unit-test-instructions.md (full content)
   - Project workspace details (languages, frameworks, conventions from
     aidlc-state.md)
   - Instructions to execute each plan step sequentially and mark checkboxes
     as completed
   - The approved Testing Contract is authoritative. The subagent does not
     independently re-resolve memory; it executes the approved TDD, BDD, ATDD,
     test-after, or custom/mixed profile exactly.

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
| unit-test-instructions.md | Per-unit setup, scoped run commands, coverage, mocks, and test data |
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
- **Unit-scoped execution**: Each per-unit test instruction file uses exact
  test paths or an exact unit filter so the cross-unit execution stage does
  not rerun the project-wide suite for every unit.
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
| Outputs           | `<record>/construction/build-and-test/` -- build-instructions.md, integration-test-instructions.md, performance-test-instructions.md, security-test-instructions.md, build-and-test-summary.md, test-results.md, plus conditional test instruction files |

### Purpose

Generate cross-unit test instructions, consume the per-unit unit test
instructions, then actually execute the build and tests via Bash. This stage
operates across ALL units -- it is NOT per-unit. The aidlc-quality-agent leads
with the aidlc-devsecops-agent providing security testing expertise.

### Inputs

- Code generation outputs across all units from
  `<record>/construction/*/code-generation/code-summary.md`
- Per-unit test instructions from
  `<record>/construction/*/code-generation/unit-test-instructions.md`
- NFR requirements across units (if they exist) for performance and security
  testing needs

### Steps

1. **Load Personas** -- Load aidlc-quality-agent (lead) persona and knowledge. Load
   aidlc-devsecops-agent persona and knowledge for security testing input.

2. **Analyze Testing Requirements** -- Read code generation summaries and
   per-unit test instructions across all units. Review NFR requirements (if
   they exist) to identify performance and security testing needs. Catalog
   all test types required.

3. **Generate Build Instructions** -- Create
   `<record>/construction/build-and-test/build-instructions.md`:
   - Dependency installation steps
   - Environment setup (env vars, config files, local services)
   - Build commands (compile, bundle, transpile)
   - Build verification steps
   - Troubleshooting common build issues

4-8. **Generate Additional Test Instructions** -- Consult the active test
   strategy and generate the matching cross-unit instruction files:
   - **Minimal**: Generate no additional files. Unit tests are covered
     per-unit by Code Generation.
   - **Standard**: Generate `integration-test-instructions.md` for key
     boundaries and cross-unit interactions.
   - **Comprehensive**: Generate integration instructions, plus
     `performance-test-instructions.md` when performance NFRs exist and
     `security-test-instructions.md` when security NFRs exist.
   - At any strategy, add specifically named contract, E2E, accessibility, or
     other instruction files when the project context requires them.

   All files go in `<record>/construction/build-and-test/`.
   Each file includes framework setup, run commands and filters, coverage
   targets, and test data or environment setup.

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
    b. **Unit tests**: Collect commands from every per-unit
       `code-generation/unit-test-instructions.md`, deduplicate identical
       commands, and run each distinct command once. Commands should be
       unit-scoped; if a file contains a project-wide command, run it once,
       never once per unit. Report per-unit pass/fail without double counting.
    c. **Integration tests** (if applicable): Run integration test commands.
       Capture results.
    d. **Report results**: Create or update
       `<record>/construction/build-and-test/test-results.md` with:
       - Build status (success/failure + output)
       - Test results (total, passed, failed, skipped)
       - Failure details (test name, assertion, stack trace)
       - Coverage report (if test framework supports it)
       - `## Loop-Back Log` (only when the failure ladder's rung 3 or 4 fires
         a loop-back): one `### Loop-back N -- <ISO timestamp>` entry per
         attempt (Diagnosis / Root-cause stage / Planned fix / Estimated impact).
         Append-only; survives re-runs (Modify, never Redo, on loop-back
         re-entry).

    **Failure-escalation ladder:** On failure, if build or tests fail:

    1. **In-stage fix (max 2 attempts)** -- for root causes inside this
       stage's own remit (test config, build scripts, environment setup):
       read the error output, identify the failing configuration or
       scaffolding, apply the fix, re-run the failing step.
    2. **Classify and estimate impact** -- when in-stage attempts are exhausted or the
       diagnosis points upstream: decide whether the root cause lies in
       generated source or test code -- regardless of defect size -- or a
       code-generation approach choice (library/version, container image,
       instance type, algorithm, flag); find a fix in a swappable dimension
       and ESTIMATE ITS IMPACT (effort, financial cost, risk). Never declare a
       feasible path out of scope on an impact-unestimated effort assumption.
    3. **Autonomous bounded loop-back** -- if `Construction Autonomy Mode:
       autonomous`, an impact-estimated fix exists, and fewer than 3 entries exist under
       `## Loop-Back Log`: record the diagnosis + impact-estimated fix, jump
       back to code-generation via the engine, and replay forward through its
       settlement-aware route per the construction protocol module
       (`aidlc-common/protocols/stage-protocol-construction.md`),
       "Build-and-Test failure loop-back". The failed run's gate is not
       presented; its learnings ritual defers to the eventual passing run.
    4. **Halt-and-ask** -- gated/unset mode, bound exhausted, or no
       identifiable fix: log the failure and present the halt-and-ask
       question from the construction protocol module
       (`aidlc-common/protocols/stage-protocol-construction.md`) -- the
       impact-estimated 3-option variant (Retry with fix [estimated impact] /
       Accept failure / Abort) when a candidate fix exists, or the no-fix
       2-option variant (Accept failure / Abort) when rung 2 found none.

    **Loop-back replay routing:** If Code Generation never used unit lifecycle
    receipts, preserved artifacts can take the all-covered `gate: true` fast
    path; apply the planned fix and deterministic Modify/Keep decisions before
    that gate. Once any lifecycle row exists, receipt mode is sticky and the
    jump re-emits per-Unit work: re-mint `unit start` / `unit complete`, apply
    Modify to targeted Units and Keep to the rest, and run the declared reviewer
    per Unit. Both paths MUST record a fresh current-attempt
    `REVIEW_COMPLETED` for every applicable Unit before the settle/approval
    gate because `STAGE_JUMPED` invalidates all earlier reviews. Under
    unit-major the autonomous swarm never fires; the replay follows the serial
    per-Unit walk and still needs no extra human turn.

    The replay repairs the already-approved Code Generation plan. Preserve its
    Plan Approval `[Answer]:`, record the delta in the Loop-Back Log, and treat
    gated "Retry with fix" as the human's re-approval of the revised approach.

    **Swarm cheap path:** A jump creates a new exact stage-attempt `Run floor`
    boundary token, so stale convergence rows cannot count. Discard stale
    worktrees/branches and run a fresh `prepare`; they cannot be adopted into
    the new attempt because `finalize` requires its current prepare stamp. Run
    `check` first. A green Unit can skip a builder turn, but it still needs a
    terminal current-attempt reviewer receipt in the fresh worktree before it
    enters `finalize --claimed`; `finalize` verifies that receipt's current
    artifact fingerprint as well as the attempt stamp.

    Single-stage runs (`--single`) stop at rung 2 -- there is no
    main-workflow position to move; the impact-estimated options are logged and
    presented in that run's isolated-run summary.

    **On success:** Update the Build and Test Summary with actual results (not
    just instructions).

11. **Prepare Completion** -- Verify the build/test evidence. Do not edit
    stage or phase state; the reported gate outcome owns the transition.

12. **Completion** -- Present completion message and approval gate.

### Outputs

| Artifact                          | Description                                                     | Condition          |
|-----------------------------------|-----------------------------------------------------------------|--------------------|
| build-instructions.md             | Dependency install, env setup, build commands, troubleshooting  | Always             |
| integration-test-instructions.md  | Prerequisites, cross-unit testing, external deps, data setup    | Standard/Comprehensive |
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
- **Failure-escalation ladder**: In-stage fixes are bounded at 2 attempts;
  when the root cause lies upstream in generated code or a code-generation
  approach choice, the stage classifies and estimates the impact of a fix, then either runs
  the bounded autonomous loop-back to code-generation (max 3, counted by the
  append-only `## Loop-Back Log` in test-results.md) or presents the impact-estimated
  halt-and-ask question. See the construction protocol module
  (`aidlc-common/protocols/stage-protocol-construction.md`),
  "Build-and-Test failure loop-back". Re-entry is settlement-aware, preserves
  the approved plan, and cannot reach its gate until every applicable Code
  Generation Unit has a fresh current-attempt review.
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
  observability, tech stack (architect-led)
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
- NFR artifacts use expanded granularity (6 files for requirements, 6 for
  design) compared to the upstream reference
- Infrastructure Design is expanded to 5 artifacts with dedicated monitoring
  and CI/CD files
- Code generation uses the aidlc-developer-agent subagent with context budget controls
- Build and Test performs actual command execution and automated failure
  diagnosis
- CI Pipeline includes phase boundary verification before transitioning to
  Operation

**Deliberate deviations from upstream reference:**
- NFR Requirements: 6 files (expanded from 2 in reference)
- NFR Design: 6 files including logical-components.md (expanded from 2 in
  reference)
- Infrastructure Design: 3 files — a consolidated infrastructure-specification.md
  (deployment + services + shared) plus dedicated monitoring-design.md and
  cicd-pipeline.md
- Plan/question file co-location with stage artifacts
