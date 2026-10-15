---
slug: aws-mlops-lifecycle-design
number: 2.80
name: ML Lifecycle Design
plugin: aws-mlops
phase: inception
execution: ALWAYS
condition: Specify ML contracts before construction begins
lead_agent: aws-mlops-ml-engineer-agent
support_agents: [aws-mlops-data-scientist-agent, aidlc-quality-agent]
mode: inline
produces: [aws-mlops-lifecycle-design]
consumes:
  - artifact: aws-mlops-platform-architecture
    required: true
  - artifact: aws-mlops-quality-contract
    required: false
  - artifact: requirements
    required: true
  - artifact: unit-of-work
    required: true
  - artifact: bolt-plan
    required: true
requires_stage: [aws-mlops-platform-design, delivery-planning]
sensors: [required-sections, upstream-coverage]
scopes: [aws-mlops-platform, aws-mlops-crisp-mlq]
ars:
  targets: [csu, ve, r]
  cost: 4
inputs: Approved architecture, requirements, units, delivery plan and model criteria
outputs: aws-mlops-lifecycle-design.md
---

# Design the lifecycle before implementing it

Follow the active stage protocol. Resolve the person-selected method and profile.

## Steps

### Step 1: Specify data and experiment contracts

For a model, define schema/validation, immutable dataset and split manifests,
train-only transformations, temporal/entity leakage checks, baseline, candidates,
seeds, hyperparameters, dependency locks and protected test evaluation.
Map each accepted metric to its computation, direction, threshold, evidence
location and decision reference. Avoid deriving thresholds from test outcomes.

For a platform, define these as reusable interfaces and provide a small
commissioning fixture; mark its metrics as fixture assertions.

### Step 2: Specify execution and release contracts

Design parameterized SageMaker steps, conditions, outputs and recovery branches.
Record code/image/data/model lineage; separate code delivery, training and
production promotion. Specify registry states, artifact integrity, inference
schema, batch or endpoint deployment, modality-specific rollback/backfill,
observability and cost/concurrency limits.

Define ground-truth source, delay, matching keys and windows; drift metrics and
thresholds; alert owners; retraining triggers, deduplication, budget/cooldown,
challenger evaluation and the agreed production approval policy. Missing labels
leave predictive-quality monitoring unmeasured.

### Step 3: Specify validation and implementation ownership

Map each contract to a unit, workspace path and meaningful local or in-AWS test.
Use stubs/local fixtures for CI. Distinguish synth/SDK pipeline compilation from
actual executions. For model intents, make platform readiness a prerequisite
for paid jobs. Write `aws-mlops-lifecycle-design.md` with `## Data`,
`## Training`, `## Evaluation`, `## Deployment`, `## Maintenance`,
`## Validation`, `## Decisions` and `## Sources`.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-lifecycle-design --result <outcome>`.
Core construction reads this artifact; revise its inputs when the person
changes a prior business or architectural decision.

## Sensors

`required-sections` and `upstream-coverage` report document gaps. Lifecycle
contracts are design inputs, not completed runtime results.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
