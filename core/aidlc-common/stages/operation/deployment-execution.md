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

When the deployment targets AWS (the pipeline or the deploy commands use the
AWS CLI, CDK, SAM, or CloudFormation), first check the AWS identity from your
own shell, before writing any question: run `aws sts get-caller-identity`
with the profile and region the deployment will use (the same `AWS_PROFILE`
and `AWS_REGION`, or the `--profile` and `--region` the pipeline names). A
person's terminal can be signed in while the shell your harness runs commands
in cannot see those credentials, and finding that out only when the deploy
starts costs the time of every answer before it.

- If it succeeds, go on. Never write the account ID or the full ARN into an
  artifact, a questions file, or the audit: when you note the identity, keep
  only the last four digits of the account (`********1234`) and the role or
  user name.
- If it fails (`NoCredentials`, `ExpiredToken`, `AccessDenied`, a missing
  profile), do not ask any deployment question yet. Ask one question through
  the stage-protocol.md question flow that says what failed, in the error's own
  words, and the fix: the credentials must be visible to the shell this agent
  runs commands in, so the person signs in again for that profile (for
  example `aws sso login --profile <profile>`), makes the profile and region
  available where the harness starts its shell (or restarts the harness from a
  terminal where they are set), and replies when it is done. Then run the
  check again; deploy only after it succeeds.

The same failure later in this stage (a token that expires mid-deploy) is
handled the same way: stop, ask with the fix, check again, then carry on.

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
`{{INVOKE}} engine orchestrate report --stage deployment-execution --result <outcome>`.
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

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
