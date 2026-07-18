---
slug: observability-setup
phase: operation
execution: CONDITIONAL
condition: Execute when monitoring, dashboards, alarms, or tracing need configuration
lead_agent: aidlc-operations-agent
support_agents: []
mode: inline
produces:
  - dashboards
  - alarms
  - slo-config
  - log-queries
  - tracing-config
  - anomaly-config
  - observability-setup-questions
consumes:
  - artifact: performance-design
    required: true
  - artifact: security-design
    required: true
  - artifact: reliability-design
    required: true
  - artifact: monitoring-design
    required: true
  - artifact: infrastructure-services
    required: true
requires_stage:
  - nfr-design
  - infrastructure-design
  - deployment-execution
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - infra
  - workshop
inputs: NFR design from nfr-design stage, infrastructure design from infrastructure-design stage, deployed application
outputs: dashboards.md, alarms.md, slo-config.md, log-queries.md, tracing-config.md, anomaly-config.md, observability-setup-questions.md (under this stage's record dir, engine-resolved)
---

# Observability Setup

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-operations-agent persona from `agents/aidlc-operations-agent.md` and knowledge from `.codex/knowledge/aidlc-operations-agent/`.

### Step 2: Load Prior Context

- Read NFR design (observability strategy) from `<record>/construction/nfr-design/`
- Read infrastructure design from `<record>/construction/infrastructure-design/`
- Read deployment execution log from `<record>/operation/deployment-execution/`

### Step 3: Generate Clarifying Questions

Create questions file covering:
- What are the golden signals to track (latency, traffic, errors, saturation)?
- What SLOs/SLIs are defined?
- What dashboard layouts does the team need?
- What log retention and aggregation rules apply?
- What distributed tracing instrumentation is needed?

Follow stage-protocol.md question flow.

### Step 4: Generate Artifacts

Create CloudWatch dashboard configurations, alarm definitions (with severity, SNS routing, escalation), SLO/SLI tracking configuration, CloudWatch Logs Insights saved queries, X-Ray tracing configuration, and anomaly detection configuration.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .codex/tools/aidlc-orchestrate.ts report --stage observability-setup --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 6: Present Completion & Request Approval

Completion emoji: :eyes:
Review path: `<record>/operation/observability-setup/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/observability-setup/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `performance-design`, `security-design`, `reliability-design`, `monitoring-design`, `infrastructure-services`).

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
- Verification check → new manifest at `.codex/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
