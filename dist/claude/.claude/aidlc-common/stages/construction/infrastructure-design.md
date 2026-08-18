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
summary_confirmation: required
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
for_each: unit-of-work
produces:
  - infrastructure-specification
  - monitoring-design
  - cicd-pipeline
  - traceability
produces_kinds:
  infrastructure-specification: [service, ui, packaging]
  monitoring-design: [service, ui, packaging]
  cicd-pipeline: [service, ui, packaging, library]
  traceability: [service, ui, packaging, library]
consumes:
  - artifact: performance-design
    required: true
  - artifact: security-design
    required: true
  - artifact: scalability-design
    required: true
  - artifact: reliability-design
    required: true
  - artifact: observability-design
    required: true
  - artifact: logical-components
    required: true
  - artifact: components
    required: true
  - artifact: functional-spec
    required: true
  - artifact: contract-summary
    required: false
requires_stage:
  - units-generation
  - nfr-design
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
  - workshop
inputs: NFR design artifacts, domain design components.md, functional design
outputs: "infrastructure-specification.md (deployment + services + shared, tabular), monitoring-design.md (tabular), cicd-pipeline.md, traceability.json (under this stage's per-unit record dir, engine-resolved); per-kind applicability via produces_kinds (a spec unit owes none)"
---

# Infrastructure Design

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Constraints

This is a design stage — artifacts describe what infrastructure is needed and why, not implementation-ready code. Complete IaC (CDK constructs, Terraform modules, CloudFormation), full Lambda handlers, and IAM policy documents belong in code-generation. Limit code to short illustrative snippets (pseudocode or interface-level, ≤15 lines) that clarify a design decision.

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

Load aidlc-aws-platform-agent (lead) persona from `agents/aidlc-aws-platform-agent.md` and knowledge from `.claude/knowledge/aidlc-aws-platform-agent/`. Load aidlc-devsecops-agent persona from `agents/aidlc-devsecops-agent.md` and knowledge from `.claude/knowledge/aidlc-devsecops-agent/` for infrastructure security. Load aidlc-compliance-agent persona from `agents/aidlc-compliance-agent.md` and knowledge from `.claude/knowledge/aidlc-compliance-agent/` for data residency and regulatory compliance validation. Apply aidlc-aws-platform-agent as the primary perspective with aidlc-devsecops-agent ensuring infrastructure security and aidlc-compliance-agent ensuring regulatory alignment.

### Step 2: Read Prior Artifacts

Read all prior design artifacts for context:
- NFR design from `<record>/construction/{unit-name}/nfr-design/` (if exists)
- Functional design from `<record>/construction/{unit-name}/functional-design/` (if exists)
- Domain design (component catalogue) from `<record>/inception/domain-design/components.md` (if exists)
- Inter-unit contracts from `<record>/inception/contract-design/contract-summary.md` (if produced) — boundary integration mechanisms (sync/async/shared store) inform networking, messaging, and shared-resource provisioning
- NFR requirements from `<record>/construction/{unit-name}/nfr-requirements/` (if exists)

Incremental scopes (infra) skip the domain-design and functional-design chain by design. When those inputs are absent, derive the component topology from the NFR requirements and, on brownfield, the reverse-engineered code knowledge base at `aidlc/spaces/<active-space>/codekb/<repo>/` — never invent the content of a missing artifact.

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

Generate the following in `<record>/construction/{unit-name}/infrastructure-design/`. Keep the content **tabular** — the deployment, services, and shared sections are tables, and monitoring is tabular wherever it can be. Prose is for rationale only, not for data a table can hold.

**1. `infrastructure-specification.md`** — the core infrastructure design: deployment, infrastructure services, and any shared resources, folded into one document. Structure it as:

- **Deployment** — a table of deployment facets:
  `| Facet | Choice | Rationale |`
  with rows for compute model (containers/serverless/VMs/hybrid), networking topology (ingress/egress, VPC/subnet), storage strategy, environments (dev/staging/prod), IaC approach, and resource sizing.
- **Infrastructure Services** — a table keyed by service:
  `| Service | Role | Configuration | Notes |`
  (role = database / cache / queue / search / cdn / dns / load-balancer; configuration = sizing, replication, eviction, etc.).
- **Shared Infrastructure** (CONDITIONAL — only when multiple units share resources) — a table:
  `| Shared Resource | Owner Unit | Consumer Units | Access Boundary |`

**2. `monitoring-design.md`** — the platform-specific monitoring that implements the `observability-design` strategy from NFR Design, tabular wherever possible:

- **Metrics & KPIs** — `| Metric | Source | Threshold | Why it matters |`
- **Alerts** — `| Alert | Condition | Severity | Routes to |`
- **SLIs / SLOs** — `| SLI | SLO target | Measurement window |`
- **Logs & Tracing** — log aggregation strategy and tracing configuration (short prose or a small table); dashboard specifications.

**3. `cicd-pipeline.md`** — the delivery pipeline: build stages, test-automation integration, deployment strategy (blue-green / canary / rolling), rollback procedures, environment promotion, and secrets management in CI/CD. Steps are inherently sequential, so prose or an ordered list is fine here; use a table for the stage→gate mapping where it helps.

Create
`<record>/construction/{unit-name}/infrastructure-design/traceability.json`.
Enumerate every `NFRx.y` design decision that requires infrastructure and map
it to the concrete resource or configuration:

```json
{
  "stage": "infrastructure-design",
  "unit": "u1-auth",
  "upstream_ids": ["NFR1.1", "NFR3.1"],
  "coverage": [
    { "id": "NFR1.1", "status": "OK", "target": "ElastiCache cluster" },
    { "id": "NFR3.1", "status": "GAP" }
  ]
}
```

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage infrastructure-design --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

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
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter (this stage consumes `performance-design`, `security-design`, `scalability-design`, `reliability-design`, `observability-design`, `logical-components`, `components`, `functional-spec`, `contract-summary`).
- **`linter`** runs against any TypeScript/JavaScript snippets the design includes (matches `**/*.{ts,js}`).
- **`type-check`** runs against any TypeScript/TSX snippets the design includes (matches `**/*.{ts,tsx}`).
- **`traceability`** validates that every infrastructure-relevant `NFRx.y` design decision is declared and covered.

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
