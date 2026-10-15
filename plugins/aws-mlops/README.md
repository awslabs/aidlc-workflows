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
  core stages, shared/per-agent knowledge, and two advisory evidence sensors.
- A read-only methodology catalog with explicit available/planned status.
- A local CRISP-ML(Q) operating reference, revision `1.0.0`, with source-section
  traceability and 20 operational requirements across the six model phases.

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

### Method context and phase quality

The model receives the
[local CRISP-ML(Q) reference](knowledge/aidlc-shared/aws-mlops-crisp-mlq.md)
through AI-DLC's shared knowledge roster. Phase instructions also explicitly
name it and the mapping owned by `tools/aws-mlops-crisp-mlq.ts`. Repository tests
verify that the reference reaches all six model phases on all seven harnesses,
including core requirements work; no conductor or core-loader change is required.

The reference supplies goals, task instructions, acceptance evidence, revision
paths, and the requirements → task risks → mitigation → verification loop.
Each model phase writes an adjacent `.crisp-mlq.json` coverage record in addition
to the normal Markdown artifact and existing numeric JSON. The methodology
sensor checks IDs, reference revision, pending/failed evidence and risk records.
Platform deployment/monitoring use explicit commissioning non-applicability
records, so a platform fixture is not reported as a model's acceptance.

This is our operating adaptation of the cited publication. The sensors verify
records and numeric consistency; methodological fidelity and evidence truth still
need review. General ML expertise remains necessary; prior recall of the method
is not the source of its requirements.

### Controlled checks with different models

Normal repository tests exercise the benchmark scorer using synthetic inputs
and skip live model calls. To run six controlled cases on each installed CLI:

```bash
AIDLC_MLOPS_LIVE=1 bun test plugins/aws-mlops/tests/crisp-mlq-live.test.ts
```

The checks use the person's existing Claude/Codex authentication and provider.
They supply the same local reference and cases, ask for structured recommendations,
and preserve reports/transcripts under ignored `tests/logs/aws-mlops-methodology/`.
They do not run a project workflow or contact SageMaker. Each CLI has a bounded
timeout; Claude has a $2 per-call budget cap. These calls spend model tokens.

Use `AIDLC_MLOPS_CLAUDE_MODEL` and `AIDLC_MLOPS_CODEX_MODEL` to select specific
models supported by your providers; otherwise each CLI uses its configured
default. `AIDLC_MLOPS_REPORT_DIR` changes the report directory;
`AIDLC_MLOPS_LIVE_TIMEOUT_MS` sets a finite per-call timeout up to ten minutes.
The report records requested/reported model identities and hashes of the
reference/prompt. Confirm the identities differ before claiming multi-model
coverage. Missing auth or a failed response is a failure, not a synthetic pass.
Deterministic action/coverage scores require review of the explanations as well.

### Execution evidence

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
