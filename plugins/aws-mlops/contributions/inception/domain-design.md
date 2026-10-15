---
target: domain-design
plugin: aws-mlops
adds:
  scopes:
    - aws-mlops-platform
    - aws-mlops-crisp-mlq
  consumes:
    - artifact: aws-mlops-platform-architecture
      required: true
  requires_stage:
    - aws-mlops-platform-design
fragments:
  - anchor: before-step:1
    order: 100
---

## fragment: before-step:1

### AWS MLOps context

Apply this addition only when the active scope is `aws-mlops-platform` or
`aws-mlops-crisp-mlq`. Other workflows retain their existing behavior.

Use the platform architecture to identify software responsibilities: processing,
training, evaluation, promotion, inference and monitoring. Infrastructure services are
dependencies, not fabricated software components. Keep contracts reusable across
methodology profiles.
