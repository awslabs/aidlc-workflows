---
slug: aws-mlops-platform-validation
number: 3.83
name: MLOps Platform Validation
plugin: aws-mlops
phase: construction
execution: ALWAYS
condition: Validate the reusable platform before provisioning it
lead_agent: aws-mlops-ml-engineer-agent
support_agents: [aidlc-aws-platform-agent, aidlc-quality-agent]
mode: inline
produces: [aws-mlops-platform-validation]
consumes:
  - artifact: aws-mlops-lifecycle-design
    required: true
  - artifact: aws-mlops-platform-architecture
    required: true
  - artifact: build-and-test-summary
    required: true
  - artifact: ci-config
    required: true
requires_stage: [aws-mlops-lifecycle-design, build-and-test, ci-pipeline]
sensors: [required-sections, upstream-coverage]
scopes: [aws-mlops-platform]
ars:
  targets: [csu, ve, r]
  cost: 4
inputs: Built platform IaC, SDK pipeline definitions, CI tests and fixture plan
outputs: aws-mlops-platform-validation.md
---

# Validate the platform before provisioning

Follow the active stage protocol.

## Steps

Read `{{HARNESS_DIR}}/knowledge/aidlc-shared/aws-mlops-crisp-mlq.md` for the
supporting lifecycle. Verify platform support for versioned phase records and
risk/evidence capture using synthetic fixtures. These checks demonstrate
plumbing, not the business model's six-phase acceptance.

### Step 1: Check infrastructure and code

Run the delivered project's meaningful static/unit tests: IaC synth and
assertions, role/KMS/storage/network contracts, parameter validation, image
build definitions, pipeline SDK compilation, and retry/idempotency behavior.
Stub AWS calls in CI so a test cannot create paid resources.

### Step 2: Check failure paths

Verify failed evaluation prevents candidate promotion, missing/corrupt artifacts
are surfaced, duplicate triggers are controlled, cross-environment releases
honor policy and budget/concurrency limits are present. Test monitoring and
retraining computation against known fixture outcomes. Do not use static
validation as evidence that these mechanisms ran in AWS.

### Step 3: Record readiness

Write `aws-mlops-platform-validation.md` with `## Checks`, `## Failure Paths`,
`## Remaining Runtime Checks`, `## Commissioning Inputs` and `## Sources`.
Record exact commands/results and the bounded post-provision commissioning plan.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-platform-validation --result <outcome>`.

## Sensors

`required-sections` and `upstream-coverage` check document and input references.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
