---
slug: nfr-requirements
phase: construction
execution: CONDITIONAL
condition: Performance, security, scalability, reliability, or observability requirements needed, or tech stack selection needed. Skip if no NFR requirements and tech stack already determined.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-devsecops-agent
  - aidlc-compliance-agent
  - aidlc-quality-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-architecture-reviewer-agent
review_artifact: security-requirements
reviewer_max_iterations: 2
for_each: unit-of-work
produces:
  - performance-requirements
  - security-requirements
  - scalability-requirements
  - reliability-requirements
  - observability-requirements
  - tech-stack-decisions
  - traceability
produces_kinds:
  performance-requirements: [service, ui]
  scalability-requirements: [service]
  reliability-requirements: [service]
  observability-requirements: [service]
consumes:
  - artifact: functional-spec
    required: true
  - artifact: rules
    required: true
  - artifact: requirements
    required: true
  - artifact: contract-summary
    required: false
  - artifact: technology-stack
    required: false
    conditional_on: brownfield
requires_stage:
  - units-generation
  - functional-design
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
  - security-patch
  - classic
  - workshop
inputs: functional design artifacts, requirements.md, RE artifacts
outputs: "performance-requirements.md, security-requirements.md, scalability-requirements.md, reliability-requirements.md, observability-requirements.md, tech-stack-decisions.md, traceability.json (under this stage's per-unit record dir, engine-resolved); per-kind applicability via produces_kinds (untagged unit: all)"
---

# NFR Requirements

## Steps

### Execution Modes

This stage supports two execution modes, controlled by the orchestrator:

**QUESTION-ONLY mode** (invoked by orchestrator during a Bolt's question phase):
Execute Steps 1–4 only (read artifacts, assess categories, generate questions, collect answers).
Do NOT proceed to artifact generation. Return control to the orchestrator.

**ARTIFACT-ONLY mode** (invoked by orchestrator during a Bolt's design phase):
Skip Steps 1–4 (questions already collected and approved).
Read the answered questions file from the per-unit directory.
Execute Steps 5–7 only (generate artifacts, update state, completion).

**Full mode** (default — single-unit projects or direct stage invocation):
Execute all steps sequentially as written.

### Step 1: Read Prior Artifacts

Read functional design artifacts from `<record>/construction/{unit-name}/functional-design/` (if they exist). Read `<record>/inception/requirements-analysis/requirements.md` (if exists), the inter-unit contracts from `<record>/inception/contract-design/contract-summary.md` (if produced — its SLAs, retry/timeout, and integration-mechanism decisions constrain this unit's NFR targets), and any reverse engineering artifacts from `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` prints). Incremental scopes (infra) skip functional-design by design; when its artifacts are absent, derive the NFR context from the requirements and the code knowledge base instead — never invent the content of a missing artifact.

### Step 2: Assess NFR Categories

Analyze the unit across NFR categories:
- **Performance**: Response times, throughput, latency targets, resource utilization
- **Security**: Authentication, authorization, data protection, compliance requirements
- **Scalability**: Load handling, growth projections, scaling strategies
- **Reliability**: Availability targets, fault tolerance, disaster recovery, data durability
- **Observability**: Monitoring, logging, alerting, tracing requirements

### Step 3: Generate Questions

Create a questions file at `<record>/construction/{unit-name}/nfr-requirements/nfr-requirements-questions.md` for unclear NFR areas using [Answer]: tags. Focus on quantifiable targets and specific constraints.

### Step 4: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file). Perform MANDATORY ambiguity analysis:
- Identify vague answers ("fast enough", "highly available", "secure")
- Check for contradictions between NFR targets
- Flag missing quantitative targets

If ANY ambiguity found: create follow-up questions and resolve before proceeding.

### Step 5: Generate Artifacts

Generate the following in `<record>/construction/{unit-name}/nfr-requirements/`:

- **performance-requirements.md**: Response time targets, throughput requirements, latency budgets, resource constraints, benchmarks
- **security-requirements.md**: Authentication requirements, authorization model, data protection, compliance, threat considerations
- **scalability-requirements.md**: Load projections, scaling triggers, capacity planning, data growth, concurrency targets
- **reliability-requirements.md**: Availability targets (SLA/SLO), fault tolerance requirements, backup/recovery, graceful degradation
- **observability-requirements.md**: Monitoring requirements, logging standards, distributed tracing needs, alerting thresholds, dashboard requirements, SLI/SLO definitions
- **tech-stack-decisions.md**: Technology selections and rationale — languages, frameworks, databases, infrastructure tools, and justification for each choice

Every detailed requirement inherits its inception NFR ID and appends a
sub-number, such as `NFR4.1` and `NFR4.2`. Carry these IDs on every requirement
row.

Create
`<record>/construction/{unit-name}/nfr-requirements/traceability.json`.
Enumerate every inception `NFR{n}` applicable to this Unit and target the
derived `NFRx.y` IDs. `N/A` requires a justification:

```json
{
  "stage": "nfr-requirements",
  "unit": "u1-auth",
  "upstream_ids": ["NFR1", "NFR4"],
  "coverage": [
    { "id": "NFR1", "status": "OK", "target": "NFR1.1, NFR1.2" },
    { "id": "NFR4", "status": "N/A", "target": "no persistent data in this Unit" }
  ]
}
```

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage nfr-requirements --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 7: Completion

Present completion message and approval gate:

```
# :bar_chart: NFR Requirements Complete — {unit-name}
```

Summary of NFR categories addressed and key targets, then:

```
**Review:** `<record>/construction/{unit-name}/nfr-requirements/`
```

Approval gate: strictly 2-option (Approve / Request Changes).

## Sensors

This stage's outputs are markdown design artefacts under `<record>/construction/{unit-name}/nfr-requirements/`. Some sections include code samples that the code-shape sensors can also flag.

Imports: `required-sections`, `upstream-coverage`, `linter`, `type-check`, `traceability`.

Upstream targets: `functional-spec`, `rules`, `requirements`, `contract-summary`, `technology-stack`.

`linter` and `type-check` inspect matching TypeScript/JavaScript snippets.
`traceability` verifies that inception NFR IDs are declared and covered by
per-Unit `NFRx.y` requirements.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
