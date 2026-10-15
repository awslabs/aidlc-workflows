---
slug: aws-mlops-data-preparation
number: 3.80
name: ML Data Preparation Verification
plugin: aws-mlops
phase: construction
execution: ALWAYS
condition: Verify the implemented preparation workflow for the chosen model
lead_agent: aws-mlops-data-scientist-agent
support_agents: [aws-mlops-ml-engineer-agent]
mode: inline
produces: [aws-mlops-data-preparation]
consumes:
  - artifact: aws-mlops-lifecycle-design
    required: true
  - artifact: aws-mlops-quality-contract
    required: true
  - artifact: build-and-test-summary
    required: true
requires_stage: [aws-mlops-lifecycle-design, build-and-test, ci-pipeline]
sensors: [required-sections, upstream-coverage, aws-mlops-crisp-mlq]
scopes: [aws-mlops-crisp-mlq]
ars:
  targets: [ve, r]
  cost: 4
inputs: Implemented processing workflow, dataset and split contracts and passing software tests
outputs: aws-mlops-data-preparation.md
---

# Verify data preparation

Follow the active stage protocol and the approved lifecycle design.

## Steps

Read `{{HARNESS_DIR}}/knowledge/aidlc-shared/aws-mlops-crisp-mlq.md` and the
phase contract in `{{HARNESS_DIR}}/tools/aws-mlops-crisp-mlq.ts` before work.
Apply its quality loop to selection, cleaning, feature construction, units,
train-only fitting and protected splits.

### Step 1: Resolve code and actual input versions

Read the built workspace processing code and pipeline definition. Identify
dataset object versions/manifests, schemas, hashes and split configuration.
Use the commissioned environment and recorded execution/budget policy for
Processing jobs. If only local execution is available, state that limit.

### Step 2: Run bounded preparation checks

Check schema/missingness/outliers/duplicates, temporal/entity disjointness,
feature/label timing and training-only fitting. Verify determinism and that
serving transformations match training. Record exclusions and their effects.
Inspect actual processed outputs; a passing software build is not a data check.

### Step 3: Record evidence

Write `aws-mlops-data-preparation.md` with `## Dataset and Splits`,
`## Quality Results`, `## Leakage Checks`, `## Reproducibility`,
`## Execution Status` and `## Sources`. Include execution reference, code/image
versions, dataset and split manifests, sample counts and unresolved findings.
Keep pending AWS execution distinct from local validation.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-data-preparation --result <outcome>`.
Use normal revisions to correct failed data checks without changing accepted
criteria merely to make them pass.

## Sensors

Before reporting completion, add `## Quality Assurance` to the primary output
and write its adjacent `.crisp-mlq.json` coverage record following the local
reference. Include all contract requirements and actual checks; proposals and
missing data remain pending. Import the advisory `aws-mlops-crisp-mlq` sensor.

`required-sections` and `upstream-coverage` check the document and input references.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
