---
target: nfr-requirements
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
---
