---
slug: aws-mlops-modeling
number: 3.81
name: Reproducible ML Modeling
plugin: aws-mlops
phase: construction
execution: ALWAYS
condition: Train and compare the baseline and model candidates
lead_agent: aws-mlops-data-scientist-agent
support_agents: [aws-mlops-ml-engineer-agent]
mode: inline
produces: [aws-mlops-modeling]
consumes:
  - artifact: aws-mlops-data-preparation
    required: true
  - artifact: aws-mlops-lifecycle-design
    required: true
  - artifact: aws-mlops-quality-contract
    required: true
requires_stage: [aws-mlops-data-preparation]
sensors: [required-sections, upstream-coverage]
scopes: [aws-mlops-crisp-mlq]
ars:
  targets: [ve, r]
  cost: 5
inputs: Versioned prepared data, experiment protocol and implemented training pipeline
outputs: aws-mlops-modeling.md
---

# Reproducible modeling

Follow the active stage protocol and approved experiment/execution policy.

## Steps

### Step 1: Establish the experiment

Train a justified simple baseline and bounded candidates using identical
split/evaluation contracts. Pin code, dependencies, image digest, data versions,
seed and parameters. Tune on validation data; keep final test data untouched.

### Step 2: Execute and track

Use SageMaker Training/Pipelines and managed MLflow when available and justified.
Honor the agreed budget, environment and job authority. Track actual run IDs,
parameters, validation metrics, artifacts, duration, failures and cost evidence.
Where jobs cannot run, state what remains and do not invent a model artifact.

### Step 3: Select a candidate with evidence

Explain candidate/baseline differences, uncertainty and complexity/latency/cost
tradeoffs. Keep business tradeoffs with the person. Write `aws-mlops-modeling.md`
with `## Experiments`, `## Baseline Comparison`, `## Candidate`,
`## Lineage`, `## Execution Status` and `## Sources`.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-modeling --result <outcome>`.
Selecting a candidate is not approving production deployment.

## Sensors

`required-sections` and `upstream-coverage` check reported outputs and inputs.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
