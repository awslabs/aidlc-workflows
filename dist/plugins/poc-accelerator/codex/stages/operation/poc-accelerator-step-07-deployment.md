---
slug: poc-accelerator-step-07-deployment
number: 4.80
name: PoC CDK Deployment
plugin: poc-accelerator
phase: operation
execution: ALWAYS
condition: Always executes after validation to deploy the approved PoC through TypeScript CDK.
lead_agent: aidlc-pipeline-deploy-agent
support_agents:
  - aidlc-developer-agent
  - aidlc-quality-agent
mode: inline
produces:
  - poc-accelerator-step-07-deployment-log
  - poc-accelerator-smoke-test-results
  - poc-accelerator-stack-inventory
consumes:
  - artifact: poc-accelerator-test-results
    required: true
  - artifact: poc-accelerator-cdk-stack-plan
    required: true
  - artifact: poc-accelerator-environment-readiness
    required: true
requires_stage:
  - poc-accelerator-step-06-test-validation
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - poc-accelerator-cde
inputs: Test evidence, approved CDK stack plan, and environment readiness evidence
outputs: poc-accelerator-step-07-deployment-log.md, poc-accelerator-smoke-test-results.md, poc-accelerator-stack-inventory.md (under this stage's record dir, engine-resolved)
---

# PoC CDK Deployment

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Recheck Deployment Preconditions

Read validation evidence, stack plan, and readiness evidence. Confirm the target
account/region, approved non-production boundary, deployment command, and
cleanup owner. A failed required test needs an explicit SA disposition before
deployment.

### Step 2: Deploy Through CDK

Validate the synthesized template through the AWS IaC MCP server (cfn-lint and
compliance checks), then run the TypeScript CDK build, `cdk synth`, and approved
`cdk deploy` command. Do not substitute manual resource creation. Capture
CloudFormation stack names, logical resource types, outputs, and safe
cost/cleanup watchpoints; never store credentials or sensitive endpoint tokens
in the record.

### Step 3: Smoke Test the Deployed Flow

Run the documented safe smoke flow with synthetic or masked data. Record output
and health result in `poc-accelerator-smoke-test-results.md`.

### Step 4: Capture Deployment Evidence

Create `poc-accelerator-step-07-deployment-log.md` and
`poc-accelerator-stack-inventory.md` with commands, deployed stack, region,
resource inventory, outputs, rollback/cleanup command, and known limits. Build
the resource inventory from read-only AWS API MCP server queries against the
deployed CloudFormation stack, not from memory — the step-8 cost projection
prices exactly this inventory.

### Step 5: SA Deployment Gate

Ask only:

- **Approve deployment** — freeze the demonstrable PoC for handoff.
- **Request changes** — remediate deployment evidence or the safe flow.

### Step 6: Update State

Mark `poc-accelerator-step-07-deployment` complete in `<record>/aidlc-state.md`.

## Sensors

Markdown sensors verify evidence covers the test result, stack plan, and
readiness record. CDK remains the single source of infrastructure truth.

## Learn

Maintain timestamped interpretations, deviations, tradeoffs, and open questions
in `<record>/<phase>/<stage>/memory.md`. Keep account metadata at the minimum
needed for repeatability.
