---
slug: aws-mlops-deployment
number: 4.80
name: MLOps Deployment and Commissioning
plugin: aws-mlops
phase: operation
execution: ALWAYS
condition: Commission the platform or deploy the evaluated model under the recorded policy
lead_agent: aws-mlops-ml-engineer-agent
support_agents: [aidlc-pipeline-deploy-agent, aidlc-aws-platform-agent]
mode: inline
produces: [aws-mlops-deployment]
consumes:
  - artifact: aws-mlops-lifecycle-design
    required: true
  - artifact: aws-mlops-evaluation
    required: false
  - artifact: aws-mlops-platform-validation
    required: false
  - artifact: environment-inventory
    required: true
  - artifact: cd-config
    required: true
  - artifact: rollback-runbook
    required: true
requires_stage: [environment-provisioning, deployment-pipeline, aws-mlops-evaluation, aws-mlops-platform-validation]
sensors: [required-sections, upstream-coverage]
scopes: [aws-mlops-platform, aws-mlops-crisp-mlq]
ars:
  targets: [r, ve]
  cost: 5
inputs: Commissioned environment or new platform, validated artifacts and release policy
outputs: aws-mlops-deployment.md
---

# Deploy and commission

Follow the active stage protocol and existing environment/deployment authority.

## Steps

### Step 1: Resolve release readiness

For the platform, use the platform-validation report and newly provisioned
inventory. For a model, use its actual evaluation and the supplied platform
inventory. Both inputs are optional in frontmatter because each belongs to a
different profile; require the appropriate one for this intent. Surface
failed/pending criteria and the human's disposition without misreporting success.

### Step 2: Commission or release

For the platform, deploy its service/pipeline configuration and run the approved
bounded fixture through preparation, training, evaluation, registration and
inference. Record failure-branch behavior as well as successful execution.

For the model, register the actual version with lineage/evaluation metadata,
apply the person's promotion policy and use the configured code/model release
pipeline. Choose batch, asynchronous or real-time inference from the approved
design. Verify permissions, limits, artifact identity and train/serve consistency.
Use supported endpoint traffic shifting/rollback where applicable; batch recovery
uses versioned inputs/outputs and rerun/backfill.

### Step 3: Measure serving behavior and recovery

Run real smoke predictions and verify schemas, latency/throughput/error measures
as relevant, and recovery. Record target environment, model/package versions,
pipeline/job/endpoint references and exact checks. A resource-create response
alone is not inference evidence.

Write `aws-mlops-deployment.md` with `## Release`, `## Policy Decisions`,
`## Runtime Checks`, `## Recovery`, `## Pending Work` and `## Sources`.
Distinguish local validation from deployed execution. If deployment cannot run,
record pending work and use the protocol's existing skip/revision mechanisms.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-deployment --result <outcome>`.

## Sensors

`required-sections` and `upstream-coverage` check artifact shape and references.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
