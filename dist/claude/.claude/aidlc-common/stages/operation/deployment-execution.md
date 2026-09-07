---
slug: deployment-execution
phase: operation
execution: CONDITIONAL
condition: Execute after deployment pipeline and environment are ready
lead_agent: aidlc-pipeline-deploy-agent
support_agents:
  - aidlc-developer-agent
mode: inline
summary_confirmation: required
produces:
  - deployment-log
  - smoke-test-results
  - health-check-report
  - deployment-execution-questions
consumes:
  - artifact: cd-config
    required: true
  - artifact: deployment-strategy
    required: true
  - artifact: environment-inventory
    required: true
  - artifact: build-test-results
    required: true
requires_stage:
  - deployment-pipeline
  - environment-provisioning
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
inputs: CD pipeline config from deployment-pipeline stage, provisioned environments from environment-provisioning stage, built artifacts from Construction
outputs: deployment-log.md, smoke-test-results.md, health-check-report.md, deployment-execution-questions.md (under this stage's record dir, engine-resolved)
---

# Deployment Execution

## Steps

### Step 1: Load Prior Context

- Read CD pipeline config and deployment strategy from `<record>/operation/deployment-pipeline/` (if they exist)
- Read environment inventory from `<record>/operation/environment-provisioning/` (if exists)
- Read build/test results from `<record>/construction/build-and-test/` (if exists)
- Read rollback runbook (if exists)

Incremental scopes (`bugfix`, `refactor`, `security-patch`, and `infra`) plus
`express` may skip Environment Provisioning or Build and Test by design.
`bugfix`, `refactor`, `security-patch`, and `express` retain Build and Test but
skip Environment Provisioning; `infra` retains Environment Provisioning but
skips Build and Test. Deployment Pipeline may also report skipped when the
workspace's existing pipeline is already adequate; in that case its absent
`cd-config` and `deployment-strategy` artifacts are expected, and this stage
must inspect and use the real pipeline configuration in the workspace instead
of invoking missing-artifact recovery. Inventory actual target environments
from that workspace configuration and any approved Deployment Pipeline
artifacts. For Express greenfield, deployment proceeds only when those files
identify a real target; otherwise this CONDITIONAL stage reports skipped.
Never invent an environment inventory or deployment path.

### Step 2: Pre-Deployment Checks

Create questions file covering:
- Are all pre-deployment checks passing?
- Are database migrations required and tested?
- Are dependent services available and healthy?
- What is the deployment window?

Follow stage-protocol.md question flow.

### Step 3: Execute Deployment

Push artifacts through the pipeline. Run smoke tests. Validate health checks. Execute database migrations if needed: delegate to Task tool with subagent_type="aidlc-developer-agent" for migration execution.

### Step 4: Generate Artifacts

Create deployment execution log, smoke test results, health check validation report, and database migration log (if applicable).

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage deployment-execution --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :package:
Review path: `<record>/operation/deployment-execution/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/deployment-execution/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `cd-config`, `deployment-strategy`, `environment-inventory`, `build-test-results`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
