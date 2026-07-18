---
slug: incident-response
phase: operation
execution: CONDITIONAL
condition: Execute when operational runbooks and incident response procedures are needed
lead_agent: aidlc-operations-agent
support_agents: []
mode: inline
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
  - artifact: deployment-architecture
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

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-operations-agent persona from `agents/aidlc-operations-agent.md` and knowledge from `.claude/knowledge/aidlc-operations-agent/`.

### Step 2: Load Prior Context

- Read observability setup from `<record>/operation/observability-setup/`
- Read NFR design from `<record>/construction/nfr-design/`
- Read infrastructure design from `<record>/construction/infrastructure-design/`

### Step 3: Generate Clarifying Questions

Create questions file covering:
- What are the most likely failure modes?
- What are the escalation paths and on-call rotations?
- What automated remediation is possible?
- What are the communication procedures during incidents?
- What are the RTO/RPO targets?

Follow stage-protocol.md question flow.

### Step 4: Generate Artifacts

Create SSM Automation runbook library, incident response plan (integrated with AWS Incident Manager), escalation matrix, automated remediation documents, disaster recovery procedures, and AWS Backup configuration.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage incident-response --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 6: Present Completion & Request Approval

Completion emoji: :fire_engine:
Review path: `<record>/operation/incident-response/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/incident-response/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `dashboards`, `alarms`, `reliability-design`, `security-design`, `deployment-architecture`).

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
