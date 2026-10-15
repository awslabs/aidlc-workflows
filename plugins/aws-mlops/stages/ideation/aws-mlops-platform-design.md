---
slug: aws-mlops-platform-design
number: 1.82
name: AWS MLOps Platform Architecture
plugin: aws-mlops
phase: ideation
execution: ALWAYS
condition: Design a new platform or validate the model's fit to a supplied platform
lead_agent: aidlc-aws-platform-agent
support_agents: [aws-mlops-ml-engineer-agent, aidlc-devsecops-agent]
mode: inline
produces: [aws-mlops-platform-architecture]
consumes:
  - artifact: aws-mlops-methodology-selection
    required: true
  - artifact: aws-mlops-business-data
    required: false
  - artifact: aws-mlops-quality-contract
    required: false
requires_stage: [aws-mlops-methodology-selection, aws-mlops-business-data]
sensors: [required-sections, upstream-coverage]
scopes: [aws-mlops-platform, aws-mlops-crisp-mlq]
ars:
  targets: [csu, r, ua]
  cost: 4
inputs: Platform intent or commissioned platform references and the model quality contract
outputs: aws-mlops-platform-architecture.md
---

# AWS platform architecture

Follow the active stage protocol. Use shared AWS MLOps knowledge.

## Steps

Read `{{HARNESS_DIR}}/knowledge/aidlc-shared/aws-mlops-crisp-mlq.md` for a
CRISP-ML(Q) model or its supporting platform. Design support for its phase
contracts and quality loop. Architecture proposals do not complete model-phase
evidence. Other selected methods retain their own requirements.

### Step 1: Resolve platform context

For a new platform, discover AWS accounts/region, team roles, existing network,
data source boundaries, retention, environment separation, IaC preferences and
budget. Honor existing answers and tools. For a model intent, inspect the
supplied commissioned-platform artifacts and actual configuration; identify
compatibility gaps rather than rebuilding that platform.

### Step 2: Design the shared capabilities

Design S3 data/artifact versions, ECR images, SageMaker execution roles,
Processing/Training/Pipelines, Model Registry, experiment tracking, code CI/CD,
inference, monitoring and reexecution. Specify parameter contracts so additional
methods reuse the same capabilities. Feature Store, Glue and streaming are
optional decisions driven by workload requirements.

Address IAM/KMS grants, audit, network routes/endpoints/DNS where needed, secrets,
quota/capacity, cost attribution, retention, retries, concurrency and teardown.
Verify region/customer availability; for new customers do not assume Model
Monitor or Clarify are available. Prefer in-account monitoring/analysis paths.

### Step 3: Document tradeoffs and commissioning

Write `aws-mlops-platform-architecture.md` with `## Architecture`,
`## Environment Contracts`, `## Security and Cost`, `## Commissioning`,
`## Decisions` and `## Sources`. Include environment account/region identifiers
when known, unresolved decisions with owners/consequences, deployment authority,
and a bounded fixture plan proving preparation→training→evaluation→registry→
inference→monitoring→retraining plus failed evaluation and recovery.
Platform smoke fixtures are not business accuracy evidence.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-platform-design --result <outcome>`.
Let the person decide material architecture and budget tradeoffs.

## Sensors

`required-sections` and `upstream-coverage` verify shape and existing input
references. An architecture document is a proposal until deployed and measured.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
