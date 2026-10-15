---
slug: aws-mlops-business-data
number: 1.81
name: ML Business and Data Understanding
plugin: aws-mlops
phase: ideation
execution: ALWAYS
condition: Execute for a model using CRISP-ML(Q)
lead_agent: aws-mlops-data-scientist-agent
support_agents: [aidlc-product-agent]
mode: inline
produces: [aws-mlops-business-data, aws-mlops-quality-contract]
consumes:
  - artifact: aws-mlops-methodology-selection
    required: true
requires_stage: [aws-mlops-methodology-selection]
sensors: [required-sections, upstream-coverage, aws-mlops-crisp-mlq]
scopes: [aws-mlops-crisp-mlq]
ars:
  targets: [iae, ua, r]
  cost: 3
inputs: Chosen methodology, business problem and actual data inventory
outputs: aws-mlops-business-data.md and aws-mlops-quality-contract.md
---

# Business and data understanding

Follow the active stage protocol. Read shared and data-scientist knowledge.

## Steps

Read `{{HARNESS_DIR}}/knowledge/aidlc-shared/aws-mlops-crisp-mlq.md` and the
phase contract in `{{HARNESS_DIR}}/tools/aws-mlops-crisp-mlq.ts` before work.
Use the supplied requirements and per-task quality loop even without prior
knowledge of the method.

### Step 1: Establish business success

Define the decision supported, current baseline, users, business value,
prediction target, decision time, observation unit and horizon. Distinguish
business acceptance from offline model metrics. Ask only unanswered business
judgment questions; explain the consequence of missing answers.

### Step 2: Inspect available data

Inventory real source locations, schema, permissions, owner, refresh frequency,
labels and label delay. Use authorized bounded profiling to measure volume,
missingness, distributions and population coverage. Record unavailable data as
pending; a schema description alone is not a data quality result. Identify
privacy, bias, selection effects, entity/time overlap and post-outcome leakage.

### Step 3: Agree the quality contract

Before final test evaluation, propose metrics with direction, thresholds,
baseline comparisons, uncertainty and relevant population slices. Record
the human's accepted requirements and the rationale, along with inference
modality, latency/throughput needs, operational targets, budget and failure cost.
Keep uncertainty visible; do not invent acceptable thresholds.

Write `aws-mlops-business-data.md` with `## Business`, `## Data Evidence`,
`## Risks` and `## Open Decisions`. Write `aws-mlops-quality-contract.md`
with `## Acceptance Criteria`, `## Evaluation Protocol`, `## Operational Targets`
and `## Decision References`. Cite the selection artifact and actual inputs.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-business-data --result <outcome>`.
Use the stage protocol's revision/gate flow for judgment decisions.

## Sensors

Before reporting completion, add `## Quality Assurance` to the primary output
and write its adjacent `.crisp-mlq.json` coverage record following the local
reference. Cover every requirement in this stage's contract, including aligned
business/ML/economic criteria, feasibility and measured data evidence.
Keep unavailable work pending. The advisory `aws-mlops-crisp-mlq` sensor checks
coverage and risk records; it does not verify their truth.

Import `required-sections` and `upstream-coverage`. Evidence is measured data,
source references and the approved quality contract, not a guessed algorithm.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
