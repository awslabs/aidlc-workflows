---
target: ci-pipeline
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

Use the agreed AWS CodeBuild/CodePipeline and ECR/S3 delivery contracts. Run
local/software/IaC checks and pipeline SDK compilation in CI without inadvertently
starting paid training. Keep code promotion separate from SageMaker training
orchestration and production model approval. Reuse the person's existing source
integration and SDK versions.
