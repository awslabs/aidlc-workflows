---
slug: nfr-requirements
phase: construction
execution: CONDITIONAL
condition: Performance requirements, security considerations, scalability concerns, or tech stack selection needed. Skip if no NFR requirements and tech stack already determined.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-devsecops-agent
  - aidlc-compliance-agent
  - aidlc-quality-agent
mode: inline
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
for_each: unit-of-work
produces:
  - performance-requirements
  - security-requirements
  - scalability-requirements
  - reliability-requirements
  - tech-stack-decisions
produces_kinds:
  performance-requirements: [service, ui]
  scalability-requirements: [service]
  reliability-requirements: [service]
consumes:
  - artifact: business-logic-model
    required: true
  - artifact: business-rules
    required: true
  - artifact: requirements
    required: true
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
scopes:
  - enterprise
  - feature
  - mvp
  - infra
  - security-patch
  - workshop
inputs: functional design artifacts, requirements.md, RE artifacts
outputs: "performance-requirements.md, security-requirements.md, scalability-requirements.md, reliability-requirements.md, tech-stack-decisions.md (under this stage's per-unit record dir, engine-resolved); per-kind applicability via produces_kinds (untagged unit: all)"
---

# NFR Requirements

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Execution Modes

This stage supports two execution modes, controlled by the orchestrator:

**QUESTION-ONLY mode** (invoked by orchestrator during a Bolt's question phase):
Execute Steps 1–5 only (load personas, read artifacts, assess categories, generate questions, collect answers).
Do NOT proceed to artifact generation. Return control to the orchestrator.

**ARTIFACT-ONLY mode** (invoked by orchestrator during a Bolt's design phase):
Skip Steps 1–5 (questions already collected and approved).
Read the answered questions file from the per-unit directory.
Execute Steps 6–8 only (generate artifacts, update state, completion).

**Full mode** (default — single-unit projects or direct stage invocation):
Execute all steps sequentially as written.

### Step 1: Load Personas

Load aidlc-architect-agent (lead) persona from `agents/aidlc-architect-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-architect-agent/`. Load aidlc-devsecops-agent persona from `agents/aidlc-devsecops-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-devsecops-agent/` for security requirements input. Load aidlc-compliance-agent persona from `agents/aidlc-compliance-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-compliance-agent/` for regulatory constraint mapping. Load aidlc-quality-agent persona from `agents/aidlc-quality-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-quality-agent/` for testable quality attribute scenarios. Apply aidlc-architect-agent as the primary perspective with aidlc-devsecops-agent, aidlc-compliance-agent, and aidlc-quality-agent providing specialist input.

### Step 2: Read Prior Artifacts

Read functional design artifacts from `<record>/construction/{unit-name}/functional-design/` (if they exist). Read `<record>/inception/requirements-analysis/requirements.md` (if exists) and any reverse engineering artifacts from `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` prints). Incremental scopes (infra) skip functional-design by design; when its artifacts are absent, derive the NFR context from the requirements and the code knowledge base instead — never invent the content of a missing artifact.

### Step 3: Assess NFR Categories

Analyze the unit across NFR categories:
- **Performance**: Response times, throughput, latency targets, resource utilization
- **Security**: Authentication, authorization, data protection, compliance requirements
- **Scalability**: Load handling, growth projections, scaling strategies
- **Reliability**: Availability targets, fault tolerance, disaster recovery, data durability
- **Observability**: Monitoring, logging, alerting, tracing requirements

### Step 4: Generate Questions

Create a questions file at `<record>/construction/{unit-name}/nfr-requirements/nfr-requirements-questions.md` for unclear NFR areas using [Answer]: tags. Focus on quantifiable targets and specific constraints.

### Step 5: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file). Perform MANDATORY ambiguity analysis:
- Identify vague answers ("fast enough", "highly available", "secure")
- Check for contradictions between NFR targets
- Flag missing quantitative targets

If ANY ambiguity found: create follow-up questions and resolve before proceeding.

### Step 6: Generate Artifacts

Generate the following in `<record>/construction/{unit-name}/nfr-requirements/`:

- **performance-requirements.md**: Response time targets, throughput requirements, latency budgets, resource constraints, benchmarks
- **security-requirements.md**: Authentication requirements, authorization model, data protection, compliance, threat considerations
- **scalability-requirements.md**: Load projections, scaling triggers, capacity planning, data growth, concurrency targets
- **reliability-requirements.md**: Availability targets (SLA/SLO), fault tolerance requirements, backup/recovery, graceful degradation
- **tech-stack-decisions.md**: Technology selections and rationale — languages, frameworks, databases, infrastructure tools, and justification for each choice

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage nfr-requirements --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 8: Completion

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

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings).
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter (this stage consumes `business-logic-model`, `business-rules`, `requirements`).
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
- Verification check → new manifest at `{{HARNESS_DIR}}/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
