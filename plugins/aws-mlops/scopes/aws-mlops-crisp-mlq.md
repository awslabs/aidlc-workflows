---
name: aws-mlops-crisp-mlq
plugin: aws-mlops
depth: Standard
keywords: [CRISP-ML(Q), crisp-mlq, sagemaker model]
description: Develop, deploy and maintain a SageMaker model using CRISP-ML(Q)
skeleton: on
runner: true
guard_policy: off
sensors: on
learnings: on
summary_confirmation: on
plan_approval: on
collaborators: off
---

# CRISP-ML(Q) on AWS

An explicit human request for this profile selects CRISP-ML(Q); record it without
asking again. A scope selected only by an agent remains a recommendation until
the person chooses it.

## Methodology

Business and data understanding → data preparation → modeling → evaluation →
deployment → monitoring and maintenance. Quality and risk assessment apply
throughout; return to an earlier stage when evidence calls for a revision.
The shipped `knowledge/aidlc-shared/aws-mlops-crisp-mlq.md` reference defines
the operating method locally. `tools/aws-mlops-crisp-mlq.ts` owns its versioned
phase/evidence mapping; per-phase advisory coverage complements numeric checks.

## Platform dependency

Use the platform commissioned by `aws-mlops-platform`, or equivalent existing
AWS infrastructure supplied by the person. Capture its actual configuration
and validation evidence before running paid training or deploying. Reference
prior platform artifacts by path; never invent them in this model intent.

## Route

Initialization → selection → business/data understanding → platform fit →
core requirements and implementation → lifecycle design → data preparation →
modeling → evaluation → CD and environment validation → deployment →
monitoring and maintenance. Core implementation consumes the lifecycle design
before generating code; it precedes the three ML execution stages.
