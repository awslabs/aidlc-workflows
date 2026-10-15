---
target: deployment-pipeline
plugin: aws-mlops
adds:
  scopes:
    - aws-mlops-platform
    - aws-mlops-crisp-mlq
  consumes:
    - artifact: aws-mlops-lifecycle-design
      required: true
    - artifact: aws-mlops-evaluation
      required: false
    - artifact: aws-mlops-platform-validation
      required: false
  requires_stage:
    - aws-mlops-evaluation
    - aws-mlops-platform-validation
fragments:
  - anchor: before-step:1
    order: 100
---

## fragment: before-step:1

### AWS MLOps context

Apply this addition only when the active scope is `aws-mlops-platform` or
`aws-mlops-crisp-mlq`. Other workflows retain their existing behavior.

Configure the release mechanism from the lifecycle design and the appropriate
evaluation/platform-validation report. Separate infrastructure/code deployment from
registry/model promotion. Honor the recorded production decision policy. Define
modality-specific recovery: supported endpoint traffic shifting and rollback, or
immutable batch inputs/outputs and rerun/backfill. Reference passing, failed and pending
criteria faithfully; a registry entry alone is not production approval.
