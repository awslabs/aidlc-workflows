---
target: code-generation
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

Implement the accepted aws-mlops-lifecycle-design in the delivered project workspace
through this stage's normal plan and source-manifest mechanism. Build reproducible
data/training/evaluation steps, registry/promotion, serving and maintenance as
applicable to the selected profile. Use SageMaker Pipelines for recurring ML execution
and CodeBuild/CodePipeline for code and infrastructure delivery. Keep
dataset/split/code/image/model lineage and parameter contracts explicit. Do not insert
sample acceptance thresholds as real requirements. AWS calls in local tests use stubs;
actual jobs follow the existing execution/budget policy.
