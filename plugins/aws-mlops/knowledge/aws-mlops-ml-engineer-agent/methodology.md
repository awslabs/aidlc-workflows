# Reproducible ML execution

Read `aidlc-shared/aws-mlops.md` for shared architecture and methodology.

## Pipelines

Define a parameterized SageMaker pipeline for input validation, preparation,
training, evaluation and candidate registration. Conditional evaluation uses
the approved metric directions and thresholds; registration is not production
approval. Capture execution IDs, artifact versions, container digests, code
revisions, random seeds and dependency locks. Test failure branches as well as
the happy path.

CodeBuild tests/builds code and images; CodePipeline promotes infrastructure
and releases. SageMaker Pipelines performs recurring ML work. EventBridge may
start a pipeline from a schedule or event. Deduplicate triggers and bound
concurrency, retries and spend. The chat creates and changes these mechanisms;
their daily execution must operate independently of an AI session.

## Inference and recovery

Keep preprocessing consistent with training. For endpoints, verify quotas,
capacity, metrics and the chosen deployment mode's supported traffic shifting
and rollback capabilities. For batch, version input/output manifests and
provide a safe rerun/backfill path. Validate predictions at the serving boundary,
not merely a successful CreateEndpoint or TransformJob response.
