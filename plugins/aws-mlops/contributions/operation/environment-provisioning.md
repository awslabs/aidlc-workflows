---
target: environment-provisioning
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

For aws-mlops-platform, provision only the approved IaC under existing environment,
budget and deployment authority. For aws-mlops-crisp-mlq, first validate the supplied
commissioned platform and inventory actual resources; provision changes only when
already included in the approved plan. Verify IAM/KMS access, S3/ECR paths, SageMaker
execution configuration, quotas and network/DNS. Preserve existing tools, credentials
and account configuration. Pending provisioning is not a deployed inventory.
