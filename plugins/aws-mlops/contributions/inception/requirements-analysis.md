---
target: requirements-analysis
plugin: aws-mlops
adds:
  scopes:
    - aws-mlops-platform
    - aws-mlops-crisp-mlq
  consumes:
    - artifact: aws-mlops-platform-architecture
      required: true
    - artifact: aws-mlops-business-data
      required: false
    - artifact: aws-mlops-quality-contract
      required: false
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

Use the chosen methodology and aws-mlops-platform-architecture as requirements inputs.
For a model, preserve the business/data findings and quality contract; for a platform,
capture reusable capabilities and commissioning requirements. Honor the supplied
full-AWS stack, existing choices and unanswered business decisions. Distinguish a
platform commissioning fixture from a business model. Reference these input artifacts in
requirements.
