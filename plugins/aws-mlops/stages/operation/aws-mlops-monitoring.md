---
slug: aws-mlops-monitoring
number: 4.81
name: ML Monitoring and Maintenance
plugin: aws-mlops
phase: operation
execution: ALWAYS
condition: Verify autonomous AWS monitoring, retraining and recovery
lead_agent: aws-mlops-ml-engineer-agent
support_agents: [aidlc-operations-agent, aws-mlops-data-scientist-agent]
mode: inline
produces: [aws-mlops-monitoring, aws-mlops-maintenance-runbook]
consumes:
  - artifact: aws-mlops-deployment
    required: true
  - artifact: aws-mlops-lifecycle-design
    required: true
  - artifact: aws-mlops-quality-contract
    required: false
requires_stage: [aws-mlops-deployment]
sensors: [required-sections, upstream-coverage, aws-mlops-crisp-mlq]
scopes: [aws-mlops-platform, aws-mlops-crisp-mlq]
ars:
  targets: [ve, r]
  cost: 4
inputs: Deployed platform or model and approved monitoring/retraining contracts
outputs: aws-mlops-monitoring.md and aws-mlops-maintenance-runbook.md
---

# Monitoring and maintenance

Follow the active stage protocol. Recurring operations run in AWS without an
ongoing AI session.

## Steps

Read `{{HARNESS_DIR}}/knowledge/aidlc-shared/aws-mlops-crisp-mlq.md` and
`{{HARNESS_DIR}}/tools/aws-mlops-crisp-mlq.ts`. For a model, apply the
maintenance contract and quality loop to signals, labeled outcomes, updates,
feedback effects and update costs. Unavailable ground truth leaves predictive
quality unmeasured; recurring training preserves the recorded promotion policy.

### Step 1: Verify monitoring

Deploy/use the built in-account jobs, EventBridge schedules, S3 analysis outputs
and CloudWatch metrics/alarms. Separate data quality/drift, prediction drift,
service health and predictive quality. Join available ground truth by the
accepted keys/windows, recording delay and coverage. Without labels, state
predictive quality is unmeasured. Validate alerts with safe fixtures using the
existing notification policy; do not contact people merely to test a channel.

For a new customer, verify service availability and use the designed alternative
to Model Monitor/Clarify. Record baselines, thresholds, owners and cost/retention.

### Step 2: Verify retraining and promotion

Test schedule/event triggering, duplicate handling, cooldown, concurrency and
budget bounds, failure recovery and challenger comparisons. A new data version
starts a new SageMaker pipeline execution with preserved lineage. A passing
candidate follows the recorded production promotion policy, not automatic
approval inferred from drift. Demonstrate a bounded update and recovery when
authorized; record unexecuted paths as pending.

### Step 3: Deliver the operational handoff

Write `aws-mlops-monitoring.md` with `## Signals`, `## Ground Truth`,
`## Verified Triggers`, `## Runtime Evidence`, `## Limits` and `## Sources`.
Write `aws-mlops-maintenance-runbook.md` with `## Owners`, `## Retraining`,
`## Promotion`, `## Incident and Recovery`, `## Cost and Shutdown`
and `## Change the Methodology`. Include how to pause schedules/jobs, restore
the prior release and safely retire resources. A method change revisits affected
artifacts using the engine; it does not silently relabel an approved project.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-monitoring --result <outcome>`.
The handoff explicitly separates commissioned behavior and remaining checks.

## Sensors

For a model, add `## Quality Assurance` to the primary output and write its
adjacent `.crisp-mlq.json` coverage record using the local reference and every
maintenance requirement. Import the advisory `aws-mlops-crisp-mlq` sensor.
For the platform profile, write the same side input with `schema_version: 1`,
`methodology: crisp-mlq`, the current `reference_revision`, this exact `stage`,
`profile: platform`, `applicability: platform-commissioning` and a `rationale`
explaining that the fixture verifies monitoring plumbing, not predictive quality.

`required-sections` and `upstream-coverage` check outputs and upstream references.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
