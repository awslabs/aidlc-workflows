---
slug: deployment-pipeline
phase: operation
execution: CONDITIONAL
condition: Execute when CD pipeline needs creation or significant modification
lead_agent: aidlc-pipeline-deploy-agent
support_agents: []
mode: inline
summary_confirmation: required
produces:
  - cd-config
  - deployment-strategy
  - rollback-runbook
  - deployment-pipeline-questions
consumes:
  - artifact: ci-config
    required: true
  - artifact: quality-gates
    required: true
  - artifact: infrastructure-specification
    required: true
  - artifact: cicd-pipeline
    required: true
requires_stage:
  - ci-pipeline
  - infrastructure-design
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - infra
  - bugfix
  - refactor
  - security-patch
  - classic
  - workshop
  - express
inputs: CI pipeline config from ci-pipeline stage, infrastructure design from infrastructure-design stage
outputs: cd-config.md, deployment-strategy.md, rollback-runbook.md, deployment-pipeline-questions.md (under this stage's record dir, engine-resolved)
---

# Deployment Pipeline Configuration

## Steps

### Step 1: Load Prior Context

- Read CI pipeline config from `<record>/construction/ci-pipeline/` (if exists)
- Read infrastructure design from `<record>/construction/infrastructure-design/` (if exists)
- Read NFR design (deployment-related NFRs) from `<record>/construction/nfr-design/` (if exists)

Incremental scopes (`bugfix`, `refactor`, and `security-patch`) and `express`
skip CI Pipeline and Infrastructure Design by design. On brownfield, inspect
the workspace's existing pipeline and infrastructure configuration plus the
code knowledge base. On Express greenfield, use the approved requirements,
Build and Test results, and deployment artifacts generated in the workspace
(for example a Dockerfile, service manifest, or IaC); if no deployable target
exists, this CONDITIONAL stage reports skipped. Design only against evidence
that exists - never invent a missing CI or infrastructure artifact.

### Step 2: Generate Clarifying Questions

Create questions file covering:
- What deployment strategy (blue/green, canary, rolling)?
- What environment promotion gates (dev → staging → prod)?
- What approval workflows for production?
- What rollback procedure?
- What feature flag strategy (CloudWatch Evidently, AppConfig)?

Follow stage-protocol.md question flow.

### Step 3: Generate Artifacts

Create CD pipeline configuration, deployment strategy document, rollback runbook, feature flag configuration, and environment promotion matrix.

### Step 4: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage deployment-pipeline --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 5: Present Completion & Request Approval

Completion emoji: :rocket:
Review path: `<record>/operation/deployment-pipeline/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/deployment-pipeline/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `ci-config`, `quality-gates`, `infrastructure-specification`, `cicd-pipeline`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
