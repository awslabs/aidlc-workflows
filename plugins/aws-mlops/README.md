# AWS MLOps plugin

Build a reusable AWS SageMaker MLOps platform, then develop and maintain models
with a methodology chosen by the person. The initial implemented method is
**CRISP-ML(Q)**. CRISP-DM, TDSP, SEMMA and KDD are planned extensions.

## What ships

- `aws-mlops-platform`: platform architecture, implementation, validation,
  commissioning and operational handoff.
- `aws-mlops-crisp-mlq`: business/data understanding, reproducible preparation
  and training, evaluation, deployment, monitoring and maintenance.
- Ten ML-specific stages, two specialist personas, additive contributions to
  core stages, shared/per-agent knowledge, and an advisory evidence sensor.
- A read-only methodology catalog with explicit available/planned status.

The plugin supplies workflow instructions and checks. Running those workflows
creates project-specific IaC, code and AWS pipelines. Adding this plugin to the
repository does **not** provision AWS resources or implement a particular model.

## Build and verify

From the AI-DLC source checkout:

```bash
bun core/tools/aidlc-plugin-validate.ts plugins/aws-mlops --json
bun scripts/package.ts
bun scripts/package.ts --check
bun test plugins/aws-mlops/tests
bun core/tools/aidlc-plugin-test.ts plugins/aws-mlops \
  --install dist/codex --harness codex --json
```

The packager emits the seven supported harness projections at
`dist/plugins/aws-mlops/<harness>/`. The builder injects the standard composition
hook; its documented absence warning on authored content is expected.
Generated projections are not source and must not be edited or committed.

## Install and start

Install the emitted projection using your harness's plugin mechanism, then
compose/select it as described in the
[plugin authoring guide](../../docs/harness-engineering/10-authoring-a-plugin.md#5-distribution--install).
For source/development installs, the guide also documents explicit composer
invocations. Do not run a composer against this framework checkout as if it were
the model delivery project.

After composition in your target project:

```bash
aidlc engine plugin select aidlc,aws-mlops
```

Preserve other enabled plugin names in that selection if you use them.
In Codex, ask:

```text
$aidlc aws-mlops-platform
Construir una plataforma MLOps nueva en AWS SageMaker usando CRISP-ML(Q).
```

After commissioning the platform, start a model intent:

```text
$aidlc aws-mlops-crisp-mlq
Desarrollar <problema de negocio> usando la plataforma <referencia>.
```

Other harnesses use their documented `/aidlc` entry. These examples initiate
workflows; they are not shell commands. Honor a methodology selected earlier in
conversation without asking again.

## Methodology choice

The selection stage reads `tools/aws-mlops-methodologies.ts`, explains methods
and availability in the person's language, and records the person's actual
choice. A named profile the person explicitly chose is an answer. An agent's
recommendation or default is not. Planned methods remain visible as roadmap
items; they are not routed through CRISP-ML(Q) under a different label.

Selection records and reported evaluation numbers have an advisory deterministic
check. The engine remains the owner of human approvals. The sensor makes no
network calls and cannot verify AWS execution or authenticate a choice.

## Evidence and operational boundaries

Local SDK compilation, IaC synth and fixtures are distinct from in-AWS runs.
Cloud jobs and deployment follow the project's recorded authorization, budget
and environment policy. Actual experiment/registry/inference references and
metrics are required for runtime claims. Monitoring distinguishes drift,
service health and model quality with ground truth.

For a greenfield customer, do not require SageMaker Model Monitor or Clarify;
use a verified in-account alternative. Recurring monitoring and retraining run
on AWS services independently of an AI conversation.

## Extending the catalog

1. Author the method's workflow and deliverables, preserving its actual meaning.
2. Map shared data, training, release and maintenance contracts to reusable stages.
3. Add the namespaced scope and scope membership/contributions.
4. Add methodology-specific knowledge and meaningful validation.
5. Mark its catalog entry available only when composition and route tests pass.

SEMMA/KDD profiles should explicitly label the business/deployment/operations
steps added for production. The shared platform must not be duplicated per method.

See the [AWS MLOps user guide](../../docs/guide/aws-mlops.md).
