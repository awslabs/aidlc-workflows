---
slug: environment-provisioning
phase: operation
execution: CONDITIONAL
condition: Execute when AWS environments need provisioning or validation
lead_agent: aidlc-aws-platform-agent
support_agents:
  - aidlc-devsecops-agent
  - aidlc-compliance-agent
mode: inline
produces:
  - environment-inventory
  - validation-report
  - environment-provisioning-questions
consumes:
  - artifact: deployment-architecture
    required: true
  - artifact: infrastructure-services
    required: true
  - artifact: cd-config
    required: true
requires_stage:
  - infrastructure-design
  - deployment-pipeline
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - infra
  - workshop
inputs: Infrastructure design from infrastructure-design stage, CD pipeline config from deployment-pipeline stage
outputs: environment-inventory.md, validation-report.md, environment-provisioning-questions.md (under this stage's record dir, engine-resolved)
---

# Environment Provisioning

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-aws-platform-agent persona from `agents/aidlc-aws-platform-agent.md` and knowledge from `.aidlc/knowledge/aidlc-aws-platform-agent/`.

### Step 2: Load Prior Context

- Read infrastructure design from `<record>/construction/infrastructure-design/`
- Read security requirements from `<record>/construction/nfr-requirements/`

### Step 3: Generate Clarifying Questions

Create questions file covering:
- Are all environments provisioned per Infra Design?
- Are VPCs, subnets, security groups, NACLs correct?
- Are secrets in Secrets Manager / Parameter Store correctly injected?
- Is cross-account / cross-VPC connectivity validated?

Follow stage-protocol.md question flow.

### Step 4: Provision and Validate

Provision target AWS environments using IaC from Construction. Validate infrastructure configuration. The orchestrator will invoke aidlc-devsecops-agent for security posture validation.

### Step 5: Generate Artifacts

Create provisioned environment inventory, infrastructure validation report, secrets & parameter store audit, stack deployment logs, and environment health check results.

### Step 6: Update State

Mark environment-provisioning as `[x]` completed in `<record>/aidlc-state.md`.

### Step 7: Present Completion & Request Approval

Completion emoji: :cloud:
Review path: `<record>/operation/environment-provisioning/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/environment-provisioning/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `deployment-architecture`, `infrastructure-services`, `cd-config`).

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

- Prescriptive rule → `.aidlc/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.aidlc/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
