---
slug: observability-setup
phase: operation
execution: CONDITIONAL
condition: Execute when monitoring, dashboards, alarms, or tracing need configuration
lead_agent: aidlc-operations-agent
support_agents: []
mode: inline
summary_confirmation: required
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
  - artifact: infrastructure-specification
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
  - express
inputs: NFR design from nfr-design stage, infrastructure design from infrastructure-design stage, deployed application
outputs: dashboards.md, alarms.md, slo-config.md, log-queries.md, tracing-config.md, anomaly-config.md, observability-setup-questions.md (under this stage's record dir, engine-resolved)
---

# Observability Setup

## Steps

### Step 1: Load Prior Context

- Read NFR design (observability strategy) from `<record>/construction/nfr-design/`
- Read infrastructure design from `<record>/construction/infrastructure-design/`
- Read deployment execution log from `<record>/operation/deployment-execution/`

`express` skips NFR Design and Infrastructure Design by design. When those
artifacts are absent, derive the minimum observable surface from approved
requirements, the deployed application's workspace configuration, Build and
Test results, and the Deployment Execution evidence. Ask for any SLO, signal,
retention, or escalation decision that cannot be observed from those sources;
never invent a missing design artifact. If no deployed target exists, this
CONDITIONAL stage reports skipped.

### Step 2: Generate Clarifying Questions

Create questions file covering:
- What are the golden signals to track (latency, traffic, errors, saturation)?
- What SLOs/SLIs are defined?
- What dashboard layouts does the team need?
- What log retention and aggregation rules apply?
- What distributed tracing instrumentation is needed?

Follow stage-protocol.md question flow.

### Step 3: Generate Artifacts

Create CloudWatch dashboard configurations, alarm definitions (with severity, SNS routing, escalation), SLO/SLI tracking configuration, CloudWatch Logs Insights saved queries, X-Ray tracing configuration, and anomaly detection configuration.

### Step 4: Completion Handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage observability-setup --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 5: Present Completion & Request Approval

Completion emoji: :eyes:
Review path: `<record>/operation/observability-setup/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/observability-setup/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `performance-design`, `security-design`, `reliability-design`, `monitoring-design`, `infrastructure-specification`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
