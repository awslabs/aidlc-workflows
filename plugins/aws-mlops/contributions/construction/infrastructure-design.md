---
target: infrastructure-design
plugin: aws-mlops
adds:
  scopes:
    - aws-mlops-platform
    - aws-mlops-crisp-mlq
  consumes:
    - artifact: aws-mlops-lifecycle-design
      required: true
  requires_stage:
    - aws-mlops-lifecycle-design
fragments:
  - anchor: before-step:1
    order: 100
---

## fragment: before-step:1

### AWS MLOps context

Apply this addition only when the active scope is `aws-mlops-platform` or
`aws-mlops-crisp-mlq`. Other workflows retain their existing behavior.

Honor the lifecycle design and existing AWS configuration. For a platform, generate
reusable IaC for the agreed account/region/environment layout, roles/KMS, storage,
pipeline and monitoring contracts. For a model, design only approved platform changes;
inventory existing commissioned resources. Verify service/customer availability rather
than requiring Model Monitor or Clarify for a new customer. Record quota, cost and
teardown assumptions.
