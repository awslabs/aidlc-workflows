---
slug: incident-response
phase: operation
execution: CONDITIONAL
condition: Execute when operational runbooks and incident response procedures are needed
lead_agent: aidlc-operations-agent
support_agents: []
mode: inline
summary_confirmation: required
produces:
  - runbooks
  - incident-plan
  - escalation-matrix
  - incident-response-questions
consumes:
  - artifact: dashboards
    required: true
  - artifact: alarms
    required: true
  - artifact: reliability-design
    required: true
  - artifact: security-design
    required: true
  - artifact: infrastructure-specification
    required: true
requires_stage:
  - observability-setup
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - workshop
inputs: Observability setup from observability-setup stage, NFR design from nfr-design stage, infrastructure design from infrastructure-design stage
outputs: runbooks.md, incident-plan.md, escalation-matrix.md, incident-response-questions.md (under this stage's record dir, engine-resolved)
---

# Incident Response & Runbook Generation

## Steps

### Step 1: Load Prior Context

- Read observability setup from `<record>/operation/observability-setup/`
- Read NFR design from `<record>/construction/nfr-design/`
- Read infrastructure design from `<record>/construction/infrastructure-design/`

### Step 2: Generate Clarifying Questions

Create questions file covering:
- What are the most likely failure modes?
- What are the escalation paths and on-call rotations?
- What automated remediation is possible?
- What are the communication procedures during incidents?
- What are the RTO/RPO targets?

Follow stage-protocol.md question flow.

### Step 3: Generate Artifacts

Create SSM Automation runbook library, incident response plan (integrated with AWS Incident Manager), escalation matrix, automated remediation documents, disaster recovery procedures, and AWS Backup configuration.

### Step 4: Completion Handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage incident-response --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 5: Present Completion & Request Approval

Completion emoji: :fire_engine:
Review path: `<record>/operation/incident-response/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/incident-response/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `dashboards`, `alarms`, `reliability-design`, `security-design`, `infrastructure-specification`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
