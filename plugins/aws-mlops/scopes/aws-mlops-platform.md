---
name: aws-mlops-platform
plugin: aws-mlops
depth: Comprehensive
keywords: [mlops platform, new sagemaker platform]
description: Build and commission a reusable AWS SageMaker MLOps platform
skeleton: on
runner: true
guard_policy: off
sensors: on
learnings: on
summary_confirmation: on
plan_approval: on
collaborators: off
---

# AWS MLOps platform

Build the shared platform once: environments, identity, data and model artifact
storage, reproducible training, registry promotion, deployment, monitoring,
retraining, and recovery. AWS is the runtime stack. Choose the methodology
explicitly at the selection stage; a platform scope alone is not a methodology
choice. Honor a choice the person already made.

## Boundaries

The platform is shared by future methodology profiles. CRISP-ML(Q) is the initial
supported methodology. A commissioning fixture proves the infrastructure path;
it is not a business model or evidence of predictive quality. Follow with
`aws-mlops-crisp-mlq` for a specific model.

## Route

Initialization → methodology selection → platform architecture → core
requirements, design, implementation and CI → platform validation → CD and
environment provisioning → commissioning → monitoring and maintenance.
