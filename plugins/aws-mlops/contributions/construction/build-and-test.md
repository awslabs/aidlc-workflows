---
target: build-and-test
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

Map every lifecycle contract to meaningful verification. Test schema/leakage and
train-serving consistency, pipeline condition/failure paths, immutable artifacts,
retry/idempotency, release policies and monitoring/retraining computations. Use local
fixtures and stub AWS calls. Compilation, synth and mocked API tests establish only
local correctness; the later ML/deployment stages collect actual runtime evidence.
Record unexecuted cloud checks separately.
