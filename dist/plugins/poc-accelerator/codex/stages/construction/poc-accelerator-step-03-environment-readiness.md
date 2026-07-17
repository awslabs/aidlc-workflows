---
slug: poc-accelerator-step-03-environment-readiness
number: 3.80
name: PoC Environment Readiness
plugin: poc-accelerator
phase: construction
execution: ALWAYS
condition: Always executes before application work to make deployment reproducible from CDK.
lead_agent: aidlc-pipeline-deploy-agent
support_agents:
  - aidlc-architect-agent
mode: inline
workspace_requires: true
produces:
  - poc-accelerator-environment-readiness
  - poc-accelerator-bootstrap-log
  - poc-accelerator-baseline-deployment
consumes:
  - artifact: poc-accelerator-solution-design
    required: true
  - artifact: poc-accelerator-cdk-stack-plan
    required: true
requires_stage:
  - poc-accelerator-step-02-solution-design
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - poc-accelerator-cde
inputs: Approved solution design and CDK stack plan
outputs: CDK source changes plus poc-accelerator-environment-readiness.md, poc-accelerator-bootstrap-log.md, poc-accelerator-baseline-deployment.md (under this stage's record dir, engine-resolved)
---

# PoC Environment Readiness

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Verify the AWS Boundary

Load the deployment persona, CDK patterns, and MCP setup guidance. Verify the
regional MCP configuration is live (created at the harness's MCP config
location from the matching regional example, servers responding) — later
stages depend on it. Confirm
the customer-approved AWS account, region, identity method, and non-production
boundary through read-only AWS API MCP server calls (identity, region, and
existing-resource discovery) before any mutation; keep
`REQUIRE_MUTATION_CONSENT=true`. Do not place access keys or customer
credentials in source control or stage artifacts.

### Step 2: Prepare CDK as Code

Inspect or create the TypeScript CDK app in the workspace. Run the project build
and `cdk synth`; run `cdk bootstrap` only for the approved account and region.
Make all infrastructure changes in CDK source, not manually in a console.

### Step 3: Establish a Baseline Deployment

Deploy the minimal safe stack or a deliberately empty baseline required by the
solution design. Verify the deployed stack state through the AWS API MCP
server rather than asserting it from command exit codes. Capture stack name,
region, logical resources, command output, and rollback/cleanup command without
recording secrets.

### Step 4: Write Readiness Evidence

Create `poc-accelerator-environment-readiness.md`,
`poc-accelerator-bootstrap-log.md`, and
`poc-accelerator-baseline-deployment.md`. Flag any account permission or region
blocker immediately with a customer/SA owner.

### Step 5: Update State

This is an automatic readiness checkpoint. Mark
`poc-accelerator-step-03-environment-readiness` complete in `<record>/aidlc-state.md`;
escalate blockers rather than bypassing CDK or the approved account boundary.

## Sensors

The upstream-coverage sensor ties the deployed baseline to the CDK stack plan.
The required-sections sensor ensures the evidence is inspectable.

## Learn

Record timestamped interpretations, deviations, tradeoffs, and open questions
in `<record>/<phase>/<stage>/memory.md`. Never copy credential values into the
learning log.
