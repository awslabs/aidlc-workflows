---
slug: infrastructure-design
phase: construction
execution: CONDITIONAL
condition: Infrastructure services need mapping, deployment architecture required, or cloud resources needed. Skip if no infrastructure changes and infrastructure already defined.
lead_agent: aidlc-aws-platform-agent
support_agents:
  - aidlc-devsecops-agent
  - aidlc-compliance-agent
mode: inline
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
for_each: unit-of-work
produces:
  - deployment-architecture
  - infrastructure-services
  - monitoring-design
  - cicd-pipeline
optional_produces:
  - shared-infrastructure
produces_kinds:
  deployment-architecture: [service, ui, packaging]
  infrastructure-services: [service, packaging]
  monitoring-design: [service, packaging]
  cicd-pipeline: [service, ui, packaging, library]
consumes:
  - artifact: performance-design
    required: true
  - artifact: security-design
    required: true
  - artifact: scalability-design
    required: true
  - artifact: reliability-design
    required: true
  - artifact: logical-components
    required: true
  - artifact: components
    required: true
  - artifact: services
    required: true
  - artifact: business-logic-model
    required: true
requires_stage:
  - units-generation
  - nfr-design
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
inputs: NFR design artifacts, application design, functional design
outputs: "deployment-architecture.md, infrastructure-services.md, monitoring-design.md, cicd-pipeline.md, CONDITIONAL: shared-infrastructure.md (under this stage's per-unit record dir, engine-resolved); per-kind applicability via produces_kinds (untagged unit: all)"
---

# Infrastructure Design

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
Execute Steps 5–8 only (design infrastructure, generate artifacts, update state, completion).

**Full mode** (default — single-unit projects or direct stage invocation):
Execute all steps sequentially as written.

### Step 1: Load Personas

Load aidlc-aws-platform-agent (lead) persona from `agents/aidlc-aws-platform-agent.md` and knowledge from `.kiro/knowledge/aidlc-aws-platform-agent/`. Load aidlc-devsecops-agent persona from `agents/aidlc-devsecops-agent.md` and knowledge from `.kiro/knowledge/aidlc-devsecops-agent/` for infrastructure security. Load aidlc-compliance-agent persona from `agents/aidlc-compliance-agent.md` and knowledge from `.kiro/knowledge/aidlc-compliance-agent/` for data residency and regulatory compliance validation. Apply aidlc-aws-platform-agent as the primary perspective with aidlc-devsecops-agent ensuring infrastructure security and aidlc-compliance-agent ensuring regulatory alignment.

### Step 2: Read Prior Artifacts

Read all prior design artifacts for context:
- NFR design from `<record>/construction/{unit-name}/nfr-design/` (if exists)
- Functional design from `<record>/construction/{unit-name}/functional-design/` (if exists)
- Application design from `<record>/inception/application-design/` (if exists)
- NFR requirements from `<record>/construction/{unit-name}/nfr-requirements/` (if exists)

Incremental scopes (infra) skip the application-design and functional-design chain by design. When those inputs are absent, derive the component/service topology from the NFR requirements and, on brownfield, the reverse-engineered code knowledge base at `aidlc/spaces/<active-space>/codekb/<repo>/` — never invent the content of a missing artifact.

### Step 3: Generate Infrastructure Questions

Create a questions file at `<record>/construction/{unit-name}/infrastructure-design/infrastructure-design-questions.md` with context-appropriate questions using [Answer]: tags.

Focus areas:
- Deployment strategy (containerized, serverless, hybrid, multi-region)
- Compute/storage/networking (sizing, topology, latency requirements)
- Monitoring approach (metrics, logging, tracing, alerting thresholds)
- CI/CD pipeline (build stages, deployment strategy, rollback procedures)
- Secrets management (vault, environment variables, rotation policy)
- Scaling policy (auto-scaling triggers, capacity limits, cost constraints)

### Step 4: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file). After collecting answers, perform MANDATORY ambiguity analysis:
- Identify vague answers ("cloud-based", "auto-scale", "standard monitoring")
- Check for contradictions between answers
- Flag missing details needed for artifact generation

If ANY ambiguity found: create follow-up questions and resolve before proceeding.

### Step 5: Design Infrastructure

Design infrastructure across four areas:

- **Deployment Architecture**: Compute model (containers, serverless, VMs), networking topology, storage strategy, environment layout (dev/staging/prod)
- **Infrastructure Services**: Databases (type, sizing, replication), caches (strategy, eviction), message queues, search services, CDN, DNS, load balancers
- **Monitoring & Observability**: Metrics collection, log aggregation, distributed tracing, alerting rules, dashboards, SLI/SLO tracking
- **CI/CD Pipeline**: Build stages, test stages, deployment stages, environment promotion, rollback strategy, feature flags, artifact management

### Step 6: Generate Artifacts

Generate the following in `<record>/construction/{unit-name}/infrastructure-design/`:

- **deployment-architecture.md**: Compute resources, networking, storage, environment definitions, infrastructure-as-code approach, resource sizing
- **infrastructure-services.md**: Database design, caching layer, messaging infrastructure, external service integrations, service discovery
- **monitoring-design.md**: Metrics and KPIs, log strategy, tracing configuration, alert definitions, dashboard specifications, incident response
- **cicd-pipeline.md**: Pipeline stages, build configuration, test automation integration, deployment strategy (blue-green, canary, rolling), rollback procedures, secrets management in CI/CD
- **shared-infrastructure.md** (CONDITIONAL — produce when multiple units share infrastructure resources): Shared databases, shared caches, shared message queues, shared networking, cross-unit service discovery, resource ownership and access boundaries

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage infrastructure-design --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 8: Completion

Present completion message and approval gate:

```
# :cloud: Infrastructure Design Complete — {unit-name}
```

Summary of infrastructure decisions and service selections, then:

```
**Review:** `<record>/construction/{unit-name}/infrastructure-design/`
```

Approval gate: strictly 2-option (Approve / Request Changes).

## Sensors

This stage's outputs are markdown design artefacts under `<record>/construction/{unit-name}/infrastructure-design/`. Some sections include code samples that the code-shape sensors can also flag.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings).
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter (this stage consumes `performance-design`, `security-design`, `scalability-design`, `reliability-design`, `logical-components`, `components`, `services`, `business-logic-model`).
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
- Verification check → new manifest at `.kiro/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
