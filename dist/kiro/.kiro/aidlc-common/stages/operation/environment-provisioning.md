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
summary_confirmation: required
produces:
  - environment-inventory
  - validation-report
  - environment-provisioning-questions
consumes:
  - artifact: infrastructure-specification
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
  - classic
  - workshop
inputs: Infrastructure design from infrastructure-design stage, CD pipeline config from deployment-pipeline stage
outputs: environment-inventory.md, validation-report.md, environment-provisioning-questions.md (under this stage's record dir, engine-resolved)
---

# Environment Provisioning

## Steps

### Step 1: Load Prior Context

- Read infrastructure design from `<record>/construction/infrastructure-design/`
- Read security requirements from `<record>/construction/nfr-requirements/`

### Step 2: Generate Clarifying Questions

Create questions file covering:
- Are all environments provisioned per Infra Design?
- Are VPCs, subnets, security groups, NACLs correct?
- Are secrets in Secrets Manager / Parameter Store correctly injected?
- Is cross-account / cross-VPC connectivity validated?

Follow stage-protocol.md question flow.

### Step 3: Provision and Validate

Provision target AWS environments using IaC from Construction. Validate infrastructure configuration. The orchestrator will invoke aidlc-devsecops-agent for security posture validation.

### Step 4: Generate Artifacts

Create provisioned environment inventory, infrastructure validation report, secrets & parameter store audit, stack deployment logs, and environment health check results.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage environment-provisioning --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :cloud:
Review path: `<record>/operation/environment-provisioning/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/environment-provisioning/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `infrastructure-specification`, `cd-config`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
